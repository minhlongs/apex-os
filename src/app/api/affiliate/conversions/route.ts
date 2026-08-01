/**
 * Affiliate Conversions API
 * Returns conversion history for the authenticated user
 *
 * Caching:
 * - Per-user per-query KV cache with 15s TTL (data changes frequently)
 * - Cache-Control: public, s-maxage=15, stale-while-revalidate=5
 * - Invalidated on: conversion status change
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { getUserIdCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';
import { error as logError } from '@/lib/logger';

interface ConversionWithDeal {
  id: string;
  deal_id: string;
  deal_name: string;
  affiliate_code: string | null;
  customer_id: string | null;
  order_id: string | null;
  revenue: number;
  currency: string;
  commission_amount: number;
  commission_type: string;
  conversion_type: string;
  status: string;
  converted_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  refunded_at: string | null;
  notes: string | null;
  level: number;
}

/**
 * GET /api/affiliate/conversions
 * Returns paginated list of conversions for the current user
 */
export async function GET(request: NextRequest): Promise<Response> {
  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();

  try {
    const auth = (createAuth({
      DB: (globalThis as unknown as { DB: any }).DB,
    }) as any);

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const DB = (globalThis as unknown as { DB: any }).DB;

    // Parse query parameters
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const status = url.searchParams.get('status');
    const conversion_type = url.searchParams.get('conversion_type');
    const sortBy = url.searchParams.get('sortBy') || 'converted_at';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';

    // Validate sort parameters to prevent SQL injection
    const validSortColumns = ['converted_at', 'deal_name', 'revenue', 'commission_amount', 'status', 'conversion_type', 'level'];
    const validSortOrders = ['asc', 'desc'];
    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'converted_at';
    const safeSortOrder = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';

    // Build cache key
    const cacheKey = cacheAvailable
      ? getUserIdCacheKey('conversions', userId, `p${page}-l${limit}-s${status || 'all'}-t${conversion_type || 'all'}-sort${safeSortBy}-${safeSortOrder}`)
      : '';

    // Check cache first
    if (cacheAvailable) {
      const cached = await getCached(cacheKey);
      if (cached) {
        const queryTime = Date.now() - startTime;
        return NextResponse.json(cached, {
          headers: {
            'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=5',
            'X-Cache': 'HIT',
            'X-Cache-Query-Time': String(queryTime),
            'Vary': 'Accept, Accept-Encoding, Cookie',
          },
        });
      }
    }

    const DB_START = Date.now();
    const offset = (page - 1) * limit;

    // Build query with optional filters
    const whereConditions: string[] = ['c.affiliate_id = ?'];
    const queryParams: (string | number)[] = [userId];

    if (status) {
      whereConditions.push('c.status = ?');
      queryParams.push(status);
    }

    if (conversion_type) {
      whereConditions.push('c.conversion_type = ?');
      queryParams.push(conversion_type);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM conversions c ${whereClause}`;
    const countResult = await DB.prepare(countQuery)
      .bind(...queryParams)
      .first() as { total: number } | undefined;
    const total = countResult?.total || 0;

    // Get conversions with deal info
    const conversionsQuery = `
      SELECT c.id, c.deal_id, d.name as deal_name, c.affiliate_code,
             c.customer_id, c.order_id, c.revenue, c.currency,
             c.commission_amount, c.commission_type, c.conversion_type,
             c.status, c.converted_at, c.approved_at, c.rejected_at,
             c.refunded_at, c.notes, e.level as level
      FROM conversions c
      LEFT JOIN deals d ON c.deal_id = d.id
      LEFT JOIN earnings e ON e.conversion_id = c.id
      ${whereClause}
      ORDER BY ${safeSortBy === 'deal_name' ? 'd.name' : `c.${safeSortBy}`} ${safeSortOrder.toUpperCase()}
      LIMIT ? OFFSET ?
    `;

    const queryParamsWithPagination = [...queryParams, limit, offset];
    const conversions = await DB.prepare(conversionsQuery)
      .bind(...queryParamsWithPagination)
      .all() as any[];

    // Calculate summary stats
    const statsQuery = `
      SELECT COUNT(*) as total_conversions,
             COALESCE(SUM(CASE WHEN status = 'approved' THEN commission_amount ELSE 0 END), 0) as total_earnings,
             COALESCE(SUM(CASE WHEN status = 'approved' THEN revenue ELSE 0 END), 0) as total_revenue,
             COALESCE(AVG(CASE WHEN status = 'approved' THEN revenue END), 0) as avg_order_value
      FROM conversions c ${whereClause}
    `;

    const statsResult = await DB.prepare(statsQuery)
      .bind(...queryParams)
      .first() as any;

    const responseData = {
      success: true,
      data: conversions,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
      stats: statsResult || { total_conversions: 0, total_earnings: 0, total_revenue: 0, avg_order_value: 0 },
    };

    const DB_TIME = Date.now() - DB_START;
    const totalTime = Date.now() - startTime;

    // Cache the response
    if (cacheAvailable) {
      try {
        await setCache(cacheKey, responseData, 15);
      } catch (cacheError) {
        logError('[ConversionsCache] Cache store error:', cacheError);
      }
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'public, s-maxage=15, stale-while-revalidate=5',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(totalTime),
        'X-DB-Query-Time': String(DB_TIME),
        'X-Cache-TTL': '15',
        'Vary': 'Accept, Accept-Encoding, Cookie',
      },
    });
  } catch (error) {
    logError('Error fetching conversions:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
