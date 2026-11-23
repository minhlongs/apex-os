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

import { createHash, timingSafeEqual } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import {
  enforcePersistentD1RateLimit,
  extractClientIp,
  type PersistentRateLimitResult,
} from '@/lib/security/d1-rate-limiter';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import { isProductionOrStagingRuntime } from '@/lib/auth/runtime-env';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import { redactPiiForReadOnlyAi } from '@/lib/compliance/pii-redactor';
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

function hashRateLimitIdentifier(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex').slice(0, 32);
}

function buildProofRateLimitResponse(
  result: PersistentRateLimitResult,
  message: string
): NextResponse {
  const errorCode =
    result.errorCode ?? (result.status === 503 ? 'RATE_LIMIT_STORE_UNAVAILABLE' : 'RATE_LIMITED');
  return NextResponse.json(
    {
      success: false,
      error: errorCode,
      message,
      retryAfterSeconds: result.retryAfterSeconds,
    },
    {
      status: result.status,
      headers: {
        'Cache-Control': 'no-store',
        'Retry-After': String(Math.max(1, result.retryAfterSeconds)),
        'X-RateLimit-Limit': String(result.limit),
        'X-RateLimit-Remaining': String(result.remaining),
        'X-RateLimit-Reset': String(result.resetAtUnixSeconds),
      },
    }
  );
}

/**
 * Compare two secrets without leaking either one's length.
 *
 * Hashing both sides to a fixed 32-byte SHA-256 digest makes the subsequent
 * `timingSafeEqual` call constant-time regardless of input length, so an
 * attacker cannot learn the configured key's byte length by timing guesses.
 */
function timingSafeStringEqual(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
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

    // Pre-auth ingress admission & durable D1 rate limit (120 req/60s) executed
    // BEFORE query/AI-tool parsing and BEFORE any D1 session lookup.
    const legacyDb = db as unknown as LegacyD1Database;
    if (isProductionOrStagingRuntime()) {
      const trustedCfIp = request.headers.get('cf-connecting-ip')?.trim().toLowerCase() || '';
      if (trustedCfIp) {
        const ipRateCheck = await enforcePersistentD1RateLimit(legacyDb, {
          endpointType: 'b2b_proof_ip',
          identifier: `ip:${hashRateLimitIdentifier(trustedCfIp)}`,
          maxRequests: 120,
          windowSeconds: 60,
          failClosed: true,
        });
        if (!ipRateCheck.allowed) {
          return buildProofRateLimitResponse(
            ipRateCheck,
            ipRateCheck.status === 503
              ? 'Proof-of-Rebate rate limit store unavailable; failing closed.'
              : 'Too many Proof-of-Rebate requests from this network. Please retry shortly.'
          );
        }
      } else {
        // Missing/empty/whitespace Cloudflare edge IP: never trust X-Forwarded-For or
        // X-Real-IP, and never skip pre-auth throttling. Only admit legitimate internal
        // Worker-to-Worker / service callers presenting a constant-time-verified
        // B2B_PROOF_API_KEY (zero D1 session lookup).
        const configuredB2bKey = process.env.B2B_PROOF_API_KEY?.trim();
        const providedB2bKey = request.headers.get('x-b2b-api-key')?.trim();
        const hasValidServiceKey = Boolean(
          configuredB2bKey &&
            providedB2bKey &&
            timingSafeStringEqual(configuredB2bKey, providedB2bKey)
        );

        if (!hasValidServiceKey || !providedB2bKey) {
          return NextResponse.json(
            {
              success: false,
              error: 'MISSING_TRUSTED_CLIENT_IP',
              message: 'Trusted Cloudflare client IP header is required',
            },
            { status: 403, headers: { 'Cache-Control': 'no-store' } }
          );
        }

        const svcIngressRateCheck = await enforcePersistentD1RateLimit(legacyDb, {
          endpointType: 'b2b_proof_svc_ingress',
          identifier: `svc_ingress:${hashRateLimitIdentifier(providedB2bKey)}`,
          maxRequests: 120,
          windowSeconds: 60,
          failClosed: true,
        });
        if (!svcIngressRateCheck.allowed) {
          return buildProofRateLimitResponse(
            svcIngressRateCheck,
            svcIngressRateCheck.status === 503
              ? 'Proof-of-Rebate rate limit store unavailable; failing closed.'
              : 'Too many Proof-of-Rebate service ingress requests. Please retry shortly.'
          );
        }
      }
    } else {
      // Local dev/test: never silently skip pre-auth throttling.
      const localClientIp = extractClientIp(request);
      const ipRateCheck = await enforcePersistentD1RateLimit(legacyDb, {
        endpointType: 'b2b_proof_ip',
        identifier: `ip:${hashRateLimitIdentifier(localClientIp)}`,
        maxRequests: 120,
        windowSeconds: 60,
        failClosed: true,
      });
      if (!ipRateCheck.allowed) {
        return buildProofRateLimitResponse(
          ipRateCheck,
          ipRateCheck.status === 503
            ? 'Proof-of-Rebate rate limit store unavailable; failing closed.'
            : 'Too many Proof-of-Rebate requests from this network. Please retry shortly.'
        );
      }
    }

    const url = new URL(request.url);
    const rawBatchId = url.searchParams.get('batchId');
    const rawAffiliateId = url.searchParams.get('affiliateId');
    const rawLimit = url.searchParams.get('limit');
    const verifyR2 = url.searchParams.get('verifyR2') === 'true';
    const aiContext = url.searchParams.get('aiContext') === 'true';
    const rawAiTools = url.searchParams.get('aiTools');
    const requestedTools = rawAiTools
      ? rawAiTools
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : undefined;

    if (requestedTools && requestedTools.length > 0) {
      try {
        redactPiiForReadOnlyAi({}, { requestedTools });
      } catch (toolErr) {
        return NextResponse.json(
          {
            success: false,
            error: 'FORBIDDEN_AI_TOOL',
            message:
              toolErr instanceof Error
                ? toolErr.message
                : 'Requested AI tool violates read-only policy',
          },
          { status: 403, headers: { 'Cache-Control': 'no-store' } }
        );
      }
    }

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
    if (verifyR2) {
      limit = Math.min(limit, 25);
    }

    const authz = await authorizeB2bProofCaller(request, db);
    if (!authz.authorized) {
      return authz.response;
    }

    // Bound total proof reads per authenticated caller identity using durable D1
    // rate_limits (migration 032). Never trust spoofable X-Forwarded-For / X-Real-IP
    // headers and never store raw PII or credentials in rate-limit keys. Fails closed
    // (HTTP 503) if D1 rate-limit storage is unavailable or errors.
    const callerIdentifier = authz.isServiceKey
      ? `svc:${hashRateLimitIdentifier(request.headers.get('x-b2b-api-key')?.trim() ?? 'service')}`
      : `user:${hashRateLimitIdentifier(authz.userId ?? 'unknown')}`;

    const callerRateCheck = await enforcePersistentD1RateLimit(legacyDb, {
      endpointType: 'b2b_proof_caller',
      identifier: callerIdentifier,
      maxRequests: 60,
      windowSeconds: 60,
      failClosed: true,
    });
    if (!callerRateCheck.allowed) {
      return buildProofRateLimitResponse(
        callerRateCheck,
        callerRateCheck.status === 503
          ? 'Proof-of-Rebate rate limit store unavailable; failing closed.'
          : 'Too many Proof-of-Rebate requests. Please retry shortly.'
      );
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

      const safeProof = aiContext
        ? redactPiiForReadOnlyAi(proof, { requestedTools }).redacted
        : proof;

      return NextResponse.json(
        {
          success: true,
          proof: safeProof,
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
    const safeProofs = aiContext
      ? redactPiiForReadOnlyAi(proofs, { requestedTools }).redacted
      : proofs;

    return NextResponse.json(
      {
        success: true,
        affiliateId,
        count: safeProofs.length,
        proofs: safeProofs,
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
