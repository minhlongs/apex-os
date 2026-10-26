import {
  splitCommission,
  toMinorUnits,
  fromMinorUnits,
  percentOf,
} from '../money';

describe('T1.7 — Minor-unit BigInt exactness & conservation above 2^53', () => {
  const RATES = { tier1_rate: 0.30, tier2_rate: 0.10, tier3_rate: 0.05 };

  it('conserves exact minor units for > 2^53 (9007199254740993 and 9007199254740995)', () => {
    const aboveMaxSafe1 = BigInt('9007199254740993'); // 2^53 + 1
    const aboveMaxSafe2 = BigInt('9007199254740995'); // 2^53 + 3
    const maxSafeEven = BigInt('9007199254740992');

    for (const raw of [aboveMaxSafe1, aboveMaxSafe2]) {
      const m = toMinorUnits(raw);
      expect(fromMinorUnits(m)).toBe(raw);
      expect(fromMinorUnits(m)).not.toBe(maxSafeEven);

      const split = splitCommission(m, RATES);
      const t1 = fromMinorUnits(split.tier1);
      const t2 = fromMinorUnits(split.tier2);
      const t3 = fromMinorUnits(split.tier3);
      const retained = raw - (t1 + t2 + t3);
      expect(t1 + t2 + t3 + retained).toBe(raw);

      const fee = fromMinorUnits(percentOf(m, 1));
      const net = raw - fee;
      expect(fee + net).toBe(raw);
    }
  });
});
