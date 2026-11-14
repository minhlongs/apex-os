/**
 * Passkey-Protected Partner Ingestion & CASH_COLLECTED Reconciliation Admin Route
 *
 * POST /api/admin/reconciliation/ingest
 *
 * Production entrypoint wiring together:
 * 1. Admin session + WebAuthn Passkey step-up (`requireAdminWithPasskeyStepUp`)
 * 2. Official Partner Ingestion Adapters (`Bybit v5`, `OKX v5 REST/CSV`, `Bitget v2`;
 *    `Binance Standard Referral Pro` hard-blocked)
 * 3. R2 Cryptographic Evidence Vault (`storeEvidenceObject` SHA-256 + 5y retention)
 * 4. `CASH_COLLECTED` Reconciliation Gate (`reconcilePartnerCashBatch`, $0.01 tolerance)
 * 5. Deterministic M2 Sybil/Self-Referral Graph Check (`M2SybilGraphEngine`)
 * 6. Atomic D1 Double-Entry Ledger `T+7` Inflight Minting (`DoubleEntryLedgerService`)
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import { M2SybilGraphEngine } from '@/lib/fraud/m2-sybil-graph-engine';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  type R2BucketLike,
} from '@/lib/ledger';
import {
  getPartnerAdapter,
  PartnerIntegrationBlockedError,
  type PartnerExchangeId,
} from '@/lib/partners';

interface WorkerBindings {
  DB?: AuthD1Database;
  STORAGE?: R2BucketLike;
}

interface IngestRequestPayload {
  exchange?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  rawPartnerPayload?: string;
  rawWalletStatementPayload?: string;
  walletCashCollectedUsd?: string;
  uidToProfileMap?: Record<
    string,
    {
      traderProfileId: string;
      l1AffiliateId?: string | null;
      traderEmail?: string;
      referrerEmail?: string;
    }
  >;
}

const VALID_EXCHANGES: readonly PartnerExchangeId[] = [
  'bybit',
  'okx',
  'bitget',
  'binance_referral_pro',
];

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

    const body = (await request.json()) as IngestRequestPayload;
    const rawExchange = (body.exchange ?? '').trim().toLowerCase() as PartnerExchangeId;
    if (!VALID_EXCHANGES.includes(rawExchange)) {
      return NextResponse.json(
        { success: false, code: 'INVALID_EXCHANGE', error: 'Unsupported partner exchange' },
        { status: 400 }
      );
    }

    const adapter = getPartnerAdapter(rawExchange);
    if (
      !body.rawPartnerPayload ||
      !body.rawWalletStatementPayload ||
      !body.walletCashCollectedUsd ||
      !body.statementPeriodStart ||
      !body.statementPeriodEnd
    ) {
      if (adapter.status === 'BLOCKED') {
        await adapter.parsePayload('');
      }
      return NextResponse.json(
        {
          success: false,
          code: 'MISSING_INGESTION_FIELDS',
          error:
            'rawPartnerPayload, rawWalletStatementPayload, walletCashCollectedUsd, statementPeriodStart, and statementPeriodEnd are required',
        },
        { status: 400 }
      );
    }

    const parsedBatch = await adapter.parsePayload(body.rawPartnerPayload, {
      periodEndIso: body.statementPeriodEnd,
    });

    const r2Bucket = bindings.STORAGE ?? new InMemoryR2Bucket();
    const partnerEvidence = await storeEvidenceObject(db, r2Bucket, {
      exchange: parsedBatch.exchange,
      sourceKind: parsedBatch.evidence.sourceKind,
      rawBytes: body.rawPartnerPayload,
      statementPeriodStart: body.statementPeriodStart,
      statementPeriodEnd: body.statementPeriodEnd,
    });
    const walletEvidence = await storeEvidenceObject(db, r2Bucket, {
      exchange: parsedBatch.exchange,
      sourceKind: 'wallet_statement',
      rawBytes: body.rawWalletStatementPayload,
      statementPeriodStart: body.statementPeriodStart,
      statementPeriodEnd: body.statementPeriodEnd,
    });

    let positiveAllocatedSum = BigInt(0);
    for (const row of parsedBatch.rows) {
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BigInt(0)) {
        positiveAllocatedSum += row.signedUnits1e8;
      }
    }

    const walletCashUnits = parseUsdToLedgerUnits(body.walletCashCollectedUsd);
    const reconciliation = await reconcilePartnerCashBatch(db, {
      exchange: parsedBatch.exchange,
      evidenceId: partnerEvidence.id,
      walletEvidenceId: walletEvidence.id,
      uidAllocatedUnits: positiveAllocatedSum,
      walletCashCollectedUnits: walletCashUnits,
      r2: r2Bucket,
    });

    if (reconciliation.status !== 'MATCHED') {
      return NextResponse.json(
        {
          success: false,
          code: 'RECONCILIATION_DISCREPANCY_HALTED',
          reconciliationId: reconciliation.id,
          status: reconciliation.status,
          discrepancyUnits: reconciliation.discrepancyUnits.toString(),
        },
        { status: 409 }
      );
    }

    const ledger = new DoubleEntryLedgerService(db);
    const fraudEngine = new M2SybilGraphEngine();
    const uidMap = body.uidToProfileMap ?? {};

    let mintedBatches = 0;
    let blockedByFraud = 0;

    for (const row of parsedBatch.rows) {
      if (row.isClawbackOrAdjustment || row.signedUnits1e8 <= BigInt(0)) {
        continue;
      }
      const mapped = uidMap[row.traderUid];
      if (!mapped?.traderProfileId) {
        continue;
      }

      let effectiveL1AffiliateId = mapped.l1AffiliateId ?? null;
      if (effectiveL1AffiliateId) {
        const fraudVerdict = await fraudEngine.evaluate(
          db as unknown as LegacyD1Database,
          {
            eventType: 'referral_attribution',
            traderId: mapped.traderProfileId,
            referrerId: effectiveL1AffiliateId,
            traderEmail: mapped.traderEmail,
            referrerEmail: mapped.referrerEmail,
          }
        );
        if (!fraudVerdict.allowed) {
          effectiveL1AffiliateId = null;
          blockedByFraud += 1;
        }
      }

      await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: `ingest:${row.externalRecordId}`,
        exchange: parsedBatch.exchange,
        traderUid: row.traderUid,
        traderId: mapped.traderProfileId,
        l1AffiliateId: effectiveL1AffiliateId,
        reconciliationId: reconciliation.id,
        evidenceId: partnerEvidence.id,
        grossCommissionUnits: row.signedUnits1e8,
        r2: r2Bucket,
      });
      mintedBatches += 1;
    }

    return NextResponse.json(
      {
        success: true,
        reconciliationId: reconciliation.id,
        partnerEvidenceSha256: partnerEvidence.payloadSha256,
        walletEvidenceSha256: walletEvidence.payloadSha256,
        mintedBatches,
        blockedByFraud,
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof PartnerIntegrationBlockedError) {
      return NextResponse.json(
        {
          success: false,
          code: err.code,
          exchange: err.exchange,
          error: err.message,
        },
        { status: 403 }
      );
    }
    return sanitizeApiErrorResponse(err, 500);
  }
}
