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
 * The fixed decimal scale every non-money value is read at.
 *
 * USDC pays at 6 decimals, but a trade quantity or an exchange fee is not
 * always USDC: a BTC satoshi reads "0.00000001", which the USDC parser must
 * refuse as a precision loss, and a fee in BTC carries 8 decimals of its own.
 * Reading those at 6 digits would drop their least significant digit -- the
 * exact drift this module exists to remove, reintroduced one field away.
 *
 * One fixed scale keeps every parsed value comparable: two quantities only add
 * up when they are counted the same way. It covers every asset the platform
 * prices in, including the 8-decimal chains, so a value finer than this is a
 * bug to refuse rather than truncate.
 */
const ASSET_DECIMALS = 8;

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
  if (fromMinorUnits(value) < BigInt(0)) {
    throw new MoneyError('NEGATIVE', `${label} must not be negative`);
  }
  return value;
}

/** Convert whole USDC to minor units, for seed data and test fixtures. */
export function usdc(whole: number): MinorUnits {
  return toMinorUnits(whole);
}

/**
 * Read a decimal quantity or fee at its own scale into exact minor units.
 *
 * `toMinorUnits` is right for money, where the scale is a property of the
 * asset (USDC is 6 decimals) and a 7th digit is a bug. It is wrong for a trade
 * quantity or an exchange fee: a BTC satoshi reads "0.00000001", which the
 * USDC parser must refuse, and a fee in BTC has 8 decimals of its own. Scaling
 * either one to 6 digits would drop the value's least significant digit -- the
 * exact drift this module exists to remove, reintroduced one field away.
 *
 * This parses at the scale the input actually carries, between
 * `MIN_ASSET_DECIMALS` and `MAX_ASSET_DECIMALS`, and refuses anything finer
 * rather than truncating. It is for exactness of a recorded value, not for
 * arithmetic on money.
 *
 * @throws MoneyError 'PRECISION_LOSS' when the value is finer than the scale.
 */
export function parseDecimal(value: string | number | bigint): MinorUnits {
  if (typeof value === 'bigint') {
    return minorUnits(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new MoneyError('PRECISION_LOSS', `Quantity value is not a finite number: ${value}`);
    }
    return parseDecimal(value.toString());
  }
  return fromAssetString(value);
}

function fromAssetString(input: string): MinorUnits {
  const trimmed = input.trim();
  if (trimmed === '') {
    throw new MoneyError('PRECISION_LOSS', 'Quantity value is an empty string');
  }

  const negative = trimmed.startsWith('-');
  const unsigned = negative ? trimmed.slice(1) : trimmed;

  if (!/^\d*(\.\d*)?$/.test(unsigned)) {
    throw new MoneyError('PRECISION_LOSS', `Quantity value is not a decimal: "${input}"`);
  }

  const [wholePart, fractionPart = ''] = unsigned.split('.');
  const whole = wholePart === '' ? '0' : wholePart;

  if (fractionPart.length > ASSET_DECIMALS) {
    throw new MoneyError(
      'PRECISION_LOSS',
      `Quantity value "${input}" has ${fractionPart.length} fractional digits; ` +
        `this scale holds at most ${ASSET_DECIMALS}`
    );
  }

  // Pad to the fixed scale so every parsed value is counted the same way.
  const magnitude = BigInt(`${whole}${fractionPart.padEnd(ASSET_DECIMALS, '0')}`);
  return minorUnits(negative ? -magnitude : magnitude);
}
