/**
 * src/app/api/kyc/initiate/route.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * User KYC Verification Initiation Route (Data Minimization Enforced)
 *
 * Per Vietnam Personal Data Protection Law 91/2025/QH15, ApexOS enforces strict
 * data minimization and disables identity document collection (CCCD/Passport)
 * by default (HTTP 410 Gone), relying instead on non-PII sanctions and on-chain
 * blacklist screening. Legacy session creation is gated behind an explicit
 * test-only override (ALLOW_LEGACY_KYC_SESSION_FOR_TESTS === 'true').
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import { getKycProvider } from '@/lib/compliance/provider';
import { complianceAuditService } from '@/lib/compliance/audit-service';
import * as logger from '@/lib/logger';

interface RequestWithEnv extends Request {
  env?: {
    DB?: D1Database;
  };
}

function resolveDatabase(request?: Request): D1Database | null {
  try {
    const reqDb = (request as RequestWithEnv | undefined)?.env?.DB;
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

  // 1. Dual-mode authentication (Bearer token or cookie)
  let user: { id: string; email?: string } | null = null;
  try {
    user = await getAuthenticatedUser(request, db ?? undefined);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(`[KYC Initiate] Auth extraction failed: ${message}`);
    user = null;
  }

  if (!user || !user.id) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Session required' },
      { status: 401 }
    );
  }

  // 2. Enforce Law 91/2025/QH15 Data-Minimization Policy by default
  if (process.env.ALLOW_LEGACY_KYC_SESSION_FOR_TESTS !== 'true') {
    return NextResponse.json(
      {
        success: false,
        code: 'KYC_DOCUMENT_COLLECTION_DISABLED',
        error:
          'Identity document collection is disabled under data-minimization policy (Law 91/2025/QH15). Compliance uses non-PII sanctions and on-chain blacklist screening.',
      },
      { status: 410 }
    );
  }

  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  // 3. Parse optional request parameters (legacy test-only override path)
  let requestedProvider: string | undefined;
  try {
    const contentType = request.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const body = (await request.json()) as { provider?: unknown };
      if (typeof body?.provider === 'string') {
        requestedProvider = body.provider;
      }
    }
  } catch {
    // Body is optional
  }

  try {
    // 4. Resolve KYC provider adapter and create session
    const provider = getKycProvider(requestedProvider);
    const sessionResult = await provider.createSession(user.id, user.email);

    // 5. Update profile kyc_status = 'pending'
    await db
      .prepare(`
        UPDATE profiles
        SET kyc_status = 'pending',
            updated_at = datetime('now')
        WHERE id = ?
      `)
      .bind(user.id)
      .run();

    // 6. Emit compliance audit log
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
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error(
      `[KYC Initiate] Failed to initiate KYC session for user ${user.id}: ${message}`
    );
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
