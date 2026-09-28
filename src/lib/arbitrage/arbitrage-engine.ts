/**
 * Cross-Exchange Arbitrage & Yield Matrix Engine
 * Module: ApexOS Arbitrage Engine
 *
 * Evaluates exchange rate cards across Binance, Bybit, OKX, and KuCoin,
 * maps active affiliate deals, computes net spreads and benchmark savings,
 * and maintains the arbitrage_opportunities lifecycle in Cloudflare D1.
 */

import { getDB, type D1Database } from '@/lib/db';
import {
  calculateArbitrageMetrics,
  classifyOpportunity,
} from './math';
import type {
  ExchangeId,
  MarketType,
  OpportunityType,
  ExchangeRateCard,
  ArbitrageOpportunity,
  ArbitrageQueryFilter,
  PaginatedArbitrageOpportunities,
  ArbitrageMatrixResponse,
  ArbitrageMatrixCell,
  ArbitrageMetrics,
} from '@/types/arbitrage';

export interface AnalyzeOpportunitiesOptions {
  pairs?: string[];
  marketTypes?: MarketType[];
  db?: D1Database;
  ttlHours?: number;
}

export class ArbitrageEngine {
  private db?: D1Database;

  constructor(db?: D1Database) {
    this.db = db;
  }

  /**
   * Resolves D1 database instance
   */
  private resolveDB(dbOverride?: D1Database): D1Database {
    if (dbOverride) return dbOverride;
    if (this.db) return this.db;
    return getDB();
  }

  /**
   * Analyzes all active rate cards, joins affiliate deals, and generates cross-exchange opportunities
   */
  async analyzeOpportunities(options?: AnalyzeOpportunitiesOptions): Promise<ArbitrageOpportunity[]> {
    const db = this.resolveDB(options?.db);
    const ttlHours = options?.ttlHours ?? 24;

    // 1. Fetch active rate cards
    let cardQuery = 'SELECT * FROM exchange_rate_cards WHERE is_active = 1';
    const cardParams: unknown[] = [];

    if (options?.pairs && options.pairs.length > 0) {
      cardQuery += ` AND UPPER(pair) IN (${options.pairs.map(() => '?').join(',')})`;
      cardParams.push(...options.pairs.map((p) => p.toUpperCase()));
    }
    if (options?.marketTypes && options.marketTypes.length > 0) {
      cardQuery += ` AND market_type IN (${options.marketTypes.map(() => '?').join(',')})`;
      cardParams.push(...options.marketTypes);
    }

    const cardRes = await db.prepare(cardQuery).bind(...cardParams).all<ExchangeRateCard>();
    const rateCards = Array.isArray(cardRes) ? cardRes : (cardRes?.results || []);

    // 2. Fetch active affiliate deals mapped by exchange & category
    const dealRes = await db.prepare(
      `SELECT id, name, url, exchange, category, cashback_percent, default_commission_rate
       FROM deals
       WHERE is_active = 1`
    ).all<{
      id: string;
      name: string;
      url: string;
      exchange: string | null;
      category: string | null;
      cashback_percent: number | null;
    }>();
    const deals = Array.isArray(dealRes) ? dealRes : (dealRes?.results || []);

    const dealMap = new Map<string, { id: string; name: string; url: string; cashback: number }>();
    for (const d of deals) {
      if (d.exchange && d.category) {
        const dealKey = `${d.exchange.toLowerCase()}_${d.category.toLowerCase()}`;
        const existing = dealMap.get(dealKey);
        if (!existing || (d.cashback_percent ?? 0) > existing.cashback) {
          dealMap.set(dealKey, {
            id: d.id,
            name: d.name,
            url: d.url,
            cashback: d.cashback_percent ?? 0,
          });
        }
      }
    }

    // 3. Group rate cards by (pair, market_type)
    const groups = new Map<string, ExchangeRateCard[]>();
    for (const card of rateCards) {
      const pair = card.pair.toUpperCase();
      const mkt = card.market_type;
      const groupKey = `${pair}_${mkt}`;
      if (!groups.has(groupKey)) {
        groups.set(groupKey, []);
      }
      groups.get(groupKey)!.push(card);
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + ttlHours * 3600 * 1000).toISOString();
    const detectedAt = now.toISOString();

    const bestOpps = new Map<string, ArbitrageOpportunity>();

    // 4. Cross-compare within each pair and market_type
    for (const [, cards] of groups.entries()) {
      if (cards.length < 2) continue;

      for (const baseCard of cards) {
        for (const targetCard of cards) {
          if (baseCard.exchange === targetCard.exchange) continue;

          const metrics = calculateArbitrageMetrics(
            baseCard.taker_fee,
            baseCard.default_cashback_pct,
            targetCard.taker_fee,
            targetCard.default_cashback_pct
          );

          // Only consider profitable switches
          if (metrics.spreadBps <= 0.0 || metrics.savingsPct <= 0.0) continue;

          const oppType = classifyOpportunity(baseCard, targetCard, metrics);
          const dealKey = `${targetCard.exchange.toLowerCase()}_${targetCard.market_type.toLowerCase()}`;
          const matchingDeal = dealMap.get(dealKey);

          const recommendation = this.formatRecommendation({
            pair: baseCard.pair,
            marketType: baseCard.market_type,
            baseExchange: baseCard.exchange,
            targetExchange: targetCard.exchange,
            metrics,
            oppType,
            dealName: matchingDeal?.name,
          });

          const opp: ArbitrageOpportunity = {
            pair: baseCard.pair,
            market_type: baseCard.market_type,
            base_exchange: baseCard.exchange,
            target_exchange: targetCard.exchange,
            base_taker_fee: baseCard.taker_fee,
            target_taker_fee: targetCard.taker_fee,
            base_maker_fee: baseCard.maker_fee,
            target_maker_fee: targetCard.maker_fee,
            base_cashback_pct: baseCard.default_cashback_pct,
            target_cashback_pct: targetCard.default_cashback_pct,
            net_base_fee: metrics.netBaseFee,
            net_target_fee: metrics.netTargetFee,
            spread_bps: metrics.spreadBps,
            savings_pct: metrics.savingsPct,
            opportunity_type: oppType,
            recommendation,
            deal_id: matchingDeal?.id ?? null,
            monthly_savings_10k: metrics.savings10k.monthly,
            monthly_savings_50k: metrics.savings50k.monthly,
            monthly_savings_250k: metrics.savings250k.monthly,
            annual_savings_10k: metrics.savings10k.annual,
            annual_savings_50k: metrics.savings50k.annual,
            annual_savings_250k: metrics.savings250k.annual,
            is_active: 1,
            detected_at: detectedAt,
            expires_at: expiresAt,
            metadata: typeof targetCard.metadata === 'string' ? targetCard.metadata : JSON.stringify(targetCard.metadata || {}),
          };

          const oppKey = `${baseCard.pair.toUpperCase()}_${baseCard.market_type}_${baseCard.exchange}_${targetCard.exchange}`;
          const existing = bestOpps.get(oppKey);
          if (!existing || opp.spread_bps > existing.spread_bps) {
            bestOpps.set(oppKey, opp);
          }
        }
      }
    }

    return Array.from(bestOpps.values());
  }

  /**
   * Atomic batch upsert for calculated opportunities with 50-item D1 chunking
   */
  async upsertOpportunities(
    opportunities: ArbitrageOpportunity[],
    dbOverride?: D1Database
  ): Promise<number> {
    if (opportunities.length === 0) return 0;
    const db = this.resolveDB(dbOverride);

    const upsertSql = `
      INSERT INTO arbitrage_opportunities (
        pair, market_type, base_exchange, target_exchange,
        base_taker_fee, target_taker_fee, base_maker_fee, target_maker_fee,
        base_cashback_pct, target_cashback_pct, net_base_fee, net_target_fee,
        spread_bps, savings_pct, opportunity_type, recommendation, deal_id,
        monthly_savings_10k, monthly_savings_50k, monthly_savings_250k,
        annual_savings_10k, annual_savings_50k, annual_savings_250k,
        is_active, detected_at, expires_at, metadata
      ) VALUES (
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?,
        ?, ?, ?, ?, ?,
        ?, ?, ?,
        ?, ?, ?,
        1, ?, ?, ?
      )
      ON CONFLICT (pair, market_type, base_exchange, target_exchange) DO UPDATE SET
        base_taker_fee = excluded.base_taker_fee,
        target_taker_fee = excluded.target_taker_fee,
        base_maker_fee = excluded.base_maker_fee,
        target_maker_fee = excluded.target_maker_fee,
        base_cashback_pct = excluded.base_cashback_pct,
        target_cashback_pct = excluded.target_cashback_pct,
        net_base_fee = excluded.net_base_fee,
        net_target_fee = excluded.net_target_fee,
        spread_bps = excluded.spread_bps,
        savings_pct = excluded.savings_pct,
        opportunity_type = excluded.opportunity_type,
        recommendation = excluded.recommendation,
        deal_id = excluded.deal_id,
        monthly_savings_10k = excluded.monthly_savings_10k,
        monthly_savings_50k = excluded.monthly_savings_50k,
        monthly_savings_250k = excluded.monthly_savings_250k,
        annual_savings_10k = excluded.annual_savings_10k,
        annual_savings_50k = excluded.annual_savings_50k,
        annual_savings_250k = excluded.annual_savings_250k,
        is_active = 1,
        detected_at = excluded.detected_at,
        expires_at = excluded.expires_at,
        metadata = excluded.metadata,
        updated_at = datetime('now')
    `;

    const stmts = opportunities.map((opp) =>
      db.prepare(upsertSql).bind(
        opp.pair,
        opp.market_type,
        opp.base_exchange,
        opp.target_exchange,
        opp.base_taker_fee,
        opp.target_taker_fee,
        opp.base_maker_fee,
        opp.target_maker_fee,
        opp.base_cashback_pct,
        opp.target_cashback_pct,
        opp.net_base_fee,
        opp.net_target_fee,
        opp.spread_bps,
        opp.savings_pct,
        opp.opportunity_type,
        opp.recommendation,
        opp.deal_id ?? null,
        opp.monthly_savings_10k,
        opp.monthly_savings_50k,
        opp.monthly_savings_250k,
        opp.annual_savings_10k,
        opp.annual_savings_50k,
        opp.annual_savings_250k,
        opp.detected_at,
        opp.expires_at,
        typeof opp.metadata === 'object' ? JSON.stringify(opp.metadata) : opp.metadata ?? '{}'
      )
    );

    const CHUNK_SIZE = 50;
    for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
      const chunk = stmts.slice(i, i + CHUNK_SIZE);
      await db.batch(chunk);
    }

    return opportunities.length;
  }

  /**
   * Deactivates stale or expired opportunities
   */
  async deactivateExpired(dbOverride?: D1Database): Promise<number> {
    const db = this.resolveDB(dbOverride);
    const res = await db.prepare(
      `UPDATE arbitrage_opportunities 
       SET is_active = 0, updated_at = datetime('now') 
       WHERE is_active = 1 AND expires_at < datetime('now')`
    ).run();

    return res.meta?.changes ?? 0;
  }

  /**
   * Queries active opportunities with pagination and multi-column filtering
   */
  async queryOpportunities(
    filter: ArbitrageQueryFilter = {},
    dbOverride?: D1Database
  ): Promise<PaginatedArbitrageOpportunities> {
    const db = this.resolveDB(dbOverride);
    const page = Math.max(1, filter.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter.limit ?? 20));
    const offset = (page - 1) * limit;

    const where: string[] = [];
    const params: unknown[] = [];

    if (filter.is_active !== undefined) {
      where.push('is_active = ?');
      params.push(filter.is_active ? 1 : 0);
    } else {
      where.push('is_active = 1');
    }

    if (filter.pair) {
      where.push('LOWER(pair) = LOWER(?)');
      params.push(filter.pair);
    }
    if (filter.market_type) {
      where.push('market_type = ?');
      params.push(filter.market_type);
    }
    if (filter.target_exchange) {
      where.push('target_exchange = ?');
      params.push(filter.target_exchange);
    }
    if (filter.opportunity_type) {
      where.push('opportunity_type = ?');
      params.push(filter.opportunity_type);
    }
    if (filter.min_spread_bps !== undefined) {
      where.push('spread_bps >= ?');
      params.push(filter.min_spread_bps);
    }

    const whereClause = where.join(' AND ');

    // 1. Total count
    const countRow = await db.prepare(
      `SELECT COUNT(*) as total FROM arbitrage_opportunities WHERE ${whereClause}`
    ).bind(...params).first<{ total: number }>();
    const total = Number(countRow?.total ?? 0);

    // 2. Paginated rows
    const rowsRes = await db.prepare(
      `SELECT * FROM arbitrage_opportunities
       WHERE ${whereClause}
       ORDER BY spread_bps DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all<ArbitrageOpportunity>();

    const data = Array.isArray(rowsRes) ? rowsRes : (rowsRes?.results || []);
    const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);

    return { data, total, page, limit, totalPages };
  }

  /**
   * Generates a 2D cross-exchange comparison matrix for a given pair and market type
   */
  async getMatrix(
    pair: string,
    marketType: MarketType,
    dbOverride?: D1Database
  ): Promise<ArbitrageMatrixResponse> {
    const db = this.resolveDB(dbOverride);
    const exchanges: ExchangeId[] = ['binance', 'bybit', 'okx', 'kucoin'];

    const oppsRes = await db.prepare(
      `SELECT * FROM arbitrage_opportunities
       WHERE LOWER(pair) = LOWER(?) AND market_type = ? AND is_active = 1`
    ).bind(pair, marketType).all<ArbitrageOpportunity>();

    const opps = Array.isArray(oppsRes) ? oppsRes : (oppsRes?.results || []);

    const matrix: Record<ExchangeId, Record<ExchangeId, ArbitrageMatrixCell | null>> = {
      binance: { binance: null, bybit: null, okx: null, kucoin: null },
      bybit: { binance: null, bybit: null, okx: null, kucoin: null },
      okx: { binance: null, bybit: null, okx: null, kucoin: null },
      kucoin: { binance: null, bybit: null, okx: null, kucoin: null },
    };

    for (const opp of opps) {
      if (matrix[opp.base_exchange] && opp.base_exchange !== opp.target_exchange) {
        matrix[opp.base_exchange][opp.target_exchange] = {
          baseExchange: opp.base_exchange,
          targetExchange: opp.target_exchange,
          spreadBps: opp.spread_bps,
          savingsPct: opp.savings_pct,
          annualSavings250k: opp.annual_savings_250k,
          opportunityType: opp.opportunity_type,
          dealId: opp.deal_id ?? null,
        };
      }
    }

    return {
      pair,
      marketType,
      exchanges,
      matrix,
      updatedAt: new Date().toISOString(),
    };
  }

  /**
   * Alias for getMatrix
   */
  async getArbitrageMatrix(
    pair: string,
    marketType: MarketType,
    dbOverride?: D1Database
  ): Promise<ArbitrageMatrixResponse> {
    return this.getMatrix(pair, marketType, dbOverride);
  }

  /**
   * Formats actionable recommendation strings with deal insights
   */
  public formatRecommendation(params: {
    pair: string;
    marketType: MarketType;
    baseExchange: string;
    targetExchange: string;
    metrics: ArbitrageMetrics;
    oppType: OpportunityType;
    dealName?: string;
  }): string {
    const bName = params.baseExchange.toUpperCase();
    const tName = params.targetExchange.toUpperCase();
    const annualSavings = params.metrics.savings250k.annual;

    if (params.oppType === 'VIP_PROMOTION') {
      return `Exclusive VIP promo: Route ${params.pair} ${params.marketType} orders to ${tName} to save ${params.metrics.savingsPct}% on fees ($${annualSavings.toFixed(0)}/yr on $250k vol).`;
    }
    if (params.oppType === 'CASHBACK_MAX') {
      return `Maximize Yield: Switch from ${bName} to ${tName} for a +${params.metrics.cashbackAdvantage}% ApexOS cashback boost, saving ${params.metrics.spreadBps} bps (${params.metrics.savingsPct}% net reduction).`;
    }
    return `Fee Advantage: ${tName} offers ${params.metrics.spreadBps} bps lower net fees than ${bName} on ${params.pair} (${params.metrics.savingsPct}% fee savings).`;
  }
}
