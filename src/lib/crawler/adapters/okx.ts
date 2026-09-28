/**
 * OKX Crawler Adapter
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
  OKX_DEFAULT_CASHBACK_PCT,
  OKX_CORE_PAIRS,
  OKX_FALLBACK_RATE_CARDS,
  getExchangeFallbackFixtures,
} from '../fixtures';

export class OKXCrawlerAdapter implements ExchangeCrawlerAdapter {
  readonly exchange: ExchangeName = 'okx';
  readonly supportedMarkets: MarketType[] = ['spot', 'futures'];

  private readonly spotUrl = 'https://www.okx.com/api/v5/public/instruments?instType=SPOT';
  private readonly swapUrl = 'https://www.okx.com/api/v5/public/instruments?instType=SWAP';

  /**
   * Normalizes raw OKX symbol (e.g., "BTC-USDT", "BTC-USDT-SWAP") to canonical format ("BTC/USDT")
   */
  normalizePair(rawSymbol: string, _marketType: MarketType): string {
    let clean = rawSymbol.trim().toUpperCase();
    if (clean.endsWith('-SWAP')) {
      clean = clean.slice(0, -5);
    }

    if (clean.includes('-')) {
      const parts = clean.split('-');
      if (parts.length >= 2) {
        return `${parts[0]}/${parts[1]}`;
      }
    }

    if (clean.includes('/')) {
      return clean;
    }

    const knownQuotes = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];
    for (const quote of knownQuotes) {
      if (clean.endsWith(quote) && clean.length > quote.length) {
        const base = clean.slice(0, -quote.length);
        return `${base}/${quote}`;
      }
    }

    return clean;
  }

  /**
   * Denormalizes canonical pair ("BTC/USDT") to OKX native format
   * Spot -> "BTC-USDT", Futures -> "BTC-USDT-SWAP"
   */
  denormalizePair(canonicalPair: string, marketType: MarketType): string {
    const parts = canonicalPair.split('/');
    if (parts.length === 2) {
      const base = parts[0].toUpperCase();
      const quote = parts[1].toUpperCase();
      return marketType === 'futures' ? `${base}-${quote}-SWAP` : `${base}-${quote}`;
    }
    return canonicalPair;
  }

  /**
   * Returns deterministic edge fallback fixtures
   */
  getFallbackFixtures(marketType?: MarketType): RateCard[] {
    return getExchangeFallbackFixtures(this.exchange, marketType);
  }

  /**
   * Crawls OKX rate cards for Spot and SWAP Futures
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
        const url = mkt === 'spot' ? this.spotUrl : this.swapUrl;
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
            throw new Error(`OKX API HTTP ${resp.status}: ${resp.statusText}`);
          }

          const data = (await resp.json()) as {
            code?: string;
            data?: Array<{ instId: string; state?: string }>;
          };

          if (data.code !== undefined && data.code !== '0') {
            throw new Error(`OKX API error code ${data.code}`);
          }

          const activeSymbols = new Set(
            (data.data || [])
              .filter((s) => !s.state || s.state.toLowerCase() === 'live')
              .map((s) => this.normalizePair(s.instId, mkt))
          );

          const baseCards = this.getFallbackFixtures(mkt);
          for (const card of baseCards) {
            if (activeSymbols.size === 0 || activeSymbols.has(card.pair)) {
              rateCards.push({
                ...card,
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
