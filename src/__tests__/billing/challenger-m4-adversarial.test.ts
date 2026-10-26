/**
 * Challenger M4 Adversarial Stress Test Suite
 * Target:
 * - src/app/api/profile/wallet/route.ts (Feature F7)
 * - src/app/api/notifications/register/route.ts (Feature F8)
 * - src/app/api/profile/deep-link-analytics/route.ts (Feature F9)
 *
 * Authored by: teamwork_preview_challenger_m4_1
 * Role: EMPIRICAL CHALLENGER
 *
 * Stress Vectors:
 * 1. Wallet Validation: Bad hex, non-hex characters, invalid lengths, illegal Base58 (0, O, I, l),
 *    Stellar Base32 violations (0, 1, 8, 9, lowercase, wrong prefix), chain case normalization,
 *    re-binding, switching chains, idempotent unbinding.
 * 2. Push Tokens: Empty/whitespace tokens, platform variations (case, whitespace, invalid),
 *    generic token provider fallbacks, device handover across users, multi-device registration,
 *    unregistration of non-existent tokens, unregistration by different token keys.
 * 3. Deep-Link Analytics: Batched ingestion stress, extreme batch sizes, missing/corrupted fields,
 *    anonymous vs authenticated users, URL parameters preservation.
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

describe('Challenger M4 Adversarial Stress Test Suite', () => {
  // ==========================================================================
  // Section 1: Wallet Address Validation & Association Adversarial Stress
  // ==========================================================================
  describe('1. Wallet Validation & Lifecycle Adversarial Stress', () => {
    const validEth = '0x742d35Cc6634C0532925a3b844Bc954e7595f0bE';
    const validSol = 'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH';
    const validStellar = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    describe('1.1 Ethereum Address Stress-Testing', () => {
      it('rejects Ethereum address with uppercase 0X prefix', async () => {
        const uppercasePrefixEth = '0X742d35Cc6634C0532925a3b844Bc954e7595f0bE';
        const req = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: uppercasePrefixEth, preferred_chain: 'ethereum' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(walletRoute.POST, req);
        expect(res.status).toBe(400);
        expect(res.error).toMatch(/format/i);
      });

      it('rejects Ethereum address with non-hex characters (g, z, special symbols)', async () => {
        const nonHexCharacters = [
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0bG', // 'G' is not hex
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0bZ', // 'Z' is not hex
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0b!', // '!' symbol
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0b-', // '-' hyphen
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0b ', // internal space
        ];

        for (const badEth of nonHexCharacters) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badEth, preferred_chain: 'ethereum' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });

      it('rejects Ethereum address invalid lengths (too short, too long, prefix-only)', async () => {
        const invalidLengths = [
          '0x', // prefix only
          '0x1',
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0', // 38 hex (total 40)
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0b', // 39 hex (total 41)
          '0x742d35Cc6634C0532925a3b844Bc954e7595f0bEE', // 41 hex (total 43)
          '0x0000000000000000000000000000000000000000000000000000000000000000', // 64 hex (32 bytes hash)
        ];

        for (const badLen of invalidLengths) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badLen, preferred_chain: 'ethereum' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });

      it('accepts valid all-lowercase and all-uppercase hex Ethereum addresses', async () => {
        const allLower = '0x742d35cc6634c0532925a3b844bc954e7595f0be';
        const allUpperHex = '0x742D35CC6634C0532925A3B844BC954E7595F0BE';

        for (const ethAddr of [allLower, allUpperHex]) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: ethAddr, preferred_chain: 'ethereum' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(200);
          expect(res.data.data.wallet_address).toBe(ethAddr);
        }
      });
    });

    describe('1.2 Solana Address Stress-Testing', () => {
      it('rejects Solana addresses with forbidden Base58 characters (0, O, I, l)', async () => {
        // Base58 excludes 0, O, I, l
        const forbiddenCharTests = [
          '0N7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH', // contains '0'
          'ON7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH', // contains 'O'
          'IN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH', // contains 'I'
          'lN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEH', // contains 'l'
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqE0', // ends with '0'
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEO', // ends with 'O'
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEI', // ends with 'I'
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqEl', // ends with 'l'
        ];

        for (const sol of forbiddenCharTests) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: sol, preferred_chain: 'solana' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });

      it('rejects Solana addresses with punctuation or symbols (+, /, =, _, -)', async () => {
        const symbolSol = [
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqE+',
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqE/',
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqE=',
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqE-',
          'HN7cABqLqMCBsKF4qwbPEuZuvB5qMkLcN8cNGcFVCqE_',
        ];

        for (const sol of symbolSol) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: sol, preferred_chain: 'solana' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });

      it('boundary length testing for Solana (31, 32, 44, 45 chars)', async () => {
        // Valid Base58 character: '1'
        const len31 = '1'.repeat(31); // Too short
        const len32 = '1'.repeat(32); // Min valid length
        const len44 = '1'.repeat(44); // Max valid length
        const len45 = '1'.repeat(45); // Too long

        const req31 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len31, preferred_chain: 'solana' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req31)).status).toBe(400);

        const req32 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len32, preferred_chain: 'solana' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req32)).status).toBe(200);

        const req44 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len44, preferred_chain: 'solana' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req44)).status).toBe(200);

        const req45 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len45, preferred_chain: 'solana' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req45)).status).toBe(400);
      });
    });

    describe('1.3 Stellar Address Stress-Testing', () => {
      it('rejects Stellar addresses with invalid prefix (S, M, g, 1)', async () => {
        const badPrefixes = [
          'SA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // starts with S (secret key)
          'MA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // starts with M (muxed)
          'gA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // starts with lowercase g
          '1A5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN', // starts with 1
        ];

        for (const badStellar of badPrefixes) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: badStellar, preferred_chain: 'stellar' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });

      it('rejects Stellar addresses with invalid Base32 characters (0, 1, 8, 9, lowercase)', async () => {
        // Base32 RFC 4648 allows only A-Z and 2-7. Excludes 0, 1, 8, 9 and lowercase.
        const baseStellar = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZV'; // 55 chars
        const invalidChars = ['0', '1', '8', '9', 'a', 'z', '@', '!'];

        for (const char of invalidChars) {
          const addr = baseStellar + char; // length 56
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: addr, preferred_chain: 'stellar' },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(400);
        }
      });

      it('boundary length testing for Stellar (55, 56, 57 chars)', async () => {
        const len55 = 'G' + 'A'.repeat(54); // length 55 (too short)
        const len56 = 'G' + 'A'.repeat(55); // length 56 (exact valid length)
        const len57 = 'G' + 'A'.repeat(56); // length 57 (too long)

        const req55 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len55, preferred_chain: 'stellar' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req55)).status).toBe(400);

        const req56 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len56, preferred_chain: 'stellar' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req56)).status).toBe(200);

        const req57 = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: len57, preferred_chain: 'stellar' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, req57)).status).toBe(400);
      });
    });

    describe('1.4 Chain Normalization, Switching, and Disconnection Lifecycle', () => {
      it('normalizes preferred_chain across casing and whitespace variations', async () => {
        const chainVariations = [
          { chain: 'ETHEREUM', expected: 'ethereum', addr: validEth },
          { chain: '  ethereum  ', expected: 'ethereum', addr: validEth },
          { chain: 'SoLaNa', expected: 'solana', addr: validSol },
          { chain: 'SOLANA', expected: 'solana', addr: validSol },
          { chain: '  sTeLlAr  ', expected: 'stellar', addr: validStellar },
        ];

        for (const testCase of chainVariations) {
          const req = createTestRequest('/api/profile/wallet', {
            method: 'POST',
            body: { wallet_address: testCase.addr, preferred_chain: testCase.chain },
            user: DEFAULT_USER,
          });
          const res = await callRoute(walletRoute.POST, req);
          expect(res.status).toBe(200);
          expect(res.data.data.preferred_chain).toBe(testCase.expected);
        }
      });

      it('supports sequential chain switching on the same profile', async () => {
        // 1. Bind Ethereum
        const reqEth = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: validEth, preferred_chain: 'ethereum' },
          user: DEFAULT_USER,
        });
        expect((await callRoute(walletRoute.POST, reqEth)).status).toBe(200);

        // 2. Switch directly to Solana
        const reqSol = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: validSol, preferred_chain: 'solana' },
          user: DEFAULT_USER,
        });
        const resSol = await callRoute(walletRoute.POST, reqSol);
        expect(resSol.status).toBe(200);
        expect(resSol.data.data.preferred_chain).toBe('solana');
        expect(resSol.data.data.wallet_address).toBe(validSol);

        // Verify GET reflects Solana
        const getReq = createTestRequest('/api/profile/wallet', {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const getRes = await callRoute(walletRoute.GET, getReq);
        expect(getRes.status).toBe(200);
        expect(getRes.data.data.preferred_chain).toBe('solana');
        expect(getRes.data.data.wallet_address).toBe(validSol);
      });

      it('idempotently handles repeated DELETE unbinding requests', async () => {
        // Disconnect when already unbound
        const delReq1 = createTestRequest('/api/profile/wallet', {
          method: 'DELETE',
          user: DEFAULT_USER,
        });
        const delRes1 = await callRoute(walletRoute.DELETE, delReq1);
        expect(delRes1.status).toBe(200);
        expect(delRes1.data.disconnected).toBe(true);

        // Disconnect again immediately
        const delReq2 = createTestRequest('/api/profile/wallet', {
          method: 'DELETE',
          user: DEFAULT_USER,
        });
        const delRes2 = await callRoute(walletRoute.DELETE, delReq2);
        expect(delRes2.status).toBe(200);
        expect(delRes2.data.disconnected).toBe(true);

        // GET confirms null
        const getReq = createTestRequest('/api/profile/wallet', {
          method: 'GET',
          user: DEFAULT_USER,
        });
        const getRes = await callRoute(walletRoute.GET, getReq);
        expect(getRes.status).toBe(200);
        // DB mock sets '' while SQLite sets NULL; both are falsy/unbound
        expect(getRes.data.data.wallet_address).toBeFalsy();
      });
    });
  });

  // ==========================================================================
  // Section 2: Push Token Registration & Handover Adversarial Stress
  // ==========================================================================
  describe('2. Push Token Registration & Handover Adversarial Stress', () => {
    describe('2.1 Empty & Malformed Token Payloads', () => {
      it('rejects empty object, missing tokens, and whitespace-only tokens', async () => {
        const invalidBodies = [
          {},
          { expoToken: '' },
          { expoToken: '   ' },
          { apnsToken: '' },
          { apnsToken: '   ' },
          { fcmToken: '' },
          { fcmToken: '   ' },
          { token: '' },
          { token: '   ' },
          { expoToken: '', apnsToken: '', fcmToken: '' },
          { expoToken: '   ', apnsToken: '   ', fcmToken: '   ' },
        ];

        for (const body of invalidBodies) {
          const req = createTestRequest('/api/notifications/register', {
            method: 'POST',
            body,
            user: DEFAULT_USER,
          });
          const res = await callRoute(notificationsRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/required/i);
        }
      });
    });

    describe('2.2 Platform Variations and Validation', () => {
      it('normalizes platform casing and trimming (IOS, android, WEB)', async () => {
        const validPlatforms = [
          { platform: 'IOS', expected: 'ios' },
          { platform: '  android  ', expected: 'android' },
          { platform: 'WEB', expected: 'web' },
          { platform: 'Web', expected: 'web' },
        ];

        for (const tc of validPlatforms) {
          const req = createTestRequest('/api/notifications/register', {
            method: 'POST',
            body: { expoToken: `ExponentPushToken[${tc.expected}]`, platform: tc.platform },
            user: DEFAULT_USER,
          });
          const res = await callRoute(notificationsRoute.POST, req);
          expect(res.status).toBe(200);
          expect(res.data.data.platform).toBe(tc.expected);
        }
      });

      it('defaults to ios when platform is omitted or undefined', async () => {
        const req = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { expoToken: 'ExponentPushToken[default_platform]' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(notificationsRoute.POST, req);
        expect(res.status).toBe(200);
        expect(res.data.data.platform).toBe('ios');
      });

      it('rejects non-supported platforms (windows, macos, symbian, empty string)', async () => {
        const badPlatforms = ['windows', 'macos', 'symbian', 'blackberry', 'linux', ''];

        for (const platform of badPlatforms) {
          const req = createTestRequest('/api/notifications/register', {
            method: 'POST',
            body: { expoToken: 'ExponentPushToken[platform_test]', platform },
            user: DEFAULT_USER,
          });
          const res = await callRoute(notificationsRoute.POST, req);
          expect(res.status).toBe(400);
          expect(res.error).toMatch(/platform/i);
        }
      });
    });

    describe('2.3 Generic Token & Provider Resolution Fallbacks', () => {
      it('resolves generic token with provider=apns to apnsToken', async () => {
        const req = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { token: 'apns_raw_token_xyz', provider: 'apns' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(notificationsRoute.POST, req);
        expect(res.status).toBe(200);
        expect(res.data.data.apnsToken).toBe('apns_raw_token_xyz');
      });

      it('resolves generic token with provider=fcm to fcmToken', async () => {
        const req = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { token: 'fcm_raw_token_xyz', provider: 'fcm' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(notificationsRoute.POST, req);
        expect(res.status).toBe(200);
        expect(res.data.data.fcmToken).toBe('fcm_raw_token_xyz');
      });

      it('auto-detects ExponentPushToken format in generic token field', async () => {
        const req = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { token: 'ExponentPushToken[generic_auto_detect]' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(notificationsRoute.POST, req);
        expect(res.status).toBe(200);
        expect(res.data.data.expoToken).toBe('ExponentPushToken[generic_auto_detect]');
      });
    });

    describe('2.4 Device Handover & Re-registration Stress', () => {
      it('handles device handover: rebinds existing token to new authenticated user', async () => {
        const token = 'ExponentPushToken[handover_token_device_99]';

        // 1. User 1 registers token
        const req1 = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { expoToken: token, platform: 'ios' },
          user: DEFAULT_USER,
        });
        const res1 = await callRoute(notificationsRoute.POST, req1);
        expect(res1.status).toBe(200);
        expect(res1.data.data.userId).toBe(DEFAULT_USER.id);

        let row = mockBillingDB.deviceTokens.get(token);
        expect(row?.user_id).toBe(DEFAULT_USER.id);

        // 2. User 2 logs into the same physical phone and registers the same token
        const req2 = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { expoToken: token, platform: 'ios' },
          user: SECOND_USER,
        });
        const res2 = await callRoute(notificationsRoute.POST, req2);
        expect(res2.status).toBe(200);
        expect(res2.data.data.userId).toBe(SECOND_USER.id);

        row = mockBillingDB.deviceTokens.get(token);
        expect(row?.user_id).toBe(SECOND_USER.id);
      });

      it('supports unregistering token by generic token property', async () => {
        const token = 'ExponentPushToken[delete_by_generic]';
        mockBillingDB.deviceTokens.set(token, {
          id: 'tok-gen-del',
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

      it('idempotently succeeds when unregistering a non-existent token', async () => {
        const req = createTestRequest('/api/notifications/register', {
          method: 'DELETE',
          body: { token: 'ExponentPushToken[non_existent_token]' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(notificationsRoute.DELETE, req);
        expect(res.status).toBe(200);
        expect(res.data.removed).toBe(true);
      });

      it('rejects DELETE when token field is missing or empty', async () => {
        const req = createTestRequest('/api/notifications/register', {
          method: 'DELETE',
          body: { token: '   ' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(notificationsRoute.DELETE, req);
        expect(res.status).toBe(400);
        expect(res.error).toMatch(/token/i);
      });
    });
  });

  // ==========================================================================
  // Section 3: Deep-Link Analytics Batch Ingestion Adversarial Stress
  // ==========================================================================
  describe('3. Deep-Link Analytics Adversarial Stress', () => {
    it('ingests batch of 100 events safely without database overflow', async () => {
      const events = Array.from({ length: 100 }, (_, i) => ({
        id: `evt-stress-${i}`,
        kind: `navigation_stress_${i % 5}`,
        route: `apex-os://screen/${i}?param=value_${i}`,
        timestamp: new Date().toISOString(),
        source: i % 2 === 0 ? 'notification' : 'direct',
        metadata: { index: i, flag: true },
      }));

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(100);
      expect(mockBillingDB.deepLinkAnalytics.length).toBe(100);
    });

    it('gracefully tolerates missing timestamps and invalid sources in mixed batch', async () => {
      const events = [
        { kind: 'evt1', route: 'apex-os://home', timestamp: null as any, source: 'invalid_source' as any },
        { kind: 'evt2', route: 'apex-os://settings', event_timestamp: '2026-09-24T19:00:00Z', source: 'notification' },
        { kind: 'evt3', route: 'apex-os://profile', timestamp: '', source: 'direct' },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        authMethod: 'none',
        user: null,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.processed).toBe(3);

      const evt1 = mockBillingDB.deepLinkAnalytics.find((e) => e.kind === 'evt1');
      expect(evt1?.source).toBe('direct'); // normalized
      expect(evt1?.user_id).toBeNull(); // anonymous
      expect(evt1?.event_timestamp).toBeDefined();
    });

    it('handles complex deep-link routes with multiple query params and url encoding', async () => {
      const complexUrl = 'apex-os://billing/checkout?payment_id=pay_999&plan=PREMIUM&redirect=https%3A%2F%2Fapex-os.com%2Fdashboard%3Fref%3Dpromo';
      const events = [
        {
          kind: 'complex-route-event',
          route: complexUrl,
          timestamp: new Date().toISOString(),
          source: 'notification',
          metadata: { query: 'nested', tags: ['crypto', 'billing'] },
        },
      ];

      const req = createTestRequest('/api/profile/deep-link-analytics', {
        method: 'POST',
        body: { events },
        user: DEFAULT_USER,
      });

      const res = await callRoute(analyticsRoute.POST, req);
      expect(res.status).toBe(200);

      const inserted = mockBillingDB.deepLinkAnalytics.find((e) => e.kind === 'complex-route-event');
      expect(inserted?.route).toBe(complexUrl);
      expect(inserted?.source).toBe('notification');
    });
  });

  // ==========================================================================
  // Section 4: Security, Injections, Auth & Concurrency Stress
  // ==========================================================================
  describe('4. Security, Injections, Type Safety & Concurrency Stress', () => {
    const validEth = '0x742d35Cc6634C0532925a3b844Bc954e7595f0bE';

    it('rejects SQL injection vectors in wallet address', async () => {
      const sqlInjections = [
        "0x742d35Cc6634C0532925a3b844Bc954e7595f0bE' OR '1'='1",
        "0x742d35Cc6634C0532925a3b844Bc954e7595f0bE'; DROP TABLE profiles;--",
        "0x742d35Cc6634C0532925a3b844Bc954e7595f0bE' UNION SELECT * FROM users--",
      ];

      for (const injection of sqlInjections) {
        const req = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: { wallet_address: injection, preferred_chain: 'ethereum' },
          user: DEFAULT_USER,
        });
        const res = await callRoute(walletRoute.POST, req);
        expect(res.status).toBe(400);
      }
    });

    it('rejects non-string types for wallet fields (numbers, objects, booleans)', async () => {
      const badTypes = [
        { wallet_address: 123456789, preferred_chain: 'ethereum' },
        { wallet_address: validEth, preferred_chain: 123 },
        { wallet_address: true, preferred_chain: 'ethereum' },
        { wallet_address: { addr: validEth }, preferred_chain: 'ethereum' },
        { wallet_address: null, preferred_chain: 'ethereum' },
      ];

      for (const b of badTypes) {
        const req = createTestRequest('/api/profile/wallet', {
          method: 'POST',
          body: b,
          user: DEFAULT_USER,
        });
        const res = await callRoute(walletRoute.POST, req);
        expect(res.status).toBe(400);
      }
    });

    it('handles long native push tokens (FCM tokens up to 512 chars) safely', async () => {
      const longFcmToken = 'fcm_prefix_' + 'a'.repeat(500);
      const req = createTestRequest('/api/notifications/register', {
        method: 'POST',
        body: { fcmToken: longFcmToken, platform: 'android' },
        user: DEFAULT_USER,
      });

      const res = await callRoute(notificationsRoute.POST, req);
      expect(res.status).toBe(200);
      expect(res.data.data.fcmToken).toBe(longFcmToken);
      expect(mockBillingDB.deviceTokens.get(longFcmToken)?.fcm_token).toBe(longFcmToken);
    });

    it('handles concurrent burst registrations for multiple devices without race or lockup', async () => {
      const concurrentRequests = Array.from({ length: 20 }, (_, i) => {
        const token = `ExponentPushToken[burst_device_${i}]`;
        const req = createTestRequest('/api/notifications/register', {
          method: 'POST',
          body: { expoToken: token, platform: i % 2 === 0 ? 'ios' : 'android' },
          user: DEFAULT_USER,
        });
        return callRoute(notificationsRoute.POST, req);
      });

      const results = await Promise.all(concurrentRequests);
      for (const res of results) {
        expect(res.status).toBe(200);
        expect(res.success).toBe(true);
      }
      expect(mockBillingDB.deviceTokens.size).toBeGreaterThanOrEqual(20);
    });

    it('rejects unauthenticated requests across all protected endpoints', async () => {
      // Wallet POST
      const req1 = createTestRequest('/api/profile/wallet', { method: 'POST', body: { wallet_address: validEth, preferred_chain: 'ethereum' }, authMethod: 'none', user: null });
      expect((await callRoute(walletRoute.POST, req1)).status).toBe(401);

      // Wallet GET
      const req2 = createTestRequest('/api/profile/wallet', { method: 'GET', authMethod: 'none', user: null });
      expect((await callRoute(walletRoute.GET, req2)).status).toBe(401);

      // Wallet DELETE
      const req3 = createTestRequest('/api/profile/wallet', { method: 'DELETE', authMethod: 'none', user: null });
      expect((await callRoute(walletRoute.DELETE, req3)).status).toBe(401);

      // Notifications POST
      const req4 = createTestRequest('/api/notifications/register', { method: 'POST', body: { expoToken: 'ExponentPushToken[123]' }, authMethod: 'none', user: null });
      expect((await callRoute(notificationsRoute.POST, req4)).status).toBe(401);

      // Notifications DELETE
      const req5 = createTestRequest('/api/notifications/register', { method: 'DELETE', body: { token: 'ExponentPushToken[123]' }, authMethod: 'none', user: null });
      expect((await callRoute(notificationsRoute.DELETE, req5)).status).toBe(401);
    });
  });
});

