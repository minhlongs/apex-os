/**
 * src/__tests__/billing/challenger-m5-mobile-integration.test.ts
 *
 * Phase 2: Tier 5 Adversarial Coverage Hardening
 * Mobile Endpoints & Integration Challenger Test Suite
 *
 * Authored by: teamwork_preview_challenger_m5_2
 * Role: EMPIRICAL CHALLENGER (Critic / Specialist)
 *
 * Target Routes:
 * - src/app/api/profile/wallet/route.ts (Feature F7: Multi-Chain Wallet Association)
 * - src/app/api/notifications/register/route.ts (Feature F8: Push Token Registration & Handover)
 * - src/app/api/profile/deep-link-analytics/route.ts (Feature F9: Deep-Link Analytics Ingestion)
 *
 * Adversarial Vectors Covered:
 * 1. Multi-chain address regex boundaries (Ethereum, Solana, Stellar)
 *    - Strict regex limits, non-hex/non-base58/non-base32 character sets, case sensitivity, length bounds
 *    - Chain switching, idempotent unbinding, and unauthenticated protections
 * 2. Push token registration & device handover
 *    - Expo, APNs (64-hex), FCM (long strings), generic tokens with provider fallback
 *    - Platform validation, device handover between users, unregistration idempotency
 * 3. Batched deep-link analytics ingestion
 *    - Scale bounds (0, 1, 50, 100 events), anonymous mobile client auth tolerance
 *    - Timestamp vs event_timestamp fallback, source normalization, route query preservation
 *    - Database column fallback resilience (event_timestamp -> timestamp)
 * 4. Cross-endpoint mobile lifecycle integration
 *    - Anonymous telemetry -> auth -> push registration -> wallet binding -> receipt navigation
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
 * Direct call helper for route handlers
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
    success: data?.success,
    error: data?.error,
    processed: data?.processed,
    registered: data?.registered,
    disconnected: data?.disconnected,
  };
}

describe('Tier 5 Adversarial Coverage Hardening: Mobile Endpoints & Integration', () => {
  // ==========================================================================
  // Section 1: Multi-Chain Address Regex Boundaries (Ethereum, Solana, Stellar)
  // ==========================================================================
  describe('1. Multi-Chain Address Regex Boundaries', () => {
    const validEthAddress = '0x1234567890abcdef1234567890abcdef12345678';
    const validSolAddress = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
    const validStellarAddress = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';

    describe('1.1 Ethereum Address Boundaries (/^0x[0-9a-fA-F]{40}$/)', () => {
      it('ETH-BOUND-01: accepts lowercase, uppercase, and mixed-case hex addresses', async () => {
        const addresses = [
          '0x' + 'a'.repeat(40),
          '0x' + 'A'.repeat(40),
          '0x' + '0123456789abcdefABCDEF0123456789abcdefAB',
        ];

        for (const addr of addresses) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: addr, preferred_chain: 'ethereum' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(200);
          expect(res.success).toBe(true);
          expect(res.data.data.wallet_address).toBe(addr);
        }
      });

      it('ETH-BOUND-02: rejects uppercase 0X prefix strictly', async () => {
        const upperPrefix = '0X' + 'a'.repeat(40);
        const req = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: upperPrefix, preferred_chain: 'ethereum' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(walletRoute.POST, req);
        expect(res.status).toBe(400);
        expect(res.error).toMatch(/format/i);
      });

      it('ETH-BOUND-03: rejects length off-by-one (39 hex characters total 41, 41 hex characters total 43)', async () => {
        const tooShort = '0x' + 'a'.repeat(39);
        const tooLong = '0x' + 'a'.repeat(41);

        for (const badAddr of [tooShort, tooLong]) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badAddr, preferred_chain: 'ethereum' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/format/i);
        }
      });

      it('ETH-BOUND-04: rejects non-hex characters in hex payload', async () => {
        const nonHexChars = ['g', 'z', 'K', '!', '@', '#', '$', '%', '^', '&', '*', ' '];
        for (const ch of nonHexChars) {
          const badAddr = '0x' + 'a'.repeat(39) + ch;
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badAddr, preferred_chain: 'ethereum' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });
    });

    describe('1.2 Solana Address Boundaries (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)', () => {
      it('SOL-BOUND-01: strictly rejects forbidden Base58 characters (0, O, I, l)', async () => {
        const forbiddenChars = ['0', 'O', 'I', 'l'];
        for (const ch of forbiddenChars) {
          // 43 char address with forbidden character at position 10
          const badAddr = '4k3Dyjzvzp' + ch + 'MZWUXbBCjEvwSkkk59S5iCNLY3QrkX6';
          expect(badAddr.length).toBe(42);
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badAddr, preferred_chain: 'solana' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/format/i);
        }
      });

      it('SOL-BOUND-02: accepts exact lower bound of 32 characters and upper bound of 44 characters', async () => {
        // 32-char all valid Base58
        const minLenAddr = '1'.repeat(32);
        // 44-char all valid Base58
        const maxLenAddr = 'z'.repeat(44);

        for (const validSol of [minLenAddr, maxLenAddr]) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: validSol, preferred_chain: 'solana' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(200);
          expect(res.data.data.wallet_address).toBe(validSol);
        }
      });

      it('SOL-BOUND-03: rejects length off-by-one (31 chars and 45 chars)', async () => {
        const tooShort = '1'.repeat(31);
        const tooLong = '1'.repeat(45);

        for (const badSol of [tooShort, tooLong]) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badSol, preferred_chain: 'solana' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });
    });

    describe('1.3 Stellar Address Boundaries (/^G[A-Z2-7]{55}$/)', () => {
      it('STELLAR-BOUND-01: strictly rejects lowercase g prefix or alternative public prefixes', async () => {
        const invalidPrefixes = ['g', 'S', 'M', '1', '0'];
        const base32Body = 'A'.repeat(55);

        for (const prefix of invalidPrefixes) {
          const badAddr = prefix + base32Body;
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badAddr, preferred_chain: 'stellar' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/format/i);
        }
      });

      it('STELLAR-BOUND-02: strictly rejects non-RFC4648 Base32 characters (0, 1, 8, 9, lowercase a-z)', async () => {
        const forbiddenChars = ['0', '1', '8', '9', 'a', 'b', 'z'];
        for (const ch of forbiddenChars) {
          const badAddr = 'G' + 'A'.repeat(54) + ch;
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badAddr, preferred_chain: 'stellar' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/format/i);
        }
      });

      it('STELLAR-BOUND-03: rejects length off-by-one (55 chars total, 57 chars total)', async () => {
        const tooShort = 'G' + 'A'.repeat(54); // 55 chars
        const tooLong = 'G' + 'A'.repeat(56); // 57 chars

        for (const badAddr of [tooShort, tooLong]) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badAddr, preferred_chain: 'stellar' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });
    });

    describe('1.4 Chain Switching, Inspection & Idempotent Disconnection', () => {
      it('CHAIN-01: allows sequential switching across Ethereum -> Solana -> Stellar', async () => {
        // Step 1: Bind ETH
        const req1 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: validEthAddress, preferred_chain: 'ethereum' },
          user: DEFAULT_USER,
        });
        const res1 = await callRoute(walletRoute.POST, req1);
        expect(res1.status).toBe(200);
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.preferred_chain).toBe('ethereum');

        // Step 2: Switch to SOL
        const req2 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: validSolAddress, preferred_chain: 'solana' },
          user: DEFAULT_USER,
        });
        const res2 = await callRoute(walletRoute.POST, req2);
        expect(res2.status).toBe(200);
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.preferred_chain).toBe('solana');
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.wallet_address).toBe(validSolAddress);

        // Step 3: Switch to Stellar
        const req3 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: validStellarAddress, preferred_chain: 'stellar' },
          user: DEFAULT_USER,
        });
        const res3 = await callRoute(walletRoute.POST, req3);
        expect(res3.status).toBe(200);
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.preferred_chain).toBe('stellar');
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.wallet_address).toBe(validStellarAddress);

        // Step 4: GET wallet inspect
        const reqGet = createTestRequest('/api/profile/wallet', {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const resGet = await callRoute(walletRoute.GET, reqGet);
        expect(resGet.status).toBe(200);
        expect(resGet.data.data.wallet_address).toBe(validStellarAddress);
        expect(resGet.data.data.preferred_chain).toBe('stellar');

        // Step 5: DELETE unbind wallet
        const reqDel1 = createTestRequest('/api/profile/wallet', {
          method: 'DELETE',
          user: DEFAULT_USER,
        });
        const resDel1 = await callRoute(walletRoute.DELETE, reqDel1);
        expect(resDel1.status).toBe(200);
        expect(resDel1.disconnected).toBe(true);
        expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.wallet_address).toBeFalsy();

        // Step 6: Repeated DELETE is idempotent
        const resDel2 = await callRoute(walletRoute.DELETE, reqDel1);
        expect(resDel2.status).toBe(200);
        expect(resDel2.disconnected).toBe(true);
      });

      it('CHAIN-02: rejects unsupported chains (bitcoin, avalanche, polygon) with 400', async () => {
        const unsupportedChains = ['bitcoin', 'avalanche', 'polygon', 'ripple', 'cardano'];
        for (const chain of unsupportedChains) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: validEthAddress, preferred_chain: chain },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/unsupported blockchain network/i);
        }
      });

      it('CHAIN-03: rejects unauthenticated requests across POST, GET, DELETE with 401', async () => {
        const reqPost = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: validEthAddress, preferred_chain: 'ethereum' },
          authMethod: 'none',
        });
        expect((await callRoute(walletRoute.POST, reqPost)).status).toBe(401);

        const reqGet = createTestRequest('/api/profile/wallet', {
          method: 'GET',
          authMethod: 'none',
        });
        expect((await callRoute(walletRoute.GET, reqGet)).status).toBe(401);

        const reqDel = createTestRequest('/api/profile/wallet', {
          method: 'DELETE',
          authMethod: 'none',
        });
        expect((await callRoute(walletRoute.DELETE, reqDel)).status).toBe(401);
      });
    });
  });

  // ==========================================================================
  // Section 2: Push Token Registration & Device Handover
  // ==========================================================================
  describe('2. Push Token Registration & Device Handover', () => {
    const sampleExpoToken = 'ExponentPushToken[e2e-tier5-sample-token-12345]';
    const sampleApnsToken = 'a'.repeat(64); // 64-char hex APNs token
    const sampleFcmToken = 'fcm_' + 'b'.repeat(250); // realistic long FCM token

    it('PUSH-01: registers dual native APNs and Expo tokens on iOS platform', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: {
          expoToken: sampleExpoToken,
          apnsToken: sampleApnsToken,
          platform: 'ios',
        },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.registered).toBe(true);
      expect(res.data.data.platform).toBe('ios');
      expect(res.data.data.apnsToken).toBe(sampleApnsToken);
      expect(res.data.data.expoToken).toBe(sampleExpoToken);

      const stored = mockBillingDB.deviceTokens.get(sampleExpoToken);
      expect(stored?.user_id).toBe(DEFAULT_USER.id);
      expect(stored?.apns_token).toBe(sampleApnsToken);
      expect(stored?.platform).toBe('ios');
    });

    it('PUSH-02: registers native FCM token on Android platform', async () => {
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: {
          fcmToken: sampleFcmToken,
          platform: 'android',
        },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.data.platform).toBe('android');
      expect(res.data.data.fcmToken).toBe(sampleFcmToken);

      const stored = mockBillingDB.deviceTokens.get(sampleFcmToken);
      expect(stored?.user_id).toBe(DEFAULT_USER.id);
      expect(stored?.platform).toBe('android');
    });

    it('PUSH-03: handles device handover - rebinds existing physical device token from User A to User B', async () => {
      const hardwareToken = 'ExponentPushToken[shared-physical-iphone-device]';

      // Step 1: User A registers physical device
      const reqUserA = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: hardwareToken, platform: 'ios' },
        user: DEFAULT_USER,
      });
      const resA = await callRoute(notificationsRoute.POST, reqUserA);
      expect(resA.status).toBe(200);
      expect(mockBillingDB.deviceTokens.get(hardwareToken)?.user_id).toBe(DEFAULT_USER.id);

      // Step 2: Device handover: User B logs into same phone and registers token
      const reqUserB = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: hardwareToken, platform: 'ios' },
        user: SECOND_USER,
      });
      const resB = await callRoute(notificationsRoute.POST, reqUserB);
      expect(resB.status).toBe(200);

      // Step 3: Hardware device token is now bound to User B
      const currentToken = mockBillingDB.deviceTokens.get(hardwareToken);
      expect(currentToken?.user_id).toBe(SECOND_USER.id);
    });

    it('PUSH-04: resolves generic token parameter with provider overrides safely', async () => {
      // Case A: generic token with provider='apns'
      const reqApns = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { token: sampleApnsToken, provider: 'apns' },
        user: DEFAULT_USER,
      });
      const resApns = await callRoute(notificationsRoute.POST, reqApns);
      expect(resApns.status).toBe(200);
      expect(resApns.data.data.apnsToken).toBe(sampleApnsToken);

      // Case B: generic token with provider='fcm'
      const reqFcm = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { token: sampleFcmToken, provider: 'fcm' },
        user: DEFAULT_USER,
      });
      const resFcm = await callRoute(notificationsRoute.POST, reqFcm);
      expect(resFcm.status).toBe(200);
      expect(resFcm.data.data.fcmToken).toBe(sampleFcmToken);
    });

    it('PUSH-05: rejects invalid platforms and missing token payloads with 400', async () => {
      // Invalid platform
      const reqBadPlatform = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: sampleExpoToken, platform: 'blackberry' },
        user: DEFAULT_USER,
      });
      const resBadPlat = await callRoute(notificationsRoute.POST, reqBadPlatform);
      expect(resBadPlat.status).toBe(400);

      // Missing all tokens
      const reqNoToken = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { platform: 'ios' },
        user: DEFAULT_USER,
      });
      const resNoTok = await callRoute(notificationsRoute.POST, reqNoToken);
      expect(resNoTok.status).toBe(400);
      expect(resNoTok.error).toMatch(/push token is required/i);
    });

    it('PUSH-06: unregisters device token idempotently via DELETE', async () => {
      // Step 1: Register token
      const reqReg = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { expoToken: sampleExpoToken, platform: 'ios' },
        user: DEFAULT_USER,
      });
      await callRoute(notificationsRoute.POST, reqReg);
      expect(mockBillingDB.deviceTokens.has(sampleExpoToken)).toBe(true);

      // Step 2: Unregister token
      const reqDel = createTestRequest('/api/notifications/register', {
        method: 'DELETE',
        body: { token: sampleExpoToken },
        user: DEFAULT_USER,
      });
      const resDel = await callRoute(notificationsRoute.DELETE, reqDel);
      expect(resDel.status).toBe(200);
      expect(resDel.data.removed).toBe(true);
      expect(mockBillingDB.deviceTokens.has(sampleExpoToken)).toBe(false);

      // Step 3: Repeated DELETE is idempotent (returns 200)
      const resDel2 = await callRoute(notificationsRoute.DELETE, reqDel);
      expect(resDel2.status).toBe(200);
      expect(resDel2.data.removed).toBe(true);
    });
  });

  // ==========================================================================
  // Section 3: Batched Deep-Link Analytics Ingestion
  // ==========================================================================
  describe('3. Batched Deep-Link Analytics Ingestion', () => {
    it('ANALYTICS-01: ingests exact standard batch size of 50 events', async () => {
      const events = Array.from({ length: 50 }, (_, i) => ({
        id: `t5-evt-50-${i}`,
        kind: 'screen_view',
        route: `apex-os://billing/checkout?step=${i}`,
        timestamp: new Date().toISOString(),
        source: i % 2 === 0 ? 'notification' : 'direct',
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.success).toBe(true);
      expect(res.processed).toBe(50);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(50);
    });

    it('ANALYTICS-02: stress tests oversized batch of 100 events in single request', async () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: `t5-evt-100-${i}`,
        kind: 'button_click',
        route: `apex-os://billing/upgrade?tier=${i % 4}`,
        timestamp: new Date().toISOString(),
        source: 'direct',
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(100);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(100);
    });

    it('ANALYTICS-03: anonymous mobile client auth handling - succeeds with user_id = null', async () => {
      const events = [
        {
          kind: 'app_launch',
          route: 'apex-os://splash',
          timestamp: new Date().toISOString(),
          source: 'direct',
        },
      ];

      // Request completely devoid of auth header or cookie
      const reqAnon = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        authMethod: 'none',
      });

      const resAnon = await callRoute(analyticsRoute.POST, reqAnon);
      expect(resAnon.status).toBe(200);
      expect(resAnon.processed).toBe(1);
      expect(mockBillingDB.deepLinkAnalytics[0].user_id).toBeNull();
    });

    it('ANALYTICS-04: expired or corrupt bearer token does not throw 401 - logs as anonymous telemetry', async () => {
      const events = [
        {
          kind: 'deep_link_open',
          route: 'apex-os://billing/receipt/pay-test-999',
          timestamp: new Date().toISOString(),
          source: 'notification',
        },
      ];

      // Header with corrupt/invalid Bearer token
      const reqCorrupt = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: null,
        authMethod: 'none',
        headers: {
          authorization: 'Bearer invalid',
        },
      });

      const res = await callRoute(analyticsRoute.POST, reqCorrupt);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(1);
      // Fallback to anonymous user_id = null
      expect(mockBillingDB.deepLinkAnalytics[0].user_id).toBeNull();
    });

    it('ANALYTICS-05: handles timestamp alias (event_timestamp) and missing timestamp fallback', async () => {
      const events = [
        // Event A: uses timestamp
        {
          kind: 'evt_a',
          route: 'apex-os://a',
          timestamp: '2026-09-24T12:00:00.000Z',
        },
        // Event B: uses event_timestamp alias
        {
          kind: 'evt_b',
          route: 'apex-os://b',
          event_timestamp: '2026-09-24T13:00:00.000Z',
        },
        // Event C: missing timestamp entirely
        {
          kind: 'evt_c',
          route: 'apex-os://c',
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.processed).toBe(3);

      expect(mockBillingDB.deepLinkAnalytics[0].event_timestamp).toBe('2026-09-24T12:00:00.000Z');
      expect(mockBillingDB.deepLinkAnalytics[1].event_timestamp).toBe('2026-09-24T13:00:00.000Z');
      // Event C falls back to non-empty current ISO string
      expect(mockBillingDB.deepLinkAnalytics[2].event_timestamp).toBeDefined();
      expect(mockBillingDB.deepLinkAnalytics[2].event_timestamp.length).toBeGreaterThan(10);
    });

    it('ANALYTICS-06: database fallback column resilience - retries with timestamp if event_timestamp fails', async () => {
      const origBatch = mockBillingDB.batch.bind(mockBillingDB);
      let batchAttempt = 0;

      mockBillingDB.batch = jest.fn(async (stmts: any[]) => {
        batchAttempt++;
        if (batchAttempt === 1) {
          throw new Error('no such column: event_timestamp');
        }
        return origBatch(stmts);
      });

      try {
        const events = [
          {
            kind: 'col_fallback_test',
            route: 'apex-os://test/column',
            timestamp: new Date().toISOString(),
          },
        ];

        const req = createTestRequest('/api/profile/deep-link-analytics', {
          method: 'POST',
          body: { events },
          user: DEFAULT_USER,
        });

        const res = await callRoute(analyticsRoute.POST, req);
        expect(res.status).toBe(200);
        expect(res.processed).toBe(1);
        expect(batchAttempt).toBe(2); // First failed, retry succeeded
      } finally {
        mockBillingDB.batch = origBatch;
      }
    });

    it('ANALYTICS-07: handles circular metadata objects without crashing process', async () => {
      const circularObj: any = { key: 'value' };
      circularObj.self = circularObj;

      const rawEvents = [
        {
          kind: 'circular_meta_test',
          route: 'apex-os://test/circular',
          metadata: circularObj,
        },
      ];

      const req = {
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => ({ events: rawEvents }),
      } as any;

      const res = await analyticsRoute.POST(req);
      expect(res.status).toBe(200);
      const data = await res.json();
      expect(data.success).toBe(true);
      expect(data.processed).toBe(1);
      // Serialized circular metadata becomes null
      expect(mockBillingDB.deepLinkAnalytics[0].metadata).toBeNull();
    });

    it('ANALYTICS-08: returns 400 for malformed non-JSON payloads', async () => {
      const req = new Request('http://localhost:3000/api/profile/deep-link-analytics', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'invalid-non-json-string{{{',
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(400);
      expect(res.error).toMatch(/json/i);
    });
  });

  // ==========================================================================
  // Section 4: Cross-Endpoint Mobile Lifecycle Integration
  // ==========================================================================
  describe('4. Cross-Endpoint Mobile Lifecycle Integration', () => {
    it('INTEG-01: complete mobile user journey (Anonymous Telemetry -> Auth -> Push -> Wallet -> Receipt)', async () => {
      // 1. Mobile app opens: anonymous deep link telemetry
      const reqTelemetry1 = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: {
          events: [
            {
              kind: 'app_foreground',
              route: 'apex-os://plans',
              timestamp: new Date().toISOString(),
              source: 'direct',
            },
          ],
        },
        authMethod: 'none',
      });
      const resTel1 = await callRoute(analyticsRoute.POST, reqTelemetry1);
      expect(resTel1.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(1);
      expect(mockBillingDB.deepLinkAnalytics[0].user_id).toBeNull();

      // 2. User logs in & registers APNs device push token
      const apnsToken = 'e2e_device_token_' + 'c'.repeat(45);
      const reqPush = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { apnsToken, platform: 'ios' },
        user: DEFAULT_USER,
      });
      const resPush = await callRoute(notificationsRoute.POST, reqPush);
      expect(resPush.status).toBe(200);
      expect(mockBillingDB.deviceTokens.get(apnsToken)?.user_id).toBe(DEFAULT_USER.id);

      // 3. User connects Solana wallet for payments
      const solAddress = '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R';
      const reqWallet = createTestRequest('/api/profile/wallet', {
        method: 'POST',
        body: { wallet_address: solAddress, preferred_chain: 'solana' },
        user: DEFAULT_USER,
      });
      const resWallet = await callRoute(walletRoute.POST, reqWallet);
      expect(resWallet.status).toBe(200);
      expect(mockBillingDB.profiles.get(DEFAULT_USER.id)?.wallet_address).toBe(solAddress);

      // 4. User navigates to billing receipt via deep link (authenticated telemetry)
      const reqTelemetry2 = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: {
          events: [
            {
              kind: 'deep_link_receipt_view',
              route: 'apex-os://billing/receipt/pay-sample-e2e',
              timestamp: new Date().toISOString(),
              source: 'notification',
            },
          ],
        },
        user: DEFAULT_USER,
      });
      const resTel2 = await callRoute(analyticsRoute.POST, reqTelemetry2);
      expect(resTel2.status).toBe(200);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(2);
      expect(mockBillingDB.deepLinkAnalytics[1].user_id).toBe(DEFAULT_USER.id);
      expect(mockBillingDB.deepLinkAnalytics[1].source).toBe('notification');
    });
  });
});
