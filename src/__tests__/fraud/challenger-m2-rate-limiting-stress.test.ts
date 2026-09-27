/**
 * Milestone 2 Rate Limiting & IP Blocking Challenger Stress Suite
 * Location: src/__tests__/fraud/challenger-m2-rate-limiting-stress.test.ts
 *
 * Empirical verification and stress testing covering:
 * 1. Exact boundary enforcement (100th vs 101st hourly, 1,000th vs 1,001st daily)
 * 2. IP address normalization across IPv4, IPv6, loopback, and IPv4-mapped formats
 * 3. Expiration edge conditions (-1ms expired vs +1ms active)
 * 4. Auto-block repeat offender idempotency and unique constraint collision resilience
 * 5. Production SQL timestamp collation verification (SQLite datetime('now') vs ISO-8601)
 */

import {
  MockFraudDatabase,
  setupFraudTestEnvironment,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import {
  checkIpRateLimit,
  createRateLimit429Response,
  getRateLimitHeaders,
  DEFAULT_RATE_LIMIT_CONFIG,
} from '@/lib/fraud/rate-limiter';
import {
  isIpBlocked,
  autoBlockOffender,
  unblockIp,
  normalizeIpAddress,
  extractClientIp,
} from '@/lib/fraud/ip-blocker';
import { FraudReasonCode } from '@/types/fraud';

beforeAll(() => {
  setupFraudTestEnvironment();
});

describe('Challenger M2: Rate Limiting & IP Blocking Stress Suite', () => {
  let db: MockFraudDatabase;

  beforeEach(() => {
    db = new MockFraudDatabase();
    db.reset();

    db.deals.set('deal-active-1', {
      id: 'deal-active-1',
      url: 'https://partner.exchange.com/register?ref=apex',
      title: 'Active Deal 1',
      is_active: 1,
      default_commission_rate: 0.1,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      created_at: new Date().toISOString(),
    });
  });

  // ==========================================================================
  // 1. Boundary Enforcement Stress Testing
  // ==========================================================================
  describe('1. Boundary Enforcement Stress Testing', () => {
    const hourlyIp = '203.0.113.10';

    it('1.1 Exact 100th click allowed, exact 101st click rejected (hourly limit)', async () => {
      const now = Date.now();

      // Seed 99 clicks within the current hour
      for (let i = 0; i < 99; i++) {
        db.dealClicks.set(`c-hr-${i}`, {
          id: `c-hr-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: hourlyIp,
          user_agent: 'stress-agent',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - (i + 1) * 1000).toISOString(),
        });
      }

      // Check 100th click: MUST BE ALLOWED
      const res100 = await checkIpRateLimit(db as any, hourlyIp);
      expect(res100.allowed).toBe(true);
      expect(res100.hourlyRemaining).toBe(1);
      expect(res100.exceededWindow).toBeNull();

      // Insert 100th click
      db.dealClicks.set('c-hr-100', {
        id: 'c-hr-100',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u1',
        session_id: 's-100',
        ip_address: hourlyIp,
        user_agent: 'stress-agent',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now).toISOString(),
      });

      // Check 101st click: MUST BE REJECTED WITH 429
      const res101 = await checkIpRateLimit(db as any, hourlyIp);
      expect(res101.allowed).toBe(false);
      expect(res101.hourlyRemaining).toBe(0);
      expect(res101.exceededWindow).toBe('hourly');
      expect(res101.reason).toBe(FraudReasonCode.RATE_LIMIT_EXCEEDED);
      expect(res101.retryAfter).toBeGreaterThan(0);
      expect(res101.retryAfter).toBeLessThanOrEqual(3600);
    });

    it('1.2 Exact 1,000th click allowed, exact 1,001st click rejected (daily limit)', async () => {
      const dailyIp = '203.0.113.20';
      const now = Date.now();

      // Seed 999 clicks spread over past 20 hours (less than 50/hr to avoid hourly limit)
      for (let i = 0; i < 999; i++) {
        const offsetMs = 3600 * 1000 + (i * 68400 * 1000) / 999;
        db.dealClicks.set(`c-day-${i}`, {
          id: `c-day-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: dailyIp,
          user_agent: 'stress-agent',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - offsetMs).toISOString(),
        });
      }

      // Check 1,000th click: MUST BE ALLOWED
      const res1000 = await checkIpRateLimit(db as any, dailyIp);
      expect(res1000.allowed).toBe(true);
      expect(res1000.dailyRemaining).toBe(1);
      expect(res1000.exceededWindow).toBeNull();

      // Insert 1,000th click (2 hours ago, safe from hourly limit)
      db.dealClicks.set('c-day-1000', {
        id: 'c-day-1000',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u1',
        session_id: 's-1000',
        ip_address: dailyIp,
        user_agent: 'stress-agent',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 7200 * 1000).toISOString(),
      });

      // Check 1,001st click: MUST BE REJECTED DUE TO DAILY LIMIT
      const res1001 = await checkIpRateLimit(db as any, dailyIp);
      expect(res1001.allowed).toBe(false);
      expect(res1001.dailyRemaining).toBe(0);
      expect(res1001.exceededWindow).toBe('daily');
      expect(res1001.retryAfter).toBeGreaterThan(0);
      expect(res1001.retryAfter).toBeLessThanOrEqual(86400);
    });

    it('1.3 Sliding window precision at exactly 3600 seconds boundary', async () => {
      const edgeIp = '203.0.113.30';
      const now = Date.now();

      // Click at exactly 3600 seconds + 1ms ago (just outside hourly window)
      db.dealClicks.set('c-outside-hr', {
        id: 'c-outside-hr',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u1',
        session_id: 's-out',
        ip_address: edgeIp,
        user_agent: 'stress-agent',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 3600 * 1000 - 1).toISOString(),
      });

      // 99 clicks inside the window
      for (let i = 0; i < 99; i++) {
        db.dealClicks.set(`c-in-${i}`, {
          id: `c-in-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: edgeIp,
          user_agent: 'stress-agent',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - (i + 1) * 1000).toISOString(),
        });
      }

      // Check: 99 inside + 1 outside -> count should be 99, so next click is 100th (allowed)
      const res = await checkIpRateLimit(db as any, edgeIp);
      expect(res.allowed).toBe(true);
      expect(res.hourlyRemaining).toBe(1);
    });
  });

  // ==========================================================================
  // 2. IP Address Normalization & Parsing Stress
  // ==========================================================================
  describe('2. IP Address Normalization & Parsing Stress', () => {
    it('2.1 normalizes IPv4, standard IPv6, and loopback correctly', () => {
      expect(normalizeIpAddress('198.51.100.1')).toBe('198.51.100.1');
      expect(normalizeIpAddress('  198.51.100.1  ')).toBe('198.51.100.1');
      expect(normalizeIpAddress('::1')).toBe('::1');
      expect(normalizeIpAddress('  ::1  ')).toBe('::1');
      expect(normalizeIpAddress('2001:0DB8:85A3::8A2E:0370:7334')).toBe('2001:0db8:85a3::8a2e:0370:7334');
      expect(normalizeIpAddress(null)).toBe('');
      expect(normalizeIpAddress(undefined)).toBe('');
      expect(normalizeIpAddress('')).toBe('');
      expect(normalizeIpAddress('   ')).toBe('');
    });

    it('2.2 tests IPv4-mapped IPv6 normalization (lowercase vs uppercase prefix)', () => {
      // Standard lowercase prefix is stripped
      expect(normalizeIpAddress('::ffff:192.0.2.128')).toBe('192.0.2.128');

      // VULNERABILITY AUDIT: Check whether uppercase ::FFFF: is stripped
      const normalizedUpper = normalizeIpAddress('::FFFF:192.0.2.128');
      // If startsWith is checked before toLowerCase, normalizedUpper will fail to strip prefix!
      expect(normalizedUpper).toBe('192.0.2.128');
    });

    it('2.3 isIpBlocked cross-format resolution: IPv4 blocked matches incoming IPv4-mapped IPv6', async () => {
      const v4 = '198.51.100.55';
      db.blockedIps.set(v4, {
        id: 'blk-v4',
        ip_address: v4,
        reason: 'Bot attack',
        blocked_by: 'system',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });

      // Lookup via lowercase mapped format
      expect(await isIpBlocked(db as any, `::ffff:${v4}`)).toBe(true);

      // Lookup via uppercase mapped format
      expect(await isIpBlocked(db as any, `::FFFF:${v4}`)).toBe(true);
    });

    it('2.4 extractClientIp header precedence: cf-connecting-ip > x-forwarded-for > x-real-ip', () => {
      const headers = new Headers({
        'cf-connecting-ip': '203.0.113.195',
        'x-forwarded-for': '198.51.100.1, 10.0.0.1',
        'x-real-ip': '10.0.0.1',
      });
      expect(extractClientIp(headers)).toBe('203.0.113.195');

      const headersNoCf = new Headers({
        'x-forwarded-for': '198.51.100.1, 10.0.0.1',
        'x-real-ip': '10.0.0.1',
      });
      expect(extractClientIp(headersNoCf)).toBe('198.51.100.1');

      const headersWhitespaceXff = new Headers({
        'x-forwarded-for': '   , 10.0.0.1',
        'x-real-ip': '198.51.100.2',
      });
      expect(extractClientIp(headersWhitespaceXff)).toBe('198.51.100.2');

      const emptyHeaders = new Headers();
      expect(extractClientIp(emptyHeaders)).toBe('127.0.0.1');
    });
  });

  // ==========================================================================
  // 3. Expiration Edge Stress Testing (-1ms vs +1ms)
  // ==========================================================================
  describe('3. Expiration Edge Stress Testing', () => {
    it('3.1 record expired 1ms ago is considered UNBLOCKED', async () => {
      const expIp = '203.0.113.60';
      const now = Date.now();

      db.blockedIps.set(expIp, {
        id: 'blk-exp-1ms',
        ip_address: expIp,
        reason: 'Temporary suspension',
        blocked_by: 'system',
        created_at: new Date(now - 3600 * 1000).toISOString(),
        expires_at: new Date(now - 1).toISOString(), // expired 1ms ago
        is_active: 1,
      });

      expect(await isIpBlocked(db as any, expIp)).toBe(false);
    });

    it('3.2 record expiring 100ms in the future is considered BLOCKED', async () => {
      const actIp = '203.0.113.61';
      const now = Date.now();

      db.blockedIps.set(actIp, {
        id: 'blk-act-100ms',
        ip_address: actIp,
        reason: 'Active suspension',
        blocked_by: 'system',
        created_at: new Date(now).toISOString(),
        expires_at: new Date(now + 100).toISOString(), // expires in 100ms
        is_active: 1,
      });

      expect(await isIpBlocked(db as any, actIp)).toBe(true);
    });

    it('3.3 record with null expires_at is permanently BLOCKED', async () => {
      const permIp = '203.0.113.62';
      db.blockedIps.set(permIp, {
        id: 'blk-perm',
        ip_address: permIp,
        reason: 'Permanent ban',
        blocked_by: 'admin-001',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });

      expect(await isIpBlocked(db as any, permIp)).toBe(true);
    });

    it('3.4 record with is_active = 0 is considered UNBLOCKED even if expires_at is in future', async () => {
      const inactIp = '203.0.113.63';
      const now = Date.now();

      db.blockedIps.set(inactIp, {
        id: 'blk-inact',
        ip_address: inactIp,
        reason: 'Unbanned early',
        blocked_by: 'admin-001',
        created_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + 3600 * 1000).toISOString(),
        is_active: 0,
      });

      expect(await isIpBlocked(db as any, inactIp)).toBe(false);
    });
  });

  // ==========================================================================
  // 4. Auto-Blocking Concurrency & Uniqueness Resilience
  // ==========================================================================
  describe('4. Auto-Blocking Concurrency & Uniqueness Resilience', () => {
    it('4.1 autoBlockOffender executes without throwing when called repeatedly for same IP', async () => {
      const repeatIp = '203.0.113.70';

      // First auto-block
      const res1 = await autoBlockOffender(db as any, repeatIp, FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER, {
        durationSeconds: 3600,
        blockedBy: 'system',
      });
      expect(res1).toBe(true);

      // Second auto-block for same IP (simulating concurrent or subsequent requests)
      // Must not crash or violate unique constraint
      const res2 = await autoBlockOffender(db as any, repeatIp, FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER, {
        durationSeconds: 3600,
        blockedBy: 'system',
      });
      expect(res2).toBe(true);
    });
  });

  // ==========================================================================
  // 5. SQLite Engine Collation & Concurrency Flaws
  // ==========================================================================
  describe('5. SQLite Engine Collation & Concurrency Flaws', () => {
    it('5.1 demonstrates production SQL collation mismatch: SQLite datetime(\'now\') is NOT >= ISO-8601 string', () => {
      // Real SQLite simulation
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const sqlite = new Database(':memory:');

      sqlite.exec(`
        CREATE TABLE deal_clicks (
          id TEXT PRIMARY KEY,
          ip_address TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
      `);

      // Insert 100 clicks using production route format (datetime('now') -> 'YYYY-MM-DD HH:MM:SS')
      const stmt = sqlite.prepare(
        "INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, '203.0.113.88', '2026-09-27 12:00:00')"
      );
      for (let i = 0; i < 100; i++) {
        stmt.run(`click-${i}`);
      }

      // Cutoff generated as ISO-8601 (as done in checkIpRateLimit: new Date(now - 3600000).toISOString())
      // At 11:00:00 UTC on the same day: '2026-09-27T11:00:00.000Z'
      const hourlyCutoff = '2026-09-27T11:00:00.000Z';

      // Query executed by checkIpRateLimit
      const query = sqlite.prepare(
        'SELECT COUNT(*) as count FROM deal_clicks WHERE ip_address = ? AND created_at >= ?'
      );
      const result = query.get('203.0.113.88', hourlyCutoff) as { count: number };

      // In real SQLite, because 'YYYY-MM-DD HH:MM:SS' has a space at index 10 (ASCII 32)
      // and 'YYYY-MM-DDTHH:MM:SS.sssZ' has 'T' at index 10 (ASCII 84),
      // the SQL string comparison evaluates to FALSE!
      // This causes count to be 0 instead of 100, completely disabling rate limiting in production!
      expect(result.count).toBe(0); // Collation bug reproduced empirically
    });

    it('5.2 demonstrates unique constraint crash on duplicate auto-block in real SQLite', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const Database = require('better-sqlite3');
      const sqlite = new Database(':memory:');

      sqlite.exec(`
        CREATE TABLE blocked_ips (
          id TEXT PRIMARY KEY,
          ip_address TEXT UNIQUE NOT NULL,
          reason TEXT NOT NULL,
          blocked_by TEXT DEFAULT 'system',
          created_at TEXT DEFAULT (datetime('now')),
          expires_at TEXT,
          is_active INTEGER DEFAULT 1
        );
      `);

      const insertStmt = sqlite.prepare(
        'INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, created_at, expires_at, is_active) VALUES (?, ?, ?, ?, ?, ?, 1)'
      );

      // First insert succeeds
      insertStmt.run('id-1', '203.0.113.99', 'auto-block', 'system', '2026-09-25 12:00:00', null);

      // Second insert with same IP (concurrent request or repeat auto-block) throws UNIQUE constraint error
      expect(() => {
        insertStmt.run('id-2', '203.0.113.99', 'auto-block', 'system', '2026-09-25 12:00:00', null);
      }).toThrow(/UNIQUE constraint failed: blocked_ips.ip_address/);
    });
  });
});

