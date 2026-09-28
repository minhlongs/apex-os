/**
 * src/lib/payouts/__tests__/e2e-multichain-payouts.test.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 6: Comprehensive Verification & End-to-End (E2E) Test Suite
 *
 * Test Scenarios Covered:
 * 1. Multi-chain payout flow covering Stellar (XLM/USDC), Ethereum (ERC-20 USDC/USDT), and Solana (SPL USDC)
 * 2. Minimum threshold filtering (>= $50 default, multiple unpaid earnings aggregation, threshold boundary enforcement)
 * 3. Atomic reservation via Cloudflare D1 db.batch(), status transitions (pending -> processing -> completed),
 *    and double-entry ledger reconciliation (earnings.is_paid = 1, paid_at set, payouts.status = 'completed')
 * 4. Admin route requests (/api/admin/payouts/batch, /api/admin/payouts/retry, /api/admin/payouts/treasury)
 *    verifying RBAC authentication/authorization (401 unauthenticated, 403 non-admin) and successful operations
 * 5. Treasury circuit breaker auto-pause when balances fall below configurable safety floors (pre-flight and in-flight)
 * 6. Safe retries with refreshed fee estimation, atomic CAS concurrency lock, and pre-flight on-chain verification
 * 7. Database immutability of payout_audit_logs via SQLite triggers preventing UPDATE and DELETE
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

jest.mock('@/lib/auth/session-helper', () => {
  const actual = jest.requireActual('@/lib/auth/session-helper');
  return {
    ...actual,
    getAuthenticatedUser: jest.fn(),
  };
});

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import * as dbModule from '@/lib/db';
import * as sessionHelper from '@/lib/auth/session-helper';
import { POST as batchRoute } from '@/app/api/admin/payouts/batch/route';
import { POST as retryRoute } from '@/app/api/admin/payouts/retry/route';
import { GET as treasuryRoute } from '@/app/api/admin/payouts/treasury/route';
import {
  BatchSettlementService,
  batchSettlementService,
  generatePayoutIdempotencyKey,
  toCents,
  fromCents,
} from '../batch-settlement-service';
import {
  TreasuryHealthService,
  treasuryHealthService,
  DEFAULT_SAFETY_FLOORS,
} from '../treasury-health-service';
import { PayoutRouter, payoutRouter } from '../router';
import { PayoutAuditService, createAuditStatement } from '../audit-service';
import type {
  PayoutChainAdapter,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
  FeeEstimateParams,
  ChainFeeEstimate,
  SupportedPayoutChain,
} from '../types';

// ============================================================================
// Mock D1 Database Implementation with Atomic Transactional Batch
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
        for (const statement of statements) {
          results.push((statement as InternalPreparedStatement)._runSync());
        }
        return results;
      });
      return runTransaction();
    },
    async exec(sql: string): Promise<D1Result<any>> {
      sqlite.exec(sql);
      return {
        results: [],
        success: true,
        meta: { duration: 0, rows_read: 0, rows_written: 0 } as any,
      };
    },
    dump(): Promise<ArrayBuffer> {
      throw new Error('Not implemented');
    },
  };
}

// ============================================================================
// Configurable Multi-Chain Mock Adapter
// ============================================================================

class ConfigurableMockAdapter implements PayoutChainAdapter {
  public nativeBalance: number;
  public stablecoinBalance: number;
  public feeUsd: number;
  public shouldFailSend: boolean = false;
  public sendErrorMessage: string = 'Simulated chain dispatch failure';
  public shouldFailEstimate: boolean = false;
  public verifyConfirmed: boolean = true;
  public verifyFound: boolean = true;
  public sendCalls: PayoutExecutionParams[] = [];
  public estimateCalls: FeeEstimateParams[] = [];
  public verifyCalls: string[] = [];

  constructor(
    public readonly chain: SupportedPayoutChain,
    defaults?: {
      nativeBalance?: number;
      stablecoinBalance?: number;
      feeUsd?: number;
    }
  ) {
    this.nativeBalance = defaults?.nativeBalance ?? (chain === 'stellar' ? 50 : chain === 'ethereum' ? 5 : 20);
    this.stablecoinBalance = defaults?.stablecoinBalance ?? 10000;
    this.feeUsd = defaults?.feeUsd ?? (chain === 'ethereum' ? 3.5 : chain === 'solana' ? 0.005 : 0.001);
  }

  validateAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    const clean = address.trim();
    if (this.chain === 'stellar') {
      return clean.startsWith('G') && clean.length === 56;
    }
    if (this.chain === 'ethereum') {
      return clean.startsWith('0x') && clean.length === 42 && /^0x[0-9a-fA-F]{40}$/.test(clean);
    }
    if (this.chain === 'solana') {
      return clean.length >= 32 && clean.length <= 44 && !clean.startsWith('0x');
    }
    return false;
  }

  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    this.estimateCalls.push(params);
    if (this.shouldFailEstimate) {
      throw new Error(`Fee estimation failed on ${this.chain}`);
    }
    const nativeSymbol = this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM';
    return {
      chain: this.chain,
      nativeFeeAmount: 0.002,
      nativeFeeSymbol: nativeSymbol,
      feeUsd: this.feeUsd,
      gasUnitsOrLimit: 65000,
      pricePerUnit: '20',
      estimatedAt: new Date().toISOString(),
    };
  }

  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    this.sendCalls.push(params);
    if (this.shouldFailSend) {
      return {
        success: false,
        payoutId: params.payoutId,
        chain: this.chain,
        toAddress: params.recipientAddress,
        amount: params.amount,
        token: params.token,
        error: this.sendErrorMessage,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      success: true,
      payoutId: params.payoutId,
      chain: this.chain,
      toAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token,
      transactionId: `tx_${this.chain}_${params.payoutId}_${Date.now()}`,
      gasFeeNative: 0.002,
      gasFeeUsd: this.feeUsd,
      status: 'confirmed',
      timestamp: new Date().toISOString(),
    };
  }

  async verifyTransaction(transactionId: string): Promise<TransactionVerificationResult> {
    this.verifyCalls.push(transactionId);
    if (!this.verifyFound) {
      return {
        transactionId,
        chain: this.chain,
        verified: false,
        status: 'failed',
        error: 'Transaction not found on chain',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      transactionId,
      chain: this.chain,
      verified: true,
      status: this.verifyConfirmed ? 'confirmed' : 'failed',
      timestamp: new Date().toISOString(),
    };
  }

  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    const nativeSymbol = this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM';
    const hotWalletAddress =
      this.chain === 'stellar'
        ? 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5'
        : this.chain === 'ethereum'
        ? '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
        : '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T';

    return {
      chain: this.chain,
      hotWalletAddress,
      nativeBalance: this.nativeBalance,
      nativeSymbol,
      tokenBalances: {
        USDC: this.stablecoinBalance,
        USDT: 0,
      },
      lastUpdated: new Date().toISOString(),
    };
  }
}

// ============================================================================
// Helper to construct NextRequest for Admin Routes
// ============================================================================

function createAdminRequest(
  url: string,
  options?: {
    method?: string;
    body?: any;
    headers?: Record<string, string>;
  }
): NextRequest {
  const method = options?.method || (options?.body ? 'POST' : 'GET');
  const headers = {
    'content-type': 'application/json',
    'cf-connecting-ip': '203.0.113.195',
    ...options?.headers,
  };

  const init: RequestInit = {
    method,
    headers,
  };

  if (options?.body !== undefined) {
    init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }

  return new NextRequest(url, init);
}

// ============================================================================
// Comprehensive E2E Test Suite
// ============================================================================

describe('ApexOS Milestone 6: Comprehensive E2E Multi-Chain Payout Rails & Settlement Engine', () => {
  let sqlite: Database.Database;
  let mockDb: D1Database;
  let stellarAdapter: ConfigurableMockAdapter;
  let ethAdapter: ConfigurableMockAdapter;
  let solAdapter: ConfigurableMockAdapter;
  let customRouter: PayoutRouter;
  let customHealthService: TreasuryHealthService;
  let customAuditService: PayoutAuditService;
  let settlementService: BatchSettlementService;

  beforeEach(() => {
    // 1. Initialize fresh in-memory SQLite database
    sqlite = new Database(':memory:');
    sqlite.exec('PRAGMA foreign_keys = ON;');

    // 2. Execute full D1 schema matching 003_affiliate_schema and 023_multichain_payouts
    sqlite.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE NOT NULL,
        full_name TEXT,
        role TEXT DEFAULT 'affiliate' CHECK (role IN ('shopper', 'affiliate', 'admin', 'superadmin')),
        wallet_address TEXT,
        preferred_chain TEXT DEFAULT 'stellar' CHECK (preferred_chain IN ('stellar', 'ethereum', 'solana') OR preferred_chain IS NULL),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE payout_batches (
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
        executed_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        dry_run INTEGER DEFAULT 0,
        scheduled_at TEXT,
        started_at TEXT,
        completed_at TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE payouts (
        id TEXT PRIMARY KEY,
        affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        payout_method TEXT CHECK (payout_method IN ('bank_transfer', 'crypto', 'paypal', 'stripe', 'momo', 'sepay', 'vnpay')),
        payout_method_details TEXT DEFAULT '{}',
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        fee REAL DEFAULT 0.00,
        net_amount REAL NOT NULL,
        status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
        scheduled_at TEXT,
        paid_at TEXT,
        transaction_id TEXT UNIQUE,
        notes TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        batch_id TEXT REFERENCES payout_batches(id) ON DELETE SET NULL,
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

      CREATE TABLE earnings (
        id TEXT PRIMARY KEY,
        affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        amount REAL NOT NULL,
        commission_type TEXT DEFAULT 'percentage',
        commission_rate REAL,
        level INTEGER DEFAULT 1,
        is_paid INTEGER DEFAULT 0,
        paid_at TEXT,
        payout_id TEXT REFERENCES payouts(id) ON DELETE SET NULL,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE payout_audit_logs (
        id TEXT PRIMARY KEY,
        batch_id TEXT REFERENCES payout_batches(id) ON DELETE SET NULL,
        payout_id TEXT REFERENCES payouts(id) ON DELETE SET NULL,
        action TEXT NOT NULL CHECK (action IN ('batch_execution', 'approval', 'override', 'cancellation', 'retry', 'circuit_breaker_pause', 'circuit_breaker_resume')),
        admin_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
        admin_email TEXT,
        chain TEXT CHECK (chain IN ('stellar', 'ethereum', 'solana') OR chain IS NULL),
        details TEXT NOT NULL DEFAULT '{}',
        ip_address TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TRIGGER IF NOT EXISTS trg_payout_audit_no_update
      BEFORE UPDATE ON payout_audit_logs
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'payout_audit_logs records are immutable and cannot be updated/deleted');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_payout_audit_no_delete
      BEFORE DELETE ON payout_audit_logs
      FOR EACH ROW
      BEGIN
        SELECT RAISE(ABORT, 'payout_audit_logs records are immutable and cannot be updated/deleted');
      END;
    `);

    // 3. Create mock D1 database & configure globals
    mockDb = createMockD1Database(sqlite);
    (globalThis as any).DB = mockDb;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(mockDb);

    // 4. Create and wire mock adapters
    stellarAdapter = new ConfigurableMockAdapter('stellar');
    ethAdapter = new ConfigurableMockAdapter('ethereum');
    solAdapter = new ConfigurableMockAdapter('solana');

    customRouter = new PayoutRouter({
      stellar: stellarAdapter,
      ethereum: ethAdapter,
      solana: solAdapter,
    });

    customHealthService = new TreasuryHealthService(customRouter);
    customAuditService = new PayoutAuditService(mockDb);

    settlementService = new BatchSettlementService({
      db: mockDb,
      router: customRouter,
      healthService: customHealthService,
      auditService: customAuditService,
    });

    // Also wire route singletons to test instance
    (payoutRouter as any).adapters.set('stellar', stellarAdapter);
    (payoutRouter as any).adapters.set('ethereum', ethAdapter);
    (payoutRouter as any).adapters.set('solana', solAdapter);

    (batchSettlementService as any).dbOverride = mockDb;
    (batchSettlementService as any).routerOverride = customRouter;
    (batchSettlementService as any).healthServiceOverride = customHealthService;
    (batchSettlementService as any).auditServiceOverride = customAuditService;

    (treasuryHealthService as any).router = customRouter;

    // 5. Seed standard admin profile
    sqlite.prepare(`
      INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
      VALUES ('admin_primary', 'admin@apexos.app', 'Apex Admin', 'admin', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
    `).run();

    // Default authenticated user to admin
    (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
      id: 'admin_primary',
      email: 'admin@apexos.app',
    });
  });

  afterEach(() => {
    sqlite.close();
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // 1. Multi-Chain Payout Flow (Stellar, Ethereum, Solana)
  // ==========================================================================
  describe('1. Multi-Chain Payout Flow', () => {
    it('should route transactions to Stellar, Ethereum, and Solana according to user profile and validate addresses', async () => {
      // Seed 3 affiliates with distinct preferred chains and valid wallet addresses
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain) VALUES
        ('aff_xlm', 'stellar_aff@test.com', 'Stellar User', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar'),
        ('aff_eth', 'eth_aff@test.com', 'Ethereum User', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum'),
        ('aff_sol', 'sol_aff@test.com', 'Solana User', 'affiliate', '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T', 'solana')
      `).run();

      // Seed unpaid earnings exceeding $50 for all 3 affiliates
      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES
        ('earn_xlm_1', 'aff_xlm', 150.00, 0),
        ('earn_eth_1', 'aff_eth', 250.00, 0),
        ('earn_sol_1', 'aff_sol', 350.00, 0)
      `).run();

      // Execute preview for all chains
      const preview = await settlementService.previewBatch({ chain: 'all' });
      expect(preview.eligibleAffiliatesCount).toBe(3);
      expect(preview.totalAmountUsd).toBe(750.00);
      expect(preview.byChain.stellar.affiliateCount).toBe(1);
      expect(preview.byChain.stellar.totalAmount).toBe(150.00);
      expect(preview.byChain.ethereum.affiliateCount).toBe(1);
      expect(preview.byChain.ethereum.totalAmount).toBe(250.00);
      expect(preview.byChain.solana.affiliateCount).toBe(1);
      expect(preview.byChain.solana.totalAmount).toBe(350.00);

      // Execute multi-chain settlement batch
      const result = await settlementService.executeBatch({ chain: 'all' });
      expect(result.status).toBe('completed');
      expect(result.successfulPayouts).toBe(3);
      expect(result.failedPayouts).toBe(0);
      expect(result.totalAmount).toBe(750.00);

      // Verify each adapter received its respective payout dispatch
      expect(stellarAdapter.sendCalls.length).toBe(1);
      expect(stellarAdapter.sendCalls[0].recipientAddress).toBe('GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5');
      expect(stellarAdapter.sendCalls[0].amount).toBe(150.00);

      expect(ethAdapter.sendCalls.length).toBe(1);
      expect(ethAdapter.sendCalls[0].recipientAddress).toBe('0x742d35Cc6634C0532925a3b844Bc454e4438f44e');
      expect(ethAdapter.sendCalls[0].amount).toBe(250.00);

      expect(solAdapter.sendCalls.length).toBe(1);
      expect(solAdapter.sendCalls[0].recipientAddress).toBe('4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T');
      expect(solAdapter.sendCalls[0].amount).toBe(350.00);

      // Verify D1 records in payouts table
      const payouts = sqlite.prepare('SELECT id, chain, status, net_amount, transaction_id FROM payouts ORDER BY chain').all() as any[];
      expect(payouts.length).toBe(3);
      expect(payouts[0].chain).toBe('ethereum');
      expect(payouts[0].status).toBe('completed');
      expect(payouts[0].transaction_id).toMatch(/^tx_ethereum_/);

      expect(payouts[1].chain).toBe('solana');
      expect(payouts[1].status).toBe('completed');
      expect(payouts[1].transaction_id).toMatch(/^tx_solana_/);

      expect(payouts[2].chain).toBe('stellar');
      expect(payouts[2].status).toBe('completed');
      expect(payouts[2].transaction_id).toMatch(/^tx_stellar_/);
    });

    it('should reject malformed or mismatching wallet addresses during routing and preview', async () => {
      // Profile with preferred_chain = 'ethereum' but a Stellar 'G...' address
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_bad_addr', 'bad_eth@test.com', 'Bad ETH', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'ethereum')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_bad_1', 'aff_bad_addr', 100.00, 0)
      `).run();

      const preview = await settlementService.previewBatch({ chain: 'ethereum' });
      // Invalid address affiliate must be skipped
      expect(preview.eligibleAffiliatesCount).toBe(0);
      expect(preview.payoutsPreview.length).toBe(0);
    });
  });

  // ==========================================================================
  // 2. Minimum Threshold Filtering (>= $50 default & aggregation)
  // ==========================================================================
  describe('2. Minimum Threshold Filtering & Aggregation', () => {
    it('should filter out balances below $50 and aggregate multiple smaller earnings above threshold', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain) VALUES
        ('aff_below', 'below@test.com', 'Below Threshold', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar'),
        ('aff_multi', 'multi@test.com', 'Multi Earnings', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum'),
        ('aff_exact', 'exact@test.com', 'Exact Threshold', 'affiliate', '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T', 'solana')
      `).run();

      // aff_below: $49.99 (below $50)
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_below', 'aff_below', 49.99, 0)`).run();

      // aff_multi: $20.00 + $15.00 + $25.00 = $60.00 (qualifies)
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES
        ('e_m1', 'aff_multi', 20.00, 0),
        ('e_m2', 'aff_multi', 15.00, 0),
        ('e_m3', 'aff_multi', 25.00, 0)
      `).run();

      // aff_exact: $50.00 exact (qualifies)
      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_exact', 'aff_exact', 50.00, 0)`).run();

      const preview = await settlementService.previewBatch({ minThreshold: 50.0 });
      expect(preview.eligibleAffiliatesCount).toBe(2);
      expect(preview.totalEarningsCount).toBe(4); // 3 from aff_multi + 1 from aff_exact
      expect(preview.totalAmountUsd).toBe(110.00); // 60.00 + 50.00

      const multiPreview = preview.payoutsPreview.find(p => p.affiliateId === 'aff_multi');
      expect(multiPreview).toBeDefined();
      expect(multiPreview?.grossAmount).toBe(60.00);
      expect(multiPreview?.earningIds.sort()).toEqual(['e_m1', 'e_m2', 'e_m3']);

      // Execute batch and verify reservation
      const execution = await settlementService.executeBatch({ minThreshold: 50.0 });
      expect(execution.status).toBe('completed');
      expect(execution.successfulPayouts).toBe(2);

      // Verify aff_below is untouched and still unpaid
      const belowEarning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('e_below') as any;
      expect(belowEarning.is_paid).toBe(0);
      expect(belowEarning.payout_id).toBeNull();
    });

    it('should respect custom minimum threshold parameters', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_custom', 'custom@test.com', 'Custom Threshold', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')
      `).run();

      sqlite.prepare(`INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_cust', 'aff_custom', 75.00, 0)`).run();

      // When threshold is $100, $75 is excluded
      const preview100 = await settlementService.previewBatch({ minThreshold: 100.0 });
      expect(preview100.eligibleAffiliatesCount).toBe(0);

      // When threshold is $25, $75 is included
      const preview25 = await settlementService.previewBatch({ minThreshold: 25.0 });
      expect(preview25.eligibleAffiliatesCount).toBe(1);
      expect(preview25.totalAmountUsd).toBe(75.00);
    });
  });

  // ==========================================================================
  // 3. Atomic Reservation, Status Transitions & Double-Entry Ledger Safety
  // ==========================================================================
  describe('3. Atomic Reservation & Double-Entry Ledger Reconciliation', () => {
    it('should atomically reserve earnings and transition statuses (pending -> processing -> completed)', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_atomic', 'atomic@test.com', 'Atomic User', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES
        ('earn_atom_1', 'aff_atomic', 70.00, 0),
        ('earn_atom_2', 'aff_atomic', 30.00, 0)
      `).run();

      // Spies to track internal state during execution
      let observedPayoutId: string | null = null;
      const originalSend = stellarAdapter.sendPayout.bind(stellarAdapter);
      stellarAdapter.sendPayout = jest.fn(async (params: PayoutExecutionParams) => {
        observedPayoutId = params.payoutId;

        // While sendPayout is in-flight, verify that D1 payout record is in 'processing' status
        const inFlightPayout = sqlite.prepare('SELECT status, batch_id, net_amount FROM payouts WHERE id = ?').get(params.payoutId) as any;
        expect(inFlightPayout.status).toBe('processing');
        expect(inFlightPayout.net_amount).toBe(100.00);

        // Verify earnings are locked to this payout_id but is_paid is still 0
        const inFlightEarnings = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE affiliate_id = ?').all('aff_atomic') as any[];
        expect(inFlightEarnings.length).toBe(2);
        expect(inFlightEarnings[0].payout_id).toBe(params.payoutId);
        expect(inFlightEarnings[0].is_paid).toBe(0);
        expect(inFlightEarnings[1].payout_id).toBe(params.payoutId);
        expect(inFlightEarnings[1].is_paid).toBe(0);

        return originalSend(params);
      });

      const execResult = await settlementService.executeBatch({ chain: 'stellar' });
      expect(execResult.status).toBe('completed');
      expect(execResult.successfulPayouts).toBe(1);

      // Post-execution: verify double-entry ledger reconciliation
      const payoutRecord = sqlite.prepare('SELECT status, transaction_id, paid_at, gas_fee_usd FROM payouts WHERE id = ?').get(observedPayoutId) as any;
      expect(payoutRecord.status).toBe('completed');
      expect(payoutRecord.transaction_id).toBeTruthy();
      expect(payoutRecord.paid_at).toBeTruthy();
      expect(payoutRecord.gas_fee_usd).toBeGreaterThan(0);

      // Earnings records must be marked is_paid = 1 with matching paid_at
      const finalizedEarnings = sqlite.prepare('SELECT is_paid, paid_at, payout_id FROM earnings WHERE affiliate_id = ?').all('aff_atomic') as any[];
      expect(finalizedEarnings.every(e => e.is_paid === 1)).toBe(true);
      expect(finalizedEarnings.every(e => e.paid_at !== null)).toBe(true);
      expect(finalizedEarnings.every(e => e.payout_id === observedPayoutId)).toBe(true);
    });

    it('should isolate errors when one chain fails, leaving other payouts completed and failed payout retriable', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain) VALUES
        ('aff_ok', 'ok@test.com', 'OK Stellar', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar'),
        ('aff_err', 'err@test.com', 'Failing ETH', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES
        ('earn_ok', 'aff_ok', 100.00, 0),
        ('earn_err', 'aff_err', 200.00, 0)
      `).run();

      // Configure Ethereum adapter to fail simulation/dispatch
      ethAdapter.shouldFailSend = true;
      ethAdapter.sendErrorMessage = 'EVM execution reverted: transfer failed';

      const result = await settlementService.executeBatch({ chain: 'all' });
      expect(result.status).toBe('partially_failed');
      expect(result.successfulPayouts).toBe(1);
      expect(result.failedPayouts).toBe(1);

      // Verify successful payout on Stellar
      const okPayout = sqlite.prepare('SELECT status, transaction_id FROM payouts WHERE affiliate_id = ?').get('aff_ok') as any;
      expect(okPayout.status).toBe('completed');
      expect(okPayout.transaction_id).toBeTruthy();

      const okEarning = sqlite.prepare('SELECT is_paid FROM earnings WHERE id = ?').get('earn_ok') as any;
      expect(okEarning.is_paid).toBe(1);

      // Verify failed payout on Ethereum
      const errPayout = sqlite.prepare('SELECT id, status, error_message FROM payouts WHERE affiliate_id = ?').get('aff_err') as any;
      expect(errPayout.status).toBe('failed');
      expect(errPayout.error_message).toContain('EVM execution reverted');

      // Failed earning must remain unpaid (is_paid = 0) but retain payout_id for safe retries
      const errEarning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('earn_err') as any;
      expect(errEarning.is_paid).toBe(0);
      expect(errEarning.payout_id).toBe(errPayout.id);
    });

    it('should reject concurrent batches attempting to claim already reserved earnings via unique idempotency key', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_idem', 'idem@test.com', 'Idem User', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_id1', 'aff_idem', 100.00, 0)
      `).run();

      // Compute deterministic key
      const expectedKey = generatePayoutIdempotencyKey('aff_idem', ['earn_id1']);

      // Pre-seed an existing payout with this exact idempotency key
      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, idempotency_key)
        VALUES ('existing_payout_1', 'aff_idem', 100.00, 100.00, 'processing', ?)
      `).run(expectedKey);

      // Attempt to execute another batch for the same earning
      const batchResult = await settlementService.executeBatch({ chain: 'stellar' });
      expect(batchResult.status).toBe('failed');
      expect(batchResult.successfulPayouts).toBe(0);
      expect(batchResult.errors?.[0]).toContain('Concurrent batch execution conflict');
    });
  });

  // ==========================================================================
  // 4. Admin Route Requests & RBAC Verification (/batch, /retry, /treasury)
  // ==========================================================================
  describe('4. Admin Route Requests & RBAC Verification', () => {
    it('should enforce 401 Unauthorized when session is missing across all admin payout routes', async () => {
      // Simulate no authenticated session
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      // 1. /api/admin/payouts/batch
      const batchReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview' },
      });
      const batchRes = await batchRoute(batchReq);
      expect(batchRes.status).toBe(401);
      const batchJson = await batchRes.json();
      expect(batchJson.error).toContain('Unauthorized');

      // 2. /api/admin/payouts/retry
      const retryReq = createAdminRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: 'payout_123' },
      });
      const retryRes = await retryRoute(retryReq);
      expect(retryRes.status).toBe(401);

      // 3. /api/admin/payouts/treasury
      const treasuryReq = createAdminRequest('http://localhost:3000/api/admin/payouts/treasury');
      const treasuryRes = await treasuryRoute(treasuryReq);
      expect(treasuryRes.status).toBe(401);
    });

    it('should enforce 403 Forbidden when user is not an admin', async () => {
      // Seed a standard non-admin affiliate
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role)
        VALUES ('aff_shopper_1', 'shopper@test.com', 'Shopper User', 'shopper')
      `).run();

      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'aff_shopper_1',
        email: 'shopper@test.com',
      });

      const req = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview' },
      });
      const res = await batchRoute(req);
      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error).toContain('Forbidden');
    });

    it('should successfully handle /api/admin/payouts/batch for preview and execution with dry-run support', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_route_batch', 'route_batch@test.com', 'Route Batch User', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_route_1', 'aff_route_batch', 85.00, 0)
      `).run();

      // Test Action: Preview
      const previewReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview', chain: 'stellar' },
      });
      const previewRes = await batchRoute(previewReq);
      expect(previewRes.status).toBe(200);
      const previewJson = await previewRes.json();
      expect(previewJson.success).toBe(true);
      expect(previewJson.eligibleAffiliatesCount).toBe(1);
      expect(previewJson.totalAmountUsd).toBe(85.00);

      // Test Action: Execute with dryRun = true
      const dryReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'execute', chain: 'stellar', dryRun: true },
      });
      const dryRes = await batchRoute(dryReq);
      expect(dryRes.status).toBe(200);
      const dryJson = await dryRes.json();
      expect(dryJson.dryRun).toBe(true);
      expect(dryJson.successfulPayouts).toBe(1);

      // Ensure dry-run did not alter earnings table
      const earningAfterDry = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('earn_route_1') as any;
      expect(earningAfterDry.is_paid).toBe(0);
      expect(earningAfterDry.payout_id).toBeNull();

      // Test Action: Execute Live Batch
      const liveReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'execute', chain: 'stellar' },
      });
      const liveRes = await batchRoute(liveReq);
      expect(liveRes.status).toBe(200);
      const liveJson = await liveRes.json();
      expect(liveJson.success).toBe(true);
      expect(liveJson.data.status).toBe('completed');
      expect(liveJson.data.successfulPayouts).toBe(1);

      // Verify earning is now paid
      const earningAfterLive = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('earn_route_1') as any;
      expect(earningAfterLive.is_paid).toBe(1);
      expect(earningAfterLive.payout_id).toBeTruthy();
    });

    it('should validate inputs for /api/admin/payouts/batch', async () => {
      // Invalid action
      const badActionReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'unknown' },
      });
      const badActionRes = await batchRoute(badActionReq);
      expect(badActionRes.status).toBe(400);

      // Invalid chain
      const badChainReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview', chain: 'dogecoin' },
      });
      const badChainRes = await batchRoute(badChainReq);
      expect(badChainRes.status).toBe(400);

      // Negative minThreshold
      const badThreshReq = createAdminRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview', minThreshold: -10 },
      });
      const badThreshRes = await batchRoute(badThreshReq);
      expect(badThreshRes.status).toBe(400);
    });

    it('should successfully handle /api/admin/payouts/treasury supply and demand inspection', async () => {
      // Seed unpaid earnings across multiple chains
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain) VALUES
        ('u_eth', 'eth@t.com', 'U ETH', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum'),
        ('u_sol', 'sol@t.com', 'U SOL', 'affiliate', '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T', 'solana')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES
        ('e_eth_1', 'u_eth', 300.00, 0),
        ('e_sol_1', 'u_sol', 400.00, 0)
      `).run();

      const req = createAdminRequest('http://localhost:3000/api/admin/payouts/treasury');
      const res = await treasuryRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();

      expect(json.success).toBe(true);
      expect(json.treasuryHealth.globalStatus).toBe('HEALTHY');
      expect(json.treasuryHealth.chains.stellar).toBeDefined();
      expect(json.treasuryHealth.chains.ethereum).toBeDefined();
      expect(json.treasuryHealth.chains.solana).toBeDefined();

      // Demand side verification
      expect(json.pendingQueues.unpaidEarnings.totalAmount).toBe(700.00);
      expect(json.pendingQueues.unpaidEarnings.byChain.ethereum.count).toBe(1);
      expect(json.pendingQueues.unpaidEarnings.byChain.ethereum.totalAmount).toBe(300.00);
      expect(json.pendingQueues.unpaidEarnings.byChain.solana.count).toBe(1);
      expect(json.pendingQueues.unpaidEarnings.byChain.solana.totalAmount).toBe(400.00);
    });

    it('should filter /api/admin/payouts/treasury by chain query parameter', async () => {
      const req = createAdminRequest('http://localhost:3000/api/admin/payouts/treasury?chain=ethereum');
      const res = await treasuryRoute(req);
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.treasuryHealth.chains.ethereum).toBeDefined();

      // Invalid chain query param
      const badReq = createAdminRequest('http://localhost:3000/api/admin/payouts/treasury?chain=bitcoin');
      const badRes = await treasuryRoute(badReq);
      expect(badRes.status).toBe(400);
    });
  });

  // ==========================================================================
  // 5. Treasury Circuit Breaker Auto-Pause & Safety Floors
  // ==========================================================================
  describe('5. Treasury Circuit Breaker Auto-Pause', () => {
    it('should halt automated batch settlement when native gas balance drops below safety floor', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_cb_gas', 'gas@test.com', 'Gas Depleted User', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_cb_1', 'aff_cb_gas', 100.00, 0)
      `).run();

      // Ethereum default nativeGasFloor is 0.05 ETH. Set adapter balance to 0.01 ETH (< floor)
      ethAdapter.nativeBalance = 0.01;

      // 1. Preview must flag canExecute = false
      const preview = await settlementService.previewBatch({ chain: 'ethereum' });
      expect(preview.canExecute).toBe(false);
      expect(preview.blockingReasons?.[0]).toContain('CRITICAL');
      expect(preview.blockingReasons?.[0]).toContain('low ETH gas balance');
      expect(preview.treasuryHealth.globalStatus).toBe('CRITICAL');

      // 2. Execution must halt before reservation, marking batch failed and recording audit log
      const execution = await settlementService.executeBatch({ chain: 'ethereum' });
      expect(execution.status).toBe('failed');
      expect(execution.successfulPayouts).toBe(0);

      // Verify circuit_breaker_pause audit log
      const auditLog = sqlite.prepare('SELECT action, chain, details FROM payout_audit_logs WHERE action = ?').get('circuit_breaker_pause') as any;
      expect(auditLog).toBeDefined();
      expect(auditLog.chain).toBe('ethereum');
      expect(auditLog.details).toContain('Pre-flight circuit breaker halted batch execution');

      // Earnings must remain unreserved and unpaid
      const earning = sqlite.prepare('SELECT is_paid, payout_id FROM earnings WHERE id = ?').get('earn_cb_1') as any;
      expect(earning.is_paid).toBe(0);
      expect(earning.payout_id).toBeNull();
    });

    it('should halt automated settlement when stablecoin reserves fall below safety floor or payout amount', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_cb_usdc', 'usdc@test.com', 'USDC User', 'affiliate', '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T', 'solana')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_cb_2', 'aff_cb_usdc', 600.00, 0)
      `).run();

      // Solana default stablecoinReserveFloor is $500.
      // Case A: Set adapter balance to $300 (< $500 floor)
      solAdapter.stablecoinBalance = 300;
      const checkFloor = await customHealthService.canSettle(600, 'solana');
      expect(checkFloor.allowed).toBe(false);
      expect(checkFloor.reason).toContain('CRITICAL');

      // Case B: Set adapter balance to $550 (> $500 floor, but < $600 required payout)
      solAdapter.stablecoinBalance = 550;
      const checkCoverage = await customHealthService.canSettle(600, 'solana');
      expect(checkCoverage.allowed).toBe(false);
      expect(checkCoverage.reason).toContain('Insufficient treasury reserves');
    });

    it('should allow dynamic configuration of safety floor thresholds', () => {
      // Update Ethereum gas floor from 0.05 to 0.01
      const updated = customHealthService.updateSafetyFloors('ethereum', {
        nativeGasFloor: 0.01,
        stablecoinReserveFloor: 250,
      });
      expect(updated.nativeGasFloor).toBe(0.01);
      expect(updated.stablecoinReserveFloor).toBe(250);

      // Verify getter returns updated floor
      const activeFloors = customHealthService.getSafetyFloors('ethereum');
      expect(activeFloors.nativeGasFloor).toBe(0.01);
      expect(activeFloors.stablecoinReserveFloor).toBe(250);

      // Reset floors back to defaults
      customHealthService.resetSafetyFloors('ethereum');
      const resetFloors = customHealthService.getSafetyFloors('ethereum');
      expect(resetFloors.nativeGasFloor).toBe(DEFAULT_SAFETY_FLOORS.ethereum.nativeGasFloor);
      expect(resetFloors.stablecoinReserveFloor).toBe(DEFAULT_SAFETY_FLOORS.ethereum.stablecoinReserveFloor);
    });

    it('should trigger in-flight circuit breaker if treasury depletes during batch execution', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain) VALUES
        ('aff_if_1', 'if1@test.com', 'In-Flight 1', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar'),
        ('aff_if_2', 'if2@test.com', 'In-Flight 2', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES
        ('e_if_1', 'aff_if_1', 100.00, 0),
        ('e_if_2', 'aff_if_2', 100.00, 0)
      `).run();

      // Initial balance is healthy
      stellarAdapter.stablecoinBalance = 1000;

      // When the first payout is dispatched, simulate sudden balance depletion
      const originalSend = stellarAdapter.sendPayout.bind(stellarAdapter);
      stellarAdapter.sendPayout = jest.fn(async (params: PayoutExecutionParams) => {
        stellarAdapter.stablecoinBalance = 50; // Drops below Stellar floor of $100
        return originalSend(params);
      });

      const batchResult = await settlementService.executeBatch({ chain: 'stellar' });
      expect(batchResult.status).toBe('partially_failed');
      expect(batchResult.successfulPayouts).toBe(1);
      expect(batchResult.failedPayouts).toBe(1);

      // First payout succeeded
      const p1 = sqlite.prepare('SELECT status FROM payouts WHERE affiliate_id = ?').get('aff_if_1') as any;
      expect(p1.status).toBe('completed');

      // Second payout failed due to in-flight circuit breaker trip
      const p2 = sqlite.prepare('SELECT status, error_message FROM payouts WHERE affiliate_id = ?').get('aff_if_2') as any;
      expect(p2.status).toBe('failed');
      expect(p2.error_message).toContain('In-flight circuit breaker tripped');
    });
  });

  // ==========================================================================
  // 6. Safe Retries, Refreshed Fees, CAS Lock & On-Chain Pre-flight Check
  // ==========================================================================
  describe('6. Safe Retries & Concurrency Guarantees', () => {
    it('should retry a failed payout with refreshed fee estimation', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_retry', 'retry@test.com', 'Retry User', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')
      `).run();

      // Seed a failed payout record and associated earnings
      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, chain, payout_method_details, gas_fee_usd, error_message)
        VALUES ('payout_failed_1', 'aff_retry', 120.00, 120.00, 'failed', 'ethereum', '{"address":"0x742d35Cc6634C0532925a3b844Bc454e4438f44e","chain":"ethereum"}', 2.00, 'RPC Timeout')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id)
        VALUES ('earn_retry_1', 'aff_retry', 120.00, 0, 'payout_failed_1')
      `).run();

      // Simulate network gas fee increase
      ethAdapter.feeUsd = 12.50;

      // Call retry endpoint via admin route
      const retryReq = createAdminRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: 'payout_failed_1', refreshFee: true },
      });
      const retryRes = await retryRoute(retryReq);
      expect(retryRes.status).toBe(200);
      const retryJson = await retryRes.json();

      expect(retryJson.success).toBe(true);
      expect(retryJson.data.status).toBe('confirmed');
      expect(retryJson.data.transactionId).toMatch(/^tx_ethereum_/);

      // Verify D1 state updated to completed with refreshed gas fee
      const updatedPayout = sqlite.prepare('SELECT status, paid_at, gas_fee_usd, retry_count FROM payouts WHERE id = ?').get('payout_failed_1') as any;
      expect(updatedPayout.status).toBe('completed');
      expect(updatedPayout.paid_at).toBeTruthy();
      expect(updatedPayout.gas_fee_usd).toBe(12.50);
      expect(updatedPayout.retry_count).toBe(1);

      // Verify earnings marked paid
      const updatedEarning = sqlite.prepare('SELECT is_paid, paid_at FROM earnings WHERE id = ?').get('earn_retry_1') as any;
      expect(updatedEarning.is_paid).toBe(1);
      expect(updatedEarning.paid_at).toBeTruthy();
    });

    it('should pre-flight verify on-chain state to prevent duplicate broadcasts if tx is already confirmed', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_ghost', 'ghost@test.com', 'Ghost User', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
      `).run();

      // Payout marked failed due to connection drop, but on-chain tx was actually mined!
      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, chain, payout_method_details, transaction_id, error_message)
        VALUES ('payout_ghost_1', 'aff_ghost', 200.00, 200.00, 'failed', 'stellar', '{"address":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"}', 'tx_already_mined_999', 'Connection lost')
      `).run();

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id)
        VALUES ('earn_ghost_1', 'aff_ghost', 200.00, 0, 'payout_ghost_1')
      `).run();

      // Stellar adapter confirms transaction
      stellarAdapter.verifyFound = true;
      stellarAdapter.verifyConfirmed = true;

      const retryResult = await settlementService.retryPayout('payout_ghost_1');
      expect(retryResult.success).toBe(true);
      expect(retryResult.transactionId).toBe('tx_already_mined_999');

      // CRITICAL: Adapter sendPayout MUST NOT have been called again!
      expect(stellarAdapter.sendCalls.length).toBe(0);

      // Verify payout is reconciled in D1
      const reconciled = sqlite.prepare('SELECT status, paid_at FROM payouts WHERE id = ?').get('payout_ghost_1') as any;
      expect(reconciled.status).toBe('completed');
      expect(reconciled.paid_at).toBeTruthy();

      const reconciledEarning = sqlite.prepare('SELECT is_paid FROM earnings WHERE id = ?').get('earn_ghost_1') as any;
      expect(reconciledEarning.is_paid).toBe(1);

      // Verify audit log recorded preflight confirmation
      const auditLog = sqlite.prepare('SELECT details FROM payout_audit_logs WHERE payout_id = ? AND action = ?').get('payout_ghost_1', 'retry') as any;
      expect(auditLog.details).toContain('preflight_verification_confirmed');
    });

    it('should reject concurrent retries via atomic Compare-And-Swap (CAS) locking', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_race', 'race@test.com', 'Race User', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')
      `).run();

      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, chain, payout_method_details)
        VALUES ('payout_race_1', 'aff_race', 100.00, 100.00, 'failed', 'ethereum', '{"address":"0x742d35Cc6634C0532925a3b844Bc454e4438f44e"}')
      `).run();

      // Hook into adapter: when first retry enters sendPayout, trigger a second concurrent retry
      let secondRetryResult: any = null;
      const originalSend = ethAdapter.sendPayout.bind(ethAdapter);
      ethAdapter.sendPayout = jest.fn(async (params: PayoutExecutionParams) => {
        // While first retry is in-flight (status = 'processing'), trigger concurrent second retry
        secondRetryResult = await settlementService.retryPayout('payout_race_1');
        return originalSend(params);
      });

      const firstRetryResult = await settlementService.retryPayout('payout_race_1');

      // First retry succeeds
      expect(firstRetryResult.success).toBe(true);

      // Second retry was rejected by CAS lock (changes === 0)
      expect(secondRetryResult).toBeDefined();
      expect(secondRetryResult.success).toBe(false);
      expect(secondRetryResult.error).toContain('Payout is in \'processing\' status');
    });

    it('should allow force retry of stuck payouts and record admin override audit logs', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
        VALUES ('aff_stuck', 'stuck@test.com', 'Stuck User', 'affiliate', '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T', 'solana')
      `).run();

      // Payout stuck in 'pending' status
      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, chain, payout_method_details)
        VALUES ('payout_stuck_1', 'aff_stuck', 150.00, 150.00, 'pending', 'solana', '{"address":"4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T"}')
      `).run();

      // Normal retry without force should be rejected with 409
      const normalReq = createAdminRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: 'payout_stuck_1', force: false },
      });
      const normalRes = await retryRoute(normalReq);
      expect(normalRes.status).toBe(409);
      const normalJson = await normalRes.json();
      expect(normalJson.error).toContain('Only \'failed\' payouts can be retried');

      // Force retry via admin route
      const forceReq = createAdminRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: 'payout_stuck_1', force: true, notes: 'Stuck transaction manual override' },
      });
      const forceRes = await retryRoute(forceReq);
      expect(forceRes.status).toBe(200);

      // Verify audit log has 'override' action with admin context
      const overrideAudit = sqlite.prepare('SELECT action, admin_id, admin_email, details FROM payout_audit_logs WHERE action = ?').get('override') as any;
      expect(overrideAudit).toBeDefined();
      expect(overrideAudit.admin_id).toBe('admin_primary');
      expect(overrideAudit.admin_email).toBe('admin@apexos.app');
      expect(overrideAudit.details).toContain('admin_retry_force_override');
    });
  });

  // ==========================================================================
  // 7. Database Immutability of payout_audit_logs
  // ==========================================================================
  describe('7. Database Immutability of payout_audit_logs', () => {
    it('should prohibit UPDATE and DELETE statements on payout_audit_logs via database triggers', async () => {
      // 1. Insert valid audit record
      const auditRecord = await customAuditService.log({
        action: 'batch_execution',
        admin_id: 'admin_primary',
        admin_email: 'admin@apexos.app',
        chain: 'stellar',
        details: { event: 'immutability_verification' },
      });

      expect(auditRecord.id).toBeDefined();

      // Verify record exists in SQLite
      const inserted = sqlite.prepare('SELECT id, action, details FROM payout_audit_logs WHERE id = ?').get(auditRecord.id) as any;
      expect(inserted).toBeDefined();
      expect(inserted.action).toBe('batch_execution');

      // 2. Attempt UPDATE operation - MUST throw abort from trigger
      expect(() => {
        sqlite.prepare(`
          UPDATE payout_audit_logs
          SET details = '{"tampered":true}'
          WHERE id = ?
        `).run(auditRecord.id);
      }).toThrow(/payout_audit_logs records are immutable and cannot be updated\/deleted/);

      // 3. Attempt DELETE operation - MUST throw abort from trigger
      expect(() => {
        sqlite.prepare(`
          DELETE FROM payout_audit_logs
          WHERE id = ?
        `).run(auditRecord.id);
      }).toThrow(/payout_audit_logs records are immutable and cannot be updated\/deleted/);

      // 4. Verify record is still pristine and unaltered
      const pristine = sqlite.prepare('SELECT details FROM payout_audit_logs WHERE id = ?').get(auditRecord.id) as any;
      expect(pristine.details).toContain('immutability_verification');
    });
  });
});
