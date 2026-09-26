/**
 * Milestone 2 Challenger Stress Test Suite: Route Protection & Matcher Attribution
 * Location: src/__tests__/fraud/challenger-m2-routes-matcher.test.ts
 *
 * Empirical adversarial stress testing for:
 * 1. Header spoofing resistance on click routes:
 *    - POST /api/deals/[id]/click
 *    - GET /api/tracking/click
 *    - cf-connecting-ip vs x-forwarded-for spoofing, x-real-ip spoofing, IPv4-mapped IPv6, whitespace/case
 * 2. Matcher query isolation:
 *    - is_suspicious = 1 clicks NEVER match in Priority 1 (direct) and Priority 2 (cookie) queries
 *    - is_suspicious = 0 clicks match
 *    - is_suspicious IS NULL (legacy) clicks match
 *    - Newer suspicious clicks do NOT shadow older legitimate clicks within the attribution window
 *    - Multi-suspicious stream isolation
 * 3. Immediate attribution eligibility upon approval:
 *    - Transition from is_suspicious = 1 -> is_suspicious = 0 restores attribution immediately
 *    - Re-flagging to is_suspicious = 1 immediately revokes attribution
 *    - Selective approval amongst multiple chronological clicks
 */

import {
  mockFraudDB,
  setupFraudTestEnvironment,
  createFraudTestRequest,
  dispatchRoute,
  getFraudEngine,
} from './fraud-test-harness';
import { Matcher } from '@/lib/tracking/matcher';

beforeAll(() => {
  setupFraudTestEnvironment();
});

beforeEach(() => {
  mockFraudDB.reset();
});

describe('Challenger M2: Route Protection & Header Spoofing Resistance', () => {
  const dealId = 'deal-active-1';
  const blockedClientIp = '198.51.100.99';
  const spoofedFakeIp = '1.1.1.1';

  beforeEach(() => {
    // Populate active deal
    mockFraudDB.deals.set(dealId, {
      id: dealId,
      title: 'Active Deal 1',
      description: 'Active deal for stress testing',
      category: 'exchanges',
      url: 'https://partner.example.com/register',
      cashback_percentage: 10.0,
      affiliate_terms: null,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Populate blocked IP record
    mockFraudDB.blockedIps.set(blockedClientIp, {
      id: 'b-attacker-99',
      ip_address: blockedClientIp,
      reason: 'Known adversarial crawler',
      blocked_by: 'admin',
      blocked_at: new Date().toISOString(),
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  describe('1. Header Spoofing Resistance on Click Routes', () => {
    it('1.1 POST /api/deals/[id]/click rejects spoofed x-forwarded-for when cf-connecting-ip is blocked', async () => {
      const initialClickCount = mockFraudDB.dealClicks.size;

      // Attacker sends innocent IP in x-forwarded-for and x-real-ip,
      // but Cloudflare edge sets cf-connecting-ip to the real (blocked) IP
      const req = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': blockedClientIp,
          'x-forwarded-for': spoofedFakeIp,
          'x-real-ip': spoofedFakeIp,
        },
        body: { userId: 'usr-trader-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: dealId }
      );

      // Must be rejected with 403 Forbidden
      expect(res.status).toBe(403);
      expect(res.data?.error).toMatch(/Forbidden|blocked/i);

      // CRITICAL: Absolutely zero click records must be written to deal_clicks
      expect(mockFraudDB.dealClicks.size).toBe(initialClickCount);

      const leakedClicks = Array.from(mockFraudDB.dealClicks.values()).filter(
        (c) => c.ip_address === spoofedFakeIp || c.ip_address === blockedClientIp
      );
      expect(leakedClicks.length).toBe(0);
    });

    it('1.2 GET /api/tracking/click rejects spoofed x-forwarded-for when cf-connecting-ip is blocked', async () => {
      const initialClickCount = mockFraudDB.dealClicks.size;

      const req = createFraudTestRequest(
        `/api/tracking/click?deal_id=${dealId}&ref=ref123`,
        {
          method: 'GET',
          headers: {
            'cf-connecting-ip': blockedClientIp,
            'x-forwarded-for': `${spoofedFakeIp}, 10.0.0.1, 172.16.0.1`,
            'x-real-ip': spoofedFakeIp,
          },
        }
      );

      const res = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        req
      );

      // Must be rejected with 403 Forbidden (no 302 redirect!)
      expect(res.status).toBe(403);
      expect(res.data?.error).toMatch(/Forbidden|blocked/i);

      // Zero click side-effects in database
      expect(mockFraudDB.dealClicks.size).toBe(initialClickCount);
    });

    it('1.3 blocks request when cf-connecting-ip has leading/trailing whitespace or upper/lowercase mismatch', async () => {
      const req = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': `  ${blockedClientIp}  `,
          'x-forwarded-for': '8.8.8.8',
        },
        body: { userId: 'usr-trader-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: dealId }
      );

      expect(res.status).toBe(403);
      expect(mockFraudDB.dealClicks.size).toBe(0);
    });

    it('1.4 blocks request when cf-connecting-ip is IPv4-mapped IPv6 (::ffff:x.x.x.x)', async () => {
      // Attacker connects via IPv6 gateway presenting IPv4-mapped format
      const req = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': `::ffff:${blockedClientIp}`,
          'x-forwarded-for': '1.1.1.1',
        },
        body: { userId: 'usr-trader-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: dealId }
      );

      expect(res.status).toBe(403);
      expect(mockFraudDB.dealClicks.size).toBe(0);
    });

    it('1.5 blocks request when blocked_ips contains IPv4-mapped IPv6 and request arrives via standard IPv4', async () => {
      const ipv4Ip = '198.51.100.88';
      // Store in blocked_ips as ::ffff:198.51.100.88
      mockFraudDB.blockedIps.set(`::ffff:${ipv4Ip}`, {
        id: 'b-mapped-88',
        ip_address: `::ffff:${ipv4Ip}`,
        reason: 'Stored as mapped IPv6',
        blocked_by: 'admin',
        blocked_at: new Date().toISOString(),
        expires_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const req = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': ipv4Ip,
        },
        body: { userId: 'usr-trader-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: dealId }
      );

      expect(res.status).toBe(403);
      expect(mockFraudDB.dealClicks.size).toBe(0);
    });

    it('1.6 extracts leftmost client IP from x-forwarded-for only when cf-connecting-ip is completely absent', async () => {
      // Case A: Leftmost IP is blocked -> 403
      const reqBlocked = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'x-forwarded-for': `${blockedClientIp}, 10.0.0.1, 172.16.0.1`,
        },
        body: { userId: 'usr-trader-1' },
      });

      const resBlocked = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        reqBlocked,
        { id: dealId }
      );
      expect(resBlocked.status).toBe(403);

      // Case B: Leftmost IP is clean, subsequent internal proxy IP is on blocklist -> ALLOWED (200)
      const cleanClientIp = '198.51.100.77';
      const reqClean = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'x-forwarded-for': `${cleanClientIp}, ${blockedClientIp}`,
        },
        body: { userId: 'usr-trader-1' },
      });

      const resClean = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        reqClean,
        { id: dealId }
      );
      expect(resClean.status).toBe(200);
      expect(mockFraudDB.dealClicks.size).toBe(1);
    });
  });
});

describe('Challenger M2: Matcher Query Isolation & Attribution Safeguards', () => {
  const dealId = 'deal-matcher-stress';
  const traderUserId = 'usr-trader-m2';
  const traderWallet = '0x2222222222222222222222222222222222222222';
  const affiliateUserId = 'usr-affiliate-m2';
  const affiliateCode = 'aff-code-m2';

  beforeEach(() => {
    // 1. Setup deal
    mockFraudDB.deals.set(dealId, {
      id: dealId,
      title: 'Matcher Stress Deal',
      description: 'Stress testing attribution isolation',
      category: 'exchanges',
      url: 'https://exchange.example.com',
      cashback_percentage: 10.0,
      default_commission_rate: 0.10,
      default_commission_type: 'percentage',
      fixed_commission_amount: 0,
      affiliate_terms: null,
      is_active: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // 2. Setup trader profile and wallet connection
    mockFraudDB.profiles.set(traderUserId, {
      id: traderUserId,
      email: 'trader@example.com',
      full_name: 'Trader Test',
      role: 'user',
      plan: 'pro',
      tier: 'standard',
      referral_code: 'trader-ref',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    mockFraudDB.walletConnections.set('wc-trader', {
      id: 'wc-trader',
      profile_id: traderUserId,
      wallet_address: traderWallet.toLowerCase(),
      preferred_chain: 'ethereum',
      is_primary: 1,
      connected_at: new Date().toISOString(),
      last_used_at: null,
    });

    // 3. Setup affiliate profile and referral tree
    mockFraudDB.profiles.set(affiliateUserId, {
      id: affiliateUserId,
      email: 'affiliate@example.com',
      full_name: 'Affiliate Test',
      role: 'user',
      plan: 'partner',
      tier: 'vip',
      referral_code: affiliateCode,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    mockFraudDB.referralTree.set('rt-affiliate', {
      id: 'rt-affiliate',
      affiliate_id: affiliateUserId,
      parent_id: null,
      path: affiliateUserId,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
  });

  describe('2. Matcher Query Isolation (is_suspicious = 1 is NEVER attributed)', () => {
    it('2.1 Priority 1: Direct affiliate click with is_suspicious = 1 is NEVER attributed', async () => {
      mockFraudDB.dealClicks.set('click-p1-susp', {
        id: 'click-p1-susp',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId, // Direct attribution match
        session_id: 'sess-p1-susp',
        ip_address: '198.51.100.1',
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // SUSPICIOUS
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.9,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(result.click).toBeNull();
      expect(result.commissions.length).toBe(0);
      expect(result.totalCommission).toBe(0);
      expect(result.metadata.clickFound).toBe(false);
    });

    it('2.2 Priority 1: Direct affiliate click with is_suspicious = 0 IS attributed', async () => {
      mockFraudDB.dealClicks.set('click-p1-clean', {
        id: 'click-p1-clean',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 'sess-p1-clean',
        ip_address: '198.51.100.1',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0, // CLEAN
        flag_reasons: null,
        anomaly_score: 0.0,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(result.click?.id).toBe('click-p1-clean');
      expect(result.totalCommission).toBe(30); // 1000 * 0.10 * 0.30
      expect(result.metadata.clickFound).toBe(true);
    });

    it('2.3 Priority 1: Direct affiliate legacy click with is_suspicious IS NULL IS attributed', async () => {
      mockFraudDB.dealClicks.set('click-p1-legacy', {
        id: 'click-p1-legacy',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 'sess-p1-legacy',
        ip_address: '198.51.100.1',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: null as any, // LEGACY NULL
        flag_reasons: null,
        anomaly_score: null as any,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(result.click?.id).toBe('click-p1-legacy');
      expect(result.totalCommission).toBe(30);
    });

    it('2.4 Priority 2: Cookie-based attribution click with is_suspicious = 1 is NEVER attributed', async () => {
      mockFraudDB.dealClicks.set('click-p2-susp', {
        id: 'click-p2-susp',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: 'some-other-unrelated-user', // Cookie-based fallback query
        session_id: 'sess-p2-susp',
        ip_address: '198.51.100.2',
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // SUSPICIOUS
        flag_reasons: '["HIGH_CLICK_CONVERSION_RATIO"]',
        anomaly_score: 0.85,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 2000,
      });

      expect(result.click).toBeNull();
      expect(result.commissions.length).toBe(0);
      expect(result.totalCommission).toBe(0);
      expect(result.metadata.clickFound).toBe(false);
    });

    it('2.5 Priority 2: Cookie-based attribution click with is_suspicious = 0 IS attributed', async () => {
      mockFraudDB.dealClicks.set('click-p2-clean', {
        id: 'click-p2-clean',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: 'some-other-unrelated-user',
        session_id: 'sess-p2-clean',
        ip_address: '198.51.100.2',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0, // CLEAN
        flag_reasons: null,
        anomaly_score: 0.0,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 2000,
      });

      expect(result.click?.id).toBe('click-p2-clean');
      expect(result.totalCommission).toBe(60); // 2000 * 0.10 * 0.30
      expect(result.metadata.clickFound).toBe(true);
    });

    it('2.6 Adversarial Shadowing: Newer suspicious click does NOT mask older legitimate click', async () => {
      const now = Date.now();

      // Older legitimate click 2 hours ago
      mockFraudDB.dealClicks.set('click-legit-older', {
        id: 'click-legit-older',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 'sess-legit',
        ip_address: '198.51.100.5',
        user_agent: 'genuine-browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0, // CLEAN
        flag_reasons: null,
        anomaly_score: 0.0,
        created_at: new Date(now - 2 * 3600 * 1000).toISOString(),
      });

      // Newer attacker / burst click 5 minutes ago attempting to hijack/shadow attribution
      mockFraudDB.dealClicks.set('click-attacker-newer', {
        id: 'click-attacker-newer',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 'sess-attacker',
        ip_address: '198.51.100.6',
        user_agent: 'botnet-scraper',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // FLAGGED AS SUSPICIOUS
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.95,
        created_at: new Date(now - 5 * 60 * 1000).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      // Empirically verify that Matcher ignores the newer suspicious click
      // and correctly falls back to the clean older click within window
      expect(result.click?.id).toBe('click-legit-older');
      expect(result.totalCommission).toBe(30);
    });

    it('2.7 Complete Isolation: Stream of 10 suspicious clicks results in 0 commission attribution', async () => {
      const now = Date.now();
      for (let i = 0; i < 10; i++) {
        mockFraudDB.dealClicks.set(`bot-stream-${i}`, {
          id: `bot-stream-${i}`,
          deal_id: dealId,
          affiliate_code: affiliateCode,
          affiliate_id: traderUserId,
          session_id: `bot-sess-${i}`,
          ip_address: `198.51.100.${10 + i}`,
          user_agent: 'python-requests/2.28',
          referrer_url: null,
          country_code: 'RU',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          is_suspicious: 1,
          flag_reasons: '["BURST_CLICK", "HIGH_CLICK_CONVERSION_RATIO"]',
          anomaly_score: 0.9,
          created_at: new Date(now - i * 10000).toISOString(),
        });
      }

      const matcher = new Matcher(mockFraudDB as any);
      const result = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 5000,
      });

      expect(result.click).toBeNull();
      expect(result.commissions.length).toBe(0);
      expect(result.totalCommission).toBe(0);
    });
  });

  describe('3. Attribution Lifecycle (Immediate Eligibility Upon Admin Approval)', () => {
    it('3.1 Transition from is_suspicious = 1 to is_suspicious = 0 immediately unlocks attribution', async () => {
      const targetClickId = 'click-lifecycle-1';

      // 1. Initial State: Click is flagged suspicious
      mockFraudDB.dealClicks.set(targetClickId, {
        id: targetClickId,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 'sess-lifecycle',
        ip_address: '198.51.100.40',
        user_agent: 'mobile-app',
        referrer_url: null,
        country_code: 'US',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.8,
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // Verify trade before approval: 0 commission
      const preApprovalResult = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });
      expect(preApprovalResult.click).toBeNull();
      expect(preApprovalResult.totalCommission).toBe(0);

      // 2. Admin reviews and approves the click:
      // - writes audit record to fraud_reviews
      // - updates deal_clicks SET is_suspicious = 0
      mockFraudDB.prepare(`
        INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
        VALUES (?, ?, ?, ?, ?)
      `).bind('rev-lifecycle-1', targetClickId, 'usr-admin-1', 'approve', 'Customer identity verified KYC').run();

      mockFraudDB.prepare(`
        UPDATE deal_clicks SET is_suspicious = 0, anomaly_score = 0.0 WHERE id = ?
      `).bind(targetClickId).run();

      // 3. Immediately re-run Matcher (no restart, no cache delay)
      const postApprovalResult = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(postApprovalResult.click?.id).toBe(targetClickId);
      expect(postApprovalResult.totalCommission).toBe(30);
      expect(mockFraudDB.fraudReviews.has('rev-lifecycle-1')).toBe(true);

      // 4. Re-flagging: Admin or security engine revokes / re-flags click to is_suspicious = 1
      mockFraudDB.prepare(`
        UPDATE deal_clicks SET is_suspicious = 1, anomaly_score = 0.95 WHERE id = ?
      `).bind(targetClickId).run();

      const postRevocationResult = await matcher.match({
        dealId,
        userIdentifier: traderWallet,
        tradeVolumeUsd: 1000,
      });

      expect(postRevocationResult.click).toBeNull();
      expect(postRevocationResult.totalCommission).toBe(0);
    });

    it('3.2 Selective Approval: Approving a specific click in a multi-click timeline accurately picks newest approved', async () => {
      const now = Date.now();

      // Three clicks created chronologically:
      // Click C (oldest, T - 30m)
      mockFraudDB.dealClicks.set('click-timeline-C', {
        id: 'click-timeline-C',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 's-C',
        ip_address: '198.51.100.51',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.8,
        created_at: new Date(now - 30 * 60 * 1000).toISOString(),
      });

      // Click B (middle, T - 15m)
      mockFraudDB.dealClicks.set('click-timeline-B', {
        id: 'click-timeline-B',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 's-B',
        ip_address: '198.51.100.52',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.8,
        created_at: new Date(now - 15 * 60 * 1000).toISOString(),
      });

      // Click A (newest, T - 1m)
      mockFraudDB.dealClicks.set('click-timeline-A', {
        id: 'click-timeline-A',
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: 's-A',
        ip_address: '198.51.100.53',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.8,
        created_at: new Date(now - 1 * 60 * 1000).toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // None approved -> 0 attribution
      const r0 = await matcher.match({ dealId, userIdentifier: traderWallet, tradeVolumeUsd: 1000 });
      expect(r0.click).toBeNull();

      // Admin selectively approves Click B (middle click)
      mockFraudDB.prepare('UPDATE deal_clicks SET is_suspicious = 0 WHERE id = ?').bind('click-timeline-B').run();

      const r1 = await matcher.match({ dealId, userIdentifier: traderWallet, tradeVolumeUsd: 1000 });
      expect(r1.click?.id).toBe('click-timeline-B');

      // Admin subsequently also approves Click A (newest click)
      mockFraudDB.prepare('UPDATE deal_clicks SET is_suspicious = 0 WHERE id = ?').bind('click-timeline-A').run();

      const r2 = await matcher.match({ dealId, userIdentifier: traderWallet, tradeVolumeUsd: 1000 });
      // Now Click A is the newest approved click, so it must take priority
      expect(r2.click?.id).toBe('click-timeline-A');
    });
  });
});
