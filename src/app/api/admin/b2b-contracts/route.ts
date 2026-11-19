/**
 * Admin White-Label B2B Agency Split Contracts API Route
 *
 * Endpoints:
 * - GET  /api/admin/b2b-contracts
 *     Requires authenticated `admin` session (`401` / `403`).
 *     Returns provisioned `b2b_agency_contracts` schedules + canonical `G1` bounds.
 * - POST /api/admin/b2b-contracts
 *     Requires BOTH `admin` session AND WebAuthn Passkey step-up (`x-passkey-stepup-token`).
 *     Enforces Safe-Spread Waterfall I4 (`tier3SpreadBps === 0` hard-locked per Vietnam
 *     Decree 40/2018/ND-CP, `tier2SpreadBps <= 1000`, `tier1SpreadBps + tier2SpreadBps <= 4500`,
 *     `clawbackReserveBps >= 500`) and upserts `b2b_agency_contracts`.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import {
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import {
  DEFAULT_B2B_WATERFALL_PREVIEW,
  InvalidWaterfallConfigError,
  listB2bAgencyContracts,
  upsertB2bAgencyContract,
  type B2bAgencyContractStatus,
} from '@/lib/ledger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, code: 'DB_UNAVAILABLE', error: 'Database unavailable' },
        { status: 503 }
      );
    }

    const user = await getAuthenticatedUser(request, db);
    if (!user?.id) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNAUTHENTICATED',
          error: 'Authentication required',
        },
        { status: 401 }
      );
    }

    const profile = await db
      .prepare('SELECT id, role FROM profiles WHERE id = ? LIMIT 1')
      .bind(user.id)
      .first<{ id: string; role: string }>();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json(
        {
          success: false,
          code: 'ADMIN_ROLE_REQUIRED',
          error: 'Forbidden: Admin access required',
        },
        { status: 403 }
      );
    }

    let contracts = [] as Awaited<ReturnType<typeof listB2bAgencyContracts>>;
    try {
      contracts = await listB2bAgencyContracts(db as unknown as AuthD1Database, 100);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/no such table/i.test(msg)) {
        throw err;
      }
    }

    return NextResponse.json(
      {
        success: true,
        contracts,
        policyBounds: {
          clawbackReserveBpsRange: [500, 2500],
          traderCashbackBpsRange: [0, 8000],
          tier1SpreadBpsRange: [0, 4500],
          tier2SpreadBpsRange: [0, 1000],
          tier3SpreadBpsHardLocked: 0,
          maxCombinedPartnerSpreadBps: 4500,
          defaults: DEFAULT_B2B_WATERFALL_PREVIEW,
        },
      },
      { status: 200, headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, code: 'DB_UNAVAILABLE', error: 'Database unavailable' },
        { status: 503 }
      );
    }

    const authz = await requireAdminWithPasskeyStepUp(request, db, {
      purpose: 'admin_step_up',
    });
    if (!authz.authorized || !authz.adminId) {
      return NextResponse.json(
        {
          success: false,
          code: authz.code,
          error: authz.error,
        },
        { status: authz.status }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_JSON',
          error: 'Request body must be valid JSON',
        },
        { status: 400 }
      );
    }

    const agencyProfileId =
      typeof body.agencyProfileId === 'string' ? body.agencyProfileId : '';
    const agencyName = typeof body.agencyName === 'string' ? body.agencyName : '';

    const parseOptionalInt = (val: unknown, field: string): number | undefined => {
      if (val === undefined || val === null) return undefined;
      if (typeof val !== 'number' || !Number.isInteger(val)) {
        throw new InvalidWaterfallConfigError(`${field} must be an integer basis-point value`);
      }
      return val;
    };

    try {
      const contract = await upsertB2bAgencyContract(db as unknown as AuthD1Database, {
        agencyProfileId,
        agencyName,
        clawbackReserveBps: parseOptionalInt(body.clawbackReserveBps, 'clawbackReserveBps'),
        traderCashbackBps: parseOptionalInt(body.traderCashbackBps, 'traderCashbackBps'),
        tier1SpreadBps: parseOptionalInt(body.tier1SpreadBps, 'tier1SpreadBps'),
        tier2SpreadBps: parseOptionalInt(body.tier2SpreadBps, 'tier2SpreadBps'),
        tier3SpreadBps: parseOptionalInt(body.tier3SpreadBps, 'tier3SpreadBps'),
        status:
          typeof body.status === 'string'
            ? (body.status.trim().toUpperCase() as B2bAgencyContractStatus)
            : undefined,
        notes: typeof body.notes === 'string' ? body.notes : null,
        actorAdminId: authz.adminId,
      });

      return NextResponse.json(
        {
          success: true,
          contract,
        },
        { status: 200, headers: { 'Cache-Control': 'no-store' } }
      );
    } catch (validationErr: unknown) {
      if (validationErr instanceof InvalidWaterfallConfigError) {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_WATERFALL_CONFIG',
            error: validationErr.message,
          },
          { status: 422 }
        );
      }
      throw validationErr;
    }
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
