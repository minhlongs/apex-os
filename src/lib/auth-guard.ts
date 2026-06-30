/**
* Admin role guard for API routes.
*
* Usage (with request):
*   const admin = await requireAdminRole(request);
*   if (!admin) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
*
* Usage (server actions / no request available):
*   const admin = await requireAdminRole();
*   if (!admin) return { success: false, error: 'Unauthorized' };
*/

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { getDB } from '@/lib/db';

export interface AdminSession {
userId: string;
role: string;
email: string;
}

/**
* Verify that the current session user has the admin role.
* When called with a NextRequest, extracts session from headers/cookies.
* When called without arguments, reads session from global DB binding
* (suitable for server actions where request is not available).
*
* @param request - Optional NextRequest for session extraction
* @returns Admin session info or null if not authorized
*/
export async function requireAdminRole(
request?: NextRequest
): Promise<AdminSession | null> {
try {
const db = getDB();

if (request) {
const auth = createAuth({ DB: db as any });
const sessionResult = await auth.api.getSession({
headers: request.headers,
cookies: request.cookies as unknown as Record<string, string>,
});

if (!sessionResult?.user) {
return null;
}

const userId = (sessionResult.user as { id: string }).id;
const profile = await db
.prepare('SELECT role, email FROM profiles WHERE id = ?')
.bind(userId)
.first() as { role: string; email: string } | undefined;

if (!profile || profile.role !== 'admin') {
return null;
}

return { userId, role: profile.role, email: profile.email };
}

// No request provided — fall back to global DB binding
// Used by server actions where request is not available
const globalDB = (globalThis as unknown as { DB: any }).DB;
if (!globalDB) {
return null;
}

const auth = createAuth({ DB: globalDB as any });
const sessionResult = await auth.api.getSession({
headers: new Headers(),
cookies: {} as Record<string, string>,
});

if (!sessionResult?.user) {
return null;
}

const userId = (sessionResult.user as { id: string }).id;
const profile = await globalDB
.prepare('SELECT role, email FROM profiles WHERE id = ?')
.bind(userId)
.first() as { role: string; email: string } | undefined;

if (!profile || profile.role !== 'admin') {
return null;
}

return { userId, role: profile.role, email: profile.email };
} catch (error) {
console.error('requireAdminRole error:', error);
return null;
}
}
