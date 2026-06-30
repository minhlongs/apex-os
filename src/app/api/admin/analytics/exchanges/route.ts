import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/auth-guard';
import { fetchExchangeBreakdown, fetchExchangeComparison, fetchTopTradingPairs, parseExchangeQueryParams } from '@/lib/analytics/exchange-metrics';
import { getGlobalCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';
import { getDB } from '@/lib/db';

// ============================================================================
// GET /api/admin/analytics/exchanges
// ============================================================================
// Query params:
//   start_date, end_date (YYYY-MM-DD, default: 30d ago)
//   exchange (required for breakdown mode)
//   deal_type (optional filter)
//   mode: 'breakdown' | 'comparison' | 'top-pairs' (default: 'comparison')
//   limit: number (for top-pairs, default: 20, max: 50)
// ============================================================================

export async function GET(request: NextRequest) {
  const admin = await requireAdminRole(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();
  const { searchParams } = new URL(request.url);

  const mode = searchParams.get('mode') || 'comparison';
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');
  const limit = Math.min(parseInt(searchParams.get('limit') || '20', 10), 50);

  const cacheKey = getGlobalCacheKey(
    'analytics-exchanges',
    `mode:${mode}:start:${startDate || 'default'}:end:${endDate || 'default'}:limit:${limit}`
  );

  if (cacheAvailable) {
    const cached = await getCached<any>(cacheKey);
    if (cached) {
      const queryTime = Date.now() - startTime;
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
          'X-Cache': 'HIT',
          'X-Cache-Query-Time': String(queryTime),
          Vary: 'Accept, Accept-Encoding',
        },
      });
    }
  }

  try {
    const DB = getDB();
    if (!DB) {
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 503 }
      );
    }

    let data: Record<string, unknown>;

    switch (mode) {
      case 'breakdown': {
        const exchange = searchParams.get('exchange');
        if (!exchange) {
          return NextResponse.json(
            { error: 'exchange query parameter is required for breakdown mode' },
            { status: 400 }
          );
        }
        const params = parseExchangeQueryParams(request);
        params.exchange = exchange;
        const breakdown = await fetchExchangeBreakdown(DB, params);
        data = { success: true, mode: 'breakdown', data: breakdown };
        break;
      }

      case 'top-pairs': {
        const params = parseExchangeQueryParams(request);
        const pairs = await fetchTopTradingPairs(DB, { ...params, limit });
        data = { success: true, mode: 'top-pairs', data: pairs };
        break;
      }

      case 'comparison':
      default: {
        const params = parseExchangeQueryParams(request);
        const comparison = await fetchExchangeComparison(DB, params);
        data = { success: true, mode: 'comparison', data: comparison };
        break;
      }
    }

    const totalTime = Date.now() - startTime;

    if (cacheAvailable) {
      try {
        await setCache(cacheKey, data, 120);
      } catch {
        // Cache write failure is non-fatal
      }
    }

    return NextResponse.json(data, {
      headers: {
        'Cache-Control': 'public, s-maxage=120, stale-while-revalidate=60',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(totalTime),
        'X-Cache-TTL': '120',
        Vary: 'Accept, Accept-Encoding',
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
