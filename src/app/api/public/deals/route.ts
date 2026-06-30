/**
 * Public Deals API Routes
 * Handles public listing of affiliate deals (no authentication required)
 *
 * Rate Limiting: 500 req/hour per IP (api_general endpoint type)
 * Caching: KV cache with 60s TTL + HTTP Cache-Control headers
 * Runtime: Edge (for faster cold starts globally)
 */

export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import type { PublicDeal, DealListQuery, PaginatedResponse } from '@/types/deal';
import { withRateLimit } from '@/lib/ratelimit/middleware';
import { extractIpAddress } from '@/lib/ratelimit/rate-limiter';

// KV Cache configuration
const DEALS_CACHE_TTL = 60; // 60 seconds
const DEALS_CACHE_PREFIX = 'public-deals';

// Minimal Database interface for D1
interface Statement {
  bind(...params: unknown[]): Statement;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
  run(): Promise<{ success: boolean }>;
}

interface Database {
  prepare(sql: string): Statement;
}

// Minimal Cloudflare KV interface
interface CloudflareKVNamespace {
  get(key: string, type?: 'text' | 'json'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
}

// Get KV namespace from global Cloudflare bindings
function getKV(): CloudflareKVNamespace | null {
  // @ts-ignore - Cloudflare KV binding from wrangler.toml
  const kv = globalThis.KV;
  if (!kv || typeof kv.get !== 'function') {
    return null;
  }
  return kv as CloudflareKVNamespace;
}

// Generate cache key from query parameters
function generateCacheKey(request: NextRequest): string {
  const url = new URL(request.url);
  const params = url.searchParams;

  // Build normalized query string (sorted for consistency)
  const entries = Array.from(params.entries())
    .filter(([key]) => !key.startsWith('_')) // Skip internal params
    .sort(([a], [b]) => a.localeCompare(b));

  const queryString = entries
    .map(([key, value]) => `${key}=${value}`)
    .join('&');

  return `${DEALS_CACHE_PREFIX}:${queryString || 'default'}`;
}

// Allowed filter values
const ALLOWED_EXCHANGES = ['binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken'] as const;
const ALLOWED_CATEGORIES = ['spot', 'futures', 'options', 'margin'] as const;
const ALLOWED_DEAL_TYPES = ['product', 'service', 'subscription', 'course'] as const;
const DEFAULT_PAGE = 1;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

/**
 * GET /api/public/deals
 * List public deals with optional filters
 * Query params:
 * - page: number (default 1)
 * - limit: number (default 20, max 100)
 * - exchange: binance|bybit|okx|ftx|coinbase|kraken
 * - category: spot|futures|options|margin
 * - deal_type: product|service|subscription|course
 * - search: string (search in name, description)
 * - is_active: 0|1 (default 1)
 */
export const GET = withRateLimit(async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();
  const kv = getKV();

  try {
    // Check if D1 database is available
    const DB = (globalThis as unknown as { DB?: Database }).DB;

    if (!DB) {
      return NextResponse.json(
        { error: 'Database not available', data: [], total: 0, page: 1, limit: 0, totalPages: 0 },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const searchParams = url.searchParams;
    const cacheKey = generateCacheKey(request);

    // Try KV cache first
    if (kv) {
      const cached = await kv.get(cacheKey, 'json');
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

    // Parse query parameters
    const page = Math.max(parseInt(searchParams.get('page') || String(DEFAULT_PAGE)), 1);
    const limit = Math.min(Math.max(parseInt(searchParams.get('limit') || String(DEFAULT_LIMIT)), 1), MAX_LIMIT);

    // Validate and collect filters
    const exchange = searchParams.get('exchange');
    const category = searchParams.get('category');
    const dealType = searchParams.get('deal_type');
    const search = searchParams.get('search');
    const isActive = searchParams.get('is_active') !== '0'; // Default to active

    // Validate enum values
    if (exchange && !ALLOWED_EXCHANGES.includes(exchange as any)) {
      return NextResponse.json(
        { error: `Invalid exchange. Must be one of: ${ALLOWED_EXCHANGES.join(', ')}`, data: [], total: 0, page, limit, totalPages: 0 },
        { status: 400 }
      );
    }
    if (category && !ALLOWED_CATEGORIES.includes(category as any)) {
      return NextResponse.json(
        { error: `Invalid category. Must be one of: ${ALLOWED_CATEGORIES.join(', ')}`, data: [], total: 0, page, limit, totalPages: 0 },
        { status: 400 }
      );
    }
    if (dealType && !ALLOWED_DEAL_TYPES.includes(dealType as any)) {
      return NextResponse.json(
        { error: `Invalid deal_type. Must be one of: ${ALLOWED_DEAL_TYPES.join(', ')}`, data: [], total: 0, page, limit, totalPages: 0 },
        { status: 400 }
      );
    }

    const offset = (page - 1) * limit;

    // Build WHERE conditions
    const conditions: string[] = ['is_active = ?'];
    const values: unknown[] = [isActive ? 1 : 0];

    if (exchange) {
      conditions.push('exchange = ?');
      values.push(exchange);
    }
    if (category) {
      conditions.push('category = ?');
      values.push(category);
    }
    if (dealType) {
      conditions.push('deal_type = ?');
      values.push(dealType);
    }
    if (search) {
      conditions.push('(name LIKE ? OR description LIKE ?)');
      const searchPattern = `%${search}%`;
      values.push(searchPattern, searchPattern);
    }

    // Handle date range: only show deals that are currently valid
    const now = new Date().toISOString();
    conditions.push('(starts_at IS NULL OR starts_at <= ?)');
    values.push(now);
    conditions.push('(ends_at IS NULL OR ends_at >= ?)');
    values.push(now);

    const whereClause = `WHERE ${conditions.join(' AND ')}`;

    // Get total count
    const countQuery = `SELECT COUNT(*) as total FROM deals ${whereClause}`;
    const countResult = await DB.prepare(countQuery).bind(...values).first<{ total: number }>();
    const total = countResult?.total || 0;

    // Get paginated deals
    const dataQuery = `
      SELECT * FROM deals
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const allValues = [...values, limit, offset];
    const dataResult = await DB.prepare(dataQuery).bind(...allValues).all<PublicDeal>();

    const response: PaginatedResponse<PublicDeal> = {
      data: dataResult.results,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    };

    const queryTime = Date.now() - startTime;
    const headers: Record<string, string> = {
      'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=30',
      'X-Cache': 'MISS',
      'X-Cache-Query-Time': String(queryTime),
      'Vary': 'Accept, Accept-Encoding',
    };

    // Cache the response in KV (only if there's data)
    if (kv && response.data.length > 0) {
      try {
        await kv.put(cacheKey, JSON.stringify(response), { expirationTtl: DEALS_CACHE_TTL });
      } catch (cacheError) {
        console.error('[DealsCache] Cache store error:', cacheError);
        // Continue without caching - don't fail the request
      }
    }

    return NextResponse.json(response, { headers });
  } catch (error) {
    console.error('Error listing public deals:', error);
    return NextResponse.json(
      { error: 'Internal server error', details: String(error), data: [], total: 0, page: 1, limit: 0, totalPages: 0 },
      { status: 500 }
    );
  }
}, {
  endpointType: 'api_general',
  getIdentifier: (request) => ({
    ip: extractIpAddress(request.headers),
    userId: undefined // Public endpoint, no user ID
  }),
  skipIf: (request) => {
    // Allow health checks and monitoring to bypass rate limits
    const pathname = new URL(request.url).pathname;
    return pathname.startsWith('/api/health') || pathname.startsWith('/api/monitoring');
  }
});
