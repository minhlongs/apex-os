/**
 * Admin API Actions
 * Shared utilities for admin API routes
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';
import { createAuth } from '@/lib/auth/auth-factory';
import { error as logError } from '@/lib/logger';

// Helper to get DB connection for API routes (with query monitoring)
export { getDB };

/**
 * Verify admin user from request session
 * Used by API routes to protect admin endpoints
 */
/**
 * Verify admin user from request session
 * Used by API routes to protect admin endpoints
 */
export async function requireAdmin(request: NextRequest): Promise<{ userId: string; role: string; email: string } | null> {
  try {
    const db = getDB();

    // Get session from headers and cookies (using Next.js headers API)
    const { headers: getHeaders, cookies } = await import('next/headers');
    const readonlyHeaders = await getHeaders();
    const cookieStore = await cookies();

    // Convert ReadonlyHeaders to mutable Headers for auth API
    const headers = new Headers();
    readonlyHeaders.forEach((value, key) => headers.append(key, value));

    // Build cookies object for auth
    const cookiesObj: Record<string, string> = {};
    const allCookies = cookieStore.getAll();
    for (const cookie of allCookies) {
      cookiesObj[cookie.name] = cookie.value;
    }

    const sessionResult = await createAuth({ DB: db }).api.getSession({
      headers,
      cookies: cookiesObj,
    });

    if (!sessionResult?.user) {
      return null;
    }

    const userId = (sessionResult.user as { id: string }).id;

    // Get user profile to check role
    const profile = await db
      .prepare('SELECT role, email FROM profiles WHERE id = ?')
      .bind(userId)
      .first<{ role: string; email: string }>();

    if (!profile || profile.role !== 'admin') {
      return null;
    }

    return { userId, role: profile.role, email: profile.email };
  } catch (error) {
logError('requireAdmin error:', error);
    return null;
  }
}

/**
 * API Response helpers
 */
export function successResponse<T>(data: T, status: number = 200) {
  return NextResponse.json({ success: true, data }, { status });
}

export function errorResponse(message: string, status: number = 500) {
  return NextResponse.json({ success: false, error: message }, { status });
}
