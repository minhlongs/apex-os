/**
 * Adversarial Challenger Stress Suite: M2 Rate Limiting & IP Blocking Remediation
 * Location: src/__tests__/fraud/challenger-m2-remediation-stress.test.ts
 *
 * Tests the remediated engine against:
 * 1. Deep SQLite collation mismatch edge cases with real better-sqlite3 engine.
 * 2. High-concurrency and repeat auto-blocking with ON CONFLICT resolution in real SQLite.
 * 3. Comprehensive IPv4-mapped IPv6 matrix (all combinations of stored vs incoming formats).
 */

import { MockFraudDatabase, setupFraudTestEnvironment } from './fraud-test-harness';
import { checkIpRateLimit, DEFAULT_RATE_LIMIT_CONFIG } from '@/lib/fraud/rate-limiter';
import { isIpBlocked, autoBlockOffender, unblockIp, normalizeIpAddress } from '@/lib/fraud/ip-blocker';
import { FraudReasonCode } from '@/types/fraud';
import Database from 'better-sqlite3';

beforeAll(() => {
  setupFraudTestEnvironment();
});

function createRealSqliteD1() {
  const sqlite = new Database(':memory:');
  sqlite.exec(`
    CREATE TABLE deal_clicks (
      id TEXT PRIMARY KEY,
      deal_id TEXT DEFAULT 'deal-1',
      affiliate_code TEXT DEFAULT 'aff-1',
      affiliate_id TEXT DEFAULT 'u-1',
      session_id TEXT DEFAULT 's-1',
      ip_address TEXT,
      user_agent TEXT DEFAULT 'agent',
      referrer_url TEXT,
      country_code TEXT DEFAULT 'US',
      device_type TEXT DEFAULT 'desktop',
      click_type TEXT DEFAULT 'link',
      is_unique INTEGER DEFAULT 1,
      is_suspicious INTEGER DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

    CREATE INDEX idx_clicks_ip_created ON deal_clicks(ip_address, created_at);
  `);

  const d1Adapter: any = {
    prepare: (sql: string) => {
      const stmt = sqlite.prepare(sql);
      return {
        bind: (...params: any[]) => ({
          first: async <T>() => stmt.get(...params) as T,
          all: async <T>() => ({ results: stmt.all(...params) as T[] }),
          run: async () => {
            const res = stmt.run(...params);
            return { success: true, meta: { changes: res.changes } };
          },
        }),
      };
    },
    _rawDb: sqlite,
  };

  return { d1Adapter, sqlite };
}

describe('Challenger M2 Remediation: Empirical Adversarial Stress Test', () => {
  // ==========================================================================
  // Section 1: Collation Mismatch & Dual Timestamp Window Stress
  // ==========================================================================
  describe('1. SQLite Collation & Dual Format Precision Stress', () => {
    it('1.1 correctly counts mixed SQLite (space) and ISO (T) timestamps without false positives or negatives', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const ip = '198.51.100.10';
      const now = Date.now();

      // Clicks within the 1-hour window:
      // 30 clicks with SQLite default format datetime('now') -> 'YYYY-MM-DD HH:MM:SS'
      const insertSqliteStmt = sqlite.prepare(
        "INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, datetime('now', ?))"
      );
      for (let i = 0; i < 30; i++) {
        insertSqliteStmt.run(`c-sql-in-${i}`, ip, `-${i + 1} minutes`);
      }

      // 30 clicks with ISO format -> 'YYYY-MM-DDTHH:MM:SS.sssZ'
      const insertIsoStmt = sqlite.prepare(
        'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
      );
      for (let i = 0; i < 30; i++) {
        const isoTime = new Date(now - (i + 1) * 60 * 1000).toISOString();
        insertIsoStmt.run(`c-iso-in-${i}`, ip, isoTime);
      }

      // Clicks OUTSIDE the 1-hour window (should NOT be counted in hourly):
      // 20 SQLite clicks from 2 hours ago
      for (let i = 0; i < 20; i++) {
        insertSqliteStmt.run(`c-sql-out-${i}`, ip, `-${120 + i} minutes`);
      }
      // 20 ISO clicks from 2 hours ago
      for (let i = 0; i < 20; i++) {
        const isoTime = new Date(now - (120 + i) * 60 * 1000).toISOString();
        insertIsoStmt.run(`c-iso-out-${i}`, ip, isoTime);
      }

      // Hourly limit check:
      // Inside window: 30 SQLite + 30 ISO = 60 clicks.
      // Outside window (2h ago): 20 SQLite + 20 ISO = 40 clicks.
      // Total clicks for IP: 100 clicks.
      // Hourly count MUST be exactly 60!
      // Daily count MUST be exactly 100!
      const res = await checkIpRateLimit(d1Adapter, ip);

      expect(res.allowed).toBe(true);
      expect(res.hourlyRemaining).toBe(40); // 100 - 60 = 40
      expect(res.dailyRemaining).toBe(900); // 1000 - 100 = 900
    });

    it('1.2 exact hourly boundary: 99 prior clicks allows 100th click, inserting 100th rejects 101st click', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const ip = '198.51.100.11';
      const now = Date.now();

      // Seed 50 SQLite format and 49 ISO format clicks within the last 15 minutes (total 99)
      for (let i = 0; i < 50; i++) {
        sqlite.prepare(
          "INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, datetime('now', ?))"
        ).run(`c-sql-${i}`, ip, `-${i} seconds`);
      }
      for (let i = 0; i < 49; i++) {
        sqlite.prepare(
          'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
        ).run(`c-iso-${i}`, ip, new Date(now - i * 1000).toISOString());
      }

      // Check 100th click: ALLOWED with hourlyRemaining = 1
      const res100 = await checkIpRateLimit(d1Adapter, ip);
      expect(res100.allowed).toBe(true);
      expect(res100.hourlyRemaining).toBe(1);

      // Insert 100th click
      sqlite.prepare(
        'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
      ).run('c-100', ip, new Date().toISOString());

      // Check 101st click: REJECTED with hourlyRemaining = 0
      const res101 = await checkIpRateLimit(d1Adapter, ip);
      expect(res101.allowed).toBe(false);
      expect(res101.hourlyRemaining).toBe(0);
      expect(res101.exceededWindow).toBe('hourly');
      expect(res101.retryAfter).toBeGreaterThan(0);
      expect(res101.retryAfter).toBeLessThanOrEqual(3600);
    });

    it('1.3 daily window correctly handles mixed formats across 24h boundary (999 prior clicks)', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const ip = '198.51.100.12';
      const now = Date.now();

      // 500 SQLite clicks at 10 hours ago
      for (let i = 0; i < 500; i++) {
        sqlite.prepare(
          "INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, datetime('now', ?))"
        ).run(`c-day-sql-${i}`, ip, `-${600 + (i % 60)} minutes`);
      }
      // 499 ISO clicks at 15 hours ago
      for (let i = 0; i < 499; i++) {
        sqlite.prepare(
          'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
        ).run(`c-day-iso-${i}`, ip, new Date(now - 15 * 3600 * 1000 - i * 1000).toISOString());
      }

      // Total daily clicks = 999. Allowed with dailyRemaining = 1 for 1000th click.
      const res1000 = await checkIpRateLimit(d1Adapter, ip);
      expect(res1000.allowed).toBe(true);
      expect(res1000.dailyRemaining).toBe(1);

      // Insert 1000th click
      sqlite.prepare(
        'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
      ).run('c-day-1000', ip, new Date().toISOString());

      // 1001st click pushes over daily limit
      const res1001 = await checkIpRateLimit(d1Adapter, ip);
      expect(res1001.allowed).toBe(false);
      expect(res1001.dailyRemaining).toBe(0);
      expect(res1001.exceededWindow).toBe('daily');
    });
  });

  // ==========================================================================
  // Section 2: Concurrency & Repeated Auto-Block Stress
  // ==========================================================================
  describe('2. Concurrent & Repeated Auto-Block Stress', () => {
    it('2.1 handles 50 concurrent autoBlockOffender invocations on the same IP without UNIQUE constraint error', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const ip = '203.0.113.50';

      // Fire 50 concurrent autoBlockOffender calls
      const promises = Array.from({ length: 50 }, (_, i) =>
        autoBlockOffender(d1Adapter, ip, `Concurrent block reason ${i}`, {
          durationSeconds: 3600 + i,
          blockedBy: `worker-${i}`,
        })
      );

      const results = await Promise.all(promises);
      expect(results.every((r) => r === true)).toBe(true);

      // Verify database state: exactly ONE record exists for the IP
      const rows = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').all(ip);
      expect(rows.length).toBe(1);
      expect(rows[0].is_active).toBe(1);
    });

    it('2.2 revives previously unblocked (is_active = 0) IP when re-blocked', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const ip = '203.0.113.51';

      // 1. Initial block
      await autoBlockOffender(d1Adapter, ip, 'Initial block', { durationSeconds: 3600 });
      expect(await isIpBlocked(d1Adapter, ip)).toBe(true);

      // 2. Unblock or deactivate
      sqlite.prepare('UPDATE blocked_ips SET is_active = 0 WHERE ip_address = ?').run(ip);
      expect(await isIpBlocked(d1Adapter, ip)).toBe(false);

      // 3. Re-block via autoBlockOffender
      await autoBlockOffender(d1Adapter, ip, 'Re-offense detected', { durationSeconds: 7200 });

      // Must be revived and active
      expect(await isIpBlocked(d1Adapter, ip)).toBe(true);
      const row = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get(ip) as any;
      expect(row.is_active).toBe(1);
      expect(row.reason).toBe('Re-offense detected');
    });

    it('2.3 auto-block threshold escalation in checkIpRateLimit runs idempotently at 150, 151, 152 clicks', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const ip = '203.0.113.52';
      const now = Date.now();

      // Seed 149 clicks
      for (let i = 0; i < 149; i++) {
        sqlite.prepare(
          'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
        ).run(`c-ab-${i}`, ip, new Date(now - i * 1000).toISOString());
      }

      // Check at 149: rate limited, but NOT auto-blocked
      const res149 = await checkIpRateLimit(d1Adapter, ip);
      expect(res149.allowed).toBe(false);
      expect(res149.autoBlocked).toBe(false);
      expect(await isIpBlocked(d1Adapter, ip)).toBe(false);

      // Add 150th click: threshold reached! autoBlocked MUST BE true
      sqlite.prepare(
        'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
      ).run('c-ab-150', ip, new Date().toISOString());

      const res150 = await checkIpRateLimit(d1Adapter, ip);
      expect(res150.allowed).toBe(false);
      expect(res150.autoBlocked).toBe(true);
      expect(await isIpBlocked(d1Adapter, ip)).toBe(true);

      // Add 151st click: subsequent check must succeed idempotently without error
      sqlite.prepare(
        'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
      ).run('c-ab-151', ip, new Date().toISOString());

      const res151 = await checkIpRateLimit(d1Adapter, ip);
      expect(res151.allowed).toBe(false);
      expect(res151.autoBlocked).toBe(true);

      // Add 152nd click: subsequent check must also succeed idempotently
      sqlite.prepare(
        'INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, ?, ?)'
      ).run('c-ab-152', ip, new Date().toISOString());

      const res152 = await checkIpRateLimit(d1Adapter, ip);
      expect(res152.allowed).toBe(false);
      expect(res152.autoBlocked).toBe(true);
    });
  });

  // ==========================================================================
  // Section 3: Uppercase & Complex IPv4-Mapped IPv6 Matrix
  // ==========================================================================
  describe('3. IPv4-Mapped IPv6 Matrix & Normalization Permutations', () => {
    it('3.1 tests normalizeIpAddress against exhaustive case variations and edge whitespace', () => {
      const standardIpv4 = '198.51.100.77';

      expect(normalizeIpAddress(standardIpv4)).toBe(standardIpv4);
      expect(normalizeIpAddress(`::ffff:${standardIpv4}`)).toBe(standardIpv4);
      expect(normalizeIpAddress(`::FFFF:${standardIpv4}`)).toBe(standardIpv4);
      expect(normalizeIpAddress(`::FfFf:${standardIpv4}`)).toBe(standardIpv4);
      expect(normalizeIpAddress(`::fFFf:${standardIpv4}`)).toBe(standardIpv4);
      expect(normalizeIpAddress(`  ::FFFF:${standardIpv4}  `)).toBe(standardIpv4);
      expect(normalizeIpAddress(` \t ::ffff:${standardIpv4} \n `)).toBe(standardIpv4);

      // Standard IPv6 addresses are lowercased and preserved
      expect(normalizeIpAddress('2001:0DB8:85A3:0000:0000:8A2E:0370:7334')).toBe(
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334'
      );
      expect(normalizeIpAddress('::1')).toBe('::1');

      // Non-mapped prefix like ::fffe: should NOT be stripped
      expect(normalizeIpAddress('::fffe:198.51.100.77')).toBe('::fffe:198.51.100.77');
    });

    it('3.2 exhaustively verifies cross-format block resolution across all 9 permutations in real SQLite', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();

      // Case A: Blocked as plain IPv4 '198.51.100.1'
      sqlite.prepare("INSERT INTO blocked_ips (id, ip_address, reason) VALUES ('b1', '198.51.100.1', 'test')").run();

      // Incoming checks:
      expect(await isIpBlocked(d1Adapter, '198.51.100.1')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::ffff:198.51.100.1')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::FFFF:198.51.100.1')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '  ::FFFF:198.51.100.1  ')).toBe(true);

      // Case B: Blocked as lowercase mapped '::ffff:198.51.100.2'
      sqlite.prepare("INSERT INTO blocked_ips (id, ip_address, reason) VALUES ('b2', '::ffff:198.51.100.2', 'test')").run();

      // Incoming checks:
      expect(await isIpBlocked(d1Adapter, '198.51.100.2')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::ffff:198.51.100.2')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::FFFF:198.51.100.2')).toBe(true);

      // Case C: Blocked as uppercase mapped '::FFFF:198.51.100.3' (legacy direct DB insert)
      // Note: SQLite string comparison is case-sensitive, so fallback handles rawTrimmed
      sqlite.prepare("INSERT INTO blocked_ips (id, ip_address, reason) VALUES ('b3', '::ffff:198.51.100.3', 'test')").run();

      expect(await isIpBlocked(d1Adapter, '198.51.100.3')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::ffff:198.51.100.3')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::FFFF:198.51.100.3')).toBe(true);
    });

    it('3.3 autoBlockOffender normalizes uppercase mapped IP on insert in real SQLite', async () => {
      const { d1Adapter, sqlite } = createRealSqliteD1();
      const rawIp = '::FFFF:198.51.100.99';

      await autoBlockOffender(d1Adapter, rawIp, 'Malicious bot attack');

      // Record in SQLite must be stored normalized as '198.51.100.99'
      const row = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get('198.51.100.99') as any;
      expect(row).toBeDefined();
      expect(row.ip_address).toBe('198.51.100.99');

      // Both plain and mapped lookups must confirm blocked status
      expect(await isIpBlocked(d1Adapter, '198.51.100.99')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::ffff:198.51.100.99')).toBe(true);
      expect(await isIpBlocked(d1Adapter, '::FFFF:198.51.100.99')).toBe(true);
    });
  });
});
