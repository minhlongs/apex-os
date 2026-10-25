import { splitCommission, toMinorUnits, fromMinorUnits, MoneyError } from '../index';
import type { MinorUnits } from '../types';

/**
 * The tiers must never overdraw the commission pool, and no unit the affiliates
 * are owed may be lost to rounding. A float implementation loses units on totals
 * it cannot divide evenly -- 30% of 1 minor unit floors to zero, and that minor unit
 * disappears from the ledger.
 */

const RATES = { tier1_rate: 0.30, tier2_rate: 0.10, tier3_rate: 0.05 };

function total(n: bigint): MinorUnits {
  return toMinorUnits(n);
}

describe('splitCommission', () => {
  it('pays nothing on a total smaller than the rates can divide', () => {
    // 1 minor unit split 30/10/5 entitles the affiliates to 0.45 units, which
    // floors to 0. The unit must not be rounded up to 1: that would pay out
    // money the rates do not entitle anyone to. It stays with the platform, and
    // the referrer genuinely earns nothing at this scale.
    const result = splitCommission(total(1n), RATES);
    expect(fromMinorUnits(result.tier1)).toBe(0n);
    expect(fromMinorUnits(result.tier2)).toBe(0n);
    expect(fromMinorUnits(result.tier3)).toBe(0n);
  });

  it('gives tier 1 the unit a floor dropped, so affiliates are never shorted', () => {
    // At 10 units the entitled share is 4.5, i.e. 4 units. Tier 2's floor is 1
    // and tier 3's is 0, which leaves tier 1 exactly 3 -- its own 3.0 floor
    // share. There is no residue here, because 10 divides cleanly enough.
    const ten = splitCommission(total(10n), RATES);
    expect(fromMinorUnits(ten.tier1)).toBe(3n);
    expect(fromMinorUnits(ten.tier2)).toBe(1n);
    expect(fromMinorUnits(ten.tier3)).toBe(0n);

    // At 3 units the entitled share is 1.35, i.e. 1 unit. Tier 2 and tier 3
    // floor to 0, so tier 1 takes the whole entitled unit.
    const three = splitCommission(total(3n), RATES);
    expect(fromMinorUnits(three.tier1)).toBe(1n);
    expect(fromMinorUnits(three.tier2)).toBe(0n);
    expect(fromMinorUnits(three.tier3)).toBe(0n);
  });

  it('never claims a unit the rates do not entitle the affiliates to', () => {
    // Across the whole range, the drawn total must equal the floored entitled
    // share -- never more, and never less than it either.
    for (let n = 1n; n <= 1000n; n += 1n) {
      const result = splitCommission(total(n), RATES);
      const drawn =
        fromMinorUnits(result.tier1) +
        fromMinorUnits(result.tier2) +
        fromMinorUnits(result.tier3);
      const entitled = (n * 450_000n) / 1_000_000n;
      expect(drawn).toBe(entitled);
    }
  });

  it('splits an evenly divisible total into the exact rate shares, retaining the margin', () => {
    const result = splitCommission(total(1000n), RATES);
    expect(fromMinorUnits(result.tier1)).toBe(300n);
    expect(fromMinorUnits(result.tier2)).toBe(100n);
    expect(fromMinorUnits(result.tier3)).toBe(50n);
    // 1000 - 300 - 100 - 50 = 550 units are the platform's retained margin.
    // The tiers drew 45% of the pool and must not draw the rest.
    const drawn =
      fromMinorUnits(result.tier1) +
      fromMinorUnits(result.tier2) +
      fromMinorUnits(result.tier3);
    expect(drawn).toBe(450n);
  });

  it('never lets the tiers overdraw the pool, at 2^53 and far beyond it', () => {
    for (const n of [2n ** 53n, 2n ** 53n + 1n, 10n ** 25n - 1n]) {
      const result = splitCommission(total(n), RATES);
      const drawn =
        fromMinorUnits(result.tier1) +
        fromMinorUnits(result.tier2) +
        fromMinorUnits(result.tier3);
      expect(drawn).toBeLessThanOrEqual(n);

      // Tier 2 and tier 3 take exactly their floor share. Tier 1 takes its own
      // floor plus at most the two units the floors dropped -- it does not
      // absorb the 55% the rates never claimed, which stays with the platform.
      const entitled = (n * 450_000n) / 1_000_000n;
      expect(fromMinorUnits(result.tier2)).toBe((n * 100_000n) / 1_000_000n);
      expect(fromMinorUnits(result.tier3)).toBe((n * 50_000n) / 1_000_000n);
      expect(fromMinorUnits(result.tier1)).toBe(
        entitled -
          (n * 100_000n) / 1_000_000n -
          (n * 50_000n) / 1_000_000n
      );
    }
  });

  it('pays nothing on a zero commission', () => {
    const result = splitCommission(total(0n), RATES);
    expect(fromMinorUnits(result.tier1)).toBe(0n);
    expect(fromMinorUnits(result.tier2)).toBe(0n);
    expect(fromMinorUnits(result.tier3)).toBe(0n);
  });

  it('refuses a negative total instead of moving money the wrong way', () => {
    expect(() => splitCommission(total(-1n), RATES)).toThrow(MoneyError);
    expect(() => splitCommission(total(-1000n), RATES)).toThrow(/must not be negative/);
  });

  it('refuses rates that draw more than the whole commission pool', () => {
    // The 30/10/5 default draws 45% and retains 55%, so a configuration that
    // sums to 0.44 is legal and one that sums past 1.0 is not.
    const undershoots = { tier1_rate: 0.30, tier2_rate: 0.10, tier3_rate: 0.04 };
    const overdrafts = { tier1_rate: 0.30, tier2_rate: 0.10, tier3_rate: 0.61 };
    expect(() => splitCommission(total(1000n), undershoots)).not.toThrow();
    expect(() => splitCommission(total(1000n), overdrafts)).toThrow(MoneyError);
    expect(() => splitCommission(total(1000n), overdrafts)).toThrow(/must not exceed/);
  });

  it('refuses a rate outside the 0..1 range', () => {
    const bad = { tier1_rate: 1.30, tier2_rate: -0.10, tier3_rate: 0.05 };
    expect(() => splitCommission(total(1000n), bad)).toThrow(MoneyError);
  });

  it('accepts rates precise to six decimals and refuses anything finer', () => {
    const exact = {
      tier1_rate: 0.123456,
      tier2_rate: 0.123456,
      tier3_rate: 0.753088,
    };
    const tooFine = {
      tier1_rate: 0.1234565,
      tier2_rate: 0.123456,
      tier3_rate: 0.753087,
    };
    expect(() => splitCommission(total(1_000_000n), exact)).not.toThrow();
    expect(() => splitCommission(total(1_000_000n), tooFine)).toThrow(MoneyError);
  });

  it('matches the float split where the old path was already exact', () => {
    // 1_000_000 minor units divides evenly, so this is the case where the
    // previous implementation and this one agree -- the change must be
    // invisible here and only differ where the old one lost units.
    const result = splitCommission(total(1_000_000n), RATES);
    expect(fromMinorUnits(result.tier1)).toBe(300_000n);
    expect(fromMinorUnits(result.tier2)).toBe(100_000n);
    expect(fromMinorUnits(result.tier3)).toBe(50_000n);
  });
});
