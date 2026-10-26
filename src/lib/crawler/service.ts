/**
 * Exchange Rate Card Crawler Service
 * Module: ApexOS Multi-Exchange Crawler Engine
 *
 * Orchestrates multi-exchange fee crawls with exponential backoff & jitter,
 * persists normalized rate cards to Cloudflare D1, and maintains sync run audit logs.
 */

import { getDB, type D1Database } from '@/lib/db';
import { withRetry, type RetryConfig } from '@/lib/notifications/retry';
import type {
  ExchangeId,
  ExchangeName,
  MarketType,
  RateCard,
  ExchangeRateCard,
  CrawlerSyncRun,
  RateCardFilter,
} from '@/types/arbitrage';
import type {
  ExchangeCrawlerAdapter,
  CrawlServiceRunOptions,
  CrawlServiceRunResult,
  CrawlResult,
} from './types';
import { createDefaultAdapters } from './adapters';

export class ExchangeCrawlerService {
  private adapters: Map<ExchangeName, ExchangeCrawlerAdapter>;
  private db?: D1Database;

  constructor(
    adapters?: ExchangeCrawlerAdapter[] | Map<ExchangeName, ExchangeCrawlerAdapter>,
    db?: D1Database
  ) {
    if (adapters instanceof Map) {
      this.adapters = adapters;
    } else if (Array.isArray(adapters)) {
      this.adapters = new Map();
      for (const adapter of adapters) {
        this.adapters.set(adapter.exchange, adapter);
      }
    } else {
      this.adapters = createDefaultAdapters();
    }
    this.db = db;
  }

  /**
   * Resolve D1 database instance
   */
  private resolveDB(dbOverride?: D1Database): D1Database {
    if (dbOverride) return dbOverride;
    if (this.db) return this.db;
    return getDB();
  }

  /**
   * Register or replace a crawler adapter
   */
  registerAdapter(adapter: ExchangeCrawlerAdapter): void {
    this.adapters.set(adapter.exchange, adapter);
  }

  /**
   * Get an adapter by exchange name
   */
  getAdapter(exchange: ExchangeName): ExchangeCrawlerAdapter | undefined {
    return this.adapters.get(exchange);
  }

  /**
   * Get list of all registered exchange names
   */
  getSupportedExchanges(): ExchangeName[] {
    return Array.from(this.adapters.keys());
  }

  /**
   * Runs crawl across specified exchange or all registered exchanges
   * Persists rate cards to exchange_rate_cards and logs execution to crawler_sync_runs
   */
  async runCrawl(
    options: CrawlServiceRunOptions = {},
    dbOverride?: D1Database
  ): Promise<CrawlServiceRunResult> {
    const db = this.resolveDB(dbOverride);
    const targetExchanges = options.exchange
      ? [options.exchange]
      : this.getSupportedExchanges();

    const runs: CrawlerSyncRun[] = [];
    let totalCardsSaved = 0;
    let allSucceeded = true;

    for (const exchange of targetExchanges) {
      const adapter = this.adapters.get(exchange);
      if (!adapter) {
        const failedRun: CrawlerSyncRun = {
          run_id: crypto.randomUUID(),
          exchange,
          status: 'failed',
          items_count: 0,
          duration_ms: 0,
          error_message: `No adapter registered for exchange: ${exchange}`,
          created_at: new Date().toISOString(),
        };
        runs.push(failedRun);
        await this.persistSyncRun(failedRun, db);
        allSucceeded = false;
        continue;
      }

      const runId = crypto.randomUUID();
      const startTime = Date.now();

      try {
        const retryConfig: RetryConfig = {
          maxAttempts: 3,
          backoffMs: 300,
          maxBackoffMs: 2000,
        };

        const retryResult = await withRetry(async () => {
          return adapter.crawlRateCards({
            pairs: options.pairs,
            marketType: options.marketType,
            forceFallback: options.forceFallback,
            timeoutMs: options.timeoutMs ?? 5000,
          });
        }, retryConfig);

        if (!retryResult.success || !retryResult.value) {
          const lastErr = retryResult.errors[retryResult.errors.length - 1];
          throw lastErr || new Error(`Crawl failed for exchange ${exchange}`);
        }

        const crawlResult: CrawlResult = retryResult.value;
        const durationMs = Date.now() - startTime;
        const status = crawlResult.fromFallback ? 'fallback_used' : 'success';

        // Persist crawled rate cards
        const savedCount = await this.persistRateCards(crawlResult.rateCards, db);
        totalCardsSaved += savedCount;

        const syncRun: CrawlerSyncRun = {
          run_id: runId,
          exchange,
          status,
          items_count: crawlResult.rateCards.length,
          duration_ms: durationMs,
          error_message: crawlResult.error ?? null,
          metadata: JSON.stringify({
            attempts: retryResult.attempts,
            fromFallback: crawlResult.fromFallback,
            triggeredBy: options.triggeredBy ?? 'system',
          }),
          created_at: new Date().toISOString(),
        };

        runs.push(syncRun);
        await this.persistSyncRun(syncRun, db);
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errMsg = err instanceof Error ? err.message : String(err);

        // Fall back to fixtures if an unexpected catastrophic failure occurred
        const fallbackCards = adapter.getFallbackFixtures(options.marketType);
        let savedCount = 0;
        try {
          savedCount = await this.persistRateCards(fallbackCards, db);
          totalCardsSaved += savedCount;
        } catch {
          // Ignore secondary save failure
        }

        const failedRun: CrawlerSyncRun = {
          run_id: runId,
          exchange,
          status: 'fallback_used',
          items_count: fallbackCards.length,
          duration_ms: durationMs,
          error_message: `Crawling failed, fallback applied: ${errMsg}`,
          metadata: JSON.stringify({
            triggeredBy: options.triggeredBy ?? 'system',
            error: errMsg,
          }),
          created_at: new Date().toISOString(),
        };

        runs.push(failedRun);
        await this.persistSyncRun(failedRun, db);
        allSucceeded = false;
      }
    }

    return {
      runs,
      totalCardsSaved,
      success: allSucceeded,
    };
  }

  /**
   * Persists rate cards into exchange_rate_cards table with batch upsert
   */
  async persistRateCards(rateCards: RateCard[], dbOverride?: D1Database): Promise<number> {
    if (rateCards.length === 0) return 0;
    const db = this.resolveDB(dbOverride);

    const upsertSql = `
      INSERT INTO exchange_rate_cards (
        exchange, market_type, pair, raw_symbol, maker_fee, taker_fee,
        default_cashback_pct, vip_tier, volume_30d_usd, is_active, metadata,
        created_at, updated_at
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, datetime('now'), datetime('now')
      )
      ON CONFLICT (exchange, market_type, pair, vip_tier) DO UPDATE SET
        raw_symbol = excluded.raw_symbol,
        maker_fee = excluded.maker_fee,
        taker_fee = excluded.taker_fee,
        default_cashback_pct = excluded.default_cashback_pct,
        volume_30d_usd = excluded.volume_30d_usd,
        is_active = excluded.is_active,
        metadata = excluded.metadata,
        updated_at = datetime('now')
    `;

    const stmts = rateCards.map((card) =>
      db.prepare(upsertSql).bind(
        card.exchange,
        card.marketType,
        card.pair,
        card.rawSymbol ?? null,
        card.makerFee,
        card.takerFee,
        card.defaultCashbackPct,
        card.vipTier,
        card.volume30dUsd ?? 0.0,
        card.metadata ? JSON.stringify(card.metadata) : '{}'
      )
    );

    // Run in chunks of 50 to respect D1 statement limit
    const CHUNK_SIZE = 50;
    for (let i = 0; i < stmts.length; i += CHUNK_SIZE) {
      const chunk = stmts.slice(i, i + CHUNK_SIZE);
      await db.batch(chunk);
    }

    return rateCards.length;
  }

  /**
   * Persists an audit record to crawler_sync_runs table
   */
  async persistSyncRun(syncRun: CrawlerSyncRun, dbOverride?: D1Database): Promise<void> {
    const db = this.resolveDB(dbOverride);
    const sql = `
      INSERT INTO crawler_sync_runs (
        run_id, exchange, status, items_count, duration_ms, error_message, metadata, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    await db.prepare(sql).bind(
      syncRun.run_id,
      syncRun.exchange,
      syncRun.status,
      syncRun.items_count,
      syncRun.duration_ms,
      syncRun.error_message ?? null,
      typeof syncRun.metadata === 'object' ? JSON.stringify(syncRun.metadata) : syncRun.metadata ?? '{}',
      syncRun.created_at ?? new Date().toISOString()
    ).run();
  }

  /**
   * Queries stored rate cards with optional filters
   */
  async getRateCards(
    filters: RateCardFilter = {},
    dbOverride?: D1Database
  ): Promise<RateCard[]> {
    const db = this.resolveDB(dbOverride);
    const where: string[] = ['1=1'];
    const params: unknown[] = [];

    if (filters.exchange) {
      where.push('exchange = ?');
      params.push(filters.exchange);
    }
    if (filters.marketType) {
      where.push('market_type = ?');
      params.push(filters.marketType);
    }
    if (filters.pair) {
      where.push('pair = ?');
      params.push(filters.pair);
    }
    if (filters.vipTier) {
      where.push('vip_tier = ?');
      params.push(filters.vipTier);
    }
    if (filters.isActive !== undefined) {
      where.push('is_active = ?');
      params.push(filters.isActive ? 1 : 0);
    }

    const sql = `
      SELECT * FROM exchange_rate_cards
      WHERE ${where.join(' AND ')}
      ORDER BY exchange, market_type, pair, vip_tier
    `;

    const res = await db.prepare(sql).bind(...params).all<ExchangeRateCard>();
    const rows = Array.isArray(res) ? res : (res?.results || []);

    return rows.map((row) => ({
      id: row.id,
      exchange: row.exchange,
      marketType: row.market_type,
      pair: row.pair,
      rawSymbol: row.raw_symbol ?? undefined,
      makerFee: row.maker_fee,
      takerFee: row.taker_fee,
      defaultCashbackPct: row.default_cashback_pct,
      vipTier: row.vip_tier,
      volume30dUsd: row.volume_30d_usd,
      isActive: row.is_active,
      metadata: typeof row.metadata === 'string' ? JSON.parse(row.metadata || '{}') : row.metadata,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Queries recent crawler sync history
   */
  async getSyncRuns(limit = 20, dbOverride?: D1Database): Promise<CrawlerSyncRun[]> {
    const db = this.resolveDB(dbOverride);
    const clampedLimit = Math.min(100, Math.max(1, limit));

    const sql = `
      SELECT run_id, exchange, status, items_count, duration_ms, error_message, metadata, created_at
      FROM crawler_sync_runs
      ORDER BY created_at DESC, rowid DESC
      LIMIT ?
    `;

    const res = await db.prepare(sql).bind(clampedLimit).all<CrawlerSyncRun>();
    return Array.isArray(res) ? res : (res?.results || []);
  }
}

/**
 * Singleton factory for ExchangeCrawlerService
 */
let crawlerServiceInstance: ExchangeCrawlerService | null = null;

export function getExchangeCrawlerService(db?: D1Database): ExchangeCrawlerService {
  if (!crawlerServiceInstance) {
    crawlerServiceInstance = new ExchangeCrawlerService(undefined, db);
  }
  return crawlerServiceInstance;
}
