/**
 * Safe-Spread Waterfall Formula I4 (1-Tier Retail + B2B Agency Override)
 *
 * Enforces:
 * 1. Vietnam Decree 40/2018/ND-CP multi-level marketing prohibition:
 *    `tier3ShareOfSpread` is hard-locked to `'0'`; any non-zero L3 configuration
 *    immediately throws `InvalidWaterfallConfigError`.
 * 2. Solvency cap: `tier1ShareOfSpread + tier2ShareOfSpread <= 0.45`, and
 *    `tier2ShareOfSpread <= 0.10` (explicit B2B agency override only; default `'0'`).
 * 3. Exact `10^-8` USD integer conservation:
 *    `R + E_trader + E_L1 + E_L2 + E_L3 + platformNetUnits === C`, with `R`
 *    rounded UP (`ceil`) to protect the clawback pool and payout shares rounded
 *    DOWN (`floor`) so liabilities never exceed cash collected.
 */

import Decimal from 'decimal.js';
import {
  BI_ZERO,
  LEDGER_SCALE,
  LedgerDecimal,
  LedgerOverflowError,
  LedgerUnitValidationError,
  SQLITE_MAX_INT64,
} from './units';

export interface WaterfallConfig {
  /** Fraction of gross commission `C` reserved for T+7 / post-settlement clawbacks (default `'0.05'`). */
  clawbackReserveRate: string;
  /** Trader cashback share of distributable pool `D = C - R` (default `'0.50'`). */
  traderCashbackShareOfDistributable: string;
  /** L1 direct affiliate share of platform spread `S = D - E_trader` (default `'0.30'`). */
  tier1ShareOfSpread: string;
  /** B2B agency override share of spread `S` (hard-locked `'0'` by default; max `'0.10'`). */
  tier2ShareOfSpread: string;
  /** Prohibited L3 MLM tier share — MUST ALWAYS be `'0'` (Decree 40/2018/ND-CP). */
  tier3ShareOfSpread: string;
}

export interface WaterfallOptions {
  config?: Partial<WaterfallConfig>;
  /** Whether the trader has an eligible L1 referrer (defaults to `true`). */
  hasL1Referrer?: boolean;
  /** Whether an explicit B2B agency override partner applies (defaults to `true` when `tier2ShareOfSpread > 0`). */
  hasB2bAgencyPartner?: boolean;
}

export interface WaterfallBreakdown {
  cashCollectedUnits: bigint;
  reserveUnits: bigint;
  distributableUnits: bigint;
  traderCashbackUnits: bigint;
  spreadUnits: bigint;
  l1CommissionUnits: bigint;
  l2CommissionUnits: bigint;
  l3CommissionUnits: bigint;
  platformNetUnits: bigint;
  config: WaterfallConfig;
}

export class InvalidWaterfallConfigError extends Error {
  public readonly statusCode = 422;
  constructor(message: string) {
    super(message);
    this.name = 'InvalidWaterfallConfigError';
  }
}

export const DEFAULT_WATERFALL_CONFIG: Readonly<WaterfallConfig> = Object.freeze({
  clawbackReserveRate: '0.05',
  traderCashbackShareOfDistributable: '0.50',
  tier1ShareOfSpread: '0.30',
  tier2ShareOfSpread: '0',
  tier3ShareOfSpread: '0',
});

const RATE_PPM_SCALE = BigInt('1000000');
const RATE_PPM_ROUND_UP_ADDEND = BigInt('999999');
const RATE_PPM_DECIMAL = new LedgerDecimal('1000000');
const MAX_COMBINED_AFFILIATE_SHARE = new LedgerDecimal('0.45');
const MAX_B2B_OVERRIDE_SHARE = new LedgerDecimal('0.10');
const MAX_RESERVE_SHARE = new LedgerDecimal('0.50');
const MAX_TRADER_DISTRIBUTABLE_SHARE = new LedgerDecimal('0.90');
const STRICT_RATE_REGEX = /^\d+(?:\.\d{1,6})?$/;

function parseRateToPpm(
  raw: string,
  fieldName: string
): { decimal: InstanceType<typeof LedgerDecimal>; ppm: bigint } {
  if (typeof raw !== 'string') {
    throw new InvalidWaterfallConfigError(`${fieldName} must be a decimal string`);
  }
  const trimmed = raw.trim();
  if (!STRICT_RATE_REGEX.test(trimmed)) {
    throw new InvalidWaterfallConfigError(
      `${fieldName} ("${raw}") must be a non-negative decimal with at most 6 fractional digits`
    );
  }
  const dec = new LedgerDecimal(trimmed);
  if (!dec.isFinite() || dec.isNaN() || dec.isNegative() || dec.gt(1)) {
    throw new InvalidWaterfallConfigError(`${fieldName} ("${raw}") must be within [0, 1]`);
  }
  const ppmDec = dec.mul(RATE_PPM_DECIMAL);
  if (!ppmDec.isInteger()) {
    throw new InvalidWaterfallConfigError(
      `${fieldName} ("${raw}") exceeds 6-decimal rate precision`
    );
  }
  return {
    decimal: dec,
    ppm: BigInt(ppmDec.toFixed(0)),
  };
}

/**
 * Validate Safe-Spread Waterfall configuration against regulatory and solvency invariants.
 */
export function validateWaterfallConfig(
  partialConfig?: Partial<WaterfallConfig>
): WaterfallConfig {
  const merged: WaterfallConfig = {
    clawbackReserveRate:
      partialConfig?.clawbackReserveRate ?? DEFAULT_WATERFALL_CONFIG.clawbackReserveRate,
    traderCashbackShareOfDistributable:
      partialConfig?.traderCashbackShareOfDistributable ??
      DEFAULT_WATERFALL_CONFIG.traderCashbackShareOfDistributable,
    tier1ShareOfSpread:
      partialConfig?.tier1ShareOfSpread ?? DEFAULT_WATERFALL_CONFIG.tier1ShareOfSpread,
    tier2ShareOfSpread:
      partialConfig?.tier2ShareOfSpread ?? DEFAULT_WATERFALL_CONFIG.tier2ShareOfSpread,
    tier3ShareOfSpread:
      partialConfig?.tier3ShareOfSpread ?? DEFAULT_WATERFALL_CONFIG.tier3ShareOfSpread,
  };

  if (typeof merged.tier3ShareOfSpread !== 'string' || merged.tier3ShareOfSpread.trim() !== '0') {
    throw new InvalidWaterfallConfigError(
      `Decree 40/2018/ND-CP compliance violation: tier3ShareOfSpread must be hard-locked to '0' (received "${String(merged.tier3ShareOfSpread)}")`
    );
  }

  const reserve = parseRateToPpm(merged.clawbackReserveRate, 'clawbackReserveRate');
  const trader = parseRateToPpm(
    merged.traderCashbackShareOfDistributable,
    'traderCashbackShareOfDistributable'
  );
  const tier1 = parseRateToPpm(merged.tier1ShareOfSpread, 'tier1ShareOfSpread');
  const tier2 = parseRateToPpm(merged.tier2ShareOfSpread, 'tier2ShareOfSpread');
  const tier3 = parseRateToPpm(merged.tier3ShareOfSpread, 'tier3ShareOfSpread');

  if (!tier3.decimal.isZero() || tier3.ppm !== BI_ZERO) {
    throw new InvalidWaterfallConfigError(
      'Decree 40/2018/ND-CP compliance violation: L3 commission share must be strictly 0'
    );
  }

  if (tier2.decimal.gt(MAX_B2B_OVERRIDE_SHARE)) {
    throw new InvalidWaterfallConfigError(
      `tier2ShareOfSpread (${merged.tier2ShareOfSpread}) exceeds maximum B2B agency override cap of 0.10`
    );
  }

  if (tier1.decimal.plus(tier2.decimal).gt(MAX_COMBINED_AFFILIATE_SHARE)) {
    throw new InvalidWaterfallConfigError(
      `Solvency cap violation: tier1ShareOfSpread + tier2ShareOfSpread (${tier1.decimal.plus(tier2.decimal).toFixed()}) exceeds 0.45`
    );
  }

  if (reserve.decimal.gt(MAX_RESERVE_SHARE)) {
    throw new InvalidWaterfallConfigError(
      `clawbackReserveRate (${merged.clawbackReserveRate}) exceeds maximum 0.50 reserve cap`
    );
  }

  if (trader.decimal.gt(MAX_TRADER_DISTRIBUTABLE_SHARE)) {
    throw new InvalidWaterfallConfigError(
      `traderCashbackShareOfDistributable (${merged.traderCashbackShareOfDistributable}) exceeds maximum 0.90 cap`
    );
  }

  return merged;
}

/**
 * Compute Safe-Spread Waterfall I4 split in `10^-8` USD integer units.
 */
export function computeSafeSpreadWaterfall(
  cashCollectedUnits: bigint,
  options: WaterfallOptions = {}
): WaterfallBreakdown {
  if (typeof cashCollectedUnits !== 'bigint') {
    throw new LedgerUnitValidationError('cashCollectedUnits must be a bigint');
  }
  if (cashCollectedUnits < BI_ZERO) {
    throw new LedgerUnitValidationError(
      `cashCollectedUnits cannot be negative (received ${cashCollectedUnits.toString()})`
    );
  }
  if (cashCollectedUnits > SQLITE_MAX_INT64) {
    throw new LedgerOverflowError(
      `cashCollectedUnits ${cashCollectedUnits.toString()} exceeds SQLite INT64 maximum`
    );
  }

  // Always validate config first (even when C === 0) so prohibited L3 configs never pass silently.
  const config = validateWaterfallConfig(options.config);

  if (cashCollectedUnits === BI_ZERO) {
    return {
      cashCollectedUnits: BI_ZERO,
      reserveUnits: BI_ZERO,
      distributableUnits: BI_ZERO,
      traderCashbackUnits: BI_ZERO,
      spreadUnits: BI_ZERO,
      l1CommissionUnits: BI_ZERO,
      l2CommissionUnits: BI_ZERO,
      l3CommissionUnits: BI_ZERO,
      platformNetUnits: BI_ZERO,
      config,
    };
  }

  const reserveRate = parseRateToPpm(config.clawbackReserveRate, 'clawbackReserveRate');
  const traderRate = parseRateToPpm(
    config.traderCashbackShareOfDistributable,
    'traderCashbackShareOfDistributable'
  );
  const tier1Rate = parseRateToPpm(config.tier1ShareOfSpread, 'tier1ShareOfSpread');
  const tier2Rate = parseRateToPpm(config.tier2ShareOfSpread, 'tier2ShareOfSpread');

  const hasL1Referrer = options.hasL1Referrer ?? true;
  const hasB2bAgencyPartner = options.hasB2bAgencyPartner ?? tier2Rate.ppm > BI_ZERO;

  // 1. Reserve R = ceil(r_reserve * C)
  const reserveUnits =
    reserveRate.ppm === BI_ZERO
      ? BI_ZERO
      : (cashCollectedUnits * reserveRate.ppm + RATE_PPM_ROUND_UP_ADDEND) / RATE_PPM_SCALE;

  // Cross-verify R with Decimal ROUND_UP (precision: 28)
  const cDec = new LedgerDecimal(cashCollectedUnits.toString());
  const expectedReserveDec = cDec
    .mul(reserveRate.decimal)
    .toDecimalPlaces(0, Decimal.ROUND_UP);
  if (BigInt(expectedReserveDec.toFixed(0)) !== reserveUnits) {
    throw new LedgerOverflowError('Reserve ceiling calculation diverged from Decimal reference');
  }

  // 2. Distributable D = C - R
  const distributableUnits = cashCollectedUnits - reserveUnits;

  // 3. Trader cashback E_trader = floor(r_trader * D)
  const traderCashbackUnits = (distributableUnits * traderRate.ppm) / RATE_PPM_SCALE;

  // 4. Platform spread S = D - E_trader
  const spreadUnits = distributableUnits - traderCashbackUnits;

  // 5. L1 & optional B2B L2 shares of spread S (ROUND_DOWN); L3 is strictly 0
  const l1CommissionUnits = hasL1Referrer
    ? (spreadUnits * tier1Rate.ppm) / RATE_PPM_SCALE
    : BI_ZERO;
  const l2CommissionUnits =
    hasB2bAgencyPartner && tier2Rate.ppm > BI_ZERO
      ? (spreadUnits * tier2Rate.ppm) / RATE_PPM_SCALE
      : BI_ZERO;
  const l3CommissionUnits = BI_ZERO;

  // 6. Retained platform net profit = S - E_L1 - E_L2
  const platformNetUnits = spreadUnits - l1CommissionUnits - l2CommissionUnits;

  if (platformNetUnits < BI_ZERO) {
    throw new InvalidWaterfallConfigError(
      `Negative platformNetUnits (${platformNetUnits.toString()}) detected on C=${cashCollectedUnits.toString()}`
    );
  }

  // Exact conservation check: R + E_trader + E_L1 + E_L2 + E_L3 + platformNet === C
  const conservedSum =
    reserveUnits +
    traderCashbackUnits +
    l1CommissionUnits +
    l2CommissionUnits +
    l3CommissionUnits +
    platformNetUnits;

  if (conservedSum !== cashCollectedUnits) {
    throw new LedgerOverflowError(
      `Waterfall conservation invariant failed: sum=${conservedSum.toString()} !== C=${cashCollectedUnits.toString()}`
    );
  }

  // Additional sanity check for standard >= $0.01 commissions: platformNetUnits strictly > 0
  if (cashCollectedUnits >= LEDGER_SCALE / BigInt(100) && platformNetUnits <= BI_ZERO) {
    throw new InvalidWaterfallConfigError(
      `Platform net contribution must be strictly positive for commissions >= $0.01`
    );
  }

  return {
    cashCollectedUnits,
    reserveUnits,
    distributableUnits,
    traderCashbackUnits,
    spreadUnits,
    l1CommissionUnits,
    l2CommissionUnits,
    l3CommissionUnits,
    platformNetUnits,
    config,
  };
}
