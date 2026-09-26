/**
 * Milestone 3 Challenger Stress Test Suite: Anti-Circumvention & Cross-Feature Fraud Scenarios
 * Location: src/__tests__/fraud/challenger-m3-anti-circumvention.test.ts
 *
 * Empirical adversarial stress testing for:
 * 1. Multi-anomaly stacking (Test C5 deep dive):
 *    - Rapid burst (<2s) + high conversion ratio (>10:1) produces cumulative score >= 0.85
 *    - Both reason codes ('BURST_CLICK' and 'HIGH_CLICK_CONVERSION_RATIO') present in flagReasons
 *    - Exact probabilistic union formula verification across multiple boundary deltas
 * 2. Anti-circumvention attack vectors:
 *    - Attacker keeping same IP but rotating session IDs: burst reliably detected via IP
 *    - Attacker keeping same session ID but rotating IPs: burst reliably detected via session
 *    - Ping-pong alternating IP and session mutation chain
 *    - Cross-deal click velocity isolation: ratio anomaly evaluates per deal-affiliate pair
 *    - Cross-affiliate click velocity isolation: clean affiliates on same deal are not penalized
 * 3. Conversion attribution isolation:
 *    - Flagged clicks (is_suspicious = 1) in deal_clicks never receive commissions in Matcher.resolveClick
 *    - Admin approving click (is_suspicious = 0) immediately restores attribution eligibility
 *    - Admin revoking / re-flagging (is_suspicious = 1) immediately denies attribution
 *    - Shadowing resistance: chronological legitimate clicks survive despite newer suspicious click flood
 */

import {
  mockFraudDB,
  setupFraudTestEnvironment,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import {
  evaluateClickVelocity,
  parseTimestampMs,
} from '@/lib/fraud/fraud-engine';
import { Matcher } from '@/lib/tracking/matcher';
import { FraudReasonCode } from '@/types/fraud';

beforeAll(() => {
  setupFraudTestEnvironment();
});

beforeEach(() => {
  mockFraudDB.reset();

  // Seed default active deals
  mockFraudDB.deals.set('deal-active-1', {
    id: 'deal-active-1',
    title: 'Active Deal 1',
    description: 'Active deal for stress testing',
    category: 'exchanges',
    url: 'https://exchange-alpha.example.com/register',
    cashback_percentage: 10.0,
    default_commission_rate: 0.10,
    default_commission_type: 'percentage',
    fixed_commission_amount: 0,
    affiliate_terms: null,
    is_active: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  mockFraudDB.deals.set('deal-active-2', {
    id: 'deal-active-2',
    title: 'Active Deal 2',
    description: 'Second active deal for cross-deal testing',
    category: 'exchanges',
    url: 'https://exchange-beta.example.com/register',
    cashback_percentage: 15.0,
    default_commission_rate: 0.15,
    default_commission_type: 'percentage',
    fixed_commission_amount: 0,
    affiliate_terms: null,
    is_active: 1,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Seed test profiles and referral tree
  mockFraudDB.profiles.set('usr-trader-m3', {
    id: 'usr-trader-m3',
    email: 'trader-m3@apex-os.com',
    full_name: 'Trader M3',
    role: 'user',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  mockFraudDB.walletConnections.set('wc-trader-m3', {
    id: 'wc-trader-m3',
    profile_id: 'usr-trader-m3',
    wallet_address: '0x3333333333333333333333333333333333333333',
    preferred_chain: 'ethereum',
    is_primary: 1,
    connected_at: new Date().toISOString(),
    last_used_at: null,
  });

  mockFraudDB.profiles.set('usr-affiliate-m3', {
    id: 'usr-affiliate-m3',
    email: 'affiliate-m3@apex-os.com',
    full_name: 'Affiliate M3',
    role: 'user',
    referral_code: 'aff-code-m3',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  mockFraudDB.referralTree.set('rt-affiliate-m3', {
    id: 'rt-affiliate-m3',
    affiliate_id: 'usr-affiliate-m3',
    parent_id: null,
    path: 'usr-affiliate-m3',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
});

describe('Challenger M3: Multi-Anomaly Stacking (Test C5 Deep Dive)', () => {
  const affCode = 'aff-stack-deep';
  const dealId = 'deal-active-1';
  const testIp = '198.51.100.70';
  const now = 1758816000000;

  it('1.1 Sub-second burst (300ms) + high ratio (>10:1) stacks to score >= 0.85 with both reason codes', async () => {
    // 15 clicks and 0 conversions -> high ratio anomaly (score: 0.70)
    for (let i = 0; i < 15; i++) {
      mockFraudDB.dealClicks.set(`c-deep-ratio-${i}`, {
        id: `c-deep-ratio-${i}`,
        deal_id: dealId,
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
        created_at: new Date(now - 120000).toISOString(),
      });
    }

    // Prior click 300ms ago -> sub-second burst (score: 0.90)
    mockFraudDB.dealClicks.set('c-deep-burst-300', {
      id: 'c-deep-burst-300',
      deal_id: dealId,
      affiliate_code: affCode,
      affiliate_id: 'u-stack',
      session_id: 's-burst-300',
      ip_address: testIp,
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 300).toISOString(),
    });

    const res = await evaluateClickVelocity(mockFraudDB as any, {
      dealId,
      affiliateCode: affCode,
      affiliateId: 'u-stack',
      sessionId: 's-burst-300',
      ipAddress: testIp,
      timestamp: now,
    });

    expect(res.isSuspicious).toBe(true);
    expect(res.burstDetected).toBe(true);
    expect(res.ratioAnomalyDetected).toBe(true);
    expect(res.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
    expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
    // Probabilistic union: 1 - (1 - 0.90) * (1 - 0.70) = 1 - 0.10 * 0.30 = 0.97
    expect(res.anomalyScore).toBe(0.97);
    expect(res.anomalyScore).toBeGreaterThanOrEqual(0.85);
  });

  it('1.2 1.5s burst (1500ms) + high ratio (>10:1) stacks to score >= 0.85 with both reason codes', async () => {
    // 12 clicks, 0 conversions
    for (let i = 0; i < 12; i++) {
      mockFraudDB.dealClicks.set(`c-deep-ratio2-${i}`, {
        id: `c-deep-ratio2-${i}`,
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u-stack',
        session_id: `s2-${i}`,
        ip_address: `198.51.100.${i}`,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 120000).toISOString(),
      });
    }

    // Prior click 1500ms ago -> burst (score: 0.85)
    mockFraudDB.dealClicks.set('c-deep-burst-1500', {
      id: 'c-deep-burst-1500',
      deal_id: dealId,
      affiliate_code: affCode,
      affiliate_id: 'u-stack',
      session_id: 's-burst-1500',
      ip_address: testIp,
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 1500).toISOString(),
    });

    const res = await evaluateClickVelocity(mockFraudDB as any, {
      dealId,
      affiliateCode: affCode,
      affiliateId: 'u-stack',
      sessionId: 's-burst-1500',
      ipAddress: testIp,
      timestamp: now,
    });

    expect(res.isSuspicious).toBe(true);
    expect(res.burstDetected).toBe(true);
    expect(res.ratioAnomalyDetected).toBe(true);
    expect(res.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
    expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
    // Probabilistic union: 1 - (1 - 0.85) * (1 - 0.70) = 1 - 0.15 * 0.30 = 0.955
    expect(res.anomalyScore).toBe(0.955);
    expect(res.anomalyScore).toBeGreaterThanOrEqual(0.85);
  });

  it('1.3 Boundary burst at 1999ms + high ratio (>10:1) stacks to 0.955 >= 0.85', async () => {
    // 10 clicks, 0 conversions
    for (let i = 0; i < 10; i++) {
      mockFraudDB.dealClicks.set(`c-deep-ratio3-${i}`, {
        id: `c-deep-ratio3-${i}`,
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u-stack',
        session_id: `s3-${i}`,
        ip_address: `198.51.100.${i}`,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 120000).toISOString(),
      });
    }

    mockFraudDB.dealClicks.set('c-deep-burst-1999', {
      id: 'c-deep-burst-1999',
      deal_id: dealId,
      affiliate_code: affCode,
      affiliate_id: 'u-stack',
      session_id: 's-burst-1999',
      ip_address: testIp,
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 1999).toISOString(),
    });

    const res = await evaluateClickVelocity(mockFraudDB as any, {
      dealId,
      affiliateCode: affCode,
      affiliateId: 'u-stack',
      sessionId: 's-burst-1999',
      ipAddress: testIp,
      timestamp: now,
    });

    expect(res.isSuspicious).toBe(true);
    expect(res.burstDetected).toBe(true);
    expect(res.ratioAnomalyDetected).toBe(true);
    expect(res.flagReasons).toEqual(
      expect.arrayContaining([FraudReasonCode.BURST_CLICK, FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO])
    );
    expect(res.anomalyScore).toBe(0.955);
    expect(res.anomalyScore).toBeGreaterThanOrEqual(0.85);
  });

  it('1.4 High ratio with 2000ms delta (non-burst) isolates ratio anomaly without stacking burst', async () => {
    // 10 clicks, 0 conversions
    for (let i = 0; i < 10; i++) {
      mockFraudDB.dealClicks.set(`c-deep-ratio4-${i}`, {
        id: `c-deep-ratio4-${i}`,
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u-stack',
        session_id: `s4-${i}`,
        ip_address: `198.51.100.${i}`,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 120000).toISOString(),
      });
    }

    mockFraudDB.dealClicks.set('c-deep-burst-2000', {
      id: 'c-deep-burst-2000',
      deal_id: dealId,
      affiliate_code: affCode,
      affiliate_id: 'u-stack',
      session_id: 's-burst-2000',
      ip_address: testIp,
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      created_at: new Date(now - 2000).toISOString(),
    });

    const res = await evaluateClickVelocity(mockFraudDB as any, {
      dealId,
      affiliateCode: affCode,
      affiliateId: 'u-stack',
      sessionId: 's-burst-2000',
      ipAddress: testIp,
      timestamp: now,
    });

    expect(res.isSuspicious).toBe(true);
    expect(res.burstDetected).toBe(false);
    expect(res.ratioAnomalyDetected).toBe(true);
    expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
    expect(res.flagReasons).not.toContain(FraudReasonCode.BURST_CLICK);
    expect(res.anomalyScore).toBe(0.70);
  });
});

describe('Challenger M3: Anti-Circumvention Stress Testing', () => {
  const dealId = 'deal-active-1';
  const now = 1758816000000;

  describe('2. Session Rotation Attack: Fixed IP with Ephemeral Sessions', () => {
    it('2.1 flags rapid bursts sharing same IP despite attacker rotating session IDs on every click', async () => {
      const fixedIp = '198.51.100.81';

      // Click 1: Session A at T - 400ms
      mockFraudDB.dealClicks.set('c-rot-sess-1', {
        id: 'c-rot-sess-1',
        deal_id: dealId,
        affiliate_code: 'aff-adv',
        affiliate_id: 'u-adv',
        session_id: 'sess-alpha',
        ip_address: fixedIp,
        user_agent: 'botnet-worker',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 400).toISOString(),
      });

      // Click 2: Session B at T from same fixed IP
      const eval2 = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: 'aff-adv',
        affiliateId: 'u-adv',
        sessionId: 'sess-bravo-mutated', // New session!
        ipAddress: fixedIp,              // Same IP!
        timestamp: now,
      });

      expect(eval2.isSuspicious).toBe(true);
      expect(eval2.burstDetected).toBe(true);
      expect(eval2.burstDetails?.matchedBy).toBe('ip');
      expect(eval2.burstDetails?.previousClickId).toBe('c-rot-sess-1');
      expect(eval2.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
    });

    it('2.2 route ingestion persists is_suspicious = 1 when session is rotated under fixed IP', async () => {
      const fixedIp = '198.51.100.82';

      // Seed initial click
      mockFraudDB.dealClicks.set('c-rot-prior', {
        id: 'c-rot-prior',
        deal_id: dealId,
        affiliate_code: 'aff-adv-route',
        affiliate_id: 'u-adv-route',
        session_id: 'cookie-sess-initial',
        ip_address: fixedIp,
        user_agent: 'curl/7.68',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        created_at: new Date(Date.now() - 350).toISOString(),
      });

      // Rapid request with completely new cookie
      const req = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': fixedIp,
          cookie: 'apex_tracking_id=cookie-sess-rotated-brand-new',
        },
        body: { userId: 'u-adv-route' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: dealId }
      );

      expect(res.status).toBe(200);

      // Verify that database flagged the click due to IP burst
      const inserted = Array.from(mockFraudDB.dealClicks.values()).find(
        (c) => c.session_id === 'cookie-sess-rotated-brand-new'
      );
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.flag_reasons).toContain('BURST_CLICK');
      expect(inserted?.anomaly_score).toBeGreaterThanOrEqual(0.85);
    });
  });

  describe('3. IP Rotation Attack: Fixed Session Cookie Across Distributed Proxies', () => {
    it('3.1 flags rapid bursts sharing same session ID despite attacker rotating IP addresses', async () => {
      const fixedSession = 'adversary-persistent-session-uuid';

      // Click 1: IP 10.10.1.1 at T - 500ms
      mockFraudDB.dealClicks.set('c-rot-ip-1', {
        id: 'c-rot-ip-1',
        deal_id: dealId,
        affiliate_code: 'aff-adv',
        affiliate_id: 'u-adv',
        session_id: fixedSession,
        ip_address: '10.10.1.1',
        user_agent: 'residential-proxy',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 500).toISOString(),
      });

      // Click 2: Rotated IP 172.16.50.99 from same persistent session
      const eval2 = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: 'aff-adv',
        affiliateId: 'u-adv',
        sessionId: fixedSession,      // Same session!
        ipAddress: '172.16.50.99',    // Completely new IP!
        timestamp: now,
      });

      expect(eval2.isSuspicious).toBe(true);
      expect(eval2.burstDetected).toBe(true);
      expect(eval2.burstDetails?.matchedBy).toBe('session');
      expect(eval2.burstDetails?.previousClickId).toBe('c-rot-ip-1');
      expect(eval2.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
    });

    it('3.2 route ingestion persists is_suspicious = 1 when IP is rotated under fixed session cookie', async () => {
      const fixedSession = 'apex-cookie-pinned-session';

      // Prior click with IP 192.0.2.1
      mockFraudDB.dealClicks.set('c-rot-ip-prior', {
        id: 'c-rot-ip-prior',
        deal_id: dealId,
        affiliate_code: 'aff-adv-ip',
        affiliate_id: 'u-adv-ip',
        session_id: fixedSession,
        ip_address: '192.0.2.1',
        user_agent: 'proxy-bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        created_at: new Date(Date.now() - 400).toISOString(),
      });

      // Route request with new IP 192.0.2.2 but same cookie
      const req = createFraudTestRequest(`/api/deals/${dealId}/click`, {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '192.0.2.2',
          cookie: `apex_tracking_id=${fixedSession}`,
        },
        body: { userId: 'u-adv-ip' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: dealId }
      );

      expect(res.status).toBe(200);

      const inserted = Array.from(mockFraudDB.dealClicks.values()).find(
        (c) => c.ip_address === '192.0.2.2'
      );
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.flag_reasons).toContain('BURST_CLICK');
    });
  });

  describe('4. Ping-Pong Mutation Attack: Alternating IP & Session Chain', () => {
    it('4.1 seamlessly detects every step in an alternating IP-then-Session mutation chain', async () => {
      // Step 1: Base click at T0 (IP 10.0.0.1, Session S1)
      mockFraudDB.dealClicks.set('step-1', {
        id: 'step-1',
        deal_id: dealId,
        affiliate_code: 'aff-chain',
        affiliate_id: 'u-chain',
        session_id: 'chain-sess-1',
        ip_address: '10.0.0.1',
        created_at: new Date(now - 1200).toISOString(),
      });

      // Step 2 at T0 + 300ms: Change IP to 10.0.0.2, Keep Session S1 -> Caught via Session!
      const step2 = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: 'aff-chain',
        affiliateId: 'u-chain',
        sessionId: 'chain-sess-1',
        ipAddress: '10.0.0.2',
        timestamp: now - 900,
      });
      expect(step2.burstDetected).toBe(true);
      expect(step2.burstDetails?.matchedBy).toBe('session');

      mockFraudDB.dealClicks.set('step-2', {
        id: 'step-2',
        deal_id: dealId,
        affiliate_code: 'aff-chain',
        affiliate_id: 'u-chain',
        session_id: 'chain-sess-1',
        ip_address: '10.0.0.2',
        created_at: new Date(now - 900).toISOString(),
      });

      // Step 3 at T0 + 600ms: Keep IP 10.0.0.2, Change Session to S2 -> Caught via IP!
      const step3 = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: 'aff-chain',
        affiliateId: 'u-chain',
        sessionId: 'chain-sess-2',
        ipAddress: '10.0.0.2',
        timestamp: now - 600,
      });
      expect(step3.burstDetected).toBe(true);
      expect(step3.burstDetails?.matchedBy).toBe('ip');

      mockFraudDB.dealClicks.set('step-3', {
        id: 'step-3',
        deal_id: dealId,
        affiliate_code: 'aff-chain',
        affiliate_id: 'u-chain',
        session_id: 'chain-sess-2',
        ip_address: '10.0.0.2',
        created_at: new Date(now - 600).toISOString(),
      });

      // Step 4 at T0 + 900ms: Change IP to 10.0.0.3, Keep Session S2 -> Caught via Session!
      const step4 = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: 'aff-chain',
        affiliateId: 'u-chain',
        sessionId: 'chain-sess-2',
        ipAddress: '10.0.0.3',
        timestamp: now - 300,
      });
      expect(step4.burstDetected).toBe(true);
      expect(step4.burstDetails?.matchedBy).toBe('session');
    });
  });

  describe('5. High Velocity Multi-Deal Isolation (Per Deal-Affiliate Pair)', () => {
    const affiliateCode = 'aff-multi-deal';
    const dealA = 'deal-active-1';
    const dealB = 'deal-active-2';

    it('5.1 ratio anomaly triggers on flooded Deal A while clean Deal B remains unaffected', async () => {
      // Flood Deal A: 15 clicks, 0 conversions (ratio Infinity > 10:1)
      for (let i = 0; i < 15; i++) {
        mockFraudDB.dealClicks.set(`c-dealA-${i}`, {
          id: `c-dealA-${i}`,
          deal_id: dealA,
          affiliate_code: affiliateCode,
          affiliate_id: 'u-multi',
          session_id: `s-A-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(now - 100000).toISOString(),
        });
      }

      // Clean Deal B: 3 clicks, 1 conversion (ratio 3.0:1 <= 10:1)
      for (let i = 0; i < 3; i++) {
        mockFraudDB.dealClicks.set(`c-dealB-${i}`, {
          id: `c-dealB-${i}`,
          deal_id: dealB,
          affiliate_code: affiliateCode,
          affiliate_id: 'u-multi',
          session_id: `s-B-${i}`,
          ip_address: `203.0.113.${i}`,
          created_at: new Date(now - 100000).toISOString(),
        });
      }

      mockFraudDB.conversions.set('conv-dealB-1', {
        id: 'conv-dealB-1',
        deal_id: dealB,
        affiliate_code: affiliateCode,
        affiliate_id: 'u-multi',
        user_id: 'trader-b',
        amount: 250,
        status: 'confirmed',
        created_at: new Date(now - 80000).toISOString(),
      });

      // Evaluation on Deal A: MUST trigger ratio anomaly
      const evalDealA = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: dealA,
        affiliateCode: affiliateCode,
        affiliateId: 'u-multi',
        sessionId: 's-eval-A',
        ipAddress: '198.51.200.1',
        timestamp: now,
      });
      expect(evalDealA.ratioAnomalyDetected).toBe(true);
      expect(evalDealA.isSuspicious).toBe(true);
      expect(evalDealA.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(evalDealA.ratioDetails?.dealId).toBe(dealA);
      expect(evalDealA.ratioDetails?.totalClicks).toBe(15);
      expect(evalDealA.ratioDetails?.totalConversions).toBe(0);

      // Evaluation on Deal B: MUST be CLEAN
      const evalDealB = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: dealB,
        affiliateCode: affiliateCode,
        affiliateId: 'u-multi',
        sessionId: 's-eval-B',
        ipAddress: '198.51.200.2',
        timestamp: now,
      });
      expect(evalDealB.ratioAnomalyDetected).toBe(false);
      expect(evalDealB.isSuspicious).toBe(false);
      expect(evalDealB.flagReasons).not.toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
    });

    it('5.2 ratio anomaly does not leak between different affiliates on the same deal', async () => {
      const badAffiliate = 'aff-spammer';
      const cleanAffiliate = 'aff-genuine';

      // Bad affiliate: 20 clicks, 0 conversions on Deal A
      for (let i = 0; i < 20; i++) {
        mockFraudDB.dealClicks.set(`c-spammer-${i}`, {
          id: `c-spammer-${i}`,
          deal_id: dealA,
          affiliate_code: badAffiliate,
          affiliate_id: 'u-bad',
          session_id: `s-bad-${i}`,
          ip_address: `198.51.100.${i}`,
          created_at: new Date(now - 100000).toISOString(),
        });
      }

      // Clean affiliate: 12 clicks, 2 conversions on Deal A (ratio 6.0 <= 10:1)
      for (let i = 0; i < 12; i++) {
        mockFraudDB.dealClicks.set(`c-clean-${i}`, {
          id: `c-clean-${i}`,
          deal_id: dealA,
          affiliate_code: cleanAffiliate,
          affiliate_id: 'u-good',
          session_id: `s-good-${i}`,
          ip_address: `203.0.113.${i}`,
          created_at: new Date(now - 100000).toISOString(),
        });
      }

      mockFraudDB.conversions.set('conv-good-1', {
        id: 'conv-good-1',
        deal_id: dealA,
        affiliate_code: cleanAffiliate,
        affiliate_id: 'u-good',
        user_id: 'trader-g1',
        amount: 100,
        status: 'confirmed',
        created_at: new Date(now - 90000).toISOString(),
      });

      mockFraudDB.conversions.set('conv-good-2', {
        id: 'conv-good-2',
        deal_id: dealA,
        affiliate_code: cleanAffiliate,
        affiliate_id: 'u-good',
        user_id: 'trader-g2',
        amount: 150,
        status: 'approved',
        created_at: new Date(now - 80000).toISOString(),
      });

      // Bad affiliate click -> FLAGGED
      const resBad = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: dealA,
        affiliateCode: badAffiliate,
        affiliateId: 'u-bad',
        sessionId: 's-bad-test',
        ipAddress: '198.51.250.1',
        timestamp: now,
      });
      expect(resBad.ratioAnomalyDetected).toBe(true);
      expect(resBad.isSuspicious).toBe(true);

      // Clean affiliate click -> CLEAN
      const resClean = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: dealA,
        affiliateCode: cleanAffiliate,
        affiliateId: 'u-good',
        sessionId: 's-clean-test',
        ipAddress: '198.51.250.2',
        timestamp: now,
      });
      expect(resClean.ratioAnomalyDetected).toBe(false);
      expect(resClean.isSuspicious).toBe(false);
    });
  });
});

describe('Challenger M3: Conversion Attribution Isolation & Admin Lifecycle', () => {
  const dealId = 'deal-active-1';
  const traderWallet = '0x3333333333333333333333333333333333333333';
  const traderUserId = 'usr-trader-m3';
  const affiliateCode = 'aff-code-m3';

  it('3.1 Direct attribution (Priority 1) with is_suspicious = 1 NEVER receives commission', async () => {
    mockFraudDB.dealClicks.set('click-m3-susp-p1', {
      id: 'click-m3-susp-p1',
      deal_id: dealId,
      affiliate_code: affiliateCode,
      affiliate_id: traderUserId,
      session_id: 'sess-p1',
      ip_address: '198.51.100.11',
      user_agent: 'bot',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1, // Flagged
      flag_reasons: '["BURST_CLICK"]',
      anomaly_score: 0.90,
      created_at: new Date().toISOString(),
    });

    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId,
      userIdentifier: traderWallet,
      tradeVolumeUsd: 2000,
    });

    expect(result.click).toBeNull();
    expect(result.totalCommission).toBe(0);
    expect(result.metadata.clickFound).toBe(false);
  });

  it('3.2 Cookie attribution (Priority 2) with is_suspicious = 1 NEVER receives commission', async () => {
    mockFraudDB.dealClicks.set('click-m3-susp-p2', {
      id: 'click-m3-susp-p2',
      deal_id: dealId,
      affiliate_code: affiliateCode,
      affiliate_id: 'unrelated-user-xyz',
      session_id: 'sess-p2',
      ip_address: '198.51.100.12',
      user_agent: 'bot',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1, // Flagged
      flag_reasons: '["HIGH_CLICK_CONVERSION_RATIO"]',
      anomaly_score: 0.70,
      created_at: new Date().toISOString(),
    });

    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId,
      userIdentifier: traderWallet,
      tradeVolumeUsd: 2000,
    });

    expect(result.click).toBeNull();
    expect(result.totalCommission).toBe(0);
  });

  it('3.3 Admin approval immediately restores attribution eligibility without restart or delay', async () => {
    const clickId = 'click-m3-approval-lifecycle';

    // 1. Initial flagged state
    mockFraudDB.dealClicks.set(clickId, {
      id: clickId,
      deal_id: dealId,
      affiliate_code: affiliateCode,
      affiliate_id: traderUserId,
      session_id: 'sess-approval-test',
      ip_address: '198.51.100.15',
      user_agent: 'genuine-user',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 1, // Suspicious initially
      flag_reasons: '["BURST_CLICK"]',
      anomaly_score: 0.85,
      created_at: new Date().toISOString(),
    });

    const matcher = new Matcher(mockFraudDB as any);

    // Initial check: 0 attribution
    const resPre = await matcher.match({
      dealId,
      userIdentifier: traderWallet,
      tradeVolumeUsd: 1000,
    });
    expect(resPre.click).toBeNull();
    expect(resPre.totalCommission).toBe(0);

    // 2. Admin performs review action: approve click
    mockFraudDB.prepare(`
      INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
      VALUES (?, ?, ?, ?, ?)
    `).bind('rev-appr-m3', clickId, 'admin-1', 'approve', 'Verified legitimate user transaction').run();

    mockFraudDB.prepare(`
      UPDATE deal_clicks SET is_suspicious = 0, anomaly_score = 0.0 WHERE id = ?
    `).bind(clickId).run();

    // 3. Immediately re-run Matcher: attribution restored!
    const resPost = await matcher.match({
      dealId,
      userIdentifier: traderWallet,
      tradeVolumeUsd: 1000,
    });

    expect(resPost.click?.id).toBe(clickId);
    expect(resPost.totalCommission).toBe(30); // 1000 * 0.10 * 0.30
    expect(resPost.metadata.clickFound).toBe(true);

    // 4. Admin subsequently revokes / re-flags click to suspicious
    mockFraudDB.prepare(`
      UPDATE deal_clicks SET is_suspicious = 1 WHERE id = ?
    `).bind(clickId).run();

    const resRevoked = await matcher.match({
      dealId,
      userIdentifier: traderWallet,
      tradeVolumeUsd: 1000,
    });

    expect(resRevoked.click).toBeNull();
    expect(resRevoked.totalCommission).toBe(0);
  });

  it('3.4 Newer suspicious clicks do not mask or shadow older legitimate clicks within attribution window', async () => {
    const nowMs = Date.now();

    // Older clean click (1 hour ago)
    mockFraudDB.dealClicks.set('click-older-clean', {
      id: 'click-older-clean',
      deal_id: dealId,
      affiliate_code: affiliateCode,
      affiliate_id: traderUserId,
      session_id: 'sess-older',
      ip_address: '198.51.100.20',
      user_agent: 'browser',
      referrer_url: null,
      country_code: 'US',
      device_type: 'desktop',
      click_type: 'link',
      is_unique: 1,
      is_suspicious: 0, // Clean
      flag_reasons: null,
      anomaly_score: 0.0,
      created_at: new Date(nowMs - 3600 * 1000).toISOString(),
    });

    // Newer spam/burst clicks (5 minutes ago)
    for (let i = 0; i < 5; i++) {
      mockFraudDB.dealClicks.set(`click-newer-spam-${i}`, {
        id: `click-newer-spam-${i}`,
        deal_id: dealId,
        affiliate_code: affiliateCode,
        affiliate_id: traderUserId,
        session_id: `sess-spam-${i}`,
        ip_address: `198.51.100.${30 + i}`,
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // Spam
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.90,
        created_at: new Date(nowMs - (300 - i * 10) * 1000).toISOString(),
      });
    }

    const matcher = new Matcher(mockFraudDB as any);
    const result = await matcher.match({
      dealId,
      userIdentifier: traderWallet,
      tradeVolumeUsd: 1000,
    });

    // Successfully matches older clean click!
    expect(result.click?.id).toBe('click-older-clean');
    expect(result.totalCommission).toBe(30);
  });
});
