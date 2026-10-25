/**
 * src/app/api/kyc/initiate/route.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * User KYC Verification Initiation Route
 *
 * Edge-compatible endpoint generating an active identity verification session
 * with configured provider (Sumsub/Persona/Mock), setting profiles.kyc_status = 'pending',
 * and emitting an immutable compliance audit log.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import { getKycProvider } from '@/lib/compliance/provider';
import { complianceAuditService } from '@/lib/compliance/audit-service';
import * as logger from '@/lib/logger';

function resolveDatabase(request?: Request): D1Database | null {
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

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = resolveDatabase(request);
  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  // 1. Dual-mode authentication (Bearer token or cookie)
  let user: { id: string; email?: string } | null = null;
  try {
    user = await getAuthenticatedUser(request, db);
  } catch (err: any) {
    logger.error(`[KYC Initiate] Auth extraction failed: ${err?.message || String(err)}`);
    user = null;
  }

  if (!user || !user.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Session required' },
      { status: 401 }
    );
  }

  // 2. Parse optional request parameters
  let requestedProvider: string | undefined;
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = await request.json();
      requestedProvider = body?.provider;
    }
  } catch {
    // Body is optional
  }

  try {
    // 3. Resolve KYC provider adapter and create session
    const provider = getKycProvider(requestedProvider);
    const sessionResult = await provider.createSession(user.id, user.email);

    // 4. Update profile kyc_status = 'pending'
    await db
      .prepare(`
        UPDATE profiles
        SET kyc_status = 'pending',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      .bind(user.id)
      .run();

    // 5. Emit compliance audit log
    await complianceAuditService.log(db, {
      action: 'kyc_initiated',
      severity: 'low',
      actorId: user.id,
      targetId: user.id,
      details: {
        provider: sessionResult.provider,
        sessionToken: sessionResult.sessionToken,
        redirectUrl: sessionResult.redirectUrl,
        initiatedAt: new Date().toISOString(),
      },
    });

    logger.info(
      `[KYC Initiate] Created session for user ${user.id} via provider ${sessionResult.provider}`
    );

    return NextResponse.json(
      {
        success: true,
        sessionToken: sessionResult.sessionToken,
        redirectUrl: sessionResult.redirectUrl,
        provider: sessionResult.provider,
        status: 'pending',
      },
      { status: 200 }
    );
  } catch (err: any) {
    logger.error(
      `[KYC Initiate] Failed to initiate KYC session for user ${user.id}: ${
        err?.message || String(err)
      }`
    );
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
