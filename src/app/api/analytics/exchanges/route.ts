/**
 * Business Analytics — Exchanges Breakdown + Top Pairs
 * GET /api/analytics/exchanges
 * Auth: admin only
 * Cache: 5-minute TTL via KV
 */

import { NextRequest, NextResponse } from 'next/server';
import { createAuth } from '@/lib/auth/auth-factory';
import { withRateLimit, extractIpAddress } from '@/lib/ratelimit/middleware';
import { error as logError, warn as logWarn } from '@/lib/logger';
import type { D1Database } from '@/lib/db';
import { exchangeBreakdown, topPairs } from '@/lib/analytics/query-builder';

const CACHE_TTL = 300; // 5 minutes
const CACHE_PREFIX = 'analytics:exchanges';

function isKVAvailable(): boolean {
  // @ts-ignore — KV binding from wrangler.toml
  return typeof KV !== 'undefined' && KV.get !== undefined;
}

function buildCacheKey(params: Record<string, string | number | undefined>): string {
  const raw = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const hash = raw.length > 0 ? raw.slice(0, 64) : 'all';
  return `${CACHE_PREFIX}:${hash}`;
}

export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();
  let cacheAvailable = false;
  let cacheKey = '';

  try {
    const auth = createAuth({
      // @ts-ignore — runtime global
      DB: (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB!,
    });

    const sessionResult = await auth.api.getSession({
      headers: request.headers,
      cookies: request.cookies as unknown as Record<string, string>,
    });

    if (!sessionResult?.user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const role = (sessionResult.user as { role?: string }).role;
    if (role !== 'admin') {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    const DB = (globalThis as unknown as { DB: Parameters<typeof createAuth>[0]['DB'] }).DB as D1Database;

    const url = new URL(request.url);
    const date_from = url.searchParams.get('date_from') ?? undefined;
    const date_to = url.searchParams.get('date_to') ?? undefined;
    const includeTopPairs = url.searchParams.get('include_top_pairs') === 'true';
    const bypassCache = url.searchParams.get('refresh') === 'true';

    cacheKey = buildCacheKey({ date_from, date_to, includeTopPairs: includeTopPairs ? '1' : '0' });
    cacheAvailable = isKVAvailable();

    // Try KV cache
    if (cacheAvailable && !bypassCache) {
      try {
        // @ts-ignore
        const cached = await KV.get(cacheKey, 'json');
        if (cached) {
          const data = typeof cached === 'string' ? JSON.parse(cached) : cached;
          return NextResponse.json(
            { ...data, meta: { ...data.meta, cached: true } },
            {
              headers: {
                'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
                'X-Cache': 'HIT',
                'X-Cache-Query-Time': String(Date.now() - startTime),
              },
            }
          );
        }
      } catch {
        // Non-fatal cache miss
      }
    }

    const [breakdown, pairs] = await Promise.all([
      exchangeBreakdown(DB, { date_from, date_to }),
      includeTopPairs ? topPairs(DB, { date_from, date_to }) : Promise.resolve(null),
    ]);

    const response = {
      breakdown,
      top_pairs: pairs,
      meta: {
        generated_at: new Date().toISOString(),
        cached: false,
      },
    };

    const queryTime = Date.now() - startTime;

    // Store in KV
    if (cacheAvailable) {
      try {
        // @ts-ignore
        await KV.put(cacheKey, JSON.stringify(response), { expirationTtl: CACHE_TTL });
      } catch (cacheError) {
        logWarn('[Analytics:Exchanges] Cache store error:', cacheError);
      }
    }

    return NextResponse.json(response, {
      headers: {
        'Cache-Control': 'public, s-maxage=300, stale-while-revalidate=60',
        'X-Cache': 'MISS',
        'X-Cache-Query-Time': String(queryTime),
      },
    });
  } catch (error) {
    logError('[Analytics:Exchanges] GET failed:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}, {
  endpointType: 'api_general',
  getIdentifier: (request) => ({
    ip: extractIpAddress(request.headers),
  }),
  skipIf: (request) => {
    const pathname = new URL(request.url).pathname;
    return pathname.startsWith('/api/health') || pathname.startsWith('/api/monitoring');
  },
});
