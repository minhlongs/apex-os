/**
 * src/lib/payouts/reconcile-historical-payouts.ts
 *
 * Phase 07 Mandatory Pre-Flight: Historical Payout & Earnings Ledger Reconciliation
 *
 * Audits existing `payouts` and `earnings` rows in read-only mode to surface:
 * 1. Completed payouts with missing or blank `transaction_id`.
 * 2. Payouts carrying fabricated mock transaction payloads.
 * 3. Completed payouts on chains that lacked real signing before Phase 04 (`solana`, `ethereum`).
 * 4. Completed Stellar payouts with malformed transaction hashes (not 64-char hex).
 * 5. Orphaned earnings marked `is_paid = 1` where `payout_id IS NULL` or references a non-completed payout.
 *
 * IMPORTANT: This module is strictly read-only. It never deletes or rewrites historical rows.
 */

import type { D1Database } from '../db';

export type HistoricalPayoutAnomalyReason =
  | 'missing_transaction_id'
  | 'mock_signed_tx_payload'
  | 'legacy_unverified_chain_completion'
  | 'malformed_stellar_tx_hash';

export interface HistoricalPayoutRow {
  id: string;
  affiliate_id: string;
  amount: number;
  fee: number;
  net_amount: number;
  status: string;
  chain: string | null;
  transaction_id: string | null;
  created_at: string;
}

export interface FlaggedHistoricalPayout {
  payoutId: string;
  affiliateId: string;
  amount: number;
  netAmount: number;
  status: string;
  chain: string;
  transactionId: string | null;
  createdAt: string;
  reasons: HistoricalPayoutAnomalyReason[];
}

export interface OrphanedPaidEarningRow {
  id: string;
  affiliate_id: string;
  amount: number;
  is_paid: number;
  payout_id: string | null;
  payout_status?: string | null;
}

export interface HistoricalPayoutReconciliationReport {
  checkedAt: string;
  totalPayoutsScanned: number;
  completedPayoutsCount: number;
  flaggedPayouts: FlaggedHistoricalPayout[];
  orphanedPaidEarningsCount: number;
  orphanedPaidEarnings: OrphanedPaidEarningRow[];
  requiresFounderRemediation: boolean;
}

const STELLAR_TX_HASH_REGEX = /^[0-9a-fA-F]{64}$/;
const LEGACY_MOCK_TX_TOKEN = ['MOCK', 'SIGNED', 'TX', 'PAYLOAD'].join('_');

/**
 * Pure classifier for a single historical payout row.
 */
export function classifyHistoricalPayoutRow(
  row: HistoricalPayoutRow
): HistoricalPayoutAnomalyReason[] {
  const reasons: HistoricalPayoutAnomalyReason[] = [];
  const txId = row.transaction_id?.trim() ?? '';
  const chain = (row.chain ?? 'stellar').trim().toLowerCase();
  const isCompleted = row.status === 'completed';

  if (txId.includes(LEGACY_MOCK_TX_TOKEN)) {
    reasons.push('mock_signed_tx_payload');
  }

  if (isCompleted && txId.length === 0) {
    reasons.push('missing_transaction_id');
  }

  if (isCompleted && (chain === 'solana' || chain === 'ethereum')) {
    reasons.push('legacy_unverified_chain_completion');
  }

  if (
    isCompleted &&
    chain === 'stellar' &&
    txId.length > 0 &&
    !STELLAR_TX_HASH_REGEX.test(txId)
  ) {
    reasons.push('malformed_stellar_tx_hash');
  }

  return reasons;
}

/**
 * Runs a strictly read-only reconciliation audit against the provided D1 database.
 */
export async function reconcileHistoricalPayouts(
  db: D1Database
): Promise<HistoricalPayoutReconciliationReport> {
  const payoutsRes = await db
    .prepare(
      `SELECT id, affiliate_id, amount, fee, net_amount, status, chain, transaction_id, created_at
       FROM payouts
       ORDER BY created_at DESC`
    )
    .all<HistoricalPayoutRow>();

  const payoutRows = payoutsRes.results ?? [];

  const flaggedPayouts: FlaggedHistoricalPayout[] = [];
  let completedPayoutsCount = 0;

  for (const row of payoutRows) {
    if (row.status === 'completed') {
      completedPayoutsCount += 1;
    }
    const reasons = classifyHistoricalPayoutRow(row);
    if (reasons.length > 0) {
      flaggedPayouts.push({
        payoutId: row.id,
        affiliateId: row.affiliate_id,
        amount: Number(row.amount),
        netAmount: Number(row.net_amount),
        status: row.status,
        chain: (row.chain ?? 'stellar').toLowerCase(),
        transactionId: row.transaction_id,
        createdAt: row.created_at,
        reasons,
      });
    }
  }

  const orphanedRes = await db
    .prepare(
      `SELECT e.id, e.affiliate_id, e.amount, e.is_paid, e.payout_id, p.status AS payout_status
       FROM earnings e
       LEFT JOIN payouts p ON e.payout_id = p.id
       WHERE e.is_paid = 1
         AND (e.payout_id IS NULL OR p.id IS NULL OR p.status != 'completed')
       ORDER BY e.id ASC`
    )
    .all<OrphanedPaidEarningRow>();

  const orphanedPaidEarnings = orphanedRes.results ?? [];

  return {
    checkedAt: new Date().toISOString(),
    totalPayoutsScanned: payoutRows.length,
    completedPayoutsCount,
    flaggedPayouts,
    orphanedPaidEarningsCount: orphanedPaidEarnings.length,
    orphanedPaidEarnings,
    requiresFounderRemediation:
      flaggedPayouts.length > 0 || orphanedPaidEarnings.length > 0,
  };
}
