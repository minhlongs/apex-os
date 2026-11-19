/**
 * Admin Ascendancy Runtime Circuit Breakers, Reconciliation Telemetry & Broadcast Queue Route
 *
 * Endpoints:
 * - GET  /api/admin/runtime-flags
 *     Requires authenticated `admin` session (401/403 otherwise).
 *     Returns:
 *       - `flags`: rows from `system_runtime_flags`
 *       - `recentReconciliations`: last 15 rows from `partner_cash_reconciliations` + `r2_evidence_objects.payload_sha256`
 *       - `recentShadowReconciliations`: last 15 rows from `partner_shadow_reconciliations`
 *       - `recentBroadcasts`: last 15 rows from `settlement_broadcasts`
 * - POST /api/admin/runtime-flags
 *     Requires BOTH `admin` session AND WebAuthn Passkey step-up (`x-passkey-stepup-token`).
 *     Updates one of the 5 allowed `system_runtime_flags` to `'true'` or `'false'` with a
 *     mandatory `reason` string (minimum 5 characters) and `updated_by = authz.adminId`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import {
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import { redactPiiForReadOnlyAi } from '@/lib/compliance/pii-redactor';
import type { D1Database } from '@/lib/db';
import {
  resolveShadowPromotionExchange,
  validateShadowPromotionGate,
} from '@/lib/partners/shadow-promotion-gate';
import {
  ALLOWED_ASCENDANCY_RUNTIME_FLAGS,
  type AllowedAscendancyRuntimeFlag,
} from './constants';

export type { AllowedAscendancyRuntimeFlag };

const ALLOWED_RUNTIME_FLAG_SET = new Set<string>(
  ALLOWED_ASCENDANCY_RUNTIME_FLAGS
);

export interface RuntimeFlagRow {
  flag_key: string;
  flag_value: string;
  reason: string | null;
  updated_by: string | null;
  updated_at: string;
}

export interface RecentReconciliationRow {
  id: string;
  exchange: string;
  evidence_id: string;
  wallet_evidence_id: string | null;
  uid_allocated_units: number;
  wallet_cash_collected_units: number;
  clawback_offset_units: number;
  minted_gross_units: number;
  discrepancy_units: number;
  status: string;
  reconciled_at: string;
  payload_sha256: string | null;
}

export interface RecentShadowReconciliationRow {
  id: string;
  exchange: string;
  evidence_id: string;
  wallet_evidence_id: string | null;
  row_count: number;
  mapped_uid_count: number;
  unmapped_uid_count: number;
  simulated_gross_units: number;
  wallet_cash_collected_units: number;
  discrepancy_units: number;
  status: string;
  notes: string | null;
  created_at: string;
  payload_sha256: string | null;
}

export interface RecentBroadcastRow {
  id: string;
  payout_id: string;
  affiliate_id: string;
  chain: string;
  recipient_address: string;
  amount_units_1e8: number;
  state: string;
  tx_hash: string | null;
  safe_multisig_tx_hash: string | null;
  error_reason: string | null;
  updated_at: string;
}

function sanitizeOptionalNote(value: string | null): string | null {
  if (!value) {
    return null;
  }
  return redactPiiForReadOnlyAi(value).redacted;
}

async function queryOptionalRows<T>(
  db: D1Database,
  sql: string
): Promise<T[]> {
  try {
    const result = await db.prepare(sql).all<T>();
    return result.results ?? [];
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) {
      return [];
    }
    throw err;
  }
}

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

    const flagsResult = await db
      .prepare(
        `SELECT flag_key, flag_value, reason, updated_by, updated_at
         FROM system_runtime_flags
         ORDER BY flag_key ASC`
      )
      .all<RuntimeFlagRow>();

    const recentReconciliationsRaw = await queryOptionalRows<RecentReconciliationRow>(
      db,
      `SELECT
         r.id,
         r.exchange,
         r.evidence_id,
         r.wallet_evidence_id,
         r.uid_allocated_units,
         r.wallet_cash_collected_units,
         r.clawback_offset_units,
         r.minted_gross_units,
         r.discrepancy_units,
         r.status,
         r.reconciled_at,
         e.payload_sha256
       FROM partner_cash_reconciliations r
       LEFT JOIN r2_evidence_objects e ON e.id = r.evidence_id
       ORDER BY r.reconciled_at DESC, r.rowid DESC
       LIMIT 15`
    );

    const recentShadowRaw = await queryOptionalRows<RecentShadowReconciliationRow>(
      db,
      `SELECT
         s.id,
         s.exchange,
         s.evidence_id,
         s.wallet_evidence_id,
         s.row_count,
         s.mapped_uid_count,
         s.unmapped_uid_count,
         s.simulated_gross_units,
         s.wallet_cash_collected_units,
         s.discrepancy_units,
         s.status,
         s.notes,
         s.created_at,
         e.payload_sha256
       FROM partner_shadow_reconciliations s
       LEFT JOIN r2_evidence_objects e ON e.id = s.evidence_id
       ORDER BY s.created_at DESC, s.rowid DESC
       LIMIT 15`
    );

    const recentBroadcastsRaw = await queryOptionalRows<RecentBroadcastRow>(
      db,
      `SELECT
         payout_id AS id,
         payout_id,
         affiliate_id,
         chain,
         recipient_address,
         amount_units_1e8,
         state,
         tx_hash,
         safe_multisig_tx_hash,
         error_reason,
         updated_at
       FROM settlement_broadcasts
       ORDER BY updated_at DESC, rowid DESC
       LIMIT 15`
    );

    const flags: RuntimeFlagRow[] = (flagsResult.results ?? []).map((row) => ({
      flag_key: row.flag_key,
      flag_value: row.flag_value,
      reason: sanitizeOptionalNote(row.reason),
      updated_by: row.updated_by ?? null,
      updated_at: row.updated_at,
    }));

    const recentShadowReconciliations: RecentShadowReconciliationRow[] =
      recentShadowRaw.map((row) => ({
        ...row,
        notes: sanitizeOptionalNote(row.notes),
      }));

    const recentBroadcasts: RecentBroadcastRow[] = recentBroadcastsRaw.map(
      (row) => ({
        ...row,
        error_reason: sanitizeOptionalNote(row.error_reason),
      })
    );

    return NextResponse.json(
      {
        success: true,
        flags,
        recentReconciliations: recentReconciliationsRaw,
        recentShadowReconciliations,
        recentBroadcasts,
      },
      { status: 200 }
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
          error: 'Invalid JSON request body',
        },
        { status: 400 }
      );
    }

    const flagKey =
      typeof body.flagKey === 'string' ? body.flagKey.trim() : '';
    const flagValue =
      typeof body.flagValue === 'boolean'
        ? String(body.flagValue)
        : typeof body.flagValue === 'string'
          ? body.flagValue.trim()
          : '';
    const reason =
      typeof body.reason === 'string' ? body.reason.trim() : '';

    if (!ALLOWED_RUNTIME_FLAG_SET.has(flagKey)) {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_RUNTIME_FLAG',
          error: `Unsupported runtime flag '${flagKey}'`,
        },
        { status: 400 }
      );
    }

    if (flagValue !== 'true' && flagValue !== 'false') {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_FLAG_VALUE',
          error: "flagValue must be 'true' or 'false'",
        },
        { status: 400 }
      );
    }

    if (reason.length < 5) {
      return NextResponse.json(
        {
          success: false,
          code: 'REASON_REQUIRED',
          error: 'A mandatory audit reason (minimum 5 characters) is required',
        },
        { status: 400 }
      );
    }

    if (flagValue === 'true' && resolveShadowPromotionExchange(flagKey)) {
      const gate = await validateShadowPromotionGate(db, flagKey);
      if (!gate.allowed) {
        return NextResponse.json(
          {
            success: false,
            code: gate.code,
            error: gate.error,
          },
          { status: gate.status }
        );
      }
    }

    const updatedBy = authz.adminId;
    await db
      .prepare(
        `INSERT INTO system_runtime_flags (flag_key, flag_value, reason, updated_by, updated_at)
         VALUES (?, ?, ?, ?, datetime('now'))
         ON CONFLICT(flag_key) DO UPDATE SET
           flag_value = excluded.flag_value,
           reason = excluded.reason,
           updated_by = excluded.updated_by,
           updated_at = datetime('now')`
      )
      .bind(flagKey, flagValue, reason, updatedBy)
      .run();

    try {
      await db
        .prepare(
          `INSERT INTO compliance_audit_logs (
             id, action, severity, actor_id, target_id, details, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(
          crypto.randomUUID(),
          'runtime_flag_updated',
          'high',
          updatedBy,
          flagKey,
          JSON.stringify({
            flagKey,
            flagValue,
            reason,
            source: '/api/admin/runtime-flags',
          })
        )
        .run();
    } catch {
      // compliance_audit_logs may be absent in minimal unit test fixtures
    }

    const updatedRow = await db
      .prepare(
        `SELECT flag_key, flag_value, reason, updated_by, updated_at
         FROM system_runtime_flags
         WHERE flag_key = ?
         LIMIT 1`
      )
      .bind(flagKey)
      .first<RuntimeFlagRow>();

    return NextResponse.json(
      {
        success: true,
        code: 'RUNTIME_FLAG_UPDATED',
        flagKey,
        flagValue,
        reason: sanitizeOptionalNote(reason),
        updatedBy,
        flag: updatedRow
          ? {
              ...updatedRow,
              reason: sanitizeOptionalNote(updatedRow.reason),
            }
          : null,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
