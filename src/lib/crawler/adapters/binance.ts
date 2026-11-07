/**
 * Binance Crawler Adapter
 * Module: ApexOS Exchange Rate Card Crawler Engine
 */

import type {
  ExchangeName,
  MarketType,
  RateCard,
} from '@/types/arbitrage';
import type {
  ExchangeCrawlerAdapter,
  CrawlOptions,
  CrawlResult,
} from '../types';
import {
  BINANCE_DEFAULT_CASHBACK_PCT,
  BINANCE_CORE_PAIRS,
  BINANCE_FALLBACK_RATE_CARDS,
  getExchangeFallbackFixtures,
} from '../fixtures';

export class BinanceCrawlerAdapter implements ExchangeCrawlerAdapter {
  readonly exchange: ExchangeName = 'binance';
  readonly supportedMarkets: MarketType[] = ['spot', 'futures'];

  private readonly spotUrl = 'https://api.binance.com/api/v3/exchangeInfo';
  private readonly futuresUrl = 'https://fapi.binance.com/fapi/v1/exchangeInfo';

  /**
   * Normalizes raw Binance symbol (e.g., "BTCUSDT") to canonical format ("BTC/USDT")
   */
  normalizePair(rawSymbol: string, _marketType: MarketType): string {
    const clean = rawSymbol.trim().toUpperCase().replace('/', '');
    const knownQuotes = ['USDT', 'USDC', 'FDUSD', 'BUSD', 'TUSD', 'BTC', 'ETH', 'BNB'];

    for (const quote of knownQuotes) {
      if (clean.endsWith(quote) && clean.length > quote.length) {
        const base = clean.slice(0, -quote.length);
        return `${base}/${quote}`;
      }
    }

    return rawSymbol.includes('/') ? rawSymbol : clean;
  }

  /**
   * Denormalizes canonical pair ("BTC/USDT") to Binance native format ("BTCUSDT")
   */
  denormalizePair(canonicalPair: string, _marketType: MarketType): string {
    return canonicalPair.replace('/', '').toUpperCase();
  }

  /**
   * Returns deterministic edge fallback fixtures
   */
  getFallbackFixtures(marketType?: MarketType): RateCard[] {
    return getExchangeFallbackFixtures(this.exchange, marketType);
  }

  /**
   * Crawls Binance rate cards for Spot and Futures
   */
  async crawlRateCards(options: CrawlOptions = {}): Promise<CrawlResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 5000;

    if (options.forceFallback) {
      const cards = this.filterCards(this.getFallbackFixtures(options.marketType), options.pairs);
      return {
        exchange: this.exchange,
        rateCards: cards,
        itemsCount: cards.length,
        durationMs: Date.now() - startTime,
        fromFallback: true,
      };
    }

    try {
      const marketsToCrawl = options.marketType
        ? [options.marketType]
        : this.supportedMarkets;

      const rateCards: RateCard[] = [];

      for (const mkt of marketsToCrawl) {
        const url = mkt === 'spot' ? this.spotUrl : this.futuresUrl;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const resp = await fetch(url, {
            method: 'GET',
            headers: {
              'User-Agent': 'ApexOS-Crawler/1.0',
              Accept: 'application/json',
            },
            signal: controller.signal,
          });

          clearTimeout(timer);

          if (!resp.ok) {
            throw new Error(`Binance API HTTP ${resp.status}: ${resp.statusText}`);
          }

          const data = (await resp.json()) as { symbols?: Array<{ symbol: string; status?: string }> };
          const activeSymbols = new Set(
            (data.symbols || [])
              .filter((s) => !s.status || s.status === 'TRADING')
              .map((s) => this.normalizePair(s.symbol, mkt))
          );

          // Build rate cards for active pairs that we index (flag provenance truthfully)
          const baseCards = this.getFallbackFixtures(mkt);
          for (const card of baseCards) {
            if (activeSymbols.size === 0 || activeSymbols.has(card.pair)) {
              rateCards.push({
                ...card,
                metadata: {
                  ...card.metadata,
                  data_source: 'live_symbols_with_curated_rates',
                  symbols_crawled_live: true,
                },
                updatedAt: new Date().toISOString(),
              });
            }
          }
        } catch (mktErr) {
          clearTimeout(timer);
          throw mktErr;
        }
      }

      const filtered = this.filterCards(rateCards, options.pairs);
      return {
        exchange: this.exchange,
        rateCards: filtered,
        itemsCount: filtered.length,
        durationMs: Date.now() - startTime,
        fromFallback: false,
      };
    } catch (error) {
      const errMsg = error instanceof Error ? error.message : String(error);
      const fallbackCards = this.filterCards(
        this.getFallbackFixtures(options.marketType),
        options.pairs
      );

      return {
        exchange: this.exchange,
        rateCards: fallbackCards,
        itemsCount: fallbackCards.length,
        durationMs: Date.now() - startTime,
        fromFallback: true,
        error: errMsg,
      };
    }
  }

  private filterCards(cards: RateCard[], pairs?: string[]): RateCard[] {
    if (!pairs || pairs.length === 0) return cards;
    const pairSet = new Set(pairs.map((p) => p.toUpperCase()));
    return cards.filter((c) => pairSet.has(c.pair.toUpperCase()));
  }
}
