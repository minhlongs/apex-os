/**
 * Passkey-Protected Partner Ingestion & CASH_COLLECTED Reconciliation Admin Route
 *
 * POST /api/admin/reconciliation/ingest
 *
 * Production entrypoint wiring together:
 * 1. Admin session + WebAuthn Passkey step-up (`requireAdminWithPasskeyStepUp`)
 * 2. Official Partner Ingestion Adapters (`Bybit v5`, `OKX v5 REST/CSV`, `Bitget v2`;
 *    `Binance Standard Referral Pro` hard-blocked)
 * 3. Pre-reconciliation `uidToProfileMap` completeness check (never burns a `MATCHED`
 *    reconciliation batch on unmapped trader UIDs)
 * 4. Fail-closed R2 Cryptographic Evidence Vault (`storeEvidenceObject` SHA-256 + 5y retention;
 *    returns `503 EVIDENCE_STORAGE_UNCONFIGURED` if `STORAGE` binding is absent)
 * 5. `CASH_COLLECTED` Reconciliation Gate (`reconcilePartnerCashBatch`, $0.01 tolerance)
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
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  type R2BucketLike,
  type WaterfallConfig,
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

    // Pre-validate UID mappings BEFORE storing evidence or burning a unique MATCHED reconciliation!
    const uidMap = body.uidToProfileMap ?? {};
    const unmappedTraderUids = new Set<string>();
    let netBatchUnits = BigInt(0);
    let positiveAllocatedSum = BigInt(0);

    for (const row of parsedBatch.rows) {
      netBatchUnits += row.signedUnits1e8;
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BigInt(0)) {
        positiveAllocatedSum += row.signedUnits1e8;
        const mapped = uidMap[row.traderUid];
        if (!mapped || !mapped.traderProfileId || mapped.traderProfileId.trim() === '') {
          unmappedTraderUids.add(row.traderUid);
        }
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

    const expectedCashUnits = netBatchUnits > BigInt(0) ? netBatchUnits : BigInt(0);
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

    const reconciliationAllocatedUnits =
      netBatchUnits === positiveAllocatedSum ? positiveAllocatedSum : expectedCashUnits;

    const reconciliation = await reconcilePartnerCashBatch(db, {
      exchange: parsedBatch.exchange,
      evidenceId: partnerEvidence.id,
      walletEvidenceId: walletEvidence.id,
      uidAllocatedUnits: reconciliationAllocatedUnits,
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
    const clawbackMap = body.clawbackOriginalBatchMap ?? {};

    let mintedBatches = 0;
    let clawbackBatches = 0;
    let blockedByFraud = 0;

    for (const row of parsedBatch.rows) {
      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BigInt(0)) {
        const clawbackUnits = -row.signedUnits1e8;
        let originalBatchId: string | undefined =
          clawbackMap[row.externalRecordId] ?? clawbackMap[row.traderUid];
        if (!originalBatchId) {
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
          originalBatchId = latestBatchRow?.id ?? undefined;
        }
        if (!originalBatchId) {
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

        const resolvedOriginalBatchId: string = originalBatchId;
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
    if (err instanceof InvalidWaterfallConfigError) {
      return sanitizeApiErrorResponse(err, 422);
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
