/**
 * Empirical Challenger M4 Adversarial Test Suite
 * Target: Milestone M4 Analytics & End-to-End Scenarios
 *
 * Authored by: teamwork_preview_challenger_m4_2
 * Role: EMPIRICAL CHALLENGER
 *
 * Scope:
 * 1. Deep-Link Analytics Batch Processing & Scale Limits (50-event standard, 100-event stress, 0-event, empty arrays)
 * 2. Missing, Null, and Malformed Timestamps & Fallback Invariance
 * 3. Complex URL Queries, Deep-Link Schemes, Route Preservation & Unicode
 * 4. Malformed Non-JSON Payloads, Primitive Roots & Content-Type Resilience
 * 5. Anonymous Telemetry, Expired Sessions & Identity Decoupling
 * 6. Source Normalization & Metadata Stress (Circular Objects, Deep Nesting, SQL Injection strings)
 * 7. Database Resiliency & Column Fallback (event_timestamp vs timestamp)
 * 8. End-to-End Scenario Stress & High-Concurrency Interleaving
 */

import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  generateIpnSignature,
  configureMockNowPayments,
  resetMockNowPayments,
  DEFAULT_USER,
  SECOND_USER,
} from './billing-test-harness';

import * as analyticsRoute from '@/app/api/profile/deep-link-analytics/route';
import * as walletRoute from '@/app/api/profile/wallet/route';
import * as notificationsRoute from '@/app/api/notifications/register/route';

const IPN_SECRET = 'apexos-challenger-m4-ipn-secret-2026';

beforeAll(() => {
  setupBillingTestEnvironment();
  process.env.NOWPAYMENTS_API_KEY = 'test-nowpayments-api-key';
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

beforeEach(() => {
  mockBillingDB.reset();
  resetMockNowPayments();
  process.env.NOWPAYMENTS_API_KEY = 'test-nowpayments-api-key';
  process.env.NOWPAYMENTS_IPN_SECRET = IPN_SECRET;
});

/**
 * Direct call helper for deep-link analytics
 */
async function callAnalytics(req: any) {
  const res = await analyticsRoute.POST(req);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return {
    status: res.status,
    data,
    success: data?.success,
    processed: data?.processed,
    error: data?.error,
  };
}

describe('Challenger M4 Adversarial: Analytics & End-to-End Scenarios', () => {

  // =========================================================================
  // Section 1: Deep-Link Analytics Batch Processing & Scale Limits
  // =========================================================================
  describe('1. Batch Processing & Scale Limits', () => {
    it('ADV-BATCH-01: ingests exact maximum standard batch of 50 events without error', async () => {
      const events = Array.from({ length: 50 }, (_, i) => ({
        id: `adv-evt-50-${i}`,
        kind: `batch-event-${i}`,
        route: `apex-os://billing/plans?step=${i}&item=tier_${i % 4}`,
        timestamp: new Date(Date.now() - i * 1000).toISOString(),
        source: i % 2 === 0 ? 'notification' : 'direct',
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(50);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(50);
      expect(mockBillingDB.deepLinkAnalytics[0].kind).toBe('batch-event-0');
      expect(mockBillingDB.deepLinkAnalytics[49].kind).toBe('batch-event-49');
    });

    it('ADV-BATCH-02: stress tests oversized batch of 100 events in a single HTTP request', async () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: `adv-evt-100-${i}`,
        kind: `oversized-event-${i}`,
        route: `apex-os://analytics/oversized?idx=${i}`,
        timestamp: new Date().toISOString(),
        source: 'direct',
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(100);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(100);
    });

    it('ADV-BATCH-03: handles zero-length batch { events: [] } returning 200 with processed: 0', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events: [] },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(0);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(0);
    });

    it('ADV-BATCH-04: handles empty body object {} gracefully without crashing', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: {},
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(0);
    });

    it('ADV-BATCH-05: handles non-array events field gracefully ({ events: "not-an-array" })', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events: 'invalid_events_string' as any },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(0);
    });
  });

  // =========================================================================
  // Section 2: Missing, Null, and Malformed Timestamps
  // =========================================================================
  describe('2. Timestamp Variations & Fallbacks', () => {
    it('ADV-TIME-01: falls back to current ISO timestamp when timestamp property is omitted', async () => {
      const events = [
        {
          kind: 'omitted-time',
          route: 'apex-os://home',
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(1);

      const record = mockBillingDB.deepLinkAnalytics[0];
      expect(record.event_timestamp).toBeDefined();
      expect(Number.isNaN(Date.parse(record.event_timestamp))).toBe(false);
    });

    it('ADV-TIME-02: falls back to current ISO timestamp when timestamp is null or empty whitespace', async () => {
      const events = [
        {
          kind: 'null-time',
          route: 'apex-os://route1',
          timestamp: null as any,
          source: 'direct',
        },
        {
          kind: 'empty-time',
          route: 'apex-os://route2',
          timestamp: '',
          source: 'direct',
        },
        {
          kind: 'whitespace-time',
          route: 'apex-os://route3',
          timestamp: '   ',
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(3);

      for (const row of mockBillingDB.deepLinkAnalytics) {
        expect(row.event_timestamp).toBeDefined();
        expect(row.event_timestamp.length).toBeGreaterThan(10);
      }
    });

    it('ADV-TIME-03: accepts event_timestamp alias when timestamp is absent', async () => {
      const customIso = '2026-09-24T15:30:00.000Z';
      const events = [
        {
          kind: 'alias-time',
          route: 'apex-os://alias-test',
          event_timestamp: customIso,
          source: 'notification',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(1);

      const record = mockBillingDB.deepLinkAnalytics[0];
      expect(record.event_timestamp).toBe(customIso);
    });

    it('ADV-TIME-04: preserves non-standard or epoch-string timestamps without crashing', async () => {
      const epochStr = '1727200000000';
      const events = [
        {
          kind: 'epoch-time',
          route: 'apex-os://epoch',
          timestamp: epochStr,
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics[0].event_timestamp).toBe(epochStr);
    });
  });

  // =========================================================================
  // Section 3: Complex URL Queries, Deep-Link Schemes & Special Characters
  // =========================================================================
  describe('3. Complex Route URLs & Deep-Link Schemes', () => {
    it('ADV-URL-01: preserves complex nested query strings, encoded JSON, and special symbols', async () => {
      const complexRoutes = [
        'apex-os://billing/checkout?plan=ENTERPRISE&price=99&currency=USDT&discount=SAVE%2020%25',
        'apex-os://navigate?filter=%7B%22tier%22%3A%22MASTER%22%2C%22minPrice%22%3A100%7D',
        'apex-os://rewards/promo?tag=!%40%23%24%25%5E%26*()_%2B&redirect=%2Faccount',
        'apex-os://billing/faq#payment-verification-steps',
        'apex-os://deals/crypto?search=bitcoin%20cash&locale=en-US',
      ];

      const events = complexRoutes.map((r, i) => ({
        kind: `url-test-${i}`,
        route: r,
        timestamp: new Date().toISOString(),
        source: 'notification',
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(5);

      complexRoutes.forEach((route, idx) => {
        expect(mockBillingDB.deepLinkAnalytics[idx].route).toBe(route);
      });
    });

    it('ADV-URL-02: preserves Unicode and emojis in deep-link routes', async () => {
      const unicodeRoute = 'apex-os://rewards/🎉🚀🔥/level-up?badge=VIP-💎';
      const events = [
        {
          kind: 'unicode-route',
          route: unicodeRoute,
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics[0].route).toBe(unicodeRoute);
    });

    it('ADV-URL-03: falls back to "/" when route is empty string or omitted', async () => {
      const events = [
        {
          kind: 'empty-route',
          route: '',
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
        {
          kind: 'omitted-route',
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics[0].route).toBe('/');
      expect(mockBillingDB.deepLinkAnalytics[1].route).toBe('/');
    });

    it('ADV-URL-04: preserves very long URL routes (2000+ characters)', async () => {
      const longQuery = 'param=' + 'a'.repeat(2048);
      const longRoute = `apex-os://analytics/deep?${longQuery}`;

      const events = [
        {
          kind: 'long-route',
          route: longRoute,
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics[0].route).toBe(longRoute);
    });
  });

  // =========================================================================
  // Section 4: Malformed Non-JSON & Corrupted Payloads
  // =========================================================================
  describe('4. Malformed Non-JSON Payloads & Content-Type Resilience', () => {
    it('ADV-JSON-01: returns HTTP 400 when body is broken JSON string', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: '{"events": [{"kind": "broken", "route": "apex-os://test"', // unclosed JSON
        headers: { 'content-type': 'application/json' },
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(400);
      expect(res.success).toBe(false);
      expect(res.error).toMatch(/invalid JSON/i);
    });

    it('ADV-JSON-02: returns HTTP 400 on raw primitive numbers or boolean bodies', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: '12345',
        headers: { 'content-type': 'application/json' },
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(400);
      expect(res.success).toBe(false);
    });

    it('ADV-JSON-03: returns HTTP 400 on empty string raw body', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: '',
        headers: { 'content-type': 'application/json' },
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(400);
      expect(res.success).toBe(false);
    });

    it('ADV-JSON-04: handles array root [{ kind: "event" }] safely returning 200 with processed: 0', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: [{ kind: 'direct-array-item', route: 'apex-os://home' }],
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(0);
    });
  });

  // =========================================================================
  // Section 5: Anonymous Telemetry & Auth Header Mutations
  // =========================================================================
  describe('5. Anonymous Telemetry & Auth Boundary', () => {
    it('ADV-AUTH-01: accepts events from completely anonymous client without auth header or cookie', async () => {
      const events = [
        {
          kind: 'anonymous-launch',
          route: 'apex-os://welcome',
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        authMethod: 'none',
        user: null,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(1);

      const record = mockBillingDB.deepLinkAnalytics[0];
      expect(record.user_id).toBeNull();
      expect(record.kind).toBe('anonymous-launch');
    });

    it('ADV-AUTH-02: accepts events gracefully with expired or corrupt Bearer token (no 401)', async () => {
      const events = [
        {
          kind: 'expired-token-event',
          route: 'apex-os://billing/plans',
          timestamp: new Date().toISOString(),
          source: 'notification',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: null,
        authMethod: 'none',
        headers: {
          authorization: 'Bearer invalid',
        },
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);

      const record = mockBillingDB.deepLinkAnalytics[0];
      // When token is invalid, user_id falls back to null rather than failing
      expect(record.user_id).toBeNull();
      expect(record.kind).toBe('expired-token-event');
    });

    it('ADV-AUTH-03: accepts events gracefully with malformed Cookie header', async () => {
      const events = [
        {
          kind: 'malformed-cookie-event',
          route: 'apex-os://deals',
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: null,
        authMethod: 'none',
        headers: {
          cookie: 'garbage_cookie_data=%%%$$$; invalid-syntax',
        },
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);

      const record = mockBillingDB.deepLinkAnalytics[0];
      expect(record.user_id).toBeNull();
    });

    it('ADV-AUTH-04: binds user_id correctly when authenticated session is valid', async () => {
      const events = [
        {
          kind: 'auth-event',
          route: 'apex-os://profile',
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);

      const record = mockBillingDB.deepLinkAnalytics[0];
      expect(record.user_id).toBe(DEFAULT_USER.id);
    });
  });

  // =========================================================================
  // Section 6: Source & Metadata Sanitization
  // =========================================================================
  describe('6. Source Normalization & Metadata Sanitization', () => {
    it('ADV-SRC-01: normalizes source case and defaults unrecognized sources to "direct"', async () => {
      const events = [
        { kind: 'src-1', route: 'apex-os://1', source: 'NOTIFICATION' },
        { kind: 'src-2', route: 'apex-os://2', source: 'Direct' },
        { kind: 'src-3', route: 'apex-os://3', source: 'notification' },
        { kind: 'src-4', route: 'apex-os://4', source: 'email_campaign' },
        { kind: 'src-5', route: 'apex-os://5', source: 'unknown_vendor' },
        { kind: 'src-6', route: 'apex-os://6', source: '' },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(6);

      const rows = mockBillingDB.deepLinkAnalytics;
      expect(rows[0].source).toBe('notification');
      expect(rows[1].source).toBe('direct');
      expect(rows[2].source).toBe('notification');
      expect(rows[3].source).toBe('direct');
      expect(rows[4].source).toBe('direct');
      expect(rows[5].source).toBe('direct');
    });

    it('ADV-META-01: handles complex metadata objects and stringified JSON', async () => {
      const metaObj = {
        campaignId: 'spring_2026',
        deepLinkReferrer: 'twitter',
        nested: { tags: ['crypto', 'billing'], count: 42 },
      };

      const events = [
        {
          kind: 'meta-test',
          route: 'apex-os://campaign',
          source: 'direct',
          metadata: metaObj,
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(1);
    });

    it('ADV-META-02: survives circular object in metadata without crashing process', async () => {
      const circularObj: any = { tag: 'circular' };
      circularObj.self = circularObj;

      // When serialized to JSON in body, circular would throw in JSON.stringify if not handled.
      // Let's pass circular directly to callRoute or route handler
      const rawEvents = [
        {
          kind: 'circular-meta',
          route: 'apex-os://test',
          source: 'direct',
          metadata: circularObj,
        },
      ];

      // Simulate a request where body is pre-parsed or mock request object
      const req = {
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ events: rawEvents }),
      } as any;

      const res = await analyticsRoute.POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
    });

    it('ADV-META-03: safely handles SQL injection payloads in route and metadata', async () => {
      const sqlInjectionString = "'; DROP TABLE deep_link_analytics; SELECT * FROM users WHERE '1'='1";
      const events = [
        {
          kind: 'sql-test',
          route: `apex-os://query?search=${sqlInjectionString}`,
          source: 'direct',
          metadata: { injection: sqlInjectionString },
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(1);

      // Verify deepLinkAnalytics table is intact and has 1 entry
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(1);
      expect(mockBillingDB.deepLinkAnalytics[0].route).toContain("DROP TABLE");
    });
  });

  // =========================================================================
  // Section 7: End-to-End Scenario Stress & Cross-Feature Interleaving
  // =========================================================================
  describe('7. End-to-End Scenario Stress & High-Concurrency Interleaving', () => {
    it('ADV-E2E-01: Scenario 1 stress - Payment journey with interleaved anonymous and authenticated deep links', async () => {
      // 1. Anonymous user opens app via deep link
      const anonReq = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: {
          events: [
            {
              kind: 'app-launch',
              route: 'apex-os://home',
              timestamp: new Date().toISOString(),
              source: 'direct',
            },
            {
              kind: 'plans-view',
              route: 'apex-os://billing/plans',
              timestamp: new Date().toISOString(),
              source: 'direct',
            },
          ],
        },
        authMethod: 'none',
        user: null,
      });
      const anonRes = await callAnalytics(anonReq);
      expect(anonRes.status).toBe(200);
      expect(anonRes.processed).toBe(2);

      // 2. User logs in and binds Ethereum wallet
      const walletReq = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: {
          wallet_address: '0x742d35Cc6634C0532925a3b844Bc954e7595f0bE',
          preferred_chain: 'ethereum',
        },
        user: DEFAULT_USER,
      });
      const walletRes = await dispatchRoute('src/app/api/profile/wallet/route.ts', 'POST', walletReq);
      expect(walletRes.status).toBe(200);

      // 3. User registers push notification token
      const pushReq = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: {
          expoToken: 'ExponentPushToken[adv-journey-token]',
          platform: 'ios',
          apnsToken: '740f4707bebcf74f9b7c25d48e3358945f6aa01da5ddb387462c7eaf61bb78ad',
        },
        user: DEFAULT_USER,
      });
      const pushRes = await dispatchRoute('src/app/api/notifications/register/route.ts', 'POST', pushReq);
      expect(pushRes.status).toBe(200);

      // 4. User initiates checkout for ENTERPRISE
      configureMockNowPayments({
        status: 200,
        response: {
          id: 7701,
          payment_id: '7701',
          payment_url: 'https://nowpayments.io/payment/?iid=7701',
          order_id: 'apex-order-7701',
        },
      });

      const payReq = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'ENTERPRISE' },
        user: DEFAULT_USER,
      });
      const payRes = await dispatchRoute('src/app/api/payments/route.ts', 'POST', payReq);
      expect(payRes.status).toBe(200);

      mockBillingDB.payments.set('7701', {
        id: 'pay-7701',
        payment_id: '7701',
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      // 5. NOWPayments IPN delivers confirmed webhook
      const ipnPayload = {
        payment_id: '7701',
        payment_status: 'confirmed',
        pay_amount: 99,
        pay_currency: 'usdt',
        price_amount: 99,
        price_currency: 'usd',
        plan: 'ENTERPRISE',
      };
      const sig = generateIpnSignature(ipnPayload, IPN_SECRET);
      const ipnReq = createTestRequest('/api/webhooks/ipn', {
        method: 'POST',
        body: ipnPayload,
        headers: { 'x-nowpayments-sig': sig },
      });
      const ipnRes = await dispatchRoute('src/app/api/webhooks/ipn/route.ts', 'POST', ipnReq);
      expect([200, 401]).toContain(ipnRes.status);

      // 6. User receives push notification and taps to view receipt deep-link
      const receiptEvents = [
        {
          kind: 'receipt-tap',
          route: 'apex-os://billing/receipt/7701?from=push_banner',
          timestamp: new Date().toISOString(),
          source: 'notification',
        },
      ];
      const receiptReq = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events: receiptEvents },
        user: DEFAULT_USER,
      });
      const receiptRes = await callAnalytics(receiptReq);
      expect(receiptRes.status).toBe(200);
      expect(receiptRes.processed).toBe(1);

      // Total analytics events: 2 (anon) + 1 (receipt) = 3
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(3);
      expect(mockBillingDB.deepLinkAnalytics[0].user_id).toBeNull();
      expect(mockBillingDB.deepLinkAnalytics[2].user_id).toBe(DEFAULT_USER.id);
    });

    it('ADV-E2E-02: Scenario 4 stress - Multi-chain wallet binding lifecycle with interleaved telemetry', async () => {
      // Step A: Anonymous click to wallet section
      const clickReq = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: {
          events: [{ kind: 'screen-view', route: 'apex-os://settings/wallet', source: 'direct' }],
        },
        authMethod: 'none',
        user: null,
      });
      await callAnalytics(clickReq);

      // Step B: Bind Solana wallet
      const solanaAddress = 'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH';
      const solReq = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: solanaAddress, preferred_chain: 'solana' },
        user: DEFAULT_USER,
      });
      const solRes = await dispatchRoute('src/app/api/profile/wallet/route.ts', 'POST', solReq);
      expect(solRes.status).toBe(200);

      // Step C: Try invalid Stellar address (must fail with 400)
      const badStellarReq = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: {
          wallet_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa',
          preferred_chain: 'stellar',
        },
        user: DEFAULT_USER,
      });
      const badStellarRes = await dispatchRoute('src/app/api/profile/wallet/route.ts', 'POST', badStellarReq);
      expect(badStellarRes.status).toBe(400);

      // Step D: Connect valid Stellar address
      const goodStellar = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
      const goodStellarReq = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: goodStellar, preferred_chain: 'stellar' },
        user: DEFAULT_USER,
      });
      const goodStellarRes = await dispatchRoute('src/app/api/profile/wallet/route.ts', 'POST', goodStellarReq);
      expect(goodStellarRes.status).toBe(200);

      // Step E: Disconnect wallet
      const disconnectReq = createTestRequest('/api/profile/wallet', {
        method: 'DELETE',
        user: DEFAULT_USER,
      });
      const disconnectRes = await dispatchRoute('src/app/api/profile/wallet/route.ts', 'DELETE', disconnectReq);
      expect(disconnectRes.status).toBe(200);

      // Step F: Query wallet inspect (should be null or disconnected)
      const inspectReq = createTestRequest('/api/profile/wallet', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const inspectRes = await dispatchRoute('src/app/api/profile/wallet/route.ts', 'GET', inspectReq);
      expect(inspectRes.status).toBe(200);
      expect(inspectRes.data.data.wallet_address).toBeFalsy();
    });

    it('ADV-E2E-03: Concurrency stress - 10 simultaneous parallel batch analytics submissions', async () => {
      const parallelRequests = Array.from({ length: 10 }, (_, batchIdx) => {
        const events = Array.from({ length: 5 }, (_, itemIdx) => ({
          kind: `parallel-batch-${batchIdx}`,
          route: `apex-os://parallel/${batchIdx}/${itemIdx}`,
          timestamp: new Date().toISOString(),
          source: itemIdx % 2 === 0 ? 'notification' : 'direct',
        }));

        const req = createTestRequest('/api/profile/deep-link-analytics', {
          method: 'POST',
          body: { events },
          user: batchIdx % 2 === 0 ? DEFAULT_USER : SECOND_USER,
        });

        return callAnalytics(req);
      });

      const results = await Promise.all(parallelRequests);

      // All 10 requests must succeed with HTTP 200
      results.forEach((r) => {
        expect(r.status).toBe(200);
        expect(r.success).toBe(true);
        expect(r.processed).toBe(5);
      });

      // Total events stored: 10 batches * 5 events = 50 events
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(50);
    });

    it('ADV-E2E-04: Scenario 5 stress - Complete user telemetry journey spanning multiple screens and payments', async () => {
      // Step 1: User navigates through multiple screens
      const userJourneyEvents = [
        { kind: 'screen-view', route: 'apex-os://home', timestamp: '2026-09-24T18:00:00Z', source: 'direct' },
        { kind: 'feature-click', route: 'apex-os://deals', timestamp: '2026-09-24T18:01:00Z', source: 'direct' },
        { kind: 'settings-view', route: 'apex-os://settings', timestamp: '2026-09-24T18:02:00Z', source: 'direct' },
        { kind: 'billing-view', route: 'apex-os://billing/plans', timestamp: '2026-09-24T18:03:00Z', source: 'direct' },
        { kind: 'checkout-click', route: 'apex-os://billing/checkout?plan=PREMIUM', timestamp: '2026-09-24T18:04:00Z', source: 'direct' },
        { kind: 'receipt-view', route: 'apex-os://billing/receipt/9999', timestamp: '2026-09-24T18:05:00Z', source: 'notification' },
      ];

      const journeyReq = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events: userJourneyEvents },
        user: DEFAULT_USER,
      });

      const journeyRes = await callAnalytics(journeyReq);
      expect(journeyRes.status).toBe(200);
      expect(journeyRes.processed).toBe(6);

      // Verify all 6 events have user_id attached
      const recorded = mockBillingDB.deepLinkAnalytics;
      expect(recorded.length).toBe(6);
      recorded.forEach((evt) => {
        expect(evt.user_id).toBe(DEFAULT_USER.id);
      });
    });
  });

  // =========================================================================
  // Section 8: Database Fault Injection & Column Fallback
  // =========================================================================
  describe('8. Database Resiliency & Fault Handling', () => {
    it('ADV-DB-01: gracefully retries with timestamp column when event_timestamp column fails', async () => {
      const origBatch = mockBillingDB.batch.bind(mockBillingDB);
      let batchCalls = 0;

      // Mock batch to fail first call with column error and succeed on second
      mockBillingDB.batch = jest.fn(async (stmts: any[]) => {
        batchCalls++;
        if (batchCalls === 1) {
          throw new Error('no such column: event_timestamp');
        }
        return origBatch(stmts);
      });

      try {
        const events = [
          {
            kind: 'fallback-column-test',
            route: 'apex-os://test-fallback',
            timestamp: new Date().toISOString(),
            source: 'direct',
          },
        ];

        const req = createTestRequest('/api/profile/deep-link-analytics', {
          method: 'POST',
          body: { events },
          user: DEFAULT_USER,
        });

        const res = await callAnalytics(req);
        expect(res.status).toBe(200);
        expect(res.success).toBe(true);
        expect(res.processed).toBe(1);
        expect(batchCalls).toBe(2);
      } finally {
        mockBillingDB.batch = origBatch;
      }
    });

    it('ADV-DB-02: returns HTTP 500 when database throws unrecoverable fatal error', async () => {
      const origBatch = mockBillingDB.batch.bind(mockBillingDB);

      mockBillingDB.batch = jest.fn(async () => {
        throw new Error('SQLITE_IOERR: disk I/O error');
      });

      try {
        const events = [
          {
            kind: 'fatal-db-test',
            route: 'apex-os://fatal',
            timestamp: new Date().toISOString(),
            source: 'direct',
          },
        ];

        const req = createTestRequest('/api/profile/deep-link-analytics', {
          method: 'POST',
          body: { events },
          user: DEFAULT_USER,
        });

        const res = await callAnalytics(req);
        expect(res.status).toBe(500);
        expect(res.success).toBe(false);
        expect(res.error).toContain('disk I/O error');
      } finally {
        mockBillingDB.batch = origBatch;
      }
    });

    it('ADV-DB-03: returns HTTP 500 cleanly on null event item without crashing process', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events: [null as any] },
        user: DEFAULT_USER,
      });

      const res = await callAnalytics(req);
      // Route catches TypeError in outer catch block and returns 500 without crashing process
      expect(res.status).toBe(500);
      expect(res.success).toBe(false);
    });
  });
});
