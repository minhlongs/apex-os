/**
 * CASH_COLLECTED Partner Reconciliation Gate
 *
 * Reconciles the sum of UID-attributed partner commission rows (`uidAllocatedUnits`)
 * against the exchange broker/funding wallet credit statement (`walletCashCollectedUnits`),
 * anchored to two distinct R2 SHA-256 evidence objects (`evidence_id` and `wallet_evidence_id`).
 *
 * Invariant (Gate G2 & G9):
 * - If `uidAllocatedUnits > walletCashCollectedUnits` OR
 *   `abs(uidAllocatedUnits - walletCashCollectedUnits) >= 1,000,000` (`$0.01 USDC`),
 *   status is recorded as `'DISCREPANCY_HALTED'` and NO ledger postings can be minted.
 * - No user/affiliate balance can ever be credited without a `'MATCHED'` reconciliation
 *   backed by verified R2 evidence objects, and cumulative minted commissions against a
 *   reconciliation record cannot exceed its `uid_allocated_units` or `wallet_cash_collected_units`.
 */

import type { D1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  assertEvidenceIntegrity,
  getEvidenceObjectById,
  isSupportedPartnerExchange,
  type R2BucketLike,
  type SupportedPartnerExchange,
} from './evidence-vault';
import {
  BI_ZERO,
  RECONCILIATION_TOLERANCE_UNITS_1E8,
  fromSqlInteger,
  LedgerUnitValidationError,
  toSafeSqlInteger,
} from './units';

export type ReconciliationStatus =
  | 'MATCHED'
  | 'DISCREPANCY_HALTED'
  | 'CLAWBACK_ADJUSTED';

export interface ReconciliationInput {
  id?: string;
  exchange: SupportedPartnerExchange;
  evidenceId: string;
  walletEvidenceId: string;
  uidAllocatedUnits: bigint;
  walletCashCollectedUnits: bigint;
  clawbackOffsetUnits?: bigint;
  reconciledAt?: string;
  r2?: R2BucketLike;
}

export interface ReconciliationRecord {
  id: string;
  exchange: SupportedPartnerExchange;
  evidenceId: string;
  walletEvidenceId: string | null;
  uidAllocatedUnits: bigint;
  walletCashCollectedUnits: bigint;
  clawbackOffsetUnits: bigint;
  mintedGrossUnits: bigint;
  discrepancyUnits: bigint;
  status: ReconciliationStatus;
  reconciledAt: string;
}

export class UnreconciledCashError extends Error {
  public readonly statusCode = 422;
  public readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UnreconciledCashError';
    this.code = code;
  }
}

interface RawReconciliationRow {
  id: string;
  exchange: SupportedPartnerExchange;
  evidence_id: string;
  wallet_evidence_id: string | null;
  uid_allocated_units: number;
  wallet_cash_collected_units: number;
  clawback_offset_units?: number | null;
  minted_gross_units?: number | null;
  discrepancy_units: number;
  status: ReconciliationStatus;
  reconciled_at: string;
}

function mapReconciliationRow(row: RawReconciliationRow): ReconciliationRecord {
  return {
    id: row.id,
    exchange: row.exchange,
    evidenceId: row.evidence_id,
    walletEvidenceId: row.wallet_evidence_id,
    uidAllocatedUnits: fromSqlInteger(row.uid_allocated_units, 'uid_allocated_units'),
    walletCashCollectedUnits: fromSqlInteger(
      row.wallet_cash_collected_units,
      'wallet_cash_collected_units'
    ),
    clawbackOffsetUnits: fromSqlInteger(
      row.clawback_offset_units ?? 0,
      'clawback_offset_units'
    ),
    mintedGrossUnits: fromSqlInteger(row.minted_gross_units ?? 0, 'minted_gross_units'),
    discrepancyUnits: fromSqlInteger(row.discrepancy_units, 'discrepancy_units'),
    status: row.status,
    reconciledAt: row.reconciled_at,
  };
}

/**
 * Compute absolute difference between two `bigint` unit amounts.
 */
export function absBigIntDiff(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/**
 * Evaluate whether `uidAllocatedUnits` vs `walletCashCollectedUnits` passes
 * the CASH_COLLECTED gate (`uidAllocated <= walletCashCollected` AND `diff < $0.01`).
 */
export function evaluateCashReconciliation(
  uidAllocatedUnits: bigint,
  walletCashCollectedUnits: bigint,
  clawbackOffsetUnits: bigint = BI_ZERO
): { status: 'MATCHED' | 'DISCREPANCY_HALTED'; discrepancyUnits: bigint } {
  if (typeof uidAllocatedUnits !== 'bigint' || uidAllocatedUnits < BI_ZERO) {
    throw new LedgerUnitValidationError('uidAllocatedUnits must be a non-negative bigint');
  }
  if (typeof walletCashCollectedUnits !== 'bigint' || walletCashCollectedUnits < BI_ZERO) {
    throw new LedgerUnitValidationError(
      'walletCashCollectedUnits must be a non-negative bigint'
    );
  }
  if (typeof clawbackOffsetUnits !== 'bigint' || clawbackOffsetUnits < BI_ZERO) {
    throw new LedgerUnitValidationError('clawbackOffsetUnits must be a non-negative bigint');
  }

  const effectiveBackedUnits = walletCashCollectedUnits + clawbackOffsetUnits;
  const discrepancyUnits = absBigIntDiff(uidAllocatedUnits, effectiveBackedUnits);

  if (
    uidAllocatedUnits > effectiveBackedUnits ||
    discrepancyUnits >= RECONCILIATION_TOLERANCE_UNITS_1E8
  ) {
    return {
      status: 'DISCREPANCY_HALTED',
      discrepancyUnits,
    };
  }

  return {
    status: 'MATCHED',
    discrepancyUnits,
  };
}

/**
 * Reconcile a partner commission statement against the exchange wallet credit
 * statement and persist the audit record in `partner_cash_reconciliations`.
 */
export async function reconcilePartnerCashBatch(
  db: D1Database,
  input: ReconciliationInput
): Promise<ReconciliationRecord> {
  if (!isSupportedPartnerExchange(input.exchange)) {
    throw new UnreconciledCashError(
      'INVALID_EXCHANGE',
      `Unsupported exchange "${String(input.exchange)}" in reconciliation`
    );
  }
  if (!input.evidenceId || typeof input.evidenceId !== 'string') {
    throw new UnreconciledCashError(
      'MISSING_EVIDENCE_ID',
      'Reconciliation requires a non-empty partner statement evidenceId'
    );
  }
  if (!input.walletEvidenceId || typeof input.walletEvidenceId !== 'string') {
    throw new UnreconciledCashError(
      'MISSING_WALLET_EVIDENCE_ID',
      'Reconciliation requires a non-empty wallet statement walletEvidenceId'
    );
  }

  const uidEvidence = input.r2
    ? await assertEvidenceIntegrity(db, input.r2, input.evidenceId)
    : await getEvidenceObjectById(db, input.evidenceId);

  if (!uidEvidence) {
    throw new UnreconciledCashError(
      'EVIDENCE_NOT_FOUND',
      `Partner statement evidence "${input.evidenceId}" not found in r2_evidence_objects`
    );
  }
  if (uidEvidence.exchange !== input.exchange) {
    throw new UnreconciledCashError(
      'EVIDENCE_EXCHANGE_MISMATCH',
      `Partner statement evidence exchange "${uidEvidence.exchange}" !== "${input.exchange}"`
    );
  }
  if (uidEvidence.sourceKind === 'wallet_statement') {
    throw new UnreconciledCashError(
      'INVALID_EVIDENCE_SOURCE_KIND',
      'evidenceId must reference a UID commission statement (rest_poll or csv_statement), not wallet_statement'
    );
  }

  const walletEvidence = input.r2
    ? await assertEvidenceIntegrity(db, input.r2, input.walletEvidenceId)
    : await getEvidenceObjectById(db, input.walletEvidenceId);

  if (!walletEvidence) {
    throw new UnreconciledCashError(
      'WALLET_EVIDENCE_NOT_FOUND',
      `Wallet statement evidence "${input.walletEvidenceId}" not found in r2_evidence_objects`
    );
  }
  if (walletEvidence.exchange !== input.exchange) {
    throw new UnreconciledCashError(
      'WALLET_EVIDENCE_EXCHANGE_MISMATCH',
      `Wallet statement evidence exchange "${walletEvidence.exchange}" !== "${input.exchange}"`
    );
  }
  if (walletEvidence.sourceKind !== 'wallet_statement') {
    throw new UnreconciledCashError(
      'INVALID_WALLET_EVIDENCE_SOURCE_KIND',
      `walletEvidenceId must have source_kind='wallet_statement' (received '${walletEvidence.sourceKind}')`
    );
  }
  if (
    uidEvidence.statementPeriodStart !== walletEvidence.statementPeriodStart ||
    uidEvidence.statementPeriodEnd !== walletEvidence.statementPeriodEnd
  ) {
    throw new UnreconciledCashError(
      'EVIDENCE_PERIOD_MISMATCH',
      `Statement period mismatch between UID evidence (${uidEvidence.statementPeriodStart}..${uidEvidence.statementPeriodEnd}) and wallet evidence (${walletEvidence.statementPeriodStart}..${walletEvidence.statementPeriodEnd})`
    );
  }

  const existingMatched = await db
    .prepare(
      `SELECT id FROM partner_cash_reconciliations
       WHERE status = 'MATCHED' AND (evidence_id = ? OR wallet_evidence_id = ?)
       LIMIT 1`
    )
    .bind(input.evidenceId, input.walletEvidenceId)
    .first<{ id: string }>();
  if (existingMatched) {
    throw new UnreconciledCashError(
      'EVIDENCE_ALREADY_RECONCILED',
      `Evidence has already been used in MATCHED reconciliation "${existingMatched.id}"`
    );
  }

  const clawbackOffsetUnits = input.clawbackOffsetUnits ?? BI_ZERO;
  const evaluation = evaluateCashReconciliation(
    input.uidAllocatedUnits,
    input.walletCashCollectedUnits,
    clawbackOffsetUnits
  );

  const reconId = input.id?.trim() || `recon_${globalThis.crypto.randomUUID()}`;
  const reconciledAt = input.reconciledAt ?? new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO partner_cash_reconciliations (
        id, exchange, evidence_id, wallet_evidence_id,
        uid_allocated_units, wallet_cash_collected_units,
        clawback_offset_units, minted_gross_units,
        discrepancy_units, status, reconciled_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .bind(
      reconId,
      input.exchange,
      input.evidenceId,
      input.walletEvidenceId,
      toSafeSqlInteger(input.uidAllocatedUnits, 'uid_allocated_units'),
      toSafeSqlInteger(input.walletCashCollectedUnits, 'wallet_cash_collected_units'),
      toSafeSqlInteger(clawbackOffsetUnits, 'clawback_offset_units'),
      toSafeSqlInteger(evaluation.discrepancyUnits, 'discrepancy_units'),
      evaluation.status,
      reconciledAt
    )
    .run();

  return {
    id: reconId,
    exchange: input.exchange,
    evidenceId: input.evidenceId,
    walletEvidenceId: input.walletEvidenceId,
    uidAllocatedUnits: input.uidAllocatedUnits,
    walletCashCollectedUnits: input.walletCashCollectedUnits,
    clawbackOffsetUnits,
    mintedGrossUnits: BI_ZERO,
    discrepancyUnits: evaluation.discrepancyUnits,
    status: evaluation.status,
    reconciledAt,
  };
}

/**
 * Retrieve a reconciliation record by primary key.
 */
export async function getReconciliationById(
  db: D1Database,
  reconciliationId: string
): Promise<ReconciliationRecord | null> {
  if (!reconciliationId || typeof reconciliationId !== 'string') {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT id, exchange, evidence_id, wallet_evidence_id,
              uid_allocated_units, wallet_cash_collected_units,
              clawback_offset_units, minted_gross_units,
              discrepancy_units, status, reconciled_at
       FROM partner_cash_reconciliations
       WHERE id = ?`
    )
    .bind(reconciliationId)
    .first<RawReconciliationRow>();

  return row ? mapReconciliationRow(row) : null;
}

/**
 * List reconciliations by exchange and status using composite index
 * `idx_partner_recon_exchange_status`.
 */
export async function listReconciliationsByExchangeStatus(
  db: D1Database,
  exchange: SupportedPartnerExchange,
  status: ReconciliationStatus,
  limit = 50
): Promise<ReconciliationRecord[]> {
  const clampedLimit = Math.max(1, Math.min(500, Math.trunc(limit)));
  const res = await db
    .prepare(
      `SELECT id, exchange, evidence_id, wallet_evidence_id,
              uid_allocated_units, wallet_cash_collected_units,
              clawback_offset_units, minted_gross_units,
              discrepancy_units, status, reconciled_at
       FROM partner_cash_reconciliations
       WHERE exchange = ? AND status = ?
       ORDER BY reconciled_at DESC
       LIMIT ?`
    )
    .bind(exchange, status, clampedLimit)
    .all<RawReconciliationRow>();

  return (res.results ?? []).map(mapReconciliationRow);
}

/**
 * Enforce Gate G2 / G9 trust boundary prior to minting any `COMMISSION_INFLIGHT`
 * ledger batch:
 * 1. Reconciliation record must exist and have `status === 'MATCHED'`.
 * 2. Both `evidence_id` and `wallet_evidence_id` must be present and verified.
 * 3. `exchange` and `evidence_id` must match the ledger batch inputs.
 * 4. Cumulative active commissions minted against `reconciliation_id` plus
 *    `grossCommissionUnits` must not exceed `uidAllocatedUnits` or `walletCashCollectedUnits`.
 */
export async function assertReconciliationEligibleForMinting(
  db: D1Database,
  params: {
    reconciliationId: string;
    evidenceId: string;
    exchange: SupportedPartnerExchange;
    grossCommissionUnits: bigint;
    r2?: R2BucketLike;
  }
): Promise<ReconciliationRecord> {
  if (!params.reconciliationId || typeof params.reconciliationId !== 'string') {
    throw new UnreconciledCashError(
      'MISSING_RECONCILIATION_ID',
      'Ledger commission minting requires a non-empty reconciliationId'
    );
  }
  if (!params.evidenceId || typeof params.evidenceId !== 'string') {
    throw new UnreconciledCashError(
      'MISSING_EVIDENCE_ID',
      'Ledger commission minting requires a non-empty evidenceId'
    );
  }

  const recon = await getReconciliationById(db, params.reconciliationId);
  if (!recon) {
    throw new UnreconciledCashError(
      'RECONCILIATION_NOT_FOUND',
      `Reconciliation "${params.reconciliationId}" does not exist`
    );
  }

  if (recon.status !== 'MATCHED') {
    throw new UnreconciledCashError(
      'RECONCILIATION_NOT_MATCHED',
      `Reconciliation "${recon.id}" has status "${recon.status}"; only MATCHED reconciliations may mint ledger postings`
    );
  }

  if (recon.exchange !== params.exchange) {
    throw new UnreconciledCashError(
      'RECONCILIATION_EXCHANGE_MISMATCH',
      `Reconciliation exchange "${recon.exchange}" does not match batch exchange "${params.exchange}"`
    );
  }

  if (recon.evidenceId !== params.evidenceId) {
    throw new UnreconciledCashError(
      'RECONCILIATION_EVIDENCE_MISMATCH',
      `Batch evidenceId "${params.evidenceId}" does not match reconciliation evidenceId "${recon.evidenceId}"`
    );
  }

  if (!recon.walletEvidenceId) {
    throw new UnreconciledCashError(
      'MISSING_WALLET_EVIDENCE',
      `Reconciliation "${recon.id}" is missing wallet_evidence_id`
    );
  }

  if (params.r2) {
    await assertEvidenceIntegrity(db, params.r2, recon.evidenceId);
    await assertEvidenceIntegrity(db, params.r2, recon.walletEvidenceId);
  } else {
    const uidEv = await getEvidenceObjectById(db, recon.evidenceId);
    const walletEv = await getEvidenceObjectById(db, recon.walletEvidenceId);
    if (!uidEv || !walletEv) {
      throw new UnreconciledCashError(
        'EVIDENCE_RECORD_MISSING',
        `Evidence anchor missing for reconciliation "${recon.id}"`
      );
    }
  }

  // Re-verify discrepancy math defensively in case DB row was tampered out-of-band
  const recheck = evaluateCashReconciliation(
    recon.uidAllocatedUnits,
    recon.walletCashCollectedUnits,
    recon.clawbackOffsetUnits
  );
  if (recheck.status !== 'MATCHED') {
    throw new UnreconciledCashError(
      'RECONCILIATION_DISCREPANCY_DETECTED',
      `Reconciliation "${recon.id}" failed CASH_COLLECTED tolerance check (discrepancy=${recheck.discrepancyUnits.toString()})`
    );
  }

  // Ensure cumulative gross commissions minted against this reconciliation never exceed cap
  const usageRow = await db
    .prepare(
      `SELECT COALESCE(SUM(gross_commission_units), 0) AS minted_units
       FROM ledger_journal_batches INDEXED BY idx_ledger_batches_recon
       WHERE reconciliation_id = ?
         AND journal_type = 'COMMISSION_INFLIGHT'`
    )
    .bind(recon.id)
    .first<{ minted_units: number }>();

  const alreadyMinted = fromSqlInteger(usageRow?.minted_units ?? 0, 'minted_units');
  const trackedMinted =
    recon.mintedGrossUnits > alreadyMinted ? recon.mintedGrossUnits : alreadyMinted;
  const projectedTotal = trackedMinted + params.grossCommissionUnits;
  const effectiveBackedCap = recon.walletCashCollectedUnits + recon.clawbackOffsetUnits;
  const maxAllowed =
    recon.uidAllocatedUnits <= effectiveBackedCap
      ? recon.uidAllocatedUnits
      : effectiveBackedCap;

  if (projectedTotal > maxAllowed) {
    throw new UnreconciledCashError(
      'RECONCILIATION_CAP_EXCEEDED',
      `Cumulative minted commissions (${projectedTotal.toString()}) would exceed reconciled CASH_COLLECTED cap (${maxAllowed.toString()}) for reconciliation "${recon.id}"`
    );
  }

  return recon;
}
