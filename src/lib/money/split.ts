/**
 * Deterministic tier split.
 *
 * The referral tiers each take a bounded percentage of the same commission
 * pool (30% / 10% / 5%), so the shares deliberately do NOT sum to the pool --
 * the remainder is the platform's retained margin and must never be handed to
 * an affiliate. Float multiplication cannot promise even the shares it does
 * compute: `total * 0.30` on a total of 1 minor unit is 0.3, which floors to 0,
 * and that unit silently disappears from the ledger.
 *
 * This module multiplies in `BigInt` and divides with an explicit floor, then
 * hands tier 1 the one or two units those floors dropped -- so an uneven total
 * pays the affiliates every unit their rates entitle them to, and no more.
 * Units below the smallest representable amount stay with the platform, because
 * paying them would mean inventing money rather than moving it.
 */

import { minorUnits, assertNonNegative } from './parse';
import { MoneyError, type MinorUnits } from './types';

/** Shares for the three tiers, in minor units. */
export interface TierShare {
  tier1: MinorUnits;
  tier2: MinorUnits;
  tier3: MinorUnits;
}

/**
 * Commission rates as configured by the business -- fractions of the total.
 *
 * Rates arrive as decimals (0.30) because that is how they are configured and
 * displayed, but they are converted once, here, into exact integers so the
 * split below performs no floating-point arithmetic at all.
 */
export interface TierRateParts {
  tier1_rate: number;
  tier2_rate: number;
  tier3_rate: number;
}

/** Parts per million that represent 1.0 (100%). */
const RATE_DENOMINATOR = BigInt('1000000');

function toRateParts(rate: number): bigint {
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new MoneyError('OVERFLOW', `Tier rate ${rate} is outside the 0..1 range`);
  }

  const scaled = rate * 1e6;

  // Require the rate to land exactly on an integer number of parts per
  // million. A rate like 0.1234565 carries a 7th decimal that `Math.round`
  // would silently absorb; refuse it instead of guessing its intent.
  if (!Number.isInteger(scaled)) {
    throw new MoneyError(
      'PRECISION_LOSS',
      `Tier rate ${rate} is finer than 6-decimal fractional precision`
    );
  }

  return BigInt(scaled);
}

/** Percent units that represent 100%. */
const PERCENT_DENOMINATOR = BigInt('100');

/**
 * Take a percentage of an amount, in percent units, exactly.
 *
 * Percentages in this system are configured in percent units rather than
 * fractions -- a 10% cashback deal stores 10 -- so the conversion to a fraction
 * has to happen somewhere. `amount * (percent / 100)` does it in float, where
 * `100 * (10 / 100)` is not exactly `10`: the division runs first and the
 * binary error is then amplified by the multiplication. Rewriting it as
 * `(amount * percent) / 100` multiplies first, so the only inexactness is the
 * single floor at the end, which is the same rounding the tier split uses.
 *
 * @throws MoneyError 'OVERFLOW' when the percent is outside 0..100.
 */
export function percentOf(amount: MinorUnits, percent: number): MinorUnits {
  assertNonNegative(amount, 'Amount');

  if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
    throw new MoneyError('OVERFLOW', `Percent ${percent} is outside the 0..100 range`);
  }

  // A percentage finer than 6 decimals cannot land exactly on an integer
  // number of parts per million, so refuse it rather than round.
  const parts = percent * 1e6;
  if (!Number.isInteger(parts)) {
    throw new MoneyError(
      'PRECISION_LOSS',
      `Percent ${percent} is finer than 6-decimal fractional precision`
    );
  }

  const units = (amount as bigint) * BigInt(parts);
  return minorUnits(units / (RATE_DENOMINATOR * PERCENT_DENOMINATOR));
}

/**
 * Split a commission total across three referral tiers.
 *
 * Remainder rule: tiers 2 and 3 take the floor of their exact share, and tier 1
 * takes everything the rates entitle the affiliates to beyond those floors --
 * at most two units, since each floor drops less than one. Tier 1 absorbs it
 * because it is the largest and most audited share, and because a fractional
 * unit is a visible relative error on a small tier-2 or tier-3 payout.
 *
 * @throws MoneyError when the total is negative or a rate is unusable.
 */
export function splitCommission(total: MinorUnits, rates: TierRateParts): TierShare {
  assertNonNegative(total, 'Commission total');

  const parts1 = toRateParts(rates.tier1_rate);
  const parts2 = toRateParts(rates.tier2_rate);
  const parts3 = toRateParts(rates.tier3_rate);

  // The tiers draw on one commission pool, so their rates must not exceed the
  // whole of it. They are expected to fall short: the remainder is the
  // platform's retained margin.
  const totalParts = parts1 + parts2 + parts3;
  if (totalParts > RATE_DENOMINATOR) {
    throw new MoneyError(
      'OVERFLOW',
      `Tier rates must not exceed 1.0 of the commission pool; they sum to ${Number(totalParts) / 1e6}`
    );
  }

  const totalUnits = total as bigint;

  const tier2 = (totalUnits * parts2) / RATE_DENOMINATOR;
  const tier3 = (totalUnits * parts3) / RATE_DENOMINATOR;

  // The three shares are entitled to this many units of the pool between them.
  // It is a whole number of units, and the two floors above may have dropped a
  // unit or two of it. That residue belongs to the affiliates, so tier 1 -- the
  // largest and most audited share -- takes it.
  const entitled = (totalUnits * totalParts) / RATE_DENOMINATOR;

  const result: TierShare = {
    tier1: minorUnits(entitled - tier2 - tier3),
    tier2: minorUnits(tier2),
    tier3: minorUnits(tier3),
  };

  const shares =
    (result.tier1 as bigint) + (result.tier2 as bigint) + (result.tier3 as bigint);

  // The affiliates are paid exactly what their rates entitle them to: no unit
  // is lost to flooring, and none of the platform's retained margin is taken.
  if (shares !== entitled) {
    throw new MoneyError('OVERFLOW', 'Tier shares do not match the share the rates entitles');
  }

  return result;
}
