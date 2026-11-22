/** @jest-environment node */
jest.mock('@turnkey/sdk-server', () => ({ Turnkey: jest.fn() }));
jest.mock('@/lib/analytics', () => ({ analytics: { track: jest.fn() } }));
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { SqliteD1Adapter } from '@/lib/ledger/double-entry-ledger';
import type { D1Database } from '@/lib/db';
import { TurnkeySigner, type ClaimHotWalletSigningSlotParams } from '../turnkey-signer';
import { BroadcastRecoveryMachine, type StellarBroadcastTransport } from '../broadcast-recovery-machine';
import { HorizonStellarBroadcastTransport } from '../stellar-horizon-transport';
import type { StellarService } from '../stellar-service';
import { reconcilePendingSettlementBroadcasts } from '../settlement-reconciler';

const unit = BigInt(100000000);
const transport = {
  signEvmDigest: jest.fn(async (): Promise<never> => { throw new Error('No network signing in exposure tests'); }),
  signStellarEnvelope: jest.fn(async (): Promise<never> => { throw new Error('No network signing in exposure tests'); }),
};
function signer(address = '0x3333333333333333333333333333333333333333') {
  return new TurnkeySigner({ transport, evmHotWalletAddress: address, stellarHotWalletAddress: 'G_TEST',
    safeColdMultisigAddresses: { arbitrum: '0x4444444444444444444444444444444444444444' } });
}
function params(id: string, amount = BigInt(250) * unit, chain: 'arbitrum' | 'base' = 'arbitrum'): ClaimHotWalletSigningSlotParams {
  return { payoutId: id, idempotencyKey: id, affiliateId: 'owner', chain,
    recipientAddress: '0x1111111111111111111111111111111111111111', amountUnits1e8: amount,
    chainTokenUnits: (amount / BigInt(100)).toString(), chainDecimals: 6, lockBatchId: `lock-${id}` };
}
function apply(sqlite: Database.Database, file: string) {
  // Back up each isolated fixture before any schema migration; never touch a live DB.
  const backup = new Database(sqlite.serialize());
  try { sqlite.exec(readFileSync(path.resolve(process.cwd(), 'src/database/migrations', file), 'utf8')); }
  finally { backup.close(); }
}
function schema(includeExposure = true) {
  const sqlite = new Database(':memory:');
  sqlite.exec('CREATE TABLE profiles(id TEXT PRIMARY KEY); CREATE TABLE deals(id TEXT PRIMARY KEY);');
  for (const file of ['028_ascendancy_audit_core.sql', '033_cold_settlement_claims.sql',
    '034_withdrawal_freeze_at_write.sql', '035_payout_effect_grants.sql']) apply(sqlite, file);
  if (includeExposure) apply(sqlite, '036_durable_hot_exposure.sql');
  return sqlite;
}
const snapshotSource = schema();
const snapshot = snapshotSource.serialize();
snapshotSource.close();

describe('durable global exposure invariants', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  const treasury = signer();
  const total = () => treasury.getRolling24hHotVolumeUnits1e8(db);
  const now = () => (sqlite.prepare("SELECT unixepoch('now') AS n").get() as { n: number }).n;
  function lock(id: string, amount = BigInt(250) * unit) {
    sqlite.prepare(`INSERT INTO ledger_journal_batches
      (id,idempotency_key,payload_fingerprint,journal_type,status,gross_commission_units,payout_id,metadata)
      VALUES (?,?,?,'WITHDRAWAL_LOCK','INFLIGHT',?,?,?)`)
      .run(`lock-${id}`, `lock-${id}`, id, Number(amount), id,
        JSON.stringify({ payoutId: id, ownerId: 'owner', ownerType: 'affiliate', lockedAmountUnits: amount.toString() }));
  }
  function row(id: string, state = 'BROADCAST_PENDING', amount = BigInt(250) * unit, createdHoursAgo = 25) {
    lock(id, amount);
    const p = params(id, amount);
    sqlite.prepare(`INSERT INTO settlement_broadcasts
      (payout_id,idempotency_key,affiliate_id,chain,recipient_address,amount_units_1e8,
       chain_token_units,chain_decimals,state,lock_batch_id,created_at,updated_at)
      VALUES (?,?,'owner','arbitrum',?,?,?,6,?,?,datetime('now',?),datetime('now',?))`)
      .run(id, id, p.recipientAddress, Number(amount), p.chainTokenUnits, state, `lock-${id}`, `-${createdHoursAgo} hours`, `-${createdHoursAgo} hours`);
  }
  function released(id: string) {
    row(id, 'FAILED_ABORTED');
    sqlite.prepare(`INSERT INTO payout_effect_attempts
      (attempt_id,payout_id,safety_epoch,lock_batch_id,owner_id,owner_type)
      VALUES (?,?,1,?,'owner','affiliate')`).run(`attempt-${id}`, id, `lock-${id}`);
    sqlite.prepare(`UPDATE settlement_broadcasts SET exposure_release_kind = 'PRE_SUBMISSION_ABORT',
      exposure_released_at = unixepoch('now'), exposure_release_attempt_id = ? WHERE payout_id = ?`)
      .run(`attempt-${id}`, id);
  }
  beforeEach(() => {
    sqlite = new Database(snapshot);
    db = new SqliteD1Adapter(sqlite);
  });
  afterEach(() => sqlite.close());

  it('admits exactly the single-transfer ceiling and refuses one unit above it', async () => {
    lock('exact');
    expect((await treasury.claimHotWalletSigningSlot(db, params('exact'))).claimed).toBe(true);
    lock('over', BigInt(250) * unit + BigInt(1));
    expect(await treasury.claimHotWalletSigningSlot(db, params('over', BigInt(250) * unit + BigInt(1))))
      .toMatchObject({ claimed: false, violationCode: 'SINGLE_TX_CAP_EXCEEDED' });
  });
  it('admits exactly the global ceiling but denies one unit above it', async () => {
    row('existing', 'BROADCAST_PENDING', BigInt(1250) * unit);
    lock('exact');
    expect((await treasury.claimHotWalletSigningSlot(db, params('exact'))).claimed).toBe(true);
    expect(await total()).toBe(BigInt(1500) * unit);
    expect((await treasury.evaluateHotWalletPolicy(db, BigInt(1))).allowedHotSign).toBe(false);
  });
  it.each(['SIGNING', 'BROADCAST_PENDING', 'FAILED_ABORTED', 'EXPIRED_RECOVERED', 'CONFIRMED', 'QUEUED_COLD_SAFE'])(
    'retains aged ambiguous %s obligations', async state => {
      row('aged', state);
      expect(await total()).toBe(BigInt(250) * unit);
    });
  it('counts a newly observed settlement independently of its old creation time', async () => {
    row('recent', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_lane='HOT', confirmation_observed_at=?").run(now());
    expect(await total()).toBe(BigInt(250) * unit);
  });
  it('keeps the 24-hour boundary inclusive and expires only older verified observations', async () => {
    const fixedNow = 1_800_000_000;
    sqlite.function('unixepoch', (value: unknown) => {
      if (value !== 'now') throw new Error('Unexpected SQLite clock argument');
      return fixedNow;
    });
    row('boundary', 'CONFIRMED', BigInt(250) * unit, 0);
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_lane='HOT', confirmation_observed_at=?").run(fixedNow - 86400);
    expect(await total()).toBe(BigInt(250) * unit);
    sqlite.prepare('UPDATE settlement_broadcasts SET confirmation_observed_at=confirmation_observed_at-1').run();
    expect(await total()).toBe(BigInt(0));
  });
  it.each([null, 'bad', 0, -1, 1.5, 99999999999])('retains malformed or future confirmation time %s', async timestamp => {
    row('bad-time', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_lane='HOT', confirmation_observed_at=?").run(timestamp);
    expect(await total()).toBe(BigInt(250) * unit);
  });
  it('excludes cold confirmations only when a lane and durable timestamp are present', async () => {
    row('cold', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_lane='COLD',confirmation_observed_at=unixepoch('now')").run();
    expect(await total()).toBe(BigInt(0));
    sqlite.prepare('UPDATE settlement_broadcasts SET confirmation_observed_at=NULL').run();
    expect(await total()).toBe(BigInt(250) * unit);
  });
  it('releases proven pre-submission aborts, but retains terminal labels without exact attempt proof', async () => {
    released('safe');
    expect(await total()).toBe(BigInt(0));
    sqlite.prepare("UPDATE payout_effect_attempts SET owner_id='different'").run();
    expect(await total()).toBe(BigInt(250) * unit);
  });
  it('atomically admits only one competing chain/service instance across insert and retry branches', async () => {
    row('outstanding', 'BROADCAST_PENDING', BigInt(1250) * unit);
    released('retry'); lock('new');
    const results = await Promise.all([
      treasury.claimHotWalletSigningSlot(db, params('retry')),
      signer('0x5555555555555555555555555555555555555555').claimHotWalletSigningSlot(db, params('new', BigInt(250) * unit, 'base')),
    ]);
    expect(results.filter(result => result.claimed)).toHaveLength(1);
    expect(await total()).toBe(BigInt(1500) * unit);
  });
  it('never treats RBF candidates as separate obligations', async () => {
    row('rbf');
    sqlite.prepare("UPDATE settlement_broadcasts SET candidate_tx_hashes='[\"first\",\"replacement\"]', rbf_candidate_tx_hash='replacement'").run();
    expect(await total()).toBe(BigInt(250) * unit);
    expect(await treasury.getRolling24hHotVolumeUnits1e8(db, 'rbf')).toBe(BigInt(0));
  });
  it('checks global capacity again when reopening a proven unsubmitted obligation', async () => {
    released('retry'); row('full', 'BROADCAST_PENDING', BigInt(1500) * unit);
    expect((await treasury.claimHotWalletSigningSlot(db, params('retry'))).claimed).toBe(false);
    expect(await total()).toBe(BigInt(1500) * unit);
  });
  it.each(['FAILED_ABORTED', 'EXPIRED_RECOVERED'])('denies reopening and refunds for historical %s', async state => {
    row('legacy', state);
    expect((await treasury.claimHotWalletSigningSlot(db, params('legacy'))).claimed).toBe(false);
    expect(() => sqlite.prepare(`INSERT INTO ledger_journal_batches
      (id,idempotency_key,payload_fingerprint,journal_type,status,metadata)
      VALUES ('refund','refund','refund','WITHDRAWAL_REVERTED','VOIDED',?)`)
      .run(JSON.stringify({ lockBatchId: 'lock-legacy' }))).toThrow(/terminal proof/);
  });
  it('counts all wallets and chains under one global ceiling', async () => {
    for (let i = 0; i < 6; i++) {
      lock(`p-${i}`);
      expect((await signer(`0x${String(i + 1).repeat(40)}`).claimHotWalletSigningSlot(db,
        params(`p-${i}`, BigInt(250) * unit, i % 2 ? 'base' : 'arbitrum'))).claimed).toBe(true);
    }
    lock('seventh');
    expect((await treasury.claimHotWalletSigningSlot(db, params('seventh'))).claimed).toBe(false);
  });
  it('fails closed on decimal amounts, missing schema, and exact integer overflow', async () => {
    row('invalid');
    sqlite.prepare('UPDATE settlement_broadcasts SET amount_units_1e8=1000000000.5').run();
    await expect(total()).rejects.toThrow(/Invalid/);
    lock('new');
    await expect(treasury.claimHotWalletSigningSlot(db, params('new'))).rejects.toThrow(/Invalid/);
    sqlite.prepare('UPDATE settlement_broadcasts SET amount_units_1e8=9223372036854775807').run();
    row('overflow');
    // Native SQLite errors can come from a different Jest realm; assert their actual fields.
    const overflow = { code: 'SQLITE_ERROR', message: expect.stringMatching(/integer overflow/) };
    await expect(total()).rejects.toMatchObject(overflow);
    await expect(treasury.claimHotWalletSigningSlot(db, params('new'))).rejects.toMatchObject(overflow);
    const old = schema(false);
    try {
      await expect(treasury.getRolling24hHotVolumeUnits1e8(new SqliteD1Adapter(old))).rejects.toMatchObject({
        code: 'SQLITE_ERROR', message: expect.stringMatching(/no such (?:table|column)/),
      });
    } finally {
      old.close();
    }
  });
  it('does not infer claim ownership from a later SIGNING read when change metadata is absent', async () => {
    lock('uncertain');
    const original = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation(query => {
      const statement = original(query);
      if (query.trimStart().startsWith('INSERT INTO settlement_broadcasts')) {
        const bind = statement.bind.bind(statement);
        statement.bind = (...values: unknown[]) => {
          const bound = bind(...values);
          const run = bound.run.bind(bound);
          bound.run = async () => { const result = await run(); return { success: result.success, meta: { ...result.meta, changes: undefined } }; };
          return bound;
        };
      }
      return statement;
    });
    await expect(treasury.claimHotWalletSigningSlot(db, params('uncertain'))).rejects.toThrow(/unconfirmed/);
    expect(await total()).toBe(BigInt(250) * unit);
  });
  it('preserves observation time on confirmation replay', async () => {
    row('done', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_lane='HOT',confirmation_observed_at=?").run(now() - 100);
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {} });
    const before = sqlite.prepare('SELECT confirmation_observed_at FROM settlement_broadcasts').get();
    await machine.recoverUncertainBroadcast('done', { passiveOnly: true });
    expect(sqlite.prepare('SELECT confirmation_observed_at FROM settlement_broadcasts').get()).toEqual(before);
  });
  it('retains confirmed status without canonical finality and ignores application clock shifts', async () => {
    row('unfinalized', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_lane='UNVERIFIED_HOT', confirmation_observed_at=?").run(now() - 90000);
    expect(await total()).toBe(BigInt(250) * unit);
    jest.spyOn(Date, 'now').mockReturnValue(9999999999999);
    try { expect(await total()).toBe(BigInt(250) * unit); }
    finally { jest.restoreAllMocks(); }
  });
  it('retains Stellar hash/status-only failure evidence and does not auto-refund', async () => {
    row('stellar');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='7',tx_hash='hash'").run();
    const lookup = jest.fn(async () => ({ found: true, successful: false }));
    const stellar: StellarBroadcastTransport = {
      lookupTransaction: lookup,
      getAccountSequence: jest.fn(async () => BigInt(7)),
      buildUnsignedUsdcPayment: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      submitSignedTransaction: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      verifyTrustline: jest.fn(async () => true),
    };
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {}, stellarTransport: stellar });
    await machine.recoverUncertainBroadcast('stellar', { passiveOnly: true });
    expect(await total()).toBe(BigInt(250) * unit);
    const result = await reconcilePendingSettlementBroadcasts(db, { machine });
    expect(result.reverted).toBe(0);
  });
  it('gives recoverable work a separate quota from more-than-limit ambiguous terminal rows over repeated ticks', async () => {
    for (let i = 0; i < 5; i++) row(`legacy-${i}`, 'FAILED_ABORTED');
    for (let i = 0; i < 3; i++) {
      row(`ready-${i}`);
      sqlite.prepare("UPDATE settlement_broadcasts SET updated_at=datetime('now') WHERE payout_id=?").run(`ready-${i}`);
    }
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {} });
    const recover = jest.spyOn(machine, 'recoverUncertainBroadcast').mockImplementation(async id => {
      sqlite.prepare("UPDATE settlement_broadcasts SET state='CONFIRMED' WHERE payout_id=?").run(id);
      sqlite.prepare("UPDATE ledger_journal_batches SET status='SETTLED' WHERE payout_id=?").run(id);
      return { payoutId: id, chain: 'arbitrum', state: 'CONFIRMED', action: 'RECONCILED_ON_CHAIN',
        txHash: 'proof', assignedNonce: 0, stellarSequence: null, timeboundsMaxUnix: null };
    });
    for (let tick = 0; tick < 3; tick++) {
      await reconcilePendingSettlementBroadcasts(db, { machine, limit: 1 });
    }
    expect(recover).toHaveBeenCalledTimes(3);
    expect(new Set(recover.mock.calls.map(([id]) => id)).size).toBe(3);
    expect(sqlite.prepare("SELECT COUNT(*) AS n FROM ledger_journal_batches WHERE payout_id LIKE 'legacy-%' AND status='INFLIGHT'").get())
      .toEqual({ n: 5 });
  });
  it('preserves historical evidence when applying the additive migration on a backed-up fixture', async () => {
    const legacy = schema(false);
    try {
      legacy.prepare(`INSERT INTO settlement_broadcasts
        (payout_id,idempotency_key,affiliate_id,chain,recipient_address,amount_units_1e8,chain_token_units,chain_decimals,state)
        VALUES ('old','old','owner','base','recipient',25000000000,'250000000',6,'FAILED_ABORTED')`).run();
      const before = legacy.prepare('SELECT * FROM settlement_broadcasts').get() as Record<string, unknown>;
      apply(legacy, '036_durable_hot_exposure.sql');
      expect(legacy.prepare('SELECT * FROM settlement_broadcasts').get()).toMatchObject(before);
      expect(await treasury.getRolling24hHotVolumeUnits1e8(new SqliteD1Adapter(legacy))).toBe(BigInt(250) * unit);
    } finally { legacy.close(); }
  });
  it('promotes Stellar confirmation to HOT only when ledger inclusion is proven and releases after 24h', async () => {
    row('stellar-final');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='11',tx_hash='hash-final'").run();
    const stellar: StellarBroadcastTransport = {
      lookupTransaction: jest.fn(async () => ({ found: true, successful: true, ledger: 5123456 })),
      getAccountSequence: jest.fn(async () => BigInt(11)),
      buildUnsignedUsdcPayment: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      submitSignedTransaction: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      verifyTrustline: jest.fn(async () => true),
    };
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {}, stellarTransport: stellar });
    await machine.recoverUncertainBroadcast('stellar-final', { passiveOnly: true });
    expect(sqlite.prepare("SELECT confirmation_lane FROM settlement_broadcasts WHERE payout_id='stellar-final'").get())
      .toEqual({ confirmation_lane: 'HOT' });
    expect(await total()).toBe(BigInt(250) * unit);
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_observed_at=? WHERE payout_id='stellar-final'").run(now() - 86401);
    expect(await total()).toBe(BigInt(0));
  });
  it('releases hot exposure and allows refund on chain-finalized Stellar failure with matching grant', async () => {
    row('stellar-failed-final');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='12',tx_hash='hash-failed-final'").run();
    sqlite.prepare(`INSERT INTO payout_effect_attempts
      (attempt_id,payout_id,lock_batch_id,owner_id,chain,signer_address,stellar_sequence,safety_epoch,active)
      VALUES ('att-sf','stellar-failed-final','lock-stellar-failed-final','owner','stellar','G_TEST','12',1,1)`).run();
    sqlite.prepare(`INSERT INTO payout_effect_grants
      (grant_id,attempt_id,payout_id,effect_kind,safety_epoch,payload_sha256,tx_hash)
      VALUES ('gr-sf','att-sf','stellar-failed-final','STELLAR_SUBMIT',1,'${'a'.repeat(64)}','hash-failed-final')`).run();
    const stellar: StellarBroadcastTransport = {
      lookupTransaction: jest.fn(async () => ({ found: true, successful: false, ledger: 5123499 })),
      getAccountSequence: jest.fn(async () => BigInt(12)),
      buildUnsignedUsdcPayment: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      submitSignedTransaction: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      verifyTrustline: jest.fn(async () => true),
    };
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {}, stellarTransport: stellar });
    await machine.recoverUncertainBroadcast('stellar-failed-final', { passiveOnly: true });
    expect(sqlite.prepare("SELECT exposure_release_kind FROM settlement_broadcasts WHERE payout_id='stellar-failed-final'").get())
      .toEqual({ exposure_release_kind: 'CHAIN_FINALIZED_FAILURE' });
    expect(await total()).toBe(BigInt(0));
    expect(sqlite.prepare("SELECT payout_id FROM settlement_verified_exposure_releases WHERE payout_id='stellar-failed-final'").get())
      .toEqual({ payout_id: 'stellar-failed-final' });
    expect(() => sqlite.prepare(`INSERT INTO ledger_journal_batches
      (id,idempotency_key,payload_fingerprint,journal_type,status,gross_commission_units,payout_id,metadata)
      VALUES ('rev-sf','rev-sf','rev-sf','WITHDRAWAL_REVERTED','SETTLED',25000000000,'stellar-failed-final',?)`)
      .run(JSON.stringify({ lockBatchId: 'lock-stellar-failed-final' }))).not.toThrow();
  });

  it('passively promotes CONFIRMED UNVERIFIED_HOT payouts to HOT once finality is verified, even while paused, allowing 24h cap age-out', async () => {
    row('stellar-fast-confirm', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='19',tx_hash='hash-fast-confirm',confirmation_lane='UNVERIFIED_HOT',confirmation_observed_at=? WHERE payout_id='stellar-fast-confirm'").run(now() - 86401);
    sqlite.prepare("UPDATE ledger_journal_batches SET status='SETTLED' WHERE payout_id='stellar-fast-confirm'").run();
    // Activate EMERGENCY_PAUSE to verify passive finality upgrade requires zero signing/broadcasting
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value='true' WHERE flag_key='EMERGENCY_PAUSE'").run();

    // Before finality verification, UNVERIFIED_HOT does not age out even after >24h
    expect(await total()).toBe(BigInt(250) * unit);

    const stellar: StellarBroadcastTransport = {
      lookupTransaction: jest.fn(async () => ({ found: true, successful: true, ledger: 5123999 })),
      getAccountSequence: jest.fn(async () => BigInt(19)),
      buildUnsignedUsdcPayment: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      submitSignedTransaction: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      verifyTrustline: jest.fn(async () => true),
    };
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {}, stellarTransport: stellar });
    await reconcilePendingSettlementBroadcasts(db, { machine });

    expect(sqlite.prepare("SELECT confirmation_lane FROM settlement_broadcasts WHERE payout_id='stellar-fast-confirm'").get())
      .toEqual({ confirmation_lane: 'HOT' });
    // Hardened invariant: UNVERIFIED_HOT -> HOT unconditionally stamps fresh unixepoch('now')
    // so a stale unverified timestamp cannot prematurely release 24h rolling exposure.
    const observedAfterPromotion = (
      sqlite.prepare("SELECT confirmation_observed_at FROM settlement_broadcasts WHERE payout_id='stellar-fast-confirm'").get() as {
        confirmation_observed_at: number;
      }
    ).confirmation_observed_at;
    expect(observedAfterPromotion).toBeGreaterThanOrEqual(now() - 5);
    expect(observedAfterPromotion).toBeLessThanOrEqual(now() + 1);
    expect(await total()).toBe(BigInt(250) * unit);
    // Once 24h elapses after verified finality observation, exposure ages out cleanly
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_observed_at=? WHERE payout_id='stellar-fast-confirm'").run(now() - 86401);
    expect(await total()).toBe(BigInt(0));
  });

  it('propagates Horizon ledger_attr via HorizonStellarBroadcastTransport.lookupTransaction to promote UNVERIFIED_HOT to HOT', async () => {
    const txHash = 'a'.repeat(64);
    row('stellar-horizon-ledger', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='21',tx_hash=?,confirmation_lane='UNVERIFIED_HOT',confirmation_observed_at=? WHERE payout_id='stellar-horizon-ledger'").run(txHash, now() - 86401);
    sqlite.prepare("UPDATE ledger_journal_batches SET status='SETTLED' WHERE payout_id='stellar-horizon-ledger'").run();

    const stubService = {
      getTransaction: jest.fn(async () => ({
        id: txHash,
        hash: txHash,
        successful: true,
        ledger_attr: 5124001,
      })),
    } as unknown as StellarService;
    const realTransport = new HorizonStellarBroadcastTransport({
      stellarService: stubService,
    });

    const lookup = await realTransport.lookupTransaction(txHash);
    expect(lookup).toEqual({ found: true, successful: true, ledger: 5124001 });

    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {}, stellarTransport: realTransport });
    await reconcilePendingSettlementBroadcasts(db, { machine });

    expect(sqlite.prepare("SELECT confirmation_lane FROM settlement_broadcasts WHERE payout_id='stellar-horizon-ledger'").get())
      .toEqual({ confirmation_lane: 'HOT' });
    const observedHorizon = (
      sqlite.prepare("SELECT confirmation_observed_at FROM settlement_broadcasts WHERE payout_id='stellar-horizon-ledger'").get() as {
        confirmation_observed_at: number;
      }
    ).confirmation_observed_at;
    expect(observedHorizon).toBeGreaterThanOrEqual(now() - 5);
    expect(observedHorizon).toBeLessThanOrEqual(now() + 1);
    expect(await total()).toBe(BigInt(250) * unit);
    sqlite.prepare("UPDATE settlement_broadcasts SET confirmation_observed_at=? WHERE payout_id='stellar-horizon-ledger'").run(now() - 86401);
    expect(await total()).toBe(BigInt(0));
  });

  it('prioritizes BROADCAST_PENDING ahead of UNVERIFIED_HOT so lagging finality never starves active recovery', async () => {
    row('older-unverified-hot', 'CONFIRMED');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='30',tx_hash='hash-old-hot',confirmation_lane='UNVERIFIED_HOT',updated_at=datetime('now','-10 minutes') WHERE payout_id='older-unverified-hot'").run();
    sqlite.prepare("UPDATE ledger_journal_batches SET status='SETTLED' WHERE payout_id='older-unverified-hot'").run();

    row('newer-pending', 'BROADCAST_PENDING');
    sqlite.prepare("UPDATE settlement_broadcasts SET chain='stellar',chain_decimals=7,signer_address='G_TEST',stellar_sequence='31',tx_hash='hash-new-pending',updated_at=datetime('now') WHERE payout_id='newer-pending'").run();

    const lookupMock = jest.fn(async (hash: string) => {
      if (hash === 'hash-new-pending') {
        return { found: true, successful: true, ledger: 5124002 };
      }
      return { found: false, successful: false };
    });
    const stellar: StellarBroadcastTransport = {
      lookupTransaction: lookupMock,
      getAccountSequence: jest.fn(async () => BigInt(31)),
      buildUnsignedUsdcPayment: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      submitSignedTransaction: jest.fn(async (): Promise<never> => { throw new Error('unused'); }),
      verifyTrustline: jest.fn(async () => true),
    };
    const machine = new BroadcastRecoveryMachine({ db, turnkeySigner: treasury, evmAdapters: {}, stellarTransport: stellar });
    await reconcilePendingSettlementBroadcasts(db, { machine, limit: 1 });

    // Even with limit=1 and older UNVERIFIED_HOT row, newer BROADCAST_PENDING is processed first
    expect(lookupMock).toHaveBeenCalledWith('hash-new-pending');
    expect(sqlite.prepare("SELECT state, confirmation_lane FROM settlement_broadcasts WHERE payout_id='newer-pending'").get())
      .toEqual({ state: 'CONFIRMED', confirmation_lane: 'HOT' });
  });

  it('rejects enqueueColdSafeMultisig explicitly when existing hot broadcast row retains unresolved exposure', async () => {
    row('active-hot-pending', 'BROADCAST_PENDING');
    await expect(
      treasury.enqueueColdSafeMultisig(db, {
        payoutId: 'active-hot-pending',
        idempotencyKey: 'cold-overwrite-attempt',
        affiliateId: 'owner',
        chain: 'base',
        recipientAddress: '0x1111111111111111111111111111111111111111',
        amountUnits1e8: BigInt(250) * unit,
        chainTokenUnits: '250000000',
        chainDecimals: 6,
        lockBatchId: 'lock-active-hot-pending',
        reason: 'Attempt to overwrite active hot broadcast',
      })
    ).rejects.toThrow(/retains unresolved hot exposure/i);
  });
});
