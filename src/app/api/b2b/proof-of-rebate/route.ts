/**
 * B2B Cryptographic Proof-of-Rebate Read-Only Verification Endpoint
 *
 * GET /api/b2b/proof-of-rebate?batchId=...
 * GET /api/b2b/proof-of-rebate?affiliateId=...&limit=25
 *
 * Returns PII-redacted rebate proofs linking ledger batch ID, masked trader UID
 * (`***1234`), Safe-Spread Waterfall I4 split in `10^-8` USD integer units,
 * R2 statement `payload_sha256`, `CASH_COLLECTED` reconciliation status, and
 * `settled_tx_hash`.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import { error as logError } from '@/lib/logger';
import {
  getProofOfRebateByBatchId,
  listProofsOfRebateByAffiliateId,
  type R2BucketLike,
} from '@/lib/ledger';

interface RuntimeBindings {
  DB?: AuthD1Database;
  STORAGE?: R2BucketLike;
}

const SAFE_IDENTIFIER_REGEX = /^[a-zA-Z0-9_.:-]{1,128}$/;

function resolveBindings(): RuntimeBindings {
  const globalScope = globalThis as unknown as RuntimeBindings;
  return {
    DB: globalScope.DB,
    STORAGE: globalScope.STORAGE,
  };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length === 0) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function authorizeB2bProofCaller(
  request: NextRequest,
  db: AuthD1Database
): Promise<
  | { authorized: true; userId: string | null; isAdmin: boolean; isServiceKey: boolean }
  | { authorized: false; response: NextResponse }
> {
  const configuredB2bKey = process.env.B2B_PROOF_API_KEY?.trim();
  const providedB2bKey = request.headers.get('x-b2b-api-key')?.trim();
  if (configuredB2bKey && providedB2bKey && timingSafeStringEqual(configuredB2bKey, providedB2bKey)) {
    return { authorized: true, userId: null, isAdmin: true, isServiceKey: true };
  }

  let sessionUser: { id: string; email?: string } | null = null;
  try {
    sessionUser = await getAuthenticatedUser(request, db as unknown as LegacyD1Database);
  } catch {
    sessionUser = null;
  }

  if (!sessionUser?.id) {
    return {
      authorized: false,
      response: NextResponse.json(
        {
          success: false,
          error: 'UNAUTHORIZED',
          message: 'Authenticated session or valid x-b2b-api-key is required',
        },
        { status: 401, headers: { 'Cache-Control': 'no-store' } }
      ),
    };
  }

  let isAdmin = false;
  try {
    const profileRow = await db
      .prepare('SELECT role FROM profiles WHERE id = ?')
      .bind(sessionUser.id)
      .first<{ role: string }>();
    isAdmin = profileRow?.role === 'admin';
  } catch {
    isAdmin = false;
  }

  return {
    authorized: true,
    userId: sessionUser.id,
    isAdmin,
    isServiceKey: false,
  };
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const rawBatchId = url.searchParams.get('batchId');
    const rawAffiliateId = url.searchParams.get('affiliateId');
    const rawLimit = url.searchParams.get('limit');
    const verifyR2 = url.searchParams.get('verifyR2') === 'true';

    if (!rawBatchId && !rawAffiliateId) {
      return NextResponse.json(
        {
          success: false,
          error: 'MISSING_QUERY_PARAMETER',
          message: 'Provide either batchId or affiliateId query parameter',
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (rawBatchId !== null && !SAFE_IDENTIFIER_REGEX.test(rawBatchId.trim())) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_BATCH_ID',
          message: 'batchId must be a valid identifier (1..128 alphanumeric/safe characters)',
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    if (rawAffiliateId !== null && !SAFE_IDENTIFIER_REGEX.test(rawAffiliateId.trim())) {
      return NextResponse.json(
        {
          success: false,
          error: 'INVALID_AFFILIATE_ID',
          message:
            'affiliateId must be a valid identifier (1..128 alphanumeric/safe characters)',
        },
        { status: 400, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    let limit = 25;
    if (rawLimit !== null) {
      const parsedLimit = Number(rawLimit);
      if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
        return NextResponse.json(
          {
            success: false,
            error: 'INVALID_LIMIT',
            message: 'limit must be an integer between 1 and 100',
          },
          { status: 400, headers: { 'Cache-Control': 'no-store' } }
        );
      }
      limit = parsedLimit;
    }

    const { DB: db, STORAGE: r2 } = resolveBindings();
    if (!db) {
      return NextResponse.json(
        {
          success: false,
          error: 'DATABASE_UNAVAILABLE',
          message: 'Ledger D1 database binding is not configured',
        },
        { status: 503, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const authz = await authorizeB2bProofCaller(request, db);
    if (!authz.authorized) {
      return authz.response;
    }

    if (rawBatchId !== null) {
      const batchId = rawBatchId.trim();
      if (!authz.isAdmin && authz.userId) {
        const batchMetaRow = await db
          .prepare('SELECT metadata FROM ledger_journal_batches WHERE id = ?')
          .bind(batchId)
          .first<{ metadata: string }>();
        if (batchMetaRow) {
          let parsedMeta: Record<string, unknown> = {};
          try {
            parsedMeta = JSON.parse(batchMetaRow.metadata) as Record<string, unknown>;
          } catch {
            parsedMeta = {};
          }
          const isOwner =
            parsedMeta.traderId === authz.userId ||
            parsedMeta.l1AffiliateId === authz.userId ||
            parsedMeta.b2bAgencyId === authz.userId;
          if (!isOwner) {
            return NextResponse.json(
              {
                success: false,
                error: 'FORBIDDEN_TENANT_SCOPE',
                message: 'Caller is not authorized to inspect this rebate batch',
              },
              { status: 403, headers: { 'Cache-Control': 'no-store' } }
            );
          }
        }
      }

      const r2ToVerify = verifyR2 && r2 ? r2 : undefined;
      const proof = await getProofOfRebateByBatchId(db, batchId, {
        r2: r2ToVerify,
      });
      if (!proof) {
        return NextResponse.json(
          {
            success: false,
            error: 'PROOF_NOT_FOUND',
            message: 'No verified Proof-of-Rebate found for the requested batchId',
          },
          { status: 404, headers: { 'Cache-Control': 'no-store' } }
        );
      }

      return NextResponse.json(
        {
          success: true,
          proof,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    const affiliateId = (rawAffiliateId ?? '').trim();
    if (!authz.isAdmin && authz.userId !== affiliateId) {
      return NextResponse.json(
        {
          success: false,
          error: 'FORBIDDEN_TENANT_SCOPE',
          message: 'Caller may only list Proof-of-Rebate records for their own affiliateId',
        },
        { status: 403, headers: { 'Cache-Control': 'no-store' } }
      );
    }

    // Disallow unbounded R2 object re-reads on multi-row list queries unless admin/service key
    const listR2ToVerify = verifyR2 && authz.isAdmin && r2 ? r2 : undefined;
    const proofs = await listProofsOfRebateByAffiliateId(db, affiliateId, {
      limit,
      r2: listR2ToVerify,
    });

    return NextResponse.json(
      {
        success: true,
        affiliateId,
        count: proofs.length,
        proofs,
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err) {
    logError(
      '[GET /api/b2b/proof-of-rebate] Unexpected error:',
      err instanceof Error ? err.message : String(err)
    );
    return NextResponse.json(
      {
        success: false,
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to verify Proof-of-Rebate',
      },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
