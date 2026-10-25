/**
 * Business Metrics API
 * Provides aggregated business metrics for admin dashboard
 *
 * Endpoint: GET /api/metrics/business
 * Authentication: Admin only
 * Rate Limit: 100 requests per hour per admin user
 *
 * Query Parameters:
 * - start_date: YYYY-MM-DD (default: 30 days ago)
 * - end_date: YYYY-MM-DD (default: today)
 * - group_by: daily|weekly|monthly|all (default: daily)
 * - deal_type: product|service|subscription|course
 * - exchange: binance|bybit|okx|kucoin
 * - status: approved|pending|all (default: approved)
 *
 * Response: BusinessMetricsResponse with:
 * - daily_revenue: revenue trends
 * - conversion_rates: conversion performance
 * - active_affiliates: affiliate statistics
 * - top_deals: best performing deals
 * - summary: high-level overview
 *
 * Caching: 5-minute TTL with distributed KV cache
 * Runtime: Edge (for faster response globally)
 */

import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';
import { createAuth } from '@/lib/auth/auth-factory';
import { getRateLimiter, extractIpAddress } from '@/lib/ratelimit/middleware';
import { getCachedMetrics, setCachedMetrics, generateCacheKey, getCacheTtlRemaining } from '@/lib/metrics/cache';
import { parseQueryParams, buildSummary } from '@/lib/metrics/business-metrics';
import type { BusinessMetricsResponse, BusinessMetricsQueryParams } from '@/types/metrics';
import { getDB } from '@/lib/db';
import type { D1Database } from '@/lib/db';

/**
 * Fetch daily revenue data from the materialized view
 */
async function fetchDailyRevenue(
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
async function fetchConversionRates(
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
async function fetchActiveAffiliates(DB: D1Database, params: BusinessMetricsQueryParams): Promise<BusinessMetricsResponse['active_affiliates']> {
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
async function fetchTopDeals(
  DB: D1Database,
  params: BusinessMetricsQueryParams & { startDateObj: Date; endDateObj: Date },
  limit: number = 10
): Promise<BusinessMetricsResponse['top_deals']> {
  // parseQueryParams always emits concrete YYYY-MM-DD strings for both bounds; the request type keeps
  // them optional because they are user-supplied. Narrowed here so the response contract
  // (TopDealsResponse.period) stays non-optional without changing any emitted value.
  const { start_date, end_date, deal_type, exchange, status } = params as BusinessMetricsQueryParams & {
    start_date: string;
    end_date: string;
    startDateObj: Date;
    endDateObj: Date;
  };
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
      start_date,
      end_date,
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
 * Check if user is admin
 */
async function isAdmin(DB: D1Database, userId: string): Promise<boolean> {
  const profile = await DB.prepare('SELECT role FROM profiles WHERE id = ?')
    .bind(userId)
    .first<{ role: string }>();
  return profile?.role === 'admin';
}

/**
 * GET /api/metrics/business
 * Main handler
 */
export const GET = async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();
  const DB = getDB();
  if (!DB) {
    return NextResponse.json({ error: 'Database not available' }, { status: 503 });
  }

  try {
    // Rate limiting check (before heavy processing)
    const limiter = getRateLimiter();
    const endpointType = 'admin_metrics';

    // Get user ID for rate limiting
    const auth = (createAuth as any)({ DB });
    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });
    const userId = sessionResult?.user?.id;
    const identifier = {
      ip: extractIpAddress(request.headers),
      userId,
    };

    const limitResult = await limiter.checkLimit(endpointType, identifier, {
      userId,
      userRole: 'admin', // Admin role, will use multiplier
    });

    if (!limitResult.allowed) {
      return NextResponse.json(
        { error: 'Too Many Requests', retryAfter: limitResult.retryAfter },
        { status: 429, headers: limiter.getHeaders(limitResult) }
      );
    }

    // Authentication and authorization
    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Admin authorization check
    const admin = await isAdmin(DB, userId);
    if (!admin) {
      return NextResponse.json({ error: 'Forbidden: Admin access required' }, { status: 403 });
    }

    // Parse query parameters
    // parseQueryParams always emits concrete YYYY-MM-DD strings for both bounds, so downstream
    // consumers (cache key generation, response period) can rely on non-optional strings.
    let params: BusinessMetricsQueryParams & {
      start_date: string;
      end_date: string;
      startDateObj: Date;
      endDateObj: Date;
    };
    try {
      params = parseQueryParams(request);
    } catch (error) {
      return NextResponse.json(
        { error: 'Invalid query parameters', details: String(error) },
        { status: 400 }
      );
    }

    // Generate cache key
    const cacheKey = generateCacheKey({
      start_date: params.start_date,
      end_date: params.end_date,
      group_by: params.group_by || 'daily',
      deal_type: params.deal_type || '',
      exchange: params.exchange || '',
      status: params.status || 'approved',
    });

    // Check cache first
    const cached = await getCachedMetrics(cacheKey);
    if (cached) {
      const cacheTtl = getCacheTtlRemaining(cacheKey);
      const response: BusinessMetricsResponse = {
        ...cached,
        cached: true,
        cache_ttl_remaining: cacheTtl,
      };
      return NextResponse.json(response, {
        headers: {
          'X-Cache': 'HIT',
          ...(cacheTtl && { 'X-Cache-TTL': cacheTtl.toString() }),
        },
      });
    }

    // Fetch all metrics (uncached)
    const [dailyRevenue, conversionRates, activeAffiliates, topDeals] = await Promise.all([
      fetchDailyRevenue(DB, params),
      fetchConversionRates(DB, params),
      fetchActiveAffiliates(DB, params),
      fetchTopDeals(DB, params, 10),
    ]);

    // Build summary
    const summary = buildSummary(params, dailyRevenue, activeAffiliates, topDeals);

    const response: BusinessMetricsResponse = {
      generated_at: new Date().toISOString(),
      query: {
        start_date: params.start_date,
        end_date: params.end_date,
        group_by: params.group_by,
        deal_type: params.deal_type,
        exchange: params.exchange,
        status: params.status,
      },
      cached: false,
      daily_revenue: dailyRevenue,
      conversion_rates: conversionRates,
      active_affiliates: activeAffiliates,
      top_deals: topDeals,
      summary,
    };

    // Cache the response (async, don't await)
    
    const duration = Date.now() - startTime;
    const rateLimitHeaders = limiter.getHeaders(limitResult);
    return NextResponse.json(response, {
      headers: {
        'X-Cache': 'MISS',
        'X-Response-Time': duration.toString(),
        ...rateLimitHeaders,
      },
    });
  } catch (error) {
    logError('Business metrics error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
};
