/**
 * Metrics Cache Utility
 * Provides distributed caching using Cloudflare KV with in-memory fallback
 */

import type { BusinessMetricsResponse, MetricsCacheConfig } from '@/types/metrics';
import { warn as logWarn } from '@/lib/logger';

const METRICS_CACHE_CONFIG: MetricsCacheConfig = {
  ttl: 300, // 5 minutes
  swr_ttl: 600, // 10 minutes
  prefix: 'metrics:business',
  use_distributed: true,
};

export { METRICS_CACHE_CONFIG };

type MetricsCacheEntry = { data: BusinessMetricsResponse; expires: number };
type MetricsMemoryCache = Map<string, MetricsCacheEntry>;

/**
 * Access the in-memory cache instance shared across module replicas via globalThis.
 * The slot is installed lazily on first write.
 */
function getMemoryCache(create: false): MetricsMemoryCache | undefined;
function getMemoryCache(create: true): MetricsMemoryCache;
function getMemoryCache(create: boolean): MetricsMemoryCache | undefined {
  const store = globalThis as typeof globalThis & { metricsCache?: MetricsMemoryCache };
  if (store.metricsCache) {
    return store.metricsCache;
  }
  if (create) {
    store.metricsCache = new Map<string, MetricsCacheEntry>();
    return store.metricsCache;
  }
  return undefined;
}

/**
 * Generate a cache key from query parameters
 * Uses simple string key since KV supports long keys
 */
export function generateCacheKey(params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const queryString = sortedKeys.map(key => `${key}=${params[key]}`).join('&');
  return `${METRICS_CACHE_CONFIG.prefix}:${queryString}`;
}

/**
 * Check if KV is available (Cloudflare Workers environment)
 */
function isKVAvailable(): boolean {
  // @ts-ignore - KV binding from wrangler.toml
  return typeof KV !== 'undefined' && KV.get !== undefined;
}

/**
 * Get cached metrics response
 */
export async function getCachedMetrics(cacheKey: string): Promise<BusinessMetricsResponse | null> {
  try {
    // Try distributed cache first (Cloudflare KV)
    if (isKVAvailable() && METRICS_CACHE_CONFIG.use_distributed) {
      // @ts-ignore
      const cached = await KV.get(cacheKey, 'json');
      if (cached) {
        return cached as BusinessMetricsResponse;
      }
    }

    // Fallback to in-memory cache
    const memoryCache = getMemoryCache(false);
    if (memoryCache) {
      const entry = memoryCache.get(cacheKey);
      if (entry && Date.now() < entry.expires) {
        return entry.data;
      } else if (entry) {
        memoryCache.delete(cacheKey);
      }
    }
  } catch (error) {
    logWarn('Cache read failed:', error);
  }

  return null;
}

/**
 * Set cached metrics response
 */
export async function setCachedMetrics(cacheKey: string, data: BusinessMetricsResponse, ttl: number = METRICS_CACHE_CONFIG.ttl): Promise<void> {
  try {
    // Set in distributed cache
    if (isKVAvailable() && METRICS_CACHE_CONFIG.use_distributed) {
      // @ts-ignore
      await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: ttl });
    }

    // Also set in memory for faster subsequent access in same instance
    if (typeof globalThis !== 'undefined') {
      getMemoryCache(true).set(cacheKey, {
        data,
        expires: Date.now() + ttl * 1000,
      });
    }
  } catch (error) {
    logWarn('Cache write failed:', error);
  }
}

/**
 * Invalidate cache for a specific key or pattern
 */
export async function invalidateCache(cacheKeyOrPattern: string): Promise<number> {
  let invalidated = 0;

  try {
    // Invalidate distributed cache
    if (isKVAvailable() && METRICS_CACHE_CONFIG.use_distributed) {
      // KV doesn't support pattern deletion, would need namespace approach
      // For now, just delete exact key matches
      // @ts-ignore
      await KV.delete(cacheKeyOrPattern);
      invalidated++;
    }

    // Invalidate memory cache
    const memoryCache = getMemoryCache(false);
    if (memoryCache) {
      if (cacheKeyOrPattern === '*') {
        const size = memoryCache.size;
        memoryCache.clear();
        invalidated += size;
      } else {
        const keysToDelete = Array.from(memoryCache.keys()).filter(k => k.includes(cacheKeyOrPattern));
        keysToDelete.forEach(k => memoryCache.delete(k));
        invalidated += keysToDelete.length;
      }
    }
  } catch (error) {
    logWarn('Cache invalidation failed:', error);
  }

  return invalidated;
}

/**
 * Get cache TTL remaining for a key (for response headers)
 */
export function getCacheTtlRemaining(cacheKey: string): number | undefined {
  const memoryCache = getMemoryCache(false);
  if (memoryCache) {
    const entry = memoryCache.get(cacheKey);
    if (entry) {
      return Math.max(0, Math.floor((entry.expires - Date.now()) / 1000));
    }
  }
  return undefined;
}
