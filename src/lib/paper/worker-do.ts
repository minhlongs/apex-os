/**
 * src/lib/paper/worker-do.ts
 *
 * Cloudflare Durable Object implementation for the Greenfield Paper Trading Engine.
 * Coordinates LiveMarketCollector (WebSocket + REST snapshot resync), OrderbookSequencer,
 * two independent 10,000 USDT Strategy Engines ('spot-2exch' and 'spot-perp'),
 * and the Immutable PaperJournal (with D1 outbox, runs tracking, and R2 raw replay archive).
 */

import { createHash } from 'node:crypto';
import type { D1Database } from '../db';
import { buildCanonical50TickSequence } from './fixtures';
import { PaperJournal, type R2BucketLike } from './journal';
import { LiveMarketCollector, type CollectorConfig } from './live-collector';
import { OrderbookSequencer } from './orderbook-sequencer';
import { PaperReplayEngine } from './replay';
import { PaperStrategyEngine } from './strategy-engine';
import type {
  NormalizedOrderbook,
  PaperClosedCycle,
  PaperPair,
  PaperStrategyId,
  PaperStrategySnapshot,
} from './types';

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  setAlarm?(scheduledTime: number | Date): Promise<void>;
  getAlarm?(): Promise<number | null>;
}

export interface DurableObjectEnvLike {
  DB?: D1Database;
  STORAGE?: R2BucketLike;
}

export interface DurableObjectStateLike {
  storage: DurableObjectStorageLike;
}

const PAIRS: PaperPair[] = ['BTC/USDT', 'ETH/USDT'];
const STRATEGY_IDS: PaperStrategyId[] = ['spot-2exch', 'spot-perp'];

export const PAPER_MODEL_VERSION = 'paper-v1.1.0';
export const PAPER_FROZEN_CONFIG_HASH = createHash('sha256')
  .update(
    JSON.stringify({
      modelVersion: PAPER_MODEL_VERSION,
      initialCapitalUsdt: 10000,
      maxCycleNotionalUsdt: 1500,
      minNetSpreadBps: 5,
      closeSpreadThresholdBps: 3,
      maxHoldDurationMs: 3600000,
      maxDrawdownPct: 2.0,
      executionLatencyBps: 1.5,
      rebalanceFeeBps: 2.0,
    })
  )
  .digest('hex');

export class PaperTradingDurableObject {
  private readonly state: DurableObjectStateLike;
  private readonly env?: DurableObjectEnvLike;
  private readonly sequencer: OrderbookSequencer;
  private readonly strategies: Map<PaperStrategyId, PaperStrategyEngine>;
  private readonly journal: PaperJournal;
  private collector: LiveMarketCollector | null = null;
  private tickCounter = 0;
  private runStartedAtMs: number | null = null;
  private lastLiveIngestTsMs: number | null = null;
  private readonly modelVersion = PAPER_MODEL_VERSION;
  private readonly configHash = PAPER_FROZEN_CONFIG_HASH;
  private initialized = false;

  constructor(state: DurableObjectStateLike, env?: DurableObjectEnvLike) {
    this.state = state;
    this.env = env;
    this.sequencer = new OrderbookSequencer({
      maxFeedAgeMs: 1000,
      maxClockSkewMs: 250,
    });
    this.strategies = new Map<PaperStrategyId, PaperStrategyEngine>();
    for (const sid of STRATEGY_IDS) {
      this.strategies.set(
        sid,
        new PaperStrategyEngine({
          strategyId: sid,
          modelVersion: this.modelVersion,
          initialCapitalUsdt: 10000,
        })
      );
    }
    this.journal = new PaperJournal();
  }

  async ensureRestored(): Promise<void> {
    if (this.initialized) return;
    const storedTick = await this.state.storage.get<number>('last_tick_counter');
    if (storedTick !== undefined) {
      this.tickCounter = storedTick;
    }
    const storedRunStart = await this.state.storage.get<number>('run_started_at_ms');
    if (storedRunStart !== undefined) {
      this.runStartedAtMs = storedRunStart;
    }
    const storedLastIngest = await this.state.storage.get<number>('last_live_ingest_ts_ms');
    if (storedLastIngest !== undefined) {
      this.lastLiveIngestTsMs = storedLastIngest;
    }

    const storedCycles = await this.state.storage.get<PaperClosedCycle[]>('paper_closed_cycles');
    if (storedCycles && Array.isArray(storedCycles)) {
      for (const cycle of storedCycles) {
        await this.journal.recordClosedCycle(cycle, this.env?.DB, this.env?.STORAGE);
      }
    } else if (this.env?.DB) {
      await this.journal.loadFromD1(this.env.DB);
    }

    for (const sid of STRATEGY_IDS) {
      const savedStrategyState = await this.state.storage.get<
        ReturnType<PaperStrategyEngine['serializeState']>
      >(`strategy_state_${sid}`);
      if (savedStrategyState) {
        this.strategies.get(sid)?.restoreState(savedStrategyState);
      }
    }
    this.initialized = true;
  }

  /**
   * Initialize and start LiveMarketCollector (WebSocket streams + periodic alarm heartbeat).
   */
  async startLiveCollector(options?: CollectorConfig): Promise<{
    started: boolean;
    streamStatuses: ReturnType<LiveMarketCollector['getStreamStatuses']>;
  }> {
    await this.ensureRestored();

    if (!this.runStartedAtMs) {
      this.runStartedAtMs = Date.now();
      await this.state.storage.put('run_started_at_ms', this.runStartedAtMs);
    }

    if (!this.collector) {
      this.collector = new LiveMarketCollector({
        ...options,
        pairs: PAIRS,
        onBook: (book: NormalizedOrderbook) => {
          void (async () => {
            if (book.isDelta === false) {
              await this.resyncStream(book, book.receivedTs);
            } else {
              const res = await this.ingestOrderbook(book, book.receivedTs);
              if (res.streamState.status === 'FEED_DESYNC' && this.collector) {
                const snapshotRes =
                  book.exchange === 'binance'
                    ? book.marketType === 'spot'
                      ? await this.collector.fetchBinanceSpotDepth(book.pair)
                      : await this.collector.fetchBinancePerpDepth(book.pair)
                    : await this.collector.fetchBybitDepth(
                        book.pair,
                        book.marketType === 'spot' ? 'spot' : 'linear'
                      );
                if (snapshotRes.book) {
                  await this.resyncStream(snapshotRes.book, snapshotRes.book.receivedTs);
                }
              }
            }
          })();
        },
      });
    }

    // Bootstrap fresh L2 REST snapshots before applying deltas
    await this.collector.bootstrapSnapshots();
    this.collector.startWebSocketStreams();

    // Schedule next DO alarm in 15s for health monitoring & outbox reconciliation
    if (this.state.storage.setAlarm) {
      await this.state.storage.setAlarm(Date.now() + 15000);
    }

    return {
      started: true,
      streamStatuses: this.collector.getStreamStatuses(),
    };
  }

  async stopLiveCollector(): Promise<void> {
    if (this.collector) {
      this.collector.close();
      this.collector = null;
    }
  }

  /**
   * Cloudflare Durable Object alarm handler:
   * - Verifies collector stream health and triggers snapshot resync if stale
   * - Reconciles D1/R2 outbox
   * - Updates paper_trading_runs heartbeat
   */
  async alarm(): Promise<void> {
    await this.ensureRestored();
    const now = Date.now();

    if (this.collector) {
      if (!this.collector.isHealthy(10000)) {
        await this.collector.bootstrapSnapshots();
      }
    }

    if (this.env?.DB) {
      await this.journal.reconcileOutbox(this.env.DB, this.env.STORAGE);
      await this.syncRunsInD1(now);
    }

    if (this.collector && this.state.storage.setAlarm) {
      await this.state.storage.setAlarm(Date.now() + 15000);
    }
  }

  private async syncRunsInD1(nowMs: number): Promise<void> {
    if (!this.env?.DB || !this.runStartedAtMs) return;

    const elapsedDays = Math.max(0, (nowMs - this.runStartedAtMs) / (24 * 3600 * 1000));
    const isTrulyLive = this.isCollectorLive(nowMs);

    for (const sid of STRATEGY_IDS) {
      const snap = this.strategies.get(sid)!.getSnapshot();
      const verifiedDays = isTrulyLive ? elapsedDays : 0;
      const verdict: 'GO' | 'NO_GO' =
        verifiedDays >= 30 &&
        snap.closedCyclesCount >= 100 &&
        snap.realizedNetPnlUsdt > 0 &&
        snap.maxDrawdownPct <= 2.0 &&
        !snap.haltedByDrawdown
          ? 'GO'
          : 'NO_GO';

      await this.journal.syncPaperRun(
        `run_${sid}_${this.runStartedAtMs}`,
        sid,
        this.modelVersion,
        this.configHash,
        this.env.DB,
        {
          verifiedRealMarketDays: Number(verifiedDays.toFixed(4)),
          closedCyclesCount: snap.closedCyclesCount,
          realizedNetPnlUsdt: snap.realizedNetPnlUsdt,
          maxDrawdownPct: snap.maxDrawdownPct,
          verdict,
          isActive: true,
        }
      );
    }
  }

  /**
   * Truthful live check: returns true ONLY when:
   * - tickCounter > 0
   * - all required sequencer streams for BTC/USDT and ETH/USDT are SYNCED and fresh
   * - lastLiveIngestTsMs is within maxFeedAgeMs
   */
  isCollectorLive(nowMs: number = Date.now()): boolean {
    if (this.tickCounter <= 0 || !this.lastLiveIngestTsMs) {
      return false;
    }
    if (nowMs - this.lastLiveIngestTsMs > 5000) {
      return false;
    }
    const states = this.sequencer.getAllStates();
    if (states.length === 0) {
      return false;
    }
    return states.every((s) => s.status === 'SYNCED' && nowMs - s.lastReceivedTs <= 5000);
  }

  async ingestOrderbook(
    book: NormalizedOrderbook,
    nowTs: number = book.receivedTs
  ): Promise<{
    streamState: ReturnType<OrderbookSequencer['ingest']>;
    snapshots: Record<PaperStrategyId, PaperStrategySnapshot>;
  }> {
    await this.ensureRestored();
    this.tickCounter += 1;
    this.lastLiveIngestTsMs = nowTs;
    if (!this.runStartedAtMs) {
      this.runStartedAtMs = nowTs;
      await this.state.storage.put('run_started_at_ms', this.runStartedAtMs);
    }

    const streamState = this.sequencer.ingest(book, nowTs);
    const replayObjectKey = `r2://apex-os-paper/live/tick-${this.tickCounter}-${book.exchange}-${book.pair.replace('/', '')}.json`;

    for (const engine of this.strategies.values()) {
      const prevClosedCount = engine.getClosedCycles().length;
      const prevClosedKeys = new Set(engine.getClosedCycles().map((c) => c.idempotencyKey));
      const decision = engine.evaluatePair(
        this.sequencer,
        book.pair,
        this.tickCounter,
        nowTs,
        replayObjectKey
      );
      const currentClosed = engine.getClosedCycles();
      if (currentClosed.length > prevClosedCount) {
        for (const c of currentClosed) {
          if (!prevClosedKeys.has(c.idempotencyKey)) {
            await this.journal.recordClosedCycle(c, this.env?.DB, this.env?.STORAGE);
            if (this.env?.STORAGE) {
              await this.journal.archiveReplayData(
                `${c.replayObjectKey}.raw.json`,
                {
                  cycle: c,
                  triggerBook: book,
                  decision,
                  sequencerStates: this.sequencer.getAllStates(),
                },
                this.env.STORAGE
              );
            }
          }
        }
      }
      await this.journal.saveStrategySnapshot(engine.getSnapshot(), this.env?.DB);
      await this.state.storage.put(
        `strategy_state_${engine.strategyId}`,
        engine.serializeState()
      );
    }

    await this.state.storage.put('last_tick_counter', this.tickCounter);
    await this.state.storage.put('last_live_ingest_ts_ms', this.lastLiveIngestTsMs);
    await this.state.storage.put('paper_closed_cycles', this.journal.getClosedCycles());

    if (this.env?.DB) {
      await this.syncRunsInD1(nowTs);
    }

    return {
      streamState,
      snapshots: this.getStrategySnapshots(),
    };
  }

  async resyncStream(
    book: NormalizedOrderbook,
    nowTs: number = book.receivedTs
  ): Promise<ReturnType<OrderbookSequencer['resyncSnapshot']>> {
    await this.ensureRestored();
    this.lastLiveIngestTsMs = nowTs;
    await this.state.storage.put('last_live_ingest_ts_ms', this.lastLiveIngestTsMs);
    return this.sequencer.resyncSnapshot(book, nowTs);
  }

  getStrategySnapshots(): Record<PaperStrategyId, PaperStrategySnapshot> {
    return {
      'spot-2exch': this.strategies.get('spot-2exch')!.getSnapshot(),
      'spot-perp': this.strategies.get('spot-perp')!.getSnapshot(),
    };
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname.endsWith('/start-collector')) {
      const status = await this.startLiveCollector();
      return Response.json({
        executionMode: 'PAPER',
        ...status,
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/stop-collector')) {
      await this.stopLiveCollector();
      return Response.json({
        executionMode: 'PAPER',
        stopped: true,
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/ingest')) {
      const payload = (await request.json()) as {
        book: NormalizedOrderbook;
        nowTs?: number;
      };
      const result = await this.ingestOrderbook(payload.book, payload.nowTs);
      return Response.json({
        executionMode: 'PAPER',
        ...result,
      });
    }

    if (request.method === 'POST' && url.pathname.endsWith('/resync')) {
      const payload = (await request.json()) as {
        book: NormalizedOrderbook;
        nowTs?: number;
      };
      const streamState = await this.resyncStream(payload.book, payload.nowTs);
      return Response.json({
        executionMode: 'PAPER',
        streamState,
      });
    }

    if (request.method === 'GET' && url.pathname.endsWith('/replay-verify')) {
      const ticks = buildCanonical50TickSequence();
      const verification = PaperReplayEngine.verifyDeterminism(ticks, this.modelVersion);
      return Response.json({
        executionMode: 'PAPER',
        modelVersion: this.modelVersion,
        ...verification,
      });
    }

    // Default GET /status
    await this.ensureRestored();
    const now = Date.now();
    const isLive = this.isCollectorLive(now);
    const snapshots = this.getStrategySnapshots();
    return Response.json({
      executionMode: 'PAPER',
      isLive,
      dataSource: isLive ? 'LIVE_DURABLE_OBJECT_STREAM' : 'DURABLE_OBJECT_IDLE_OR_STALE',
      modelVersion: this.modelVersion,
      configHash: this.configHash,
      tickCounter: this.tickCounter,
      runStartedAtMs: this.runStartedAtMs,
      lastLiveIngestTsMs: this.lastLiveIngestTsMs,
      pairs: PAIRS,
      sequencerStates: this.sequencer.getAllStates(),
      collectorStreams: this.collector ? this.collector.getStreamStatuses() : [],
      strategies: snapshots,
      closedCycles: this.journal.getClosedCycles(),
    });
  }
}
