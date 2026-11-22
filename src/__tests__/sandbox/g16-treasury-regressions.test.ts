/** @jest-environment node */
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import {
  BroadcastRecoveryMachine,
  type SettlementBroadcastRow,
} from '@/lib/payouts/broadcast-recovery-machine';
import {
  HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8,
  TurnkeySigner,
  type EvmDigestSignature,
  type StellarEnvelopeSignature,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import {
  ARBITRUM_ONE_CHAIN_ID,
  ARBITRUM_SEPOLIA_CHAIN_ID,
  BASE_MAINNET_CHAIN_ID,
  BASE_SEPOLIA_CHAIN_ID,
  ArbitrumBaseUsdcAdapter,
  CANONICAL_ARBITRUM_NATIVE_USDC,
  CANONICAL_ARBITRUM_SEPOLIA_USDC,
  CANONICAL_BASE_NATIVE_USDC,
  CANONICAL_BASE_SEPOLIA_USDC,
  REJECTED_BASE_BRIDGED_USDBC,
  type EvmJsonRpcTransport,
} from '@/lib/payouts/adapters/arbitrum-base-usdc-adapter';
import { keccak256, stringToHex, type Hex } from 'viem';
import { reconcilePendingSettlementBroadcasts } from '@/lib/payouts/settlement-reconciler';
import { DoubleEntryLedgerService } from '@/lib/ledger/double-entry-ledger';
import { HorizonStellarBroadcastTransport } from '@/lib/payouts/stellar-horizon-transport';
import { CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER, StellarNetwork } from '@/lib/payouts/stellar-service';

interface SyncPreparedStatement extends D1PreparedStatement {
  _runSync: () => D1Result<unknown>;
}

function createSqliteD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let boundParams: unknown[] = [];
      const stmt = sqlite.prepare(sql);
      const prepared: SyncPreparedStatement = {
        bind(...params: unknown[]) {
          boundParams = params;
          return prepared;
        },
        _runSync() {
          const info = stmt.run(...boundParams);
          return {
            results: [],
            success: true,
            meta: {
              changes: info.changes,
              rows_written: info.changes,
              last_row_id: Number(info.lastInsertRowid),
              duration: 0,
            },
          };
        },
        async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          return prepared._runSync() as D1Result<T>;
        },
        async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
          const row = stmt.get(...boundParams) as Record<string, unknown> | undefined;
          if (!row) return null;
          if (colName) return ((row[colName] as T) ?? null);
          return row as unknown as T;
        },
        async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          const rows = stmt.all(...boundParams) as T[];
          return { results: rows, success: true, meta: { duration: 0, changes: 0, rows_written: 0, last_row_id: 0 } };
        },
        async raw<T = unknown[]>(): Promise<T[]> {
          return stmt.raw().all(...boundParams) as T[];
        },
      };
      return prepared;
    },
    async batch<T = Record<string, unknown>>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> {
      const transaction = sqlite.transaction(() =>
        statements.map((statement) =>
          (statement as SyncPreparedStatement)._runSync() as D1Result<T>
        )
      );
      return transaction();
    },
    async exec(sql: string): Promise<D1Result<Record<string, unknown>>> {
      sqlite.exec(sql);
      return { success: true, meta: { duration: 0, changes: 0, rows_written: 0, last_row_id: 0 } };
    },
    async close() { sqlite.close(); },
    async dump(): Promise<string> {
      throw new Error('D1 dump is not used by this fixture');
    },
  };
}

function createAscendancyDb(schema: 'normal' | 'before-cold-claims' = 'normal'): { sqlite: Database.Database; db: D1Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE profiles (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE deals (id TEXT PRIMARY KEY);
  `);
  const migrationPath = path.resolve(
    process.cwd(),
    'src/database/migrations/028_ascendancy_audit_core.sql'
  );
  sqlite.exec(fs.readFileSync(migrationPath, 'utf8'));
  if (schema === 'normal') {
    sqlite.exec(fs.readFileSync('src/database/migrations/032_persistent_d1_rate_limits.sql', 'utf8'));
    applyColdClaimsMigration(sqlite);
    applyPostClaimMigrations(sqlite);
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function applyColdClaimsMigration(sqlite: Database.Database) {
  const snapshot = new Database(sqlite.serialize());
  try {
    expect(snapshot.prepare("SELECT name FROM sqlite_master WHERE name = 'cold_settlement_claims'").get()).toBeUndefined();
    const migration = fs.readFileSync('src/database/migrations/033_cold_settlement_claims.sql', 'utf8');
    sqlite.exec(migration);
    sqlite.exec(migration);
  } finally {
    snapshot.close();
  }
}

function applyPostClaimMigrations(sqlite: Database.Database) {
  const snapshot = new Database(sqlite.serialize());
  try {
    sqlite.exec(fs.readFileSync('src/database/migrations/034_withdrawal_freeze_at_write.sql', 'utf8'));
    sqlite.exec(fs.readFileSync('src/database/migrations/035_payout_effect_grants.sql', 'utf8'));
    sqlite.exec(fs.readFileSync('src/database/migrations/036_durable_hot_exposure.sql', 'utf8'));
  } finally {
    snapshot.close();
  }
}

const HOT_WALLET_ADDRESS = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const STELLAR_HOT_WALLET_ADDRESS = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const EVM_RECIPIENT = '0x0000000000000000000000000000000000000101';
const COLD_SAFE_TX_HASH = '0x' + 'ab'.repeat(32);
const COLD_PAYOUT_UNITS_1E8 = 30_000_000_000; // $300.00, represented in 10^-8 ledger units.
const COLD_SOURCE = '0x0000000000000000000000000000000000000202';
const STELLAR_RECIPIENT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const COLD_PAYOUT_TOKEN_UNITS = '300000000'; // $300.00 USDC at 6 decimals.

class RecordingSigningTransport implements TurnkeySigningTransport {
  readonly evmSignCalls: string[] = [];
  readonly stellarSignCalls: string[] = [];

  async signEvmDigest(params: {
    chain: 'arbitrum' | 'base';
    signerAddress: string;
    digestHex: Hex;
    payoutId: string;
  }): Promise<EvmDigestSignature> {
    this.evmSignCalls.push(params.payoutId);
    return {
      r: `0x${'01'.repeat(32)}`,
      s: `0x${'02'.repeat(32)}`,
      yParity: 0,
      activityId: `mock-evm-${params.payoutId}`,
    };
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    this.stellarSignCalls.push(params.payoutId);
    return {
      signedEnvelopeXdr: `mock-signed:${params.unsignedEnvelopeXdr}`,
      txHash: params.txHashHex,
      signatureBase64: Buffer.alloc(64, 1).toString('base64'),
      activityId: `mock-stellar-${params.payoutId}`,
    };
  }
}

function createSigner(transport: RecordingSigningTransport): TurnkeySigner {
  return new TurnkeySigner({
    transport,
    evmHotWalletAddress: HOT_WALLET_ADDRESS,
    stellarHotWalletAddress: STELLAR_HOT_WALLET_ADDRESS,
    safeColdMultisigAddresses: { arbitrum: COLD_SOURCE, base: COLD_SOURCE, stellar: STELLAR_HOT_WALLET_ADDRESS },
  });
}

async function seedColdSafePayout(
  sqlite: Database.Database,
  db: D1Database,
  payoutId: string,
  chain: 'arbitrum' | 'base' | 'stellar' = 'arbitrum',
  recipient = chain === 'stellar' ? STELLAR_RECIPIENT : EVM_RECIPIENT
): Promise<string> {
  const owner = `affiliate-${payoutId}`;
  sqlite.prepare(`INSERT INTO ledger_accounts (id, owner_type, owner_id, account_code, settled_balance_units)
    VALUES (?, 'affiliate', ?, ?, ?)`).run(`acct_affiliate_${owner}`, owner, `affiliate:${owner}`, COLD_PAYOUT_UNITS_1E8);
  const { batch } = await new DoubleEntryLedgerService(db).lockSettledForWithdrawal({
    payoutId, ownerId: owner, ownerType: 'affiliate', idempotencyKey: `wd_lock:idem-${payoutId}`,
    amountUnits: BigInt(COLD_PAYOUT_UNITS_1E8), chain,
  });
  sqlite.prepare(`INSERT INTO settlement_broadcasts (
    payout_id, idempotency_key, affiliate_id, chain, recipient_address,
    amount_units_1e8, chain_token_units, chain_decimals, state, signer_address,
    safe_multisig_tx_hash, lock_batch_id
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED_COLD_SAFE', ?, ?, ?)`).run(
    payoutId, `idem-${payoutId}`, owner, chain, recipient, COLD_PAYOUT_UNITS_1E8,
    chain === 'stellar' ? '3000000000' : COLD_PAYOUT_TOKEN_UNITS, chain === 'stellar' ? 7 : 6,
    chain === 'stellar' ? STELLAR_HOT_WALLET_ADDRESS : COLD_SOURCE, `safe-proposal-${payoutId}`, batch.id
  );
  return batch.id;
}

const BLOCK_HASH = `0x${'cd'.repeat(32)}`;
const TRANSFER_TOPIC = keccak256(stringToHex('Transfer(address,address,uint256)'));
const indexedAddress = (address: string) => `0x${address.slice(2).toLowerCase().padStart(64, '0')}`;

function transferLog(options: { source?: string; recipient?: string; amount?: string; index?: string; asset?: string } = {}) {
  return {
    address: options.asset ?? CANONICAL_ARBITRUM_SEPOLIA_USDC,
    topics: [TRANSFER_TOPIC, indexedAddress(options.source ?? COLD_SOURCE), indexedAddress(options.recipient ?? EVM_RECIPIENT)],
    data: `0x${BigInt(options.amount ?? COLD_PAYOUT_TOKEN_UNITS).toString(16).padStart(64, '0')}`,
    logIndex: options.index ?? '0x1', transactionHash: COLD_SAFE_TX_HASH,
    blockHash: BLOCK_HASH, blockNumber: '0x10', removed: false,
  };
}

function createColdSafeMachine(
  db: D1Database,
  signer: TurnkeySigner,
  options: {
    receipt?: Record<string, unknown>;
    chain?: 'arbitrum' | 'base';
    networkMode?: 'mainnet' | 'testnet';
    chainId?: number;
    finalized?: string;
    canonicalHash?: string;
    beforeReceipt?: () => Promise<void>;
    primaryRpc?: EvmJsonRpcTransport;
    fallbackRpc?: EvmJsonRpcTransport;
    stellarTransport?: HorizonStellarBroadcastTransport;
  } = {}
): BroadcastRecoveryMachine {
  const chain = options.chain ?? 'arbitrum';
  const networkMode = options.networkMode ?? 'testnet';
  const chainId = chain === 'base'
    ? networkMode === 'mainnet' ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID
    : networkMode === 'mainnet' ? ARBITRUM_ONE_CHAIN_ID : ARBITRUM_SEPOLIA_CHAIN_ID;
  const asset = chain === 'base'
    ? networkMode === 'mainnet' ? CANONICAL_BASE_NATIVE_USDC : CANONICAL_BASE_SEPOLIA_USDC
    : networkMode === 'mainnet' ? CANONICAL_ARBITRUM_NATIVE_USDC : CANONICAL_ARBITRUM_SEPOLIA_USDC;
  const adapter = new ArbitrumBaseUsdcAdapter({
    chain, networkMode, hotWalletAddress: HOT_WALLET_ADDRESS,
    fallbackRpc: options.fallbackRpc,
    primaryRpc: options.primaryRpc ?? {
      async call<T>(method: string, params?: unknown[]): Promise<T> {
        let value: unknown;
        if (method === 'eth_chainId') value = `0x${(options.chainId ?? chainId).toString(16)}`;
        else if (method === 'eth_getTransactionReceipt') {
          await options.beforeReceipt?.();
          value = {
            status: '0x1', blockHash: BLOCK_HASH, blockNumber: '0x10', transactionHash: params?.[0],
            from: HOT_WALLET_ADDRESS, to: COLD_SOURCE, logs: [transferLog({ asset })], ...options.receipt,
          };
        } else if (method === 'eth_getBlockByNumber') {
          value = params?.[0] === 'finalized' ? { number: options.finalized ?? '0x20', hash: BLOCK_HASH } :
            { number: '0x10', hash: options.canonicalHash ?? BLOCK_HASH };
        } else throw new Error(`Unexpected test RPC method: ${method}`);
        return value as T;
      },
    },
  });
  return new BroadcastRecoveryMachine({ db, turnkeySigner: signer, evmAdapters: { [chain]: adapter }, stellarTransport: options.stellarTransport });
}

function resolveColdSafe(machine: BroadcastRecoveryMachine, payoutId: string, txHash = COLD_SAFE_TX_HASH, operationId?: string) {
  return machine.resolveColdSafeBroadcast({ payoutId, resolution: 'CONFIRMED', txHash, operationId });
}

const STELLAR_HASH = 'ef'.repeat(32);
const FIXTURE_STELLAR_TESTNET_USDC_ISSUER = 'GAI72RLRJ6EKEDPPFEYIW36CXM7ZS5YXY5GALHN26O7V3LOGZ6LAUZWW';
const stellarPayment = {
  id: '10000000000000001', paging_token: '10000000000000001', type: 'payment',
  transaction_hash: STELLAR_HASH, transaction_successful: true,
  from: STELLAR_HOT_WALLET_ADDRESS, to: STELLAR_RECIPIENT, amount: '300.0000000',
  asset_type: 'credit_alphanum4', asset_code: 'USDC', asset_issuer: FIXTURE_STELLAR_TESTNET_USDC_ISSUER,
};

function mockHorizon(
  pages: Array<Array<Record<string, unknown>>>,
  network = 'Test SDF Network ; September 2015',
  beforeTransaction?: () => Promise<void>
) {
  const fetchMock = jest.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
    const path = new URL(String(url));
    if (path.hostname !== 'horizon.example') throw new Error('Unexpected test Horizon host');
    if (path.pathname === '/') return Response.json({ network_passphrase: network });
    if (path.pathname === `/transactions/${STELLAR_HASH}`) {
      await beforeTransaction?.();
      return Response.json({ hash: STELLAR_HASH, ledger: 4821338, successful: true,
        operation_count: pages.reduce((count, page) => count + page.length, 0) });
    }
    if (path.pathname === `/transactions/${STELLAR_HASH}/operations`) {
      return Response.json({ _embedded: { records: pages[path.searchParams.has('cursor') ? 1 : 0] ?? [] } });
    }
    throw new Error(`Unexpected test Horizon endpoint: ${path.pathname}`);
  });
  const transport = new HorizonStellarBroadcastTransport({ network: StellarNetwork.TESTNET,
    horizonUrl: 'https://horizon.example', usdcIssuer: FIXTURE_STELLAR_TESTNET_USDC_ISSUER });
  return { fetchMock, transport };
}

function recordingProofRpc(options: {
  chainId?: number;
  blockHash?: string;
  receipt?: Record<string, unknown>;
  finalized?: string;
  canonicalHash?: string;
  failFinality?: boolean;
} = {}) {
  const calls: Array<[string, unknown[] | undefined]> = [];
  const blockHash = options.blockHash ?? BLOCK_HASH;
  const transport: EvmJsonRpcTransport = {
    async call<T>(method: string, params?: unknown[]): Promise<T> {
      calls.push([method, params]);
      let value: unknown;
      if (method === 'eth_chainId') value = `0x${(options.chainId ?? ARBITRUM_SEPOLIA_CHAIN_ID).toString(16)}`;
      else if (method === 'eth_getTransactionReceipt') value = {
        status: '0x1', transactionHash: COLD_SAFE_TX_HASH, blockNumber: '0x10', blockHash,
        logs: [{ ...transferLog({ index: '0x7' }), blockHash }], ...options.receipt,
      };
      else if (method === 'eth_getBlockByNumber') {
        if (params?.[0] === 'finalized' && options.failFinality) throw new Error('injected primary finality failure');
        value = params?.[0] === 'finalized'
          ? { number: options.finalized ?? '0x20', hash: blockHash }
          : { number: '0x10', hash: options.canonicalHash ?? blockHash };
      } else throw new Error(`Unexpected proof RPC method: ${method}`);
      return value as T;
    },
  };
  return { calls, transport };
}

describe('G16 T01: cold Safe confirmation requires unique, complete transfer proof', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let signer: TurnkeySigner;
  const lockById = (id: string) => new DoubleEntryLedgerService(db).getBatchById(id);
  const coldClaims = () => sqlite.prepare('SELECT * FROM cold_settlement_claims').all();
  const finalizations = () => sqlite.prepare(`SELECT b.id, COUNT(p.id) AS postings FROM ledger_journal_batches b
    JOIN ledger_postings p ON p.batch_id = b.id WHERE b.journal_type = 'WITHDRAWAL_FINALIZED' GROUP BY b.id`).all();

  beforeEach(() => {
    ({ sqlite, db } = createAscendancyDb());
    signer = createSigner(new RecordingSigningTransport());
  });

  afterEach(() => {
    jest.restoreAllMocks();
    sqlite.close();
  });

  it('settles complete evidence, using the ERC20 source rather than the relayer', async () => {
    const lockId = await seedColdSafePayout(sqlite, db, 'valid');
    const machine = createColdSafeMachine(db, signer, { receipt: { logs: [
      { ...transferLog(), topics: [`0x${'66'.repeat(32)}`] }, transferLog(),
    ] } });
    expect(await resolveColdSafe(machine, 'valid')).toMatchObject({ state: 'CONFIRMED', tx_hash: COLD_SAFE_TX_HASH });
    expect(await lockById(lockId)).toMatchObject({ status: 'SETTLED', settledTxHash: COLD_SAFE_TX_HASH });
    expect(coldClaims()).toEqual([expect.objectContaining({ network: `eip155:${ARBITRUM_SEPOLIA_CHAIN_ID}`,
      operation_id: '1', tx_hash: COLD_SAFE_TX_HASH, source_address: COLD_SOURCE, lock_batch_id: lockId, payout_id: 'valid' })]);
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it.each([
    ['wrong USDC asset', { receipt: { logs: [transferLog({ asset: '0x' + '22'.repeat(20) })] } }, /transfer events/i],
    ['wrong amount', { receipt: { logs: [transferLog({ amount: '300000001' })] } }, /expected chain token units/i],
    ['successful receipt with no logs', { receipt: { logs: undefined } }, /transfer metadata/i],
    ['recipient-only metadata', { receipt: { logs: [], recipient: EVM_RECIPIENT } }, /transfer events/i],
    ['unrelated transaction', { receipt: { transactionHash: `0x${'01'.repeat(32)}` } }, /requested transaction/i],
    ['wrong source despite correct recipient', { receipt: { logs: [transferLog({ source: HOT_WALLET_ADDRESS })] } }, /source/i],
    ['wrong recipient', { receipt: { logs: [transferLog({ recipient: HOT_WALLET_ADDRESS })] } }, /recipient/i],
    ['another network', { chainId: 84532 }, /network/i],
    ['reverted receipt', { receipt: { status: '0x0' } }, /successful/i],
    ['nonfinal block', { finalized: '0xf' }, /finalized/i],
    ['noncanonical block hash', { canonicalHash: `0x${'ff'.repeat(32)}` }, /canonical/i],
    ['omitted transfer index', { receipt: { logs: [{ ...transferLog(), logIndex: undefined }] } }, /Malformed/i],
    ['removed transfer log', { receipt: { logs: [{ ...transferLog(), removed: true }] } }, /Malformed/i],
    ['malformed Transfer ABI data', { receipt: { logs: [{ ...transferLog(), data: '0x1' }] } }, /Malformed/i],
    ['duplicate log IDs', { receipt: { logs: [transferLog(), transferLog()] } }, /duplicate/i],
  ] as const)('rejects %s without consuming a proof or changing the lock', async (_label, options, reason) => {
    const lockId = await seedColdSafePayout(sqlite, db, 'invalid');
    const machine = createColdSafeMachine(db, signer, options);
    await expect(resolveColdSafe(machine, 'invalid')).rejects.toThrow(reason);
    expect(await machine.getSettlementRecord('invalid')).toMatchObject({ state: 'QUEUED_COLD_SAFE' });
    expect(await lockById(lockId)).toMatchObject({ status: 'INFLIGHT' });
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });

  it.each(['mainnet', 'testnet'] as const)('settles exactly $300 using canonical Base %s USDC and network', async (networkMode) => {
    const lockId = await seedColdSafePayout(sqlite, db, 'base-valid', 'base');
    const machine = createColdSafeMachine(db, signer, { chain: 'base', networkMode });
    expect(await resolveColdSafe(machine, 'base-valid')).toMatchObject({ state: 'CONFIRMED', chain: 'base' });
    expect(coldClaims()).toEqual([expect.objectContaining({
      network: `eip155:${networkMode === 'mainnet' ? BASE_MAINNET_CHAIN_ID : BASE_SEPOLIA_CHAIN_ID}`,
      chain: 'base', asset: (networkMode === 'mainnet' ? CANONICAL_BASE_NATIVE_USDC : CANONICAL_BASE_SEPOLIA_USDC).toLowerCase(),
      amount_token_units: '300000000', payout_id: 'base-valid', lock_batch_id: lockId,
    })]);
    expect(await lockById(lockId)).toMatchObject({ status: 'SETTLED', grossCommissionUnits: 30_000_000_000n });
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it.each([
    ['Arbitrum network', { chainId: ARBITRUM_ONE_CHAIN_ID }, /network/],
    ['Base testnet for mainnet payout', { chainId: BASE_SEPOLIA_CHAIN_ID }, /network/],
    ['bridged USDbC', { receipt: { logs: [transferLog({ asset: REJECTED_BASE_BRIDGED_USDBC })] } }, /transfer events/],
    ['another chain native USDC', { receipt: { logs: [transferLog({ asset: CANONICAL_ARBITRUM_NATIVE_USDC })] } }, /transfer events/],
  ] as const)('rejects Base proof from %s without consuming the $300 lock', async (_label, options, reason) => {
    const lockId = await seedColdSafePayout(sqlite, db, 'base-invalid', 'base');
    const machine = createColdSafeMachine(db, signer, { chain: 'base', networkMode: 'mainnet', ...options });
    await expect(resolveColdSafe(machine, 'base-invalid')).rejects.toThrow(reason);
    expect(await lockById(lockId)).toMatchObject({ status: 'INFLIGHT' });
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });

  it('restarts chain, receipt, finality and canonical block proof on fallback and stores only fallback identity', async () => {
    await seedColdSafePayout(sqlite, db, 'fallback-valid');
    const primary = recordingProofRpc({ failFinality: true });
    const fallbackHash = `0x${'12'.repeat(32)}`;
    const fallback = recordingProofRpc({ blockHash: fallbackHash });
    const machine = createColdSafeMachine(db, signer, { primaryRpc: primary.transport, fallbackRpc: fallback.transport });
    expect(await resolveColdSafe(machine, 'fallback-valid')).toMatchObject({ state: 'CONFIRMED' });
    const completeRead = [
      ['eth_chainId', undefined], ['eth_getTransactionReceipt', [COLD_SAFE_TX_HASH]],
      ['eth_getBlockByNumber', ['finalized', false]], ['eth_getBlockByNumber', ['0x10', false]],
    ];
    expect(primary.calls).toEqual(completeRead);
    expect(fallback.calls).toEqual(completeRead);
    expect(coldClaims()).toEqual([expect.objectContaining({ block_reference: fallbackHash, operation_id: '7' })]);
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it.each([
    ['wrong network', { chainId: BASE_SEPOLIA_CHAIN_ID }, /network/],
    ['missing receipt', { receipt: { status: undefined } }, /successful/],
    ['missing logs', { receipt: { logs: undefined } }, /transfer metadata/],
    ['wrong amount', { receipt: { logs: [transferLog({ amount: '300000001' })] } }, /chain token units/],
    ['nonfinal receipt', { finalized: '0xf' }, /finalized/],
    ['noncanonical receipt', { canonicalHash: `0x${'34'.repeat(32)}` }, /canonical/],
  ] as const)('rejects fallback %s rather than mixing it with primary receipt proof', async (_label, options, reason) => {
    const lockId = await seedColdSafePayout(sqlite, db, 'fallback-invalid');
    const primary = recordingProofRpc({ failFinality: true });
    const fallback = recordingProofRpc(options);
    const machine = createColdSafeMachine(db, signer, { primaryRpc: primary.transport, fallbackRpc: fallback.transport });
    await expect(resolveColdSafe(machine, 'fallback-invalid')).rejects.toThrow(reason);
    expect(primary.calls).toHaveLength(4);
    expect(fallback.calls[0]).toEqual(['eth_chainId', undefined]);
    if (_label !== 'wrong network') expect(fallback.calls[1]).toEqual(['eth_getTransactionReceipt', [COLD_SAFE_TX_HASH]]);
    if (!['wrong network', 'missing receipt'].includes(_label)) expect(fallback.calls).toHaveLength(4);
    expect(await lockById(lockId)).toMatchObject({ status: 'INFLIGHT' });
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });

  it('requires explicit attribution for identical payments and accepts distinct log identities', async () => {
    await seedColdSafePayout(sqlite, db, 'batch-one');
    await seedColdSafePayout(sqlite, db, 'batch-two');
    const machine = createColdSafeMachine(db, signer, { receipt: { logs: [transferLog(), transferLog({ index: '0x2' })] } });
    await expect(resolveColdSafe(machine, 'batch-one')).rejects.toThrow(/ambiguous/i);
    await expect(resolveColdSafe(machine, 'batch-one', COLD_SAFE_TX_HASH, '3')).rejects.toThrow(/no attributable/i);
    expect((await resolveColdSafe(machine, 'batch-one', COLD_SAFE_TX_HASH, '1')).state).toBe('CONFIRMED');
    expect((await resolveColdSafe(machine, 'batch-two', COLD_SAFE_TX_HASH, '2')).state).toBe('CONFIRMED');
    expect(coldClaims()).toHaveLength(2);
  });

  it('does not allow one confirmed operation to settle two cold payouts across service instances', async () => {
    await seedColdSafePayout(sqlite, db, 'race-one');
    await seedColdSafePayout(sqlite, db, 'race-two');
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const beforeReceipt = async () => { if (++arrived === 2) release(); await together; };
    const first = createColdSafeMachine(db, signer, { beforeReceipt });
    const second = createColdSafeMachine(createSqliteD1(sqlite), signer, { beforeReceipt });
    const results = await Promise.allSettled([resolveColdSafe(first, 'race-one'), resolveColdSafe(second, 'race-two')]);
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(1);
    expect(results.find(({ status }) => status === 'rejected')).toMatchObject({ reason: expect.objectContaining({ message: expect.stringMatching(/already used by another payout/) }) });
    expect(coldClaims()).toHaveLength(1);
    expect(finalizations()).toHaveLength(1);
  });

  it('coalesces concurrent confirmations for the same payout across service instances', async () => {
    await seedColdSafePayout(sqlite, db, 'same-payout');
    let arrived = 0;
    let release!: () => void;
    const together = new Promise<void>((resolve) => { release = resolve; });
    const beforeReceipt = async () => { if (++arrived === 2) release(); await together; };
    const first = createColdSafeMachine(db, signer, { beforeReceipt });
    const second = createColdSafeMachine(createSqliteD1(sqlite), signer, { beforeReceipt });
    const results = await Promise.all([resolveColdSafe(first, 'same-payout'), resolveColdSafe(second, 'same-payout')]);
    expect(results.map(({ state }) => state)).toEqual(['CONFIRMED', 'CONFIRMED']);
    expect(coldClaims()).toHaveLength(1);
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it('rejects another payout after a ledger batch failure, then retries the original claim without a provider read', async () => {
    const lockId = await seedColdSafePayout(sqlite, db, 'ledger-retry');
    await seedColdSafePayout(sqlite, db, 'other-payout');
    const machine = createColdSafeMachine(db, signer);
    const batchFailure = jest.spyOn(db, 'batch').mockRejectedValueOnce(new Error('injected ledger batch failure'));
    await expect(resolveColdSafe(machine, 'ledger-retry')).rejects.toThrow(/injected ledger batch failure/);
    expect(batchFailure).toHaveBeenCalledTimes(1);
    expect(await machine.getSettlementRecord('ledger-retry')).toMatchObject({ state: 'QUEUED_COLD_SAFE', tx_hash: null });
    expect(await lockById(lockId)).toMatchObject({ status: 'INFLIGHT' });
    expect(coldClaims()).toHaveLength(1);
    expect(finalizations()).toHaveLength(0);
    await expect(resolveColdSafe(machine, 'other-payout')).rejects.toThrow(/already used by another payout/);
    const beforeReceipt = jest.fn(async () => { throw new Error('provider unavailable'); });
    const restarted = createColdSafeMachine(createSqliteD1(sqlite), signer, { beforeReceipt });
    expect((await resolveColdSafe(restarted, 'ledger-retry')).state).toBe('CONFIRMED');
    expect(await lockById(lockId)).toMatchObject({ status: 'SETTLED' });
    expect(beforeReceipt).not.toHaveBeenCalled();
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it('leaves the withdrawal inflight when proof is read but the durable claim cannot be stored', async () => {
    const lockId = await seedColdSafePayout(sqlite, db, 'claim-unavailable');
    const machine = createColdSafeMachine(db, signer);
    const prepare = db.prepare.bind(db);
    const unavailable = jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/INSERT INTO cold_settlement_claims/.test(sql)) throw new Error('injected claim storage failure');
      return prepare(sql);
    });
    await expect(resolveColdSafe(machine, 'claim-unavailable')).rejects.toThrow(/claim storage failure/);
    unavailable.mockRestore();
    expect(await lockById(lockId)).toMatchObject({ status: 'INFLIGHT' });
    expect(await machine.getSettlementRecord('claim-unavailable')).toMatchObject({ state: 'QUEUED_COLD_SAFE', tx_hash: null });
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
    expect(await resolveColdSafe(machine, 'claim-unavailable')).toMatchObject({ state: 'CONFIRMED' });
    expect(coldClaims()).toHaveLength(1);
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it('verifies a committed ledger batch after its response is lost without posting twice', async () => {
    const lockId = await seedColdSafePayout(sqlite, db, 'lost-ledger-response');
    const batch = db.batch.bind(db);
    const lostResponse = jest.spyOn(db, 'batch').mockImplementationOnce(async (statements) => {
      await batch(statements);
      throw new Error('injected response failure after ledger commit');
    });
    const machine = createColdSafeMachine(db, signer);
    expect(await resolveColdSafe(machine, 'lost-ledger-response')).toMatchObject({ state: 'CONFIRMED' });
    expect(lostResponse).toHaveBeenCalledTimes(1);
    expect(await lockById(lockId)).toMatchObject({ status: 'SETTLED' });
    expect(await resolveColdSafe(machine, 'lost-ledger-response')).toMatchObject({ state: 'CONFIRMED' });
    expect(lostResponse).toHaveBeenCalledTimes(1);
    expect(coldClaims()).toHaveLength(1);
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it('resumes after ledger commit before broadcast confirmation and replays a lost response without duplicate postings', async () => {
    const lockId = await seedColdSafePayout(sqlite, db, 'lost-response');
    const machine = createColdSafeMachine(db, signer);
    const prepare = db.prepare.bind(db);
    const inject = jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/UPDATE settlement_broadcasts SET state = 'CONFIRMED'/.test(sql)) throw new Error('injected broadcast write failure');
      return prepare(sql);
    });
    await expect(resolveColdSafe(machine, 'lost-response')).rejects.toThrow(/injected broadcast write failure/);
    inject.mockRestore();
    expect(await lockById(lockId)).toMatchObject({ status: 'SETTLED' });
    expect(await machine.getSettlementRecord('lost-response')).toMatchObject({ state: 'QUEUED_COLD_SAFE' });
    const restarted = createColdSafeMachine(createSqliteD1(sqlite), signer);
    expect(await reconcilePendingSettlementBroadcasts(db, { machine: restarted })).toMatchObject({ confirmed: 1, errors: [] });
    expect((await resolveColdSafe(restarted, 'lost-response', COLD_SAFE_TX_HASH.toUpperCase())).state).toBe('CONFIRMED');
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
    expect(coldClaims()).toHaveLength(1);
  });

  it('persists passive evidence under ledger freeze and later reconciles it', async () => {
    const lockId = await seedColdSafePayout(sqlite, db, 'freeze');
    const machine = createColdSafeMachine(db, signer);
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'").run();
    await expect(resolveColdSafe(machine, 'freeze')).rejects.toThrow(/freeze/i);
    expect(await lockById(lockId)).toMatchObject({ status: 'INFLIGHT' });
    expect(coldClaims()).toHaveLength(1);
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'false' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'").run();
    expect(await reconcilePendingSettlementBroadcasts(db, { machine })).toMatchObject({ confirmed: 1, errors: [] });
    expect(await lockById(lockId)).toMatchObject({ status: 'SETTLED' });
  });

  it.each([
    "UPDATE settlement_broadcasts SET lock_batch_id = NULL",
    "UPDATE ledger_journal_batches SET payout_id = 'other-payout'",
    "UPDATE ledger_journal_batches SET metadata = json_set(metadata, '$.ownerId', 'other-owner')",
    "UPDATE ledger_journal_batches SET metadata = json_set(metadata, '$.chain', 'base')",
    "UPDATE settlement_broadcasts SET amount_units_1e8 = amount_units_1e8 + 100",
    "UPDATE settlement_broadcasts SET chain_token_units = '300000001'",
  ])('rejects a mismatched or absent withdrawal lock: %s', async (sql) => {
    await seedColdSafePayout(sqlite, db, 'wrong-lock');
    sqlite.exec(sql);
    await expect(resolveColdSafe(createColdSafeMachine(db, signer), 'wrong-lock')).rejects.toThrow(/withdrawal lock/i);
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });

  it('validates chain on new lock replays and preserves a historical chainless lock fingerprint', async () => {
    const payoutId = 'replayed-lock';
    const lockId = await seedColdSafePayout(sqlite, db, payoutId);
    const ledger = new DoubleEntryLedgerService(db);
    const request = {
      payoutId, ownerId: `affiliate-${payoutId}`, ownerType: 'affiliate' as const,
      idempotencyKey: `wd_lock:idem-${payoutId}`, amountUnits: BigInt(COLD_PAYOUT_UNITS_1E8),
    };
    await expect(ledger.lockSettledForWithdrawal({ ...request, chain: 'arbitrum' })).resolves.toMatchObject({
      isReplay: true, batch: { id: lockId, metadata: { chain: 'arbitrum' } },
    });
    await expect(ledger.lockSettledForWithdrawal({ ...request, chain: 'base' })).rejects.toThrow(/idempotency/i);
    await expect(ledger.lockSettledForWithdrawal(request)).rejects.toThrow(/idempotency/i);
    sqlite.prepare("UPDATE ledger_journal_batches SET metadata = json_remove(metadata, '$.chain') WHERE id = ?").run(lockId);
    const replay = await ledger.lockSettledForWithdrawal({ ...request, chain: 'base' });
    expect(replay).toMatchObject({ isReplay: true, batch: { id: lockId } });
    expect(replay.batch.metadata).not.toHaveProperty('chain');
    expect((await resolveColdSafe(createColdSafeMachine(db, signer), payoutId)).state).toBe('CONFIRMED');
  });

  it('migrates an existing chainless lock on schema 028 + 032 and enforces its claim foreign key', async () => {
    const legacy = createAscendancyDb('before-cold-claims');
    try {
      legacy.sqlite.exec(fs.readFileSync('src/database/migrations/032_persistent_d1_rate_limits.sql', 'utf8'));
      const payoutId = 'pre-migration-payout';
      const lockId = await seedColdSafePayout(legacy.sqlite, legacy.db, payoutId);
      legacy.sqlite.prepare("UPDATE ledger_journal_batches SET metadata = json_remove(metadata, '$.chain') WHERE id = ?").run(lockId);
      applyColdClaimsMigration(legacy.sqlite);
      applyPostClaimMigrations(legacy.sqlite);
      const machine = createColdSafeMachine(legacy.db, signer);
      expect(await resolveColdSafe(machine, payoutId)).toMatchObject({ state: 'CONFIRMED', lock_batch_id: lockId });
      expect(legacy.sqlite.prepare('SELECT confirmation_lane, confirmation_observed_at FROM settlement_broadcasts WHERE payout_id = ?').get(payoutId))
        .toEqual({ confirmation_lane: 'COLD', confirmation_observed_at: expect.any(Number) });
      expect(legacy.sqlite.prepare('SELECT lock_batch_id FROM cold_settlement_claims WHERE payout_id = ?').get(payoutId))
        .toEqual({ lock_batch_id: lockId });
      expect(legacy.sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(() => legacy.sqlite.prepare('UPDATE cold_settlement_claims SET lock_batch_id = ?').run('unknown-lock'))
        .toThrow(/FOREIGN KEY constraint/);
    } finally {
      legacy.sqlite.close();
    }
  });

  it('does not refund an uncertain cold cancellation or auto-post a legacy cold terminal row', async () => {
    const cancelledLock = await seedColdSafePayout(sqlite, db, 'cancel-unknown');
    const legacyLock = await seedColdSafePayout(sqlite, db, 'legacy-confirmed');
    const machine = createColdSafeMachine(db, signer);
    await expect(machine.resolveColdSafeBroadcast({ payoutId: 'cancel-unknown', resolution: 'CANCELLED' })).rejects.toThrow(/remains locked/);
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'CONFIRMED', tx_hash = ? WHERE payout_id = 'legacy-confirmed'").run(COLD_SAFE_TX_HASH);
    await expect(resolveColdSafe(machine, 'legacy-confirmed', `0x${'aa'.repeat(32)}`)).rejects.toThrow(/no verified payment claim/);
    await expect(resolveColdSafe(machine, 'cancel-unknown')).rejects.toThrow(/already used by another payout/);
    await expect(machine.recoverUncertainBroadcast('legacy-confirmed')).rejects.toThrow(/no verified payment claim/);
    expect(await reconcilePendingSettlementBroadcasts(db, { machine })).toMatchObject({ confirmed: 0, errors: [expect.objectContaining({ payoutId: 'legacy-confirmed' })] });
    expect(await lockById(cancelledLock)).toMatchObject({ status: 'INFLIGHT' });
    expect(await lockById(legacyLock)).toMatchObject({ status: 'INFLIGHT' });
    expect(finalizations()).toHaveLength(0);
    await expect(resolveColdSafe(machine, 'legacy-confirmed')).resolves.toMatchObject({ state: 'CONFIRMED' });
    expect(await lockById(legacyLock)).toMatchObject({ status: 'SETTLED' });
    expect(finalizations()).toEqual([expect.objectContaining({ postings: 2 })]);
  });

  it('keeps actionable $300 claims and hot pending payouts moving across ticks despite an older legacy backlog', async () => {
    const signingTransport = new RecordingSigningTransport();
    signer = createSigner(signingTransport);
    const legacyIds: string[] = [];
    const legacyLocks: string[] = [];
    for (let index = 0; index < 26; index += 1) {
      const payoutId = `legacy-backlog-${String(index).padStart(2, '0')}`;
      legacyIds.push(payoutId);
      legacyLocks.push(await seedColdSafePayout(sqlite, db, payoutId));
      sqlite.prepare("UPDATE settlement_broadcasts SET state = ?, tx_hash = ?, updated_at = '2020-01-01' WHERE payout_id = ?")
        .run(['CONFIRMED', 'FAILED_ABORTED', 'EXPIRED_RECOVERED'][index % 3], `0x${'99'.repeat(32)}`, payoutId);
    }
    const legacyRowsBefore = sqlite.prepare("SELECT * FROM settlement_broadcasts WHERE payout_id LIKE 'legacy-backlog-%' ORDER BY payout_id").all();
    const legacyLocksBefore = await Promise.all(legacyLocks.map(lockById));
    const claimLocks: string[] = [];
    for (let index = 0; index < 26; index += 1) {
      claimLocks.push(await seedColdSafePayout(sqlite, db, `actionable-claim-${String(index).padStart(2, '0')}`));
    }
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'").run();
    for (let index = 0; index < 26; index += 1) {
      const payoutId = `actionable-claim-${String(index).padStart(2, '0')}`;
      const machine = createColdSafeMachine(db, signer, { receipt: { logs: [transferLog({ index: `0x${(index + 1).toString(16)}` })] } });
      await expect(resolveColdSafe(machine, payoutId)).rejects.toThrow(/freeze/i);
      sqlite.prepare("UPDATE settlement_broadcasts SET updated_at = '2026-11-02' WHERE payout_id = ?").run(payoutId);
    }
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'false' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'").run();
    const hotLock = await seedColdSafePayout(sqlite, db, 'hot-pending-backlog');
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', safe_multisig_tx_hash = NULL, tx_hash = ?, updated_at = '2026-11-01' WHERE payout_id = 'hot-pending-backlog'").run(COLD_SAFE_TX_HASH);
    const claimsBefore = coldClaims();
    const beforeReceipt = jest.fn(async () => { throw new Error('passive cold recovery must not read RPC'); });
    const machine = createColdSafeMachine(db, signer, { beforeReceipt });
    const resume = jest.spyOn(machine, 'resumeColdPaymentClaim');
    const recover = jest.spyOn(machine, 'recoverUncertainBroadcast').mockImplementation(async (payoutId) => {
      sqlite.prepare("UPDATE settlement_broadcasts SET state = 'CONFIRMED' WHERE payout_id = ?").run(payoutId);
      return { payoutId, chain: 'arbitrum', state: 'CONFIRMED', action: 'RECONCILED_ON_CHAIN',
        txHash: COLD_SAFE_TX_HASH, assignedNonce: null, stellarSequence: null, timeboundsMaxUnix: null };
    });
    const first = await reconcilePendingSettlementBroadcasts(db, { machine });
    const second = await reconcilePendingSettlementBroadcasts(db, { machine });
    const third = await reconcilePendingSettlementBroadcasts(db, { machine });
    expect(first).toMatchObject({ scanned: 50, confirmed: 25, reverted: 0, stillPending: 0, skippedNoMachine: false });
    expect(second).toMatchObject({ scanned: 27, confirmed: 2, reverted: 0, stillPending: 0 });
    expect(third).toMatchObject({ scanned: 25, confirmed: 0, reverted: 0, stillPending: 0 });
    for (const tick of [first, second, third]) {
      expect(tick.errors).toHaveLength(25);
      expect(tick.errors.every(({ payoutId, error }) => legacyIds.includes(payoutId) && /manual reconciliation required/.test(error))).toBe(true);
    }
    expect(resume).toHaveBeenCalledTimes(26);
    expect(resume.mock.calls.every(([payoutId]) => payoutId.startsWith('actionable-claim-'))).toBe(true);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(recover).toHaveBeenCalledWith('hot-pending-backlog', { nowUnix: undefined, bumpGasRbf: false, reexecuteExpired: false, passiveOnly: true });
    expect(beforeReceipt).not.toHaveBeenCalled();
    expect(coldClaims()).toEqual(claimsBefore);
    expect(sqlite.prepare("SELECT * FROM settlement_broadcasts WHERE payout_id LIKE 'legacy-backlog-%' ORDER BY payout_id").all()).toEqual(legacyRowsBefore);
    expect(await Promise.all(legacyLocks.map(lockById))).toEqual(legacyLocksBefore);
    expect((await Promise.all([...claimLocks, hotLock].map(lockById))).every((lock) => lock?.status === 'SETTLED')).toBe(true);
    expect(finalizations()).toHaveLength(27);
    expect(sqlite.prepare("SELECT COUNT(*) AS total FROM ledger_journal_batches WHERE journal_type = 'WITHDRAWAL_REVERTED'").get()).toEqual({ total: 0 });
    expect(signingTransport.evmSignCalls).toEqual([]);
    expect(signingTransport.stellarSignCalls).toEqual([]);
  });

  it('reports legacy diagnostics and a retained cold claim explicitly when the machine is unavailable', async () => {
    const claimLock = await seedColdSafePayout(sqlite, db, 'missing-machine-claim');
    const machine = createColdSafeMachine(db, signer);
    jest.spyOn(db, 'batch').mockRejectedValueOnce(new Error('injected ledger failure'));
    await expect(resolveColdSafe(machine, 'missing-machine-claim')).rejects.toThrow(/injected ledger failure/);
    const claimsBefore = coldClaims();
    const legacyLock = await seedColdSafePayout(sqlite, db, 'missing-machine-legacy');
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'FAILED_ABORTED' WHERE payout_id = 'missing-machine-legacy'").run();
    const hotLock = await seedColdSafePayout(sqlite, db, 'missing-machine-hot');
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', safe_multisig_tx_hash = NULL WHERE payout_id = 'missing-machine-hot'").run();
    const summary = await reconcilePendingSettlementBroadcasts(db, { machine: null });
    expect(summary).toMatchObject({ scanned: 3, confirmed: 0, reverted: 0, stillPending: 2, skippedNoMachine: false });
    expect(summary.errors).toEqual(expect.arrayContaining([
      { payoutId: 'missing-machine-claim', error: expect.stringMatching(/machine is not configured.*remains reserved/) },
      { payoutId: 'missing-machine-legacy', error: expect.stringMatching(/manual reconciliation required/) },
    ]));
    expect(summary.errors).toHaveLength(2);
    expect(coldClaims()).toEqual(claimsBefore);
    expect((await Promise.all([claimLock, legacyLock, hotLock].map(lockById))).every((lock) => lock?.status === 'INFLIGHT')).toBe(true);
    expect(finalizations()).toHaveLength(0);
  });

  it('rejects the tick without mutation when the claims migration is absent', async () => {
    const legacy = createAscendancyDb('before-cold-claims');
    try {
      const legacyLock = await seedColdSafePayout(legacy.sqlite, legacy.db, 'unmigrated-legacy');
      const queuedLock = await seedColdSafePayout(legacy.sqlite, legacy.db, 'unmigrated-queued');
      const hotLock = await seedColdSafePayout(legacy.sqlite, legacy.db, 'unmigrated-hot');
      legacy.sqlite.prepare("UPDATE settlement_broadcasts SET state = 'CONFIRMED', updated_at = '2020-01-01' WHERE payout_id = 'unmigrated-legacy'").run();
      legacy.sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', safe_multisig_tx_hash = NULL WHERE payout_id = 'unmigrated-hot'").run();
      const machine = createColdSafeMachine(legacy.db, signer);
      const resume = jest.spyOn(machine, 'resumeColdPaymentClaim');
      const recover = jest.spyOn(machine, 'recoverUncertainBroadcast').mockResolvedValue({
        payoutId: 'unmigrated-hot', chain: 'arbitrum', state: 'BROADCAST_PENDING', action: 'STILL_BROADCAST_PENDING',
        txHash: null, assignedNonce: null, stellarSequence: null, timeboundsMaxUnix: null,
      });
      await expect(reconcilePendingSettlementBroadcasts(legacy.db, { machine })).rejects.toMatchObject({ message: expect.stringMatching(/no such table: cold_settlement_claims/) });
      expect(resume).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      const ledger = new DoubleEntryLedgerService(legacy.db);
      expect((await Promise.all([legacyLock, queuedLock, hotLock].map((id) => ledger.getBatchById(id)))).every((lock) => lock?.status === 'INFLIGHT')).toBe(true);
    } finally {
      legacy.sqlite.close();
    }
  });

  it('rejects the tick without observing hot or resuming cold work when the ledger schema is missing', async () => {
    await seedColdSafePayout(sqlite, db, 'ledger-missing-legacy');
    await seedColdSafePayout(sqlite, db, 'ledger-missing-queued');
    await seedColdSafePayout(sqlite, db, 'ledger-missing-hot');
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'EXPIRED_RECOVERED' WHERE payout_id = 'ledger-missing-legacy'").run();
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', safe_multisig_tx_hash = NULL WHERE payout_id = 'ledger-missing-hot'").run();
    const rowsBefore = sqlite.prepare('SELECT * FROM settlement_broadcasts ORDER BY payout_id').all();
    const machine = createColdSafeMachine(db, signer);
    const resume = jest.spyOn(machine, 'resumeColdPaymentClaim');
    const recover = jest.spyOn(machine, 'recoverUncertainBroadcast').mockResolvedValue({
      payoutId: 'ledger-missing-hot', chain: 'arbitrum', state: 'BROADCAST_PENDING', action: 'STILL_BROADCAST_PENDING',
      txHash: null, assignedNonce: null, stellarSequence: null, timeboundsMaxUnix: null,
    });
    const prepare = db.prepare.bind(db);
    const missingSchema = jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (/ledger_journal_batches/.test(sql)) throw new Error('no such table: ledger_journal_batches');
      return prepare(sql);
    });
    await expect(reconcilePendingSettlementBroadcasts(db, { machine })).rejects.toThrow(/no such table: ledger_journal_batches/);
    missingSchema.mockRestore();
    expect(resume).not.toHaveBeenCalled();
    expect(recover).not.toHaveBeenCalled();
    expect(sqlite.prepare('SELECT * FROM settlement_broadcasts ORDER BY payout_id').all()).toEqual(rowsBefore);
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });

  it('rejects an empty 028 plus 032 fixture genuinely missing migration 033', async () => {
    const legacy = createAscendancyDb('before-cold-claims');
    try {
      const snapshot = new Database(legacy.sqlite.serialize());
      try {
        legacy.sqlite.exec(fs.readFileSync('src/database/migrations/032_persistent_d1_rate_limits.sql', 'utf8'));
      } finally { snapshot.close(); }
      expect(legacy.sqlite.prepare("SELECT name FROM sqlite_master WHERE name = 'cold_settlement_claims'").get()).toBeUndefined();
      await expect(reconcilePendingSettlementBroadcasts(legacy.db, { machine: null })).rejects.toMatchObject({ message: expect.stringMatching(/no such table: cold_settlement_claims/) });
    } finally { legacy.sqlite.close(); }
  });

  it.each(['cold_settlement_claims', 'ledger_journal_batches'])('reports missing schema with zero candidates: %s', async (table) => {
    const prepare = db.prepare.bind(db);
    jest.spyOn(db, 'prepare').mockImplementation((sql) => {
      if (sql.includes(table)) throw new Error(`no such table: ${table}`);
      return prepare(sql);
    });
    await expect(reconcilePendingSettlementBroadcasts(db, { machine: null })).rejects.toThrow(`no such table: ${table}`);
  });

  it.each(['CONFIRMED', 'FAILED_ABORTED'] as const)('does not count hot %s when ledger lookup becomes unavailable', async (state) => {
    await seedColdSafePayout(sqlite, db, 'schema-hot');
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', safe_multisig_tx_hash = NULL, tx_hash = ? WHERE payout_id = 'schema-hot'").run(COLD_SAFE_TX_HASH);
    const machine = createColdSafeMachine(db, signer);
    const prepare = db.prepare.bind(db);
    jest.spyOn(machine, 'recoverUncertainBroadcast').mockImplementation(async () => {
      jest.spyOn(db, 'prepare').mockImplementation((sql) => {
        if (sql.includes('ledger_journal_batches')) throw new Error('no such table: ledger_journal_batches');
        return prepare(sql);
      });
      return { payoutId: 'schema-hot', chain: 'arbitrum', state, action: 'RECONCILED_ON_CHAIN',
        txHash: COLD_SAFE_TX_HASH, assignedNonce: null, stellarSequence: null, timeboundsMaxUnix: null };
    });
    const summary = await reconcilePendingSettlementBroadcasts(db, { machine });
    expect(summary).toMatchObject({ confirmed: 0, reverted: 0 });
    expect(summary.errors).toEqual([{ payoutId: 'schema-hot', error: 'no such table: ledger_journal_batches' }]);
    expect(finalizations()).toHaveLength(0);
  });

  it('preserves the explicit hot-only missing-machine summary', async () => {
    await seedColdSafePayout(sqlite, db, 'hot-without-machine');
    sqlite.prepare("UPDATE settlement_broadcasts SET state = 'BROADCAST_PENDING', safe_multisig_tx_hash = NULL WHERE payout_id = 'hot-without-machine'").run();
    expect(await reconcilePendingSettlementBroadcasts(db, { machine: null })).toEqual({
      scanned: 1, confirmed: 0, reverted: 0, stillPending: 1, skippedNoMachine: true, errors: [],
    });
  });

  it.each(['database is locked', 'no such table: unexpected_dependency', 'no such table: settlement_broadcasts'])(
    'propagates unexpected selector failure instead of returning a successful empty summary: %s', async (message) => {
      jest.spyOn(db, 'prepare').mockImplementation(() => { throw new Error(message); });
      await expect(reconcilePendingSettlementBroadcasts(db, { machine: null })).rejects.toThrow(message);
    }
  );

  it('accepts exact Stellar stroops from actual operations across pages and keeps large operation IDs exact', async () => {
    await seedColdSafePayout(sqlite, db, 'stellar', 'stellar');
    const { fetchMock, transport } = mockHorizon([[{ ...stellarPayment, type: 'change_trust' }], [{
      ...stellarPayment, id: '10000000000000002', paging_token: '10000000000000002',
    }]]);
    const machine = createColdSafeMachine(db, signer, { stellarTransport: transport });
    expect((await resolveColdSafe(machine, 'stellar', STELLAR_HASH)).state).toBe('CONFIRMED');
    expect(coldClaims()).toEqual([expect.objectContaining({ network: 'stellar:testnet', operation_id: '10000000000000002',
      asset: `USDC:${FIXTURE_STELLAR_TESTNET_USDC_ISSUER}`, amount_token_units: '3000000000' })]);
    expect(String(fetchMock.mock.calls[3]?.[0])).toContain('cursor=10000000000000001');
  });

  it('attributes distinct Stellar operations in one hash and rejects reusing an operation for another $300 payout', async () => {
    const firstLock = await seedColdSafePayout(sqlite, db, 'stellar-one', 'stellar');
    const secondLock = await seedColdSafePayout(sqlite, db, 'stellar-two', 'stellar');
    const reusedLock = await seedColdSafePayout(sqlite, db, 'stellar-reuse', 'stellar');
    const secondId = '10000000000000002';
    const { transport } = mockHorizon([[stellarPayment], [{ ...stellarPayment, id: secondId, paging_token: secondId }]]);
    const machine = createColdSafeMachine(db, signer, { stellarTransport: transport });
    await expect(resolveColdSafe(machine, 'stellar-one', STELLAR_HASH)).rejects.toThrow(/ambiguous/i);
    await expect(resolveColdSafe(machine, 'stellar-one', STELLAR_HASH, '10000000000000003')).rejects.toThrow(/no attributable/);
    expect(coldClaims()).toHaveLength(0);
    expect(await resolveColdSafe(machine, 'stellar-one', STELLAR_HASH, stellarPayment.id)).toMatchObject({ state: 'CONFIRMED' });
    await expect(resolveColdSafe(machine, 'stellar-reuse', STELLAR_HASH, stellarPayment.id)).rejects.toThrow(/already used by another payout/);
    const restarted = createColdSafeMachine(createSqliteD1(sqlite), signer, { stellarTransport: transport });
    expect(await resolveColdSafe(restarted, 'stellar-two', STELLAR_HASH, secondId)).toMatchObject({ state: 'CONFIRMED' });
    expect(coldClaims()).toEqual(expect.arrayContaining([
      expect.objectContaining({ tx_hash: STELLAR_HASH, operation_id: stellarPayment.id, payout_id: 'stellar-one', amount_token_units: '3000000000' }),
      expect.objectContaining({ tx_hash: STELLAR_HASH, operation_id: secondId, payout_id: 'stellar-two', amount_token_units: '3000000000' }),
    ]));
    expect(coldClaims()).toHaveLength(2);
    expect(await lockById(firstLock)).toMatchObject({ status: 'SETTLED' });
    expect(await lockById(secondLock)).toMatchObject({ status: 'SETTLED' });
    expect(await lockById(reusedLock)).toMatchObject({ status: 'INFLIGHT' });
    expect(finalizations()).toHaveLength(2);
  });

  it.each(['same-operation', 'distinct-operations', 'same-payout'] as const)(
    'preserves Stellar claim exclusivity across concurrent services: %s', async (mode) => {
      const firstLock = await seedColdSafePayout(sqlite, db, 'stellar-race-one', 'stellar');
      const secondLock = mode === 'same-payout' ? firstLock : await seedColdSafePayout(sqlite, db, 'stellar-race-two', 'stellar');
      const secondId = '10000000000000002';
      let arrived = 0;
      let release!: () => void;
      const together = new Promise<void>((resolve) => { release = resolve; });
      const beforeTransaction = async () => { if (++arrived === 2) release(); await together; };
      const { transport, fetchMock } = mockHorizon([[stellarPayment, { ...stellarPayment, id: secondId, paging_token: secondId }]], undefined, beforeTransaction);
      const first = createColdSafeMachine(db, signer, { stellarTransport: transport });
      const second = createColdSafeMachine(createSqliteD1(sqlite), signer, { stellarTransport: transport });
      const outcomes = await Promise.allSettled([
        resolveColdSafe(first, 'stellar-race-one', STELLAR_HASH, stellarPayment.id),
        resolveColdSafe(second, mode === 'same-payout' ? 'stellar-race-one' : 'stellar-race-two', STELLAR_HASH,
          mode === 'distinct-operations' ? secondId : stellarPayment.id),
      ]);
      expect(arrived).toBe(2);
      expect(outcomes.filter(({ status }) => status === 'fulfilled')).toHaveLength(mode === 'same-operation' ? 1 : 2);
      if (mode === 'same-operation') {
        expect(outcomes.find(({ status }) => status === 'rejected')).toMatchObject({
          reason: expect.objectContaining({ message: expect.stringMatching(/already used by another payout/) }),
        });
      }
      expect(coldClaims()).toHaveLength(mode === 'distinct-operations' ? 2 : 1);
      expect(finalizations()).toHaveLength(mode === 'distinct-operations' ? 2 : 1);
      const statuses = [await lockById(firstLock), await lockById(secondLock)].map((lock) => lock?.status);
      expect(statuses.filter((status) => status === 'SETTLED')).toHaveLength(mode === 'same-operation' ? 1 : 2);
      const readCount = fetchMock.mock.calls.length;
      const winner = coldClaims()[0] as { payout_id: string; operation_id: string };
      await expect(resolveColdSafe(first, winner.payout_id, STELLAR_HASH, winner.operation_id)).resolves.toMatchObject({ state: 'CONFIRMED' });
      expect(fetchMock).toHaveBeenCalledTimes(readCount);
    }
  );

  it.each([
    ['missing testnet issuer', StellarNetwork.TESTNET, undefined, /explicitly configured/],
    ['invalid testnet issuer', StellarNetwork.TESTNET, 'invalid-issuer', /explicitly configured/],
    ['mainnet issuer on testnet', StellarNetwork.TESTNET, CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER, /explicitly configured/],
    ['arbitrary valid issuer on mainnet', StellarNetwork.MAINNET, FIXTURE_STELLAR_TESTNET_USDC_ISSUER, /canonical Circle/],
  ] as const)('refuses %s before querying Horizon', async (_label, network, issuer, reason) => {
    await seedColdSafePayout(sqlite, db, 'bad-issuer', 'stellar');
    const env = { ...process.env };
    delete env.STELLAR_USDC_ISSUER;
    jest.replaceProperty(process, 'env', env);
    const { fetchMock } = mockHorizon([[stellarPayment]]);
    const transport = new HorizonStellarBroadcastTransport({ network, horizonUrl: 'https://horizon.example', usdcIssuer: issuer });
    const machine = createColdSafeMachine(db, signer, { stellarTransport: transport });
    await expect(resolveColdSafe(machine, 'bad-issuer', STELLAR_HASH)).rejects.toThrow(reason);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });

  it.each([
    ['missing payment operations', [{ ...stellarPayment, type: 'change_trust' }], undefined, /transfer events/],
    ['wrong asset issuer', [{ ...stellarPayment, asset_issuer: STELLAR_HOT_WALLET_ADDRESS }], undefined, /USDC asset/],
    ['wrong Stellar USDC asset type', [{ ...stellarPayment, asset_type: 'credit_alphanum12' }], undefined, /Malformed/],
    ['wrong code', [{ ...stellarPayment, asset_code: 'FAKE' }], undefined, /USDC asset/],
    ['native instead of issued USDC', [{ ...stellarPayment, asset_type: 'native' }], undefined, /USDC asset/],
    ['one extra stroop', [{ ...stellarPayment, amount: '300.0000001' }], undefined, /chain token units/],
    ['wrong source', [{ ...stellarPayment, from: STELLAR_RECIPIENT }], undefined, /source/],
    ['wrong destination', [{ ...stellarPayment, to: STELLAR_HOT_WALLET_ADDRESS }], undefined, /recipient/],
    ['failed operation', [{ ...stellarPayment, transaction_successful: false }], undefined, /Malformed/],
    ['operation from another transaction', [{ ...stellarPayment, transaction_hash: 'fa'.repeat(32) }], undefined, /unrelated/],
    ['wrong Horizon network', [stellarPayment], 'Public Global Stellar Network ; September 2015', /network/],
  ] as const)('rejects Stellar evidence with %s', async (_label, ops, network, reason) => {
    await seedColdSafePayout(sqlite, db, 'stellar-reject', 'stellar');
    const { transport } = mockHorizon([[...ops]], network);
    const machine = createColdSafeMachine(db, signer, { stellarTransport: transport });
    await expect(resolveColdSafe(machine, 'stellar-reject', STELLAR_HASH)).rejects.toThrow(reason);
    expect(coldClaims()).toHaveLength(0);
    expect(finalizations()).toHaveLength(0);
  });
});

describe('G16 T02: direct Turnkey signing respects emergency settlement flags', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let transport: RecordingSigningTransport;
  let signer: TurnkeySigner;

  beforeEach(() => {
    const fixture = createAscendancyDb();
    sqlite = fixture.sqlite;
    db = fixture.db;
    transport = new RecordingSigningTransport();
    signer = createSigner(transport);
  });

  afterEach(() => {
    sqlite.close();
  });

  const emergencyFlags = [
    { key: 'EMERGENCY_PAUSE', label: 'emergency pause' },
    { key: 'EMERGENCY_LEDGER_FREEZE', label: 'ledger freeze' },
  ] as const;

  it.each(emergencyFlags)(
    'blocks direct EVM signing during $label',
    async ({ key }) => {
      sqlite
        .prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = ?")
        .run(key);

      await expect(
        signer.signEvmDigestEnforced({
          db,
          payoutId: `po_g16_evm_${key.toLowerCase()}`,
          chain: 'arbitrum',
          amountUnits1e8: 1_000_000_000n,
          digestHex: `0x${'11'.repeat(32)}` as Hex,
        })
      ).rejects.toThrow(/emergency|pause|freeze/i);
      expect(transport.evmSignCalls).toHaveLength(0);
    }
  );

  it.each(emergencyFlags)(
    'blocks direct Stellar signing during $label',
    async ({ key }) => {
      sqlite
        .prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = ?")
        .run(key);

      await expect(
        signer.signStellarEnvelopeEnforced({
          db,
          payoutId: `po_g16_stellar_${key.toLowerCase()}`,
          amountUnits1e8: 1_000_000_000n,
          unsignedEnvelopeXdr: 'mock-unsigned-envelope',
          txHashHex: '11'.repeat(32),
        })
      ).rejects.toThrow(/emergency|pause|freeze/i);
      expect(transport.stellarSignCalls).toHaveLength(0);
    }
  );
});

describe('G16 T03: unresolved pending payouts remain in hot exposure after 24 hours', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let signer: TurnkeySigner;

  beforeEach(() => {
    const fixture = createAscendancyDb();
    sqlite = fixture.sqlite;
    db = fixture.db;
    signer = createSigner(new RecordingSigningTransport());

    const insertPendingPayout = sqlite.prepare(
      `INSERT INTO settlement_broadcasts (
         payout_id, idempotency_key, affiliate_id, chain, recipient_address,
         amount_units_1e8, chain_token_units, chain_decimals, state,
         tx_hash, created_at, updated_at
       ) VALUES (?, ?, ?, 'arbitrum', ?, 25000000000, '250000000', 6,
                 'BROADCAST_PENDING', ?, datetime('now', '-25 hours'), datetime('now', '-25 hours'))`
    );
    for (let index = 0; index < 6; index += 1) {
      insertPendingPayout.run(
        `po_g16_old_pending_${index}`,
        `idem_g16_old_pending_${index}`,
        `affiliate_g16_old_pending_${index}`,
        EVM_RECIPIENT,
        `0x${(index + 1).toString(16).padStart(64, '0')}`
      );
    }
  });

  afterEach(() => {
    sqlite.close();
  });

  it('includes 25-hour-old BROADCAST_PENDING rows in rolling hot volume', async () => {
    await expect(signer.getRolling24hHotVolumeUnits1e8(db)).resolves.toBe(
      HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8
    );
  });

  it('routes a new payout to cold Safe when old unresolved exposure exhausts the cap', async () => {
    const decision = await signer.evaluateHotWalletPolicy(db, 1_000_000_000n);

    expect(decision).toMatchObject({
      allowedHotSign: false,
      targetState: 'QUEUED_COLD_SAFE',
      rolling24hBeforeUnits1e8: HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8,
      violationCode: 'ROLLING_24H_CAP_EXCEEDED',
    });
  });

  it('does not atomically claim a hot signing slot while old pending exposure exhausts the cap', async () => {
    const claim = await signer.claimHotWalletSigningSlot(db, {
      payoutId: 'po_g16_new_claim',
      idempotencyKey: 'idem_g16_new_claim',
      affiliateId: 'affiliate_g16_new_claim',
      chain: 'arbitrum',
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: 1_000_000_000n,
      chainTokenUnits: '10000000',
      chainDecimals: 6,
    });

    expect(claim).toMatchObject({
      claimed: false,
      violationCode: 'ROLLING_24H_CAP_EXCEEDED',
    });
  });
});
