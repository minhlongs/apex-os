/**
 * Passkey-Protected Partner Poller & 30-Day Shadow Promotion Admin Route
 *
 * Endpoints:
 * - GET  /api/admin/reconciliation/poller
 *     Admin-authenticated telemetry view returning recent `partner_poller_runs`
 *     and `partner_shadow_reconciliations` promotion readiness for KuCoin & Gate.io.
 * - POST /api/admin/reconciliation/poller
 *     Requires Admin session + WebAuthn Passkey step-up (`admin_step_up`).
 *     Supports:
 *       1. `action: 'run'` (default): Manual poll cycle across selected or all pollable
 *          exchanges (`bybit`, `okx`, `bitget`, `kucoin`, `gateio`), with optional dry-run
 *          `forceShadow: true` or sandbox payload overrides.
 *       2. `action: 'promote_shadow'`: Promotes/demotes `PARTNER_KUCOIN_LIVE` or
 *          `PARTNER_GATEIO_LIVE` in `system_runtime_flags`. Promotion to `'true'` enforces
 *          a >= 30-day shadow history in `partner_shadow_reconciliations` with zero
 *          unresolved `SHADOW_DISCREPANCY` batches.
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import { isProductionOrStagingRuntime } from '@/lib/compliance/legacy-route-guards';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import type { R2BucketLike } from '@/lib/ledger';
import {
  isActivePartnerExchange,
  listPartnerPollerStatus,
  POLLABLE_PARTNER_EXCHANGES,
  runPartnerPollerCycle,
  SHADOW_PROMOTION_FLAG_KEYS,
  validateShadowPromotionGate,
  type ActivePartnerExchangeId,
  type ExchangePollerOverride,
} from '@/lib/partners';
import {
  persistRuntimeFlagWithAudit,
  RuntimeFlagAuditPersistenceError,
  type AtomicFlagAuditDatabase,
} from '@/lib/admin/runtime-flag-audit';

interface WorkerBindings {
  DB?: AuthD1Database;
  STORAGE?: R2BucketLike;
  env?: Record<string, string | undefined>;
}

interface PollerPostPayload {
  action?: 'run' | 'promote_shadow';
  exchanges?: string[];
  forceShadow?: boolean;
  overrides?: Partial<Record<ActivePartnerExchangeId, ExchangePollerOverride>>;
  exchange?: string;
  liveEnabled?: boolean;
  reason?: string;
  nowMs?: number;
}

export async function GET(request: NextRequest): Promise<Response> {
  const bindings = globalThis as unknown as WorkerBindings;
  const db = bindings.DB;
  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  try {
    const legacyDb = db as unknown as LegacyD1Database;
    const user = await getAuthenticatedUser(request, legacyDb);
    if (!user?.id) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHENTICATED', error: 'Authentication required' },
        { status: 401 }
      );
    }

    const profile = await db
      .prepare(`SELECT role FROM profiles WHERE id = ? LIMIT 1`)
      .bind(user.id)
      .first<{ role: string | null }>();

    if (!profile || (profile.role !== 'admin' && profile.role !== 'super_admin')) {
      return NextResponse.json(
        { success: false, code: 'FORBIDDEN_ROLE', error: 'Admin role required' },
        { status: 403 }
      );
    }

    const statusPayload = await listPartnerPollerStatus(db, bindings.env);
    return NextResponse.json(
      {
        success: true,
        ...statusPayload,
      },
      { status: 200 }
    );
  } catch (err) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const bindings = globalThis as unknown as WorkerBindings;
  const db = bindings.DB;
  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  try {
    const authz = await requireAdminWithPasskeyStepUp(
      request,
      db as unknown as LegacyD1Database,
      { purpose: 'admin_step_up' }
    );
    if (!authz.authorized) {
      return NextResponse.json(
        { success: false, code: authz.code, error: authz.error },
        { status: authz.status }
      );
    }

    let body: PollerPostPayload = {};
    const rawText = await request.text();
    if (rawText.trim().length > 0) {
      try {
        body = JSON.parse(rawText) as PollerPostPayload;
      } catch {
        return NextResponse.json(
          { success: false, code: 'INVALID_JSON', error: 'Malformed JSON request body' },
          { status: 400 }
        );
      }
    }

    const action = body.action ?? 'run';

    if (action === 'promote_shadow') {
      const targetExchange = (body.exchange ?? '').trim().toLowerCase();
      if (targetExchange !== 'kucoin' && targetExchange !== 'gateio') {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_SHADOW_EXCHANGE',
            error: 'Shadow promotion applies only to kucoin or gateio',
          },
          { status: 400 }
        );
      }
      if (typeof body.liveEnabled !== 'boolean') {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_LIVE_ENABLED',
            error: 'liveEnabled boolean is required',
          },
          { status: 400 }
        );
      }

      const flagKey = SHADOW_PROMOTION_FLAG_KEYS[targetExchange];
      const allowTestClockOverride =
        process.env.NODE_ENV === 'test' && !isProductionOrStagingRuntime();
      const evalNowMs =
        allowTestClockOverride && typeof body.nowMs === 'number' && Number.isFinite(body.nowMs)
          ? body.nowMs
          : Date.now();
      const nowIso = new Date(evalNowMs).toISOString();

      if (body.liveEnabled) {
        const gate = await validateShadowPromotionGate(db, targetExchange, evalNowMs);
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

      const reason =
        typeof body.reason === 'string' && body.reason.trim().length > 0
          ? body.reason.trim().slice(0, 500)
          : body.liveEnabled
            ? `Promoted ${targetExchange} to live after >=30d clean shadow audit`
            : `Demoted ${targetExchange} to shadow-only mode`;

      let auditId: string;
      try {
        const persisted = await persistRuntimeFlagWithAudit(
          db as unknown as AtomicFlagAuditDatabase,
          {
            flagKey,
            flagValue: body.liveEnabled ? 'true' : 'false',
            reason,
            updatedBy: authz.adminId ?? 'admin',
            source: '/api/admin/reconciliation/poller',
            updatedAtIso: nowIso,
            extraDetails: {
              exchange: targetExchange,
              action: 'promote_shadow',
            },
          }
        );
        auditId = persisted.auditId;
      } catch (err: unknown) {
        if (err instanceof RuntimeFlagAuditPersistenceError) {
          return NextResponse.json(
            {
              success: false,
              code: err.code,
              error: 'Shadow promotion flag update aborted because compliance audit persistence failed',
            },
            { status: 500 }
          );
        }
        throw err;
      }

      return NextResponse.json(
        {
          success: true,
          auditId,
          exchange: targetExchange,
          flagKey,
          liveEnabled: body.liveEnabled,
          updatedBy: authz.adminId,
          updatedAt: nowIso,
        },
        { status: 200 }
      );
    }

    if (action !== 'run') {
      return NextResponse.json(
        { success: false, code: 'UNKNOWN_ACTION', error: `Unsupported action: ${String(action)}` },
        { status: 400 }
      );
    }

    let selectedExchanges: readonly ActivePartnerExchangeId[] = POLLABLE_PARTNER_EXCHANGES;
    if (Array.isArray(body.exchanges) && body.exchanges.length > 0) {
      const validated: ActivePartnerExchangeId[] = [];
      for (const rawEx of body.exchanges) {
        const normalized = String(rawEx).trim().toLowerCase();
        if (!isActivePartnerExchange(normalized)) {
          return NextResponse.json(
            {
              success: false,
              code: 'INVALID_EXCHANGE',
              error: `Unsupported pollable exchange: '${String(rawEx)}'`,
            },
            { status: 400 }
          );
        }
        validated.push(normalized);
      }
      selectedExchanges = validated;
    }

    const hasOverrides = Boolean(
      body.overrides && Object.keys(body.overrides).length > 0
    );
    if (hasOverrides && isProductionOrStagingRuntime()) {
      return NextResponse.json(
        {
          success: false,
          code: 'OVERRIDES_FORBIDDEN_IN_PRODUCTION',
          error:
            'Manual poller payload/endpoint overrides are forbidden in staging and production environments',
        },
        { status: 403 }
      );
    }

    const isTestEnv =
      process.env.NODE_ENV === 'test' && !isProductionOrStagingRuntime();
    if (hasOverrides && !isTestEnv && !body.forceShadow) {
      return NextResponse.json(
        {
          success: false,
          code: 'OVERRIDES_REQUIRE_FORCE_SHADOW',
          error: 'Payload overrides in non-test environments require forceShadow: true',
        },
        { status: 400 }
      );
    }

    const cycleResult = await runPartnerPollerCycle({
      db,
      r2: bindings.STORAGE ?? null,
      env: bindings.env ?? {},
      triggerSource: 'admin_manual',
      exchanges: selectedExchanges,
      overrides: body.overrides,
      forceShadow: Boolean(body.forceShadow),
      nowMs:
        isTestEnv && typeof body.nowMs === 'number' && Number.isFinite(body.nowMs)
          ? body.nowMs
          : undefined,
    });

    return NextResponse.json(
      {
        success: true,
        ...cycleResult,
      },
      { status: 200 }
    );
  } catch (err) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
