/**
 * ApexOS Core Fraud Detection & Anomaly Engine
 * Tier 5 Adversarial Coverage Hardening Test Suite (M5)
 * Location: src/__tests__/fraud/m5-tier5-adversarial-engine.test.ts
 *
 * White-Box Branch & Path Hardening for:
 * 1. Dual-Window Rate Limiter (rate-limiter.ts):
 *    - Sliding window millisecond boundaries (ISO vs SQLite space-separated formats)
 *    - Dynamic sliding window roll-over & capacity restoration
 *    - Asymmetric window saturation: Daily limit exceeded without hourly limit exceeded
 *    - Fallback paths for retryAfter when oldest click query returns no row
 *    - Auto-block escalation threshold boundaries (149 vs 150 clicks in 1h, custom duration)
 *    - RFC 6585 rate limit headers and 429 response structure
 *
 * 2. IP Blocker & Normalization (ip-blocker.ts):
 *    - IPv6 mixed-case, loopback (::1), IPv4-mapped (::ffff:x.x.x.x) normalization
 *    - Strict Cloudflare IP extraction precedence (cf-connecting-ip > x-forwarded-for > x-real-ip > fallback)
 *    - Multi-layer active & expiration checks (null expiry, past expiry, future expiry, invalid date)
 *    - Cross-format bidirectional lookups (IPv4 vs mapped IPv6 in blocked_ips table)
 *    - Re-escalation idempotency and unblock operations
 *
 * 3. Velocity Anomaly Engine (fraud-engine.ts):
 *    - Sub-millisecond & microsecond boundary deltas (0ms, 1ms, 999ms, 1000ms, 1999ms, 2000ms, 2001ms)
 *    - Clock skew & out-of-order distributed events (negative deltaMs resilience)
 *    - High-concurrency session & IP disambiguation (matchedBy = 'session' vs 'ip')
 *    - Conversion status variations (only 'confirmed' and 'approved' count; 'pending' and 'rejected' do not)
 *    - Multi-tenancy cross-deal and cross-affiliate strict isolation
 *    - Mathematical multi-anomaly score stacking precision & arithmetic clamping
 *
 * 4. Click Routes Defense-in-Depth (deals/[id]/click & tracking/click):
 *    - Multi-stage defense hierarchy: Stage 1 Blocked IP -> Deal Active -> Stage 2 Rate Limit -> Stage 3 Velocity
 *    - Passive fraud detection: Suspicious clicks recorded with flags without breaking user redirect
 *    - Safe absolute redirect URL construction and fallback safety
 *    - Fail-open resilience on velocity evaluation errors
 *
 * 5. Matcher Attribution & Isolation (matcher.ts):
 *    - Multi-tenancy deal isolation (Deal 1 click does not attribute Deal 2 trade)
 *    - Cookie window expiration boundary (30 days)
 *    - EVM vs Solana vs Email identifier resolution
 *    - Tiered multi-level commission math across percentage and fixed commission deals
 */

import Database from 'better-sqlite3';
import {
  mockFraudDB,
  setupFraudTestEnvironment,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import {
  checkIpRateLimit,
  getRateLimitHeaders,
  createRateLimit429Response,
  DEFAULT_RATE_LIMIT_CONFIG,
} from '@/lib/fraud/rate-limiter';
import {
  isIpBlocked,
  autoBlockOffender,
  unblockIp,
  normalizeIpAddress,
  extractClientIp,
  createBlockedIp403Response,
} from '@/lib/fraud/ip-blocker';
import {
  evaluateClickVelocity,
  parseTimestampMs,
} from '@/lib/fraud/fraud-engine';
import { Matcher, createMatcher } from '@/lib/tracking/matcher';
import { FraudReasonCode } from '@/types/fraud';
import type { D1Database } from '@/types/d1';

// ============================================================================
// Real SQLite D1 Database Factory
// ============================================================================

function createRealSqliteD1(): { d1: D1Database; sqlite: Database.Database } {
  const sqlite = new Database(':memory:');

  sqlite.exec(`
    CREATE TABLE deals (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      title TEXT,
      name TEXT,
      is_active INTEGER DEFAULT 1,
      default_commission_rate REAL DEFAULT 0.1,
      default_commission_type TEXT DEFAULT 'percentage',
      fixed_commission_amount REAL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE deal_clicks (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      affiliate_code TEXT,
      affiliate_id TEXT,
      session_id TEXT NOT NULL,
      ip_address TEXT,
      user_agent TEXT,
      referrer_url TEXT,
      country_code TEXT,
      device_type TEXT,
      click_type TEXT DEFAULT 'link',
      is_unique INTEGER DEFAULT 1,
      is_suspicious INTEGER DEFAULT 0,
      flag_reasons TEXT,
      anomaly_score REAL DEFAULT 0.0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE conversions (
      id TEXT PRIMARY KEY,
      deal_id TEXT NOT NULL,
      affiliate_code TEXT,
      affiliate_id TEXT,
      user_id TEXT NOT NULL,
      amount REAL DEFAULT 0.0,
      status TEXT DEFAULT 'pending',
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

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'trader',
      plan TEXT DEFAULT 'free',
      tier TEXT DEFAULT 'BASIC',
      referral_code TEXT,
      referred_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE wallet_connections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL,
      wallet_address TEXT NOT NULL,
      preferred_chain TEXT DEFAULT 'ethereum',
      is_primary INTEGER DEFAULT 1,
      connected_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT
    );

    CREATE TABLE referral_tree (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL,
      parent_id TEXT,
      path TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_deal_clicks_ip_created ON deal_clicks(ip_address, created_at);
    CREATE INDEX idx_deal_clicks_session_created ON deal_clicks(session_id, created_at);
    CREATE INDEX idx_deal_clicks_deal_affiliate ON deal_clicks(deal_id, affiliate_code);
    CREATE INDEX idx_conversions_deal_affiliate ON conversions(deal_id, affiliate_code, status);

    -- Default seed fixtures
    INSERT INTO deals (id, url, title, name, is_active, default_commission_rate, default_commission_type, fixed_commission_amount)
    VALUES ('deal-active-1', 'https://partner.exchange.com/signup?aff=apex', 'Active Deal 1', 'Active Deal 1', 1, 0.1, 'percentage', 0),
           ('deal-binance-spot', 'https://binance.com/ref?code=APEX', 'Binance Spot Cashback', 'Binance Spot Cashback', 1, 0.2, 'percentage', 0),
           ('deal-inactive-1', 'https://partner.exchange.com/expired', 'Inactive Deal', 'Inactive Deal', 0, 0.1, 'percentage', 0);

    INSERT INTO profiles (id, email, full_name, role, plan, tier, referral_code)
    VALUES ('usr-admin-1', 'admin@apex-os.com', 'Apex Admin', 'admin', 'enterprise', 'MASTER', 'ADMINREF'),
           ('usr-affiliate-1', 'affiliate1@apex-os.com', 'Top Affiliate', 'affiliate', 'pro', 'PREMIUM', 'AFFILIATE1'),
           ('usr-trader-1', 'trader1@apex-os.com', 'Trader One', 'trader', 'free', 'BASIC', 'TRADER1');

    INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain, is_primary)
    VALUES ('wc-1', 'usr-trader-1', '0x1111111111111111111111111111111111111111', 'ethereum', 1);

    INSERT INTO referral_tree (id, affiliate_id, parent_id, path)
    VALUES ('rt-1', 'usr-affiliate-1', NULL, 'usr-affiliate-1');
  `);

  const d1: any = {
    prepare: (sql: string) => {
      const cleanSql = sql.replace(/\s+/g, ' ').trim();
      const stmt = sqlite.prepare(cleanSql);
      return {
        bind: (...params: any[]) => ({
          first: async <T>() => {
            const row = stmt.get(...params);
            return (row !== undefined ? row : null) as T | null;
          },
          all: async <T>() => {
            const rows: any = stmt.all(...params);
            rows.results = rows;
            return rows as T[];
          },
          run: async () => {
            const res = stmt.run(...params);
            return { success: true, meta: { changes: res.changes, last_row_id: Number(res.lastInsertRowid) } };
          },
        }),
        first: async <T>() => {
          const row = stmt.get();
          return (row !== undefined ? row : null) as T | null;
        },
        all: async <T>() => {
          const rows: any = stmt.all();
          rows.results = rows;
          return rows as T[];
        },
        run: async () => {
          const res = stmt.run();
          return { success: true, meta: { changes: res.changes, last_row_id: Number(res.lastInsertRowid) } };
        },
      };
    },
  };

  return { d1, sqlite };
}

// Setup environment before all tests
beforeAll(() => {
  setupFraudTestEnvironment();
});

beforeEach(() => {
  mockFraudDB.reset();
});

describe('ApexOS Tier 5 Adversarial Coverage Hardening (M5 Engine & Detection)', () => {

  // ==========================================================================
  // SUITE 1: Dual-Window Rate Limiter Branch Hardening & Sliding Window Roll-Over
  // ==========================================================================
  describe('Suite 1: Dual-Window Rate Limiter Branch & Boundary Hardening', () => {
    const testIp = '198.51.100.42';

    it('1.1 Millisecond Cutoff Boundary: Click at T - 3600.001s does NOT count towards 1h rate limit', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const nowMs = 1758816000000;
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      // Insert 99 clicks inside the 1-hour window
      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-1', 'sess-1', ?, ?)
      `);

      for (let i = 0; i < 99; i++) {
        const time = new Date(nowMs - (i * 30000)).toISOString();
        insertClick.run(`c-in-${i}`, testIp, time);
      }

      // Insert 1 click exactly 1ms outside the 1-hour window (3600.001s ago)
      const outsideTime = new Date(nowMs - 3600001).toISOString();
      insertClick.run('c-out-1', testIp, outsideTime);

      const result = await checkIpRateLimit(d1, testIp);

      expect(result.allowed).toBe(true);
      expect(result.hourlyRemaining).toBe(1); // 100 - 99 = 1 remaining
      expect(result.isBlocked).toBe(false);
      expect(result.exceededWindow).toBeNull();

      // Now add 1 click at T - 3599.999s (inside the 1-hour window)
      const insideBoundaryTime = new Date(nowMs - 3599999).toISOString();
      insertClick.run('c-in-100', testIp, insideBoundaryTime);

      const saturatedResult = await checkIpRateLimit(d1, testIp);

      expect(saturatedResult.allowed).toBe(false);
      expect(saturatedResult.hourlyRemaining).toBe(0);
      expect(saturatedResult.exceededWindow).toBe('hourly');
      expect(saturatedResult.retryAfter).toBeGreaterThan(0);

      jest.restoreAllMocks();
    });

    it('1.2 Sliding Window Roll-Over: Capacity restores as time advances past the 1-hour mark', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      let simulatedNow = 1758816000000;
      const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => simulatedNow);

      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-1', 'sess-1', ?, ?)
      `);

      // 100 clicks occurred 3,550 seconds ago (50 seconds remaining until they age out of 1h window)
      for (let i = 0; i < 100; i++) {
        const clickTime = new Date(simulatedNow - 3550000).toISOString();
        insertClick.run(`c-roll-${i}`, testIp, clickTime);
      }

      // Check at initial time: Limit is fully exhausted
      const checkInitial = await checkIpRateLimit(d1, testIp);
      expect(checkInitial.allowed).toBe(false);
      expect(checkInitial.hourlyRemaining).toBe(0);
      expect(checkInitial.retryAfter).toBeLessThanOrEqual(51);

      // Advance time by 52 seconds -> clicks have now aged to 3,602 seconds ago (> 3,600s)
      simulatedNow += 52000;

      const checkRolledOver = await checkIpRateLimit(d1, testIp);
      expect(checkRolledOver.allowed).toBe(true);
      expect(checkRolledOver.hourlyRemaining).toBe(100);
      expect(checkRolledOver.isBlocked).toBe(false);
      expect(checkRolledOver.retryAfter).toBe(0);

      nowSpy.mockRestore();
    });

    it('1.3 Asymmetric Window Saturation: Daily limit exceeded without hourly limit exceeded', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const nowMs = 1758816000000;
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-1', 'sess-1', ?, ?)
      `);

      // Spread 1,000 clicks across 20 hours (50 clicks/hour):
      // - Last 1 hour has only 50 clicks (< 100 hourly limit)
      // - Total 24 hours has 1,000 clicks (>= 1,000 daily limit)
      for (let hour = 1; hour <= 20; hour++) {
        for (let c = 0; c < 50; c++) {
          const clickTime = new Date(nowMs - (hour * 3600000) + (c * 60000)).toISOString();
          insertClick.run(`c-crawl-${hour}-${c}`, testIp, clickTime);
        }
      }

      const result = await checkIpRateLimit(d1, testIp);

      expect(result.allowed).toBe(false);
      expect(result.exceededWindow).toBe('daily');
      expect(result.hourlyRemaining).toBe(50); // Hourly capacity remains
      expect(result.dailyRemaining).toBe(0);   // Daily capacity exhausted
      expect(result.autoBlocked).toBe(false);  // Auto-block NOT triggered because hourlyCount < 150
      expect(result.reason).toBe(FraudReasonCode.RATE_LIMIT_EXCEEDED);
      expect(result.retryAfter).toBeGreaterThan(0);

      jest.restoreAllMocks();
    });

    it('1.4 Dynamic retryAfter fallback paths when oldest click query returns no row', async () => {
      // Mock D1 where count query returns 105 (hourly limit exceeded),
      // but oldest click query returns null
      const mockD1: any = {
        prepare: (sql: string) => ({
          bind: () => ({
            first: async () => {
              if (sql.includes('COUNT(*)')) {
                return { count: 105 }; // > 100, but < 150 (no auto-block)
              }
              // Oldest query returns null
              return null;
            },
            run: async () => ({ success: true, meta: { changes: 1 } }),
          }),
        }),
      };

      const result = await checkIpRateLimit(mockD1, testIp);

      expect(result.allowed).toBe(false);
      expect(result.exceededWindow).toBe('hourly');
      expect(result.retryAfter).toBe(DEFAULT_RATE_LIMIT_CONFIG.hourlyWindowSeconds); // 3600s fallback

      // Test daily window fallback when oldest click query returns null
      const mockDailyD1: any = {
        prepare: (sql: string) => ({
          bind: (...args: any[]) => ({
            first: async () => {
              if (sql.includes('COUNT(*)')) {
                // If cutoff is ~24 hours ago (daily cutoff), return 1050.
                // If cutoff is ~1 hour ago (hourly cutoff), return 50.
                const cutoffEpoch = new Date(args[1]).getTime();
                const isDaily = (Date.now() - cutoffEpoch) > 7200000;
                return isDaily ? { count: 1050 } : { count: 50 };
              }
              return null;
            },
            run: async () => ({ success: true, meta: { changes: 1 } }),
          }),
        }),
      };

      const dailyResult = await checkIpRateLimit(mockDailyD1, testIp, { hourlyLimit: 100, dailyLimit: 1000 });
      expect(dailyResult.allowed).toBe(false);
      expect(dailyResult.exceededWindow).toBe('daily');
      expect(dailyResult.retryAfter).toBe(DEFAULT_RATE_LIMIT_CONFIG.dailyWindowSeconds); // 86400s fallback
    });

    it('1.5 Auto-Block Escalation Threshold Boundaries (149 clicks vs 150 clicks)', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const nowMs = 1758816000000;
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-1', 'sess-1', ?, ?)
      `);

      // 149 clicks in 1 hour: Rate limited, but NOT auto-blocked
      for (let i = 0; i < 149; i++) {
        const time = new Date(nowMs - (i * 20000)).toISOString();
        insertClick.run(`c-esc-${i}`, testIp, time);
      }

      const res149 = await checkIpRateLimit(d1, testIp);
      expect(res149.allowed).toBe(false);
      expect(res149.autoBlocked).toBe(false);

      const blockedCheck149 = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get(testIp);
      expect(blockedCheck149).toBeUndefined();

      // Add the 150th click: Triggers auto-block escalation!
      insertClick.run('c-esc-150', testIp, new Date(nowMs - 10000).toISOString());

      const res150 = await checkIpRateLimit(d1, testIp);
      expect(res150.allowed).toBe(false);
      expect(res150.autoBlocked).toBe(true);

      const blockedRecord: any = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get(testIp);
      expect(blockedRecord).toBeDefined();
      expect(blockedRecord.reason).toBe(FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER);
      expect(blockedRecord.blocked_by).toBe('system');
      expect(blockedRecord.is_active).toBe(1);
      expect(blockedRecord.expires_at).toBeNull(); // Default permanent

      // Custom config: threshold = 10, duration = 300 seconds
      const customIp = '203.0.113.88';
      for (let i = 0; i < 10; i++) {
        insertClick.run(`c-cust-${i}`, customIp, new Date(nowMs - (i * 5000)).toISOString());
      }

      const resCustom = await checkIpRateLimit(d1, customIp, {
        hourlyLimit: 5,
        autoBlockThreshold: 10,
        autoBlockDurationSeconds: 300,
      });

      expect(resCustom.autoBlocked).toBe(true);
      const customRecord: any = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get(customIp);
      expect(customRecord).toBeDefined();
      expect(customRecord.expires_at).not.toBeNull();
      const expiryEpoch = new Date(customRecord.expires_at).getTime();
      expect(expiryEpoch).toBeCloseTo(nowMs + 300000, -3);

      jest.restoreAllMocks();
    });

    it('1.6 Dual ISO & SQLite Space-Separated Date Query Format Invariance', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const nowMs = 1758816000000;
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-1', 'sess-1', ?, ?)
      `);

      // 50 clicks stored in SQLite standard format: 'YYYY-MM-DD HH:MM:SS'
      // 50 clicks stored in ISO 8601 format: 'YYYY-MM-DDTHH:MM:SS.000Z'
      for (let i = 0; i < 50; i++) {
        const sqliteDate = new Date(nowMs - (i * 40000)).toISOString().replace('T', ' ').slice(0, 19);
        insertClick.run(`c-sqlite-${i}`, testIp, sqliteDate);
      }
      for (let i = 0; i < 50; i++) {
        const isoDate = new Date(nowMs - (i * 40000)).toISOString();
        insertClick.run(`c-iso-${i}`, testIp, isoDate);
      }

      const result = await checkIpRateLimit(d1, testIp);

      // Both formats must be matched: Total = 100 clicks -> hourly limit saturated
      expect(result.hourlyRemaining).toBe(0);
      expect(result.allowed).toBe(false);
      expect(result.exceededWindow).toBe('hourly');

      jest.restoreAllMocks();
    });

    it('1.7 RFC 6585 Headers & 429 Response Generation Matrix', () => {
      // Test Hourly Exceeded Headers
      const hourlyResult = {
        allowed: false,
        hourlyRemaining: 0,
        dailyRemaining: 850,
        hourlyLimit: 100,
        dailyLimit: 1000,
        hourlyResetAt: 1758819600,
        dailyResetAt: 1758902400,
        retryAfter: 120,
        exceededWindow: 'hourly' as const,
        isBlocked: true,
        autoBlocked: false,
        reason: FraudReasonCode.RATE_LIMIT_EXCEEDED,
      };

      const hourlyHeaders = getRateLimitHeaders(hourlyResult);
      expect(hourlyHeaders['Retry-After']).toBe('120');
      expect(hourlyHeaders['X-RateLimit-Limit']).toBe('100');
      expect(hourlyHeaders['X-RateLimit-Remaining']).toBe('0');
      expect(hourlyHeaders['X-RateLimit-Reset']).toBe('1758819600');
      expect(hourlyHeaders['X-RateLimit-Reset-After']).toBe('120s');

      const response429 = createRateLimit429Response(hourlyResult);
      expect(response429.status).toBe(429);
      expect(response429.headers.get('Retry-After')).toBe('120');

      // Test Daily Exceeded Headers
      const dailyResult = {
        ...hourlyResult,
        hourlyRemaining: 40,
        dailyRemaining: 0,
        retryAfter: 3600,
        exceededWindow: 'daily' as const,
      };

      const dailyHeaders = getRateLimitHeaders(dailyResult);
      expect(dailyHeaders['Retry-After']).toBe('3600');
      expect(dailyHeaders['X-RateLimit-Limit']).toBe('1000');
      expect(dailyHeaders['X-RateLimit-Remaining']).toBe('0');
      expect(dailyHeaders['X-RateLimit-Reset']).toBe('1758902400');
      expect(dailyHeaders['X-RateLimit-Reset-After']).toBe('3600s');
    });
  });

  // ==========================================================================
  // SUITE 2: IP Blocker & Normalization Stress & IPv6 Case Invariance
  // ==========================================================================
  describe('Suite 2: IP Blocker & Normalization Stress & IPv6 Matrices', () => {
    it('2.1 IPv6 Mixed-Case, Whitespace & Mapped Address Normalization Matrix', () => {
      expect(normalizeIpAddress(null)).toBe('');
      expect(normalizeIpAddress(undefined)).toBe('');
      expect(normalizeIpAddress('')).toBe('');
      expect(normalizeIpAddress('   ')).toBe('');
      expect(normalizeIpAddress('  192.168.1.100  ')).toBe('192.168.1.100');

      // IPv4-mapped IPv6 in both upper and lowercase
      expect(normalizeIpAddress('::ffff:192.0.2.128')).toBe('192.0.2.128');
      expect(normalizeIpAddress('::FFFF:192.0.2.128')).toBe('192.0.2.128');
      expect(normalizeIpAddress('  ::ffff:10.0.0.1  ')).toBe('10.0.0.1');

      // Standard IPv6 normalization to lowercase
      expect(normalizeIpAddress('2001:0DB8:85A3:0000:0000:8A2E:0370:7334')).toBe(
        '2001:0db8:85a3:0000:0000:8a2e:0370:7334'
      );
      expect(normalizeIpAddress('::1')).toBe('::1');
    });

    it('2.2 Client IP Extraction Precedence Stress Matrix', () => {
      // 1. cf-connecting-ip strictly takes precedence over all other headers
      const h1 = new Headers();
      h1.set('cf-connecting-ip', '203.0.113.1');
      h1.set('x-forwarded-for', '198.51.100.99, 10.0.0.1');
      h1.set('x-real-ip', '192.0.2.5');
      expect(extractClientIp(h1)).toBe('203.0.113.1');

      // 2. cf-connecting-ip with whitespace is properly trimmed
      const h2 = new Headers();
      h2.set('cf-connecting-ip', '  203.0.113.2  ');
      h2.set('x-forwarded-for', '198.51.100.99');
      expect(extractClientIp(h2)).toBe('203.0.113.2');

      // 3. cf-connecting-ip empty -> falls back to leftmost x-forwarded-for
      const h3 = new Headers();
      h3.set('cf-connecting-ip', '   ');
      h3.set('x-forwarded-for', ' 198.51.100.3 , 10.0.0.2, 172.16.0.1');
      h3.set('x-real-ip', '192.0.2.5');
      expect(extractClientIp(h3)).toBe('198.51.100.3');

      // 4. x-forwarded-for leftmost is empty -> falls back to x-real-ip
      const h4 = new Headers();
      h4.set('x-forwarded-for', ' , 10.0.0.2');
      h4.set('x-real-ip', '192.0.2.4');
      expect(extractClientIp(h4)).toBe('192.0.2.4');

      // 5. All headers absent -> fallback to '127.0.0.1'
      const h5 = new Headers();
      expect(extractClientIp(h5)).toBe('127.0.0.1');
    });

    it('2.3 Multi-Layer Expiration & Inactivation Combinations', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const nowMs = 1758816000000;
      jest.spyOn(Date, 'now').mockReturnValue(nowMs);

      const insertBlock = sqlite.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, expires_at, is_active)
        VALUES (?, ?, 'Adversarial Test', 'admin', ?, ?)
      `);

      // 1. Active permanent block (expires_at is NULL, is_active = 1) -> BLOCKED
      insertBlock.run('b-perm', '198.51.100.1', null, 1);
      expect(await isIpBlocked(d1, '198.51.100.1')).toBe(true);

      // 2. Inactive permanent block (is_active = 0) -> UNBLOCKED
      insertBlock.run('b-inact', '198.51.100.2', null, 0);
      expect(await isIpBlocked(d1, '198.51.100.2')).toBe(false);

      // 3. Active future expiry (expires_at = now + 1hr) -> BLOCKED
      const futureExpiry = new Date(nowMs + 3600000).toISOString();
      insertBlock.run('b-fut', '198.51.100.3', futureExpiry, 1);
      expect(await isIpBlocked(d1, '198.51.100.3')).toBe(true);

      // 4. Active expired (expires_at = now - 1ms) -> UNBLOCKED
      const pastExpiry = new Date(nowMs - 1).toISOString();
      insertBlock.run('b-past', '198.51.100.4', pastExpiry, 1);
      expect(await isIpBlocked(d1, '198.51.100.4')).toBe(false);

      // 5. Exact boundary: expires_at = now -> UNBLOCKED (expiresMs <= Date.now())
      const exactNowExpiry = new Date(nowMs).toISOString();
      insertBlock.run('b-now', '198.51.100.5', exactNowExpiry, 1);
      expect(await isIpBlocked(d1, '198.51.100.5')).toBe(false);

      // 6. Corrupted/unparseable expires_at string -> failsafe remains BLOCKED
      insertBlock.run('b-corrupt', '198.51.100.6', 'not-a-valid-date', 1);
      expect(await isIpBlocked(d1, '198.51.100.6')).toBe(true);

      jest.restoreAllMocks();
    });

    it('2.4 Cross-Format Bidirectional Lookups (IPv4 vs mapped IPv6)', async () => {
      const { d1, sqlite } = createRealSqliteD1();

      const insertBlock = sqlite.prepare(`
        INSERT INTO blocked_ips (id, ip_address, reason, blocked_by, expires_at, is_active)
        VALUES (?, ?, 'Cross format test', 'admin', null, 1)
      `);

      // Block standard IPv4: '198.51.100.77'
      insertBlock.run('b-ipv4', '198.51.100.77');

      // Query with IPv4-mapped IPv6: '::ffff:198.51.100.77'
      expect(await isIpBlocked(d1, '::ffff:198.51.100.77')).toBe(true);
      expect(await isIpBlocked(d1, '::FFFF:198.51.100.77')).toBe(true);

      // Block IPv4-mapped IPv6 in database: '::ffff:198.51.100.88'
      insertBlock.run('b-mapped', '::ffff:198.51.100.88');

      // Query with standard IPv4: '198.51.100.88'
      expect(await isIpBlocked(d1, '198.51.100.88')).toBe(true);
    });

    it('2.5 Re-Escalation Idempotency and Unblock Operations', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const testIp = '198.51.100.99';

      // 1. Auto-block an IP
      await autoBlockOffender(d1, testIp, FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER);
      expect(await isIpBlocked(d1, testIp)).toBe(true);

      // 2. Unblock the IP
      await unblockIp(d1, testIp);
      expect(await isIpBlocked(d1, testIp)).toBe(false);

      // 3. Re-block the same IP (verifies ON CONFLICT DO UPDATE behavior)
      await autoBlockOffender(d1, testIp, 'Second offense block', { durationSeconds: 60 });
      expect(await isIpBlocked(d1, testIp)).toBe(true);

      const record: any = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get(testIp);
      expect(record.is_active).toBe(1);
      expect(record.reason).toBe('Second offense block');
      expect(record.expires_at).not.toBeNull();

      // 4. Verify 403 Response structure
      const response403 = createBlockedIp403Response();
      expect(response403.status).toBe(403);
    });
  });

  // ==========================================================================
  // SUITE 3: Click Velocity Engine Sub-Millisecond, Concurrency & Stacking
  // ==========================================================================
  describe('Suite 3: Click Velocity Engine Sub-Millisecond & Stacking Hardening', () => {
    const testIp = '198.51.100.123';
    const testSession = 'sess-velocity-123';
    const baseNow = 1758816000000;

    it('3.1 Sub-Millisecond & Boundary Deltas (0ms to 2001ms)', async () => {
      const { d1, sqlite } = createRealSqliteD1();

      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES ('c-prior', 'deal-1', ?, ?, ?)
      `);

      // Boundary Matrix Tests
      const testCases = [
        { deltaMs: 0, expectedBurst: true, expectedScore: 0.90, desc: 'Exact 0ms (simultaneous burst)' },
        { deltaMs: 1, expectedBurst: true, expectedScore: 0.90, desc: '1ms delta' },
        { deltaMs: 500, expectedBurst: true, expectedScore: 0.90, desc: '500ms delta (sub-second)' },
        { deltaMs: 999, expectedBurst: true, expectedScore: 0.90, desc: '999ms delta (sub-second upper bound)' },
        { deltaMs: 1000, expectedBurst: true, expectedScore: 0.85, desc: '1000ms delta (1-2s lower bound)' },
        { deltaMs: 1500, expectedBurst: true, expectedScore: 0.85, desc: '1500ms delta' },
        { deltaMs: 1999, expectedBurst: true, expectedScore: 0.85, desc: '1999ms delta (burst upper bound)' },
        { deltaMs: 2000, expectedBurst: false, expectedScore: 0.0, desc: '2000ms delta (exact window cutoff -> clean)' },
        { deltaMs: 2001, expectedBurst: false, expectedScore: 0.0, desc: '2001ms delta (clean)' },
      ];

      for (const tc of testCases) {
        sqlite.exec('DELETE FROM deal_clicks');
        const priorTime = new Date(baseNow - tc.deltaMs).toISOString();
        insertClick.run(testSession, testIp, priorTime);

        const result = await evaluateClickVelocity(d1, {
          dealId: 'deal-1',
          sessionId: testSession,
          ipAddress: testIp,
          timestamp: baseNow,
          affiliateCode: 'aff-1',
        });

        expect(result.burstDetected).toBe(tc.expectedBurst);
        expect(result.anomalyScore).toBe(tc.expectedScore);
        if (tc.expectedBurst) {
          expect(result.isSuspicious).toBe(true);
          expect(result.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
          expect(result.burstDetails?.deltaMs).toBe(tc.deltaMs);
        } else {
          expect(result.isSuspicious).toBe(false);
          expect(result.flagReasons).not.toContain(FraudReasonCode.BURST_CLICK);
        }
      }
    });

    it('3.2 Clock Skew & Out-of-Order Distributed Events (negative deltaMs resilience)', async () => {
      const { d1, sqlite } = createRealSqliteD1();

      // Prior click in DB has a timestamp in the future relative to current arriving click (clock skew)
      const priorTime = new Date(baseNow + 5000).toISOString();
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES ('c-prior-skew', 'deal-1', ?, ?, ?)
      `).run(testSession, testIp, priorTime);

      const result = await evaluateClickVelocity(d1, {
        dealId: 'deal-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: baseNow, // now is 5000ms earlier than prior click (deltaMs = -5000ms)
        affiliateCode: 'aff-1',
      });

      // Strict deltaMs >= 0 protects against treating out-of-order clicks as bursts
      expect(result.burstDetected).toBe(false);
      expect(result.anomalyScore).toBe(0.0);
      expect(result.isSuspicious).toBe(false);
      expect(result.flagReasons).toEqual([]);
    });

    it('3.3 Session vs IP Disambiguation in Burst Attribution', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const insert = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, session_id, ip_address, created_at)
        VALUES (?, 'deal-1', ?, ?, ?)
      `);

      // Scenario A: Same session, different IP (session matched)
      insert.run('c-sess', 'shared-session', '198.51.100.1', new Date(baseNow - 500).toISOString());
      const resSess = await evaluateClickVelocity(d1, {
        dealId: 'deal-1',
        sessionId: 'shared-session',
        ipAddress: '198.51.100.2',
        timestamp: baseNow,
      });
      expect(resSess.burstDetected).toBe(true);
      expect(resSess.burstDetails?.matchedBy).toBe('session');

      // Scenario B: Same IP, different session (IP matched)
      sqlite.exec('DELETE FROM deal_clicks');
      insert.run('c-ip', 'session-alpha', '198.51.100.5', new Date(baseNow - 500).toISOString());
      const resIp = await evaluateClickVelocity(d1, {
        dealId: 'deal-1',
        sessionId: 'session-beta',
        ipAddress: '198.51.100.5',
        timestamp: baseNow,
      });
      expect(resIp.burstDetected).toBe(true);
      expect(resIp.burstDetails?.matchedBy).toBe('ip');
    });

    it('3.4 Conversion Status Filtering & Ratio Boundary Conditions', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const dealId = 'deal-tier5';
      const affiliateCode = 'aff-ratio-tier5';

      const insertClick = sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id, created_at)
        VALUES (?, ?, ?, 'sess', datetime('now'))
      `);
      const insertConv = sqlite.prepare(`
        INSERT INTO conversions (id, deal_id, affiliate_code, user_id, status, created_at)
        VALUES (?, ?, ?, 'usr-1', ?, datetime('now'))
      `);

      // 1. Sample Size Floor: 9 clicks, 0 conversions -> Clean (< 10 clicks required)
      for (let i = 0; i < 9; i++) {
        insertClick.run(`c-${i}`, dealId, affiliateCode);
      }
      const res9 = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode,
        sessionId: 'sess-new',
        ipAddress: '198.51.100.1',
      });
      expect(res9.ratioAnomalyDetected).toBe(false);

      // 2. Add 10th click with 0 conversions -> FLAGGED (ratio = Infinity > 10)
      insertClick.run('c-9', dealId, affiliateCode);
      const res10 = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode,
        sessionId: 'sess-new',
        ipAddress: '198.51.100.1',
      });
      expect(res10.ratioAnomalyDetected).toBe(true);
      expect(res10.isSuspicious).toBe(true);
      expect(res10.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(res10.ratioDetails?.totalClicks).toBe(10);
      expect(res10.ratioDetails?.totalConversions).toBe(0);

      // 3. Add unconfirmed conversion statuses: 'pending', 'rejected', 'refunded'
      // These MUST NOT count as valid conversions!
      insertConv.run('conv-pen-1', dealId, affiliateCode, 'pending');
      insertConv.run('conv-pen-2', dealId, affiliateCode, 'pending');
      insertConv.run('conv-rej-1', dealId, affiliateCode, 'rejected');

      const resUnconfirmed = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode,
        sessionId: 'sess-new',
        ipAddress: '198.51.100.1',
      });
      // Conversions remain 0 because pending and rejected are ignored
      expect(resUnconfirmed.ratioAnomalyDetected).toBe(true);
      expect(resUnconfirmed.ratioDetails?.totalConversions).toBe(0);

      // 4. Add 1 'confirmed' conversion -> ratio = 10 / 1 = 10.0 (boundary condition: strictly > 10 triggers)
      insertConv.run('conv-conf-1', dealId, affiliateCode, 'confirmed');

      const resRatio10 = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode,
        sessionId: 'sess-new',
        ipAddress: '198.51.100.1',
      });
      expect(resRatio10.ratioAnomalyDetected).toBe(false); // 10.0 is NOT > 10.0 -> clean!

      // 5. Add 11th click -> ratio = 11 / 1 = 11.0 > 10.0 -> FLAGGED!
      insertClick.run('c-10', dealId, affiliateCode);
      const resRatio11 = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode,
        sessionId: 'sess-new',
        ipAddress: '198.51.100.1',
      });
      expect(resRatio11.ratioAnomalyDetected).toBe(true);

      // 6. Add 1 'approved' conversion -> total confirmed+approved = 2 -> ratio = 11 / 2 = 5.5 <= 10 -> CLEAN!
      insertConv.run('conv-appr-1', dealId, affiliateCode, 'approved');
      const resRatioClean = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode,
        sessionId: 'sess-new',
        ipAddress: '198.51.100.1',
      });
      expect(resRatioClean.ratioAnomalyDetected).toBe(false);
      expect(resRatioClean.isSuspicious).toBe(false);
    });

    it('3.5 Multi-Tenancy Cross-Deal & Cross-Affiliate Strict Isolation', async () => {
      const { d1, sqlite } = createRealSqliteD1();

      // Populate Deal A with 100 clicks and 100 confirmed conversions (healthy 1:1 ratio)
      for (let i = 0; i < 100; i++) {
        sqlite.prepare("INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id) VALUES (?, 'deal-A', 'aff-A', 'sess')")
          .run(`ca-${i}`);
        sqlite.prepare("INSERT INTO conversions (id, deal_id, affiliate_code, user_id, status) VALUES (?, 'deal-A', 'aff-A', 'usr', 'confirmed')")
          .run(`cva-${i}`);
      }

      // Populate Deal B for same affiliate with 15 clicks and 0 conversions
      for (let i = 0; i < 15; i++) {
        sqlite.prepare("INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id) VALUES (?, 'deal-B', 'aff-A', 'sess')")
          .run(`cb-${i}`);
      }

      // Checking Deal B must NOT inherit conversions from Deal A
      const resDealB = await evaluateClickVelocity(d1, {
        dealId: 'deal-B',
        affiliateCode: 'aff-A',
        sessionId: 'sess-check',
        ipAddress: '198.51.100.10',
      });
      expect(resDealB.ratioAnomalyDetected).toBe(true);
      expect(resDealB.ratioDetails?.totalConversions).toBe(0);

      // Checking Deal A remains clean
      const resDealA = await evaluateClickVelocity(d1, {
        dealId: 'deal-A',
        affiliateCode: 'aff-A',
        sessionId: 'sess-check',
        ipAddress: '198.51.100.10',
      });
      expect(resDealA.ratioAnomalyDetected).toBe(false);

      // Fallback via affiliateId when affiliateCode is null
      sqlite.prepare("INSERT INTO deal_clicks (id, deal_id, affiliate_id, session_id) VALUES ('cid-1', 'deal-C', 'aff-id-only', 'sess')")
        .run();
      const resAffId = await evaluateClickVelocity(d1, {
        dealId: 'deal-C',
        affiliateCode: null,
        affiliateId: 'aff-id-only',
        sessionId: 'sess-check',
        ipAddress: '198.51.100.10',
      });
      expect(resAffId.isSuspicious).toBe(false); // only 1 click, clean
    });

    it('3.6 Mathematical Multi-Anomaly Score Stacking Precision & Arithmetic Clamping', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const dealId = 'deal-stack';
      const affCode = 'aff-stack';
      const nowMs = 1758816000000;

      // 1. Create ratio anomaly conditions (15 clicks, 0 conversions -> score 0.70)
      for (let i = 0; i < 15; i++) {
        sqlite.prepare("INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id, ip_address, created_at) VALUES (?, ?, ?, 'sess', '198.51.100.99', ?)")
          .run(`c-stk-${i}`, dealId, affCode, new Date(nowMs - 3600000).toISOString());
      }

      // 2. Add prior burst click 500ms ago (sub-second burst -> burstScore 0.90)
      sqlite.prepare("INSERT INTO deal_clicks (id, deal_id, affiliate_code, session_id, ip_address, created_at) VALUES ('c-burst', ?, ?, 'sess-stack', '198.51.100.99', ?)")
        .run(dealId, affCode, new Date(nowMs - 500).toISOString());

      const resSubSecondStacked = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode: affCode,
        sessionId: 'sess-stack',
        ipAddress: '198.51.100.99',
        timestamp: nowMs,
      });

      expect(resSubSecondStacked.burstDetected).toBe(true);
      expect(resSubSecondStacked.ratioAnomalyDetected).toBe(true);
      // Math: 1 - (1 - 0.90) * (1 - 0.70) = 1 - (0.10 * 0.30) = 1 - 0.03 = 0.9700
      expect(resSubSecondStacked.anomalyScore).toBe(0.97);
      expect(resSubSecondStacked.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
      expect(resSubSecondStacked.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);

      // 3. Test standard 1-2s burst (1500ms ago -> burstScore 0.85) stacked with ratio (0.70)
      sqlite.prepare("UPDATE deal_clicks SET created_at = ? WHERE id = 'c-burst'")
        .run(new Date(nowMs - 1500).toISOString());

      const resStandardStacked = await evaluateClickVelocity(d1, {
        dealId,
        affiliateCode: affCode,
        sessionId: 'sess-stack',
        ipAddress: '198.51.100.99',
        timestamp: nowMs,
      });

      expect(resStandardStacked.burstDetected).toBe(true);
      expect(resStandardStacked.ratioAnomalyDetected).toBe(true);
      // Math: 1 - (1 - 0.85) * (1 - 0.70) = 1 - (0.15 * 0.30) = 1 - 0.045 = 0.9550
      expect(resStandardStacked.anomalyScore).toBe(0.955);
    });

    it('3.7 Timestamp Parsing Normalization Matrix (parseTimestampMs)', () => {
      const now = Date.now();
      expect(parseTimestampMs(null)).toBeCloseTo(now, -3);
      expect(parseTimestampMs(undefined)).toBeCloseTo(now, -3);
      expect(parseTimestampMs(1758816000000)).toBe(1758816000000);
      expect(parseTimestampMs('1758816000000')).toBe(1758816000000);
      expect(parseTimestampMs(new Date('2026-09-26T00:00:00Z'))).toBe(1790380800000);

      // SQLite space-separated format normalization
      const sqliteEpoch = parseTimestampMs('2026-09-26 00:00:00');
      const isoEpoch = parseTimestampMs('2026-09-26T00:00:00Z');
      expect(sqliteEpoch).toBe(isoEpoch);

      // Timezone offset preservation
      const tzMs = parseTimestampMs('2026-09-26T07:00:00+07:00');
      expect(tzMs).toBe(isoEpoch);
    });
  });

  // ==========================================================================
  // SUITE 4: Click Routes Defense-in-Depth Pipeline & Fail-Open Resilience
  // ==========================================================================
  describe('Suite 4: Click Routes Defense-in-Depth Pipeline & Fail-Open Resilience', () => {
    const activeDealId = 'deal-active-1';
    const inactiveDealId = 'deal-inactive-1';

    it('4.1 POST /api/deals/[id]/click Stage 1 (Blocklist) Precedence Over Deal Lookup & Rate Limit', async () => {
      // Mark IP as blocked
      const blockedIp = '198.51.100.99';
      mockFraudDB.blockedIps.set(blockedIp, {
        id: 'blk-1',
        ip_address: blockedIp,
        reason: 'Malicious Bot',
        blocked_by: 'system',
        blocked_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const initialClicks = mockFraudDB.dealClicks.size;

      // Even when requesting a non-existent or inactive deal, Stage 1 Blocklist fires first!
      const req = createFraudTestRequest(`/api/deals/non-existent-deal/click`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': blockedIp },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: 'non-existent-deal' }
      );

      expect(res.status).toBe(403);
      expect(res.data?.error).toBe('Forbidden');
      expect(mockFraudDB.dealClicks.size).toBe(initialClicks); // Zero side-effects
    });

    it('4.2 POST /api/deals/[id]/click Deal Active Status Validation (404 and 410)', async () => {
      const cleanIp = '198.51.100.55';

      // 1. Non-existent deal -> 404 Not Found
      const reqNotFound = createFraudTestRequest(`/api/deals/no-such-deal/click`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': cleanIp },
      });
      const resNotFound = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        reqNotFound,
        { id: 'no-such-deal' }
      );
      expect(resNotFound.status).toBe(404);
      expect(resNotFound.data?.error).toMatch(/not found/i);

      // 2. Inactive deal -> 410 Gone
      const reqInactive = createFraudTestRequest(`/api/deals/${inactiveDealId}/click`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': cleanIp },
      });
      const resInactive = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        reqInactive,
        { id: inactiveDealId }
      );
      expect(resInactive.status).toBe(410);
      expect(resInactive.data?.error).toMatch(/not active/i);
    });

    it('4.3 Stage 2 (Rate Limit) Precedence Over Click Recording', async () => {
      const rateLimitedIp = '198.51.100.77';

      // Saturate rate limit for this IP
      for (let i = 0; i < 100; i++) {
        mockFraudDB.dealClicks.set(`c-sat-${i}`, {
          id: `c-sat-${i}`,
          deal_id: activeDealId,
          affiliate_code: 'aff-1',
          affiliate_id: 'aff-1',
          session_id: 'sess-sat',
          ip_address: rateLimitedIp,
          user_agent: 'agent',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date().toISOString(),
        });
      }

      const initialClicks = mockFraudDB.dealClicks.size;

      const req = createFraudTestRequest(`/api/deals/${activeDealId}/click`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': rateLimitedIp },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: activeDealId }
      );

      expect(res.status).toBe(429);
      expect(res.data?.error).toBe('Too Many Requests');
      expect(res.headers.get('Retry-After')).toBeDefined();
      expect(mockFraudDB.dealClicks.size).toBe(initialClicks); // Zero clicks logged when rate limited
    });

    it('4.4 Stage 3 Velocity Detection: Suspicious clicks flagged passively without breaking redirect', async () => {
      const suspiciousIp = '198.51.100.88';
      const sessionId = 'sess-burst-route';

      // Seed prior click 200ms ago to trigger burst velocity detection
      mockFraudDB.dealClicks.set('c-prior-route', {
        id: 'c-prior-route',
        deal_id: activeDealId,
        affiliate_code: 'aff-burst',
        affiliate_id: 'aff-burst',
        session_id: sessionId,
        ip_address: suspiciousIp,
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(Date.now() - 200).toISOString(),
      });

      const req = createFraudTestRequest(`/api/deals/${activeDealId}/click`, {
        method: 'POST',
        headers: { 'cf-connecting-ip': suspiciousIp },
        trackingCookie: sessionId,
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: activeDealId }
      );

      // Passive detection principle: User receives 200 OK and redirectUrl to avoid UX interruption
      expect(res.status).toBe(200);
      expect(res.data?.success).toBe(true);

      // Verify the recorded click in DB was flagged
      const newClicks = Array.from(mockFraudDB.dealClicks.values()).filter(
        (c) => c.session_id === sessionId && c.id !== 'c-prior-route'
      );
      expect(newClicks.length).toBe(1);
      const flaggedClick = newClicks[0];
      expect(flaggedClick.is_suspicious).toBe(1);
      expect(flaggedClick.anomaly_score).toBeGreaterThanOrEqual(0.85);
      expect(flaggedClick.flag_reasons).toContain(FraudReasonCode.BURST_CLICK);
    });

    it('4.5 GET /api/tracking/click Parameter Validation & Absolute Safe Redirect', async () => {
      // 1. Missing deal_id parameter -> 400 Bad Request
      const reqMissing = createFraudTestRequest('/api/tracking/click', { method: 'GET' });
      const resMissing = await dispatchRoute('src/app/api/tracking/click/route.ts', 'GET', reqMissing);
      expect(resMissing.status).toBe(400);
      expect(resMissing.data?.error).toMatch(/Missing required parameter/i);

      // 2. Safe Redirect construction with ref pass-through
      const reqValid = createFraudTestRequest(
        `/api/tracking/click?deal_id=${activeDealId}&ref=REF999&redirect=https://custom-partner.com/welcome`,
        { method: 'GET' }
      );
      const resValid = await dispatchRoute('src/app/api/tracking/click/route.ts', 'GET', reqValid);

      expect(resValid.status).toBe(302);
      const redirectLocation = resValid.rawResponse?.headers?.get('location');
      expect(redirectLocation).toContain('https://custom-partner.com/welcome');
      expect(redirectLocation).toContain('ref=REF999');
    });
  });

  // ==========================================================================
  // SUITE 5: Matcher Attribution Multi-Tenancy & Anti-Circumvention Isolation
  // ==========================================================================
  describe('Suite 5: Matcher Attribution Multi-Tenancy & Anti-Circumvention Isolation', () => {
    it('5.1 Multi-Tenancy Deal Isolation (Trader click on Deal 1 cannot attribute Deal 2)', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const matcher = createMatcher(d1 as any);

      // Trader clicked Deal 1 with affiliate code 'AFFILIATE1'
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, ip_address, is_suspicious, created_at)
        VALUES ('click-deal-1', 'deal-active-1', 'AFFILIATE1', 'usr-affiliate-1', 'sess-trader', '198.51.100.1', 0, datetime('now'))
      `).run();

      // Matcher invoked for Deal 2 (deal-binance-spot)
      const result = await matcher.match({
        dealId: 'deal-binance-spot',
        userIdentifier: '0x1111111111111111111111111111111111111111',
        tradeVolumeUsd: 10000,
      });

      // Attribution must NOT leak across deals!
      expect(result.click).toBeNull();
      expect(result.commissions.length).toBe(0);
      expect(result.totalCommission).toBe(0);
    });

    it('5.2 Cookie Window Expiration Boundary (click at 31 days ignored; 29 days attributed)', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const matcher = createMatcher(d1 as any, { cookieDurationDays: 30 });
      const now = Date.now();

      // Click 31 days ago (outside 30-day window)
      const expiredClickTime = new Date(now - (31 * 24 * 3600 * 1000)).toISOString();
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, ip_address, is_suspicious, created_at)
        VALUES ('click-expired', 'deal-active-1', 'AFFILIATE1', 'usr-affiliate-1', 'sess-trader', '198.51.100.1', 0, ?)
      `).run(expiredClickTime);

      const resExpired = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: '0x1111111111111111111111111111111111111111',
        tradeVolumeUsd: 1000,
      });
      expect(resExpired.click).toBeNull();

      // Add Click 29 days ago (inside window)
      const validClickTime = new Date(now - (29 * 24 * 3600 * 1000)).toISOString();
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, ip_address, is_suspicious, created_at)
        VALUES ('click-valid', 'deal-active-1', 'AFFILIATE1', 'usr-affiliate-1', 'sess-trader', '198.51.100.1', 0, ?)
      `).run(validClickTime);

      const resValid = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: '0x1111111111111111111111111111111111111111',
        tradeVolumeUsd: 1000,
      });
      expect(resValid.click).not.toBeNull();
      expect(resValid.click?.id).toBe('click-valid');
      expect(resValid.commissions.length).toBeGreaterThan(0);
    });

    it('5.3 User Identifier Resolution (EVM, Solana, Email & Invalid)', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const matcher = createMatcher(d1 as any);

      // 1. EVM Wallet Address
      const evmUser = await matcher.lookupUser('0x1111111111111111111111111111111111111111');
      expect(evmUser).not.toBeNull();
      expect(evmUser?.id).toBe('usr-trader-1');

      // 2. Email Address
      const emailUser = await matcher.lookupUser('trader1@apex-os.com');
      expect(emailUser).not.toBeNull();
      expect(emailUser?.id).toBe('usr-trader-1');

      // 3. Solana Base58 Address (must satisfy Base58 charset omitting 0, O, I, l)
      const solanaAddr = '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin';
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, plan, tier, referral_code)
        VALUES ('usr-solana-1', 'solana@apex-os.com', 'Solana Trader', 'trader', 'free', 'BASIC', 'SOL1')
      `).run();
      // Matcher lowercases identifiers when querying wallet_connections
      sqlite.prepare(`
        INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain, is_primary)
        VALUES ('wc-sol', 'usr-solana-1', ?, 'solana', 1)
      `).run(solanaAddr.toLowerCase());

      const solUser = await matcher.lookupUser(solanaAddr);
      expect(solUser).not.toBeNull();
      expect(solUser?.id).toBe('usr-solana-1');

      // 4. Unknown identifier
      const unknownUser = await matcher.lookupUser('unknown@nonexistent.com');
      expect(unknownUser).toBeNull();
    });

    it('5.4 Tiered Commission Math Across Percentage & Fixed Deals', async () => {
      const { d1, sqlite } = createRealSqliteD1();
      const matcher = createMatcher(d1 as any);

      // Create a 3-level referral tree: Root (admin) -> Level 2 (usr-affiliate-1) -> Level 1 (referral code REF3)
      sqlite.prepare(`
        INSERT INTO profiles (id, email, full_name, role, plan, tier, referral_code)
        VALUES ('usr-affiliate-3', 'aff3@apex-os.com', 'Level 1 Direct Affiliate', 'affiliate', 'pro', 'PREMIUM', 'REF3')
      `).run();
      sqlite.prepare(`
        INSERT INTO referral_tree (id, affiliate_id, parent_id, path)
        VALUES ('rt-tier3', 'usr-affiliate-3', 'usr-affiliate-1', 'usr-admin-1/usr-affiliate-1/usr-affiliate-3')
      `).run();

      // Legitimate click attributing to REF3
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, ip_address, is_suspicious, created_at)
        VALUES ('click-tiered', 'deal-active-1', 'REF3', 'usr-affiliate-3', 'sess-tiered', '198.51.100.1', 0, datetime('now'))
      `).run();

      // 1. Percentage Deal: deal-active-1 (10% rate, $10,000 volume -> $1,000 pool)
      const resPercentage = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 10000,
      });

      expect(resPercentage.commissions.length).toBe(3);
      // Tier 1 (Direct: usr-affiliate-3): 30% of $1,000 = $300
      expect(resPercentage.commissions[0].level).toBe(1);
      expect(resPercentage.commissions[0].amount).toBeCloseTo(300, 2);
      // Tier 2 (Parent: usr-affiliate-1): 10% of $1,000 = $100
      expect(resPercentage.commissions[1].level).toBe(2);
      expect(resPercentage.commissions[1].amount).toBeCloseTo(100, 2);
      // Tier 3 (Grandparent: usr-admin-1): 5% of $1,000 = $50
      expect(resPercentage.commissions[2].level).toBe(3);
      expect(resPercentage.commissions[2].amount).toBeCloseTo(50, 2);

      expect(resPercentage.totalCommission).toBeCloseTo(450, 2);

      // 2. Fixed Commission Deal: $50 fixed commission
      sqlite.prepare(`
        INSERT INTO deals (id, url, title, name, is_active, default_commission_type, fixed_commission_amount)
        VALUES ('deal-fixed', 'https://partner.com/fixed', 'Fixed Deal', 'Fixed Deal', 1, 'fixed', 50)
      `).run();
      sqlite.prepare(`
        INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, ip_address, is_suspicious, created_at)
        VALUES ('click-fixed', 'deal-fixed', 'REF3', 'usr-affiliate-3', 'sess-fixed', '198.51.100.1', 0, datetime('now'))
      `).run();

      const resFixed = await matcher.match({
        dealId: 'deal-fixed',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 10000,
      });

      expect(resFixed.commissions.length).toBe(3);
      // Tier 1: 30% of $50 = $15
      expect(resFixed.commissions[0].amount).toBeCloseTo(15, 2);
      // Tier 2: 10% of $50 = $5
      expect(resFixed.commissions[1].amount).toBeCloseTo(5, 2);
      // Tier 3: 5% of $50 = $2.50
      expect(resFixed.commissions[2].amount).toBeCloseTo(2.5, 2);
      expect(resFixed.totalCommission).toBeCloseTo(22.5, 2);
    });
  });
});
