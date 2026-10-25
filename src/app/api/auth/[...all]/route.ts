/**
 * Better Auth catch-all route with rate limiting
 * Delegates all /api/auth/* requests to the Better Auth handler.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { checkRateLimit, getClientIP } from '@/lib/rate-limiter';

// Auth endpoints that need rate limiting
const RATE_LIMITED_AUTH_ENDPOINTS = ['/signin', '/signup', '/login', '/register'];

function getAuthEndpoint(pathname: string): string | null {
  for (const endpoint of RATE_LIMITED_AUTH_ENDPOINTS) {
    if (pathname.endsWith(endpoint) || pathname === `/api/auth${endpoint}`) {
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

  const endpoint = getAuthEndpoint(pathname);

  if (!endpoint) {
    const auth = createAuth({ DB: (globalThis as any).DB });
    return auth.handler(request);
  }

  // IP-based rate limit: 5 req/min
  const ipResult = await checkRateLimit(request, {
    maxRequests: 5,
    windowMs: 60 * 1000,
    keyGenerator: (req) => `ip:${getClientIP(req)}`,
  });

  if (!ipResult.allowed) {
    return NextResponse.json(
      {
        error: 'Too Many Requests',
        message: `IP rate limit exceeded. Try again in ${ipResult.retryAfter ?? 60}s.`,
        retry_after: Math.ceil((ipResult.retryAfter ?? 60) / 1000),
      },
      {
        status: 429,
        headers: {
          'Content-Type': 'application/json',
          'X-RateLimit-Limit': '5',
          'X-RateLimit-Remaining': '0',
          'Retry-After': String(Math.ceil((ipResult.retryAfter ?? 60) / 1000)),
        },
      }
    );
  }

  // User-based rate limit: 3 req/min per email
  const userIdentifier = await extractUserIdentifier(request);
  if (userIdentifier) {
    const userKey = `email:${userIdentifier.toLowerCase().trim()}`;
    const userResult = await checkRateLimit(request, {
      maxRequests: 3,
      windowMs: 60 * 1000,
      keyGenerator: () => userKey,
    });

    if (!userResult.allowed) {
      return NextResponse.json(
        {
          error: 'Too Many Requests',
          message: `Account rate limit exceeded. Try again in ${userResult.retryAfter ?? 60}s.`,
          retry_after: Math.ceil((userResult.retryAfter ?? 60) / 1000),
        },
        {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'X-RateLimit-Limit': '3',
            'X-RateLimit-Remaining': '0',
            'Retry-After': String(Math.ceil((userResult.retryAfter ?? 60) / 1000)),
          },
        }
      );
    }
  }

  const auth = createAuth({ DB: (globalThis as any).DB });
  return auth.handler(request);
}

export async function GET(request: Request) {
  return handleRateLimitedAuth(request as NextRequest);
}

export async function POST(request: Request) {
  return handleRateLimitedAuth(request as NextRequest);
}
