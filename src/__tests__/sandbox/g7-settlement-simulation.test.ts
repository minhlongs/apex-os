/**
 * src/__tests__/sandbox/g7-settlement-simulation.test.ts
 *
 * Sandbox Gate G7: Phase 1 Multi-Chain USDC Settlement Simulation
 *
 * Verifies:
 * 1. Canonical Circle Mainnet USDC issuer/contracts (Stellar, Arbitrum One, Base)
 *    and explicit rejection of bridged USDC.e / USDbC.
 * 2. Exact decimal scaling (7 decimals stroops on Stellar vs 6 decimals on Arbitrum/Base)
 *    with ROUND_DOWN integer math and zero IEEE-754 float drift.
 * 3. $10.00 USDC minimum withdrawal floor across adapters, guards, state machine, and D1 CHECK constraint.
 * 4. Rejection of missing/unauthorized Stellar USDC trustlines (zero free trustline/reserve sponsorship).
 * 5. Rejection of Circle `isBlacklisted(address)` (0xfe575a87) & OFAC SDN addresses + RPC failover.
 * 6. Rejection of Ethereum L1 and Solana (`DISABLED_PHASE1` — zero L1 gas / zero 0.002039 SOL ATA rent).
 * 7. Turnkey HSM key isolation (`hasRawPrivateKeyInMemory() === false`), $250/tx & $1,500/24h caps
 *    routing excess to `QUEUED_COLD_SAFE`, and >= 80% Safe{Wallet} 2-of-3 cold reserve invariant.
 * 8. USDC depeg ($0.980) flipping `EMERGENCY_PAUSE = 'true'` in `system_runtime_flags` and halting settlement.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, type Hex } from 'viem';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import {
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
  STELLAR_USDC_DECIMALS,
  StellarNetwork,
  StellarService,
  USDC_CONFIG,
  fromStellarStroops,
  ledgerUnits1e8ToStellarStroops,
  toStellarStroops,
} from '@/lib/payouts/stellar-service';
import {
  STELLAR_OFFICIAL_USDC_ISSUER,
  StellarAdapter,
} from '@/lib/payouts/adapters/stellar-adapter';
import { getUSDCInfo } from '@/lib/admin/stellar-actions';
import {
  ARBITRUM_ONE_CHAIN_ID,
  ArbitrumBaseUsdcAdapter,
  BASE_MAINNET_CHAIN_ID,
  CANONICAL_ARBITRUM_NATIVE_USDC,
  CANONICAL_BASE_NATIVE_USDC,
  CIRCLE_IS_BLACKLISTED_SELECTOR,
  EVM_USDC_DECIMALS,
  MinimumWithdrawalFloorError,
  NonCanonicalUsdcContractError,
  Phase1ChainDisabledError,
  REJECTED_ARBITRUM_BRIDGED_USDC_E,
  REJECTED_BASE_BRIDGED_USDBC,
  assertMinimumWithdrawalFloor,
  assertPhase1ChainEnabled,
  checkPhase1ChainGate,
  encodeIsBlacklistedCalldata,
  ledgerUnits1e8ToEvmUsdcUnits,
  toEvmUsdcUnits,
  toLedgerUnits1e8,
  type EvmJsonRpcTransport,
} from '@/lib/payouts/adapters/arbitrum-base-usdc-adapter';
import {
  HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8,
  HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8,
  TurnkeySigner,
  verifyTreasuryReserveDistribution,
  type EvmDigestSignature,
  type StellarEnvelopeSignature,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import {
  UsdcSafetyGuardError,
  assertPreSigningSafetyGuards,
  enforceUsdcPegCircuitBreaker,
  evaluateUsdcPegBand,
  isEmergencySettlementPaused,
} from '@/lib/payouts/usdc-safety-guards';
import {
  BroadcastRecoveryMachine,
  type StellarBroadcastTransport,
} from '@/lib/payouts/broadcast-recovery-machine';

// ============================================================================
// Typed SQLite-backed D1 Harness
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
          return {
            results: rows,
            success: true,
            meta: { duration: 0 },
          };
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
  ownerId = 'trader_g7',
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
  const disbursableUnits =
    chain === 'arbitrum' || chain === 'base'
      ? amountUnits1e8 - (amountUnits1e8 % BigInt(100))
      : chain === 'stellar'
        ? amountUnits1e8 - (amountUnits1e8 % BigInt(10))
        : amountUnits1e8;
  const amountNum = Number(disbursableUnits);
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
        lockedAmountUnits: disbursableUnits.toString(),
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
// Enclave HSM Mock Transport (Private Key Lives ONLY Inside Simulated Enclave)
// ============================================================================

class SimulatedEnclaveTransport implements TurnkeySigningTransport {
  public evmSignCalls = 0;
  public stellarSignCalls = 0;
  private readonly enclaveInternalKeyHex = '0b'.repeat(32);

  async signEvmDigest(params: {
    chain: 'arbitrum' | 'base';
    signerAddress: string;
    digestHex: Hex;
    payoutId: string;
  }): Promise<EvmDigestSignature> {
    this.evmSignCalls += 1;
    const sig = secp256k1.sign(params.digestHex.slice(2), this.enclaveInternalKeyHex);
    return {
      r: `0x${sig.r.toString(16).padStart(64, '0')}`,
      s: `0x${sig.s.toString(16).padStart(64, '0')}`,
      yParity: (sig.recovery === 1 ? 1 : 0) as 0 | 1,
      activityId: `turnkey_evm_${params.payoutId}_${this.evmSignCalls}`,
    };
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    this.stellarSignCalls += 1;
    const fakeEd25519Sig = Buffer.alloc(64, 7).toString('base64');
    return {
      signedEnvelopeXdr: `SIGNED:${params.unsignedEnvelopeXdr}`,
      txHash: params.txHashHex,
      signatureBase64: fakeEd25519Sig,
      activityId: `turnkey_xlm_${params.payoutId}_${this.stellarSignCalls}`,
    };
  }
}

// ============================================================================
// Programmable EVM JSON-RPC Mock
// ============================================================================

class MockL2Rpc implements EvmJsonRpcTransport {
  public readonly calls: Array<{ method: string; params: unknown[] }> = [];
  public readonly blacklistedAddresses = new Set<string>();
  public failAllReads = false;
  public revertTransferSimulation = false;
  public txCount = 0;

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    this.calls.push({ method, params });
    if (this.failAllReads) {
      throw new Error('503 Service Unavailable: Primary RPC down');
    }

    if (method === 'eth_call') {
      const txObj = (params[0] ?? {}) as { to?: string; data?: string };
      const data = (txObj.data ?? '').toLowerCase();

      if (data.startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR)) {
        const addrHex = `0x${data.slice(-40)}`.toLowerCase();
        const isBl = this.blacklistedAddresses.has(addrHex);
        return (`0x${(isBl ? 1 : 0).toString(16).padStart(64, '0')}` as unknown) as T;
      }

      if (this.revertTransferSimulation) {
        throw new Error('execution reverted: ERC20: transfer amount exceeds balance');
      }

      return (`0x${'0'.repeat(63)}1` as unknown) as T;
    }

    if (method === 'eth_estimateGas') {
      return ('0xfde8' as unknown) as T; // 65000
    }
    if (method === 'eth_gasPrice') {
      return ('0x5f5e100' as unknown) as T; // 0.1 Gwei
    }
    if (method === 'eth_maxPriorityFeePerGas') {
      return ('0x989680' as unknown) as T; // 0.01 Gwei
    }
    if (method === 'eth_getTransactionCount') {
      return (`0x${this.txCount.toString(16)}` as unknown) as T;
    }
    if (method === 'eth_sendRawTransaction') {
      this.txCount += 1;
      const rawTx = String(params[0] ?? '') as Hex;
      return (keccak256(rawTx) as unknown) as T;
    }
    if (method === 'eth_getTransactionReceipt') {
      return ({
        status: '0x1',
        blockNumber: '0x100',
        gasUsed: '0xc350',
        effectiveGasPrice: '0x5f5e100',
      } as unknown) as T;
    }

    throw new Error(`Unhandled RPC method: ${method}`);
  }
}

// ============================================================================
// Programmable Stellar Horizon Transport Mock
// ============================================================================

class MockStellarHorizonTransport implements StellarBroadcastTransport {
  public readonly authorizedTrustlines = new Set<string>();
  public readonly operationsBuilt: string[] = [];
  private currentSeq = BigInt(5000);

  async hasUsdcTrustline(accountId: string): Promise<boolean> {
    return this.authorizedTrustlines.has(accountId);
  }

  async getAccountSequence(_accountId: string): Promise<bigint> {
    return this.currentSeq;
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
    // Only 'payment' is ever constructed — NEVER createAccount or changeTrust!
    this.operationsBuilt.push('payment');
    const txHashHex = Buffer.from(
      `${params.stellarSequence}:${params.recipientAddress}:${params.amountFormatted7}:${params.timeboundsMaxUnix}`
    )
      .toString('hex')
      .padEnd(64, '0')
      .slice(0, 64);

    return {
      unsignedEnvelopeXdr: `XDR_PAYMENT:${params.stellarSequence}:${params.amountFormatted7}:${params.timeboundsMaxUnix}`,
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
    this.currentSeq += BigInt(1);
    return { txHash: params.expectedTxHash, confirmed: true };
  }

  async lookupTransaction(_txHash: string) {
    return { found: true, successful: true, ledger: 999 };
  }
}

// ============================================================================
// Valid Test Wallet Fixtures (Non-Sanctioned)
// ============================================================================

const EVM_HOT_WALLET = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const EVM_CLEAN_RECIPIENT = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
const EVM_BLACKLISTED_RECIPIENT = '0xFFcf8FDEE72ac11b5c542428B35EEF5769C409f0';
const EVM_OFAC_TORNADO = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b';

const STELLAR_HOT_WALLET = 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR';
const STELLAR_CLEAN_RECIPIENT = 'GCATS5YOVB6ROX2WUNKGNQ2MP3GMXDMKSG2O4N5CLX3A6W4PZGZZI55U';
const STELLAR_OFAC_RECIPIENT = 'GARF4Z2QYF477XG2LFFXZN2C77X6QXXZ5N4YFXG6Q6NXWNZG6Q6NXWNZ';

// ============================================================================
// Gate G7 Test Suite
// ============================================================================

describe('Gate G7: Multi-Chain Native Circle USDC Settlement Simulation', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let enclave: SimulatedEnclaveTransport;
  let turnkeySigner: TurnkeySigner;
  let arbPrimaryRpc: MockL2Rpc;
  let arbFallbackRpc: MockL2Rpc;
  let basePrimaryRpc: MockL2Rpc;
  let arbAdapter: ArbitrumBaseUsdcAdapter;
  let baseAdapter: ArbitrumBaseUsdcAdapter;
  let stellarTransport: MockStellarHorizonTransport;
  let machine: BroadcastRecoveryMachine;

  beforeEach(() => {
    const created = createAscendancyDb();
    sqlite = created.sqlite;
    db = created.db;

    enclave = new SimulatedEnclaveTransport();
    turnkeySigner = new TurnkeySigner({
      transport: enclave,
      evmHotWalletAddress: EVM_HOT_WALLET,
      stellarHotWalletAddress: STELLAR_HOT_WALLET,
    });

    arbPrimaryRpc = new MockL2Rpc();
    arbFallbackRpc = new MockL2Rpc();
    basePrimaryRpc = new MockL2Rpc();

    arbAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode: 'mainnet',
      hotWalletAddress: EVM_HOT_WALLET,
      primaryRpc: arbPrimaryRpc,
      fallbackRpc: arbFallbackRpc,
    });

    baseAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'base',
      networkMode: 'mainnet',
      hotWalletAddress: EVM_HOT_WALLET,
      primaryRpc: basePrimaryRpc,
    });

    stellarTransport = new MockStellarHorizonTransport();
    stellarTransport.authorizedTrustlines.add(STELLAR_CLEAN_RECIPIENT);

    machine = bindTestWithdrawalLocks(
      new BroadcastRecoveryMachine({
        db,
        turnkeySigner,
        evmAdapters: {
          arbitrum: arbAdapter,
          base: baseAdapter,
        },
        stellarTransport,
        defaultUsdcPriceUsd: '1.0000',
        nowUnixProvider: () => 1_794_600_000,
      }),
      sqlite
    );
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('1. Canonical Circle Mainnet Issuers & Bridged Token Rejection', () => {
    it('enforces exact canonical Circle Mainnet addresses on Stellar, Arbitrum One, and Base', async () => {
      // Stellar Mainnet Circle USDC Issuer
      expect(CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER).toBe(
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      );
      expect(USDC_CONFIG[StellarNetwork.MAINNET].issuer).toBe(
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      );
      expect(STELLAR_OFFICIAL_USDC_ISSUER).toBe(
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      );

      const mainnetStellarService = new StellarService({ network: StellarNetwork.MAINNET });
      expect(mainnetStellarService.getUSDCAsset().issuer).toBe(
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      );

      const adminInfo = await getUSDCInfo(StellarNetwork.MAINNET);
      expect(adminInfo.issuer).toBe(
        'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
      );

      // Arbitrum One (chainId 42161) Native Circle USDC
      expect(arbAdapter.chainId).toBe(ARBITRUM_ONE_CHAIN_ID);
      expect(arbAdapter.chainId).toBe(42161);
      expect(arbAdapter.usdcContractAddress).toBe(
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
      );
      expect(CANONICAL_ARBITRUM_NATIVE_USDC).toBe(
        '0xaf88d065e77c8cC2239327C5EDb3A432268e5831'
      );

      // Base Mainnet (chainId 8453) Native Circle USDC
      expect(baseAdapter.chainId).toBe(BASE_MAINNET_CHAIN_ID);
      expect(baseAdapter.chainId).toBe(8453);
      expect(baseAdapter.usdcContractAddress).toBe(
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      );
      expect(CANONICAL_BASE_NATIVE_USDC).toBe(
        '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913'
      );
    });

    it('explicitly rejects bridged Arbitrum USDC.e and bridged Base USDbC', () => {
      expect(() =>
        new ArbitrumBaseUsdcAdapter({
          chain: 'arbitrum',
          hotWalletAddress: EVM_HOT_WALLET,
          usdcContractAddress: REJECTED_ARBITRUM_BRIDGED_USDC_E,
          primaryRpc: arbPrimaryRpc,
        })
      ).toThrow(NonCanonicalUsdcContractError);

      expect(() =>
        new ArbitrumBaseUsdcAdapter({
          chain: 'base',
          hotWalletAddress: EVM_HOT_WALLET,
          usdcContractAddress: REJECTED_BASE_BRIDGED_USDBC,
          primaryRpc: basePrimaryRpc,
        })
      ).toThrow(NonCanonicalUsdcContractError);
    });
  });

  describe('2. Exact Decimal Scaling (7 Decimals Stellar vs 6 Decimals Arbitrum/Base)', () => {
    it('scales $12.3456789 to 123456789 Stellar stroops (7d) and 12345678 EVM units (6d) via ROUND_DOWN', async () => {
      expect(STELLAR_USDC_DECIMALS).toBe(7);
      expect(EVM_USDC_DECIMALS).toBe(6);

      // Direct USD string -> chain units
      const stellarStroops = toStellarStroops('12.3456789');
      const evmUnits = toEvmUsdcUnits('12.3456789');
      expect(stellarStroops).toBe(BigInt(123456789));
      expect(fromStellarStroops(stellarStroops)).toBe('12.3456789');
      expect(evmUnits).toBe(BigInt(12345678));

      // Ledger 10^-8 minor units -> chain units
      const units1e8 = toLedgerUnits1e8('12.3456789');
      expect(units1e8).toBe(BigInt(1234567890));
      expect(ledgerUnits1e8ToStellarStroops(units1e8)).toBe(BigInt(123456789));
      expect(ledgerUnits1e8ToEvmUsdcUnits(units1e8)).toBe(BigInt(12345678));

      // End-to-end settlement records exact chain_token_units and chain_decimals in D1
      const xlmRes = await machine.executeSettlement({
        payoutId: 'po_scale_xlm',
        idempotencyKey: 'idem_scale_xlm',
        affiliateId: 'aff_1',
        chain: 'stellar',
        recipientAddress: STELLAR_CLEAN_RECIPIENT,
        amountUnits1e8: units1e8,
      });
      expect(xlmRes.state).toBe('CONFIRMED');

      const xlmRow = await machine.getSettlementRecord('po_scale_xlm');
      expect(xlmRow?.chain_decimals).toBe(7);
      expect(xlmRow?.chain_token_units).toBe('123456789');

      const arbRes = await machine.executeSettlement({
        payoutId: 'po_scale_arb',
        idempotencyKey: 'idem_scale_arb',
        affiliateId: 'aff_1',
        chain: 'arbitrum',
        recipientAddress: EVM_CLEAN_RECIPIENT,
        amountUnits1e8: units1e8,
      });
      expect(arbRes.state).toBe('CONFIRMED');

      const arbRow = await machine.getSettlementRecord('po_scale_arb');
      expect(arbRow?.chain_decimals).toBe(6);
      expect(arbRow?.chain_token_units).toBe('12345678');
    });
  });

  describe('3. $10.00 USDC Minimum Withdrawal Floor & Phase 1 Chain Gate', () => {
    it('rejects any payout below $10.00 USDC across adapters, safety guards, and state machine', async () => {
      const belowFloor = toLedgerUnits1e8('9.99');
      expect(belowFloor).toBe(BigInt(999000000));
      expect(() => assertMinimumWithdrawalFloor(belowFloor)).toThrow(
        MinimumWithdrawalFloorError
      );

      await expect(
        machine.executeSettlement({
          payoutId: 'po_under_10',
          idempotencyKey: 'idem_under_10',
          affiliateId: 'aff_low',
          chain: 'base',
          recipientAddress: EVM_CLEAN_RECIPIENT,
          amountUnits1e8: belowFloor,
        })
      ).rejects.toThrow(/minimum floor of \$10\.00 USDC/);

      expect(enclave.evmSignCalls).toBe(0);

      // Exact $10.00 floor succeeds cleanly
      const exactFloor = toLedgerUnits1e8('10.00');
      expect(exactFloor).toBe(BigInt(1000000000));
      const okRes = await machine.executeSettlement({
        payoutId: 'po_exact_10',
        idempotencyKey: 'idem_exact_10',
        affiliateId: 'aff_exact',
        chain: 'base',
        recipientAddress: EVM_CLEAN_RECIPIENT,
        amountUnits1e8: exactFloor,
      });
      expect(okRes.state).toBe('CONFIRMED');
    });

    it('blocks Ethereum L1 and Solana as DISABLED_PHASE1 without touching RPC or HSM', async () => {
      expect(checkPhase1ChainGate('ethereum')).toMatchObject({
        enabled: false,
        status: 'DISABLED_PHASE1',
      });
      expect(checkPhase1ChainGate('solana')).toMatchObject({
        enabled: false,
        status: 'DISABLED_PHASE1',
      });
      expect(checkPhase1ChainGate('arbitrum').status).toBe('ENABLED');
      expect(checkPhase1ChainGate('base').status).toBe('ENABLED');
      expect(checkPhase1ChainGate('stellar').status).toBe('ENABLED');

      expect(() => assertPhase1ChainEnabled('ethereum')).toThrow(Phase1ChainDisabledError);
      expect(() => assertPhase1ChainEnabled('solana')).toThrow(Phase1ChainDisabledError);

      await expect(
        machine.executeSettlement({
          payoutId: 'po_eth_blocked',
          idempotencyKey: 'idem_eth_blocked',
          affiliateId: 'aff_eth',
          chain: 'ethereum',
          recipientAddress: EVM_CLEAN_RECIPIENT,
          amountUnits1e8: toLedgerUnits1e8('25.00'),
        })
      ).rejects.toThrow(/DISABLED_PHASE1/);

      await expect(
        machine.executeSettlement({
          payoutId: 'po_sol_blocked',
          idempotencyKey: 'idem_sol_blocked',
          affiliateId: 'aff_sol',
          chain: 'solana',
          recipientAddress: '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T',
          amountUnits1e8: toLedgerUnits1e8('25.00'),
        })
      ).rejects.toThrow(/0\.002039 SOL/);

      expect(enclave.evmSignCalls).toBe(0);
      expect(enclave.stellarSignCalls).toBe(0);
    });
  });

  describe('4. Missing Stellar Trustline, Circle Blacklist (0xfe575a87), OFAC & RPC Failover', () => {
    it('rejects Stellar recipients lacking an existing authorized USDC trustline without sponsoring reserves', async () => {
      const untrustedWallet = 'GDWUSKGGFDI4FRXK5EBTRECZSVQSSWJHHJOGH6JWG3AUMFFMQ435DIAG';
      // Not added to stellarTransport.authorizedTrustlines

      await expect(
        machine.executeSettlement({
          payoutId: 'po_no_trustline',
          idempotencyKey: 'idem_no_trustline',
          affiliateId: 'aff_untrusted',
          chain: 'stellar',
          recipientAddress: untrustedWallet,
          amountUnits1e8: toLedgerUnits1e8('20.00'),
        })
      ).rejects.toThrow(/authorized Circle USDC trustline/);

      expect(enclave.stellarSignCalls).toBe(0);
      expect(stellarTransport.operationsBuilt).toHaveLength(0);

      // Also verify StellarAdapter.hasUsdcTrustline returns false and sendPayout fails closed immediately
      const mockService = {
        hasUsdcTrustline: jest.fn(async () => false),
        sendPayout: jest.fn(),
      } as unknown as StellarService;
      const adapter = new StellarAdapter({ stellarService: mockService });
      expect(await adapter.hasUsdcTrustline(untrustedWallet)).toBe(false);
      const adapterResult = await adapter.sendPayout({
        payoutId: 'po_adapter_untrusted',
        affiliateId: 'aff_untrusted',
        recipientAddress: untrustedWallet,
        amount: 20,
        idempotencyKey: 'idem_adapter_untrusted',
      });
      expect(adapterResult.success).toBe(false);
      expect(adapterResult.error).toContain('LEGACY_PAYOUT_PATH_DISABLED');
      expect((mockService.sendPayout as jest.Mock).mock.calls).toHaveLength(0);
    });

    it('encodes 0xfe575a87 selector, blocks Circle-blacklisted & OFAC addresses, and fails over to fallback RPC', async () => {
      const calldata = encodeIsBlacklistedCalldata(EVM_BLACKLISTED_RECIPIENT);
      expect(calldata.startsWith('0xfe575a87')).toBe(true);

      // Flag recipient on Circle blacklist
      arbPrimaryRpc.blacklistedAddresses.add(EVM_BLACKLISTED_RECIPIENT.toLowerCase());

      await expect(
        machine.executeSettlement({
          payoutId: 'po_circle_bl',
          idempotencyKey: 'idem_circle_bl',
          affiliateId: 'aff_bl',
          chain: 'arbitrum',
          recipientAddress: EVM_BLACKLISTED_RECIPIENT,
          amountUnits1e8: toLedgerUnits1e8('50.00'),
        })
      ).rejects.toThrow(/CIRCLE_USDC_BLACKLISTED/);
      expect(enclave.evmSignCalls).toBe(0);

      // OFAC SDN Tornado Cash address blocked on Arbitrum & Stellar OFAC blocked on Stellar
      await expect(
        machine.executeSettlement({
          payoutId: 'po_ofac_arb',
          idempotencyKey: 'idem_ofac_arb',
          affiliateId: 'aff_ofac',
          chain: 'arbitrum',
          recipientAddress: EVM_OFAC_TORNADO,
          amountUnits1e8: toLedgerUnits1e8('50.00'),
        })
      ).rejects.toThrow(/sanctions block/i);

      await expect(
        machine.executeSettlement({
          payoutId: 'po_ofac_xlm',
          idempotencyKey: 'idem_ofac_xlm',
          affiliateId: 'aff_ofac_xlm',
          chain: 'stellar',
          recipientAddress: STELLAR_OFAC_RECIPIENT,
          amountUnits1e8: toLedgerUnits1e8('50.00'),
        })
      ).rejects.toThrow(/sanctions block/i);
      expect(enclave.evmSignCalls).toBe(0);
      expect(enclave.stellarSignCalls).toBe(0);

      // Primary RPC read failure seamlessly fails over to fallback RPC for simulation
      arbPrimaryRpc.failAllReads = true;
      const simRes = await arbAdapter.simulateTransferBeforeSigning({
        recipientAddress: EVM_CLEAN_RECIPIENT,
        amountUnits6: toEvmUsdcUnits('25.00'),
      });
      expect(simRes.ok).toBe(true);
      expect(arbFallbackRpc.calls.length).toBeGreaterThan(0);
    });
  });

  describe('5. Turnkey HSM Isolation, $250/tx & $1,500/24h Caps, and Safe 2-of-3 Cold Reserve', () => {
    it('guarantees zero raw private keys in memory and enforces >= 80% Safe 2-of-3 cold reserve invariant', () => {
      expect(turnkeySigner.hasRawPrivateKeyInMemory()).toBe(false);
      expect(HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8).toBe(BigInt('25000000000'));
      expect(HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8).toBe(BigInt('150000000000'));

      // Reject accidental raw secret injection
      expect(
        () =>
          new TurnkeySigner({
            transport: enclave,
            evmHotWalletAddress: `0x${'a'.repeat(64)}`,
            stellarHotWalletAddress: STELLAR_HOT_WALLET,
          })
      ).toThrow(/Security violation/);

      expect(
        () =>
          new TurnkeySigner({
            transport: enclave,
            evmHotWalletAddress: EVM_HOT_WALLET,
            stellarHotWalletAddress: `S${'A'.repeat(55)}`,
          })
      ).toThrow(/Security violation/);

      // Reserve distribution: 85% Cold Safe ($8,500) / 15% Hot Turnkey ($1,500) -> compliant
      const okDist = verifyTreasuryReserveDistribution({
        hotWalletUnits1e8: toLedgerUnits1e8('1500.00'),
        coldSafeUnits1e8: toLedgerUnits1e8('8500.00'),
      });
      expect(okDist.compliant).toBe(true);
      expect(okDist.multisigPolicy).toBe('2-of-3');
      expect(okDist.coldShareBps).toBe(8500);

      // Reserve distribution: 75% Cold Safe ($7,500) / 25% Hot Turnkey ($2,500) -> non-compliant
      const badDist = verifyTreasuryReserveDistribution({
        hotWalletUnits1e8: toLedgerUnits1e8('2500.00'),
        coldSafeUnits1e8: toLedgerUnits1e8('7500.00'),
      });
      expect(badDist.compliant).toBe(false);
      expect(badDist.reason).toContain('below required 80.00% floor');
    });

    it('routes single payouts > $250.00 and cumulative 24h payouts > $1,500.00 to QUEUED_COLD_SAFE with zero hot signatures', async () => {
      // Single payout $250.01 -> QUEUED_COLD_SAFE
      const singleOver = await machine.executeSettlement({
        payoutId: 'po_over_250',
        idempotencyKey: 'idem_over_250',
        affiliateId: 'aff_whale',
        chain: 'arbitrum',
        recipientAddress: EVM_CLEAN_RECIPIENT,
        amountUnits1e8: toLedgerUnits1e8('250.01'),
      });
      expect(singleOver.state).toBe('QUEUED_COLD_SAFE');
      expect(singleOver.safeMultisigTxHash).toMatch(/^safe_2of3_/);
      expect(enclave.evmSignCalls).toBe(0);

      // Six exact $250.00 payouts = $1,500.00 hot-signed cleanly
      for (let i = 1; i <= 6; i++) {
        const res = await machine.executeSettlement({
          payoutId: `po_cap_${i}`,
          idempotencyKey: `idem_cap_${i}`,
          affiliateId: `aff_${i}`,
          chain: i % 2 === 0 ? 'base' : 'arbitrum',
          recipientAddress: EVM_CLEAN_RECIPIENT,
          amountUnits1e8: toLedgerUnits1e8('250.00'),
        });
        expect(res.state).toBe('CONFIRMED');
      }
      expect(enclave.evmSignCalls).toBe(6);

      // 7th payout of $10.00 pushes 24h hot volume to $1,510.00 (> $1,500.00) -> QUEUED_COLD_SAFE!
      const overflow7th = await machine.executeSettlement({
        payoutId: 'po_cap_overflow_7',
        idempotencyKey: 'idem_cap_overflow_7',
        affiliateId: 'aff_7',
        chain: 'arbitrum',
        recipientAddress: EVM_CLEAN_RECIPIENT,
        amountUnits1e8: toLedgerUnits1e8('10.00'),
      });
      expect(overflow7th.state).toBe('QUEUED_COLD_SAFE');
      expect(overflow7th.safeMultisigTxHash).toMatch(/^safe_2of3_/);
      // Enclave sign count remained strictly 6!
      expect(enclave.evmSignCalls).toBe(6);
    });
  });

  describe('6. USDC Peg Circuit Breaker [$0.985, $1.015] & D1 EMERGENCY_PAUSE', () => {
    it('flips EMERGENCY_PAUSE = true in system_runtime_flags on $0.980 depeg and halts all subsequent settlements', async () => {
      expect(evaluateUsdcPegBand('0.985').withinBand).toBe(true);
      expect(evaluateUsdcPegBand('1.015').withinBand).toBe(true);
      expect(evaluateUsdcPegBand('0.980').withinBand).toBe(false);
      expect(evaluateUsdcPegBand('1.020').withinBand).toBe(false);

      // Simulate depeg at $0.980 during settlement attempt
      let caughtError: unknown;
      try {
        await assertPreSigningSafetyGuards({
          db,
          chain: 'arbitrum',
          recipientAddress: EVM_CLEAN_RECIPIENT,
          amountUnits1e8: toLedgerUnits1e8('50.00'),
          usdcReferencePriceUsd: '0.980',
          evmAdapters: { arbitrum: arbAdapter },
        });
      } catch (err) {
        caughtError = err;
      }

      expect(caughtError).toBeInstanceOf(UsdcSafetyGuardError);
      expect((caughtError as UsdcSafetyGuardError).code).toBe('USDC_DEPEG_CIRCUIT_BREAKER');

      // Verify D1 `system_runtime_flags` has EMERGENCY_PAUSE = 'true'
      const pauseStatus = await isEmergencySettlementPaused(db);
      expect(pauseStatus.paused).toBe(true);
      expect(pauseStatus.flagKey).toBe('EMERGENCY_PAUSE');

      const flagRow = sqlite
        .prepare("SELECT flag_value, reason FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'")
        .get() as { flag_value: string; reason: string };
      expect(flagRow.flag_value).toBe('true');
      expect(flagRow.reason).toContain('0.980000');

      // Even if oracle recovers to $1.0000, EMERGENCY_PAUSE stays latched until admin clears it
      await expect(
        machine.executeSettlement({
          payoutId: 'po_after_depeg',
          idempotencyKey: 'idem_after_depeg',
          affiliateId: 'aff_paused',
          chain: 'arbitrum',
          recipientAddress: EVM_CLEAN_RECIPIENT,
          amountUnits1e8: toLedgerUnits1e8('20.00'),
          usdcReferencePriceUsd: '1.0000',
        })
      ).rejects.toThrow(/EMERGENCY_PAUSE|mandatory emergency controls missing, invalid, or active/);

      const breakerCheck = await enforceUsdcPegCircuitBreaker(db, '0.97');
      expect(breakerCheck.allowed).toBe(false);
      expect(breakerCheck.emergencyPaused).toBe(true);
      expect(enclave.evmSignCalls).toBe(0);
    });
  });
});
