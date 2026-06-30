/**
 * Admin Top Affiliates API
 * Returns ranked list of top performing affiliates
 * Admin only endpoint
 *
 * Caching:
 * - Global KV cache with 5 minute TTL (affiliate stats don't change minute-by-minute)
 * - Cache-Control: public, s-maxage=300, stale-while-revalidate=60
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';
import { getDB } from '@/lib/db';
import { requireAdmin } from '@/lib/admin-guard';

export interface TopAffiliate {
  id: string;
  email: string;
  full_name: string | null;
  referral_code: string;
  lifetime_earnings: number;
  lifetime_payouts: number;
  pending_earnings: number;
  total_conversions: number;
  total_clicks: number;
  conversion_rate: number;
  total_referrals: number;
  total_revenue: number;
  created_at: string;
  [key: string]: unknown;
}

interface TopAffiliatesResponse {
  affiliates: TopAffiliate[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

/**
 * GET /api/admin/affiliates
 * Returns paginated list of top affiliates sorted by performance
 * Query params:
 * - page: page number (default 1)
 * - limit: items per page (default 20)
 * - sortBy: column to sort by (lifetime_earnings, total_conversions, conversion_rate, total_referrals, created_at)
 * - sortOrder: asc or desc (default desc)
 * - timeRange: 7d, 30d, 90d, all (filter by activity period)
 */
export async function GET(request: NextRequest): Promise<Response> {
  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();

 try {
  const admin = await requireAdmin(request);
  if (!admin) {
   return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const db = getDB();
  const userId = admin.userId;

 // Parse query parameters
 const url = new URL(request.url);
 const page = parseInt(url.searchParams.get('page') || '1');
 const limit = parseInt(url.searchParams.get('limit') || '20');
 const sortBy = url.searchParams.get('sortBy') || 'lifetime_earnings';
 const sortOrder = url.searchParams.get('sortOrder') || 'desc';
 const timeRange = url.searchParams.get('timeRange') || 'all';

    // Validate sort parameters
    const validSortColumns = ['lifetime_earnings', 'total_conversions', 'conversion_rate', 'total_referrals', 'total_revenue', 'created_at', 'pending_earnings'];
    const validSortOrders = ['asc', 'desc'];
    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'lifetime_earnings';
    const safeSortOrder = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';

    // Build cache key
    const cacheKey = cacheAvailable
      ? `admin:affiliates:${page}:${limit}:${safeSortBy}:${safeSortOrder}:${timeRange}`
      : '';

    // Check cache first
    if (cacheAvailable) {
      const cached = await getCached<TopAffiliatesResponse>(cacheKey);
      if (cached) {
        const queryTime = Date.now() - startTime;

        return NextResponse.json(cached, {
          headers: {
            'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
            'X-Cache': 'HIT',
            'X-Cache-Query-Time': String(queryTime),
          },
        });
      }
    }

    const DB_START = Date.now();

    // Build time range filter
    let dateCondition = '';
    if (timeRange !== 'all') {
      const days = timeRange === '7d' ? 7 : timeRange === '30d' ? 30 : 90;
      dateCondition = `AND p.created_at >= datetime('now', '-${days} days')`;
    }

    // Map sort columns to actual SQL expressions
    const sortColumnMap: Record<string, string> = {
      lifetime_earnings: 'COALESCE(rt.total_earnings, 0)',
      total_conversions: 'COALESCE(ap.total_conversions, 0)',
      conversion_rate: 'COALESCE(ap.conversion_rate, 0)',
      total_referrals: 'COALESCE(rt.total_direct_referrals, 0) + COALESCE(rt.total_indirect_referrals, 0)',
      total_revenue: 'COALESCE(ap.total_revenue, 0)',
      pending_earnings: 'COALESCE(pending.pending_earnings, 0)',
      created_at: 'p.created_at',
    };

    const sortExpression = sortColumnMap[safeSortBy] || sortColumnMap.lifetime_earnings;

    const offset = (page - 1) * limit;

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM profiles p
      WHERE p.role IN ('affiliate', 'admin')
      ${dateCondition}
    `;

    const countResult = await db.prepare(countQuery)
      .first<{ total: number }>();

    const total = countResult?.total || 0;

    // Get top affiliates with comprehensive stats
    const affiliatesQuery = `
      SELECT
        p.id,
        p.email,
        p.full_name,
        COALESCE(p.referral_code, '') as referral_code,
        COALESCE(rt.total_earnings, 0) as lifetime_earnings,
        COALESCE(rt.total_payouts, 0) as lifetime_payouts,
        COALESCE(pending.pending_earnings, 0) as pending_earnings,
        COALESCE(ap.total_conversions, 0) as total_conversions,
        COALESCE(ap.total_clicks, 0) as total_clicks,
        COALESCE(ap.conversion_rate, 0) as conversion_rate,
        COALESCE(rt.total_direct_referrals, 0) + COALESCE(rt.total_indirect_referrals, 0) as total_referrals,
        COALESCE(ap.total_revenue, 0) as total_revenue,
        p.created_at
      FROM profiles p
      LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
      LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
      LEFT JOIN (
        SELECT affiliate_id, COALESCE(SUM(amount), 0) as pending_earnings
        FROM earnings
        WHERE is_paid = 0
        GROUP BY affiliate_id
      ) pending ON pending.affiliate_id = p.id
      WHERE p.role IN ('affiliate', 'admin')
      ${dateCondition}
      ORDER BY ${sortExpression} ${safeSortOrder.toUpperCase()}, p.created_at DESC
      LIMIT ? OFFSET ?
    `;

    const affiliates = await db.prepare(affiliatesQuery)
      .bind(limit, offset)
      .all<TopAffiliate>();

    const responseData: TopAffiliatesResponse = {
      affiliates: affiliates.results,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    const DB_TIME = Date.now() - DB_START;
    const totalTime = Date.now() - startTime;

    // Cache the response
    if (cacheAvailable) {
      try {
        await setCache(cacheKey, responseData, 300); // 5 minute TTL
      } catch (cacheError) {
        console.error('[TopAffiliatesCache] Cache store error:', cacheError);
      }
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(totalTime),
        'X-DB-Query-Time': String(DB_TIME),
      },
    });
  } catch (error) {
    console.error('Error fetching top affiliates:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
