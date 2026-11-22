/**
 * HTTP Edge & Route Security Hardening (F-01 & F-02)
 *
 * F-01: CSRF Defense for Cookie-Authenticated State-Changing Requests
 *   - Strict exact-origin verification of `Origin`, `Referer` fallback, and `Sec-Fetch-Site` Fetch Metadata.
 *   - Rejects `Origin: null` (sandboxed iframe / data: redirect), cross-site / sibling-subdomain origins,
 *     and cookie-authenticated mutations missing both `Origin` and `Referer`.
 *
 * F-02: Hardened Content-Security-Policy (per-request cryptographic nonce + strict-dynamic)
 *   & Companion HTTP Security Headers
 *   - Eliminates `'unsafe-inline'` and `'unsafe-eval'` from `script-src`.
 *   - Enforces `frame-ancestors 'none'` (scoped to Telegram Web origins only on `/telegram` Mini App routes),
 *     `object-src 'none'`, `base-uri 'self'`, `form-action 'self'`, `X-Content-Type-Options: nosniff`,
 *     `Referrer-Policy`, `Permissions-Policy`, `Strict-Transport-Security`, and `Cache-Control: private, no-store`
 *     on `/api/admin/*` and `/api/auth/*`.
 */

import { NextResponse } from 'next/server';
import { isProductionOrStagingRuntime } from '@/lib/auth/runtime-env';

const STATE_CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

const SESSION_COOKIE_NAMES = [
  '__Secure-better-auth.session_token',
  'better-auth.session_token',
  '__session',
  'session_token',
  'auth_token',
] as const;

const EXTERNAL_SIGNED_WEBHOOK_PREFIXES = [
  '/api/webhooks/',
  '/api/cron',
] as const;

export type CsrfRejectionCode =
  | 'CSRF_CROSS_SITE_BLOCKED'
  | 'CSRF_ORIGIN_MISMATCH'
  | 'CSRF_REFERER_MISMATCH'
  | 'CSRF_ORIGIN_REQUIRED';

export interface CsrfVerificationResult {
  allowed: boolean;
  status: 200 | 403;
  code?: CsrfRejectionCode;
  error?: string;
  trustedOrigins: string[];
}

export interface CsrfVerificationOptions {
  /**
   * When true, any cookie-authenticated mutating request without a Bearer token
   * MUST carry a matching `Origin` or `Referer` header.
   */
  requireOriginWhenCookiePresent?: boolean;
  /**
   * When true (admin mutations), any mutating request without a Bearer token
   * MUST carry a matching `Origin` or `Referer` header regardless of cookie names.
   */
  requireOriginWithoutBearer?: boolean;
  /**
   * When true, do not skip external webhook/cron path prefixes.
   */
  enforceUnconditionally?: boolean;
}

function safeParseOrigin(rawUrl: string | null | undefined): string | null {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  const trimmed = rawUrl.trim();
  if (!trimmed || trimmed.toLowerCase() === 'null') return null;
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }
    return parsed.origin.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Resolves the exact set of trusted origins for the current request.
 * Never uses substring or prefix matching (`evil.com` suffix spoofing is impossible).
 */
export function resolveTrustedRequestOrigins(request: Request): Set<string> {
  const trusted = new Set<string>();

  const requestUrlOrigin = safeParseOrigin(request.url);
  if (requestUrlOrigin) {
    trusted.add(requestUrlOrigin);
  }

  // Never trust `x-forwarded-host` to expand the CSRF allowlist (prevents header-injection bypass).
  const hostHeader = request.headers.get('host')?.trim();
  if (hostHeader && /^[a-zA-Z0-9.:-]+$/.test(hostHeader)) {
    const defaultProto = requestUrlOrigin?.startsWith('http://') ? 'http' : 'https';
    const synthesized = safeParseOrigin(`${defaultProto}://${hostHeader}`);
    if (synthesized) {
      trusted.add(synthesized);
    }
  }

  for (const envCandidate of [
    process.env.NEXT_PUBLIC_APP_URL,
    process.env.WEBAUTHN_ORIGIN,
  ]) {
    const parsedEnvOrigin = safeParseOrigin(envCandidate);
    if (parsedEnvOrigin) {
      trusted.add(parsedEnvOrigin);
    }
  }

  return trusted;
}

export function hasAmbientSessionCookie(request: Request): boolean {
  const cookieHeader = request.headers.get('cookie');
  if (!cookieHeader || !cookieHeader.trim()) return false;
  return SESSION_COOKIE_NAMES.some((cookieName) => {
    const escaped = cookieName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|;\\s*)${escaped}=`).test(cookieHeader);
  });
}

export function hasExplicitBearerAuthorization(request: Request): boolean {
  const authHeader = request.headers.get('authorization');
  if (!authHeader) return false;
  return /^Bearer\s+\S+/i.test(authHeader.trim());
}

function hasExplicitInternalSecretHeader(request: Request): boolean {
  return Boolean(
    request.headers.get('x-internal-secret')?.trim() ||
      request.headers.get('x-cron-secret')?.trim()
  );
}

function isExternalSignedReceiverPath(pathname: string): boolean {
  return EXTERNAL_SIGNED_WEBHOOK_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(prefix)
  );
}

/**
 * Verifies that a state-changing HTTP request (`POST`, `PUT`, `PATCH`, `DELETE`)
 * originates from a trusted first-party origin and is not a cross-site forgery.
 */
export function verifyTrustedMutationOrigin(
  request: Request,
  options: CsrfVerificationOptions = {}
): CsrfVerificationResult {
  const method = (request.method || 'GET').toUpperCase();
  if (!STATE_CHANGING_METHODS.has(method)) {
    return { allowed: true, status: 200, trustedOrigins: [] };
  }

  let pathname = '/';
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    pathname = '/';
  }

  if (!options.enforceUnconditionally && isExternalSignedReceiverPath(pathname)) {
    return { allowed: true, status: 200, trustedOrigins: [] };
  }

  const trustedSet = resolveTrustedRequestOrigins(request);
  const trustedOrigins = Array.from(trustedSet);

  // 1. W3C Fetch Metadata (`Sec-Fetch-Site`) defense:
  // Reject cross-site AND sibling-subdomain (`same-site`, e.g. another *.workers.dev tenant) mutations.
  const secFetchSite = request.headers.get('sec-fetch-site')?.trim().toLowerCase();
  if (
    secFetchSite &&
    secFetchSite !== 'same-origin' &&
    secFetchSite !== 'none'
  ) {
    return {
      allowed: false,
      status: 403,
      code: 'CSRF_CROSS_SITE_BLOCKED',
      error: `Forbidden: Cross-origin state-changing request blocked (Sec-Fetch-Site: ${secFetchSite}).`,
      trustedOrigins,
    };
  }

  // 2. `Origin` header check (always sent by modern browsers on fetch/XHR/form POST/PUT/PATCH/DELETE).
  const rawOrigin = request.headers.get('origin');
  if (rawOrigin !== null) {
    const parsedOrigin = safeParseOrigin(rawOrigin);
    if (!parsedOrigin || !trustedSet.has(parsedOrigin)) {
      return {
        allowed: false,
        status: 403,
        code: 'CSRF_ORIGIN_MISMATCH',
        error: 'Forbidden: Untrusted or opaque request Origin header.',
        trustedOrigins,
      };
    }
    return { allowed: true, status: 200, trustedOrigins };
  }

  // 3. `Referer` header fallback check when `Origin` was omitted.
  const rawReferer = request.headers.get('referer');
  if (rawReferer !== null) {
    const parsedRefererOrigin = safeParseOrigin(rawReferer);
    if (!parsedRefererOrigin || !trustedSet.has(parsedRefererOrigin)) {
      return {
        allowed: false,
        status: 403,
        code: 'CSRF_REFERER_MISMATCH',
        error: 'Forbidden: Untrusted or malformed Referer header.',
        trustedOrigins,
      };
    }
    return { allowed: true, status: 200, trustedOrigins };
  }

  // 4. Neither `Origin` nor `Referer` is present:
  // Non-browser clients using explicit `Authorization: Bearer` or internal secret headers are safe
  // because browsers cannot attach custom auth headers cross-origin without CORS approval.
  if (
    hasExplicitBearerAuthorization(request) ||
    hasExplicitInternalSecretHeader(request)
  ) {
    return { allowed: true, status: 200, trustedOrigins };
  }

  const mustRequireOrigin =
    Boolean(options.requireOriginWithoutBearer) ||
    (Boolean(options.requireOriginWhenCookiePresent) &&
      hasAmbientSessionCookie(request));

  if (mustRequireOrigin) {
    return {
      allowed: false,
      status: 403,
      code: 'CSRF_ORIGIN_REQUIRED',
      error:
        'Forbidden: Cookie-authenticated state-changing requests must include a trusted Origin or Referer header.',
      trustedOrigins,
    };
  }

  return { allowed: true, status: 200, trustedOrigins };
}

export function buildCsrfForbiddenResponse(
  decision: CsrfVerificationResult
): NextResponse {
  return NextResponse.json(
    {
      success: false,
      code: decision.code ?? 'CSRF_ORIGIN_MISMATCH',
      error:
        decision.error ??
        'Forbidden: Cross-site state-changing request rejected.',
    },
    {
      status: 403,
      headers: {
        'Cache-Control': 'private, no-store, no-cache, must-revalidate',
      },
    }
  );
}

/**
 * Generates a fresh 128-bit cryptographic base64 nonce per HTTP request.
 */
export function generateCspNonce(): string {
  const bytes = new Uint8Array(16);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Fallback for stripped test environments
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = Math.floor(Math.random() * 256);
    }
  }

  if (typeof Buffer !== 'undefined') {
    return Buffer.from(bytes).toString('base64');
  }

  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

export function isTelegramMiniAppPath(pathname: string): boolean {
  return (
    pathname === '/telegram' ||
    pathname.startsWith('/telegram/') ||
    /^\/(en|vi)\/telegram(\/|$)/.test(pathname)
  );
}

export interface BuildCspOptions {
  nonce: string;
  pathname: string;
  isSecureRuntime?: boolean;
}

/**
 * Builds a strict Content-Security-Policy header value:
 *   - `/api/*` JSON responses get a locked-down `default-src 'none'` policy.
 *   - HTML pages get per-request `'nonce-...' 'strict-dynamic'` in `script-src`
 *     with ZERO `'unsafe-inline'` and ZERO `'unsafe-eval'`.
 */
export function buildContentSecurityPolicy(options: BuildCspOptions): string {
  const { nonce, pathname } = options;
  const isSecure =
    options.isSecureRuntime ?? isProductionOrStagingRuntime();

  if (pathname.startsWith('/api/')) {
    return "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'";
  }

  const isTelegram = isTelegramMiniAppPath(pathname);
  const scriptSrc = isTelegram
    ? `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://telegram.org`
    : `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`;

  const frameAncestors = isTelegram
    ? "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org"
    : "frame-ancestors 'none'";

  const directives = [
    "default-src 'self'",
    scriptSrc,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self' https://*.ingest.sentry.io https://*.posthog.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    frameAncestors,
  ];

  if (isSecure) {
    directives.push('upgrade-insecure-requests');
  }

  return directives.join('; ');
}

export interface ApplySecurityHeadersOptions {
  request: Request;
  nonce: string;
}

/**
 * Attaches hardened CSP and companion security headers to any outgoing NextResponse/Response.
 */
export function applyHardenedSecurityHeaders<T extends Response>(
  response: T,
  options: ApplySecurityHeadersOptions
): T {
  const { request, nonce } = options;
  let pathname = '/';
  let isHttpsRequest = false;
  try {
    const parsedUrl = new URL(request.url);
    pathname = parsedUrl.pathname;
    isHttpsRequest =
      parsedUrl.protocol === 'https:' ||
      request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() === 'https';
  } catch {
    pathname = '/';
  }

  const isSecureRuntime = isProductionOrStagingRuntime() || isHttpsRequest;
  const isTelegram = isTelegramMiniAppPath(pathname);

  const csp = buildContentSecurityPolicy({
    nonce,
    pathname,
    isSecureRuntime,
  });

  response.headers.set('Content-Security-Policy', csp);
  response.headers.set('x-nonce', nonce);
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  response.headers.set(
    'Permissions-Policy',
    'accelerometer=(), camera=(), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=(), browsing-topics=()'
  );
  response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');

  if (!isTelegram) {
    response.headers.set('X-Frame-Options', 'DENY');
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
  }

  if (isSecureRuntime) {
    response.headers.set(
      'Strict-Transport-Security',
      'max-age=63072000; includeSubDomains; preload'
    );
  }

  // Prevent CDN/shared-cache poisoning of authenticated admin or session endpoints
  if (pathname.startsWith('/api/admin/') || pathname.startsWith('/api/auth/')) {
    response.headers.set(
      'Cache-Control',
      'private, no-store, no-cache, must-revalidate'
    );
  }

  return response;
}
