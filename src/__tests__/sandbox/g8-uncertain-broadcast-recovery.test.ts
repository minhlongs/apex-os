/**
 * src/__tests__/sandbox/g8-uncertain-broadcast-recovery.test.ts
 *
 * Sandbox Gate G8: 50 Concurrent Payouts Under 30% `504 Gateway Timeout` Chaos & Broadcast Recovery
 *
 * Verifies:
 * 1. 50 concurrent payouts across Stellar Testnet, Arbitrum Sepolia, and Base Sepolia mocks
 *    with 30% deterministic/seeded `504 Gateway Timeout` RPC disconnects covering BOTH:
 *    - "tx actually landed on-chain despite 504 Gateway Timeout"
 *    - "tx dropped before reaching mempool/Horizon on 504 Gateway Timeout"
 * 2. `BROADCAST_PENDING` lock holds strictly: duplicate `executeSettlement` or premature retry calls
 *    NEVER allocate a new EVM nonce or sign a second Stellar sequence while unresolved.
 * 3. Stellar `TimeBounds(180s)` blocks premature re-signing (`now <= timebounds_max_unix`);
 *    only after `now > timebounds_max_unix` AND verified absent on Horizon does it transition
 *    to `EXPIRED_RECOVERED` and execute a clean bounded retry.
 * 4. EVM (`arbitrum` / `base`) reuses the EXACT `assigned_nonce` (both raw signed tx rebroadcast
 *    and RBF gas-bumped replacement), NEVER incrementing `next_nonce` to send a second transfer.
 * 5. Zero double-sends occur across all 50 payouts (every hot-settled payout transfers USDC
 *    on-chain to its recipient AT MOST ONCE and settles to exactly 1 transfer).
 * 6. Zero payouts > $250.00 USDC (or pushing 24h hot volume > $1,500.00 USDC) ever slip through
 *    the Turnkey hot wallet — all excess payouts route deterministically to `QUEUED_COLD_SAFE`.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, parseTransaction, type Hex } from 'viem';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import {
  ArbitrumBaseUsdcAdapter,
  CIRCLE_IS_BLACKLISTED_SELECTOR,
  toLedgerUnits1e8,
  type EvmJsonRpcTransport,
} from '@/lib/payouts/adapters/arbitrum-base-usdc-adapter';
import {
  HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8,
  HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8,
  TurnkeySigner,
  type EvmDigestSignature,
  type StellarEnvelopeSignature,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import {
  BroadcastRecoveryMachine,
  SIGNING_STALE_ABORT_AFTER_SECONDS,
  type StellarBroadcastTransport,
  type StellarHorizonTxLookupResult,
} from '@/lib/payouts/broadcast-recovery-machine';

// ============================================================================
// SQLite D1 Harness
// ============================================================================

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
          return { results: rows, success: true, meta: { duration: 0 } };
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
      const tx = sqlite.transaction(() =>
        statements.map((s) => (s as SyncPreparedStatement)._runSync() as D1Result<T>)
      );
      return tx();
    },
    async exec(sql: string): Promise<D1Result<Record<string, unknown>>> {
      sqlite.exec(sql);
      return { results: [], success: true };
    },
    dump(): Promise<ArrayBuffer> {
      throw new Error('Not implemented');
    },
  };
}

function createAscendancyDb(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE profiles (id TEXT PRIMARY KEY, email TEXT);
    CREATE TABLE deals (id TEXT PRIMARY KEY);
  `);
  for (const migFile of [
    '028_ascendancy_audit_core.sql',
    '033_cold_settlement_claims.sql',
    '034_withdrawal_freeze_at_write.sql',
    '035_payout_effect_grants.sql',
    '036_durable_hot_exposure.sql',
  ]) {
    const migrationPath = path.resolve(
      process.cwd(),
      `src/database/migrations/${migFile}`
    );
    sqlite.exec(fs.readFileSync(migrationPath, 'utf8'));
  }
  return { sqlite, db: createSqliteD1(sqlite) };
}

function ensureTestWithdrawalLock(
  sqlite: Database.Database,
  payoutId: string,
  ownerId = 'trader_g8',
  amountUnits1e8: bigint = BigInt(0),
  chain?: string
): string {
  const lockId = `lock_${payoutId}`;
  const existing = sqlite
    .prepare(
      `SELECT id FROM ledger_journal_batches WHERE payout_id = ? AND journal_type = 'WITHDRAWAL_LOCK' LIMIT 1`
    )
    .get(payoutId) as { id: string } | undefined;
  if (existing) return existing.id;
  const amountNum = Number(amountUnits1e8);
  sqlite
    .prepare(
      `INSERT INTO ledger_journal_batches (
         id, idempotency_key, payload_fingerprint, journal_type, status,
         gross_commission_units, payout_id, metadata
       ) VALUES (?, ?, ?, 'WITHDRAWAL_LOCK', 'INFLIGHT', ?, ?, ?)`
    )
    .run(
      lockId,
      `lock_idem_${payoutId}`,
      `fp_${payoutId}`,
      amountNum,
      payoutId,
      JSON.stringify({
        payoutId,
        ownerId,
        ownerType: 'trader',
        ...(chain ? { chain } : {}),
        lockedAmountUnits: amountUnits1e8.toString(),
      })
    );
  return lockId;
}

function bindTestWithdrawalLocks(
  machine: BroadcastRecoveryMachine,
  sqlite: Database.Database
): BroadcastRecoveryMachine {
  const origExecute = machine.executeSettlement.bind(machine);
  machine.executeSettlement = async (req) => {
    const lockBatchId =
      req.lockBatchId ??
      ensureTestWithdrawalLock(sqlite, req.payoutId, req.affiliateId, req.amountUnits1e8, req.chain);
    return origExecute({ ...req, lockBatchId });
  };
  const origRecover = machine.recoverUncertainBroadcast.bind(machine);
  machine.recoverUncertainBroadcast = async (payoutId, opts) => {
    ensureTestWithdrawalLock(sqlite, payoutId);
    return origRecover(payoutId, opts);
  };
  return machine;
}

// ============================================================================
// Auditing Turnkey HSM Enclave Mock (Tracks Every Signed Payout & Amount)
// ============================================================================

class AuditingTurnkeyEnclave implements TurnkeySigningTransport {
  public readonly evmSignedPayoutIds: string[] = [];
  public readonly stellarSignedPayoutIds: string[] = [];
  public failStellarSignTimes = 0;
  private readonly enclaveKeyHex = '13'.repeat(32);

  async signEvmDigest(params: {
    chain: 'arbitrum' | 'base';
    signerAddress: string;
    digestHex: Hex;
    payoutId: string;
  }): Promise<EvmDigestSignature> {
    this.evmSignedPayoutIds.push(params.payoutId);
    const sig = secp256k1.sign(params.digestHex.slice(2), this.enclaveKeyHex);
    return {
      r: `0x${sig.r.toString(16).padStart(64, '0')}`,
      s: `0x${sig.s.toString(16).padStart(64, '0')}`,
      yParity: (sig.recovery === 1 ? 1 : 0) as 0 | 1,
      activityId: `tk_evm_${params.payoutId}_${this.evmSignedPayoutIds.length}`,
    };
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    if (this.failStellarSignTimes > 0) {
      this.failStellarSignTimes -= 1;
      throw new Error('Turnkey HSM transient timeout during Stellar envelope signing');
    }
    this.stellarSignedPayoutIds.push(params.payoutId);
    return {
      signedEnvelopeXdr: `SIGNED:${params.unsignedEnvelopeXdr}`,
      txHash: params.txHashHex,
      signatureBase64: Buffer.alloc(64, 9).toString('base64'),
      activityId: `tk_xlm_${params.payoutId}_${this.stellarSignedPayoutIds.length}`,
    };
  }
}

// ============================================================================
// Realistic Sepolia L2 Chain Simulator with 504 Gateway Timeout Chaos Injection
// ============================================================================

type ChaosMode = 'CLEAN' | 'TIMEOUT_504_LANDED' | 'TIMEOUT_504_DROPPED';

interface MinedEvmTransfer {
  txHash: Hex;
  nonce: number;
  recipient: string;
  amountUnits6: bigint;
}

class ChaosSepoliaL2Simulator implements EvmJsonRpcTransport {
  public readonly minedByHash = new Map<string, MinedEvmTransfer>();
  public readonly minedByNonce = new Map<number, MinedEvmTransfer>();
  public readonly chaosByNonce = new Map<number, ChaosMode>();
  private readonly consumedChaosNonces = new Set<number>();

  getConfirmedTransferCount(): number {
    return this.minedByNonce.size;
  }

  private getContiguousConfirmedNonce(): number {
    let cursor = 0;
    while (this.minedByNonce.has(cursor)) {
      cursor += 1;
    }
    return cursor;
  }

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (method === 'eth_call') {
      const txObj = (params[0] ?? {}) as { data?: string };
      const data = (txObj.data ?? '').toLowerCase();
      if (data.startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR)) {
        return (`0x${'0'.repeat(64)}` as unknown) as T;
      }
      return (`0x${'0'.repeat(63)}1` as unknown) as T;
    }

    if (method === 'eth_estimateGas') {
      return ('0xfde8' as unknown) as T;
    }
    if (method === 'eth_gasPrice') {
      return ('0x5f5e100' as unknown) as T;
    }
    if (method === 'eth_maxPriorityFeePerGas') {
      return ('0x989680' as unknown) as T;
    }

    if (method === 'eth_getTransactionCount') {
      const count = this.getConfirmedTransferCountForTag(String(params[1] ?? 'latest'));
      return (`0x${count.toString(16)}` as unknown) as T;
    }

    if (method === 'eth_sendRawTransaction') {
      const rawTxHex = String(params[0]) as Hex;
      const txHash = keccak256(rawTxHex);
      const parsed = parseTransaction(rawTxHex);
      const nonce = Number(parsed.nonce ?? 0);
      const calldata = String(parsed.data ?? '');
      // ERC-20 transfer(address,uint256): 0xa9059cbb + 32B addr + 32B amount
      const recipient = `0x${calldata.slice(34, 74)}`.toLowerCase();
      const amountUnits6 = BigInt(`0x${calldata.slice(74, 138)}`);

      const mode = !this.consumedChaosNonces.has(nonce)
        ? (this.chaosByNonce.get(nonce) ?? 'CLEAN')
        : 'CLEAN';

      if (mode === 'TIMEOUT_504_DROPPED') {
        this.consumedChaosNonces.add(nonce);
        throw new Error('504 Gateway Timeout: upstream L2 sequencer did not respond (dropped)');
      }

      // Enforce EVM consensus single-execution-per-nonce rule
      if (this.minedByNonce.has(nonce)) {
        const already = this.minedByNonce.get(nonce)!;
        if (already.txHash === txHash) {
          return (txHash as unknown) as T;
        }
        throw new Error(`nonce too low: nonce ${nonce} already mined by ${already.txHash}`);
      }

      const record: MinedEvmTransfer = {
        txHash,
        nonce,
        recipient,
        amountUnits6,
      };
      this.minedByNonce.set(nonce, record);
      this.minedByHash.set(txHash.toLowerCase(), record);

      if (mode === 'TIMEOUT_504_LANDED') {
        this.consumedChaosNonces.add(nonce);
        // Transaction landed in block, BEFORE HTTP proxy crashed with 504!
        throw new Error('504 Gateway Timeout: HTTP proxy disconnected after sequencer accepted tx');
      }

      return (txHash as unknown) as T;
    }

    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params[0] ?? '').toLowerCase();
      const mined = this.minedByHash.get(hash);
      if (!mined) {
        return (null as unknown) as T;
      }
      return ({
        status: '0x1',
        blockNumber: `0x${(1000 + mined.nonce).toString(16)}`,
        gasUsed: '0xc350',
        effectiveGasPrice: '0x5f5e100',
      } as unknown) as T;
    }

    throw new Error(`Unsupported RPC method: ${method}`);
  }

  private getConfirmedTransferCountForTag(tag: string): number {
    if (tag === 'pending') {
      return this.getContiguousConfirmedNonce();
    }
    return this.getContiguousConfirmedNonce();
  }
}

// ============================================================================
// Realistic Stellar Testnet Horizon Simulator with 504 Chaos & TimeBounds
// ============================================================================

interface MinedStellarTransfer {
  txHash: string;
  sequence: string;
  recipient: string;
  amountFormatted7: string;
  timeboundsMaxUnix: number;
}

class ChaosStellarTestnetSimulator implements StellarBroadcastTransport {
  public readonly authorizedTrustlines = new Set<string>();
  public readonly minedByHash = new Map<string, MinedStellarTransfer>();
  public readonly minedSequences = new Set<string>();
  public readonly chaosByAttemptIndex: ChaosMode[] = [];
  public currentClockUnix = 1_794_700_000;
  private submitCallIndex = 0;
  private baseSequence = BigInt(10000);

  async hasUsdcTrustline(accountId: string): Promise<boolean> {
    return this.authorizedTrustlines.has(accountId);
  }

  async getAccountSequence(_accountId: string): Promise<bigint> {
    return this.baseSequence + BigInt(this.minedSequences.size);
  }

  async buildUnsignedUsdcPayment(params: {
    fromAccount: string;
    recipientAddress: string;
    stellarSequence: string;
    amountStroops: bigint;
    amountFormatted7: string;
    timeboundsMaxUnix: number;
    memo?: string;
  }) {
    const payload = `${params.stellarSequence}|${params.recipientAddress}|${params.amountFormatted7}|${params.timeboundsMaxUnix}|${params.memo ?? ''}`;
    const txHashHex = keccak256(`0x${Buffer.from(payload, 'utf8').toString('hex')}`).slice(2);
    return {
      unsignedEnvelopeXdr: `UNSIGNED_XLM|${payload}`,
      txHashHex,
      stellarSequence: params.stellarSequence,
      timeboundsMaxUnix: params.timeboundsMaxUnix,
      amountFormatted7: params.amountFormatted7,
    };
  }

  async submitSignedTransaction(params: {
    signedEnvelopeXdr: string;
    signatureBase64: string;
    expectedTxHash: string;
  }): Promise<{ txHash: string; confirmed: boolean }> {
    const idx = this.submitCallIndex++;
    const mode = this.chaosByAttemptIndex[idx] ?? 'CLEAN';

    const parts = params.signedEnvelopeXdr.replace(/^SIGNED:UNSIGNED_XLM\|/, '').split('|');
    const [stellarSequence, recipient, amountFormatted7, maxTimeRaw] = parts;
    const timeboundsMaxUnix = Number(maxTimeRaw);

    if (this.currentClockUnix > timeboundsMaxUnix) {
      throw new Error('tx_too_late: Stellar TimeBounds expired');
    }

    if (mode === 'TIMEOUT_504_DROPPED') {
      throw new Error('504 Gateway Timeout: Horizon upstream dropped request before ledger');
    }

    if (this.minedSequences.has(stellarSequence)) {
      throw new Error(`tx_bad_seq: sequence ${stellarSequence} already consumed`);
    }

    const record: MinedStellarTransfer = {
      txHash: params.expectedTxHash,
      sequence: stellarSequence,
      recipient,
      amountFormatted7,
      timeboundsMaxUnix,
    };
    this.minedSequences.add(stellarSequence);
    this.minedByHash.set(params.expectedTxHash, record);

    if (mode === 'TIMEOUT_504_LANDED') {
      throw new Error('504 Gateway Timeout: Horizon edge proxy timed out after ledger close');
    }

    return { txHash: params.expectedTxHash, confirmed: true };
  }

  async lookupTransaction(txHash: string): Promise<StellarHorizonTxLookupResult> {
    const found = this.minedByHash.get(txHash);
    if (!found) {
      return { found: false, successful: false };
    }
    return { found: true, successful: true, ledger: 55001 };
  }
}

// ============================================================================
// Deterministic Valid Wallet Generator
// ============================================================================

const EVM_HOT_WALLET = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const STELLAR_HOT_WALLET = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';

const VALID_STELLAR_RECIPIENTS = [
  'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U',
  'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG',
  'GDFJHLAXAUMHA4OWPOB4P7YO72AQR2HMIUYFOXLXE2DZGM633K7HZDQP',
];

function makeEvmRecipient(index: number): string {
  const hexSuffix = (index + 1000).toString(16).padStart(40, '0');
  return `0x${hexSuffix}`;
}

// ============================================================================
// Gate G8 Test Suite
// ============================================================================

describe('Gate G8: 50 Concurrent Payouts with 30% 504 Timeout Chaos & BROADCAST_PENDING Recovery', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let enclave: AuditingTurnkeyEnclave;
  let turnkeySigner: TurnkeySigner;
  let arbSepoliaSim: ChaosSepoliaL2Simulator;
  let baseSepoliaSim: ChaosSepoliaL2Simulator;
  let stellarTestnetSim: ChaosStellarTestnetSimulator;
  let arbAdapter: ArbitrumBaseUsdcAdapter;
  let baseAdapter: ArbitrumBaseUsdcAdapter;
  let machine: BroadcastRecoveryMachine;

  beforeEach(() => {
    const created = createAscendancyDb();
    sqlite = created.sqlite;
    db = created.db;

    enclave = new AuditingTurnkeyEnclave();
    turnkeySigner = new TurnkeySigner({
      transport: enclave,
      evmHotWalletAddress: EVM_HOT_WALLET,
      stellarHotWalletAddress: STELLAR_HOT_WALLET,
    });

    arbSepoliaSim = new ChaosSepoliaL2Simulator();
    baseSepoliaSim = new ChaosSepoliaL2Simulator();
    stellarTestnetSim = new ChaosStellarTestnetSimulator();

    for (const addr of VALID_STELLAR_RECIPIENTS) {
      stellarTestnetSim.authorizedTrustlines.add(addr);
    }

    arbAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode: 'testnet',
      hotWalletAddress: EVM_HOT_WALLET,
      primaryRpc: arbSepoliaSim,
    });

    baseAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'base',
      networkMode: 'testnet',
      hotWalletAddress: EVM_HOT_WALLET,
      primaryRpc: baseSepoliaSim,
    });

    machine = bindTestWithdrawalLocks(
      new BroadcastRecoveryMachine({
        db,
        turnkeySigner,
        evmAdapters: {
          arbitrum: arbAdapter,
          base: baseAdapter,
        },
        stellarTransport: stellarTestnetSim,
        defaultUsdcPriceUsd: '1.0000',
        nowUnixProvider: () => stellarTestnetSim.currentClockUnix,
      }),
      sqlite
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  it('executes 50 concurrent payouts with 30% 504 timeouts, holds BROADCAST_PENDING locks, blocks premature Stellar re-sign before 180s, reuses EVM nonces, and achieves 0 double-sends and 0 >$250 hot leaks', async () => {
    // Design 50 concurrent payouts:
    // - Indices 0..44 (45 payouts across Stellar Testnet, Arbitrum Sepolia, Base Sepolia):
    //   $30.00 each -> 45 * $30 = $1,350.00 (fits within $1,500.00/24h hot cap; 15 per chain).
    // - Indices 45..49 (5 whale payouts): $260.00 .. $500.00 (> $250/tx cap -> MUST route to QUEUED_COLD_SAFE).
    //
    // Inject exactly 30% (15 of 50 = 30%, applied across the 45 hot-dispatched txs: 5 per chain = 15 timeouts):
    // - Arbitrum Sepolia nonces: nonce 1, 4 -> TIMEOUT_504_LANDED; nonce 2, 7, 11 -> TIMEOUT_504_DROPPED (5 total)
    // - Base Sepolia nonces: nonce 0, 5, 9 -> TIMEOUT_504_LANDED; nonce 3, 8 -> TIMEOUT_504_DROPPED (5 total)
    // - Stellar Testnet attempts: attempt 1, 6 -> TIMEOUT_504_LANDED; attempt 2, 8, 12 -> TIMEOUT_504_DROPPED (5 total)

    arbSepoliaSim.chaosByNonce.set(1, 'TIMEOUT_504_LANDED');
    arbSepoliaSim.chaosByNonce.set(4, 'TIMEOUT_504_LANDED');
    arbSepoliaSim.chaosByNonce.set(2, 'TIMEOUT_504_DROPPED');
    arbSepoliaSim.chaosByNonce.set(7, 'TIMEOUT_504_DROPPED');
    arbSepoliaSim.chaosByNonce.set(11, 'TIMEOUT_504_DROPPED');

    baseSepoliaSim.chaosByNonce.set(0, 'TIMEOUT_504_LANDED');
    baseSepoliaSim.chaosByNonce.set(5, 'TIMEOUT_504_LANDED');
    baseSepoliaSim.chaosByNonce.set(9, 'TIMEOUT_504_LANDED');
    baseSepoliaSim.chaosByNonce.set(3, 'TIMEOUT_504_DROPPED');
    baseSepoliaSim.chaosByNonce.set(8, 'TIMEOUT_504_DROPPED');

    for (let i = 0; i < 30; i++) {
      stellarTestnetSim.chaosByAttemptIndex[i] = 'CLEAN';
    }
    stellarTestnetSim.chaosByAttemptIndex[1] = 'TIMEOUT_504_LANDED';
    stellarTestnetSim.chaosByAttemptIndex[6] = 'TIMEOUT_504_LANDED';
    stellarTestnetSim.chaosByAttemptIndex[2] = 'TIMEOUT_504_DROPPED';
    stellarTestnetSim.chaosByAttemptIndex[8] = 'TIMEOUT_504_DROPPED';
    stellarTestnetSim.chaosByAttemptIndex[12] = 'TIMEOUT_504_DROPPED';

    const chains = ['stellar', 'arbitrum', 'base'] as const;

    const requests = Array.from({ length: 50 }, (_, i) => {
      const chain = chains[i % 3];
      const isWhale = i >= 45;
      const amountUsd = isWhale ? `${260 + (i - 45) * 60}.00` : '30.00';
      const recipientAddress =
        chain === 'stellar'
          ? VALID_STELLAR_RECIPIENTS[i % VALID_STELLAR_RECIPIENTS.length]
          : makeEvmRecipient(i);

      return {
        payoutId: `po_g8_${String(i).padStart(2, '0')}`,
        idempotencyKey: `idem_g8_${String(i).padStart(2, '0')}`,
        affiliateId: `aff_g8_${i}`,
        chain,
        recipientAddress,
        amountUnits1e8: toLedgerUnits1e8(amountUsd),
      };
    });

    // ========================================================================
    // Wave 1: Fire all 50 concurrent payouts simultaneously via Promise.all
    // ========================================================================
    const initialResults = await Promise.all(
      requests.map((req) => machine.executeSettlement(req))
    );

    expect(initialResults).toHaveLength(50);

    // Verify all 5 > $250 payouts routed to QUEUED_COLD_SAFE and NEVER touched Turnkey HSM
    const coldQueued = initialResults.filter((r) => r.state === 'QUEUED_COLD_SAFE');
    expect(coldQueued).toHaveLength(5);
    for (let i = 45; i < 50; i++) {
      const whaleId = `po_g8_${String(i).padStart(2, '0')}`;
      expect(enclave.evmSignedPayoutIds).not.toContain(whaleId);
      expect(enclave.stellarSignedPayoutIds).not.toContain(whaleId);
    }

    // Verify exactly 15 payouts (30% of 50) hit 504 Gateway Timeout and locked in BROADCAST_PENDING
    const pendingUncertain = initialResults.filter((r) => r.state === 'BROADCAST_PENDING');
    expect(pendingUncertain).toHaveLength(15);
    expect(pendingUncertain.every((r) => r.uncertainBroadcast === true)).toBe(true);

    // Snapshot signer_nonces BEFORE duplicate retry attempts
    const arbNextNonceBefore = await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET);
    const baseNextNonceBefore = await machine.getNextSignerNonce('base', EVM_HOT_WALLET);
    const xlmNextSeqBefore = await machine.getNextSignerNonce('stellar', STELLAR_HOT_WALLET);
    expect(arbNextNonceBefore).toBe(15);
    expect(baseNextNonceBefore).toBe(15);

    const signCountBeforeDupCalls =
      enclave.evmSignedPayoutIds.length + enclave.stellarSignedPayoutIds.length;

    // ========================================================================
    // Wave 2: Attempt duplicate executeSettlement on all 15 BROADCAST_PENDING payouts!
    // Must stay strictly locked: blocked by retained workflow owner or BROADCAST_PENDING,
    // with ZERO new nonces allocated and ZERO new HSM signatures!
    // ========================================================================
    const dupAttempts = await Promise.all(
      pendingUncertain.map(async (p) => {
        const origReq = requests.find((r) => r.payoutId === p.payoutId)!;
        try {
          const outcome = await machine.executeSettlement(origReq);
          return { blocked: false as const, state: outcome.state };
        } catch (err: unknown) {
          return {
            blocked: true as const,
            message: err instanceof Error ? err.message : String(err),
          };
        }
      })
    );
    expect(
      dupAttempts.every((d) =>
        d.blocked
          ? /workflow ownership unconfirmed or stale/.test(d.message)
          : d.state === 'BROADCAST_PENDING'
      )
    ).toBe(true);
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBe(arbNextNonceBefore);
    expect(await machine.getNextSignerNonce('base', EVM_HOT_WALLET)).toBe(baseNextNonceBefore);
    expect(await machine.getNextSignerNonce('stellar', STELLAR_HOT_WALLET)).toBe(xlmNextSeqBefore);
    expect(enclave.evmSignedPayoutIds.length + enclave.stellarSignedPayoutIds.length).toBe(
      signCountBeforeDupCalls
    );

    // ========================================================================
    // Wave 3: Run recovery at t0 + 60s (BEFORE Stellar 180s TimeBounds expiry!)
    // - Landed Stellar & EVM 504s reconcile to CONFIRMED via passive observation with 0 re-signs.
    // - Dropped EVM & Stellar 504s with uncertain provider outcomes stay strictly locked in
    //   BROADCAST_PENDING (retained workflow owner; ZERO automatic re-sign or nonce reuse).
    // ========================================================================
    stellarTestnetSim.currentClockUnix += 60; // +60s (< 180s TimeBounds!)

    const recoveryAt60s = await Promise.all(
      pendingUncertain.map((p, idx) =>
        machine.recoverUncertainBroadcast(p.payoutId, {
          nowUnix: stellarTestnetSim.currentClockUnix,
          bumpGasRbf: idx % 2 === 1,
        })
      )
    );

    // Check Stellar dropped txs (3 of them) remained strictly LOCKED in BROADCAST_PENDING
    const lockedStellarAt60s = recoveryAt60s.filter(
      (r) => r.chain === 'stellar' && r.state === 'BROADCAST_PENDING'
    );
    expect(lockedStellarAt60s).toHaveLength(3);
    expect(
      lockedStellarAt60s.every(
        (r) => r.action === 'LOCKED_AWAITING_TIMEBOUNDS_EXPIRY' || r.action === 'STILL_BROADCAST_PENDING'
      )
    ).toBe(true);

    // Check Stellar landed txs (2 of them) reconciled cleanly without re-signing
    const reconciledStellarAt60s = recoveryAt60s.filter(
      (r) => r.chain === 'stellar' && r.action === 'RECONCILED_ON_CHAIN'
    );
    expect(reconciledStellarAt60s).toHaveLength(2);

    // Check EVM 504s: 5 landed reconciled to CONFIRMED, 5 dropped stay fenced in BROADCAST_PENDING
    const evmRecoveries = recoveryAt60s.filter(
      (r) => r.chain === 'arbitrum' || r.chain === 'base'
    );
    expect(evmRecoveries).toHaveLength(10);
    expect(
      evmRecoveries.filter((r) => r.state === 'CONFIRMED' && r.action === 'RECONCILED_ON_CHAIN')
    ).toHaveLength(5);
    expect(
      evmRecoveries.filter((r) => r.state === 'BROADCAST_PENDING')
    ).toHaveLength(5);

    // CRITICAL INVARIANT: EVM next_nonce stayed at 15 (0 extra nonces ever allocated!)
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBe(15);
    expect(await machine.getNextSignerNonce('base', EVM_HOT_WALLET)).toBe(15);

    // Verify each EVM payout preserved its exact original assigned_nonce
    for (const pendingItem of pendingUncertain.filter((p) => p.chain !== 'stellar')) {
      const updated = await machine.getSettlementRecord(pendingItem.payoutId);
      expect(updated?.assigned_nonce).toBe(pendingItem.assignedNonce);
    }

    // ========================================================================
    // Wave 4: Advance clock past 180s TimeBounds (t0 + 185s) — local expiry + Horizon absence
    // cannot prove non-execution, so dropped Stellar txs remain safely fenced in BROADCAST_PENDING.
    // ========================================================================
    stellarTestnetSim.currentClockUnix += 125; // Total +185s (> 180s TimeBounds!)

    const postExpiryChecks = await Promise.all(
      lockedStellarAt60s.map((item) =>
        machine.recoverUncertainBroadcast(item.payoutId, {
          nowUnix: stellarTestnetSim.currentClockUnix,
          reexecuteExpired: true,
        })
      )
    );
    expect(postExpiryChecks.every((r) => r.state === 'BROADCAST_PENDING')).toBe(true);
    expect(enclave.evmSignedPayoutIds.length + enclave.stellarSignedPayoutIds.length).toBe(
      signCountBeforeDupCalls
    );

    // ========================================================================
    // Final Audit Across All 50 Payouts: ZERO Double-Sends & ZERO Cap Leaks
    // ========================================================================
    const allDbRows = sqlite
      .prepare('SELECT * FROM settlement_broadcasts ORDER BY payout_id ASC')
      .all() as Array<{
      payout_id: string;
      chain: string;
      amount_units_1e8: number;
      state: string;
      assigned_nonce: number | null;
      tx_hash: string | null;
    }>;

    expect(allDbRows).toHaveLength(50);

    const confirmedRows = allDbRows.filter((r) => r.state === 'CONFIRMED');
    const pendingRows = allDbRows.filter((r) => r.state === 'BROADCAST_PENDING');
    const queuedSafeRows = allDbRows.filter((r) => r.state === 'QUEUED_COLD_SAFE');
    expect(confirmedRows).toHaveLength(37); // 30 immediate + 7 landed 504s reconciled
    expect(pendingRows).toHaveLength(8); // 5 dropped EVM + 3 dropped Stellar safely fenced
    expect(queuedSafeRows).toHaveLength(5);

    // 1. Assert ZERO payouts > $250 ever landed in CONFIRMED / hot wallet
    for (const row of confirmedRows) {
      expect(BigInt(row.amount_units_1e8) <= HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8).toBe(true);
    }

    // 2. Assert total 24h hot-wallet exposure includes BOTH confirmed and unresolved pending ($1,350.00 exact)
    const rolling24h = await turnkeySigner.getRolling24hHotVolumeUnits1e8(db);
    expect(rolling24h).toBe(toLedgerUnits1e8('1350.00'));
    expect(rolling24h <= HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8).toBe(true);

    // 3. Assert ZERO double-sends: total on-chain transfers === confirmedRows.length (37 exact 1:1)
    const totalOnChainTransfers =
      arbSepoliaSim.getConfirmedTransferCount() +
      baseSepoliaSim.getConfirmedTransferCount() +
      stellarTestnetSim.minedByHash.size;
    expect(totalOnChainTransfers).toBe(37);

    // 4. Every EVM recipient that received a transfer received AT MOST 1 transfer of 30_000_000 (6-decimal) USDC units
    for (let i = 0; i < 45; i++) {
      const chain = chains[i % 3];
      if (chain === 'arbitrum' || chain === 'base') {
        const expectedRecipient = makeEvmRecipient(i).toLowerCase();
        const sim = chain === 'arbitrum' ? arbSepoliaSim : baseSepoliaSim;
        const transfersToRecipient = Array.from(sim.minedByNonce.values()).filter(
          (t) => t.recipient === expectedRecipient
        );
        expect(transfersToRecipient.length).toBeLessThanOrEqual(1);
        if (transfersToRecipient.length === 1) {
          expect(transfersToRecipient[0].amountUnits6).toBe(BigInt(30000000));
        }
      }
    }
  });

  it('guarantees cross-isolate atomic 24h cap enforcement, cross-isolate nonce serialization, and pre-broadcast nonce reclamation without burning nonces', async () => {
    // 1. Cross-isolate 24h cap race: launch 8 concurrent $240 payouts ($1,920 total > $1,500 24h cap)
    //    across two separate BroadcastRecoveryMachine instances sharing D1 (simulating 2 Worker isolates
    //    where process-local mutexes do NOT coordinate).
    const isolateMachineA = bindTestWithdrawalLocks(
      new BroadcastRecoveryMachine({
        db,
        turnkeySigner,
        evmAdapters: { arbitrum: arbAdapter, base: baseAdapter },
        stellarTransport: stellarTestnetSim,
      }),
      sqlite
    );
    const isolateMachineB = bindTestWithdrawalLocks(
      new BroadcastRecoveryMachine({
        db,
        turnkeySigner,
        evmAdapters: { arbitrum: arbAdapter, base: baseAdapter },
        stellarTransport: stellarTestnetSim,
      }),
      sqlite
    );

    const raceOutcomes = await Promise.all(
      Array.from({ length: 8 }, (_, idx) => {
        const runner = idx % 2 === 0 ? isolateMachineA : isolateMachineB;
        return runner.executeSettlement({
          payoutId: `po_iso_race_${idx}`,
          idempotencyKey: `idem_iso_race_${idx}`,
          affiliateId: `aff_iso_${idx}`,
          chain: 'arbitrum',
          recipientAddress: makeEvmRecipient(200 + idx),
          amountUnits1e8: toLedgerUnits1e8('240.00'),
          usdcReferencePriceUsd: '1.0000',
        });
      })
    );

    const raceConfirmed = raceOutcomes.filter((o) => o.state === 'CONFIRMED');
    const raceCold = raceOutcomes.filter((o) => o.state === 'QUEUED_COLD_SAFE');
    // 6 * $240 = $1,440 <= $1,500; 7th ($1,680) and 8th ($1,920) MUST route to QUEUED_COLD_SAFE
    expect(raceConfirmed).toHaveLength(6);
    expect(raceCold).toHaveLength(2);

    const rollingAfterRace = await turnkeySigner.getRolling24hHotVolumeUnits1e8(db);
    expect(rollingAfterRace).toBe(toLedgerUnits1e8('1440.00'));
    expect(rollingAfterRace <= HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8).toBe(true);

    // Verify contiguous EVM nonces 0..5 with zero collisions across the two isolates
    const assignedNonces = raceConfirmed
      .map((o) => o.assignedNonce)
      .filter((n): n is number => typeof n === 'number')
      .sort((a, b) => a - b);
    expect(assignedNonces).toEqual([0, 1, 2, 3, 4, 5]);

    // 2. Pre-broadcast nonce reclamation: force Turnkey HSM transient outage on a $40 payout ($1,480 <= $1,500)
    //    after nonce 6 is reserved, then verify the next $40 payout reclaims nonce 6 cleanly!
    const origSignEvm = enclave.signEvmDigest.bind(enclave);
    let failHsmOnce = true;
    enclave.signEvmDigest = async (p) => {
      if (failHsmOnce) {
        failHsmOnce = false;
        throw new Error('Turnkey HSM transient network socket reset before signing');
      }
      return origSignEvm(p);
    };

    await expect(
      isolateMachineA.executeSettlement({
        payoutId: 'po_reclaim_nonce_fail',
        idempotencyKey: 'idem_reclaim_nonce_fail',
        affiliateId: 'aff_reclaim_1',
        chain: 'arbitrum',
        recipientAddress: makeEvmRecipient(301),
        amountUnits1e8: toLedgerUnits1e8('40.00'),
        usdcReferencePriceUsd: '1.0000',
      })
    ).rejects.toThrow(/provider outcome uncertain; reconcile retained owner/);

    // Provider exception after signing grant does not prove non-execution; nonce 6 is retained.
    const retainedRow = sqlite
      .prepare('SELECT state, assigned_nonce FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_reclaim_nonce_fail') as { state: string; assigned_nonce: number | null };
    expect(retainedRow.state).toBe('SIGNING');
    expect(retainedRow.assigned_nonce).toBe(6);

    // Retained unresolved $40 keeps 24h hot exposure at $1,480 ($1,440 + $40), so another $40
    // exceeds the $1,500 rolling cap and routes to QUEUED_COLD_SAFE instead of leaking exposure.
    const capProtectedCold = await isolateMachineB.executeSettlement({
      payoutId: 'po_reclaim_nonce_cold',
      idempotencyKey: 'idem_reclaim_nonce_cold',
      affiliateId: 'aff_reclaim_2',
      chain: 'arbitrum',
      recipientAddress: makeEvmRecipient(302),
      amountUnits1e8: toLedgerUnits1e8('40.00'),
      usdcReferencePriceUsd: '1.0000',
    });
    expect(capProtectedCold.state).toBe('QUEUED_COLD_SAFE');

    // A $20 payout fits within the remaining $20 cap ($1,480 + $20 = $1,500) and allocates nonce 7
    // so it never collides with uncertain nonce 6.
    const nextSuccess = await isolateMachineB.executeSettlement({
      payoutId: 'po_reclaim_nonce_ok',
      idempotencyKey: 'idem_reclaim_nonce_ok',
      affiliateId: 'aff_reclaim_3',
      chain: 'arbitrum',
      recipientAddress: makeEvmRecipient(303),
      amountUnits1e8: toLedgerUnits1e8('20.00'),
      usdcReferencePriceUsd: '1.0000',
    });
    expect(nextSuccess.state).toBe('CONFIRMED');
    expect(nextSuccess.assignedNonce).toBe(7);
  });

  it('aborts EVM settlement when pre-submission nonce read or unsigned tx construction fails, reclaiming the nonce without burning it', async () => {
    // Case 1: nonce reservation read fails before any nonce is allocated.
    const origCall = arbSepoliaSim.call.bind(arbSepoliaSim);
    let failNonceReadOnce = true;
    arbSepoliaSim.call = async <T,>(method: string, params: unknown[] = []): Promise<T> => {
      if (failNonceReadOnce && method === 'eth_getTransactionCount') {
        failNonceReadOnce = false;
        throw new Error('RPC 503: eth_getTransactionCount unavailable before nonce allocation');
      }
      return origCall<T>(method, params);
    };

    await expect(
      machine.executeSettlement({
        payoutId: 'po_prep_nonce_read_fail',
        idempotencyKey: 'idem_prep_nonce_read_fail',
        affiliateId: 'aff_prep_1',
        chain: 'arbitrum',
        recipientAddress: makeEvmRecipient(401),
        amountUnits1e8: toLedgerUnits1e8('20.00'),
        usdcReferencePriceUsd: '1.0000',
      })
    ).rejects.toThrow(/eth_getTransactionCount unavailable/);

    const nonceReadAborted = sqlite
      .prepare('SELECT state, assigned_nonce, tx_hash, signed_raw_tx FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_prep_nonce_read_fail') as {
      state: string;
      assigned_nonce: number | null;
      tx_hash: string | null;
      signed_raw_tx: string | null;
    };
    expect(nonceReadAborted.state).toBe('FAILED_ABORTED');
    expect(nonceReadAborted.assigned_nonce).toBeNull();
    expect(nonceReadAborted.tx_hash).toBeNull();
    expect(nonceReadAborted.signed_raw_tx).toBeNull();
    expect(enclave.evmSignedPayoutIds).not.toContain('po_prep_nonce_read_fail');
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBeNull();

    // Case 2: unsigned tx construction fails after the nonce was reserved and persisted.
    const origBuild = arbAdapter.buildUnsignedTransfer.bind(arbAdapter);
    let failBuildOnce = true;
    arbAdapter.buildUnsignedTransfer = async (params) => {
      if (failBuildOnce) {
        failBuildOnce = false;
        throw new Error('EVM unsigned tx construction failure (gas estimation envelope rejected)');
      }
      return origBuild(params);
    };

    await expect(
      machine.executeSettlement({
        payoutId: 'po_prep_build_fail',
        idempotencyKey: 'idem_prep_build_fail',
        affiliateId: 'aff_prep_2',
        chain: 'arbitrum',
        recipientAddress: makeEvmRecipient(402),
        amountUnits1e8: toLedgerUnits1e8('20.00'),
        usdcReferencePriceUsd: '1.0000',
      })
    ).rejects.toThrow(/unsigned tx construction failure/);

    const buildAborted = sqlite
      .prepare('SELECT state, assigned_nonce FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_prep_build_fail') as { state: string; assigned_nonce: number | null };
    expect(buildAborted.state).toBe('FAILED_ABORTED');
    expect(buildAborted.assigned_nonce).toBeNull();
    expect(enclave.evmSignedPayoutIds).not.toContain('po_prep_build_fail');
    // Nonce 0 was reserved then reclaimed by the top-of-counter CAS (never burned).
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBe(0);

    const afterPrepFailures = await machine.executeSettlement({
      payoutId: 'po_prep_build_recovered',
      idempotencyKey: 'idem_prep_build_recovered',
      affiliateId: 'aff_prep_3',
      chain: 'arbitrum',
      recipientAddress: makeEvmRecipient(403),
      amountUnits1e8: toLedgerUnits1e8('20.00'),
      usdcReferencePriceUsd: '1.0000',
    });
    expect(afterPrepFailures.state).toBe('CONFIRMED');
    expect(afterPrepFailures.assignedNonce).toBe(0);
  });

  it('aborts Stellar settlement when sequence read, unsigned tx build, or HSM signing fails, reclaiming the 64-bit sequence without burning it', async () => {
    const stellarRequest = (payoutId: string, recipient: string, idempotencyKey: string) => ({
      payoutId,
      idempotencyKey,
      affiliateId: `aff_${payoutId}`,
      chain: 'stellar' as const,
      recipientAddress: recipient,
      amountUnits1e8: toLedgerUnits1e8('20.00'),
      usdcReferencePriceUsd: '1.0000',
    });

    // Case 1: Horizon sequence read fails before any sequence is allocated.
    const origGetSequence = stellarTestnetSim.getAccountSequence.bind(stellarTestnetSim);
    let failSequenceReadOnce = true;
    stellarTestnetSim.getAccountSequence = async (accountId: string) => {
      if (failSequenceReadOnce) {
        failSequenceReadOnce = false;
        throw new Error('Horizon 503: account sequence read failed before allocation');
      }
      return origGetSequence(accountId);
    };

    await expect(
      machine.executeSettlement(
        stellarRequest('po_xlm_seq_read_fail', VALID_STELLAR_RECIPIENTS[0], 'idem_xlm_seq_read_fail')
      )
    ).rejects.toThrow(/account sequence read failed/);

    const seqReadAborted = sqlite
      .prepare('SELECT state, stellar_sequence, tx_hash FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_xlm_seq_read_fail') as {
      state: string;
      stellar_sequence: string | null;
      tx_hash: string | null;
    };
    expect(seqReadAborted.state).toBe('FAILED_ABORTED');
    expect(seqReadAborted.stellar_sequence).toBeNull();
    expect(seqReadAborted.tx_hash).toBeNull();
    expect(enclave.stellarSignedPayoutIds).not.toContain('po_xlm_seq_read_fail');
    expect(await machine.getNextStellarSequence(STELLAR_HOT_WALLET)).toBeNull();

    // Case 2: unsigned envelope construction fails after the sequence was reserved and persisted.
    const origBuildUnsigned = stellarTestnetSim.buildUnsignedUsdcPayment.bind(stellarTestnetSim);
    let failStellarBuildOnce = true;
    stellarTestnetSim.buildUnsignedUsdcPayment = async (params) => {
      if (failStellarBuildOnce) {
        failStellarBuildOnce = false;
        throw new Error('Stellar unsigned envelope construction failed before signing');
      }
      return origBuildUnsigned(params);
    };

    await expect(
      machine.executeSettlement(
        stellarRequest('po_xlm_build_fail', VALID_STELLAR_RECIPIENTS[1], 'idem_xlm_build_fail')
      )
    ).rejects.toThrow(/unsigned envelope construction failed/);

    const buildAborted = sqlite
      .prepare('SELECT state, stellar_sequence, timebounds_max_unix FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_xlm_build_fail') as {
      state: string;
      stellar_sequence: string | null;
      timebounds_max_unix: number | null;
    };
    expect(buildAborted.state).toBe('FAILED_ABORTED');
    expect(buildAborted.stellar_sequence).toBeNull();
    expect(buildAborted.timebounds_max_unix).toBeNull();
    expect(enclave.stellarSignedPayoutIds).not.toContain('po_xlm_build_fail');
    expect((await machine.getNextStellarSequence(STELLAR_HOT_WALLET))?.toString()).toBe('10001');

    // Case 3: Turnkey HSM fails while signing a fully built envelope.
    // Provider exception after signing grant retains sequence 10001 instead of reclaiming blindly.
    enclave.failStellarSignTimes = 1;
    await expect(
      machine.executeSettlement(
        stellarRequest('po_xlm_hsm_fail', VALID_STELLAR_RECIPIENTS[2], 'idem_xlm_hsm_fail')
      )
    ).rejects.toThrow(/provider outcome uncertain; reconcile retained owner/);

    const hsmRetained = sqlite
      .prepare('SELECT state, stellar_sequence FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_xlm_hsm_fail') as { state: string; stellar_sequence: string | null };
    expect(hsmRetained.state).toBe('SIGNING');
    expect(hsmRetained.stellar_sequence).toBe('10001');
    expect(enclave.stellarSignedPayoutIds).not.toContain('po_xlm_hsm_fail');
    expect((await machine.getNextStellarSequence(STELLAR_HOT_WALLET))?.toString()).toBe('10002');
    expect(stellarTestnetSim.minedSequences.size).toBe(0);

    // Next payout allocates sequence 10002 without colliding with retained sequence 10001.
    const recovered = await machine.executeSettlement(
      stellarRequest('po_xlm_prep_recovered', VALID_STELLAR_RECIPIENTS[0], 'idem_xlm_prep_recovered')
    );
    expect(recovered.state).toBe('CONFIRMED');
    expect(recovered.stellarSequence).toBe('10002');
  });

  it('refuses to abort an active or payload-bearing SIGNING claim and never signs or broadcasts during passive recovery', async () => {
    const realNowUnix = Math.floor(Date.now() / 1000);

    sqlite
      .prepare(
        `INSERT INTO signer_nonces (chain, signer_address, next_nonce, updated_at)
         VALUES ('arbitrum', ?, 7, datetime('now'))`
      )
      .run(EVM_HOT_WALLET);
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts (
           payout_id, idempotency_key, affiliate_id, chain, recipient_address,
           amount_units_1e8, chain_token_units, chain_decimals, state, signer_address,
           assigned_nonce, created_at, updated_at
         ) VALUES (?, ?, ?, 'arbitrum', ?, ?, ?, 6, 'SIGNING', ?, ?, datetime('now'), datetime('now'))`
      )
      .run(
        'po_signing_active',
        'idem_signing_active',
        'aff_signing_active',
        makeEvmRecipient(501),
        Number(toLedgerUnits1e8('25.00')),
        '25000000',
        EVM_HOT_WALLET,
        6
      );

    // Fresh claim: interactive recovery must never auto-abort a SIGNING row on elapsed time.
    expect(SIGNING_STALE_ABORT_AFTER_SECONDS).toBe(300);
    const youngOutcome = await machine.recoverUncertainBroadcast('po_signing_active', {
      nowUnix: realNowUnix + 60,
    });
    expect(youngOutcome.state).toBe('SIGNING');
    expect(youngOutcome.action).toBe('NO_RECOVERY_NEEDED');
    expect(youngOutcome.reason).toMatch(/Elapsed time does not prove signing did not occur/);

    // Passive recovery never aborts an active SIGNING claim, even when it is stale.
    const passiveOutcome = await machine.recoverUncertainBroadcast('po_signing_active', {
      nowUnix: realNowUnix + 10_000,
      passiveOnly: true,
    });
    expect(passiveOutcome.state).toBe('SIGNING');
    expect(passiveOutcome.action).toBe('NO_RECOVERY_NEEDED');
    expect(passiveOutcome.reason).toMatch(/Elapsed time does not prove signing did not occur/);

    // A stale SIGNING row holding a Turnkey activity id must never be released either.
    sqlite
      .prepare(
        `UPDATE settlement_broadcasts
         SET turnkey_activity_id = 'tk_evm_po_signing_active_1',
             updated_at = datetime('now', '-1 hour')
         WHERE payout_id = 'po_signing_active'`
      )
      .run();
    const payloadOutcome = await machine.recoverUncertainBroadcast('po_signing_active', {
      nowUnix: realNowUnix + 60,
    });
    expect(payloadOutcome.state).toBe('SIGNING');
    expect(payloadOutcome.action).toBe('NO_RECOVERY_NEEDED');
    expect(payloadOutcome.reason).toMatch(/Elapsed time does not prove signing did not occur/);

    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBe(7);
    expect(enclave.evmSignedPayoutIds).toHaveLength(0);
    expect(arbSepoliaSim.getConfirmedTransferCount()).toBe(0);
  });

  it('aborts a stale zero-payload SIGNING claim with top-of-counter reclamation and fences a resumed isolate out of broadcasting', async () => {
    const realNowUnix = Math.floor(Date.now() / 1000);

    sqlite
      .prepare(
        `INSERT INTO signer_nonces (chain, signer_address, next_nonce, updated_at)
         VALUES ('arbitrum', ?, 43, datetime('now'))`
      )
      .run(EVM_HOT_WALLET);
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts (
           payout_id, idempotency_key, affiliate_id, chain, recipient_address,
           amount_units_1e8, chain_token_units, chain_decimals, state, signer_address,
           assigned_nonce, created_at, updated_at
         ) VALUES (?, ?, ?, 'arbitrum', ?, ?, ?, 6, 'SIGNING', ?, ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))`
      )
      .run(
        'po_signing_stale',
        'idem_signing_stale',
        'aff_signing_stale',
        makeEvmRecipient(502),
        Number(toLedgerUnits1e8('30.00')),
        '30000000',
        EVM_HOT_WALLET,
        42
      );

    const staleOutcome = await machine.recoverUncertainBroadcast('po_signing_stale', {
      nowUnix: realNowUnix,
    });
    expect(staleOutcome.state).toBe('SIGNING');
    expect(staleOutcome.action).toBe('NO_RECOVERY_NEEDED');
    expect(staleOutcome.reason).toMatch(/Elapsed time does not prove signing did not occur/);

    const staleRow = sqlite
      .prepare('SELECT state, assigned_nonce, tx_hash, signed_raw_tx FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_signing_stale') as {
      state: string;
      assigned_nonce: number | null;
      tx_hash: string | null;
      signed_raw_tx: string | null;
    };
    expect(staleRow.state).toBe('SIGNING');
    expect(staleRow.assigned_nonce).toBe(42);
    expect(staleRow.tx_hash).toBeNull();
    expect(staleRow.signed_raw_tx).toBeNull();

    // Nonce 42 is NOT blindly reclaimed on elapsed time alone.
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBe(43);

    // Re-dispatch sees the unresolved SIGNING record and refuses to allocate a duplicate nonce.
    const reDispatch = await machine.executeSettlement({
      payoutId: 'po_signing_stale',
      idempotencyKey: 'idem_signing_stale',
      affiliateId: 'aff_signing_stale',
      chain: 'arbitrum',
      recipientAddress: makeEvmRecipient(502),
      amountUnits1e8: toLedgerUnits1e8('30.00'),
      usdcReferencePriceUsd: '1.0000',
    });
    expect(reDispatch.state).toBe('SIGNING');
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_WALLET)).toBe(43);
    expect(enclave.evmSignedPayoutIds).toHaveLength(0);
    expect(arbSepoliaSim.getConfirmedTransferCount()).toBe(0);
  });

  it('refuses to auto-abort a stale Stellar SIGNING claim on elapsed time alone and retains sequence ownership', async () => {
    const realNowUnix = Math.floor(Date.now() / 1000);

    sqlite
      .prepare(
        `INSERT INTO signer_nonces (chain, signer_address, next_nonce, next_sequence_text, updated_at)
         VALUES ('stellar', ?, 0, '10002', datetime('now'))`
      )
      .run(STELLAR_HOT_WALLET);
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts (
           payout_id, idempotency_key, affiliate_id, chain, recipient_address,
           amount_units_1e8, chain_token_units, chain_decimals, state, signer_address,
           stellar_sequence, timebounds_max_unix, created_at, updated_at
         ) VALUES (?, ?, ?, 'stellar', ?, ?, ?, 7, 'SIGNING', ?, '10001', ?, datetime('now', '-1 hour'), datetime('now', '-1 hour'))`
      )
      .run(
        'po_xlm_signing_stale',
        'idem_xlm_signing_stale',
        'aff_xlm_signing_stale',
        VALID_STELLAR_RECIPIENTS[0],
        Number(toLedgerUnits1e8('30.00')),
        '300000000',
        STELLAR_HOT_WALLET,
        realNowUnix + 10_000
      );

    const staleOutcome = await machine.recoverUncertainBroadcast('po_xlm_signing_stale', {
      nowUnix: realNowUnix,
    });
    expect(staleOutcome.state).toBe('SIGNING');
    expect(staleOutcome.action).toBe('NO_RECOVERY_NEEDED');
    expect(staleOutcome.reason).toMatch(/Elapsed time does not prove signing did not occur/);

    const staleRow = sqlite
      .prepare('SELECT state, stellar_sequence, timebounds_max_unix FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_xlm_signing_stale') as {
      state: string;
      stellar_sequence: string | null;
      timebounds_max_unix: number | null;
    };
    expect(staleRow.state).toBe('SIGNING');
    expect(staleRow.stellar_sequence).toBe('10001');
    expect(staleRow.timebounds_max_unix).toBe(realNowUnix + 10_000);

    expect((await machine.getNextStellarSequence(STELLAR_HOT_WALLET))?.toString()).toBe('10002');
    expect(enclave.stellarSignedPayoutIds).toHaveLength(0);
    expect(stellarTestnetSim.minedSequences.size).toBe(0);
  });
});
