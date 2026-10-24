/**
 * Decimal input -> exact minor units.
 *
 * Money enters the system from three places: exchange webhook payloads (which
 * send decimal strings like "0.000001"), operator-entered amounts (numbers),
 * and the chain adapters (bigint counts). All three land here so the conversion
 * decision -- rounding mode and when to refuse -- is written once rather than
 * re-invented at each boundary.
 */

import { MoneyError, type MinorUnits } from './types';
import { USDC_DECIMALS } from './constants';

/** Fractional digits beyond which extra digits are a precision loss. */
const MAX_FRACTION_DIGITS = USDC_DECIMALS;

/**
 * Brand an integer count of minor units.
 *
 * The only sanctioned way to produce a `MinorUnits`: every value that reaches
 * arithmetic has already passed a parse or split that guarantees exactness.
 */
export function minorUnits(value: bigint): MinorUnits {
  return value as MinorUnits;
}

/**
 * Parse a decimal amount in whole units into minor units.
 *
 * Strings are read digit by digit rather than multiplied, because `0.1 * 1e6`
 * does not equal `100000n` in binary floating point -- the multiplication
 * introduces the very drift this module exists to remove. A string with more
 * than 6 fractional digits would be silently truncated, so it is refused
 * instead: `"0.0000001"` is a real value this scale cannot hold, and quietly
 * dropping the 7th digit would misstate it.
 *
 * @throws MoneyError 'PRECISION_LOSS' when the input is finer than the scale.
 */
export function toMinorUnits(input: string | number | bigint): MinorUnits {
  if (typeof input === 'bigint') {
    return minorUnits(input);
  }
  if (typeof input === 'number') {
    return fromNumber(input);
  }
  return fromString(input);
}

function fromString(input: string): MinorUnits {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new MoneyError('PRECISION_LOSS', 'Money value is an empty string');
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  if (!/^\d*(\.\d*)?$/.test(unsigned)) {
    throw new MoneyError('PRECISION_LOSS', `Money value is not a decimal: "${input}"`);
  }

  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = wholePart === '' ? '0' : wholePart;

  if (fractionPart.length > MAX_FRACTION_DIGITS) {
    throw new MoneyError(
      'PRECISION_LOSS',
      `Money value "${input}" has ${fractionPart.length} fractional digits; ` +
        `this asset holds at most ${MAX_FRACTION_DIGITS}`
    );
  }

  const paddedFraction = fractionPart.padEnd(MAX_FRACTION_DIGITS, '0');
  const magnitude = BigInt(`${whole}${paddedFraction}`);

  return minorUnits(negative ? -magnitude : magnitude);
}

function fromNumber(input: number): MinorUnits {
  if (!Number.isFinite(input)) {
    throw new MoneyError('PRECISION_LOSS', `Money value is not a finite number: ${input}`);
  }

  // Ask for the decimal text first, then read that text exactly. Converting the
  // number straight to minor units by multiplication would inherit its binary
  // error; `Number.prototype.toString` emits the shortest decimal that
  // round-trips to this number, which is the value the caller meant.
  const parsed = fromString(input.toString());

  // Guard the round trip: if the minor-unit value does not read back as the
  // number handed in, the conversion was not faithful and must not be accepted.
  const readBack = Number(fromMinorUnits(parsed)) / 1e6;
  if (Math.abs(readBack - input) > 1e-9) {
    throw new MoneyError(
      'PRECISION_LOSS',
      `Money value ${input} cannot be represented exactly at this scale`
    );
  }

  return parsed;
}

/**
 * Drop the brand for a value already known to be an exact count of minor units,
 * such as one produced by an integer computation inside this module.
 */
export function fromMinorUnits(value: MinorUnits): bigint {
  return value as bigint;
}

/**
 * Assert an amount is zero or greater, for balances and payouts where a
 * negative would mean money moving the wrong way.
 *
 * @throws MoneyError 'NEGATIVE'
 */
export function assertNonNegative(value: MinorUnits, label = 'Money value'): MinorUnits {
  if (fromMinorUnits(value) < 0n) {
    throw new MoneyError('NEGATIVE', `${label} must not be negative`);
  }
  return value;
}

/** Convert whole USDC to minor units, for seed data and test fixtures. */
export function usdc(whole: number): MinorUnits {
  return toMinorUnits(whole);
}
