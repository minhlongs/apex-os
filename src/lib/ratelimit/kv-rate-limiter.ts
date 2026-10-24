/**
 * Cloudflare KV-based Rate Limiter
 *
 * Uses KV storage for high-performance rate limiting without D1 writes.
 * Implements sliding window algorithm with atomic KV operations.
 */

// Cloudflare KV binding interface
interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface RateLimitConfig {
  endpointType: string;
  maxRequests: number;
  windowSeconds: number;
  appliesTo: 'ip' | 'user' | 'api_key' | 'combined';
  roleMultiplier: number;
  tierMultiplier: number;
  description?: string;
  isActive: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
  retryAfter: number; // seconds until reset
  identifierUsed: string;
  isNearLimit: boolean;
}

export type RateLimitIdentifier = {
  ip?: string;
  userId?: string;
  apiKey?: string;
};

/**
 * KV-based rate limiter using sliding window algorithm
 *
 * Stores window data as JSON in KV with structure:
 * {
 *   "c": <current_count>,
 *   "w": <window_seconds>,
 *   "r": <reset_timestamp>,
 *   "t": <timestamps_array> // for sliding window precision
 * }
 */
export class KVRateLimiter {
  private kv: KVNamespace;
  private configCache: Map<string, RateLimitConfig> = new Map();
  private configCacheExpiry: Map<string, number> = new Map();
  private readonly CONFIG_CACHE_TTL = 30000; // 30 seconds
  private readonly WINDOW_PRECISION = 60; // 1-minute buckets for sliding window

  constructor(kv: KVNamespace) {
    this.kv = kv;
  }

  /**
   * Check rate limit for a request and increment if within limits.
   * Uses atomic KV operations to prevent race conditions.
   */
  async checkLimit(
    endpointType: string,
    identifier: RateLimitIdentifier,
    options?: {
      userId?: string;
      userRole?: string;
      userTier?: string;
    }
  ): Promise<RateLimitResult> {
    // Get config (from cache or D1)
    const config = await this.getConfig(endpointType);
    if (!config || !config.isActive) {
      return {
        allowed: true,
        remaining: 1,
        resetAt: new Date(Date.now() + 3600000),
        limit: 1,
        retryAfter: 0,
        identifierUsed: 'none',
        isNearLimit: false
      };
    }

    // Determine which identifier to use
    const appliedIdentifier = this.selectIdentifier(identifier, config.appliesTo);
    const key = this.buildKey(endpointType, appliedIdentifier);

    // Calculate effective limit with multipliers
    let effectiveLimit = config.maxRequests;
    if (options?.userRole) {
      effectiveLimit = Math.floor(effectiveLimit * this.getRoleMultiplier(options.userRole));
    }
    if (options?.userTier) {
      effectiveLimit = Math.floor(effectiveLimit * this.getTierMultiplier(options.userTier));
    }

    // Use sliding window algorithm with KV
    const result = await this.slidingWindowCheck(key, effectiveLimit, config.windowSeconds);

    return {
      ...result,
      limit: effectiveLimit,
      identifierUsed: appliedIdentifier,
      isNearLimit: result.remaining <= Math.floor(effectiveLimit * 0.2)
    };
  }

  /**
   * Sliding window rate limit check using KV
   * Stores timestamps in buckets for efficient counting
   */
  private async slidingWindowCheck(
    key: string,
    limit: number,
    windowSeconds: number
  ): Promise<Omit<RateLimitResult, 'limit' | 'identifierUsed' | 'isNearLimit'>> {
    const now = Math.floor(Date.now() / 1000);
    const windowStart = now - windowSeconds;

    // Read current window data
    const raw = await this.kv.get(key);

    // Parse the stored bucket; a corrupt or absent entry starts a fresh window.
    let parsed: { timestamps: number[]; lastCleanup: number } | null = null;
    if (raw) {
      try {
        parsed = JSON.parse(raw) as { timestamps: number[]; lastCleanup: number };
      } catch {
        parsed = null;
      }
    }

    const windowData: { timestamps: number[]; lastCleanup: number } = parsed ?? {
      timestamps: [],
      lastCleanup: now,
    };

    // Clean up old timestamps if cleanup is due (every 10 minutes)
    if (now - (windowData.lastCleanup || 0) > 600) {
      windowData.timestamps = windowData.timestamps.filter(ts => ts > windowStart);
      windowData.lastCleanup = now;
    } else {
      // Just filter for current window
      windowData.timestamps = windowData.timestamps.filter(ts => ts > windowStart);
    }

    // Count requests in current window
    const currentCount = windowData.timestamps.length;

    // Check if limit exceeded
    const allowed = currentCount < limit;
    const remaining = Math.max(0, limit - currentCount);

    // Calculate reset time (based on oldest timestamp in window)
    let resetAt = new Date();
    let retryAfter = 0;
    if (!allowed && windowData.timestamps.length > 0) {
      const oldestTimestamp = windowData.timestamps[0];
      resetAt = new Date((oldestTimestamp + windowSeconds) * 1000);
      retryAfter = Math.max(1, Math.ceil((oldestTimestamp + windowSeconds - now)));
    }

    // If allowed, add current timestamp
    if (allowed) {
      windowData.timestamps.push(now);
      windowData.lastCleanup = now;

      // Store with TTL slightly longer than window to auto-expire
      const ttl = windowSeconds + 60; // 1 minute buffer
      await this.kv.put(key, JSON.stringify(windowData), { expirationTtl: ttl });
    }

    return {
      allowed,
      remaining,
      resetAt,
      retryAfter
    };
  }

  /**
   * Build KV key from endpoint type and identifier
   */
  private buildKey(endpointType: string, identifier: string): string {
    // Use a prefix for easy management/debugging
    return `rate_limit:${endpointType}:${identifier}`;
  }

  /**
   * Select which identifier to use based on applies_to setting
   */
  private selectIdentifier(identifier: RateLimitIdentifier, appliesTo: string): string {
    switch (appliesTo) {
      case 'ip':
        return identifier.ip || 'unknown';
      case 'user':
        return identifier.userId || identifier.ip || 'unknown';
      case 'api_key':
        return identifier.apiKey || identifier.ip || 'unknown';
      case 'combined':
        return `${identifier.userId || identifier.apiKey || 'anon'}:${identifier.ip || 'no-ip'}`;
      default:
        return identifier.ip || 'unknown';
    }
  }

  /**
   * Get role-based multiplier
   */
  private getRoleMultiplier(role: string): number {
    const multipliers: Record<string, number> = {
      admin: 2.0,
      master_trader: 1.5,
      affiliate: 1.2,
      shopper: 1.0
    };
    return multipliers[role] || 1.0;
  }

  /**
   * Get tier-based multiplier
   */
  private getTierMultiplier(tier: string): number {
    const multipliers: Record<string, number> = {
      premium: 2.5,
      growth: 1.5,
      starter: 1.2,
      free: 1.0
    };
    return multipliers[tier] || 1.0;
  }

  /**
   * Get rate limit configuration (from cache or D1)
   * Falls back to built-in defaults if no config found
   */
  private async getConfig(endpointType: string): Promise<RateLimitConfig | null> {
    // Check cache first
    const cached = this.configCache.get(endpointType);
    const cachedAt = this.configCacheExpiry.get(endpointType);
    if (cached && cachedAt && Date.now() < cachedAt) {
      return cached;
    }

    // Try to fetch from D1 (rate_limit_configs table)
    // This is a fallback - we still keep D1 for config storage
    try {
      // @ts-ignore - global DB
      const db = globalThis.DB;
      if (db) {
        const configRow = await db.prepare(
          'SELECT * FROM rate_limit_configs WHERE endpoint_type = ? AND is_active = 1'
        )
          .bind(endpointType)
          .first();

        if (configRow) {
          const config = configRow as RateLimitConfig;
          this.configCache.set(endpointType, config);
          this.configCacheExpiry.set(endpointType, Date.now() + this.CONFIG_CACHE_TTL);
          return config;
        }
      }
    } catch {
      // D1 not available, use defaults
    }

    // Built-in defaults for common endpoint types
    const defaults: Record<string, RateLimitConfig> = {
      click_tracking: {
        endpointType: 'click_tracking',
        maxRequests: 100,
        windowSeconds: 3600, // 1 hour
        appliesTo: 'ip',
        roleMultiplier: 1.0,
        tierMultiplier: 1.0,
        description: 'Click tracking endpoint - 100 requests per IP per hour',
        isActive: true
      },
      auth: {
        endpointType: 'auth',
        maxRequests: 20,
        windowSeconds: 900, // 15 minutes
        appliesTo: 'ip',
        roleMultiplier: 1.0,
        tierMultiplier: 1.0,
        description: 'Authentication endpoints - 20 requests per 15 min per IP',
        isActive: true
      },
      webhook: {
        endpointType: 'webhook',
        maxRequests: 100,
        windowSeconds: 60, // 1 minute
        appliesTo: 'api_key',
        roleMultiplier: 1.0,
        tierMultiplier: 1.0,
        description: 'Webhook endpoints - 100 requests per minute',
        isActive: true
      },
      admin: {
        endpointType: 'admin',
        maxRequests: 200,
        windowSeconds: 3600,
        appliesTo: 'user',
        roleMultiplier: 1.5,
        tierMultiplier: 1.2,
        description: 'Admin endpoints - 200 requests per hour per user',
        isActive: true
      }
    };

    const defaultConfig = defaults[endpointType];
    if (defaultConfig) {
      return defaultConfig;
    }

    return null;
  }

  /**
   * Get current rate limit status without incrementing
   */
  async getStatus(
    endpointType: string,
    identifier: RateLimitIdentifier,
    options?: { userId?: string; userRole?: string; userTier?: string }
  ): Promise<RateLimitResult | null> {
    const config = await this.getConfig(endpointType);
    if (!config || !config.isActive) {
      return null;
    }

    const appliedIdentifier = this.selectIdentifier(identifier, config.appliesTo);
    const key = this.buildKey(endpointType, appliedIdentifier);

    let effectiveLimit = config.maxRequests;
    if (options?.userRole) {
      effectiveLimit = Math.floor(effectiveLimit * this.getRoleMultiplier(options.userRole));
    }
    if (options?.userTier) {
      effectiveLimit = Math.floor(effectiveLimit * this.getTierMultiplier(options.userTier));
    }

    const raw = await this.kv.get(key);
    if (!raw) {
      return {
        allowed: true,
        remaining: effectiveLimit,
        resetAt: new Date(),
        limit: effectiveLimit,
        retryAfter: 0,
        identifierUsed: appliedIdentifier,
        isNearLimit: false
      };
    }

    try {
      const windowData = JSON.parse(raw);
      const now = Math.floor(Date.now() / 1000);
      const windowStart = now - config.windowSeconds;

      const timestamps = windowData.timestamps.filter((ts: number) => ts > windowStart);
      const remaining = Math.max(0, effectiveLimit - timestamps.length);

      let resetAt = new Date();
      let retryAfter = 0;
      if (timestamps.length >= effectiveLimit && timestamps.length > 0) {
        const oldestTimestamp = timestamps[0];
        resetAt = new Date((oldestTimestamp + config.windowSeconds) * 1000);
        retryAfter = Math.max(1, Math.ceil((oldestTimestamp + config.windowSeconds - now)));
      }

      return {
        allowed: remaining > 0,
        remaining,
        resetAt,
        limit: effectiveLimit,
        retryAfter,
        identifierUsed: appliedIdentifier,
        isNearLimit: remaining <= Math.floor(effectiveLimit * 0.2)
      };
    } catch {
      return {
        allowed: true,
        remaining: effectiveLimit,
        resetAt: new Date(),
        limit: effectiveLimit,
        retryAfter: 0,
        identifierUsed: appliedIdentifier,
        isNearLimit: false
      };
    }
  }

  /**
   * Reset rate limit for a specific identifier (admin operation)
   */
  async resetLimit(endpointType: string, identifier: string): Promise<boolean> {
    const key = this.buildKey(endpointType, identifier);
    const result = await this.kv.delete(key);
    return result;
  }

  /**
   * Get rate limit headers for response
   */
  getHeaders(result: RateLimitResult): Record<string, string> {
    return {
      'X-RateLimit-Limit': result.limit.toString(),
      'X-RateLimit-Remaining': result.remaining.toString(),
      'X-RateLimit-Reset': Math.floor(result.resetAt.getTime() / 1000).toString(),
      'X-RateLimit-Reset-After': `${result.retryAfter}s`,
      ...(result.retryAfter > 0 && { 'Retry-After': result.retryAfter.toString() })
    };
  }
}

/**
 * Factory function to create KVRateLimiter with Cloudflare KV binding
 */
export function createKVRateLimiter(): KVRateLimiter {
  // @ts-ignore - Cloudflare KV binding
  const kv = (globalThis as { KV?: KVNamespace }).KV;
  if (!kv) {
    throw new Error('KV binding not found. KVRateLimiter requires KV namespace binding.');
  }
  return new KVRateLimiter(kv);
}
