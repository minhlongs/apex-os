/**
 * Legacy Route Boundary Guards ("Fourth Door" Closure)
 *
 * Ensures legacy pre-audit API routes cannot bypass Phase 1 Viability Audit controls
 * when running in production/staging or against a D1 database migrated to `028_ascendancy_audit_core.sql`:
 * - 48-hour wallet-change timelock & Phase 1 chain gate (`stellar`, `arbitrum`, `base`)
 * - WebAuthn Passkey step-up & deprecation of raw-key `BatchSettlementService` execution
 *   in favor of Turnkey HSM + `DoubleEntryLedgerService` (`POST /api/admin/settlement/dispatch`)
 * - Gate G2 `CASH_COLLECTED` reconciliation gate + Decree `40/2018/NĐ-CP` 1-tier lock
 *   (blocking unreconciled 3-tier webhook `earnings` minting and enforcing D1 replay nonces)
 */

import { NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import type { D1Database } from '@/lib/db';
import { requireAdminWithPasskeyStepUp } from '@/lib/auth/passkey-step-up';
import { verifyAndGuardWebhook } from '@/lib/webhooks/strict-webhook-guard';

export function isProductionOrStagingRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const appEnv = process.env.APP_ENV?.trim().toLowerCase();
  return (
    nodeEnv === 'production' ||
    appEnv === 'production' ||
    appEnv === 'staging' ||
    process.env.ENFORCE_ASCENDANCY_GUARDS === 'true'
  );
}

export async function hasD1Table(
  db: D1Database | null | undefined,
  tableName: string
): Promise<boolean> {
  if (!db) {
    return false;
  }
  try {
    const row = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1"
      )
      .bind(tableName)
      .first<{ name?: string }>();
    return row?.name === tableName;
  } catch {
    return false;
  }
}

export async function isAscendancyGuardActive(
  db: D1Database | null | undefined,
  sentinelTable: string
): Promise<boolean> {
  if (isProductionOrStagingRuntime()) {
    return true;
  }
  return hasD1Table(db, sentinelTable);
}

/**
 * Guards legacy admin payout execution endpoints (`/api/payouts`, `/api/admin/payouts/batch` execute,
 * `/api/admin/payouts/retry`) when Ascendancy controls are active:
 * 1. Verifies Admin session + WebAuthn Passkey step-up (`401` / `403 PASSKEY_STEP_UP_REQUIRED`).
 * 2. Refuses legacy raw-key `BatchSettlementService` payouts with `409 LEGACY_PAYOUT_ROUTE_DISABLED`,
 *    directing callers to `POST /api/admin/settlement/dispatch` (Turnkey HSM + Double-Entry Ledger).
 */
export async function guardLegacyAdminPayoutMutation(
  request: Request,
  db: D1Database | null | undefined
): Promise<NextResponse | null> {
  const active = await isAscendancyGuardActive(db, 'webauthn_challenges');
  if (!active) {
    return null;
  }
  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  const stepUp = await requireAdminWithPasskeyStepUp(request, db, {
    purpose: 'admin_step_up',
  });
  if (!stepUp.authorized) {
    return NextResponse.json(
      {
        success: false,
        code: stepUp.code,
        error: stepUp.error,
      },
      { status: stepUp.status }
    );
  }

  return NextResponse.json(
    {
      success: false,
      code: 'LEGACY_PAYOUT_ROUTE_DISABLED',
      error:
        'Legacy raw-key payout execution is disabled; use POST /api/admin/settlement/dispatch (Turnkey HSM + Double-Entry Ledger)',
    },
    { status: 409 }
  );
}

/**
 * Enforces Gate G4 `verifyAndGuardWebhook` (D1 `webhook_nonces` + constant-time HMAC + 300s window)
 * and Gate G2 `ENQUEUED_FOR_RECONCILIATION_ONLY` (`autoPayoutTriggered = false`, 0 unreconciled
 * 3-tier `earnings` rows minted before `CASH_COLLECTED`) on legacy `/api/webhooks/exchange/*` routes
 * when Ascendancy controls are active.
 */
export async function guardLegacyExchangeWebhook(params: {
  db: D1Database | null | undefined;
  source: 'binance' | 'bybit' | 'okx' | 'kucoin';
  eventId: string;
  timestamp: string | null | undefined;
  signature: string | null | undefined;
  rawBody: string;
  secret: string | undefined;
  requestPath?: string;
}): Promise<NextResponse | null> {
  const active = await isAscendancyGuardActive(params.db, 'partner_cash_reconciliations');
  if (!active) {
    return null;
  }
  if (!params.db) {
    return NextResponse.json(
      { success: false, code: 'DATABASE_UNAVAILABLE', error: 'Database unavailable' },
      { status: 503 }
    );
  }

  const canonicalFormat =
    params.source === 'binance'
      ? 'raw_body'
      : params.source === 'bybit'
        ? 'bybit'
        : 'okx';

  const guardResult = await verifyAndGuardWebhook({
    db: params.db as unknown as AuthD1Database,
    source: params.source,
    eventId: params.eventId,
    timestamp: params.timestamp,
    signature: params.signature,
    rawBody: params.rawBody,
    secret: params.secret ?? '',
    canonicalFormat,
    method: 'POST',
    requestPath: params.requestPath,
  });

  if (!guardResult.verified) {
    return NextResponse.json(
      {
        success: false,
        code: guardResult.errorCode,
        error: guardResult.errorMessage,
        autoPayoutTriggered: false,
      },
      { status: guardResult.statusCode }
    );
  }

  return NextResponse.json(
    {
      success: true,
      action: guardResult.action,
      autoPayoutTriggered: false,
      source: guardResult.source,
      eventId: guardResult.eventId,
      payloadSha256: guardResult.payloadSha256,
    },
    { status: 202 }
  );
}
