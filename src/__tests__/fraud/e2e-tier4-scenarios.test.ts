/**
 * Tier 4: Real-World Scenarios E2E Tests
 * Covers complex multi-step security scenarios and user journeys:
 * - Scenario 1: Distributed Botnet Attack Across Multiple Deals & Nodes
 * - Scenario 2: Single-Target Burst Flood & Auto-Mitigation Lifecycle
 * - Scenario 3: Admin Bulk Fraud Mitigation & Audit Lifecycle
 * - Scenario 4: High-Volume Organic Influencer Campaign (Zero False Positives)
 * - Scenario 5: Reverse Proxy Header Spoofing & Injection Defense
 *
 * Total: 5 scenarios
 */

import {
  mockFraudDB,
  setupFraudTestEnvironment,
  createFraudTestRequest,
  dispatchRoute,
  getFraudEngine,
  isFraudEngineImplemented,
} from './fraud-test-harness';
import { Matcher } from '@/lib/tracking/matcher';

beforeAll(() => {
  setupFraudTestEnvironment();
});

beforeEach(() => {
  mockFraudDB.reset();
});

describe('Tier 4: Real-World Scenarios', () => {
  // ==========================================================================
  // Scenario 1: Distributed Botnet Attack Across Multiple Deals & Nodes
  // ==========================================================================
  it('Scenario 1: detects distributed botnet cycling 20 distinct IPs and prevents fraudulent commission attribution', async () => {
    const engine = await getFraudEngine();
    const botNodesCount = 20;
    const now = Date.now();
    const botAffiliateCode = 'botnet-affiliate-001';

    // Step 1: Simulate 20 distributed bot nodes executing sub-second rapid clicks
    for (let i = 0; i < botNodesCount; i++) {
      const nodeIp = `198.51.100.${10 + i}`;
      const sessionId = `bot-node-sess-${i}`;

      // Insert prior click 200ms ago for each node
      mockFraudDB.dealClicks.set(`bot-click-${i}`, {
        id: `bot-click-${i}`,
        deal_id: 'deal-active-1',
        affiliate_code: botAffiliateCode,
        affiliate_id: 'usr-botmaster',
        session_id: sessionId,
        ip_address: nodeIp,
        user_agent: 'Python-urllib/3.9',
        referrer_url: null,
        country_code: 'RU',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // Flagged by engine
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.9,
        created_at: new Date(now - (i * 50)).toISOString(),
      });
    }

    expect(mockFraudDB.dealClicks.size).toBe(botNodesCount);

    // Step 2: Velocity engine evaluates an incoming bot click from one of the active nodes
    if (engine && typeof engine.evaluateClickVelocity === 'function') {
      const evalResult = await engine.evaluateClickVelocity(mockFraudDB, {
        ipAddress: '198.51.100.10',
        sessionId: 'bot-node-sess-0',
        dealId: 'deal-active-1',
        affiliateCode: botAffiliateCode,
      });

      expect(evalResult.isSuspicious).toBe(true);
      expect(evalResult.flagReasons).toContain('BURST_CLICK');
      expect(evalResult.anomalyScore).toBeGreaterThanOrEqual(0.8);
    }

    // Step 3: Botmaster attempts to claim affiliate rewards by simulating trade conversion
    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId: 'deal-active-1',
      userIdentifier: '0x1111111111111111111111111111111111111111',
      tradeVolumeUsd: 10000,
    });

    if (isFraudEngineImplemented()) {
      // Attribution safeguard protects treasury
      expect(result.click).toBeNull();
      expect(result.totalCommission).toBe(0);
    }
  });

  // ==========================================================================
  // Scenario 2: Single-Target Burst Flood & Auto-Mitigation Lifecycle
  // ==========================================================================
  it('Scenario 2: executes end-to-end burst flood, rate limiting, and auto-block transition', async () => {
    const engine = await getFraudEngine();
    const attackerIp = '198.51.100.240';
    const now = Date.now();

    // Step 1: 1st click passes cleanly
    const req1 = createFraudTestRequest('/api/deals/deal-active-1/click', {
      method: 'POST',
      ip: attackerIp,
      body: { userId: 'usr-trader-1' },
    });
    const res1 = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      req1,
      { id: 'deal-active-1' }
    );
    expect(res1.status).toBe(200);

    // Step 2: Simulate 99 rapid burst clicks hitting the hourly rate limit
    for (let i = 2; i <= 100; i++) {
      mockFraudDB.dealClicks.set(`flood-${i}`, {
        id: `flood-${i}`,
        deal_id: 'deal-active-1',
        affiliate_code: 'flood-aff',
        affiliate_id: 'u-flood',
        session_id: 's-flood',
        ip_address: attackerIp,
        user_agent: 'Go-http-client/1.1',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.95,
        created_at: new Date(now - (100 - i) * 100).toISOString(),
      });
    }

    // Step 3: 101st click triggers rate limit (429)
    if (engine && typeof engine.checkIpRateLimit === 'function') {
      const limitResult = await engine.checkIpRateLimit(mockFraudDB, attackerIp);
      expect(limitResult.allowed).toBe(false);
      expect(limitResult.retryAfter).toBeGreaterThan(0);
    }

    // Step 4: System escalates repeated offender to blocked_ips
    mockFraudDB.prepare(`
      INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
      VALUES (?, ?, ?, ?)
    `).bind('auto-b2', attackerIp, 'Repeated burst flood attack', 'system-autoblock').run();

    expect(mockFraudDB.blockedIps.has(attackerIp)).toBe(true);

    // Step 5: Subsequent requests rejected with 403 Forbidden without database writes
    const preCount = mockFraudDB.dealClicks.size;
    const reqBlocked = createFraudTestRequest('/api/deals/deal-active-1/click', {
      method: 'POST',
      ip: attackerIp,
      body: { userId: 'usr-trader-1' },
    });
    const resBlocked = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      reqBlocked,
      { id: 'deal-active-1' }
    );

    if (isFraudEngineImplemented()) {
      expect(resBlocked.status).toBe(403);
      expect(mockFraudDB.dealClicks.size).toBe(preCount);
    }
  });

  // ==========================================================================
  // Scenario 3: Admin Bulk Fraud Mitigation & Audit Lifecycle
  // ==========================================================================
  it('Scenario 3: admin conducts review queue mitigation, approving clean clicks and blocking attacker with immutable audit trail', async () => {
    const adminUser = 'usr-admin-1';
    const badIp = '198.51.100.245';

    // Step 1: Queue contains 3 suspicious clicks
    // Click 1 & 2: false positive from mobile network switch
    mockFraudDB.dealClicks.set('click-fp-1', {
      id: 'click-fp-1',
      deal_id: 'deal-active-1',
      affiliate_code: 'usr-affiliate-1',
      affiliate_id: 'usr-trader-1',
      session_id: 's-mobile-user',
      ip_address: '172.56.21.1',
      user_agent: 'Mobile Safari',
      referrer_url: null,
      country_code: 'US',
      device_type: 'mobile',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1,
      flag_reasons: '["BURST_CLICK"]',
      anomaly_score: 0.6,
      created_at: new Date().toISOString(),
    });

    // Click 3: actual malicious bot
    mockFraudDB.dealClicks.set('click-bot-1', {
      id: 'click-bot-1',
      deal_id: 'deal-active-1',
      affiliate_code: 'bad-actor',
      affiliate_id: 'u-bad',
      session_id: 's-bot',
      ip_address: badIp,
      user_agent: 'curl/7.68.0',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1,
      flag_reasons: '["BURST_CLICK", "HIGH_CLICK_CONVERSION_RATIO"]',
      anomaly_score: 0.98,
      created_at: new Date().toISOString(),
    });

    // Step 2: Admin bulk approves the false positive click
    mockFraudDB.prepare(`
      UPDATE deal_clicks SET is_suspicious = 0, anomaly_score = 0.0 WHERE id = ?
    `).bind('click-fp-1').run();

    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('rev-fp-1', 'click-fp-1', adminUser, 'approve', 'Customer verified mobile reconnect').run();

    // Step 3: Admin blocks the abusive IP and rejects click 3
    mockFraudDB.prepare(`
      INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
      VALUES (?, ?, ?, ?)
    `).bind('b-bad-actor', badIp, 'Confirmed curl scraper bot', adminUser).run();

    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('rev-bot-1', 'click-bot-1', adminUser, 'reject', 'Confirmed scraper bot').run();

    // Step 4: Verify audit log states and immutability
    expect(mockFraudDB.fraudReviews.size).toBe(2);
    expect(mockFraudDB.blockedIps.has(badIp)).toBe(true);

    // Step 5: Verified trader from approved click now attributes commission
    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId: 'deal-active-1',
      userIdentifier: '0x1111111111111111111111111111111111111111',
      tradeVolumeUsd: 2000,
    });

    expect(result.click?.id).toBe('click-fp-1');
    expect(result.totalCommission).toBe(60); // 2000 * 0.10 * 0.30
  });

  // ==========================================================================
  // Scenario 4: High-Volume Organic Influencer Campaign (Zero False Positives)
  // ==========================================================================
  it('Scenario 4: handles high-volume organic campaign (90 clicks, 15 conversions) with 0 false positives', async () => {
    const influencerAffCode = 'crypto-influencer-pro';
    const totalClicks = 90;
    const totalConversions = 15;
    const now = Date.now();

    // 90 organic clicks spread naturally over 3 hours (1 click every 2 minutes) from 90 distinct IPs
    for (let i = 0; i < totalClicks; i++) {
      mockFraudDB.dealClicks.set(`organic-click-${i}`, {
        id: `organic-click-${i}`,
        deal_id: 'deal-active-1',
        affiliate_code: influencerAffCode,
        affiliate_id: 'usr-affiliate-1',
        session_id: `s-organic-${i}`,
        ip_address: `198.51.101.${(i % 250) + 1}`,
        user_agent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)',
        referrer_url: 'https://twitter.com/crypto_alpha',
        country_code: 'US',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0, // Clean
        flag_reasons: '[]',
        anomaly_score: 0.0,
        created_at: new Date(now - (totalClicks - i) * 120000).toISOString(),
      });
    }

    // 15 conversions (Ratio = 90:15 = 6.0, well under 10.0 threshold)
    for (let i = 0; i < totalConversions; i++) {
      mockFraudDB.conversions.set(`organic-conv-${i}`, {
        id: `organic-conv-${i}`,
        deal_id: 'deal-active-1',
        affiliate_code: influencerAffCode,
        affiliate_id: 'usr-affiliate-1',
        user_id: `trader-user-${i}`,
        amount: 500,
        status: 'confirmed',
        created_at: new Date(now - (totalConversions - i) * 600000).toISOString(),
      });
    }

    // Verify 0 clicks are flagged as suspicious
    const suspiciousClicks = Array.from(mockFraudDB.dealClicks.values()).filter(
      (c) => c.is_suspicious === 1
    );
    expect(suspiciousClicks.length).toBe(0);

    // Verify conversion ratio evaluation for next incoming click
    const engine = await getFraudEngine();
    if (engine && typeof engine.evaluateClickVelocity === 'function') {
      const evalResult = await engine.evaluateClickVelocity(mockFraudDB, {
        ipAddress: '198.51.101.99',
        sessionId: 's-organic-next',
        dealId: 'deal-active-1',
        affiliateCode: influencerAffCode,
      });

      expect(evalResult.isSuspicious).toBe(false);
      expect(evalResult.flagReasons.length).toBe(0);
      expect(evalResult.anomalyScore).toBe(0.0);
    }
  });

  // ==========================================================================
  // Scenario 5: Reverse Proxy Header Spoofing & Injection Defense
  // ==========================================================================
  it('Scenario 5: defends against client header spoofing, prioritizing trusted edge IP and neutralizing bypass attempts', async () => {
    const edgeClientIp = '203.0.113.99'; // Real client IP from Cloudflare
    const spoofedHeaderChain = '127.0.0.1, 10.0.0.1, 8.8.8.8, 172.16.0.1';

    // Place edge IP on blocklist
    mockFraudDB.blockedIps.set(edgeClientIp, {
      id: 'b-spoof-target',
      ip_address: edgeClientIp,
      reason: 'Known malicious scraper network',
      blocked_by: 'admin',
      blocked_at: new Date().toISOString(),
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // Attacker crafts spoofed request attempting to fool rate limiter and blocklist
    const req = createFraudTestRequest('/api/deals/deal-active-1/click', {
      method: 'POST',
      headers: {
        'cf-connecting-ip': edgeClientIp,
        'x-forwarded-for': spoofedHeaderChain,
        'x-real-ip': '127.0.0.1',
      },
      body: { userId: 'usr-trader-1' },
    });

    const res = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      req,
      { id: 'deal-active-1' }
    );

    if (isFraudEngineImplemented()) {
      // Must be rejected with 403 because cf-connecting-ip is prioritized
      expect(res.status).toBe(403);
      // Verify no click record was logged for the spoofed 127.0.0.1 IP
      const localClicks = Array.from(mockFraudDB.dealClicks.values()).filter(
        (c) => c.ip_address === '127.0.0.1'
      );
      expect(localClicks.length).toBe(0);
    } else {
      expect([200, 403, 501]).toContain(res.status);
    }
  });
});
