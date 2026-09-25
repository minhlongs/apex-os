/**
 * Adversarial Challenge Test Suite for Milestone M2: Payment Initiation & History (R1)
 * Target Files:
 * - src/app/api/payments/route.ts (POST /api/payments)
 * - src/app/api/payments/history/route.ts (GET /api/payments/history)
 *
 * Authored by: teamwork_preview_challenger_m2_1
 * Role: EMPIRICAL CHALLENGER
 *
 * Scope:
 * 1. Unauthorized access (empty header, fake token, expired session, Bearer without token)
 * 2. Invalid / malformed request bodies (null, string, empty object, array, invalid plan enum, case variations, plan injection)
 * 3. Upstream NOWPayments simulated failures (HTTP 500, network timeout, corrupt JSON)
 * 4. Database write integrity (user_id, amount, plan, status = 'pending', DB error handling)
 * 5. Payment history access control & authorization integrity
 */

import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  DEFAULT_USER,
  SECOND_USER,
  configureMockNowPayments,
  resetMockNowPayments,
  recordedUpstreamRequests,
} from './billing-test-harness';
import { NextRequest } from 'next/server';

describe('Adversarial Challenge: Milestone M2 Payment Initiation & History', () => {
  beforeAll(() => {
    setupBillingTestEnvironment();
    process.env.NOWPAYMENTS_API_KEY = 'test-api-key-challenge';
  });

  beforeEach(() => {
    mockBillingDB.reset();
    resetMockNowPayments();
    recordedUpstreamRequests.length = 0;
    process.env.NOWPAYMENTS_API_KEY = 'test-api-key-challenge';
  });

  // =========================================================================
  // 1. Unauthorized Access Tests
  // =========================================================================
  describe('1. Unauthorized Access (POST /api/payments)', () => {
    it('CHALLENGE-AUTH-01: rejects completely missing auth headers (empty header)', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        authMethod: 'none',
        user: null,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/unauthorized/i);
    });

    it('CHALLENGE-AUTH-02: rejects Bearer header without any token (whitespace only)', async () => {
      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer ',
        },
        body: JSON.stringify({ plan: 'BASIC' }),
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-AUTH-03: rejects Bearer header with only the keyword "Bearer"', async () => {
      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer',
        },
        body: JSON.stringify({ plan: 'BASIC' }),
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-AUTH-04: rejects fake/invalid token not in session database (Bearer invalid)', async () => {
      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer invalid',
        },
        body: JSON.stringify({ plan: 'BASIC' }),
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-AUTH-05: rejects non-Bearer authorization scheme (Basic auth)', async () => {
      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Basic dXNlcjpwYXNzd29yZA==',
        },
        body: JSON.stringify({ plan: 'BASIC' }),
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    /**
     * EMPIRICAL CHALLENGE FINDING 1:
     * In src/app/api/payments/route.ts (lines 85-96), Strategy 3 uses regex to extract
     * any token matching `token-(.+)` without verifying it against Cloudflare D1 sessions.
     * When a forged token like `Bearer token-invalid` (which returns null in D1) is sent,
     * the route accepts it and returns HTTP 200 instead of HTTP 401!
     */
    it('CHALLENGE-AUTH-06 [BUG-REPRODUCED]: rejects forged token with token- prefix not in D1 (Bearer token-invalid)', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 'pay-backdoor-test',
          payment_id: 'pay-backdoor-test',
          payment_url: 'https://nowpayments.io/test',
        },
      });

      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: 'Bearer token-invalid',
        },
        body: JSON.stringify({ plan: 'BASIC' }),
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      // Empirical verification: If bug exists, res.status is 200 (auth bypassed).
      // A secure route MUST return 401.
      expect({
        status: res.status,
        bypassed: res.status === 200,
      }).toEqual({
        status: 401,
        bypassed: false,
      });
    });

    /**
     * EMPIRICAL CHALLENGE FINDING 2:
     * History endpoint also contains identical bypass in resolveAuthUser (lines 105-116).
     * An attacker can supply `Authorization: Bearer token-<victim_id>` and dump victim's payment history.
     */
    it('CHALLENGE-AUTH-07 [BUG-REPRODUCED]: history endpoint rejects forged token without D1 session verification', async () => {
      // Seed payment for victim user (usr-buyer-002)
      mockBillingDB.payments.set('victim-pay-01', {
        id: 'row-vic-1',
        payment_id: 'victim-pay-01',
        status: 'confirmed',
        plan: 'MASTER',
        user_id: SECOND_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: 'tx-vic-01',
        confirmed_at: '2026-09-01T00:00:00Z',
        created_at: '2026-09-01T00:00:00Z',
        updated_at: '2026-09-01T00:00:00Z',
      });

      // Attacker attempts to forge token-usr-buyer-002 directly
      const req = new NextRequest('https://apex-os.com/api/payments/history', {
        method: 'GET',
        headers: {
          authorization: 'Bearer token-invalid',
        },
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect({
        status: res.status,
        bypassed: res.status === 200,
      }).toEqual({
        status: 401,
        bypassed: false,
      });
    });
  });

  // =========================================================================
  // 2. Invalid / Malformed Request Bodies
  // =========================================================================
  describe('2. Invalid / Malformed Request Bodies', () => {
    it('CHALLENGE-BODY-01: rejects null body', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: 'null',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-BODY-02: rejects primitive string body', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: '"PREMIUM"',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-BODY-03: rejects empty object body {}', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: {},
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-BODY-04: rejects array body [{ plan: "BASIC" }]', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: [{ plan: 'BASIC' }],
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('CHALLENGE-BODY-05: rejects invalid plan enum (GOLD, FREE, ULTIMATE)', async () => {
      for (const invalidPlan of ['GOLD', 'FREE', 'ULTIMATE', 'VIP', 'PRO']) {
        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: invalidPlan },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      }
    });

    it('CHALLENGE-BODY-06: rejects case variations (basic, Basic, Premium, ENTERPRISE )', async () => {
      const variations = ['basic', 'Basic', 'Premium', 'pReMiUm', 'ENTERPRISE ', ' BASIC'];
      for (const planVar of variations) {
        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: planVar },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      }
    });

    it('CHALLENGE-BODY-07: rejects plan injection attempts (SQLi / path traversal / prototype pollution)', async () => {
      const maliciousPlans = [
        "BASIC'; DROP TABLE payments;--",
        'BASIC/../../etc/passwd',
        '__proto__',
        'constructor',
        'toString',
        '<script>alert(1)</script>',
      ];

      for (const badPlan of maliciousPlans) {
        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: badPlan },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      }
    });

    it('CHALLENGE-BODY-08: rejects non-string plan types (numbers, booleans, objects)', async () => {
      const nonStringPlans = [123, true, false, { name: 'BASIC' }, ['BASIC']];
      for (const badPlan of nonStringPlans) {
        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: badPlan },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      }
    });

    it('CHALLENGE-BODY-09: rejects malformed unparseable JSON string', async () => {
      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer token-${DEFAULT_USER.id}`,
        },
        body: '{ malformed json: not valid',
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/json/i);
    });
  });

  // =========================================================================
  // 3. Upstream NOWPayments Simulated Failures
  // =========================================================================
  describe('3. Upstream NOWPayments Simulated Failures', () => {
    it('CHALLENGE-UPSTREAM-01: handles NOWPayments HTTP 500 error gracefully returning 502', async () => {
      configureMockNowPayments({
        status: 500,
        response: { message: 'Internal Server Error in Payment Engine' },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(502);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/internal server error/i);
      // Ensure no dangling payment recorded in DB on upstream failure
      expect(mockBillingDB.payments.size).toBe(0);
    });

    it('CHALLENGE-UPSTREAM-02: handles NOWPayments network timeout / connection abort', async () => {
      configureMockNowPayments({
        shouldThrow: true,
        throwError: new Error('ETIMEDOUT: Connection timed out after 10000ms'),
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(502);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/unreachable|failed/i);
      expect(mockBillingDB.payments.size).toBe(0);
    });

    it('CHALLENGE-UPSTREAM-03: handles NOWPayments returning HTTP 503 Service Unavailable', async () => {
      configureMockNowPayments({
        status: 503,
        response: { message: 'NOWPayments maintenance in progress' },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'MASTER' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(502);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/maintenance/i);
      expect(mockBillingDB.payments.size).toBe(0);
    });

    /**
     * EMPIRICAL CHALLENGE FINDING 3:
     * When NOWPayments returns HTTP 200 with an empty JSON object or non-JSON/corrupt payload,
     * `data.payment_id` is undefined. `String(data.payment_id ?? data.id)` produces literal "undefined".
     * The route returns HTTP 200 with paymentId="undefined" and checkoutUrl=undefined,
     * and persists a corrupt record into D1 with payment_id="undefined".
     */
    it('CHALLENGE-UPSTREAM-04 [BUG-REPRODUCED]: handles corrupt/empty JSON response from NOWPayments without creating "undefined" payment', async () => {
      configureMockNowPayments({
        status: 200,
        response: {}, // Missing payment_id and checkout url
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);

      // Empirical verification: A corrupted response should NOT be treated as a successful checkout.
      // Must reject with 502 or, if 200, must have valid non-undefined paymentId and checkoutUrl.
      expect({
        status: res.status,
        paymentId: res.data?.paymentId,
        checkoutUrl: res.data?.checkoutUrl,
      }).not.toEqual({
        status: 200,
        paymentId: 'undefined',
        checkoutUrl: undefined,
      });
    });
  });

  // =========================================================================
  // 4. Database Write Integrity Verification
  // =========================================================================
  describe('4. Database Write Integrity Verification', () => {
    it('CHALLENGE-DB-01: verifies exact DB fields for all 4 plans (BASIC, PREMIUM, ENTERPRISE, MASTER)', async () => {
      const planSpecs = [
        { plan: 'BASIC', expectedAmount: 9, payId: 'np-basic-001' },
        { plan: 'PREMIUM', expectedAmount: 29, payId: 'np-prem-002' },
        { plan: 'ENTERPRISE', expectedAmount: 99, payId: 'np-ent-003' },
        { plan: 'MASTER', expectedAmount: 299, payId: 'np-mast-004' },
      ];

      for (const spec of planSpecs) {
        configureMockNowPayments({
          status: 200,
          response: {
            id: spec.payId,
            payment_id: spec.payId,
            payment_url: `https://nowpayments.io/payment/?iid=${spec.payId}`,
            order_id: `apex-order-${spec.payId}`,
            valid_until: '2026-10-01T00:00:00Z',
          },
        });

        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: spec.plan },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);

        const saved = mockBillingDB.payments.get(spec.payId);
        expect(saved).toBeDefined();
        // Exact user_id
        expect(saved?.user_id).toBe(DEFAULT_USER.id);
        // Exact amount
        expect(saved?.amount).toBe(spec.expectedAmount);
        // Exact plan
        expect(saved?.plan).toBe(spec.plan);
        // Exact status
        expect(saved?.status).toBe('pending');
        // Currency USDT
        expect(saved?.currency).toBe('USDT');
        // Payment ID matches
        expect(saved?.payment_id).toBe(spec.payId);
        // Internal UUID exists and is distinct from payment_id
        expect(saved?.id).toBeDefined();
        expect(saved?.id).not.toBe(spec.payId);
        // confirmed_at is null for pending
        expect(saved?.confirmed_at).toBeNull();
      }
    });

    it('CHALLENGE-DB-02: client price/status tampering is prevented (extra fields ignored)', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 'np-tamper-01',
          payment_id: 'np-tamper-01',
          payment_url: 'https://nowpayments.io/payment/?iid=np-tamper-01',
        },
      });

      // Attempt client tampering: trying to buy MASTER ($299) for $1 or inject confirmed status
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: {
          plan: 'MASTER',
          amount: 1,
          price: 0,
          status: 'confirmed',
          currency: 'BTC',
          user_id: 'attacker-id',
        },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(200);

      const saved = mockBillingDB.payments.get('np-tamper-01');
      expect(saved).toBeDefined();
      // Must ignore client amount tampering
      expect(saved?.amount).toBe(299);
      // Must ignore client status tampering
      expect(saved?.status).toBe('pending');
      // Must bind to authenticated user, not client injected user_id
      expect(saved?.user_id).toBe(DEFAULT_USER.id);
      // Currency must remain USDT
      expect(saved?.currency).toBe('USDT');
    });

    it('CHALLENGE-DB-03: multiple payment checkouts for same user create distinct records', async () => {
      const payIds = ['multi-pay-001', 'multi-pay-002', 'multi-pay-003'];

      for (const pid of payIds) {
        configureMockNowPayments({
          status: 200,
          response: {
            id: pid,
            payment_id: pid,
            payment_url: `https://nowpayments.io/payment/?iid=${pid}`,
          },
        });

        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: 'BASIC' },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(200);
      }

      // Verify all 3 records exist with unique internal IDs
      const userPayments = Array.from(mockBillingDB.payments.values()).filter(
        (p) => p.user_id === DEFAULT_USER.id
      );
      expect(userPayments.length).toBe(3);
      const internalIds = new Set(userPayments.map((p) => p.id));
      expect(internalIds.size).toBe(3);
    });

    /**
     * EMPIRICAL CHALLENGE FINDING 4:
     * In src/app/api/payments/route.ts lines 194-208, the database insertion is wrapped
     * in a try/catch block that merely logs the error and continues.
     * When D1 persistence fails, the route still returns HTTP 200 with checkoutUrl,
     * leaving the payment untracked. Future webhook callbacks will fail to find the payment.
     */
    it('CHALLENGE-DB-04 [BUG-REPRODUCED]: database write failure should not silently return HTTP 200', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 'pay-db-fail-test',
          payment_id: 'pay-db-fail-test',
          payment_url: 'https://nowpayments.io/payment/?iid=pay-db-fail-test',
        },
      });

      // Temporarily mock db.prepare to throw
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      mockBillingDB.prepare = (sql: string) => {
        if (sql.includes('INSERT INTO payments')) {
          throw new Error('D1 database connection lost or disk full');
        }
        return originalPrepare(sql);
      };

      try {
        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: 'PREMIUM' },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);

        // If the route swallowed the DB error, res.status is 200 even though DB has 0 records!
        // An unpersisted checkout is a critical billing defect.
        expect({
          status: res.status,
          persisted: mockBillingDB.payments.has('pay-db-fail-test'),
        }).not.toEqual({
          status: 200,
          persisted: false,
        });
      } finally {
        mockBillingDB.prepare = originalPrepare;
      }
    });
  });
});
