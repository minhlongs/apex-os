/**
 * Money module -- exact integer minor-unit arithmetic.
 *
 * Every amount crossing a boundary (webhook ingestion, payout execution,
 * display) comes through here. `parse.ts` owns inbound conversion, `format.ts`
 * owns outbound rendering, `split.ts` owns tier division, and no other file in
 * the codebase performs arithmetic on a money value.
 */

export { MoneyError } from './types';
export type { MoneyErrorKind, MinorUnits } from './types';

export { USDC_DECIMALS, USDC_SCALE, RATE_SCALE } from './constants';

export { toMinorUnits, fromMinorUnits, assertNonNegative, minorUnits, usdc } from './parse';

export { formatMinorUnits, formatUsdc } from './format';
export type { FormatOptions } from './format';

export { splitCommission } from './split';
export type { TierRateParts, TierShare } from './split';
