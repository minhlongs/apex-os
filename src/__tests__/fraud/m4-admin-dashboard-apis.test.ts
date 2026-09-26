/**
 * Milestone 4: Admin Dashboard & APIs Comprehensive Test Suite
 * Location: src/__tests__/fraud/m4-admin-dashboard-apis.test.ts
 *
 * Covers:
 * 1. Authentication & RBAC Guard (401 unauthenticated, 403 non-admin)
 * 2. Clicks Listing API (GET /api/admin/fraud/clicks) with pagination & filters
 * 3. Stats Aggregation API (GET /api/admin/fraud/stats)
 * 4. Actions API (POST /api/admin/fraud/actions) & Audit Logger (Feature F12)
 * 5. Blocked IPs Management (GET, POST, DELETE /api/admin/fraud/blocked-ips)
 * 6. Immutability Invariant on fraud_reviews (triggers abort UPDATE/DELETE)
 * 7. Attribution Restoration in Matcher.resolveClick
 * 8. UI Components and Navigation Integrity
 */

import fs from 'fs';
import path from 'path';
import {
  setupFraudTestEnvironment,
  mockFraudDB,
  createFraudTestRequest,
  dispatchRoute,
} from './fraud-test-harness';
import { recordFraudDecision } from '@/lib/fraud/fraud-engine';
import { Matcher } from '@/lib/tracking/matcher';
import { FraudReasonCode } from '@/types/fraud';

describe('Milestone 4: Admin Fraud Dashboard & APIs (Features F10, F11, F12)', () => {
  beforeAll(() => {
    setupFraudTestEnvironment();
  });

  beforeEach(() => {
    mockFraudDB.reset();
  });

  // ==========================================================================
  // Section 1: Authentication & RBAC Guards
  // ==========================================================================
  describe('1. Authentication & RBAC Security Guards', () => {
    it('returns 401 Unauthorized for unauthenticated GET /api/admin/fraud/clicks', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks', {
        method: 'GET',
        admin: false,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.implemented).toBe(true);
      expect([401, 403]).toContain(res.status);
    });

    it('returns 403 Forbidden for authenticated non-admin GET /api/admin/fraud/clicks', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks', {
        method: 'GET',
        affiliate: true, // Non-admin user
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.implemented).toBe(true);
      expect(res.status).toBe(403);
    });

    it('returns 401 Unauthorized for unauthenticated POST /api/admin/fraud/actions', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: false,
        body: { action: 'approve', clickId: 'c-test', reason: 'Unauth attempt' },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.implemented).toBe(true);
      expect([401, 403]).toContain(res.status);
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 403 Forbidden for authenticated non-admin POST /api/admin/fraud/actions', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        affiliate: true,
        body: { action: 'approve', clickId: 'c-test', reason: 'Non-admin attempt' },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.implemented).toBe(true);
      expect(res.status).toBe(403);
      expect(mockFraudDB.fraudReviews.size).toBe(0);
    });

    it('returns 401 Unauthorized for unauthenticated GET /api/admin/fraud/stats', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: false,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', req);
      expect(res.implemented).toBe(true);
      expect([401, 403]).toContain(res.status);
    });

    it('returns 401 Unauthorized for unauthenticated GET /api/admin/fraud/blocked-ips', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'GET',
        admin: false,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
      expect(res.implemented).toBe(true);
      expect([401, 403]).toContain(res.status);
    });

    it('allows authenticated administrator to access fraud endpoints', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', req);
      expect(res.implemented).toBe(true);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
    });

    it('strictly rejects unauthenticated requests even if x-test-admin: true is present', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: false,
        headers: { 'x-test-admin': 'true' },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', req);
      expect(res.status).toBe(401);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/unauthorized|session/i);
    });
  });

  // ==========================================================================
  // Section 2: Clicks Listing API & Filters (GET /api/admin/fraud/clicks)
  // ==========================================================================
  describe('2. Clicks Listing API & Multi-Dimensional Filtering', () => {
    beforeEach(() => {
      // Seed test clicks
      mockFraudDB.dealClicks.set('click-s1', {
        id: 'click-s1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-top',
        affiliate_id: 'usr-aff-1',
        session_id: 'sess-1',
        ip_address: '198.51.100.1',
        user_agent: 'curl/7.68.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.85,
        review_status: 'pending',
        reviewed_at: null,
        reviewed_by: null,
        created_at: new Date(Date.now() - 3600 * 1000).toISOString(),
      });

      mockFraudDB.dealClicks.set('click-s2', {
        id: 'click-s2',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-suspect',
        affiliate_id: 'usr-aff-2',
        session_id: 'sess-2',
        ip_address: '198.51.100.2',
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'VN',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1,
        flag_reasons: '["HIGH_CLICK_CONVERSION_RATIO"]',
        anomaly_score: 0.72,
        review_status: 'rejected',
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'usr-admin-1',
        created_at: new Date(Date.now() - 7200 * 1000).toISOString(),
      });

      mockFraudDB.dealClicks.set('click-clean', {
        id: 'click-clean',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-clean',
        affiliate_id: 'usr-aff-3',
        session_id: 'sess-3',
        ip_address: '198.51.100.3',
        user_agent: 'Safari',
        referrer_url: null,
        country_code: 'US',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        flag_reasons: '[]',
        anomaly_score: 0.0,
        review_status: null,
        reviewed_at: null,
        reviewed_by: null,
        created_at: new Date().toISOString(),
      });
    });

    it('returns only suspicious clicks by default with pagination metadata', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=1&limit=10', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);

      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(2);
      expect(items.every((c: any) => c.isSuspicious === true)).toBe(true);
      expect(res.data.pagination.page).toBe(1);
      expect(res.data.pagination.limit).toBe(10);
    });

    it('filters clicks by review_status = pending', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?status=pending', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('click-s1');
      expect(items[0].reviewStatus).toBe('pending');
    });

    it('filters clicks by review_status = approved and returns approved click records', async () => {
      mockFraudDB.dealClicks.set('click-approved-1', {
        id: 'click-approved-1',
        deal_id: 'deal-active-1',
        affiliate_code: 'aff-top',
        affiliate_id: 'usr-aff-1',
        session_id: 'sess-app-1',
        ip_address: '198.51.100.5',
        user_agent: 'Mozilla/5.0',
        referrer_url: null,
        country_code: 'US',
        device_type: 'desktop',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 0,
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.0,
        review_status: 'approved',
        reviewed_at: new Date().toISOString(),
        reviewed_by: 'usr-admin-1',
        created_at: new Date().toISOString(),
      });

      const req = createFraudTestRequest('/api/admin/fraud/clicks?status=approved', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('click-approved-1');
      expect(items[0].reviewStatus).toBe('approved');
      expect(items[0].isSuspicious).toBe(false);
    });

    it('filters clicks by review_status = rejected', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?status=rejected', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('click-s2');
      expect(items[0].reviewStatus).toBe('rejected');
      expect(items[0].isSuspicious).toBe(true);
    });

    it('filters clicks by review_status = all (excludes clean clicks)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?status=all', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const items = res.data.clicks || res.data.data;
      const ids = items.map((c: any) => c.id);
      expect(ids).toContain('click-s1');
      expect(ids).toContain('click-s2');
      expect(ids).not.toContain('click-clean');
    });

    it('filters clicks by reason = BURST_CLICK', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?reason=BURST_CLICK', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(1);
      expect(items[0].id).toBe('click-s1');
      expect(items[0].flagReasons).toContain('BURST_CLICK');
    });

    it('handles boundary: page=0 defaults to page 1', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=0&limit=5', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.page).toBe(1);
    });

    it('handles boundary: limit=1000000 capped to 100', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?page=1&limit=1000000', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      expect(res.data.pagination.limit).toBe(100);
    });

    it('handles boundary: non-existent filter produces empty list without crashing', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/clicks?reason=IMPOSSIBLE_CODE', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/clicks/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const items = res.data.clicks || res.data.data;
      expect(items.length).toBe(0);
    });
  });

  // ==========================================================================
  // Section 3: Stats Aggregation API (GET /api/admin/fraud/stats)
  // ==========================================================================
  describe('3. Real-Time Telemetry & Stats Aggregation', () => {
    it('aggregates total clicks, flagged volume, and review statuses correctly', async () => {
      mockFraudDB.dealClicks.set('c1', {
        id: 'c1',
        deal_id: 'deal-1',
        affiliate_code: 'aff-top',
        ip_address: '10.0.0.1',
        is_suspicious: 1,
        flag_reasons: '["BURST_CLICK"]',
        review_status: 'pending',
        created_at: new Date().toISOString(),
      } as any);

      mockFraudDB.dealClicks.set('c2', {
        id: 'c2',
        deal_id: 'deal-1',
        affiliate_code: 'aff-top',
        ip_address: '10.0.0.1',
        is_suspicious: 0,
        flag_reasons: '["HIGH_CLICK_CONVERSION_RATIO"]',
        review_status: 'approved',
        created_at: new Date().toISOString(),
      } as any);

      mockFraudDB.dealClicks.set('c3', {
        id: 'c3',
        deal_id: 'deal-1',
        affiliate_code: 'aff-other',
        ip_address: '10.0.0.2',
        is_suspicious: 0,
        flag_reasons: '[]',
        review_status: null,
        created_at: new Date().toISOString(),
      } as any);

      mockFraudDB.blockedIps.set('10.0.0.1', {
        id: 'b1',
        ip_address: '10.0.0.1',
        reason: 'Rate limit violation',
        blocked_by: 'usr-admin-1',
        is_active: 1,
        created_at: new Date().toISOString(),
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const stats = res.data.stats || res.data.data;
      expect(stats.totalClicksEvaluated).toBe(3);
      expect(stats.totalFlaggedClicks).toBe(2);
      expect(stats.flaggedPercentage).toBeCloseTo(66.67, 1);
      expect(stats.pendingReviews).toBe(1);
      expect(stats.approvedReviews).toBe(1);
      expect(stats.totalBlockedIps).toBe(1);
      expect(stats.burstClicksCount).toBe(1);
      expect(stats.ratioAnomaliesCount).toBe(1);
      expect(stats.topFlaggedAffiliates[0].affiliateCode).toBe('aff-top');
    });

    it('handles 0 clicks without division-by-zero or NaN (F10-B2)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/stats', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/stats/route.ts', 'GET', req);
      expect(res.status).toBe(200);

      const stats = res.data.stats || res.data.data;
      expect(stats.totalClicksEvaluated).toBe(0);
      expect(stats.totalFlaggedClicks).toBe(0);
      expect(stats.flaggedPercentage).toBe(0);
      expect(isNaN(stats.flaggedPercentage)).toBe(false);
    });
  });

  // ==========================================================================
  // Section 4: Actions API & Audit Logger (POST /api/admin/fraud/actions)
  // ==========================================================================
  describe('4. Review Actions & Atomic Audit Logging (F11 + F12)', () => {
    it('rejects invalid action string with 400 Bad Request (F11-B4)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'malicious_injection_operation',
          clickId: 'c1',
          reason: 'Test invalid',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('rejects empty or whitespace reason with 400 Bad Request (F11-B5)', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'c1',
          reason: '   ',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
    });

    it('rejects reason shorter than 3 characters with 400 Bad Request', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'c1',
          reason: 'ab',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(400);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/at least 3 characters/i);
    });

    it('returns 404 Not Found when attempting action on non-existent click ID', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-non-existent-12345',
          reason: 'Valid review reason',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(404);
      expect(res.data.success).toBe(false);
      expect(res.data.error).toMatch(/not found/i);
    });

    it('executes single click approval: clears suspicion and writes audit record', async () => {
      mockFraudDB.dealClicks.set('click-approve-test', {
        id: 'click-approve-test',
        deal_id: 'deal-1',
        is_suspicious: 1,
        anomaly_score: 0.85,
        review_status: 'pending',
        created_at: new Date().toISOString(),
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'approve',
          clickId: 'click-approve-test',
          reason: 'Verified legitimate mobile reconnect',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.affectedCount).toBe(1);
      expect(res.data.reviewId).toBeDefined();

      // Verify deal_clicks state
      const updatedClick = mockFraudDB.dealClicks.get('click-approve-test');
      expect(updatedClick?.is_suspicious).toBe(0);
      expect(updatedClick?.anomaly_score).toBe(0.0);
      expect(updatedClick?.review_status).toBe('approved');
      expect(updatedClick?.reviewed_at).toBeDefined();

      // Verify audit record in fraud_reviews
      expect(mockFraudDB.fraudReviews.size).toBe(1);
      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.click_id).toBe('click-approve-test');
      expect(audit.action).toBe('approve');
      expect(audit.reason).toBe('Verified legitimate mobile reconnect');
      expect(audit.reviewer_id).toBe('usr-admin-1');
    });

    it('executes single click rejection: confirms suspicion and writes audit record', async () => {
      mockFraudDB.dealClicks.set('click-reject-test', {
        id: 'click-reject-test',
        deal_id: 'deal-1',
        is_suspicious: 1,
        review_status: 'pending',
        created_at: new Date().toISOString(),
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'reject',
          clickId: 'click-reject-test',
          reason: 'Confirmed curl script attack',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);

      const updated = mockFraudDB.dealClicks.get('click-reject-test');
      expect(updated?.is_suspicious).toBe(1);
      expect(updated?.review_status).toBe('rejected');

      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.action).toBe('reject');
      expect(audit.click_id).toBe('click-reject-test');
    });

    it('executes block_ip action: updates blocked_ips and writes audit record', async () => {
      const targetIp = '198.51.100.99';
      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'block_ip',
          ip: targetIp,
          reason: 'Abusive click flooding IP',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(mockFraudDB.blockedIps.has(targetIp)).toBe(true);

      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.ip_address).toBe(targetIp);
      expect(audit.action).toBe('block_ip');
    });

    it('executes bulk_resolve across multiple clicks in atomic batch', async () => {
      ['c-bulk-1', 'c-bulk-2', 'c-bulk-3'].forEach((id) => {
        mockFraudDB.dealClicks.set(id, {
          id,
          deal_id: 'deal-1',
          is_suspicious: 1,
          review_status: 'pending',
          created_at: new Date().toISOString(),
        } as any);
      });

      const req = createFraudTestRequest('/api/admin/fraud/actions', {
        method: 'POST',
        admin: true,
        body: {
          action: 'bulk_resolve',
          clickIds: ['c-bulk-1', 'c-bulk-2', 'c-bulk-3'],
          resolution: 'approve',
          reason: 'Batch verified marketing affiliate burst',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/actions/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(res.data.affectedCount).toBe(3);

      ['c-bulk-1', 'c-bulk-2', 'c-bulk-3'].forEach((id) => {
        const c = mockFraudDB.dealClicks.get(id);
        expect(c?.is_suspicious).toBe(0);
        expect(c?.review_status).toBe('approved');
      });

      // 3 distinct immutable audit records written
      expect(mockFraudDB.fraudReviews.size).toBe(3);
    });
  });

  // ==========================================================================
  // Section 5: Blocked IPs API (GET, POST, DELETE /api/admin/fraud/blocked-ips)
  // ==========================================================================
  describe('5. Blocked IPs CRUD & Management', () => {
    it('GET /api/admin/fraud/blocked-ips lists and searches blocked IPs', async () => {
      mockFraudDB.blockedIps.set('198.51.100.11', {
        id: 'b-11',
        ip_address: '198.51.100.11',
        reason: 'Bot network crawler',
        blocked_by: 'usr-admin-1',
        is_active: 1,
        created_at: new Date().toISOString(),
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?search=198.51.100.11', {
        method: 'GET',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'GET', req);
      expect(res.status).toBe(200);
      const data = res.data.data || res.data.blockedIps;
      expect(data.length).toBe(1);
      expect(data[0].ipAddress).toBe('198.51.100.11');
      expect(data[0].isActive).toBe(true);
    });

    it('POST /api/admin/fraud/blocked-ips adds new IP block with audit log', async () => {
      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips', {
        method: 'POST',
        admin: true,
        body: {
          ipAddress: '198.51.100.55',
          reason: 'Manual blacklist addition',
        },
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'POST', req);
      expect(res.status).toBe(200);
      expect(mockFraudDB.blockedIps.has('198.51.100.55')).toBe(true);
      expect(mockFraudDB.fraudReviews.size).toBe(1);
    });

    it('DELETE /api/admin/fraud/blocked-ips removes block and records audit log', async () => {
      mockFraudDB.blockedIps.set('198.51.100.77', {
        id: 'b-77',
        ip_address: '198.51.100.77',
        reason: 'Temporary ban',
        blocked_by: 'usr-admin-1',
        is_active: 1,
        created_at: new Date().toISOString(),
      } as any);

      const req = createFraudTestRequest('/api/admin/fraud/blocked-ips?ip=198.51.100.77&reason=Pardoned', {
        method: 'DELETE',
        admin: true,
      });

      const res = await dispatchRoute('src/app/api/admin/fraud/blocked-ips/route.ts', 'DELETE', req);
      expect(res.status).toBe(200);
      expect(mockFraudDB.blockedIps.has('198.51.100.77')).toBe(false);

      const audit = Array.from(mockFraudDB.fraudReviews.values())[0];
      expect(audit.action).toBe('unblock_ip');
      expect(audit.ip_address).toBe('198.51.100.77');
    });
  });

  // ==========================================================================
  // Section 6: Immutability Invariant on fraud_reviews
  // ==========================================================================
  describe('6. Immutable Audit Log Security Invariant (Feature F12)', () => {
    it('strictly aborts UPDATE on fraud_reviews via trigger', async () => {
      mockFraudDB.prepare(`
        INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
        VALUES (?, ?, ?, ?, ?)
      `).bind('rev-safe-1', 'c-1', 'usr-admin-1', 'approve', 'Initial review').run();

      await expect(
        mockFraudDB.prepare("UPDATE fraud_reviews SET reason = 'tampered' WHERE id = 'rev-safe-1'").run()
      ).rejects.toThrow(/cannot modify immutable table/i);
    });

    it('strictly aborts DELETE on fraud_reviews via trigger', async () => {
      mockFraudDB.prepare(`
        INSERT INTO fraud_reviews (id, click_id, reviewer_id, action, reason)
        VALUES (?, ?, ?, ?, ?)
      `).bind('rev-safe-2', 'c-2', 'usr-admin-1', 'reject', 'Initial rejection').run();

      await expect(
        mockFraudDB.prepare("DELETE FROM fraud_reviews WHERE id = 'rev-safe-2'").run()
      ).rejects.toThrow(/cannot modify immutable table/i);
    });
  });

  // ==========================================================================
  // Section 7: Attribution Restoration in Matcher.resolveClick
  // ==========================================================================
  describe('7. Conversion Attribution Restoration Lifecycle', () => {
    it('restores commission attribution instantly when suspicious click is approved', async () => {
      const clickId = 'click-restoration-test';
      const dealId = 'deal-active-1';
      const userWallet = '0x1111111111111111111111111111111111111111';

      // 1. Initial state: click flagged as suspicious
      mockFraudDB.dealClicks.set(clickId, {
        id: clickId,
        deal_id: dealId,
        affiliate_code: 'usr-affiliate-1',
        affiliate_id: 'usr-trader-1',
        session_id: 'sess-restore',
        ip_address: '198.51.100.88',
        user_agent: 'Mobile Safari',
        referrer_url: null,
        country_code: 'US',
        device_type: 'mobile',
        click_type: 'link',
        is_unique: 1,
        is_suspicious: 1, // Flagged!
        flag_reasons: '["BURST_CLICK"]',
        anomaly_score: 0.85,
        review_status: 'pending',
        created_at: new Date().toISOString(),
      });

      const matcher = new Matcher(mockFraudDB as any);

      // 2. Pre-approval match attempt fails: click ignored
      const preResult = await matcher.match({
        dealId,
        userIdentifier: userWallet,
        tradeVolumeUsd: 1000,
      });
      expect(preResult.click).toBeNull();
      expect(preResult.totalCommission).toBe(0);

      // 3. Admin approves click via recordFraudDecision service
      const decision = await recordFraudDecision(mockFraudDB, {
        action: 'approve',
        clickId,
        reason: 'Customer appeal verified legitimate mobile click',
        reviewerId: 'usr-admin-1',
      });
      expect(decision.success).toBe(true);

      // 4. Post-approval match attempt succeeds immediately
      const postResult = await matcher.match({
        dealId,
        userIdentifier: userWallet,
        tradeVolumeUsd: 1000,
      });
      expect(postResult.click?.id).toBe(clickId);
      expect(postResult.totalCommission).toBe(30); // 1000 * 0.10 * 0.30
    });
  });

  // ==========================================================================
  // Section 8: UI Components & Navigation File Integrity
  // ==========================================================================
  describe('8. UI Components and Navigation Integrity (Feature F10)', () => {
    it('verifies /admin/fraud navigation item in admin-nav.tsx', () => {
      const navPath = path.resolve(process.cwd(), 'src/components/admin/admin-nav.tsx');
      expect(fs.existsSync(navPath)).toBe(true);
      const content = fs.readFileSync(navPath, 'utf8');
      expect(content).toContain('/admin/fraud');
      expect(content).toContain('ShieldAlert');
    });

    it('verifies /admin/fraud navigation item in admin/layout.tsx', () => {
      const layoutPath = path.resolve(process.cwd(), 'src/app/admin/layout.tsx');
      expect(fs.existsSync(layoutPath)).toBe(true);
      const content = fs.readFileSync(layoutPath, 'utf8');
      expect(content).toContain('/admin/fraud');
      expect(content).toContain('Fraud Detection');
    });

    it('verifies localized fraud translations in en.json and vi.json', () => {
      const enPath = path.resolve(process.cwd(), 'src/i18n/messages/en.json');
      const viPath = path.resolve(process.cwd(), 'src/i18n/messages/vi.json');

      const en = JSON.parse(fs.readFileSync(enPath, 'utf8'));
      const vi = JSON.parse(fs.readFileSync(viPath, 'utf8'));

      expect(en.admin.nav.fraud).toBe('Fraud & Risk');
      expect(en.admin.fraud.title).toBe('Fraud Review Dashboard');

      expect(vi.admin.nav.fraud).toBe('Phát hiện gian lận');
      expect(vi.admin.fraud.title).toBe('Bảng điều khiển kiểm tra gian lận');
    });

    it('verifies page routes exist', () => {
      const locPage = path.resolve(process.cwd(), 'src/app/[locale]/admin/fraud/page.tsx');
      const unlocPage = path.resolve(process.cwd(), 'src/app/admin/fraud/page.tsx');

      expect(fs.existsSync(locPage)).toBe(true);
      expect(fs.existsSync(unlocPage)).toBe(true);
    });

    it('verifies all fraud dashboard UI components exist in src/components/admin/fraud/', () => {
      const compDir = path.resolve(process.cwd(), 'src/components/admin/fraud');
      const requiredFiles = [
        'index.ts',
        'FraudDashboard.tsx',
        'FraudHeader.tsx',
        'FraudKpiCards.tsx',
        'FraudFilterToolbar.tsx',
        'FlaggedClicksTable.tsx',
        'AnomalyBreakdownDrawer.tsx',
        'BulkActionBar.tsx',
        'BlockIpModal.tsx',
        'BulkActionModal.tsx',
        'BlockedIpsView.tsx',
        'AuditTrailView.tsx',
      ];

      requiredFiles.forEach((file) => {
        expect(fs.existsSync(path.join(compDir, file))).toBe(true);
      });
    });
  });
});
