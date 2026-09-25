/**
 * src/__tests__/billing/mobile-endpoints-m4.test.ts
 *
 * Comprehensive Milestone M4 Test Suite:
 * - Feature F7: Wallet Address Validation & Association (/api/profile/wallet)
 * - Feature F8: Device Push Token Registration (/api/notifications/register)
 * - Feature F9: Batched Deep-Link Analytics Ingestion (/api/profile/deep-link-analytics)
 *
 * Verifies all happy paths, boundary conditions, security constraints, and data persistence.
 */

import {
  mockBillingDB,
  setupBillingTestEnvironment,
  createTestRequest,
  DEFAULT_USER,
  SECOND_USER,
} from './billing-test-harness';

import * as walletRoute from '@/app/api/profile/wallet/route';
import * as notificationsRoute from '@/app/api/notifications/register/route';
import * as analyticsRoute from '@/app/api/profile/deep-link-analytics/route';

beforeAll(() => {
  setupBillingTestEnvironment();
});

beforeEach(() => {
  mockBillingDB.reset();
});

/**
 * Helper to dispatch request directly to proposed route handler and format response
 */
async function callRoute(handler: (req: any) => Promise<any>, req: any) {
  const res = await handler(req);
  let data: any = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  return {
    status: res.status,
    data,
    error: data?.error,
    success: data?.success,
  };
}

describe('Milestone M4: Mobile Wallet, Push, & Analytics Test Suite', () => {
  // ==========================================================================
  // Feature F7: Wallet Profile Association (POST, GET, DELETE /api/profile/wallet)
  // ==========================================================================
  describe('Feature F7: Wallet Profile Association', () => {
    const validEth = '0x742d35Cc6634C0532925a3b844Bc954e7595f0bE';
    const validSol = 'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH';
    const validStellar = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    it('F7-1: binds valid Ethereum address to user profile', async () => {
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: validEth, preferred_chain: 'ethereum' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.data.data.wallet_address).toBe(validEth);
      expect(res.data.data.preferred_chain).toBe('ethereum');

      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(prof?.wallet_address).toBe(validEth);
      expect(prof?.preferred_chain).toBe('ethereum');
    });

    it('F7-2: binds valid Solana address to user profile', async () => {
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: validSol, preferred_chain: 'solana' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.data.preferred_chain).toBe('solana');
      expect(res.data.data.wallet_address).toBe(validSol);
    });

    it('F7-3: binds valid Stellar address to user profile', async () => {
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: validStellar, preferred_chain: 'stellar' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.data.preferred_chain).toBe('stellar');
    });

    it('F7-4: rejects unsupported blockchain network with HTTP 400', async () => {
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa', preferred_chain: 'bitcoin' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/unsupported/i);
    });

    it('F7-5: rejects unauthenticated requests with HTTP 401 Unauthorized', async () => {
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: validEth, preferred_chain: 'ethereum' },
        authMethod: 'none',
        user: null,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(401);
      expect(res.error).toMatch(/unauthorized/i);
    });

    it('F7-B1: rejects Ethereum address missing 0x prefix with 400', async () => {
      const rawHexWithoutPrefix = '742d35Cc6634C0532925a3b844Bc954e7595f0bE';
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: rawHexWithoutPrefix, preferred_chain: 'ethereum' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/format|invalid/i);
    });

    it('F7-B2: rejects Ethereum address with invalid length (41 chars)', async () => {
      const shortEth = '0x742d35Cc6634C0532925a3b844Bc954e7595f0b';
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: shortEth, preferred_chain: 'ethereum' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(400);
    });

    it('F7-B3: rejects Solana address with illegal base58 characters (0, O, I, l)', async () => {
      const illegalSol = '0OIlABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH';
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: illegalSol, preferred_chain: 'solana' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(400);
    });

    it('F7-B4: rejects Solana address with length < 32', async () => {
      const shortSol = 'TooShortSolAddress';
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: shortSol, preferred_chain: 'solana' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(400);
    });

    it('F7-B5: rejects Stellar address not starting with G', async () => {
      const invalidStellar = 'MAM7BL3FGO44S2NTGG6SJ7I3W5X5Z5G5WOXWWR3RQYXK5E6GONAIRCGO';
      const req = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: invalidStellar, preferred_chain: 'stellar' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(walletRoute.POST, req);
      expect(res.status).toBe(400);
    });

    it('F7-6: queries wallet info via GET /api/profile/wallet', async () => {
      // First bind wallet
      const postReq = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: validEth, preferred_chain: 'ethereum' },
        user: DEFAULT_USER,
      });
      await callRoute(walletRoute.POST, postReq);

      // Now query via GET
      const getReq = createTestRequest('/api/profile/wallet', {
        method: 'GET',
        user: DEFAULT_USER,
      });
      const getRes = await callRoute(walletRoute.GET, getReq);
      expect(getRes.status).toBe(200);
      expect(getRes.data.data.wallet_address).toBe(validEth);
      expect(getRes.data.data.preferred_chain).toBe('ethereum');
    });

    it('F7-7: disconnects wallet via DELETE /api/profile/wallet', async () => {
      // First bind
      const postReq = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: validEth, preferred_chain: 'ethereum' },
        user: DEFAULT_USER,
      });
      await callRoute(walletRoute.POST, postReq);

      // Disconnect
      const delReq = createTestRequest('/api/profile/wallet', {
        method: 'DELETE',
        user: DEFAULT_USER,
      });
      const delRes = await callRoute(walletRoute.DELETE, delReq);
      expect(delRes.status).toBe(200);
      expect(delRes.data.disconnected).toBe(true);

      const prof = mockBillingDB.profiles.get(DEFAULT_USER.id);
      expect(prof?.wallet_address).toBeFalsy();
    });
  });

  // ==========================================================================
  // Feature F8: Device Push Token Registration (POST & DELETE /api/notifications/register)
  // ==========================================================================
  describe('Feature F8: Device Push Token Registration', () => {
    it('F8-1: registers Expo push token with platform ios', async () => {
      const expoToken = 'ExponentPushToken[xxxxxxxxxxxxxxxxxxxxxx]';
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken, platform: 'ios' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);

      const registered = mockBillingDB.deviceTokens.get(expoToken);
      expect(registered).toBeDefined();
      expect(registered?.user_id).toBe(DEFAULT_USER.id);
      expect(registered?.platform).toBe('ios');
    });

    it('F8-2: registers native APNs device token alongside Expo token for iOS', async () => {
      const expoToken = 'ExponentPushToken[apns_test_token]';
      const apnsToken = 'c9d4b0f9c9d4b0f9c9d4b0f9c9d4b0f9c9d4b0f9c9d4b0f9c9d4b0f9c9d4b0f9';

      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: {
          expoToken,
          platform: 'ios',
          apnsToken,
        },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);

      const registered = mockBillingDB.deviceTokens.get(expoToken);
      expect(registered?.apns_token).toBe(apnsToken);
    });

    it('F8-3: registers native FCM device token alongside Expo token for Android', async () => {
      const expoToken = 'ExponentPushToken[fcm_test_token]';
      const fcmToken = 'fM123:APA91b_test_fcm_token_sample_string_value';

      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: {
          expoToken,
          platform: 'android',
          fcmToken,
        },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);

      const registered = mockBillingDB.deviceTokens.get(expoToken);
      expect(registered?.platform).toBe('android');
      expect(registered?.fcm_token).toBe(fcmToken);
    });

    it('F8-4: unregisters device token via DELETE /api/notifications/register', async () => {
      const token = 'ExponentPushToken[to_be_deleted]';
      mockBillingDB.deviceTokens.set(token, {
        id: 'tok-del',
        user_id: DEFAULT_USER.id,
        expo_token: token,
        platform: 'ios',
        apns_token: null,
        fcm_token: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const req = createTestRequest('/api/notifications/register', {
        method: 'DELETE',
        body: { token },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.DELETE, req);
      expect(res.status).toBe(200);
      expect(res.data.removed).toBe(true);
      expect(mockBillingDB.deviceTokens.has(token)).toBe(false);
    });

    it('F8-5: rejects unauthenticated registration with HTTP 401', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: 'ExponentPushToken[unauth_test]', platform: 'ios' },
        authMethod: 'none',
        user: null,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(401);
    });

    it('F8-B1: rejects missing all push tokens ({ platform: ios }) with 400', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { platform: 'ios' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/required/i);
    });

    it('F8-B2: rejects invalid platform string (symbian, windows) with 400', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: 'ExponentPushToken[abc]', platform: 'symbian' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/platform/i);
    });

    it('F8-B3: device handover rebinds device token to new active user', async () => {
      const sharedToken = 'ExponentPushToken[shared_phone_token]';

      mockBillingDB.deviceTokens.set(sharedToken, {
        id: 'tok-1',
        user_id: DEFAULT_USER.id,
        expo_token: sharedToken,
        platform: 'ios',
        apns_token: null,
        fcm_token: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });

      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: sharedToken, platform: 'ios' },
        user: SECOND_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);

      const tok = mockBillingDB.deviceTokens.get(sharedToken);
      expect(tok?.user_id).toBe(SECOND_USER.id);
    });

    it('F8-B4: unregistering non-existent push token returns 200 idempotently', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'DELETE',
        body: { token: 'ExponentPushToken[never_registered_before]' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.DELETE, req);
      expect(res.status).toBe(200);
      expect(res.data.removed).toBe(true);
    });

    it('F8-B5: empty string push token ({ expoToken: "" }) is rejected with 400', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: '', platform: 'ios' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(400);
    });
  });

  // ==========================================================================
  // Feature F9: Batched Deep-Link Analytics Ingestion (POST /api/profile/deep-link-analytics)
  // ==========================================================================
  describe('Feature F9: Batched Deep-Link Analytics Ingestion', () => {
    it('F9-1: ingests valid batch of deep link navigation events returning 200', async () => {
      const events = [
        {
          kind: 'billing-result',
          route: 'apex-os://billing/result?paymentId=5000000001&status=completed',
          timestamp: '2026-09-24T18:00:00.000Z',
          source: 'notification',
        },
        {
          kind: 'wallet-connected',
          route: 'apex-os://wallet-connected?address=0x742d35Cc6634C0532925a3b844Bc954e7595f0bE&chain=ethereum',
          timestamp: '2026-09-24T18:05:00.000Z',
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.data.processed).toBe(2);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(2);
    });

    it('F9-2: ingests empty events batch { events: [] } returning 200 gracefully', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events: [] },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.data.processed).toBe(0);
    });

    it('F9-3: ingests deep link events from anonymous / unauthenticated mobile user', async () => {
      const events = [
        {
          kind: 'anon-click',
          route: 'apex-os://deals/crypto-bonus',
          timestamp: '2026-09-24T18:10:00.000Z',
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        authMethod: 'none',
        user: null,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.data.processed).toBe(1);

      const inserted = mockBillingDB.deepLinkAnalytics[mockBillingDB.deepLinkAnalytics.length - 1];
      expect(inserted.user_id).toBeNull();
      expect(inserted.kind).toBe('anon-click');
    });

    it('F9-4: persists events into database storage', async () => {
      const events = [
        {
          kind: 'audit-test',
          route: 'apex-os://billing/history',
          timestamp: '2026-09-24T18:15:00.000Z',
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics.some((e) => e.kind === 'audit-test')).toBe(true);
    });

    it('F9-5: ingests receipt deep-link event (apex-os://billing/receipt/:id)', async () => {
      const events = [
        {
          kind: 'receipt-view',
          route: 'apex-os://billing/receipt/5000000001',
          timestamp: '2026-09-24T18:20:00.000Z',
          source: 'notification',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(1);
    });

    it('F9-B1: ingests maximum batch size of 50 events without error', async () => {
      const events = Array.from({ length: 50 }, (_, i) => ({
        kind: `event_${i}`,
        route: `apex-os://route/${i}`,
        timestamp: new Date().toISOString(),
        source: 'notification',
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(50);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(50);
    });

    it('F9-B2: event with missing timestamp falls back to current ISO time', async () => {
      const events = [
        {
          kind: 'fallback-time',
          route: 'apex-os://home',
          timestamp: null as any,
          source: 'direct',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);

      const inserted = mockBillingDB.deepLinkAnalytics[mockBillingDB.deepLinkAnalytics.length - 1];
      expect(inserted.event_timestamp).toBeDefined();
      expect(inserted.event_timestamp.length).toBeGreaterThan(10);
    });

    it('F9-B3: event with invalid source defaults safely to direct without failing', async () => {
      const events = [
        {
          kind: 'source-test',
          route: 'apex-os://home',
          timestamp: new Date().toISOString(),
          source: 'unknown_source' as any,
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);

      const inserted = mockBillingDB.deepLinkAnalytics[mockBillingDB.deepLinkAnalytics.length - 1];
      expect(inserted.source).toBe('direct');
    });

    it('F9-B4: malformed raw non-JSON body returns 400 without crashing server', async () => {
      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: 'NOT_VALID_JSON{{{',
        headers: { 'content-type': 'application/json' },
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(400);
    });

    it('F9-B5: route with complex URL-encoded query params is preserved', async () => {
      const complexRoute = 'apex-os://billing/result?paymentId=5001&status=completed&source=push%20banner&ref=%2Fsettings';
      const events = [
        {
          kind: 'encoded-test',
          route: complexRoute,
          timestamp: new Date().toISOString(),
          source: 'notification',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);

      const inserted = mockBillingDB.deepLinkAnalytics[mockBillingDB.deepLinkAnalytics.length - 1];
      expect(inserted.route).toBe(complexRoute);
    });
  });
});
