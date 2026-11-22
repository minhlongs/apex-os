/**
 * Atomic Double-Entry Ledger Monetary Units & Chain Scale Converters
 *
 * Internal ledger scale is signed 64-bit integer BIGINT (`10^-8` USD minor units,
 * where `100,000,000` units = `$1.00 USD`).
 *
 * All decimal parsing and ratio math use `decimal.js` configured with
 * `precision: 28` and `Decimal.ROUND_DOWN` combined with `bigint` arithmetic.
 * Safe integer binding to Cloudflare D1 / SQLite `INTEGER` enforces
 * `Number.isSafeInteger` (`<= $90,071,992.54740991` per value) and throws
 * `LedgerOverflowError` on overflow.
 */

import Decimal from 'decimal.js';

export const LedgerDecimal = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_DOWN,
});

export const BI_ZERO = BigInt(0);
export const BI_TEN = BigInt(10);
export const BI_HUNDRED = BigInt(100);

export const LEDGER_DECIMALS = 8 as const;
export const LEDGER_SCALE = BigInt('100000000');
export const LEDGER_SCALE_DECIMAL = new LedgerDecimal('100000000');

/** SQLite signed 64-bit integer ceiling (`2^63 - 1`). */
export const SQLITE_MAX_INT64 = BigInt('9223372036854775807');

/** JavaScript IEEE-754 exact safe integer ceiling (`2^53 - 1`, ~$90.07M at 1e-8 scale). */
export const JS_MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER);

/** Minimum B2B/affiliate settlement payout threshold: $10.00 USDC (`1,000,000,000` units). */
export const MIN_WITHDRAWAL_UNITS_1E8 = BigInt('1000000000');

/** Reconciliation discrepancy halt threshold: $0.01 USDC (`1,000,000` units). */
export const RECONCILIATION_TOLERANCE_UNITS_1E8 = BigInt('1000000');

const STELLAR_TOKEN_SCALE = BigInt('10000000');
const EVM_USDC_TOKEN_SCALE = BigInt('1000000');

export type SupportedSettlementChain = 'stellar' | 'arbitrum' | 'base';

export interface ChainUnitConversion {
  chain: SupportedSettlementChain;
  chainUnits: bigint;
  disbursableUnits1e8: bigint;
  formatted: string;
  decimals: 6 | 7;
  divisor: bigint;
  residualDust1e8: bigint;
}

export class LedgerOverflowError extends Error {
  public readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = 'LedgerOverflowError';
  }
}

export class LedgerUnitValidationError extends Error {
  public readonly statusCode = 400;
  constructor(message: string) {
    super(message);
    this.name = 'LedgerUnitValidationError';
  }
}

const STRICT_DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;

/**
 * Parse a non-negative USD decimal string into `10^-8` ledger `bigint` units
 * using `ROUND_DOWN` (truncating any digits finer than 8 decimals).
 */
export function parseUsdToLedgerUnits(rawDecimalString: string): bigint {
  if (typeof rawDecimalString !== 'string') {
    throw new LedgerUnitValidationError('USD amount must be a string');
  }
  const trimmed = rawDecimalString.trim();
  if (trimmed.length === 0 || !STRICT_DECIMAL_PATTERN.test(trimmed)) {
    throw new LedgerUnitValidationError(
      `Invalid non-negative decimal USD string: "${rawDecimalString}"`
    );
  }

  let dec: InstanceType<typeof LedgerDecimal>;
  try {
    dec = new LedgerDecimal(trimmed);
  } catch {
    throw new LedgerUnitValidationError(
      `Unparseable USD decimal string: "${rawDecimalString}"`
    );
  }

  if (!dec.isFinite() || dec.isNaN() || dec.isNegative()) {
    throw new LedgerUnitValidationError(
      `USD amount must be finite and non-negative: "${rawDecimalString}"`
    );
  }

  const scaled = dec.mul(LEDGER_SCALE_DECIMAL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  const units = BigInt(scaled.toFixed(0));

  if (units > SQLITE_MAX_INT64) {
    throw new LedgerOverflowError(
      `Ledger amount ${units.toString()} exceeds SQLite INT64 maximum`
    );
  }

  return units;
}

/**
 * Format `10^-8` ledger `bigint` units into a canonical fixed-point USD string
 * (8 fractional digits by default).
 */
export function formatLedgerUnitsToUsd(
  units1e8: bigint,
  fractionDigits: number = LEDGER_DECIMALS
): string {
  if (typeof units1e8 !== 'bigint') {
    throw new LedgerUnitValidationError('Ledger units must be a bigint');
  }
  if (!Number.isInteger(fractionDigits) || fractionDigits < 0 || fractionDigits > 8) {
    throw new LedgerUnitValidationError('fractionDigits must be an integer between 0 and 8');
  }

  const isNeg = units1e8 < BI_ZERO;
  const abs = isNeg ? -units1e8 : units1e8;
  const whole = abs / LEDGER_SCALE;
  const frac = (abs % LEDGER_SCALE).toString().padStart(LEDGER_DECIMALS, '0');
  const sign = isNeg ? '-' : '';

  if (fractionDigits === 0) {
    return `${sign}${whole.toString()}`;
  }
  return `${sign}${whole.toString()}.${frac.slice(0, fractionDigits)}`;
}

/**
 * Convert `bigint` ledger units to a JavaScript safe integer `number` suitable
 * for binding to Cloudflare D1 / SQLite `INTEGER` columns.
 *
 * Throws `LedgerOverflowError` if `abs(units) > Number.MAX_SAFE_INTEGER`
 * (`$90,071,992.54740991` at `10^-8` scale).
 */
export function toSafeSqlInteger(units: bigint, label = 'ledger_units'): number {
  if (typeof units !== 'bigint') {
    throw new LedgerUnitValidationError(`${label} must be a bigint`);
  }
  const abs = units < BI_ZERO ? -units : units;
  if (abs > JS_MAX_SAFE_BIGINT) {
    throw new LedgerOverflowError(
      `${label} value ${units.toString()} exceeds Number.MAX_SAFE_INTEGER (${Number.MAX_SAFE_INTEGER})`
    );
  }
  const num = Number(units);
  if (!Number.isSafeInteger(num)) {
    throw new LedgerOverflowError(`${label} failed Number.isSafeInteger check`);
  }
  return num;
}

/**
 * Convert a SQL `INTEGER` column value (`number | bigint | string`) back into
 * exact `bigint` ledger units, validating integer integrity.
 */
export function fromSqlInteger(
  raw: number | bigint | string | null | undefined,
  label = 'sql_integer'
): bigint {
  if (raw === null || raw === undefined) {
    return BI_ZERO;
  }
  if (typeof raw === 'bigint') {
    if (raw > SQLITE_MAX_INT64 || raw < -SQLITE_MAX_INT64) {
      throw new LedgerOverflowError(`${label} exceeds SQLite INT64 bounds`);
    }
    return raw;
  }
  if (typeof raw === 'number') {
    if (!Number.isSafeInteger(raw)) {
      throw new LedgerOverflowError(
        `${label} number ${String(raw)} is not a safe integer`
      );
    }
    return BigInt(raw);
  }
  if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
    const parsed = BigInt(raw.trim());
    if (parsed > SQLITE_MAX_INT64 || parsed < -SQLITE_MAX_INT64) {
      throw new LedgerOverflowError(`${label} string integer exceeds SQLite INT64 bounds`);
    }
    return parsed;
  }
  throw new LedgerUnitValidationError(`Invalid SQL integer for ${label}: ${String(raw)}`);
}

/**
 * Convert `10^-8` USD ledger units into on-chain token minor units with zero
 * floating-point arithmetic:
 * - Stellar Classic / Soroban USDC: **7 decimals** (`10^-7`, `divisor = 10`)
 * - Arbitrum One / Base ERC-20 USDC: **6 decimals** (`10^-6`, `divisor = 100`)
 *
 * Rounds down (`floor`) so on-chain payout never exceeds settled ledger balance;
 * returns `residualDust1e8` (`0..9` on Stellar, `0..99` on EVM) so dust stays
 * accounted for in the ledger.
 */
export function ledgerUnitsToChainUnits(
  units1e8: bigint,
  chain: SupportedSettlementChain
): ChainUnitConversion {
  if (typeof units1e8 !== 'bigint' || units1e8 < BI_ZERO) {
    throw new LedgerUnitValidationError(
      `Chain conversion requires non-negative bigint units; received ${String(units1e8)}`
    );
  }
  if (units1e8 > SQLITE_MAX_INT64) {
    throw new LedgerOverflowError(
      `Ledger units ${units1e8.toString()} exceed SQLite INT64 ceiling`
    );
  }

  let decimals: 6 | 7;
  let divisor: bigint;
  let scale: bigint;
  if (chain === 'stellar') {
    decimals = 7;
    divisor = BI_TEN;
    scale = STELLAR_TOKEN_SCALE;
  } else if (chain === 'arbitrum' || chain === 'base') {
    decimals = 6;
    divisor = BI_HUNDRED;
    scale = EVM_USDC_TOKEN_SCALE;
  } else {
    throw new LedgerUnitValidationError(`Unsupported settlement chain: ${String(chain)}`);
  }

  const chainUnits = units1e8 / divisor;
  const residualDust1e8 = units1e8 % divisor;
  const disbursableUnits1e8 = chainUnits * divisor;

  const whole = chainUnits / scale;
  const frac = (chainUnits % scale).toString().padStart(decimals, '0');
  const formatted = `${whole.toString()}.${frac}`;

  if (disbursableUnits1e8 + residualDust1e8 !== units1e8) {
    throw new LedgerOverflowError('Chain unit conversion failed exact conservation check');
  }

  return {
    chain,
    chainUnits,
    disbursableUnits1e8,
    formatted,
    decimals,
    divisor,
    residualDust1e8,
  };
}

/**
 * Convert a non-negative `bigint` monetary amount to a validated JavaScript safe
 * integer for D1 / SQLite `INTEGER` bindings. Rejects non-bigint, negative values,
 * values exceeding `Number.MAX_SAFE_INTEGER`, and non-safe integers.
 */
export function toSafeNonNegativeSqlInteger(units: bigint, label = 'ledger_units'): number {
  if (typeof units !== 'bigint') {
    throw new LedgerUnitValidationError(`${label} must be a bigint`);
  }
  if (units < BI_ZERO) {
    throw new LedgerUnitValidationError(`${label} must be non-negative; received ${units.toString()}`);
  }
  return toSafeSqlInteger(units, label);
}

/**
 * Compute the chain-representable portion of a withdrawal request and the exact
 * residual dust (`10^-8` units) that must remain as customer liability.
 *
 * When `requireZeroDust` is true, rejects any amount that is not an exact multiple
 * of the target chain's unit divisor (`10` for Stellar, `100` for Arbitrum/Base).
 */
export function splitChainSettlementAndDust(
  requestedUnits1e8: bigint,
  chain: SupportedSettlementChain,
  options?: { requireZeroDust?: boolean }
): ChainUnitConversion {
  const conversion = ledgerUnitsToChainUnits(requestedUnits1e8, chain);
  if (options?.requireZeroDust && conversion.residualDust1e8 !== BI_ZERO) {
    throw new LedgerUnitValidationError(
      `Amount ${requestedUnits1e8.toString()} (10^-8 units) has ${conversion.residualDust1e8.toString()} unrepresentable dust units on ${chain} (divisor ${conversion.divisor.toString()})`
    );
  }
  return conversion;
}
