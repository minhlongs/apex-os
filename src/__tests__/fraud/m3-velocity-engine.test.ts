/**
 * Milestone 3 Test Suite: Velocity Anomaly Engine, Multi-Anomaly Stacking & Click Ingestion
 * Location: src/__tests__/fraud/m3-velocity-engine.test.ts
 *
 * Comprehensive tests covering all M3 capabilities:
 * 1. Timestamp normalization (parseTimestampMs: ISO 8601, SQLite space format in UTC, overrides)
 * 2. Rapid multi-click burst detection (Feature F7: <2s window, exact 2000ms boundary, first click, sub-second scores)
 * 3. Click-to-conversion ratio velocity (Feature F8: >10:1 ratio, 10-click floor, 9 clean, confirmed/approved filtering)
 * 4. Multi-anomaly score stacking (Test C5: burst + ratio probabilistic union >= 0.85)
 * 5. Ingestion route integration & persistence (POST & GET deals/[id]/click, GET tracking/click with is_suspicious = 1)
 * 6. Fraud transparency (legitimate HTTP 200 / 302 responses for suspicious traffic)
 * 7. Attribution isolation in Matcher (suspicious clicks never receive commission)
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

describe('Milestone 3: Velocity Anomaly Engine & Ingestion Integration', () => {
  // ==========================================================================
  // 1. Robust Timestamp Normalization (parseTimestampMs)
  // ==========================================================================
  describe('1. Timestamp Normalization (parseTimestampMs)', () => {
    it('accurately parses standard ISO 8601 UTC strings', () => {
      const iso = '2026-09-25T16:00:00.000Z';
      const expected = new Date(iso).getTime();
      expect(parseTimestampMs(iso)).toBe(expected);
    });

    it('accurately parses SQLite space-separated format in pure UTC without local offset drift', () => {
      const sqliteDate = '2026-09-25 16:00:00';
      const expectedUtc = Date.UTC(2026, 8, 25, 16, 0, 0, 0); // Month is 0-indexed: 8 = Sept
      expect(parseTimestampMs(sqliteDate)).toBe(expectedUtc);
    });

    it('accurately parses SQLite space-separated format with milliseconds in UTC', () => {
      const sqliteDateWithMs = '2026-09-25 16:00:00.500';
      const expectedUtc = Date.UTC(2026, 8, 25, 16, 0, 0, 500);
      expect(parseTimestampMs(sqliteDateWithMs)).toBe(expectedUtc);
    });

    it('accurately parses ISO strings with timezone offsets', () => {
      const isoWithOffset = '2026-09-25T11:00:00-05:00';
      const expected = new Date(isoWithOffset).getTime();
      expect(parseTimestampMs(isoWithOffset)).toBe(expected);
    });

    it('accurately parses numeric epochs and numeric strings', () => {
      const epoch = 1758816000000;
      expect(parseTimestampMs(epoch)).toBe(epoch);
      expect(parseTimestampMs(String(epoch))).toBe(epoch);
    });

    it('accurately parses Date objects', () => {
      const date = new Date(1758816000000);
      expect(parseTimestampMs(date)).toBe(1758816000000);
    });

    it('handles null, undefined, and empty string by falling back to current time', () => {
      const before = Date.now();
      const valNull = parseTimestampMs(null);
      const valUndef = parseTimestampMs(undefined);
      const valEmpty = parseTimestampMs('   ');
      const after = Date.now();

      expect(valNull).toBeGreaterThanOrEqual(before);
      expect(valNull).toBeLessThanOrEqual(after);
      expect(valUndef).toBeGreaterThanOrEqual(before);
      expect(valUndef).toBeLessThanOrEqual(after);
      expect(valEmpty).toBeGreaterThanOrEqual(before);
      expect(valEmpty).toBeLessThanOrEqual(after);
    });

    it('supports deterministic testability via click.timestamp override in evaluateClickVelocity', async () => {
      const fixedNow = 1758816000000;
      const priorTime = fixedNow - 1500; // 1500ms ago (<2000ms)

      mockFraudDB.dealClicks.set('click-prior-det', {
        id: 'click-prior-det',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-det',
        affiliate_id: 'u-det',
        session_id: 'sess-det',
        ip_address: '198.51.100.90',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(priorTime).toISOString(),
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-det',
        affiliateId: 'u-det',
        sessionId: 'sess-det',
        ipAddress: '198.51.100.90',
        timestamp: fixedNow,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.burstDetails?.deltaMs).toBe(1500);
    });
  });

  // ==========================================================================
  // 2. Feature F7: Rapid Multi-Click Burst Anomaly Detection
  // ==========================================================================
  describe('2. Feature F7: Rapid Multi-Click Burst Detection', () => {
    const testIp = '198.51.100.120';
    const testSession = 'sess-burst-f7';
    const now = 1758816000000;

    it('first click for an IP and session is clean with no prior history', async () => {
      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        affiliateId: 'u-1',
        sessionId: 'sess-brand-new',
        ipAddress: '198.51.100.121',
        timestamp: now,
      });

      expect(res.isSuspicious).toBe(false);
      expect(res.burstDetected).toBe(false);
      expect(res.burstDetails).toBeUndefined();
      expect(res.anomalyScore).toBe(0.0);
      expect(res.flagReasons).toEqual([]);
    });

    it('EXACT BOUNDARY: interval of 1,999ms is flagged as BURST_CLICK', async () => {
      mockFraudDB.dealClicks.set('click-1999', {
        id: 'click-1999',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u-1',
        session_id: testSession,
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
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        affiliateId: 'u-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.isSuspicious).toBe(true);
      expect(res.burstDetected).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
      expect(res.burstDetails?.deltaMs).toBe(1999);
      expect(res.anomalyScore).toBe(0.85);
    });

    it('EXACT BOUNDARY: interval of 2,000ms is clean (NOT flagged as BURST_CLICK)', async () => {
      mockFraudDB.dealClicks.set('click-2000', {
        id: 'click-2000',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u-1',
        session_id: testSession,
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
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        affiliateId: 'u-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.isSuspicious).toBe(false);
      expect(res.burstDetected).toBe(false);
      expect(res.flagReasons).not.toContain(FraudReasonCode.BURST_CLICK);
    });

    it('sub-second burst (e.g. 350ms) produces elevated burst score (0.90)', async () => {
      mockFraudDB.dealClicks.set('click-sub-sec', {
        id: 'click-sub-sec',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u-1',
        session_id: testSession,
        ip_address: testIp,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 350).toISOString(),
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        affiliateId: 'u-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.anomalyScore).toBe(0.90);
      expect(res.burstDetails?.deltaMs).toBe(350);
    });

    it('detects burst across rotated IPs using identical session_id (matchedBy = "session")', async () => {
      const ip1 = '198.51.100.150';
      const ip2 = '203.0.113.200';
      const sharedSession = 'sess-shared-rotated';

      mockFraudDB.dealClicks.set('click-ip1', {
        id: 'click-ip1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u-1',
        session_id: sharedSession,
        ip_address: ip1,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 600).toISOString(),
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        affiliateId: 'u-1',
        sessionId: sharedSession,
        ipAddress: ip2, // Different IP!
        timestamp: now,
      });

      expect(res.burstDetected).toBe(true);
      expect(res.burstDetails?.matchedBy).toBe('session');
      expect(res.burstDetails?.previousClickId).toBe('click-ip1');
    });

    it('ignores out-of-order clicks with deltaMs < 0', async () => {
      mockFraudDB.dealClicks.set('click-future', {
        id: 'click-future',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-1',
        affiliate_id: 'u-1',
        session_id: testSession,
        ip_address: testIp,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now + 5000).toISOString(), // Click recorded with future clock
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: 'deal-active-1',
        affiliateCode: 'aff-1',
        affiliateId: 'u-1',
        sessionId: testSession,
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.burstDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });
  });

  // ==========================================================================
  // 3. Feature F8: Click-to-Conversion Ratio Velocity
  // ==========================================================================
  describe('3. Feature F8: Click-to-Conversion Ratio Velocity', () => {
    const affCode = 'aff-ratio-test';
    const dealId = 'deal-active-1';

    it('statistical floor: 9 clicks and 0 conversions is NOT flagged (under 10 clicks floor)', async () => {
      for (let i = 0; i < 9; i++) {
        mockFraudDB.dealClicks.set(`c-floor-${i}`, {
          id: `c-floor-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          user_agent: 'browser',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(Date.now() - 50000).toISOString(),
        });
      }

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: affCode,
        affiliateId: 'u1',
        sessionId: 's-new',
        ipAddress: '198.51.100.99',
        timestamp: Date.now(),
      });

      expect(res.ratioAnomalyDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('statistical floor: 10 clicks and 0 conversions IS flagged (Infinity > 10.0)', async () => {
      for (let i = 0; i < 10; i++) {
        mockFraudDB.dealClicks.set(`c-floor10-${i}`, {
          id: `c-floor10-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          user_agent: 'browser',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(Date.now() - 50000).toISOString(),
        });
      }

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: affCode,
        affiliateId: 'u1',
        sessionId: 's-new',
        ipAddress: '198.51.100.99',
        timestamp: Date.now(),
      });

      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(res.anomalyScore).toBe(0.70);
      expect(res.ratioDetails?.totalClicks).toBe(10);
      expect(res.ratioDetails?.totalConversions).toBe(0);
      expect(res.ratioDetails?.clickToConvRatio).toBe(Infinity);
    });

    it('EXACT BOUNDARY: 10 clicks and 1 conversion (ratio = 10.0) is clean (NOT flagged)', async () => {
      for (let i = 0; i < 10; i++) {
        mockFraudDB.dealClicks.set(`c-b10-${i}`, {
          id: `c-b10-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          user_agent: 'browser',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(Date.now() - 50000).toISOString(),
        });
      }

      mockFraudDB.conversions.set('conv-b10', {
        id: 'conv-b10',
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u1',
        user_id: 'trader-1',
        amount: 100,
        status: 'confirmed',
        created_at: new Date(Date.now() - 40000).toISOString(),
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: affCode,
        affiliateId: 'u1',
        sessionId: 's-new',
        ipAddress: '198.51.100.99',
        timestamp: Date.now(),
      });

      expect(res.ratioAnomalyDetected).toBe(false);
      expect(res.isSuspicious).toBe(false);
    });

    it('EXACT BOUNDARY: 11 clicks and 1 conversion (ratio = 11.0 > 10.0) IS flagged', async () => {
      for (let i = 0; i < 11; i++) {
        mockFraudDB.dealClicks.set(`c-b11-${i}`, {
          id: `c-b11-${i}`,
          deal_id: dealId,
          affiliate_code: affCode,
          affiliate_id: 'u1',
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          user_agent: 'browser',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(Date.now() - 50000).toISOString(),
        });
      }

      mockFraudDB.conversions.set('conv-b11', {
        id: 'conv-b11',
        deal_id: dealId,
        affiliate_code: affCode,
        affiliate_id: 'u1',
        user_id: 'trader-1',
        amount: 100,
        status: 'confirmed',
        created_at: new Date(Date.now() - 40000).toISOString(),
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: affCode,
        affiliateId: 'u1',
        sessionId: 's-new',
        ipAddress: '198.51.100.99',
        timestamp: Date.now(),
      });

      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      expect(res.ratioDetails?.totalClicks).toBe(11);
      expect(res.ratioDetails?.totalConversions).toBe(1);
      expect(res.ratioDetails?.clickToConvRatio).toBe(11);
    });

    it('supports affiliate identification via fallback affiliateId when affiliateCode is null', async () => {
      const affId = 'aff-user-uuid-99';
      for (let i = 0; i < 12; i++) {
        mockFraudDB.dealClicks.set(`c-affid-${i}`, {
          id: `c-affid-${i}`,
          deal_id: dealId,
          affiliate_code: null,
          affiliate_id: affId,
          session_id: `s-${i}`,
          ip_address: `198.51.100.${i}`,
          user_agent: 'browser',
          referrer_url: null,
          country_code: 'US',
          device_type: 'desktop',
          click_type: 'link',
          is_unique: 1,
          created_at: new Date(Date.now() - 50000).toISOString(),
        });
      }

      // Mock database requires dealClicks where deal_id = dealId
      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId,
        affiliateCode: null,
        affiliateId: affId,
        sessionId: 's-new',
        ipAddress: '198.51.100.99',
        timestamp: Date.now(),
      });

      // 12 clicks and 0 conversions
      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.isSuspicious).toBe(true);
    });
  });

  // ==========================================================================
  // 4. Multi-Anomaly Score Stacking (Test C5 Compliance)
  // ==========================================================================
  describe('4. Multi-Anomaly Score Stacking', () => {
    it('stacks BURST_CLICK and HIGH_CLICK_CONVERSION_RATIO probabilistically reaching >= 0.85', async () => {
      const affCode = 'stack-aff-code';
      const testIp = '198.51.100.199';
      const now = 1758816000000;

      // Seed 15 clicks for high ratio
      for (let i = 0; i < 15; i++) {
        mockFraudDB.dealClicks.set(`c-mstack-${i}`, {
          id: `c-mstack-${i}`,
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

      // Prior click 400ms ago to trigger sub-second burst (0.90)
      mockFraudDB.dealClicks.set('c-mstack-burst', {
        id: 'c-mstack-burst',
        deal_id: 'deal-active-1',
        affiliate_code: affCode,
        affiliate_id: 'u-stack',
        session_id: 'sess-mstack',
        ip_address: testIp,
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        created_at: new Date(now - 400).toISOString(),
      });

      const res = await evaluateClickVelocity(mockFraudDB as any, {
        dealId: 'deal-active-1',
        affiliateCode: affCode,
        affiliateId: 'u-stack',
        sessionId: 'sess-mstack',
        ipAddress: testIp,
        timestamp: now,
      });

      expect(res.isSuspicious).toBe(true);
      expect(res.burstDetected).toBe(true);
      expect(res.ratioAnomalyDetected).toBe(true);
      expect(res.flagReasons).toContain(FraudReasonCode.BURST_CLICK);
      expect(res.flagReasons).toContain(FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO);
      // Probabilistic union: 1 - (1 - 0.90) * (1 - 0.70) = 1 - 0.03 = 0.97
      expect(res.anomalyScore).toBe(0.97);
      expect(res.anomalyScore).toBeGreaterThanOrEqual(0.85);
    });
  });

  // ==========================================================================
  // 5. Click Ingestion Route Persistence & Fraud Transparency
  // ==========================================================================
  describe('5. Ingestion Routes: Velocity Integration & Persistence', () => {
    const burstIp = '198.51.100.222';
    const testSession = 'sess-route-test';

    it('POST /api/deals/[id]/click persists clean click with is_suspicious = 0 and anomaly_score = 0.0', async () => {
      const req = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': '198.51.100.55',
          cookie: `apex_tracking_id=${testSession}`,
        },
        body: { userId: 'u-clean-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: 'deal-active-1' }
      );

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.redirectUrl).toBe('https://partner.exchange.com/register?ref=apex');

      // Verify database record
      const clicks = Array.from(mockFraudDB.dealClicks.values());
      const inserted = clicks.find((c) => c.session_id === testSession);
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(0);
      expect(inserted?.anomaly_score).toBe(0.0);
      expect(inserted?.flag_reasons).toBeNull();
    });

    it('POST /api/deals/[id]/click flags rapid burst click with is_suspicious = 1 while returning 200 (fraud-transparent)', async () => {
      // Seed prior click 300ms ago
      mockFraudDB.dealClicks.set('prior-route-burst', {
        id: 'prior-route-burst',
        deal_id: 'deal-active-1',
        affiliate_code: 'u-burst-1',
        affiliate_id: 'u-burst-1',
        session_id: 'sess-post-burst',
        ip_address: burstIp,
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        created_at: new Date(Date.now() - 300).toISOString(),
      });

      const req = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'POST',
        headers: {
          'cf-connecting-ip': burstIp,
          cookie: 'apex_tracking_id=sess-post-burst',
        },
        body: { userId: 'u-burst-1' },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'POST',
        req,
        { id: 'deal-active-1' }
      );

      // Fraud transparency: User is NOT blocked with 403; gets standard 200
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      // Database persistence: Click is flagged as suspicious!
      const clicks = Array.from(mockFraudDB.dealClicks.values());
      const inserted = clicks.find((c) => c.id !== 'prior-route-burst' && c.ip_address === burstIp);
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.anomaly_score).toBeGreaterThanOrEqual(0.85);
      expect(inserted?.flag_reasons).toContain('BURST_CLICK');
    });

    it('GET /api/deals/[id]/click flags burst click while returning standard 302 redirect', async () => {
      const getBurstIp = '198.51.100.223';
      const getSession = 'sess-get-burst';

      // Seed prior click 250ms ago
      mockFraudDB.dealClicks.set('prior-get-burst', {
        id: 'prior-get-burst',
        deal_id: 'deal-active-1',
        affiliate_code: null,
        affiliate_id: null,
        session_id: getSession,
        ip_address: getBurstIp,
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        created_at: new Date(Date.now() - 250).toISOString(),
      });

      const req = createFraudTestRequest('http://localhost:3000/api/deals/deal-active-1/click', {
        method: 'GET',
        headers: {
          'cf-connecting-ip': getBurstIp,
          cookie: `apex_tracking_id=${getSession}`,
        },
      });

      const res = await dispatchRoute(
        'src/app/api/deals/[id]/click/route.ts',
        'GET',
        req,
        { id: 'deal-active-1' }
      );

      // Redirect succeeded
      expect(res.status).toBe(302);

      // Click flagged in database
      const clicks = Array.from(mockFraudDB.dealClicks.values());
      const inserted = clicks.find((c) => c.id !== 'prior-get-burst' && c.ip_address === getBurstIp);
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.anomaly_score).toBeGreaterThanOrEqual(0.85);
      expect(inserted?.flag_reasons).toContain('BURST_CLICK');
    });

    it('GET /api/tracking/click flags burst click while returning standard 302 redirect', async () => {
      const trackBurstIp = '198.51.100.224';
      const trackSession = 'sess-track-burst';

      // Seed prior click 500ms ago
      mockFraudDB.dealClicks.set('prior-track-burst', {
        id: 'prior-track-burst',
        deal_id: 'deal-active-1',
        affiliate_code: 'ref-code-1',
        affiliate_id: null,
        session_id: trackSession,
        ip_address: trackBurstIp,
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        created_at: new Date(Date.now() - 500).toISOString(),
      });

      const req = createFraudTestRequest(
        'http://localhost:3000/api/tracking/click?deal_id=deal-active-1&ref=ref-code-1',
        {
          method: 'GET',
          headers: {
            'cf-connecting-ip': trackBurstIp,
            cookie: `apex_tracking_id=${trackSession}`,
          },
        }
      );

      const res = await dispatchRoute(
        'src/app/api/tracking/click/route.ts',
        'GET',
        req
      );

      expect(res.status).toBe(302);

      // Verify persistence
      const clicks = Array.from(mockFraudDB.dealClicks.values());
      const inserted = clicks.find((c) => c.id !== 'prior-track-burst' && c.ip_address === trackBurstIp);
      expect(inserted).toBeDefined();
      expect(inserted?.is_suspicious).toBe(1);
      expect(inserted?.anomaly_score).toBeGreaterThanOrEqual(0.85);
      expect(inserted?.flag_reasons).toContain('BURST_CLICK');
    });
  });

  // ==========================================================================
  // 6. Attribution Isolation in Matcher
  // ==========================================================================
  describe('6. Attribution Isolation Safeguards in Matcher', () => {
    it('Matcher never attributes clicks flagged with is_suspicious = 1', async () => {
      const matcher = new Matcher(mockFraudDB as any);

      // Insert suspicious click
      mockFraudDB.dealClicks.set('suspicious-click-attr', {
        id: 'suspicious-click-attr',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-suspicious',
        affiliate_id: 'usr-trader-1',
        session_id: 'sess-suspicious',
        ip_address: '198.51.100.99',
        user_agent: 'bot',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify(['BURST_CLICK']),
        anomaly_score: 0.90,
        created_at: new Date().toISOString(),
      });

      const matchResult = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });

      // Suspicious click must NOT be attributed
      expect(matchResult.click).toBeNull();
      expect(matchResult.totalCommission).toBe(0);
    });

    it('Matcher attributes legitimate clicks with is_suspicious = 0', async () => {
      const matcher = new Matcher(mockFraudDB as any);

      mockFraudDB.dealClicks.set('clean-click-attr', {
        id: 'clean-click-attr',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-clean',
        affiliate_id: 'usr-trader-1',
        session_id: 'sess-clean',
        ip_address: '198.51.100.98',
        user_agent: 'browser',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        flag_reasons: null,
        anomaly_score: 0.0,
        created_at: new Date().toISOString(),
      });

      const matchResult = await matcher.match({
        dealId: 'deal-active-1',
        userIdentifier: 'trader1@apex-os.com',
        tradeVolumeUsd: 1000,
      });

      expect(matchResult.click).toBeDefined();
      expect(matchResult.click?.id).toBe('clean-click-attr');
    });
  });
});
