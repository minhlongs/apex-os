/**
 * src/lib/paper/live-collector.ts
 *
 * Live Market Data Collector for ApexOS Greenfield Paper Trading.
 *
 * Streams are WebSocket-only per the confirmed runtime decision:
 *   - Binance `@depth@100ms` (combined + partial book depth streams, with buffered snapshot bridging)
 *   - Bybit v5 `orderbook.50.{spot,linear}` (snapshot + delta)
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
  /** Optional fetch implementation for deterministic unit testing of REST fallback rotation. */
  fetchImpl?: typeof fetch;
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
export const BINANCE_SPOT_WS_ENDPOINTS: readonly string[] = [
  'wss://data-stream.binance.vision/stream',
  'wss://stream.binance.com:9443/stream',
  'wss://stream.binance.info/stream',
];
export const BINANCE_SPOT_REST_BASES: readonly string[] = [
  'https://data-api.binance.vision',
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api-gcp.binance.com',
];
export const BINANCE_PERP_WS_ENDPOINTS: readonly string[] = [
  'wss://data-stream.binance.vision/stream',
  'wss://fstream.binance.info/stream',
  'wss://fstream.binance.com/stream',
  'wss://fstream.binance.me/stream',
  'wss://fstream1.binance.com/stream',
  'wss://fstream2.binance.com/stream',
  'wss://fstream-auth.binance.com/stream',
];
export const BINANCE_PERP_REST_BASES: readonly string[] = [
  'https://fapi.binance.com',
  'https://www.binance.com',
  'https://www.binance.info',
  'https://fapi.binance.me',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://data-api.binance.vision',
];
const BINANCE_PERP_FUNDING_CACHE_TTL_MS = 8000;
const BYBIT_RESYNC_COOLDOWN_MS = 2000;
const BINANCE_PERP_FALLBACK_INTERVAL_MS = 400;
const BINANCE_PERP_FALLBACK_STALE_MS = 450;

export class LiveMarketCollector {
  private readonly binanceWsUrl: string;
  private readonly bybitWsUrl: string;
  private readonly binanceRestUrl: string;
  private readonly bybitRestUrl: string;
  private readonly pairs: PaperPair[];
  private readonly fetchTimeoutMs: number;
  private readonly maxReconnectDelayMs: number;
  private readonly wsFactory?: (url: string) => WebSocketLike;
  private readonly fetchImpl: typeof fetch;
  private readonly onBook?: CollectorConfig['onBook'];
  private readonly onDisconnect?: CollectorConfig['onDisconnect'];

  private readonly sockets = new Map<string, WebSocketLike>();
  private readonly wsOpenedKeys = new Set<string>();
  private readonly wsReceiveCounts = new Map<string, number>();
  private readonly lastWsReceiveTs = new Map<string, number>();
  private readonly reconnectAttempts = new Map<string, number>();
  private readonly reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly lastResyncAttemptMs = new Map<string, number>();
  private readonly statuses: CollectorStreamStatus[] = [];
  private readonly localBooks = new Map<string, NormalizedOrderbook>();
  private readonly fundingByKey = new Map<
    string,
    {
      rateBps: number;
      fetchedTs: number;
      nextFundingTimeMs?: number;
      lastSettledBoundaryMs?: number;
      pendingSettlementEventId?: string;
      pendingSettlementTs?: number;
      pendingSettlementRateBps?: number;
    }
  >();
  private readonly bootstrappingKeys = new Set<string>();
  private readonly bufferedDeltas = new Map<string, NormalizedOrderbook[]>();
  private preferredBinanceSpotRestIdx = 0;
  private preferredBinanceSpotWsIdx = 0;
  private preferredBinancePerpRestIdx = 0;
  private preferredBinancePerpWsIdx = 0;
  private perpFallbackTimer: ReturnType<typeof setInterval> | null = null;
  private perpFallbackInFlight = false;
  private closed = false;

  constructor(config?: CollectorConfig) {
    this.binanceWsUrl =
      config?.binanceWsUrl ?? BINANCE_SPOT_WS_ENDPOINTS[0];
    this.bybitWsUrl = config?.bybitWsUrl ?? 'wss://stream.bybit.com/v5/public';
    this.binanceRestUrl = config?.binanceRestUrl ?? BINANCE_SPOT_REST_BASES[0];
    this.bybitRestUrl = config?.bybitRestUrl ?? 'https://api.bybit.com';
    this.pairs = config?.pairs ?? DEFAULT_PAIRS;
    this.fetchTimeoutMs = config?.fetchTimeoutMs ?? 3000;
    this.maxReconnectDelayMs = config?.maxReconnectDelayMs ?? 30000;
    this.wsFactory = config?.wsFactory;
    this.fetchImpl = config?.fetchImpl ?? ((input, init) => fetch(input, init));
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
   * Determine whether a Bybit stream has an actively streaming WebSocket that has already
   * delivered at least one recent frame in the Bybit WS sequence space (~6M–8.5M).
   * Only when true must REST snapshots (`u` ~59M–68M) be skipped to avoid sequence-space
   * collision; on cold start or before WS emits its native snapshot, REST snapshots are
   * required so all 8 streams synchronize within `maxFeedAgeMs`.
   *
   * Uses `wsReceiveCounts` and `lastWsReceiveTs` (updated strictly on genuine WebSocket
   * messages, never on REST snapshot polls) so REST bootstrap ingests never masquerade
   * as active WebSocket streaming.
   */
  private isBybitWsActivelyStreaming(
    marketType: 'spot' | 'linear_perp',
    maxAgeMs = 10000
  ): boolean {
    const now = Date.now();
    return this.pairs.every((pair) => {
      const key = OrderbookSequencer.makeStreamKey('bybit', pair, marketType);
      const st = this.statuses.find(
        (s) => s.exchange === 'bybit' && s.pair === pair && s.marketType === marketType
      );
      const wsCount = this.wsReceiveCounts.get(key) ?? 0;
      const lastWsTs = this.lastWsReceiveTs.get(key) ?? 0;
      return (
        this.wsOpenedKeys.has(key) &&
        Boolean(st && st.connected && wsCount > 0 && lastWsTs > 0 && now - lastWsTs <= maxAgeMs)
      );
    });
  }

  /**
   * Bootstrap an initial full snapshot via REST for all streams and push to listeners.
   * When Bybit WebSocket streams are actively streaming (`wsOpenedKeys` + recent WS frames),
   * skips Bybit (`spot` and `linear_perp`) REST snapshots so REST `u` (~59M–68M) never
   * overwrites Bybit WS `u` (~6M–8.5M); otherwise fetches full REST snapshots so cold-start
   * and DO hibernation wake-ups synchronize all 8 streams within `maxFeedAgeMs`.
   */
  async bootstrapSnapshots(): Promise<CollectorFetchResult[]> {
    const skipBybitSpot = this.isBybitWsActivelyStreaming('spot');
    const skipBybitLinear = this.isBybitWsActivelyStreaming('linear_perp');
    const results = await this.pollAllPairs({
      skipBybitSpot,
      skipBybitLinear,
    });
    const syncedAt = Date.now();
    for (const res of results) {
      if (res.book) {
        const synchronizedBook: NormalizedOrderbook = {
          ...res.book,
          exchangeTs: Math.min(res.book.exchangeTs, syncedAt),
          receivedTs: syncedAt,
        };
        this.recordBookIngest(synchronizedBook);
      }
    }
    if (this.sockets.size > 0) {
      const now = Date.now();
      for (const pair of this.pairs) {
        for (const marketType of ['spot', 'linear_perp'] as const) {
          const key = OrderbookSequencer.makeStreamKey('bybit', pair, marketType);
          const st = this.statuses.find(
            (s) => s.exchange === 'bybit' && s.pair === pair && s.marketType === marketType
          );
          const lastWsTs = this.lastWsReceiveTs.get(key) ?? 0;
          if (!st || !st.connected || lastWsTs === 0 || now - lastWsTs > 10000) {
            await this.resyncBybitWsStream(pair, marketType);
          } else if (
            !this.bootstrappingKeys.has(key) &&
            ((marketType === 'spot' && skipBybitSpot) ||
              (marketType === 'linear_perp' && skipBybitLinear))
          ) {
            const cachedBook = this.localBooks.get(key);
            if (cachedBook) {
              this.recordBookIngest({
                ...cachedBook,
                isDelta: false,
                prevSequenceId: undefined,
                firstUpdateId: undefined,
                fundingEventId: undefined,
                fundingSettlementTs: undefined,
                exchangeTs: syncedAt,
                receivedTs: syncedAt,
              });
            }
          }
        }
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
    const prevBook = this.localBooks.get(key);
    if (book.isDelta && prevBook) {
      const mergedBook = OrderbookSequencer.applyL2Delta(prevBook, book);
      this.localBooks.set(key, {
        ...mergedBook,
        isDelta: false,
        prevSequenceId: undefined,
        firstUpdateId: undefined,
      });
    } else if (!book.isDelta) {
      this.localBooks.set(key, {
        ...book,
        isDelta: false,
        prevSequenceId: undefined,
        firstUpdateId: undefined,
      });
    } else {
      this.localBooks.set(key, book);
    }
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
    this.stopBinancePerpFallbackPump();
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
    this.wsOpenedKeys.clear();
    this.wsReceiveCounts.clear();
    this.lastWsReceiveTs.clear();
    for (const status of this.statuses) {
      status.connected = false;
    }
  }

  /**
   * Start real-time WebSocket subscriptions for Binance and Bybit, buffering
   * incoming WebSocket deltas while bootstrapping initial REST snapshots and
   * replaying bridged deltas (`u > snapshot.sequenceId`) in sequence order.
   * Note: Bybit v5 WS (`orderbook.50.{symbol}` on both `spot` and `linear`) emits
   * its own initial `"type": "snapshot"` in the WS sequence space (~6M–8.5M),
   * whereas Bybit REST returns `u` in a distinct sequence space (~59M–68M).
   * Therefore we skip REST snapshot overwrite for both `bybit:spot` and
   * `bybit:linear_perp` during WS startup and let their native WS snapshots
   * drain the buffer directly inside `ingestOrBufferWsBook`.
   */
  async startWebSocketStreams(): Promise<void> {
    this.stopBinancePerpFallbackPump();
    for (const timer of this.reconnectTimers.values()) {
      clearTimeout(timer);
    }
    this.reconnectTimers.clear();
    for (const socket of this.sockets.values()) {
      try {
        socket.close();
      } catch {
        // Ignore close error on restart
      }
    }
    this.sockets.clear();
    this.wsOpenedKeys.clear();
    this.wsReceiveCounts.clear();
    this.lastWsReceiveTs.clear();
    this.closed = false;

    for (const pair of this.pairs) {
      for (const exchange of ['binance', 'bybit'] as const) {
        for (const marketType of ['spot', 'linear_perp'] as const) {
          const key = OrderbookSequencer.makeStreamKey(exchange, pair, marketType);
          this.bootstrappingKeys.add(key);
          this.bufferedDeltas.set(key, []);
        }
      }
      this.connectBinanceWs(pair, 'spot');
      this.connectBinanceWs(pair, 'linear_perp');
      this.connectBybitWs(pair, 'spot');
      this.connectBybitWs(pair, 'linear_perp');
    }

    this.startBinancePerpFallbackPump();

    const results = await this.pollAllPairs({
      skipBybitSpot: this.isBybitWsActivelyStreaming('spot'),
      skipBybitLinear: this.isBybitWsActivelyStreaming('linear_perp'),
    });
    const syncedAt = Date.now();
    for (const res of results) {
      const key = OrderbookSequencer.makeStreamKey(
        res.exchange,
        res.pair,
        res.marketType
      );
      const st = this.statuses.find(
        (s) =>
          s.exchange === res.exchange &&
          s.pair === res.pair &&
          s.marketType === res.marketType
      );
      if (res.book && (!st || !st.connected || st.receiveCount === 0)) {
        const synchronizedBook: NormalizedOrderbook = {
          ...res.book,
          exchangeTs: Math.min(res.book.exchangeTs, syncedAt),
          receivedTs: syncedAt,
        };
        if (res.exchange === 'bybit') {
          // Record the REST snapshot so the sequencer is immediately SYNCED on cold start,
          // while keeping the stream in `bootstrappingKeys` so any early WS deltas before
          // the native WS `"type": "snapshot"` frame are buffered (not applied against REST u~59M).
          this.recordBookIngest(synchronizedBook);
        } else {
          this.applySnapshotAndDrainBuffer(key, synchronizedBook);
        }
      }
    }
  }

  /**
   * Request a fresh native WebSocket snapshot from Bybit (`orderbook.50.{symbol}`)
   * by sending `unsubscribe` + `subscribe` on the active socket (or reconnecting
   * if the socket is unavailable), with a 2000ms per-stream cooldown.
   */
  async resyncBybitWsStream(
    pair: PaperPair,
    marketType: PaperMarketType
  ): Promise<boolean> {
    const key = OrderbookSequencer.makeStreamKey('bybit', pair, marketType);
    const now = Date.now();
    const lastAttempt = this.lastResyncAttemptMs.get(key) ?? 0;
    if (now - lastAttempt < BYBIT_RESYNC_COOLDOWN_MS) {
      return false;
    }
    this.lastResyncAttemptMs.set(key, now);
    this.beginBootstrapping(key);

    const symbol = pair.replace('/', '');
    const topic = `orderbook.50.${symbol}`;
    const ws = this.sockets.get(key);
    if (ws) {
      try {
        ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
        ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
        return true;
      } catch {
        try {
          ws.close();
        } catch {
          // Ignore close error
        }
        this.sockets.delete(key);
      }
    }

    if (!this.closed) {
      this.connectBybitWs(pair, marketType);
    }
    return true;
  }

  private startBinancePerpFallbackPump(): void {
    this.stopBinancePerpFallbackPump();
    this.perpFallbackTimer = setInterval(() => {
      if (this.closed || this.perpFallbackInFlight) return;
      const now = Date.now();
      const stalePairs: PaperPair[] = [];
      for (const pair of this.pairs) {
        const key = OrderbookSequencer.makeStreamKey('binance', pair, 'linear_perp');
        const st = this.statuses.find(
          (s) =>
            s.exchange === 'binance' &&
            s.pair === pair &&
            s.marketType === 'linear_perp'
        );
        const wsOpen = this.wsOpenedKeys.has(key);
        const ageMs = st && st.lastReceiveTs > 0 ? now - st.lastReceiveTs : Infinity;
        if (!wsOpen || !st?.connected || ageMs > BINANCE_PERP_FALLBACK_STALE_MS) {
          stalePairs.push(pair);
        }
      }
      if (stalePairs.length === 0) return;

      this.perpFallbackInFlight = true;
      void Promise.all(
        stalePairs.map(async (pair) => {
          const res = await this.fetchBinancePerpDepth(pair);
          if (res.book && !this.closed) {
            this.ingestOrBufferWsBook(res.book);
          }
        })
      ).finally(() => {
        this.perpFallbackInFlight = false;
      });
    }, BINANCE_PERP_FALLBACK_INTERVAL_MS);
  }

  private stopBinancePerpFallbackPump(): void {
    if (this.perpFallbackTimer) {
      clearInterval(this.perpFallbackTimer);
      this.perpFallbackTimer = null;
    }
    this.perpFallbackInFlight = false;
  }

  beginBootstrapping(key: string): void {
    this.bootstrappingKeys.add(key);
    this.bufferedDeltas.set(key, []);
  }

  applySnapshotAndDrainBuffer(
    key: string,
    snapshotBook?: NormalizedOrderbook
  ): NormalizedOrderbook[] {
    this.bootstrappingKeys.delete(key);
    const queued = this.bufferedDeltas.get(key) ?? [];
    this.bufferedDeltas.delete(key);

    if (snapshotBook) {
      this.recordBookIngest(snapshotBook);
    }
    // On a Bybit WebSocket stream, the native `"type": "snapshot"` frame is delivered
    // in-order on the same connection. Any delta buffered prior to that snapshot
    // frame belongs to a prior subscription epoch and must be discarded.
    if (snapshotBook?.exchange === 'bybit') {
      return [];
    }
    const minSeq = snapshotBook ? snapshotBook.sequenceId : -1;
    const drained: NormalizedOrderbook[] = [];
    for (const delta of queued) {
      if (delta.sequenceId <= minSeq) {
        continue;
      }
      // Preserve authentic delta metadata (sequenceId, prevSequenceId, firstUpdateId).
      // Do NOT rewrite prevSequenceId to mask missing ranges or sequence gaps.
      // OrderbookSequencer verifies whether the delta genuinely bridges or triggers FEED_DESYNC.
      drained.push(delta);
      this.recordBookIngest(delta);
    }
    return drained;
  }

  ingestOrBufferWsBook(book: NormalizedOrderbook): boolean {
    const key = OrderbookSequencer.makeStreamKey(
      book.exchange,
      book.pair,
      book.marketType
    );
    if (book.isDelta === false) {
      this.applySnapshotAndDrainBuffer(key, book);
      return false;
    }
    if (this.bootstrappingKeys.has(key)) {
      const queue = this.bufferedDeltas.get(key) ?? [];
      queue.push(book);
      this.bufferedDeltas.set(key, queue);
      return true;
    }
    this.recordBookIngest(book);
    return false;
  }

  private updateFundingState(
    key: string,
    exchange: PaperExchange,
    pair: PaperPair,
    rateBps: number,
    eventTs: number,
    nextFundingTimeMs?: number
  ): void {
    const prev = this.fundingByKey.get(key);
    let lastSettledBoundaryMs = prev?.lastSettledBoundaryMs;
    let pendingSettlementEventId = prev?.pendingSettlementEventId;
    let pendingSettlementTs = prev?.pendingSettlementTs;
    let pendingSettlementRateBps = prev?.pendingSettlementRateBps;

    if (
      prev?.nextFundingTimeMs &&
      nextFundingTimeMs &&
      nextFundingTimeMs > prev.nextFundingTimeMs &&
      eventTs >= prev.nextFundingTimeMs &&
      lastSettledBoundaryMs !== prev.nextFundingTimeMs
    ) {
      // Verified exchange funding settlement transition: the stream crossed `prev.nextFundingTimeMs`
      // and rolled `nextFundingTimeMs` forward. Settle using the rate active right before rollover.
      lastSettledBoundaryMs = prev.nextFundingTimeMs;
      pendingSettlementTs = prev.nextFundingTimeMs;
      pendingSettlementRateBps = prev.rateBps;
      pendingSettlementEventId = `${exchange}:${pair}:funding:${prev.nextFundingTimeMs}`;
    }

    this.fundingByKey.set(key, {
      rateBps,
      fetchedTs: eventTs,
      nextFundingTimeMs: nextFundingTimeMs ?? prev?.nextFundingTimeMs,
      lastSettledBoundaryMs,
      pendingSettlementEventId,
      pendingSettlementTs,
      pendingSettlementRateBps,
    });
  }

  /**
   * Explicitly acknowledge that a funding settlement event has been ingested and durably processed.
   * Clears the pending settlement metadata so subsequent books do not keep emitting it.
   */
  ackFundingSettlement(key: string, eventId: string): void {
    const cached = this.fundingByKey.get(key);
    if (cached && cached.pendingSettlementEventId === eventId) {
      cached.pendingSettlementEventId = undefined;
      cached.pendingSettlementTs = undefined;
      cached.pendingSettlementRateBps = undefined;
    }
  }

  private consumeFundingMetadata(key: string, now: number): {
    fundingRateBps: number;
    nextFundingTimeMs?: number;
    fundingEventId?: string;
    fundingSettlementTs?: number;
  } {
    const cached = this.fundingByKey.get(key);
    if (!cached || now - cached.fetchedTs > FUNDING_STALE_MS) {
      return { fundingRateBps: 0.0 };
    }
    if (cached.pendingSettlementEventId && cached.pendingSettlementTs) {
      const eventId = cached.pendingSettlementEventId;
      const settlementTs = cached.pendingSettlementTs;
      const settledRate = cached.pendingSettlementRateBps ?? cached.rateBps;
      // Retain pendingSettlementEventId until acknowledged by downstream persistence or overwritten by next boundary
      return {
        fundingRateBps: settledRate,
        nextFundingTimeMs: cached.nextFundingTimeMs,
        fundingEventId: eventId,
        fundingSettlementTs: settlementTs,
      };
    }
    return {
      fundingRateBps: cached.rateBps,
      nextFundingTimeMs: cached.nextFundingTimeMs,
    };
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
    const attempts = this.reconnectAttempts.get(key) ?? 0;
    const spotEndpointIdx =
      attempts === 0
        ? this.preferredBinanceSpotWsIdx
        : (this.preferredBinanceSpotWsIdx + attempts) % BINANCE_SPOT_WS_ENDPOINTS.length;
    const perpEndpointIdx =
      attempts === 0
        ? this.preferredBinancePerpWsIdx
        : (this.preferredBinancePerpWsIdx + attempts) % BINANCE_PERP_WS_ENDPOINTS.length;
    const baseWs =
      marketType === 'spot'
        ? BINANCE_SPOT_WS_ENDPOINTS[spotEndpointIdx] ?? this.binanceWsUrl
        : BINANCE_PERP_WS_ENDPOINTS[perpEndpointIdx];
    const streams =
      marketType === 'spot'
        ? `${symbolLower}@depth20@100ms`
        : `${symbolLower}@depth20@100ms/${symbolLower}@markPrice@1s`;
    const url = `${baseWs}?streams=${streams}`;

    try {
      const ws = this.createWebSocket(url);
      this.sockets.set(key, ws);

      ws.addEventListener('open', () => {
        this.wsOpenedKeys.add(key);
        this.reconnectAttempts.set(key, 0);
        if (marketType === 'spot') {
          this.preferredBinanceSpotWsIdx = spotEndpointIdx;
        } else {
          this.preferredBinancePerpWsIdx = perpEndpointIdx;
        }
        // Only fetch REST bootstrap if the stream has not already synchronized via
        // REST pollAllPairs or a 100ms @depth20@100ms partial-depth WebSocket snapshot
        // within 250ms of socket open.
        setTimeout(() => {
          if (this.closed || this.sockets.get(key) !== ws) return;
          const stBefore = this.statuses.find(
            (s) =>
              s.exchange === 'binance' &&
              s.pair === pair &&
              s.marketType === marketType
          );
          if (stBefore && stBefore.connected && stBefore.receiveCount > 0) {
            return;
          }
          void (async () => {
            const snap =
              marketType === 'spot'
                ? await this.fetchBinanceSpotDepth(pair)
                : await this.fetchBinancePerpDepth(pair);
            const st = this.statuses.find(
              (s) =>
                s.exchange === 'binance' &&
                s.pair === pair &&
                s.marketType === marketType
            );
            if (!this.closed && snap.book && (!st || !st.connected || st.receiveCount === 0)) {
              this.applySnapshotAndDrainBuffer(key, snap.book);
            }
          })();
        }, 250);
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
              lastUpdateId?: number;
              bids?: Array<[string, string]>;
              asks?: Array<[string, string]>;
            };
          };
          const payload =
            parsed.data ??
            (parsed as unknown as BinanceDepthMessage & {
              r?: string;
              T?: number;
              lastUpdateId?: number;
              bids?: Array<[string, string]>;
              asks?: Array<[string, string]>;
            });
          if (!payload) return;

          if (payload.e === 'markPriceUpdate' && payload.r !== undefined) {
            const rateBps = Number(payload.r) * 10000;
            const nextFundingTs =
              typeof payload.T === 'number' && payload.T > 0 ? payload.T : undefined;
            if (Number.isFinite(rateBps)) {
              this.updateFundingState(
                key,
                'binance',
                pair,
                rateBps,
                payload.E || Date.now(),
                nextFundingTs
              );
            }
            return;
          }

          const isPartialDepthStream = Boolean(parsed.stream?.includes('@depth20'));
          const hasBidsAsks =
            (Array.isArray(payload.b) && Array.isArray(payload.a)) ||
            (Array.isArray(payload.bids) && Array.isArray(payload.asks));
          if (hasBidsAsks) {
            const now = Date.now();
            const fundingMeta = this.consumeFundingMetadata(key, now);
            let resolvedFundingRateBps = fundingMeta.fundingRateBps;
            if (
              marketType === 'linear_perp' &&
              resolvedFundingRateBps === undefined &&
              baseWs?.includes('data-stream.binance.vision')
            ) {
              const bybitFunding = this.fundingByKey.get(
                OrderbookSequencer.makeStreamKey('bybit', pair, 'linear_perp')
              );
              if (bybitFunding && Number.isFinite(bybitFunding.rateBps)) {
                resolvedFundingRateBps = bybitFunding.rateBps;
              }
            }
            const book =
              isPartialDepthStream || Array.isArray(payload.bids)
                ? OrderbookSequencer.parseBinancePartialDepthSnapshot(
                    payload,
                    pair,
                    marketType,
                    now,
                    resolvedFundingRateBps
                  )
                : OrderbookSequencer.parseBinanceDepth(
                    payload,
                    marketType,
                    now,
                    resolvedFundingRateBps
                  );
            if (fundingMeta.nextFundingTimeMs !== undefined) {
              book.nextFundingTimeMs = fundingMeta.nextFundingTimeMs;
            }
            if (fundingMeta.fundingEventId) {
              book.fundingEventId = fundingMeta.fundingEventId;
              book.fundingSettlementTs = fundingMeta.fundingSettlementTs;
            }
            this.wsReceiveCounts.set(key, (this.wsReceiveCounts.get(key) ?? 0) + 1);
            this.lastWsReceiveTs.set(key, now);
            this.ingestOrBufferWsBook(book);
          }
        } catch (err) {
          console.error('[LiveMarketCollector] Binance WS parse error:', err);
        }
      });

      let disconnectHandled = false;
      const handleDisconnect = (reason: string) => {
        // Ignore late events from a socket that was already replaced by a newer attempt
        // (reconnect, restart, or shutdown): otherwise a closing socket marks the live
        // replacement stream disconnected and inflates the reconnect counter.
        if (this.closed || disconnectHandled || this.sockets.get(key) !== ws) return;
        disconnectHandled = true;
        this.sockets.delete(key);
        this.wsOpenedKeys.delete(key);
        const st = this.statuses.find(
          (s) =>
            s.exchange === 'binance' &&
            s.pair === pair &&
            s.marketType === marketType
        );
        const now = Date.now();
        const isPerpCoveredByFallback =
          marketType === 'linear_perp' &&
          this.perpFallbackTimer !== null &&
          Boolean(st && st.lastReceiveTs > 0 && now - st.lastReceiveTs <= 1000);
        if (isPerpCoveredByFallback && st) {
          st.lastErrorReason = reason;
          st.reconnectCount += 1;
        } else {
          this.recordDisconnect('binance', pair, marketType, reason);
        }
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
      this.wsOpenedKeys.delete(key);
      const st = this.statuses.find(
        (s) =>
          s.exchange === 'binance' &&
          s.pair === pair &&
          s.marketType === marketType
      );
      const now = Date.now();
      const isPerpCoveredByFallback =
        marketType === 'linear_perp' &&
        this.perpFallbackTimer !== null &&
        Boolean(st && st.lastReceiveTs > 0 && now - st.lastReceiveTs <= 1000);
      if (isPerpCoveredByFallback && st) {
        st.lastErrorReason = reason;
        st.reconnectCount += 1;
      } else {
        this.recordDisconnect('binance', pair, marketType, reason);
      }
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
        this.wsOpenedKeys.add(key);
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
            const nextFundingTs = parsed.data.nextFundingTime
              ? Number(parsed.data.nextFundingTime)
              : undefined;
            if (Number.isFinite(rateBps)) {
              this.updateFundingState(
                key,
                'bybit',
                pair,
                rateBps,
                parsed.ts || Date.now(),
                Number.isFinite(nextFundingTs) && (nextFundingTs ?? 0) > 0
                  ? nextFundingTs
                  : undefined
              );
            }
            return;
          }

          if (
            parsed.topic.startsWith('orderbook.') &&
            parsed.data &&
            Array.isArray(parsed.data.b) &&
            Array.isArray(parsed.data.a)
          ) {
            const now = Date.now();
            const fundingMeta = this.consumeFundingMetadata(key, now);
            const book = OrderbookSequencer.parseBybitDepth(
              parsed,
              marketType,
              now,
              fundingMeta.fundingRateBps
            );
            if (fundingMeta.nextFundingTimeMs !== undefined) {
              book.nextFundingTimeMs = fundingMeta.nextFundingTimeMs;
            }
            if (fundingMeta.fundingEventId) {
              book.fundingEventId = fundingMeta.fundingEventId;
              book.fundingSettlementTs = fundingMeta.fundingSettlementTs;
            }
            this.wsReceiveCounts.set(key, (this.wsReceiveCounts.get(key) ?? 0) + 1);
            this.lastWsReceiveTs.set(key, now);
            this.ingestOrBufferWsBook(book);
          }
        } catch (err) {
          console.error('[LiveMarketCollector] Bybit WS parse error:', err);
        }
      });

      let disconnectHandled = false;
      const handleDisconnect = (reason: string) => {
        // Ignore late events from a socket that was already replaced by a newer attempt
        // (reconnect, restart, or shutdown): otherwise a closing socket marks the live
        // replacement stream disconnected and inflates the reconnect counter.
        if (this.closed || disconnectHandled || this.sockets.get(key) !== ws) return;
        disconnectHandled = true;
        this.sockets.delete(key);
        this.wsOpenedKeys.delete(key);
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
      this.wsOpenedKeys.delete(key);
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
      // Open WebSocket stream first with delta buffering enabled, then fetch REST snapshot
      // and drain bridged deltas (`u > snapshot.sequenceId`) without missing in-flight updates.
      this.bootstrappingKeys.add(key);
      this.bufferedDeltas.set(key, []);
      if (exchange === 'binance') {
        this.connectBinanceWs(pair, marketType);
        const snap =
          marketType === 'spot'
            ? await this.fetchBinanceSpotDepth(pair)
            : await this.fetchBinancePerpDepth(pair);
        if (snap.book) {
          this.applySnapshotAndDrainBuffer(key, snap.book);
        }
      } else {
        this.connectBybitWs(pair, marketType);
      }
    }, delayMs);

    this.reconnectTimers.set(key, timer);
  }

  /**
   * Fetch L2 depth snapshot from Binance Spot API.
   * Rotates across `BINANCE_SPOT_REST_BASES` (starting with `https://data-api.binance.vision`,
   * which routes directly to Binance's AWS ALB without CloudFront WAF 403 blocks on Cloudflare Edge)
   * with sticky memoization of the working endpoint.
   */
  async fetchBinanceSpotDepth(pair: PaperPair): Promise<CollectorFetchResult> {
    const symbol = pair.replace('/', '');
    const start = Date.now();
    let lastError = 'Binance Spot HTTP error';

    for (let offset = 0; offset < BINANCE_SPOT_REST_BASES.length; offset++) {
      const idx =
        (this.preferredBinanceSpotRestIdx + offset) % BINANCE_SPOT_REST_BASES.length;
      const base = BINANCE_SPOT_REST_BASES[idx];
      const url = `${base}/api/v3/depth?symbol=${symbol}&limit=20`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        const res = await this.fetchImpl(url, { signal: controller.signal }).catch((e) => ({
          ok: false,
          status: 0,
          statusText: String(e),
          headers: undefined,
          json: async () => null,
        }));
        clearTimeout(timer);

        if (!res.ok) {
          lastError = `Binance Spot HTTP ${res.status} (${base})`;
          continue;
        }

        const data = (await res.json()) as {
          lastUpdateId?: number;
          E?: number;
          bids?: Array<[string, string]>;
          asks?: Array<[string, string]>;
        } | null;

        if (
          !data ||
          typeof data.lastUpdateId !== 'number' ||
          !Array.isArray(data.bids) ||
          !Array.isArray(data.asks)
        ) {
          lastError = `Binance Spot invalid depth payload (${base})`;
          continue;
        }

        this.preferredBinanceSpotRestIdx = idx;
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
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    const status = this.statuses.find(
      (s) =>
        s.exchange === 'binance' &&
        s.pair === pair &&
        s.marketType === 'spot'
    );
    if (status && (!status.connected || status.receiveCount === 0)) {
      status.lastErrorReason = lastError;
    }
    return {
      exchange: 'binance',
      pair,
      marketType: 'spot',
      error: lastError,
      latencyMs: Date.now() - start,
    };
  }

  /**
   * Fetch L2 depth snapshot and funding rate from Binance Linear Perp (fapi).
   * Rotates across `BINANCE_PERP_REST_BASES` with sticky memoization of the
   * working endpoint, and caches `premiumIndex` independently (8s TTL) so
   * funding fetch errors never fail orderbook snapshots.
   */
  async fetchBinancePerpDepth(pair: PaperPair): Promise<CollectorFetchResult> {
    const symbol = pair.replace('/', '');
    const start = Date.now();
    const key = OrderbookSequencer.makeStreamKey('binance', pair, 'linear_perp');

    let depthData: {
      lastUpdateId: number;
      E?: number;
      bids: Array<[string, string]>;
      asks: Array<[string, string]>;
    } | null = null;
    let workingBase = BINANCE_PERP_REST_BASES[this.preferredBinancePerpRestIdx];
    let lastError = 'Binance Perp HTTP error';

    for (let offset = 0; offset < BINANCE_PERP_REST_BASES.length; offset++) {
      const idx =
        (this.preferredBinancePerpRestIdx + offset) % BINANCE_PERP_REST_BASES.length;
      const base = BINANCE_PERP_REST_BASES[idx];
      const depthPath = base.includes('data-api.binance.vision')
        ? `/api/v3/depth?symbol=${symbol}&limit=20`
        : `/fapi/v1/depth?symbol=${symbol}&limit=20`;
      const depthUrl = `${base}${depthPath}`;

      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        const depthRes = await this.fetchImpl(depthUrl, { signal: controller.signal }).catch((e) => ({
          ok: false,
          status: 0,
          statusText: String(e),
          json: async () => null,
        }));
        clearTimeout(timer);

        if (!depthRes.ok) {
          lastError = `Binance Perp HTTP ${depthRes.status} (${base})`;
          continue;
        }

        const parsed = (await depthRes.json()) as {
          lastUpdateId?: number;
          E?: number;
          bids?: Array<[string, string]>;
          asks?: Array<[string, string]>;
        } | null;

        if (
          parsed &&
          typeof parsed.lastUpdateId === 'number' &&
          Array.isArray(parsed.bids) &&
          Array.isArray(parsed.asks)
        ) {
          depthData = {
            lastUpdateId: parsed.lastUpdateId,
            E: parsed.E,
            bids: parsed.bids,
            asks: parsed.asks,
          };
          this.preferredBinancePerpRestIdx = idx;
          workingBase = base;
          break;
        }
        lastError = `Binance Perp invalid depth payload (${base})`;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
      }
    }

    if (!depthData) {
      const status = this.statuses.find(
        (s) =>
          s.exchange === 'binance' &&
          s.pair === pair &&
          s.marketType === 'linear_perp'
      );
      if (status && (!status.connected || status.receiveCount === 0)) {
        status.lastErrorReason = lastError;
      }
      return {
        exchange: 'binance',
        pair,
        marketType: 'linear_perp',
        error: lastError,
        latencyMs: Date.now() - start,
      };
    }

    const now = Date.now();
    const cachedFunding = this.fundingByKey.get(key);
    if (
      !workingBase.includes('data-api.binance.vision') &&
      (!cachedFunding || now - cachedFunding.fetchedTs > BINANCE_PERP_FUNDING_CACHE_TTL_MS)
    ) {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.fetchTimeoutMs);
        const premRes = await this.fetchImpl(
          `${workingBase}/fapi/v1/premiumIndex?symbol=${symbol}`,
          { signal: controller.signal }
        ).catch(() => null);
        clearTimeout(timer);

        if (premRes && 'ok' in premRes && premRes.ok) {
          const premData = (await premRes.json()) as {
            lastFundingRate?: string;
            nextFundingTime?: number;
            time?: number;
          };
          if (premData?.lastFundingRate !== undefined) {
            const rateBps = Number(premData.lastFundingRate) * 10000;
            const nextFundingTs =
              typeof premData.nextFundingTime === 'number' && premData.nextFundingTime > 0
                ? premData.nextFundingTime
                : undefined;
            if (Number.isFinite(rateBps)) {
              this.updateFundingState(
                key,
                'binance',
                pair,
                rateBps,
                premData.time || now,
                nextFundingTs
              );
            }
          }
        }
      } catch {
        // Decoupled: never fail orderbook depth snapshot on premiumIndex error
      }
    }

    const fundingMeta = this.consumeFundingMetadata(key, now);
    let resolvedFundingRateBps = fundingMeta.fundingRateBps;
    if (
      resolvedFundingRateBps === undefined &&
      workingBase.includes('data-api.binance.vision')
    ) {
      const bybitFunding = this.fundingByKey.get(
        OrderbookSequencer.makeStreamKey('bybit', pair, 'linear_perp')
      );
      if (bybitFunding && Number.isFinite(bybitFunding.rateBps)) {
        resolvedFundingRateBps = bybitFunding.rateBps;
      }
    }

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
      fundingRateBps: resolvedFundingRateBps,
      nextFundingTimeMs: fundingMeta.nextFundingTimeMs,
      fundingEventId: fundingMeta.fundingEventId,
      fundingSettlementTs: fundingMeta.fundingSettlementTs,
    };

    return {
      exchange: 'binance',
      pair,
      marketType: 'linear_perp',
      book,
      latencyMs: Date.now() - start,
    };
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
      const res = await this.fetchImpl(url, { signal: controller.signal });
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
            const tickerRes = await this.fetchImpl(
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
   * When `skipBybitSpot` or `skipBybitLinear` is true, omits the corresponding
   * Bybit REST fetches so REST `u` (~59M–68M) never overwrites active Bybit WS sequences (~6M–8.5M).
   */
  async pollAllPairs(options?: {
    skipBybitSpot?: boolean;
    skipBybitLinear?: boolean;
  }): Promise<CollectorFetchResult[]> {
    const promises: Array<Promise<CollectorFetchResult>> = [];
    for (const pair of this.pairs) {
      promises.push(this.fetchBinanceSpotDepth(pair));
      promises.push(this.fetchBinancePerpDepth(pair));
      if (!options?.skipBybitSpot) {
        promises.push(this.fetchBybitDepth(pair, 'spot'));
      }
      if (!options?.skipBybitLinear) {
        promises.push(this.fetchBybitDepth(pair, 'linear'));
      }
    }
    return Promise.all(promises);
  }
}
