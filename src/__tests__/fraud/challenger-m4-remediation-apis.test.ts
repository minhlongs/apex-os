/**
 * Milestone 4 Remediation Adversarial Stress Suite: Admin Fraud APIs
 * Location: src/__tests__/fraud/challenger-m4-remediation-apis.test.ts
 *
 * Empirical verification of:
 * 1. Non-existent click ID handling:
 *    - POST /api/admin/fraud/actions returns 404 Not Found
 *    - Absolutely ZERO records written to fraud_reviews
 * 2. Reason length boundary:
 *    - reason: "ok" (length 2) -> 400 Bad Request
 *    - reason: "   ok   " (trimmed length 2) -> 400 Bad Request
 *    - reason: "Valid reason >= 3 chars" -> 200 OK
 * 3. Anti-backdoor security:
 *    - Any request providing 'x-test-admin: true' without valid session -> 401 Unauthorized
 *    - Non-admin with 'x-test-admin: true' -> 403 Forbidden
 * 4. Real SQLite audit table zero-pollution verification
 */

import {
  setupFraudTestEnvironment,
  mockFraudDB,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import Database from 'better-sqlite3';
import { recordFraudDecision, EntityNotFoundError } from '@/lib/fraud/audit-logger';

describe('Challenger M4 Remediation: Admin Fraud APIs Adversarial Suite', () => {
  beforeAll(() => {
    setupFraudTestEnvironment();
  });

  beforeEach(() => {
    mockFraudDB.reset();
  });

  // ==========================================================================
  // 1. Anti-Backdoor Security Verification
  // ==========================================================================
  describe('1. Anti-Backdoor Security Guard (x-test-admin Elimination)', () => {
    const adminEndpoints: Array<{
      name: string;
      route: string;
      method: 'GET' | 'POST' | 'DELETE';
      body?: any;
    }> = [
      {
        name: 'GET /api/admin/fraud/clicks',
        route: 'src/app/api/admin/fraud/clicks/route.ts',
        method: 'GET',
      },
      {
        name: 'GET /api/admin/fraud/stats',
        route: 'src/app/api/admin/fraud/stats/route.ts',
        method: 'GET',
      },
      {
        name: 'POST /api/admin/fraud/actions',
        route: 'src/app/api/admin/fraud/actions/route.ts',
        method: 'POST',
        body: { action: 'approve', clickId: 'c1', reason: 'Backdoor exploit test' },
      },
      {
        name: 'GET /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'GET',
      },
      {
        name: 'POST /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'POST',
        body: { ipAddress: '198.51.100.42', reason: 'Backdoor exploit test' },
      },
      {
        name: 'DELETE /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'DELETE',
        body: { ipAddress: '198.51.100.42', reason: 'Backdoor exploit test' },
      },
    ];

    adminEndpoints.forEach(({ name, route, method, body }) => {
      it(`strictly rejects unauthenticated request with 'x-test-admin: true' on ${name} with 401`, async () => {
        const req = createFraudTestRequest(name.split(' ')[1], {
          method,
          admin: false,
          headers: {
            'x-test-admin': 'true',
          },
          body,
        });

        const res = await dispatchRoute(route, method, req);
        expect(res.status).toBe(401);
        expect(res.data?.success).toBe(false);
        expect(res.data?.error).toMatch(/unauthorized|session/i);
      });

      it(`strictly rejects non-admin user request with 'x-test-admin: true' on ${name} with 403`, async () => {
        const req = createFraudTestRequest(name.split(' ')[1], {
          method,
          affiliate: true,
          headers: {
            'x-test-admin': 'true',
          },
          body,
        });

        const res = await dispatchRoute(route, method, req);
        expect(res.status).toBe(403);
        expect(res.data?.success).toBe(false);
        expect(res.data?.error).toMatch(/forbidden|privileges/i);
      });
    });
  });

  // ==========================================================================
  // 2. Non-Existent Click ID Handling & Zero Ledger Pollution
  // ==========================================================================
  describe('2. Non-Existent Click ID Handling (404 and Zero Audit Pollution)', () => {
    it('returns 404 and writes 0 records to fraud_reviews for approve action on non-existent click', async () => {
      const nonExistentId = 'click-ghost-100001';

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: nonExistentId,
          reason: 'Attempting to approve non-existent click',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/not found/i);

      // Verify ZERO records written to fraud_reviews
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 404 and writes 0 records to fraud_reviews for reject action on non-existent click', async () => {
      const nonExistentId = 'click-ghost-200002';

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'reject',
          clickId: nonExistentId,
          reason: 'Attempting to reject non-existent click',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/not found/i);

      // Verify ZERO records written to fraud_reviews
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 404 and writes 0 records to fraud_reviews for dismiss action on non-existent click', async () => {
      const nonExistentId = 'click-ghost-300003';

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'dismiss',
          clickId: nonExistentId,
          reason: 'Attempting to dismiss non-existent click',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/not found/i);

      // Verify ZERO records written to fraud_reviews
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 404 and writes 0 records for bulk_resolve when all click IDs are non-existent', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          clickIds: ['ghost-bulk-1', 'ghost-bulk-2', 'ghost-bulk-3'],
          resolution: 'reject',
          reason: 'Bulk action on ghosts',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);

      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/no matching clicks|not found/i);

      // Verify ZERO records written to fraud_reviews
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('only processes valid clicks during partial bulk_resolve and writes no orphan records', async () => {
      // Seed 1 valid click
      mockFraudDB.dealClicks.set('valid-click-1', {
        id: 'valid-click-1',
        deal_id: 'deal-1',
        is_suspicious: 1,
        review_status: 'pending',
        ip_address: '203.0.113.10',
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          clickIds: ['valid-click-1', 'ghost-bulk-2', 'ghost-bulk-3'],
          resolution: 'approve',
          reason: 'Partial bulk approval',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(1);

      // Only 1 record in fraud_reviews, matching the valid click
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const reviews = Array.from(mockFraudDB.fraudReviews.values());
      expect(reviews[0].click_id).toBe('valid-click-1');
    });
  });

  // ==========================================================================
  // 3. Reason Length Boundary Validation
  // ==========================================================================
  describe('3. Reason Length Boundary Validation', () => {
    it('rejects reason="ok" (length 2) with 400 Bad Request', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-any',
          reason: 'ok',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/at least 3 characters/i);
    });

    it('rejects reason="   ok   " (length 2 after trim) with 400 Bad Request', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-any',
          reason: '   ok   ',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/at least 3 characters/i);
    });

    it('rejects 1-character reason with 400 Bad Request', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-any',
          reason: 'x',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('accepts exact 3-character reason "yes" with valid click and returns 200 OK', async () => {
      mockFraudDB.dealClicks.set('click-exact-3', {
        id: 'click-exact-3',
        deal_id: 'deal-1',
        is_suspicious: 1,
        review_status: 'pending',
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-exact-3',
          reason: 'yes',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(1);
    });

    it('accepts "Valid reason >= 3 chars" with valid click and returns 200 OK', async () => {
      mockFraudDB.dealClicks.set('click-valid-boundary', {
        id: 'click-valid-boundary',
        deal_id: 'deal-1',
        is_suspicious: 1,
        review_status: 'pending',
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-valid-boundary',
          reason: 'Valid reason >= 3 chars',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(1);

      // Verify audit record was created with the exact reason
      const review = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(review.reason).toBe('Valid reason >= 3 chars');
      expect(review.action).toBe('approve');
    });
  });

  // ==========================================================================
  // 4. Real SQLite Engine Zero Ledger Pollution Verification
  // ==========================================================================
  describe('4. Real SQLite Engine Zero Ledger Pollution Verification', () => {
    let sqlite: Database.Database;
    let d1Adapter: any;

    beforeEach(() => {
      sqlite = new Database(':memory:');
      sqlite.exec(`
        CREATE TABLE deal_clicks (
          id TEXT PRIMARY KEY,
          deal_id TEXT DEFAULT 'deal-1',
          ip_address TEXT,
          is_suspicious INTEGER DEFAULT 1,
          anomaly_score REAL DEFAULT 0.8,
          review_status TEXT DEFAULT 'pending',
          reviewed_at TEXT,
          reviewed_by TEXT,
          created_at TEXT DEFAULT (datetime('now'))
        );

        CREATE TABLE blocked_ips (
          id TEXT PRIMARY KEY,
          ip_address TEXT UNIQUE NOT NULL,
          reason TEXT NOT NULL,
          blocked_by TEXT DEFAULT 'system',
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          is_active INTEGER DEFAULT 1
        );

        CREATE TABLE fraud_reviews (
          id TEXT PRIMARY KEY,
          click_id TEXT,
          ip_address TEXT,
          reviewer_id TEXT,
          reviewed_by TEXT,
          action TEXT NOT NULL,
          reason TEXT NOT NULL,
          reviewed_at TEXT DEFAULT (datetime('now')),
          created_at TEXT DEFAULT (datetime('now')),
          details TEXT
        );

        CREATE TRIGGER trg_fraud_reviews_prevent_update
        BEFORE UPDATE ON fraud_reviews
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT_LOG: Updates to fraud_reviews are strictly prohibited');
        END;

        CREATE TRIGGER trg_fraud_reviews_prevent_delete
        BEFORE DELETE ON fraud_reviews
        BEGIN
          SELECT RAISE(ABORT, 'IMMUTABLE_AUDIT_LOG: Deletions from fraud_reviews are strictly prohibited');
        END;
      `);

      d1Adapter = {
        prepare: (sql: string) => {
          return {
            bind: (...params: any[]) => ({
              first: async <T>() => {
                const stmt = sqlite.prepare(sql);
                return stmt.get(...params) as T;
              },
              all: async <T>() => {
                const stmt = sqlite.prepare(sql);
                return { results: stmt.all(...params) as T[] };
              },
              run: async () => {
                const stmt = sqlite.prepare(sql);
                return stmt.run(...params);
              },
              _sql: sql,
              _params: params,
            }),
          };
        },
        batch: async (statements: any[]) => {
          const runBatch = sqlite.transaction(() => {
            return statements.map((s) => {
              const stmt = sqlite.prepare(s._sql);
              return stmt.run(...s._params);
            });
          });
          return runBatch();
        },
      };
    });

    afterEach(() => {
      sqlite.close();
    });

    it('recordFraudDecision throws EntityNotFoundError on non-existent click without writing any audit row', async () => {
      const nonExistentClickId = 'non-existent-sqlite-click-404';

      await expect(
        recordFraudDecision(
          d1Adapter,
          {
            action: 'approve',
            clickId: nonExistentClickId,
            reason: 'Valid reason >= 3 chars',
          },
          { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
        )
      ).rejects.toThrow(EntityNotFoundError);

      // Verify that fraud_reviews has 0 rows in real SQLite
      const count = sqlite.prepare('SELECT COUNT(*) as count FROM fraud_reviews').get() as { count: number };
      expect(count.count).toBe(0);
    });

    it('recordFraudDecision successfully commits dual-write on valid click in real SQLite with triggers', async () => {
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, ip_address, is_suspicious, review_status)
        VALUES ('click-real-1', '1.2.3.4', 1, 'pending')
      `).run();

      const result = await recordFraudDecision(
        d1Adapter,
        {
          action: 'approve',
          clickId: 'click-real-1',
          reason: 'Valid reason >= 3 chars',
        },
        { userId: 'usr-admin-1', email: 'admin@apex-os.com' }
      );

      expect(result.success).toBe(true);
      expect(result.affectedCount).toBe(1);

      // Check click state updated
      const click = sqlite.prepare("SELECT is_suspicious, review_status FROM deal_clicks WHERE id = 'click-real-1'").get() as any;
      expect(click.is_suspicious).toBe(0);
      expect(click.review_status).toBe('approved');

      // Check fraud_reviews has exactly 1 row
      const count = sqlite.prepare('SELECT COUNT(*) as count FROM fraud_reviews').get() as { count: number };
      expect(count.count).toBe(1);
    });
  });
});
