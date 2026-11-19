/**
 * Trader & B2B Partner Portal Ledger Summary API
 *
 * Endpoint:
 * - GET /api/affiliate/ledger-summary
 *
 * Aggregates owner-scoped Ascendancy Phase 2 financial state in a single
 * non-custodial, PII-redacted payload:
 * 1. Exact `10^-8` USD integer unit balances (`INFLIGHT`, `AVAILABLE`,
 *    `LOCKED_WITHDRAWAL`, `SETTLED`, `CLAWBACK`) formatted exclusively via
 *    `BigInt` + `formatLedgerUnitsToUsd` (zero IEEE-754 float math).
 * 2. Recent journal batches with `T+7` `holdUntil` timestamps, clawback markers,
 *    and on-chain `settledTxHash` settlement receipts.
 * 3. Cryptographic B2B Proof-of-Rebate records (`payloadSha256`,
 *    `walletPayloadSha256`, `proofDigestSha256`, masked `***1234` trader UIDs).
 * 4. Strictly 2-level (`L1` Direct Referrals + `L2` B2B Sub-Affiliates) partner
 *    network summary — hard-capped at depth 2 (no L3+ MLM).
 */

import { NextRequest, NextResponse } from 'next/server';
import type { D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { assertNoIdor, sanitizeApiErrorResponse } from '@/lib/auth/passkey-step-up';
import type { R2BucketLike } from '@/lib/ledger/evidence-vault';
import {
  getProofOfRebateByBatchId,
  listProofsOfRebateByAffiliateId,
  maskTraderUid,
  type ProofOfRebateRecord,
} from '@/lib/ledger/proof-of-rebate';
import {
  BI_ZERO,
  formatLedgerUnitsToUsd,
  fromSqlInteger,
  MIN_WITHDRAWAL_UNITS_1E8,
} from '@/lib/ledger/units';
import { isWalletUnlockedForPayout } from '@/lib/wallet/timelock-wallet-service';

export type PortalLedgerStateBucket =
  | 'INFLIGHT'
  | 'AVAILABLE'
  | 'LOCKED_WITHDRAWAL'
  | 'SETTLED'
  | 'CLAWBACK';

export interface PortalBalanceBucketSummary {
  inflightUnits: string;
  inflightUsd: string;
  inflightUsdExact: string;
  availableUnits: string;
  availableUsd: string;
  availableUsdExact: string;
  lockedWithdrawalUnits: string;
  lockedWithdrawalUsd: string;
  lockedWithdrawalUsdExact: string;
  settledUnits: string;
  settledUsd: string;
  settledUsdExact: string;
  clawedBackUnits: string;
  clawedBackUsd: string;
  clawedBackUsdExact: string;
  minimumWithdrawalUnits: string;
  minimumWithdrawalUsd: string;
  canWithdraw: boolean;
}

export interface PortalBatchFeedItem {
  batchId: string;
  journalType: string;
  status: 'INFLIGHT' | 'SETTLED' | 'VOIDED';
  stateBucket: PortalLedgerStateBucket;
  exchange: string | null;
  maskedTraderUid: string | null;
  userAmountUnits: string;
  userAmountUsd: string;
  userAmountUsdExact: string;
  direction: 'CREDIT' | 'DEBIT';
  legRoles: string[];
  holdUntil: string | null;
  settledTxHash: string | null;
  clawedBackUnits: string;
  clawedBackUsd: string;
  createdAt: string;
}

export interface TwoLevelPartnerNode {
  partnerId: string;
  maskedPartnerRef: string;
  level: 1 | 2;
  joinedAt: string | null;
}

export interface TwoLevelPartnerTreeSummary {
  maxAllowedDepth: 2;
  l1DirectCount: number;
  l2SubAffiliateCount: number;
  l1OverrideEarnedUnits: string;
  l1OverrideEarnedUsd: string;
  l2B2bOverrideEarnedUnits: string;
  l2B2bOverrideEarnedUsd: string;
  nodes: TwoLevelPartnerNode[];
}

interface RawLedgerAccountRow {
  id: string;
  owner_type: 'trader' | 'affiliate' | 'agency';
  settled_balance_units: number;
  inflight_balance_units: number;
}

interface RawPostingJoinBatchRow {
  batch_id: string;
  journal_type: string;
  status: 'INFLIGHT' | 'SETTLED' | 'VOIDED';
  exchange: string | null;
  trader_uid: string | null;
  hold_until: string | null;
  settled_tx_hash: string | null;
  metadata: string;
  batch_created_at: string;
  direction: 'DEBIT' | 'CREDIT';
  amount_units: number;
  leg_role: string;
}

function resolveOptionalR2Bucket(): R2BucketLike | undefined {
  const globalObj = globalThis as unknown as {
    STORAGE?: R2BucketLike;
    R2_EVIDENCE_VAULT?: R2BucketLike;
    EVIDENCE_BUCKET?: R2BucketLike;
  };
  return globalObj.STORAGE ?? globalObj.R2_EVIDENCE_VAULT ?? globalObj.EVIDENCE_BUCKET;
}

interface PostingAggregateTotalsRow {
  locked_withdrawal_units: number | string | null;
  settled_units: number | string | null;
  clawed_back_units: number | string | null;
  l1_override_earned_units: number | string | null;
  l2_b2b_override_earned_units: number | string | null;
}

const RAW_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_INTERNAL_ID_PATTERN = /^[0-9a-f]{32}$|^[A-Za-z0-9_-]{24,}$/;

function sanitizePublicPartnerId(rawId: string): string {
  const trimmed = rawId.trim();
  if (
    RAW_UUID_PATTERN.test(trimmed) ||
    OPAQUE_INTERNAL_ID_PATTERN.test(trimmed)
  ) {
    const prefix = trimmed.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase();
    return `partner-${prefix || 'anon'}`;
  }
  return trimmed;
}

function maskPartnerId(rawId: string): string {
  const cleaned = rawId.replace(/[^A-Za-z0-9]/g, '');
  if (cleaned.length <= 4) {
    return `PARTNER-***${cleaned || 'ANON'}`;
  }
  return `PARTNER-***${cleaned.slice(-4)}`;
}

function deriveStateBucket(
  journalType: string,
  status: 'INFLIGHT' | 'SETTLED' | 'VOIDED',
  direction: 'DEBIT' | 'CREDIT'
): PortalLedgerStateBucket {
  if (
    journalType === 'COMMISSION_VOID_CLAWBACK' ||
    journalType === 'POST_SETTLEMENT_CLAWBACK' ||
    status === 'VOIDED'
  ) {
    return 'CLAWBACK';
  }
  if (journalType === 'WITHDRAWAL_LOCK') {
    return status === 'SETTLED' ? 'SETTLED' : 'LOCKED_WITHDRAWAL';
  }
  if (journalType === 'WITHDRAWAL_FINALIZED') {
    return 'SETTLED';
  }
  if (journalType === 'COMMISSION_INFLIGHT') {
    return status === 'SETTLED' ? 'AVAILABLE' : 'INFLIGHT';
  }
  if (journalType === 'COMMISSION_SETTLED') {
    return 'AVAILABLE';
  }
  return direction === 'DEBIT' ? 'LOCKED_WITHDRAWAL' : 'AVAILABLE';
}

function parseClawedBackUnitsFromMetadata(rawMeta: string): bigint {
  try {
    const parsed = JSON.parse(rawMeta) as Record<string, unknown>;
    if (typeof parsed.clawedBackUnits === 'string' && /^\d+$/.test(parsed.clawedBackUnits)) {
      return BigInt(parsed.clawedBackUnits);
    }
    if (typeof parsed.clawbackUnits === 'string' && /^\d+$/.test(parsed.clawbackUnits)) {
      return BigInt(parsed.clawbackUnits);
    }
  } catch {
    // Ignore malformed metadata
  }
  return BI_ZERO;
}

async function queryTwoLevelPartnerNodes(
  db: D1Database,
  userId: string
): Promise<TwoLevelPartnerNode[]> {
  const levelMap = new Map<string, TwoLevelPartnerNode>();

  // Strategy A: `referral_tree` (migration 003 canonical D1 hierarchy)
  try {
    const myNode = await db
      .prepare('SELECT id FROM referral_tree WHERE affiliate_id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string }>();

    if (myNode?.id) {
      const l1Rows = await db
        .prepare(
          `SELECT id, affiliate_id, joined_at
           FROM referral_tree
           WHERE parent_id = ? AND affiliate_id != ?
           ORDER BY joined_at DESC
           LIMIT 100`
        )
        .bind(myNode.id, userId)
        .all<{ id: string; affiliate_id: string; joined_at: string | null }>();

      const l1TreeIds: string[] = [];
      for (const row of l1Rows.results ?? []) {
        l1TreeIds.push(row.id);
        levelMap.set(row.affiliate_id, {
          partnerId: sanitizePublicPartnerId(row.affiliate_id),
          maskedPartnerRef: maskPartnerId(row.affiliate_id),
          level: 1,
          joinedAt: row.joined_at ?? null,
        });
      }

      // Strictly L2 only (children of L1; L3+ never queried)
      if (l1TreeIds.length > 0) {
        const placeholders = l1TreeIds.map(() => '?').join(', ');
        const l2Rows = await db
          .prepare(
            `SELECT affiliate_id, joined_at
             FROM referral_tree
             WHERE parent_id IN (${placeholders}) AND affiliate_id != ?
             ORDER BY joined_at DESC
             LIMIT 100`
          )
          .bind(...l1TreeIds, userId)
          .all<{ affiliate_id: string; joined_at: string | null }>();

        for (const row of l2Rows.results ?? []) {
          if (!levelMap.has(row.affiliate_id)) {
            levelMap.set(row.affiliate_id, {
              partnerId: sanitizePublicPartnerId(row.affiliate_id),
              maskedPartnerRef: maskPartnerId(row.affiliate_id),
              level: 2,
              joinedAt: row.joined_at ?? null,
            });
          }
        }
      }
    }
  } catch {
    // referral_tree is optional in minimal schemas
  }

  // Strategy B: `profiles.referred_by` (matches `profiles.referral_code` or `profiles.id`)
  try {
    const me = await db
      .prepare('SELECT id, referral_code FROM profiles WHERE id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string; referral_code: string | null }>();

    if (me) {
      const matchKeys = me.referral_code ? [me.id, me.referral_code] : [me.id];
      const l1Placeholders = matchKeys.map(() => '?').join(', ');
      const l1Profiles = await db
        .prepare(
          `SELECT id, referral_code, created_at
           FROM profiles
           WHERE referred_by IN (${l1Placeholders}) AND id != ?
           ORDER BY created_at DESC
           LIMIT 100`
        )
        .bind(...matchKeys, userId)
        .all<{ id: string; referral_code: string | null; created_at: string | null }>();

      const l1MatchKeys: string[] = [];
      for (const p of l1Profiles.results ?? []) {
        l1MatchKeys.push(p.id);
        if (p.referral_code) {
          l1MatchKeys.push(p.referral_code);
        }
        if (!levelMap.has(p.id)) {
          levelMap.set(p.id, {
            partnerId: sanitizePublicPartnerId(p.id),
            maskedPartnerRef: maskPartnerId(p.id),
            level: 1,
            joinedAt: p.created_at ?? null,
          });
        }
      }

      // Strictly cap at L2 (never recurse to L3+)
      if (l1MatchKeys.length > 0) {
        const l2Placeholders = l1MatchKeys.map(() => '?').join(', ');
        const l2Profiles = await db
          .prepare(
            `SELECT id, created_at
             FROM profiles
             WHERE referred_by IN (${l2Placeholders}) AND id != ?
             ORDER BY created_at DESC
             LIMIT 100`
          )
          .bind(...l1MatchKeys, userId)
          .all<{ id: string; created_at: string | null }>();

        for (const p2 of l2Profiles.results ?? []) {
          if (!levelMap.has(p2.id)) {
            levelMap.set(p2.id, {
              partnerId: sanitizePublicPartnerId(p2.id),
              maskedPartnerRef: maskPartnerId(p2.id),
              level: 2,
              joinedAt: p2.created_at ?? null,
            });
          }
        }
      }
    }
  } catch {
    // Ignore if profiles lacks referral_code / referred_by in minimal fixtures
  }

  return Array.from(levelMap.values());
}

function extractRequestedOwnerParam(searchParams: URLSearchParams): string | null {
  const candidates = [
    searchParams.get('profile_id'),
    searchParams.get('profileId'),
    searchParams.get('affiliate_id'),
    searchParams.get('affiliateId'),
    searchParams.get('user_id'),
    searchParams.get('userId'),
  ];
  for (const val of candidates) {
    if (val && val.trim().length > 0) {
      return val.trim();
    }
  }
  return null;
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
        { success: false, code: 'UNAUTHENTICATED', error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const url = new URL(request.url);
    const requestedOwner = extractRequestedOwnerParam(url.searchParams);
    if (requestedOwner !== null) {
      const idor = assertNoIdor(user.id, requestedOwner, false);
      if (!idor.allowed) {
        return NextResponse.json(
          {
            success: false,
            code: 'IDOR_FORBIDDEN',
            error: 'Forbidden: Cross-account ledger summary access denied',
          },
          { status: 403 }
        );
      }
    }

    // 1. Load owner-scoped ledger accounts (trader, affiliate, agency)
    let accountRows: RawLedgerAccountRow[] = [];
    try {
      const acctResult = await db
        .prepare(
          `SELECT id, owner_type, settled_balance_units, inflight_balance_units
           FROM ledger_accounts
           WHERE owner_id = ? AND owner_type IN ('trader', 'affiliate', 'agency')`
        )
        .bind(user.id)
        .all<RawLedgerAccountRow>();
      accountRows = acctResult.results ?? [];
    } catch {
      accountRows = [];
    }

    let inflightUnits = BI_ZERO;
    let availableUnits = BI_ZERO;
    for (const acct of accountRows) {
      inflightUnits += fromSqlInteger(acct.inflight_balance_units, 'inflight_balance_units');
      availableUnits += fromSqlInteger(acct.settled_balance_units, 'settled_balance_units');
    }

    const accountIds = accountRows.map((a) => a.id);
    let lockedWithdrawalUnits = BI_ZERO;
    let settledUnits = BI_ZERO;
    let clawedBackUnits = BI_ZERO;
    let l1OverrideEarnedUnits = BI_ZERO;
    let l2B2bOverrideEarnedUnits = BI_ZERO;

    const recentBatches: PortalBatchFeedItem[] = [];
    const candidateCommissionBatchIds: string[] = [];

    if (accountIds.length > 0) {
      const placeholders = accountIds.map(() => '?').join(', ');

      // Aggregate withdrawal lock, settled payout, clawbacks, and L1/L2 override totals
      // across ALL postings for this user via SQL SUM(...) so totals are never truncated by LIMIT 200.
      let usedSqlAggregates = false;
      try {
        const aggregateRow = await db
          .prepare(
            `SELECT
               COALESCE(SUM(CASE
                 WHEN lp.leg_role = 'USER_WITHDRAWAL_LOCK'
                  AND b.journal_type = 'WITHDRAWAL_LOCK'
                  AND b.status = 'INFLIGHT'
                 THEN lp.amount_units ELSE 0 END), 0) AS locked_withdrawal_units,
               COALESCE(SUM(CASE
                 WHEN lp.leg_role = 'USER_WITHDRAWAL_LOCK'
                  AND b.journal_type = 'WITHDRAWAL_LOCK'
                  AND b.status = 'SETTLED'
                 THEN lp.amount_units ELSE 0 END), 0) AS settled_units,
               COALESCE(SUM(CASE
                 WHEN lp.direction = 'DEBIT'
                  AND b.journal_type IN ('COMMISSION_VOID_CLAWBACK', 'POST_SETTLEMENT_CLAWBACK')
                 THEN lp.amount_units ELSE 0 END), 0) AS clawed_back_units,
               COALESCE(SUM(CASE
                 WHEN lp.direction = 'CREDIT'
                  AND lp.leg_role = 'L1_AFFILIATE_COMMISSION'
                  AND b.status != 'VOIDED'
                 THEN lp.amount_units ELSE 0 END), 0) AS l1_override_earned_units,
               COALESCE(SUM(CASE
                 WHEN lp.direction = 'CREDIT'
                  AND lp.leg_role = 'B2B_AGENCY_OVERRIDE'
                  AND b.status != 'VOIDED'
                 THEN lp.amount_units ELSE 0 END), 0) AS l2_b2b_override_earned_units
             FROM ledger_postings lp
             INNER JOIN ledger_journal_batches b ON b.id = lp.batch_id
             WHERE lp.account_id IN (${placeholders})`
          )
          .bind(...accountIds)
          .first<PostingAggregateTotalsRow>();

        if (
          aggregateRow &&
          (aggregateRow.locked_withdrawal_units !== undefined ||
            aggregateRow.settled_units !== undefined ||
            aggregateRow.clawed_back_units !== undefined ||
            aggregateRow.l1_override_earned_units !== undefined ||
            aggregateRow.l2_b2b_override_earned_units !== undefined)
        ) {
          lockedWithdrawalUnits = fromSqlInteger(
            aggregateRow.locked_withdrawal_units ?? 0,
            'locked_withdrawal_units'
          );
          settledUnits = fromSqlInteger(
            aggregateRow.settled_units ?? 0,
            'settled_units'
          );
          clawedBackUnits = fromSqlInteger(
            aggregateRow.clawed_back_units ?? 0,
            'clawed_back_units'
          );
          l1OverrideEarnedUnits = fromSqlInteger(
            aggregateRow.l1_override_earned_units ?? 0,
            'l1_override_earned_units'
          );
          l2B2bOverrideEarnedUnits = fromSqlInteger(
            aggregateRow.l2_b2b_override_earned_units ?? 0,
            'l2_b2b_override_earned_units'
          );
          usedSqlAggregates = true;
        }
      } catch {
        // Fallback to JS aggregation below if minimal test mocks only handle the list query
      }

      // Fetch recent postings (LIMIT 200) for the display feed
      const allPostingsResult = await db
        .prepare(
          `SELECT
             b.id AS batch_id,
             b.journal_type,
             b.status,
             b.exchange,
             b.trader_uid,
             b.hold_until,
             b.settled_tx_hash,
             b.metadata,
             b.created_at AS batch_created_at,
             lp.direction,
             lp.amount_units,
             lp.leg_role
           FROM ledger_postings lp
           INNER JOIN ledger_journal_batches b ON b.id = lp.batch_id
           WHERE lp.account_id IN (${placeholders})
           ORDER BY b.created_at DESC, lp.created_at DESC
           LIMIT 200`
        )
        .bind(...accountIds)
        .all<RawPostingJoinBatchRow>();

      const groupedByBatch = new Map<
        string,
        {
          first: RawPostingJoinBatchRow;
          creditUnits: bigint;
          debitUnits: bigint;
          legRoles: Set<string>;
        }
      >();

      for (const row of allPostingsResult.results ?? []) {
        const amt = fromSqlInteger(row.amount_units, 'amount_units');

        if (!usedSqlAggregates) {
          if (row.leg_role === 'USER_WITHDRAWAL_LOCK' && row.journal_type === 'WITHDRAWAL_LOCK') {
            if (row.status === 'INFLIGHT') {
              lockedWithdrawalUnits += amt;
            } else if (row.status === 'SETTLED') {
              settledUnits += amt;
            }
          }

          if (
            row.direction === 'DEBIT' &&
            (row.journal_type === 'COMMISSION_VOID_CLAWBACK' ||
              row.journal_type === 'POST_SETTLEMENT_CLAWBACK')
          ) {
            clawedBackUnits += amt;
          }

          if (
            row.direction === 'CREDIT' &&
            row.leg_role === 'L1_AFFILIATE_COMMISSION' &&
            row.status !== 'VOIDED'
          ) {
            l1OverrideEarnedUnits += amt;
          }

          if (
            row.direction === 'CREDIT' &&
            row.leg_role === 'B2B_AGENCY_OVERRIDE' &&
            row.status !== 'VOIDED'
          ) {
            l2B2bOverrideEarnedUnits += amt;
          }
        }

        const existingGroup = groupedByBatch.get(row.batch_id);
        if (!existingGroup) {
          groupedByBatch.set(row.batch_id, {
            first: row,
            creditUnits: row.direction === 'CREDIT' ? amt : BI_ZERO,
            debitUnits: row.direction === 'DEBIT' ? amt : BI_ZERO,
            legRoles: new Set([row.leg_role]),
          });
        } else {
          if (row.direction === 'CREDIT') {
            existingGroup.creditUnits += amt;
          } else {
            existingGroup.debitUnits += amt;
          }
          existingGroup.legRoles.add(row.leg_role);
        }
      }

      for (const [batchId, group] of groupedByBatch.entries()) {
        if (group.first.journal_type === 'COMMISSION_INFLIGHT') {
          candidateCommissionBatchIds.push(batchId);
        }
        if (recentBatches.length >= 25) {
          continue;
        }

        const isCreditDominant = group.creditUnits >= group.debitUnits;
        const primaryAmount = isCreditDominant
          ? group.creditUnits - group.debitUnits
          : group.debitUnits - group.creditUnits;
        const direction: 'CREDIT' | 'DEBIT' = isCreditDominant ? 'CREDIT' : 'DEBIT';
        const batchClawback =
          group.first.journal_type === 'COMMISSION_VOID_CLAWBACK' ||
          group.first.journal_type === 'POST_SETTLEMENT_CLAWBACK'
            ? group.debitUnits
            : parseClawedBackUnitsFromMetadata(group.first.metadata);

        recentBatches.push({
          batchId,
          journalType: group.first.journal_type,
          status: group.first.status,
          stateBucket: deriveStateBucket(group.first.journal_type, group.first.status, direction),
          exchange: group.first.exchange,
          maskedTraderUid: group.first.trader_uid
            ? maskTraderUid(group.first.trader_uid)
            : null,
          userAmountUnits: primaryAmount.toString(),
          userAmountUsd: formatLedgerUnitsToUsd(primaryAmount, 2),
          userAmountUsdExact: formatLedgerUnitsToUsd(primaryAmount, 8),
          direction,
          legRoles: Array.from(group.legRoles),
          holdUntil: group.first.hold_until,
          settledTxHash: group.first.settled_tx_hash,
          clawedBackUnits: batchClawback.toString(),
          clawedBackUsd: formatLedgerUnitsToUsd(batchClawback, 2),
          createdAt: group.first.batch_created_at,
        });
      }
    }

    // 2. Cryptographic Proof-of-Rebate records (affiliate/agency + self-rebate trader batches)
    const r2 = resolveOptionalR2Bucket();
    let proofsOfRebate: ProofOfRebateRecord[] = [];
    try {
      proofsOfRebate = await listProofsOfRebateByAffiliateId(db, user.id, {
        limit: 20,
        r2,
      });
      const existingProofIds = new Set(proofsOfRebate.map((p) => p.batchId));
      for (const batchId of candidateCommissionBatchIds) {
        if (proofsOfRebate.length >= 20) {
          break;
        }
        if (existingProofIds.has(batchId)) {
          continue;
        }
        const traderProof = await getProofOfRebateByBatchId(db, batchId, { r2 });
        if (traderProof) {
          proofsOfRebate.push(traderProof);
          existingProofIds.add(batchId);
        }
      }
    } catch {
      proofsOfRebate = [];
    }

    // 3. Wallet timelock & withdrawal readiness
    let walletStatus = {
      unlocked: false,
      reason: 'NO_PAYOUT_WALLET_BOUND' as
        | 'WALLET_UNLOCKED'
        | 'WALLET_TIMELOCK_ACTIVE_48H'
        | 'NO_PAYOUT_WALLET_BOUND',
      unlockAt: null as string | null,
      walletAddress: null as string | null,
      chain: null as string | null,
    };
    try {
      const unlockRes = await isWalletUnlockedForPayout(db, user.id);
      walletStatus = {
        unlocked: unlockRes.unlocked,
        reason: unlockRes.reason,
        unlockAt: unlockRes.unlockAt,
        walletAddress: unlockRes.walletAddress ?? null,
        chain: unlockRes.chain ?? null,
      };
    } catch {
      // Default to locked if wallet tables are absent
    }

    // 4. Strictly 2-Level Partner Network (L1 Direct + L2 Sub-Affiliate; zero L3+ MLM)
    const partnerNodes = await queryTwoLevelPartnerNodes(db, user.id);
    const l1DirectCount = partnerNodes.filter((n) => n.level === 1).length;
    const l2SubAffiliateCount = partnerNodes.filter((n) => n.level === 2).length;

    const balances: PortalBalanceBucketSummary = {
      inflightUnits: inflightUnits.toString(),
      inflightUsd: formatLedgerUnitsToUsd(inflightUnits, 2),
      inflightUsdExact: formatLedgerUnitsToUsd(inflightUnits, 8),
      availableUnits: availableUnits.toString(),
      availableUsd: formatLedgerUnitsToUsd(availableUnits, 2),
      availableUsdExact: formatLedgerUnitsToUsd(availableUnits, 8),
      lockedWithdrawalUnits: lockedWithdrawalUnits.toString(),
      lockedWithdrawalUsd: formatLedgerUnitsToUsd(lockedWithdrawalUnits, 2),
      lockedWithdrawalUsdExact: formatLedgerUnitsToUsd(lockedWithdrawalUnits, 8),
      settledUnits: settledUnits.toString(),
      settledUsd: formatLedgerUnitsToUsd(settledUnits, 2),
      settledUsdExact: formatLedgerUnitsToUsd(settledUnits, 8),
      clawedBackUnits: clawedBackUnits.toString(),
      clawedBackUsd: formatLedgerUnitsToUsd(clawedBackUnits, 2),
      clawedBackUsdExact: formatLedgerUnitsToUsd(clawedBackUnits, 8),
      minimumWithdrawalUnits: MIN_WITHDRAWAL_UNITS_1E8.toString(),
      minimumWithdrawalUsd: formatLedgerUnitsToUsd(MIN_WITHDRAWAL_UNITS_1E8, 2),
      canWithdraw: availableUnits >= MIN_WITHDRAWAL_UNITS_1E8 && walletStatus.unlocked,
    };

    const partnerTree: TwoLevelPartnerTreeSummary = {
      maxAllowedDepth: 2,
      l1DirectCount,
      l2SubAffiliateCount,
      l1OverrideEarnedUnits: l1OverrideEarnedUnits.toString(),
      l1OverrideEarnedUsd: formatLedgerUnitsToUsd(l1OverrideEarnedUnits, 2),
      l2B2bOverrideEarnedUnits: l2B2bOverrideEarnedUnits.toString(),
      l2B2bOverrideEarnedUsd: formatLedgerUnitsToUsd(l2B2bOverrideEarnedUnits, 2),
      nodes: partnerNodes,
    };

    return NextResponse.json(
      {
        success: true,
        balances,
        walletStatus,
        recentBatches,
        proofsOfRebate,
        partnerTree,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
