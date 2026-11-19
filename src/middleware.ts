import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createRateLimiter } from './lib/rate-limiter'
import { initializeDB } from './lib/db'
import { warn as logWarn } from './lib/logger'
import { evaluateGeoFence, buildGeoRestrictedResponse } from './lib/compliance/geo-fence'
import {
  applyHardenedSecurityHeaders,
  buildContentSecurityPolicy,
  buildCsrfForbiddenResponse,
  generateCspNonce,
  verifyTrustedMutationOrigin,
} from './lib/security/http-hardening'

export const DEFAULT_LOCALE = 'en'
export const SUPPORTED_LOCALES = ['en', 'vi'] as const

// Paths that skip geo/locale middleware processing (health checks, cron)
const SKIP_PATHS = [
  '/api/health',
  '/api/cron', // Cron handler - has its own auth
]

function isApiPath(pathname: string): boolean {
  return pathname.startsWith('/api/')
}

function shouldSkip(pathname: string): boolean {
  return SKIP_PATHS.some((prefix) => pathname.startsWith(prefix))
}

function extractLocale(pathname: string): string | null {
  const segments = pathname.split('/').filter(Boolean)
  if (segments.length > 0 && (SUPPORTED_LOCALES as readonly string[]).includes(segments[0])) {
    return segments[0]
  }
  return null
}

// Edge KV burst rate limiters (defense-in-depth outer shield; authoritative persistent D1
// rate limits execute atomically inside Auth, UID-binding, and Short-link route handlers)
const rateLimiters = {
  '/r/': createRateLimiter({
    maxRequests: 30,
    windowMs: 60_000,
    prefix: 'shortlink-click',
  }),
  '/api/tracking/click': createRateLimiter({
    maxRequests: 30,
    windowMs: 60_000,
    prefix: 'tracking-click',
  }),
  '/api/auth/sign-in': createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'auth-sign-in',
  }),
  '/api/auth/sign-up': createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'auth-sign-up',
  }),
  '/api/auth/signin': createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'auth-signin',
  }),
  '/api/auth/signup': createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'auth-signup',
  }),
  '/api/auth/forget-password': createRateLimiter({
    maxRequests: 5,
    windowMs: 60_000,
    prefix: 'auth-forget-password',
  }),
  '/api/auth/reset-password': createRateLimiter({
    maxRequests: 5,
    windowMs: 60_000,
    prefix: 'auth-reset-password',
  }),
  '/api/auth/telegram': createRateLimiter({
    maxRequests: 15,
    windowMs: 60_000,
    prefix: 'auth-telegram',
  }),
  '/api/webhooks': createRateLimiter({
    maxRequests: 50,
    windowMs: 60_000,
    prefix: 'webhooks',
  }),
  '/api/deals': createRateLimiter({
    maxRequests: 100,
    windowMs: 60_000,
    prefix: 'deals',
  }),
  '/api/affiliate': createRateLimiter({
    maxRequests: 60,
    windowMs: 60_000,
    prefix: 'affiliate-api',
  }),
  '/api/b2b/proof-of-rebate': createRateLimiter({
    maxRequests: 60,
    windowMs: 60_000,
    prefix: 'b2b-proof',
  }),
  '/api/admin': createRateLimiter({
    maxRequests: 25,
    windowMs: 60_000,
    prefix: 'admin-api',
  }),
  '/api/payouts': createRateLimiter({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'payouts',
  }),
}

function getRateLimiter(pathname: string): ((req: NextRequest) => Promise<NextResponse | null>) | null {
  for (const [prefix, limiter] of Object.entries(rateLimiters)) {
    if (pathname.startsWith(prefix)) {
      return limiter
    }
  }
  return null
}

function nextWithNonceAndHeaders(request: NextRequest, nonce: string): NextResponse {
  const requestHeaders = new Headers(request.headers)
  requestHeaders.set('x-nonce', nonce)
  requestHeaders.set(
    'Content-Security-Policy',
    buildContentSecurityPolicy({
      nonce,
      pathname: request.nextUrl.pathname,
    })
  )

  const response = NextResponse.next({
    request: {
      headers: requestHeaders,
    },
  })
  return applyHardenedSecurityHeaders(response, { request, nonce })
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
  try {
    initializeDB()
  } catch (error) {
    logWarn('[middleware] DB initialization skipped:', error)
  }

  const nonce = generateCspNonce()
  const { pathname } = request.nextUrl

  // 0. Handle Cloudflare Cron triggers
  const isCronRequest =
    request.headers.get('CF-Cron-Event') === 'true' ||
    request.headers.get('cron') === 'true' ||
    request.headers.get('x-cron') === 'true'
  if (isCronRequest) {
    const url = request.nextUrl.clone()
    url.pathname = '/api/cron'
    return applyHardenedSecurityHeaders(NextResponse.rewrite(url), { request, nonce })
  }

  // 1. F-01 Edge CSRF Defense on state-changing requests (`POST`, `PUT`, `PATCH`, `DELETE`)
  // Blocks cross-site (`Sec-Fetch-Site: cross-site`/`same-site`), untrusted/null `Origin`,
  // untrusted `Referer`, and cookie-authenticated mutations missing `Origin` & `Referer`.
  const isAdminPath = pathname.startsWith('/api/admin/') || pathname === '/api/admin'
  const csrfDecision = verifyTrustedMutationOrigin(request, {
    requireOriginWhenCookiePresent: true,
    requireOriginWithoutBearer: isAdminPath,
  })
  if (!csrfDecision.allowed) {
    return applyHardenedSecurityHeaders(
      buildCsrfForbiddenResponse(csrfDecision),
      { request, nonce }
    )
  }

  // 2. Edge rate limiting for specific API & shortlink endpoints
  const limiter = getRateLimiter(pathname)
  if (limiter) {
    const rateLimited = await limiter(request)
    if (rateLimited) {
      return applyHardenedSecurityHeaders(rateLimited, { request, nonce })
    }
  }

  // 3. Skip further geo/locale processing for health/cron API paths
  if (isApiPath(pathname) && shouldSkip(pathname)) {
    return nextWithNonceAndHeaders(request, nonce)
  }

  // 3b. Geo-Fencing Gate (G5): Enforce CF-IPCountry allow/blocklist BEFORE serving UI or APIs
  const geoDecision = await evaluateGeoFence(request, {
    db: (globalThis as unknown as { DB?: Parameters<typeof evaluateGeoFence>[1] extends { db?: infer T } ? T : never }).DB,
  })
  if (!geoDecision.allowed) {
    return applyHardenedSecurityHeaders(
      buildGeoRestrictedResponse(geoDecision),
      { request, nonce }
    )
  }

  // 4. API routes don't need locale handling
  if (isApiPath(pathname)) {
    return nextWithNonceAndHeaders(request, nonce)
  }

  // 5. Shortlink redirects (/r/[code]) skip locale handling
  if (pathname.startsWith('/r/')) {
    return nextWithNonceAndHeaders(request, nonce)
  }

  // 6. Locale handling for page routes
  const currentLocale = extractLocale(pathname)
  if (!currentLocale) {
    const url = request.nextUrl.clone()
    url.pathname = `/${DEFAULT_LOCALE}${pathname === '/' ? '' : pathname}`
    return applyHardenedSecurityHeaders(NextResponse.redirect(url), { request, nonce })
  }

  return nextWithNonceAndHeaders(request, nonce)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
