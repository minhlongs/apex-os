/** @jest-environment node */
jest.mock('@turnkey/sdk-server', () => ({ Turnkey: jest.fn() }));
import Database from 'better-sqlite3';
import { keccak256 } from 'viem';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { D1Database, D1PreparedStatement, D1QueryResult, D1ExecResult } from '@/lib/auth/adapters/d1-adapter';
import { SqliteD1Adapter } from '@/lib/ledger/double-entry-ledger';
import { TurnkeySigner } from '../turnkey-signer';
import { BroadcastRecoveryMachine } from '../broadcast-recovery-machine';
import { ArbitrumBaseUsdcAdapter, type EvmJsonRpcTransport } from '../adapters/arbitrum-base-usdc-adapter';
import { HorizonStellarBroadcastTransport } from '../stellar-horizon-transport';
import { StellarNetwork } from '../stellar-service';
const { Account, Asset, Keypair, Networks, Operation, TransactionBuilder } = process.getBuiltinModule('node:module').createRequire(process.cwd() + '/package.json')('@stellar/stellar-sdk') as typeof import('@stellar/stellar-sdk');
jest.mock('@/lib/analytics', () => ({ analytics: { track: jest.fn() } }));
import { PayoutEffectBlockedError, withPayoutWorkflow, withPayoutEffect } from '../payout-effect-fence';

class MemoryD1 implements D1Database {
  constructor(private readonly sqlite: Database.Database) {}

  prepare(query: string): D1PreparedStatement {
    const statement = this.sqlite.prepare(query);
    let values: unknown[] = [];
    const result: D1PreparedStatement = {
      bind(...args: unknown[]): D1PreparedStatement {
        values = args;
        return this;
      },
      async first<T = unknown>(): Promise<T | undefined> {
        return statement.get(...values) as T | undefined;
      },
      async all<T = unknown>(): Promise<D1QueryResult<T>> {
        return {
          results: statement.all(...values) as T[],
          meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0 },
        };
      },
      async run(): Promise<D1ExecResult> {
        const run = statement.run(...values);
        return {
          success: true,
          meta: {
            last_row_id: Number(run.lastInsertRowid),
            rows_written: run.changes,
            changes: run.changes,
            duration: 0,
          },
        };
      },
      async *raw<T = unknown>(): AsyncIterable<T> {
        yield* statement.all(...values) as T[];
      },
    };
    return result;
  }

  async exec(sql: string): Promise<D1ExecResult> {
    this.sqlite.exec(sql);
    return { success: true, meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0 } };
  }

  async batch(): Promise<never[]> {
    throw new Error('Batch is not used in payout effect fence tests');
  }

  async dump(): Promise<string> { return ''; }
  async close(): Promise<void> { this.sqlite.close(); }
}

function buildSnapshot(): Buffer {
  const source = new Database(':memory:');
  try {
    source.exec('CREATE TABLE profiles(id TEXT PRIMARY KEY); CREATE TABLE deals(id TEXT PRIMARY KEY);');
    for (const file of ['028_ascendancy_audit_core.sql', '033_cold_settlement_claims.sql',
      '034_withdrawal_freeze_at_write.sql', '035_payout_effect_grants.sql', '036_durable_hot_exposure.sql']) {
      source.exec(readFileSync(path.resolve(process.cwd(), 'src/database/migrations', file), 'utf8'));
    }
    source.exec("UPDATE system_runtime_flags SET flag_value = 'false' WHERE flag_key IN ('EMERGENCY_PAUSE','EMERGENCY_LEDGER_FREEZE')");
    source.prepare(`INSERT INTO ledger_journal_batches
      (id,idempotency_key,payload_fingerprint,journal_type,status,gross_commission_units,payout_id,metadata)
      VALUES ('lock','lock','fixture','WITHDRAWAL_LOCK','INFLIGHT',1000000000,'payout-1',?)`)
      .run(JSON.stringify({ payoutId: 'payout-1', ownerId: 'affiliate-1', ownerType: 'affiliate', lockedAmountUnits: '1000000000' }));
    return source.serialize();
  } finally { source.close(); }
}

const sqliteSnapshot = buildSnapshot();
const fixtureSigner = '0x3333333333333333333333333333333333333333';
const fixtureRecipient = '0x1111111111111111111111111111111111111111';
function createFixture(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = new Database(sqliteSnapshot);
  sqlite.pragma('foreign_keys = ON');
  sqlite.prepare(`INSERT INTO settlement_broadcasts
    (payout_id,idempotency_key,affiliate_id,chain,recipient_address,amount_units_1e8,chain_token_units,
     chain_decimals,state,signer_address,assigned_nonce,lock_batch_id,updated_at)
    VALUES ('payout-1','id-1','affiliate-1','arbitrum',?,1000000000,'10000000',6,'SIGNING',?,7,'lock','2000-01-01 00:00:00')`)
    .run(fixtureRecipient, fixtureSigner);
  return { sqlite, db: new MemoryD1(sqlite) };
}

async function readEpoch(db: D1Database): Promise<number> {
  const row = await db.prepare('SELECT epoch FROM system_safety_epoch WHERE singleton = 1')
    .first<{ epoch: number }>();
  if (!row) throw new Error('Safety epoch row missing');
  return row.epoch;
}

describe('payout effect fencing controls and durable grants', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    ({ sqlite, db } = createFixture());
  });

  afterEach(() => sqlite.close());

  it.each([
    ['pause active', "UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'"],
    ['freeze active', "UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'"],
    ['pause missing', "DELETE FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'"],
    ['freeze invalid', "UPDATE system_runtime_flags SET flag_value = 'FALSE' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'"],
  ])('denies without invoking provider when %s before admission', async (_label, sql) => {
    sqlite.exec(sql);
    const invoke = jest.fn(async () => 'sent');
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, invoke))
      .rejects.toMatchObject({ code: 'PAYOUT_EFFECT_BLOCKED' });
    expect(invoke).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM payout_effect_grants').get())
      .toMatchObject({ count: 0 });
  });

  it('admits one invocation and persists only a payload digest', async () => {
    const result = await withPayoutEffect({
      db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'sensitive-digest',
    }, async () => 'signature-result');
    expect(result).toBe('signature-result');
    expect(sqlite.prepare('SELECT effect_kind, payload_sha256, safety_epoch FROM payout_effect_grants').get())
      .toMatchObject({ effect_kind: 'TURNKEY_SIGN', safety_epoch: await readEpoch(db) });
    expect(sqlite.prepare('SELECT payload_sha256 FROM payout_effect_grants').get())
      .not.toHaveProperty('payload_sha256', 'sensitive-digest');
    expect(sqlite.prepare('SELECT active, worker_id, lock_batch_id FROM payout_effect_attempts').get())
      .toEqual({ active: 1, worker_id: null, lock_batch_id: 'lock' });
  });

  it('fails closed when the control read exceeds its deadline', async () => {
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (query: string) => {
      const statement = originalPrepare(query);
      if (!query.startsWith('SELECT epoch')) return statement;
      return {
        ...statement,
        first: () => new Promise<undefined>(() => undefined),
      } as D1PreparedStatement;
    };
    const invoke = jest.fn(async () => 'sent');
    await expect(withPayoutEffect({
      db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest', timeoutMs: 1,
    }, invoke)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('does not start a request if pause commits before the final grant write', async () => {
    const originalPrepare = db.prepare.bind(db);
    let paused = false;
    db.prepare = (query: string) => {
      const statement = originalPrepare(query);
      if (!query.includes('INTO payout_effect_grants')) return statement;
      const originalBind = statement.bind.bind(statement);
      return {
        ...statement,
        bind: (...values: unknown[]) => {
          const bound = originalBind(...values);
          return {
            ...bound,
            run: async () => {
              if (!paused) {
                paused = true;
                sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'").run();
              }
              return bound.run();
            },
          };
        },
      } as D1PreparedStatement;
    };
    const invoke = jest.fn(async () => 'sent');
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, invoke))
      .rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(invoke).not.toHaveBeenCalled();
  });

  it('retains the active owner and skips the request when grant outcome is ambiguous', async () => {
    const originalPrepare = db.prepare.bind(db);
    db.prepare = (query: string) => {
      const statement = originalPrepare(query);
      if (!query.includes('INTO payout_effect_grants')) return statement;
      const originalBind = statement.bind.bind(statement);
      return {
        ...statement,
        bind: (...values: unknown[]) => {
          const bound = originalBind(...values);
          return {
            ...bound,
            run: async () => { throw new Error('simulated D1 timeout'); },
          };
        },
      } as D1PreparedStatement;
    };
    const invoke = jest.fn(async () => 'sent');
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, invoke))
      .rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(invoke).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT active FROM payout_effect_attempts').get()).toMatchObject({ active: 1 });
    expect(sqlite.prepare('SELECT COUNT(*) AS count FROM payout_effect_grants').get()).toMatchObject({ count: 0 });
  });

  it('documents the honest boundary: pause after grant cannot revoke the single admitted request', async () => {
    const originalPrepare = db.prepare.bind(db);
    let paused = false;
    db.prepare = (query: string) => {
      const statement = originalPrepare(query);
      if (!query.includes('INTO payout_effect_grants')) return statement;
      const originalBind = statement.bind.bind(statement);
      return {
        ...statement,
        bind: (...values: unknown[]) => {
          const bound = originalBind(...values);
          return {
            ...bound,
            run: async () => {
              const result = await bound.run();
              if (!paused) {
                paused = true;
                sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'").run();
              }
              return result;
            },
          };
        },
      } as D1PreparedStatement;
    };
    const invoke = jest.fn(async () => 'one admitted in-flight request');
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, invoke))
      .resolves.toBe('one admitted in-flight request');
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent workers and invokes only the durable owner', async () => {
    let unblock: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { unblock = resolve; });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const invoke = jest.fn(async () => { entered?.(); await gate; return 'provider-result'; });
    const request = { db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN' as const, payload: 'digest' };
    const first = withPayoutEffect(request, invoke);
    await started;
    await expect(withPayoutEffect(request, invoke)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(invoke).toHaveBeenCalledTimes(1);
    unblock?.();
    await expect(first).resolves.toBe('provider-result');
  });

  it('advances epoch on flag insert, update, delete, and key rename', async () => {
    const start = await readEpoch(db);
    sqlite.exec("DELETE FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'");
    expect(await readEpoch(db)).toBe(start + 1);
    sqlite.exec("INSERT INTO system_runtime_flags(flag_key, flag_value) VALUES ('EMERGENCY_PAUSE', 'false')");
    expect(await readEpoch(db)).toBe(start + 2);
    sqlite.exec("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'");
    expect(await readEpoch(db)).toBe(start + 3);
    sqlite.exec("UPDATE system_runtime_flags SET flag_key = 'OTHER_FLAG' WHERE flag_key = 'EMERGENCY_PAUSE'");
    expect(await readEpoch(db)).toBe(start + 4);
    sqlite.exec("INSERT INTO system_runtime_flags(flag_key, flag_value) VALUES ('EMERGENCY_PAUSE', 'false')");
    expect(await readEpoch(db)).toBe(start + 5);
    sqlite.exec("DELETE FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'");
    expect(await readEpoch(db)).toBe(start + 6);
  });

  it('leaves completed grants stale after pause then resume', async () => {
    await withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, async () => 'ok');
    const admittedEpoch = sqlite.prepare('SELECT safety_epoch FROM payout_effect_grants').get() as { safety_epoch: number };
    sqlite.exec("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'");
    sqlite.exec("UPDATE system_runtime_flags SET flag_value = 'false' WHERE flag_key = 'EMERGENCY_PAUSE'");
    const currentEpoch = await readEpoch(db);
    expect(currentEpoch).toBe(admittedEpoch.safety_epoch + 2);
    expect(sqlite.prepare('SELECT 1 FROM payout_effect_grants WHERE safety_epoch = ? AND safety_epoch = ?')
      .get(admittedEpoch.safety_epoch, currentEpoch)).toBeUndefined();
  });

  it('hands off a completed worker without resampling the attempt or replaying its sign grant', async () => {
    const sign = jest.fn(async () => 'signed');
    const send = jest.fn(async () => 'sent');
    const request = { db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN' as const, payload: 'digest' };
    await withPayoutEffect(request, sign);
    const nextDb = new MemoryD1(sqlite);
    await expect(withPayoutEffect({ ...request, db: nextDb, payload: 'different' }, sign)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    sqlite.exec("UPDATE settlement_broadcasts SET state='BROADCAST_PENDING', signed_raw_tx='0x02'");
    await expect(withPayoutEffect({ ...request, db: nextDb, effect: 'EVM_BROADCAST', payload: '0x02' }, send)).resolves.toBe('sent');
    expect(sign).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(sqlite.prepare('SELECT COUNT(DISTINCT attempt_id) AS attempts, COUNT(*) AS effects FROM payout_effect_grants').get())
      .toEqual({ attempts: 1, effects: 2 });
  });

  it('rejects stale workflow during pause/resume and also from a different worker', async () => {
    const send = jest.fn(async () => 'sent');
    await withPayoutWorkflow(db, 'payout-1', async (workflow) => {
      await withPayoutEffect({ db, payoutId: 'payout-1', workflow, effect: 'TURNKEY_SIGN', payload: 'digest' }, async () => 'signed');
      sqlite.exec("UPDATE settlement_broadcasts SET state='BROADCAST_PENDING', signed_raw_tx='0x02'");
      sqlite.exec("UPDATE system_runtime_flags SET flag_value='true' WHERE flag_key='EMERGENCY_PAUSE'");
      sqlite.exec("UPDATE system_runtime_flags SET flag_value='false' WHERE flag_key='EMERGENCY_PAUSE'");
      await expect(withPayoutEffect({ db, payoutId: 'payout-1', workflow, effect: 'EVM_BROADCAST', payload: '0x02' }, send)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    });
    await expect(withPayoutEffect({ db: new MemoryD1(sqlite), payoutId: 'payout-1', effect: 'EVM_BROADCAST', payload: '0x02' }, send)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    "UPDATE ledger_journal_batches SET status='VOIDED'",
    "UPDATE ledger_journal_batches SET metadata=json_set(metadata,'$.ownerId','other')",
    "UPDATE settlement_broadcasts SET assigned_nonce=8",
    "UPDATE settlement_broadcasts SET chain='base'",
    "UPDATE settlement_broadcasts SET signer_address='different'",
  ])('rejects a later effect after its durable binding changes: %s', async (mutation) => {
    await withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, async () => 'signed');
    sqlite.exec("UPDATE settlement_broadcasts SET state='BROADCAST_PENDING', signed_raw_tx='0x02'");
    sqlite.exec(mutation);
    const send = jest.fn(async () => 'sent');
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'EVM_BROADCAST', payload: '0x02' }, send)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(send).not.toHaveBeenCalled();
  });

  it('denies if the durable payout state changes before final grant', async () => {
    const originalPrepare = db.prepare.bind(db);
    let changed = false;
    db.prepare = (query: string) => {
      const statement = originalPrepare(query);
      if (!query.includes('INTO payout_effect_grants')) return statement;
      const originalBind = statement.bind.bind(statement);
      return {
        ...statement,
        bind: (...values: unknown[]) => {
          const bound = originalBind(...values);
          return {
            ...bound,
            run: async () => {
              if (!changed) {
                changed = true;
                sqlite.prepare("UPDATE settlement_broadcasts SET tx_hash = '0xnew' WHERE payout_id = 'payout-1'").run();
              }
              return bound.run();
            },
          };
        },
      } as D1PreparedStatement;
    };
    const invoke = jest.fn(async () => 'sent');
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'TURNKEY_SIGN', payload: 'digest' }, invoke))
      .rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(invoke).not.toHaveBeenCalled();
  });
});

// PAUSE-01..10 use real machine/signer/adapter + SQLite. Every external request is a mock.
describe('PAUSE-01..10 production effect boundaries', () => {
  const hash = `0x${'ab'.repeat(32)}` as const;
  const signerAddress = '0x3333333333333333333333333333333333333333';
  const recipient = '0x1111111111111111111111111111111111111111';
  let sqlite: Database.Database;
  let db: D1Database;
  let signer: TurnkeySigner;
  let adapter: ArbitrumBaseUsdcAdapter;
  let machine: BroadcastRecoveryMachine;
  let sign: jest.Mock;
  let send: jest.Mock;
  let afterReceipt: (() => void) | undefined;
  let afterBuild: (() => void) | undefined;
  let afterSign: (() => void) | undefined;
  let receiptConfirmed: boolean;

  const pause = (flag = 'EMERGENCY_PAUSE') => {
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = ?").run(flag);
  };
  const setState = (state: string, raw: string | null = '0x02') => {
    sqlite.prepare('UPDATE settlement_broadcasts SET state = ?, signed_raw_tx = ? WHERE payout_id = ?')
      .run(state, raw, 'payout-1');
  };
  const directSign = () => signer.signEvmDigestEnforced({
    db, payoutId: 'payout-1', chain: 'arbitrum', amountUnits1e8: BigInt(1_000_000_000), digestHex: hash,
  });
  const recover = () => machine.recoverUncertainBroadcast('payout-1', { nowUnix: 100_000, bumpGasRbf: sqlite.prepare('SELECT signed_raw_tx FROM settlement_broadcasts').get() != null && (sqlite.prepare('SELECT signed_raw_tx FROM settlement_broadcasts').get() as { signed_raw_tx: string | null }).signed_raw_tx === null });

  beforeEach(() => {
    ({ sqlite } = createFixture());
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', tx_hash = ?, signed_raw_tx = '0x02'").run(hash);
    db = new SqliteD1Adapter(sqlite);
    afterReceipt = undefined; afterBuild = undefined; afterSign = undefined; receiptConfirmed = false;
    globalThis.fetch = jest.fn();
    Object.defineProperty(globalThis.AbortSignal, 'timeout', { configurable: true, value: () => new AbortController().signal });
    send = jest.fn(async () => hash);
    sign = jest.fn(async () => {
      afterSign?.();
      return { r: `0x${'01'.repeat(32)}` as const, s: `0x${'02'.repeat(32)}` as const, v: 0, activityId: 'activity-1' };
    });
    signer = new TurnkeySigner({
      evmHotWalletAddress: signerAddress,
      stellarHotWalletAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      transport: { signEvmDigest: sign, signStellarEnvelope: jest.fn() },
    });
    const rpc: EvmJsonRpcTransport = {
      async call<T>(method: string): Promise<T> {
        if (method === 'eth_sendRawTransaction') return await send() as T;
        if (method === 'eth_getTransactionCount') return '0x7' as T;
        if (method === 'eth_maxPriorityFeePerGas') { afterBuild?.(); return '0x100' as T; }
        if (method === 'eth_getBlockByNumber') { afterBuild?.(); return { baseFeePerGas: '0x100' } as T; }
        if (method === 'eth_estimateGas') return '0x10000' as T;
        if (method === 'eth_call') return '0x1' as T;
        throw new Error(`Unexpected mock read ${method}`);
      },
    };
    adapter = new ArbitrumBaseUsdcAdapter({ chain: 'arbitrum', hotWalletAddress: signerAddress, primaryRpc: rpc });
    jest.spyOn(adapter, 'getTransactionReceipt').mockImplementation(async () => {
      afterReceipt?.();
      return { txHash: hash, found: receiptConfirmed, confirmed: receiptConfirmed, reverted: false, status: receiptConfirmed ? 1 as const : undefined };
    });
    machine = new BroadcastRecoveryMachine({ db, turnkeySigner: signer, evmAdapters: { arbitrum: adapter } });
  });

  afterEach(() => { jest.restoreAllMocks(); sqlite.close(); });

  it('PAUSE-01: active pause before recovery denies raw rebroadcast and keeps signed nonce', async () => {
    pause();
    await recover();
    expect(send).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT state, assigned_nonce, signed_raw_tx FROM settlement_broadcasts').get())
      .toMatchObject({ state: 'BROADCAST_PENDING', assigned_nonce: 7, signed_raw_tx: '0x02' });
  });

  it('PAUSE-02: recovery started then paused before signing makes zero Turnkey calls', async () => {
    setState('BROADCAST_PENDING', null);
    afterReceipt = () => pause();
    await expect(recover()).resolves.toMatchObject({ state: 'BROADCAST_PENDING', reason: expect.stringContaining('Payout effect denied') });
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('PAUSE-03: direct signature completes then pause denies initial broadcast', async () => {
    setState('SIGNING', null);
    await directSign();
    setState('BROADCAST_PENDING');
    pause();
    await expect(adapter.broadcastSignedTransaction('0x02', { db, payoutId: 'payout-1', effect: 'EVM_BROADCAST' }))
      .rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(sign).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
  });

  it('PAUSE-04: flag flips during RBF build, before sign admission', async () => {
    setState('BROADCAST_PENDING', null);
    afterBuild = () => pause();
    await expect(recover()).resolves.toMatchObject({ state: 'BROADCAST_PENDING', reason: expect.stringContaining('Payout effect denied') });
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('PAUSE-05: pause during RBF signing persists late signed bytes but blocks RBF send', async () => {
    setState('BROADCAST_PENDING', null);
    afterSign = () => pause();
    await recover();
    expect(sign).toHaveBeenCalledTimes(1); expect(send).not.toHaveBeenCalled();
    const row = sqlite.prepare('SELECT state, assigned_nonce, signed_raw_tx FROM settlement_broadcasts').get() as {
      state: string; assigned_nonce: number; signed_raw_tx: string;
    };
    expect(row.state).toBe('BROADCAST_PENDING'); expect(row.assigned_nonce).toBe(7);
    expect(row.signed_raw_tx).toMatch(/^0x02/);
  });

  it('PAUSE-06: pause during raw rebroadcast records late result without another request', async () => {
    const expectedHash = keccak256('0x02');
    sqlite.prepare('UPDATE settlement_broadcasts SET tx_hash = ?').run(expectedHash);
    send.mockImplementation(async () => { pause(); return expectedHash; });
    await recover();
    await recover();
    expect(send).toHaveBeenCalledTimes(1); expect(sign).not.toHaveBeenCalled();
  });

  it('PAUSE-07: ledger freeze alone blocks direct signer and send', async () => {
    pause('EMERGENCY_LEDGER_FREEZE');
    setState('SIGNING');
    await expect(directSign()).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    setState('BROADCAST_PENDING');
    await recover();
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('PAUSE-08: unreadable control/grant state blocks production direct signer', async () => {
    sqlite.exec('DROP TABLE system_safety_epoch');
    setState('SIGNING');
    await expect(directSign()).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(sign).not.toHaveBeenCalled();
  });

  it('PAUSE-09: already sent receipt confirms during pause using passive recovery', async () => {
    pause(); receiptConfirmed = true;
    await expect(machine.recoverUncertainBroadcast('payout-1', { passiveOnly: true }))
      .resolves.toMatchObject({ state: 'CONFIRMED', action: 'RECONCILED_ON_CHAIN' });
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('PAUSE-10: concurrent direct signer workers plus pause invoke one admitted request', async () => {
    setState('SIGNING');
    let finish: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { finish = resolve; });
    sign.mockImplementation(async () => { entered?.(); await gate; return { r: hash, s: hash, v: 0, activityId: 'late' }; });
    const first = directSign(); await started; pause();
    await expect(directSign()).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    finish?.(); await first;
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('stale SIGNING with pause is not aborted and its nonce is not reclaimed', async () => {
    setState('SIGNING', null);
    sqlite.exec('UPDATE settlement_broadcasts SET tx_hash = NULL');
    pause();
    await expect(recover()).resolves.toMatchObject({ state: 'SIGNING', assignedNonce: 7 });
  });

  it('does not reclaim an old SIGNING reservation even with timeout zero', async () => {
    setState('SIGNING', null);
    sqlite.exec('UPDATE settlement_broadcasts SET tx_hash = NULL');
    await expect(machine.recoverUncertainBroadcast('payout-1', { signingStaleTimeoutSeconds: 0, nowUnix: 2_000_000_000 }))
      .resolves.toMatchObject({ state: 'SIGNING', assignedNonce: 7 });
    expect(sign).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  });

  it('denies a ledger refund and a second worker after an ambiguous provider result', async () => {
    const invoke = jest.fn(async () => { throw new Error('connection lost'); });
    const request = { db, payoutId: 'payout-1', effect: 'EVM_REBROADCAST' as const, payload: '0x02' };
    await expect(withPayoutEffect(request, invoke)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    await expect(withPayoutEffect({ ...request, db: new MemoryD1(sqlite) }, invoke)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(() => sqlite.prepare(`INSERT INTO ledger_journal_batches
      (id,idempotency_key,payload_fingerprint,journal_type,status,metadata)
      VALUES ('refund','refund','fixture','WITHDRAWAL_REVERTED','SETTLED','{"lockBatchId":"lock"}')`).run())
      .toThrow('Withdrawal refund requires exact durable terminal proof');
    expect(sqlite.prepare("SELECT status FROM ledger_journal_batches WHERE id='lock'").get()).toEqual({ status: 'INFLIGHT' });
  });

  it.each(['arbitrum', 'stellar'] as const)('retains funds after receipt status alone reports failure on %s', async (chain) => {
    const txHash = chain === 'stellar' ? 'ab'.repeat(32) : keccak256('0x02');
    if (chain === 'stellar') sqlite.exec("UPDATE settlement_broadcasts SET chain='stellar', assigned_nonce=NULL, stellar_sequence='8'");
    sqlite.prepare('UPDATE settlement_broadcasts SET tx_hash = ?').run(txHash);
    const lost = jest.fn(async () => { throw new Error('transport timeout'); });
    const request = { db, payoutId: 'payout-1', effect: chain === 'stellar' ? 'STELLAR_SUBMIT' as const : 'EVM_REBROADCAST' as const,
      payload: '0x02', expectedHash: txHash };
    await expect(withPayoutEffect(request, lost)).rejects.toThrow(/provider outcome uncertain/);
    const refund = sqlite.prepare(`INSERT INTO ledger_journal_batches
      (id,idempotency_key,payload_fingerprint,journal_type,status,metadata)
      VALUES ('refund','refund','fixture','WITHDRAWAL_REVERTED','SETTLED','{"lockBatchId":"lock"}')`);
    sqlite.exec("UPDATE settlement_broadcasts SET state='FAILED_ABORTED'");
    expect(() => refund.run()).toThrow(/terminal proof/);
    sqlite.exec("UPDATE settlement_broadcasts SET state='BROADCAST_PENDING'");
    jest.spyOn(adapter, 'getTransactionReceipt').mockResolvedValue({ found: true, confirmed: false, reverted: true, transactionHash: txHash });
    const passive = new BroadcastRecoveryMachine({ db, turnkeySigner: signer, evmAdapters: { arbitrum: adapter }, stellarTransport: {
      lookupTransaction: jest.fn(async () => ({ found: true, successful: false })),
      buildUnsignedEnvelope: jest.fn(),
      submitSignedEnvelope: jest.fn(),
    } });
    await expect(passive.recoverUncertainBroadcast('payout-1', { passiveOnly: true })).resolves.toMatchObject({ state: 'FAILED_ABORTED' });
    expect(() => refund.run()).toThrow(/terminal proof/);
    expect(sqlite.prepare("SELECT status FROM ledger_journal_batches WHERE id='lock'").get()).toEqual({ status: 'INFLIGHT' });
    await expect(withPayoutEffect(request, lost)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(lost).toHaveBeenCalledTimes(1);
  });

  it('does not treat Stellar expiry as permission to take over an uncertain submission', async () => {
    sqlite.exec(`UPDATE settlement_broadcasts SET chain='stellar', assigned_nonce=NULL,
      stellar_sequence='8', timebounds_max_unix=10`);
    await expect(withPayoutEffect({ db, payoutId: 'payout-1', effect: 'STELLAR_SUBMIT', payload: '0x02' },
      async () => { throw new Error('timeout'); })).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    const stellarTransport = new HorizonStellarBroadcastTransport({ network: StellarNetwork.TESTNET, horizonUrl: 'https://horizon-fixture.invalid' });
    jest.spyOn(stellarTransport, 'lookupTransaction').mockResolvedValue({ found: false, successful: false, txHash: hash });
    const stellarMachine = new BroadcastRecoveryMachine({ db, turnkeySigner: signer, stellarTransport });
    await expect(stellarMachine.recoverUncertainBroadcast('payout-1', { nowUnix: 100, reexecuteExpired: true }))
      .resolves.toMatchObject({ state: 'BROADCAST_PENDING', stellarSequence: '8' });
    expect(sign).not.toHaveBeenCalled(); expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('EVM production send uses one fetch, zero retries and redirect:error on HTTP 503', async () => {
    sqlite.prepare('UPDATE settlement_broadcasts SET tx_hash = ?').run(keccak256('0x02'));
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503 } as Response);
    const productionAdapter = new ArbitrumBaseUsdcAdapter({ chain: 'arbitrum', hotWalletAddress: signerAddress,
      primaryRpcUrl: 'https://local-fixture.invalid' });
    await expect(productionAdapter.broadcastSignedTransaction('0x02', { db, payoutId: 'payout-1', effect: 'EVM_BROADCAST' }))
      .rejects.toThrow('provider outcome uncertain');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://local-fixture.invalid', expect.objectContaining({ redirect: 'error' }));
  });

  it('Horizon submit fixture has encoded signed XDR, no redirects/retries, and late result', async () => {
    const key = Keypair.fromRawEd25519Seed(Buffer.alloc(32, 1));
    const tx = new TransactionBuilder(new Account(key.publicKey(), '7'), { fee: '100', networkPassphrase: Networks.TESTNET })
      .addOperation(Operation.payment({ destination: key.publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(180).build();
    tx.sign(key);
    const expected = Buffer.from(tx.hash()).toString('hex');
    sqlite.prepare(`UPDATE settlement_broadcasts SET chain = 'stellar', chain_decimals = 7,
      signer_address = ?, assigned_nonce = NULL, stellar_sequence = ?, tx_hash = ?, signed_raw_tx = ?`)
      .run(key.publicKey(), tx.sequence, expected, tx.toXDR());
    const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      pause(); return { ok: true, json: async () => ({ hash: expected, successful: true }) } as Response;
    });
    const horizon = new HorizonStellarBroadcastTransport({ network: StellarNetwork.TESTNET, horizonUrl: 'https://horizon-fixture.invalid' });
    const params = { db, payoutId: 'payout-1', effect: 'STELLAR_SUBMIT' as const,
      signedEnvelopeXdr: tx.toXDR(), signatureBase64: '', expectedTxHash: expected };
    await expect(horizon.submitSignedTransaction(params)).resolves.toEqual({ txHash: expected, confirmed: true });
    await expect(horizon.submitSignedTransaction(params)).rejects.toBeInstanceOf(PayoutEffectBlockedError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://horizon-fixture.invalid/transactions', expect.objectContaining({
      method: 'POST', redirect: 'error', body: new URLSearchParams({ tx: tx.toXDR() }).toString(),
    }));
  });

  it.each(['WITHDRAWAL_LOCK','WITHDRAWAL_FINALIZED','WITHDRAWAL_REVERTED'])(
    'freeze rolls back the whole %s transaction, while cold proof and confirmation remain writable', async (journalType) => {
      sqlite.exec('CREATE TABLE atomic_witness(id TEXT PRIMARY KEY);');
      pause('EMERGENCY_LEDGER_FREEZE');
      const transaction = sqlite.transaction(() => {
        sqlite.prepare("INSERT INTO atomic_witness VALUES ('must-rollback')").run();
        sqlite.prepare(`INSERT INTO ledger_journal_batches(id,idempotency_key,journal_type,payload_fingerprint,status)
          VALUES ('batch','batch',?,'fixture','INFLIGHT')`).run(journalType);
      });
      expect(transaction).toThrow();
      expect(sqlite.prepare('SELECT COUNT(*) AS count FROM atomic_witness').get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT COUNT(*) AS count FROM ledger_journal_batches WHERE id = 'batch'").get()).toEqual({ count: 0 });
      expect(sqlite.prepare("SELECT id FROM ledger_journal_batches WHERE id='lock'").get()).toEqual({ id: 'lock' });
      expect(sqlite.prepare("SELECT payout_id FROM settlement_broadcasts WHERE payout_id='payout-1'").get()).toEqual({ payout_id: 'payout-1' });
      expect(sqlite.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND tbl_name='cold_settlement_claims'").all()).toEqual([]);
      sqlite.prepare(`INSERT INTO cold_settlement_claims(network,tx_hash,operation_id,payout_id,asset,amount_token_units,lock_batch_id,chain,block_reference,source_address,recipient_address)
        VALUES ('eip155:42161',?,'log:0','payout-1','USDC','10000000','lock','arbitrum','block:1','source','recipient')`).run(hash);
      expect(() => sqlite.prepare(`INSERT INTO cold_settlement_claims(network,tx_hash,operation_id,payout_id,asset,amount_token_units,lock_batch_id,chain,block_reference,source_address,recipient_address)
        VALUES ('eip155:42161',?,'log:0','payout-1','USDC','10000000','lock','arbitrum','block:1','source','recipient')`).run(hash)).toThrow();
      receiptConfirmed = true;
      await expect(machine.recoverUncertainBroadcast('payout-1', { passiveOnly: true })).resolves.toMatchObject({ state: 'CONFIRMED' });
    });
});


describe('EVM failed receipt finality', () => {
  it.each(['finalized', 'missing finality', 'wrong chain', 'noncanonical block'] as const)(
    'requires canonical finalized failure on the configured chain: %s', async (proof) => {
      const transactionHash = keccak256('0x02');
      const blockHash = `0x${'ab'.repeat(32)}`;
      const rpc: EvmJsonRpcTransport = {
        async call<T>(method: string, params: unknown[] = []): Promise<T> {
          if (method === 'eth_chainId') return (proof === 'wrong chain' ? '0x2105' : '0xa4b1') as T;
          if (method === 'eth_getTransactionReceipt') return { status: '0x0', transactionHash, blockHash, blockNumber: '0x10' } as T;
          if (method === 'eth_getBlockByNumber') {
            if (params[0] === 'finalized' && proof === 'missing finality') return null as T;
            const hash = params[0] === '0x10' && proof === 'noncanonical block' ? `0x${'cd'.repeat(32)}` : blockHash;
            return { hash, number: '0x10' } as T;
          }
          throw new Error(`Unexpected simulated method ${method}`);
        },
      };
      const adapter = new ArbitrumBaseUsdcAdapter({ chain: 'arbitrum', hotWalletAddress: fixtureSigner, primaryRpc: rpc });
      const result = adapter.getTransactionReceipt(transactionHash);
      if (proof === 'finalized') await expect(result).resolves.toMatchObject({ reverted: true, transactionHash });
      else await expect(result).rejects.toThrow(/configured chain|canonical finalized block/);
    }
  );
});
