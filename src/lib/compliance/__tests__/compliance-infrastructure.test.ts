/**
 * src/lib/compliance/__tests__/compliance-infrastructure.test.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Milestone 1: Core Compliance Infrastructure & Settlement Engine Test Suite
 *
 * Covers:
 * 1. Migration 024 DDL, constraints, case-insensitivity, and immutability triggers
 * 2. KYC Tiers, limits ($500, $2,500, $50,000), and cumulative volume calculations
 * 3. ComplianceAuditService logging, batch statements, and immutable audit queries
 * 4. SanctionsScreeningService address normalization across Ethereum, Solana, and Stellar
 * 5. Pre-populated watchlist screening and dynamic D1 database lookup
 * 6. PayoutRouter synchronous pre-flight sanctions gate
 * 7. BatchSettlementService 30-day cumulative volume query and tier hold enforcement
 * 8. BatchSettlementService pre-flight sanctions gate and critical audit logging
 * 9. Anti-circumvention (smurfing) defense across multiple payouts
 * 10. Retry compliance safeguards
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import {
  getKycTierLimit,
  isTierLimitExceeded,
  KYC_TIER_LIMITS,
  type KycTier,
  type ComplianceAuditEntry,
} from '../types';
import { ComplianceAuditService } from '../audit-service';
import { SanctionsScreeningService } from '../sanctions-service';
import { PayoutRouter } from '@/lib/payouts/router';
import {
  BatchSettlementService,
  toCents,
  fromCents,
} from '@/lib/payouts/batch-settlement-service';
import { TreasuryHealthService } from '@/lib/payouts/treasury-health-service';
import { PayoutAuditService } from '@/lib/payouts/audit-service';
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
} from '@/lib/payouts/types';

// ============================================================================
// Mock D1 Database & SQLite Test Harness
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

function initializeComplianceSchema(sqlite: Database.Database): void {
  // 1. Prerequisites: profiles, payouts, earnings, payout_batches, payout_audit_logs
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      full_name TEXT,
      role TEXT DEFAULT 'affiliate',
      wallet_address TEXT,
      preferred_chain TEXT
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
      status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled', 'kyc_required', 'compliance_blocked')),
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

  // 2. Run Migration 024 directly from SQL file
  const migrationPath = path.resolve(
    __dirname,
    '../../../database/migrations/024_kyc_compliance_schema.sql'
  );
  const migrationSql = fs.readFileSync(migrationPath, 'utf8');
  sqlite.exec(migrationSql);
}

// ============================================================================
// Mock Chain Adapter
// ============================================================================

class MockChainAdapter implements PayoutChainAdapter {
  public sendHandler?: (params: PayoutExecutionParams) => Promise<PayoutExecutionResult>;
  public estimateHandler?: (params: FeeEstimateParams) => Promise<ChainFeeEstimate>;

  constructor(public readonly chain: SupportedPayoutChain) {}

  validateAddress(address: string): boolean {
    if (!address || typeof address !== 'string') return false;
    if (this.chain === 'ethereum') return /^0x[0-9a-fA-F]{40}$/.test(address);
    if (this.chain === 'stellar') return /^G[A-Z2-7]{55}$/.test(address);
    if (this.chain === 'solana') return address.length >= 32 && address.length <= 44;
    return false;
  }

  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    if (this.estimateHandler) return this.estimateHandler(params);
    return {
      chain: this.chain,
      nativeFeeAmount: 0.001,
      nativeFeeSymbol: this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM',
      feeUsd: 0.1,
      gasUnitsOrLimit: 21000,
      pricePerUnit: '10',
    };
  }

  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (this.sendHandler) return this.sendHandler(params);
    return {
      success: true,
      payoutId: params.payoutId,
      chain: this.chain,
      toAddress: params.recipientAddress,
      amount: params.amount,
      token: 'USDC',
      transactionId: `mock_tx_${this.chain}_${params.payoutId}`,
      gasFeeNative: 0.001,
      gasFeeUsd: 0.1,
      status: 'confirmed',
      timestamp: new Date().toISOString(),
    };
  }

  async verifyTransaction(transactionId: string): Promise<TransactionVerificationResult> {
    return {
      verified: true,
      status: 'confirmed',
      transactionId,
    };
  }

  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    return {
      chain: this.chain,
      hotWalletAddress: 'mock_hot_wallet',
      nativeBalance: 100,
      nativeSymbol: this.chain === 'ethereum' ? 'ETH' : this.chain === 'solana' ? 'SOL' : 'XLM',
      tokenBalances: { USDC: 50000 },
      lastUpdated: new Date().toISOString(),
    };
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('KYC & Regulatory Compliance Engine — Milestone 1 Infrastructure', () => {
  let sqlite: Database.Database;
  let d1: D1Database;
  let auditService: ComplianceAuditService;
  let sanctionsService: SanctionsScreeningService;
  let ethAdapter: MockChainAdapter;
  let stellarAdapter: MockChainAdapter;
  let solAdapter: MockChainAdapter;
  let router: PayoutRouter;
  let settlementService: BatchSettlementService;
  let healthService: TreasuryHealthService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    initializeComplianceSchema(sqlite);
    d1 = createMockD1Database(sqlite);

    auditService = new ComplianceAuditService();
    sanctionsService = new SanctionsScreeningService();

    ethAdapter = new MockChainAdapter('ethereum');
    stellarAdapter = new MockChainAdapter('stellar');
    solAdapter = new MockChainAdapter('solana');

    router = new PayoutRouter(
      {
        ethereum: ethAdapter,
        stellar: stellarAdapter,
        solana: solAdapter,
      },
      sanctionsService
    );

    healthService = new TreasuryHealthService(undefined, router);
    jest.spyOn(healthService, 'checkHealth').mockResolvedValue({
      globalStatus: 'HEALTHY',
      canSettle: true,
      checkedAt: new Date().toISOString(),
      chains: {} as any,
      warnings: [],
      errors: [],
    });
    jest.spyOn(healthService, 'canSettle').mockResolvedValue({
      allowed: true,
      report: {
        globalStatus: 'HEALTHY',
        canSettle: true,
        checkedAt: new Date().toISOString(),
        chains: {} as any,
        warnings: [],
        errors: [],
      },
    });

    settlementService = new BatchSettlementService({
      db: d1,
      router,
      healthService,
      auditService: new PayoutAuditService(d1),
      complianceAuditService: auditService,
      sanctionsService,
    });
  });

  afterEach(() => {
    sqlite.close();
    jest.restoreAllMocks();
  });

  // --------------------------------------------------------------------------
  // 1. Migration 024 Schema & Trigger Immutability
  // --------------------------------------------------------------------------

  describe('Migration 024 Schema & SQLite Triggers', () => {
    it('extends profiles with kyc_status, kyc_tier, and kyc_verified_at', () => {
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, kyc_status, kyc_tier) VALUES ('user1', 'u1@test.com', 'unverified', 'tier0_unverified')"
        )
        .run();
      const profile = sqlite.prepare('SELECT * FROM profiles WHERE id = ?').get('user1') as any;
      expect(profile.kyc_status).toBe('unverified');
      expect(profile.kyc_tier).toBe('tier0_unverified');
      expect(profile.kyc_verified_at).toBeNull();
    });

    it('prohibits UPDATE operations on compliance_audit_logs via trigger', () => {
      sqlite
        .prepare(
          "INSERT INTO compliance_audit_logs (id, action, severity, details) VALUES ('cal_1', 'kyc_tier_hold', 'medium', '{}')"
        )
        .run();

      expect(() => {
        sqlite
          .prepare("UPDATE compliance_audit_logs SET action = 'tampered' WHERE id = 'cal_1'")
          .run();
      }).toThrow(/compliance_audit_logs records are immutable and cannot be updated\/deleted/);
    });

    it('prohibits DELETE operations on compliance_audit_logs via trigger', () => {
      sqlite
        .prepare(
          "INSERT INTO compliance_audit_logs (id, action, severity, details) VALUES ('cal_2', 'sanctions_block', 'critical', '{}')"
        )
        .run();

      expect(() => {
        sqlite.prepare("DELETE FROM compliance_audit_logs WHERE id = 'cal_2'").run();
      }).toThrow(/compliance_audit_logs records are immutable and cannot be updated\/deleted/);
    });

    it('enforces case-insensitive uniqueness on sanctioned_addresses (chain, address)', () => {
      sqlite
        .prepare(
          "INSERT INTO sanctioned_addresses (address, chain, source) VALUES ('0xabc1234567890123456789012345678901234567', 'ethereum', 'OFAC')"
        )
        .run();

      expect(() => {
        sqlite
          .prepare(
            "INSERT INTO sanctioned_addresses (address, chain, source) VALUES ('0xABC1234567890123456789012345678901234567', 'ethereum', 'Duplicate')"
          )
          .run();
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('verifies pre-populated OFAC SDN entries exist in sanctioned_addresses', () => {
      const tornadoRouter = sqlite
        .prepare(
          "SELECT * FROM sanctioned_addresses WHERE chain = 'ethereum' AND address = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b'"
        )
        .get();
      expect(tornadoRouter).toBeDefined();

      const lazarus = sqlite
        .prepare(
          "SELECT * FROM sanctioned_addresses WHERE chain = 'ethereum' AND address = '0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a'"
        )
        .get();
      expect(lazarus).toBeDefined();

      const stellarSanctioned = sqlite
        .prepare(
          "SELECT * FROM sanctioned_addresses WHERE chain = 'stellar' AND address = 'GARF4Z2QYF477XG2LFFXZN2C77X6QXXZ5N4YFXG6Q6NXWNZG6Q6NXWNZ'"
        )
        .get();
      expect(stellarSanctioned).toBeDefined();
    });
  });

  // --------------------------------------------------------------------------
  // 2. KYC Tiers, Limits, and Calculations
  // --------------------------------------------------------------------------

  describe('KYC Tiers and Tier Limits Rules', () => {
    it('returns correct 30-day cumulative limit for each tier', () => {
      expect(getKycTierLimit('tier0_unverified')).toBe(500.0);
      expect(getKycTierLimit('tier1_basic')).toBe(2500.0);
      expect(getKycTierLimit('tier2_enhanced')).toBe(50000.0);
      expect(getKycTierLimit(undefined)).toBe(500.0);
      expect(getKycTierLimit(null)).toBe(500.0);
      expect(getKycTierLimit('unverified')).toBe(500.0);
      expect(getKycTierLimit('basic')).toBe(2500.0);
      expect(getKycTierLimit('enhanced')).toBe(50000.0);
    });

    it('accurately checks ceiling breaches with floating point precision safety', () => {
      // Unverified tier ($500.00 ceiling)
      expect(isTierLimitExceeded(0, 499.99, 'tier0_unverified')).toBe(false);
      expect(isTierLimitExceeded(0, 500.0, 'tier0_unverified')).toBe(false);
      expect(isTierLimitExceeded(0, 500.01, 'tier0_unverified')).toBe(true);

      // Cumulative across days
      expect(isTierLimitExceeded(450.0, 50.0, 'tier0_unverified')).toBe(false);
      expect(isTierLimitExceeded(450.0, 50.01, 'tier0_unverified')).toBe(true);
      expect(isTierLimitExceeded(480.0, 20.0, 'tier0_unverified')).toBe(false);
      expect(isTierLimitExceeded(480.0, 20.01, 'tier0_unverified')).toBe(true);

      // Float boundary test: 19.99 + 30.01 = 50.00
      expect(isTierLimitExceeded(19.99, 30.01, 'tier0_unverified')).toBe(false);

      // Tier 1 ($2,500.00 limit)
      expect(isTierLimitExceeded(2000.0, 500.0, 'tier1_basic')).toBe(false);
      expect(isTierLimitExceeded(2000.0, 500.01, 'tier1_basic')).toBe(true);

      // Tier 2 ($50,000.00 limit)
      expect(isTierLimitExceeded(40000.0, 10000.0, 'tier2_enhanced')).toBe(false);
      expect(isTierLimitExceeded(45000.0, 6000.0, 'tier2_enhanced')).toBe(true);
    });
  });

  // --------------------------------------------------------------------------
  // 3. ComplianceAuditService
  // --------------------------------------------------------------------------

  describe('ComplianceAuditService', () => {
    it('persists audit entry with immutable timestamps and details', async () => {
      await auditService.log(d1, {
        action: 'kyc_tier_hold',
        severity: 'medium',
        actorId: 'admin_1',
        targetId: 'payout_123',
        details: { cumulativeVolume: 650.0, limit: 500.0 },
      });

      const logs = await auditService.getAuditLogs(d1);
      expect(logs.total).toBe(1);
      expect(logs.data[0].action).toBe('kyc_tier_hold');
      expect(logs.data[0].severity).toBe('medium');
      expect(logs.data[0].actor_id).toBe('admin_1');
      expect(logs.data[0].target_id).toBe('payout_123');

      const details = JSON.parse(logs.data[0].details);
      expect(details.cumulativeVolume).toBe(650.0);
    });

    it('creates prepared statement compatible with db.batch atomic transactions', async () => {
      const stmt1 = auditService.createAuditStatement(d1, {
        action: 'sanctions_block',
        severity: 'critical',
        targetId: 'payout_456',
        details: { reason: 'OFAC SDN' },
      });

      const stmt2 = d1
        .prepare("INSERT INTO profiles (id, email) VALUES ('user_batch', 'ub@test.com')");

      await d1.batch([stmt1, stmt2]);

      const logs = await auditService.getAuditLogs(d1, { severity: 'critical' });
      expect(logs.total).toBe(1);
      expect(logs.data[0].action).toBe('sanctions_block');

      const profile = await d1
        .prepare('SELECT id FROM profiles WHERE id = ?')
        .bind('user_batch')
        .first();
      expect(profile).toBeDefined();
    });

    it('filters audit logs by action, severity, targetId, and pagination', async () => {
      await auditService.log(d1, {
        action: 'kyc_tier_hold',
        severity: 'medium',
        targetId: 'target_A',
        details: {},
      });
      await auditService.log(d1, {
        action: 'sanctions_block',
        severity: 'critical',
        targetId: 'target_B',
        details: {},
      });
      await auditService.log(d1, {
        action: 'admin_override',
        severity: 'high',
        targetId: 'target_A',
        details: {},
      });

      const byAction = await auditService.getAuditLogs(d1, { action: 'sanctions_block' });
      expect(byAction.total).toBe(1);
      expect(byAction.data[0].target_id).toBe('target_B');

      const byTarget = await auditService.getAuditLogs(d1, { targetId: 'target_A' });
      expect(byTarget.total).toBe(2);

      const paginated = await auditService.getAuditLogs(d1, { limit: 1, page: 2 });
      expect(paginated.data.length).toBe(1);
      expect(paginated.totalPages).toBe(3);
    });
  });

  // --------------------------------------------------------------------------
  // 4. SanctionsScreeningService Address Normalization & Screening
  // --------------------------------------------------------------------------

  describe('SanctionsScreeningService', () => {
    it('normalizes Ethereum addresses to lowercase', () => {
      const mixed = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
      const normalized = sanctionsService.normalizeAddress(mixed, 'ethereum');
      expect(normalized).toBe(mixed.toLowerCase());
    });

    it('validates and preserves Solana Base58 32-byte public keys', () => {
      const solAddr = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
      const normalized = sanctionsService.normalizeAddress(solAddr, 'solana');
      expect(normalized).toBe(solAddr);
    });

    it('normalizes Stellar public keys to uppercase RFC 4648 Base32', () => {
      const stellarAddr = 'garf4z2qyf477xg2lffxzn2c77x6qxxz5n4yfxg6q6nxwnzg6q6nxwnz';
      const normalized = sanctionsService.normalizeAddress(stellarAddr, 'stellar');
      expect(normalized).toBe(stellarAddr.toUpperCase());
    });

    it('rejects malformed addresses with descriptive validation errors', () => {
      expect(() => sanctionsService.normalizeAddress('invalid_eth', 'ethereum')).toThrow(
        /Invalid Ethereum address/
      );
      expect(() => sanctionsService.normalizeAddress('short_sol', 'solana')).toThrow(
        /Invalid Solana address/
      );
      expect(() => sanctionsService.normalizeAddress('not_stellar', 'stellar')).toThrow(
        /Invalid Stellar address/
      );
    });

    it('identifies sanctioned Ethereum addresses (OFAC SDN - Tornado Cash)', async () => {
      const tornadoCash = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b';
      const result = await sanctionsService.checkAddress(tornadoCash, 'ethereum');
      expect(result.isSanctioned).toBe(true);
      expect(result.reason).toContain('Tornado Cash');
      expect(result.riskScore).toBe(1.0);
    });

    it('performs case-insensitive screening on Ethereum addresses', async () => {
      const tornadoUpper = '0xD90E2F925DA726B50C4ED8D0FB90AD053324F31B';
      const result = await sanctionsService.checkAddress(tornadoUpper, 'ethereum');
      expect(result.isSanctioned).toBe(true);
    });

    it('identifies sanctioned Solana and Stellar addresses', async () => {
      const solSanctioned = '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM';
      const solResult = await sanctionsService.checkAddress(solSanctioned, 'solana');
      expect(solResult.isSanctioned).toBe(true);

      const stellarSanctioned = 'GARF4Z2QYF477XG2LFFXZN2C77X6QXXZ5N4YFXG6Q6NXWNZG6Q6NXWNZ';
      const stellarResult = await sanctionsService.checkAddress(stellarSanctioned, 'stellar');
      expect(stellarResult.isSanctioned).toBe(true);
    });

    it('returns clean result for non-sanctioned address', async () => {
      const cleanEth = '0x1111111111111111111111111111111111111111';
      const result = await sanctionsService.checkAddress(cleanEth, 'ethereum');
      expect(result.isSanctioned).toBe(false);
    });

    it('dynamically queries and caches D1 sanctioned_addresses additions', async () => {
      const dynamicAddr = '0x2222222222222222222222222222222222222222';
      // Initially clean
      expect((await sanctionsService.checkAddress(dynamicAddr, 'ethereum', d1)).isSanctioned).toBe(
        false
      );

      // Add to D1
      await sanctionsService.addSanctionedAddress(d1, {
        address: dynamicAddr,
        chain: 'ethereum',
        source: 'Court Order #999',
        riskScore: 0.95,
      });

      // Now sanctioned via D1 and cached
      const checkRes = await sanctionsService.checkAddress(dynamicAddr, 'ethereum', d1);
      expect(checkRes.isSanctioned).toBe(true);
      expect(checkRes.source).toBe('Court Order #999');
      expect(checkRes.riskScore).toBe(0.95);
    });
  });

  // --------------------------------------------------------------------------
  // 5. PayoutRouter Pre-Flight Sanctions Gate
  // --------------------------------------------------------------------------

  describe('PayoutRouter Pre-Flight Sanctions Gate', () => {
    it('aborts on-chain dispatch immediately if recipient address is sanctioned', async () => {
      const sanctionedEth = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b';
      const sendPayoutSpy = jest.spyOn(ethAdapter, 'sendPayout');

      const execResult = await router.sendPayout('ethereum', {
        payoutId: 'payout_sanctioned_router',
        affiliateId: 'aff_1',
        recipientAddress: sanctionedEth,
        amount: 150.0,
        idempotencyKey: 'idemp_router_sanctioned',
      });

      expect(execResult.success).toBe(false);
      expect(execResult.status).toBe('failed');
      expect(execResult.error).toContain('Pre-flight sanctions check failed');
      // Adapter must strictly NEVER be called!
      expect(sendPayoutSpy).not.toHaveBeenCalled();
    });

    it('allows clean recipient address to dispatch normally via adapter', async () => {
      const cleanEth = '0x1111111111111111111111111111111111111111';
      const sendPayoutSpy = jest.spyOn(ethAdapter, 'sendPayout');

      const execResult = await router.sendPayout('ethereum', {
        payoutId: 'payout_clean_router',
        affiliateId: 'aff_clean',
        recipientAddress: cleanEth,
        amount: 150.0,
        idempotencyKey: 'idemp_router_clean',
      });

      expect(execResult.success).toBe(true);
      expect(execResult.status).toBe('confirmed');
      expect(sendPayoutSpy).toHaveBeenCalledTimes(1);
    });
  });

  // --------------------------------------------------------------------------
  // 6. BatchSettlementService Tiered Limits & KYC Hold
  // --------------------------------------------------------------------------

  describe('BatchSettlementService — Tier Limits & KYC Hold', () => {
    it('settles payouts under $500 cleanly for tier0_unverified user', async () => {
      // Create affiliate with $100 earnings
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain, kyc_tier) VALUES ('aff_under_500', 'u500@test.com', '0x1111111111111111111111111111111111111111', 'ethereum', 'tier0_unverified')"
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e1', 'aff_under_500', 100.0, 0)"
        )
        .run();

      const batchRes = await settlementService.executeBatch({ chain: 'ethereum' });
      expect(batchRes.successfulPayouts).toBe(1);
      expect(batchRes.failedPayouts).toBe(0);

      // Verify payout is completed and compliance_status is clean
      const payout = sqlite
        .prepare("SELECT * FROM payouts WHERE affiliate_id = 'aff_under_500'")
        .get() as any;
      expect(payout.status).toBe('completed');
      expect(payout.compliance_status).toBe('clean');

      // Verify earnings marked paid
      const earning = sqlite.prepare("SELECT * FROM earnings WHERE id = 'e1'").get() as any;
      expect(earning.is_paid).toBe(1);
    });

    it('holds payout exceeding $500 with kyc_required and KYC_TIER_LIMIT_EXCEEDED without on-chain broadcast', async () => {
      const sendPayoutSpy = jest.spyOn(ethAdapter, 'sendPayout');

      // Create unverified affiliate with $650 earnings (exceeds $500 ceiling)
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain, kyc_tier) VALUES ('aff_over_500', 'over500@test.com', '0x2222222222222222222222222222222222222222', 'ethereum', 'tier0_unverified')"
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_over_1', 'aff_over_500', 650.0, 0)"
        )
        .run();

      const batchRes = await settlementService.executeBatch({ chain: 'ethereum' });
      expect(batchRes.failedPayouts).toBe(1);
      expect(batchRes.successfulPayouts).toBe(0);

      // Adapter must NOT be called for held payout!
      expect(sendPayoutSpy).not.toHaveBeenCalled();

      // Verify payout record in DB is held with compliance_status = kyc_required
      const payout = sqlite
        .prepare("SELECT * FROM payouts WHERE affiliate_id = 'aff_over_500'")
        .get() as any;
      expect(payout).toBeDefined();
      expect(payout.compliance_status).toBe('kyc_required');
      expect(payout.compliance_reason).toBe('KYC_TIER_LIMIT_EXCEEDED');

      // Verify audit log entry in compliance_audit_logs
      const auditLog = sqlite
        .prepare("SELECT * FROM compliance_audit_logs WHERE action = 'kyc_tier_hold'")
        .get() as any;
      expect(auditLog).toBeDefined();
      expect(auditLog.severity).toBe('medium');
      expect(auditLog.target_id).toBe(payout.id);

      const details = JSON.parse(auditLog.details);
      expect(details.tierLimit).toBe(500.0);
      expect(details.kycTier).toBe('tier0_unverified');
    });

    it('enforces rolling 30-day cumulative limit across prior batches (anti-smurfing)', async () => {
      // Unverified affiliate already has $450 in payouts in the last 10 days
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain, kyc_tier) VALUES ('aff_smurfer', 'smurf@test.com', '0x3333333333333333333333333333333333333333', 'ethereum', 'tier0_unverified')"
        )
        .run();

      sqlite
        .prepare(`
          INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, compliance_status, created_at)
          VALUES ('p_prior_1', 'aff_smurfer', 450.0, 450.0, 'completed', 'clean', datetime('now', '-5 days'))
        `)
        .run();

      // New pending earnings of $100 -> Cumulative = 450 + 100 = $550 > $500 limit
      sqlite
        .prepare(
          "INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_smurf_new', 'aff_smurfer', 100.0, 0)"
        )
        .run();

      const batchRes = await settlementService.executeBatch({ chain: 'ethereum' });
      expect(batchRes.failedPayouts).toBe(1);

      const payout = sqlite
        .prepare("SELECT * FROM payouts WHERE id != 'p_prior_1' AND affiliate_id = 'aff_smurfer'")
        .get() as any;
      expect(payout.compliance_status).toBe('kyc_required');
      expect(payout.compliance_reason).toBe('KYC_TIER_LIMIT_EXCEEDED');
    });

    it('allows tier2_enhanced user to settle high volume payouts ($15,000) seamlessly', async () => {
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain, kyc_tier, kyc_status) VALUES ('aff_tier2', 'vip@test.com', '0x4444444444444444444444444444444444444444', 'ethereum', 'tier2_enhanced', 'approved')"
        )
        .run();
      sqlite
        .prepare(
          "INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_vip', 'aff_tier2', 15000.0, 0)"
        )
        .run();

      const batchRes = await settlementService.executeBatch({ chain: 'ethereum' });
      expect(batchRes.successfulPayouts).toBe(1);
      expect(batchRes.failedPayouts).toBe(0);

      const payout = sqlite
        .prepare("SELECT * FROM payouts WHERE affiliate_id = 'aff_tier2'")
        .get() as any;
      expect(payout.status).toBe('completed');
      expect(payout.compliance_status).toBe('clean');
    });
  });

  // --------------------------------------------------------------------------
  // 7. BatchSettlementService Pre-Flight Sanctions Screening
  // --------------------------------------------------------------------------

  describe('BatchSettlementService — Pre-Flight Sanctions Screening', () => {
    it('aborts settlement for sanctioned address, marks compliance_blocked, and writes critical audit log', async () => {
      const sendPayoutSpy = jest.spyOn(ethAdapter, 'sendPayout');

      // Tornado Cash router address
      const tornadoRouter = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b';

      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain, kyc_tier) VALUES ('aff_sanctioned', 'bad@test.com', ?, 'ethereum', 'tier0_unverified')"
        )
        .run(tornadoRouter);
      sqlite
        .prepare(
          "INSERT INTO earnings (id, affiliate_id, amount, is_paid) VALUES ('e_bad_1', 'aff_sanctioned', 75.0, 0)"
        )
        .run();

      const batchRes = await settlementService.executeBatch({ chain: 'ethereum' });
      expect(batchRes.failedPayouts).toBe(1);
      expect(batchRes.successfulPayouts).toBe(0);

      // On-chain adapter MUST NEVER be called!
      expect(sendPayoutSpy).not.toHaveBeenCalled();

      // Payout status must be compliance_blocked
      const payout = sqlite
        .prepare("SELECT * FROM payouts WHERE affiliate_id = 'aff_sanctioned'")
        .get() as any;
      expect(payout.compliance_status).toBe('compliance_blocked');
      expect(payout.compliance_reason).toBe('SANCTIONED_ADDRESS');

      // Critical audit log must be written
      const auditLog = sqlite
        .prepare("SELECT * FROM compliance_audit_logs WHERE action = 'sanctions_block'")
        .get() as any;
      expect(auditLog).toBeDefined();
      expect(auditLog.severity).toBe('critical');
      expect(auditLog.target_id).toBe(payout.id);
    });

    it('rejects retrying a compliance_blocked payout', async () => {
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain) VALUES ('aff_blocked', 'bl@test.com', '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', 'ethereum')"
        )
        .run();

      sqlite
        .prepare(`
          INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, compliance_status, compliance_reason, chain, payout_method_details)
          VALUES ('p_blocked_1', 'aff_blocked', 100.0, 100.0, 'failed', 'compliance_blocked', 'SANCTIONED_ADDRESS', 'ethereum', '{"address":"0xd90e2f925da726b50c4ed8d0fb90ad053324f31b"}')
        `)
        .run();

      const retryRes = await settlementService.retryPayout('p_blocked_1');
      expect(retryRes.success).toBe(false);
      expect(retryRes.error).toMatch(/compliance blocked|sanctions/);
    });

    it('rejects retrying a payout when cumulative 30-day volume exceeds KYC tier limit', async () => {
      sqlite
        .prepare(
          "INSERT INTO profiles (id, email, wallet_address, preferred_chain, kyc_tier) VALUES ('aff_retry_kyc', 'rkyc@test.com', '0x5555555555555555555555555555555555555555', 'ethereum', 'tier0_unverified')"
        )
        .run();

      sqlite
        .prepare(`
          INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, compliance_status, compliance_reason, chain, payout_method_details)
          VALUES ('p_retry_held', 'aff_retry_kyc', 800.0, 800.0, 'failed', 'kyc_required', 'KYC_TIER_LIMIT_EXCEEDED', 'ethereum', '{"address":"0x5555555555555555555555555555555555555555"}')
        `)
        .run();

      const retryRes = await settlementService.retryPayout('p_retry_held');
      expect(retryRes.success).toBe(false);
      expect(retryRes.error).toContain('exceeds KYC limit');
    });
  });
});
