import { NextResponse } from 'next/server';
import type { D1Database } from '@/types/d1';
import {
  DualWindowRateLimitConfig,
  DualWindowRateLimitResult,
  FraudReasonCode,
} from '@/types/fraud';
import { autoBlockOffender, normalizeIpAddress } from './ip-blocker';

export const DEFAULT_RATE_LIMIT_CONFIG: DualWindowRateLimitConfig = {
  endpointType: 'click_tracking',
  hourlyLimit: 100,
  hourlyWindowSeconds: 3600,
  dailyLimit: 1000,
  dailyWindowSeconds: 86400,
  autoBlockThreshold: 150,
  autoBlockDurationSeconds: null,
};

/**
 * Evaluates dual-window rate limiting for click tracking on an IP address:
 * - 1-hour window: 100 clicks
 * - 24-hour window: 1,000 clicks
 * Uses Cloudflare D1 indexed queries on deal_clicks(ip_address, created_at)
 */
export async function checkIpRateLimit(
  db: D1Database,
  rawIp: string,
  options?: Partial<DualWindowRateLimitConfig>
): Promise<DualWindowRateLimitResult> {
  const config = { ...DEFAULT_RATE_LIMIT_CONFIG, ...options };
  const ip = normalizeIpAddress(rawIp) || rawIp.trim();
  const now = Date.now();

  const hourlyDate = new Date(now - config.hourlyWindowSeconds * 1000);
  const dailyDate = new Date(now - config.dailyWindowSeconds * 1000);

  const hourlyIsoCutoff = hourlyDate.toISOString();
  const dailyIsoCutoff = dailyDate.toISOString();
  const hourlySqliteCutoff = hourlyIsoCutoff.replace('T', ' ').slice(0, 19);
  const dailySqliteCutoff = dailyIsoCutoff.replace('T', ' ').slice(0, 19);

  // 1. Query counts for both windows in parallel supporting both SQLite and ISO date formats
  const rateLimitCountQuery =
    'SELECT COUNT(*) as count FROM deal_clicks WHERE ip_address = ? AND (created_at >= ? OR (created_at >= ? AND created_at NOT LIKE \'%T%\'))';

  const [hourlyRes, dailyRes] = await Promise.all([
    db
      .prepare(rateLimitCountQuery)
      .bind(ip, hourlyIsoCutoff, hourlySqliteCutoff)
      .first<{ count?: number; 'COUNT(*)': number; total?: number }>(),
    db
      .prepare(rateLimitCountQuery)
      .bind(ip, dailyIsoCutoff, dailySqliteCutoff)
      .first<{ count?: number; 'COUNT(*)': number; total?: number }>(),
  ]);

  const hourlyCount = hourlyRes?.count ?? hourlyRes?.['COUNT(*)'] ?? hourlyRes?.total ?? 0;
  const dailyCount = dailyRes?.count ?? dailyRes?.['COUNT(*)'] ?? dailyRes?.total ?? 0;

  const hourlyRemaining = Math.max(0, config.hourlyLimit - hourlyCount);
  const dailyRemaining = Math.max(0, config.dailyLimit - dailyCount);

  const hourlyExceeded = hourlyCount >= config.hourlyLimit;
  const dailyExceeded = dailyCount >= config.dailyLimit;
  const allowed = !hourlyExceeded && !dailyExceeded;

  let exceededWindow: 'hourly' | 'daily' | null = null;
  let retryAfter = 0;
  let reason: string | null = null;
  let autoBlocked = false;

  const hourlyResetAt = Math.floor((now + config.hourlyWindowSeconds * 1000) / 1000);
  const dailyResetAt = Math.floor((now + config.dailyWindowSeconds * 1000) / 1000);

  if (!allowed) {
    reason = FraudReasonCode.RATE_LIMIT_EXCEEDED;

    if (hourlyExceeded) {
      exceededWindow = 'hourly';
      // Find oldest click in 1-hour window for dynamic sliding window calculation
      const oldestQuery =
        'SELECT created_at FROM deal_clicks WHERE ip_address = ? AND (created_at >= ? OR (created_at >= ? AND created_at NOT LIKE \'%T%\')) ORDER BY created_at ASC LIMIT 1';
      const oldestHourly = await db
        .prepare(oldestQuery)
        .bind(ip, hourlyIsoCutoff, hourlySqliteCutoff)
        .first<{ created_at: string }>();

      if (oldestHourly?.created_at) {
        const oldestTime = new Date(oldestHourly.created_at).getTime();
        const resetTime = oldestTime + config.hourlyWindowSeconds * 1000;
        retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));
      } else {
        retryAfter = config.hourlyWindowSeconds;
      }

      // Check auto-block escalation threshold (e.g. 150 clicks in 1 hr)
      if (hourlyCount >= config.autoBlockThreshold) {
        await autoBlockOffender(db, ip, FraudReasonCode.AUTO_BLOCKED_REPEAT_OFFENDER, {
          durationSeconds: config.autoBlockDurationSeconds,
          blockedBy: 'system',
        });
        autoBlocked = true;
      }
    } else if (dailyExceeded) {
      exceededWindow = 'daily';
      // Find oldest click in 24-hour window
      const oldestQuery =
        'SELECT created_at FROM deal_clicks WHERE ip_address = ? AND (created_at >= ? OR (created_at >= ? AND created_at NOT LIKE \'%T%\')) ORDER BY created_at ASC LIMIT 1';
      const oldestDaily = await db
        .prepare(oldestQuery)
        .bind(ip, dailyIsoCutoff, dailySqliteCutoff)
        .first<{ created_at: string }>();

      if (oldestDaily?.created_at) {
        const oldestTime = new Date(oldestDaily.created_at).getTime();
        const resetTime = oldestTime + config.dailyWindowSeconds * 1000;
        retryAfter = Math.max(1, Math.ceil((resetTime - now) / 1000));
      } else {
        retryAfter = config.dailyWindowSeconds;
      }
    }
  }

  return {
    allowed,
    hourlyRemaining,
    dailyRemaining,
    hourlyLimit: config.hourlyLimit,
    dailyLimit: config.dailyLimit,
    hourlyResetAt,
    dailyResetAt,
    retryAfter,
    exceededWindow,
    isBlocked: !allowed,
    autoBlocked,
    reason,
  };
}

/**
 * Generate standard RFC 6585 and rate limiting headers
 */
export function getRateLimitHeaders(result: DualWindowRateLimitResult): Record<string, string> {
  const limit = result.exceededWindow === 'daily' ? result.dailyLimit : result.hourlyLimit;
  const remaining = result.exceededWindow === 'daily' ? result.dailyRemaining : result.hourlyRemaining;
  const resetAt = result.exceededWindow === 'daily' ? result.dailyResetAt : result.hourlyResetAt;
  const retryAfter = result.retryAfter || 3600;

  return {
    'Retry-After': String(retryAfter),
    'X-RateLimit-Limit': String(limit),
    'X-RateLimit-Remaining': String(remaining),
    'X-RateLimit-Reset': String(resetAt),
    'X-RateLimit-Reset-After': `${retryAfter}s`,
  };
}

/**
 * Generate RFC 6585-compliant HTTP 429 Too Many Requests response with standard headers
 */
export function createRateLimit429Response(
  result: DualWindowRateLimitResult
): NextResponse {
  const headers = getRateLimitHeaders(result);

  return NextResponse.json(
    {
      error: 'Too Many Requests',
      message: 'Click rate limit exceeded. Please retry after ' + (result.retryAfter || 3600) + ' seconds.',
      retryAfter: result.retryAfter || 3600,
    },
    {
      status: 429,
      headers,
    }
  );
}
