/**
 * src/lib/payouts/admin-auth.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 5: Admin Payout Controls, Retries & Audit Logging
 *
 * Dedicated edge-compatible Admin RBAC guard for /api/admin/payouts/* routes.
 * Enforces dual-phase authentication:
 *   Phase 1: Valid user session (Bearer token or session cookie) -> 401 Unauthorized if missing/invalid
 *   Phase 2: Database profile check (role in ['admin', 'superadmin', 'super_admin']) -> 403 Forbidden if not admin
 * Also provides edge D1 database resolution and strict Cloudflare IP extraction.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';

export interface AdminIdentity {
  id: string;
  userId: string;
  email: string;
  role: string;
}

export interface AdminAuthSuccess {
  authorized: true;
  admin: AdminIdentity;
  db: D1Database;
  ipAddress: string;
  status?: 200;
  error?: undefined;
  response?: undefined;
}

export interface AdminAuthFailure {
  authorized: false;
  status: number;
  error: string;
  response: NextResponse;
  admin?: undefined;
  db?: undefined;
  ipAddress?: undefined;
}

export type AdminAuthResult = AdminAuthSuccess | AdminAuthFailure;

/**
 * Safely resolves the D1 database instance from request context, @/lib/db, or globalThis.DB
 */
export function resolveDatabase(request?: Request): D1Database | null {
  try {
    const reqDb = (request as any)?.env?.DB;
    if (reqDb) return reqDb;
    const db = getDB();
    if (db) return db;
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    if (globalDb) return globalDb;
  }
  return null;
}

/**
 * Strict Cloudflare IP extraction precedence to prevent header spoofing:
 * 1. cf-connecting-ip (Cloudflare edge validated, non-tamperable)
 * 2. x-forwarded-for (leftmost client IP in proxy chain)
 * 3. x-real-ip
 * 4. Fallback: '127.0.0.1'
 */
export function extractClientIp(headers: Headers): string {
  const cfConnectingIp = headers.get('cf-connecting-ip')?.trim();
  if (cfConnectingIp && cfConnectingIp.length > 0) {
    return cfConnectingIp;
  }

  const xForwardedFor = headers.get('x-forwarded-for');
  if (xForwardedFor && xForwardedFor.trim().length > 0) {
    const leftmost = xForwardedFor.split(',')[0]?.trim();
    if (leftmost && leftmost.length > 0) {
      return leftmost;
    }
  }

  const xRealIp = headers.get('x-real-ip')?.trim();
  if (xRealIp && xRealIp.length > 0) {
    return xRealIp;
  }

  return '127.0.0.1';
}

/**
 * Verifies that the incoming request has valid admin credentials.
 *
 * @param request - NextRequest object
 * @param dbOverride - Optional D1 database override for testing or custom bindings
 * @returns AdminAuthResult with authorized status and admin context or error response
 */
export async function verifyAdminPayoutAccess(
  request: NextRequest,
  dbOverride?: D1Database
): Promise<AdminAuthResult> {
  // 1. Resolve D1 database
  const db = dbOverride || resolveDatabase(request);
  if (!db) {
    const error = 'Database unavailable';
    return {
      authorized: false,
      status: 503,
      error,
      response: NextResponse.json(
        { success: false, error },
        { status: 503 }
      ),
    };
  }

  // Ensure globalThis.DB has reference if not set
  if (typeof globalThis !== 'undefined' && !(globalThis as any).DB) {
    (globalThis as any).DB = db;
  }

  const ipAddress = extractClientIp(request.headers);

  // 2. Resolve user session via dual-mode session helper
  let user: { id: string; email?: string } | null = null;
  try {
    user = await getAuthenticatedUser(request, db);
  } catch {
    user = null;
  }

  if (!user || !user.id) {
    const error = 'Unauthorized: Session required';
    return {
      authorized: false,
      status: 401,
      error,
      response: NextResponse.json(
        { success: false, error },
        { status: 401 }
      ),
    };
  }

  // 3. Query profiles table for role
  // D1 first() resolves to undefined when no row matches; the guards below treat that as "no profile".
  let profile: { id: string; role: string | null; email: string | null } | null | undefined = null;
  try {
    profile = await db
      .prepare('SELECT id, role, email FROM profiles WHERE id = ?')
      .bind(user.id)
      .first<{ id: string; role: string | null; email: string | null }>();
  } catch (err: any) {
    const error = 'Database query failed during admin verification';
    return {
      authorized: false,
      status: 500,
      error,
      response: NextResponse.json(
        { success: false, error },
        { status: 500 }
      ),
    };
  }

  const role = (profile?.role || '').toLowerCase().trim();
  const isAdminRole = role === 'admin' || role === 'superadmin' || role === 'super_admin';

  if (!profile || !isAdminRole) {
    const error = 'Forbidden: Admin access required';
    return {
      authorized: false,
      status: 403,
      error,
      response: NextResponse.json(
        { success: false, error },
        { status: 403 }
      ),
    };
  }

  const verifiedEmail = (profile.email || user.email || '').trim();
  return {
    authorized: true,
    admin: {
      id: profile.id,
      userId: profile.id,
      email: verifiedEmail,
      role: profile.role || 'admin',
    },
    db,
    ipAddress,
  };
}
