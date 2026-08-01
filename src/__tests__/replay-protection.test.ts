/**
 * Unit Tests: Webhook Replay Protection
 * Tests KV-based replay detection with 24h TTL
 */

import { REPLAY_PROTECTION_TTL, isWebhookReplay, markWebhookProcessed, buildReplayKey, checkAndMarkWebhook } from '@/lib/webhooks/replay-protection';
import type { ReplayProtectionKV } from '@/lib/webhooks/replay-protection';

// Mock Cloudflare KV namespace
const createMockKV = (): ReplayProtectionKV & { store: Map<string, { value: string; ttl: number }> } => {
  const store = new Map<string, { value: string; ttl: number }>();
  return {
    store,
    async get(key: string): Promise<string | null> {
      const entry = store.get(key);
      return entry ? entry.value : null;
    },
    async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
      store.set(key, { value, ttl: options?.expirationTtl ?? 0 });
    },
    async add(key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean> {
      if (store.has(key)) {
        return false;
      }
      store.set(key, { value, ttl: options?.expirationTtl ?? 0 });
      return true;
    },
    async delete(key: string): Promise<boolean> {
      return store.delete(key);
    },
  };
};

let mockKV: ReturnType<typeof createMockKV>;

beforeEach(() => {
  mockKV = createMockKV();
  // @ts-ignore - mocking globalThis.KV
  globalThis.KV = mockKV;
});

afterEach(() => {
  // @ts-ignore
  delete globalThis.KV;
});

describe('Replay Protection', () => {
  describe('isWebhookReplay', () => {
    it('should return false when KV is not available', async () => {
      // @ts-ignore
      delete globalThis.KV;
      const result = await isWebhookReplay('binance', 'order-123', 'BTCUSDT');
      expect(result).toBe(false);
    });

    it('should return false for a new (unprocessed) webhook', async () => {
      const result = await isWebhookReplay('binance', 'order-123', 'BTCUSDT');
      expect(result).toBe(false);
    });

    it('should return true for an already processed webhook', async () => {
      // Pre-mark as processed
      await mockKV.add('webhook:replay:binance:BTCUSDT:order-123', 'processed', { expirationTtl: 86400 });

      const result = await isWebhookReplay('binance', 'order-123', 'BTCUSDT');
      expect(result).toBe(true);
    });

    it('should build correct KV key format using buildReplayKey', async () => {
      await isWebhookReplay('binance', 'order-123', 'BTCUSDT');
      expect(mockKV.store.has('webhook:replay:binance:BTCUSDT:order-123')).toBe(false); // isWebhookReplay doesn't store
    });

    it('should return false on KV errors (fail open)', async () => {
      const originalGet = mockKV.get;
      mockKV.get = jest.fn().mockRejectedValue(new Error('KV error'));

      const result = await isWebhookReplay('binance', 'order-123', 'BTCUSDT');
      expect(result).toBe(false);

      mockKV.get = originalGet;
    });

    it('should differentiate between different exchanges', async () => {
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      expect(await isWebhookReplay('bybit', 'order-123', 'BTCUSDT')).toBe(false);
    });

    it('should differentiate between different symbols', async () => {
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      expect(await isWebhookReplay('binance', 'order-123', 'ETHUSDT')).toBe(false);
    });

    it('should differentiate between different order IDs', async () => {
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      expect(await isWebhookReplay('binance', 'order-456', 'BTCUSDT')).toBe(false);
    });
  });

  describe('markWebhookProcessed', () => {
    it('should store processed flag in KV with 24h TTL', async () => {
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      const entry = mockKV.store.get('webhook:replay:binance:BTCUSDT:order-123');
      expect(entry).toBeDefined();
      expect(entry.value).toBe('processed');
      expect(entry.ttl).toBe(86400);
    });

    it('should not overwrite existing entry (uses add not put)', async () => {
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      const entry1 = mockKV.store.get('webhook:replay:binance:BTCUSDT:order-123');
      expect(entry1.value).toBe('processed');

      // Second call should not overwrite
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      const entry2 = mockKV.store.get('webhook:replay:binance:BTCUSDT:order-123');
      expect(entry2.value).toBe('processed'); // Still the same
    });

    it('should log warning when KV is not available', async () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      // @ts-ignore
      delete globalThis.KV;
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      expect(consoleSpy).toHaveBeenCalledWith('[ApexOS]', '[ReplayProtection] KV not available, cannot mark webhook as processed');
      consoleSpy.mockRestore();
    });

    it('should log error on KV failures', async () => {
      const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockKV.add = jest.fn().mockRejectedValue(new Error('KV error'));
      await markWebhookProcessed('binance', 'order-123', 'BTCUSDT');
      expect(consoleSpy).toHaveBeenCalledWith('[ApexOS]', '[ReplayProtection] Error marking webhook as processed:', expect.any(Error));
      consoleSpy.mockRestore();
    });
  });

  describe('checkAndMarkWebhook', () => {
    it('should return true for first processing and false for duplicates', async () => {
      // First call should return true (first time)
      expect(await checkAndMarkWebhook('binance', 'order-123', 'BTCUSDT')).toBe(true);
      // Second call should return false (already processed)
      expect(await checkAndMarkWebhook('binance', 'order-123', 'BTCUSDT')).toBe(false);
    });

    it('should return true when KV is unavailable (fail open)', async () => {
      // @ts-ignore
      delete globalThis.KV;
      expect(await checkAndMarkWebhook('binance', 'order-123', 'BTCUSDT')).toBe(true);
    });
  });

  describe('buildReplayKey', () => {
    it('should build correct key format', () => {
      expect(buildReplayKey('binance', 'order-123', 'BTCUSDT')).toBe('webhook:replay:binance:BTCUSDT:order-123');
    });

    it('should handle special characters in orderId', () => {
      const orderId = 'order:with/colons?and=equals';
      expect(buildReplayKey('binance', orderId, 'BTCUSDT')).toBe(`webhook:replay:binance:BTCUSDT:${orderId}`);
    });
  });

  describe('TTL Configuration', () => {
    it('REPLAY_PROTECTION_TTL should be 24 hours (86400 seconds)', () => {
      expect(REPLAY_PROTECTION_TTL).toBe(86400);
    });
  });

  describe('Idempotency and Race Conditions', () => {
    it('should handle concurrent mark attempts safely', async () => {
      await Promise.all([
        markWebhookProcessed('binance', 'order-123', 'BTCUSDT'),
        markWebhookProcessed('binance', 'order-123', 'BTCUSDT'),
      ]);

      const entry = mockKV.store.get('webhook:replay:binance:BTCUSDT:order-123');
      expect(entry).toBeDefined();
      expect(entry.value).toBe('processed');
    });

    it('concurrent checkAndMarkWebhook should only allow one to succeed', async () => {
      const results = await Promise.all([
        checkAndMarkWebhook('binance', 'order-123', 'BTCUSDT'),
        checkAndMarkWebhook('binance', 'order-123', 'BTCUSDT'),
      ]);

      // Exactly one should be true, one should be false
      const trueCount = results.filter(r => r === true).length;
      const falseCount = results.filter(r => r === false).length;
      expect(trueCount).toBe(1);
      expect(falseCount).toBe(1);
    });
  });

  describe('Fail-Open Behavior', () => {
    it('isWebhookReplay should allow requests when KV fails', async () => {
      mockKV.get = jest.fn().mockRejectedValue(new Error('KV down'));
      expect(await isWebhookReplay('binance', 'order-123', 'BTCUSDT')).toBe(false);
    });

    it('markWebhookProcessed should not throw when KV fails', async () => {
      mockKV.add = jest.fn().mockRejectedValue(new Error('KV down'));
      await expect(markWebhookProcessed('binance', 'order-123', 'BTCUSDT')).resolves.toBeUndefined();
    });

    it('checkAndMarkWebhook should allow requests when KV fails', async () => {
      mockKV.add = jest.fn().mockRejectedValue(new Error('KV down'));
      expect(await checkAndMarkWebhook('binance', 'order-123', 'BTCUSDT')).toBe(true);
    });
  });
});
