/**
 * Integration and Unit Tests for ExchangeCrawlerService
 * Tests crawling orchestration, backoff retry, Cloudflare D1 persistence, and query filters.
 */

import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import { ExchangeCrawlerService } from '../service';
import type { ExchangeCrawlerAdapter, CrawlOptions, CrawlResult } from '../types';
import type { ExchangeName, MarketType, RateCard } from '@/types/arbitrage';

interface InternalPreparedStatement extends D1PreparedStatement {
  _runSync?: () => D1Result<any>;
}

function createMockD1Database(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let boundParams: any[] = [];
      const stmt = sqlite.prepare(sql);

      const prepared: InternalPreparedStatement = {
        bind(...params: any[]) {
          boundParams = params;
          return prepared;
        },
        _runSync() {
          const info = stmt.run(...boundParams);
          return {
            results: [],
            success: true,
            meta: {
              changes: info.changes,
              last_row_id: Number(info.lastInsertRowid),
              duration: 0,
              rows_read: 0,
              rows_written: info.changes,
            } as any,
          };
        },
        async run<T = unknown>(): Promise<D1Result<T>> {
          return prepared._runSync!();
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const row = stmt.get(...boundParams);
          if (!row) return null;
          if (colName) return (row as any)[colName] ?? null;
          return row as T;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const rows = stmt.all(...boundParams);
          return {
            results: rows as T[],
            success: true,
            meta: { duration: 0, rows_read: rows.length, rows_written: 0 } as any,
          };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return stmt.raw().all(...boundParams) as T[];
        },
      };

      return prepared;
    },

    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const runTransaction = sqlite.transaction(() => {
        const results: D1Result<T>[] = [];
        for (const stmt of statements) {
          const internalStmt = stmt as InternalPreparedStatement;
          if (internalStmt._runSync) {
            results.push(internalStmt._runSync());
          } else {
            throw new Error('Unsupported statement format in mock batch');
          }
        }
        return results;
      });

      return runTransaction();
    },

    async exec(sql: string) {
      sqlite.exec(sql);
      return { count: 0, duration: 0 };
    },

    async close() {
      sqlite.close();
    },
  } as D1Database;
}

describe('ExchangeCrawlerService', () => {
  let sqlite: Database.Database;
  let mockDb: D1Database;
  let service: ExchangeCrawlerService;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    // Setup deals dependency table for foreign keys
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS deals (
        id TEXT PRIMARY KEY,
        name TEXT,
        exchange TEXT,
        is_active INTEGER DEFAULT 1
      );
    `);

    // Apply migration 025
    const migrationPath = path.resolve(
      __dirname,
      '../../../database/migrations/025_deal_crawler_arbitrage.sql'
    );
    const sql = fs.readFileSync(migrationPath, 'utf8');
    sqlite.exec(sql);

    mockDb = createMockD1Database(sqlite);
    service = new ExchangeCrawlerService(undefined, mockDb);
  });

  afterEach(async () => {
    await mockDb.close();
  });

  test('initializes with all 4 supported exchange adapters', () => {
    const exchanges = service.getSupportedExchanges();
    expect(exchanges).toContain('binance');
    expect(exchanges).toContain('bybit');
    expect(exchanges).toContain('okx');
    expect(exchanges).toContain('kucoin');
    expect(exchanges.length).toBe(4);
  });

  test('runs crawl with fallback mode and persists rate cards to D1', async () => {
    const result = await service.runCrawl(
      { forceFallback: true, triggeredBy: 'admin' },
      mockDb
    );

    expect(result.success).toBe(true);
    expect(result.runs.length).toBe(4);
    expect(result.totalCardsSaved).toBeGreaterThan(0);

    for (const run of result.runs) {
      expect(run.status).toBe('fallback_used');
      expect(run.items_count).toBeGreaterThan(0);
      expect(run.duration_ms).toBeGreaterThanOrEqual(0);
    }

    // Verify rate cards stored in SQLite table
    const cardCountRow = sqlite
      .prepare('SELECT COUNT(*) as count FROM exchange_rate_cards')
      .get() as { count: number };
    expect(cardCountRow.count).toBe(result.totalCardsSaved);

    // Verify sync runs stored in SQLite table
    const runCountRow = sqlite
      .prepare('SELECT COUNT(*) as count FROM crawler_sync_runs')
      .get() as { count: number };
    expect(runCountRow.count).toBe(4);
  });

  test('persists rate cards idempotently (upsert does not duplicate)', async () => {
    await service.runCrawl(
      { exchange: 'binance', marketType: 'spot', forceFallback: true },
      mockDb
    );

    const firstCount = (
      sqlite.prepare('SELECT COUNT(*) as count FROM exchange_rate_cards').get() as { count: number }
    ).count;

    // Run again with same parameters
    await service.runCrawl(
      { exchange: 'binance', marketType: 'spot', forceFallback: true },
      mockDb
    );

    const secondCount = (
      sqlite.prepare('SELECT COUNT(*) as count FROM exchange_rate_cards').get() as { count: number }
    ).count;

    expect(secondCount).toBe(firstCount);
  });

  test('triggers auto-update trigger on exchange_rate_cards', async () => {
    await service.runCrawl(
      { exchange: 'binance', marketType: 'spot', forceFallback: true },
      mockDb
    );

    const firstRow = sqlite
      .prepare("SELECT id, updated_at FROM exchange_rate_cards WHERE pair = 'BTC/USDT' LIMIT 1")
      .get() as { id: string; updated_at: string };

    // Update maker fee to trigger trg_exchange_rate_cards_updated
    sqlite
      .prepare("UPDATE exchange_rate_cards SET maker_fee = 0.0005 WHERE id = ?")
      .run(firstRow.id);

    const updatedRow = sqlite
      .prepare("SELECT maker_fee, updated_at FROM exchange_rate_cards WHERE id = ?")
      .get(firstRow.id) as { maker_fee: number; updated_at: string };

    expect(updatedRow.maker_fee).toBe(0.0005);
    expect(updatedRow.updated_at).toBeDefined();
  });

  test('queries stored rate cards with multiple filters', async () => {
    await service.runCrawl({ forceFallback: true }, mockDb);

    // Filter by exchange
    const binanceCards = await service.getRateCards({ exchange: 'binance' }, mockDb);
    expect(binanceCards.length).toBeGreaterThan(0);
    expect(binanceCards.every((c) => c.exchange === 'binance')).toBe(true);

    // Filter by marketType
    const spotCards = await service.getRateCards({ marketType: 'spot' }, mockDb);
    expect(spotCards.length).toBeGreaterThan(0);
    expect(spotCards.every((c) => c.marketType === 'spot')).toBe(true);

    // Filter by pair
    const btcCards = await service.getRateCards({ pair: 'BTC/USDT' }, mockDb);
    expect(btcCards.length).toBeGreaterThan(0);
    expect(btcCards.every((c) => c.pair === 'BTC/USDT')).toBe(true);

    // Filter by vipTier
    const vip1Cards = await service.getRateCards({ vipTier: 'VIP1' }, mockDb);
    expect(vip1Cards.length).toBeGreaterThan(0);
    expect(vip1Cards.every((c) => c.vipTier === 'VIP1')).toBe(true);
  });

  test('queries sync runs history with limit and sort', async () => {
    await service.runCrawl({ exchange: 'binance', forceFallback: true }, mockDb);
    await service.runCrawl({ exchange: 'bybit', forceFallback: true }, mockDb);
    await service.runCrawl({ exchange: 'okx', forceFallback: true }, mockDb);

    const runs = await service.getSyncRuns(2, mockDb);
    expect(runs.length).toBe(2);
    expect(runs[0].exchange).toBe('okx');
    expect(runs[1].exchange).toBe('bybit');
  });

  test('handles unknown exchange gracefully', async () => {
    const result = await service.runCrawl(
      { exchange: 'unknown_exchange' as ExchangeName },
      mockDb
    );

    expect(result.success).toBe(false);
    expect(result.runs[0].status).toBe('failed');
    expect(result.runs[0].error_message).toContain('No adapter registered');
  });

  test('handles adapter catastrophic errors by falling back and logging', async () => {
    const faultyAdapter: ExchangeCrawlerAdapter = {
      exchange: 'binance',
      supportedMarkets: ['spot', 'futures'],
      async crawlRateCards(): Promise<CrawlResult> {
        throw new Error('Fatal socket connection drop');
      },
      getFallbackFixtures(marketType?: MarketType): RateCard[] {
        return [
          {
            exchange: 'binance',
            marketType: marketType || 'spot',
            pair: 'BTC/USDT',
            makerFee: 0.001,
            takerFee: 0.001,
            defaultCashbackPct: 20,
            vipTier: 'VIP0',
          },
        ];
      },
      normalizePair: (s) => s,
      denormalizePair: (s) => s,
    };

    service.registerAdapter(faultyAdapter);

    const result = await service.runCrawl({ exchange: 'binance' }, mockDb);
    expect(result.success).toBe(false);
    expect(result.runs[0].status).toBe('fallback_used');
    expect(result.runs[0].error_message).toContain('Fatal socket connection drop');
    expect(result.totalCardsSaved).toBeGreaterThan(0);
  });

  test('retries transient failures using exponential backoff before succeeding', async () => {
    let attempt = 0;
    const retryAdapter: ExchangeCrawlerAdapter = {
      exchange: 'bybit',
      supportedMarkets: ['spot'],
      async crawlRateCards(options?: CrawlOptions): Promise<CrawlResult> {
        attempt++;
        if (attempt < 2) {
          throw new Error('503 Service Unavailable');
        }
        return {
          exchange: 'bybit',
          rateCards: [
            {
              exchange: 'bybit',
              marketType: 'spot',
              pair: 'BTC/USDT',
              makerFee: 0.001,
              takerFee: 0.001,
              defaultCashbackPct: 40,
              vipTier: 'VIP0',
            },
          ],
          itemsCount: 1,
          durationMs: 50,
          fromFallback: false,
        };
      },
      getFallbackFixtures: () => [],
      normalizePair: (s) => s,
      denormalizePair: (s) => s,
    };

    service.registerAdapter(retryAdapter);

    const result = await service.runCrawl({ exchange: 'bybit' }, mockDb);
    expect(attempt).toBe(2);
    expect(result.success).toBe(true);
    expect(result.runs[0].status).toBe('success');
    expect(result.totalCardsSaved).toBe(1);
  });
});
