/**
 * Milestone 2 Test Suite: Click Rate-Limiting, IP Blocking & Route Protection
 * Location: src/__tests__/fraud/m2-rate-limiting.test.ts
 *
 * Comprehensive tests covering all M2 deliverables:
 * 1. Dual-window rate limiting boundaries (100 clicks/hour, 1,000 clicks/day)
 * 2. RFC 6585 HTTP 429 response format with Retry-After and X-RateLimit-* headers
 * 3. IP Blocklist validation and zero-side-effect HTTP 403 Forbidden (no deal_clicks inserts)
 * 4. Repeat offender auto-blocking escalation
 * 5. Relative URL redirect fix in src/app/api/tracking/click/route.ts
 * 6. Matcher attribution filter ignoring is_suspicious = 1 while matching is_suspicious = 0
 */

import {
  mockFraudDB,
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
  createBlockedIp403Response,
  normalizeIpAddress,
  extractClientIp,
} from '@/lib/fraud/ip-blocker';
import { Matcher } from '@/lib/tracking/matcher';
import { FraudReasonCode } from '@/types/fraud';

beforeAll(() => {
  setupFraudTestEnvironment();
});

beforeEach(() => {
  mockFraudDB.reset();
  // Ensure default active deal exists
  mockFraudDB.deals.set('deal-active-1', {
    id: 'deal-active-1',
    url: 'https://partner.exchange.com/register?ref=apex',
    title: 'Active Deal 1',
    is_active: 1,
    created_at: new Date().toISOString(),
  });
  // Ensure default profile exists for matcher tests
  mockFraudDB.profiles.set('usr-trader-1', {
    id: 'usr-trader-1',
    email: 'trader1@apex-os.com',
    full_name: 'Trader One',
    role: 'user',
    created_at: new Date().toISOString(),
  });
});

describe('Milestone 2: Rate Limiting & Route Protection', () => {
  // ============================================================================
  // 1. Dual-Window Rate Limiting Boundaries (100/hr, 1,000/day)
  // ============================================================================
  describe('1. Dual-Window Rate Limiting Boundaries', () => {
    const testIp = '198.51.100.10';

    it('allows 1st through 100th clicks in 1 hour (exact 100/hr boundary)', async () => {
      const now = Date.now();

      // Seed 99 clicks within the last 10 minutes
      for (let i = 0; i < 99; i++) {
        mockFraudDB.dealClicks.set(`c-hr-${i}`, {
          id: `c-hr-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: testIp,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - (i + 1) * 5000).toISOString(),
        });
      }

      // 100th click check (before insertion)
      const res100 = await checkIpRateLimit(mockFraudDB as any, testIp);
      expect(res100.allowed).toBe(true);
      expect(res100.hourlyRemaining).toBe(1);
      expect(res100.exceededWindow).toBeNull();
      expect(res100.isBlocked).toBe(false);

      // Record 100th click
      mockFraudDB.dealClicks.set('c-hr-100', {
        id: 'c-hr-100',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u1',
        session_id: 's-100',
        ip_address: testIp,
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date().toISOString(),
      });

      // 101st click check must be rejected
      const res101 = await checkIpRateLimit(mockFraudDB as any, testIp);
      expect(res101.allowed).toBe(false);
      expect(res101.hourlyRemaining).toBe(0);
      expect(res101.exceededWindow).toBe('hourly');
      expect(res101.reason).toBe(FraudReasonCode.RATE_LIMIT_EXCEEDED);
      expect(res101.retryAfter).toBeGreaterThan(0);
      expect(res101.retryAfter).toBeLessThanOrEqual(3600);
    });

    it('sliding window expires hourly clicks older than 3600 seconds', async () => {
      const now = Date.now();

      // Seed 100 clicks that are 2 hours old (outside 1-hour window)
      for (let i = 0; i < 100; i++) {
        mockFraudDB.dealClicks.set(`c-old-hr-${i}`, {
          id: `c-old-hr-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: testIp,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - 7200 * 1000 - i * 1000).toISOString(),
        });
      }

      // Because all clicks are older than 1 hour, hourly window count is 0
      const res = await checkIpRateLimit(mockFraudDB as any, testIp);
      expect(res.allowed).toBe(true);
      expect(res.hourlyRemaining).toBe(100);
    });

    it('allows 1st through 1,000th clicks in 24 hours (exact 1,000/day boundary)', async () => {
      const dailyIp = '198.51.100.20';
      const now = Date.now();

      // Seed 999 clicks spread over the last 20 hours (e.g. 50 clicks/hour, well below hourly limit)
      for (let i = 0; i < 999; i++) {
        const offsetSeconds = 3600 + ((i * 70000) / 999); // all between 1h and 20h ago
        mockFraudDB.dealClicks.set(`c-day-${i}`, {
          id: `c-day-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: dailyIp,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - offsetSeconds * 1000).toISOString(),
        });
      }

      // 1,000th click check (before insertion)
      const res1000 = await checkIpRateLimit(mockFraudDB as any, dailyIp);
      expect(res1000.allowed).toBe(true);
      expect(res1000.dailyRemaining).toBe(1);
      expect(res1000.exceededWindow).toBeNull();

      // Record 1,000th click
      mockFraudDB.dealClicks.set('c-day-1000', {
        id: 'c-day-1000',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u1',
        session_id: 's-1000',
        ip_address: dailyIp,
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 3700 * 1000).toISOString(),
      });

      // 1,001st click check must be rejected due to daily limit
      const res1001 = await checkIpRateLimit(mockFraudDB as any, dailyIp);
      expect(res1001.allowed).toBe(false);
      expect(res1001.dailyRemaining).toBe(0);
      expect(res1001.exceededWindow).toBe('daily');
      expect(res1001.reason).toBe(FraudReasonCode.RATE_LIMIT_EXCEEDED);
      expect(res1001.retryAfter).toBeGreaterThan(0);
      expect(res1001.retryAfter).toBeLessThanOrEqual(86400);
    });

    it('sliding window expires daily clicks older than 86,400 seconds', async () => {
      const dailyIp = '198.51.100.25';
      const now = Date.now();

      // Seed 1,000 clicks that are 30 hours old (outside 24-hour window)
      for (let i = 0; i < 1000; i++) {
        mockFraudDB.dealClicks.set(`c-old-day-${i}`, {
          id: `c-old-day-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: dailyIp,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(now - 108000 * 1000 - i * 1000).toISOString(),
        });
      }

      const res = await checkIpRateLimit(mockFraudDB as any, dailyIp);
      expect(res.allowed).toBe(true);
      expect(res.dailyRemaining).toBe(1000);
      expect(res.hourlyRemaining).toBe(100);
    });

    it('enforces completely independent limits across different IP addresses', async () => {
      const ipA = '198.51.100.50';
      const ipB = '198.51.100.51';

      // Flood IP A with 105 clicks
      for (let i = 0; i < 105; i++) {
        mockFraudDB.dealClicks.set(`c-ipa-${i}`, {
          id: `c-ipa-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-1',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: ipA,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date().toISOString(),
        });
      }

      // IP A is rate limited
      const resA = await checkIpRateLimit(mockFraudDB as any, ipA);
      expect(resA.allowed).toBe(false);

      // IP B has 0 clicks and is completely unaffected
      const resB = await checkIpRateLimit(mockFraudDB as any, ipB);
      expect(resB.allowed).toBe(true);
      expect(resB.hourlyRemaining).toBe(100);
      expect(resB.dailyRemaining).toBe(1000);
    });
  });

  // ============================================================================
  // 2. RFC 6585 HTTP 429 Response Format & Headers
  // ============================================================================
  describe('2. RFC 6585 HTTP 429 Response Format & Headers', () => {
    it('generates standard RFC 6585 429 response structure with all required headers', async () => {
      const rateLimitResult = {
        allowed: false,
        hourlyRemaining: 0,
        dailyRemaining: 900,
        hourlyLimit: 100,
        dailyLimit: 1000,
        hourlyResetAt: Math.floor(Date.now() / 1000) + 1800,
        dailyResetAt: Math.floor(Date.now() / 1000) + 80000,
        retryAfter: 1800,
        exceededWindow: 'hourly' as const,
        isBlocked: true,
        autoBlocked: false,
        reason: 'RATE_LIMIT_EXCEEDED',
      };

      const response = createRateLimit429Response(rateLimitResult);
      expect(response.status).toBe(429);

      const json = await response.json();
      expect(json).toEqual({
        error: 'Too Many Requests',
        message: 'Click rate limit exceeded. Please retry after 1800 seconds.',
        retryAfter: 1800,
      });

      // Verify RFC 6585 and rate limiting headers
      expect(response.headers.get('Retry-After')).toBe('1800');
      expect(response.headers.get('X-RateLimit-Limit')).toBe('100');
      expect(response.headers.get('X-RateLimit-Remaining')).toBe('0');
      expect(response.headers.get('X-RateLimit-Reset')).toBe(String(rateLimitResult.hourlyResetAt));
      expect(response.headers.get('X-RateLimit-Reset-After')).toBe('1800s');
    });

    it('routes return HTTP 429 with RFC headers when rate limit is exceeded', async () => {
      const floodingIp = '198.51.100.99';

      // Seed 100 clicks to max out hourly capacity
      for (let i = 0; i < 100; i++) {
        mockFraudDB.dealClicks.set(`c-flood-${i}`, {
          id: `c-flood-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-flood',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: floodingIp,
          user_agent: 'Mozilla/5.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date().toISOString(),
        });
      }

      // Test POST /api/deals/[id]/click
      const postReq = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'POST',
        headers: { 'cf-connecting-ip': floodingIp },
      });
      const postRes = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        postReq,
        { id: 'deal-active-1' }
      );

      expect(postRes.status).toBe(429);
      expect(postRes.data.error).toBe('Too Many Requests');
      expect(postRes.headers.get('Retry-After')).toBeDefined();
      expect(postRes.headers.get('X-RateLimit-Limit')).toBe('100');
      expect(postRes.headers.get('X-RateLimit-Remaining')).toBe('0');

      // Test GET /api/tracking/click
      const trackReq = createFraudTestRequest(
        'http://localhost:3000/api/tracking/click?deal_id=deal-active-1',
        {
          method: 'GET',
          headers: { 'cf-connecting-ip': floodingIp },
        }
      );
      const trackRes = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        trackReq
      );

      expect(trackRes.status).toBe(429);
      expect(trackRes.data.error).toBe('Too Many Requests');
      expect(trackRes.headers.get('Retry-After')).toBeDefined();
    });
  });

  // ============================================================================
  // 3. IP Blocklist Enforcement & Zero-Side-Effect 403 Forbidden
  // ============================================================================
  describe('3. IP Blocklist Enforcement & Zero-Side-Effect 403 Forbidden', () => {
    const cleanIp = '198.51.100.100';
    const blockedIp = '203.0.113.50';

    it('isIpBlocked accurately identifies clean, active, and expired blocked IPs', async () => {
      // 1. Clean IP
      expect(await isIpBlocked(mockFraudDB as any, cleanIp)).toBe(false);

      // 2. Active permanent block (expires_at is null)
      mockFraudDB.blockedIps.set(blockedIp, {
        id: 'block-1',
        ip_address: blockedIp,
        reason: 'Malicious bot traffic',
        blocked_by: 'admin-001',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });
      expect(await isIpBlocked(mockFraudDB as any, blockedIp)).toBe(true);

      // 3. Expired block (expires_at in past)
      const expiredIp = '203.0.113.51';
      mockFraudDB.blockedIps.set(expiredIp, {
        id: 'block-exp',
        ip_address: expiredIp,
        reason: 'Temporary rate limit violation',
        blocked_by: 'system',
        created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
        expires_at: new Date(Date.now() - 1000).toISOString(), // expired 1s ago
        is_active: 1,
      });
      expect(await isIpBlocked(mockFraudDB as any, expiredIp)).toBe(false);

      // 4. Future expiration block (still active)
      const futureIp = '203.0.113.52';
      mockFraudDB.blockedIps.set(futureIp, {
        id: 'block-fut',
        ip_address: futureIp,
        reason: 'Temporary 1-hour block',
        blocked_by: 'system',
        created_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3600 * 1000).toISOString(),
        is_active: 1,
      });
      expect(await isIpBlocked(mockFraudDB as any, futureIp)).toBe(true);

      // 5. Inactive block (is_active = 0)
      const inactiveIp = '203.0.113.53';
      mockFraudDB.blockedIps.set(inactiveIp, {
        id: 'block-inact',
        ip_address: inactiveIp,
        reason: 'Unblocked by admin',
        blocked_by: 'admin-001',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 0,
      });
      expect(await isIpBlocked(mockFraudDB as any, inactiveIp)).toBe(false);
    });

    it('normalizes IPv4, IPv4-mapped IPv6, and IPv6 loopback properly', async () => {
      expect(normalizeIpAddress('  192.0.2.1  ')).toBe('192.0.2.1');
      expect(normalizeIpAddress('::ffff:192.0.2.1')).toBe('192.0.2.1');
      expect(normalizeIpAddress('::1')).toBe('::1');
      expect(normalizeIpAddress('2001:0DB8:85A3::8A2E:0370:7334')).toBe('2001:0db8:85a3::8a2e:0370:7334');

      // Blocked via IPv4 matches lookup via ::ffff:
      const rawV4 = '198.51.100.77';
      mockFraudDB.blockedIps.set(rawV4, {
        id: 'b-v4',
        ip_address: rawV4,
        reason: 'Scraper',
        blocked_by: 'system',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });

      expect(await isIpBlocked(mockFraudDB as any, `::ffff:${rawV4}`)).toBe(true);
    });

    it('rejects blocked IP with 403 Forbidden with ZERO deal_clicks database insertions', async () => {
      mockFraudDB.blockedIps.set(blockedIp, {
        id: 'block-p-1',
        ip_address: blockedIp,
        reason: 'Bot syndicate',
        blocked_by: 'system',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });

      const initialClicksCount = mockFraudDB.dealClicks.size;

      // 1. Attempt POST /api/deals/[id]/click from blocked IP
      const postReq = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'POST',
        headers: { 'cf-connecting-ip': blockedIp },
      });
      const postRes = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        postReq,
        { id: 'deal-active-1' }
      );

      expect(postRes.status).toBe(403);
      expect(postRes.data).toEqual({
        error: 'Forbidden',
        message: 'IP address blocked due to suspicious activity',
      });

      // 2. Attempt GET /api/deals/[id]/click from blocked IP
      const getReq = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'GET',
        headers: { 'cf-connecting-ip': blockedIp },
      });
      const getRes = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'GET',
        getReq,
        { id: 'deal-active-1' }
      );
      expect(getRes.status).toBe(403);

      // 3. Attempt GET /api/tracking/click from blocked IP
      const trackReq = createFraudTestRequest(
        'http://localhost:3000/api/tracking/click?deal_id=deal-active-1',
        {
          method: 'GET',
          headers: { 'cf-connecting-ip': blockedIp },
        }
      );
      const trackRes = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        trackReq
      );
      expect(trackRes.status).toBe(403);

      // CRITICAL VERIFICATION: Absolutely ZERO click records inserted into deal_clicks
      expect(mockFraudDB.dealClicks.size).toBe(initialClicksCount);
    });

    it('prioritizes cf-connecting-ip over spoofed x-forwarded-for header', async () => {
      mockFraudDB.blockedIps.set(blockedIp, {
        id: 'block-spoof',
        ip_address: blockedIp,
        reason: 'Attacker IP',
        blocked_by: 'system',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });

      // Request attempts to spoof clean IP via x-forwarded-for while cf-connecting-ip is the blocked IP
      const req = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': blockedIp,
          'x-forwarded-for': '127.0.0.1, 10.0.0.1',
        },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: 'deal-active-1' }
      );

      // Must be rejected with 403 because cf-connecting-ip has highest precedence
      expect(res.status).toBe(403);
      expect(mockFraudDB.dealClicks.size).toBe(0);
    });
  });

  // ============================================================================
  // 4. Repeat Offender Auto-Blocking
  // ============================================================================
  describe('4. Repeat Offender Auto-Blocking', () => {
    const offenderIp = '198.51.100.222';

    it('autoBlockOffender adds record to blocked_ips with AUTO_BLOCKED_REPEAT_OFFENDER reason', async () => {
      const blocked = await autoBlockOffender(
        mockFraudDB as any,
        offenderIp,
        FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER,
        { blockedBy: 'system', durationSeconds: 86400 }
      );

      expect(blocked).toBe(true);

      const record = mockFraudDB.blockedIps.get(offenderIp);
      expect(record).toBeDefined();
      expect(record?.ip_address).toBe(offenderIp);
      expect(record?.reason).toBe(FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER);
      expect(record?.blocked_by).toBe('system');
      expect(record?.is_active).toBe(1);
      expect(record?.expires_at).toBeDefined();
    });

    it('checkIpRateLimit triggers auto-blocking when autoBlockThreshold (150 clicks/hr) is exceeded', async () => {
      const repeatIp = '198.51.100.233';

      // Seed 150 clicks in the past hour
      for (let i = 0; i < 150; i++) {
        mockFraudDB.dealClicks.set(`c-rep-${i}`, {
          id: `c-rep-${i}`,
          deal_id: 'deal-active-1',
          affiliate_code: 'aff-rep',
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: repeatIp,
          user_agent: 'curl/7.68.0',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date().toISOString(),
        });
      }

      // Pre-condition: not blocked yet
      expect(mockFraudDB.blockedIps.has(repeatIp)).toBe(false);

      // Check rate limit: 150 clicks >= autoBlockThreshold (150)
      const res = await checkIpRateLimit(mockFraudDB as any, repeatIp);

      expect(res.allowed).toBe(false);
      expect(res.autoBlocked).toBe(true);

      // Post-condition: now in blocked_ips
      expect(mockFraudDB.blockedIps.has(repeatIp)).toBe(true);
      expect(mockFraudDB.blockedIps.get(repeatIp)?.reason).toBe(
        FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER
      );

      // Subsequent isIpBlocked check returns true
      expect(await isIpBlocked(mockFraudDB as any, repeatIp)).toBe(true);
    });
  });

  // ============================================================================
  // 5. Safe Absolute Redirect Resolution in tracking/click/route.ts
  // ============================================================================
  describe('5. Safe Absolute Redirect Resolution in tracking/click/route.ts', () => {
    it('constructs safe absolute redirect URL preventing 500 relative redirect crash', async () => {
      const req = createFraudTestRequest(
        'http://localhost:3000/api/tracking/click?deal_id=deal-active-1',
        {
          method: 'GET',
          headers: { 'cf-connecting-ip': '198.51.100.12' },
        }
      );

      const res = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        req
      );

      // Must succeed with 302 redirect, NOT 500 error
      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toBeDefined();

      // Must be an absolute URL parseable by URL constructor
      expect(() => new URL(location!)).not.toThrow();
      const parsedUrl = new URL(location!);
      expect(parsedUrl.pathname).toContain('/deals/deal-active-1');
    });

    it('safely handles referral code passthrough in absolute redirect', async () => {
      const req = createFraudTestRequest(
        'http://localhost:3000/api/tracking/click?deal_id=deal-active-1&ref=VIP99',
        {
          method: 'GET',
          headers: { 'cf-connecting-ip': '198.51.100.13' },
        }
      );

      const res = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        req
      );

      expect(res.status).toBe(302);
      const location = res.headers.get('location');
      expect(location).toBeDefined();
      const parsedUrl = new URL(location!);
      expect(parsedUrl.searchParams.get('ref')).toBe('VIP99');
    });

    it('returns 400 Bad Request when deal_id is missing', async () => {
      const req = createFraudTestRequest(
        'http://localhost:3000/api/tracking/click',
        {
          method: 'GET',
          headers: { 'cf-connecting-ip': '198.51.100.14' },
        }
      );

      const res = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        req
      );

      expect(res.status).toBe(400);
      expect(res.data.error).toBe('Missing required parameter: deal_id');
    });
  });

  // ============================================================================
  // 6. Matcher Attribution Fraud Filter (is_suspicious)
  // ============================================================================
  describe('6. Matcher Attribution Fraud Filter (is_suspicious)', () => {
    it('Matcher ignores clicks flagged with is_suspicious = 1', async () => {
      // Seed a click flagged as suspicious
      mockFraudDB.dealClicks.set('click-suspicious-1', {
        id: 'click-suspicious-1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-suspicious',
        affiliate_id: 'usr-trader-1',
        session_id: 's-suspicious',
        ip_address: '198.51.100.99',
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        anomaly_score: 0.85,
        flag_reasons: '["BURST_CLICK"]',
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });

      // Suspicious click must NOT be attributed
      expect(result.click).toBeNull();
      expect(result.totalCommission).toBe(0);
      expect(result.metadata.clickFound).toBe(false);
    });

    it('Matcher attributes clean clicks with is_suspicious = 0', async () => {
      mockFraudDB.dealClicks.set('click-clean-1', {
        id: 'click-clean-1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-clean',
        affiliate_id: 'usr-trader-1',
        session_id: 's-clean',
        ip_address: '198.51.100.98',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });

      // Clean click must be attributed
      expect(result.click).not.toBeNull();
      expect(result.click?.id).toBe('click-clean-1');
      expect(result.metadata.clickFound).toBe(true);
    });

    it('Matcher attributes legacy clicks where is_suspicious IS NULL', async () => {
      mockFraudDB.dealClicks.set('click-legacy-1', {
        id: 'click-legacy-1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-legacy',
        affiliate_id: 'usr-trader-1',
        session_id: 's-legacy',
        ip_address: '198.51.100.97',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: null,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });

      expect(result.click).not.toBeNull();
      expect(result.click?.id).toBe('click-legacy-1');
    });

    it('approved clicks immediately become re-eligible for conversion attribution', async () => {
      mockFraudDB.dealClicks.set('click-fp-recover', {
        id: 'click-fp-recover',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-fp',
        affiliate_id: 'usr-trader-1',
        session_id: 's-fp',
        ip_address: '198.51.100.96',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // Initially suspicious
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // 1. Initial attempt fails to attribute
      const res1 = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });
      expect(res1.click).toBeNull();

      // 2. Admin approval updates is_suspicious to 0
      mockFraudDB.prepare('UPDATE deal_clicks SET is_suspicious = 0, anomaly_score = 0.0 WHERE id = ?')
        .bind('click-fp-recover')
        .run();

      // 3. Second attempt attributes immediately
      const res2 = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });
      expect(res2.click).not.toBeNull();
      expect(res2.click?.id).toBe('click-fp-recover');
    });
  });

  // ==========================================================================
  // 7. Remediation Verification: Collation, ON CONFLICT, and IPv6 Normalization
  // ==========================================================================
  describe('7. Remediation Verification', () => {
    it('7.1 SQLite datetime collation: counts both SQLite format and ISO format clicks', async () => {
      // Create a better-sqlite3 instance simulating Cloudflare D1
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

      // 50 clicks with datetime('now')
      for (let i = 0; i < 50; i++) {
        sqlite.prepare("INSERT INTO deal_clicks (id, ip_address) VALUES (?, '198.51.100.99')").run(`c-sql-${i}`);
      }
      // 50 clicks with ISO format
      for (let i = 0; i < 50; i++) {
        sqlite.prepare("INSERT INTO deal_clicks (id, ip_address, created_at) VALUES (?, '198.51.100.99', ?)").run(
          `c-iso-${i}`,
          new Date().toISOString()
        );
      }

      // Adapter wrapping better-sqlite3 in D1 interface
      const d1Adapter: any = {
        prepare: (sql: string) => {
          const stmt = sqlite.prepare(sql);
          return {
            bind: (...params: any[]) => ({
              first: async () => stmt.get(...params),
              all: async () => ({ results: stmt.all(...params) }),
              run: async () => {
                const res = stmt.run(...params);
                return { success: true, meta: { changes: res.changes } };
              },
            }),
          };
        },
      };

      const result = await checkIpRateLimit(d1Adapter, '198.51.100.99');
      // Total 100 clicks counted -> hourly limit (100) reached, not exceeded (0 remaining)
      expect(result.hourlyRemaining).toBe(0);

      // 1 more click pushes it to 101 -> exceeded!
      sqlite.prepare("INSERT INTO deal_clicks (id, ip_address) VALUES (?, '198.51.100.99')").run('c-breach');
      const breachResult = await checkIpRateLimit(d1Adapter, '198.51.100.99');
      expect(breachResult.allowed).toBe(false);
      expect(breachResult.exceededWindow).toBe('hourly');
    });

    it('7.2 ON CONFLICT autoBlockOffender idempotency in real SQLite and MockFraudDatabase', async () => {
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

      const d1Adapter: any = {
        prepare: (sql: string) => {
          const stmt = sqlite.prepare(sql);
          return {
            bind: (...params: any[]) => ({
              first: async () => stmt.get(...params),
              run: async () => {
                const res = stmt.run(...params);
                return { success: true, meta: { changes: res.changes } };
              },
            }),
          };
        },
      };

      // First call inserts
      const res1 = await autoBlockOffender(d1Adapter, '203.0.113.88', 'First block', { durationSeconds: 3600 });
      expect(res1).toBe(true);

      // Second call updates with ON CONFLICT without throwing UNIQUE constraint violation
      const res2 = await autoBlockOffender(d1Adapter, '203.0.113.88', 'Updated block reason', { durationSeconds: 7200 });
      expect(res2).toBe(true);

      const row = sqlite.prepare('SELECT * FROM blocked_ips WHERE ip_address = ?').get('203.0.113.88');
      expect(row.reason).toBe('Updated block reason');
      expect(row.is_active).toBe(1);

      // Also verify MockFraudDatabase
      const mockRes1 = await autoBlockOffender(mockFraudDB as any, '203.0.113.88', 'Mock block 1');
      expect(mockRes1).toBe(true);
      const mockRes2 = await autoBlockOffender(mockFraudDB as any, '203.0.113.88', 'Mock block 2');
      expect(mockRes2).toBe(true);
      expect(mockFraudDB.blockedIps.get('203.0.113.88')?.reason).toBe('Mock block 2');
    });

    it('7.3 uppercase IPv4-mapped IPv6 normalization and blocklist cross-resolution', async () => {
      // Direct normalization test
      expect(normalizeIpAddress('::ffff:192.0.2.128')).toBe('192.0.2.128');
      expect(normalizeIpAddress('::FFFF:192.0.2.128')).toBe('192.0.2.128');
      expect(normalizeIpAddress('::FfFf:192.0.2.128')).toBe('192.0.2.128');

      // Blocked IPv4 matches uppercase incoming IPv4-mapped IPv6
      mockFraudDB.blockedIps.set('192.0.2.128', {
        id: 'blk-upper-test',
        ip_address: '192.0.2.128',
        reason: 'Malicious bot',
        blocked_by: 'system',
        created_at: new Date().toISOString(),
        expires_at: null,
        is_active: 1,
      });

      expect(await isIpBlocked(mockFraudDB as any, '::FFFF:192.0.2.128')).toBe(true);
      expect(await isIpBlocked(mockFraudDB as any, '::ffff:192.0.2.128')).toBe(true);
      expect(await isIpBlocked(mockFraudDB as any, '192.0.2.128')).toBe(true);
    });

    it('7.4 click routes explicitly bind ISO created_at on insertion', async () => {
      const trackingReq = createFraudTestRequest('/api/tracking/click?deal_id=deal-active-1', {
        headers: { 'cf-connecting-ip': '198.51.100.77' },
      });

      // Dispatch route and verify click was recorded with valid ISO created_at
      const res = await dispatchRoute('src/app/api/tracking/click/route.ts', 'GET', trackingReq);
      expect(res.status).toBe(302);

      const recordedClick = Array.from(mockFraudDB.dealClicks.values()).find(
        (c) => c.ip_address === '198.51.100.77'
      );
      expect(recordedClick).toBeDefined();
      expect(recordedClick?.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    });
  });
});
