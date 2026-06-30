/**
 * Unit Tests for KV Cache Utility
 *
 * Tests the caching layer using mocked Cloudflare KV namespace.
 */

import {
  getKV,
  isKVAvailable,
  getCacheKey,
  getUserIdCacheKey,
  getGlobalCacheKey,
  getCached,
  setCache,
  invalidateCache,
  buildCacheControlHeader,
  setCacheHeaders,
  getCacheStats,
  resetCacheStats,
} from '@/lib/cache/kv-cache';

// Mock KV
const store = new Map<string, string>();

const mockKVNamespace = {
  async get(key: string, type?: 'text' | 'json'): Promise<string | null> {
    const value = store.get(key) || null;
    if (type === 'json' && value) {
      try {
        return JSON.parse(value);
      } catch {
        // Simulate KV behavior: invalid JSON should be treated as cache miss
        return null;
      }
    }
    return value;
  },
  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    store.set(key, value);
  },
  async add(key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean> {
    if (store.has(key)) {
      return false;
    }
    store.set(key, value);
    return true;
  },
  async delete(key: string): Promise<boolean> {
    return store.delete(key);
  },
};

// Setup globalThis.KV mock
beforeEach(() => {
  // Reset stats
  resetCacheStats();

  // Clear mock data
  store.clear();

  // Set up KV binding
  (globalThis as any).KV = mockKVNamespace;
});

describe('isKVAvailable', () => {
  it('should return true when KV is bound', () => {
    expect(isKVAvailable()).toBe(true);
  });

  it('should return false when KV is not bound', () => {
    (globalThis as any).KV = undefined;
    expect(isKVAvailable()).toBe(false);
  });
});

describe('getCacheKey', () => {
  it('should generate consistent key from request', () => {
    const request = new Request('https://example.com/api/test?foo=bar&baz=qux');
    const key = getCacheKey(request, 'test-prefix');
    // Query params are sorted alphabetically: baz=qux&foo=bar
    expect(key).toBe('test-prefix:/api/test:baz=qux&foo=bar:');
  });

  it('should sort query parameters for consistency', () => {
    const request = new Request('https://example.com/api/test?z=last&a=first');
    const key = getCacheKey(request, 'test-prefix');
    expect(key).toBe('test-prefix:/api/test:a=first&z=last:');
  });

  it('should include params in key', () => {
    const request = new Request('https://example.com/api/test');
    const key = getCacheKey(request, 'test-prefix', { userId: '123' });
    // Empty query becomes 'default'
    expect(key).toBe('test-prefix:/api/test:default:userId=123');
  });

  it('should ignore specified query params', () => {
    const request = new Request('https://example.com/api/test?keep=this&ignore=that');
    const key = getCacheKey(request, 'test-prefix', undefined, {
      ignoreQueryParams: ['ignore'],
    });
    expect(key).toBe('test-prefix:/api/test:keep=this:');
  });

  it('should remove locale prefix from path', () => {
    const request = new Request('https://example.com/vi/api/test');
    const key = getCacheKey(request, 'test-prefix');
    // Empty query becomes 'default'
    expect(key).toBe('test-prefix:/api/test:default:');
  });
});

describe('getUserIdCacheKey', () => {
  it('should generate user-specific cache key', () => {
    const key = getUserIdCacheKey('dashboard', 'user-123');
    expect(key).toBe('dashboard:user:user-123');
  });

  it('should include subKey when provided', () => {
    const key = getUserIdCacheKey('dashboard', 'user-123', 'v1');
    expect(key).toBe('dashboard:user:user-123:v1');
  });
});

describe('getGlobalCacheKey', () => {
  it('should generate global cache key', () => {
    const key = getGlobalCacheKey('analytics', 'overview');
    expect(key).toBe('analytics:global:overview');
  });

  it('should include timeRange in key', () => {
    const key = getGlobalCacheKey('analytics', 'timeRange:7d');
    expect(key).toBe('analytics:global:timeRange:7d');
  });
});

describe('getCached and setCache', () => {
  it('should store and retrieve cached data', async () => {
    const key = 'test:key:1';
    const data = { foo: 'bar', count: 42 };

    await setCache(key, data, 60);
    const cached = await getCached<typeof data>(key);

    expect(cached).toEqual(data);
  });

  it('should return null for missing cache entry', async () => {
    const cached = await getCached<{ foo: string }>('nonexistent:key');
    expect(cached).toBeNull();
  });

  it('should handle JSON serialization errors gracefully', async () => {
    // Store invalid JSON in KV directly
    store.set('bad:key', 'not valid json');

    const cached = await getCached<{ foo: string }>('bad:key');
    expect(cached).toBeNull();
  });

  it('should increment hits stat on cache hit', async () => {
    const key = 'test:hits';
    await setCache(key, { test: true }, 60);
    await getCached(key);

    const stats = getCacheStats();
    expect(stats.hits).toBe(1);
  });

  it('should increment misses stat on cache miss', async () => {
    await getCached<{ test: boolean }>('nonexistent:miss');
    const stats = getCacheStats();
    expect(stats.misses).toBe(1);
  });
});

describe('invalidateCache', () => {
  it('should delete cache entry', async () => {
    const key = 'test:delete';
    await setCache(key, { data: 'test' }, 60);
    expect(await getCached(key)).not.toBeNull();

    const result = await invalidateCache(key);
    expect(result).toBe(true);
    expect(await getCached(key)).toBeNull();
  });

  it('should return false when KV not available', async () => {
    (globalThis as any).KV = undefined;
    const result = await invalidateCache('some:key');
    expect(result).toBe(false);
  });
});

describe('buildCacheControlHeader', () => {
  it('should build basic public cache header without SWR', () => {
    const header = buildCacheControlHeader(60);
    expect(header).toBe('public, s-maxage=60');
  });

  it('should include stale-while-revalidate option', () => {
    const header = buildCacheControlHeader(60, { staleWhileRevalidate: 120 });
    expect(header).toBe('public, s-maxage=60, stale-while-revalidate=120');
  });

  it('should include stale-if-error option', () => {
    const header = buildCacheControlHeader(60, { staleIfError: 3600 });
    expect(header).toBe('public, s-maxage=60, stale-if-error=3600');
  });

  it('should include both SWR and SIE', () => {
    const header = buildCacheControlHeader(60, { staleWhileRevalidate: 30, staleIfError: 3600 });
    expect(header).toBe('public, s-maxage=60, stale-while-revalidate=30, stale-if-error=3600');
  });

  it('should mark as private when requested', () => {
    const header = buildCacheControlHeader(60, { isPrivate: true });
    expect(header).toBe('private, s-maxage=60');
  });
});

describe('setCacheHeaders', () => {
  it('should build standard cache headers with default SWR', () => {
    const headers = setCacheHeaders(60, 'MISS');
    expect(headers['Cache-Control']).toBe('public, s-maxage=60, stale-while-revalidate=30');
    expect(headers['X-Cache']).toBe('MISS');
    expect(headers['Vary']).toBe('Accept, Accept-Encoding');
  });

  it('should allow disabling SWR', () => {
    const headers = setCacheHeaders(60, 'MISS', { staleWhileRevalidate: 0 });
    expect(headers['Cache-Control']).toBe('public, s-maxage=60');
  });

  it('should include custom headers', () => {
    const headers = setCacheHeaders(60, 'MISS', {
      custom: { 'X-Custom': 'value' },
    });
    expect(headers['X-Custom']).toBe('value');
  });
});

describe('Cache Stats', () => {
  it('should track cache hits and misses', async () => {
    const key = 'stats:test';

    // Miss
    await getCached(key);
    let stats = getCacheStats();
    expect(stats.misses).toBe(1);

    // Hit
    await setCache(key, { data: 'test' }, 60);
    await getCached(key);
    stats = getCacheStats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
  });

  it('should reset stats correctly', () => {
    resetCacheStats();
    const stats = getCacheStats();
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
    expect(stats.errors).toBe(0);
    expect(stats.lastReset).toBeGreaterThan(0);
  });
});

describe('KV Fallback Behavior', () => {
  it('should return null when KV not available for get', async () => {
    (globalThis as any).KV = undefined;
    const result = await getCached('any:key');
    expect(result).toBeNull();
  });

  it('should return false when KV not available for set', async () => {
    (globalThis as any).KV = undefined;
    const result = await setCache('any:key', { data: 'test' }, 60);
    expect(result).toBe(false);
  });

  it('should return false when KV not available for invalidate', async () => {
    (globalThis as any).KV = undefined;
    const result = await invalidateCache('any:key');
    expect(result).toBe(false);
  });
});
