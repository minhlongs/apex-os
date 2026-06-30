/**
 * Affiliate Payouts API
 * Returns payout history for the authenticated user
 *
 * Caching:
 * - Per-user KV cache with 30s TTL
 * - Cache-Control: public, s-maxage=30, stale-while-revalidate=15
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { getUserIdCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';

interface PayoutRecord {
  id: string;
  affiliate_id: string;
  payout_method: string;
  payout_method_details: Record<string, unknown>;
  amount: number;
  currency: string;
  fee: number;
  net_amount: number;
  status: string;
  scheduled_at: string | null;
  paid_at: string | null;
  transaction_id: string | null;
  notes: string | null;
  created_at: string;
}

/**
 * GET /api/affiliate/payouts
 * Returns paginated list of payouts for the current user
 * Query params:
 * - page: page number (default 1)
 * - limit: items per page (default 20)
 * - status: filter by status (pending, processing, completed, failed, cancelled)
 */
export async function GET(request: NextRequest): Promise<Response> {
  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();

  try {
    const auth = createAuth({
      DB: (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!,
    });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const userId = (sessionResult.user as { id: string }).id;
    const DB = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!;

    // Parse query parameters
    const url = new URL(request.url);
    const page = parseInt(url.searchParams.get('page') || '1');
    const limit = parseInt(url.searchParams.get('limit') || '20');
    const status = url.searchParams.get('status');
    const sortBy = url.searchParams.get('sortBy') || 'scheduled_at';
    const sortOrder = url.searchParams.get('sortOrder') || 'desc';

    // Validate sort parameters to prevent SQL injection
    const validSortColumns = ['scheduled_at', 'paid_at', 'amount', 'net_amount', 'status', 'created_at'];
    const validSortOrders = ['asc', 'desc'];
    const safeSortBy = validSortColumns.includes(sortBy) ? sortBy : 'scheduled_at';
    const safeSortOrder = validSortOrders.includes(sortOrder.toLowerCase()) ? sortOrder.toLowerCase() : 'desc';

    // Build cache key
    const cacheKey = cacheAvailable
      ? getUserIdCacheKey('payouts', userId, `p${page}-l${limit}-s${status || 'all'}-sort${safeSortBy}-${safeSortOrder}`)
      : '';

    // Check cache first
    if (cacheAvailable) {
      const cached = await getCached<typeof responseData>(cacheKey);
      if (cached) {
        const queryTime = Date.now() - startTime;
        return NextResponse.json(cached, {
          headers: {
            'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=15',
            'X-Cache': 'HIT',
            'X-Cache-Query-Time': String(queryTime),
            'Vary': 'Accept, Accept-Encoding, Cookie',
          },
        });
      }
    }

    const offset = (page - 1) * limit;

    // Build query with optional filters
    const whereConditions: string[] = ['p.affiliate_id = ?'];
    const queryParams: (string | number)[] = [userId];

    if (status) {
      whereConditions.push('p.status = ?');
      queryParams.push(status);
    }

    const whereClause = whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // Get total count
    const countQuery = `
      SELECT COUNT(*) as total
      FROM payouts p
      ${whereClause}
    `;

    const countResult = await DB.prepare(countQuery)
      .bind(...queryParams)
      .first<{ total: number }>();

    const total = countResult?.total || 0;

    // Get payouts
    const payoutsQuery = `
      SELECT
        p.id,
        p.affiliate_id,
        p.payout_method,
        p.payout_method_details,
        p.amount,
        p.currency,
        p.fee,
        p.net_amount,
        p.status,
        p.scheduled_at,
        p.paid_at,
        p.transaction_id,
        p.notes,
        p.created_at
      FROM payouts p
      ${whereClause}
      ORDER BY p.${safeSortBy} ${safeSortOrder.toUpperCase()}
      LIMIT ? OFFSET ?
    `;

    const queryParamsWithPagination = [...queryParams, limit, offset];

    const payouts = await DB.prepare(payoutsQuery)
      .bind(...queryParamsWithPagination)
      .all<PayoutRecord>();

    // Calculate summary stats
    const statsQuery = `
      SELECT
        COUNT(*) as total_payouts,
        COALESCE(SUM(CASE WHEN status = 'completed' THEN net_amount ELSE 0 END), 0) as total_paid,
        COALESCE(SUM(CASE WHEN status IN ('pending', 'processing') THEN net_amount ELSE 0 END), 0) as pending_amount,
        COALESCE(SUM(fee), 0) as total_fees
      FROM payouts p
      ${whereClause}
    `;

    const statsResult = await DB.prepare(statsQuery)
      .bind(...queryParams)
      .first<{
        total_payouts: number;
        total_paid: number;
        pending_amount: number;
        total_fees: number;
      }>();

    const responseData = {
      success: true,
      data: payouts.results,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
      stats: statsResult || {
        total_payouts: 0,
        total_paid: 0,
        pending_amount: 0,
        total_fees: 0,
      },
    };

    const DB_TIME = Date.now() - startTime;

    // Cache the response
    if (cacheAvailable) {
      try {
        await setCache(cacheKey, responseData, 30); // 30 second TTL
      } catch (cacheError) {
        console.error('[PayoutsCache] Cache store error:', cacheError);
      }
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'public, s-maxage=30, stale-while-revalidate=15',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(DB_TIME),
        'X-Cache-TTL': '30',
        'Vary': 'Accept, Accept-Encoding, Cookie',
      },
    });
  } catch (error) {
    console.error('Error fetching payouts:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
