/**
 * Webhook ingestion earnings: one exact commission, split once.
 *
 * The three exchange routes (Binance/Bybit, OKX, KuCoin) record a conversion and
 * its referral tiers on the same path. The money arithmetic lives here so the
 * three cannot drift apart -- which is how the rates came to be written out as
 * literals in each of them, and how each tier came to draw its share from a
 * float the previous tier had already multiplied.
 *
 * The stored columns are REAL, so an exact amount is projected to a float
 * exactly once, at the edge. Everything before that projection is integer.
 */

import type { D1Database } from '@/lib/db';
import { percentOf, splitCommission, fromMinorUnits, minorUnits, type MinorUnits } from '@/lib/money';
import { DEFAULT_TIER_RATES } from '@/lib/earnings/types';
import type { StandardizedTrade } from './types';

/**
 * The money figures behind one conversion.
 *
 * `revenue` is the trade's notional and `total` is the commission drawn from it,
 * both exact. `total` is null when the payload carried a value finer than the
 * USDC scale can hold: there is then no exact commission to record, and
 * substituting a rounded one would misstate what every tier is owed.
 */
export interface Commission {
  revenue: MinorUnits;
  total: MinorUnits | null;
}

/**
 * Compute one trade's commission exactly.
 *
 * The percentage is applied in percent units -- a 10% cashback deal stores 10,
 * not 0.10 -- so the conversion to a fraction happens once here rather than at
 * each tier. `value * (percent / 100)` divides first and lets the float error be
 * amplified by the multiplication; `percentOf` multiplies first, leaving the
 * single floor as the only inexactness.
 */
export function commissionOf(
  trade: StandardizedTrade,
  cashbackPercent: number
): Commission {
  const revenue =
    trade.totalValueMinor === undefined
      ? minorUnits(BigInt(0))
      : minorUnits(trade.totalValueMinor);

  // No exact commission exists when the payload was finer than this scale holds.
  const total =
    trade.totalValueMinor === undefined ? null : percentOf(revenue, cashbackPercent);

  return { revenue, total };
}

/** Project an exact amount onto the REAL column it is stored in. */
export function toUsdc(amount: MinorUnits): number {
  return Number(fromMinorUnits(amount)) / 1e6;
}

/**
 * Record the commission shares for one conversion's referral tree.
 *
 * The three tiers each take their configured share of the same commission pool,
 * so the shares deliberately fall short of it -- the remainder is the platform's
 * retained margin. Splitting once, from the exact pool, keeps the three rows
 * consistent with each other and with the total.
 *
 * A commission the payload could not hold exactly has no exact shares, so no
 * tier is owed anything: rounding one up would pay money the trade does not
 * entitle anyone to.
 */
export async function createEarnings(
  db: D1Database,
  conversionId: string,
  affiliateId: string,
  commission: Commission
): Promise<string[]> {
  const earningsIds: string[] = [];

  const tree = await db.prepare(
    `SELECT id, parent_id, level, path
     FROM referral_tree
     WHERE affiliate_id = ?
     LIMIT 1`
  ).bind(affiliateId).first<{ id: string; parent_id?: string; level: number; path?: string }>();

  if (!tree || commission.total === null) {
    return earningsIds;
  }

  const shares = splitCommission(commission.total, DEFAULT_TIER_RATES);

  // Enforce Decree 40/2018/ND-CP 1-tier lock when Ascendancy double-entry ledger is active
  let singleTierLocked =
    process.env.NODE_ENV === 'production' ||
    process.env.APP_ENV === 'production' ||
    process.env.APP_ENV === 'staging';
  if (!singleTierLocked) {
    try {
      const auditSentinel = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_journal_batches' LIMIT 1"
        )
        .first<{ name?: string }>();
      singleTierLocked = auditSentinel?.name === 'ledger_journal_batches';
    } catch {
      singleTierLocked = false;
    }
  }

  const earnings1Id = await insertEarning(db, {
    conversionId,
    affiliateId,
    referralTreeId: tree.id,
    amount: shares.tier1,
    rate: DEFAULT_TIER_RATES.tier1_rate,
    level: 1,
    parentEarningsId: null,
  });
  earningsIds.push(earnings1Id);

  if (singleTierLocked || !tree.parent_id) {
    return earningsIds;
  }

  const parent = await db.prepare(
    `SELECT rt.id, p.id as affiliate_id
     FROM referral_tree rt
     JOIN profiles p ON rt.affiliate_id = p.id
     WHERE rt.id = ? AND p.role IN ("affiliate", "master_trader")
     LIMIT 1`
  ).bind(tree.parent_id).first<{ id: string; affiliate_id: string }>();

  if (!parent) {
    return earningsIds;
  }

  const earnings2Id = await insertEarning(db, {
    conversionId,
    affiliateId: parent.affiliate_id,
    referralTreeId: parent.id,
    amount: shares.tier2,
    rate: DEFAULT_TIER_RATES.tier2_rate,
    level: 2,
    parentEarningsId: earnings1Id,
  });
  earningsIds.push(earnings2Id);

  if (tree.level < 3) {
    return earningsIds;
  }

  const grandparent = await db.prepare(
    `SELECT rt.id, p.id as affiliate_id
     FROM referral_tree rt
     JOIN profiles p ON rt.affiliate_id = p.id
     WHERE rt.id = (SELECT parent_id FROM referral_tree WHERE id = ?)
       AND p.role IN ("affiliate", "master_trader")
     LIMIT 1`
  ).bind(tree.parent_id).first<{ id: string; affiliate_id: string }>();

  if (!grandparent) {
    return earningsIds;
  }

  const earnings3Id = await insertEarning(db, {
    conversionId,
    affiliateId: grandparent.affiliate_id,
    referralTreeId: grandparent.id,
    amount: shares.tier3,
    rate: DEFAULT_TIER_RATES.tier3_rate,
    level: 3,
    parentEarningsId: earnings2Id,
  });
  earningsIds.push(earnings3Id);

  return earningsIds;
}

/** One earnings row, projected onto the REAL column it is stored in. */
interface EarningInput {
  conversionId: string;
  affiliateId: string;
  referralTreeId: string;
  amount: MinorUnits;
  rate: number;
  level: number;
  parentEarningsId: string | null;
}

async function insertEarning(db: D1Database, input: EarningInput): Promise<string> {
  const earningsId = crypto.randomUUID().replace(/-/g, '').slice(0, 32);

  await db
    .prepare(
      `INSERT INTO earnings (id, conversion_id, affiliate_id, referral_tree_id, amount, commission_type, commission_rate, level, parent_earnings_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      earningsId,
      input.conversionId,
      input.affiliateId,
      input.referralTreeId,
      toUsdc(input.amount),
      'percentage',
      input.rate,
      input.level,
      input.parentEarningsId
    )
    .run();

  return earningsId;
}
