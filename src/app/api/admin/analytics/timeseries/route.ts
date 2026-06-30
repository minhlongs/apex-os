import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/auth-guard';
import { getAnalyticsTimeSeries } from '@/lib/analytics/cloudflare-analytics';
import { getGlobalCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';

/**
 * API Route: GET /api/admin/analytics/timeseries
 * Fetches time series data for charts
 *
 * Caching:
 * - Global KV cache with 60s TTL
 * - Cache-Control: public, s-maxage=60, stale-while-revalidate=30
 *
 * Query parameters:
 * - timeRange: '24h' | '7d' | '30d' (default: '7d')
 * - interval: 'hour' | 'day' (default: 'day')
 */
export async function GET(request: NextRequest) {
const admin = await requireAdminRole(request);
if (!admin) {
return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
}

  const startTime = Date.now();
  const cacheAvailable = isKVAvailable();

  const { searchParams } = new URL(request.url);
  const timeRange = searchParams.get('timeRange') as '24h' | '7d' | '30d' || '7d';
  const interval = searchParams.get('interval') as 'hour' | 'day' || 'day';

  // Check cache first
  if (cacheAvailable) {
    const cacheKey = getGlobalCacheKey('analytics-timeseries', `timeRange:${timeRange}:interval:${interval}`);
    const cached = await getCached<any>(cacheKey);
    if (cached) {
      const queryTime = Date.now() - startTime;
      return NextResponse.json(cached, {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
          'X-Cache': 'HIT',
          'X-Cache-Query-Time': String(queryTime),
          'Vary': 'Accept, Accept-Encoding',
        },
      });
    }
  }

  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;

  if (!apiToken || !accountId) {
    return NextResponse.json(
      { error: 'Cloudflare API credentials not configured' },
      { status: 500 }
    );
  }

  try {
    const timeseries = await getAnalyticsTimeSeries(accountId, apiToken, timeRange, interval);

    const responseData = {
      success: true,
      data: timeseries,
    };

    const totalTime = Date.now() - startTime;

    // Cache the response
    if (cacheAvailable) {
      try {
        const cacheKey = getGlobalCacheKey('analytics-timeseries', `timeRange:${timeRange}:interval:${interval}`);
        await setCache(cacheKey, responseData, 60);
      } catch (cacheError) {
        console.error('[AnalyticsCache] Cache store error:', cacheError);
      }
    }

    return NextResponse.json(responseData, {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(totalTime),
        'X-Cache-TTL': '60',
        'Vary': 'Accept, Accept-Encoding',
      },
    });
  } catch (error) {
    console.error('Analytics timeseries API error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
