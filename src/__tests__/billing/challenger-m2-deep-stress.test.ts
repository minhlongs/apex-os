/**
 * Empirical Challenger Deep Stress Test Suite for Milestone M2:
 * Payment History (GET /api/payments/history)
 * Target File: src/__tests__/billing/challenger-m2-deep-stress.test.ts
 *
 * Authored by: teamwork_preview_challenger_m2_remediation_2
 * Role: EMPIRICAL CHALLENGER
 *
 * Scope:
 * 1. Pagination extreme boundaries & mathematical precision
 * 2. SQL boundary & adversarial query parameter defense (date ranges, injection, unicode)
 * 3. User isolation & session security (expired sessions, invalid tokens, cross-tenant isolation)
 * 4. Sorting order across complex date ranges (multi-year, leap year, sub-second timestamps)
 * 5. Complete field mapping integrity & null safety
 */

import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  dispatchRoute,
  DEFAULT_USER,
  SECOND_USER,
} from './billing-test-harness';
import { NextRequest } from 'next/server';

describe('Empirical Challenger M2 Remediation: Deep Stress Suite (GET /api/payments/history)', () => {
  beforeAll(() => {
    setupBillingTestEnvironment();
  });

  beforeEach(() => {
    mockBillingDB.reset();
  });

  // =========================================================================
  // 1. Pagination Limits & Mathematical Boundaries
  // =========================================================================
  describe('1. Pagination Limits & Mathematical Boundaries', () => {
    it('STRESS-PAG-01: exactly 100 items seeded, limit=100 returns exactly 100, page=2 returns 0', async () => {
      // Seed exactly 100 payments for DEFAULT_USER
      for (let i = 1; i <= 100; i++) {
        const pad = String(i).padStart(3, '0');
        mockBillingDB.payments.set(`stress-pay-${pad}`, {
          id: `row-${pad}`,
          payment_id: `stress-pay-${pad}`,
          status: 'confirmed',
          plan: 'BASIC',
          user_id: DEFAULT_USER.id,
          amount: 9,
          currency: 'USDT',
          txn_id: `0x${pad}`,
          confirmed_at: `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
          created_at: `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
          updated_at: `2026-09-01T00:${String(Math.floor(i / 60)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}Z`,
        });
      }

      // Page 1 with limit 100
      const req1 = createTestRequest('/api/payments/history?page=1&limit=100', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res1 = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req1);
      expect(res1.status).toBe(200);
      expect(res1.data.success).toBe(true);
      expect(res1.data.data.length).toBe(100);
      expect(res1.data.pagination).toEqual({
        page: 1,
        limit: 100,
        total: 100,
        totalPages: 1,
      });

      // Page 2 with limit 100 should return empty
      const req2 = createTestRequest('/api/payments/history?page=2&limit=100', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res2 = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req2);
      expect(res2.status).toBe(200);
      expect(res2.data.data).toEqual([]);
      expect(res2.data.pagination).toEqual({
        page: 2,
        limit: 100,
        total: 100,
        totalPages: 1,
      });
    });

    it('STRESS-PAG-02: handles huge page numbers (e.g. 1,000,000) without integer overflow or crash', async () => {
      mockBillingDB.payments.set('pay-single', {
        id: 'row-single',
        payment_id: 'pay-single',
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

      const hugePages = [1000000, 999999999, 2147483647];
      for (const page of hugePages) {
        const req = createTestRequest(`/api/payments/history?page=${page}&limit=10`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.data).toEqual([]);
        expect(res.data.pagination.page).toBe(page);
        expect(res.data.pagination.total).toBe(1);
        expect(res.data.pagination.totalPages).toBe(1);
      }
    });

    it('STRESS-PAG-03: accurately computes totalPages for various total / limit ratios', async () => {
      const seedCount = (n: number) => {
        mockBillingDB.payments.clear();
        for (let i = 1; i <= n; i++) {
          mockBillingDB.payments.set(`p-${i}`, {
            id: `r-${i}`,
            payment_id: `p-${i}`,
            status: 'confirmed',
            plan: 'BASIC',
            user_id: DEFAULT_USER.id,
            amount: 9,
            currency: 'USDT',
            txn_id: null,
            confirmed_at: null,
            created_at: `2026-09-24T10:00:${String(i % 60).padStart(2, '0')}Z`,
            updated_at: `2026-09-24T10:00:${String(i % 60).padStart(2, '0')}Z`,
          });
        }
      };

      const testCases = [
        { total: 0, limit: 10, expectedTotalPages: 0 },
        { total: 1, limit: 10, expectedTotalPages: 1 },
        { total: 10, limit: 10, expectedTotalPages: 1 },
        { total: 11, limit: 10, expectedTotalPages: 2 },
        { total: 25, limit: 7, expectedTotalPages: 4 }, // ceil(25/7) = 4
        { total: 30, limit: 15, expectedTotalPages: 2 },
      ];

      for (const tc of testCases) {
        seedCount(tc.total);
        const req = createTestRequest(`/api/payments/history?page=1&limit=${tc.limit}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.total).toBe(tc.total);
        expect(res.data.pagination.limit).toBe(tc.limit);
        expect(res.data.pagination.totalPages).toBe(tc.expectedTotalPages);
      }
    });
  });

  // =========================================================================
  // 2. SQL Boundary & Adversarial Query Parameter Defense
  // =========================================================================
  describe('2. SQL Boundary & Adversarial Query Parameter Defense', () => {
    beforeEach(() => {
      mockBillingDB.payments.set('p-user1', {
        id: 'r-user1',
        payment_id: 'p-user1',
        status: 'confirmed',
        plan: 'PREMIUM',
        user_id: DEFAULT_USER.id,
        amount: 29,
        currency: 'USDT',
        txn_id: '0xabc',
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });
      mockBillingDB.payments.set('p-user2', {
        id: 'r-user2',
        payment_id: 'p-user2',
        status: 'confirmed',
        plan: 'ENTERPRISE',
        user_id: SECOND_USER.id,
        amount: 99,
        currency: 'USDT',
        txn_id: '0xdef',
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });
    });

    it('STRESS-SQL-01: Defends against extensive SQL injection in status parameter', async () => {
      const sqlAttacks = [
        "confirmed' OR '1'='1",
        "'; DROP TABLE payments; --",
        "' UNION SELECT id,payment_id,status,plan,user_id,amount,currency,txn_id,confirmed_at,created_at,updated_at FROM payments WHERE ''='",
        "admin'--",
        "1; WAITFOR DELAY '0:0:5'--",
        "1' AND SLEEP(5)--",
        "confirmed'/*",
      ];

      for (const attack of sqlAttacks) {
        const req = createTestRequest(`/api/payments/history?status=${encodeURIComponent(attack)}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        // None of these should match any status, total should be 0, never leaking other users
        expect(res.data.data).toEqual([]);
        expect(res.data.pagination.total).toBe(0);
      }
    });

    it('STRESS-SQL-02: Null byte, unicode, and buffer attacks in status parameter are handled cleanly', async () => {
      const specialInputs = [
        'confirmed\x00',
        'confirmed\u0000admin',
        '🔥💎💰',
        '   ',
        '\t\r\n',
        'a'.repeat(5000), // Very long string
      ];

      for (const input of specialInputs) {
        const req = createTestRequest(`/api/payments/history?status=${encodeURIComponent(input)}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
      }
    });

    it('STRESS-SQL-03: Adversarial date range & query injection parameters do not alter query logic', async () => {
      const adversarialQueries = [
        '?startDate=2026-01-01&endDate=2026-12-31',
        '?from=2026-01-01T00:00:00Z&to=2026-12-31T23:59:59Z',
        '?since=1000000000&until=2000000000',
        '?where=1=1',
        '?order=created_at%20ASC',
        '?orderBy=amount%20DESC',
        '?groupBy=user_id',
        '?having=1=1',
        '?limit=5&limit=1', // duplicate param
      ];

      for (const query of adversarialQueries) {
        const req = createTestRequest(`/api/payments/history${query}`, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.success).toBe(true);
        expect(res.data.data.length).toBe(1);
        expect(res.data.data[0].paymentId).toBe('p-user1');
      }
    });
  });

  // =========================================================================
  // 3. User Isolation & Session Security
  // =========================================================================
  describe('3. User Isolation & Session Security', () => {
    it('STRESS-SEC-01: Rejects expired session in D1 sessions table with HTTP 401', async () => {
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      mockBillingDB.prepare = (sql: string) => {
        if (sql.toUpperCase().includes('FROM SESSIONS') || sql.toUpperCase().includes('FROM "SESSIONS"')) {
          return {
            bind: () => ({
              first: async () => ({
                user_id: DEFAULT_USER.id,
                expires_at: new Date(Date.now() - 3600 * 1000).toISOString(), // expired 1 hour ago
                email: DEFAULT_USER.email,
              }),
            }),
          } as any;
        }
        return originalPrepare(sql);
      };

      try {
        const req = new NextRequest('https://apex-os.com/api/payments/history', {
          method: 'GET',
          headers: {
            authorization: 'Bearer expired-session-token',
          },
        });

        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(401);
        expect(res.data.success).toBe(false);
      } finally {
        mockBillingDB.prepare = originalPrepare;
      }
    });

    it('STRESS-SEC-02: Rejects arbitrary non-existent session token in D1 with HTTP 401', async () => {
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      // Ensure sessions lookup returns null for forged/unregistered tokens
      mockBillingDB.prepare = (sql: string) => {
        if (sql.toUpperCase().includes('FROM SESSIONS') || sql.toUpperCase().includes('FROM "SESSIONS"')) {
          return {
            bind: (token: string) => ({
              first: async () => {
                if (token === `token-${DEFAULT_USER.id}`) {
                  return {
                    user_id: DEFAULT_USER.id,
                    expires_at: new Date(Date.now() + 86400000).toISOString(),
                    email: DEFAULT_USER.email,
                  };
                }
                return null; // Forged or invalid token
              },
            }),
          } as any;
        }
        return originalPrepare(sql);
      };

      try {
        const forgedTokens = [
          'Bearer token-random123',
          'Bearer token-invalid',
          'Bearer invalid',
          'Bearer null',
          'Bearer undefined',
          'Bearer [object Object]',
          'Bearer false',
        ];

        for (const authHeader of forgedTokens) {
          const req = new NextRequest('https://apex-os.com/api/payments/history', {
            method: 'GET',
            headers: {
              authorization: authHeader,
            },
          });
          const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
          expect(res.status).toBe(401);
          expect(res.data.success).toBe(false);
        }
      } finally {
        mockBillingDB.prepare = originalPrepare;
      }
    });

    it('STRESS-SEC-03: User cannot access other user records even if payment IDs are known', async () => {
      // User B has a payment with known ID
      mockBillingDB.payments.set('secret-b-id-999', {
        id: 'row-b-999',
        payment_id: 'secret-b-id-999',
        status: 'confirmed',
        plan: 'MASTER',
        user_id: SECOND_USER.id,
        amount: 299,
        currency: 'USDT',
        txn_id: '0x999',
        confirmed_at: '2026-09-24T10:00:00Z',
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      // User A queries with payment_id or id in query params
      const probeUrls = [
        '/api/payments/history?payment_id=secret-b-id-999',
        '/api/payments/history?paymentId=secret-b-id-999',
        '/api/payments/history?id=row-b-999',
      ];

      for (const url of probeUrls) {
        const req = createTestRequest(url, {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.data).toEqual([]);
        expect(res.data.pagination.total).toBe(0);
      }
    });
  });

  // =========================================================================
  // 4. Sorting Across Diverse Date Ranges
  // =========================================================================
  describe('4. Sorting Across Diverse Date Ranges', () => {
    it('STRESS-ORD-01: Correctly sorts records spanning multiple years and leap years in strict descending order', async () => {
      const dates = [
        '2024-02-29T12:00:00.000Z', // Leap day
        '2024-01-01T00:00:00.000Z',
        '2025-06-15T18:30:00.000Z',
        '2026-09-24T15:00:00.000Z',
        '2026-09-24T15:00:01.000Z',
        '2027-01-01T00:00:00.000Z', // Future year
        '2023-12-31T23:59:59.000Z',
      ];

      // Shuffle and seed
      const shuffled = [...dates].sort(() => Math.random() - 0.5);
      shuffled.forEach((d, idx) => {
        mockBillingDB.payments.set(`date-pay-${idx}`, {
          id: `r-date-${idx}`,
          payment_id: `date-pay-${idx}`,
          status: 'confirmed',
          plan: 'BASIC',
          user_id: DEFAULT_USER.id,
          amount: 9,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: d,
          updated_at: d,
        });
      });

      const req = createTestRequest('/api/payments/history?limit=20', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(dates.length);

      // Verify strict descending chronological order
      const returnedDates = res.data.data.map((p: any) => p.createdAt || p.created_at);
      const expectedSorted = [...dates].sort((a, b) => new Date(b).getTime() - new Date(a).getTime());

      expect(returnedDates).toEqual(expectedSorted);
    });

    it('STRESS-ORD-02: Sub-millisecond timestamps sort correctly in descending order', async () => {
      const subMsDates = [
        '2026-09-24T12:00:00.001Z',
        '2026-09-24T12:00:00.050Z',
        '2026-09-24T12:00:00.099Z',
        '2026-09-24T12:00:00.500Z',
        '2026-09-24T12:00:00.999Z',
      ];

      // Insert in reverse order
      subMsDates.forEach((d, idx) => {
        mockBillingDB.payments.set(`subms-${idx}`, {
          id: `r-subms-${idx}`,
          payment_id: `subms-${idx}`,
          status: 'confirmed',
          plan: 'BASIC',
          user_id: DEFAULT_USER.id,
          amount: 9,
          currency: 'USDT',
          txn_id: null,
          confirmed_at: null,
          created_at: d,
          updated_at: d,
        });
      });

      const req = createTestRequest('/api/payments/history?limit=10', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const returned = res.data.data.map((p: any) => p.createdAt || p.created_at);
      expect(returned[0]).toBe('2026-09-24T12:00:00.999Z');
      expect(returned[1]).toBe('2026-09-24T12:00:00.500Z');
      expect(returned[2]).toBe('2026-09-24T12:00:00.099Z');
      expect(returned[3]).toBe('2026-09-24T12:00:00.050Z');
      expect(returned[4]).toBe('2026-09-24T12:00:00.001Z');
    });
  });

  // =========================================================================
  // 5. Complete Field Mapping & Null Safety
  // =========================================================================
  describe('5. Complete Field Mapping & Null Safety', () => {
    it('STRESS-FLD-01: Null fields in database map safely without NaN or "undefined" strings', async () => {
      mockBillingDB.payments.set('pay-nulls', {
        id: 'r-nulls',
        payment_id: 'pay-nulls',
        status: 'pending',
        plan: null as any,
        user_id: null as any,
        amount: null as any,
        currency: null as any,
        txn_id: null,
        confirmed_at: null,
        created_at: '2026-09-24T10:00:00Z',
        updated_at: '2026-09-24T10:00:00Z',
      });

      // Need user_id to match user query
      mockBillingDB.payments.get('pay-nulls')!.user_id = DEFAULT_USER.id;

      const req = createTestRequest('/api/payments/history', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.data.length).toBe(1);

      const item = res.data.data[0];
      expect(item.id).toBe('r-nulls');
      expect(item.paymentId).toBe('pay-nulls');
      expect(item.payment_id).toBe('pay-nulls');
      expect(item.orderId).toBe('pay-nulls');
      expect(item.status).toBe('pending');
      expect(item.plan).toBe(''); // Defaults to empty string, NOT null or 'undefined'
      expect(item.amount).toBe(0); // Defaults to 0, NOT NaN
      expect(item.currency).toBe('USDT'); // Defaults to USDT
      expect(item.txnId).toBeNull();
      expect(item.txn_id).toBeNull();
      expect(item.confirmedAt).toBeNull();
      expect(item.confirmed_at).toBeNull();
      expect(item.createdAt).toBe('2026-09-24T10:00:00Z');
      expect(item.created_at).toBe('2026-09-24T10:00:00Z');

      // Check payments alias array matches data array
      expect(res.data.payments).toEqual(res.data.data);
    });

    it('STRESS-FLD-02: Returns 500 if database query throws during history retrieval', async () => {
      const originalPrepare = mockBillingDB.prepare.bind(mockBillingDB);
      mockBillingDB.prepare = (sql: string) => {
        if (sql.toUpperCase().includes('FROM PAYMENTS')) {
          throw new Error('Database pool exhausted');
        }
        return originalPrepare(sql);
      };

      try {
        const req = createTestRequest('/api/payments/history', {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const res = await dispatchRoute('src/app/api/payments/history/route.ts', 'GET', req);
        expect(res.status).toBe(500);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/exhausted/i);
      } finally {
        mockBillingDB.prepare = originalPrepare;
      }
    });
  });
});
