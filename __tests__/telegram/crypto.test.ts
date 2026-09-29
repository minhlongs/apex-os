/**
 * __tests__/telegram/crypto.test.ts
 *
 * Unit test suite for Telegram Mini App cryptographic verification service:
 * - SubtleCrypto resolution across Edge/Node runtimes
 * - Constant-time string comparison (timingSafeEqual)
 * - Data check string normalization
 * - WebApp & Widget HMAC-SHA256 signature computation
 * - initData verification, 24h replay attack prevention & future clock skew
 * - Tampered hash, expired timestamp, and malformed payload rejections
 */

import {
  getSubtleCrypto,
  timingSafeEqual,
  buildDataCheckString,
  computeTelegramHmac,
  computeTelegramWidgetHmac,
  signTelegramInitData,
  verifyTelegramInitData,
} from '@/lib/telegram/crypto';

describe('Telegram Cryptographic Verification Service', () => {
  const TEST_BOT_TOKEN = '123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ_TestToken';

  describe('getSubtleCrypto', () => {
    it('should resolve a valid SubtleCrypto instance with HMAC and digest capabilities', () => {
      const subtle = getSubtleCrypto();
      expect(subtle).toBeDefined();
      expect(typeof subtle.importKey).toBe('function');
      expect(typeof subtle.sign).toBe('function');
      expect(typeof subtle.digest).toBe('function');
    });
  });

  describe('timingSafeEqual', () => {
    it('should return true for identical strings', () => {
      expect(timingSafeEqual('abcdef', 'abcdef')).toBe(true);
      expect(timingSafeEqual('', '')).toBe(true);
      expect(timingSafeEqual('a'.repeat(64), 'a'.repeat(64))).toBe(true);
    });

    it('should return false for strings of different lengths', () => {
      expect(timingSafeEqual('abc', 'abcd')).toBe(false);
      expect(timingSafeEqual('abcd', 'abc')).toBe(false);
      expect(timingSafeEqual('', 'a')).toBe(false);
    });

    it('should return false for strings with differing characters at any position', () => {
      expect(timingSafeEqual('abcdef', 'bbcdef')).toBe(false); // diff at start
      expect(timingSafeEqual('abcdef', 'abxdef')).toBe(false); // diff in middle
      expect(timingSafeEqual('abcdef', 'abcdeg')).toBe(false); // diff at end
    });

    it('should return false for non-string inputs safely', () => {
      expect(timingSafeEqual(null as any, 'abc')).toBe(false);
      expect(timingSafeEqual('abc', undefined as any)).toBe(false);
      expect(timingSafeEqual(123 as any, 123 as any)).toBe(false);
    });

    it('should safely compare 64-character SHA-256 hexadecimal digests', () => {
      const hash1 = '382ddfa22d6a7198d6f31e404b70a18b94b175844a5b4853dc191ff0df2aa455';
      const hash2 = '382ddfa22d6a7198d6f31e404b70a18b94b175844a5b4853dc191ff0df2aa455';
      const hash3 = '382ddfa22d6a7198d6f31e404b70a18b94b175844a5b4853dc191ff0df2aa456';

      expect(timingSafeEqual(hash1, hash2)).toBe(true);
      expect(timingSafeEqual(hash1, hash3)).toBe(false);
    });
  });

  describe('buildDataCheckString', () => {
    it('should sort keys alphabetically and format as key=value separated by newlines', () => {
      const params = new Map<string, string>([
        ['username', 'alice'],
        ['auth_date', '1662771648'],
        ['first_name', 'Alice'],
        ['id', '123456'],
      ]);

      const result = buildDataCheckString(params);
      expect(result).toBe(
        'auth_date=1662771648\nfirst_name=Alice\nid=123456\nusername=alice'
      );
    });

    it('should exclude the hash parameter from the data-check-string', () => {
      const params = new URLSearchParams(
        'hash=abc123hash&auth_date=1662771648&query_id=ABC123'
      );

      const result = buildDataCheckString(params);
      expect(result).toBe('auth_date=1662771648\nquery_id=ABC123');
      expect(result).not.toContain('hash=');
    });

    it('should handle plain Record<string, string> inputs', () => {
      const record = {
        user: '{"id":1}',
        auth_date: '1660000000',
        hash: 'ignore_me',
      };

      const result = buildDataCheckString(record);
      expect(result).toBe('auth_date=1660000000\nuser={"id":1}');
    });
  });

  describe('computeTelegramHmac & computeTelegramWidgetHmac', () => {
    const dataCheckString = 'auth_date=1662771648\nfirst_name=Vladislav\nid=279058397';

    it('should produce a deterministic 64-character lowercase hex hash', async () => {
      const hash1 = await computeTelegramHmac(dataCheckString, TEST_BOT_TOKEN);
      const hash2 = await computeTelegramHmac(dataCheckString, TEST_BOT_TOKEN);

      expect(hash1).toHaveLength(64);
      expect(hash1).toMatch(/^[0-9a-f]{64}$/);
      expect(hash1).toBe(hash2);
    });

    it('should produce a different hash when bot token changes', async () => {
      const hash1 = await computeTelegramHmac(dataCheckString, TEST_BOT_TOKEN);
      const hash2 = await computeTelegramHmac(dataCheckString, 'different_token_123');

      expect(hash1).not.toBe(hash2);
    });

    it('should produce a different hash when dataCheckString changes', async () => {
      const hash1 = await computeTelegramHmac(dataCheckString, TEST_BOT_TOKEN);
      const hash2 = await computeTelegramHmac(
        dataCheckString + '\nusername=changed',
        TEST_BOT_TOKEN
      );

      expect(hash1).not.toBe(hash2);
    });

    it('should compute valid widget HMAC differing from WebApp HMAC', async () => {
      const webAppHash = await computeTelegramHmac(dataCheckString, TEST_BOT_TOKEN);
      const widgetHash = await computeTelegramWidgetHmac(dataCheckString, TEST_BOT_TOKEN);

      expect(widgetHash).toHaveLength(64);
      expect(widgetHash).toMatch(/^[0-9a-f]{64}$/);
      expect(widgetHash).not.toBe(webAppHash);
    });
  });

  describe('verifyTelegramInitData - Success Cases', () => {
    it('should verify freshly signed Telegram WebApp initData', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const userPayload = {
        id: 7123456789,
        first_name: 'Minh',
        last_name: 'Long',
        username: 'minhlong',
        language_code: 'en',
        is_premium: true,
      };

      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
          user: userPayload,
          start_param: 'ref_apex2026',
        },
        TEST_BOT_TOKEN
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);

      expect(result.isValid).toBe(true);
      expect(result.error).toBeUndefined();
      expect(result.data).toBeDefined();
      expect(result.data?.auth_date).toBe(nowSeconds);
      expect(result.data?.user.id).toBe(7123456789);
      expect(result.data?.user.first_name).toBe('Minh');
      expect(result.data?.user.last_name).toBe('Long');
      expect(result.data?.user.username).toBe('minhlong');
      expect(result.data?.user.is_premium).toBe(true);
      expect(result.data?.query_id).toBe('AAHdF6IQAAAAAN0XohDhrOrc');
      expect(result.data?.start_param).toBe('ref_apex2026');
      expect(result.data?.hash).toHaveLength(64);
    });

    it('should verify Telegram Login Widget HMAC fallback', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const userPayload = {
        id: 12345678,
        first_name: 'WidgetUser',
      };

      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: userPayload,
        },
        TEST_BOT_TOKEN,
        true // useWidgetAlgorithm = true
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);

      expect(result.isValid).toBe(true);
      expect(result.data?.user.id).toBe(12345678);
      expect(result.data?.user.first_name).toBe('WidgetUser');
    });

    it('should be case-insensitive to hash casing (uppercase hex)', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: { id: 999, first_name: 'Tester' },
        },
        TEST_BOT_TOKEN
      );

      const searchParams = new URLSearchParams(signedInitData);
      const lowerHash = searchParams.get('hash')!;
      searchParams.set('hash', lowerHash.toUpperCase());

      const result = await verifyTelegramInitData(searchParams.toString(), TEST_BOT_TOKEN);
      expect(result.isValid).toBe(true);
    });

    it('should accept timestamps up to 300 seconds in the future (clock skew tolerance)', async () => {
      const skewSeconds = Math.floor(Date.now() / 1000) + 120; // 2 minutes in future
      const signedInitData = await signTelegramInitData(
        {
          auth_date: skewSeconds,
          user: { id: 888, first_name: 'FutureTrader' },
        },
        TEST_BOT_TOKEN
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);
      expect(result.isValid).toBe(true);
      expect(result.data?.auth_date).toBe(skewSeconds);
    });
  });

  describe('verifyTelegramInitData - Replay Attack & Timestamp Rejection', () => {
    it('should reject initData older than 24 hours (86,400 seconds)', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const expiredDate = nowSeconds - 86401; // 24 hours + 1 second ago

      const signedInitData = await signTelegramInitData(
        {
          auth_date: expiredDate,
          user: { id: 111, first_name: 'OldUser' },
        },
        TEST_BOT_TOKEN
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);

      expect(result.isValid).toBe(false);
      expect(result.error).toMatch(/Authentication data expired/);
      expect(result.data).toBeUndefined();
    });

    it('should respect custom maxAgeSeconds parameter', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const twoHoursAgo = nowSeconds - 7200;

      const signedInitData = await signTelegramInitData(
        {
          auth_date: twoHoursAgo,
          user: { id: 111, first_name: 'TwoHourUser' },
        },
        TEST_BOT_TOKEN
      );

      // With maxAge = 3600 (1 hour), 2 hours should be rejected
      const result1 = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN, 3600);
      expect(result1.isValid).toBe(false);
      expect(result1.error).toMatch(/Authentication data expired/);

      // With maxAge = 14400 (4 hours), 2 hours should be accepted
      const result2 = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN, 14400);
      expect(result2.isValid).toBe(true);
    });

    it('should reject timestamps more than 5 minutes (300s) in the future', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const farFutureDate = nowSeconds + 600; // 10 minutes in future

      const signedInitData = await signTelegramInitData(
        {
          auth_date: farFutureDate,
          user: { id: 222, first_name: 'TimeTraveler' },
        },
        TEST_BOT_TOKEN
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Authentication date is in the future');
      expect(result.data).toBeUndefined();
    });
  });

  describe('verifyTelegramInitData - Tampering & Signature Mismatch', () => {
    it('should reject initData when the hash parameter is modified', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: { id: 333, first_name: 'TamperUser' },
        },
        TEST_BOT_TOKEN
      );

      const searchParams = new URLSearchParams(signedInitData);
      searchParams.set('hash', 'f'.repeat(64)); // forged hash

      const result = await verifyTelegramInitData(searchParams.toString(), TEST_BOT_TOKEN);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Cryptographic signature mismatch');
    });

    it('should reject initData when a parameter is modified without recalculating hash', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: { id: 444, first_name: 'OriginalName' },
        },
        TEST_BOT_TOKEN
      );

      const searchParams = new URLSearchParams(signedInitData);
      // Tamper with user payload
      searchParams.set('user', JSON.stringify({ id: 444, first_name: 'Attacker' }));

      const result = await verifyTelegramInitData(searchParams.toString(), TEST_BOT_TOKEN);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Cryptographic signature mismatch');
    });

    it('should reject initData signed with a different bot token', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: { id: 555, first_name: 'TokenUser' },
        },
        'different_secret_bot_token_999'
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);

      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Cryptographic signature mismatch');
    });
  });

  describe('verifyTelegramInitData - Malformed & Missing Payload Handling', () => {
    it('should reject empty or missing initData string', async () => {
      expect((await verifyTelegramInitData('', TEST_BOT_TOKEN)).isValid).toBe(false);
      expect((await verifyTelegramInitData('   ', TEST_BOT_TOKEN)).isValid).toBe(false);
      expect((await verifyTelegramInitData(null as any, TEST_BOT_TOKEN)).isValid).toBe(false);
    });

    it('should reject missing or empty bot token', async () => {
      const result = await verifyTelegramInitData('hash=123', '');
      expect(result.isValid).toBe(false);
      expect(result.error).toMatch(/missing bot token/);
    });

    it('should reject initData missing the hash parameter', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const query = `auth_date=${nowSeconds}&user=${encodeURIComponent(JSON.stringify({ id: 1, first_name: 'NoHash' }))}`;

      const result = await verifyTelegramInitData(query, TEST_BOT_TOKEN);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Missing hash parameter in initData');
    });

    it('should reject initData missing the auth_date parameter', async () => {
      const query = `hash=abc123&user=${encodeURIComponent(JSON.stringify({ id: 1, first_name: 'NoAuthDate' }))}`;

      const result = await verifyTelegramInitData(query, TEST_BOT_TOKEN);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Missing auth_date in initData');
    });

    it('should reject non-numeric auth_date values', async () => {
      const query = `hash=abc123&auth_date=not_a_number&user=${encodeURIComponent(JSON.stringify({ id: 1, first_name: 'NaN' }))}`;

      const result = await verifyTelegramInitData(query, TEST_BOT_TOKEN);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Invalid auth_date format');
    });

    it('should reject initData missing the user object', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          query_id: 'test_query_id',
        },
        TEST_BOT_TOKEN
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Missing user object in initData');
    });

    it('should reject unparseable user JSON', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);
      const signedInitData = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: '{broken_json',
        },
        TEST_BOT_TOKEN
      );

      const result = await verifyTelegramInitData(signedInitData, TEST_BOT_TOKEN);
      expect(result.isValid).toBe(false);
      expect(result.error).toBe('Failed to parse user JSON from initData');
    });

    it('should reject user payload missing id or first_name', async () => {
      const nowSeconds = Math.floor(Date.now() / 1000);

      // Missing id
      const signedNoId = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: { first_name: 'OnlyFirst' },
        },
        TEST_BOT_TOKEN
      );
      const resultNoId = await verifyTelegramInitData(signedNoId, TEST_BOT_TOKEN);
      expect(resultNoId.isValid).toBe(false);
      expect(resultNoId.error).toBe('Malformed user payload: missing id or first_name');

      // Missing first_name
      const signedNoFirst = await signTelegramInitData(
        {
          auth_date: nowSeconds,
          user: { id: 12345 },
        },
        TEST_BOT_TOKEN
      );
      const resultNoFirst = await verifyTelegramInitData(signedNoFirst, TEST_BOT_TOKEN);
      expect(resultNoFirst.isValid).toBe(false);
      expect(resultNoFirst.error).toBe('Malformed user payload: missing id or first_name');
    });
  });

  describe('Full Telegram Mini App Integration Flow', () => {
    it('should simulate full TMA client-server handshake', async () => {
      // 1. Client simulates launch inside Telegram client
      const authDate = Math.floor(Date.now() / 1000);
      const clientUser = {
        id: 9988776655,
        first_name: 'Vitalik',
        last_name: 'Buterin',
        username: 'vitalik',
        language_code: 'en',
        is_premium: true,
      };

      // 2. Telegram client signs initData
      const clientInitData = await signTelegramInitData(
        {
          query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
          user: clientUser,
          auth_date: authDate,
          start_param: 'ref_vip2026',
          chat_type: 'private',
          chat_instance: '-8765432109876',
        },
        TEST_BOT_TOKEN
      );

      // 3. ApexOS backend validates payload
      const verification = await verifyTelegramInitData(clientInitData, TEST_BOT_TOKEN);

      expect(verification.isValid).toBe(true);
      expect(verification.data).toBeDefined();

      const data = verification.data!;
      expect(data.user.id).toBe(9988776655);
      expect(data.user.first_name).toBe('Vitalik');
      expect(data.user.last_name).toBe('Buterin');
      expect(data.user.username).toBe('vitalik');
      expect(data.user.is_premium).toBe(true);
      expect(data.start_param).toBe('ref_vip2026');
      expect(data.chat_type).toBe('private');
      expect(data.chat_instance).toBe('-8765432109876');
      expect(data.raw_params['query_id']).toBe('AAHdF6IQAAAAAN0XohDhrOrc');
    });
  });
});
