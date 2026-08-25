// ==============================================================================
// Sprint 3 — Analytics Query Builder
// Generates parameterized SQL against the analytics materialized views.
// ==============================================================================

import { error as logError } from '@/lib/logger';
import type { D1Database } from '@/lib/db';
import type {
  DealsAnalyticsFilters,
  AffiliatesAnalyticsFilters,
  FunnelFilters,
  ExchangesFilters,
  DailyDealRow,
  DailyAffiliateRow,
  ExchangeBreakdownRow,
  TopPairRow,
  FunnelDailyRow,
  AnalyticsResult,
  ApiEnvelope,
} from '@/types/analytics';

// ==============================================================================
// Helpers
// ==============================================================================

function offsetLimit(offset: number): { limit: number; offset: number } {
  return { limit: 100, offset };
}

function parseDate(range?: string): { date_from: string; date_to: string } {
  if (!range) {
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - 30);
    return {
      date_from: from.toISOString().slice(0, 10),
      date_to: to.toISOString().slice(0, 10),
    };
  }
  const days = parseInt(range.replace('d', ''), 10);
  if (!Number.isFinite(days) || days <= 0) {
    return {
      date_from: new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10),
      date_to: new Date().toISOString().slice(0, 10),
    };
  }
  const to = new Date();
  const from = new Date();
  from.setDate(from.getDate() - days);
  return {
    date_from: from.toISOString().slice(0, 10),
    date_to: to.toISOString().slice(0, 10),
  };
}

function pageOffset(page?: number): number {
  const p = typeof page === 'number' && Number.isFinite(page) && page > 0 ? page : 1;
  return (p - 1) * 100;
}

// ==============================================================================
// View-backed queries
// ==============================================================================

export async function dailyDeals(
  DB: D1Database,
  filters: DealsAnalyticsFilters
): Promise<AnalyticsResult<DailyDealRow>> {
  const t0 = Date.now();
  try {
    const { date_from, date_to } = parseFilters(filters);
    const limit = filters.limit && filters.limit > 0 ? Math.min(filters.limit, 100) : 100;
    const offset = pageOffset(filters.page);

    const sql = `
      SELECT *
      FROM analytics_daily_deals
      WHERE (date >= ? OR ? IS NULL)
        AND (date <= ? OR ? IS NULL)
        AND (exchange = ? OR ? IS NULL)
        AND (deal_id = ? OR ? IS NULL)
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `;
    const rows = await DB.prepare(sql)
      .bind(date_from ?? null, date_from, date_to ?? null, date_to, filters.exchange ?? null, filters.exchange, filters.deal_id ?? null, filters.deal_id, limit, offset)
      .all<DailyDealRow>();

    const countSql = `
      SELECT COUNT(*) as cnt
      FROM analytics_daily_deals
      WHERE (date >= ? OR ? IS NULL)
        AND (date <= ? OR ? IS NULL)
        AND (exchange = ? OR ? IS NULL)
        AND (deal_id = ? OR ? IS NULL)
    `;
    const countRow = await DB.prepare(countSql)
      .bind(date_from ?? null, date_from, date_to ?? null, date_to, filters.exchange ?? null, filters.exchange, filters.deal_id ?? null, filters.deal_id)
      .first<{ cnt: number }>();

    return {
      data: getResults(rows),
      total: countRow?.cnt ?? 0,
      page: filters.page ?? 1,
      page_size: limit,
      query_time_ms: Date.now() - t0,
    };
  } catch (error) {
    logError('[analytics] dailyDeals query failed:', error);
    throw error;
  }
}

export async function dailyAffiliates(
  DB: D1Database,
  filters: AffiliatesAnalyticsFilters
): Promise<AnalyticsResult<DailyAffiliateRow>> {
  const t0 = Date.now();
  try {
    const { date_from, date_to } = parseFilters(filters);
    const limit = (filters.top ?? 100);
    const offset = 0;

    const sql = `
      SELECT *
      FROM analytics_daily_affiliates
      WHERE (date >= ? OR ? IS NULL)
        AND (date <= ? OR ? IS NULL)
        AND (affiliate_id = ? OR ? IS NULL)
        AND (email = ? OR ? IS NULL)
      ORDER BY date DESC
      LIMIT ? OFFSET ?
    `;
    let rows: { results?: DailyAffiliateRow[] };
    try {
      rows = await DB.prepare(sql)
        .bind(date_from ?? null, date_from, date_to ?? null, date_to, filters.affiliate_id ?? null, filters.affiliate_id, null, null, limit, offset)
        .all<DailyAffiliateRow>();
    } catch {
      // Fallback without email filter when view has no email column
      const fallback = `
        SELECT *
        FROM analytics_daily_affiliates
        WHERE (date >= ? OR ? IS NULL)
          AND (date <= ? OR ? IS NULL)
          AND (affiliate_id = ? OR ? IS NULL)
        ORDER BY date DESC
        LIMIT ? OFFSET ?
      `;
      rows = await DB.prepare(fallback)
        .bind(date_from ?? null, date_from, date_to ?? null, date_to, filters.affiliate_id ?? null, filters.affiliate_id, limit, offset)
        .all<DailyAffiliateRow>();
    }

    // Envelope to match .results shape regardless of driver
    const data = getResults(rows);

    return {
      data,
      total: data.length,
      page: 1,
      page_size: limit,
      query_time_ms: Date.now() - t0,
    };
  } catch (error) {
    logError('[analytics] dailyAffiliates query failed:', error);
    throw error;
  }
}

export async function exchangeBreakdown(
  DB: D1Database,
  _filters: ExchangesFilters
): Promise<AnalyticsResult<ExchangeBreakdownRow>> {
  const t0 = Date.now();
  try {
    const sql = `SELECT * FROM analytics_exchange_breakdown ORDER BY total_volume DESC`;
    const rows = await DB.prepare(sql).all<ExchangeBreakdownRow>();
    const data = getResults(rows);
    return {
      data,
      total: data.length,
      page: 1,
      page_size: data.length,
      query_time_ms: Date.now() - t0,
    };
  } catch (error) {
    logError('[analytics] exchangeBreakdown query failed:', error);
    throw error;
  }
}

export async function topPairs(
  DB: D1Database,
  _filters: ExchangesFilters
): Promise<AnalyticsResult<TopPairRow>> {
  const t0 = Date.now();
  try {
    const sql = `SELECT * FROM analytics_top_pairs ORDER BY total_volume DESC LIMIT 50`;
    const rows = await DB.prepare(sql).all<TopPairRow>();
    const data = getResults(rows);
    return {
      data,
      total: data.length,
      page: 1,
      page_size: data.length,
      query_time_ms: Date.now() - t0,
    };
  } catch (error) {
    logError('[analytics] topPairs query failed:', error);
    throw error;
  }
}

export async function funnelDaily(
  DB: D1Database,
  filters: FunnelFilters
): Promise<AnalyticsResult<FunnelDailyRow>> {
  const t0 = Date.now();
  try {
    const { date_from, date_to } = parseFilters(filters);
    const sql = `
      SELECT *
      FROM analytics_funnel_daily
      WHERE (date >= ? OR ? IS NULL)
        AND (date <= ? OR ? IS NULL)
      ORDER BY date DESC
      LIMIT 90
    `;
    const rows = await DB.prepare(sql)
      .bind(date_from ?? null, date_from, date_to ?? null, date_to)
      .all<FunnelDailyRow>();
    const data = getResults(rows);
    return {
      data,
      total: data.length,
      page: 1,
      page_size: data.length,
      query_time_ms: Date.now() - t0,
    };
  } catch (error) {
    logError('[analytics] funnelDaily query failed:', error);
    throw error;
  }
}

// -------------------------------------------------------------------------------
// Legacy alias used by existing code
// -------------------------------------------------------------------------------
export async function dailyDealPerformance(
  DB: D1Database,
  _filters: DealsAnalyticsFilters
): Promise<ApiEnvelope<DailyDealRow[]>> {
  const result = await dailyDeals(DB, _filters);
  return { success: true, data: result.data, meta: { total: result.total, query_time_ms: result.query_time_ms } };
}

// Type-safe result extraction — avoids `any` casts
function getResults<T>(rows: { results?: T[] } | T[]): T[] {
  if (Array.isArray(rows)) return rows;
  return rows.results ?? [];
}

function parseFilters(
  filters: { date_from?: string; date_to?: string }
): { date_from?: string; date_to?: string } {
  const from = typeof filters.date_from === 'string' && filters.date_from.length > 0
    ? filters.date_from
    : undefined;
  const to = typeof filters.date_to === 'string' && filters.date_to.length > 0
    ? filters.date_to
    : undefined;
  return { date_from: from, date_to: to };
}
