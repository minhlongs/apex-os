/**
 * Unit Tests for Cache Invalidation Module
 *
 * Tests cache invalidation functions and helper utilities.
 */

import {
  invalidateAffiliateCache,
  invalidatePublicDealsCache,
  invalidateAnalyticsCache,
  invalidateAllForUser,
  getCacheVersion,
  incrementCacheVersion,
  __resetCacheVersion,
} from '@/lib/cache/cache-invalidation';

// Mock KV
const store = new Map<string, string>();

const mockKVNamespace = {
  async get(key: string, type?: 'text' | 'json'): Promise<string | null> {
    return store.get(key) || null;
  },
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    store.set(key, value);
  },
  async delete(key: string): Promise<boolean> {
    return store.delete(key);
  },
};

// Reset globalThis.KV before each test
beforeEach(() => {
  store.clear();
  (globalThis as any).KV = mockKVNamespace;
});

describe('invalidateAffiliateCache', () => {
  it('should invalidate dashboard cache for affiliate', async () => {
    const affiliateId = 'user-123';

    // Manually set cache keys
    const dashboardKey = `affiliate-dashboard:user:${affiliateId}:v1`;
    store.set(dashboardKey, JSON.stringify({ test: true }));

    await invalidateAffiliateCache(affiliateId, ['affiliate-dashboard']);

    expect(store.has(dashboardKey)).toBe(false);
  });

  it('should invalidate multiple cache types', async () => {
    const affiliateId = 'user-456';

    const keys = [
      `affiliate-dashboard:user:${affiliateId}:v1`,
      `affiliate-payouts:user:${affiliateId}:v1`,
    ];
    keys.forEach(key => store.set(key, JSON.stringify({ data: 'test' })));

    await invalidateAffiliateCache(affiliateId, ['affiliate-dashboard', 'affiliate-payouts']);

    keys.forEach(key => {
      expect(store.has(key)).toBe(false);
    });
  });

  it('should invalidate all default types when none specified', async () => {
    const affiliateId = 'user-789';

    const keys = [
      `affiliate-dashboard:user:${affiliateId}:v1`,
      `affiliate-conversions:user:${affiliateId}:v1`, // This one relies on TTL, not deleted
      `affiliate-payouts:user:${affiliateId}:v1`,
    ];
    keys.forEach(key => store.set(key, JSON.stringify({ data: 'test' })));

    await invalidateAffiliateCache(affiliateId);

    // Dashboard and payouts should be deleted; conversions relies on TTL
    expect(store.has(keys[0])).toBe(false); // dashboard
    expect(store.has(keys[2])).toBe(false); // payouts
    // conversions (keys[1]) remains
  });

  it('should handle KV not available gracefully', async () => {
    (globalThis as any).KV = undefined;
    // Should not throw
    await invalidateAffiliateCache('user-123');
  });

  it('should log warning for conversions cache (prefix-based)', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await invalidateAffiliateCache('user-123', ['affiliate-conversions']);
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ApexOS]',
      '[Invalidation] conversions for affiliate user-123 (relying on TTL)'
    );
    consoleSpy.mockRestore();
  });
});

describe('invalidatePublicDealsCache', () => {
  it('should log warning about TTL reliance', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await invalidatePublicDealsCache();
    expect(consoleSpy).toHaveBeenCalledWith(
      '[ApexOS]',
      '[Invalidation] Public deals cache - relying on TTL expiry'
    );
    consoleSpy.mockRestore();
  });
});

describe('invalidateAnalyticsCache', () => {
  it('should invalidate all analytics types by default', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await invalidateAnalyticsCache();

    expect(consoleSpy).toHaveBeenCalledWith(
      '[ApexOS]',
      '[Invalidation] Analytics cache types: admin-analytics-overview, admin-analytics-timeseries, admin-analytics-countries, admin-analytics-top-pages, admin-analytics-referrers, admin-analytics-devices (relying on TTL)'
    );
    consoleSpy.mockRestore();
  });

  it('should invalidate only specified types', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    await invalidateAnalyticsCache(['admin-analytics-overview', 'admin-analytics-devices']);

    expect(consoleSpy).toHaveBeenCalledWith(
      '[ApexOS]',
      '[Invalidation] Analytics cache types: admin-analytics-overview, admin-analytics-devices (relying on TTL)'
    );
    consoleSpy.mockRestore();
  });
});

describe('invalidateAllForUser', () => {
  it('should invalidate all user-specific cache types', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const userId = 'user-999';
    const keys = [
      `affiliate-dashboard:user:${userId}:v1`,
      `affiliate-conversions:user:${userId}:v1`,
      `affiliate-payouts:user:${userId}:v1`,
    ];
    keys.forEach(key => store.set(key, JSON.stringify({ data: 'test' })));

    await invalidateAllForUser(userId);

    // Dashboard and payouts should be deleted
    expect(store.has(keys[0])).toBe(false);
    expect(store.has(keys[2])).toBe(false);

    consoleSpy.mockRestore();
  });
});

describe('getCacheVersion and incrementCacheVersion', () => {
  beforeEach(() => {
    store.clear();
    __resetCacheVersion();
  });

  it('should return default version 1 when not set', async () => {
    // Ensure store is empty
    store.delete('cache:version');
    const version = await getCacheVersion();
    expect(version).toBe(1);
  });

  it('should return stored version', async () => {
    store.set('cache:version', '5');
    const version = await getCacheVersion();
    expect(version).toBe(5);
  });

  it('should increment version correctly', async () => {
    store.set('cache:version', '3');
    const newVersion = await incrementCacheVersion();
    expect(newVersion).toBe(4);
    expect(store.get('cache:version')).toBe('4');
  });

  it('should handle invalid version string gracefully', async () => {
    store.set('cache:version', 'invalid');
    const version = await getCacheVersion();
    expect(version).toBe(1);
  });
});

describe('KV not available scenarios', () => {
  it('getCacheVersion should return 1 when KV unavailable', async () => {
    (globalThis as any).KV = undefined;
    const version = await getCacheVersion();
    expect(version).toBe(1);
  });

  it('incrementCacheVersion should return 1 when KV unavailable', async () => {
    (globalThis as any).KV = undefined;
    const version = await incrementCacheVersion();
    expect(version).toBe(1);
  });
});
