/**
 * src/lib/paper/orderbook-sequencer.ts
 *
 * L2 Orderbook Sequencer with strict sequence gap detection (FEED_DESYNC),
 * staleness checks (>1000ms), cross-exchange clock skew protection (>250ms),
 * and VWAP book-depth fill simulation.
 */

import type {
  NormalizedOrderbook,
  OrderbookLevel,
  PaperExchange,
  PaperMarketType,
  PaperPair,
  SequencerStreamState,
  VwapFillResult,
} from './types';

export interface SequencerConfig {
  maxFeedAgeMs?: number;
  maxClockSkewMs?: number;
}

export interface BinanceDepthMessage {
  e?: string;
  E: number;
  s: string;
  U: number;
  u: number;
  b: Array<[string, string]>;
  a: Array<[string, string]>;
}

export interface BybitOrderbookMessage {
  topic: string;
  type: 'snapshot' | 'delta';
  ts: number;
  data: {
    s: string;
    b: Array<[string, string]>;
    a: Array<[string, string]>;
    u: number;
    seq?: number;
  };
}

export class OrderbookSequencer {
  private readonly maxFeedAgeMs: number;
  private readonly maxClockSkewMs: number;
  private readonly books = new Map<string, NormalizedOrderbook>();
  private readonly states = new Map<string, SequencerStreamState>();

  constructor(config?: SequencerConfig) {
    this.maxFeedAgeMs = config?.maxFeedAgeMs ?? 1000;
    this.maxClockSkewMs = config?.maxClockSkewMs ?? 250;
  }

  static makeStreamKey(
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType
  ): string {
    return `${exchange}:${marketType}:${pair}`;
  }

  /**
   * Parse a raw Binance depth WebSocket message into a NormalizedOrderbook.
   */
  static parseBinanceDepth(
    msg: BinanceDepthMessage,
    marketType: PaperMarketType,
    receivedTs: number,
    fundingRateBps?: number
  ): NormalizedOrderbook {
    const pair: PaperPair = msg.s.toUpperCase() === 'ETHUSDT' ? 'ETH/USDT' : 'BTC/USDT';
    // Preserve level deletions (quantity === 0) for L2 delta assembly
    const bids: OrderbookLevel[] = msg.b
      .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
      .sort((a, b) => b.price - a.price);
    const asks: OrderbookLevel[] = msg.a
      .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
      .sort((a, b) => a.price - b.price);

    return {
      exchange: 'binance',
      pair,
      marketType,
      sequenceId: msg.u,
      prevSequenceId: msg.U - 1,
      exchangeTs: msg.E,
      receivedTs,
      isDelta: true,
      bids,
      asks,
      fundingRateBps,
    };
  }

  /**
   * Parse a raw Bybit v5 orderbook WebSocket message into a NormalizedOrderbook.
   */
  static parseBybitDepth(
    msg: BybitOrderbookMessage,
    marketType: PaperMarketType,
    receivedTs: number,
    fundingRateBps?: number
  ): NormalizedOrderbook {
    const pair: PaperPair =
      msg.data.s.toUpperCase() === 'ETHUSDT' ? 'ETH/USDT' : 'BTC/USDT';
    // Preserve level deletions (quantity === 0) for L2 delta assembly
    const bids: OrderbookLevel[] = msg.data.b
      .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
      .sort((a, b) => b.price - a.price);
    const asks: OrderbookLevel[] = msg.data.a
      .map(([p, q]) => ({ price: Number(p), quantity: Number(q) }))
      .sort((a, b) => a.price - b.price);

    return {
      exchange: 'bybit',
      pair,
      marketType,
      sequenceId: msg.data.u,
      prevSequenceId: msg.type === 'snapshot' ? undefined : msg.data.u - 1,
      exchangeTs: msg.ts,
      receivedTs,
      isDelta: msg.type === 'delta',
      bids,
      asks,
      fundingRateBps,
    };
  }

  /**
   * Merge incoming L2 delta levels into an existing orderbook.
   * Levels with quantity <= 0 are removed.
   */
  static applyL2Delta(
    existing: NormalizedOrderbook,
    delta: NormalizedOrderbook
  ): NormalizedOrderbook {
    const mergeLevels = (
      current: OrderbookLevel[],
      updates: OrderbookLevel[],
      isBid: boolean
    ): OrderbookLevel[] => {
      const levelMap = new Map<number, number>();
      for (const l of current) {
        if (l.quantity > 0) levelMap.set(l.price, l.quantity);
      }
      for (const u of updates) {
        if (u.quantity <= 0) {
          levelMap.delete(u.price);
        } else {
          levelMap.set(u.price, u.quantity);
        }
      }
      const merged: OrderbookLevel[] = Array.from(levelMap.entries()).map(
        ([price, quantity]) => ({ price, quantity })
      );
      return merged.sort((a, b) => (isBid ? b.price - a.price : a.price - b.price));
    };

    return {
      exchange: delta.exchange,
      pair: delta.pair,
      marketType: delta.marketType,
      sequenceId: delta.sequenceId,
      prevSequenceId: delta.prevSequenceId,
      exchangeTs: delta.exchangeTs,
      receivedTs: delta.receivedTs,
      isDelta: false,
      bids: mergeLevels(existing.bids, delta.bids, true),
      asks: mergeLevels(existing.asks, delta.asks, false),
      fundingRateBps: delta.fundingRateBps ?? existing.fundingRateBps,
    };
  }

  /**
   * Ingest an orderbook update and verify sequence continuity and freshness.
   */
  ingest(book: NormalizedOrderbook, nowTs: number = book.receivedTs): SequencerStreamState {
    const key = OrderbookSequencer.makeStreamKey(
      book.exchange,
      book.pair,
      book.marketType
    );
    const existing = this.states.get(key);
    const feedAgeMs = Math.max(0, nowTs - book.exchangeTs);

    if (!existing) {
      const initialStatus = feedAgeMs > this.maxFeedAgeMs ? 'STALE_FEED' : 'SYNCED';
      const nextState: SequencerStreamState = {
        streamKey: key,
        exchange: book.exchange,
        pair: book.pair,
        marketType: book.marketType,
        status: initialStatus,
        lastSequenceId: book.sequenceId,
        lastExchangeTs: book.exchangeTs,
        lastReceivedTs: book.receivedTs,
        feedAgeMs,
        gapCount: 0,
        staleCount: initialStatus === 'STALE_FEED' ? 1 : 0,
        lastErrorReason:
          initialStatus === 'STALE_FEED'
            ? `Feed age ${feedAgeMs}ms exceeds limit ${this.maxFeedAgeMs}ms`
            : undefined,
      };
      this.books.set(key, book);
      this.states.set(key, nextState);
      return nextState;
    }

    // If already in FEED_DESYNC or DISCONNECTED, remain halted until explicit resyncSnapshot()
    if (existing.status === 'FEED_DESYNC' || existing.status === 'DISCONNECTED') {
      const haltedState: SequencerStreamState = {
        ...existing,
        feedAgeMs,
        lastReceivedTs: book.receivedTs,
      };
      this.states.set(key, haltedState);
      return haltedState;
    }

    // Valid repeated snapshot check (e.g., Bybit L1/L2 snapshot where u repeats when book is unchanged)
    const isRepeatedValidSnapshot =
      !book.isDelta &&
      book.prevSequenceId === undefined &&
      book.sequenceId === existing.lastSequenceId;

    // Sequence continuity check:
    // 1. Out-of-order / non-monotonic sequence ID (unless valid repeated snapshot)
    // 2. Explicit gap via prevSequenceId mismatch or jump > 1
    const expectedPrev =
      book.prevSequenceId !== undefined ? book.prevSequenceId : book.sequenceId - 1;
    const hasSequenceGap =
      !isRepeatedValidSnapshot &&
      (book.sequenceId <= existing.lastSequenceId ||
        (book.isDelta !== false && expectedPrev > existing.lastSequenceId));

    if (hasSequenceGap) {
      const desyncState: SequencerStreamState = {
        ...existing,
        status: 'FEED_DESYNC',
        feedAgeMs,
        lastReceivedTs: book.receivedTs,
        gapCount: existing.gapCount + 1,
        lastErrorReason: `Sequence gap detected on ${key}: last=${existing.lastSequenceId}, incoming=${book.sequenceId} (expectedPrev=${expectedPrev})`,
      };
      this.states.set(key, desyncState);
      return desyncState;
    }

    // Apply L2 delta if incoming book is an incremental update
    const existingBook = this.books.get(key);
    const finalBook =
      book.isDelta && existingBook
        ? OrderbookSequencer.applyL2Delta(existingBook, book)
        : book;

    if (feedAgeMs > this.maxFeedAgeMs) {
      const staleState: SequencerStreamState = {
        ...existing,
        status: 'STALE_FEED',
        lastSequenceId: book.sequenceId,
        lastExchangeTs: book.exchangeTs,
        lastReceivedTs: book.receivedTs,
        feedAgeMs,
        staleCount: existing.staleCount + 1,
        lastErrorReason: `Feed age ${feedAgeMs}ms exceeds limit ${this.maxFeedAgeMs}ms`,
      };
      this.books.set(key, finalBook);
      this.states.set(key, staleState);
      return staleState;
    }

    const syncedState: SequencerStreamState = {
      ...existing,
      status: 'SYNCED',
      lastSequenceId: book.sequenceId,
      lastExchangeTs: book.exchangeTs,
      lastReceivedTs: book.receivedTs,
      feedAgeMs,
      lastErrorReason: undefined,
    };
    this.books.set(key, finalBook);
    this.states.set(key, syncedState);
    return syncedState;
  }

  /**
   * Explicitly resync a stream from a fresh snapshot after a FEED_DESYNC event.
   */
  resyncSnapshot(
    book: NormalizedOrderbook,
    nowTs: number = book.receivedTs
  ): SequencerStreamState {
    const key = OrderbookSequencer.makeStreamKey(
      book.exchange,
      book.pair,
      book.marketType
    );
    const existing = this.states.get(key);
    const feedAgeMs = Math.max(0, nowTs - book.exchangeTs);
    const status = feedAgeMs > this.maxFeedAgeMs ? 'STALE_FEED' : 'SYNCED';

    const resyncedState: SequencerStreamState = {
      streamKey: key,
      exchange: book.exchange,
      pair: book.pair,
      marketType: book.marketType,
      status,
      lastSequenceId: book.sequenceId,
      lastExchangeTs: book.exchangeTs,
      lastReceivedTs: book.receivedTs,
      feedAgeMs,
      gapCount: existing?.gapCount ?? 0,
      staleCount: (existing?.staleCount ?? 0) + (status === 'STALE_FEED' ? 1 : 0),
      lastErrorReason: undefined,
    };

    this.books.set(key, book);
    this.states.set(key, resyncedState);
    return resyncedState;
  }

  /**
   * Validate whether two orderbook legs are synchronized and safe for paper execution.
   */
  validatePairSync(
    keyA: string,
    keyB: string,
    nowTs: number
  ): { ok: boolean; status: SequencerStreamState['status']; reason?: string } {
    const stateA = this.states.get(keyA);
    const stateB = this.states.get(keyB);
    const bookA = this.books.get(keyA);
    const bookB = this.books.get(keyB);

    if (!stateA || !stateB || !bookA || !bookB) {
      return {
        ok: false,
        status: 'UNINITIALIZED',
        reason: `Missing orderbook leg (${keyA} or ${keyB})`,
      };
    }

    if (stateA.status === 'DISCONNECTED' || stateB.status === 'DISCONNECTED') {
      return {
        ok: false,
        status: 'DISCONNECTED',
        reason: stateA.lastErrorReason || stateB.lastErrorReason || 'Feed disconnected',
      };
    }

    if (stateA.status === 'FEED_DESYNC' || stateB.status === 'FEED_DESYNC') {
      return {
        ok: false,
        status: 'FEED_DESYNC',
        reason: stateA.lastErrorReason || stateB.lastErrorReason || 'Feed desynchronized',
      };
    }

    const ageA = Math.max(0, nowTs - bookA.exchangeTs);
    const ageB = Math.max(0, nowTs - bookB.exchangeTs);
    if (ageA > this.maxFeedAgeMs || ageB > this.maxFeedAgeMs) {
      return {
        ok: false,
        status: 'STALE_FEED',
        reason: `Stale orderbook feed (ageA=${ageA}ms, ageB=${ageB}ms, max=${this.maxFeedAgeMs}ms)`,
      };
    }

    const skewMs = Math.abs(bookA.exchangeTs - bookB.exchangeTs);
    if (skewMs > this.maxClockSkewMs) {
      return {
        ok: false,
        status: 'CLOCK_SKEW',
        reason: `Cross-leg timestamp skew ${skewMs}ms exceeds ${this.maxClockSkewMs}ms`,
      };
    }

    return { ok: true, status: 'SYNCED' };
  }

  /**
   * Mark a stream as DISCONNECTED when WebSocket drops, halting trading until resyncSnapshot.
   */
  markDisconnected(
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType,
    reason = 'WebSocket connection closed'
  ): SequencerStreamState {
    const key = OrderbookSequencer.makeStreamKey(exchange, pair, marketType);
    const existing = this.states.get(key);
    const nextState: SequencerStreamState = {
      streamKey: key,
      exchange,
      pair,
      marketType,
      status: 'DISCONNECTED',
      lastSequenceId: existing?.lastSequenceId ?? 0,
      lastExchangeTs: existing?.lastExchangeTs ?? 0,
      lastReceivedTs: existing?.lastReceivedTs ?? 0,
      feedAgeMs: existing?.feedAgeMs ?? 0,
      gapCount: existing?.gapCount ?? 0,
      staleCount: existing?.staleCount ?? 0,
      lastErrorReason: reason,
    };
    this.states.set(key, nextState);
    return nextState;
  }

  getBook(
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType
  ): NormalizedOrderbook | undefined {
    return this.books.get(OrderbookSequencer.makeStreamKey(exchange, pair, marketType));
  }

  getState(
    exchange: PaperExchange,
    pair: PaperPair,
    marketType: PaperMarketType
  ): SequencerStreamState | undefined {
    return this.states.get(OrderbookSequencer.makeStreamKey(exchange, pair, marketType));
  }

  getAllStates(): SequencerStreamState[] {
    return Array.from(this.states.values());
  }

  /**
   * Compute realistic VWAP fill price across L2 orderbook depth for a target USDT notional.
   * For a 'buy' taker order, consumes asks from lowest price upward.
   * For a 'sell' taker order, consumes bids from highest price downward.
   */
  static computeVwapFill(
    book: NormalizedOrderbook,
    side: 'buy' | 'sell',
    targetNotionalUsdt: number
  ): VwapFillResult {
    const levels = side === 'buy' ? book.asks : book.bids;
    if (!levels || levels.length === 0 || targetNotionalUsdt <= 0) {
      return {
        filled: false,
        vwapPrice: 0,
        filledQuantityBase: 0,
        filledNotionalUsdt: 0,
        slippageBps: 0,
      };
    }

    const topPrice = levels[0].price;
    let remainingNotional = targetNotionalUsdt;
    let totalBase = 0;
    let totalNotional = 0;

    for (const level of levels) {
      if (remainingNotional <= 0) break;
      if (level.price <= 0 || level.quantity <= 0) continue;

      const levelMaxNotional = level.price * level.quantity;
      const takeNotional = Math.min(remainingNotional, levelMaxNotional);
      const takeBase = takeNotional / level.price;

      totalNotional += takeNotional;
      totalBase += takeBase;
      remainingNotional -= takeNotional;
    }

    if (remainingNotional > 1e-6 || totalBase <= 0) {
      return {
        filled: false,
        vwapPrice: 0,
        filledQuantityBase: totalBase,
        filledNotionalUsdt: totalNotional,
        slippageBps: 0,
      };
    }

    const vwapPrice = totalNotional / totalBase;
    const rawSlippage =
      side === 'buy'
        ? (vwapPrice - topPrice) / topPrice
        : (topPrice - vwapPrice) / topPrice;

    return {
      filled: true,
      vwapPrice: Number(vwapPrice.toFixed(6)),
      filledQuantityBase: Number(totalBase.toFixed(8)),
      filledNotionalUsdt: Number(totalNotional.toFixed(4)),
      slippageBps: Number((Math.max(0, rawSlippage) * 10000).toFixed(4)),
    };
  }
}
