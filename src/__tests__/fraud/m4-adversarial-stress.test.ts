/**
 * Milestone 4 Adversarial Stress Test Suite
 * Location: src/__tests__/fraud/m4-adversarial-stress.test.ts
 *
 * EMPIRICAL ADVERSARIAL STRESS HARNESS
 * Tests:
 * 1. Comprehensive RBAC Authentication Guard across ALL Admin Fraud API routes:
 *    - Unauthenticated (missing/invalid headers/cookies) -> 401 Unauthorized
 *    - Authenticated non-admin role (affiliate/trader) -> 403 Forbidden
 *    - Authenticated admin role -> 200 OK
 * 2. Pagination and Input Clamping Stress:
 *    - Negative page numbers (page=-5, page=-999) -> clamped to page 1
 *    - Zero page number (page=0) -> clamped to page 1
 *    - Zero limit (limit=0) -> clamped to default limit
 *    - Extreme limits (limit=5000, limit=1000000) -> clamped to max limit 100
 *    - Non-numeric / malformed page and limit values
 *    - Empty or whitespace-only reason for review action -> 400 Bad Request
 *    - Unknown action types -> 400 Bad Request
 *    - Non-existent click IDs -> 404 or graceful handling with 0 affected count
 * 3. Filter Combinations & Search Stress:
 *    - Simultaneous filter by reason + affiliate + date range + status
 *    - Partial search by IP or click ID
 */

import {
  setupFraudTestEnvironment,
  mockFraudDB,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import { FraudReasonCode } from '@/types/fraud';

describe('M4 Adversarial Stress Harness: Admin Fraud APIs (Feature F11)', () => {
  beforeAll(() => {
    setupFraudTestEnvironment();
  });

  beforeEach(() => {
    mockFraudDB.reset();
  });

  // ==========================================================================
  // 1. RBAC Authentication Guard Across ALL Admin Fraud Endpoints
  // ==========================================================================
  describe('1. RBAC Authentication Guard Stress Test', () => {
    const adminEndpoints: Array<{
      name: string;
      route: string;
      method: 'GET' | 'POST' | 'DELETE';
      body?: any;
    }> = [
      {
        name: 'GET /api/admin/fraud/clicks',
        route: 'src/app/api/admin/fraud/clicks/route.ts',
        method: 'GET',
      },
      {
        name: 'GET /api/admin/fraud/stats',
        route: 'src/app/api/admin/fraud/stats/route.ts',
        method: 'GET',
      },
      {
        name: 'POST /api/admin/fraud/actions',
        route: 'src/app/api/admin/fraud/actions/route.ts',
        method: 'POST',
        body: { action: 'approve', clickId: 'c-test', reason: 'RBAC verification' },
      },
      {
        name: 'GET /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'GET',
      },
      {
        name: 'POST /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'POST',
        body: { ipAddress: '198.51.100.99', reason: 'RBAC verification' },
      },
      {
        name: 'DELETE /api/admin/fraud/blocked-ips',
        route: 'src/app/api/admin/fraud/blocked-ips/route.ts',
        method: 'DELETE',
        body: { ipAddress: '198.51.100.99', reason: 'RBAC verification' },
      },
    ];

    adminEndpoints.forEach(({ name, route, method, body }) => {
      describe(name, () => {
        it('rejects unauthenticated requests with 401 Unauthorized', async () => {
          const req = createFraudTestRequest(
            name.split(' ')[1],
            {
              method,
              admin: false,
              body,
            }
          );

          const res = await dispatchRoute(route, method, req);
          expect(res.implemented).toBe(true);
          expect(res.status).toBe(401);
          expect(res.data?.success).toBe(false);
          expect(res.data?.error).toMatch(/unauthorized|session/i);
        });

        it('rejects authenticated non-admin requests with 403 Forbidden', async () => {
          const req = createFraudTestRequest(
            name.split(' ')[1],
            {
              method,
              affiliate: true, // Non-admin user role
              body,
            }
          );

          const res = await dispatchRoute(route, method, req);
          expect(res.implemented).toBe(true);
          expect(res.status).toBe(403);
          expect(res.data?.success).toBe(false);
          expect(res.data?.error).toMatch(/forbidden|privileges/i);
        });

        it('permits authenticated administrator requests with 200 OK', async () => {
          // Pre-seed any required state so valid admin calls succeed
          if (name.includes('DELETE')) {
            mockFraudDB.blockedIps.set('198.51.100.99', {
              id: 'b-99',
              ip_address: '198.51.100.99',
              reason: 'Pre-seeded for delete test',
              blocked_by: 'usr-admin-1',
              is_active: 1,
              created_at: new Date().toISOString(),
            } as any);
          }
          if (name.includes('actions')) {
            mockFraudDB.dealClicks.set('c-test', {
              id: 'c-test',
              deal_id: 'deal-1',
              is_suspicious: 1,
              review_status: 'pending',
              created_at: new Date().toISOString(),
            } as any);
          }

          const req = createFraudTestRequest(
            name.split(' ')[1],
            {
              method,
              admin: true,
              body,
            }
          );

          const res = await dispatchRoute(route, method, req);
          expect(res.implemented).toBe(true);
          expect(res.status).toBe(200);
          expect(res.data?.success).toBe(true);
        });
      });
    });
  });

  // ==========================================================================
  // 2. Pagination and Input Clamping Stress Test
  // ==========================================================================
  describe('2. Pagination & Input Clamping Stress Test', () => {
    describe('Clicks Listing Pagination Clamping', () => {
      it('clamps negative page numbers (page=-5, page=-999) to page 1', async () => {
        for (const badPage of [-5, -999, -1]) {
          const req = createFraudTestRequest(`/api/admin/fraud/clicks?page=${badPage}&limit=10`, {
            method: 'GET',
            admin: true,
          });

          const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
          expect(res.status).toBe(200);
          expect(res.data.pagination.page).toBe(1);
        }
      });

      it('clamps page=0 to page 1', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/clicks?page=0&limit=10', {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.page).toBe(1);
      });

      it('clamps non-numeric page values to page 1', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/clicks?page=invalid_page&limit=10', {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.page).toBe(1);
      });

      it('clamps limit=0 to default limit (20)', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/clicks?page=1&limit=0', {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.limit).toBe(20);
      });

      it('clamps negative limit (limit=-25) to default limit (20)', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/clicks?page=1&limit=-25', {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.limit).toBe(20);
      });

      it('clamps extreme limit values (limit=5000, limit=1000000) to max limit 100', async () => {
        for (const extremeLimit of [5000, 1000000, 99999999]) {
          const req = createFraudTestRequest(`/api/admin/fraud/clicks?page=1&limit=${extremeLimit}`, {
            method: 'GET',
            admin: true,
          });

          const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
          expect(res.status).toBe(200);
          expect(res.data.pagination.limit).toBe(100);
        }
      });
    });

    describe('Blocked IPs Pagination Clamping', () => {
      it('clamps page=-5 and limit=0 in blocked-ips listing', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?page=-5&limit=0', {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.page).toBe(1);
        expect(res.data.pagination.limit).toBe(50); // Default limit for blocked IPs
      });

      it('clamps limit=5000 in blocked-ips listing to 100', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?page=1&limit=5000', {
          method: 'GET',
          admin: true,
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
        expect(res.status).toBe(200);
        expect(res.data.pagination.limit).toBe(100);
      });
    });

    describe('Review Action Reason & Type Boundary Validation', () => {
      it('rejects empty reason string with 400 Bad Request', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/actions', {
          method: 'POST',
          admin: true,
          body: {
            action: 'approve',
            clickId: 'c1',
            reason: '',
          },
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/reason/i);
      });

      it('rejects whitespace-only reason strings with 400 Bad Request', async () => {
        for (const badReason of ['   ', '\t', '\n\r  \n  ', '      ']) {
          const req = createFraudTestRequest('/api/admin/fraud/actions', {
            method: 'POST',
            admin: true,
            body: {
              action: 'approve',
              clickId: 'c1',
              reason: badReason,
            },
          });

          const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
          expect(res.status).toBe(400);
          expect(res.data.success).toBe(false);
          expect(res.data.error).toMatch(/reason/i);
        }
      });

      it('rejects missing reason property with 400 Bad Request', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/actions', {
          method: 'POST',
          admin: true,
          body: {
            action: 'approve',
            clickId: 'c1',
          },
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
      });

      it('rejects unknown action types with 400 Bad Request', async () => {
        const invalidActions = [
          'unknown_action',
          'DESTROY_ALL',
          'DROP TABLE deal_clicks',
          'admin_override',
          '',
          12345,
          null,
        ];

        for (const badAction of invalidActions) {
          const req = createFraudTestRequest('/api/admin/fraud/actions', {
            method: 'POST',
            admin: true,
            body: {
              action: badAction,
              clickId: 'c1',
              reason: 'Valid test reason',
            },
          });

          const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
          expect(res.status).toBe(400);
          expect(res.data.success).toBe(false);
          expect(res.data.error).toMatch(/action/i);
        }
      });

      it('rejects malformed JSON payload with 400 Bad Request', async () => {
        const req = createFraudTestRequest('/api/admin/fraud/actions', {
          method: 'POST',
          admin: true,
        });
        // Override json method to simulate syntax error
        (req as any).json = async () => {
          throw new SyntaxError('Unexpected token < in JSON at position 0');
        };

        const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
        expect(res.status).toBe(400);
        expect(res.data.success).toBe(false);
        expect(res.data.error).toMatch(/malformed json/i);
      });
    });

    describe('Non-Existent Click ID Handling', () => {
      it('handles non-existent click IDs with 404 or graceful handling with 0 affected count', async () => {
        const nonExistentId = 'click-non-existent-999999';

        const req = createFraudTestRequest('/api/admin/fraud/actions', {
          method: 'POST',
          admin: true,
          body: {
            action: 'approve',
            clickId: nonExistentId,
            reason: 'Reviewing non-existent click',
          },
        });

        const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
        // Authoritative Requirement: "Non-existent click IDs -> 404 or graceful handling with 0 affected count"
        if (res.status === 404) {
          expect(res.data.success).toBe(false);
          expect(res.data.error).toMatch(/not found/i);
        } else if (res.status === 200) {
          expect(res.data.affectedCount).toBe(0);
        } else {
          expect(res.status).toBe(404);
        }
      });
    });
  });

  // ==========================================================================
  // 3. Multi-Dimensional Filter Combinations & Search Stress Test
  // ==========================================================================
  describe('3. Multi-Dimensional Filter Combinations & Search Stress Test', () => {
    beforeEach(() => {
      // Seed rich dataset for filter combinations
      const now = Date.now();

      // Click 1: BURST_CLICK, aff-alpha, pending, 198.51.100.1, 1 hour ago
      mockFraudDB.dealClicks.set('click-combo-1', {
        id: 'click-combo-1',
        deal_id: 'deal-100',
        affiliate_code: 'aff-alpha',
        affiliate_id: 'usr-aff-alpha',
        session_id: 'sess-1',
        ip_address: '198.51.100.1',
        user_agent: 'Chrome/120.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
        anomaly_score: 0.85,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: new Date(now - 3600 * 1000).toISOString(),
      });

      // Click 2: HIGH_CLICK_CONVERSION_RATIO, aff-alpha, approved, 198.51.100.2, 2 hours ago
      mockFraudDB.dealClicks.set('click-combo-2', {
        id: 'click-combo-2',
        deal_id: 'deal-100',
        affiliate_code: 'aff-alpha',
        affiliate_id: 'usr-aff-alpha',
        session_id: 'sess-2',
        ip_address: '198.51.100.2',
        user_agent: 'Firefox/119.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify([FraudReasonCode.HIGH_CLICK_CONVERSION_RATIO]),
        anomaly_score: 0.75,
        review_status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'usr-admin-1',
        created_at: new Date(now - 7200 * 1000).toISOString(),
      });

      // Click 3: BURST_CLICK, aff-beta, pending, 203.0.113.50, 3 hours ago
      mockFraudDB.dealClicks.set('click-combo-3', {
        id: 'click-combo-3',
        deal_id: 'deal-200',
        affiliate_code: 'aff-beta',
        affiliate_id: 'usr-aff-beta',
        session_id: 'sess-3',
        ip_address: '203.0.113.50',
        user_agent: 'Safari/17.0',
        referrer_url: null,
        country_code: 'VN',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify([FraudReasonCode.BURST_CLICK]),
        anomaly_score: 0.90,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: new Date(now - 10800 * 1000).toISOString(),
      });

      // Click 4: RATE_LIMIT_EXCEEDED, aff-beta, rejected, 203.0.113.51, 24 hours ago
      mockFraudDB.dealClicks.set('click-combo-4', {
        id: 'click-combo-4',
        deal_id: 'deal-200',
        affiliate_code: 'aff-beta',
        affiliate_id: 'usr-aff-beta',
        session_id: 'sess-4',
        ip_address: '203.0.113.51',
        user_agent: 'curl/7.88',
        referrer_url: null,
        country_code: 'VN',
        device_type: 'server',
        click_type: 'direct',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: JSON.stringify([FraudReasonCode.RATE_LIMIT_EXCEEDED]),
        anomaly_score: 0.99,
        review_status: 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'usr-admin-1',
        created_at: new Date(now - 86400 * 1000).toISOString(),
      });

      // Click 5: Clean legitimate click (not suspicious)
      mockFraudDB.dealClicks.set('click-clean-1', {
        id: 'click-clean-1',
        deal_id: 'deal-100',
        affiliate_code: 'aff-alpha',
        affiliate_id: 'usr-aff-alpha',
        session_id: 'sess-clean',
        ip_address: '198.51.100.9',
        user_agent: 'Chrome/120.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        flag_reasons: '[]',
        anomaly_score: 0.0,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: new Date(now - 1800 * 1000).toISOString(),
      });
    });

    it('filters by status=pending alone returns only pending suspicious clicks', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?status=pending', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(2);
      expect(items.every((c: any) => c.reviewStatus === 'pending')).toBe(true);
    });

    it('filters by reason=BURST_CLICK alone returns only burst clicks', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?reason=BURST_CLICK', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(2);
      expect(items.every((c: any) => c.flagReasons.includes('BURST_CLICK'))).toBe(true);
    });

    it('filters by reason + affiliate + date range + status simultaneously', async () => {
      const now = Date.now();
      const dateFrom = new Date(now - 5 * 3600 * 1000).toISOString(); // 5 hours ago
      const dateTo = new Date(now).toISOString();

      const url = `/api/admin/fraud/clicks?reason=BURST_CLICK&affiliateCode=aff-alpha&status=pending&dateFrom=${encodeURIComponent(dateFrom)}&dateTo=${encodeURIComponent(dateTo)}`;
      const req = createFraudTestRequest(url, {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      // Should match ONLY click-combo-1:
      // - reason: BURST_CLICK
      // - affiliateCode: aff-alpha
      // - status: pending
      // - created_at: 1 hour ago (within [5h ago, now])
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('click-combo-1');
      expect(items[0].affiliateCode).toBe('aff-alpha');
      expect(items[0].reviewStatus).toBe('pending');
      expect(items[0].flagReasons).toContain('BURST_CLICK');
    });

    it('searches by partial IP (search=198.51)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?search=198.51', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(2);
      expect(items.every((c: any) => c.ipAddress.includes('198.51'))).toBe(true);
    });

    it('searches by partial click ID (search=combo-3)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?search=combo-3', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('click-combo-3');
    });

    it('searches by partial affiliate code (search=beta)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?search=beta', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(2);
      expect(items.every((c: any) => c.affiliateCode.includes('beta'))).toBe(true);
    });
  });
});
