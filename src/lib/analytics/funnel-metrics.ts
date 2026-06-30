/**
 * Funnel Metrics Service
 *
 * Computes click-to-conversion rate, activation rate, and funnel stages
 * from deal_clicks, conversions, and events tables.
 *
 * Pattern: mirrors business-metrics.ts — D1 queries only, no HTTP deps.
 */

import type { D1Database } from '@/lib/db';
import type {
  FunnelMetrics,
  ClickToConversionDaily,
  ActivationMetrics,
  FunnelStage,
} from '@/types/analytics';

// ============================================================================
// Types
// ============================================================================

interface FunnelQueryParams {
  start_date: string;
  end_date: string;
  exchange?: string;
  deal_type?: string;
}

// ============================================================================
// Funnel Stage Builder
// ============================================================================

function buildFunnelStages(
  visits: number,
  clicks: number,
  signups: number,
  activations: number,
  conversions: number
): FunnelStage[] {
  const stages: FunnelStage[] = [
    { stage: 'visit', label: 'Visits', count: visits, dropoff_rate: 0, conversion_to_next: 0 },
    { stage: 'click', label: 'Clicks', count: clicks, dropoff_rate: 0, conversion_to_next: 0 },
    { stage: 'signup', label: 'Signups', count: signups, dropoff_rate: 0, conversion_to_next: 0 },
    { stage: 'activation', label: 'Activations', count: activations, dropoff_rate: 0, conversion_to_next: 0 },
    { stage: 'conversion', label: 'Conversions', count: conversions, dropoff_rate: 0, conversion_to_next: 0 },
  ];

  for (let i = 0; i < stages.length - 1; i++) {
    const current = stages[i].count;
    const next = stages[i + 1].count;
    stages[i].conversion_to_next = current > 0 ? Math.round((next / current) * 10000) / 100 : 0;
    stages[i].dropoff_rate = current > 0 ? Math.round(((current - next) / current) * 10000) / 100 : 0;
  }

  return stages;
}

// ============================================================================
// Click-to-Conversion Daily
// ============================================================================

/**
 * Fetch daily click-to-conversion metrics.
 * Falls back to deal_clicks + conversions join when analytics_funnel_daily
 * view is not yet populated (no events table yet).
 */
export async function fetchClickToConversionDaily(
  DB: D1Database,
  params: FunnelQueryParams
): Promise<ClickToConversionDaily[]> {
  const { start_date, end_date, deal_type, exchange } = params;

  // Build deal filter subquery
  const dealFilter = deal_type || exchange
    ? `AND d.deal_type = '${deal_type || '___'}' AND d.exchange = '${exchange || '___'}'`
    : '';

  const sql = `
    SELECT
      DATE(dc.created_at) as date,
      COUNT(DISTINCT dc.id) as total_clicks,
      COUNT(DISTINCT dc.session_id) as unique_clicks,
      COUNT(DISTINCT c.id) as total_conversions,
      COUNT(DISTINCT c.customer_id) as unique_converters,
      (CASE
        WHEN COUNT(DISTINCT dc.id) > 0
        THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
        ELSE 0
      END) as click_to_conversion_rate,
      COALESCE(AVG(
        (julianday(c.converted_at) - julianday(dc.created_at)) * 86400
      ), 0) as avg_time_to_conversion_seconds
    FROM deal_clicks dc
    JOIN deals d ON d.id = dc.deal_id
    LEFT JOIN conversions c ON c.deal_id = dc.deal_id
      AND c.status = 'approved'
      AND c.converted_at >= dc.created_at
      AND c.converted_at <= datetime(dc.created_at, '+30 days')
    WHERE dc.created_at >= ?
      AND dc.created_at <= ?
      ${dealFilter}
    GROUP BY DATE(dc.created_at)
    ORDER BY date DESC
  `;

  const endDateTime = `${end_date}T23:59:59.999Z`;
  const result = await DB.prepare(sql)
    .bind(start_date, endDateTime)
    .all<{
      date: string;
      total_clicks: number;
      unique_clicks: number;
      total_conversions: number;
      unique_converters: number;
      click_to_conversion_rate: number;
      avg_time_to_conversion_seconds: number;
    }>();

  return result.results.map(row => ({
    date: row.date,
    total_clicks: row.total_clicks,
    unique_clicks: row.unique_clicks,
    total_conversions: row.total_conversions,
    unique_converters: row.unique_converters,
    click_to_conversion_rate: row.click_to_conversion_rate,
    avg_time_to_conversion_seconds: Math.round(row.avg_time_to_conversion_seconds),
  }));
}

// ============================================================================
// Activation Metrics
// ============================================================================

/**
 * Activation = user who signed up AND completed a qualifying action
 * (first deal click or first conversion).
 *
 * Falls back to counting profiles with activity when events table
 * is not yet available.
 */
export async function fetchActivationMetrics(
  DB: D1Database,
  params: FunnelQueryParams
): Promise<ActivationMetrics> {
  const { start_date, end_date } = params;
  const startDateTime = `${start_date}T00:00:00.000Z`;
  const endDateTime = `${end_date}T23:59:59.999Z`;

  // Total visitors = unique sessions with deal clicks in period
  const visitorsResult = await DB.prepare(`
    SELECT COUNT(DISTINCT session_id) as total_visitors
    FROM deal_clicks
    WHERE created_at >= ? AND created_at <= ?
  `).bind(startDateTime, endDateTime).first<{ total_visitors: number }>();

  // Signups = profiles created in period with shopper/affiliate role
  const signupsResult = await DB.prepare(`
    SELECT COUNT(*) as total_signups
    FROM profiles
    WHERE created_at >= ? AND created_at <= ?
      AND role IN ('shopper', 'affiliate', 'admin', 'master_trader')
  `).bind(startDateTime, endDateTime).first<{ total_signups: number }>();

  // Activated = users who signed up in period AND had a deal click or conversion
  const activatedResult = await DB.prepare(`
    SELECT COUNT(DISTINCT p.id) as total_activations
    FROM profiles p
    WHERE p.created_at >= ? AND p.created_at <= ?
      AND p.role IN ('shopper', 'affiliate', 'admin', 'master_trader')
      AND (
        EXISTS (
          SELECT 1 FROM deal_clicks dc
          WHERE dc.affiliate_id = p.id
            AND dc.created_at >= p.created_at
            AND dc.created_at <= ?
        )
        OR EXISTS (
          SELECT 1 FROM conversions c
          WHERE c.affiliate_id = p.id
            AND c.converted_at >= p.created_at
            AND c.converted_at <= ?
        )
      )
  `).bind(startDateTime, endDateTime, endDateTime, endDateTime)
    .first<{ total_activations: number }>();

  const totalVisitors = visitorsResult?.total_visitors || 0;
  const totalSignups = signupsResult?.total_signups || 0;
  const totalActivations = activatedResult?.total_activations || 0;

  const signupRate = totalVisitors > 0 ? Math.round((totalSignups / totalVisitors) * 10000) / 100 : 0;
  const activationRate = totalSignups > 0
    ? Math.round((totalActivations / totalSignups) * 10000) / 100
    : 0;

  return {
    period: { start_date: params.start_date, end_date: params.end_date },
    total_visitors: totalVisitors,
    total_signups: totalSignups,
    total_activations: totalActivations,
    signup_rate: signupRate,
    activation_rate: activationRate,
    click_to_signup_rate: totalVisitors > 0
      ? Math.round((totalSignups / totalVisitors) * 10000) / 100
      : 0,
  };
}

// ============================================================================
// Full Funnel Metrics
// ============================================================================

/**
 * Compute full funnel: visits -> clicks -> signups -> activations -> conversions
 */
export async function fetchFunnelMetrics(
  DB: D1Database,
  params: FunnelQueryParams
): Promise<FunnelMetrics> {
  const { start_date, end_date } = params;
  const startDateTime = `${start_date}T00:00:00.000Z`;
  const endDateTime = `${end_date}T23:59:59.999Z`;

  // Visits: deal_clicks represent landing/visit events
  const visitsResult = await DB.prepare(`
    SELECT COUNT(DISTINCT session_id) as visits
    FROM deal_clicks
    WHERE created_at >= ? AND created_at <= ?
  `).bind(startDateTime, endDateTime).first<{ visits: number }>();

  // Clicks: total deal clicks
  const clicksResult = await DB.prepare(`
    SELECT COUNT(DISTINCT session_id) as clicks
    FROM deal_clicks
    WHERE created_at >= ? AND created_at <= ?
  `).bind(startDateTime, endDateTime).first<{ clicks: number }>();

  // Signups: new profiles in period
  const signupsResult = await DB.prepare(`
    SELECT COUNT(*) as signups
    FROM profiles
    WHERE created_at >= ? AND created_at <= ?
      AND role IN ('shopper', 'affiliate', 'admin', 'master_trader')
  `).bind(startDateTime, endDateTime).first<{ signups: number }>();

  // Activations: signups with activity
  const activationsResult = await DB.prepare(`
    SELECT COUNT(DISTINCT p.id) as activations
    FROM profiles p
    WHERE p.created_at >= ? AND p.created_at <= ?
      AND p.role IN ('shopper', 'affiliate', 'admin', 'master_trader')
      AND (
        EXISTS (
          SELECT 1 FROM deal_clicks dc
          WHERE dc.affiliate_id = p.id
            AND dc.created_at >= p.created_at AND dc.created_at <= ?
        )
        OR EXISTS (
          SELECT 1 FROM conversions c
          WHERE c.affiliate_id = p.id
            AND c.converted_at >= p.created_at AND c.converted_at <= ?
        )
      )
  `).bind(startDateTime, endDateTime, endDateTime, endDateTime)
    .first<{ activations: number }>();

  // Conversions: approved conversions in period
  const conversionsResult = await DB.prepare(`
    SELECT COUNT(DISTINCT customer_id) as conversions
    FROM conversions
    WHERE status = 'approved'
      AND converted_at >= ? AND converted_at <= ?
  `).bind(startDateTime, endDateTime).first<{ conversions: number }>();

  // Avg time from click to conversion
  const avgTimeResult = await DB.prepare(`
    SELECT COALESCE(AVG(
      (julianday(c.converted_at) - julianday(dc.created_at)) * 86400
    ), 0) as avg_seconds
    FROM deal_clicks dc
    JOIN conversions c ON c.deal_id = dc.deal_id
      AND c.status = 'approved'
      AND c.converted_at >= dc.created_at
      AND c.converted_at <= datetime(dc.created_at, '+30 days')
    WHERE dc.created_at >= ? AND dc.created_at <= ?
  `).bind(startDateTime, endDateTime).first<{ avg_seconds: number }>();

  // Avg time from visit (first click) to conversion for new users
  const avgVisitTimeResult = await DB.prepare(`
    SELECT COALESCE(AVG(
      (julianday(c.converted_at) - julianday(MIN(dc.created_at))) * 86400
    ), 0) as avg_seconds
    FROM conversions c
    JOIN deal_clicks dc ON dc.deal_id = c.deal_id
      AND dc.customer_id = c.customer_id
      AND dc.created_at <= c.converted_at
    WHERE c.status = 'approved'
      AND c.converted_at >= ? AND c.converted_at <= ?
    GROUP BY c.customer_id
  `).bind(startDateTime, endDateTime).first<{ avg_seconds: number }>();

  const visits = visitsResult?.visits || 0;
  const clicks = clicksResult?.clicks || 0;
  const signups = signupsResult?.signups || 0;
  const activations = activationsResult?.activations || 0;
  const conversions = conversionsResult?.conversions || 0;

  const stages = buildFunnelStages(visits, clicks, signups, activations, conversions);

  const clickToConversionRate = clicks > 0
    ? Math.round((conversions / clicks) * 10000) / 100
    : 0;

  const activationRate = signups > 0
    ? Math.round((activations / signups) * 10000) / 100
    : 0;

  return {
    period: { start_date: params.start_date, end_date: params.end_date },
    stages,
    overall_click_to_conversion_rate: clickToConversionRate,
    overall_activation_rate: activationRate,
    avg_seconds_to_click: 0,
    avg_seconds_to_conversion: Math.round(avgTimeResult?.avg_seconds || 0),
  };
}

// ============================================================================
// Query Parameter Parser
// ============================================================================

export function parseFunnelQueryParams(request: Request): FunnelQueryParams & { startDateObj: Date; endDateObj: Date } {
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
