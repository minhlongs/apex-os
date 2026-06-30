/**
 * Unit tests cho API Key Resolution Module
 * File: /Users/macbook/apex-os/src/lib/byok/__tests__/resolve-api-key.test.ts
 */

// Mock user-api-key-store FIRST (jest hoists this)
jest.mock('../user-api-key-store', () => ({
  getUserApiKey: jest.fn(),
}));

import { resolveApiKey } from '../resolve-api-key';
import { getUserApiKey } from '../user-api-key-store';

// Helper to set env vars
const setEnvVars = (vars: Record<string, string | undefined>) => {
  Object.entries(vars).forEach(([key, value]) => {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  });
};

// Reset all env vars to clean state
const resetEnvVars = () => {
  setEnvVars({
    BYOK_ENABLED: undefined,
    BINANCE_WEBHOOK_SECRET: undefined,
    BYBIT_WEBHOOK_SECRET: undefined,
    RESEND_API_KEY: undefined,
  });
};

describe('resolveApiKey', () => {
  const TEST_USER_ID = 'user_12345';
  const TEST_PROVIDER: 'binance' | 'bybit' | 'resend' = 'binance';
  const TEST_USER_KEY = 'user-specific-api-key';
  const TEST_GLOBAL_KEY = 'global-webhook-secret';

  beforeEach(() => {
    jest.clearAllMocks();
    resetEnvVars();
    // Set default env vars for most tests
    setEnvVars({
      BYOK_ENABLED: 'true',
      BINANCE_WEBHOOK_SECRET: TEST_GLOBAL_KEY,
      BYBIT_WEBHOOK_SECRET: 'bybit-global-secret',
      RESEND_API_KEY: 'resend-global-key',
    });
  });

  afterEach(() => {
    resetEnvVars();
  });

  describe('Case 1: BYOK disabled', () => {
    beforeEach(() => {
      setEnvVars({ BYOK_ENABLED: 'false' });
    });

    it('should return global key when BYOK_ENABLED=false with userId', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(result).toBe(TEST_GLOBAL_KEY);
      expect(getUserApiKey).not.toHaveBeenCalled();
    });

    it('should return global key when BYOK_ENABLED=false without userId', async () => {
      const result = await resolveApiKey(null, TEST_PROVIDER);

      expect(result).toBe(TEST_GLOBAL_KEY);
      expect(getUserApiKey).not.toHaveBeenCalled();
    });

    it('should ignore fallbackToGlobal option when BYOK disabled', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: false });

      expect(result).toBe(TEST_GLOBAL_KEY);
      expect(getUserApiKey).not.toHaveBeenCalled();
    });
  });

  describe('Case 2: User key exists', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockResolvedValue(TEST_USER_KEY);
    });

    it('should return user key when it exists', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(getUserApiKey).toHaveBeenCalledWith(TEST_USER_ID, TEST_PROVIDER);
      expect(result).toBe(TEST_USER_KEY);
    });

    it('should not call getGlobalSecret when user key exists', async () => {
      await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      // Verify global secret was never accessed
      expect(process.env.BINANCE_WEBHOOK_SECRET).toBe(TEST_GLOBAL_KEY);
    });

    it('should work with requireUserKey=true when user key exists', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { requireUserKey: true });

      expect(result).toBe(TEST_USER_KEY);
      expect(getUserApiKey).toHaveBeenCalledWith(TEST_USER_ID, TEST_PROVIDER);
    });
  });

  describe('Case 3: User key missing with fallbackToGlobal=true', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockResolvedValue(null);
    });

    it('should return global key when user key missing and fallback enabled', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: true });

      expect(getUserApiKey).toHaveBeenCalledWith(TEST_USER_ID, TEST_PROVIDER);
      expect(result).toBe(TEST_GLOBAL_KEY);
    });

    it('should use default fallbackToGlobal=true', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(result).toBe(TEST_GLOBAL_KEY);
    });
  });

  describe('Case 4: User key missing with fallbackToGlobal=false and requireUserKey=true', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockResolvedValue(null);
      setEnvVars({ BYOK_ENABLED: 'true' }); // Ensure BYOK is enabled
    });

    it('should throw when no user key and requireUserKey=true', async () => {
      await expect(
        resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: false, requireUserKey: true })
      ).rejects.toThrow(`Không tìm thấy API key cho provider ${TEST_PROVIDER} của user ${TEST_USER_ID}`);
    });

    it('should throw even if global secret exists', async () => {
      await expect(
        resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: false, requireUserKey: true })
      ).rejects.toThrow();
    });
  });

  describe('Case 5: User key missing with fallbackToGlobal=false and requireUserKey=false', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockResolvedValue(null);
      setEnvVars({ BYOK_ENABLED: 'true' });
    });

    it('should throw unreachable error when no user key and fallback disabled', async () => {
      await expect(
        resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: false, requireUserKey: false })
      ).rejects.toThrow('Không thể resolve API key: không có user key và không cho phép fallback');
    });
  });

  describe('Case 6: Missing userId with BYOK enabled', () => {
    beforeEach(() => {
      setEnvVars({ BYOK_ENABLED: 'true' });
    });

    it('should throw when userId is null with fallbackToGlobal=false', async () => {
      await expect(
        resolveApiKey(null, TEST_PROVIDER, { fallbackToGlobal: false })
      ).rejects.toThrow('BYOK bị disable hoặc userId không được cung cấp');
    });

    it('should return global when userId is null with fallbackToGlobal=true', async () => {
      const result = await resolveApiKey(null, TEST_PROVIDER, { fallbackToGlobal: true });

      expect(result).toBe(TEST_GLOBAL_KEY);
    });
  });

  describe('Provider-specific global secrets', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockResolvedValue(null);
    });

    it('should use BYBIT_WEBHOOK_SECRET for bybit provider', async () => {
      const result = await resolveApiKey(TEST_USER_ID, 'bybit');

      expect(result).toBe('bybit-global-secret');
    });

    it('should use RESEND_API_KEY for resend provider', async () => {
      const result = await resolveApiKey(TEST_USER_ID, 'resend');

      expect(result).toBe('resend-global-key');
    });

    it('should throw when global secret not configured', async () => {
      setEnvVars({ BINANCE_WEBHOOK_SECRET: undefined });

      await expect(resolveApiKey(TEST_USER_ID, 'binance'))
        .rejects.toThrow('BINANCE_WEBHOOK_SECRET không được thiết lập trong environment');
    });

    it('should throw for unknown provider', async () => {
      // @ts-expect-error - testing invalid provider
      await expect(resolveApiKey(TEST_USER_ID, 'unknown' as any))
        .rejects.toThrow('Provider không được hỗ trợ');
    });
  });

  describe('getUserApiKey errors', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockRejectedValue(new Error('Database error'));
    });

    it('should propagate getUserApiKey errors', async () => {
      await expect(resolveApiKey(TEST_USER_ID, TEST_PROVIDER))
        .rejects.toThrow('Database error');
    });
  });

  describe('edge cases', () => {
    it('should handle empty userId string as invalid', async () => {
      await expect(resolveApiKey('', TEST_PROVIDER))
        .rejects.toThrow('BYOK bị disable hoặc userId không được cung cấp');
    });

    it('should handle undefined userId', async () => {
      await expect(resolveApiKey(undefined, TEST_PROVIDER))
        .rejects.toThrow('BYOK bị disable hoặc userId không được cung cấp');
    });

    it('should work with empty string user key (user has empty key set)', async () => {
      (getUserApiKey as jest.Mock).mockResolvedValue('');

      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(result).toBe(''); // Empty string is a valid key
    });

    it('should prioritize user key even if empty over global with requireUserKey=false', async () => {
      (getUserApiKey as jest.Mock).mockResolvedValue('');

      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(result).toBe(''); // Returns empty user key, not global
    });
  });

  describe('options handling', () => {
    beforeEach(() => {
      (getUserApiKey as jest.Mock).mockResolvedValue(null);
    });

    it('should use default options when not provided', async () => {
      await resolveApiKey(TEST_USER_ID, TEST_PROVIDER);

      // Default: fallbackToGlobal=true, requireUserKey=false
      // Should return global key
      expect(process.env.BINANCE_WEBHOOK_SECRET).toBeDefined();
    });

    it('should respect explicit fallbackToGlobal=true', async () => {
      const result = await resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: true });
      expect(result).toBe(TEST_GLOBAL_KEY);
    });

    it('should respect explicit fallbackToGlobal=false', async () => {
      await expect(
        resolveApiKey(TEST_USER_ID, TEST_PROVIDER, { fallbackToGlobal: false })
      ).rejects.toThrow('Không thể resolve API key: không có user key và không cho phép fallback');
    });
  });
});
