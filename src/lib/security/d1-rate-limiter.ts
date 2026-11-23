/**
 * Persistent Cloudflare D1 Rate Limiter (F-03)
 *
 * Replaces isolate-local in-memory `Map` counters and read-then-write KV checks
 * on security-critical endpoints (Auth, UID-binding, Short-link creation & resolution)
 * with a single atomic SQLite/D1 `INSERT ... ON CONFLICT(key) DO UPDATE ... RETURNING`
 * statement backed by the `rate_limits` table.
 *
 * Security guarantees:
 *   1. Survives Cloudflare Worker isolate recycling and horizontal isolate fan-out.
 *   2. Single SQL statement per check — eliminates read-modify-write TOCTOU race conditions.
 *   3. Fails closed (HTTP 503) in staging/production if D1 is unavailable or errors.
 */

import { NextResponse } from 'next/server';
import type { D1Database } from '@/lib/db';
import { isProductionOrStagingRuntime } from '@/lib/auth/runtime-env';

export interface PersistentRateLimitConfig {
  endpointType: string;
  identifier: string;
  maxRequests: number;
  windowSeconds: number;
  nowMs?: number;
  /**
   * When true, always fail closed (HTTP 503) if D1 is unavailable or errors,
   * regardless of NODE_ENV. Defaults to `isProductionOrStagingRuntime()`.
   */
  failClosed?: boolean;
}

export interface PersistentRateLimitResult {
  allowed: boolean;
  status: 200 | 429 | 503;
  limit: number;
  currentCount: number;
  remaining: number;
  retryAfterSeconds: number;
  resetAtUnixSeconds: number;
  key: string;
  source: 'd1' | 'mock-fallback' | 'fail-closed';
  errorCode?: 'RATE_LIMITED' | 'RATE_LIMIT_STORE_UNAVAILABLE';
}

const bootstrappedDatabases = new WeakSet<object>();

interface FallbackBucket {
  count: number;
  resetAtMs: number;
}
const mockDbFallbackStores = new WeakMap<object, Map<string, FallbackBucket>>();

const BOOTSTRAP_RATE_LIMITS_DDL = `
CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  endpoint_type TEXT NOT NULL,
  identifier TEXT NOT NULL,
  current_count INTEGER NOT NULL DEFAULT 0,
  max_count INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
)
`;

const ATOMIC_RATE_LIMIT_UPSERT_SQL = `
INSERT INTO rate_limits (
  key,
  endpoint_type,
  identifier,
  current_count,
  max_count,
  window_seconds,
  reset_at,
  created_at,
  updated_at
) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
ON CONFLICT(key) DO UPDATE SET
  current_count = CASE
    WHEN rate_limits.reset_at <= excluded.created_at THEN 1
    ELSE rate_limits.current_count + 1
  END,
  max_count = excluded.max_count,
  window_seconds = excluded.window_seconds,
  reset_at = CASE
    WHEN rate_limits.reset_at <= excluded.created_at THEN excluded.reset_at
    ELSE rate_limits.reset_at
  END,
  updated_at = excluded.updated_at
RETURNING current_count, reset_at
`;

/**
 * Extracts normalized client IP from Cloudflare Edge headers (`cf-connecting-ip`).
 * In production/staging runtimes, ONLY `cf-connecting-ip` is trusted (never falling
 * back to spoofable `x-real-ip` or `x-forwarded-for`). In local dev/test, preserves
 * fallback to `x-real-ip` / `x-forwarded-for`.
 */
export function extractClientIp(request: Request): string {
  const cfIp = request.headers.get('cf-connecting-ip')?.trim();
  if (cfIp) return cfIp.toLowerCase();

  if (isProductionOrStagingRuntime()) {
    return 'unknown';
  }

  const realIp = request.headers.get('x-real-ip')?.trim();
  if (realIp) return realIp.toLowerCase();

  const xff = request.headers.get('x-forwarded-for');
  if (xff) {
    const first = xff.split(',')[0]?.trim();
    if (first) return first.toLowerCase();
  }

  return 'unknown';
}

export const extractTrustedClientIp = extractClientIp;

export function normalizeRateLimitIdentifier(rawIdentifier: string): string {
  const normalized = String(rawIdentifier || 'unknown').trim().toLowerCase();
  return normalized.length > 160 ? normalized.slice(0, 160) : normalized || 'unknown';
}

async function ensureRateLimitsTable(db: D1Database): Promise<void> {
  // Production and staging schema must come strictly from approved Migration 032
  // (`032_persistent_d1_rate_limits.sql`). Never execute runtime DDL in
  // production or staging — if the table is missing, the atomic UPSERT fails
  // and `enforcePersistentD1RateLimit` fails closed with HTTP 503.
  if (isProductionOrStagingRuntime()) {
    return;
  }
  const dbRef = db as unknown as object;
  if (bootstrappedDatabases.has(dbRef)) {
    return;
  }
  await db.prepare(BOOTSTRAP_RATE_LIMITS_DDL).run();
  bootstrappedDatabases.add(dbRef);
}

function evaluateMockDbFallback(
  db: object,
  key: string,
  maxRequests: number,
  windowSeconds: number,
  nowMs: number
): PersistentRateLimitResult {
  let store = mockDbFallbackStores.get(db);
  if (!store) {
    store = new Map<string, FallbackBucket>();
    mockDbFallbackStores.set(db, store);
  }

  const windowMs = windowSeconds * 1000;
  const existing = store.get(key);
  let bucket: FallbackBucket;
  if (!existing || existing.resetAtMs <= nowMs) {
    bucket = { count: 1, resetAtMs: nowMs + windowMs };
    store.set(key, bucket);
  } else {
    existing.count += 1;
    bucket = existing;
  }

  const allowed = bucket.count <= maxRequests;
  const remaining = Math.max(0, maxRequests - bucket.count);
  const retryAfterSeconds = Math.max(1, Math.ceil((bucket.resetAtMs - nowMs) / 1000));
  const resetAtUnixSeconds = Math.ceil(bucket.resetAtMs / 1000);

  return {
    allowed,
    status: allowed ? 200 : 429,
    limit: maxRequests,
    currentCount: bucket.count,
    remaining,
    retryAfterSeconds,
    resetAtUnixSeconds,
    key,
    source: 'mock-fallback',
    errorCode: allowed ? undefined : 'RATE_LIMITED',
  };
}

/**
 * Enforces an atomic, persistent rate-limit window stored in Cloudflare D1 (`rate_limits`).
 */
export async function enforcePersistentD1RateLimit(
  db: D1Database | null | undefined,
  config: PersistentRateLimitConfig
): Promise<PersistentRateLimitResult> {
  const nowMs = config.nowMs ?? Date.now();
  const maxRequests = Math.max(1, Math.floor(config.maxRequests));
  const windowSeconds = Math.max(1, Math.floor(config.windowSeconds));
  const endpointType = config.endpointType.trim();
  const identifier = normalizeRateLimitIdentifier(config.identifier);
  const key = `d1rl:${endpointType}:${identifier}`;
  const strictRuntime = isProductionOrStagingRuntime() || config.failClosed === true;

  if (!db) {
    if (strictRuntime) {
      return {
        allowed: false,
        status: 503,
        limit: maxRequests,
        currentCount: maxRequests,
        remaining: 0,
        retryAfterSeconds: windowSeconds,
        resetAtUnixSeconds: Math.ceil((nowMs + windowSeconds * 1000) / 1000),
        key,
        source: 'fail-closed',
        errorCode: 'RATE_LIMIT_STORE_UNAVAILABLE',
      };
    }
    return evaluateMockDbFallback(
      globalThis,
      key,
      maxRequests,
      windowSeconds,
      nowMs
    );
  }

  const nowIso = new Date(nowMs).toISOString();
  const nextResetIso = new Date(nowMs + windowSeconds * 1000).toISOString();

  try {
    await ensureRateLimitsTable(db);

    const row = await db
      .prepare(ATOMIC_RATE_LIMIT_UPSERT_SQL)
      .bind(
        key,
        endpointType,
        identifier,
        maxRequests,
        windowSeconds,
        nextResetIso,
        nowIso,
        nowIso
      )
      .first<{ current_count: number; reset_at: string }>();

    if (!row || typeof row.current_count !== 'number') {
      // Synthetic Jest hand-rolled mock DBs that do not execute real SQLite queries return null.
      // In staging/production we NEVER fall back — fail closed immediately.
      if (strictRuntime) {
        return {
          allowed: false,
          status: 503,
          limit: maxRequests,
          currentCount: maxRequests,
          remaining: 0,
          retryAfterSeconds: windowSeconds,
          resetAtUnixSeconds: Math.ceil((nowMs + windowSeconds * 1000) / 1000),
          key,
          source: 'fail-closed',
          errorCode: 'RATE_LIMIT_STORE_UNAVAILABLE',
        };
      }
      return evaluateMockDbFallback(
        db as unknown as object,
        key,
        maxRequests,
        windowSeconds,
        nowMs
      );
    }

    const currentCount = Number(row.current_count);
    const parsedResetMs = Date.parse(row.reset_at);
    const effectiveResetMs = Number.isFinite(parsedResetMs)
      ? parsedResetMs
      : nowMs + windowSeconds * 1000;

    const allowed = currentCount <= maxRequests;
    const remaining = Math.max(0, maxRequests - currentCount);
    const retryAfterSeconds = Math.max(
      1,
      Math.ceil((effectiveResetMs - nowMs) / 1000)
    );
    const resetAtUnixSeconds = Math.ceil(effectiveResetMs / 1000);

    return {
      allowed,
      status: allowed ? 200 : 429,
      limit: maxRequests,
      currentCount,
      remaining,
      retryAfterSeconds,
      resetAtUnixSeconds,
      key,
      source: 'd1',
      errorCode: allowed ? undefined : 'RATE_LIMITED',
    };
  } catch {
    if (strictRuntime) {
      return {
        allowed: false,
        status: 503,
        limit: maxRequests,
        currentCount: maxRequests,
        remaining: 0,
        retryAfterSeconds: windowSeconds,
        resetAtUnixSeconds: Math.ceil((nowMs + windowSeconds * 1000) / 1000),
        key,
        source: 'fail-closed',
        errorCode: 'RATE_LIMIT_STORE_UNAVAILABLE',
      };
    }
    return evaluateMockDbFallback(
      db as unknown as object,
      key,
      maxRequests,
      windowSeconds,
      nowMs
    );
  }
}

/**
 * Builds a standardized HTTP 429 / 503 NextResponse with RFC-compliant rate-limit headers.
 */
export function buildD1RateLimitResponse(
  result: PersistentRateLimitResult,
  customMessage?: string
): NextResponse {
  const isStoreFailure = result.status === 503;
  const code = result.errorCode ?? (isStoreFailure ? 'RATE_LIMIT_STORE_UNAVAILABLE' : 'RATE_LIMITED');
  const errorMessage =
    customMessage ??
    (isStoreFailure
      ? 'Rate limit store unavailable; failing closed.'
      : `Too many requests. Retry after ${result.retryAfterSeconds}s.`);

  return NextResponse.json(
    {
      success: false,
      code,
      error: errorMessage,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: result.status,
      headers: {
        'Retry-After': String(result.retryAfterSeconds),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetAtUnixSeconds),
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
      },
    }
  );
}

/**
 * Purges expired rows from `rate_limits` to keep D1 storage bounded.
 */
export async function cleanupExpiredD1RateLimits(
  db: D1Database,
  nowMs: number = Date.now()
): Promise<number> {
  await ensureRateLimitsTable(db);
  const cutoffIso = new Date(nowMs).toISOString();
  const res = await db
    .prepare('DELETE FROM rate_limits WHERE reset_at <= ?')
    .bind(cutoffIso)
    .run();
  return Number(res.meta?.changes ?? 0);
}
