import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { createRateLimiter } from './lib/rate-limiter'
import { initializeDB } from './lib/db'
import { warn as logWarn } from './lib/logger'
import { evaluateGeoFence, buildGeoRestrictedResponse } from './lib/compliance/geo-fence'

export const DEFAULT_LOCALE = 'en'
export const SUPPORTED_LOCALES = ['en', 'vi'] as const

// Paths that skip all middleware processing (health checks, cron)
const SKIP_PATHS = [
'/api/health',
'/api/cron', // Cron handler - has its own auth
]

// Check if a path is an API route
function isApiPath(pathname: string): boolean {
return pathname.startsWith('/api/')
}

// Check if a path should skip all middleware processing
function shouldSkip(pathname: string): boolean {
return SKIP_PATHS.some((prefix) => pathname.startsWith(prefix))
}

// Extract locale from pathname (first segment)
function extractLocale(pathname: string): string | null {
const segments = pathname.split('/').filter(Boolean)
if (segments.length > 0 && (SUPPORTED_LOCALES as readonly string[]).includes(segments[0])) {
return segments[0]
}
return null
}

// Rate limiter instances
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
'/api/auth/signin': createRateLimiter({
maxRequests: 5,
windowMs: 60_000,
prefix: 'auth-signin',
}),
'/api/auth/signup': createRateLimiter({
maxRequests: 5,
windowMs: 60_000,
prefix: 'auth-signup',
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
prefix: 'affiliate',
}),
'/api/payouts': createRateLimiter({
maxRequests: 10,
windowMs: 60_000,
prefix: 'payouts',
}),
}

/**
* Get rate limiter for path
*/
function getRateLimiter(pathname: string): ((req: NextRequest) => Promise<NextResponse | null>) | null {
for (const [prefix, limiter] of Object.entries(rateLimiters)) {
if (pathname.startsWith(prefix)) {
return limiter
}
}
return null
}

export async function middleware(request: NextRequest): Promise<NextResponse> {
// Initialize database with query monitoring (no-op if already initialized)
try {
initializeDB();
} catch (error) {
// DB might not be available in all environments (e.g., during build)
// This is non-critical as getDB() will throw when actually needed
logWarn('[middleware] DB initialization skipped:', error);
}

const { pathname } = request.nextUrl

// 0. Handle Cloudflare Cron triggers
// Cron requests are sent to the root path '/' with a CF-Cron-Event header
const isCronRequest = request.headers.get('CF-Cron-Event') === 'true' ||
request.headers.get('cron') === 'true' ||
request.headers.get('x-cron') === 'true'
if (isCronRequest) {
// Rewrite to cron handler
const url = request.nextUrl.clone()
url.pathname = '/api/cron'
return NextResponse.rewrite(url)
}

// 1. Rate limiting for specific API endpoints
const limiter = getRateLimiter(pathname)
if (limiter) {
const rateLimited = await limiter(request)
if (rateLimited) return rateLimited
}

// 2. Skip further processing for certain API paths
if (isApiPath(pathname) && shouldSkip(pathname)) {
return NextResponse.next()
}

// 2.5. Edge Geo-Fencing + BLOCK_VN_SIGNUPS kill-switch
const geoDecision = await evaluateGeoFence(request)
if (!geoDecision.allowed) {
return buildGeoRestrictedResponse(geoDecision)
}

// 3. Locale handling for pages (skip API routes and clean-room shortlinks /r/:code)
if (!isApiPath(pathname) && !pathname.startsWith('/r/')) {
const locale = extractLocale(pathname)
if (!locale) {
// No locale in path, redirect to default
const url = request.nextUrl.clone()
url.pathname = pathname === '/' ? `/${DEFAULT_LOCALE}` : `/${DEFAULT_LOCALE}${pathname}`
return NextResponse.redirect(url)
}
}

// Continue to next handler
return NextResponse.next()
}

export const config = {
matcher: [
'/((?!_next|favicon.ico|.*\\..*|public).*)',
'/(en|vi)/((?!_next|favicon.ico|.*\\..*).*)',
'/api/:path*',
],
}
