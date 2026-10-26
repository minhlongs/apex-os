/**
 * Earnings Calculator Types
 * ApexOS Affiliate Cashback System
 */

/**
 * Referral tree node with level information
 * Maps to the referral_tree database table
 */
export interface ReferralNode {
  /** Referral tree record ID (primary key) */
  id: string;
  /** Affiliate profile ID (foreign key to profiles) */
  affiliate_id: string;
  /** Parent referral tree ID */
  parent_id: string | null;
  /** Root referral tree ID */
  root_id: string;
  /** Level in the tree (1 = direct referral, 2 = indirect, 3 = third level) */
  level: number;
  /** Full path of affiliate IDs from root to this node */
  path: string;
  /** Whether this node is active */
  is_active: number;
}

/**
 * Conversion from exchange webhook
 */
export interface Conversion {
  id: string;
  deal_id: string;
  deal_click_id: string | null;
  affiliate_code: string | null;
  affiliate_id: string;
  customer_id: string | null;
  order_id: string | null;
  revenue: number;
  currency: string;
  commission_amount: number;
  commission_type: 'percentage' | 'fixed';
  conversion_type: 'sale' | 'lead' | 'signup' | 'install';
  status: 'pending' | 'approved' | 'rejected' | 'refunded';
  conversion_data: string; // JSON string
  converted_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  refunded_at: string | null;
  notes: string | null;
}

/**
 * Profile for earnings calculation
 */
export interface AffiliateProfile {
  id: string;
  email: string;
  full_name: string | null;
  role: 'shopper' | 'affiliate' | 'admin' | 'master_trader';
  referral_code: string | null;
}

/**
 * Tier commission rates configuration
 */
export interface TierRates {
  /** Direct referral commission rate (level 1) */
  tier1_rate: number;
  /** Second level referral commission rate */
  tier2_rate: number;
  /** Third level referral commission rate */
  tier3_rate: number;
}

/**
 * Default tier rates: 30% / 10% / 5%
 */
export const DEFAULT_TIER_RATES: TierRates = {
  tier1_rate: 0.30,
  tier2_rate: 0.10,
  tier3_rate: 0.05,
};

/**
 * Earnings record to be inserted into database
 */
export interface EarningsRecord {
  id: string;
  conversion_id: string;
  affiliate_id: string;
  referral_tree_id: string | null;
  amount: number;
  commission_type: 'percentage' | 'fixed';
  commission_rate: number | null;
  level: number;
  parent_earnings_id: string | null;
  earnings_period_start: string | null;
  earnings_period_end: string | null;
  is_paid: number;
  paid_at: string | null;
  payout_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Batch processing options
 */
export interface BatchOptions {
  /** Maximum number of conversions to process per batch */
  batch_size: number;
  /** Only process conversions after this timestamp */
  start_date: string | null;
  /** Only process conversions before this timestamp */
  end_date: string | null;
  /** Minimum commission amount to process */
  min_commission_amount: number;
  /** Whether to skip already processed conversions */
  skip_existing: boolean;
}

/**
 * Batch job progress tracking
 */
export interface BatchJobProgress {
  job_id: string;
  total_conversions: number;
  processed_conversions: number;
  total_earnings_generated: number;
  earnings_count: number;
  errors: BatchError[];
  started_at: string;
  completed_at: string | null;
  status: 'pending' | 'running' | 'completed' | 'failed';
}

/**
 * Batch error record
 */
export interface BatchError {
  conversion_id: string;
  affiliate_id: string;
  message: string;
  details?: Record<string, unknown>;
}

/**
 * Earnings summary for an affiliate
 */
export interface AffiliateEarningsSummary {
  affiliate_id: string;
  affiliate_name: string;
  affiliate_email: string;
  total_earnings: number;
  pending_earnings: number;
  paid_earnings: number;
  conversions_count: number;
  breakdown: EarningsLevelBreakdown[];
  last_earnings_at: string | null;
}

/**
 * Level breakdown in earnings summary
 */
export interface EarningsLevelBreakdown {
  level: number;
  count: number;
  total_amount: number;
  avg_amount: number;
}

/**
 * Referral tree lookup result
 */
export interface ReferralLookup {
  affiliate_id: string;
  level: number;
  path: string;
  root_id: string;
  referral_tree_id: string;
}

/**
 * Calculated earning for a single affiliate from a conversion
 */
export interface CalculatedEarning {
  conversion_id: string;
  affiliate_id: string;
  amount: number;
  /** 1 = direct referral, 2 = second level, 3 = third level. Only these three
   *  values exist, because the referral tree is capped at three levels. */
  level: 1 | 2 | 3;
  referral_tree_id: string;
  commission_rate: number;
}

/**
 * Batch job result summary
 */
export interface BatchJobResult {
  job_id: string;
  success: boolean;
  conversions_processed: number;
  earnings_created: number;
  total_amount: number;
  errors: BatchError[];
  started_at: string;
  completed_at: string;
  duration_ms: number;
}

/**
 * Input for batch earnings calculation
 */
export interface BatchCalculationInput {
  conversions: Conversion[];
  referral_tree: Map<string, ReferralNode>;
  profiles: Map<string, AffiliateProfile>;
  tier_rates: TierRates;
  options: BatchOptions;
}

/**
 * Database abstraction for earnings calculator
 */
export interface EarningsDatabase {
  // Conversion queries
  getPendingApprovedConversions(options: BatchOptions): Promise<Conversion[]>;
  getConversionById(id: string): Promise<Conversion | null>;
  getConversionsByAffiliate(affiliate_id: string, options: BatchOptions): Promise<Conversion[]>;

  // Profile queries
  getProfile(affiliate_id: string): Promise<AffiliateProfile | null>;

  // Referral tree queries
  getReferralTree(affiliate_id: string): Promise<ReferralNode[]>;
  getReferralNode(affiliate_id: string): Promise<ReferralNode | null>;
  getAncestors(affiliate_id: string, max_levels: number): Promise<ReferralNode[]>;

  // Earnings queries
  getExistingEarning(conversion_id: string, affiliate_id: string): Promise<EarningsRecord | null>;
  createEarning(record: Omit<EarningsRecord, 'id' | 'created_at' | 'updated_at'>): Promise<string>;
  createEarningsBatch(records: Omit<EarningsRecord, 'id' | 'created_at' | 'updated_at'>[]): Promise<string[]>;
  markEarningsPaid(earning_ids: string[], payout_id: string): Promise<number>;

  // Summary queries
  getAffiliateEarningsSummary(affiliate_id: string, period_start?: string, period_end?: string): Promise<AffiliateEarningsSummary | null>;
  getPendingEarningsByPeriod(period_start: string, period_end: string): Promise<EarningsRecord[]>;

  // Transaction support
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}
