/**
 * Business Metrics Utilities
 * Shared functions for parsing, aggregating, and formatting metrics
 */

import type { BusinessMetricsResponse, BusinessMetricsQueryParams } from '@/types/metrics';

// ============================================================================
// Query Parameter Parsing
// ============================================================================

/**
 * Parse and validate query parameters from NextRequest
 */
export function parseQueryParams(request: any): BusinessMetricsQueryParams & { startDateObj: Date; endDateObj: Date } {
  const url = new URL(request.url);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const startDate = url.searchParams.get('start_date');
  const endDate = url.searchParams.get('end_date');
  const groupBy = url.searchParams.get('group_by') as 'daily' | 'weekly' | 'monthly' | 'all' | null;
  const dealType = url.searchParams.get('deal_type');
  const exchange = url.searchParams.get('exchange');
  const status = url.searchParams.get('status') as 'approved' | 'pending' | 'all' | null;

  // Parse dates with validation
  const startDateObj = startDate ? new Date(startDate) : thirtyDaysAgo;
  const endDateObj = endDate ? new Date(endDate) : now;

  if (isNaN(startDateObj.getTime()) || isNaN(endDateObj.getTime())) {
    throw new Error('Invalid date format. Use YYYY-MM-DD');
  }

  if (startDateObj > endDateObj) {
    throw new Error('start_date must be before end_date');
  }

  return {
    start_date: startDateObj.toISOString().split('T')[0],
    end_date: endDateObj.toISOString().split('T')[0],
    group_by: groupBy || 'daily',
    deal_type: dealType || undefined,
    exchange: exchange || undefined,
    status: status || 'approved',
    startDateObj,
    endDateObj,
  };
}

// ============================================================================
// Summary Building
// ============================================================================

/**
 * Build overall summary from aggregated data
 */
export function buildSummary(
  params: BusinessMetricsQueryParams & { startDateObj: Date; endDateObj: Date },
  dailyRevenue: BusinessMetricsResponse['daily_revenue'],
  activeAffiliates: BusinessMetricsResponse['active_affiliates'],
  topDeals: BusinessMetricsResponse['top_deals']
): BusinessMetricsResponse['summary'] {
  const totalRevenue = dailyRevenue.reduce((sum, d) => sum + d.revenue, 0);
  const totalConversions = dailyRevenue.reduce((sum, d) => sum + d.conversions, 0);
  const totalCommission = dailyRevenue.reduce((sum, d) => sum + d.commission_paid, 0);

  // Calculate overall conversion rate (approximation based on revenue and avg order value)
  const totalClicks = dailyRevenue.reduce((sum, d) => {
    const avgOrderValue = d.average_order_value || 100;
    const clicks = d.conversions > 0 && d.commission_rate_percent > 0
      ? d.conversions / (d.commission_rate_percent / 100)
      : 0;
    return sum + clicks;
  }, 0);

  const overallConversionRate = totalClicks > 0 ? (totalConversions / totalClicks) * 100 : 0;

  // Find top deal
  const topDeal = topDeals?.deals[0];
  const topAffiliate = activeAffiliates?.top_performers[0];

  return {
    period_start: params.start_date,
    period_end: params.end_date,
    total_revenue: Math.round(totalRevenue * 100) / 100,
    total_conversions: totalConversions,
    overall_conversion_rate: Math.round(overallConversionRate * 100) / 100,
    active_affiliates_count: activeAffiliates?.total_affiliates || 0,
    total_commission_liability: Math.round(totalCommission * 100) / 100,
    top_deal_name: topDeal?.name || 'N/A',
    top_affiliate_name: topAffiliate?.full_name || topAffiliate?.email || 'N/A',
  };
}

// ============================================================================
// Date Utilities
// ============================================================================

/**
 * Format date for SQLite date queries
 */
export function formatDateForQuery(date: Date): string {
  return date.toISOString().split('T')[0];
}

/**
 * Check if a date is within range
 */
export function isDateInRange(
  date: string | Date,
  startDate: Date,
  endDate: Date
): boolean {
  const dateObj = typeof date === 'string' ? new Date(date) : date;
  return dateObj >= startDate && dateObj <= endDate;
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format currency value
 */
export function formatCurrency(value: number, currency: string = 'USD'): string {
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency,
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(value);
}

/**
 * Format percentage value
 */
export function formatPercentage(value: number, decimals: number = 2): string {
  return `${value.toFixed(decimals)}%`;
}

/**
 * Format large numbers with K/M suffixes
 */
export function formatCompactNumber(value: number): string {
  if (value >= 1000000) {
    return `${(value / 1000000).toFixed(1)}M`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toFixed(1)}K`;
  }
  return value.toString();
}
