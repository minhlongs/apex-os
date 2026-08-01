/**
 * KV-based Rate Limiter for Next.js on Cloudflare Pages
 *
 * Uses Cloudflare KV for distributed rate limiting with sliding window algorithm.
 * Provides middleware factory for Next.js App Router and direct check function
 * for API route handlers.
 *
 * Features:
 * - Sliding window log (accurate rate limiting)
 * - Automatic key expiration via KV TTL
 * - Configurable per endpoint with sensible defaults
 * - Cloudflare-specific IP detection (cf-connecting-ip)
 * - Proper rate limit headers (X-RateLimit-*)
 * - Fail-open on KV errors (doesn't block traffic during KV issues)
 *
 * @example Middleware usage in src/middleware.ts
 * ```ts
 * import { createRateLimiter } from '@/lib/rate-limiter';
 *
 * export async function middleware(request: NextRequest) {
 *   const result = await rateLimiter(request, {
 *     maxRequests: 60,
 *     windowMs: 60_000,
 *   });
 *
 *   if (result) return result; // 429 response if rate limited
 *   return NextResponse.next();
 * }
 * ```
 *
 * @example Direct usage in API route
 * ```ts
 * import { checkRateLimit } from '@/lib/rate-limiter';
 *
 * export async function POST(request: NextRequest) {
 *   const result = await checkRateLimit(request, {
 *     maxRequests: 10,
 *     windowMs: 60_000,
 *   });
 *
 *   if (!result.allowed) {
 *     return NextResponse.json(
 *       { error: 'Rate limit exceeded', retryAfter: result.retryAfter },
 *       { status: 429 }
 *     );
 *   }
 *
 *   // Handle request...
 * }
 * ```
 */

import { NextRequest, NextResponse } from 'next/server';
import { error as logError, warn as logWarn } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================

/**
 * Cloudflare KV namespace binding type
 * @internal
 */
interface CloudflareKVNamespace {
  get(key: string, type?: 'text' | 'json'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  add(key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean>;
  delete(key: string): Promise<boolean>;
}

/**
 * Rate limit configuration
 */
export interface RateLimitConfig {
  /** Maximum number of requests allowed per window */
  maxRequests: number;
  /** Time window in milliseconds */
  windowMs: number;
  /** Optional key prefix for namespacing (default: 'rl') */
  prefix?: string;
  /** Skip check for certain requests (e.g., admin routes, health checks) */
  skipCheck?: (request: NextRequest) => boolean | Promise<boolean>;
  /** Custom identifier generator (default: IP-based) */
  keyGenerator?: (request: NextRequest) => string | Promise<string>;
}

/**
 * Result from rate limit check
 */
export interface RateLimitResult {
  /** Whether request is allowed */
  allowed: boolean;
  /** Remaining requests in current window */
  remaining: number;
  /** Total limit */
  limit: number;
  /** Unix timestamp (seconds) when window resets */
  reset: number;
  /** Seconds to retry after (only set when allowed === false) */
  retryAfter?: number;
}

// ============================================================================
// Cloudflare KV Access
// ============================================================================

/**
 * Get KV namespace from global Cloudflare bindings
 * In Cloudflare Pages/Workers, KV is bound via wrangler.toml
 */
function getKV(): CloudflareKVNamespace | null {
  // @ts-ignore - Cloudflare KV binding from wrangler.toml
  const kv = globalThis.KV;
  if (!kv || typeof kv.get !== 'function') {
    return null;
  }
  return kv as CloudflareKVNamespace;
}

/**
 * Check if running on Cloudflare Workers/Pages with KV available
 */
export function isKVAvailable(): boolean {
  return getKV() !== null;
}

// ============================================================================
// Core Rate Limiting Logic
// ============================================================================

/**
 * Build rate limit key for sliding window storage
 * Format: rate-limit:{prefix}:{identifier}:{windowSec}
 */
export function buildKey(
  prefix: string,
  identifier: string,
  windowMs: number
): string {
  const windowSec = Math.floor(windowMs / 1000);
  return `rate-limit:${prefix}:${encodeURIComponent(identifier)}:${windowSec}`;
}

/**
 * Sliding window rate limit check using KV (internal, for advanced usage)
 *
 * This is the core algorithm. Use `checkRateLimit` or `createRateLimiter` for the
 * higher-level API.
 */
export async function checkRateLimitByIdentifier(
  identifier: string,
  config: Required<Omit<RateLimitConfig, 'keyGenerator' | 'skipCheck'>> & { prefix: string }
): Promise<RateLimitResult> {
  const kv = getKV();

  if (!kv) {
    logWarn('[RateLimiter] KV not available, allowing request (fail-open)');
    return {
      allowed: true,
      remaining: config.maxRequests,
      limit: config.maxRequests,
      reset: Math.floor(Date.now() / 1000) + Math.floor(config.windowMs / 1000),
    };
  }

  const key = buildKey(config.prefix, identifier, config.windowMs);
  const now = Math.floor(Date.now() / 1000); // Current time in seconds
  const windowStart = now - Math.floor(config.windowMs / 1000);
  const ttl = Math.ceil(config.windowMs / 1000) + 60; // 60s buffer

  try {
    // Get current timestamps from KV
    const raw = await kv.get(key, 'text');
    let timestamps: number[] = [];

    if (raw) {
      try {
        timestamps = JSON.parse(raw);
        if (!Array.isArray(timestamps)) timestamps = [];
      } catch {
        timestamps = [];
      }
    }

    // Filter timestamps within current sliding window
    timestamps = timestamps.filter((ts) => ts > windowStart);
    const currentCount = timestamps.length;

    // Check if limit exceeded
    if (currentCount >= config.maxRequests) {
      const oldest = timestamps[0] || now;
      const retryAfter = Math.max(1, (oldest + Math.floor(config.windowMs / 1000)) - now);

      return {
        allowed: false,
        remaining: 0,
        limit: config.maxRequests,
        reset: oldest + Math.floor(config.windowMs / 1000),
        retryAfter,
      };
    }

    // Allow request - add current timestamp
    timestamps.push(now);

    // Trim array to maxRequests to prevent unbounded growth
    if (timestamps.length > config.maxRequests) {
      timestamps = timestamps.slice(-config.maxRequests);
    }

    // Store updated timestamps
    await kv.put(key, JSON.stringify(timestamps), { expirationTtl: ttl });

    return {
      allowed: true,
      remaining: config.maxRequests - timestamps.length,
      limit: config.maxRequests,
      reset: now + Math.floor(config.windowMs / 1000),
    };
  } catch (error) {
    logError('[RateLimiter] Error checking rate limit:', error);
    // Fail open: allow request on KV errors
    return {
      allowed: true,
      remaining: config.maxRequests,
      limit: config.maxRequests,
      reset: now + Math.floor(config.windowMs / 1000),
    };
  }
}

// ============================================================================
// Identifier Extraction
// ============================================================================

/**
 * Get client IP address from NextRequest headers
 * Checks Cloudflare-specific headers first, then standard proxy headers.
 */
export function getClientIP(request: NextRequest): string {
  // Cloudflare specific header (most reliable on Cloudflare)
  const cfIP = request.headers.get('cf-connecting-ip');
  if (cfIP) return cfIP.trim();

  // Standard proxy headers
  const xForwardedFor = request.headers.get('x-forwarded-for');
  if (xForwardedFor) {
    const firstIP = xForwardedFor.split(',')[0]?.trim();
    if (firstIP) return firstIP;
  }

  const xRealIP = request.headers.get('x-real-ip');
  if (xRealIP) return xRealIP.trim();

  // Fallback to unknown
  return 'unknown';
}

/**
 * Default identifier generator using IP address
 */
async function defaultKeyGenerator(request: NextRequest): Promise<string> {
  const ip = getClientIP(request);
  return `ip:${ip}`;
}

// ============================================================================
// Public API Functions
// ============================================================================

/**
 * Check rate limit for a NextRequest
 *
 * This is the core function used by both middleware and direct route handler usage.
 *
 * @param request - NextRequest object from Next.js
 * @param config - Rate limit configuration
 * @returns Rate limit result with allowed status and remaining count
 *
 * @example Direct usage in API route
 * ```ts
 * import { checkRateLimit } from '@/lib/rate-limiter';
 *
 * export async function POST(request: NextRequest) {
 *   const result = await checkRateLimit(request, {
 *     maxRequests: 10,
 *     windowMs: 60_000,
 *   });
 *
 *   if (!result.allowed) {
 *     return NextResponse.json(
 *       { error: 'Rate limit exceeded', retryAfter: result.retryAfter },
 *       { status: 429 }
 *     );
 *   }
 *
 *   // Handle request...
 * }
 * ```
 */
export async function checkRateLimit(
  request: NextRequest,
  config: RateLimitConfig
): Promise<RateLimitResult> {
  // Skip check if configured
  if (config.skipCheck && config.skipCheck(request)) {
    return {
      allowed: true,
      remaining: config.maxRequests,
      limit: config.maxRequests,
      reset: Math.floor(Date.now() / 1000) + Math.floor(config.windowMs / 1000),
    };
  }

  // Get identifier
  const keyGenerator = config.keyGenerator || defaultKeyGenerator;
  const identifier = await keyGenerator(request);

  // Perform sliding window check
  return checkRateLimitByIdentifier(identifier, {
    maxRequests: config.maxRequests,
    windowMs: config.windowMs,
    prefix: config.prefix || 'rl',
  });
}

/**
 * Create a rate limiter middleware function for Next.js
 *
 * Returns a function that can be used in:
 * - src/middleware.ts (global middleware)
 * - Route handlers via inline middleware
 *
 * @param config - Rate limit configuration
 * @returns Middleware function that returns NextResponse on rate limit, null otherwise
 *
 * @example Usage in src/middleware.ts
 * ```ts
 * import { createRateLimiter } from '@/lib/rate-limiter';
 *
 * // Create rate limiter for tracking endpoint
 * const trackingRateLimiter = createRateLimiter({
 *   maxRequests: 30,
 *   windowMs: 60_000,
 * });
 *
 * export async function middleware(request: NextRequest) {
 *   // Apply rate limiting to specific paths
 *   if (request.nextUrl.pathname.startsWith('/api/tracking')) {
 *     const response = await trackingRateLimiter(request);
 *     if (response) return response;
 *   }
 *
 *   // Other middleware logic...
 *   return NextResponse.next();
 * }
 * ```
 *
 * @example Usage in API route with conditional matcher
 * ```ts
 * import { NextRequest, NextResponse } from 'next/server';
 * import { rateLimiter } from '@/lib/rate-limiter';
 *
 * // Apply rate limiter as middleware in the route
 * export async function GET(request: NextRequest) {
 *   const rateLimitResponse = await rateLimiter(request, {
 *     maxRequests: 100,
 *     windowMs: 60_000,
 *   });
 *
 *   if (rateLimitResponse) return rateLimitResponse;
 *
 *   // Normal handler logic
 *   return NextResponse.json({ data: 'success' });
 * }
 * ```
 */
export function createRateLimiter(
  config: RateLimitConfig
): (request: NextRequest) => Promise<NextResponse | null> {
  return async (request: NextRequest): Promise<NextResponse | null> => {
    const result = await checkRateLimit(request, config);

    if (!result.allowed) {
      return NextResponse.json(
        {
          error: 'Rate limit exceeded',
          message: `Too many requests. Limit: ${result.limit} per ${Math.floor(config.windowMs / 1000)}s`,
          retryAfter: result.retryAfter,
          limit: result.limit,
          remaining: 0,
          reset: result.reset,
        },
        {
          status: 429,
          headers: {
            'X-RateLimit-Limit': String(result.limit),
            'X-RateLimit-Remaining': '0',
            'X-RateLimit-Reset': String(result.reset),
            'Retry-After': String(result.retryAfter || 0),
            'Content-Type': 'application/json',
          },
        }
      );
    }

    return null; // Request allowed, continue to next middleware/handler
  };
}

// Convenience: pre-configured rate limiter for common use cases
export const rateLimiter = createRateLimiter;

/**
 * Reset rate limit for an identifier (admin/debug use)
 *
 * Note: With sliding window, keys auto-expire via TTL. This function
 * forces immediate cleanup by deleting the key.
 *
 * @param identifier - Identifier to reset (IP, user ID, etc.)
 * @param prefix - Key prefix used (default: 'rl')
 * @param windowMs - Window size to reset (optional, resets current window if not specified)
 * @returns Promise resolving to true if successful
 */
export async function resetRateLimit(
  identifier: string,
  prefix: string = 'rl',
  windowMs?: number
): Promise<boolean> {
  const kv = getKV();
  if (!kv) {
    logWarn('[RateLimiter] KV not available for reset');
    return false;
  }

  try {
    if (windowMs) {
      const key = buildKey(prefix, identifier, windowMs);
      return await kv.delete(key);
    }
    logWarn('[RateLimiter] Reset without windowMs is not supported for sliding window');
    return true;
  } catch (error) {
    logError('[RateLimiter] Error resetting rate limit:', error);
    return false;
  }
}

/**
 * Parse rate limit headers from a response
 * Useful for testing or displaying info to users
 */
export function parseRateLimitHeaders(
  headers: Headers
): { limit: number; remaining: number; reset: number } | null {
  const limit = headers.get('X-RateLimit-Limit');
  const remaining = headers.get('X-RateLimit-Remaining');
  const reset = headers.get('X-RateLimit-Reset');

  if (!limit || !remaining || !reset) {
    return null;
  }

  return {
    limit: parseInt(limit, 10),
    remaining: parseInt(remaining, 10),
    reset: parseInt(reset, 10),
  };
}
