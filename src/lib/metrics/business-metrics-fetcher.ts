/**
 * Business Metrics Fetcher
 *
 * Shared module for fetching business metrics from the database.
 * Used by both the /api/metrics/business endpoint and the alert engine.
 *
 * This module contains pure database query functions with no HTTP dependencies.
 */

import type { D1Database } from '@/types/d1';
import type { BusinessMetricsResponse, BusinessMetricsQueryParams } from '@/types/metrics';

// ============================================================================
// Database Query Functions (extracted from /api/metrics/business)
// ============================================================================

/**
 * Fetch daily revenue data from the materialized view
 */
export async function fetchDailyRevenue(
  DB: D1Database,
  params: BusinessMetricsQueryParams & { startDateObj: Date; endDateObj: Date }
): Promise<BusinessMetricsResponse['daily_revenue']> {
  const { start_date, end_date, deal_type, exchange, status } = params;

  let query = `
    SELECT
      date as date,
      total_revenue as revenue,
      total_conversions as conversions,
      unique_customers as unique_customers,
      avg_order_value as average_order_value,
      total_commission as commission_paid,
      conversion_rate_percent as commission_rate_percent
    FROM v_daily_revenue
    WHERE date >= ? AND date <= ?
  `;

  const bindings: unknown[] = [start_date, end_date];

  // Add optional filters
  if (deal_type || exchange) {
    query = `
      SELECT
        dr.date,
        dr.revenue,
        dr.conversions,
        dr.unique_customers,
        dr.average_order_value,
        dr.commission_paid,
        dr.commission_rate_percent
      FROM v_daily_revenue dr
      JOIN conversions c ON DATE(c.converted_at) = dr.date
      JOIN deals d ON d.id = c.deal_id
      WHERE dr.date >= ? AND dr.date <= ?
    `;
    bindings.push(start_date, end_date);

    if (deal_type) {
      query += ' AND d.deal_type = ?';
      bindings.push(deal_type);
    }
    if (exchange) {
      query += ' AND d.exchange = ?';
      bindings.push(exchange);
    }
    if (status === 'approved') {
      query += ' AND c.status = ?';
      bindings.push('approved');
    } else if (status === 'pending') {
      query += ' AND c.status = ?';
      bindings.push('pending');
    }
  }

  query += ' ORDER BY date DESC';

  const result = await DB.prepare(query).bind(...bindings).all<{
    date: string;
    revenue: number;
    conversions: number;
    unique_customers: number;
    average_order_value: number;
    commission_paid: number;
    commission_rate_percent: number;
  }>();

  return result.results.map(row => ({
    date: row.date,
    revenue: row.revenue,
    conversions: row.conversions,
    unique_customers: row.unique_customers,
    average_order_value: row.average_order_value,
    commission_paid: row.commission_paid,
    commission_rate_percent: row.commission_rate_percent,
  }));
}

/**
 * Fetch conversion rate metrics from view
 */
export async function fetchConversionRates(
  DB: D1Database,
  params: BusinessMetricsQueryParams & { startDateObj: Date; endDateObj: Date }
): Promise<BusinessMetricsResponse['conversion_rates']> {
  const { start_date, end_date, deal_type, exchange } = params;

  let query = `
    SELECT
      date as period,
      unique_visitors,
      total_clicks,
      total_conversions,
      conversion_rate_percent as conversion_rate,
      avg_seconds_to_conversion as avg_time_to_conversion
    FROM v_conversion_rates
    WHERE date >= ? AND date <= ?
  `;

  const bindings: unknown[] = [start_date, end_date];

  // Apply deal/exchange filters by joining with deal_clicks and deals
  if (deal_type || exchange) {
    query = `
      SELECT
        cr.date as period,
        cr.unique_visitors,
        cr.total_clicks,
        cr.total_conversions,
        cr.conversion_rate_percent as conversion_rate,
        cr.avg_seconds_to_conversion as avg_time_to_conversion
      FROM v_conversion_rates cr
      JOIN deal_clicks dc ON DATE(dc.created_at) = cr.date
      JOIN deals d ON d.id = dc.deal_id
      WHERE cr.date >= ? AND cr.date <= ?
    `;
    bindings.push(start_date, end_date);

    if (deal_type) {
      query += ' AND d.deal_type = ?';
      bindings.push(deal_type);
    }
    if (exchange) {
      query += ' AND d.exchange = ?';
      bindings.push(exchange);
    }
  }

  // Group by period if we have joins that duplicate rows
  if (deal_type || exchange) {
    query = `
      SELECT
        period,
        MAX(unique_visitors) as unique_visitors,
        SUM(total_clicks) as total_clicks,
        SUM(total_conversions) as total_conversions,
        CASE WHEN SUM(total_clicks) > 0
          THEN ROUND((SUM(total_conversions) * 100.0 / SUM(total_clicks)), 2)
          ELSE 0
        END as conversion_rate,
        AVG(avg_time_to_conversion) as avg_time_to_conversion
      FROM (${query}) as subq
      GROUP BY period
    `;
  }

  query += ' ORDER BY period DESC';

  const result = await DB.prepare(query).bind(...bindings).all<{
    period: string;
    unique_visitors: number;
    total_clicks: number;
    total_conversions: number;
    conversion_rate: number;
    avg_time_to_conversion: number;
  }>();

  return result.results.map(row => ({
    period: row.period,
    unique_visitors: row.unique_visitors,
    total_clicks: row.total_clicks,
    total_conversions: row.total_conversions,
    conversion_rate: row.conversion_rate,
    avg_time_to_conversion: row.avg_time_to_conversion,
  }));
}

/**
 * Fetch active affiliates summary from view
 */
export async function fetchActiveAffiliates(
  DB: D1Database,
  params: BusinessMetricsQueryParams
): Promise<BusinessMetricsResponse['active_affiliates']> {
  const { start_date, end_date, deal_type, exchange } = params;
  const startDate = `${start_date}T00:00:00.000Z`;
  const endDate = `${end_date}T23:59:59.999Z`;

  // Fetch all affiliates with their metrics
  let query = `
    SELECT * FROM v_active_affiliates
    WHERE 1=1
  `;
  const bindings: unknown[] = [];

  // Filter by activity period
  if (start_date && end_date) {
    query += ` AND (last_conversion_date >= ? OR last_click_date >= ?)`;
    bindings.push(startDate, startDate);
    bindings.push(endDate, endDate);
  }

  // Apply deal type/exchange filters by joining with conversions
  if (deal_type || exchange) {
    query = `
      SELECT DISTINCT va.* FROM v_active_affiliates va
      JOIN conversions c ON c.affiliate_id = va.id
      JOIN deals d ON d.id = c.deal_id
      WHERE c.converted_at >= ? AND c.converted_at <= ?
    `;
    bindings.length = 0;
    bindings.push(startDate, endDate);

    if (deal_type) {
      query += ' AND d.deal_type = ?';
      bindings.push(deal_type);
    }
    if (exchange) {
      query += ' AND d.exchange = ?';
      bindings.push(exchange);
    }
  }

  query += ' ORDER BY lifetime_earnings DESC';

  const allAffiliates = await DB.prepare(query).bind(...bindings).all<{
    id: string;
    email: string;
    full_name: string | null;
    level: number;
    lifetime_earnings: number;
    pending_earnings: number;
    total_conversions: number;
    total_revenue: number;
    conversion_rate: number;
    total_clicks: number;
    is_active: number;
    last_click_date: string | null;
    last_conversion_date: string | null;
    total_direct_referrals: number;
    total_indirect_referrals: number;
    commission_rate: number;
    last_payout_date: string | null;
    joined_date: string;
  }>();

  const affiliates = allAffiliates.results.map(aff => ({
    id: aff.id,
    email: aff.email,
    full_name: aff.full_name,
    level: aff.level,
    lifetime_earnings: aff.lifetime_earnings,
    pending_earnings: aff.pending_earnings,
    total_conversions: aff.total_conversions,
    total_revenue: aff.total_revenue,
    conversion_rate: aff.conversion_rate,
    total_clicks: aff.total_clicks,
    is_active: aff.is_active === 1,
    last_activity_date: aff.last_conversion_date || aff.last_click_date,
    direct_referrals: aff.total_direct_referrals,
    indirect_referrals: aff.total_indirect_referrals,
    commission_rate: aff.commission_rate,
    last_payout_date: aff.last_payout_date,
    joined_date: aff.joined_date,
  }));

  // Build summary
  const totalAffiliates = affiliates.length;
  const affiliatesWithConversions = affiliates.filter(a => a.total_conversions > 0).length;
  const newAffiliates = affiliates.filter(a => {
    const joined = new Date(a.joined_date);
    return joined >= new Date(startDate) && joined <= new Date(endDate);
  }).length;

  const avgLifetimeEarnings = totalAffiliates > 0
    ? affiliates.reduce((sum, a) => sum + a.lifetime_earnings, 0) / totalAffiliates
    : 0;

  const distributionByLevel = {
    level_1: affiliates.filter(a => a.level === 1).length,
    level_2: affiliates.filter(a => a.level === 2).length,
    level_3: affiliates.filter(a => a.level === 3).length,
  };

  return {
    total_affiliates: totalAffiliates,
    affiliates_with_conversions: affiliatesWithConversions,
    new_affiliates: newAffiliates,
    avg_lifetime_earnings: Math.round(avgLifetimeEarnings * 100) / 100,
    top_performers: affiliates.slice(0, 10),
    distribution_by_level: distributionByLevel,
  };
}

/**
 * Fetch top deals performance
 */
export async function fetchTopDeals(
  DB: D1Database,
  params: BusinessMetricsQueryParams & { startDateObj: Date; endDateObj: Date },
  limit: number = 10
): Promise<BusinessMetricsResponse['top_deals']> {
  const { start_date, end_date, deal_type, exchange, status } = params;
  const startDate = `${start_date}T00:00:00.000Z`;
  const endDate = `${end_date}T23:59:59.999Z`;

  let query = `
    SELECT
      dp.id,
      dp.name,
      dp.exchange,
      dp.category,
      dp.deal_type,
      dp.total_clicks,
      dp.unique_clicks,
      dp.total_conversions,
      dp.unique_customers,
      dp.total_revenue,
      dp.total_commission,
      dp.conversion_rate_percent as conversion_rate,
      dp.avg_order_value,
      dp.avg_commission_rate,
      dp.top_affiliate_email,
      dp.affiliate_count,
      dp.is_active
    FROM v_deal_performance dp
    WHERE dp.total_clicks > 0
  `;

  const bindings: unknown[] = [];

  // Apply date filter by joining with conversions
  query += `
    AND dp.id IN (
      SELECT DISTINCT deal_id FROM conversions
      WHERE converted_at >= ? AND converted_at <= ?
      ${status === 'approved' ? "AND status = 'approved'" : status === 'pending' ? "AND status = 'pending'" : ''}
    )
  `;
  bindings.push(startDate, endDate);

  // Apply deal_type and exchange filters
  if (deal_type) {
    query += ' AND dp.deal_type = ?';
    bindings.push(deal_type);
  }
  if (exchange) {
    query += ' AND dp.exchange = ?';
    bindings.push(exchange);
  }

  query += ' ORDER BY dp.total_revenue DESC LIMIT ?';
  bindings.push(limit);

  const deals = await DB.prepare(query).bind(...bindings).all<{
    id: string;
    name: string;
    exchange: string | null;
    category: string | null;
    deal_type: string;
    total_clicks: number;
    unique_clicks: number;
    total_conversions: number;
    unique_customers: number;
    total_revenue: number;
    total_commission: number;
    conversion_rate: number;
    avg_order_value: number;
    avg_commission_rate: number;
    top_affiliate_email: string | null;
    affiliate_count: number;
    is_active: number;
  }>();

  const dealMetrics = deals.results.map(d => ({
    id: d.id,
    name: d.name,
    exchange: d.exchange,
    category: d.category,
    total_clicks: d.total_clicks,
    unique_clicks: d.unique_clicks,
    total_conversions: d.total_conversions,
    conversion_rate: d.conversion_rate,
    total_revenue: d.total_revenue,
    total_commission: d.total_commission,
    avg_commission_rate: d.avg_commission_rate,
    is_active: d.is_active === 1,
    top_affiliate: d.top_affiliate_email ? {
      email: d.top_affiliate_email,
    } : null,
  }));

  // Calculate summary statistics
  const totalClicks = dealMetrics.reduce((sum, d) => sum + d.total_clicks, 0);
  const totalConversions = dealMetrics.reduce((sum, d) => sum + d.total_conversions, 0);
  const totalRevenue = dealMetrics.reduce((sum, d) => sum + d.total_revenue, 0);
  const avgConversionRate = dealMetrics.length > 0
    ? dealMetrics.reduce((sum, d) => sum + d.conversion_rate, 0) / dealMetrics.length
    : 0;

  return {
    period: {
      start_date: params.start_date,
      end_date: params.end_date,
    },
    limit,
    deals: dealMetrics,
    summary: {
      total_clicks: totalClicks,
      total_conversions: totalConversions,
      total_revenue: totalRevenue,
      avg_conversion_rate: Math.round(avgConversionRate * 100) / 100,
    },
  };
}

/**
 * Get business metrics snapshot for alert evaluation
 * Returns a simplified metrics snapshot for the evaluation window
 */
export async function fetchBusinessMetricsSnapshot(
  DB: D1Database,
  windowMinutes: number = 120
): Promise<{
  todayRevenue: number;
  yesterdayRevenue: number;
  sevenDayAvgRevenue: number;
  revenueTrend: 'up' | 'down' | 'stable';
  todayConversionRate: number;
  last7DayAvgConversionRate: number;
  clicksToday: number;
  conversionsToday: number;
  webhookFailureRate: number;
  webhookTotalAttempts: number;
  webhookFailedAttempts: number;
  payoutFailureRate: number;
  totalPayouts: number;
  failedPayouts: number;
  stellarBalance: number;
}> {
  const now = new Date();
  const windowStart = new Date(now.getTime() - windowMinutes * 60 * 1000);
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const yesterday = new Date(today.getTime() - 24 * 60 * 60 * 1000);
  const sevenDaysAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000);

  // Today's metrics
  const todayMetrics = await DB.prepare(`
    SELECT
      COALESCE(SUM(revenue), 0) as revenue,
      COUNT(*) as conversions,
      (SELECT COUNT(*) FROM deal_clicks WHERE created_at >= ?) as clicks
    FROM conversions
    WHERE converted_at >= ? AND status = 'approved'
  `).bind(today.toISOString(), today.toISOString()).first<{
    revenue: number;
    conversions: number;
    clicks: number;
  }>();

  // Yesterday's revenue
  const yesterdayResult = await DB.prepare(`
    SELECT COALESCE(SUM(revenue), 0) as revenue
    FROM conversions
    WHERE converted_at >= ? AND converted_at < ? AND status = 'approved'
  `).bind(yesterday.toISOString(), today.toISOString()).first<{ revenue: number }>();

  // 7-day average revenue
  const sevenDayAvgResult = await DB.prepare(`
    SELECT COALESCE(AVG(daily_rev), 0) as avg_revenue
    FROM (
      SELECT DATE(converted_at) as date, COALESCE(SUM(revenue), 0) as daily_rev
      FROM conversions
      WHERE converted_at >= ? AND status = 'approved'
      GROUP BY DATE(converted_at)
    ) as daily
  `).bind(sevenDaysAgo.toISOString()).first<{ avg_revenue: number }>();

  // 7-day average conversion rate
  const conversionRateResult = await DB.prepare(`
    SELECT
      AVG(CASE WHEN clicks > 0 THEN (conversions * 100.0 / clicks) ELSE 0 END) as avg_rate
    FROM (
      SELECT
        DATE(dc.created_at) as date,
        COUNT(DISTINCT dc.id) as clicks,
        COUNT(DISTINCT c.id) as conversions
      FROM deal_clicks dc
      LEFT JOIN conversions c ON
        c.deal_id = dc.deal_id
        AND c.converted_at >= datetime(?, '-30 days')
        AND c.converted_at >= dc.created_at
      WHERE dc.created_at >= ?
      GROUP BY DATE(dc.created_at)
    ) as daily
  `).bind(sevenDaysAgo.toISOString(), sevenDaysAgo.toISOString()).first<{ avg_rate: number }>();

  // Webhook failure rate (from webhook logs)
  const webhookResult = await DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM webhook_logs
    WHERE attempted_at >= ?
  `).bind(windowStart.toISOString()).first<{ total: number; failed: number }>();

  // Payout failure rate
  const payoutResult = await DB.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) as failed
    FROM payouts
    WHERE created_at >= ?
  `).bind(windowStart.toISOString()).first<{ total: number; failed: number }>();

  // Current Stellar balance (latest reading)
  const stellarResult = await DB.prepare(`
    SELECT balance_usdc
    FROM stellar_balance_records
    ORDER BY recorded_at DESC
    LIMIT 1
  `).first<{ balance_usdc: number }>();

  // Calculate today's conversion rate
  const todayConversionRate = todayMetrics.clicks > 0
    ? (todayMetrics.conversions / todayMetrics.clicks) * 100
    : 0;

  // Determine revenue trend
  const todayRev = todayMetrics.revenue;
  const yesterdayRev = yesterdayResult?.revenue || 0;
  const revenueTrend: 'up' | 'down' | 'stable' = todayRev > yesterdayRev * 1.1 ? 'up'
    : todayRev < yesterdayRev * 0.9 ? 'down'
    : 'stable';

  return {
    todayRevenue: todayMetrics.revenue,
    yesterdayRevenue: yesterdayRev,
    sevenDayAvgRevenue: sevenDayAvgResult?.avg_revenue || 0,
    revenueTrend,
    todayConversionRate,
    last7DayAvgConversionRate: conversionRateResult?.avg_rate || 0,
    clicksToday: todayMetrics.clicks,
    conversionsToday: todayMetrics.conversions,
    webhookFailureRate: webhookResult.total > 0 ? (webhookResult.failed / webhookResult.total) * 100 : 0,
    webhookTotalAttempts: webhookResult.total,
    webhookFailedAttempts: webhookResult.failed,
    payoutFailureRate: payoutResult.total > 0 ? (payoutResult.failed / payoutResult.total) * 100 : 0,
    totalPayouts: payoutResult.total,
    failedPayouts: payoutResult.failed,
    stellarBalance: stellarResult?.balance_usdc || 0,
  };
}

/**
 * Build summary from metrics data
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
