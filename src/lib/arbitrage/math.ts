/**
 * Arbitrage & Yield Math Engine
 * Module: ApexOS Arbitrage Engine
 *
 * Implements high-precision fee arbitrage calculations:
 * - Gross to net fee calculations with cashback reduction
 * - Maker rebate preservation (negative maker fees)
 * - Basis point (bps) spread and fee savings percentages
 * - Monthly and annual volume benchmark savings ($10k, $50k, $250k)
 * - Opportunity taxonomy classification (VIP_PROMOTION, CASHBACK_MAX, FEE_SPREAD)
 */

import type {
  OpportunityType,
  VolumeBenchmarkSavings,
  ArbitrageMetrics,
} from '@/types/arbitrage';

export interface RateCardLike {
  vip_tier?: string;
  vipTier?: string;
  maker_fee?: number;
  makerFee?: number;
  taker_fee?: number;
  takerFee?: number;
  default_cashback_pct?: number;
  defaultCashbackPct?: number;
  promotional_discount_pct?: number;
  promotionalDiscountPct?: number;
}

/**
 * Rounds a floating point number to a fixed decimal precision
 */
export function roundTo(value: number, decimals = 4): number {
  const factor = Math.pow(10, decimals);
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

/**
 * Calculates net taker fee after applying ApexOS partner cashback reduction.
 * netTaker = grossTaker * (1 - cashbackPct / 100)
 */
export function calculateNetTakerFee(grossTakerFee: number, cashbackPct: number): number {
  if (grossTakerFee <= 0) return 0;
  const clampedCashback = Math.max(0, Math.min(100, cashbackPct));
  return roundTo(grossTakerFee * (1 - clampedCashback / 100), 6);
}

/**
 * Calculates net maker fee after applying cashback reduction.
 * If gross maker fee is negative (market maker rebate), the rebate is preserved unmodified
 * to avoid calculating cashback on negative fees.
 */
export function calculateNetMakerFee(grossMakerFee: number, cashbackPct: number): number {
  if (grossMakerFee < 0) {
    // Negative maker fee = maker rebate; rebates are not reduced by cashback
    return grossMakerFee;
  }
  const clampedCashback = Math.max(0, Math.min(100, cashbackPct));
  return roundTo(grossMakerFee * (1 - clampedCashback / 100), 6);
}

/**
 * Calculates net basis point (bps) spread between base and target exchanges.
 * spreadBps = (netBaseFee - netTargetFee) * 10,000
 */
export function calculateSpreadBps(netBaseFee: number, netTargetFee: number): number {
  const diff = netBaseFee - netTargetFee;
  return roundTo(diff * 10000, 2);
}

/**
 * Calculates relative fee savings percentage.
 * savingsPct = ((netBaseFee - netTargetFee) / netBaseFee) * 100
 * Handles zero/negative netBaseFee safely returning 0.0.
 */
export function calculateSavingsPct(netBaseFee: number, netTargetFee: number): number {
  if (netBaseFee <= 0) return 0.0;
  const diff = netBaseFee - netTargetFee;
  return roundTo((diff / netBaseFee) * 100, 2);
}

/**
 * Calculates estimated monthly and annual fee savings for a given trading volume.
 * monthlySavings = volume * (spreadBps / 10,000)
 * annualSavings = monthlySavings * 12
 */
export function calculateVolumeSavings(
  spreadBps: number,
  monthlyVolumeUsd: number
): VolumeBenchmarkSavings {
  if (monthlyVolumeUsd <= 0 || spreadBps <= 0) {
    return { monthly: 0.0, annual: 0.0 };
  }
  const monthly = roundTo(monthlyVolumeUsd * (spreadBps / 10000), 2);
  const annual = roundTo(monthly * 12, 2);
  return { monthly, annual };
}

/**
 * Computes all arbitrage metrics comparing base and target fee schedules
 */
export function calculateArbitrageMetrics(
  baseTakerFee: number,
  baseCashbackPct: number,
  targetTakerFee: number,
  targetCashbackPct: number
): ArbitrageMetrics {
  const netBaseFee = calculateNetTakerFee(baseTakerFee, baseCashbackPct);
  const netTargetFee = calculateNetTakerFee(targetTakerFee, targetCashbackPct);
  const spreadBps = calculateSpreadBps(netBaseFee, netTargetFee);
  const savingsPct = calculateSavingsPct(netBaseFee, netTargetFee);
  const cashbackAdvantage = roundTo(targetCashbackPct - baseCashbackPct, 2);

  return {
    netBaseFee,
    netTargetFee,
    spreadBps,
    savingsPct,
    cashbackAdvantage,
    savings10k: calculateVolumeSavings(spreadBps, 10000),
    savings50k: calculateVolumeSavings(spreadBps, 50000),
    savings250k: calculateVolumeSavings(spreadBps, 250000),
  };
}

/**
 * Classifies the arbitrage opportunity into one of three taxonomy types:
 * - VIP_PROMOTION: Target exchange has non-VIP0 tier, zero/negative maker fee, or promotional discount.
 * - CASHBACK_MAX: ApexOS affiliate cashback boost accounts for significant advantage (>= 15% or >= 50% net spread).
 * - FEE_SPREAD: Target exchange native raw fee schedule drives majority of savings.
 */
export function classifyOpportunity(
  baseCard: RateCardLike,
  targetCard: RateCardLike,
  metrics: ArbitrageMetrics
): OpportunityType {
  const targetVip = targetCard.vip_tier ?? targetCard.vipTier;
  const targetMaker = targetCard.maker_fee ?? targetCard.makerFee;
  const targetPromo =
    targetCard.promotional_discount_pct ?? targetCard.promotionalDiscountPct;

  // 1. VIP Promotion check: non-VIP0 tier, zero/negative maker fee promo, or promotional discount
  if (
    (targetVip && targetVip !== 'VIP0') ||
    (targetMaker !== undefined && targetMaker <= 0) ||
    (targetPromo !== undefined && targetPromo > 0)
  ) {
    return 'VIP_PROMOTION';
  }

  // 2. Cashback Max: significant cashback advantage (>= 15% delta)
  if (metrics.cashbackAdvantage >= 15.0) {
    return 'CASHBACK_MAX';
  }

  // Check if cashback contribution accounts for >= 50% of the net spread
  const netSpread = metrics.netBaseFee - metrics.netTargetFee;
  const baseTaker = baseCard.taker_fee ?? baseCard.takerFee;
  const targetTaker = targetCard.taker_fee ?? targetCard.takerFee;
  const baseCb = baseCard.default_cashback_pct ?? baseCard.defaultCashbackPct ?? 0;
  const targetCb = targetCard.default_cashback_pct ?? targetCard.defaultCashbackPct ?? 0;

  if (netSpread > 0 && baseTaker !== undefined && targetTaker !== undefined) {
    const baseCbSaving = baseTaker * (baseCb / 100);
    const targetCbSaving = targetTaker * (targetCb / 100);
    const netCbBenefit = targetCbSaving - baseCbSaving;
    if (netCbBenefit / netSpread >= 0.5) {
      return 'CASHBACK_MAX';
    }
  }

  // 3. Default: Fee Spread
  return 'FEE_SPREAD';
}
