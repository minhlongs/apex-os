/**
 * Business Metrics API Types
 * Defines response schemas for aggregated business metrics
 */

// ============================================================================
// Request Parameters
// ============================================================================

export interface BusinessMetricsQueryParams {
  /** Start date in ISO format (YYYY-MM-DD) */
  start_date?: string;
  /** End date in ISO format (YYYY-MM-DD) */
  end_date?: string;
  /** Group by: 'daily' | 'weekly' | 'monthly' | 'all' */
  group_by?: 'daily' | 'weekly' | 'monthly' | 'all';
  /** Filter by deal type (product, service, subscription, course) */
  deal_type?: string;
  /** Filter by exchange (binance, bybit, okx, kucoin) */
  exchange?: string;
  /** Include only approved conversions */
  status?: 'approved' | 'pending' | 'all';
}

// ============================================================================
// Daily Revenue Metrics
// ============================================================================

export interface DailyRevenue {
  /** Date in YYYY-MM-DD format */
  date: string;
  /** Total revenue from approved conversions in USD */
  revenue: number;
  /** Number of conversions */
  conversions: number;
  /** Number of unique customers */
  unique_customers: number;
  /** Average order value */
  average_order_value: number;
  /** Commission paid out (USD) */
  commission_paid: number;
  /** Commission rate as percentage (0-100) */
  commission_rate_percent: number;
}

// ============================================================================
// Conversion Rate Metrics
// ============================================================================

export interface ConversionRateMetrics {
  /** Date or period */
  period: string;
  /** Total number of deal clicks */
  total_clicks: number;
  /** Total number of conversions */
  total_conversions: number;
  /** Conversion rate as percentage (0-100) */
  conversion_rate: number;
  /** Unique visitors (based on session_id) */
  unique_visitors: number;
  /** Click-to-lead conversion (if lead tracking exists) */
  lead_conversion_rate?: number;
  /** Average time from click to conversion in seconds */
  avg_time_to_conversion: number;
}

// ============================================================================
// Active Affiliates Metrics
// ============================================================================

export interface AffiliateMetrics {
  /** Affiliate ID */
  id: string;
  /** Affiliate email */
  email: string;
  /** Full name */
  full_name: string | null;
  /** Affiliate level (1, 2, 3) */
  level: number;
  /** Lifetime earnings (USD) */
  lifetime_earnings: number;
  /** Pending earnings (USD) */
  pending_earnings: number;
  /** Total conversions referred */
  total_conversions: number;
  /** Total revenue generated */
  total_revenue: number;
  /** Conversion rate */
  conversion_rate: number;
  /** Total clicks from referral links */
  total_clicks: number;
  /** Active status (has activity in last 30 days) */
  is_active: boolean;
  /** Last activity date */
  last_activity_date: string | null;
  /** Number of direct referrals (level 1) */
  direct_referrals: number;
  /** Number of indirect referrals (levels 2-3) */
  indirect_referrals: number;
  /** Commission tier (0.30, 0.10, 0.05) */
  commission_rate: number;
  /** Last payout date */
  last_payout_date: string | null;
  /** Date when affiliate joined */
  joined_date: string;
}

export interface ActiveAffiliatesSummary {
  /** Total count of active affiliates */
  total_affiliates: number;
  /** Affiliates with at least one conversion */
  affiliates_with_conversions: number;
  /** New affiliates in the period */
  new_affiliates: number;
  /** Average lifetime earnings per affiliate */
  avg_lifetime_earnings: number;
  /** Top performers (top 10 by earnings) */
  top_performers: AffiliateMetrics[];
  /** Distribution by level (1, 2, 3) */
  distribution_by_level: {
    level_1: number;
    level_2: number;
    level_3: number;
  };
}

// ============================================================================
// Top Deals Metrics
// ============================================================================

export interface DealMetrics {
  /** Deal ID */
  id: string;
  /** Deal name */
  name: string;
  /** Exchange (binance, bybit, etc.) */
  exchange: string | null;
  /** Deal category */
  category: string | null;
  /** Total clicks */
  total_clicks: number;
  /** Unique clicks */
  unique_clicks: number;
  /** Total conversions */
  total_conversions: number;
  /** Conversion rate percentage */
  conversion_rate: number;
  /** Total revenue generated */
  total_revenue: number;
  /** Total commission paid/payable */
  total_commission: number;
  /** Average commission rate */
  avg_commission_rate: number;
  /** Top performing affiliate for this deal */
  top_affiliate?: {
    /** Affiliate email */
    email?: string;
  } | null;
  /** Deal is active */
  is_active: boolean;
}

export interface TopDealsResponse {
  /** Requested period */
  period: {
    start_date: string;
    end_date: string;
  };
  /** Limit applied */
  limit: number;
  /** Array of top deals sorted by revenue */
  deals: DealMetrics[];
  /** Summary statistics */
  summary: {
    total_clicks: number;
    total_conversions: number;
    total_revenue: number;
    avg_conversion_rate: number;
  };
}

// ============================================================================
// Main Business Metrics Response
// ============================================================================

export interface BusinessMetricsResponse {
  /** Request timestamp */
  generated_at: string;
  /** Query parameters used */
  query: BusinessMetricsQueryParams;
  /** Cached indicator */
  cached: boolean;
  /** Cache TTL remaining (seconds) */
  cache_ttl_remaining?: number;

  /** Daily revenue aggregations */
  daily_revenue?: DailyRevenue[];

  /** Conversion rate metrics */
  conversion_rates?: ConversionRateMetrics[];

  /** Active affiliates summary */
  active_affiliates?: ActiveAffiliatesSummary;

  /** Top deals by performance */
  top_deals?: TopDealsResponse;

  /** Overall summary */
  summary?: {
    /** Period start date */
    period_start: string;
    /** Period end date */
    period_end: string;
    /** Total revenue across all deals */
    total_revenue: number;
    /** Total conversions */
    total_conversions: number;
    /** Overall conversion rate */
    overall_conversion_rate: number;
    /** Active affiliates count */
    active_affiliates_count: number;
    /** Total commission liability */
    total_commission_liability: number;
    /** Top deal by revenue */
    top_deal_name: string;
    /** Top affiliate by earnings */
    top_affiliate_name: string;
  };
}

// ============================================================================
// Cache Configuration
// ============================================================================

export interface MetricsCacheConfig {
  /** Cache TTL in seconds */
  ttl: number;
  /** Cache key prefix */
  prefix: string;
  /** Whether to use distributed cache (KV) */
  use_distributed: boolean;
  /** Stale-while-revalidate TTL in seconds */
  swr_ttl: number;
}

export const METRICS_CACHE_CONFIG: MetricsCacheConfig = {
  ttl: 300, // 5 minutes for business metrics (fresh data)
  swr_ttl: 600, // 10 minutes stale-while-revalidate
  prefix: 'metrics:business',
  use_distributed: true, // Use Cloudflare KV for cross-instance caching
};

// ============================================================================
// Rate Limiting Configuration
// ============================================================================

export const METRICS_ENDPOINT_CONFIG = {
  endpointType: 'admin_metrics',
  maxRequests: 100, // per hour for authenticated admin
  windowSeconds: 3600,
  appliesTo: 'user' as const,
  roleMultiplier: {
    admin: 1.0,
    super_admin: 2.0,
  },
  description: 'Business metrics API - admin only, 100 req/hour',
  isActive: true,
};

// ============================================================================
// Time-Series Metrics Types
// ============================================================================

/**
 * Time interval for aggregation
 */
export type TimeInterval = 'hour' | 'day' | 'week' | 'month';

/**
 * Metric type for time-series data
 */
export type TimeSeriesMetricType =
  | 'conversions'
  | 'revenue'
  | 'clicks'
  | 'earnings'
  | 'payouts'
  | 'conversion_rate'
  | 'unique_affiliates';

/**
 * Aggregated data point for a time interval
 */
export interface TimeSeriesDataPoint {
  /** ISO 8601 date string for the interval */
  date: string;
  /** Aggregated value */
  value: number;
  /** Optional: additional metrics for this point */
  metadata?: {
    count?: number;
    uniqueCount?: number;
    avgValue?: number;
  };
}

/**
 * Response format for time-series metrics API
 */
export interface TimeSeriesResponse {
  /** Request parameters echoed back */
  meta: {
    metric: TimeSeriesMetricType;
    startDate: string;
    endDate: string;
    interval: TimeInterval;
    totalDataPoints: number;
  };
  /** Array of labels (dates) for charts */
  labels: string[];
  /** Array of values matching labels */
  values: number[];
  /** Raw data points with full details */
  data: TimeSeriesDataPoint[];
  /** Summary statistics */
  summary: {
    total: number;
    average: number;
    min: number;
    max: number;
    trend: 'up' | 'down' | 'stable';
    trendPercentage: number;
  };
}

/**
 * Database row type for aggregated time-series queries
 */
export interface AggregatedMetricRow {
  date: string;
  value: number;
  count?: number;
  unique_count?: number;
  avg_value?: number;
}

/**
 * Chart-friendly format for frontend consumption
 */
export interface ChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    color?: string;
  }>;
}

/**
 * Request query parameters for time-series endpoint
 */
export interface TimeSeriesQueryParams {
  /** Start date in ISO format (YYYY-MM-DD) */
  start: string;
  /** End date in ISO format (YYYY-MM-DD) */
  end: string;
  /** Aggregation interval */
  interval: TimeInterval;
  /** Optional: filter by specific deal ID */
  dealId?: string;
  /** Optional: filter by affiliate ID */
  affiliateId?: string;
  /** Optional: filter by conversion status */
  status?: 'pending' | 'approved' | 'rejected' | 'refunded';
  /** Optional: metric to aggregate */
  metric?: TimeSeriesMetricType;
}

/**
 * Metric definitions for time-series data
 */
export const TIME_SERIES_METRIC_DEFINITIONS: Record<
  TimeSeriesMetricType,
  {
    label: string;
    description: string;
    table: string;
    valueColumn: string;
    dateColumn: string;
    defaultInterval: TimeInterval;
    minInterval: TimeInterval;
  }
> = {
  conversions: {
    label: 'Conversions',
    description: 'Number of completed conversions',
    table: 'conversions',
    valueColumn: 'COUNT(*)',
    dateColumn: 'converted_at',
    defaultInterval: 'day',
    minInterval: 'hour',
  },
  revenue: {
    label: 'Revenue',
    description: 'Total revenue from conversions',
    table: 'conversions',
    valueColumn: 'SUM(COALESCE(revenue, 0))',
    dateColumn: 'converted_at',
    defaultInterval: 'day',
    minInterval: 'hour',
  },
  clicks: {
    label: 'Clicks',
    description: 'Number of deal clicks',
    table: 'deal_clicks',
    valueColumn: 'COUNT(*)',
    dateColumn: 'created_at',
    defaultInterval: 'day',
    minInterval: 'hour',
  },
  earnings: {
    label: 'Earnings',
    description: 'Total earnings paid to affiliates',
    table: 'earnings',
    valueColumn: 'SUM(amount)',
    dateColumn: 'created_at',
    defaultInterval: 'day',
    minInterval: 'day',
  },
  payouts: {
    label: 'Payouts',
    description: 'Total payout amount',
    table: 'payouts',
    valueColumn: 'SUM(COALESCE(net_amount, 0))',
    dateColumn: 'paid_at',
    defaultInterval: 'day',
    minInterval: 'day',
  },
  conversion_rate: {
    label: 'Conversion Rate',
    description: 'Conversion rate (conversions / clicks)',
    table: 'combined',
    valueColumn: 'CASE WHEN clicks > 0 THEN conversions * 100.0 / clicks ELSE 0 END',
    dateColumn: 'converted_at',
    defaultInterval: 'day',
    minInterval: 'day',
  },
  unique_affiliates: {
    label: 'Unique Affiliates',
    description: 'Number of unique affiliates with activity',
    table: 'conversions',
    valueColumn: 'COUNT(DISTINCT affiliate_id)',
    dateColumn: 'converted_at',
    defaultInterval: 'day',
    minInterval: 'day',
  },
};
