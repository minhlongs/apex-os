import {
  toMinorUnits,
  fromMinorUnits,
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
