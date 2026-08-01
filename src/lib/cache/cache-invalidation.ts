/**
 * Cache Invalidation Hooks
 *
 * Provides functions to invalidate cache entries when underlying data changes.
 * Use these in mutation endpoints, webhooks, and admin actions to ensure
 * cache consistency.
 *
 * @example In a webhook handler:
 * ```ts
 * import { invalidateAffiliateCache } from '@/lib/cache/cache-invalidation';
 *
 * // After processing a new conversion
 * await invalidateAffiliateCache(affiliateId, ['dashboard', 'conversions']);
 * ```
 */

import cache from './kv-cache';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Cache types that can be invalidated
 */
export type CacheType =
  | 'affiliate-dashboard'
  | 'affiliate-conversions'
  | 'affiliate-payouts'
  | 'admin-analytics-overview'
  | 'admin-analytics-timeseries'
  | 'admin-analytics-countries'
  | 'admin-analytics-top-pages'
  | 'admin-analytics-referrers'
  | 'admin-analytics-devices'
  | 'public-deals';

// ============================================================================
// Invalidation Functions
// ============================================================================

/**
 * Invalidate affiliate-specific cache entries
 * Call this when affiliate data changes (new conversion, payout, etc.)
 */
export async function invalidateAffiliateCache(
  affiliateId: string,
  types?: CacheType[]
): Promise<void> {
  const kvAvailable = cache.isKVAvailable();
  if (!kvAvailable) return;

  const typesToInvalidate = types || [
    'affiliate-dashboard',
    'affiliate-conversions',
    'affiliate-payouts',
  ];

  const keysToDelete: string[] = [];

  for (const cacheType of typesToInvalidate) {
    switch (cacheType) {
      case 'affiliate-dashboard':
        keysToDelete.push(`affiliate-dashboard:user:${affiliateId}:v1`);
        break;
      case 'affiliate-conversions':
        // Invalidate all paginated conversions for this user
        // Note: In production, you'd maintain a key index for efficient deletion
        // For now, we rely on TTL expiry
        logInfo(`[Invalidation] conversions for affiliate ${affiliateId} (relying on TTL)`);
        break;
      case 'affiliate-payouts':
        keysToDelete.push(`affiliate-payouts:user:${affiliateId}:v1`);
        break;
    }
  }

  // Delete identified keys
  const kv = cache.getKV();
  if (kv) {
    await Promise.all(
      keysToDelete.map((key) => {
        try {
          return kv.delete(key);
        } catch (error) {
          logError(`[Invalidation] Error deleting key ${key}:`, error);
          return false;
        }
      })
    );
  }

  if (keysToDelete.length > 0) {
    logInfo(`[Invalidation] Invalidated ${keysToDelete.length} cache entries for affiliate ${affiliateId}`);
  }
}

/**
 * Invalidate public deals cache
 * Call this when deals are created, updated, or deleted
 */
export async function invalidatePublicDealsCache(): Promise<void> {
  const kvAvailable = cache.isKVAvailable();
  if (!kvAvailable) return;

  // The public deals cache uses query-based keys, so we need to delete all keys with the prefix
  // Note: Cloudflare KV doesn't support prefix deletion natively
  // For production, maintain a key index or use a version-based approach
  logInfo('[Invalidation] Public deals cache - relying on TTL expiry');
  // Alternative: use versioned cache keys by incrementing a global version token
}

/**
 * Invalidate admin analytics cache
 * Call this when analytics data might be stale (e.g., after data import)
 */
export async function invalidateAnalyticsCache(
  types?: CacheType[]
): Promise<void> {
  const kvAvailable = cache.isKVAvailable();
  if (!kvAvailable) return;

  const typesToInvalidate = types || [
    'admin-analytics-overview',
    'admin-analytics-timeseries',
    'admin-analytics-countries',
    'admin-analytics-top-pages',
    'admin-analytics-referrers',
    'admin-analytics-devices',
  ];

  logInfo(`[Invalidation] Analytics cache types: ${typesToInvalidate.join(', ')} (relying on TTL)`);
  // Analytics data is frequently updated from external sources
  // For now, rely on TTL (60s) for freshness
}

/**
 * Invalidate all cache for a specific user
 * Use sparingly - this clears everything for that user
 */
export async function invalidateAllForUser(userId: string): Promise<void> {
  await invalidateAffiliateCache(userId, [
    'affiliate-dashboard',
    'affiliate-conversions',
    'affiliate-payouts',
  ]);
}

/**
 * Invalidate all cache globally
 * Use only in emergency or maintenance scenarios
 */
export async function invalidateAllCache(): Promise<void> {
  const kvAvailable = cache.isKVAvailable();
  if (!kvAvailable) return;

  logWarn('[Invalidation] Global cache invalidation requested (KV prefix deletion not natively supported)');
  // In production, implement a version-based approach:
  // 1. Store a global version number in KV
  // 2. Include version in all cache keys
  // 3. Increment version to invalidate all keys
}

// ============================================================================
// Helper: Versioned Cache Keys
// ============================================================================

let cachedVersion: number | null = null;
let versionFetchTime: number = 0;
const VERSION_TTL = 60_000; // 1 minute cache for version

// For testing only - reset version cache
export function __resetCacheVersion(): void {
  cachedVersion = null;
  versionFetchTime = 0;
}

export async function getCacheVersion(): Promise<number> {
  const kv = cache.isKVAvailable() ? (globalThis as any).KV : null;
  if (!kv) return 1; // Default version when KV not available

  const now = Date.now();
  if (cachedVersion !== null && now - versionFetchTime < VERSION_TTL) {
    return cachedVersion;
  }

  try {
    const versionStr = await kv.get('cache:version', 'text');
    const version = versionStr ? parseInt(versionStr, 10) : 1;
    cachedVersion = isNaN(version) ? 1 : version;
    versionFetchTime = now;
    return cachedVersion;
  } catch (error) {
    logError('[Cache] Error fetching version:', error);
    return 1;
  }
}

/**
 * Increment the global cache version
 * This effectively invalidates all cache entries that use versioned keys
 */
export async function incrementCacheVersion(): Promise<number> {
  const kv = cache.isKVAvailable() ? (globalThis as any).KV : null;
  if (!kv) return 1;

  try {
    const current = await getCacheVersion();
    const next = current + 1;
    await kv.put('cache:version', String(next), { expirationTtl: 3600 * 24 * 30 }); // 30 days
    cachedVersion = next;
    logInfo(`[Invalidation] Cache version incremented to ${next}`);
    return next;
  } catch (error) {
    logError('[Cache] Error incrementing version:', error);
    return 1;
  }
}

// ============================================================================
// Export
// ============================================================================

const cacheInvalidation = {
  invalidateAffiliateCache,
  invalidatePublicDealsCache,
  invalidateAnalyticsCache,
  invalidateAllForUser,
  invalidateAllCache,
  getCacheVersion,
  incrementCacheVersion,
};

export default cacheInvalidation;
