/**
 * src/lib/paper/live-collector.ts
 *
 * Live Market Data Collector for ApexOS Greenfield Paper Trading.
 *
 * Streams are WebSocket-only per the confirmed runtime decision:
 *   - Binance `@depth@100ms` (combined + partial book depth streams)
 *   - Bybit v5 `orderbook.1.{spot,linear}` (snapshot + delta)
 * REST endpoints below exist ONLY for the initial snapshot bootstrap and for
 * post-desync `resyncSnapshot` recovery; they are not the primary feed.
 *
 * Operates strictly paper-only: zero trading keys, zero order execution.
 */

import {
  OrderbookSequencer,
  type BinanceDepthMessage,
  type BybitOrderbookMessage,
} from './orderbook-sequencer';
import type {
  NormalizedOrderbook,
  OrderbookLevel,
  PaperExchange,
  PaperMarketType,
  PaperPair,
} from './types';

export interface CollectorConfig {
  binanceWsUrl?: string;
  bybitWsUrl?: string;
  binanceRestUrl?: string;
  bybitRestUrl?: string;
  pairs?: PaperPair[];
  fetchTimeoutMs?: number;
  maxReconnectDelayMs?: number;
  /** Optional WebSocket factory for deterministic testing or custom runtimes. */
  wsFactory?: (url: string) => WebSocketLike;
  /** Called for every normalized update, live or bootstrapped. */
  onBook?: (book: NormalizedOrderbook) => void;
  /** Called when a stream drops, before reconnect begins. */
  onDisconnect?: (
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType,
    reason: string
  ) => void;
}

export interface WebSocketLike {
  send(data: string): void;
  close(): void;
  addEventListener(
    type: 'open' | 'message' | 'close' | 'error',
    listener: (event: { data?: unknown; reason?: string }) => void
  ): void;
}

export interface CollectorFetchResult {
  exchange: PaperExchange;
  pair: PaperPair;
  marketType: PaperMarketType;
  book?: NormalizedOrderbook;
  error?: string;
  latencyMs: number;
}

export interface CollectorStreamStatus {
  exchange: PaperExchange;
  pair: PaperPair;
  marketType: PaperMarketType;
  connected: boolean;
  receiveCount: number;
  lastReceiveTs: number;
  lastExchangeTs: number;
  lastErrorReason?: string;
  reconnectCount: number;
}

const DEFAULT_PAIRS: PaperPair[] = ['BTC/USDT', 'ETH/USDT'];
const FUNDING_STALE_MS = 8 * 60 * 60 * 1000;

export class LiveMarketCollector {
  private readonly binanceWsUrl: string;
  private readonly bybitWsUrl: string;
  private readonly binanceRestUrl: string;
  private readonly bybitRestUrl: string;
  private readonly pairs: PaperPair[];
  private readonly fetchTimeoutMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly wsFactory?: (url: string) => WebSocketLike;
  private readonly onBook?: CollectorConfig['onBook'];
  private readonly onDisconnect?: CollectorConfig['onDisconnect'];

  private readonly sockets = new Map<string, WebSocketLike>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly statuses: CollectorStreamStatus[] = [];
  private readonly localBooks = new Map<string, NormalizedOrderbook>();
  private readonly fundingByKey = new Map<string, { rateBps: number; fetchedTs: number }>();
  private closed = false;

  constructor(config?: CollectorConfig) {
    this.binanceWsUrl =
      config?.binanceWsUrl ?? 'wss://stream.binance.com:9443/stream';
    this.bybitWsUrl = config?.bybitWsUrl ?? 'wss://stream.bybit.com/v5/public';
    this.binanceRestUrl = config?.binanceRestUrl ?? 'https://api.binance.com';
    this.bybitRestUrl = config?.bybitRestUrl ?? 'https://api.bybit.com';
    this.pairs = config?.pairs ?? DEFAULT_PAIRS;
    this.fetchTimeoutMs = config?.fetchTimeoutMs ?? 3000;
    this.maxReconnectDelayMs = config?.maxReconnectDelayMs ?? 30000;
    this.wsFactory = config?.wsFactory;
    this.onBook = config?.onBook;
    this.onDisconnect = config?.onDisconnect;

    for (const pair of this.pairs) {
      for (const exchange of ['binance', 'bybit'] as const) {
        for (const marketType of ['spot', 'linear_perp'] as const) {
          this.statuses.push({
            exchange,
            pair,
            marketType,
            connected: false,
            receiveCount: 0,
            lastReceiveTs: 0,
            lastExchangeTs: 0,
            reconnectCount: 0,
          });
        }
      }
    }
  }

  /**
   * Return the current health status of all tracked streams.
   */
  getStreamStatuses(): CollectorStreamStatus[] {
    return this.statuses.map((s) => ({ ...s }));
  }

  /**
   * Return a snapshot of the most recent normalized book for every stream.
   */
  getLatestBooks(): NormalizedOrderbook[] {
    return Array.from(this.localBooks.values());
  }

  /**
   * Determine whether all required streams are actively receiving fresh data.
   */
  isHealthy(maxAgeMs = 1500): boolean {
    if (this.statuses.length === 0) return false;
    const now = Date.now();
    return this.statuses.every(
      (s) => s.connected && s.lastReceiveTs > 0 && now - s.lastReceiveTs <= maxAgeMs
    );
  }

  /**
   * Bootstrap an initial full snapshot via REST for all streams and push to listeners.
   * Required before consuming delta streams.
   */
  async bootstrapSnapshots(): Promise<CollectorFetchResult[]> {
    const results = await this.pollAllPairs();
    for (const res of results) {
      if (res.book) {
        this.recordBookIngest(res.book);
      }
    }
    return results;
  }

  /**
   * Ingest a normalized book, updating internal metrics and routing to listener.
   */
  private recordBookIngest(book: NormalizedOrderbook): void {
    const key = OrderbookSequencer.makeStreamKey(
      book.exchange,
      book.pair,
      book.marketType
    );
    this.localBooks.set(key, book);
    const status = this.statuses.find(
      (s) =>
        s.exchange === book.exchange &&
        s.pair === book.pair &&
        s.marketType === book.marketType
    );
    if (status) {
      status.connected = true;
      status.receiveCount += 1;
      status.lastReceiveTs = book.receivedTs;
      status.lastExchangeTs = book.exchangeTs;
      status.lastErrorReason = undefined;
    }
    try {
      this.onBook?.(book);
    } catch (err) {
      console.error('[LiveMarketCollector] onBook callback error:', err);
    }
  }

  /**
   * Record a stream disconnect and notify listeners.
   */
  private recordDisconnect(
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType,
    reason: string
  ): void {
    const status = this.statuses.find(
      (s) =>
        s.exchange === exchange &&
        s.pair === pair &&
        s.marketType === marketType
    );
    if (status) {
      status.connected = false;
      status.lastErrorReason = reason;
      status.reconnectCount += 1;
    }
    try {
      this.onDisconnect?.(exchange, pair, marketType, reason);
    } catch (err) {
      console.error('[LiveMarketCollector] onDisconnect callback error:', err);
    }
  }

  /**
   * Close all active sockets and abort scheduled reconnects.
   */
  close(): void {
    this.closed = true;
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const socket of this.sockets.values()) {
      try {
        socket.close();
      } catch {
        // Ignore close error on shutdown
      }
    }
    this.sockets.clear();
    for (const status of this.statuses) {
      status.connected = false;
    }
  }

  /**
   * Start real-time WebSocket subscriptions for Binance and Bybit after
   * bootstrapping initial orderbook snapshots via REST.
   */
  async startWebSocketStreams(): Promise<void> {
    this.closed = false;
    await this.bootstrapSnapshots();

    for (const pair of this.pairs) {
      this.connectBinanceWs(pair, 'spot');
      this.connectBinanceWs(pair, 'linear_perp');
      this.connectBybitWs(pair, 'spot');
      this.connectBybitWs(pair, 'linear_perp');
    }
  }

  private createWebSocket(url: string): WebSocketLike {
    if (this.wsFactory) {
      return this.wsFactory(url);
    }
    const GlobalWS = (globalThis as unknown as { WebSocket?: new (u: string) => WebSocketLike }).WebSocket;
    if (!GlobalWS) {
      throw new Error('WebSocket runtime constructor unavailable');
    }
    return new GlobalWS(url);
  }

  private connectBinanceWs(pair: PaperPair, marketType: PaperMarketType): void {
    if (this.closed) return;
    const key = OrderbookSequencer.makeStreamKey('binance', pair, marketType);
    const symbolLower = pair.replace('/', '').toLowerCase();
    const baseWs =
      marketType === 'spot'
        ? this.binanceWsUrl
        : 'wss://fstream.binance.com/stream';
    const streams =
      marketType === 'spot'
        ? `${symbolLower}@depth@100ms`
        : `${symbolLower}@depth@100ms/${symbolLower}@markPrice@1s`;
    const url = `${baseWs}?streams=${streams}`;

    try {
      const ws = this.createWebSocket(url);
      this.sockets.set(key, ws);

      ws.addEventListener('open', () => {
        this.reconnectAttempts.set(key, 0);
      });

      ws.addEventListener('message', (evt) => {
        try {
          const raw = typeof evt.data === 'string' ? evt.data : String(evt.data ?? '');
          const parsed = JSON.parse(raw) as {
            stream?: string;
            data?: BinanceDepthMessage & {
              e?: string;
              r?: string;
              T?: number;
            };
          };
          const payload = parsed.data ?? (parsed as unknown as BinanceDepthMessage & { r?: string; T?: number });
          if (!payload) return;

          if (payload.e === 'markPriceUpdate' && payload.r !== undefined) {
            const rateBps = Number(payload.r) * 10000;
            if (Number.isFinite(rateBps)) {
              this.fundingByKey.set(key, {
                rateBps,
                fetchedTs: payload.E || Date.now(),
              });
            }
            return;
          }

          if (Array.isArray(payload.b) && Array.isArray(payload.a)) {
            const cachedFunding = this.fundingByKey.get(key);
            const now = Date.now();
            const fundingRateBps =
              cachedFunding && now - cachedFunding.fetchedTs <= FUNDING_STALE_MS
                ? cachedFunding.rateBps
                : 0.0;
            const book = OrderbookSequencer.parseBinanceDepth(
              payload,
              marketType,
              now,
              fundingRateBps
            );
            this.recordBookIngest(book);
          }
        } catch (err) {
          console.error('[LiveMarketCollector] Binance WS parse error:', err);
        }
      });

      const handleDisconnect = (reason: string) => {
        this.sockets.delete(key);
        this.recordDisconnect('binance', pair, marketType, reason);
        this.scheduleReconnect('binance', pair, marketType);
      };

      ws.addEventListener('close', (evt) => {
        handleDisconnect(evt.reason || 'Binance WebSocket closed');
      });
      ws.addEventListener('error', () => {
        handleDisconnect('Binance WebSocket error');
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.recordDisconnect('binance', pair, marketType, reason);
      this.scheduleReconnect('binance', pair, marketType);
    }
  }

  private connectBybitWs(pair: PaperPair, marketType: PaperMarketType): void {
    if (this.closed) return;
    const key = OrderbookSequencer.makeStreamKey('bybit', pair, marketType);
    const symbol = pair.replace('/', '');
    const category = marketType === 'spot' ? 'spot' : 'linear';
    const url = `${this.bybitWsUrl}/${category}`;

    try {
      const ws = this.createWebSocket(url);
      this.sockets.set(key, ws);

      ws.addEventListener('open', () => {
        this.reconnectAttempts.set(key, 0);
        const args =
          marketType === 'spot'
            ? [`orderbook.50.${symbol}`]
            : [`orderbook.50.${symbol}`, `tickers.${symbol}`];
        ws.send(JSON.stringify({ op: 'subscribe', args }));
      });

      ws.addEventListener('message', (evt) => {
        try {
          const raw = typeof evt.data === 'string' ? evt.data : String(evt.data ?? '');
          const parsed = JSON.parse(raw) as BybitOrderbookMessage & {
            data?: {
              fundingRate?: string;
              nextFundingTime?: string;
              s?: string;
              b?: Array<[string, string]>;
              a?: Array<[string, string]>;
              u?: number;
            };
          };
          if (!parsed || !parsed.topic) return;

          if (parsed.topic.startsWith('tickers.') && parsed.data?.fundingRate !== undefined) {
            const rateBps = Number(parsed.data.fundingRate) * 10000;
            if (Number.isFinite(rateBps)) {
              this.fundingByKey.set(key, {
                rateBps,
                fetchedTs: parsed.ts || Date.now(),
              });
            }
            return;
          }

          if (
            parsed.topic.startsWith('orderbook.') &&
            parsed.data &&
            Array.isArray(parsed.data.b) &&
            Array.isArray(parsed.data.a)
          ) {
            const cachedFunding = this.fundingByKey.get(key);
            const now = Date.now();
            const fundingRateBps =
              cachedFunding && now - cachedFunding.fetchedTs <= FUNDING_STALE_MS
                ? cachedFunding.rateBps
                : 0.0;
            const book = OrderbookSequencer.parseBybitDepth(
              parsed,
              marketType,
              now,
              fundingRateBps
            );
            this.recordBookIngest(book);
          }
        } catch (err) {
          console.error('[LiveMarketCollector] Bybit WS parse error:', err);
        }
      });

      const handleDisconnect = (reason: string) => {
        this.sockets.delete(key);
        this.recordDisconnect('bybit', pair, marketType, reason);
        this.scheduleReconnect('bybit', pair, marketType);
      };

      ws.addEventListener('close', (evt) => {
        handleDisconnect(evt.reason || 'Bybit WebSocket closed');
      });
      ws.addEventListener('error', () => {
        handleDisconnect('Bybit WebSocket error');
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      this.recordDisconnect('bybit', pair, marketType, reason);
      this.scheduleReconnect('bybit', pair, marketType);
    }
  }

  private scheduleReconnect(
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType
  ): void {
    if (this.closed) return;
    const key = OrderbookSequencer.makeStreamKey(exchange, pair, marketType);
    if (this.reconnectTimers.has(key)) return;

    const attempts = (this.reconnectAttempts.get(key) ?? 0) + 1;
    this.reconnectAttempts.set(key, attempts);
    const delayMs = Math.min(this.maxReconnectDelayMs, 500 * Math.pow(2, attempts - 1));

    const timer = setTimeout(async () => {
      this.reconnectTimers.delete(key);
      if (this.closed) return;
      // Bootstrap fresh REST snapshot before re-opening delta WebSocket stream
      if (exchange === 'binance') {
        const snap =
          marketType === 'spot'
            ? await this.fetchBinanceSpotDepth(pair)
            : await this.fetchBinancePerpDepth(pair);
        if (snap.book) this.recordBookIngest(snap.book);
        this.connectBinanceWs(pair, marketType);
      } else {
        const snap = await this.fetchBybitDepth(
          pair,
          marketType === 'spot' ? 'spot' : 'linear'
        );
        if (snap.book) this.recordBookIngest(snap.book);
        this.connectBybitWs(pair, marketType);
      }
    }, delayMs);

    this.reconnectTimers.set(key, timer);
  }

  /**
   * Fetch L2 depth snapshot from Binance Spot API.
   * Note: Binance Spot /api/v3/depth does not include an event timestamp `E`
   * in its JSON body (unlike fapi and WebSocket `@depth@100ms`). We parse the
   * HTTP `Date` response header when available or fall back to receive time for
   * bootstrap snapshots only; primary live updates carry `msg.E` from WebSocket.
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
        E?: number;
        bids: Array<[string, string]>;
        asks: Array<[string, string]>;
      };

      const now = Date.now();
      const headerDate = res.headers?.get?.('date');
      const parsedHeaderTs = headerDate ? Date.parse(headerDate) : NaN;
      const exchangeTs =
        typeof data.E === 'number' && data.E > 0
          ? data.E
          : Number.isFinite(parsedHeaderTs)
          ? parsedHeaderTs
          : now;

      const bids: OrderbookLevel[] = data.bids
        .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
        .sort((a, b) => b.price - a.price);
      const asks: OrderbookLevel[] = data.asks
        .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
        .sort((a, b) => a.price - b.price);

      const book: NormalizedOrderbook = {
        exchange: 'binance',
        pair,
        marketType: 'spot',
        sequenceId: data.lastUpdateId,
        exchangeTs,
        receivedTs: now,
        isDelta: false,
        bids,
        asks,
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
      let fundingRateBps: number | undefined;
      if (category === 'linear') {
        const cached = this.fundingByKey.get(`bybit:${pair}:linear_perp`);
        if (cached && now - cached.fetchedTs < FUNDING_STALE_MS) {
          fundingRateBps = cached.rateBps;
        } else {
          try {
            const tickerRes = await fetch(
              `${this.bybitRestUrl}/v5/market/tickers?category=linear&symbol=${symbol}`
            );
            if (tickerRes.ok) {
              const tickerData = (await tickerRes.json()) as {
                retCode: number;
                result?: { list?: Array<{ fundingRate?: string }> };
              };
              const item = tickerData.result?.list?.[0];
              if (item?.fundingRate !== undefined) {
                const rate = Number(item.fundingRate);
                if (Number.isFinite(rate)) {
                  fundingRateBps = rate * 10000;
                  this.fundingByKey.set(`bybit:${pair}:linear_perp`, {
                    rateBps: fundingRateBps,
                    fetchedTs: now,
                  });
                }
              }
            }
          } catch {
            // Do not default missing funding rate to synthetic profit
          }
        }
      }

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
        fundingRateBps,
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
