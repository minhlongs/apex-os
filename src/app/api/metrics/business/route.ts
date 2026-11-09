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
import { getCachedMetrics, generateCacheKey, getCacheTtlRemaining } from '@/lib/metrics/cache';
import { parseQueryParams, buildSummary } from '@/lib/metrics/business-metrics';
import {
  fetchDailyRevenue,
  fetchConversionRates,
  fetchActiveAffiliates,
  fetchTopDeals,
} from '@/lib/metrics/business-metrics-fetcher';
import type { BusinessMetricsResponse, BusinessMetricsQueryParams } from '@/types/metrics';
import { getDB } from '@/lib/db';
import type { D1Database } from '@/lib/db';

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
    const auth = (createAuth as unknown as (opts: { DB: D1Database }) => {
      api: {
        getSession: (opts: {
          headers: Headers;
          cookies: Record<string, string>;
        }) => Promise<{ user?: { id: string } } | null>;
      };
    })({ DB });
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
    if (!sessionResult?.user || !userId) {
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
