/**
 * Rate Limiter for ApexOS
 *
 * Provides token bucket style rate limiting with D1 storage.
 * Supports configurable limits per endpoint type and user tier.
 */

// Minimal D1 database interface
interface D1Statement {
  bind(...params: unknown[]): D1Statement;
  first<T = unknown>(): T | null;
  all<T = unknown>(): { results: T[] };
  run(): { success: boolean; changes?: number };
}

interface D1Database {
  prepare(sql: string): D1Statement;
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
  identifierUsed: string; // which identifier triggered the limit
  isNearLimit: boolean; // > 80% used
}

export type RateLimitIdentifier = {
  ip?: string;
  userId?: string;
  apiKey?: string;
};

export class RateLimiter {
  private db: D1Database;
  private configCache: Map<string, RateLimitConfig> = new Map();
  private configCacheExpiry: Map<string, number> = new Map();
  private readonly CONFIG_CACHE_TTL = 30000; // 30 seconds

  constructor(db: D1Database) {
    this.db = db;
  }

  /**
   * Check rate limit for a request and increment if within limits.
   * Returns rate limit check result with remaining quota.
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
    // Get the config for this endpoint type
    const config = await this.getConfig(endpointType);
    if (!config || !config.isActive) {
      // No rate limiting configured for this endpoint
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

    // Determine which identifier to use based on applies_to
    const appliedIdentifier = this.selectIdentifier(identifier, config.appliesTo);
    const key = `${endpointType}|${appliedIdentifier}`;

    // Apply multipliers
    let effectiveLimit = config.maxRequests;
    if (options?.userRole) {
      effectiveLimit = Math.floor(effectiveLimit * this.getRoleMultiplier(options.userRole));
    }
    if (options?.userTier) {
      effectiveLimit = Math.floor(effectiveLimit * this.getTierMultiplier(options.userTier));
    }

    // Check current count and reset time
    const now = new Date().toISOString();
    const existing = await this.db.prepare(
      'SELECT current_count, max_count, reset_at FROM rate_limits WHERE key = ?'
    )
      .bind(key)
      .first<{ current_count: number; max_count: number; reset_at: string }>();

    let currentCount = 0;
    let resetAt = new Date().toISOString();

    if (existing) {
      // Check if the window has expired
      if (existing.reset_at <= now) {
        // Window expired, reset count
        await this.db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
        currentCount = 0;
        resetAt = new Date(Date.now() + config.windowSeconds * 1000).toISOString();
      } else {
        currentCount = existing.current_count;
        resetAt = existing.reset_at;
      }
    } else {
      // New entry, set reset time
      resetAt = new Date(Date.now() + config.windowSeconds * 1000).toISOString();
    }

    // Check if limit exceeded
    const allowed = currentCount < effectiveLimit;
    const remaining = Math.max(0, effectiveLimit - currentCount);
    const retryAfter = allowed ? 0 : Math.ceil((new Date(resetAt).getTime() - Date.now()) / 1000);
    const isNearLimit = remaining <= Math.floor(effectiveLimit * 0.2); // 20% or less remaining

    // If allowed, increment the counter
    if (allowed) {
      await this.increment(key, endpointType, appliedIdentifier, effectiveLimit, config.windowSeconds, resetAt);
    }

    return {
      allowed,
      remaining,
      resetAt: new Date(resetAt),
      limit: effectiveLimit,
      retryAfter,
      identifierUsed: appliedIdentifier,
      isNearLimit
    };
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
    const key = `${endpointType}|${appliedIdentifier}`;

    let effectiveLimit = config.maxRequests;
    if (options?.userRole) {
      effectiveLimit = Math.floor(effectiveLimit * this.getRoleMultiplier(options.userRole));
    }
    if (options?.userTier) {
      effectiveLimit = Math.floor(effectiveLimit * this.getTierMultiplier(options.userTier));
    }

    const now = new Date().toISOString();
    const existing = await this.db.prepare(
      'SELECT current_count, reset_at FROM rate_limits WHERE key = ?'
    )
      .bind(key)
      .first<{ current_count: number; reset_at: string }>();

    if (!existing || existing.reset_at <= now) {
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

    const remaining = Math.max(0, effectiveLimit - existing.current_count);
    const retryAfter = Math.ceil((new Date(existing.reset_at).getTime() - Date.now()) / 1000);

    return {
      allowed: remaining > 0,
      remaining,
      resetAt: new Date(existing.reset_at),
      limit: effectiveLimit,
      retryAfter,
      identifierUsed: appliedIdentifier,
      isNearLimit: remaining <= Math.floor(effectiveLimit * 0.2)
    };
  }

  /**
   * Reset rate limit for a specific identifier (admin operation)
   */
  async resetLimit(endpointType: string, identifier: string): Promise<boolean> {
    const key = `${endpointType}|${identifier}`;
    const result = await this.db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
    return result.success && result.changes > 0;
  }

  /**
   * Clean up expired rate limit entries
   */
  async cleanupExpired(): Promise<number> {
    const result = await this.db.prepare(
      'DELETE FROM rate_limits WHERE reset_at < datetime("now")'
    ).run();
    return result.changes || 0;
  }

  /**
   * Get rate limit configuration for an endpoint type
   */
  private async getConfig(endpointType: string): Promise<RateLimitConfig | null> {
    // Check cache first
    const cached = this.configCache.get(endpointType);
    const cachedAt = this.configCacheExpiry.get(endpointType);
    if (cached && cachedAt && Date.now() < cachedAt) {
      return cached;
    }

    // Fetch from database
    const config = await this.db.prepare(
      'SELECT * FROM rate_limit_configs WHERE endpoint_type = ? AND is_active = 1'
    )
      .bind(endpointType)
      .first<RateLimitConfig>();

    if (config) {
      this.configCache.set(endpointType, config);
      this.configCacheExpiry.set(endpointType, Date.now() + this.CONFIG_CACHE_TTL);
    }

    return config || null;
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
        // Use composite: userId:ip or apiKey:ip
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
      admin: 2.0,      // Admins get 2x limits
      master_trader: 1.5, // Master traders get 1.5x
      affiliate: 1.2,   // Affiliates get 1.2x
      shopper: 1.0     // Default
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
   * Increment the counter for a key
   */
  private async increment(
    key: string,
    endpointType: string,
    identifier: string,
    maxCount: number,
    windowSeconds: number,
    resetAt: string
  ): Promise<void> {
    const now = new Date().toISOString();

    // Try to update existing
    const updateResult = await this.db.prepare(
      'UPDATE rate_limits SET current_count = current_count + 1, updated_at = ? WHERE key = ?'
    )
      .bind(now, key)
      .run();

    if ((updateResult.changes ?? 0) === 0) {
      // Insert new record
      await this.db.prepare(
        'INSERT INTO rate_limits (key, endpoint_type, identifier, current_count, max_count, window_seconds, reset_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
        .bind(key, endpointType, identifier, 1, maxCount, windowSeconds, resetAt, now, now)
        .run();
    }
  }
}

/**
 * Factory function to create RateLimiter with global DB
 */
export function createRateLimiter(): RateLimiter {
  const db = (globalThis as { DB?: D1Database }).DB;
  if (!db) {
    throw new Error('Database not initialized. Rate limiter requires DB binding.');
  }
  return new RateLimiter(db);
}

/**
 * Utility to extract IP from request headers (Cloudflare)
 */
export function extractIpAddress(headers: Headers): string {
  return headers.get('x-forwarded-for')?.split(',')[0]?.trim() ||
         headers.get('cf-connecting-ip') ||
         headers.get('x-real-ip') ||
         '127.0.0.1';
}

/**
 * Determine endpoint type from request path
 */
export function getEndpointType(pathname: string, method: string): string {
  // Authentication endpoints
  if (pathname.startsWith('/api/auth') || pathname.includes('/api/auth/')) {
    return 'auth';
  }

  // Tracking endpoints
  if (pathname.startsWith('/api/tracking') || pathname.includes('/api/tracking/')) {
    return 'click_tracking';
  }

  // Webhook endpoints
  if (pathname.startsWith('/api/webhooks')) {
    return 'webhook';
  }

  // Admin endpoints
  if (pathname.startsWith('/api/admin') || pathname.includes('/api/admin/')) {
    return 'admin';
  }

  // Business metrics endpoint
  if (pathname.startsWith('/api/metrics/business') || pathname.includes('/api/metrics/business')) {
    return 'admin_metrics';
  }

  // General API
  return 'api_general';
}
