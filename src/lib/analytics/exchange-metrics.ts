/**
 * Exchange Metrics Service
 *
 * Computes exchange breakdown analytics: volume per exchange,
 * top trading pairs, and cross-exchange comparison.
 *
 * Pattern: mirrors business-metrics.ts — D1 queries only, no HTTP deps.
 */

import type { D1Database } from '@/lib/db';
import type {
  ExchangeBreakdown,
  ExchangeComparison,
  TopTradingPair,
  ExchangeSummary,
} from '@/types/analytics';

// ============================================================================
// Types
// ============================================================================

interface ExchangeQueryParams {
  start_date: string;
  end_date: string;
  exchange?: string;
  deal_type?: string;
}

// ============================================================================
// Exchange Breakdown
// ============================================================================

/**
 * Get full breakdown for a specific exchange including top deals.
 */
export async function fetchExchangeBreakdown(
  DB: D1Database,
  params: ExchangeQueryParams
): Promise<ExchangeBreakdown> {
  const { start_date, end_date, exchange } = params;
  const startDateTime = `${start_date}T00:00:00.000Z`;
  const endDateTime = `${end_date}T23:59:59.999Z`;

  if (!exchange) {
    throw new Error('exchange parameter is required for breakdown');
  }

  // Aggregate metrics for this exchange
  const aggResult = await DB.prepare(`
    SELECT
      COUNT(DISTINCT d.id) as total_deals,
      COUNT(DISTINCT dc.id) as total_clicks,
      COUNT(DISTINCT dc.session_id) as unique_visitors,
      COUNT(DISTINCT c.id) as total_conversions,
      COUNT(DISTINCT c.customer_id) as unique_customers,
      COALESCE(SUM(c.revenue), 0) as total_volume,
      COALESCE(SUM(e.amount), 0) as total_commission,
      (CASE
        WHEN COUNT(DISTINCT dc.id) > 0
        THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
        ELSE 0
      END) as conversion_rate_percent,
      COALESCE(AVG(c.revenue), 0) as avg_order_value
    FROM deals d
    LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
    AND dc.created_at >= ? AND dc.created_at <= ?
    LEFT JOIN conversions c ON c.deal_id = d.id
    AND c.status = 'approved'
    AND c.converted_at >= dc.created_at
    AND c.converted_at <= datetime(dc.created_at, '+30 days')
    LEFT JOIN earnings e ON e.conversion_id = c.id
    WHERE d.exchange = ?
    AND dc.created_at >= ?
    AND dc.created_at <= ?
    GROUP BY d.exchange
  `)
    .bind(startDateTime, endDateTime, exchange, startDateTime, endDateTime)
    .first<{
      total_deals: number;
      total_clicks: number;
      unique_visitors: number;
      total_conversions: number;
      unique_customers: number;
      total_volume: number;
      total_commission: number;
      conversion_rate_percent: number;
      avg_order_value: number;
    }>();

  if (!aggResult) {
    return {
      exchange,
      period: { start_date: params.start_date, end_date: params.end_date },
      total_volume: 0,
      total_revenue: 0,
      total_deals: 0,
      total_clicks: 0,
      total_conversions: 0,
      avg_conversion_rate: 0,
      top_deals: [],
    };
  }

  // Top deals for this exchange
  const topDealsResult = await DB.prepare(`
    SELECT
      d.id as deal_id,
      d.name as deal_name,
      d.deal_type,
      COUNT(DISTINCT dc.id) as clicks,
      COUNT(DISTINCT c.id) as conversions,
      COALESCE(SUM(c.revenue), 0) as revenue,
      (CASE
        WHEN COUNT(DISTINCT dc.id) > 0
        THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
        ELSE 0
      END) as conversion_rate
    FROM deals d
    LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
    AND dc.created_at >= ? AND dc.created_at <= ?
    LEFT JOIN conversions c ON c.deal_id = d.id
    AND c.status = 'approved'
    AND c.converted_at >= dc.created_at
    AND c.converted_at <= datetime(dc.created_at, '+30 days')
    WHERE d.exchange = ?
    AND dc.created_at >= ?
    AND dc.created_at <= ?
    GROUP BY d.id, d.name, d.deal_type
    ORDER BY revenue DESC
    LIMIT 10
  `)
    .bind(startDateTime, endDateTime, exchange, startDateTime, endDateTime)
    .all<{
      deal_id: string;
      deal_name: string;
      deal_type: string;
      clicks: number;
      conversions: number;
      revenue: number;
      conversion_rate: number;
    }>();

  const top_deals = topDealsResult.results.map(d => ({
    deal_id: d.deal_id,
    deal_name: d.deal_name,
    deal_type: d.deal_type,
    clicks: d.clicks,
    conversions: d.conversions,
    revenue: d.revenue,
    conversion_rate: d.conversion_rate,
  }));

  return {
    exchange,
    period: { start_date: params.start_date, end_date: params.end_date },
    total_volume: aggResult.total_volume,
    total_revenue: aggResult.total_volume,
    total_deals: aggResult.total_deals,
    total_clicks: aggResult.total_clicks,
    total_conversions: aggResult.total_conversions,
    avg_conversion_rate: aggResult.conversion_rate_percent,
    top_deals,
  };
}

// ============================================================================
// Exchange Comparison
// ============================================================================

/**
 * Compare all exchanges side by side with market share.
 */
export async function fetchExchangeComparison(
  DB: D1Database,
  params: ExchangeQueryParams
): Promise<ExchangeComparison> {
  const { start_date, end_date } = params;
  const startDateTime = `${start_date}T00:00:00.000Z`;
  const endDateTime = `${end_date}T23:59:59.999Z`;

  const result = await DB.prepare(`
    SELECT
      d.exchange,
      COUNT(DISTINCT d.id) as deal_count,
      COUNT(DISTINCT dc.id) as total_clicks,
      COUNT(DISTINCT c.id) as total_conversions,
      COALESCE(SUM(c.revenue), 0) as total_volume,
      (CASE
        WHEN COUNT(DISTINCT dc.id) > 0
        THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
        ELSE 0
      END) as conversion_rate
    FROM deals d
    LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
    AND dc.created_at >= ? AND dc.created_at <= ?
    LEFT JOIN conversions c ON c.deal_id = d.id
    AND c.status = 'approved'
    AND c.converted_at >= dc.created_at
    AND c.converted_at <= datetime(dc.created_at, '+30 days')
    WHERE d.exchange IS NOT NULL
    AND dc.created_at >= ?
    AND dc.created_at <= ?
    GROUP BY d.exchange
    ORDER BY total_volume DESC
  `)
    .bind(startDateTime, endDateTime, startDateTime, endDateTime)
    .all<{
      exchange: string;
      deal_count: number;
      total_clicks: number;
      total_conversions: number;
      total_volume: number;
      conversion_rate: number;
    }>();

  const totalVolume = result.results.reduce((sum, r) => sum + r.total_volume, 0);
  const totalConversions = result.results.reduce((sum, r) => sum + r.total_conversions, 0);

  const exchanges: ExchangeSummary[] = result.results.map(r => ({
    exchange: r.exchange,
    volume: r.total_volume,
    conversions: r.total_conversions,
    clicks: r.total_clicks,
    revenue: r.total_volume,
    conversion_rate: r.conversion_rate,
    market_share_percent: totalVolume > 0
      ? Math.round((r.total_volume / totalVolume) * 10000) / 100
      : 0,
  }));

  return {
    period: { start_date: params.start_date, end_date: params.end_date },
    exchanges,
    total_volume: totalVolume,
    total_conversions: totalConversions,
  };
}

// ============================================================================
// Top Trading Pairs
// ============================================================================

/**
 * Get top trading pairs (deal_type + category combinations) across all exchanges.
 */
export async function fetchTopTradingPairs(
  DB: D1Database,
  params: ExchangeQueryParams & { limit?: number }
): Promise<TopTradingPair[]> {
  const { start_date, end_date, limit = 20 } = params;
  const startDateTime = `${start_date}T00:00:00.000Z`;
  const endDateTime = `${end_date}T23:59:59.999Z`;

  const result = await DB.prepare(`
    SELECT
      d.exchange,
      d.deal_type as pair_type,
      d.category as pair_category,
      COUNT(DISTINCT d.id) as deal_count,
      COUNT(DISTINCT dc.id) as total_clicks,
      COUNT(DISTINCT c.id) as total_conversions,
      COALESCE(SUM(c.revenue), 0) as total_volume,
      (CASE
        WHEN COUNT(DISTINCT dc.id) > 0
        THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
        ELSE 0
      END) as conversion_rate_percent
    FROM deals d
    LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
    AND dc.created_at >= ? AND dc.created_at <= ?
    LEFT JOIN conversions c ON c.deal_id = d.id
    AND c.status = 'approved'
    AND c.converted_at >= dc.created_at
    AND c.converted_at <= datetime(dc.created_at, '+30 days')
    WHERE d.exchange IS NOT NULL
    AND d.category IS NOT NULL
    AND dc.created_at >= ?
    AND dc.created_at <= ?
    GROUP BY d.exchange, d.deal_type, d.category
    ORDER BY total_volume DESC
    LIMIT ?
  `)
    .bind(startDateTime, endDateTime, startDateTime, endDateTime, limit)
    .all<{
      exchange: string;
      pair_type: string;
      pair_category: string;
      deal_count: number;
      total_clicks: number;
      total_conversions: number;
      total_volume: number;
      conversion_rate_percent: number;
    }>();

  return result.results.map(r => ({
    pair: `${r.pair_category} (${r.pair_type})`,
    exchange: r.exchange,
    deal_type: r.pair_type,
    total_volume: r.total_volume,
    total_conversions: r.total_conversions,
    conversion_rate: r.conversion_rate_percent,
  }));
}

// ============================================================================
// Query Parameter Parser
// ============================================================================

export function parseExchangeQueryParams(
  request: Request
): ExchangeQueryParams & { startDateObj: Date; endDateObj: Date } {
  const url = new URL(request.url);
  const now = new Date();
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const startDate = url.searchParams.get('start_date');
  const endDate = url.searchParams.get('end_date');
  const dealType = url.searchParams.get('deal_type');
  const exchange = url.searchParams.get('exchange');

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
    deal_type: dealType || undefined,
    exchange: exchange || undefined,
    startDateObj,
    endDateObj,
  };
}
