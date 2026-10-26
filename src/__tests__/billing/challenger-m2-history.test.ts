/**
 * Empirical Challenger Adversarial Test Suite for Milestone M2:
 * Payment History (GET /api/payments/history)
 * Target File: src/__tests__/billing/challenger-m2-history.test.ts
 *
 * Authored by: teamwork_preview_challenger_m2_2 (Empirical Challenger)
 * Scope:
 * 1. Strict User Data Isolation (cross-tenant access attempts, query injection, forged tokens)
 * 2. Pagination Boundaries (page 0, negative page, page > totalPages, limit 0, negative limit, limit > 100, non-numeric page/limit)
 * 3. Date-Descending Ordering (multi-record, interleaved timestamps, sub-second resolution, cross-page continuity)
 * 4. Empty History Handling (zero records, non-standard page/limit on empty)
 * 5. Status Filtering & Robustness (case insensitivity, whitespace trimming, SQL injection defense, dual field schema contract)
 */

import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  DEFAULT_USER,
  SECOND_USER,
} from './billing-test-harness';

describe('Empirical Challenger: Payment History (GET /api/payments/history) Stress Suite', () => {
  beforeAll(() => {
    setupBillingTestEnvironment();
  });

  beforeEach(() => {
    mockBillingDB.reset();
  });

  // ==========================================================================
  // Section 1: Strict User Data Isolation
  // ==========================================================================
  describe('1. Strict User Data Isolation', () => {
    it('CHALLENGE-ISO-01: User A cannot see User B payments across mixed datasets', async () => {
      // Seed User A with 4 payments
      for (let i = 1; i <= 4; i++) {
        mockBillingDB.payments.set(`user-a-pay-${i}`, {
          id: `id-a-${i}`,
          payment_id: `user-a-pay-${i}`,
          status: 'confirmed',
          plan: 'BASIC',
          user_id: DEFAULT_USER.id,
          amount: 9,
          currency: 'USDT',
          txn_id: `0xa${i}`,
          confirmed_at: `2026-09-24T10:0${i}:00Z`,
          created_at: `2026-09-24T10:0${i}:00Z`,
          updated_at: `2026-09-24T10:0${i}:00Z`,
        });
      }

      // Seed User B with 3 payments
      for (let i = 1; i <= 3; i++) {
        mockBillingDB.payments.set(`user-b-pay-${i}`, {
          id: `id-b-${i}`,
          payment_id: `user-b-pay-${i}`,
          status: 'confirmed',
          plan: 'PREMIUM',
          user_id: SECOND_USER.id,
          amount: 29,
          currency: 'USDT',
          txn_id: `0xb${i}`,
          confirmed_at: `2026-09-24T11:0${i}:00Z`,
          created_at: `2026-09-24T11:0${i}:00Z`,
          updated_at: `2026-09-24T11:0${i}:00Z`,
        });
      }

      // 1. User A queries history
      const reqA = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const resA = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', reqA);
      expect(resA.status).toBe(200);
      expect(resA.data.success).toBe(true);
      expect(resA.data.data.length).toBe(4);
      expect(resA.data.pagination.total).toBe(4);
      for (const p of resA.data.data) {
        expect(p.userId || p.user_id).toBe(DEFAULT_USER.id);
        expect(p.paymentId || p.payment_id).toMatch(/^user-a-pay-/);
        expect(p.paymentId || p.payment_id).not.toMatch(/^user-b-pay-/);
      }

      // 2. User B queries history
      const reqB = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: SECOND_USER,
      });
      const resB = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', reqB);
      expect(resB.status).toBe(200);
      expect(resB.data.success).toBe(true);
      expect(resB.data.data.length).toBe(3);
      expect(resB.data.pagination.total).toBe(3);
      for (const p of resB.data.data) {
        expect(p.userId || p.user_id).toBe(SECOND_USER.id);
        expect(p.paymentId || p.payment_id).toMatch(/^user-b-pay-/);
        expect(p.paymentId || p.payment_id).not.toMatch(/^user-a-pay-/);
      }
    });

    it('CHALLENGE-ISO-02: Ignores hostile user_id query parameters in request URL', async () => {
      mockBillingDB.payments.set('user-b-secret', {
        id: 'id-b-sec',
        payment_id: 'user-b-secret',
        status: 'confirmed',
        plan: 'ENTERPRISE',
        user_id: SECOND_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: '0xsec',
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      // User A attempts to inspect User B's history by injecting user_id in search params
      const hostileUrls = [
        `/api/payments/history?user_id=${encodeURIComponent(SECOND_USER.id)}`,
        `/api/payments/history?userId=${encodeURIComponent(SECOND_USER.id)}`,
        `/api/payments/history?user_id=any&userId=${encodeURIComponent(SECOND_USER.id)}`,
        `/api/payments/history?user_id=' OR '1'='1`,
      ];

      for (const url of hostileUrls) {
        const req = createTestRequest(url, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        // Must return empty or only User A's data, NEVER User B's data
        expect(res.data.data).toEqual([]);
        expect(res.data.pagination.total).toBe(0);
      }
    });

    it('CHALLENGE-ISO-03: Rejects unauthenticated and tampered requests with HTTP 401', async () => {
      // 1. Missing authentication
      const reqNoAuth = createTestRequest('/api/payments/history', {
        method: 'GET',
        authMethod: 'none',
        user: null,
      });
      const resNoAuth = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', reqNoAuth);
      expect(resNoAuth.status).toBe(401);
      expect(resNoAuth.data.success).toBe(false);

      // 2. Empty Authorization header
      const reqEmptyAuth = createTestRequest('/api/payments/history', {
        method: 'GET',
        authMethod: 'none',
        user: null,
        headers: { authorization: '' },
      });
      const resEmptyAuth = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', reqEmptyAuth);
      expect(resEmptyAuth.status).toBe(401);
      expect(resEmptyAuth.data.success).toBe(false);

      // 3. Malformed Authorization header without token
      const reqMalformedAuth = createTestRequest('/api/payments/history', {
        method: 'GET',
        authMethod: 'none',
        user: null,
        headers: { authorization: 'Bearer ' },
      });
      const resMalformedAuth = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', reqMalformedAuth);
      expect(resMalformedAuth.status).toBe(401);
      expect(resMalformedAuth.data.success).toBe(false);
    });

    it('CHALLENGE-ISO-04: Multi-tenant interleaving maintains absolute partition across 5 users', async () => {
      const userIds = ['tenant-1', 'tenant-2', 'tenant-3', 'tenant-4', 'tenant-5'];
      let counter = 0;

      // Seed 3 payments per user in round-robin fashion
      for (let round = 1; round <= 3; round++) {
        for (const uid of userIds) {
          counter++;
          mockBillingDB.payments.set(`pay-multi-${counter}`, {
            id: `row-multi-${counter}`,
            payment_id: `pay-multi-${counter}`,
            status: 'confirmed',
            plan: 'BASIC',
            user_id: uid,
            amount: 9,
            currency: 'USDT',
            txn_id: null,
            confirmed_at: null,
            created_at: `2026-09-24T12:${String(counter).padStart(2, '0')}:00Z`,
            updated_at: `2026-09-24T12:${String(counter).padStart(2, '0')}:00Z`,
          });
        }
      }

      // Verify each tenant receives exactly 3 items and strictly their own items
      for (const uid of userIds) {
        const tenantUser = { id: uid, email: `${uid}@apex-os.com` };
        const req = createTestRequest('/api/payments/history', {
          method: 'GET',
          user: tenantUser,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.data.length).toBe(3);
        expect(res.data.pagination.total).toBe(3);
        for (const item of res.data.data) {
          expect(item.userId || item.user_id).toBe(uid);
        }
      }
    });
  });

  // ==========================================================================
  // Section 2: Pagination Boundaries & Extreme Inputs
  // ==========================================================================
  describe('2. Pagination Boundaries & Extreme Inputs', () => {
    beforeEach(() => {
      // Seed 5 payments for DEFAULT_USER
      for (let i = 1; i <= 5; i++) {
        mockBillingDB.payments.set(`bound-pay-${i}`, {
          id: `id-bound-${i}`,
          payment_id: `bound-pay-${i}`,
          status: 'confirmed',
          plan: 'BASIC',
          user_id: DEFAULT_USER.id,
          amount: 9 * i,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: `2026-09-24T0${i}:00:00Z`,
          updated_at: `2026-09-24T0${i}:00:00Z`,
        });
      }
    });

    it('CHALLENGE-PAG-01: Boundary page=0 normalizes to page=1', async () => {
      const req = createTestRequest('/api/payments/history?page=0&limit=2', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.data.length).toBe(2);
      expect(res.data.pagination.total).toBe(5);
    });

    it('CHALLENGE-PAG-02: Negative page values (?page=-1, ?page=-999) normalize safely to page=1', async () => {
      for (const negPage of [-1, -50, -99999]) {
        const req = createTestRequest(`/api/payments/history?page=${negPage}&limit=3`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.page).toBe(1);
        expect(res.data.data.length).toBe(3);
      }
    });

    it('CHALLENGE-PAG-03: Page exceeding totalPages (?page=999) returns empty array without error', async () => {
      const req = createTestRequest('/api/payments/history?page=999&limit=10', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toEqual([]);
      expect(res.data.payments).toEqual([]);
      expect(res.data.pagination.page).toBe(999);
      expect(res.data.pagination.total).toBe(5);
      expect(res.data.pagination.totalPages).toBe(1);
    });

    it('CHALLENGE-PAG-04: Boundary limit=0 and negative limits normalize to default limit (10)', async () => {
      for (const badLimit of [0, -1, -50]) {
        const req = createTestRequest(`/api/payments/history?page=1&limit=${badLimit}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.limit).toBe(10);
        expect(res.data.data.length).toBe(5); // All 5 items fit in limit 10
      }
    });

    it('CHALLENGE-PAG-05: Excessive limit (?limit=101, ?limit=9999) is strictly capped at 100', async () => {
      for (const highLimit of [101, 500, 9999]) {
        const req = createTestRequest(`/api/payments/history?page=1&limit=${highLimit}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.limit).toBe(100);
      }
    });

    it('CHALLENGE-PAG-06: Non-numeric page and limit parameters fallback safely without crash', async () => {
      const hostileParams = [
        '?page=abc&limit=xyz',
        '?page=NaN&limit=NaN',
        '?page=null&limit=undefined',
        '?page=true&limit=false',
        '?page=&&limit=',
        '?page=%20&limit=%20',
      ];

      for (const query of hostileParams) {
        const req = createTestRequest(`/api/payments/history${query}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.pagination.page).toBe(1);
        expect(res.data.pagination.limit).toBe(10);
        expect(res.data.data.length).toBe(5);
      }
    });

    it('CHALLENGE-PAG-07: Decimal/floating point page and limit values parse integer portions gracefully', async () => {
      const req = createTestRequest('/api/payments/history?page=1.9&limit=2.7', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.pagination.limit).toBe(2);
      expect(res.data.data.length).toBe(2);
    });

    it('CHALLENGE-PAG-08: Consecutive 1-item pages paginate all records with exact totalPages', async () => {
      const totalRecords = 5;
      const seenIds = new Set<string>();

      for (let p = 1; p <= totalRecords; p++) {
        const req = createTestRequest(`/api/payments/history?page=${p}&limit=1`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.page).toBe(p);
        expect(res.data.pagination.limit).toBe(1);
        expect(res.data.pagination.total).toBe(totalRecords);
        expect(res.data.pagination.totalPages).toBe(totalRecords);
        expect(res.data.data.length).toBe(1);

        const currentId = res.data.data[0].paymentId || res.data.data[0].payment_id;
        expect(seenIds.has(currentId)).toBe(false);
        seenIds.add(currentId);
      }

      expect(seenIds.size).toBe(totalRecords);
    });
  });

  // ==========================================================================
  // Section 3: Date-Descending Ordering
  // ==========================================================================
  describe('3. Date-Descending Ordering Verification', () => {
    it('CHALLENGE-ORD-01: Sorts records strictly in descending order of created_at regardless of insertion order', async () => {
      // Generate 12 timestamps out of order
      const timestamps = [
        '2026-09-24T05:00:00Z',
        '2026-09-24T11:00:00Z',
        '2026-09-24T01:00:00Z',
        '2026-09-24T09:00:00Z',
        '2026-09-24T03:00:00Z',
        '2026-09-24T08:00:00Z',
        '2026-09-24T02:00:00Z',
        '2026-09-24T12:00:00Z',
        '2026-09-24T07:00:00Z',
        '2026-09-24T04:00:00Z',
        '2026-09-24T10:00:00Z',
        '2026-09-24T06:00:00Z',
      ];

      for (let i = 0; i < timestamps.length; i++) {
        mockBillingDB.payments.set(`order-pay-${i}`, {
          id: `id-ord-${i}`,
          payment_id: `order-pay-${i}`,
          status: 'confirmed',
          plan: 'BASIC',
          user_id: DEFAULT_USER.id,
          amount: 9,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: timestamps[i],
          updated_at: timestamps[i],
        });
      }

      const req = createTestRequest('/api/payments/history?page=1&limit=20', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(12);

      // Verify strictly descending timestamps
      for (let i = 0; i < res.data.data.length - 1; i++) {
        const current = new Date(res.data.data[i].createdAt || res.data.data[i].created_at).getTime();
        const next = new Date(res.data.data[i + 1].createdAt || res.data.data[i + 1].created_at).getTime();
        expect(current).toBeGreaterThanOrEqual(next);
      }

      // Check first is the newest (12:00:00Z) and last is oldest (01:00:00Z)
      expect(res.data.data[0].createdAt || res.data.data[0].created_at).toBe('2026-09-24T12:00:00Z');
      expect(res.data.data[11].createdAt || res.data.data[11].created_at).toBe('2026-09-24T01:00:00Z');
    });

    it('CHALLENGE-ORD-02: Preserves total ordering across multi-page traversals', async () => {
      // Seed 6 payments with sequential timestamps
      for (let i = 1; i <= 6; i++) {
        mockBillingDB.payments.set(`seq-pay-${i}`, {
          id: `id-seq-${i}`,
          payment_id: `seq-pay-${i}`,
          status: 'confirmed',
          plan: 'PREMIUM',
          user_id: DEFAULT_USER.id,
          amount: 29,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: `2026-09-24T10:0${i}:00Z`,
          updated_at: `2026-09-24T10:0${i}:00Z`,
        });
      }

      // Fetch page 1 (limit 2)
      const resPage1 = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?page=1&limit=2', { user: DEFAULT_USER })
      );
      // Fetch page 2 (limit 2)
      const resPage2 = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?page=2&limit=2', { user: DEFAULT_USER })
      );
      // Fetch page 3 (limit 2)
      const resPage3 = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?page=3&limit=2', { user: DEFAULT_USER })
      );

      expect(resPage1.data.data.length).toBe(2);
      expect(resPage2.data.data.length).toBe(2);
      expect(resPage3.data.data.length).toBe(2);

      // Verify last item of page 1 is newer than first item of page 2
      const p1Last = new Date(resPage1.data.data[1].createdAt).getTime();
      const p2First = new Date(resPage2.data.data[0].createdAt).getTime();
      expect(p1Last).toBeGreaterThan(p2First);

      // Verify last item of page 2 is newer than first item of page 3
      const p2Last = new Date(resPage2.data.data[1].createdAt).getTime();
      const p3First = new Date(resPage3.data.data[0].createdAt).getTime();
      expect(p2Last).toBeGreaterThan(p3First);
    });

    it('CHALLENGE-ORD-03: Correctly orders records with sub-second millisecond granularity', async () => {
      mockBillingDB.payments.set('ms-pay-1', {
        id: 'id-ms-1',
        payment_id: 'ms-pay-1',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T12:00:00.100Z',
        updated_at: '2026-09-24T12:00:00.100Z',
      });

      mockBillingDB.payments.set('ms-pay-2', {
        id: 'id-ms-2',
        payment_id: 'ms-pay-2',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T12:00:00.850Z',
        updated_at: '2026-09-24T12:00:00.850Z',
      });

      mockBillingDB.payments.set('ms-pay-3', {
        id: 'id-ms-3',
        payment_id: 'ms-pay-3',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T12:00:00.500Z',
        updated_at: '2026-09-24T12:00:00.500Z',
      });

      const req = createTestRequest('/api/payments/history', { user: DEFAULT_USER });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(3);

      expect(res.data.data[0].paymentId).toBe('ms-pay-2'); // .850Z
      expect(res.data.data[1].paymentId).toBe('ms-pay-3'); // .500Z
      expect(res.data.data[2].paymentId).toBe('ms-pay-1'); // .100Z
    });
  });

  // ==========================================================================
  // Section 4: Empty History Handling
  // ==========================================================================
  describe('4. Empty History Handling', () => {
    it('CHALLENGE-EMP-01: Returns empty arrays with total=0 and totalPages=0 for user with no records', async () => {
      const freshUser = { id: 'usr-new-001', email: 'newbie@apex-os.com' };
      const req = createTestRequest('/api/payments/history', { user: freshUser });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.payments).toEqual([]);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination).toEqual({
        page: 1,
        limit: 10,
        total: 0,
        totalPages: 0,
      });
    });

    it('CHALLENGE-EMP-02: Safely handles non-default page and limit queries on empty history', async () => {
      const freshUser = { id: 'usr-new-002', email: 'newbie2@apex-os.com' };
      const req = createTestRequest('/api/payments/history?page=5&limit=25', { user: freshUser });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.payments).toEqual([]);
      expect(res.data.data).toEqual([]);
      expect(res.data.pagination).toEqual({
        page: 5,
        limit: 25,
        total: 0,
        totalPages: 0,
      });
    });
  });

  // ==========================================================================
  // Section 5: Status Filtering & Edge-Case Robustness
  // ==========================================================================
  describe('5. Status Filtering, Query Defense, & Response Contract', () => {
    beforeEach(() => {
      // Seed 2 confirmed, 2 pending, 1 failed for DEFAULT_USER
      mockBillingDB.payments.set('pay-c1', {
        id: 'r-c1',
        payment_id: 'pay-c1',
        status: 'confirmed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: '0x1',
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T09:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });
      mockBillingDB.payments.set('pay-c2', {
        id: 'r-c2',
        payment_id: 'pay-c2',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: '0x2',
        confirmed_at: '2026-09-24T11:00:00Z',
        created_at: '2026-09-24T10:30:00Z',
        updated_at: '2026-09-24T11:00:00Z',
      });
      mockBillingDB.payments.set('pay-p1', {
        id: 'r-p1',
        payment_id: 'pay-p1',
        status: 'pending',
        plan: 'ENTERPRISE',
        user_id: DEFAULT_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T12:00:00Z',
        updated_at: '2026-09-24T12:00:00Z',
      });
      mockBillingDB.payments.set('pay-p2', {
        id: 'r-p2',
        payment_id: 'pay-p2',
        status: 'pending',
        plan: 'MASTER',
        user_id: DEFAULT_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T13:00:00Z',
        updated_at: '2026-09-24T13:00:00Z',
      });
      mockBillingDB.payments.set('pay-f1', {
        id: 'r-f1',
        payment_id: 'pay-f1',
        status: 'failed',
        plan: 'BASIC',
        user_id: DEFAULT_USER.id,
        amount: 9,
        currency: 'USDT',
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T08:00:00Z',
        updated_at: '2026-09-24T08:10:00Z',
      });
    });

    it('CHALLENGE-ROB-01: Filters history accurately across all status states', async () => {
      // 1. confirmed
      const resConf = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?status=confirmed', { user: DEFAULT_USER })
      );
      expect(resConf.status).toBe(200);
      expect(resConf.data.data.length).toBe(2);
      expect(resConf.data.pagination.total).toBe(2);
      resConf.data.data.forEach((p: any) => expect(p.status).toBe('confirmed'));

      // 2. pending
      const resPend = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?status=pending', { user: DEFAULT_USER })
      );
      expect(resPend.status).toBe(200);
      expect(resPend.data.data.length).toBe(2);
      expect(resPend.data.pagination.total).toBe(2);
      resPend.data.data.forEach((p: any) => expect(p.status).toBe('pending'));

      // 3. failed
      const resFail = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?status=failed', { user: DEFAULT_USER })
      );
      expect(resFail.status).toBe(200);
      expect(resFail.data.data.length).toBe(1);
      expect(resFail.data.pagination.total).toBe(1);
      expect(resFail.data.data[0].status).toBe('failed');
    });

    it('CHALLENGE-ROB-02: Normalizes status case and whitespace (?status=%20CONFIRMED%20)', async () => {
      const resUpper = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?status=%20CONFIRMED%20', { user: DEFAULT_USER })
      );
      expect(resUpper.status).toBe(200);
      expect(resUpper.data.data.length).toBe(2);
      expect(resUpper.data.pagination.total).toBe(2);
    });

    it('CHALLENGE-ROB-03: Safely handles unrecognized status queries without error', async () => {
      const resNone = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?status=unknown_lifecycle_status', { user: DEFAULT_USER })
      );
      expect(resNone.status).toBe(200);
      expect(resNone.data.data).toEqual([]);
      expect(resNone.data.pagination.total).toBe(0);
      expect(resNone.data.pagination.totalPages).toBe(0);
    });

    it('CHALLENGE-ROB-04: Defends against SQL injection in status parameter (?status=x\'%20OR%20\'1\'=\'1)', async () => {
      const sqlInjectionQuery = encodeURIComponent("confirmed' OR '1'='1");
      const resSql = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest(`/api/payments/history?status=${sqlInjectionQuery}`, { user: DEFAULT_USER })
      );
      expect(resSql.status).toBe(200);
      // Because SQL is parameterized, the injection string is treated as a literal status, matching 0 rows
      expect(resSql.data.data).toEqual([]);
      expect(resSql.data.pagination.total).toBe(0);
    });

    it('CHALLENGE-ROB-05: Verifies complete dual-field contract (camelCase + snake_case) on every item', async () => {
      const res = await dispatchRoute(
        'src/app/api/payments/history/route.ts',
        'GET',
        createTestRequest('/api/payments/history?status=confirmed&limit=1', { user: DEFAULT_USER })
      );
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(1);

      const item = res.data.data[0];
      // Core fields
      expect(typeof item.id).toBe('string');
      expect(typeof item.status).toBe('string');
      expect(typeof item.plan).toBe('string');
      expect(typeof item.amount).toBe('number');
      expect(typeof item.currency).toBe('string');

      // Dual alias verification
      expect(item.paymentId).toBe(item.payment_id);
      expect(item.orderId).toBe(item.payment_id);
      expect(item.userId).toBe(item.user_id);
      expect(item.txnId).toBe(item.txn_id);
      expect(item.confirmedAt).toBe(item.confirmed_at);
      expect(item.createdAt).toBe(item.created_at);
      expect(item.updatedAt).toBe(item.updated_at);

      // Verify payments alias array matches data array
      expect(res.data.payments).toEqual(res.data.data);
    });
  });
});
