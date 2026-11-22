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
import {
  createFraudTelemetryBatchCache,
  loadAttributionFraudTelemetry,
  resolveUplineB2bAgencyOverride,
} from '@/lib/fraud/d1-fraud-telemetry';
import {
  M2SybilGraphEngine,
  type M2FraudEvaluationVerdict,
} from '@/lib/fraud/m2-sybil-graph-engine';
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
  findExistingLedgerIdempotencyKeys,
  getPartnerAdapter,
  PartnerIntegrationBlockedError,
  PartnerPayloadValidationError,
  resolveD1UidAttributions,
  resolveExchangeExecutionMode,
  runSingleExchangePoll,
  type ActivePartnerExchangeId,
  type PartnerExchangeId,
  type ResolvedUidAttribution,
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
  shadowMode?: boolean;
}

const VALID_EXCHANGES: readonly PartnerExchangeId[] = [
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
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

    const activeExchange = rawExchange as ActivePartnerExchangeId;
    const explicitResolvedUidMap: Record<string, ResolvedUidAttribution> = {};
    // UIDs whose B2B agency partner was pinned by the operator; these bypass the
    // D1 upline-agency override so a deliberate override is never silently replaced.
    const explicitB2bAgencyUids = new Set<string>();
    if (body.uidToProfileMap) {
      for (const [uid, m] of Object.entries(body.uidToProfileMap)) {
        if (m && m.traderProfileId && m.traderProfileId.trim() !== '') {
          explicitResolvedUidMap[uid] = {
            traderProfileId: m.traderProfileId,
            l1AffiliateId: m.l1AffiliateId ?? null,
            b2bAgencyId: m.b2bAgencyId ?? null,
            waterfallConfig: m.waterfallConfig,
            traderEmail: m.traderEmail,
            referrerEmail: m.referrerEmail,
          };
          if (m.b2bAgencyId && m.b2bAgencyId.trim() !== '') {
            explicitB2bAgencyUids.add(uid);
          }
        }
      }
    }

    // Enforce 30-day shadow gate for KuCoin & Gate.io (and explicit `shadowMode: true` dry runs)
    if (body.shadowMode === true) {
      const shadowRun = await runSingleExchangePoll({
        db,
        r2: r2Bucket,
        envBag: {},
        triggerSource: 'admin_manual',
        exchange: activeExchange,
        forceShadow: true,
        nowMs: Date.parse(body.statementPeriodEnd) || Date.now(),
        lookbackMs: Math.max(
          0,
          (Date.parse(body.statementPeriodEnd) || Date.now()) -
            (Date.parse(body.statementPeriodStart) || Date.now())
        ),
        override: {
          rawPartnerPayload: body.rawPartnerPayload,
          walletStatement: {
            rawWalletStatementPayload: body.rawWalletStatementPayload,
            walletCashCollectedUsd: body.walletCashCollectedUsd,
          },
          uidToProfileMap: explicitResolvedUidMap,
          startTimeMs: Date.parse(body.statementPeriodStart),
          endTimeMs: Date.parse(body.statementPeriodEnd),
        },
      });
      return NextResponse.json(
        {
          success: true,
          mode: 'SHADOW_ONLY',
          shadowReconciliationId: shadowRun.shadowReconciliationId,
          partnerEvidenceId: shadowRun.evidenceId,
          walletEvidenceId: shadowRun.walletEvidenceId,
          mintedBatches: 0,
          clawbackBatches: 0,
          blockedByFraud: 0,
          status: shadowRun.status,
        },
        { status: 200 }
      );
    }

    if (adapter.status === 'SHADOW_ONLY') {
      const modeDecision = await resolveExchangeExecutionMode(db, activeExchange);
      if (modeDecision.mode === 'SHADOW_ONLY') {
        return NextResponse.json(
          {
            success: false,
            code: 'SHADOW_MODE_PROMOTION_REQUIRED',
            exchange: activeExchange,
            error: `Partner exchange '${activeExchange}' is in mandatory 30-day shadow reconciliation mode; promote PARTNER_${activeExchange.toUpperCase()}_LIVE to 'true' after clean shadow audit or pass shadowMode: true`,
          },
          { status: 403 }
        );
      }
    }

    const parsedBatch = await adapter.parsePayload(body.rawPartnerPayload, {
      periodEndIso: body.statementPeriodEnd,
    });

    // Pre-validate BOTH `uidToProfileMap` (merged with D1 `trader_exchange_uids`) AND all clawback
    // target batches BEFORE storing R2 evidence or burning a unique `MATCHED` reconciliation row!
    const resolvedUidMap = await resolveD1UidAttributions(
      db,
      parsedBatch.exchange,
      parsedBatch.rows,
      explicitResolvedUidMap
    );
    const clawbackMap = body.clawbackOriginalBatchMap ?? {};
    const ledger = new DoubleEntryLedgerService(db);

    const ledgerKeysByExternalRecord = new Map<string, string[]>();
    for (const row of parsedBatch.rows) {
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BigInt(0)) {
        ledgerKeysByExternalRecord.set(row.externalRecordId, [
          `ingest:${row.externalRecordId}`,
        ]);
      } else if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BigInt(0)) {
        ledgerKeysByExternalRecord.set(row.externalRecordId, [
          `ingest_clawback:${row.externalRecordId}`,
          `poller_void:${row.externalRecordId}`,
          `poller_post:${row.externalRecordId}`,
          `ingest_void:${row.externalRecordId}`,
          `ingest_post:${row.externalRecordId}`,
        ]);
      }
    }
    const existingLedgerKeys = await findExistingLedgerIdempotencyKeys(
      db,
      Array.from(ledgerKeysByExternalRecord.values()).flat()
    );
    const isRowAlreadyApplied = (externalRecordId: string): boolean =>
      (ledgerKeysByExternalRecord.get(externalRecordId) ?? []).some((key) =>
        existingLedgerKeys.has(key)
      );

    const unmappedTraderUids = new Set<string>();
    const resolvedClawbacks = new Map<string, string>();
    const cumulativeClawbackPerBatch = new Map<string, bigint>();
    let positiveAllocatedSum = BigInt(0);
    let totalClawbackUnits = BigInt(0);

    for (const row of parsedBatch.rows) {
      if (!row.isClawbackOrAdjustment && row.signedUnits1e8 > BigInt(0)) {
        const mapped = resolvedUidMap.get(row.traderUid);
        if (!mapped || !mapped.traderProfileId || mapped.traderProfileId.trim() === '') {
          unmappedTraderUids.add(row.traderUid);
        }
        if (!isRowAlreadyApplied(row.externalRecordId)) {
          positiveAllocatedSum += row.signedUnits1e8;
        }
        continue;
      }

      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BigInt(0)) {
        const alreadyApplied = isRowAlreadyApplied(row.externalRecordId);
        const clawbackUnits = -row.signedUnits1e8;
        if (!alreadyApplied) {
          totalClawbackUnits += clawbackUnits;
        }

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

        if (alreadyApplied) {
          if (targetBatchId) {
            resolvedClawbacks.set(row.externalRecordId, targetBatchId);
          }
          continue;
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

    const allRowsAlreadyApplied =
      parsedBatch.rows.length > 0 &&
      positiveAllocatedSum === BigInt(0) &&
      totalClawbackUnits === BigInt(0);

    // Reconcile full gross positive commissions (`positiveAllocatedSum`) against net cash collected
    // (`walletCashUnits`) plus verified batch clawback deductions (`totalClawbackUnits`), so mixed
    // batches both verify `walletCashUnits + totalClawbackUnits ≈ positiveAllocatedSum` (< $0.01)
    // AND allow minting all `positiveAllocatedSum` commissions up to the atomic cap!
    const reconciliation = allRowsAlreadyApplied
      ? null
      : await reconcilePartnerCashBatch(db, {
          exchange: parsedBatch.exchange,
          evidenceId: partnerEvidence.id,
          walletEvidenceId: walletEvidence.id,
          uidAllocatedUnits: positiveAllocatedSum,
          walletCashCollectedUnits: walletCashUnits,
          clawbackOffsetUnits: totalClawbackUnits,
          r2: r2Bucket,
        });

    if (reconciliation && reconciliation.status !== 'MATCHED') {
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
    const telemetryCache = createFraudTelemetryBatchCache();
    const fraudVerdicts = new Map<string, Promise<M2FraudEvaluationVerdict>>();
    const evaluateAttribution = (
      traderId: string,
      referrerId: string,
      evaluate: () => Promise<M2FraudEvaluationVerdict>
    ): Promise<M2FraudEvaluationVerdict> => {
      const key = `${traderId.trim()}\u0000${referrerId.trim()}`;
      const existing = fraudVerdicts.get(key);
      if (existing) return existing;
      const pending = evaluate();
      fraudVerdicts.set(key, pending);
      void pending.catch(() => fraudVerdicts.delete(key));
      return pending;
    };
    // The request carries the ADMIN OPERATOR's IP, never the trader's or referrer's.
    // Pass requestIp: null into attribution fraud telemetry so operator IP never pollutes Sybil checks.
    let mintedBatches = 0;
    let clawbackBatches = 0;
    let blockedByFraud = 0;
    let replayReconciliationId: string | null = null;

    for (const row of parsedBatch.rows) {
      const alreadyApplied = isRowAlreadyApplied(row.externalRecordId);
      if (row.isClawbackOrAdjustment && row.signedUnits1e8 < BigInt(0)) {
        const clawbackUnits = -row.signedUnits1e8;
        const resolvedOriginalBatchId = resolvedClawbacks.get(row.externalRecordId);
        if (!resolvedOriginalBatchId) {
          continue;
        }

        const clawbackResult = await ledger.applyClawback({
          idempotencyKey: `ingest_clawback:${row.externalRecordId}`,
          originalBatchId: resolvedOriginalBatchId,
          clawbackUnits,
          reason: `Partner adjustment ${parsedBatch.exchange}:${row.externalRecordId}`,
          recoverFromFutureInflight: Boolean(body.recoverClawbackFromFutureInflight),
        });
        if (!clawbackResult.isReplay && !alreadyApplied) {
          clawbackBatches += 1;
        }
        continue;
      }

      if (row.signedUnits1e8 <= BigInt(0)) {
        continue;
      }

      const mapped = resolvedUidMap.get(row.traderUid)!;
      const explicitB2bAgencyId = explicitB2bAgencyUids.has(row.traderUid)
        ? (mapped.b2bAgencyId ?? null)
        : null;
      let effectiveL1AffiliateId = mapped.l1AffiliateId ?? null;
      let waterfallConfig = mapped.waterfallConfig;

      // Resolve the provisioned upline B2B agency override when the operator did not pin
      // one explicitly, so the L2 spread leg is only paid to a real agency partner.
      let effectiveB2bAgencyId = explicitB2bAgencyId;
      if (!effectiveB2bAgencyId && effectiveL1AffiliateId) {
        const agencyOverride = await resolveUplineB2bAgencyOverride(
          db,
          effectiveL1AffiliateId,
          telemetryCache
        );
        if (agencyOverride) {
          effectiveB2bAgencyId = agencyOverride.b2bAgencyId;
          waterfallConfig = {
            ...waterfallConfig,
            tier2ShareOfSpread:
              waterfallConfig?.tier2ShareOfSpread ??
              agencyOverride.defaultTier2ShareOfSpread,
          };
        }
      }

      if (effectiveL1AffiliateId) {
        const l1AffiliateId = effectiveL1AffiliateId;
        const fraudVerdict = await evaluateAttribution(
          mapped.traderProfileId,
          l1AffiliateId,
          async () => {
            const telemetry = await loadAttributionFraudTelemetry(
              db,
              {
                traderId: mapped.traderProfileId,
                referrerId: l1AffiliateId,
                traderEmail: mapped.traderEmail,
                referrerEmail: mapped.referrerEmail,
                requestIp: null,
              },
              telemetryCache
            );
            return fraudEngine.evaluate(
              db as unknown as LegacyD1Database,
              {
                eventType: 'referral_attribution',
                traderId: mapped.traderProfileId,
                referrerId: l1AffiliateId,
                traderEmail: telemetry.traderEmail,
                referrerEmail: telemetry.referrerEmail,
                traderIpHash: telemetry.traderIpHash,
                referrerIpHash: telemetry.referrerIpHash,
                traderDeviceHash: telemetry.traderDeviceHash,
                referrerDeviceHash: telemetry.referrerDeviceHash,
                signupDeltaMinutes: telemetry.signupDeltaMinutes,
                sameDeviceRecentSignups10m: telemetry.sameDeviceRecentSignups10m,
                subSecondClickBurstCount: telemetry.subSecondClickBurstCount,
              }
            );
          }
        );
        if (!fraudVerdict.allowed) {
          effectiveL1AffiliateId = null;
          // The L2 leg is paid through the L1 upline chain; a blocked L1 cannot
          // pass an override through to its own upstream agency.
          effectiveB2bAgencyId = null;
          if (!alreadyApplied) {
            blockedByFraud += 1;
          }
        }
      }

      if (effectiveB2bAgencyId) {
        const b2bAgencyId = effectiveB2bAgencyId;
        const agencyVerdict = await evaluateAttribution(
          mapped.traderProfileId,
          b2bAgencyId,
          async () => {
            const agencyTelemetry = await loadAttributionFraudTelemetry(
              db,
              {
                traderId: mapped.traderProfileId,
                referrerId: b2bAgencyId,
                traderEmail: mapped.traderEmail,
                referrerEmail: undefined,
                requestIp: null,
              },
              telemetryCache
            );
            return fraudEngine.evaluate(
              db as unknown as LegacyD1Database,
              {
                eventType: 'referral_attribution',
                traderId: mapped.traderProfileId,
                referrerId: b2bAgencyId,
                traderEmail: agencyTelemetry.traderEmail,
                referrerEmail: agencyTelemetry.referrerEmail,
                traderIpHash: agencyTelemetry.traderIpHash,
                referrerIpHash: agencyTelemetry.referrerIpHash,
                traderDeviceHash: agencyTelemetry.traderDeviceHash,
                referrerDeviceHash: agencyTelemetry.referrerDeviceHash,
                signupDeltaMinutes: agencyTelemetry.signupDeltaMinutes,
                sameDeviceRecentSignups10m: agencyTelemetry.sameDeviceRecentSignups10m,
                subSecondClickBurstCount: agencyTelemetry.subSecondClickBurstCount,
              }
            );
          }
        );
        if (!agencyVerdict.allowed) {
          effectiveB2bAgencyId = null;
          if (!alreadyApplied) {
            blockedByFraud += 1;
          }
        }
      }

      const mintResult = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: `ingest:${row.externalRecordId}`,
        exchange: parsedBatch.exchange,
        traderUid: row.traderUid,
        traderId: mapped.traderProfileId,
        l1AffiliateId: effectiveL1AffiliateId,
        b2bAgencyId: effectiveB2bAgencyId,
        waterfallConfig,
        reconciliationId: reconciliation?.id ?? `recon_replay_${row.externalRecordId}`,
        evidenceId: partnerEvidence.id,
        grossCommissionUnits: row.signedUnits1e8,
        r2: r2Bucket,
      });
      if (!mintResult.isReplay && !alreadyApplied) {
        mintedBatches += 1;
      } else if (!replayReconciliationId) {
        replayReconciliationId = mintResult.batch.reconciliationId;
      }

      if (mapped.uidRecordId && mapped.verificationStatus === 'PENDING_FIRST_TRADE') {
        const verifiedIso = new Date().toISOString();
        try {
          await db
            .prepare(
              `UPDATE trader_exchange_uids
               SET verification_status = 'VERIFIED_BY_PARTNER',
                   verified_at = COALESCE(verified_at, ?),
                   updated_at = ?
               WHERE id = ? AND verification_status = 'PENDING_FIRST_TRADE'`
            )
            .bind(verifiedIso, verifiedIso, mapped.uidRecordId)
            .run();
        } catch {
          // Non-fatal metadata promotion
        }
      }
    }

    return NextResponse.json(
      {
        success: true,
        reconciliationId: reconciliation?.id ?? replayReconciliationId,
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
