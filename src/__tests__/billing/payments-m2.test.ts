/**
 * Dedicated Unit & Contract Tests for Milestone M2: Payment Initiation & History
 * Target File: src/__tests__/billing/payments-m2.test.ts
 *
 * Covers:
 * - Feature F1: Payment Initiation (POST /api/payments)
 * - Feature F2: Payment History (GET /api/payments/history)
 * - End-to-End M2 Flow: Payment Creation -> Database Insertion -> History Query
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

describe('Milestone M2: Payment Initiation & History Unit Tests', () => {
  beforeAll(() => {
    setupBillingTestEnvironment();
    process.env.NOWPAYMENTS_API_KEY = 'test-nowpayments-api-key-m2';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret-m2';
  });

  beforeEach(() => {
    mockBillingDB.reset();
    resetMockNowPayments();
    recordedUpstreamRequests.length = 0;
    process.env.NOWPAYMENTS_API_KEY = 'test-nowpayments-api-key-m2';
    process.env.NOWPAYMENTS_IPN_SECRET = 'test-ipn-secret-m2';
  });

  // ==========================================================================
  // 1. F1: Payment Initiation (POST /api/payments)
  // ==========================================================================
  describe('F1: Payment Initiation (POST /api/payments)', () => {
    it('M2-F1-01: creates checkout for BASIC plan ($9) and persists pending record in D1', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000001,
          payment_id: '6000000001',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000001',
          order_id: `apex-${DEFAULT_USER.id.slice(0, 8)}-basic-1727200001`,
          valid_until: '2026-09-25T12:00:00Z',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.implemented).toBe(true);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.checkoutUrl).toBe('https://nowpayments.io/payment/?iid=6000000001');
      expect(res.data.paymentId).toBe('6000000001');

      // Verify database record insertion
      const saved = mockBillingDB.payments.get('6000000001');
      expect(saved).toBeDefined();
      expect(saved?.payment_id).toBe('6000000001');
      expect(saved?.status).toBe('pending');
      expect(saved?.plan).toBe('BASIC');
      expect(saved?.user_id).toBe(DEFAULT_USER.id);
      expect(saved?.amount).toBe(9);
      expect(saved?.currency).toBe('USDT');
    });

    it('M2-F1-02: creates checkout for PREMIUM plan ($29) and persists pending record in D1', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000002,
          payment_id: '6000000002',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000002',
          order_id: `apex-${DEFAULT_USER.id.slice(0, 8)}-premium-1727200002`,
          valid_until: '2026-09-25T12:00:00Z',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.paymentId).toBe('6000000002');

      const saved = mockBillingDB.payments.get('6000000002');
      expect(saved).toBeDefined();
      expect(saved?.plan).toBe('PREMIUM');
      expect(saved?.amount).toBe(29);
      expect(saved?.status).toBe('pending');
    });

    it('M2-F1-03: creates checkout for ENTERPRISE plan ($99) and persists pending record in D1', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000003,
          payment_id: '6000000003',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000003',
          order_id: `apex-${DEFAULT_USER.id.slice(0, 8)}-enterprise-1727200003`,
          valid_until: '2026-09-25T12:00:00Z',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'ENTERPRISE' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.paymentId).toBe('6000000003');

      const saved = mockBillingDB.payments.get('6000000003');
      expect(saved?.amount).toBe(99);
      expect(saved?.plan).toBe('ENTERPRISE');
    });

    it('M2-F1-04: creates checkout for MASTER plan ($299) and persists pending record in D1', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000004,
          payment_id: '6000000004',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000004',
          order_id: `apex-${DEFAULT_USER.id.slice(0, 8)}-master-1727200004`,
          valid_until: '2026-09-25T12:00:00Z',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'MASTER' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.paymentId).toBe('6000000004');

      const saved = mockBillingDB.payments.get('6000000004');
      expect(saved?.amount).toBe(299);
      expect(saved?.plan).toBe('MASTER');
    });

    it('M2-F1-05: verifies outbound NOWPayments payload fields and callback URL', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000005,
          payment_id: '6000000005',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000005',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
        headers: {
          'x-forwarded-proto': 'https',
          host: 'apex-os.com',
        },
      });

      await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);

      expect(recordedUpstreamRequests.length).toBeGreaterThan(0);
      const upstreamReq = recordedUpstreamRequests[0];
      expect(upstreamReq.url).toContain('api.nowpayments.io/v1/payment');
      expect(upstreamReq.method).toBe('POST');
      expect(upstreamReq.headers['x-api-key']).toBe('test-nowpayments-api-key-m2');
      expect(upstreamReq.body).toMatchObject({
        price_currency: 'usd',
        pay_currency: 'usdterc20',
        plan: 'PREMIUM',
        ipn_callback_url: 'https://apex-os.com/api/webhooks/ipn',
      });
      expect(upstreamReq.body.order_id).toContain(DEFAULT_USER.id.slice(0, 8));
    });

    it('M2-F1-06: rejects unauthenticated requests with HTTP 401 Unauthorized', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        authMethod: 'none',
        user: null,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    it('M2-F1-06A: rejects forged token with token- prefix not in D1 (Bearer token-invalid)', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        authMethod: 'none',
        headers: {
          authorization: 'Bearer token-invalid',
        },
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Unauthorized');
    });

    it('M2-F1-06B: rejects arbitrary invalid Bearer token (Bearer invalid) with HTTP 401', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        authMethod: 'none',
        headers: {
          authorization: 'Bearer invalid',
        },
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Unauthorized');
    });

    it('M2-F1-07: accepts mobile Bearer token authentication', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000007,
          payment_id: '6000000007',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000007',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        authMethod: 'bearer',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      const saved = mockBillingDB.payments.get('6000000007');
      expect(saved?.user_id).toBe(DEFAULT_USER.id);
    });

    it('M2-F1-08: accepts Better Auth cookie authentication', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 6000000008,
          payment_id: '6000000008',
          payment_url: 'https://nowpayments.io/payment/?iid=6000000008',
        },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'BASIC' },
        authMethod: 'cookie',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      const saved = mockBillingDB.payments.get('6000000008');
      expect(saved?.user_id).toBe(DEFAULT_USER.id);
    });

    it('M2-F1-09: rejects lowercase plan string with HTTP 400 Bad Request', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'premium' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('M2-F1-10: rejects unsupported plan tier (DIAMOND) with HTTP 400 Bad Request', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'DIAMOND' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('M2-F1-11: rejects missing body or empty JSON with HTTP 400 Bad Request', async () => {
      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: {},
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(400);
    });

    it('M2-F1-12: returns HTTP 503 when NOWPAYMENTS_API_KEY is not configured', async () => {
      delete process.env.NOWPAYMENTS_API_KEY;

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(503);
      expect(res.error).toMatch(/not configured/i);
    });

    it('M2-F1-13: handles upstream NOWPayments timeout returning HTTP 502 Bad Gateway', async () => {
      configureMockNowPayments({
        shouldThrow: true,
        throwError: new Error('Upstream timeout connection reset'),
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'ENTERPRISE' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect(res.status).toBe(502);
      expect(res.error).toMatch(/unreachable|failed/i);
    });

    it('M2-F1-14: handles upstream NOWPayments 500 error returning HTTP 500 or 502', async () => {
      configureMockNowPayments({
        status: 500,
        response: { message: 'NOWPayments internal failure' },
      });

      const req = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'PREMIUM' },
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
      expect([500, 502]).toContain(res.status);
    });

    it('M2-F1-15: rejects corrupt or missing upstream NOWPayments payload with HTTP 502 Bad Gateway', async () => {
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
      expect(res.status).toBe(502);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Invalid response from payment provider');
    });

    it('M2-F1-16: fails with HTTP 500 when database insertion fails (fail-closed)', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 'pay-db-fail-m2',
          payment_id: 'pay-db-fail-m2',
          payment_url: 'https://nowpayments.io/payment/?iid=pay-db-fail-m2',
        },
      });

      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      mockBillingDB.prepare = (sql: string) => {
        if (sql.includes('INSERT INTO payments')) {
          throw new Error('D1 database connection lost');
        }
        return originalPrepare(sql);
      };

      try {
        const req = createTestRequest('/api/payments', {
          method: 'POST',
          body: { plan: 'BASIC' },
          user: DEFAULT_USER,
        });

        const res = await dispatchRoute('src/app/api/payments/route.ts', 'POST', req);
        expect(res.status).toBe(500);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toBe('Failed to record payment');
      } finally {
        mockBillingDB.prepare = originalPrepare;
      }
    });
  });

  // ==========================================================================
  // 2. F2: Payment History (GET /api/payments/history)
  // ==========================================================================
  describe('F2: Payment History (GET /api/payments/history)', () => {
    it('M2-F2-01: retrieves user payments sorted by created_at DESC', async () => {
      mockBillingDB.payments.set('pay-hist-1', {
        id: 'row-1',
        payment_id: 'pay-hist-1',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: '0x111',
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T09:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      mockBillingDB.payments.set('pay-hist-2', {
        id: 'row-2',
        payment_id: 'pay-hist-2',
        status: 'pending',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T12:00:00Z',
        updated_at: '2026-09-24T12:00:00Z',
      });

      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(Array.isArray(res.data.data)).toBe(true);
      expect(res.data.data.length).toBe(2);
      // Newest first (pay-hist-2 at 12:00)
      expect(res.data.data[0].paymentId || res.data.data[0].payment_id).toBe('pay-hist-2');
      expect(res.data.data[1].paymentId || res.data.data[1].payment_id).toBe('pay-hist-1');
    });

    it('M2-F2-02: returns empty array and total 0 for user with no payments', async () => {
      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: SECOND_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(0);
    });

    it('M2-F2-03: rejects unauthenticated requests with HTTP 401 Unauthorized', async () => {
      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        authMethod: 'none',
        user: null,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
    });

    it('M2-F2-03A: rejects forged token with token- prefix not in D1 (Bearer token-invalid)', async () => {
      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        authMethod: 'none',
        headers: {
          authorization: 'Bearer token-invalid',
        },
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Unauthorized');
    });

    it('M2-F2-03B: rejects arbitrary invalid Bearer token (Bearer invalid) with HTTP 401', async () => {
      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        authMethod: 'none',
        headers: {
          authorization: 'Bearer invalid',
        },
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toBe('Unauthorized');
    });

    it('M2-F2-04: ensures strict data isolation between different users', async () => {
      mockBillingDB.payments.set('u1-payment', {
        id: 'row-u1',
        payment_id: 'u1-payment',
        status: 'confirmed',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      mockBillingDB.payments.set('u2-payment', {
        id: 'row-u2',
        payment_id: 'u2-payment',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: SECOND_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T11:00:00Z',
        updated_at: '2026-09-24T11:00:00Z',
      });

      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: SECOND_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(1);
      expect(res.data.data[0].paymentId || res.data.data[0].payment_id).toBe('u2-payment');
      res.data.data.forEach((p: any) => {
        expect(p.paymentId || p.payment_id).not.toBe('u1-payment');
      });
    });

    it('M2-F2-05: respects pagination parameters (page=1, limit=1)', async () => {
      mockBillingDB.payments.set('p-1', {
        id: 'r-1',
        payment_id: 'p-1',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T08:00:00Z',
        updated_at: '2026-09-24T08:00:00Z',
      });

      mockBillingDB.payments.set('p-2', {
        id: 'r-2',
        payment_id: 'p-2',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T09:00:00Z',
        updated_at: '2026-09-24T09:00:00Z',
      });

      const req = createTestRequest('/api/payments/history?page=1&limit=1', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(1);
      expect(res.data.data[0].paymentId || res.data.data[0].payment_id).toBe('p-2');
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.pagination.limit).toBe(1);
      expect(res.data.pagination.total).toBe(2);
      expect(res.data.pagination.totalPages).toBe(2);
    });

    it('M2-F2-06: respects page=2 offset retrieving the older item', async () => {
      mockBillingDB.payments.set('p-1', {
        id: 'r-1',
        payment_id: 'p-1',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T08:00:00Z',
        updated_at: '2026-09-24T08:00:00Z',
      });

      mockBillingDB.payments.set('p-2', {
        id: 'r-2',
        payment_id: 'p-2',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T09:00:00Z',
        updated_at: '2026-09-24T09:00:00Z',
      });

      const req = createTestRequest('/api/payments/history?page=2&limit=1', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(1);
      expect(res.data.data[0].paymentId || res.data.data[0].payment_id).toBe('p-1');
      expect(res.data.pagination.page).toBe(2);
    });

    it('M2-F2-07: filters history by status (?status=confirmed)', async () => {
      mockBillingDB.payments.set('c-1', {
        id: 'r-c1',
        payment_id: 'c-1',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T09:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      mockBillingDB.payments.set('f-1', {
        id: 'r-f1',
        payment_id: 'f-1',
        status: 'failed',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T09:30:00Z',
        updated_at: '2026-09-24T09:30:00Z',
      });

      const req = createTestRequest('/api/payments/history?status=confirmed', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(1);
      expect(res.data.data[0].status).toBe('confirmed');
    });

    it('M2-F2-08: normalizes negative page (?page=-1) safely to page >= 1', async () => {
      const req = createTestRequest('/api/payments/history?page=-1&limit=10', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect([200, 400]).toContain(res.status);
      if (res.status === 200) {
        expect(res.data.pagination.page).toBeGreaterThanOrEqual(1);
      }
    });

    it('M2-F2-09: normalizes zero or negative limit (?limit=0) safely', async () => {
      const req = createTestRequest('/api/payments/history?page=1&limit=0', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect([200, 400]).toContain(res.status);
    });

    it('M2-F2-10: caps excessive limit (?limit=9999) to maximum limit <= 100', async () => {
      const req = createTestRequest('/api/payments/history?page=1&limit=9999', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.limit).toBeLessThanOrEqual(100);
    });

    it('M2-F2-11: handles offset exceeding total records (?page=999) gracefully', async () => {
      mockBillingDB.payments.set('p-only', {
        id: 'r-only',
        payment_id: 'p-only',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      const req = createTestRequest('/api/payments/history?page=999&limit=10', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination.total).toBe(1);
    });

    it('M2-F2-12: ensures history items contain both camelCase and snake_case properties', async () => {
      mockBillingDB.payments.set('p-props', {
        id: 'r-props',
        payment_id: 'p-props',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: '0xtxn123',
        confirmed_at: '2026-09-24T12:00:00Z',
        created_at: '2026-09-24T11:00:00Z',
        updated_at: '2026-09-24T12:00:00Z',
      });

      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const item = res.data.data[0];
      expect(item.paymentId).toBe('p-props');
      expect(item.payment_id).toBe('p-props');
      expect(item.txnId).toBe('0xtxn123');
      expect(item.txn_id).toBe('0xtxn123');
      expect(item.status).toBe('confirmed');
      expect(item.plan).toBe('PREMIUM');
      expect(item.amount).toBe(29);
      expect(item.currency).toBe('USDT');
    });
  });

  // ==========================================================================
  // 3. M2 Cross-Feature Lifecycle: Initiation -> DB -> History
  // ==========================================================================
  describe('M2 Cross-Feature Lifecycle: Initiation -> DB -> History', () => {
    it('M2-LIFECYCLE-01: initiated payment immediately appears in history as pending', async () => {
      configureMockNowPayments({
        status: 200,
        response: {
          id: 7000000001,
          payment_id: '7000000001',
          payment_url: 'https://nowpayments.io/payment/?iid=7000000001',
          order_id: `apex-${DEFAULT_USER.id.slice(0, 8)}-enterprise-1727200005`,
          valid_until: '2026-09-25T12:00:00Z',
        },
      });

      // 1. Initiate payment
      const initReq = createTestRequest('/api/payments', {
        method: 'POST',
        body: { plan: 'ENTERPRISE' },
        user: DEFAULT_USER,
      });

      const initRes = await dispatchRoute('src/app/api/payments/route.ts', 'POST', initReq);
      expect(initRes.status).toBe(200);
      expect(initRes.data.paymentId).toBe('7000000001');

      // 2. Query history without manual mock DB injection
      const histReq = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: DEFAULT_USER,
      });

      const histRes = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', histReq);
      expect(histRes.status).toBe(200);
      expect(histRes.data.success).toBe(true);

      const found = histRes.data.data.find(
        (p: any) => (p.paymentId || p.payment_id) === '7000000001'
      );
      expect(found).toBeDefined();
      expect(found.status).toBe('pending');
      expect(found.plan).toBe('ENTERPRISE');
      expect(found.amount).toBe(99);
      expect(found.currency).toBe('USDT');
    });
  });
});
