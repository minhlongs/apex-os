/**
 * Crawler Adapter and Service Interfaces
 * Module: ApexOS Multi-Exchange Rate Card Crawler Engine
 */

import type {
  ExchangeId,
  ExchangeName,
  MarketType,
  RateCard,
  CrawlerSyncRun,
  OpportunityType,
  RateCardFilter,
} from '@/types/arbitrage';

export type {
  ExchangeId,
  ExchangeName,
  MarketType,
  RateCard,
  CrawlerSyncRun,
  OpportunityType,
  RateCardFilter,
};

/**
 * Options passed to adapter crawl executions
 */
export interface CrawlOptions {
  pairs?: string[];
  marketType?: MarketType;
  forceFallback?: boolean;
  timeoutMs?: number;
}

/**
 * Result returned by an individual exchange crawler adapter
 */
export interface CrawlResult {
  exchange: ExchangeName;
  rateCards: RateCard[];
  itemsCount: number;
  durationMs: number;
  fromFallback: boolean;
  error?: string;
}

/**
 * Standard contract for exchange rate card crawler adapters
 */
export interface ExchangeCrawlerAdapter {
  readonly exchange: ExchangeName;
  readonly supportedMarkets: MarketType[];

  /**
   * Crawls live rate cards from exchange endpoints.
   * If network fails or times out, gracefully falls back to deterministic fixtures.
   */
  crawlRateCards(options?: CrawlOptions): Promise<CrawlResult>;

  /**
   * Deterministic edge-compatible fallback fixtures for offline resilience and testing
   */
  getFallbackFixtures(marketType?: MarketType): RateCard[];

  /**
   * Normalizes native exchange symbol to canonical format (e.g. "BTCUSDT" -> "BTC/USDT")
   */
  normalizePair(rawSymbol: string, marketType: MarketType): string;

  /**
   * Denormalizes canonical pair to exchange native format (e.g. "BTC/USDT" -> "BTCUSDT")
   */
  denormalizePair(canonicalPair: string, marketType: MarketType): string;
}

/**
 * Options for crawler service crawl orchestration
 */
export interface CrawlServiceRunOptions {
  exchange?: ExchangeName;
  marketType?: MarketType;
  pairs?: string[];
  forceFallback?: boolean;
  timeoutMs?: number;
  triggeredBy?: 'system' | 'cron' | 'admin';
}

/**
 * Result returned by crawler service crawl execution
 */
export interface CrawlServiceRunResult {
  runs: CrawlerSyncRun[];
  totalCardsSaved: number;
  success: boolean;
}
