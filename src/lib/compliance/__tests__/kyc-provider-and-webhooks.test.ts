/**
 * src/lib/compliance/__tests__/kyc-provider-and-webhooks.test.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Milestone 2: KYC Provider Architecture, Webhook Ingestion & Auto-Release Test Suite
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
import {
  SumsubAdapter,
  PersonaAdapter,
  MockKycAdapter,
  getKycProvider,
  computeHmacSha256Hex,
} from '@/lib/compliance/provider';
import { releaseHeldPayouts, autoReleaseService } from '@/lib/compliance/auto-release-service';
import { POST as initiateRoute } from '@/app/api/kyc/initiate/route';
import { POST as webhookRoute } from '@/app/api/webhooks/kyc/route';
import { BatchSettlementService } from '@/lib/payouts/batch-settlement-service';
import { PayoutRouter } from '@/lib/payouts/router';
import { TreasuryHealthService } from '@/lib/payouts/treasury-health-service';

// Mock session helper
jest.mock('@/lib/auth/session-helper', () => {
  const actual = jest.requireActual('@/lib/auth/session-helper');
  return {
    ...actual,
    getAuthenticatedUser: jest.fn(),
  };
});

// Mock D1 Database backed by in-memory better-sqlite3
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

    CREATE TABLE IF NOT EXISTS earnings (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL REFERENCES profiles(id),
      deal_id TEXT,
      amount REAL NOT NULL,
      currency TEXT DEFAULT 'USD',
      payout_id TEXT REFERENCES payouts(id),
      is_paid INTEGER DEFAULT 0,
      status TEXT DEFAULT 'pending',
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

    CREATE TRIGGER IF NOT EXISTS trg_test_cal_no_up
    BEFORE UPDATE ON compliance_audit_logs FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'compliance_audit_logs records are immutable and cannot be updated/deleted'); END;

    CREATE TRIGGER IF NOT EXISTS trg_test_cal_no_del
    BEFORE DELETE ON compliance_audit_logs FOR EACH ROW
    BEGIN SELECT RAISE(ABORT, 'compliance_audit_logs records are immutable and cannot be updated/deleted'); END;
  `);
}

describe('KYC Provider Architecture & Edge Webhook Engine', () => {
  let sqlite: Database.Database;
  let mockDb: D1Database;
  const TEST_SECRET = 'kyc_test_secret_key_12345';

  beforeEach(() => {
    sqlite = new Database(':memory:');
    initializeDatabaseSchema(sqlite);
    mockDb = createMockD1Database(sqlite);

    (globalThis as any).DB = mockDb;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(mockDb);
    jest.clearAllMocks();
    process.env.KYC_WEBHOOK_SECRET = TEST_SECRET;
  });

  afterEach(() => {
    sqlite.close();
    delete (globalThis as any).DB;
  });

  // ==========================================================================
  // 1. Sumsub Adapter Tests
  // ==========================================================================
  describe('SumsubAdapter', () => {
    const sumsub = new SumsubAdapter();

    it('creates verification session with valid sessionToken and redirectUrl', async () => {
      const session = await sumsub.createSession('usr_sumsub_1');
      expect(session.provider).toBe('sumsub');
      expect(session.sessionToken).toContain('sb_tok_usr_sumsub_1');
      expect(session.redirectUrl).toContain('cockpit.sumsub.com');
    });

    it('verifies valid HMAC-SHA256 signature in x-payload-digest', async () => {
      const payload = JSON.stringify({
        applicantId: 'app_1',
        externalUserId: 'usr_1',
        reviewResult: { reviewAnswer: 'GREEN' },
      });
      const expectedDigest = await computeHmacSha256Hex(payload, TEST_SECRET);

      const headers = new Headers({
        'x-payload-digest': expectedDigest,
      });

      const isValid = await sumsub.verifySignature(payload, headers, TEST_SECRET);
      expect(isValid).toBe(true);
    });

    it('rejects forged HMAC-SHA256 signature', async () => {
      const payload = JSON.stringify({ applicantId: 'app_1' });
      const headers = new Headers({
        'x-payload-digest': 'deadbeef0000111122223333444455556666777788889999aaaabbbbccccdddd',
      });

      const isValid = await sumsub.verifySignature(payload, headers, TEST_SECRET);
      expect(isValid).toBe(false);
    });

    it('rejects missing x-payload-digest header', async () => {
      const payload = JSON.stringify({ applicantId: 'app_1' });
      const headers = new Headers({});

      const isValid = await sumsub.verifySignature(payload, headers, TEST_SECRET);
      expect(isValid).toBe(false);
    });

    it('normalizes GREEN reviewAnswer to approved and tier2_enhanced', async () => {
      const payload = JSON.stringify({
        applicantId: 'app_100',
        externalUserId: 'affiliate_green',
        reviewResult: { reviewAnswer: 'GREEN' },
        createdAt: '2026-09-28T12:00:00Z',
      });

      const event = await sumsub.parseWebhook(payload, new Headers());
      expect(event.userId).toBe('affiliate_green');
      expect(event.status).toBe('approved');
      expect(event.tier).toBe('tier2_enhanced');
      expect(event.provider).toBe('sumsub');
    });

    it('normalizes RED reviewAnswer to rejected', async () => {
      const payload = JSON.stringify({
        externalUserId: 'affiliate_red',
        reviewResult: { reviewAnswer: 'RED' },
      });

      const event = await sumsub.parseWebhook(payload, new Headers());
      expect(event.userId).toBe('affiliate_red');
      expect(event.status).toBe('rejected');
    });

    it('normalizes non-terminal review status to requires_action', async () => {
      const payload = JSON.stringify({
        externalUserId: 'affiliate_pending',
        reviewResult: { reviewAnswer: 'YELLOW' },
      });

      const event = await sumsub.parseWebhook(payload, new Headers());
      expect(event.userId).toBe('affiliate_pending');
      expect(event.status).toBe('requires_action');
    });
  });

  // ==========================================================================
  // 2. Persona Adapter Tests
  // ==========================================================================
  describe('PersonaAdapter', () => {
    const persona = new PersonaAdapter();

    it('creates verification session with inquiry template and reference-id', async () => {
      const session = await persona.createSession('usr_persona_1');
      expect(session.provider).toBe('persona');
      expect(session.sessionToken).toContain('inq_usr_persona_1');
      expect(session.redirectUrl).toContain('withpersona.com/verify');
      expect(session.redirectUrl).toContain('usr_persona_1');
    });

    it('verifies valid persona-signature header (t=...,v1=...)', async () => {
      const payload = JSON.stringify({
        data: {
          attributes: {
            name: 'inquiry.approved',
            payload: {
              data: {
                attributes: { 'reference-id': 'usr_p1' },
              },
            },
          },
        },
      });

      const timestamp = Math.floor(Date.now() / 1000).toString();
      const dataToSign = `${timestamp}.${payload}`;
      const sig = await computeHmacSha256Hex(dataToSign, TEST_SECRET);

      const headers = new Headers({
        'persona-signature': `t=${timestamp},v1=${sig}`,
      });

      const isValid = await persona.verifySignature(payload, headers, TEST_SECRET);
      expect(isValid).toBe(true);
    });

    it('rejects expired persona timestamp (>5 minutes old)', async () => {
      const payload = JSON.stringify({ test: 1 });
      const oldTimestamp = (Math.floor(Date.now() / 1000) - 400).toString(); // 400s old
      const dataToSign = `${oldTimestamp}.${payload}`;
      const sig = await computeHmacSha256Hex(dataToSign, TEST_SECRET);

      const headers = new Headers({
        'persona-signature': `t=${oldTimestamp},v1=${sig}`,
      });

      const isValid = await persona.verifySignature(payload, headers, TEST_SECRET);
      expect(isValid).toBe(false);
    });

    it('rejects forged persona signature', async () => {
      const payload = JSON.stringify({ test: 1 });
      const timestamp = Math.floor(Date.now() / 1000).toString();
      const headers = new Headers({
        'persona-signature': `t=${timestamp},v1=badbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadbadb`,
      });

      const isValid = await persona.verifySignature(payload, headers, TEST_SECRET);
      expect(isValid).toBe(false);
    });

    it('normalizes inquiry.approved to approved and tier2_enhanced', async () => {
      const payload = JSON.stringify({
        data: {
          attributes: {
            name: 'inquiry.approved',
            payload: {
              data: {
                attributes: {
                  'reference-id': 'affiliate_p_appr',
                  'completed-at': '2026-09-28T14:00:00Z',
                },
              },
            },
          },
        },
      });

      const event = await persona.parseWebhook(payload, new Headers());
      expect(event.userId).toBe('affiliate_p_appr');
      expect(event.status).toBe('approved');
      expect(event.tier).toBe('tier2_enhanced');
      expect(event.provider).toBe('persona');
    });

    it('normalizes inquiry.declined to rejected', async () => {
      const payload = JSON.stringify({
        data: {
          attributes: {
            name: 'inquiry.declined',
            payload: {
              data: {
                attributes: { 'reference-id': 'affiliate_p_dec' },
              },
            },
          },
        },
      });

      const event = await persona.parseWebhook(payload, new Headers());
      expect(event.userId).toBe('affiliate_p_dec');
      expect(event.status).toBe('rejected');
    });
  });

  // ==========================================================================
  // 3. Mock Adapter & Provider Factory Tests
  // ==========================================================================
  describe('MockKycAdapter & Factory', () => {
    it('MockKycAdapter strictly verifies genuine HMAC and rejects bypass tokens', async () => {
      const mock = new MockKycAdapter();
      const payload = JSON.stringify({ userId: 'u1', status: 'approved' });
      const realSig = await computeHmacSha256Hex(payload, TEST_SECRET);

      // 1. Valid genuine HMAC passes
      const validHeaders = new Headers({ 'x-kyc-signature': realSig });
      expect(await mock.verifySignature(payload, validHeaders, TEST_SECRET)).toBe(true);

      // 2. Former bypass tokens are strictly REJECTED (Integrity violation eliminated)
      const bypassHeaders1 = new Headers({ 'x-kyc-signature': 'mock_valid_signature' });
      expect(await mock.verifySignature(payload, bypassHeaders1, TEST_SECRET)).toBe(false);

      const bypassHeaders2 = new Headers({ 'x-kyc-signature': 'valid_mock_signature' });
      expect(await mock.verifySignature(payload, bypassHeaders2, TEST_SECRET)).toBe(false);

      // 3. Forged signatures are rejected
      const badHeaders = new Headers({ 'x-kyc-signature': 'wrong_sig' });
      expect(await mock.verifySignature(payload, badHeaders, TEST_SECRET)).toBe(false);
    });

    it('getKycProvider resolves sumsub, persona, and defaults to mock', () => {
      expect(getKycProvider('sumsub')).toBeInstanceOf(SumsubAdapter);
      expect(getKycProvider('persona')).toBeInstanceOf(PersonaAdapter);
      expect(getKycProvider('mock')).toBeInstanceOf(MockKycAdapter);
      expect(getKycProvider(undefined)).toBeInstanceOf(MockKycAdapter);
      expect(getKycProvider('unknown_provider')).toBeInstanceOf(MockKycAdapter);
    });
  });

  // ==========================================================================
  // 4. POST /api/kyc/initiate Route Tests
  // ==========================================================================
  describe('POST /api/kyc/initiate', () => {
    beforeEach(() => {
      sqlite
        .prepare(`
          INSERT INTO profiles (id, email, full_name, role, kyc_status, kyc_tier)
          VALUES ('user_init_1', 'user1@example.com', 'User One', 'affiliate', 'unverified', 'tier0_unverified')
        `)
        .run();
    });

    it('rejects unauthenticated request with 401', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue(null);

      const req = new NextRequest('http://localhost:3000/api/kyc/initiate', {
        method: 'POST',
      });

      const res = await initiateRoute(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('Unauthorized');
    });

    it('creates active verification session for authenticated user', async () => {
      (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValue({
        id: 'user_init_1',
        email: 'user1@example.com',
      });

      const req = new NextRequest('http://localhost:3000/api/kyc/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'mock' }),
      });

      const res = await initiateRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();

      expect(data.success).toBe(true);
      expect(data.provider).toBe('mock');
      expect(data.sessionToken).toContain('mock_tok_user_init_1');
      expect(data.redirectUrl).toContain('verify.mock-kyc.com');
      expect(data.status).toBe('pending');

      // Assert profile transitioned to pending
      const profile = sqlite
        .prepare('SELECT kyc_status FROM profiles WHERE id = ?')
        .get('user_init_1') as any;
      expect(profile.kyc_status).toBe('pending');

      // Assert audit log was recorded
      const log = sqlite
        .prepare("SELECT action, severity, target_id FROM compliance_audit_logs WHERE action = 'kyc_initiated'")
        .get() as any;
      expect(log).toBeDefined();
      expect(log.target_id).toBe('user_init_1');
      expect(log.severity).toBe('low');
    });
  });

  // ==========================================================================
  // 5. POST /api/webhooks/kyc Route & Auto-Release Tests
  // ==========================================================================
  describe('POST /api/webhooks/kyc', () => {
    beforeEach(() => {
      // Seed user and held payouts
      sqlite
        .prepare(`
          INSERT INTO profiles (id, email, full_name, role, kyc_status, kyc_tier)
          VALUES ('affiliate_held_1', 'held@apexos.app', 'Held User', 'affiliate', 'pending', 'tier0_unverified')
        `)
        .run();

      sqlite
        .prepare(`
          INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, compliance_status, compliance_reason)
          VALUES
            ('payout_h1', 'affiliate_held_1', 600.0, 600.0, 'pending', 'kyc_required', 'KYC_TIER_LIMIT_EXCEEDED'),
            ('payout_h2', 'affiliate_held_1', 750.0, 750.0, 'pending', 'kyc_required', 'KYC_TIER_LIMIT_EXCEEDED')
        `)
        .run();

      sqlite
        .prepare(`
          INSERT INTO earnings (id, affiliate_id, amount, payout_id, is_paid)
          VALUES
            ('earn_1', 'affiliate_held_1', 600.0, 'payout_h1', 0),
            ('earn_2', 'affiliate_held_1', 750.0, 'payout_h2', 0)
        `)
        .run();
    });

    it('rejects forged webhook signature with 401', async () => {
      const payload = JSON.stringify({ userId: 'affiliate_held_1', status: 'approved' });
      const req = new NextRequest('http://localhost:3000/api/webhooks/kyc', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-kyc-signature': 'invalid_forged_signature_123',
        },
        body: payload,
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(401);
      const data = await res.json();
      expect(data.success).toBe(false);
      expect(data.error).toContain('Invalid webhook signature');
    });

    it('rejects empty payload with 400', async () => {
      const req = new NextRequest('http://localhost:3000/api/webhooks/kyc', {
        method: 'POST',
        body: '',
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(400);
    });

    it('processes approved event: upgrades tier, unholds payouts, and resets earnings', async () => {
      const payload = JSON.stringify({
        userId: 'affiliate_held_1',
        status: 'approved',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);

      const req = new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-kyc-signature': sig,
        },
        body: payload,
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe('approved');

      // 1. Verify profile upgrade
      const profile = sqlite
        .prepare('SELECT kyc_status, kyc_tier, kyc_verified_at FROM profiles WHERE id = ?')
        .get('affiliate_held_1') as any;
      expect(profile.kyc_status).toBe('approved');
      expect(profile.kyc_tier).toBe('tier2_enhanced');
      expect(profile.kyc_verified_at).not.toBeNull();

      // 2. Verify payouts unheld and transitioned to cancelled to prevent pending inflation
      const heldPayouts = sqlite
        .prepare('SELECT id, compliance_status, compliance_reason, status FROM payouts WHERE affiliate_id = ?')
        .all('affiliate_held_1') as any[];
      expect(heldPayouts).toHaveLength(2);
      for (const p of heldPayouts) {
        expect(p.compliance_status).toBe('clean');
        expect(p.compliance_reason).toBe('KYC_VERIFIED_AUTO_RELEASED_REBATCHED');
        expect(p.status).toBe('cancelled');
      }

      // 3. Verify earnings reset back to null payout_id so BatchSettlementService picks them up
      const earnings = sqlite
        .prepare('SELECT id, payout_id, is_paid FROM earnings WHERE affiliate_id = ?')
        .all('affiliate_held_1') as any[];
      expect(earnings).toHaveLength(2);
      for (const e of earnings) {
        expect(e.payout_id).toBeNull();
        expect(e.is_paid).toBe(0);
      }

      // 4. Verify compliance audit log
      const logs = sqlite
        .prepare("SELECT action, severity, target_id FROM compliance_audit_logs WHERE action = 'kyc_auto_release'")
        .all() as any[];
      expect(logs.length).toBeGreaterThanOrEqual(1);
    });

    it('handles duplicate approved webhook callback idempotently', async () => {
      // First webhook
      const payload = JSON.stringify({
        userId: 'affiliate_held_1',
        status: 'approved',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);

      const makeReq = () =>
        new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-kyc-signature': sig,
          },
          body: payload,
        });

      const res1 = await webhookRoute(makeReq());
      expect(res1.status).toBe(200);

      // Second duplicate delivery
      const res2 = await webhookRoute(makeReq());
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.success).toBe(true);
      expect(data2.deduped).toBe(true);
    });

    it('processes rejected event: updates status and writes high-severity audit log', async () => {
      const payload = JSON.stringify({
        userId: 'affiliate_held_1',
        status: 'rejected',
        reason: 'Fraudulent document detected',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);

      const req = new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-kyc-signature': sig,
        },
        body: payload,
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.status).toBe('rejected');

      const profile = sqlite
        .prepare('SELECT kyc_status FROM profiles WHERE id = ?')
        .get('affiliate_held_1') as any;
      expect(profile.kyc_status).toBe('rejected');

      // Verify high severity rejection audit log
      const audit = sqlite
        .prepare("SELECT action, severity, target_id FROM compliance_audit_logs WHERE action = 'admin_reject' AND target_id = ?")
        .get('affiliate_held_1') as any;
      expect(audit).toBeDefined();
      expect(audit.severity).toBe('high');
    });

    it('processes requires_action event: updates status and logs medium severity audit entry', async () => {
      const payload = JSON.stringify({
        userId: 'affiliate_held_1',
        status: 'requires_action',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);

      const req = new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-kyc-signature': sig,
        },
        body: payload,
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.status).toBe('requires_action');

      const profile = sqlite
        .prepare('SELECT kyc_status FROM profiles WHERE id = ?')
        .get('affiliate_held_1') as any;
      expect(profile.kyc_status).toBe('requires_action');
    });

    it('handles duplicate rejected webhook callback idempotently without duplicate audit logs', async () => {
      const payload = JSON.stringify({
        userId: 'affiliate_held_1',
        status: 'rejected',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);
      const makeReq = () =>
        new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-kyc-signature': sig,
          },
          body: payload,
        });

      // First delivery sets status to rejected
      const res1 = await webhookRoute(makeReq());
      expect(res1.status).toBe(200);

      const logsBefore = (sqlite
        .prepare("SELECT COUNT(*) as count FROM compliance_audit_logs WHERE action = 'admin_reject' AND target_id = 'affiliate_held_1'")
        .get() as any)?.count ?? 0;

      // Duplicate rejected delivery
      const res2 = await webhookRoute(makeReq());
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.success).toBe(true);
      expect(data2.deduped).toBe(true);
      expect(data2.status).toBe('rejected');

      const logsAfter = (sqlite
        .prepare("SELECT COUNT(*) as count FROM compliance_audit_logs WHERE action = 'admin_reject' AND target_id = 'affiliate_held_1'")
        .get() as any)?.count ?? 0;

      expect(logsAfter).toBe(logsBefore);
    });

    it('handles duplicate requires_action webhook callback idempotently without duplicate audit logs', async () => {
      const payload = JSON.stringify({
        userId: 'affiliate_held_1',
        status: 'requires_action',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);
      const makeReq = () =>
        new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-kyc-signature': sig,
          },
          body: payload,
        });

      // First delivery sets status to requires_action
      const res1 = await webhookRoute(makeReq());
      expect(res1.status).toBe(200);

      const logsBefore = (sqlite
        .prepare("SELECT COUNT(*) as count FROM compliance_audit_logs WHERE action = 'kyc_tier_hold' AND target_id = 'affiliate_held_1'")
        .get() as any)?.count ?? 0;

      // Duplicate delivery
      const res2 = await webhookRoute(makeReq());
      expect(res2.status).toBe(200);
      const data2 = await res2.json();
      expect(data2.success).toBe(true);
      expect(data2.deduped).toBe(true);
      expect(data2.status).toBe('requires_action');

      const logsAfter = (sqlite
        .prepare("SELECT COUNT(*) as count FROM compliance_audit_logs WHERE action = 'kyc_tier_hold' AND target_id = 'affiliate_held_1'")
        .get() as any)?.count ?? 0;

      expect(logsAfter).toBe(logsBefore);
    });

    it('returns 404 if user profile is not found before auto-release or audit logging', async () => {
      const payload = JSON.stringify({
        userId: 'non_existent_user_999',
        status: 'approved',
      });
      const sig = await computeHmacSha256Hex(payload, TEST_SECRET);

      const req = new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-kyc-signature': sig,
        },
        body: payload,
      });

      const res = await webhookRoute(req);
      expect(res.status).toBe(404);
      const data = await res.json();
      expect(data.error).toBe('User profile not found');

      // Verify no audit log recorded for non-existent user
      const audit = sqlite
        .prepare('SELECT COUNT(*) as count FROM compliance_audit_logs WHERE target_id = ?')
        .get('non_existent_user_999') as any;
      expect(Number(audit?.count ?? 0)).toBe(0);
    });

    it('fails closed with 500 when webhook secret is missing or fallback in production', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.KYC_WEBHOOK_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        delete process.env.KYC_WEBHOOK_SECRET;

        const payload = JSON.stringify({ userId: 'affiliate_held_1', status: 'approved' });
        const req = new NextRequest('http://localhost:3000/api/webhooks/kyc', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: payload,
        });

        const res = await webhookRoute(req);
        expect(res.status).toBe(500);
        const data = await res.json();
        expect(data.error).toBe('Webhook secret is not configured');

        // Also test with default test secret in production
        process.env.KYC_WEBHOOK_SECRET = 'test_kyc_webhook_secret';
        const resDefault = await webhookRoute(req);
        expect(resDefault.status).toBe(500);
        const dataDefault = await resDefault.json();
        expect(dataDefault.error).toBe('Webhook secret is not configured');
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalSecret !== undefined) {
          process.env.KYC_WEBHOOK_SECRET = originalSecret;
        } else {
          delete process.env.KYC_WEBHOOK_SECRET;
        }
      }
    });

    it('disallows ?provider=mock in production environment', async () => {
      const originalEnv = process.env.NODE_ENV;
      const originalSecret = process.env.KYC_WEBHOOK_SECRET;
      try {
        process.env.NODE_ENV = 'production';
        process.env.KYC_WEBHOOK_SECRET = 'super_secure_production_secret_12345';

        const payload = JSON.stringify({ userId: 'affiliate_held_1', status: 'approved' });
        const sig = await computeHmacSha256Hex(payload, 'super_secure_production_secret_12345');

        // Caller attempts to inject ?provider=mock in production
        const req = new NextRequest('http://localhost:3000/api/webhooks/kyc?provider=mock', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-kyc-signature': sig,
          },
          body: payload,
        });

        // In production, ?provider=mock is ignored and adapter defaults to Sumsub (which rejects missing digest header with 401)
        const res = await webhookRoute(req);
        expect(res.status).toBe(401);
      } finally {
        process.env.NODE_ENV = originalEnv;
        if (originalSecret !== undefined) {
          process.env.KYC_WEBHOOK_SECRET = originalSecret;
        } else {
          delete process.env.KYC_WEBHOOK_SECRET;
        }
      }
    });
  });

  // ==========================================================================
  // 6. Direct AutoReleaseService & BatchSettlement Integration Test
  // ==========================================================================
  describe('AutoReleaseService & BatchSettlement Integration', () => {
    it('releases held payouts and allows BatchSettlementService.previewBatch to re-aggregate them', async () => {
      sqlite
        .prepare(`
          INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain, kyc_status, kyc_tier)
          VALUES ('affiliate_auto_1', 'auto@example.com', 'Auto Affiliate', '0x1111111111111111111111111111111111111111', 'ethereum', 'approved', 'tier2_enhanced')
        `)
        .run();

      sqlite
        .prepare(`
          INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, compliance_status, compliance_reason)
          VALUES ('payout_held_auto', 'affiliate_auto_1', 800.0, 800.0, 'pending', 'kyc_required', 'KYC_TIER_LIMIT_EXCEEDED')
        `)
        .run();

      sqlite
        .prepare(`
          INSERT INTO earnings (id, affiliate_id, amount, payout_id, is_paid)
          VALUES ('earn_auto_1', 'affiliate_auto_1', 800.0, 'payout_held_auto', 0)
        `)
        .run();

      const mockEth = {
        chain: 'ethereum' as const,
        validateAddress: () => true,
        async estimateFee() {
          return {
            chain: 'ethereum' as const,
            feeNative: '0.001',
            feeUsd: 0.05,
            gasLimit: '21000',
            estimatedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 60000).toISOString(),
          };
        },
        async sendPayout() {
          return {
            success: true,
            transactionId: 'mock_tx_eth',
            chain: 'ethereum' as const,
            status: 'completed' as const,
            feeNative: '0.001',
            feeUsd: 0.05,
            recipientAddress: '0x1111111111111111111111111111111111111111',
            amount: 800.0,
            token: 'USDC',
          };
        },
        async verifyTransaction() {
          return {
            verified: true,
            transactionId: 'mock_tx_eth',
            chain: 'ethereum' as const,
            status: 'confirmed' as const,
            confirmations: 10,
          };
        },
        async getTreasuryBalance() {
          return {
            chain: 'ethereum' as const,
            address: '0xmock',
            nativeBalance: '10.0',
            nativeSymbol: 'ETH',
            usdcBalance: '100000.0',
            usdcSymbol: 'USDC',
            checkedAt: new Date().toISOString(),
          };
        },
      };

      const testRouter = new PayoutRouter({
        ethereum: mockEth as any,
        solana: mockEth as any,
        stellar: mockEth as any,
      });

      const testHealthService = new TreasuryHealthService(undefined, testRouter);
      jest.spyOn(testHealthService, 'checkHealth').mockResolvedValue({
        globalStatus: 'HEALTHY',
        canSettle: true,
        checkedAt: new Date().toISOString(),
        chains: {} as any,
        warnings: [],
        errors: [],
      });
      jest.spyOn(testHealthService, 'canSettle').mockResolvedValue({
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

      // Before release: previewBatch finds 0 earnings because payout_id is set
      const settlementService = new BatchSettlementService({
        db: mockDb,
        router: testRouter,
        healthService: testHealthService,
      });

      const previewBefore = await settlementService.previewBatch();
      expect(previewBefore.totalEarningsCount).toBe(0);

      // Execute auto-release
      const releaseResult = await releaseHeldPayouts(mockDb, 'affiliate_auto_1');
      expect(releaseResult.success).toBe(true);
      expect(releaseResult.releasedPayoutsCount).toBe(1);
      expect(releaseResult.releasedEarningsCount).toBe(1);
      expect(releaseResult.totalAmount).toBe(800.0);

      // After release: previewBatch now automatically picks up the released $800 earning!
      const previewAfter = await settlementService.previewBatch();
      expect(previewAfter.totalEarningsCount).toBe(1);
      expect(previewAfter.eligibleAffiliatesCount).toBe(1);
      expect(previewAfter.payoutsPreview).toHaveLength(1);
      expect(previewAfter.totalAmountUsd).toBe(800.0);
      expect(previewAfter.payoutsPreview[0].affiliateId).toBe('affiliate_auto_1');
      expect(previewAfter.payoutsPreview[0].complianceStatus).toBe('clean');
    });

    it('defensively refuses to release sanctioned payouts with compliance_blocked status', async () => {
      sqlite
        .prepare(`
          INSERT INTO profiles (id, email, full_name, wallet_address, preferred_chain, kyc_status, kyc_tier)
          VALUES ('affiliate_sanctioned_1', 'sanctioned@example.com', 'Sanctioned Affiliate', '0x9999999999999999999999999999999999999999', 'ethereum', 'approved', 'tier2_enhanced')
        `)
        .run();

      sqlite
        .prepare(`
          INSERT INTO payouts (id, affiliate_id, amount, net_amount, status, compliance_status, compliance_reason)
          VALUES ('payout_sanctioned_blocked', 'affiliate_sanctioned_1', 1000.0, 1000.0, 'kyc_required', 'compliance_blocked', 'SANCTIONED_ADDRESS_OFAC')
        `)
        .run();

      sqlite
        .prepare(`
          INSERT INTO earnings (id, affiliate_id, amount, payout_id, is_paid)
          VALUES ('earn_sanctioned_1', 'affiliate_sanctioned_1', 1000.0, 'payout_sanctioned_blocked', 0)
        `)
        .run();

      const releaseResult = await releaseHeldPayouts(mockDb, 'affiliate_sanctioned_1');
      expect(releaseResult.releasedPayoutsCount).toBe(0);
      expect(releaseResult.releasedEarningsCount).toBe(0);
      expect(releaseResult.totalAmount).toBe(0);

      // Verify payout is still compliance_blocked
      const payout = sqlite
        .prepare('SELECT compliance_status, compliance_reason FROM payouts WHERE id = ?')
        .get('payout_sanctioned_blocked') as any;
      expect(payout.compliance_status).toBe('compliance_blocked');

      // Verify earning is still tied to payout_sanctioned_blocked
      const earning = sqlite
        .prepare('SELECT payout_id FROM earnings WHERE id = ?')
        .get('earn_sanctioned_1') as any;
      expect(earning.payout_id).toBe('payout_sanctioned_blocked');
    });
  });
});

