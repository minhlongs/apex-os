/**
 * Rate Limiting Middleware for API Routes
 *
 * Provides `withRateLimit` HOF to wrap API route handlers.
 * Supports both D1 and KV storage backends.
 */

import { NextRequest, NextResponse } from 'next/server';
import { RateLimiter, extractIpAddress, getEndpointType, type RateLimitResult } from './rate-limiter';
import { KVRateLimiter } from './kv-rate-limiter';

// Re-export extractIpAddress for convenience
export { extractIpAddress };

export interface RateLimitOptions {
  endpointType?: string;
  getUserId?: (request: NextRequest) => string | undefined | Promise<string | undefined>;
  getIdentifier?: (request: NextRequest, userId?: string) => { ip?: string; userId?: string; apiKey?: string };
  getRole?: (request: NextRequest) => string | undefined | Promise<string | undefined>;
  getTier?: (request: NextRequest) => string | undefined | Promise<string | undefined>;
  skipIf?: (request: NextRequest) => boolean;
  onRateLimited?: (result: RateLimitResult) => Response;
  storage?: 'd1' | 'kv'; // Default: 'd1'
}

/**
 * Wrap an API handler with rate limiting
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function withRateLimit<T extends (...args: any[]) => Promise<any>>(
  handler: T,
  options: RateLimitOptions = {}
): (...args: Parameters<T>) => Promise<any> {
  const { endpointType, getUserId, getIdentifier, getRole, getTier, skipIf, onRateLimited, storage = 'd1' } = options;

  return async (...args: Parameters<T>): Promise<any> => {
    const request = args[0] as NextRequest;

    if (skipIf && skipIf(request)) {
      return handler(...args);
    }

    // Choose limiter based on storage option
    let limiter;
    if (storage === 'kv') {
      limiter = getKVRateLimiter();
    } else {
      limiter = getRateLimiter();
    }

    const detectedType = endpointType || getEndpointType(request.nextUrl.pathname, request.method);

    const userId = getUserId ? await getUserId(request) : undefined;
    const identifier = getIdentifier
      ? getIdentifier(request, userId)
      : { ip: extractIpAddress(request.headers), userId };

    const result = await limiter.checkLimit(detectedType, identifier, {
      userId,
      userRole: getRole ? await getRole(request) : undefined,
      userTier: getTier ? await getTier(request) : undefined,
    });

    const headers = limiter.getHeaders(result) as Record<string, string>;

    if (!result.allowed) {
      if (onRateLimited) {
        return onRateLimited(result);
      }
      return NextResponse.json(
        { error: 'Too Many Requests', message: 'Rate limit exceeded', retryAfter: result.retryAfter },
        { status: 429, headers }
      );
    }

    const response = await handler(...args);
    if (response instanceof NextResponse) {
      Object.entries(headers).forEach(([k, v]) => response.headers.set(k, v));
    }
    return response;
  };
}

let rateLimiterInstance: InstanceType<typeof RateLimiter> | null = null;
let kvRateLimiterInstance: InstanceType<typeof KVRateLimiter> | null = null;

export function getRateLimiter(): InstanceType<typeof RateLimiter> {
  if (!rateLimiterInstance) {
    // @ts-ignore
    const db = globalThis.DB;
    if (!db) throw new Error('Database not initialized');
    rateLimiterInstance = new RateLimiter(db);
  }
  return rateLimiterInstance;
}

export function getKVRateLimiter(): InstanceType<typeof KVRateLimiter> {
  if (!kvRateLimiterInstance) {
    // @ts-ignore
    const kv = globalThis.KV;
    if (!kv) throw new Error('KV binding not initialized');
    kvRateLimiterInstance = new KVRateLimiter(kv);
  }
  return kvRateLimiterInstance;
}

/**
 * Extract user ID from request session (synchronous from cookies)
 * Note: This is a simplified version. For actual session verification,
 * you'd typically use the auth library's getSession method (async).
 */
export function getUserIdFromSession(request: NextRequest): string | undefined {
  // Try common session cookie names
  const sessionCookie = request.cookies.get('__session')?.value;
  if (sessionCookie) {
    // For Better Auth, session might be in a different format
    // This is a placeholder - actual implementation would decode the session
    return undefined;
  }
  return undefined;
}
