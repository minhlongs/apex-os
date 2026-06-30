import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/auth-guard';
import {
  fetchFunnelMetrics,
  fetchClickToConversionDaily,
  fetchActivationMetrics,
  parseFunnelQueryParams,
} from '@/lib/analytics/funnel-metrics';
import { getGlobalCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';
import { getDB } from '@/lib/db';

// ============================================================================
// GET /api/admin/analytics/funnel
//   Funnel metrics: click-to-conversion rate, activation rate, stages
//
// Query params:
//   start_date, end_date (YYYY-MM-DD, default: 30d ago)
//   exchange (optional filter)
//   deal_type (optional filter)
//   format: 'full' | 'daily' | 'activation' (default: 'full')
// ============================================================================

export async function GET(request: NextRequest) {
  const admin = await requireAdminRole(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();
  const { searchParams } = new URL(request.url);

  const format = searchParams.get('format') || 'full';
  const startDate = searchParams.get('start_date');
  const endDate = searchParams.get('end_date');

  const cacheKey = getGlobalCacheKey(
    'analytics-funnel',
    `format:${format}:start:${startDate || 'default'}:end:${endDate || 'default'}`
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

    const params = parseFunnelQueryParams(request);
    let data: Record<string, unknown>;

    switch (format) {
      case 'daily': {
        const daily = await fetchClickToConversionDaily(DB, params);
        data = { success: true, format: 'daily', data: daily };
        break;
      }

      case 'activation': {
        const activation = await fetchActivationMetrics(DB, params);
        data = { success: true, format: 'activation', data: activation };
        break;
      }

      case 'full':
      default: {
        const funnel = await fetchFunnelMetrics(DB, params);
        data = { success: true, format: 'full', data: funnel };
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
