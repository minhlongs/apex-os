/**
 * Milestone 1 Unit Tests: Mock Fraud Database Engine Verification
 * Location: src/__tests__/fraud/mock-fraud-db.test.ts
 *
 * Verifies:
 * 1. Cloudflare D1 interface simulation (prepare, bind, first, all, run, batch)
 * 2. CRUD lifecycle for deal_clicks with fraud extensions
 * 3. IP blocklist lifecycle (insert, active check, unblock, expiration)
 * 4. Rate limit bucket tracking and mutations
 * 5. In-memory immutability trigger guard on fraud_reviews (UPDATE/DELETE rejection)
 * 6. Batch statement atomic execution
 */

import {
  MockFraudDatabase,
  mockFraudDB,
  MockDealClickRow,
  MockBlockedIpRow,
  MockFraudReviewRow,
} from './fraud-test-harness';

describe('MockFraudDatabase Engine & Cloudflare D1 Simulation', () => {
  let db: MockFraudDatabase;

  beforeEach(() => {
    db = new MockFraudDatabase();
  });

  describe('1. CRUD Lifecycle for deal_clicks', () => {
    it('inserts clean and suspicious click records', async () => {
      await db
        .prepare(`
          INSERT INTO deal_clicks (
            id, deal_id, session_id, ip_address, is_suspicious, flag_reasons, anomaly_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind('c-1', 'deal-active-1', 'sess-1', '198.51.100.10', 0, '[]', 0.0)
        .run();

      await db
        .prepare(`
          INSERT INTO deal_clicks (
            id, deal_id, session_id, ip_address, is_suspicious, flag_reasons, anomaly_score
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          'c-2',
          'deal-active-1',
          'sess-2',
          '198.51.100.10',
          1,
          '["BURST_CLICK"]',
          0.85
        )
        .run();

      expect(db.dealClicks.size).toBe(2);
      expect(db.dealClicks.get('c-1')?.is_suspicious).toBe(0);
      expect(db.dealClicks.get('c-2')?.is_suspicious).toBe(1);
    });

    it('queries clicks by IP address with DESC sorting', async () => {
      // Insert with explicit created_at
      db.dealClicks.set('c-old', {
        id: 'c-old',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff1',
        affiliate_id: 'usr-1',
        session_id: 's-1',
        ip_address: '198.51.100.20',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        flag_reasons: '[]',
        anomaly_score: 0.0,
        created_at: '2026-09-25T08:00:00Z',
      });

      db.dealClicks.set('c-new', {
        id: 'c-new',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff1',
        affiliate_id: 'usr-1',
        session_id: 's-2',
        ip_address: '198.51.100.20',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.9,
        created_at: '2026-09-25T09:00:00Z',
      });

      const { results } = await db
        .prepare('SELECT * FROM deal_clicks WHERE ip_address = ? ORDER BY created_at DESC')
        .bind('198.51.100.20')
        .all<MockDealClickRow>();

      expect(results.length).toBe(2);
      expect(results[0].id).toBe('c-new');
      expect(results[1].id).toBe('c-old');
    });

    it('updates click review status and reviewer details', async () => {
      db.dealClicks.set('c-review-1', {
        id: 'c-review-1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff1',
        affiliate_id: 'usr-1',
        session_id: 's-rev',
        ip_address: '198.51.100.30',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: '2026-09-25T09:00:00Z',
      });

      const now = new Date().toISOString();
      await db
        .prepare(
          'UPDATE deal_clicks SET review_status = ?, is_suspicious = ?, reviewed_at = ?, reviewed_by = ? WHERE id = ?'
        )
        .bind('approved', 0, now, 'admin-001', 'c-review-1')
        .run();

      const updated = db.dealClicks.get('c-review-1');
      expect(updated?.review_status).toBe('approved');
      expect(updated?.is_suspicious).toBe(0);
      expect(updated?.reviewed_by).toBe('admin-001');
      expect(updated?.reviewed_at).toBe(now);
    });
  });

  describe('2. IP Blocklist Lifecycle & Expiration Checks', () => {
    it('inserts and retrieves active blocked IP', async () => {
      await db
        .prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, blocked_at, expires_at, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind('b-1', '198.51.100.40', 'Burst attack', 'system', '2026-09-25T10:00:00Z', null, 1)
        .run();

      const blocked = await db
        .prepare('SELECT * FROM blocked_ips WHERE ip_address = ? AND is_active = 1')
        .bind('198.51.100.40')
        .first<MockBlockedIpRow>();

      expect(blocked).not.toBeNull();
      expect(blocked?.ip_address).toBe('198.51.100.40');
      expect(blocked?.is_active).toBe(1);
    });

    it('unblocks IP and returns null on subsequent is_active check', async () => {
      await db
        .prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, blocked_at, expires_at, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind('b-2', '198.51.100.41', 'Manual ban', 'admin', '2026-09-25T10:00:00Z', null, 1)
        .run();

      // Unblock
      await db
        .prepare('UPDATE blocked_ips SET is_active = 0 WHERE ip_address = ?')
        .bind('198.51.100.41')
        .run();

      const activeCheck = await db
        .prepare('SELECT * FROM blocked_ips WHERE ip_address = ? AND is_active = 1')
        .bind('198.51.100.41')
        .first<MockBlockedIpRow>();

      expect(activeCheck).toBeNull();

      const raw = db.blockedIps.get('198.51.100.41');
      expect(raw?.is_active).toBe(0);
    });

    it('treats expired temporary blocks as inactive/unblocked', async () => {
      const pastTime = new Date(Date.now() - 3600000).toISOString(); // 1 hour ago
      await db
        .prepare(`
          INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, blocked_at, expires_at, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind('b-expired', '198.51.100.42', 'Temp ban', 'system', '2026-09-25T08:00:00Z', pastTime, 1)
        .run();

      const blocked = await db
        .prepare('SELECT * FROM blocked_ips WHERE ip_address = ? AND is_active = 1')
        .bind('198.51.100.42')
        .first<MockBlockedIpRow>();

      expect(blocked).toBeNull();
    });
  });

  describe('3. Rate Limiting Bucket Mutations', () => {
    it('inserts, increments, and reads rate limit bucket', async () => {
      const testKey = 'click_tracking|198.51.100.50';
      const resetAt = new Date(Date.now() + 3600000).toISOString();

      await db
        .prepare(`
          INSERT INTO rate_limits (key, endpoint_type, identifier, current_count, max_count, window_seconds, reset_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(testKey, 'click_tracking', '198.51.100.50', 1, 100, 3600, resetAt)
        .run();

      let bucket = await db
        .prepare('SELECT current_count, max_count, reset_at FROM rate_limits WHERE key = ?')
        .bind(testKey)
        .first<{ current_count: number; max_count: number; reset_at: string }>();

      expect(bucket?.current_count).toBe(1);

      // Increment count
      await db
        .prepare('UPDATE rate_limits SET current_count = current_count + 1 WHERE key = ?')
        .bind(new Date().toISOString(), testKey)
        .run();

      bucket = await db
        .prepare('SELECT current_count, max_count, reset_at FROM rate_limits WHERE key = ?')
        .bind(testKey)
        .first<{ current_count: number; max_count: number; reset_at: string }>();

      expect(bucket?.current_count).toBe(2);
    });

    it('deletes rate limit bucket on reset', async () => {
      const testKey = 'click_tracking|198.51.100.51';
      await db
        .prepare(`
          INSERT INTO rate_limits (key, endpoint_type, identifier, current_count, max_count, window_seconds, reset_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(testKey, 'click_tracking', '198.51.100.51', 100, 100, 3600, new Date().toISOString())
        .run();

      await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(testKey).run();

      const bucket = await db
        .prepare('SELECT current_count FROM rate_limits WHERE key = ?')
        .bind(testKey)
        .first();

      expect(bucket).toBeNull();
    });
  });

  describe('4. In-Memory Trigger Guard & Immutability Simulation', () => {
    it('permits INSERT into fraud_reviews audit log', async () => {
      await db
        .prepare(`
          INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind('rev-1', 'c-1', 'usr-admin-1', 'approve', 'Valid influencer click')
        .run();

      expect(db.fraudReviews.has('rev-1')).toBe(true);
      const row = db.fraudReviews.get('rev-1');
      expect(row?.action).toBe('approve');
      expect(row?.reason).toBe('Valid influencer click');
    });

    it('rejects UPDATE operations on fraud_reviews with descriptive error', async () => {
      await db
        .prepare(`
          INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind('rev-immutable', 'c-1', 'usr-admin-1', 'approve', 'Approved')
        .run();

      await expect(
        db.prepare('UPDATE fraud_reviews SET reason = ? WHERE id = ?').bind('altered', 'rev-immutable').run()
      ).rejects.toThrow(/cannot modify immutable table/i);
    });

    it('rejects DELETE operations on fraud_reviews with descriptive error', async () => {
      await expect(
        db.prepare('DELETE FROM fraud_reviews WHERE id = ?').bind('rev-immutable').run()
      ).rejects.toThrow(/cannot modify immutable table/i);

      await expect(db.prepare('DELETE FROM fraud_reviews').run()).rejects.toThrow(
        /cannot modify immutable table/i
      );
    });
  });

  describe('5. Atomic Batch Execution', () => {
    it('executes multiple statements sequentially via db.batch()', async () => {
      const stmt1 = db
        .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
        .bind('batch-b1', '10.0.0.1', 'Batch ban 1', 'admin');

      const stmt2 = db
        .prepare('INSERT INTO blocked_ips (id, ip_address, reason, blocked_by) VALUES (?, ?, ?, ?)')
        .bind('batch-b2', '10.0.0.2', 'Batch ban 2', 'admin');

      const stmt3 = db
        .prepare('INSERT INTO fraud_reviews (id, reviewer_id, action, reason) VALUES (?, ?, ?, ?)')
        .bind('batch-rev-1', 'usr-admin-1', 'block_ip', 'Batch executed');

      const results = await db.batch([stmt1, stmt2, stmt3]);

      expect(results.length).toBe(3);
      expect(results[0].success).toBe(true);
      expect(results[1].success).toBe(true);
      expect(results[2].success).toBe(true);

      expect(db.blockedIps.has('10.0.0.1')).toBe(true);
      expect(db.blockedIps.has('10.0.0.2')).toBe(true);
      expect(db.fraudReviews.has('batch-rev-1')).toBe(true);
    });
  });
});
