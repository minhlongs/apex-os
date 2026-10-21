/**
 * Cloudflare KV Caching Utility for Next.js on Cloudflare Pages
 *
 * Provides a reusable caching layer for API routes with:
 * - Automatic KV namespace detection
 * - Configurable TTL per cache type
 * - Cache key generation from request/params
 * - Cache-Control header generation
 * - Cache metrics (hits/misses)
 * - Automatic fail-open on KV errors
 *
 * @example Basic usage in API route:
 * ```ts
 * import { withCache, getCacheKey, setCacheHeaders } from '@/lib/cache/kv-cache';
 *
 * export const GET = withRateLimit(withCache(async (request) => {
 *   const cacheKey = getCacheKey(request, 'dashboard', { userId });
 *   const cached = await getCached(cacheKey);
 *   if (cached) return NextResponse.json(cached, setCacheHeaders(60, 'HIT'));
 *
 *   const data = await fetchFromDB();
 *   await setCache(cacheKey, data, 60);
 *   return NextResponse.json(data, setCacheHeaders(60, 'MISS'));
 * }));
 * ```
 */

import { NextRequest, NextResponse } from 'next/server';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Cache configuration for a specific data type
 */
export interface CacheConfig {
  /** Cache key prefix (namespace) */
  prefix: string;
  /** Time-to-live in seconds */
  ttl: number;
  /** Whether to cache errors (default: false) */
  cacheErrors?: boolean;
  /** Custom key generator function */
  keyGenerator?: (request: NextRequest, params?: Record<string, string>) => string;
  /** Vary header values for CDN caching */
  vary?: string[];
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number;
  misses: number;
  errors: number;
  lastReset: number;
}

// ============================================================================
// Cloudflare KV Interface
// ============================================================================

/**
 * Cloudflare KV namespace binding type
 */
export interface CloudflareKVNamespace {
  get(key: string, type?: 'text' | 'json'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  add(key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean>;
  delete(key: string): Promise<boolean>;
}

// ============================================================================
// KV Access
// ============================================================================

/**
 * Get KV namespace from global Cloudflare bindings
 * In Cloudflare Pages/Workers, KV is bound via wrangler.toml
 */
function getKV(): CloudflareKVNamespace | null {
  // The KV binding is injected by the Cloudflare runtime, so it is absent from
  // the typed global scope; read it structurally to keep the lookup error-free.
  const kv = (globalThis as { KV?: CloudflareKVNamespace }).KV;
  if (!kv || typeof kv.get !== 'function') {
    return null;
  }
  return kv;
}

/**
 * Check if KV is available (running on Cloudflare)
 */
export function isKVAvailable(): boolean {
  return getKV() !== null;
}

// ============================================================================
// Cache Statistics (in-memory, per-instance)
// ============================================================================

let stats: CacheStats = {
  hits: 0,
  misses: 0,
  errors: 0,
  lastReset: Date.now(),
};

export function getCacheStats(): CacheStats {
  return { ...stats };
}

export function resetCacheStats(): void {
  stats = {
    hits: 0,
    misses: 0,
    errors: 0,
    lastReset: Date.now(),
  };
}

// ============================================================================
// Cache Key Generation
// ============================================================================

/**
 * Generate a cache key from request URL and optional params
 * Normalizes query parameters for consistent keys
 */
export function getCacheKey(
  request: NextRequest,
  prefix: string,
  params?: Record<string, string>,
  options?: {
    ignoreQueryParams?: string[];
    includeBody?: boolean;
  }
): string {
  const url = new URL(request.url);
  const { ignoreQueryParams = [], includeBody = false } = options || {};

  // Build normalized query string (sorted for consistency)
  const entries = Array.from(url.searchParams.entries())
    .filter(([key]) => !ignoreQueryParams.includes(key))
    .sort(([a], [b]) => a.localeCompare(b));

  const queryString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  // Include URL path (without locale prefix if present)
  let path = url.pathname;
  // Remove locale prefix (e.g., /vi/api/... -> /api/...)
  path = path.replace(/^\/(vi|en)(?=\/)/, '');

  // Include params if provided
  const paramsString = params
    ? Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => `${k}=${v}`)
        .join('&')
    : '';

  // Include body hash if requested (for POST responses)
  let bodyHash = '';
  if (includeBody && request.body) {
    // Note: body can only be read once, so caller should handle this
    bodyHash = ':body';
  }

  return `${prefix}:${path}:${queryString || 'default'}:${paramsString}${bodyHash}`;
}

/**
 * Generate a simple cache key for user-specific data
 */
export function getUserIdCacheKey(prefix: string, userId: string, subKey?: string): string {
  return `${prefix}:user:${userId}${subKey ? `:${subKey}` : ''}`;
}

/**
 * Generate a cache key for global data (same for all users)
 */
export function getGlobalCacheKey(prefix: string, subKey: string): string {
  return `${prefix}:global:${subKey}`;
}

// ============================================================================
// Cache Operations
// ============================================================================

/**
 * Get data from KV cache
 */
export async function getCached<T>(key: string): Promise<T | null> {
  const kv = getKV();

  if (!kv) {
    return null;
  }

  try {
    const cached = await kv.get(key, 'json');
    if (cached) {
      stats.hits++;
      return cached as T;
    }
    stats.misses++;
    return null;
  } catch (error) {
    logError('[Cache] Get error:', error);
    stats.errors++;
    return null;
  }
}

/**
 * Set data in KV cache
 */
export async function setCache<T>(key: string, data: T, ttl: number): Promise<boolean> {
  const kv = getKV();

  if (!kv) {
    return false;
  }

  try {
    await kv.put(key, JSON.stringify(data), { expirationTtl: ttl });
    return true;
  } catch (error) {
    logError('[Cache] Set error:', error);
    stats.errors++;
    return false;
  }
}

/**
 * Delete a specific cache key
 */
export async function invalidateCache(key: string): Promise<boolean> {
  const kv = getKV();

  if (!kv) {
    return false;
  }

  try {
    return await kv.delete(key);
  } catch (error) {
    logError('[Cache] Invalidate error:', error);
    return false;
  }
}

/**
 * Delete all cache keys with a given prefix
 * WARNING: This is an expensive operation and should be used sparingly
 */
export async function invalidateCachePrefix(prefix: string): Promise<number> {
  const kv = getKV();

  if (!kv) {
    return 0;
  }

  // NOTE: Cloudflare KV does not support listing keys by prefix natively.
  // For production, you would need to maintain a key index or use a different approach.
  // This is a placeholder that logs a warning.
  logWarn('[Cache] invalidateCachePrefix not implemented - requires key index tracking');
  return 0;
}

// ============================================================================
// Cache-Control Headers
// ============================================================================

/**
 * Generate Cache-Control header string for CDN/edge caching
 */
export function buildCacheControlHeader(
  ttl: number,
  options?: {
    staleWhileRevalidate?: number;
    staleIfError?: number;
    isPrivate?: boolean;
  }
): string {
  const { staleWhileRevalidate = 0, staleIfError = 0, isPrivate = false } = options || {};

  const directives: string[] = [];

  if (isPrivate) {
    directives.push('private');
  } else {
    directives.push('public');
  }

  directives.push(`s-maxage=${ttl}`);

  if (staleWhileRevalidate > 0) {
    directives.push(`stale-while-revalidate=${staleWhileRevalidate}`);
  }

  if (staleIfError > 0) {
    directives.push(`stale-if-error=${staleIfError}`);
  }

  return directives.join(', ');
}

/**
 * Build standard cache headers for a response
 */
export function setCacheHeaders(
  ttl: number,
  cacheStatus: 'HIT' | 'MISS',
  options?: {
    staleWhileRevalidate?: number;
    vary?: string[];
    custom?: Record<string, string>;
  }
): Record<string, string> {
  const { staleWhileRevalidate = Math.floor(ttl / 2), vary = ['Accept', 'Accept-Encoding'], custom = {} } = options || {};

  const headers: Record<string, string> = {
    'Cache-Control': buildCacheControlHeader(ttl, { staleWhileRevalidate }),
    'X-Cache': cacheStatus,
    'Vary': vary.join(', '),
    ...custom,
  };

  return headers;
}

// ============================================================================
// Higher-Order Cache Wrapper
// ============================================================================

/**
 * Cache wrapper for API route handlers
 * Automatically manages cache key, get/set, and headers
 *
 * @param config - Cache configuration
 * @param handler - The route handler function
 * @returns Wrapped handler with caching
 *
 * @example:
 * ```ts
 * export const GET = withRateLimit(withCache({
 *   prefix: 'affiliate-dashboard',
 *   ttl: 30,
 *   keyGenerator: (req, { userId }) => getUserIdCacheKey('dashboard', userId)
 * }, async (request) => {
 *   // Fetch and return data
 * }));
 * ```
 */
export function withCache<T extends (...args: any[]) => Promise<any>>(
  config: CacheConfig,
  handler: T
): (...args: Parameters<T>) => Promise<any> {
  return async (...args: Parameters<T>): Promise<any> => {
    const request = args[0] as NextRequest;
    const startTime = Date.now();
    const kv = getKV();

    // Generate cache key
    const cacheKey = config.keyGenerator
      ? await config.keyGenerator(request, undefined)
      : getCacheKey(request, config.prefix);

    // Try cache first
    if (kv) {
      const cached = await kv.get(cacheKey, 'json');
      if (cached) {
        stats.hits++;
        const queryTime = Date.now() - startTime;
        logInfo(`[Cache] HIT ${cacheKey} (${queryTime}ms)`);

        return NextResponse.json(cached, {
          headers: {
            'Cache-Control': buildCacheControlHeader(config.ttl, {
              staleWhileRevalidate: Math.floor(config.ttl / 2),
            }),
            'X-Cache': 'HIT',
            'X-Cache-Query-Time': String(queryTime),
            'X-Cache-TTL': String(config.ttl),
            'Vary': config.vary?.join(', ') || 'Accept, Accept-Encoding',
          },
        });
      }
    }

    stats.misses++;
    const queryTime = Date.now() - startTime;

    // Execute handler
    const response = await handler(...args);

    // Cache the response if it's a NextResponse with JSON body
    if (kv && response instanceof NextResponse && config.ttl > 0) {
      try {
        const body = await response.clone().json();
        await kv.put(cacheKey, JSON.stringify(body), { expirationTtl: config.ttl });
        logInfo(`[Cache] CACHED ${cacheKey} (TTL: ${config.ttl}s, query: ${queryTime}ms)`);
      } catch (error) {
        logError('[Cache] Store error:', error);
        stats.errors++;
      }
    }

    // Add cache miss header
    if (response instanceof NextResponse) {
      const headers = new Headers(response.headers);
      headers.set('X-Cache', 'MISS');
      headers.set('X-Cache-Query-Time', String(queryTime));
      headers.set('Cache-Control', buildCacheControlHeader(config.ttl, {
        staleWhileRevalidate: Math.floor(config.ttl / 2),
      }));
      if (config.vary) {
        headers.set('Vary', config.vary.join(', '));
      }
      // Convert Headers to plain object
      const headersObj: Record<string, string> = {};
      headers.forEach((value, key) => {
        headersObj[key] = value;
      });
      return NextResponse.json(await response.clone().json(), { headers: headersObj });
    }

    return response;
  };
}

// ============================================================================
// Cache Invalidation Helpers
// ============================================================================

/**
 * Create an invalidation key for tracking related cache entries
 * Returns a key that should be included in all related cache entries
 */
export function createInvalidationTrackerKey(prefix: string, entityType: string, entityId: string): string {
  return `invalidation:${prefix}:${entityType}:${entityId}`;
}

/**
 * Get the current invalidation version/token for an entity
 * Increment this to invalidate all related cache entries
 */
export async function getInvalidationToken(
  entityType: string,
  entityId: string
): Promise<number> {
  const kv = getKV();
  if (!kv) return 0;

  const key = createInvalidationTrackerKey('global', entityType, entityId);
  const tokenStr = await kv.get(key);
  return tokenStr ? parseInt(tokenStr, 10) : 0;
}

/**
 * Invalidate all cache entries for an entity by incrementing its token
 * Cached entries should include this token in their key to become invalid
 */
export async function invalidateEntity(
  entityType: string,
  entityId: string
): Promise<boolean> {
  const kv = getKV();
  if (!kv) return false;

  const key = createInvalidationTrackerKey('global', entityType, entityId);
  const current = await getInvalidationToken(entityType, entityId);
  await kv.put(key, String(current + 1), { expirationTtl: 3600 * 24 * 30 }); // 30 days
  return true;
}

/**
 * Invalidate multiple entity types at once
 */
export async function invalidateEntities(
  entities: Array<{ type: string; id: string }>
): Promise<void> {
  await Promise.all(
    entities.map((entity) => invalidateEntity(entity.type, entity.id))
  );
}

// ============================================================================
// Export for convenience
// ============================================================================

const kvCache = {
  getKV,
  isKVAvailable,
  getCacheKey,
  getUserIdCacheKey,
  getGlobalCacheKey,
  getCached,
  setCache,
  invalidateCache,
  invalidateCachePrefix,
  withCache,
  setCacheHeaders,
  buildCacheControlHeader,
  getCacheStats,
  resetCacheStats,
  createInvalidationTrackerKey,
  getInvalidationToken,
  invalidateEntity,
  invalidateEntities,
};

export default kvCache;
