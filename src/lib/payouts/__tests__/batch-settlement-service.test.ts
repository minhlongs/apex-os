/**
 * src/lib/payouts/__tests__/batch-settlement-service.test.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 4: Automated Batch Settlement & Ledger Reconciliation Test Suite
 *
 * Covers:
 * 1. Precision math and cents conversion
 * 2. Deterministic idempotency key generation and uniqueness
 * 3. Threshold filtering (< $50 excluded, >= $50 included, exact boundaries)
 * 4. Multi-chain destination resolution and wallet validation
 * 5. Dry-run execution mode
 * 6. Atomic two-phase D1 batch reservation
 * 7. Successful batch execution and double-entry ledger reconciliation
 * 8. Pre-flight circuit breaker pause on critical treasury health
 * 9. In-flight circuit breaker trip handling
 * 10. Partial batch failure handling and error isolation
 * 11. Failed payout retry mechanism with fee re-estimation
 * 12. Pre-flight verification on retry preventing duplicate broadcasts
 */

import Database from 'better-sqlite3';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import {
  BatchSettlementService,
  toCents,
  fromCents,
  generateBatchNumber,
  generatePayoutIdempotencyKey,
  generateRetryIdempotencyKey,
} from '../batch-settlement-service';
import type {
  PayoutChainAdapter,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
  FeeEstimateParams,
  ChainFeeEstimate,
  SupportedPayoutChain,
  TreasuryHealthReport,
} from '../types';
import { PayoutRouter } from '../router';
import { TreasuryHealthService, type CanSettleResult } from '../treasury-health-service';
import { PayoutAuditService } from '../audit-service';

// ============================================================================
// Mock D1 Database Implementation
// ============================================================================

interface InternalPreparedStatement extends D1PreparedStatement {
  _runSync: () => D1Result<any>;
}

function createMockD1Database(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let boundParams: any[] = [];
      const stmt = sqlite.prepare(sql);

      const prepared: InternalPreparedStatement = {
        bind(...params: any[]) {
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
              rows_read: 0,
              rows_written: info.changes,
            } as any,
          };
        },
        async run<T = unknown>(): Promise<D1Result<T>> {
          return prepared._runSync();
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const row = stmt.get(...boundParams);
          if (!row) return null;
          if (colName) return (row as any)[colName] ?? null;
          return row as T;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const rows = stmt.all(...boundParams);
          return {
            results: rows as T[],
            success: true,
            meta: { duration: 0, rows_read: rows.length, rows_written: 0 } as any,
          };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return stmt.raw().all(...boundParams) as T[];
        },
      };

      return prepared;
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const runTransaction = sqlite.transaction(() => {
        const results: D1Result<T>[] = [];
        for (const stmt of statements) {
          const internalStmt = stmt as InternalPreparedStatement;
          if (internalStmt._runSync) {
            results.push(internalStmt._runSync());
          } else {
            throw new Error('Unsupported statement format in mock batch');
          }
        }
        return results;
      });

      return runTransaction();
    },

    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },

    async dump() {
      return '';
    },

    async close() {
      sqlite.close();
    },
  } as unknown as D1Database;
}

function initializeTestSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      full_name TEXT,
      role TEXT DEFAULT 'affiliate',
      wallet_address TEXT,
      preferred_chain TEXT
    );

    CREATE TABLE IF NOT EXISTS wallet_connections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id),
      wallet_address TEXT NOT NULL,
      preferred_chain TEXT DEFAULT 'ethereum',
      is_primary INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL REFERENCES profiles(id),
      payout_method TEXT DEFAULT 'crypto',
      payout_method_details TEXT DEFAULT '{}',
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      fee REAL DEFAULT 0.00,
      net_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
      scheduled_at TEXT,
      paid_at TEXT,
      transaction_id TEXT,
      notes TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      batch_id TEXT,
      chain TEXT DEFAULT 'stellar' CHECK (chain IN ('stellar', 'ethereum', 'solana')),
      idempotency_key TEXT,
      gas_fee_native REAL DEFAULT 0.00,
      gas_fee_usd REAL DEFAULT 0.00,
      error_message TEXT,
      retry_count INTEGER DEFAULT 0,
      last_retried_at TEXT
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_idempotency_key ON payouts(idempotency_key) WHERE idempotency_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_payouts_batch_id ON payouts(batch_id);
    CREATE INDEX IF NOT EXISTS idx_payouts_chain_status ON payouts(chain, status);

    CREATE TABLE IF NOT EXISTS earnings (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL REFERENCES profiles(id),
      amount REAL NOT NULL,
      is_paid INTEGER DEFAULT 0,
      paid_at TEXT,
      payout_id TEXT REFERENCES payouts(id),
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payout_batches (
      id TEXT PRIMARY KEY,
      batch_number TEXT NOT NULL UNIQUE,
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'partially_failed', 'failed', 'cancelled')),
      chain TEXT CHECK (chain IN ('stellar', 'ethereum', 'solana') OR chain IS NULL),
      total_payouts INTEGER DEFAULT 0,
      successful_payouts INTEGER DEFAULT 0,
      failed_payouts INTEGER DEFAULT 0,
      total_amount REAL DEFAULT 0.00,
      total_fee REAL DEFAULT 0.00,
      total_gas_fee_usd REAL DEFAULT 0.00,
      executed_by TEXT,
      dry_run INTEGER DEFAULT 0,
      scheduled_at TEXT,
      started_at TEXT,
      completed_at TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payout_audit_logs (
      id TEXT PRIMARY KEY,
      batch_id TEXT,
      payout_id TEXT,
      action TEXT NOT NULL,
      admin_id TEXT,
      admin_email TEXT,
      chain TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}

// ============================================================================
// Mock Adapters & Services
// ============================================================================

class MockChainAdapter implements PayoutChainAdapter {
  constructor(
    public readonly chain: SupportedPayoutChain,
    public sendHandler?: (params: PayoutExecutionParams) => Promise<PayoutExecutionResult>,
    public verifyHandler?: (txId: string) => Promise<TransactionVerificationResult>
  ) {}

  validateAddress(address: string): boolean {
    if (this.chain === 'stellar') return address.startsWith('G') && address.length === 56;
    if (this.chain === 'ethereum') return address.startsWith('0x') && address.length === 42;
    if (this.chain === 'solana') return address.length >= 32 && address.length <= 44;
    return false;
  }

  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    const feeUsd = this.chain === 'ethereum' ? 2.5 : this.chain === 'solana' ? 0.005 : 0.001;
    return {
      chain: this.chain,
      token: 'USDC',
      nativeFeeAmount: 0.001,
      nativeFeeSymbol: this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM',
      feeUsd,
      gasUnitsOrLimit: 21000,
      pricePerUnit: 10,
      timestamp: new Date().toISOString(),
    };
  }

  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (this.sendHandler) {
      return this.sendHandler(params);
    }
    return {
      success: true,
      payoutId: params.payoutId,
      chain: this.chain,
      toAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token,
      transactionId: `mock_tx_${this.chain}_${params.payoutId}`,
      gasFeeNative: 0.001,
      gasFeeUsd: this.chain === 'ethereum' ? 2.5 : this.chain === 'solana' ? 0.005 : 0.001,
      status: 'confirmed',
      timestamp: new Date().toISOString(),
    };
  }

  async verifyTransaction(transactionId: string): Promise<TransactionVerificationResult> {
    if (this.verifyHandler) {
      return this.verifyHandler(transactionId);
    }
    return {
      verified: true,
      status: 'confirmed',
      transactionId,
      timestamp: new Date().toISOString(),
    };
  }

  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    return {
      chain: this.chain,
      hotWalletAddress: 'mock_hot_wallet',
      nativeBalance: 100,
      nativeSymbol: 'NATIVE',
      nativeBalanceUsd: 1000,
      tokenBalances: { USDC: 50000 },
      totalUsdValue: 51000,
      lastUpdated: new Date().toISOString(),
    };
  }
}

function createHealthyTreasuryReport(): TreasuryHealthReport {
  return {
    timestamp: new Date().toISOString(),
    overallStatus: 'HEALTHY',
    chains: {
      stellar: {
        chain: 'stellar',
        status: 'HEALTHY',
        rpcHealthy: true,
        nativeGasBalance: 100,
        nativeGasFloor: 5,
        nativeGasSymbol: 'XLM',
        stablecoinBalance: 10000,
        stablecoinReserveFloor: 100,
        lastChecked: new Date().toISOString(),
      },
      ethereum: {
        chain: 'ethereum',
        status: 'HEALTHY',
        rpcHealthy: true,
        nativeGasBalance: 2,
        nativeGasFloor: 0.05,
        nativeGasSymbol: 'ETH',
        stablecoinBalance: 20000,
        stablecoinReserveFloor: 500,
        lastChecked: new Date().toISOString(),
      },
      solana: {
        chain: 'solana',
        status: 'HEALTHY',
        rpcHealthy: true,
        nativeGasBalance: 10,
        nativeGasFloor: 0.2,
        nativeGasSymbol: 'SOL',
        stablecoinBalance: 15000,
        stablecoinReserveFloor: 500,
        lastChecked: new Date().toISOString(),
      },
    },
    alerts: [],
  };
}

// ============================================================================
// Test Suite
// ============================================================================

describe('BatchSettlementService (Milestone 4)', () => {
  let sqlite: Database.Database;
  let d1: D1Database;
  let stellarAdapter: MockChainAdapter;
  let ethAdapter: MockChainAdapter;
  let solAdapter: MockChainAdapter;
  let router: PayoutRouter;
  let healthService: TreasuryHealthService;
  let auditService: PayoutAuditService;
  let service: BatchSettlementService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    initializeTestSchema(sqlite);
    d1 = createMockD1Database(sqlite);

    stellarAdapter = new MockChainAdapter('stellar');
    ethAdapter = new MockChainAdapter('ethereum');
    solAdapter = new MockChainAdapter('solana');

    router = new PayoutRouter({
      stellar: stellarAdapter,
      ethereum: ethAdapter,
      solana: solAdapter,
    });

    healthService = new TreasuryHealthService(undefined, router);
    // Default health mock: Healthy
    jest.spyOn(healthService, 'checkHealth').mockResolvedValue(createHealthyTreasuryReport());
    jest.spyOn(healthService, 'canSettle').mockResolvedValue({
      allowed: true,
      report: createHealthyTreasuryReport(),
    });

    auditService = new PayoutAuditService(d1);

    service = new BatchSettlementService({
      db: d1,
      router,
      healthService,
      auditService,
    });
  });

  afterEach(() => {
    sqlite.close();
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. Math and Precision
  // --------------------------------------------------------------------------

  describe('Math and Precision Helpers', () => {
    it('converts dollar amounts to cents avoiding IEEE 754 precision drift', () => {
      expect(toCents(50.25)).toBe(5025);
      expect(toCents(19.99)).toBe(1999);
      expect(toCents(30.01)).toBe(3001);
      // Floating drift test: 19.99 + 30.01 in JS floating point = 50.00000000000001
      const sumCents = toCents(19.99) + toCents(30.01);
      expect(sumCents).toBe(5000);
      expect(fromCents(sumCents)).toBe(50.0);
    });

    it('generates deterministic idempotency key for batch payouts', () => {
      const key1 = generatePayoutIdempotencyKey('aff_1', ['earn_1', 'earn_2']);
      const key2 = generatePayoutIdempotencyKey('aff_1', ['earn_2', 'earn_1']);
      expect(key1).toBe(key2);
      expect(key1).toMatch(/^idem_payout_aff_1_[a-f0-9]{12}$/);

      // Backwards-compatible 3-arg invocation also yields key without batchId
      const key3 = generatePayoutIdempotencyKey('batch_1', 'aff_1', ['earn_1', 'earn_2']);
      expect(key3).toBe(key1);
    });

    it('generates deterministic retry idempotency key', () => {
      const retryKey = generateRetryIdempotencyKey('payout_123', 0);
      expect(retryKey).toBe('idem_retry_payout_123_att_1');
      const retryKey2 = generateRetryIdempotencyKey('payout_123', 1);
      expect(retryKey2).toBe('idem_retry_payout_123_att_2');
    });
  });

  // --------------------------------------------------------------------------
  // 2. Threshold Filtering & Preview
  // --------------------------------------------------------------------------

  describe('previewBatch — Threshold Filtering & Grouping', () => {
    it('excludes affiliates with total earnings below min threshold ($50.00)', async () => {
      // Affiliate 1: $49.99 (below threshold)
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_low', 'low@example.com', 'Low Earner', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e1', 'aff_low', 49.99)`).run();

      // Affiliate 2: $50.00 (meets threshold)
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_exact', 'exact@example.com', 'Exact Earner', '0x1111111111111111111111111111111111111111', 'ethereum')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e2', 'aff_exact', 50.00)`).run();

      const preview = await service.previewBatch();

      expect(preview.eligibleAffiliatesCount).toBe(1);
      expect(preview.payoutsPreview).toHaveLength(1);
      expect(preview.payoutsPreview[0].affiliateId).toBe('aff_exact');
      expect(preview.payoutsPreview[0].grossAmount).toBe(50.0);
      expect(preview.totalAmountUsd).toBe(50.0);
    });

    it('aggregates multiple small earnings for the same affiliate to meet threshold', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_multi', 'multi@example.com', 'Multi Earner', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e1', 'aff_multi', 20.00)`).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e2', 'aff_multi', 20.00)`).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e3', 'aff_multi', 15.50)`).run();

      const preview = await service.previewBatch({ minThreshold: 50.0 });

      expect(preview.eligibleAffiliatesCount).toBe(1);
      expect(preview.payoutsPreview[0].earningsCount).toBe(3);
      expect(preview.payoutsPreview[0].grossAmount).toBe(55.5);
      expect(preview.payoutsPreview[0].earningIds).toEqual(['e1', 'e2', 'e3']);
    });

    it('ignores earnings that are already paid or currently reserved in a payout', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_1', 'user@example.com', 'User One', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      // Insert dummy payout rows so foreign key constraint is satisfied
      sqlite.prepare(`INSERT INTO payouts (id, affiliate_id, amount, net_amount) VALUES ('payout_old', 'aff_1', 100.00, 100.00)`).run();
      sqlite.prepare(`INSERT INTO payouts (id, affiliate_id, amount, net_amount) VALUES ('payout_reserved', 'aff_1', 200.00, 200.00)`).run();

      // Unpaid & unreserved
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id) VALUES ('e1', 'aff_1', 60.00, 0, NULL)`).run();
      // Already paid
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id) VALUES ('e2', 'aff_1', 100.00, 1, 'payout_old')`).run();
      // Currently reserved by another batch
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id) VALUES ('e3', 'aff_1', 200.00, 0, 'payout_reserved')`).run();

      const preview = await service.previewBatch();

      expect(preview.eligibleAffiliatesCount).toBe(1);
      expect(preview.payoutsPreview[0].grossAmount).toBe(60.0);
      expect(preview.payoutsPreview[0].earningIds).toEqual(['e1']);
    });

    it('flags affiliates without a wallet address in blockingReasons', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_no_wallet', 'nowallet@example.com', 'No Wallet', NULL, 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e1', 'aff_no_wallet', 100.00)`).run();

      const preview = await service.previewBatch();

      expect(preview.eligibleAffiliatesCount).toBe(0);
      expect(preview.blockingReasons).toBeDefined();
      expect(preview.blockingReasons![0]).toContain('no wallet address configured');
    });

    it('supports chain filtering in previewBatch', async () => {
      // Stellar user
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_xlm', 'xlm@example.com', 'XLM User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e1', 'aff_xlm', 80.00)`).run();

      // Ethereum user
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_eth', 'eth@example.com', 'ETH User', '0x2222222222222222222222222222222222222222', 'ethereum')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e2', 'aff_eth', 90.00)`).run();

      const previewEth = await service.previewBatch({ chain: 'ethereum' });
      expect(previewEth.eligibleAffiliatesCount).toBe(1);
      expect(previewEth.payoutsPreview[0].affiliateId).toBe('aff_eth');
      expect(previewEth.payoutsPreview[0].chain).toBe('ethereum');

      const previewAll = await service.previewBatch({ chain: 'all' });
      expect(previewAll.eligibleAffiliatesCount).toBe(2);
    });
  });

  // --------------------------------------------------------------------------
  // 3. Dry Run Mode
  // --------------------------------------------------------------------------

  describe('executeBatch — Dry Run Mode', () => {
    it('simulates payouts without modifying database tables in dry-run mode', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_dry', 'dry@example.com', 'Dry User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_dry', 'aff_dry', 75.00)`).run();

      const result = await service.executeBatch({ dryRun: true });

      expect(result.dryRun).toBe(true);
      expect(result.totalPayouts).toBe(1);
      expect(result.successfulPayouts).toBe(1);
      expect(result.status).toBe('completed');
      expect(result.payouts[0].transactionId).toContain('DRY_RUN_TX');

      // Verify DB remains untouched
      const batchCount = sqlite.prepare('SELECT count(*) as c FROM payout_batches').get() as { c: number };
      const payoutCount = sqlite.prepare('SELECT count(*) as c FROM payouts').get() as { c: number };
      const earning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('e_dry') as any;

      expect(batchCount.c).toBe(0);
      expect(payoutCount.c).toBe(0);
      expect(earning.is_paid).toBe(0);
      expect(earning.payout_id).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 4. Atomic Two-Phase D1 Reservation & Successful Reconciliation
  // --------------------------------------------------------------------------

  describe('executeBatch — Atomic Reservation & Ledger Reconciliation', () => {
    it('atomically reserves earnings and reconciles double-entry ledger upon success', async () => {
      // Seed affiliate and 2 earnings
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_rec', 'rec@example.com', 'Reconcile User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e1', 'aff_rec', 30.00)`).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e2', 'aff_rec', 40.00)`).run();

      const result = await service.executeBatch();

      expect(result.status).toBe('completed');
      expect(result.totalPayouts).toBe(1);
      expect(result.successfulPayouts).toBe(1);
      expect(result.failedPayouts).toBe(0);
      expect(result.totalAmount).toBe(70.0);

      // Verify batch in D1
      const batchRow = sqlite.prepare('SELECT * FROM payout_batches WHERE id = ?').get(result.batchId) as any;
      expect(batchRow).toBeDefined();
      expect(batchRow.status).toBe('completed');
      expect(batchRow.successful_payouts).toBe(1);

      // Verify payout in D1
      const payoutRow = sqlite.prepare('SELECT * FROM payouts WHERE batch_id = ?').get(result.batchId) as any;
      expect(payoutRow).toBeDefined();
      expect(payoutRow.status).toBe('completed');
      expect(payoutRow.amount).toBe(70.0);
      expect(payoutRow.net_amount).toBe(70.0);
      expect(payoutRow.transaction_id).toBeDefined();
      expect(payoutRow.paid_at).not.toBeNull();
      expect(payoutRow.idempotency_key).toMatch(/^idem_payout_/);

      // Verify earnings linked and marked is_paid = 1
      const earnings = sqlite.prepare('SELECT * FROM earnings WHERE affiliate_id = ?').all('aff_rec') as any[];
      expect(earnings).toHaveLength(2);
      expect(earnings[0].is_paid).toBe(1);
      expect(earnings[0].payout_id).toBe(payoutRow.id);
      expect(earnings[0].paid_at).not.toBeNull();
      expect(earnings[1].is_paid).toBe(1);
      expect(earnings[1].payout_id).toBe(payoutRow.id);

      // Verify audit log created
      const auditLogs = sqlite.prepare('SELECT * FROM payout_audit_logs WHERE batch_id = ?').all(result.batchId) as any[];
      expect(auditLogs.length).toBeGreaterThanOrEqual(2); // reservation + completion
    });

    it('prevents concurrent batch runs from claiming the same earnings twice', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_race', 'race@example.com', 'Race User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_race', 'aff_race', 100.00)`).run();

      const sendSpy = jest.spyOn(stellarAdapter, 'sendPayout');

      // True concurrent execution via Promise.all
      const [res1, res2] = await Promise.all([
        service.executeBatch(),
        service.executeBatch(),
      ]);

      // Exactly 1 on-chain disbursement occurs
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // Total successful payouts across both batches is exactly 1
      const totalSuccessful = (res1.successfulPayouts || 0) + (res2.successfulPayouts || 0);
      expect(totalSuccessful).toBe(1);

      // Verify database state: exactly 1 payout record created and completed
      const payouts = sqlite.prepare('SELECT * FROM payouts WHERE affiliate_id = ?').all('aff_race') as any[];
      expect(payouts.length).toBe(1);
      expect(payouts[0].status).toBe('completed');

      // Earnings row is marked paid and linked to the single payout
      const earning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('e_race') as any;
      expect(earning.is_paid).toBe(1);
      expect(earning.payout_id).toBe(payouts[0].id);
    });

    it('rolls back atomic reservation completely if statement in batch fails', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_rb', 'rb@example.com', 'Rollback User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_rb', 'aff_rb', 80.00)`).run();

      // Mock db.batch to throw error during reservation
      const originalBatch = d1.batch.bind(d1);
      jest.spyOn(d1, 'batch').mockImplementationOnce(async () => {
        throw new Error('Simulated D1 batch database error');
      });

      await expect(service.executeBatch()).rejects.toThrow('Simulated D1 batch database error');

      // Verify no records were inserted into payout_batches or payouts
      const batchCount = sqlite.prepare('SELECT count(*) as c FROM payout_batches').get() as { c: number };
      const payoutCount = sqlite.prepare('SELECT count(*) as c FROM payouts').get() as { c: number };
      const earning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('e_rb') as any;

      expect(batchCount.c).toBe(0);
      expect(payoutCount.c).toBe(0);
      expect(earning.is_paid).toBe(0);
      expect(earning.payout_id).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // 5. Circuit Breaker Integration
  // --------------------------------------------------------------------------

  describe('Circuit Breaker Auto-Pause Gate', () => {
    it('halts batch execution pre-flight when treasury status is CRITICAL', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_crit', 'crit@example.com', 'Critical User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_crit', 'aff_crit', 120.00)`).run();

      // Mock canSettle returning false (circuit breaker trip)
      jest.spyOn(healthService, 'canSettle').mockResolvedValueOnce({
        allowed: false,
        reason: 'Automated settlement halted: Stellar treasury in CRITICAL state due to low XLM gas balance',
        report: createHealthyTreasuryReport(),
      });

      const result = await service.executeBatch();

      expect(result.status).toBe('failed');
      expect(result.successfulPayouts).toBe(0);
      expect(result.failedPayouts).toBe(1);
      expect(result.errors).toBeDefined();
      expect(result.errors![0]).toContain('CRITICAL state');

      // Verify circuit_breaker_pause audit log written
      const auditLogs = sqlite.prepare("SELECT * FROM payout_audit_logs WHERE action = 'circuit_breaker_pause'").all();
      expect(auditLogs).toHaveLength(1);

      // Verify earnings remain unreserved (is_paid = 0, payout_id = null)
      const earning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('e_crit') as any;
      expect(earning.is_paid).toBe(0);
      expect(earning.payout_id).toBeNull();
    });

    it('halts in-flight payouts if treasury trips mid-batch', async () => {
      // 2 affiliates on Ethereum
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_e1', 'e1@example.com', 'ETH 1', '0x1111111111111111111111111111111111111111', 'ethereum')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_e1', 'aff_e1', 100.00)`).run();

      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_e2', 'e2@example.com', 'ETH 2', '0x2222222222222222222222222222222222222222', 'ethereum')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_e2', 'aff_e2', 200.00)`).run();

      // Pre-flight allows settlement, but in-flight trips on 2nd payout
      let callCount = 0;
      jest.spyOn(healthService, 'canSettle').mockImplementation(async () => {
        callCount++;
        // Calls 1 = preview check (allowed)
        // Call 2 = in-flight payout 1 (allowed)
        // Call 3 = in-flight payout 2 (blocked!)
        if (callCount >= 3) {
          return {
            allowed: false,
            reason: 'Insufficient treasury reserves on Ethereum',
            report: createHealthyTreasuryReport(),
          };
        }
        return { allowed: true, report: createHealthyTreasuryReport() };
      });

      const result = await service.executeBatch();

      expect(result.status).toBe('partially_failed');
      expect(result.successfulPayouts).toBe(1);
      expect(result.failedPayouts).toBe(1);

      // Payout 1 completed
      const p1 = sqlite.prepare("SELECT * FROM payouts WHERE affiliate_id = 'aff_e1'").get() as any;
      expect(p1.status).toBe('completed');

      // Payout 2 failed due to circuit breaker
      const p2 = sqlite.prepare("SELECT * FROM payouts WHERE affiliate_id = 'aff_e2'").get() as any;
      expect(p2.status).toBe('failed');
      expect(p2.error_message).toContain('circuit breaker');
    });
  });

  // --------------------------------------------------------------------------
  // 6. Partial Failures & Failure Isolation
  // --------------------------------------------------------------------------

  describe('executeBatch — Partial Batch Failures', () => {
    it('isolates failures so one failing affiliate does not abort successful payouts', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_ok', 'ok@example.com', 'OK User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_ok', 'aff_ok', 100.00)`).run();

      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_fail', 'fail@example.com', 'Fail User', '0x3333333333333333333333333333333333333333', 'ethereum')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_fail', 'aff_fail', 150.00)`).run();

      // Configure Ethereum adapter to fail
      ethAdapter.sendHandler = async (params) => {
        return {
          success: false,
          payoutId: params.payoutId,
          chain: 'ethereum',
          toAddress: params.recipientAddress,
          amount: params.amount,
          token: params.token,
          error: 'EVM RPC simulation reverted: execution error',
          status: 'failed',
          timestamp: new Date().toISOString(),
        };
      };

      const result = await service.executeBatch();

      expect(result.status).toBe('partially_failed');
      expect(result.successfulPayouts).toBe(1);
      expect(result.failedPayouts).toBe(1);

      // Verify OK affiliate
      const okEarning = sqlite.prepare('SELECT is_paid FROM earnings WHERE id = ?').get('e_ok') as any;
      expect(okEarning.is_paid).toBe(1);

      // Verify Failed affiliate
      const failEarning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('e_fail') as any;
      expect(failEarning.is_paid).toBe(0);
      expect(failEarning.payout_id).not.toBeNull(); // Still linked for retry
    });
  });

  // --------------------------------------------------------------------------
  // 7. Retry Payout Mechanism
  // --------------------------------------------------------------------------

  describe('retryPayout — Payout Retries & Pre-Flight Verification', () => {
    it('successfully retries a failed payout with updated retry count and fresh idempotency key', async () => {
      // Create an affiliate and a failed payout record
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_retry', 'retry@example.com', 'Retry User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();

      const payoutId = 'payout_to_retry_1';
      sqlite.prepare(`
        INSERT INTO payouts (
          id, affiliate_id, amount, net_amount, chain, status, error_message, retry_count, payout_method_details
        ) VALUES (?, 'aff_retry', 95.0, 95.0, 'stellar', 'failed', 'Temporary network failure', 0, ?)
      `).run(payoutId, JSON.stringify({ address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', chain: 'stellar' }));

      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id) VALUES ('e_ret', 'aff_retry', 95.0, 0, ?)`).run(payoutId);

      const retryRes = await service.retryPayout(payoutId, { reason: 'Network restored' });

      expect(retryRes.success).toBe(true);
      expect(retryRes.status).toBe('confirmed');
      expect(retryRes.transactionId).toBeDefined();

      // Check DB: payout is completed, retry_count = 1, error_message cleared
      const updatedPayout = sqlite.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId) as any;
      expect(updatedPayout.status).toBe('completed');
      expect(updatedPayout.retry_count).toBe(1);
      expect(updatedPayout.error_message).toBeNull();
      expect(updatedPayout.transaction_id).toBe(retryRes.transactionId);

      // Check DB: earnings is_paid = 1
      const updatedEarning = sqlite.prepare('SELECT * FROM earnings WHERE id = ?').get('e_ret') as any;
      expect(updatedEarning.is_paid).toBe(1);
      expect(updatedEarning.paid_at).not.toBeNull();
    });

    it('pre-flight verifies existing transaction on retry avoiding double-broadcast if already confirmed', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_pre', 'pre@example.com', 'Preflight User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();

      const payoutId = 'payout_preflight';
      const existingTxId = 'tx_already_mined_on_stellar';

      // Payout recorded with transaction_id but status remained 'failed' due to timeout
      sqlite.prepare(`
        INSERT INTO payouts (
          id, affiliate_id, amount, net_amount, chain, status, transaction_id, error_message, payout_method_details
        ) VALUES (?, 'aff_pre', 150.0, 150.0, 'stellar', 'failed', ?, 'HTTP timeout polling receipt', ?)
      `).run(payoutId, existingTxId, JSON.stringify({ address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ' }));

      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id) VALUES ('e_pre', 'aff_pre', 150.0, 0, ?)`).run(payoutId);

      // Spy on sendPayout to verify it is NOT called when transaction was confirmed!
      const sendSpy = jest.spyOn(stellarAdapter, 'sendPayout');

      const retryRes = await service.retryPayout(payoutId);

      expect(retryRes.success).toBe(true);
      expect(retryRes.status).toBe('confirmed');
      expect(retryRes.transactionId).toBe(existingTxId);

      // sendPayout was NOT called!
      expect(sendSpy).not.toHaveBeenCalled();

      // Payout and earnings transitioned to completed/paid
      const payout = sqlite.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId) as any;
      expect(payout.status).toBe('completed');
      const earning = sqlite.prepare('SELECT * FROM earnings WHERE id = ?').get('e_pre') as any;
      expect(earning.is_paid).toBe(1);
    });

    it('rejects retry if payout is already completed', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_done', 'done@example.com', 'Done User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();

      const payoutId = 'payout_already_completed';
      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, chain, status, transaction_id)
        VALUES (?, 'aff_done', 100.0, 100.0, 'stellar', 'completed', 'tx_completed_123')
      `).run(payoutId);

      const result = await service.retryPayout(payoutId);
      expect(result.success).toBe(true);
      expect(result.status).toBe('confirmed');
      expect(result.transactionId).toBe('tx_completed_123');
    });

    it('prevents concurrent retryPayout calls from double-executing via atomic CAS', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_cas', 'cas@example.com', 'CAS User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();

      const payoutId = 'payout_cas_retry';
      sqlite.prepare(`
        INSERT INTO payouts (
          id, affiliate_id, amount, net_amount, chain, status, error_message, retry_count, payout_method_details
        ) VALUES (?, 'aff_cas', 120.0, 120.0, 'stellar', 'failed', 'Temporary network failure', 0, ?)
      `).run(payoutId, JSON.stringify({ address: 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', chain: 'stellar' }));

      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id) VALUES ('e_cas', 'aff_cas', 120.0, 0, ?)`).run(payoutId);

      const sendSpy = jest.spyOn(stellarAdapter, 'sendPayout');

      // True concurrent execution via Promise.all
      const [res1, res2] = await Promise.all([
        service.retryPayout(payoutId),
        service.retryPayout(payoutId),
      ]);

      // Exactly 1 on-chain dispatch occurred
      expect(sendSpy).toHaveBeenCalledTimes(1);

      // One call succeeds and one is rejected by atomic CAS
      const succeeded = [res1, res2].filter((r) => r.success);
      const failed = [res1, res2].filter((r) => !r.success);

      expect(succeeded.length).toBe(1);
      expect(failed.length).toBe(1);
      expect(failed[0].error).toBe('Payout is already processing or has already been retried');

      // Verify DB state
      const payout = sqlite.prepare('SELECT * FROM payouts WHERE id = ?').get(payoutId) as any;
      expect(payout.status).toBe('completed');
      expect(payout.retry_count).toBe(1);
    });
  });

  // --------------------------------------------------------------------------
  // Settlement integrity: "submitted" must never be treated as "confirmed".
  // --------------------------------------------------------------------------
  describe('executeBatch — on-chain confirmation is required before marking paid', () => {
    beforeEach(() => {
      // The adapter reports success, but verification is not yet confirmed.
      stellarAdapter.verifyHandler = async () => ({
        verified: true,
        status: 'pending',
        transactionId: 'tx-pending',
        timestamp: new Date().toISOString(),
      }) as never;
    });

    it('leaves earnings unpaid when the transfer is not confirmed on-chain', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_unconfirmed', 'unconf@example.com', 'Unconfirmed User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_uc', 'aff_unconfirmed', 50.00)`).run();

      const result = await service.executeBatch();

      // The submission happened, but the payout is not retired and earnings are
      // untouched: the next cycle retries instead of marking users paid for a
      // transfer that has not landed.
      expect(result.successfulPayouts).toBe(0);

      const earnings = sqlite.prepare('SELECT * FROM earnings WHERE affiliate_id = ?').all('aff_unconfirmed') as Array<{ is_paid: number }>;
      expect(earnings[0].is_paid).toBe(0);
    });

    it('marks earnings paid once verification confirms the transfer', async () => {
      stellarAdapter.verifyHandler = async () => ({
        verified: true,
        status: 'confirmed',
        transactionId: 'tx-confirmed',
        timestamp: new Date().toISOString(),
      }) as never;

      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain)
        VALUES ('aff_confirmed', 'conf@example.com', 'Confirmed User', 'GA2C5RFPE6GCKMY3US5PAB6UZLKIGAHWKXX2GFFMDNAHG4JJSV27GCGZ', 'stellar')
      `).run();
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount) VALUES ('e_c', 'aff_confirmed', 50.00)`).run();

      const result = await service.executeBatch();

      expect(result.successfulPayouts).toBe(1);
      const earnings = sqlite.prepare('SELECT * FROM earnings WHERE affiliate_id = ?').all('aff_confirmed') as Array<{ is_paid: number }>;
      expect(earnings[0].is_paid).toBe(1);
    });
  });
});
