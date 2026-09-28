/**
 * src/lib/compliance/__tests__/admin-compliance-routes.test.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Milestone 2: Admin Compliance API Endpoints & RBAC Test Suite
 *
 * Covers:
 * 1. Admin RBAC guard enforcement: 401 unauthenticated, 403 non-admin role
 * 2. GET /api/admin/compliance/payouts: holds inspection, profile join, filters, KPIs, audit view
 * 3. POST /api/admin/compliance/review: validation, actions (approve/override, reject, reverify, flag_address)
 * 4. Atomic dual-writes to payouts/profiles and compliance_audit_logs via db.batch
 * 5. GET/POST/DELETE /api/admin/compliance/sanctions: CRUD, normalization, audit logs
 * 6. SQLite trigger immutability: verifies BEFORE UPDATE and BEFORE DELETE triggers abort
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
import { GET as getPayoutsRoute } from '@/app/api/admin/compliance/payouts/route';
import { POST as reviewRoute } from '@/app/api/admin/compliance/review/route';
import {
  GET as getSanctionsRoute,
  POST as postSanctionsRoute,
  DELETE as deleteSanctionsRoute,
} from '@/app/api/admin/compliance/sanctions/route';

// Mock session helper
jest.mock('@/lib/auth/session-helper', () => {
  const actual = jest.requireActual('@/lib/auth/session-helper');
  return {
    ...actual,
    getAuthenticatedUser: jest.fn(),
  };
});

interface InternalPreparedStatement extends D1PreparedStatement {
  _runSync: () => D1Result<any>;
}

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
      const runTx = sqlite.transaction(() => {
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

      return runTx();
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

function initializeDatabaseSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE,
      full_name TEXT,
      role TEXT DEFAULT 'affiliate',
      wallet_address TEXT,
      preferred_chain TEXT DEFAULT 'ethereum',
      kyc_status TEXT DEFAULT 'unverified',
      kyc_tier TEXT DEFAULT 'tier0_unverified',
      kyc_verified_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS payouts (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL REFERENCES profiles(id),
      batch_id TEXT,
      chain TEXT DEFAULT 'ethereum',
      payout_method TEXT DEFAULT 'crypto',
      payout_method_details TEXT DEFAULT '{}',
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      fee REAL DEFAULT 0.00,
      net_amount REAL NOT NULL,
      status TEXT DEFAULT 'pending',
      compliance_status TEXT DEFAULT 'clean',
      compliance_reason TEXT,
      scheduled_at TEXT,
      paid_at TEXT,
      transaction_id TEXT,
      notes TEXT,
      metadata TEXT DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sanctioned_addresses (
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      source TEXT,
      risk_score REAL DEFAULT 1.0,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chain, address)
    );

    CREATE TABLE IF NOT EXISTS compliance_audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      severity TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      details TEXT NOT NULL DEFAULT '{}',
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TRIGGER IF NOT EXISTS trg_audit_no_up
    BEFORE UPDATE ON compliance_audit_logs FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'compliance_audit_logs records are immutable and cannot be updated/deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_no_del
    BEFORE DELETE ON compliance_audit_logs FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'compliance_audit_logs records are immutable and cannot be updated/deleted'); END;
  `);
}

describe('Admin Compliance Routes & RBAC Test Suite', () => {
  let sqlite: Database.Database;
  let mockDb: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    initializeDatabaseSchema(sqlite);
    mockDb = createMockD1Database(sqlite);

    (globalThis as any).DB = mockDb;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(mockDb);
    jest.clearAllMocks();

    // Seed admin profile
    sqlite
      .prepare(`
        INSERT INTO profiles (id, email, full_name, role)
        VALUES ('admin_usr_1', 'admin@apexos.app', 'Admin User', 'admin')
      `)
      .run();

    // Seed non-admin affiliate
    sqlite
      .prepare(`
        INSERT INTO profiles (id, email, full_name, role, kyc_status, kyc_tier)
        VALUES ('affiliate_usr_1', 'affiliate@apexos.app', 'Affiliate User', 'affiliate', 'pending', 'tier0_unverified')
      `)
      .run();

    // Seed held payouts
    sqlite
      .prepare(`
        INSERT INTO payouts (id, affiliate_id, amount, net_amount, chain, status, compliance_status, compliance_reason, payout_method_details)
        VALUES
          ('payout_kyc_hold_1', 'affiliate_usr_1', 750.0, 750.0, 'ethereum', 'pending', 'kyc_required', 'KYC_TIER_LIMIT_EXCEEDED', '{"wallet_address":"0x2222222222222222222222222222222222222222"}'),
          ('payout_kyc_hold_2', 'affiliate_usr_1', 1250.0, 1250.0, 'solana', 'pending', 'kyc_required', 'KYC_TIER_LIMIT_EXCEEDED', '{"wallet_address":"4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM"}'),
          ('payout_sanction_hold_1', 'affiliate_usr_1', 300.0, 300.0, 'ethereum', 'failed', 'compliance_blocked', 'SANCTIONED_ADDRESS', '{"wallet_address":"0xd90e2f925da726b50c4ed8d0fb90ad053324f31b"}')
      `)
      .run();

    // Seed initial sanctioned address
    sqlite
      .prepare(`
        INSERT INTO sanctioned_addresses (address, chain, source, risk_score)
        VALUES ('0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', 'ethereum', 'OFAC SDN - Tornado Cash', 1.0)
      `)
      .run();
  });

  afterEach(() => {
    sqlite.close();
    delete (globalThis as any).DB;
  });

  // ==========================================================================
  // 1. Admin RBAC Guard Tests
  // ==========================================================================
  describe('Admin RBAC Guard Enforcement', () => {
    it('returns 401 when request is unauthenticated', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts');
      const res = await getPayoutsRoute(req);

      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('Unauthorized');
    });

    it('returns 403 when user does not have admin role', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'affiliate_usr_1',
        email: 'affiliate@apexos.app',
      });

      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts');
      const res = await getPayoutsRoute(req);

      expect(res.status).toBe(403);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('Forbidden');
    });

    it('returns 200 when authenticated user has admin role', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'admin_usr_1',
        email: 'admin@apexos.app',
      });

      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts');
      const res = await getPayoutsRoute(req);

      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });
  });

  // ==========================================================================
  // 2. GET /api/admin/compliance/payouts Tests
  // ==========================================================================
  describe('GET /api/admin/compliance/payouts', () => {
    beforeEach(() => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'admin_usr_1',
        email: 'admin@apexos.app',
      });
    });

    it('returns paginated list of held payouts joining profile information', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts');
      const res = await getPayoutsRoute(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.payouts).toHaveLength(3);
      expect(data.pagination.total).toBe(3);

      const first = data.payouts[0];
      expect(first.affiliate_email).toBe('affiliate@apexos.app');
      expect(first.affiliate_kyc_tier).toBe('tier0_unverified');
    });

    it('calculates summary KPIs correctly', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts');
      const res = await getPayoutsRoute(req);
      const data = await res.json();

      expect(data.kpis).toBeDefined();
      expect(data.kpis.totalCount).toBe(3);
      expect(data.kpis.kycRequiredCount).toBe(2);
      expect(data.kpis.complianceBlockedCount).toBe(1);
      expect(data.kpis.totalHeldUsd).toBe(2300.0);
      expect(data.kpis.totalHeldCents).toBe(230000);
    });

    it('filters payouts by status (kyc_required vs compliance_blocked)', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts?status=kyc_required');
      const res = await getPayoutsRoute(req);
      const data = await res.json();

      expect(data.payouts).toHaveLength(2);
      for (const p of data.payouts) {
        expect(p.compliance_status).toBe('kyc_required');
      }

      const blockedReq = new NextRequest('http://localhost:3000/api/admin/compliance/payouts?status=compliance_blocked');
      const blockedRes = await getPayoutsRoute(blockedReq);
      const blockedData = await blockedRes.json();

      expect(blockedData.payouts).toHaveLength(1);
      expect(blockedData.payouts[0].compliance_status).toBe('compliance_blocked');
    });

    it('filters payouts by blockchain chain', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts?chain=solana');
      const res = await getPayoutsRoute(req);
      const data = await res.json();

      expect(data.payouts).toHaveLength(1);
      expect(data.payouts[0].chain).toBe('solana');
    });

    it('returns compliance audit logs when view=audit is requested', async () => {
      sqlite
        .prepare(`
          INSERT INTO compliance_audit_logs (id, action, severity, actor_id, target_id, details)
          VALUES ('log_1', 'kyc_tier_hold', 'medium', 'system', 'affiliate_usr_1', '{"amount":750}')
        `)
        .run();

      const req = new NextRequest('http://localhost:3000/api/admin/compliance/payouts?view=audit');
      const res = await getPayoutsRoute(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.data).toHaveLength(1);
      expect(data.data[0].action).toBe('kyc_tier_hold');
    });
  });

  // ==========================================================================
  // 3. POST /api/admin/compliance/review Tests
  // ==========================================================================
  describe('POST /api/admin/compliance/review', () => {
    beforeEach(() => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'admin_usr_1',
        email: 'admin@apexos.app',
      });
    });

    it('rejects missing payoutId with 400', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'approve', reason: 'Valid override reason' }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('payoutId');
    });

    it('rejects invalid review action with 400', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutId: 'payout_kyc_hold_1', action: 'invalid_action', reason: 'Valid reason' }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('Invalid review action');
    });

    it('rejects reason shorter than 5 characters with 400', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutId: 'payout_kyc_hold_1', action: 'approve', reason: 'ok' }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.error).toContain('at least 5 characters');
    });

    it('rejects non-existent payoutId with 404', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ payoutId: 'non_existent_123', action: 'approve', reason: 'Valid reason here' }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(404);
    });

    it('action approve/override: updates payout and creates audit log atomically', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payoutId: 'payout_kyc_hold_1',
          action: 'approve',
          reason: 'Passport verified via manual verification portal',
        }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      // Verify payout updated to approved
      const payout = sqlite
        .prepare('SELECT compliance_status, compliance_reason, status FROM payouts WHERE id = ?')
        .get('payout_kyc_hold_1') as any;
      expect(payout.compliance_status).toBe('approved');
      expect(payout.compliance_reason).toContain('Passport verified');

      // Verify audit log created
      const log = sqlite
        .prepare("SELECT action, severity, actor_id, target_id FROM compliance_audit_logs WHERE action = 'admin_override' AND target_id = ?")
        .get('payout_kyc_hold_1') as any;
      expect(log).toBeDefined();
      expect(log.actor_id).toBe('admin_usr_1');
      expect(log.severity).toBe('medium');
    });

    it('action reject: updates payout to rejected and creates high-severity audit log', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payoutId: 'payout_kyc_hold_1',
          action: 'reject',
          reason: 'Identity verification failed due to mismatch with profile name',
        }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(200);

      const payout = sqlite
        .prepare('SELECT compliance_status, status FROM payouts WHERE id = ?')
        .get('payout_kyc_hold_1') as any;
      expect(payout.compliance_status).toBe('rejected');
      expect(payout.status).toBe('cancelled');

      const log = sqlite
        .prepare("SELECT action, severity FROM compliance_audit_logs WHERE action = 'admin_reject' AND target_id = ?")
        .get('payout_kyc_hold_1') as any;
      expect(log).toBeDefined();
      expect(log.severity).toBe('high');
    });

    it('action reverify: sets profile to requires_action and payout to pending_review', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payoutId: 'payout_kyc_hold_1',
          action: 'reverify',
          reason: 'Document expired, requesting re-upload of valid proof',
        }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(200);

      const profile = sqlite
        .prepare('SELECT kyc_status FROM profiles WHERE id = ?')
        .get('affiliate_usr_1') as any;
      expect(profile.kyc_status).toBe('requires_action');

      const payout = sqlite
        .prepare('SELECT compliance_status FROM payouts WHERE id = ?')
        .get('payout_kyc_hold_1') as any;
      expect(payout.compliance_status).toBe('pending_review');
    });

    it('action flag_address: normalizes address, adds to sanctioned_addresses, blocks payout, and logs critical audit entry', async () => {
      const targetAddress = '0x3333333333333333333333333333333333333333';
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          payoutId: 'payout_kyc_hold_1',
          action: 'flag_address',
          address: targetAddress,
          chain: 'ethereum',
          reason: 'Associated with high-risk darknet mixer cluster',
        }),
      });

      const res = await reviewRoute(req);
      expect(res.status).toBe(200);

      // Verify sanctioned_addresses table updated
      const sanctioned = sqlite
        .prepare('SELECT address, chain, risk_score FROM sanctioned_addresses WHERE lower(address) = lower(?)')
        .get(targetAddress) as any;
      expect(sanctioned).toBeDefined();
      expect(sanctioned.chain).toBe('ethereum');

      // Verify payout blocked
      const payout = sqlite
        .prepare('SELECT compliance_status, compliance_reason FROM payouts WHERE id = ?')
        .get('payout_kyc_hold_1') as any;
      expect(payout.compliance_status).toBe('compliance_blocked');
      expect(payout.compliance_reason).toBe('SANCTIONED_ADDRESS_FLAGGED');

      // Verify critical audit log
      const log = sqlite
        .prepare("SELECT action, severity, target_id FROM compliance_audit_logs WHERE action = 'admin_flag_address' AND target_id = ?")
        .get(targetAddress.toLowerCase()) as any;
      expect(log).toBeDefined();
      expect(log.severity).toBe('critical');
    });
  });

  // ==========================================================================
  // 4. GET / POST / DELETE /api/admin/compliance/sanctions Tests
  // ==========================================================================
  describe('Sanctions Management Endpoints (/api/admin/compliance/sanctions)', () => {
    beforeEach(() => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'admin_usr_1',
        email: 'admin@apexos.app',
      });
    });

    it('GET: returns paginated list of sanctioned addresses', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/sanctions');
      const res = await getSanctionsRoute(req);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.addresses.length).toBeGreaterThanOrEqual(1);
      expect(data.addresses[0].chain).toBe('ethereum');
    });

    it('POST: adds newly flagged address with normalization and critical audit log', async () => {
      const newAddress = '0x4444444444444444444444444444444444444444';
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/sanctions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: newAddress,
          chain: 'ethereum',
          source: 'Chainalysis alert #9901',
          riskScore: 0.95,
        }),
      });

      const res = await postSanctionsRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.address).toBe(newAddress.toLowerCase());

      const row = sqlite
        .prepare('SELECT address, chain, source, risk_score FROM sanctioned_addresses WHERE lower(address) = lower(?)')
        .get(newAddress) as any;
      expect(row).toBeDefined();
      expect(row.source).toBe('Chainalysis alert #9901');
      expect(row.risk_score).toBe(0.95);

      const log = sqlite
        .prepare("SELECT action, severity FROM compliance_audit_logs WHERE action = 'admin_flag_address' AND target_id = ?")
        .get(newAddress.toLowerCase()) as any;
      expect(log).toBeDefined();
      expect(log.severity).toBe('critical');
    });

    it('POST: rejects malformed address format with 400', async () => {
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/sanctions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: 'not_a_valid_eth_address',
          chain: 'ethereum',
        }),
      });

      const res = await postSanctionsRoute(req);
      expect(res.status).toBe(400);
    });

    it('DELETE: removes address from sanctions watchlist and records audit log', async () => {
      const addressToRemove = '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b';
      const req = new NextRequest('http://localhost:3000/api/admin/compliance/sanctions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: addressToRemove,
          chain: 'ethereum',
          reason: 'False positive flag removal',
        }),
      });

      const res = await deleteSanctionsRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);

      const check = sqlite
        .prepare('SELECT address FROM sanctioned_addresses WHERE lower(address) = lower(?)')
        .get(addressToRemove);
      expect(check).toBeUndefined();

      const log = sqlite
        .prepare("SELECT action, severity FROM compliance_audit_logs WHERE action = 'admin_override' AND target_id = ?")
        .get(addressToRemove.toLowerCase()) as any;
      expect(log).toBeDefined();
      expect(log.severity).toBe('high');
    });
  });

  // ==========================================================================
  // 5. Immutability Triggers Protection Test
  // ==========================================================================
  describe('Audit Table Immutability Triggers', () => {
    it('prevents direct UPDATE and DELETE on compliance_audit_logs', () => {
      sqlite
        .prepare(`
          INSERT INTO compliance_audit_logs (id, action, severity, details)
          VALUES ('log_immutable_1', 'kyc_tier_hold', 'medium', '{"test":1}')
        `)
        .run();

      expect(() => {
        sqlite
          .prepare("UPDATE compliance_audit_logs SET action = 'tampered' WHERE id = 'log_immutable_1'")
          .run();
      }).toThrow(/compliance_audit_logs records are immutable/i);

      expect(() => {
        sqlite
          .prepare("DELETE FROM compliance_audit_logs WHERE id = 'log_immutable_1'")
          .run();
      }).toThrow(/compliance_audit_logs records are immutable/i);
    });
  });
});
