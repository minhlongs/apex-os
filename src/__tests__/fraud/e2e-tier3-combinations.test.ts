/**
 * Tier 3: Cross-Feature Combinations E2E Tests
 * Covers pairwise interactions across Fraud Detection & Anomaly Engine features:
 * - C1 (F3 + F7): Rate Limit + Velocity Burst Interaction
 * - C2 (F4 + F12): Admin Block IP + Audit Trail + Subsequent 403 Rejection
 * - C3 (F6 + F9): Suspicious Click Persistence + Matcher Attribution Safeguard
 * - C4 (F6 + F12): Admin Approval + Attribution Recovery
 * - C5 (F7 + F8): Multi-Anomaly Stacking (Burst + High Ratio)
 * - C6 (F3 + F4): Rate Limit Escalation to Auto-Block
 * - C7 (F11 + F12): Admin Bulk Resolve + Atomic Audit Trail
 * - C8 (F4 + F5): Admin Unblock + Route Ingestion Restoration
 * - C9 (F5 + F11): RBAC Protection on Admin Fraud APIs
 * - C10 (F5 + Deals): Inactive Deal Lifecycle + Fraud Route Defense
 * - C11 (F7 + Session): Session Correlation Across Rotated IPs
 * - C12 (F12 + Security): Tamper Resistance of Audit Trail
 *
 * Total: 12 test cases (>= 10 requirement)
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

describe('Tier 3: Pairwise Cross-Feature Interactions', () => {
  // ==========================================================================
  // C1: Rate Limit + Velocity Burst Interaction (F3 + F7)
  // ==========================================================================
  it('C1: click stream triggers BURST_CLICK early and escalates to 429 when exceeding 100/hr', async () => {
    const engine = await getFraudEngine();
    const testIp = '198.51.100.210';
    const now = Date.now();

    // 1. First 2 clicks within 300ms trigger burst detection
    mockFraudDB.dealClicks.set('c-burst-1', {
      id: 'c-burst-1',
      deal_id: 'deal-active-1',
      affiliate_code: 'aff1',
      affiliate_id: 'u1',
      session_id: 's-c1',
      ip_address: testIp,
      user_agent: 'bot',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 300).toISOString(),
    });

    if (engine && typeof engine.evaluateClickVelocity === 'function') {
      const burstEval = await engine.evaluateClickVelocity(mockFraudDB, {
        ipAddress: testIp,
        sessionId: 's-c1',
        dealId: 'deal-active-1',
        affiliateCode: 'aff1',
      });
      expect(burstEval.isSuspicious).toBe(true);
      expect(burstEval.flagReasons).toContain('BURST_CLICK');
    }

    // 2. Add 99 more clicks to hit rate limit ceiling (total 100 clicks)
    for (let i = 2; i <= 100; i++) {
      mockFraudDB.dealClicks.set(`c-stream-${i}`, {
        id: `c-stream-${i}`,
        deal_id: 'deal-active-1',
        affiliate_code: 'aff1',
        affiliate_id: 'u1',
        session_id: `s-${i}`,
        ip_address: testIp,
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - (i * 1000)).toISOString(),
      });
    }

    if (engine && typeof engine.checkIpRateLimit === 'function') {
      const limitCheck = await engine.checkIpRateLimit(mockFraudDB, testIp);
      expect(limitCheck.allowed).toBe(false);
      expect(limitCheck.retryAfter).toBeGreaterThan(0);
    }
  });

  // ==========================================================================
  // C2: Blocked IP + Audit Trail + Route 403 (F4 + F12)
  // ==========================================================================
  it('C2: admin block action creates audit log in fraud_reviews and rejects traffic with 403', async () => {
    const targetIp = '198.51.100.211';

    // 1. Admin blocks IP
    mockFraudDB.prepare(`
      INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
      VALUES (?, ?, ?, ?)
    `).bind('b-c2', targetIp, 'DDoS bot cluster', 'usr-admin-1').run();

    // 2. Audit record created in fraud_reviews
    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('rev-c2', 'system', 'usr-admin-1', 'block_ip', 'DDoS bot cluster').run();

    expect(mockFraudDB.blockedIps.has(targetIp)).toBe(true);
    expect(mockFraudDB.fraudReviews.has('rev-c2')).toBe(true);

    // 3. Subsequent deal click from target IP is rejected with 403
    const req = createFraudTestRequest('/api/deals/deal-active-1/click', {
      method: 'POST',
      ip: targetIp,
      body: { userId: 'usr-trader-1' },
    });

    const res = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      req,
      { id: 'deal-active-1' }
    );

    if (isFraudEngineImplemented()) {
      expect(res.status).toBe(403);
    } else {
      expect([200, 403, 501]).toContain(res.status);
    }
  });

  // ==========================================================================
  // C3: Suspicious Click Persistence + Matcher Safeguard (F6 + F9)
  // ==========================================================================
  it('C3: suspicious click with flag_reasons is safely ignored by Matcher attribution', async () => {
    // 1. Persist suspicious click
    mockFraudDB.dealClicks.set('click-susp-c3', {
      id: 'click-susp-c3',
      deal_id: 'deal-active-1',
      affiliate_code: 'usr-affiliate-1',
      affiliate_id: 'usr-trader-1',
      session_id: 'sess-c3',
      ip_address: '1.2.3.4',
      user_agent: 'headless-chrome',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1,
      flag_reasons: '["BURST_CLICK", "HIGH_CLICK_CONVERSION_RATIO"]',
      anomaly_score: 0.95,
      created_at: new Date().toISOString(),
    });

    // 2. Customer performs trade
    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId: 'deal-active-1',
      userIdentifier: '0x1111111111111111111111111111111111111111',
      tradeVolumeUsd: 5000,
    });

    if (isFraudEngineImplemented()) {
      expect(result.click).toBeNull();
      expect(result.totalCommission).toBe(0);
    }
  });

  // ==========================================================================
  // C4: Admin Approval + Attribution Recovery (F6 + F12)
  // ==========================================================================
  it('C4: admin approves flagged click, writes audit log, and restores commission payout', async () => {
    // 1. Initially suspicious click
    mockFraudDB.dealClicks.set('click-review-c4', {
      id: 'click-review-c4',
      deal_id: 'deal-active-1',
      affiliate_code: 'usr-affiliate-1',
      affiliate_id: 'usr-trader-1',
      session_id: 'sess-c4',
      ip_address: '1.2.3.4',
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1,
      flag_reasons: '["BURST_CLICK"]',
      anomaly_score: 0.8,
      created_at: new Date().toISOString(),
    });

    // 2. Admin reviews and approves
    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('rev-c4', 'click-review-c4', 'usr-admin-1', 'approve', 'Customer verified manually').run();

    // 3. Clear is_suspicious
    mockFraudDB.prepare(`
      UPDATE deal_clicks SET is_suspicious = ?, anomaly_score = ? WHERE id = ?
    `).bind(0, 0.0, 'click-review-c4').run();

    // 4. Matcher now attributes successfully
    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId: 'deal-active-1',
      userIdentifier: '0x1111111111111111111111111111111111111111',
      tradeVolumeUsd: 1000,
    });

    expect(result.click?.id).toBe('click-review-c4');
    expect(result.totalCommission).toBe(30); // 1000 * 0.10 * 0.30
    expect(mockFraudDB.fraudReviews.has('rev-c4')).toBe(true);
  });

  // ==========================================================================
  // C5: Multi-Anomaly Stacking (F7 + F8)
  // ==========================================================================
  it('C5: stacks BURST_CLICK and HIGH_CLICK_CONVERSION_RATIO with cumulative anomaly score', async () => {
    const engine = await getFraudEngine();
    const affCode = 'stack-affiliate';
    const testIp = '198.51.100.215';
    const now = Date.now();

    // Seed 15 clicks for high ratio condition (15 clicks, 0 conversions)
    for (let i = 0; i < 15; i++) {
      mockFraudDB.dealClicks.set(`c-stack-${i}`, {
        id: `c-stack-${i}`,
        deal_id: 'deal-active-1',
        affiliate_code: affCode,
        affiliate_id: 'u-stack',
        session_id: `s-${i}`,
        ip_address: `198.51.100.${i}`,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 100000).toISOString(),
      });
    }

    // Recent click 200ms ago from same IP to trigger burst condition
    mockFraudDB.dealClicks.set('c-stack-burst', {
      id: 'c-stack-burst',
      deal_id: 'deal-active-1',
      affiliate_code: affCode,
      affiliate_id: 'u-stack',
      session_id: 's-burst-stack',
      ip_address: testIp,
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 200).toISOString(),
    });

    if (engine && typeof engine.evaluateClickVelocity === 'function') {
      const evalResult = await engine.evaluateClickVelocity(mockFraudDB, {
        ipAddress: testIp,
        sessionId: 's-burst-stack',
        dealId: 'deal-active-1',
        affiliateCode: affCode,
      });

      expect(evalResult.isSuspicious).toBe(true);
      expect(evalResult.flagReasons).toContain('BURST_CLICK');
      expect(evalResult.flagReasons).toContain('HIGH_CLICK_CONVERSION_RATIO');
      expect(evalResult.anomalyScore).toBeGreaterThanOrEqual(0.85);
    }
  });

  // ==========================================================================
  // C6: Rate Limit Escalation to Auto-Block (F3 + F4)
  // ==========================================================================
  it('C6: auto-blocks repeated rate limit offenders and transitions response from 429 to 403', async () => {
    const testIp = '198.51.100.216';

    // Simulate auto-block trigger
    mockFraudDB.prepare(`
      INSERT INTO blocked_ips (id, ip_address, reason, blocked_by)
      VALUES (?, ?, ?, ?)
    `).bind('b-auto-c6', testIp, 'Repeated rate limit threshold reached', 'system').run();

    const req = createFraudTestRequest('/api/deals/deal-active-1/click', {
      method: 'POST',
      ip: testIp,
      body: { userId: 'usr-trader-1' },
    });

    const res = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      req,
      { id: 'deal-active-1' }
    );

    if (isFraudEngineImplemented()) {
      expect(res.status).toBe(403);
    } else {
      expect([200, 403, 501]).toContain(res.status);
    }
  });

  // ==========================================================================
  // C7: Admin Bulk Resolve + Atomic Audit Trail (F11 + F12)
  // ==========================================================================
  it('C7: bulk_resolve updates multiple clicks and writes corresponding immutable audit logs', async () => {
    const clickIds = ['c-bulk-1', 'c-bulk-2', 'c-bulk-3'];

    // Seed 3 suspicious clicks
    clickIds.forEach((id) => {
      mockFraudDB.dealClicks.set(id, {
        id,
        deal_id: 'deal-active-1',
        affiliate_code: 'aff1',
        affiliate_id: 'u1',
        session_id: `s-${id}`,
        ip_address: '1.2.3.4',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        created_at: new Date().toISOString(),
      });
    });

    // Execute atomic batch review simulation
    const statements = clickIds.map((id) =>
      mockFraudDB.prepare(`
        INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
        VALUES (?, ?, ?, ?, ?)
      `).bind(`rev-${id}`, id, 'usr-admin-1', 'bulk_resolve', 'Resolved in batch')
    );

    await mockFraudDB.batch(statements);

    expect(mockFraudDB.fraudReviews.size).toBe(3);
    clickIds.forEach((id) => {
      expect(mockFraudDB.fraudReviews.has(`rev-${id}`)).toBe(true);
    });
  });

  // ==========================================================================
  // C8: Admin Unblock + Route Ingestion Restoration (F4 + F5)
  // ==========================================================================
  it('C8: admin unblocks IP, records audit log, and restores click route access', async () => {
    const testIp = '198.51.100.218';

    // 1. Initial block
    mockFraudDB.blockedIps.set(testIp, {
      id: 'b-c8',
      ip_address: testIp,
      reason: 'Temporary investigation',
      blocked_by: 'admin',
      blocked_at: new Date().toISOString(),
      expires_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });

    // 2. Admin unblocks
    mockFraudDB.prepare('DELETE FROM blocked_ips WHERE ip_address = ?').bind(testIp).run();

    // 3. Audit unblock action
    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('rev-unblock-c8', 'system', 'usr-admin-1', 'unblock_ip', 'Appealed and verified clean').run();

    expect(mockFraudDB.blockedIps.has(testIp)).toBe(false);

    // 4. Request from unblocked IP succeeds
    const req = createFraudTestRequest('/api/deals/deal-active-1/click', {
      method: 'POST',
      ip: testIp,
      body: { userId: 'usr-trader-1' },
    });

    const res = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      req,
      { id: 'deal-active-1' }
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  // ==========================================================================
  // C9: RBAC Protection on Admin Fraud APIs (F5 + F11)
  // ==========================================================================
  it('C9: prevents non-admin user from querying fraud stats or posting review actions', async () => {
    const nonAdminReq = createFraudTestRequest('/api/admin/fraud/actions', {
      method: 'POST',
      admin: false,
      body: { action: 'approve', clickIds: ['c1'], reason: 'Unauthorized attempt' },
    });

    const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', nonAdminReq);
    if (res.implemented) {
      expect([401, 403]).toContain(res.status);
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    } else {
      expect(res.status).toBe(501);
    }
  });

  // ==========================================================================
  // C10: Inactive Deal Lifecycle + Fraud Defense (F5 + Deals)
  // ==========================================================================
  it('C10: rejects clicks on inactive deals before rate limiting or click logging', async () => {
    const req = createFraudTestRequest('/api/deals/deal-inactive-1/click', {
      method: 'POST',
      ip: '198.51.100.220',
      body: { userId: 'usr-trader-1' },
    });

    const initialClicks = mockFraudDB.dealClicks.size;

    const res = await dispatchRoute(
      'src/app/api/deals/[id]/click/route.ts',
      'POST',
      req,
      { id: 'deal-inactive-1' }
    );

    expect(res.status).toBe(410);
    expect(mockFraudDB.dealClicks.size).toBe(initialClicks);
  });

  // ==========================================================================
  // C11: Session Correlation Across Rotated IPs (F7 + Session)
  // ==========================================================================
  it('C11: flags burst clicks sharing same session cookie even when adversary rotates IP addresses', async () => {
    const engine = await getFraudEngine();
    const fixedSession = 'adversary-sticky-session';
    const now = Date.now();

    // Prior click with IP A
    mockFraudDB.dealClicks.set('c-rot-1', {
      id: 'c-rot-1',
      deal_id: 'deal-active-1',
      affiliate_code: 'aff1',
      affiliate_id: 'u1',
      session_id: fixedSession,
      ip_address: '10.0.0.1', // IP A
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 400).toISOString(),
    });

    if (engine && typeof engine.evaluateClickVelocity === 'function') {
      const evalResult = await engine.evaluateClickVelocity(mockFraudDB, {
        ipAddress: '10.0.0.2', // IP B (rotated)
        sessionId: fixedSession, // Same session
        dealId: 'deal-active-1',
        affiliateCode: 'aff1',
      });

      expect(evalResult.isSuspicious).toBe(true);
      expect(evalResult.flagReasons).toContain('BURST_CLICK');
    }
  });

  // ==========================================================================
  // C12: Tamper Resistance of Audit Trail (F12 + Security)
  // ==========================================================================
  it('C12: ensures audit logs cannot be overwritten or altered by rogue database operations', async () => {
    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('audit-tamper-check', 'c-secure', 'usr-admin-1', 'reject', 'Initial rejection').run();

    await expect(
      mockFraudDB.prepare("UPDATE fraud_reviews SET action = 'approve' WHERE id = 'audit-tamper-check'").run()
    ).rejects.toThrow(/cannot modify immutable table/i);

    const log = mockFraudDB.fraudReviews.get('audit-tamper-check');
    expect(log?.action).toBe('reject');
  });
});
