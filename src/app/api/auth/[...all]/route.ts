/**
 * Better Auth catch-all route with rate limiting
 * Delegates all /api/auth/* requests to the Better Auth handler.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { resolveDatabase } from '@/lib/auth/session-helper';
import {
  buildD1RateLimitResponse,
  enforcePersistentD1RateLimit,
  extractTrustedClientIp,
} from '@/lib/security/d1-rate-limiter';
import {
  buildCsrfForbiddenResponse,
  verifyTrustedMutationOrigin,
} from '@/lib/security/http-hardening';

// Auth endpoints that require strict persistent D1 brute-force protection
const RATE_LIMITED_AUTH_ENDPOINTS = [
  '/signin',
  '/signup',
  '/login',
  '/register',
  '/sign-in',
  '/sign-in/email',
  '/sign-up',
  '/sign-up/email',
  '/forget-password',
  '/reset-password',
];

function getAuthEndpoint(pathname: string): string | null {
  const normalized = pathname.endsWith('/') && pathname.length > 1
    ? pathname.slice(0, -1)
    : pathname;
  for (const endpoint of RATE_LIMITED_AUTH_ENDPOINTS) {
    if (normalized.endsWith(endpoint) || normalized === `/api/auth${endpoint}`) {
      return `/api/auth${endpoint}`;
    }
  }
  return null;
}

async function extractUserIdentifier(request: NextRequest): Promise<string | null> {
  try {
    const body = await request.clone().json();
    return body.email || body.identifier || body.username || null;
  } catch {
    return null;
  }
}

async function handleRateLimitedAuth(request: NextRequest): Promise<Response> {
  const pathname = new URL(request.url).pathname;

  if (pathname === '/api/auth/session' || pathname === '/api/auth/get-session') {
    try {
      const { getAuthenticatedUser, resolveDatabase } = await import('@/lib/auth/session-helper');
      const globalDb = (globalThis as unknown as { DB?: ReturnType<typeof resolveDatabase> }).DB;
      const db = globalDb || resolveDatabase();
      const user = await getAuthenticatedUser(request, db ?? undefined);

      if (!user) {
        return NextResponse.json({ user: null, session: null }, { status: 200 });
      }

      return NextResponse.json(
        {
          user: {
            id: user.id,
            email: user.email ?? null,
          },
          session: {
            userId: user.id,
          },
        },
        { status: 200 }
      );
    } catch {
      return NextResponse.json({ user: null, session: null }, { status: 200 });
    }
  }

  const csrfDecision = verifyTrustedMutationOrigin(request);
  if (!csrfDecision.allowed) {
    return buildCsrfForbiddenResponse(csrfDecision);
  }

  const globalDb = (globalThis as unknown as { DB?: ReturnType<typeof resolveDatabase> }).DB;
  const db = globalDb || resolveDatabase();
  const endpoint = getAuthEndpoint(pathname);

  if (!endpoint) {
    const auth = createAuth({ DB: db as any });
    return auth.handler(request);
  }

  // Persistent D1 IP-based rate limit: 5 req / 60s across Worker isolates
  const clientIp = extractTrustedClientIp(request);
  const ipResult = await enforcePersistentD1RateLimit(db, {
    endpointType: 'auth_ip',
    identifier: `${endpoint}:${clientIp}`,
    maxRequests: 5,
    windowSeconds: 60,
  });

  if (!ipResult.allowed) {
    if (ipResult.status === 503) {
      return buildD1RateLimitResponse(ipResult);
    }
    return NextResponse.json(
      {
        error: 'Too Many Requests',
        code: ipResult.errorCode ?? 'RATE_LIMITED',
        message: `IP rate limit exceeded. Try again in ${ipResult.retryAfterSeconds}s.`,
        retry_after: ipResult.retryAfterSeconds,
      },
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '0',
          'Retry-After': String(ipResult.retryAfterSeconds),
        },
      }
    );
  }

  // Persistent D1 account-based rate limit: 3 req / 60s per email/identifier
  const userIdentifier = await extractUserIdentifier(request);
  if (userIdentifier) {
    const userResult = await enforcePersistentD1RateLimit(db, {
      endpointType: 'auth_identifier',
      identifier: userIdentifier.toLowerCase().trim(),
      maxRequests: 3,
      windowSeconds: 60,
    });

    if (!userResult.allowed) {
      if (userResult.status === 503) {
        return buildD1RateLimitResponse(userResult);
      }
      return NextResponse.json(
        {
          error: 'Too Many Requests',
          code: userResult.errorCode ?? 'RATE_LIMITED',
          message: `Account rate limit exceeded. Try again in ${userResult.retryAfterSeconds}s.`,
          retry_after: userResult.retryAfterSeconds,
        },
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': '3',
            'X-RateLimit-Remaining': '0',
            'Retry-After': String(userResult.retryAfterSeconds),
          },
        }
      );
    }
  }

  const auth = createAuth({ DB: db as any });
  return auth.handler(request);
}

export async function GET(request: Request) {
  return handleRateLimitedAuth(request as NextRequest);
}

export async function POST(request: Request) {
  return handleRateLimitedAuth(request as NextRequest);
}
