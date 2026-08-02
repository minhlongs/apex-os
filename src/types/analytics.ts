/**
 * Analytics Types — Sprint 3 additions
 * Funnel metrics and exchange breakdown types
 */

// ============================================================================
// Cloudflare Analytics Types (used by admin dashboard)
// ============================================================================
export interface AnalyticsOverview {
  pageViews: number;
  uniqueVisitors: number;
  requests: number;
  bounceRate: number;
  avgPageViewsPerVisitor: number;
  dataTransfer: number;
}

export interface AnalyticsTimeSeriesData {
  date: string;
  pageViews: number;
  uniqueVisitors: number;
  requests: number;
}

export interface AnalyticsTopPages {
  url: string;
  pageViews: number;
  uniqueVisitors: number;
}

export interface AnalyticsReferrers {
  referrer: string;
  visits: number;
  percentage?: number;
}

export interface AnalyticsCountries {
  country: string;
  countryCode: string;
  visits: number;
  percentage?: number;
}

export interface AnalyticsDevices {
  device: string;
  visits: number;
  percentage?: number;
}

// ============================================================================
// Funnel Metrics Types
// ============================================================================

export interface FunnelStage {
  stage: 'visit' | 'click' | 'signup' | 'activation' | 'conversion';
  label: string;
  count: number;
  dropoff_rate: number;
  conversion_to_next: number;
}

export interface FunnelMetrics {
  period: { start_date: string; end_date: string };
  stages: FunnelStage[];
  overall_click_to_conversion_rate: number;
  overall_activation_rate: number;
  avg_seconds_to_click: number;
  avg_seconds_to_conversion: number;
}

export interface ClickToConversionDaily {
  date: string;
  total_clicks: number;
  unique_clicks: number;
  total_conversions: number;
  unique_converters: number;
  click_to_conversion_rate: number;
  avg_time_to_conversion_seconds: number;
}

export interface ActivationMetrics {
  period: { start_date: string; end_date: string };
  total_visitors: number;
  total_signups: number;
  total_activations: number;
  signup_rate: number;
  activation_rate: number;
  click_to_signup_rate: number;
}

// ============================================================================
// Exchange Metrics Types
// ============================================================================

export interface AnalyticsResponse {
  success: boolean;
  result: {
    overview?: AnalyticsOverview;
    timeseries?: AnalyticsTimeSeriesData[];
    top_pages?: AnalyticsTopPages[];
    referrers?: AnalyticsReferrers[];
    countries?: AnalyticsCountries[];
    devices?: AnalyticsDevices[];
    browsers?: AnalyticsBrowserInfo[];
  };
}

export interface AnalyticsBrowserInfo {
  browser: string;
  visits: number;
  percentage?: number;
}

export interface ExchangeBreakdown {
  exchange: string;
  period: { start_date: string; end_date: string };
  total_volume: number;
  total_revenue: number;
  total_deals: number;
  total_clicks: number;
  total_conversions: number;
  avg_conversion_rate: number;
  top_deals: ExchangeDeal[];
}

export interface ExchangeDeal {
  deal_id: string;
  deal_name: string;
  deal_type: string;
  clicks: number;
  conversions: number;
  revenue: number;
  conversion_rate: number;
}

export interface TopTradingPair {
  pair: string;
  exchange: string;
  deal_type: string;
  total_volume: number;
  total_conversions: number;
  conversion_rate: number;
}

export interface ExchangeComparison {
  period: { start_date: string; end_date: string };
  exchanges: ExchangeSummary[];
  total_volume: number;
  total_conversions: number;
}

export interface ExchangeSummary {
  exchange: string;
  volume: number;
  conversions: number;
  clicks: number;
  revenue: number;
  conversion_rate: number;
  market_share_percent: number;
}

// ============================================================================
// Refresh Job Types
// ============================================================================

export interface RefreshResult {
  success: boolean;
  job: string;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  rows_affected: number;
  error?: string;
}

export interface RefreshStatus {
  last_refresh: string | null;
  last_success: string | null;
  last_error: string | null;
  refresh_count: number;
  error_count: number;
  views_status: Record<string, { last_refresh: string | null; row_count: number }>;
}

// ============================================================================
// Query Builder Types (for analytics/query-builder.ts)
// ============================================================================

export interface DealsAnalyticsFilters {
  date_from?: string;
  date_to?: string;
  limit?: number;
  page?: number;
  exchange?: string;
  deal_id?: string;
}

export interface AffiliatesAnalyticsFilters {
  date_from?: string;
  date_to?: string;
  top?: number;
  affiliate_id?: string;
}

export interface FunnelFilters {
  date_from?: string;
  date_to?: string;
}

export interface ExchangesFilters {
  date_from?: string;
  date_to?: string;
}

export interface DailyDealRow {
  date: string;
  deal_id: string;
  exchange: string;
  clicks: number;
  conversions: number;
  revenue: number;
  commission: number;
}

export interface DailyAffiliateRow {
  date: string;
  affiliate_id: string;
  email: string;
  clicks: number;
  conversions: number;
  revenue: number;
  commission: number;
}

export interface ExchangeBreakdownRow {
  exchange: string;
  total_volume: number;
  total_revenue: number;
  total_deals: number;
  total_clicks: number;
  total_conversions: number;
  avg_conversion_rate: number;
}

export interface TopPairRow {
  pair: string;
  exchange: string;
  total_volume: number;
  total_conversions: number;
  conversion_rate: number;
}

export interface FunnelDailyRow {
  date: string;
  stage_visits: number;
  stage_clicks: number;
  stage_signups: number;
  stage_activations: number;
  stage_conversions: number;
  click_to_conversion_rate: number;
}

export interface AnalyticsResult<T> {
  data: T[];
  total: number;
  page: number;
  page_size: number;
  query_time_ms: number;
}

export interface ApiEnvelope<T> {
  success: true;
  data: T;
  meta: { total: number; query_time_ms: number };
}
