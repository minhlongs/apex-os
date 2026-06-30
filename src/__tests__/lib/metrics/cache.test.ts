/**
 * Metrics Cache Unit Tests
 * ApexOS Metrics Module
 *
 * Coverage target: Caching layer (KV + in-memory), cache key generation, TTL, invalidation
 */

import {
  getCachedMetrics,
  setCachedMetrics,
  generateCacheKey,
  invalidateCache,
  getCacheTtlRemaining,
} from '@/lib/metrics/cache';
import type { BusinessMetricsResponse } from '@/types/metrics';

// ============================================================================
// Mock Response Helper
// ============================================================================

function getMockResponse(): BusinessMetricsResponse {
  return {
    generated_at: '2024-06-15T00:00:00Z',
    query: { start_date: '2024-06-01', end_date: '2024-06-30', group_by: 'daily' },
    cached: false,
    daily_revenue: [],
    conversion_rates: [],
    active_affiliates: {
      total_affiliates: 0,
      affiliates_with_conversions: 0,
      new_affiliates: 0,
      avg_lifetime_earnings: 0,
      top_performers: [],
      distribution_by_level: { level_1: 0, level_2: 0, level_3: 0 },
    },
    top_deals: {
      period: { start_date: '2024-06-01', end_date: '2024-06-30' },
      limit: 10,
      deals: [],
      summary: { total_clicks: 0, total_conversions: 0, total_revenue: 0, avg_conversion_rate: 0 },
    },
    summary: {
      period_start: '2024-06-01',
      period_end: '2024-06-30',
      total_revenue: 0,
      total_conversions: 0,
      overall_conversion_rate: 0,
      active_affiliates_count: 0,
      total_commission_liability: 0,
      top_deal_name: 'N/A',
      top_affiliate_name: 'N/A',
    },
  };
}

// ============================================================================
// Cache Key Generation Tests
// ============================================================================

describe('generateCacheKey', () => {
  it('should generate consistent key for same params', () => {
    const params = {
      start_date: '2024-06-01',
      end_date: '2024-06-30',
      group_by: 'daily',
      deal_type: '',
      exchange: '',
      status: 'approved',
    };
    const key1 = generateCacheKey(params);
    const key2 = generateCacheKey(params);
    expect(key1).toBe(key2);
  });

  it('should generate different keys for different date ranges', () => {
    const params1 = { start_date: '2024-06-01', end_date: '2024-06-30', group_by: 'daily' };
    const params2 = { start_date: '2024-07-01', end_date: '2024-07-31', group_by: 'daily' };
    const key1 = generateCacheKey(params1);
    const key2 = generateCacheKey(params2);
    expect(key1).not.toBe(key2);
  });

  it('should generate different keys for different group_by', () => {
    const params1 = { start_date: '2024-06-01', end_date: '2024-06-30', group_by: 'daily' };
    const params2 = { start_date: '2024-06-01', end_date: '2024-06-30', group_by: 'weekly' };
    const key1 = generateCacheKey(params1);
    const key2 = generateCacheKey(params2);
    expect(key1).not.toBe(key2);
  });

  it('should start with metrics:business prefix', () => {
    const params = { start_date: '2024-06-01', end_date: '2024-06-30', group_by: 'daily' };
    const key = generateCacheKey(params);
    expect(key.startsWith('metrics:business:')).toBe(true);
  });

  it('should sort keys before generating hash', () => {
    const params1 = { a: '1', b: '2' };
    const params2 = { b: '2', a: '1' };
    expect(generateCacheKey(params1)).toBe(generateCacheKey(params2));
  });

  it('should handle empty optional parameters', () => {
    const params = { start_date: '2024-06-01', end_date: '2024-06-30', group_by: 'daily' };
    const key = generateCacheKey(params);
    expect(typeof key).toBe('string');
    expect(key.length).toBeGreaterThan(0);
  });
});

// ============================================================================
// Cache Storage Tests (In-Memory)
// ============================================================================

describe('In-Memory Cache', () => {
  beforeEach(() => {
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    delete (globalThis as any).metricsCache;
  });

  it('should store and retrieve from memory cache', async () => {
    const cacheKey = 'test:key:123';
    const response = getMockResponse();
    await setCachedMetrics(cacheKey, response);

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).toEqual(response);
  });

  it('should return null for non-existent key', async () => {
    const cached = await getCachedMetrics('nonexistent:key');
    expect(cached).toBeNull();
  });

  it('should not return expired entries', async () => {
    const cacheKey = 'test:expiring:123';
    const expiredResponse = { ...getMockResponse(), cached: true };

    if (!globalThis.metricsCache) {
      globalThis.metricsCache = new Map();
    }
    (globalThis.metricsCache as Map<string, { data: BusinessMetricsResponse; expires: number }>).set(cacheKey, {
      data: expiredResponse,
      expires: Date.now() - 1000, // Expired
    });

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).toBeNull();
  });

  it('should return valid unexpired entries', async () => {
    const cacheKey = 'test:valid:123';
    if (!globalThis.metricsCache) {
      globalThis.metricsCache = new Map();
    }
    const response = getMockResponse();
    (globalThis.metricsCache as Map<string, { data: BusinessMetricsResponse; expires: number }>).set(cacheKey, {
      data: response,
      expires: Date.now() + 60000, // Valid for 60s
    });

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).toEqual(response);
  });

  it('should auto-clean expired entries on access', async () => {
    const cacheKey = 'test:auto-clean:123';
    if (!globalThis.metricsCache) {
      globalThis.metricsCache = new Map();
    }
    const cache = globalThis.metricsCache as Map<string, { data: BusinessMetricsResponse; expires: number }>;
    cache.set(cacheKey, {
      data: getMockResponse(),
      expires: Date.now() - 1000,
    });
    expect(cache.size).toBe(1);

    await getCachedMetrics(cacheKey);
    expect(cache.has(cacheKey)).toBe(false);
  });
});

// ============================================================================
// Cache TTL Tests
// ============================================================================

describe('Cache TTL', () => {
  beforeEach(() => {
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    delete (globalThis as any).metricsCache;
  });

  it('should use ~5 minute default TTL', async () => {
    const cacheKey = 'test:ttl:123';
    await setCachedMetrics(cacheKey, getMockResponse());

    const remaining = getCacheTtlRemaining(cacheKey);
    // Default TTL is 300 seconds (5 minutes)
    expect(remaining).toBeGreaterThan(295);
    expect(remaining).toBeLessThanOrEqual(300);
  });

  it('should respect custom TTL', async () => {
    const cacheKey = 'test:custom:ttl';
    await setCachedMetrics(cacheKey, getMockResponse(), 60); // 60 seconds

    const remaining = getCacheTtlRemaining(cacheKey);
    expect(remaining).toBeGreaterThan(55);
    expect(remaining).toBeLessThanOrEqual(60);
  });

  it('should return undefined for non-existent key', () => {
    const remaining = getCacheTtlRemaining('nonexistent:key');
    expect(remaining).toBeUndefined();
  });
});

// ============================================================================
// Cache Invalidation Tests
// ============================================================================

describe('invalidateCache', () => {
  beforeEach(() => {
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    delete (globalThis as any).metricsCache;
  });

  it('should invalidate specific cache key', async () => {
    const cacheKey = 'metrics:test:specific';
    await setCachedMetrics(cacheKey, getMockResponse());

    const deleted = await invalidateCache(cacheKey);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).toBeNull();
  });

  it('should invalidate all cache entries with wildcard', async () => {
    const keys = ['metrics:test:1', 'metrics:test:2', 'metrics:other:3'];
    for (const key of keys) {
      await setCachedMetrics(key, getMockResponse());
    }

    const deleted = await invalidateCache('test');
    expect(deleted).toBe(2); // Only keys with 'test' pattern

    // Verify pattern-matched are deleted
    expect(await getCachedMetrics('metrics:test:1')).toBeNull();
    expect(await getCachedMetrics('metrics:test:2')).toBeNull();
  });

  it('should invalidate all with asterisk', async () => {
    await setCachedMetrics('metrics:all:1', getMockResponse());
    await setCachedMetrics('metrics:all:2', getMockResponse());

    const deleted = await invalidateCache('*');
    expect(deleted).toBeGreaterThanOrEqual(2);
  });

  it('should return 0 when pattern matches nothing', async () => {
    const deleted = await invalidateCache('nonexistent:pattern:*');
    expect(deleted).toBe(0);
  });

  it('should handle empty memory cache gracefully', async () => {
    const deleted = await invalidateCache('any:pattern');
    expect(deleted).toBe(0);
  });
});

// ============================================================================
// Cache Hit/Miss Scenarios
// ============================================================================

describe('Cache Hit/Miss Scenarios', () => {
  beforeEach(() => {
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    delete (globalThis as any).metricsCache;
  });

  it('should return cache miss when key not found', async () => {
    const cached = await getCachedMetrics('metrics:not:found');
    expect(cached).toBeNull();
  });

  it('should return cache hit when key exists and not expired', async () => {
    const cacheKey = 'metrics:hit:test';
    await setCachedMetrics(cacheKey, getMockResponse());

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).not.toBeNull();
    expect(cached?.cached).toBe(false);
    expect(cached?.generated_at).toBe(getMockResponse().generated_at);
  });

  it('should handle concurrent writes safely', async () => {
    const cacheKey = 'metrics:concurrent:test';
    const response1 = { ...getMockResponse(), generated_at: '2024-06-15T00:00:01Z' };
    const response2 = { ...getMockResponse(), generated_at: '2024-06-15T00:00:02Z' };

    await Promise.all([
      setCachedMetrics(cacheKey, response1),
      setCachedMetrics(cacheKey, response2),
    ]);

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).not.toBeNull();
    // Last write wins (implementation dependent, but should have one value)
    expect(['2024-06-15T00:00:01Z', '2024-06-15T00:00:02Z']).toContain(cached?.generated_at);
  });
});

// ============================================================================
// KV Integration Tests (Conditional)
// ============================================================================

describe('KV Cache Integration', () => {
  beforeEach(() => {
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    delete (globalThis as any).metricsCache;
    delete (globalThis as any).KV;
  });

  it('should fall back to memory cache when KV unavailable', async () => {
    // Ensure KV is not defined
    expect((globalThis as any).KV).toBeUndefined();

    const cacheKey = 'test:fallback';
    await setCachedMetrics(cacheKey, getMockResponse());

    const cached = await getCachedMetrics(cacheKey);
    expect(cached).not.toBeNull();
  });

  it('should attempt KV first when available', async () => {
    // Mock KV
    const mockKV = {
      get: jest.fn(),
      put: jest.fn(),
      delete: jest.fn(),
    };
    (globalThis as any).KV = mockKV;

    const cacheKey = 'test:kv:key';
    const response = getMockResponse();

    await setCachedMetrics(cacheKey, response);
    expect(mockKV.put).toHaveBeenCalledWith(cacheKey, expect.any(String), expect.any(Object));
  });
});

// ============================================================================
// Error Handling Tests
// ============================================================================

describe('Cache Error Handling', () => {
  beforeEach(() => {
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    delete (globalThis as any).metricsCache;
  });

  it('should handle getCachedMetrics when cache throws', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation();

    // Corrupt the cache
    if (!globalThis.metricsCache) {
      globalThis.metricsCache = new Map();
    }
    (globalThis.metricsCache as any).set('corrupt', 'not-a-serializable-object');

    const result = await getCachedMetrics('corrupt');
    expect(result).toBeNull();

    warnSpy.mockRestore();
  });
});
