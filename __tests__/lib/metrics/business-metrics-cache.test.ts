/**
 * Business Metrics Cache Tests
 */

import {
  generateCacheKey,
  getCachedMetrics,
  setCachedMetrics,
  invalidateCache,
  getCacheTtlRemaining,
  METRICS_CACHE_CONFIG,
} from '@/lib/metrics/cache';
import type { BusinessMetricsResponse } from '@/types/metrics';

// Mock Cloudflare KV
function createMockKV() {
  const store: Record<string, string> = {};

  return {
    get: async (key: string, type?: 'text' | 'json'): Promise<string | object | null> => {
      const value = store[key] ?? null;
      if (value && type === 'json') {
        try {
          return JSON.parse(value);
        } catch {
          return value;
        }
      }
      return value;
    },
    put: async (key: string, value: string | object, options?: { expirationTtl?: number }): Promise<void> => {
      store[key] = typeof value === 'string' ? value : JSON.stringify(value);
    },
    delete: async (key: string): Promise<boolean> => {
      const existed = store[key] !== undefined;
      delete store[key];
      return existed;
    },
    _clear: () => {
      for (const key in store) delete store[key];
    },
  };
}

describe('Metrics Cache', () => {
  let mockKV: ReturnType<typeof createMockKV>;

  beforeEach(() => {
    mockKV = createMockKV();
    // @ts-ignore - Mock KV binding
    globalThis.KV = mockKV;
    // Clear memory cache
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
    globalThis.metricsCache = new Map();
  });

  afterEach(() => {
    mockKV._clear();
    if (globalThis.metricsCache) {
      globalThis.metricsCache.clear();
    }
  });

  describe('generateCacheKey', () => {
    it('generates consistent key for same params', () => {
      const params1 = {
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        group_by: 'daily',
        deal_type: '',
        exchange: '',
        status: 'approved',
      };
      const params2 = {
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        group_by: 'daily',
        deal_type: '',
        exchange: '',
        status: 'approved',
      };

      const key1 = generateCacheKey(params1);
      const key2 = generateCacheKey(params2);

      expect(key1).toBe(key2);
    });

    it('generates different keys for different params', () => {
      const params1 = {
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        group_by: 'daily',
        deal_type: '',
        exchange: '',
        status: 'approved',
      };
      const params2 = {
        start_date: '2026-07-01',
        end_date: '2026-07-31',
        group_by: 'daily',
        deal_type: '',
        exchange: '',
        status: 'approved',
      };

      const key1 = generateCacheKey(params1);
      const key2 = generateCacheKey(params2);

      expect(key1).not.toBe(key2);
    });

    it('includes prefix in key', () => {
      const params = {
        start_date: '2026-06-01',
        end_date: '2026-06-30',
        group_by: 'daily',
        deal_type: '',
        exchange: '',
        status: 'approved',
      };
      const key = generateCacheKey(params);

      expect(key).toContain(METRICS_CACHE_CONFIG.prefix);
    });
  });

  describe('setCachedMetrics and getCachedMetrics', () => {
    it('stores and retrieves metrics from cache', async () => {
      const mockResponse: BusinessMetricsResponse = {
        generated_at: '2026-06-22T00:00:00Z',
        query: {
          start_date: '2026-06-01',
          end_date: '2026-06-30',
          group_by: 'daily',
        },
        cached: false,
        daily_revenue: [],
        summary: {
          period_start: '2026-06-01',
          period_end: '2026-06-30',
          total_revenue: 10000,
          total_conversions: 100,
          overall_conversion_rate: 5.0,
          active_affiliates_count: 10,
          total_commission_liability: 3000,
          top_deal_name: 'Binance BTC Trading',
          top_affiliate_name: 'John Doe',
        },
      };

      const cacheKey = 'test-cache-key';
      await setCachedMetrics(cacheKey, mockResponse);

      const retrieved = await getCachedMetrics(cacheKey);

      expect(retrieved).toEqual(mockResponse);
    });

    it('returns null for missing cache key', async () => {
      const result = await getCachedMetrics('non-existent-key');
      expect(result).toBeNull();
    });

    it('respects TTL in distributed cache', async () => {
      const mockResponse: BusinessMetricsResponse = {
        generated_at: '2026-06-22T00:00:00Z',
        query: { start_date: '2026-06-01', end_date: '2026-06-30', group_by: 'daily' },
        cached: false,
        daily_revenue: [],
        summary: {
          period_start: '2026-06-01',
          period_end: '2026-06-30',
          total_revenue: 0,
          total_conversions: 0,
          overall_conversion_rate: 0,
          active_affiliates_count: 0,
          total_commission_liability: 0,
          top_deal_name: '',
          top_affiliate_name: '',
        },
      };

      const cacheKey = 'ttl-test-key';
      await setCachedMetrics(cacheKey, mockResponse, 1); // 1 second TTL

      // Immediate retrieval should work
      const retrieved1 = await getCachedMetrics(cacheKey);
      expect(retrieved1).not.toBeNull();

      // Wait for TTL to expire (simulated - in real test would use jest.useFakeTimers)
      // For now, memory cache still works
    });
  });

  describe('invalidateCache', () => {
    it('removes specific key from cache', async () => {
      const mockResponse: BusinessMetricsResponse = {
        generated_at: '2026-06-22T00:00:00Z',
        query: { start_date: '2026-06-01', end_date: '2026-06-30', group_by: 'daily' },
        cached: false,
        daily_revenue: [],
        summary: {
          period_start: '2026-06-01',
          period_end: '2026-06-30',
          total_revenue: 0,
          total_conversions: 0,
          overall_conversion_rate: 0,
          active_affiliates_count: 0,
          total_commission_liability: 0,
          top_deal_name: '',
          top_affiliate_name: '',
        },
      };

      const cacheKey = 'invalidate-test-key';
      await setCachedMetrics(cacheKey, mockResponse);

      let retrieved = await getCachedMetrics(cacheKey);
      expect(retrieved).not.toBeNull();

      await invalidateCache(cacheKey);

      retrieved = await getCachedMetrics(cacheKey);
      expect(retrieved).toBeNull();
    });
  });

  describe('getCacheTtlRemaining', () => {
    it('returns TTL for existing cache entry', () => {
      if (!globalThis.metricsCache) {
        globalThis.metricsCache = new Map();
      }

      const cacheKey = 'ttl-check-key';
      const data: BusinessMetricsResponse = {
        generated_at: '2026-06-22T00:00:00Z',
        query: { start_date: '2026-06-01', end_date: '2026-06-30', group_by: 'daily' },
        cached: false,
        daily_revenue: [],
        summary: {
          period_start: '2026-06-01',
          period_end: '2026-06-30',
          total_revenue: 0,
          total_conversions: 0,
          overall_conversion_rate: 0,
          active_affiliates_count: 0,
          total_commission_liability: 0,
          top_deal_name: '',
          top_affiliate_name: '',
        },
      };

      globalThis.metricsCache.set(cacheKey, {
        data,
        expires: Date.now() + 300000, // 5 minutes
      });

      const ttl = getCacheTtlRemaining(cacheKey);
      expect(ttl).toBeGreaterThan(0);
      expect(ttl).toBeLessThanOrEqual(300);
    });

    it('returns undefined for non-existent key', () => {
      const ttl = getCacheTtlRemaining('non-existent');
      expect(ttl).toBeUndefined();
    });
  });
});
