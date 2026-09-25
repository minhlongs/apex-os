/**
 * src/lib/auth/session-helper.ts
 * Universal Authentication Helper for Next.js API Routes (Cloudflare D1 & Workers runtime)
 * Supports dual-mode authentication:
 * - Mobile: Authorization: Bearer <token>
 * - Web: Cookie (better-auth.session_token, __session, session_token)
 */

import { getDB, type D1Database } from '@/lib/db';
import { createAuth } from '@/lib/auth/auth-factory';
import { warn as logWarn, error as logError } from '@/lib/logger';

export interface AuthenticatedUser {
  id: string;
  email?: string;
}

interface SessionRow {
  user_id: string;
  expires_at: string;
  email: string | null;
}

/**
 * Safely resolves the D1 database instance from @/lib/db or globalThis.DB
 */
export function resolveDatabase(): D1Database | null {
  try {
    return getDB();
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    return globalDb || null;
  }
}

/**
 * Extracts the bearer token from the Authorization header if present.
 */
export function extractBearerToken(headers: Headers): string | null {
  const authHeader = headers.get('authorization') || headers.get('Authorization');
  if (!authHeader) return null;

  const match = authHeader.match(/^Bearer\s+(\S+)$/i);
  return match ? match[1].trim() : null;
}

/**
 * Parses cookies from header string into a record.
 */
export function parseCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  const pairs = cookieHeader.split(';');

  for (const pair of pairs) {
    const idx = pair.indexOf('=');
    if (idx === -1) continue;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(val);
    } catch {
      cookies[key] = val;
    }
  }

  return cookies;
}

/**
 * Extracts a session token from Cookie header.
 * Handles Better Auth signed cookies (<token>.<signature>) by stripping the signature.
 */
export function extractCookieToken(headers: Headers): string | null {
  const cookieHeader = headers.get('cookie') || headers.get('Cookie');
  if (!cookieHeader) return null;

  const cookies = parseCookies(cookieHeader);

  // Preferred cookie keys in priority order
  const candidates = [
    cookies['better-auth.session_token'],
    cookies['__Secure-better-auth.session_token'],
    cookies['__session'],
    cookies['session_token'],
    cookies['auth_token'],
  ];

  for (const raw of candidates) {
    if (raw && typeof raw === 'string' && raw.length > 0) {
      // If signed with HMAC (token.signature), isolate the raw token part
      const token = raw.split('.')[0];
      if (token) return token;
    }
  }

  return null;
}

/**
 * Validates a session token directly against the Cloudflare D1 sessions table.
 */
export async function validateSessionInD1(
  db: D1Database,
  token: string
): Promise<AuthenticatedUser | null> {
  try {
    const query = `
      SELECT s.user_id, s.expires_at, p.email
      FROM sessions s
      LEFT JOIN profiles p ON s.user_id = p.id
      WHERE (s.token = ? OR s.id = ?)
      LIMIT 1
    `;

    const row = await db.prepare(query).bind(token, token).first<SessionRow>();
    if (!row) {
      return null;
    }

    // Verify expiration timestamp
    let expiresAtMs: number;
    const numeric = Number(row.expires_at);
    if (!isNaN(numeric) && isFinite(numeric)) {
      expiresAtMs = numeric < 1e11 ? numeric * 1000 : numeric;
    } else {
      expiresAtMs = new Date(row.expires_at).getTime();
    }

    if (isNaN(expiresAtMs) || expiresAtMs <= Date.now()) {
      return null;
    }

    return {
      id: row.user_id,
      email: row.email || undefined,
    };
  } catch (error) {
    logError('[session-helper] D1 session validation error:', error);
    return null;
  }
}

/**
 * Validates session using Better Auth engine.
 */
export async function validateSessionWithBetterAuth(
  db: D1Database,
  headers: Headers
): Promise<AuthenticatedUser | null> {
  try {
    const auth = createAuth({ DB: db });
    const sessionResult = await auth.api.getSession({ headers });

    if (sessionResult?.user?.id) {
      return {
        id: String(sessionResult.user.id),
        email: sessionResult.user.email || undefined,
      };
    }
    return null;
  } catch {
    // Better Auth may fail on malformed signed cookies or missing secrets; return null for fallback
    return null;
  }
}

/**
 * Universal function to retrieve the currently authenticated user from a Request.
 *
 * @param request - Standard Web Fetch Request or NextRequest
 * @param dbOverride - Optional D1Database instance (useful for testing or specific bindings)
 * @returns { id: string; email?: string } | null
 */
export async function getAuthenticatedUser(
  request: Request,
  dbOverride?: D1Database
): Promise<AuthenticatedUser | null> {
  if (!request || !request.headers) {
    return null;
  }

  try {
    const headers = request.headers;
    const bearerToken = extractBearerToken(headers);
    const hasCookies = !!(headers.get('cookie') || headers.get('Cookie'));

    // Fast exit if no credentials supplied
    if (!bearerToken && !hasCookies) {
      return null;
    }

    const db = dbOverride || resolveDatabase();
    if (!db) {
      logWarn('[session-helper] Database not available for session authentication');
      return null;
    }

    // 1. If cookie is present, attempt Better Auth session validation first
    if (hasCookies) {
      const betterAuthUser = await validateSessionWithBetterAuth(db, headers);
      if (betterAuthUser) {
        return betterAuthUser;
      }
    }

    // 2. Direct D1 verification: Check Bearer token (mobile) or raw cookie token (web fallback)
    const tokenCandidate = bearerToken || extractCookieToken(headers);
    if (tokenCandidate) {
      const d1User = await validateSessionInD1(db, tokenCandidate);
      if (d1User) {
        return d1User;
      }
    }

    return null;
  } catch (err) {
    logError('[session-helper] Unexpected error during authentication:', err);
    return null;
  }
}

export default getAuthenticatedUser;
