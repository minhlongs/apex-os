import {
  toMinorUnits,
  fromMinorUnits,
  minorUnits,
  parseDecimal,
  percentOf,
  assertNonNegative,
  formatUsdc,
  MoneyError,
} from '../index';

/**
 * Boundary tests for money conversion and formatting.
 *
 * These assert the exactness guarantee rather than roundness: a value that
 * cannot be represented at this scale is refused, not approximated.
 */

describe('toMinorUnits', () => {
  it('treats 0 as zero minor units', () => {
    expect(fromMinorUnits(toMinorUnits(0))).toBe(0n);
  });

  it('treats 1n as one minor unit', () => {
    expect(fromMinorUnits(toMinorUnits(1n))).toBe(1n);
  });

  it('treats one whole USDC as exactly one million minor units', () => {
    expect(fromMinorUnits(toMinorUnits(1))).toBe(1_000_000n);
    expect(fromMinorUnits(toMinorUnits('1'))).toBe(1_000_000n);
    expect(fromMinorUnits(toMinorUnits('1.000000'))).toBe(1_000_000n);
  });

  it('reads a decimal string digit by digit, without multiplying it by a float', () => {
    // "0.1" * 1e6 is 100000.00000000001 in binary floating point, so a
    // multiplication-based parser would be off by one here.
    expect(fromMinorUnits(toMinorUnits('0.1'))).toBe(100_000n);
    expect(fromMinorUnits(toMinorUnits('0.000001'))).toBe(1n);
    expect(fromMinorUnits(toMinorUnits('0.999999'))).toBe(999_999n);
  });

  it('parses a number input that is exact at this scale', () => {
    expect(fromMinorUnits(toMinorUnits(12.5))).toBe(12_500_000n);
  });

  it('passes a bigint through unchanged', () => {
    expect(fromMinorUnits(toMinorUnits(1_000_000n))).toBe(1_000_000n);
  });

  it('refuses a value finer than the asset scale rather than truncating it', () => {
    expect(() => toMinorUnits('0.0000001')).toThrow(MoneyError);
    expect(() => toMinorUnits('0.0000001')).toThrow(/fractional digits/);
    try {
      toMinorUnits('0.1234567');
      throw new Error('expected a MoneyError');
    } catch (err) {
      expect((err as MoneyError).kind).toBe('PRECISION_LOSS');
    }
  });

  it('refuses a non-finite number', () => {
    expect(() => toMinorUnits(Number.NaN)).toThrow(MoneyError);
    expect(() => toMinorUnits(Number.POSITIVE_INFINITY)).toThrow(MoneyError);
  });

  it('preserves a negative sign so a caller can reject it deliberately', () => {
    expect(fromMinorUnits(toMinorUnits('-1.5'))).toBe(-1_500_000n);
  });

  it('rejects a value that is not numeric', () => {
    expect(() => toMinorUnits('abc')).toThrow(MoneyError);
    expect(() => toMinorUnits('')).toThrow(MoneyError);
  });
});

describe('beyond the JS safe-integer limit', () => {
  it('holds 2^53 minor units exactly', () => {
    const safe = 2n ** 53n;
    expect(fromMinorUnits(toMinorUnits(safe))).toBe(safe);
  });

  it('holds a value far beyond 2^53 exactly, where a float would drift', () => {
    const beyond = 10n ** 25n;
    expect(fromMinorUnits(toMinorUnits(beyond))).toBe(beyond);
  });
});

describe('assertNonNegative', () => {
  it('accepts zero and positive amounts', () => {
    expect(fromMinorUnits(assertNonNegative(toMinorUnits(0)))).toBe(0n);
    expect(fromMinorUnits(assertNonNegative(toMinorUnits(5)))).toBe(5_000_000n);
  });

  it('refuses a negative amount', () => {
    expect(() => assertNonNegative(toMinorUnits('-0.000001'))).toThrow(MoneyError);
    expect(() => assertNonNegative(toMinorUnits('-1'))).toThrow(/must not be negative/);
  });
});

describe('formatUsdc', () => {
  it('renders one whole USDC as "1"', () => {
    expect(formatUsdc(toMinorUnits(1))).toBe('1');
  });

  it('renders one minor unit at the full asset scale', () => {
    expect(formatUsdc(toMinorUnits('0.000001'))).toBe('0.000001');
  });

  it('renders a fractional amount without float drift', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in binary floating point.
    expect(formatUsdc(toMinorUnits('0.3'))).toBe('0.3');
    expect(formatUsdc(toMinorUnits('0.000300'))).toBe('0.0003');
  });

  it('renders zero as "0"', () => {
    expect(formatUsdc(toMinorUnits(0))).toBe('0');
  });

  it('renders a negative amount with its sign', () => {
    expect(formatUsdc(toMinorUnits('-1.25'))).toBe('-1.25');
  });

  it('renders a large amount without exponent notation', () => {
    expect(formatUsdc(toMinorUnits(1_234_567_890n))).toBe('1234.56789');
  });
});

describe('parseDecimal', () => {
  it('reads a BTC satoshi, which the USDC scale cannot hold', () => {
    expect(fromMinorUnits(parseDecimal('0.00000001'))).toBe(1n);
  });

  it('reads a whole BTC at the fixed asset scale', () => {
    expect(fromMinorUnits(parseDecimal('1'))).toBe(100_000_000n);
  });

  it('pads a coarse input up to the fixed scale instead of truncating it', () => {
    expect(fromMinorUnits(parseDecimal('0.5'))).toBe(50_000_000n);
    expect(fromMinorUnits(parseDecimal('0.12345678'))).toBe(12_345_678n);
  });

  it('keeps every parsed value on the same scale so they can be compared', () => {
    const a = parseDecimal('0.5');
    const b = parseDecimal('0.50000000');
    expect(a).toBe(b);
  });

  it('reads a negative fee', () => {
    expect(fromMinorUnits(parseDecimal('-0.00000001'))).toBe(-1n);
  });

  it('refuses a value finer than the fixed scale rather than truncating', () => {
    expect(() => parseDecimal('0.000000001')).toThrow(/fractional digits/);
    expect(() => parseDecimal('1.123456789')).toThrow(MoneyError);
  });

  it('refuses non-numeric input', () => {
    expect(() => parseDecimal('abc')).toThrow(/not a decimal/);
    expect(() => parseDecimal('')).toThrow(/empty string/);
  });

  it('accepts a bigint and a finite number', () => {
    expect(fromMinorUnits(parseDecimal(42n))).toBe(42n);
    expect(fromMinorUnits(parseDecimal(1.5))).toBe(150_000_000n);
    expect(() => parseDecimal(NaN)).toThrow(/not a finite number/);
    expect(() => parseDecimal(Infinity)).toThrow(/not a finite number/);
  });
});

describe('percentOf', () => {
  const amount = (units: bigint) => minorUnits(units);

  it('takes a percentage in percent units, not fractions', () => {
    expect(fromMinorUnits(percentOf(amount(1_000_000n), 10))).toBe(100_000n);
    expect(fromMinorUnits(percentOf(amount(1_000_000n), 0.30))).toBe(3_000n);
    expect(fromMinorUnits(percentOf(amount(1_000_000n), 30))).toBe(300_000n);
  });

  it('multiplies before dividing so the only inexactness is the final floor', () => {
    // 100 * (10 / 100) in float is not exactly 10; this must be.
    expect(fromMinorUnits(percentOf(amount(100n), 10))).toBe(10n);
    expect(fromMinorUnits(percentOf(amount(123n), 10))).toBe(12n); // 12.3 floors to 12
  });

  it('pays nothing when the percentage is finer than one minor unit', () => {
    expect(fromMinorUnits(percentOf(amount(1n), 45))).toBe(0n);
  });

  it('takes the whole amount at 100% and nothing at 0%', () => {
    expect(fromMinorUnits(percentOf(amount(7n), 100))).toBe(7n);
    expect(fromMinorUnits(percentOf(amount(7n), 0))).toBe(0n);
  });

  it('never hands back more than the amount', () => {
    for (let units = 1n; units <= 500n; units += 1n) {
      const pct = units % 101n;
      const share = fromMinorUnits(percentOf(amount(units), Number(pct)));
      expect(share <= units).toBe(true);
      expect(share >= 0n).toBe(true);
    }
  });

  it('refuses a percent outside 0..100', () => {
    expect(() => percentOf(amount(100n), 101)).toThrow(/outside the 0\.\.100/);
    expect(() => percentOf(amount(100n), -1)).toThrow(/outside the 0\.\.100/);
    expect(() => percentOf(amount(100n), NaN)).toThrow(/outside the 0\.\.100/);
  });

  it('refuses a percent finer than the rate scale', () => {
    expect(() => percentOf(amount(100n), 0.1234565)).toThrow(/finer than 6-decimal/);
  });

  it('refuses a negative amount', () => {
    expect(() => percentOf(amount(-10n), 10)).toThrow(/must not be negative/);
  });

  it('handles the full-scale maximum exactly', () => {
    const big = BigInt('10') ** BigInt(25);
    expect(fromMinorUnits(percentOf(amount(big), 100))).toBe(big);
    expect(fromMinorUnits(percentOf(amount(big), 10))).toBe(big / BigInt(10));
  });
});
