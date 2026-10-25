/**
 * src/app/api/deals/arbitrage/route.ts
 *
 * Public Cross-Exchange Arbitrage & High-Yield Deal API
 * Endpoint: GET /api/deals/arbitrage
 *
 * Queries active fee and cashback arbitrage opportunities with multi-column filtering,
 * pagination, and cache headers. Edge runtime compatible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { ArbitrageEngine } from '@/lib/arbitrage/arbitrage-engine';
import type { MarketType, OpportunityType, ExchangeId } from '@/types/arbitrage';

function resolveDb(request?: NextRequest): D1Database {
  if (request && 'env' in request && (request as any).env?.DB) {
    return (request as any).env.DB;
  }
  const globalAny = globalThis as any;
  if (globalAny.DB) {
    return globalAny.DB;
  }
  return getDB();
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const db = resolveDb(request);
    const url = new URL(request.url);
    const searchParams = url.searchParams;

    const rawPair = searchParams.get('pair');
    const pair = rawPair ? rawPair.trim() : undefined;

    const rawMarketType = searchParams.get('market_type') || searchParams.get('marketType');
    const marketType = (rawMarketType?.toLowerCase() as MarketType) || undefined;

    const rawMinSpread = searchParams.get('min_spread') || searchParams.get('minSpread') || searchParams.get('min_spread_bps');
    const minSpread = rawMinSpread !== null ? parseFloat(rawMinSpread) : undefined;

    const rawOppType = searchParams.get('opportunity_type') || searchParams.get('opportunityType');
    const opportunityType = (rawOppType as OpportunityType) || undefined;

    const exchange = searchParams.get('exchange')?.toLowerCase() as ExchangeId | undefined;

    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));

    // If exchange filter is provided (which matches base_exchange OR target_exchange), query directly
    if (exchange) {
      const offset = (page - 1) * limit;
      const where: string[] = ['is_active = 1'];
      const params: unknown[] = [];

      where.push('(base_exchange = ? OR target_exchange = ?)');
      params.push(exchange, exchange);

      if (pair) {
        where.push('LOWER(pair) = LOWER(?)');
        params.push(pair);
      }
      if (marketType) {
        where.push('market_type = ?');
        params.push(marketType);
      }
      if (minSpread !== undefined && !isNaN(minSpread)) {
        where.push('spread_bps >= ?');
        params.push(minSpread);
      }
      if (opportunityType) {
        where.push('opportunity_type = ?');
        params.push(opportunityType);
      }

      const whereClause = where.join(' AND ');

      const countRow = await db.prepare(
        `SELECT COUNT(*) as total FROM arbitrage_opportunities WHERE ${whereClause}`
      ).bind(...params).first<{ total: number }>();
      const total = Number(countRow?.total ?? 0);

      const rowsRes = await db.prepare(
        `SELECT * FROM arbitrage_opportunities
         WHERE ${whereClause}
         ORDER BY spread_bps DESC
         LIMIT ? OFFSET ?`
      ).bind(...params, limit, offset).all();

      const data = Array.isArray(rowsRes) ? rowsRes : (rowsRes?.results || []);
      const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);

      return NextResponse.json(
        {
          success: true,
          data,
          total,
          page,
          limit,
          totalPages,
          pagination: {
            page,
            limit,
            total,
            totalPages,
          },
        },
        {
          headers: {
            'Cache-Control': 'public, max-age=30, s-maxage=30',
          },
        }
      );
    }

    // Default query through ArbitrageEngine
    const engine = new ArbitrageEngine(db);
    const result = await engine.queryOpportunities(
      {
        pair,
        market_type: marketType,
        min_spread_bps: minSpread,
        opportunity_type: opportunityType,
        page,
        limit,
      },
      db
    );

    return NextResponse.json(
      {
        success: true,
        data: result.data,
        total: result.total,
        page: result.page,
        limit: result.limit,
        totalPages: result.totalPages,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: result.totalPages,
        },
      },
      {
        headers: {
          'Cache-Control': 'public, max-age=30, s-maxage=30',
        },
      }
    );
  } catch (error: any) {
    return NextResponse.json(
      {
        success: false,
        error: error?.message || 'Failed to retrieve arbitrage opportunities',
        data: [],
        total: 0,
        page: 1,
        limit: 20,
        totalPages: 0,
        pagination: { page: 1, limit: 20, total: 0, totalPages: 0 },
      },
      { status: 500 }
    );
  }
}
