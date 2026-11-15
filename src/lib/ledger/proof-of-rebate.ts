/**
 * B2B Cryptographic Proof-of-Rebate Verification Service
 *
 * Produces PII-redacted, cryptographically verifiable rebate proofs linking:
 * - Ledger batch ID & double-entry balance status
 * - Masked trader UID (`***1234` — never raw UID, email, or IP address)
 * - Safe-Spread Waterfall I4 split in `10^-8` USD integer units
 * - R2 partner statement & broker wallet statement `payload_sha256` anchors
 * - `CASH_COLLECTED` reconciliation status
 * - On-chain `settled_tx_hash` (when settled/disbursed)
 */

import type { D1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  computeSha256Hex,
  getEvidenceObjectById,
  verifyEvidenceIntegrity,
  type R2BucketLike,
} from './evidence-vault';
import { getReconciliationById } from './reconciliation-service';
import {
  BI_ZERO,
  formatLedgerUnitsToUsd,
  fromSqlInteger,
} from './units';
import { DoubleEntryLedgerService, type LedgerBatchStatus } from './double-entry-ledger';

export interface ProofOfRebateWaterfallUnits {
  clawbackReserveUnits: string;
  traderCashbackUnits: string;
  l1AffiliateCommissionUnits: string;
  b2bAgencyOverrideUnits: string;
  platformNetUnits: string;
  doubleEntryBalanced: boolean;
}

export interface ProofOfRebateClawbackState {
  clawedBackUnits: string;
  remainingGrossUnits: string;
}

export interface ProofOfRebateEvidenceAnchor {
  evidenceId: string;
  sourceKind: string;
  payloadSha256: string;
  byteLength: number;
  statementPeriodStart: string;
  statementPeriodEnd: string;
  retentionUntil: string;
  r2IntegrityVerified: boolean | null;
}

export interface ProofOfRebateReconciliationAnchor {
  reconciliationId: string;
  status: 'MATCHED' | 'DISCREPANCY_HALTED' | 'CLAWBACK_ADJUSTED';
  walletPayloadSha256: string | null;
  discrepancyUnits: string;
  reconciledAt: string;
}

export interface ProofOfRebateRecord {
  batchId: string;
  journalType: string;
  status: LedgerBatchStatus;
  exchange: string;
  maskedTraderUid: string;
  grossCommissionUnits: string;
  grossCommissionUsd: string;
  waterfallUnits: ProofOfRebateWaterfallUnits;
  clawbackState: ProofOfRebateClawbackState;
  evidence: ProofOfRebateEvidenceAnchor;
  reconciliation: ProofOfRebateReconciliationAnchor;
  settlement: {
    holdUntil: string | null;
    settledTxHash: string | null;
  };
  createdAt: string;
  proofDigestSha256: string;
}

/**
 * Redact a raw exchange trader UID into `***1234` format, stripping any
 * accidental email domain or whitespace so PII can never leak.
 */
export function maskTraderUid(rawUid: string | null | undefined): string {
  if (!rawUid || typeof rawUid !== 'string') {
    return '***REDACTED';
  }
  const withoutDomain = rawUid.includes('@') ? rawUid.split('@')[0] : rawUid;
  const cleaned = withoutDomain.replace(/[^a-zA-Z0-9]/g, '');
  if (cleaned.length === 0) {
    return '***REDACTED';
  }
  if (cleaned.length <= 4) {
    const tail = cleaned.length >= 2 ? cleaned.slice(-2) : cleaned.slice(-1);
    return `***${tail}`;
  }
  return `***${cleaned.slice(-4)}`;
}

/**
 * Build a PII-redacted cryptographic Proof-of-Rebate for a commission batch.
 */
export async function getProofOfRebateByBatchId(
  db: D1Database,
  batchId: string,
  options: { r2?: R2BucketLike } = {}
): Promise<ProofOfRebateRecord | null> {
  if (!batchId || typeof batchId !== 'string' || batchId.trim() === '') {
    return null;
  }

  const ledger = new DoubleEntryLedgerService(db);
  const batch = await ledger.getBatchById(batchId.trim());
  if (!batch || batch.journalType !== 'COMMISSION_INFLIGHT') {
    return null;
  }
  if (!batch.evidenceId || !batch.reconciliationId || !batch.exchange) {
    return null;
  }

  const [postings, evidenceRecord, reconRecord] = await Promise.all([
    ledger.getPostingsForBatch(batch.id),
    getEvidenceObjectById(db, batch.evidenceId),
    getReconciliationById(db, batch.reconciliationId),
  ]);

  if (!evidenceRecord || !reconRecord) {
    return null;
  }

  let walletPayloadSha256: string | null = null;
  if (reconRecord.walletEvidenceId) {
    const walletEv = await getEvidenceObjectById(db, reconRecord.walletEvidenceId);
    walletPayloadSha256 = walletEv ? walletEv.payloadSha256 : null;
  }

  let r2IntegrityVerified: boolean | null = null;
  if (options.r2) {
    const integrity = await verifyEvidenceIntegrity(db, options.r2, evidenceRecord.id);
    r2IntegrityVerified = integrity.valid;
  }

  let debitSum = BI_ZERO;
  let creditSum = BI_ZERO;
  let reserveUnits = BI_ZERO;
  let traderUnits = BI_ZERO;
  let l1Units = BI_ZERO;
  let b2bUnits = BI_ZERO;
  let platformUnits = BI_ZERO;

  for (const p of postings) {
    if (p.direction === 'DEBIT') {
      debitSum += p.amountUnits;
    } else {
      creditSum += p.amountUnits;
      if (p.legRole === 'CLAWBACK_RESERVE') {
        reserveUnits += p.amountUnits;
      } else if (p.legRole === 'TRADER_CASHBACK') {
        traderUnits += p.amountUnits;
      } else if (p.legRole === 'L1_AFFILIATE_COMMISSION') {
        l1Units += p.amountUnits;
      } else if (p.legRole === 'B2B_AGENCY_OVERRIDE') {
        b2bUnits += p.amountUnits;
      } else if (p.legRole === 'PLATFORM_NET_REVENUE') {
        platformUnits += p.amountUnits;
      }
    }
  }

  const doubleEntryBalanced =
    debitSum > BI_ZERO &&
    debitSum === creditSum &&
    debitSum === batch.grossCommissionUnits;

  const maskedUid = maskTraderUid(batch.traderUid);

  // Lookup optional finalized payout tx_hash ONLY when the batch itself is SETTLED
  // and the withdrawal lock occurred on or after the batch's creation timestamp
  let settledTxHash = batch.settledTxHash;
  if (!settledTxHash && batch.status === 'SETTLED') {
    const l1Id =
      typeof batch.metadata.l1AffiliateId === 'string'
        ? batch.metadata.l1AffiliateId
        : null;
    if (l1Id) {
      const affiliateAcct = await ledger.getAccountByOwner('affiliate', l1Id);
      if (affiliateAcct) {
        const recentLockPosting = await db
          .prepare(
            `SELECT lp.batch_id
             FROM ledger_postings lp
             WHERE lp.account_id = ? AND lp.leg_role = 'USER_WITHDRAWAL_LOCK'
               AND lp.created_at >= ?
             ORDER BY lp.created_at DESC
             LIMIT 1`
          )
          .bind(affiliateAcct.id, batch.createdAt)
          .first<{ batch_id: string }>();
        if (recentLockPosting) {
          const lockBatch = await ledger.getBatchById(recentLockPosting.batch_id);
          if (lockBatch?.status === 'SETTLED' && lockBatch.settledTxHash) {
            settledTxHash = lockBatch.settledTxHash;
          }
        }
      }
    }
  }

  const rawRemainingLegs =
    typeof batch.metadata.remainingLegs === 'object' && batch.metadata.remainingLegs !== null
      ? (batch.metadata.remainingLegs as Record<string, unknown>)
      : {};
  const clawbackState: ProofOfRebateClawbackState = {
    clawedBackUnits:
      typeof batch.metadata.clawedBackUnits === 'string' ? batch.metadata.clawedBackUnits : '0',
    remainingGrossUnits:
      typeof rawRemainingLegs.grossUnits === 'string'
        ? rawRemainingLegs.grossUnits
        : batch.grossCommissionUnits.toString(),
  };

  const waterfallUnits: ProofOfRebateWaterfallUnits = {
    clawbackReserveUnits: reserveUnits.toString(),
    traderCashbackUnits: traderUnits.toString(),
    l1AffiliateCommissionUnits: l1Units.toString(),
    b2bAgencyOverrideUnits: b2bUnits.toString(),
    platformNetUnits: platformUnits.toString(),
    doubleEntryBalanced,
  };

  const evidenceAnchor: ProofOfRebateEvidenceAnchor = {
    evidenceId: evidenceRecord.id,
    sourceKind: evidenceRecord.sourceKind,
    payloadSha256: evidenceRecord.payloadSha256,
    byteLength: evidenceRecord.byteLength,
    statementPeriodStart: evidenceRecord.statementPeriodStart,
    statementPeriodEnd: evidenceRecord.statementPeriodEnd,
    retentionUntil: evidenceRecord.retentionUntil,
    r2IntegrityVerified,
  };

  const reconciliationAnchor: ProofOfRebateReconciliationAnchor = {
    reconciliationId: reconRecord.id,
    status: reconRecord.status,
    walletPayloadSha256,
    discrepancyUnits: reconRecord.discrepancyUnits.toString(),
    reconciledAt: reconRecord.reconciledAt,
  };

  const canonicalDigestPayload = JSON.stringify({
    batchId: batch.id,
    status: batch.status,
    exchange: batch.exchange,
    maskedTraderUid: maskedUid,
    grossCommissionUnits: batch.grossCommissionUnits.toString(),
    waterfallUnits,
    clawbackState,
    payloadSha256: evidenceAnchor.payloadSha256,
    walletPayloadSha256: reconciliationAnchor.walletPayloadSha256,
    reconciliationStatus: reconciliationAnchor.status,
    settledTxHash,
  });
  const proofDigestSha256 = await computeSha256Hex(canonicalDigestPayload);

  return {
    batchId: batch.id,
    journalType: batch.journalType,
    status: batch.status,
    exchange: batch.exchange,
    maskedTraderUid: maskedUid,
    grossCommissionUnits: batch.grossCommissionUnits.toString(),
    grossCommissionUsd: formatLedgerUnitsToUsd(batch.grossCommissionUnits),
    waterfallUnits,
    clawbackState,
    evidence: evidenceAnchor,
    reconciliation: reconciliationAnchor,
    settlement: {
      holdUntil: batch.holdUntil,
      settledTxHash,
    },
    createdAt: batch.createdAt,
    proofDigestSha256,
  };
}

/**
 * List PII-redacted Proof-of-Rebate records for an affiliate or B2B agency
 * using `idx_ledger_accounts_owner` and `idx_ledger_postings_account_created`.
 */
export async function listProofsOfRebateByAffiliateId(
  db: D1Database,
  affiliateId: string,
  options: { limit?: number; r2?: R2BucketLike } = {}
): Promise<ProofOfRebateRecord[]> {
  if (!affiliateId || typeof affiliateId !== 'string' || affiliateId.trim() === '') {
    return [];
  }
  const trimmedId = affiliateId.trim();
  const limit = Math.max(1, Math.min(100, Math.trunc(options.limit ?? 25)));

  const acctRows = await db
    .prepare(
      `SELECT id
       FROM ledger_accounts
       WHERE owner_type IN ('affiliate', 'agency') AND owner_id = ?`
    )
    .bind(trimmedId)
    .all<{ id: string }>();

  const accountIds = (acctRows.results ?? []).map((r) => r.id);
  if (accountIds.length === 0) {
    return [];
  }

  const seenBatchIds = new Set<string>();
  const orderedBatchIds: string[] = [];

  for (const acctId of accountIds) {
    const postingRows = await db
      .prepare(
        `SELECT batch_id, amount_units
         FROM ledger_postings
         WHERE account_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
      )
      .bind(acctId, limit * 2)
      .all<{ batch_id: string; amount_units: number }>();

    for (const row of postingRows.results ?? []) {
      const amt = fromSqlInteger(row.amount_units, 'amount_units');
      if (amt > BI_ZERO && !seenBatchIds.has(row.batch_id)) {
        seenBatchIds.add(row.batch_id);
        orderedBatchIds.push(row.batch_id);
      }
    }
  }

  const proofs: ProofOfRebateRecord[] = [];
  for (const bId of orderedBatchIds) {
    if (proofs.length >= limit) {
      break;
    }
    const proof = await getProofOfRebateByBatchId(db, bId, { r2: options.r2 });
    if (proof) {
      proofs.push(proof);
    }
  }

  return proofs;
}
