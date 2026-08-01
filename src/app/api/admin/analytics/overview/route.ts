import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';
import { requireAdminRole } from '@/lib/auth-guard';
import { getAnalyticsOverview } from '@/lib/analytics/cloudflare-analytics';
import { getGlobalCacheKey, getCached, setCache, isKVAvailable } from '@/lib/cache/kv-cache';

/**
 * API Route: GET /api/admin/analytics/overview
 * Fetches analytics overview from Cloudflare
 *
 * Caching:
 * - Global KV cache with 60s TTL (data refreshed from Cloudflare API)
 * - Cache-Control: public, s-maxage=60, stale-while-revalidate=30
 *
 * Required environment variables:
 * - CLOUDFLARE_API_TOKEN
 * - CLOUDFLARE_ACCOUNT_ID
 *
 * Query parameters:
 * - timeRange: '24h' | '7d' | '30d' (default: '7d')
 *
 * Admin authentication should be handled by middleware
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

  // Check cache first
  if (cacheAvailable) {
    const cacheKey = getGlobalCacheKey('analytics-overview', `timeRange:${timeRange}`);
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
    const overview = await getAnalyticsOverview(accountId, apiToken, timeRange);

    if (!overview) {
      return NextResponse.json(
        { error: 'Failed to fetch analytics data from Cloudflare' },
        { status: 502 }
      );
    }

    const responseData = {
      success: true,
      data: overview,
    };

    const totalTime = Date.now() - startTime;

    // Cache the response
    if (cacheAvailable) {
      try {
        const cacheKey = getGlobalCacheKey('analytics-overview', `timeRange:${timeRange}`);
        await setCache(cacheKey, responseData, 60); // 60 second TTL
      } catch (cacheError) {
        logError('[AnalyticsCache] Cache store error:', cacheError);
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
    logError('Analytics overview API error:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
