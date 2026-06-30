/**
 * Earnings Module
 * ApexOS Affiliate Cashback System
 *
 * Provides earnings calculation, batch job processing,
 * and summary statistics for the affiliate system.
 */

export {
  EarningsCalculator,
  createEarningsCalculator,
  defaultCalculator,
  BatchJobStatusCode,
} from './calculator';

export type {
  CalculatorConfig,
} from './calculator';

export {
  DEFAULT_TIER_RATES,
} from './types';

export type {
  Conversion,
  ReferralNode,
  AffiliateProfile,
  TierRates,
  BatchOptions,
  BatchJobProgress,
  BatchError,
  BatchJobResult,
  CalculatedEarning,
  AffiliateEarningsSummary,
  EarningsLevelBreakdown,
  ReferralLookup,
  EarningsRecord,
  EarningsDatabase,
} from './types';
