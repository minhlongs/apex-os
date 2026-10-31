/**
 * src/lib/paper/live-collector.ts
 *
 * Live Market Data Collector for ApexOS Greenfield Paper Trading.
 * Streams real-time L2 orderbooks and funding rates from Binance & Bybit
 * and feeds normalized updates directly to PaperTradingDurableObject.
 *
 * Operates strictly paper-only: zero trading keys, zero order execution.
 */

import { OrderbookSequencer } from './orderbook-sequencer';
import type {
  NormalizedOrderbook,
  PaperExchange,
  PaperMarketType,
  PaperPair,
} from './types';

export interface CollectorConfig {
  binanceRestUrl?: string;
  bybitRestUrl?: string;
  pairs?: PaperPair[];
  fetchTimeoutMs?: number;
}

export interface CollectorFetchResult {
  exchange: PaperExchange;
  pair: PaperPair;
  marketType: PaperMarketType;
  book?: NormalizedOrderbook;
  error?: string;
  latencyMs: number;
}

const DEFAULT_PAIRS: PaperPair[] = ['BTC/USDT', 'ETH/USDT'];

export class LiveMarketCollector {
  private readonly binanceRestUrl: string;
  private readonly bybitRestUrl: string;
  private readonly pairs: PaperPair[];
  private readonly fetchTimeoutMs: number;

  constructor(config?: CollectorConfig) {
    this.binanceRestUrl = config?.binanceRestUrl ?? 'https://api.binance.com';
    this.bybitRestUrl = config?.bybitRestUrl ?? 'https://api.bybit.com';
    this.pairs = config?.pairs ?? DEFAULT_PAIRS;
    this.fetchTimeoutMs = config?.fetchTimeoutMs ?? 3000;
  }

  /**
   * Fetch L2 depth snapshot from Binance Spot API.
   */
  async fetchBinanceSpotDepth(pair: PaperPair): Promise<CollectorFetchResult> {
    const symbol = pair.replace('/', '');
    const start = Date.now();
    const url = `${this.binanceRestUrl}/api/v3/depth?symbol=${symbol}&limit=20`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        return {
          exchange: 'binance',
          pair,
          marketType: 'spot',
          error: `Binance Spot HTTP ${res.status}: ${res.statusText}`,
          latencyMs: Date.now() - start,
        };
      }

      const data = (await res.json()) as {
        lastUpdateId: number;
        bids: Array<[string, string]>;
        asks: Array<[string, string]>;
      };

      const now = Date.now();
      const book: NormalizedOrderbook = {
        exchange: 'binance',
        pair,
        marketType: 'spot',
        sequenceId: data.lastUpdateId,
        exchangeTs: now,
        receivedTs: now,
        isDelta: false,
        bids: data.bids
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .sort((a, b) => b.price - a.price),
        asks: data.asks
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .sort((a, b) => a.price - b.price),
      };

      return {
        exchange: 'binance',
        pair,
        marketType: 'spot',
        book,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        exchange: 'binance',
        pair,
        marketType: 'spot',
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch L2 depth snapshot and funding rate from Binance Linear Perp (fapi).
   */
  async fetchBinancePerpDepth(pair: PaperPair): Promise<CollectorFetchResult> {
    const symbol = pair.replace('/', '');
    const start = Date.now();
    const depthUrl = `https://fapi.binance.com/fapi/v1/depth?symbol=${symbol}&limit=20`;
    const premiumIndexUrl = `https://fapi.binance.com/fapi/v1/premiumIndex?symbol=${symbol}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);

      const [depthRes, premRes] = await Promise.all([
        fetch(depthUrl, { signal: controller.signal }).catch((e) => ({ ok: false, status: 0, statusText: String(e), json: async () => null })),
        fetch(premiumIndexUrl, { signal: controller.signal }).catch(() => null),
      ]);
      clearTimeout(timer);

      if (!depthRes.ok) {
        return {
          exchange: 'binance',
          pair,
          marketType: 'linear_perp',
          error: `Binance Perp HTTP ${depthRes.status}`,
          latencyMs: Date.now() - start,
        };
      }

      const depthData = (await depthRes.json()) as {
        lastUpdateId: number;
        E: number;
        bids: Array<[string, string]>;
        asks: Array<[string, string]>;
      };

      let fundingRateBps = 0.0;
      if (premRes && 'ok' in premRes && premRes.ok) {
        try {
          const premData = (await premRes.json()) as { lastFundingRate?: string };
          if (premData?.lastFundingRate) {
            fundingRateBps = Number(premData.lastFundingRate) * 10000;
          }
        } catch {
          // Default to 0.0 bps on failure
          fundingRateBps = 0.0;
        }
      }

      const now = Date.now();
      const book: NormalizedOrderbook = {
        exchange: 'binance',
        pair,
        marketType: 'linear_perp',
        sequenceId: depthData.lastUpdateId,
        exchangeTs: depthData.E || now,
        receivedTs: now,
        isDelta: false,
        bids: depthData.bids
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .sort((a, b) => b.price - a.price),
        asks: depthData.asks
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .sort((a, b) => a.price - b.price),
        fundingRateBps,
      };

      return {
        exchange: 'binance',
        pair,
        marketType: 'linear_perp',
        book,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        exchange: 'binance',
        pair,
        marketType: 'linear_perp',
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch L2 depth snapshot from Bybit v5 Spot / Linear.
   */
  async fetchBybitDepth(
    pair: PaperPair,
    category: 'spot' | 'linear'
  ): Promise<CollectorFetchResult> {
    const symbol = pair.replace('/', '');
    const start = Date.now();
    const marketType: PaperMarketType = category === 'spot' ? 'spot' : 'linear_perp';
    const url = `${this.bybitRestUrl}/v5/market/orderbook?category=${category}&symbol=${symbol}&limit=25`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
      const res = await fetch(url, { signal: controller.signal });
      clearTimeout(timer);

      if (!res.ok) {
        return {
          exchange: 'bybit',
          pair,
          marketType,
          error: `Bybit ${category} HTTP ${res.status}: ${res.statusText}`,
          latencyMs: Date.now() - start,
        };
      }

      const data = (await res.json()) as {
        retCode: number;
        retMsg: string;
        result: {
          s: string;
          b: Array<[string, string]>;
          a: Array<[string, string]>;
          ts: number;
          u: number;
        };
      };

      if (data.retCode !== 0 || !data.result) {
        return {
          exchange: 'bybit',
          pair,
          marketType,
          error: `Bybit ${category} error: ${data.retMsg}`,
          latencyMs: Date.now() - start,
        };
      }

      const now = Date.now();
      const book: NormalizedOrderbook = {
        exchange: 'bybit',
        pair,
        marketType,
        sequenceId: data.result.u,
        exchangeTs: data.result.ts || now,
        receivedTs: now,
        isDelta: false,
        bids: data.result.b
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .sort((a, b) => b.price - a.price),
        asks: data.result.a
          .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
          .sort((a, b) => a.price - b.price),
        fundingRateBps: 0.0,
      };

      return {
        exchange: 'bybit',
        pair,
        marketType,
        book,
        latencyMs: Date.now() - start,
      };
    } catch (err) {
      return {
        exchange: 'bybit',
        pair,
        marketType,
        error: err instanceof Error ? err.message : String(err),
        latencyMs: Date.now() - start,
      };
    }
  }

  /**
   * Fetch all 4 streams across Binance and Bybit for all supported pairs.
   */
  async pollAllPairs(): Promise<CollectorFetchResult[]> {
    const promises: Array<Promise<CollectorFetchResult>> = [];
    for (const pair of this.pairs) {
      promises.push(this.fetchBinanceSpotDepth(pair));
      promises.push(this.fetchBinancePerpDepth(pair));
      promises.push(this.fetchBybitDepth(pair, 'spot'));
      promises.push(this.fetchBybitDepth(pair, 'linear'));
    }
    return Promise.all(promises);
  }
}
