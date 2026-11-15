/**
 * Passkey-Protected Partner Ingestion & CASH_COLLECTED Reconciliation Admin Route
 *
 * POST /api/admin/reconciliation/ingest
 *
 * Production entrypoint wiring together:
 * 1. Admin session + WebAuthn Passkey step-up (`requireAdminWithPasskeyStepUp`)
 * 2. Official Partner Ingestion Adapters (`Bybit v5`, `OKX v5 REST/CSV`, `Bitget v2`;
 *    `Binance Standard Referral Pro` hard-blocked; USD stablecoin `commissionAsset` allowlist)
 * 3. Pre-reconciliation `uidToProfileMap` AND clawback target batch validation (never burns a
 *    `MATCHED` reconciliation or writes R2 objects on unmapped UIDs or missing clawback targets)
 * 4. Fail-closed R2 Cryptographic Evidence Vault (`storeEvidenceObject` SHA-256 + 5y retention;
 *    returns `503 EVIDENCE_STORAGE_UNAVAILABLE` if `STORAGE` binding is absent)
 * 5. `CASH_COLLECTED` Reconciliation Gate (`reconcilePartnerCashBatch`, $0.01 tolerance,
 *    accounting for verified clawback offsets on mixed statements)
 * 6. Deterministic M2 Sybil/Self-Referral Graph Check (`M2SybilGraphEngine`)
 * 7. Atomic D1 Double-Entry Ledger `T+7` Inflight Minting + Clawback Adjustment (`DoubleEntryLedgerService`)
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
  IdempotencyConflictError,
  InvalidWaterfallConfigError,
  LedgerFrozenError,
  UnreconciledCashError,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  type R2BucketLike,
  type WaterfallConfig,
} from '@/lib/ledger';
import {
  getPartnerAdapter,
  PartnerIntegrationBlockedError,
  PartnerPayloadValidationError,
  type PartnerExchangeId,
} from '@/lib/partners';

interface WorkerBindings {
  DB?: AuthD1Database;
  STORAGE?: R2BucketLike;
}

interface UidProfileMapping {
  traderProfileId: string;
  l1AffiliateId?: string | null;
  b2bAgencyId?: string | null;
  waterfallConfig?: Partial<WaterfallConfig>;
  traderEmail?: string;
  referrerEmail?: string;
}

interface IngestRequestPayload {
  exchange?: string;
  statementPeriodStart?: string;
  statementPeriodEnd?: string;
  rawPartnerPayload?: string;
  rawWalletStatementPayload?: string;
  walletCashCollectedUsd?: string;
  uidToProfileMap?: Record<string, UidProfileMapping>;
  clawbackOriginalBatchMap?: Record<string, string>;
  recoverClawbackFromFutureInflight?: boolean;
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
    if (adapter.status === 'BLOCKED') {
      await adapter.parsePayload('');
    }

    // Fail closed if immutable R2 evidence storage is not bound in this Worker environment!
    const r2Bucket = bindings.STORAGE;
    if (!r2Bucket) {
      return NextResponse.json(
        {
          success: false,
          code: 'EVIDENCE_STORAGE_UNAVAILABLE',
          error:
            'Immutable R2 evidence vault binding (STORAGE) is required for partner reconciliation',
        },
        { status: 503 }
      );
    }

    if (
      !body.rawPartnerPayload ||
      !body.rawWalletStatementPayload ||
      !body.walletCashCollectedUsd ||
      !body.statementPeriodStart ||
      !body.statementPeriodEnd
    ) {
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

    // Pre-validate BOTH `uidToProfileMap` AND all clawback target batches BEFORE storing R2 evidence
    // or burning a unique `MATCHED` reconciliation row!
    const uidMap = body.uidToProfileMap ?? {};
    const clawbackMap = body.clawbackOriginalBatchMap ?? {};
    const ledger = new DoubleEntryLedgerService(db);

    const unmappedTraderUids = new Set<string>();
    const resolvedClawbacks = new Map<string, string>();
    const cumulativeClawbackPerBatch = new Map<string, bigint>();
    let positiveAllocatedSum = BigInt(0);
    let totalClawbackUnits = BigInt(0);

    for (const row of parsedBatch.rows) {
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BigInt(0)) {
        positiveAllocatedSum += row.signedUnits1e8;
        const mapped = uidMap[row.traderUid];
        if (!mapped || !mapped.traderProfileId || mapped.traderProfileId.trim() === '') {
          unmappedTraderUids.add(row.traderUid);
        }
        continue;
      }

      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BigInt(0)) {
        const clawbackUnits = -row.signedUnits1e8;
        totalClawbackUnits += clawbackUnits;

        let targetBatchId: string | undefined =
          clawbackMap[row.externalRecordId] ?? clawbackMap[row.traderUid];
        if (!targetBatchId) {
          const latestBatchRow = await db
            .prepare(
              `SELECT id FROM ledger_journal_batches
               WHERE exchange = ?
                 AND trader_uid = ?
                 AND journal_type = 'COMMISSION_INFLIGHT'
                 AND status IN ('INFLIGHT', 'SETTLED')
               ORDER BY created_at DESC
               LIMIT 1`
            )
            .bind(parsedBatch.exchange, row.traderUid)
            .first<{ id: string }>();
          targetBatchId = latestBatchRow?.id ?? undefined;
        }

        if (!targetBatchId) {
          return NextResponse.json(
            {
              success: false,
              code: 'CLAWBACK_TARGET_BATCH_NOT_FOUND',
              traderUid: row.traderUid,
              externalRecordId: row.externalRecordId,
              error: `Cannot locate original commission batch for clawback record '${row.externalRecordId}'`,
            },
            { status: 422 }
          );
        }

        const origBatch = await ledger.getBatchById(targetBatchId);
        if (
          !origBatch ||
          origBatch.journalType !== 'COMMISSION_INFLIGHT' ||
          origBatch.status === 'VOIDED' ||
          origBatch.exchange !== parsedBatch.exchange
        ) {
          return NextResponse.json(
            {
              success: false,
              code: 'INVALID_CLAWBACK_TARGET_BATCH',
              traderUid: row.traderUid,
              externalRecordId: row.externalRecordId,
              originalBatchId: targetBatchId,
              error: `Original commission batch '${targetBatchId}' is missing, voided, or from a different exchange`,
            },
            { status: 422 }
          );
        }

        const remLegs = origBatch.metadata.remainingLegs as
          | { grossUnits?: string }
          | undefined;
        const remainingGross = BigInt(String(remLegs?.grossUnits ?? '0'));
        const projectedBatchClawback =
          (cumulativeClawbackPerBatch.get(targetBatchId) ?? BigInt(0)) + clawbackUnits;
        if (projectedBatchClawback > remainingGross) {
          return NextResponse.json(
            {
              success: false,
              code: 'CLAWBACK_EXCEEDS_ORIGINAL_BATCH',
              originalBatchId: targetBatchId,
              error: `Clawback amount (${projectedBatchClawback.toString()}) exceeds remaining gross units (${remainingGross.toString()}) on batch '${targetBatchId}'`,
            },
            { status: 422 }
          );
        }

        cumulativeClawbackPerBatch.set(targetBatchId, projectedBatchClawback);
        resolvedClawbacks.set(row.externalRecordId, targetBatchId);
      }
    }

    if (unmappedTraderUids.size > 0) {
      return NextResponse.json(
        {
          success: false,
          code: 'UNMAPPED_TRADER_UIDS',
          unmappedUids: Array.from(unmappedTraderUids),
          error:
            'Every positive partner commission UID must map to a verified traderProfileId before reconciliation',
        },
        { status: 422 }
      );
    }

    const walletCashUnits = parseUsdToLedgerUnits(body.walletCashCollectedUsd);

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

    // Reconcile full gross positive commissions (`positiveAllocatedSum`) against net cash collected
    // (`walletCashUnits`) plus verified batch clawback deductions (`totalClawbackUnits`), so mixed
    // batches both verify `walletCashUnits + totalClawbackUnits ≈ positiveAllocatedSum` (< $0.01)
    // AND allow minting all `positiveAllocatedSum` commissions up to the atomic cap!
    const reconciliation = await reconcilePartnerCashBatch(db, {
      exchange: parsedBatch.exchange,
      evidenceId: partnerEvidence.id,
      walletEvidenceId: walletEvidence.id,
      uidAllocatedUnits: positiveAllocatedSum,
      walletCashCollectedUnits: walletCashUnits,
      clawbackOffsetUnits: totalClawbackUnits,
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

    const fraudEngine = new M2SybilGraphEngine();
    let mintedBatches = 0;
    let clawbackBatches = 0;
    let blockedByFraud = 0;

    for (const row of parsedBatch.rows) {
      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BigInt(0)) {
        const clawbackUnits = -row.signedUnits1e8;
        const resolvedOriginalBatchId = resolvedClawbacks.get(row.externalRecordId)!;

        await ledger.applyClawback({
          idempotencyKey: `ingest_clawback:${row.externalRecordId}`,
          originalBatchId: resolvedOriginalBatchId,
          clawbackUnits,
          reason: `Partner adjustment ${parsedBatch.exchange}:${row.externalRecordId}`,
          recoverFromFutureInflight: Boolean(body.recoverClawbackFromFutureInflight),
        });
        clawbackBatches += 1;
        continue;
      }

      if (row.signedUnits1e8 <= BigInt(0)) {
        continue;
      }

      const mapped = uidMap[row.traderUid]!;
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
        b2bAgencyId: mapped.b2bAgencyId ?? null,
        waterfallConfig: mapped.waterfallConfig,
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
        clawbackBatches,
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
    if (err instanceof PartnerPayloadValidationError || err instanceof UnreconciledCashError) {
      return sanitizeApiErrorResponse(err, 422, err.code);
    }
    if (err instanceof InvalidWaterfallConfigError) {
      return sanitizeApiErrorResponse(err, 422, 'INVALID_WATERFALL_CONFIG');
    }
    if (err instanceof IdempotencyConflictError) {
      return sanitizeApiErrorResponse(err, 409);
    }
    if (err instanceof LedgerFrozenError) {
      return sanitizeApiErrorResponse(err, 503);
    }
    return sanitizeApiErrorResponse(err, 500);
  }
}
