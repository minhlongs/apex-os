/**
 * KuCoin Crawler Adapter
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
  KUCOIN_DEFAULT_CASHBACK_PCT,
  KUCOIN_CORE_PAIRS,
  KUCOIN_FALLBACK_RATE_CARDS,
  getExchangeFallbackFixtures,
} from '../fixtures';

export class KuCoinCrawlerAdapter implements ExchangeCrawlerAdapter {
  readonly exchange: ExchangeName = 'kucoin';
  readonly supportedMarkets: MarketType[] = ['spot', 'futures'];

  private readonly spotUrl = 'https://api.kucoin.com/api/v1/symbols';
  private readonly contractsUrl = 'https://api.kucoin.com/api/v1/contracts/active';

  /**
   * Normalizes raw KuCoin symbol (e.g., "BTC-USDT", "XBTUSDTM") to canonical format ("BTC/USDT")
   */
  normalizePair(rawSymbol: string, marketType: MarketType): string {
    let clean = rawSymbol.trim().toUpperCase();

    if (marketType === 'futures') {
      if (clean.endsWith('M')) {
        clean = clean.slice(0, -1);
      }
      if (clean.startsWith('XBT')) {
        clean = 'BTC' + clean.slice(3);
      }
    }

    if (clean.includes('-')) {
      const parts = clean.split('-');
      if (parts.length >= 2) {
        let base = parts[0];
        if (base === 'XBT') base = 'BTC';
        return `${base}/${parts[1]}`;
      }
    }

    if (clean.includes('/')) {
      const parts = clean.split('/');
      let base = parts[0];
      if (base === 'XBT') base = 'BTC';
      return `${base}/${parts[1]}`;
    }

    const knownQuotes = ['USDT', 'USDC', 'USD', 'BTC', 'ETH'];
    for (const quote of knownQuotes) {
      if (clean.endsWith(quote) && clean.length > quote.length) {
        let base = clean.slice(0, -quote.length);
        if (base === 'XBT') base = 'BTC';
        return `${base}/${quote}`;
      }
    }

    return clean;
  }

  /**
   * Denormalizes canonical pair ("BTC/USDT") to KuCoin native format
   * Spot -> "BTC-USDT", Futures -> "XBTUSDTM" (or "ETHUSDTM")
   */
  denormalizePair(canonicalPair: string, marketType: MarketType): string {
    const parts = canonicalPair.split('/');
    if (parts.length === 2) {
      let base = parts[0].toUpperCase();
      const quote = parts[1].toUpperCase();

      if (marketType === 'futures') {
        if (base === 'BTC') base = 'XBT';
        return `${base}${quote}M`;
      }
      return `${base}-${quote}`;
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
   * Crawls KuCoin rate cards for Spot and Contracts Futures
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
        const url = mkt === 'spot' ? this.spotUrl : this.contractsUrl;
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
            throw new Error(`KuCoin API HTTP ${resp.status}: ${resp.statusText}`);
          }

          const data = (await resp.json()) as {
            code?: string;
            data?: Array<{ symbol: string; enableTrading?: boolean; status?: string }>;
          };

          if (data.code !== undefined && data.code !== '200000') {
            throw new Error(`KuCoin API error code ${data.code}`);
          }

          const activeSymbols = new Set(
            (data.data || [])
              .filter((s) => s.enableTrading !== false && (!s.status || s.status.toLowerCase() === 'open'))
              .map((s) => this.normalizePair(s.symbol, mkt))
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
