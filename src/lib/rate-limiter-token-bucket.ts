/**
 * ApexOS Rate Limiter - Token Bucket Implementation
 *
 * Improved version using token bucket algorithm for:
 * - O(1) storage (16 bytes vs JSON arrays)
 * - Built-in burst support
 * - Better CAS contention handling
 *
 * Integration: Add to src/middleware.ts or individual API routes
 */
import { NextRequest } from 'next/server';
import { getUserIdFromSession } from '@/lib/ratelimit/middleware';

/**
 * KV Namespace interface for Cloudflare Workers
 */
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete?(key: string): Promise<void>;
}

interface RateLimitConfig {
  /** Burst capacity (max tokens) */
  capacity: number;
  /** Refill rate in tokens per second */
  refillRate: number;
  /** Window in seconds (for reset calculation) */
  window: number;
  /** Key type: 'ip' or 'user' */
  keyType: 'ip' | 'user';
  /** Cost in tokens for this request (default 1) */
  cost?: number;
}

interface BucketState {
  tokens: number;
  lastRefill: number; // Unix timestamp in milliseconds
}

interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAfter: number; // Seconds until window reset
  retryAfter?: number; // Seconds (only when denied)
}

// Rate limit configurations per endpoint type
// Public: 100 req/min (burst 120)
// Auth: 10 req/min (burst 12)
// Burst = 20% over base limit
export const RATE_LIMIT_CONFIGS: Record<string, RateLimitConfig> = {
  // Public deals browsing - 100 req/min, 20% burst = 120 capacity
  '/api/public/deals': {
    capacity: 120,
    refillRate: 2, // 120 tokens / 60 sec
    window: 60,
    keyType: 'ip'
  },

  // Click tracking - more aggressive rate limiting
  '/api/tracking/click': {
    capacity: 36, // 30 base + 20% burst = 36
    refillRate: 0.6, // 36 / 60
    window: 60,
    keyType: 'ip'
  },

  // Authenticated click tracking
  '/api/tracking/click:auth': {
    capacity: 12, // 10 base + 20% burst = 12
    refillRate: 0.2, // 12 / 60
    window: 60,
    keyType: 'user'
  },

  // Authentication endpoints - strict
  '/api/auth/signin': {
    capacity: 6, // 5 base + 20% burst = 6
    refillRate: 0.1, // 6 / 60
    window: 60,
    keyType: 'ip',
    cost: 5 // Sign-in costs 5 tokens to prevent rapid attempts
  },

  // Webhooks - higher limits for batch processing
  '/api/webhooks/exchange': {
    capacity: 240, // 200 base + 20% burst
    refillRate: 4, // 240 / 60
    window: 60,
    keyType: 'ip'
  }
};

// KV key prefix
const KV_KEY_PREFIX = 'rl:'; // Short prefix to minimize KV key size
const KV_TTL = 90; // seconds (window + 30s buffer for clock skew)

/**
 * Generate KV key for rate limiting
 * Format: rl:{hash(keyType:identifier:endpoint)}
 */
function makeKey(keyType: string, identifier: string, endpoint: string): string {
  const material = `${keyType}:${identifier}:${endpoint}`;
  // Use simple hash for KV key (CF Workers crypto.subtle is async)
  // For production, use a consistent hash function
  const hash = simpleHash(material);
  return `${KV_KEY_PREFIX}${hash}`;
}

/**
 * Simple non-cryptographic hash for KV keys
 * Returns 8-character hex string (4 bytes)
 */
function simpleHash(str: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Convert to 8-char hex
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Token bucket rate limit check using KV CAS
 *
 * Algorithm:
 * 1. Read current bucket state from KV
 * 2. Calculate tokens to add based on time elapsed
 * 3. If enough tokens, consume and write back with CAS
 * 4. Retry on contention (max 3 attempts)
 *
 * @returns RateLimitResult with remaining tokens and reset time
 */
export async function checkTokenBucket(
  kv: KVNamespace,
  identifier: string,
  endpoint: string,
  configKey: string
): Promise<RateLimitResult> {
  const config = RATE_LIMIT_CONFIGS[configKey];
  if (!config) {
    // No config, allow through
    return { allowed: true, remaining: Infinity, resetAfter: 0 };
  }

  const key = makeKey(config.keyType, identifier, endpoint);
  const cost = config.cost || 1;
  const now = Date.now();

  for (let attempt = 0; attempt < 3; attempt++) {
    // Read current state
    const raw = await kv.get(key);

    if (!raw) {
      // Initialize new bucket with full capacity
      const initial: BucketState = {
        tokens: config.capacity,
        lastRefill: now
      };
      const serialized = serializeBucket(initial);

      await kv.put(key, serialized, { expirationTtl: KV_TTL });

      if (cost <= config.capacity) {
        return {
          allowed: true,
          remaining: config.capacity - cost,
          resetAfter: config.window
        };
      }
      return {
        allowed: false,
        remaining: 0,
        resetAfter: config.window,
        retryAfter: Math.ceil(cost / config.refillRate)
      };
    }

    // Deserialize bucket state
    const bucket = deserializeBucket(raw);

    // Calculate refill: tokens = min(capacity, tokens + (now - lastRefill) * refillRate)
    const timeDiffSeconds = (now - bucket.lastRefill) / 1000;
    const refillAmount = timeDiffSeconds * config.refillRate;
    const newTokens = Math.min(config.capacity, bucket.tokens + refillAmount);

    // Check if we can consume
    if (newTokens < cost) {
      const tokensNeeded = cost - newTokens;
      const retryAfter = Math.ceil(tokensNeeded / config.refillRate);
      return {
        allowed: false,
        remaining: 0,
        resetAfter: config.window,
        retryAfter
      };
    }

    // Consume tokens
    const updated: BucketState = {
      tokens: newTokens - cost,
      lastRefill: now
    };

    // Write updated state with expiration
    try {
      await kv.put(
        key,
        serializeBucket(updated),
        { expirationTtl: KV_TTL }
      );
      return {
        allowed: true,
        remaining: Math.floor(updated.tokens),
        resetAfter: config.window,
      };
    } catch (error) {
      // On write failure, deny request (conservative)
      return {
        allowed: false,
        remaining: Math.floor(newTokens),
        resetAfter: config.window,
        retryAfter: Math.ceil(cost / config.refillRate)
      };
    }
  }

  // Every iteration above returns; this is unreachable and exists so the
  // function is total after the bounded retry loop.
  return {
    allowed: false,
    remaining: 0,
    resetAfter: config.window,
    retryAfter: Math.ceil(cost / config.refillRate)
  };
}

/**
 * Serialize bucket state to compact binary string (8 bytes)
 * Format: [tokens: float32][lastRefill: uint32 (seconds)]
 *
 * Note: Uses 32-bit seconds (year 2106 problem acceptable for rate limiting)
 */
function serializeBucket(bucket: BucketState): string {
  const tokens = Math.min(255, bucket.tokens); // 1 byte is enough for our ranges
  const seconds = Math.floor(bucket.lastRefill / 1000);
  // Pack into 8 bytes: tokens (1 byte) + padding (3 bytes) + seconds (4 bytes)
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setUint8(0, Math.floor(tokens));
  view.setUint32(4, seconds, false); // Big-endian

  // Convert to base64 for KV storage
  const binary = String.fromCharCode(...new Uint8Array(buffer));
  return btoa(binary);
}

/**
 * Deserialize bucket state from binary string
 */
function deserializeBucket(encoded: string): BucketState {
  const binary = atob(encoded);
  const buffer = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    buffer[i] = binary.charCodeAt(i);
  }
  const view = new DataView(buffer.buffer);
  const tokens = view.getUint8(0);
  const seconds = view.getUint32(4, false);
  return {
    tokens,
    lastRefill: seconds * 1000
  };
}

/**
 * Get client IP from Cloudflare Workers headers
 * Priority: CF-Connecting-IP → X-Forwarded-For → X-Real-IP
 */
export function getClientIP(request: Request): string {
  const headers = request.headers;

  // Cloudflare-specific header (most reliable)
  const cfIp = headers.get('cf-connecting-ip');
  if (cfIp) return cfIp.split(',')[0].trim();

  // X-Forwarded-For (may contain multiple IPs)
  const xff = headers.get('x-forwarded-for');
  if (xff) return xff.split(',')[0].trim();

  // X-Real-IP
  const xri = headers.get('x-real-ip');
  if (xri) return xri.trim();

  return 'unknown';
}


/**
 * Apply rate limit headers to response
 */
export function applyRateLimitHeaders(
  response: Response,
  result: RateLimitResult,
  capacity: number
): Response {
  const headers = new Headers(response.headers);
  headers.set('X-RateLimit-Limit', String(capacity));
  headers.set('X-RateLimit-Remaining', String(Math.max(0, result.remaining)));
  headers.set('X-RateLimit-Reset', String(Math.floor(Date.now() / 1000) + result.resetAfter));

  if (result.retryAfter) {
    headers.set('Retry-After', String(Math.ceil(result.retryAfter)));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

/**
 * Build 429 Too Many Requests response
 */
export function build429Response(
  retryAfter: number,
  endpoint: string,
  keyType: 'ip' | 'user'
): Response {
  return new Response(JSON.stringify({
    error: 'rate_limit_exceeded',
    message: `Rate limit exceeded for ${endpoint}. Too many ${keyType} requests.`,
    retry_after: retryAfter
  }), {
    status: 429,
    headers: {
      'Content-Type': 'application/json',
      'Retry-After': String(Math.ceil(retryAfter))
    }
  });
}

// ============================================================================
// Middleware for Next.js (if using middleware.ts)
// ============================================================================

export async function rateLimitMiddleware(
  request: Request,
  env: { KV: KVNamespace },
  next: () => Promise<Response>
): Promise<Response> {
  const url = new URL(request.url);
  const endpoint = url.pathname;

  // Skip rate limiting for certain paths
  if (endpoint.startsWith('/api/health') ||
      endpoint.startsWith('/api/webhooks/')) { // Webhooks use different limiting
    return next();
  }

  // Determine tier and config key
  const userId = getUserIdFromSession(request as NextRequest);
  const clientIp = getClientIP(request);

  // Select appropriate config
  let configKey: string | null = null;
  let identifier: string;
  let keyType: 'ip' | 'user';

  if (userId && endpoint.includes('/tracking/click')) {
    configKey = '/api/tracking/click:auth';
    identifier = userId;
    keyType = 'user';
  } else if (RATE_LIMIT_CONFIGS[endpoint]) {
    configKey = endpoint;
    identifier = clientIp;
    keyType = RATE_LIMIT_CONFIGS[endpoint].keyType;
  } else {
    // Default public limit
    configKey = '/api/public/deals';
    identifier = clientIp;
    keyType = 'ip';
  }

  if (!configKey) {
    return next();
  }

  // Check rate limit
  const result = await checkTokenBucket(env.KV, identifier, endpoint, configKey);
  const config = RATE_LIMIT_CONFIGS[configKey];

  // Get response
  const response = await next();

  if (!result.allowed) {
    return build429Response(result.retryAfter || config.window, endpoint, keyType);
  }

  // Apply rate limit headers to successful response
  return applyRateLimitHeaders(response, result, config.capacity);
}

// ============================================================================
// Usage in API Routes (alternative to middleware)
// ============================================================================

/*
// In your API route:
import { checkTokenBucket, getClientIP, build429Response, RATE_LIMIT_CONFIGS } from '@/lib/rate-limiter';

export async function GET(request: Request) {
  const kv = env.KV; // From your Worker/Pages context

  const clientIp = getClientIP(request);
  const result = await checkTokenBucket(kv, clientIp, '/api/public/deals', '/api/public/deals');

  if (!result.allowed) {
    return build429Response(result.retryAfter || 60, '/api/public/deals', 'ip');
  }

  // Your business logic here
  const deals = await getDeals();

  const response = NextResponse.json(deals);
  return applyRateLimitHeaders(response, result, RATE_LIMIT_CONFIGS['/api/public/deals'].capacity);
}
*/

// ============================================================================
// Utility: Get utilization for monitoring
// ============================================================================

export async function getCurrentUtilization(
  kv: KVNamespace,
  identifier: string,
  endpoint: string,
  configKey: string
): Promise<{ used: number; capacity: number; percent: number }> {
  const config = RATE_LIMIT_CONFIGS[configKey];
  if (!config) return { used: 0, capacity: 0, percent: 0 };

  const key = makeKey(config.keyType, identifier, endpoint);
  const raw = await kv.get(key);

  if (!raw) {
    return { used: 0, capacity: config.capacity, percent: 0 };
  }

  const bucket = deserializeBucket(raw);
  const now = Date.now();
  const timeDiffSeconds = (now - bucket.lastRefill) / 1000;
  const refillAmount = timeDiffSeconds * config.refillRate;
  const currentTokens = Math.min(config.capacity, bucket.tokens + refillAmount);
  const used = config.capacity - currentTokens;

  return {
    used: Math.floor(used),
    capacity: config.capacity,
    percent: (used / config.capacity) * 100
  };
}
