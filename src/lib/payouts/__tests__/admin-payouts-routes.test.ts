/**
 * src/lib/payouts/__tests__/admin-payouts-routes.test.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 5: Admin Payout Controls, Retries & Audit Logging Test Suite
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import * as dbModule from '@/lib/db';
import * as sessionHelper from '@/lib/auth/session-helper';
import { verifyAdminPayoutAccess } from '../admin-auth';
import { POST as batchRoute } from '@/app/api/admin/payouts/batch/route';
import { POST as retryRoute } from '@/app/api/admin/payouts/retry/route';
import { GET as treasuryRoute } from '@/app/api/admin/payouts/treasury/route';
import { batchSettlementService } from '../batch-settlement-service';
import { treasuryHealthService } from '../treasury-health-service';
import { payoutRouter } from '../router';
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

// Mock session helper
jest.mock('@/lib/auth/session-helper', () => {
  const actual = jest.requireActual('@/lib/auth/session-helper');
  return {
    ...actual,
    getAuthenticatedUser: jest.fn(),
  };
});

// Mock D1 Database implementation backed by better-sqlite3
function createMockD1Database(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let boundParams: any[] = [];
      const stmt = sqlite.prepare(sql);

      const prepared: any = {
        bind(...params: any[]) {
          boundParams = params;
          return prepared;
        },
        async run<T = unknown>(): Promise<D1Result<T>> {
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
        async first<T = unknown>(col?: string): Promise<T | null> {
          const row = stmt.get(...boundParams);
          if (!row) return null;
          return (col ? (row as any)[col] : row) as T;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const rows = stmt.all(...boundParams);
          return {
            results: rows as T[],
            success: true,
            meta: {
              changes: 0,
              last_row_id: 0,
              duration: 0,
              rows_read: rows.length,
              rows_written: 0,
            } as any,
          };
        },
      };
      return prepared;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const results: D1Result<T>[] = [];
      for (const statement of statements) {
        results.push(await statement.run<T>());
      }
      return results;
    },
  } as unknown as D1Database;
}

// Mock Chain Adapters for deterministic execution
class MockAdapter implements PayoutChainAdapter {
  constructor(
    public readonly chain: SupportedPayoutChain,
    private readonly options?: {
      feeUsd?: number;
      canSettle?: boolean;
      verifyConfirmed?: boolean;
      sendFails?: boolean;
    }
  ) {}

  validateAddress(address: string): boolean {
    if (!address || address.length < 10) return false;
    if (this.chain === 'stellar') return address.startsWith('G');
    if (this.chain === 'ethereum') return address.startsWith('0x');
    if (this.chain === 'solana') return address.length >= 32 && !address.startsWith('0x');
    return true;
  }

  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    const feeUsd = this.options?.feeUsd ?? (this.chain === 'ethereum' ? 2.5 : this.chain === 'solana' ? 0.005 : 0.001);
    return {
      chain: this.chain,
      nativeFeeAmount: 0.001,
      nativeFeeSymbol: this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM',
      feeUsd,
      gasUnitsOrLimit: 65000,
      pricePerUnit: '10',
      estimatedAt: new Date().toISOString(),
    };
  }

  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (this.options?.sendFails) {
      return {
        success: false,
        payoutId: params.payoutId,
        chain: this.chain,
        toAddress: params.recipientAddress,
        amount: params.amount,
        token: params.token,
        error: `Simulated RPC error on ${this.chain}`,
        status: 'failed',
      };
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
      gasFeeUsd: this.options?.feeUsd ?? 0.01,
      status: 'confirmed',
      timestamp: new Date().toISOString(),
    };
  }

  async verifyTransaction(txId: string): Promise<TransactionVerificationResult> {
    return {
      transactionId: txId,
      chain: this.chain,
      verified: true,
      status: this.options?.verifyConfirmed !== false ? 'confirmed' : 'failed',
      timestamp: new Date().toISOString(),
    };
  }

  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    return {
      chain: this.chain,
      hotWalletAddress:
        this.chain === 'ethereum'
          ? '0x742d35Cc6634C0532925a3b844Bc454e4438f44e'
          : this.chain === 'solana'
          ? '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T'
          : 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
      nativeBalance: 100,
      nativeSymbol: this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM',
      tokenBalances: { USDC: 50000, USDT: 10000 },
      lastUpdated: new Date().toISOString(),
    };
  }
}

describe('Milestone 5: Admin Payout Controls, Retries & Audit Logging', () => {
  let sqlite: Database.Database;
  let mockDb: D1Database;
  let stellarMock: MockAdapter;
  let ethMock: MockAdapter;
  let solMock: MockAdapter;

  beforeEach(() => {
    sqlite = new Database(':memory:');

    // Create D1 tables matching 003_affiliate_schema and 023_multichain_payouts
    sqlite.exec(`
      CREATE TABLE profiles (
        id TEXT PRIMARY KEY,
        email TEXT UNIQUE,
        full_name TEXT,
        role TEXT DEFAULT 'affiliate',
        wallet_address TEXT,
        preferred_chain TEXT DEFAULT 'stellar'
      );

      CREATE TABLE payouts (
        id TEXT PRIMARY KEY,
        affiliate_id TEXT NOT NULL REFERENCES profiles(id),
        payout_method TEXT DEFAULT 'crypto',
        payout_method_details TEXT DEFAULT '{}',
        amount REAL NOT NULL,
        currency TEXT DEFAULT 'USD',
        fee REAL DEFAULT 0.00,
        net_amount REAL NOT NULL,
        status TEXT DEFAULT 'pending',
        scheduled_at TEXT,
        paid_at TEXT,
        transaction_id TEXT,
        notes TEXT,
        metadata TEXT DEFAULT '{}',
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now')),
        batch_id TEXT,
        chain TEXT DEFAULT 'stellar',
        idempotency_key TEXT,
        gas_fee_native REAL DEFAULT 0.00,
        gas_fee_usd REAL DEFAULT 0.00,
        error_message TEXT,
        retry_count INTEGER DEFAULT 0,
        last_retried_at TEXT
      );

      CREATE TABLE earnings (
        id TEXT PRIMARY KEY,
        affiliate_id TEXT NOT NULL REFERENCES profiles(id),
        amount REAL NOT NULL,
        is_paid INTEGER DEFAULT 0,
        paid_at TEXT,
        payout_id TEXT REFERENCES payouts(id),
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );

      CREATE TABLE payout_batches (
        id TEXT PRIMARY KEY,
        batch_number TEXT NOT NULL UNIQUE,
        status TEXT DEFAULT 'pending',
        chain TEXT,
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

      CREATE TABLE payout_audit_logs (
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

    mockDb = createMockD1Database(sqlite);
    (globalThis as any).DB = mockDb;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(mockDb);

    // Register mock adapters on router
    stellarMock = new MockAdapter('stellar');
    ethMock = new MockAdapter('ethereum');
    solMock = new MockAdapter('solana');

    payoutRouter.registerAdapter('stellar', stellarMock);
    payoutRouter.registerAdapter('ethereum', ethMock);
    payoutRouter.registerAdapter('solana', solMock);

    // Wire BatchSettlementService to mockDb
    (batchSettlementService as any).dbOverride = mockDb;
    (batchSettlementService as any).routerOverride = payoutRouter;

    // Seed admin profile
    sqlite.prepare(`
      INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
      VALUES ('admin_1', 'admin@apexos.app', 'Admin User', 'admin', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
    `).run();

    // Seed affiliate profiles
    sqlite.prepare(`
      INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
      VALUES ('aff_stellar', 'aff_xlm@example.com', 'Stellar Affiliate', 'affiliate', 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5', 'stellar')
    `).run();

    sqlite.prepare(`
      INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
      VALUES ('aff_eth', 'aff_eth@example.com', 'Ethereum Affiliate', 'affiliate', '0x742d35Cc6634C0532925a3b844Bc454e4438f44e', 'ethereum')
    `).run();

    sqlite.prepare(`
      INSERT INTO profiles (id, email, full_name, role, wallet_address, preferred_chain)
      VALUES ('aff_sol', 'aff_sol@example.com', 'Solana Affiliate', 'affiliate', '4Nd1mBQtrMJVYVfKf2PJy9NZ25gE267n79q4tK35wX8T', 'solana')
    `).run();

    // Default mock session to admin
    (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
      id: 'admin_1',
      email: 'admin@apexos.app',
    });
  });

  afterEach(() => {
    sqlite.close();
    jest.restoreAllMocks();
  });

  function createRequest(
    url: string,
    options?: { method?: string; body?: any; headers?: Record<string, string> }
  ): NextRequest {
    const init: RequestInit = {
      method: options?.method || (options?.body ? 'POST' : 'GET'),
      headers: {
        'content-type': 'application/json',
        'cf-connecting-ip': '198.51.100.25',
        ...options?.headers,
      },
    };
    if (options?.body) {
      init.body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
    }
    return new NextRequest(url, init);
  }

  // ==========================================================================
  // 1. Admin Auth & RBAC Guard
  // ==========================================================================
  describe('verifyAdminPayoutAccess (RBAC Guard)', () => {
    it('returns 503 when D1 database is unavailable', async () => {
      jest.spyOn(dbModule, 'getDB').mockImplementation(() => {
        throw new Error('Database not initialized');
      });
      delete (globalThis as any).DB;

      const req = createRequest('http://localhost:3000/api/admin/payouts/batch');
      const auth = await verifyAdminPayoutAccess(req);

      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(503);
      expect(auth.response.status).toBe(503);
      const data = await auth.response.json();
      expect(data.error).toBe('Database unavailable');
    });

    it('returns 401 when no session is present', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      const req = createRequest('http://localhost:3000/api/admin/payouts/batch');
      const auth = await verifyAdminPayoutAccess(req, mockDb);

      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(401);
      expect(auth.response.status).toBe(401);
      const data = await auth.response.json();
      expect(data.error).toBe('Unauthorized: Session required');
    });

    it('returns 403 when authenticated user is not an admin', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'aff_stellar',
        email: 'aff_xlm@example.com',
      });

      const req = createRequest('http://localhost:3000/api/admin/payouts/batch');
      const auth = await verifyAdminPayoutAccess(req, mockDb);

      expect(auth.authorized).toBe(false);
      expect(auth.status).toBe(403);
      expect(auth.response.status).toBe(403);
      const data = await auth.response.json();
      expect(data.error).toBe('Forbidden: Admin access required');
    });

    it('authorizes admin users and extracts client IP', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        headers: { 'cf-connecting-ip': '203.0.113.195' },
      });
      const auth = await verifyAdminPayoutAccess(req, mockDb);

      expect(auth.authorized).toBe(true);
      if (auth.authorized) {
        expect(auth.admin.id).toBe('admin_1');
        expect(auth.admin.email).toBe('admin@apexos.app');
        expect(auth.admin.role).toBe('admin');
        expect(auth.ipAddress).toBe('203.0.113.195');
      }
    });

    it('authorizes superadmin and super_admin roles', async () => {
      sqlite.prepare(`
        INSERT INTO profiles (id, email, role) VALUES ('super_1', 'super@apexos.app', 'superadmin')
      `).run();

      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'super_1',
        email: 'super@apexos.app',
      });

      const req = createRequest('http://localhost:3000/api/admin/payouts/batch');
      const auth = await verifyAdminPayoutAccess(req, mockDb);

      expect(auth.authorized).toBe(true);
      if (auth.authorized) {
        expect(auth.admin.role).toBe('superadmin');
      }
    });
  });

  // ==========================================================================
  // 2. POST /api/admin/payouts/batch
  // ==========================================================================
  describe('POST /api/admin/payouts/batch', () => {
    beforeEach(() => {
      // Seed earnings for affiliates
      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_xlm_1', 'aff_stellar', 100.0, 0)
      `).run();
      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_eth_1', 'aff_eth', 200.0, 0)
      `).run();
      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_sol_1', 'aff_sol', 75.0, 0)
      `).run();
    });

    it('enforces RBAC and rejects unauthenticated request with 401', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview' },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized: Session required');
    });

    it('enforces RBAC and rejects non-admin request with 403', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'aff_stellar',
      });

      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview' },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Forbidden: Admin access required');
    });

    it('rejects invalid JSON request body with 400', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: '{ malformed json',
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Invalid JSON request body');
    });

    it('rejects missing or invalid action with 400', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'invalid_action' },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Missing or invalid 'action'");
    });

    it('rejects invalid chain with 400', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview', chain: 'bitcoin' },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid 'chain'");
    });

    it('rejects negative minThreshold with 400', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview', minThreshold: -10 },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid 'minThreshold'");
    });

    it('previews batch dispatches without modifying database', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'preview', minThreshold: 50 },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.eligibleAffiliatesCount).toBe(3);
      expect(data.data.totalAmountUsd).toBe(375.0);
      expect(data.data.payoutsPreview).toHaveLength(3);

      // Verify no records inserted in DB
      const batchesCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM payout_batches').get() as any).count;
      expect(batchesCount).toBe(0);
      const payoutsCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM payouts').get() as any).count;
      expect(payoutsCount).toBe(0);
    });

    it('executes batch settlement, creates audit log and marks earnings paid', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'execute', minThreshold: 50 },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.status).toBe('completed');
      expect(data.data.successfulPayouts).toBe(3);
      expect(data.data.totalAmount).toBe(375.0);

      // Verify batch record in DB
      const batchRow = sqlite.prepare('SELECT * FROM payout_batches WHERE id = ?').get(data.data.batchId) as any;
      expect(batchRow).toBeDefined();
      expect(batchRow.status).toBe('completed');
      expect(batchRow.executed_by).toBe('admin_1');

      // Verify audit log recorded
      const auditLog = sqlite.prepare('SELECT * FROM payout_audit_logs WHERE batch_id = ?').get(data.data.batchId) as any;
      expect(auditLog).toBeDefined();
      expect(auditLog.action).toBe('batch_execution');
      expect(auditLog.admin_id).toBe('admin_1');
      expect(auditLog.ip_address).toBe('198.51.100.25');

      // Verify earnings marked paid
      const unpaidCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM earnings WHERE is_paid = 0').get() as any).count;
      expect(unpaidCount).toBe(0);
    });

    it('executes dryRun mode without modifying database tables', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'execute', dryRun: true },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.dryRun).toBe(true);
      expect(data.data.successfulPayouts).toBe(3);

      const batchesCount = (sqlite.prepare('SELECT COUNT(*) AS count FROM payout_batches').get() as any).count;
      expect(batchesCount).toBe(0);
    });

    it('filters batch execution by chain', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/batch', {
        body: { action: 'execute', chain: 'solana' },
      });
      const res = await batchRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.successfulPayouts).toBe(1);
      expect(data.data.totalAmount).toBe(75.0);
    });
  });

  // ==========================================================================
  // 3. POST /api/admin/payouts/retry
  // ==========================================================================
  describe('POST /api/admin/payouts/retry', () => {
    let failedPayoutId: string;

    beforeEach(() => {
      failedPayoutId = 'payout_failed_1';
      sqlite.prepare(`
        INSERT INTO payouts (
          id, affiliate_id, amount, net_amount, status, chain, error_message, payout_method_details
        ) VALUES (
          ?, 'aff_stellar', 100.0, 100.0, 'failed', 'stellar', 'Simulated failure',
          '{"walletAddress":"GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"}'
        )
      `).run(failedPayoutId);

      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid, payout_id)
        VALUES ('earn_retry_1', 'aff_stellar', 100.0, 0, ?)
      `).run(failedPayoutId);
    });

    it('enforces RBAC and rejects unauthenticated request with 401', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized: Session required');
    });

    it('enforces RBAC and rejects non-admin request with 403', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'aff_stellar',
      });

      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Forbidden: Admin access required');
    });

    it('rejects missing or empty payoutId with 400', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: '   ' },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.code).toBe('INVALID_REQUEST');
    });

    it('returns 404 when payout record is not found', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: 'nonexistent_payout_xyz' },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.code).toBe('PAYOUT_NOT_FOUND');
    });

    it('returns 409 when payout is not in failed status without force', async () => {
      sqlite.prepare("UPDATE payouts SET status = 'pending' WHERE id = ?").run(failedPayoutId);

      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId, force: false },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(409);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.code).toBe('INVALID_PAYOUT_STATUS');
    });

    it('returns 422 when circuit breaker halts retry', async () => {
      jest.spyOn(treasuryHealthService, 'canSettle').mockResolvedValueOnce({
        allowed: false,
        reason: 'Hot wallet reserve below safety floor',
      });

      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(422);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.code).toBe('CIRCUIT_BREAKER_HALTED');
    });

    it('successfully retries failed payout and records audit log', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId, notes: 'Retried after resolving network glitch' },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.status).toBe('confirmed');
      expect(data.data.transactionId).toBeDefined();

      // Verify payout updated to completed
      const payoutRow = sqlite.prepare('SELECT * FROM payouts WHERE id = ?').get(failedPayoutId) as any;
      expect(payoutRow.status).toBe('completed');
      expect(payoutRow.retry_count).toBe(1);

      // Verify audit log
      const auditLog = sqlite.prepare('SELECT * FROM payout_audit_logs WHERE payout_id = ?').get(failedPayoutId) as any;
      expect(auditLog).toBeDefined();
      expect(auditLog.action).toBe('retry');
    });

    it('records override audit log when force=true is used', async () => {
      sqlite.prepare("UPDATE payouts SET status = 'pending' WHERE id = ?").run(failedPayoutId);

      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId, force: true, notes: 'Emergency operator bypass' },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Verify override audit log
      const overrideLog = sqlite.prepare(
        "SELECT * FROM payout_audit_logs WHERE payout_id = ? AND action = 'override'"
      ).get(failedPayoutId) as any;
      expect(overrideLog).toBeDefined();
      expect(overrideLog.admin_id).toBe('admin_1');
    });

    it('returns existing transaction idempotently if payout is already completed', async () => {
      sqlite.prepare(`
        UPDATE payouts
        SET status = 'completed', transaction_id = 'existing_tx_123', paid_at = datetime('now')
        WHERE id = ?
      `).run(failedPayoutId);

      const req = createRequest('http://localhost:3000/api/admin/payouts/retry', {
        body: { payoutId: failedPayoutId },
      });
      const res = await retryRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.transactionId).toBe('existing_tx_123');
    });
  });

  // ==========================================================================
  // 4. GET /api/admin/payouts/treasury
  // ==========================================================================
  describe('GET /api/admin/payouts/treasury', () => {
    beforeEach(() => {
      // Seed pending queues: earnings, pending batch, in-flight payout
      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_q_1', 'aff_stellar', 120.0, 0)
      `).run();
      sqlite.prepare(`
        INSERT INTO earnings (id, affiliate_id, amount, is_paid)
        VALUES ('earn_q_2', 'aff_eth', 340.5, 0)
      `).run();

      sqlite.prepare(`
        INSERT INTO payout_batches (id, batch_number, status, chain, total_payouts, total_amount)
        VALUES ('batch_q_1', 'BATCH-PENDING-001', 'pending', 'all', 2, 460.5)
      `).run();

      sqlite.prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, chain)
        VALUES ('payout_q_1', 'aff_stellar', 120.0, 120.0, 'processing', 'stellar')
      `).run();
    });

    it('enforces RBAC and rejects unauthenticated request with 401', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      const req = createRequest('http://localhost:3000/api/admin/payouts/treasury');
      const res = await treasuryRoute(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Unauthorized: Session required');
    });

    it('enforces RBAC and rejects non-admin request with 403', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'aff_stellar',
      });

      const req = createRequest('http://localhost:3000/api/admin/payouts/treasury');
      const res = await treasuryRoute(req);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toBe('Forbidden: Admin access required');
    });

    it('rejects invalid chain filter query parameter with 400', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/treasury?chain=cardano');
      const res = await treasuryRoute(req);

      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain("Invalid 'chain' parameter");
    });

    it('returns treasury health report and pending settlement queues', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/treasury');
      const res = await treasuryRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Verify Supply side (treasuryHealth)
      expect(data.data.treasuryHealth).toBeDefined();
      expect(data.data.treasuryHealth.globalStatus).toBe('HEALTHY');
      expect(data.data.treasuryHealth.canSettle).toBe(true);

      // Verify Demand side (pendingQueues)
      expect(data.data.pendingQueues).toBeDefined();

      // Unpaid earnings
      const unpaid = data.data.pendingQueues.unpaidEarnings;
      expect(unpaid.totalCount).toBe(2);
      expect(unpaid.totalAmount).toBe(460.5);
      expect(unpaid.byChain.stellar.totalAmount).toBe(120.0);
      expect(unpaid.byChain.ethereum.totalAmount).toBe(340.5);

      // Pending batches
      const batches = data.data.pendingQueues.pendingBatches;
      expect(batches.pendingCount).toBe(1);
      expect(batches.totalPendingCount).toBe(1);

      // In-flight payouts
      const inFlight = data.data.pendingQueues.inFlightPayouts;
      expect(inFlight.totalCount).toBe(1);
      expect(inFlight.totalAmount).toBe(120.0);
      expect(inFlight.byChain.stellar.processingCount).toBe(1);
    });

    it('filters treasury inspection by chain', async () => {
      const req = createRequest('http://localhost:3000/api/admin/payouts/treasury?chain=stellar');
      const res = await treasuryRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.treasuryHealth.chains.stellar).toBeDefined();
    });

    it('handles empty queues gracefully', async () => {
      sqlite.exec('DELETE FROM earnings; DELETE FROM payout_batches; DELETE FROM payouts;');

      const req = createRequest('http://localhost:3000/api/admin/payouts/treasury');
      const res = await treasuryRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.data.pendingQueues.unpaidEarnings.totalCount).toBe(0);
      expect(data.data.pendingQueues.pendingBatches.totalPendingCount).toBe(0);
      expect(data.data.pendingQueues.inFlightPayouts.totalCount).toBe(0);
    });
  });
});
