/**
 * Money types — integer minor units only.
 *
 * ApexOS moves real USDC, so every amount is an exact integer count of the
 * currency's smallest unit. IEEE-754 binary fractions cannot represent most
 * decimal cent values, so two "obviously equal" sums can differ; carrying the
 * amount as an integer removes that class of arithmetic error rather than
 * papering over it with rounding at the edges.
 */

/**
 * A count of an asset's smallest indivisible unit. USDC has 6 decimals, so
 * 1_000_000n here is exactly one dollar.
 *
 * The brand makes this a nominal type: a plain `bigint` (or any other unit —
 * a rate, a fee, a block height) cannot be assigned to it or read from it
 * without an explicit conversion. That is the compile-time guard against the
 * recurring bug of applying a rate as if it were an amount.
 */
export type MinorUnits = bigint & { readonly __brand: unique symbol };

/**
 * Why a money value was refused.
 *
 * These are distinct because the correct response differs: a precision loss is
 * a caller bug to fix, a negative amount may be a legitimate reversal the
 * caller must route elsewhere, and an overflow means the value cannot be
 * counted at this scale at all.
 */
export type MoneyErrorKind = 'PRECISION_LOSS' | 'NEGATIVE' | 'OVERFLOW';

/**
 * Raised instead of silently coercing a value that money math cannot represent
 * exactly. A thrown error is recoverable and visible; a truncated amount is
 * neither.
 */
export class MoneyError extends Error {
  readonly kind: MoneyErrorKind;

  constructor(kind: MoneyErrorKind, message: string) {
    super(message);
    this.name = 'MoneyError';
    this.kind = kind;
  }
}
