/**
 * Asset scale constants.
 *
 * USDC and USDT both use 6 decimals on their ERC-20 contracts and on Stellar,
 * so one scale serves every chain this system pays on. A fixed 6 here is the
 * on-chain value, not a simplification: a mismatch would move a million times
 * the intended amount.
 */

/** Decimals defined by the USDC/USDT token contracts. */
export const USDC_DECIMALS = 6 as const;

/** Minor units in one whole USDC — the multiplier for every parse and format. */
export const USDC_SCALE = BigInt('1000000');

/** Denominator that converts a fractional rate into exact integer parts. */
export const RATE_SCALE = BigInt('1000000');
