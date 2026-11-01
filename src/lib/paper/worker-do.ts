/**
 * src/lib/paper/worker-do.ts
 *
 * Cloudflare Durable Object implementation for the Greenfield Paper Trading Engine.
 * Coordinates LiveMarketCollector (WebSocket + REST snapshot resync), OrderbookSequencer,
 * two independent 10,000 USDT Strategy Engines ('spot-2exch' and 'spot-perp'),
 * and the Immutable PaperJournal (with D1 outbox, runs tracking, and R2 raw replay archive).
 */

import type { D1Database } from '../db';
import { buildCanonical50TickSequence } from './fixtures';
import { PaperJournal, type R2BucketLike } from './journal';
import { LiveMarketCollector, type CollectorConfig } from './live-collector';
import { OrderbookSequencer, REQUIRED_PAPER_STREAMS } from './orderbook-sequencer';
import { PaperReplayEngine } from './replay';
import {
  PaperStrategyEngine,
  PAPER_CANONICAL_CONFIG,
  PAPER_FROZEN_CONFIG_HASH,
  PAPER_MODEL_VERSION,
} from './strategy-engine';
import type {
  FundingDispositionResult,
  NormalizedOrderbook,
  PaperClosedCycle,
  PaperPair,
  PaperSerializedStrategyState,
  PaperStrategyId,
  PaperStrategySnapshot,
} from './types';

export interface DurableObjectStorageLike {
  get<T = unknown>(key: string): Promise<T | undefined>;
  put<T = unknown>(key: string, value: T): Promise<void>;
  delete?(key: string): Promise<boolean | void>;
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

export { PAPER_MODEL_VERSION, PAPER_FROZEN_CONFIG_HASH };

interface StrategyWindowBaseline {
  baselineClosedCyclesCount: number;
  baselineRealizedNetPnlUsdt: number;
  baselineEquityUsdt: number;
  windowPeakEquityUsdt: number;
  windowMaxDrawdownPct: number;
  baselineTimestampMs: number;
  baselinePositionsSnapshot?: Array<{
    cycleId: string;
    pair: PaperPair;
    entryTs: number;
    baselineUnrealizedPnlUsdt: number;
  }>;
}

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
  private continuousCoverageMs = 0;
  private lastCoverageCheckTsMs: number | null = null;
  private lastLiveConfirmedTsMs: number | null = null;
  private gapStartedAtMs: number | null = null;
  private collectorDesiredRunning = false;
  private ingestQueue: Promise<unknown> = Promise.resolve();
  private readonly sessionTicks: Array<{
    tickIndex: number;
    nowTs: number;
    book: NormalizedOrderbook;
  }> = [];
  private readonly activeCycleTicks: Map<
    string,
    Array<{ tickIndex: number; nowTs: number; book: NormalizedOrderbook }>
  > = new Map();
  private readonly activeCycleInitialBooks: Map<
    string,
    {
      legA: NormalizedOrderbook;
      legB: NormalizedOrderbook;
      allStreams?: NormalizedOrderbook[];
    }
  > = new Map();
  private readonly activeCycleInitialStates: Map<
    string,
    ReturnType<PaperStrategyEngine['serializeState']>
  > = new Map();
  private readonly windowBaselines: Map<PaperStrategyId, StrategyWindowBaseline> = new Map();
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
          initialCapitalUsdt: PAPER_CANONICAL_CONFIG.initialCapitalUsdt,
          maxCycleNotionalUsdt: PAPER_CANONICAL_CONFIG.maxCycleNotionalUsdt,
          maxOpenCycles: PAPER_CANONICAL_CONFIG.maxOpenCycles,
          singleLegTakerFeeRate: PAPER_CANONICAL_CONFIG.singleLegTakerFeeRate,
          minEntryNetSpreadBps: PAPER_CANONICAL_CONFIG.minEntryNetSpreadBps,
          exitConvergenceSpreadBps: PAPER_CANONICAL_CONFIG.exitConvergenceSpreadBps,
          maxDrawdownLimitPct: PAPER_CANONICAL_CONFIG.maxDrawdownLimitPct,
        })
      );
      this.windowBaselines.set(sid, {
        baselineClosedCyclesCount: 0,
        baselineRealizedNetPnlUsdt: 0,
        baselineEquityUsdt: PAPER_CANONICAL_CONFIG.initialCapitalUsdt,
        windowPeakEquityUsdt: PAPER_CANONICAL_CONFIG.initialCapitalUsdt,
        windowMaxDrawdownPct: 0,
        baselineTimestampMs: 0,
      });
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
    const storedCoverage = await this.state.storage.get<number>('continuous_coverage_ms');
    if (storedCoverage !== undefined) {
      this.continuousCoverageMs = storedCoverage;
    }
    const storedLastCoverageCheck = await this.state.storage.get<number>('last_coverage_check_ts_ms');
    if (storedLastCoverageCheck !== undefined) {
      this.lastCoverageCheckTsMs = storedLastCoverageCheck;
    }
    const storedLastLiveConfirmed = await this.state.storage.get<number>('last_live_confirmed_ts_ms');
    if (storedLastLiveConfirmed !== undefined) {
      this.lastLiveConfirmedTsMs = storedLastLiveConfirmed;
    }
    const storedGapStarted = await this.state.storage.get<number>('gap_started_at_ms');
    if (storedGapStarted !== undefined) {
      this.gapStartedAtMs = storedGapStarted;
    }
    const storedDesiredRunning = await this.state.storage.get<boolean>('collector_desired_running');
    if (storedDesiredRunning !== undefined) {
      this.collectorDesiredRunning = storedDesiredRunning;
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

      const storedBaseline = await this.state.storage.get<StrategyWindowBaseline>(
        `window_baseline_${sid}`
      );
      if (storedBaseline) {
        this.windowBaselines.set(sid, storedBaseline);
      }
    }

    const storedSequencerState = await this.state.storage.get<
      ReturnType<OrderbookSequencer['serializeState']>
    >('sequencer_state');
    if (storedSequencerState) {
      this.sequencer.restoreState(storedSequencerState);
    }

    const storedActiveTicks = await this.state.storage.get<
      Record<string, Array<{ tickIndex: number; nowTs: number; book: NormalizedOrderbook }>>
    >('active_cycle_ticks_ledger');
    if (storedActiveTicks) {
      for (const [cycleId, ticks] of Object.entries(storedActiveTicks)) {
        this.activeCycleTicks.set(cycleId, ticks);
      }
    }

    const storedInitialBooks = await this.state.storage.get<
      Record<string, { legA: NormalizedOrderbook; legB: NormalizedOrderbook }>
    >('active_cycle_initial_books_ledger');
    if (storedInitialBooks) {
      for (const [cycleId, books] of Object.entries(storedInitialBooks)) {
        this.activeCycleInitialBooks.set(cycleId, books);
      }
    }

    const storedInitialStates = await this.state.storage.get<
      Record<string, ReturnType<PaperStrategyEngine['serializeState']>>
    >('active_cycle_initial_states_ledger');
    if (storedInitialStates) {
      for (const [cycleId, st] of Object.entries(storedInitialStates)) {
        this.activeCycleInitialStates.set(cycleId, st);
      }
    }

    this.initialized = true;

    // V3: If collector was desired running before restart and is not currently present,
    // automatically recreate and start it.
    if (this.collectorDesiredRunning && !this.collector) {
      void this.startLiveCollector();
    }
  }

  /**
   * Queue async tasks to run strictly sequentially, preserving chronological
   * order across all book ingestions and resyncs.
   */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.ingestQueue.then(task, task);
    this.ingestQueue = next.then(
      () => undefined,
      () => undefined
    );
    return next;
  }

  /**
   * Initialize and start LiveMarketCollector (WebSocket streams + periodic alarm heartbeat).
   */
  async startLiveCollector(options?: CollectorConfig): Promise<{
    started: boolean;
    streamStatuses: ReturnType<LiveMarketCollector['getStreamStatuses']>;
  }> {
    await this.ensureRestored();

    this.collectorDesiredRunning = true;
    await this.state.storage.put('collector_desired_running', true);

    if (!this.runStartedAtMs) {
      this.runStartedAtMs = Date.now();
      await this.state.storage.put('run_started_at_ms', this.runStartedAtMs);
    }

    if (!this.collector) {
      this.collector = new LiveMarketCollector({
        ...options,
        pairs: PAIRS,
        onDisconnect: (exchange, pair, marketType, reason) => {
          this.sequencer.markDisconnected(exchange, pair, marketType, reason);
          // Invalidate continuous coverage when a stream drops
          this.updateCoverage(Date.now(), false);
        },
        onBook: (book: NormalizedOrderbook) => {
          void this.enqueue(async () => {
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
          });
        },
      });
    }

    // Bootstrap fresh L2 REST snapshots and subscribe WebSocket streams
    await this.collector.startWebSocketStreams();

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
    this.collectorDesiredRunning = false;
    await this.state.storage.put('collector_desired_running', false);
    if (this.collector) {
      this.collector.close();
      this.collector = null;
    }
  }

  /**
   * Cloudflare Durable Object alarm handler:
   * - Restores collector if collectorDesiredRunning === true
   * - Verifies collector stream health and triggers snapshot resync if stale
   * - Reconciles D1/R2 outbox
   * - Updates paper_trading_runs heartbeat and coverage
   * - Schedules next alarm if collector is desired running or present
   */
  async alarm(): Promise<void> {
    await this.ensureRestored();
    const now = Date.now();

    // Recreate collector if desired running but missing
    if (this.collectorDesiredRunning && !this.collector) {
      try {
        await this.startLiveCollector();
      } catch (err) {
        console.error('[PaperTradingDO] Alarm failed to restore collector:', err);
      }
    }

    if (this.collector) {
      if (!this.collector.isHealthy(10000)) {
        await this.collector.bootstrapSnapshots();
      }
    }

    const isLive = this.isCollectorLive(now);
    await this.updateCoverage(now, isLive);

    if (this.env?.DB) {
      await this.journal.reconcileOutbox(this.env.DB, this.env.STORAGE);
      await this.syncRunsInD1(now);
    }

    // Reschedule next alarm if collector is active or desired running
    if ((this.collector || this.collectorDesiredRunning) && this.state.storage.setAlarm) {
      await this.state.storage.setAlarm(Date.now() + 15000);
    }
  }

  /**
   * Track continuous verified market coverage.
   * If a feed gap occurs (not live for > 15s) that cannot be continuously recovered,
   * reset the 30-day window per the user's explicit rule: never pause and accumulate
   * across unrecoverable gaps; restart the window.
   *
   * Fixes Finding C1:
   * - Repro 1: Feed goes false for 60s while checked every 1s -> must track gapStartedAtMs
   *   and reset window once gap exceeds 15s, NOT keep window alive because each step is small.
   * - Repro 2: Feed reconnects true after 31 days with no intermediate checks -> must NOT
   *   credit the 31-day unverified gap to continuous coverage. Only steps <= 15s since
   *   last live confirmation are credited. Any step > 15s resets continuousCoverageMs.
   */
  private async updateCoverage(nowMs: number, isLive: boolean): Promise<void> {
    this.lastCoverageCheckTsMs = nowMs;
    await this.state.storage.put('last_coverage_check_ts_ms', nowMs);

    if (isLive) {
      if (this.gapStartedAtMs !== null && nowMs - this.gapStartedAtMs > 15000) {
        // Feed recovered, but the gap exceeded 15s: unrecoverable gap, reset window
        await this.resetContinuousWindow(nowMs);
        this.lastLiveConfirmedTsMs = nowMs;
        this.gapStartedAtMs = null;
        await this.state.storage.put('last_live_confirmed_ts_ms', nowMs);
        if (this.state.storage.delete) {
          await this.state.storage.delete('gap_started_at_ms');
        }
        return;
      }

      if (this.lastLiveConfirmedTsMs !== null) {
        const step = Math.max(0, nowMs - this.lastLiveConfirmedTsMs);
        if (step > 15000) {
          // Unmonitored gap occurred between live checks (> 15s): reset window
          await this.resetContinuousWindow(nowMs);
          this.lastLiveConfirmedTsMs = nowMs;
          this.gapStartedAtMs = null;
          await this.state.storage.put('last_live_confirmed_ts_ms', nowMs);
          if (this.state.storage.delete) {
            await this.state.storage.delete('gap_started_at_ms');
          }
          return;
        }

        // Proven continuous live step <= 15s
        this.continuousCoverageMs += step;
        await this.state.storage.put('continuous_coverage_ms', this.continuousCoverageMs);
      }

      this.lastLiveConfirmedTsMs = nowMs;
      this.gapStartedAtMs = null;
      await this.state.storage.put('last_live_confirmed_ts_ms', nowMs);
      if (this.state.storage.delete) {
        await this.state.storage.delete('gap_started_at_ms');
      }
    } else {
      // Feed is non-live
      if (this.gapStartedAtMs === null) {
        this.gapStartedAtMs = this.lastLiveConfirmedTsMs ?? nowMs;
        await this.state.storage.put('gap_started_at_ms', this.gapStartedAtMs);
      }
      const outageDuration = Math.max(0, nowMs - this.gapStartedAtMs);
      if (outageDuration > 15000) {
        // Continuous feed loss > 15s: reset continuous window immediately
        await this.resetContinuousWindow(nowMs);
        this.lastLiveConfirmedTsMs = null;
        if (this.state.storage.delete) {
          await this.state.storage.delete('last_live_confirmed_ts_ms');
        }
      }
    }
  }

  private windowEstablished = false;

  private async resetContinuousWindow(nowMs: number): Promise<void> {
    this.continuousCoverageMs = 0;
    await this.state.storage.put('continuous_coverage_ms', 0);

    // Reset window baselines for all strategies to snapshot current state
    for (const sid of STRATEGY_IDS) {
      const engine = this.strategies.get(sid)!;
      // N1: Mark all currently open positions as carry-over and record their pre-reset unrealized mark
      engine.markOpenCyclesAsCarryOver(this.sequencer, nowMs);

      const snap = engine.getSnapshot();
      const openCycles = engine.getOpenCycles();
      const baselinePositionsSnapshot = openCycles.map((c) => ({
        cycleId: c.cycleId,
        pair: c.pair,
        entryTs: c.entryTs,
        baselineUnrealizedPnlUsdt: c.baselineUnrealizedPnlUsdt ?? 0,
      }));

      const baseline: StrategyWindowBaseline = {
        baselineClosedCyclesCount: snap.closedCyclesCount,
        baselineRealizedNetPnlUsdt: snap.realizedNetPnlUsdt,
        baselineEquityUsdt: snap.equityUsdt,
        windowPeakEquityUsdt: snap.equityUsdt,
        windowMaxDrawdownPct: 0,
        baselineTimestampMs: nowMs,
        baselinePositionsSnapshot,
      };
      this.windowBaselines.set(sid, baseline);
      await this.state.storage.put(`window_baseline_${sid}`, baseline);
      await this.state.storage.put(
        `strategy_state_${engine.strategyId}`,
        engine.serializeState()
      );

      if (this.env?.DB) {
        await this.journal.deactivatePriorRuns(
          sid,
          `run_${sid}_${nowMs}`,
          this.env.DB
        );
      }
    }
  }

  private async syncRunsInD1(nowMs: number): Promise<void> {
    if (!this.env?.DB || !this.runStartedAtMs) return;

    const isTrulyLive = this.isCollectorLive(nowMs);
    const verifiedDays = isTrulyLive
      ? Number((this.continuousCoverageMs / (24 * 3600 * 1000)).toFixed(6))
      : 0;

    for (const sid of STRATEGY_IDS) {
      const engine = this.strategies.get(sid)!;
      const snap = engine.getSnapshot();
      const baseline = this.windowBaselines.get(sid) ?? {
        baselineClosedCyclesCount: 0,
        baselineRealizedNetPnlUsdt: 0,
        baselineEquityUsdt: PAPER_CANONICAL_CONFIG.initialCapitalUsdt,
        windowPeakEquityUsdt: snap.equityUsdt,
        windowMaxDrawdownPct: 0,
        baselineTimestampMs: 0,
      };

      // N1: Window P&L is derived from NAV delta from baseline and cycle attributable P&L.
      // Carry-over cycles are strictly excluded from qualifying windowClosedCycles count (only new cycles opened in this window count).
      const allClosed = engine.getClosedCycles();
      const newCyclesInWindow = allClosed.filter(
        (c) => c.entryTs >= baseline.baselineTimestampMs && !c.isCarryOver
      );
      const windowClosedCycles = newCyclesInWindow.length;

      // Calculate total attributable window net P&L:
      // Current equity minus baseline equity (adjusting for capital baseline).
      const windowNavPnl = Number((snap.equityUsdt - baseline.baselineEquityUsdt).toFixed(4));
      // Sum of attributable net P&L of cycles closed within this window
      const closedCyclesInWindow = allClosed.filter((c) => c.exitTs >= baseline.baselineTimestampMs);
      const windowAttributablePnl = Number(
        closedCyclesInWindow
          .reduce((sum, c) => sum + (c.windowAttributableNetPnlUsdt ?? (c.netPnlUsdt - (c.isCarryOver ? (c.netPnlUsdt) : 0))), 0)
          .toFixed(4)
      );

      // Use NAV delta from baseline as the primary window P&L, reflecting post-baseline changes only
      const windowRealizedNetPnl = windowNavPnl;

      // Track window peak equity and drawdown within the continuous window
      if (snap.equityUsdt > baseline.windowPeakEquityUsdt) {
        baseline.windowPeakEquityUsdt = snap.equityUsdt;
      }
      const windowDrawdown =
        baseline.windowPeakEquityUsdt > 0
          ? Number(
              (
                ((baseline.windowPeakEquityUsdt - snap.equityUsdt) /
                  baseline.windowPeakEquityUsdt) *
                100
              ).toFixed(4)
            )
          : 0;
      if (windowDrawdown > baseline.windowMaxDrawdownPct) {
        baseline.windowMaxDrawdownPct = windowDrawdown;
      }
      await this.state.storage.put(`window_baseline_${sid}`, baseline);

      const verdict: 'GO' | 'NO_GO' =
        verifiedDays >= 30 &&
        windowClosedCycles >= 100 &&
        windowRealizedNetPnl > 0 &&
        baseline.windowMaxDrawdownPct <= 2.0 &&
        !snap.haltedByDrawdown
          ? 'GO'
          : 'NO_GO';

      const runId = `run_${sid}_${this.runStartedAtMs}`;
      await this.journal.deactivatePriorRuns(sid, runId, this.env.DB);
      await this.journal.syncPaperRun(
        runId,
        sid,
        this.modelVersion,
        this.configHash,
        this.env.DB,
        {
          verifiedRealMarketDays: verifiedDays,
          closedCyclesCount: windowClosedCycles,
          realizedNetPnlUsdt: windowRealizedNetPnl,
          maxDrawdownPct: baseline.windowMaxDrawdownPct,
          verdict,
          isActive: true,
        }
      );
    }
  }

  /**
   * Truthful live check: returns true ONLY when:
   * - collector is present and healthy
   * - tickCounter > 0
   * - all 8 required streams are present, SYNCED, and within 1000ms maxFeedAge
   * - lastLiveIngestTsMs is within 1000ms maxFeedAge
   */
  isCollectorLive(nowMs: number = Date.now()): boolean {
    if (this.tickCounter <= 0 || !this.lastLiveIngestTsMs) {
      return false;
    }
    if (nowMs - this.lastLiveIngestTsMs > 1000) {
      return false;
    }
    return this.sequencer.areAllRequiredStreamsSynced(nowMs).ok;
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
    await this.state.storage.put('sequencer_state', this.sequencer.serializeState());
    const tickEntry = {
      tickIndex: this.tickCounter,
      nowTs,
      book,
    };
    this.sessionTicks.push(tickEntry);
    if (this.sessionTicks.length > 500) {
      this.sessionTicks.shift();
    }

    // N2: Track tick history for all currently open cycles
    await this.recordTickForOpenCycles(tickEntry);

    const isLive = this.isCollectorLive(nowTs);
    await this.updateCoverage(nowTs, isLive);

    const replayObjectKey = `${book.exchange}/${book.pair}/${nowTs}-${this.tickCounter}`;

    let perpStrategyStatePersistenceFailed = false;
    for (const engine of this.strategies.values()) {
      const prevClosedCount = engine.getClosedCycles().length;
      const prevClosedKeys = new Set(engine.getClosedCycles().map((c) => c.idempotencyKey));
      const prevOpenKeys = new Set(engine.getOpenCycles().map((c) => c.cycleId));
      const preEvaluateState = engine.serializeState();

      const decision = engine.evaluatePair(
        this.sequencer,
        book.pair,
        this.tickCounter,
        nowTs,
        replayObjectKey
      );

      // N2: Detect newly opened cycles and persist their initial opening orderbooks, pre-open state, and opening tick
      for (const open of engine.getOpenCycles()) {
        if (!prevOpenKeys.has(open.cycleId)) {
          const legABook = this.sequencer.getBook(open.legAExchange, open.pair, open.legAMarket);
          const legBBook = this.sequencer.getBook(open.legBExchange, open.pair, open.legBMarket);
          if (legABook && legBBook) {
            this.activeCycleInitialBooks.set(open.cycleId, {
              legA: { ...legABook },
              legB: { ...legBBook },
              allStreams: this.sequencer.getAllBooks().map((b) => ({ ...b })),
            });
            await this.persistActiveCycleInitialBooks();
          }
          this.activeCycleInitialStates.set(open.cycleId, preEvaluateState);
          await this.persistActiveCycleInitialStates();

          const existingTicks = this.activeCycleTicks.get(open.cycleId) ?? [];
          if (!existingTicks.some((t) => t.tickIndex === tickEntry.tickIndex)) {
            existingTicks.push(tickEntry);
            this.activeCycleTicks.set(open.cycleId, existingTicks);
            await this.persistActiveCycleTicks();
          }
        }
      }

      const currentClosed = engine.getClosedCycles();
      if (currentClosed.length > prevClosedCount) {
        for (const c of currentClosed) {
          if (!prevClosedKeys.has(c.idempotencyKey)) {
            await this.journal.recordClosedCycle(c, this.env?.DB, this.env?.STORAGE);
            if (this.env?.STORAGE) {
              const cycleTicks =
                this.activeCycleTicks.get(c.cycleId) ??
                this.sessionTicks.filter(
                  (t) => t.nowTs >= c.entryTs && t.nowTs <= c.exitTs
                );
              const initialBooks = this.activeCycleInitialBooks.get(c.cycleId) ?? {
                legA: book,
                legB: book,
              };
              const initialStrategyState = this.activeCycleInitialStates.get(c.cycleId);
              const cycleTickSet = new Set(cycleTicks.map((t) => t.tickIndex));
              const cycleDecisions = engine
                .getDecisions()
                .filter(
                  (d) =>
                    d.pair === c.pair &&
                    (cycleTickSet.size > 0
                      ? cycleTickSet.has(d.tickIndex)
                      : d.timestamp >= c.entryTs && d.timestamp <= c.exitTs)
                );
              await this.journal.archiveReplayData(
                `${c.replayObjectKey}.raw.json`,
                {
                  cycle: c,
                  modelVersion: this.modelVersion,
                  engineConfig: {
                    initialCapitalUsdt: engine.initialCapitalUsdt,
                    maxCycleNotionalUsdt: engine.maxCycleNotionalUsdt,
                    maxOpenCycles: engine.maxOpenCycles,
                    singleLegTakerFeeRate: engine.singleLegTakerFeeRate,
                    minEntryNetSpreadBps: engine.minEntryNetSpreadBps,
                    exitConvergenceSpreadBps: engine.exitConvergenceSpreadBps,
                    maxDrawdownLimitPct: engine.maxDrawdownLimitPct,
                  },
                  initialStrategyState,
                  finalSnapshot: engine.getSnapshot(),
                  initialBooks,
                  triggerBook: book,
                  decision,
                  cycleTicks,
                  decisions: cycleDecisions,
                  fundingLedger: engine.getSnapshot().fundingLedger ?? [],
                  sequencerStates: this.sequencer.getAllStates(),
                },
                this.env.STORAGE
              );
            }
            // Clean up durable ticks, initial books, and initial states for this closed cycle
            this.activeCycleTicks.delete(c.cycleId);
            this.activeCycleInitialBooks.delete(c.cycleId);
            this.activeCycleInitialStates.delete(c.cycleId);
            await this.persistActiveCycleTicks();
            await this.persistActiveCycleInitialBooks();
            await this.persistActiveCycleInitialStates();
          }
        }
      }
      try {
        await this.journal.saveStrategySnapshot(engine.getSnapshot(), this.env?.DB);
        await this.state.storage.put(
          `strategy_state_${engine.strategyId}`,
          engine.serializeState()
        );
      } catch (err) {
        if (engine.strategyId === 'spot-perp' && book.fundingEventId) {
          perpStrategyStatePersistenceFailed = true;
        } else {
          throw err;
        }
      }
    }

    // N3: Multi-tier persisted funding disposition handling:
    // If incoming book contains a funding event, resolve its disposition via perp engine:
    // 1. 'applied': Funding calculated and recorded into position and funding ledger.
    // 2. 'not-applicable': No open position, entered after settlement, 0 bps, or already applied.
    // 3. 'retry': Open position exists but pair sync failed (e.g. HALTED_DESYNC or missing counterpart)
    //    or stream is desynced, or persistence failed. Suppress ACK so collector/broker can replay.
    if (book.fundingEventId) {
      const perpEngine = this.strategies.get('spot-perp');
      const streamKey = OrderbookSequencer.makeStreamKey(
        book.exchange,
        book.pair,
        book.marketType
      );

      let dispositionResult: FundingDispositionResult = {
        disposition: 'not-applicable',
        reason: 'No perpetual strategy active',
        eventId: book.fundingEventId,
      };

      if (streamState.status !== 'SYNCED') {
        dispositionResult = {
          disposition: 'retry',
          reason: `Stream ${streamKey} status is ${streamState.status}, not SYNCED`,
          eventId: book.fundingEventId,
          settlementTs: book.fundingSettlementTs ?? nowTs,
        };
      } else if (perpEngine) {
        dispositionResult = perpEngine.processFundingSettlementEvent(
          this.sequencer,
          book,
          nowTs
        );
      }

      // Persist both perp strategy state and funding disposition in DO state BEFORE collector ACK
      let persistenceOk = !perpStrategyStatePersistenceFailed;
      if (persistenceOk) {
        try {
          if (perpEngine && dispositionResult.disposition === 'applied') {
            await this.journal.saveStrategySnapshot(perpEngine.getSnapshot(), this.env?.DB);
            await this.state.storage.put(
              'strategy_state_spot-perp',
              perpEngine.serializeState()
            );
          }
          await this.state.storage.put(
            `funding_disp_${book.fundingEventId}`,
            dispositionResult
          );
        } catch (err) {
          persistenceOk = false;
        }
      }

      // ACK collector strictly when disposition is 'applied' or 'not-applicable' AND persistence succeeded.
      // If disposition is 'retry' (e.g. HALTED_DESYNC, missing spot counterpart, stream desync) or persistence failed: DO NOT ACK!
      if (
        this.collector &&
        persistenceOk &&
        (dispositionResult.disposition === 'applied' ||
          dispositionResult.disposition === 'not-applicable')
      ) {
        this.collector.ackFundingSettlement(streamKey, book.fundingEventId);
      }
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
    const result = this.sequencer.resyncSnapshot(book, nowTs);
    await this.state.storage.put('sequencer_state', this.sequencer.serializeState());

    const tickEntry = {
      tickIndex: this.tickCounter,
      nowTs,
      book,
    };
    this.sessionTicks.push(tickEntry);
    if (this.sessionTicks.length > 500) {
      this.sessionTicks.shift();
    }
    // N2: Track resync snapshot tick in active cycles as well
    await this.recordTickForOpenCycles(tickEntry);

    const isLive = this.isCollectorLive(nowTs);
    await this.updateCoverage(nowTs, isLive);

    // Evaluate strategy state after resync through the unified persistence pipeline
    const replayObjectKey = `${book.exchange}/${book.pair}/${nowTs}-${this.tickCounter}`;
    let perpStrategyStatePersistenceFailed = false;
    for (const engine of this.strategies.values()) {
      const prevClosedCount = engine.getClosedCycles().length;
      const prevClosedKeys = new Set(engine.getClosedCycles().map((c) => c.idempotencyKey));
      const prevOpenKeys = new Set(engine.getOpenCycles().map((c) => c.cycleId));
      const preEvaluateState = engine.serializeState();

      const decision = engine.evaluatePair(
        this.sequencer,
        book.pair,
        this.tickCounter,
        nowTs,
        replayObjectKey
      );

      // N2: Detect newly opened cycles and persist their initial opening orderbooks + pre-open state + opening tick
      for (const open of engine.getOpenCycles()) {
        if (!prevOpenKeys.has(open.cycleId)) {
          const legABook = this.sequencer.getBook(open.legAExchange, open.pair, open.legAMarket);
          const legBBook = this.sequencer.getBook(open.legBExchange, open.pair, open.legBMarket);
          if (legABook && legBBook) {
            this.activeCycleInitialBooks.set(open.cycleId, {
              legA: { ...legABook },
              legB: { ...legBBook },
              allStreams: this.sequencer.getAllBooks().map((b) => ({ ...b })),
            });
            await this.persistActiveCycleInitialBooks();
          }
          this.activeCycleInitialStates.set(open.cycleId, preEvaluateState);
          await this.persistActiveCycleInitialStates();

          const existingTicks = this.activeCycleTicks.get(open.cycleId) ?? [];
          if (
            existingTicks.length === 0 ||
            existingTicks[existingTicks.length - 1].tickIndex !== tickEntry.tickIndex
          ) {
            existingTicks.push(tickEntry);
            this.activeCycleTicks.set(open.cycleId, existingTicks);
            await this.persistActiveCycleTicks();
          }
        }
      }

      const currentClosed = engine.getClosedCycles();
      if (currentClosed.length > prevClosedCount) {
        for (const c of currentClosed) {
          if (!prevClosedKeys.has(c.idempotencyKey)) {
            await this.journal.recordClosedCycle(c, this.env?.DB, this.env?.STORAGE);
            if (this.env?.STORAGE) {
              const cycleTicks =
                this.activeCycleTicks.get(c.cycleId) ??
                this.sessionTicks.filter(
                  (t) => t.nowTs >= c.entryTs && t.nowTs <= c.exitTs
                );
              const initialBooks = this.activeCycleInitialBooks.get(c.cycleId) ?? {
                legA: book,
                legB: book,
              };
              const initialStrategyState = this.activeCycleInitialStates.get(c.cycleId);
              const cycleTickIndices = new Set(cycleTicks.map((t) => t.tickIndex));
              const cycleDecisions = engine
                .getDecisions()
                .filter((d) => d.pair === c.pair && cycleTickIndices.has(d.tickIndex));
              await this.journal.archiveReplayData(
                `${c.replayObjectKey}.raw.json`,
                {
                  cycle: c,
                  modelVersion: this.modelVersion,
                  engineConfig: {
                    initialCapitalUsdt: engine.initialCapitalUsdt,
                    maxCycleNotionalUsdt: engine.maxCycleNotionalUsdt,
                    maxOpenCycles: engine.maxOpenCycles,
                    singleLegTakerFeeRate: engine.singleLegTakerFeeRate,
                    minEntryNetSpreadBps: engine.minEntryNetSpreadBps,
                    exitConvergenceSpreadBps: engine.exitConvergenceSpreadBps,
                    maxDrawdownLimitPct: engine.maxDrawdownLimitPct,
                  },
                  initialStrategyState,
                  finalSnapshot: engine.getSnapshot(),
                  initialBooks,
                  triggerBook: book,
                  decision,
                  cycleTicks,
                  decisions: cycleDecisions.length > 0 ? cycleDecisions : engine.getDecisions().slice(-50),
                  fundingLedger: engine.getSnapshot().fundingLedger ?? [],
                  sequencerStates: this.sequencer.getAllStates(),
                },
                this.env.STORAGE
              );
            }
            // Clean up durable ticks, initial books, and initial states for this closed cycle
            this.activeCycleTicks.delete(c.cycleId);
            this.activeCycleInitialBooks.delete(c.cycleId);
            this.activeCycleInitialStates.delete(c.cycleId);
            await this.persistActiveCycleTicks();
            await this.persistActiveCycleInitialBooks();
            await this.persistActiveCycleInitialStates();
          }
        }
      }

      try {
        await this.journal.saveStrategySnapshot(engine.getSnapshot(), this.env?.DB);
        await this.state.storage.put(
          `strategy_state_${engine.strategyId}`,
          engine.serializeState()
        );
      } catch (err) {
        if (engine.strategyId === 'spot-perp' && book.fundingEventId) {
          perpStrategyStatePersistenceFailed = true;
        } else {
          throw err;
        }
      }
    }

    // N3: Multi-tier persisted funding disposition handling on resync path:
    if (book.fundingEventId) {
      const perpEngine = this.strategies.get('spot-perp');
      const streamKey = OrderbookSequencer.makeStreamKey(
        book.exchange,
        book.pair,
        book.marketType
      );

      let dispositionResult: FundingDispositionResult = {
        disposition: 'not-applicable',
        reason: 'No perpetual strategy active',
        eventId: book.fundingEventId,
      };

      if (perpEngine) {
        dispositionResult = perpEngine.processFundingSettlementEvent(
          this.sequencer,
          book,
          nowTs
        );
      }

      let persistenceOk = !perpStrategyStatePersistenceFailed;
      if (persistenceOk) {
        try {
          if (perpEngine && dispositionResult.disposition === 'applied') {
            await this.journal.saveStrategySnapshot(perpEngine.getSnapshot(), this.env?.DB);
            await this.state.storage.put(
              `strategy_state_${perpEngine.strategyId}`,
              perpEngine.serializeState()
            );
          }
          await this.state.storage.put(
            `funding_disp_${book.fundingEventId}`,
            dispositionResult
          );
        } catch (err) {
          persistenceOk = false;
        }
      }

      if (
        this.collector &&
        persistenceOk &&
        (dispositionResult.disposition === 'applied' ||
          dispositionResult.disposition === 'not-applicable')
      ) {
        this.collector.ackFundingSettlement(streamKey, book.fundingEventId);
      }
    }

    await this.state.storage.put('paper_closed_cycles', this.journal.getClosedCycles());

    if (this.env?.DB) {
      await this.syncRunsInD1(nowTs);
    }

    return result;
  }

  private async recordTickForOpenCycles(tickItem: {
    tickIndex: number;
    nowTs: number;
    book: NormalizedOrderbook;
  }): Promise<void> {
    let hasOpen = false;
    for (const engine of this.strategies.values()) {
      const openList = engine.getOpenCycles();
      if (openList.length > 0) {
        hasOpen = true;
        for (const oc of openList) {
          let list = this.activeCycleTicks.get(oc.cycleId);
          if (!list) {
            list = [];
            this.activeCycleTicks.set(oc.cycleId, list);
          }
          list.push(tickItem);
        }
      }
    }
    if (hasOpen) {
      await this.persistActiveCycleTicks();
    }
  }

  private async persistActiveCycleTicks(): Promise<void> {
    const obj: Record<
      string,
      Array<{ tickIndex: number; nowTs: number; book: NormalizedOrderbook }>
    > = {};
    for (const [cid, ticks] of this.activeCycleTicks.entries()) {
      obj[cid] = ticks;
    }
    await this.state.storage.put('active_cycle_ticks_ledger', obj);
  }

  private async persistActiveCycleInitialBooks(): Promise<void> {
    const obj: Record<
      string,
      {
        legA: NormalizedOrderbook;
        legB: NormalizedOrderbook;
        allStreams?: NormalizedOrderbook[];
      }
    > = {};
    for (const [cid, books] of this.activeCycleInitialBooks.entries()) {
      obj[cid] = books;
    }
    await this.state.storage.put('active_cycle_initial_books_ledger', obj);
  }

  private async persistActiveCycleInitialStates(): Promise<void> {
    const obj: Record<string, PaperSerializedStrategyState> = {};
    for (const [cid, state] of this.activeCycleInitialStates.entries()) {
      obj[cid] = state;
    }
    await this.state.storage.put('active_cycle_initial_states_ledger', obj);
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
    const verifiedRealMarketDays = isLive
      ? Number((this.continuousCoverageMs / (24 * 3600 * 1000)).toFixed(6))
      : 0;
    const snapshots = this.getStrategySnapshots();
    const windowMetrics: Record<PaperStrategyId, {
      windowClosedCyclesCount: number;
      windowRealizedNetPnlUsdt: number;
      windowMaxDrawdownPct: number;
    }> = {} as any;
    for (const sid of STRATEGY_IDS) {
      const engine = this.strategies.get(sid)!;
      const snap = snapshots[sid];
      const baseline = this.windowBaselines.get(sid) ?? {
        baselineClosedCyclesCount: 0,
        baselineRealizedNetPnlUsdt: 0,
        baselineEquityUsdt: PAPER_CANONICAL_CONFIG.initialCapitalUsdt,
        windowPeakEquityUsdt: snap.equityUsdt,
        windowMaxDrawdownPct: 0,
        baselineTimestampMs: 0,
      };
      const allClosed = engine.getClosedCycles();
      const newCyclesInWindow = allClosed.filter(
        (c) => c.entryTs >= baseline.baselineTimestampMs && !c.isCarryOver
      );
      const windowNavPnl = Number((snap.equityUsdt - baseline.baselineEquityUsdt).toFixed(4));
      windowMetrics[sid] = {
        windowClosedCyclesCount: newCyclesInWindow.length,
        windowRealizedNetPnlUsdt: windowNavPnl,
        windowMaxDrawdownPct: baseline.windowMaxDrawdownPct,
      };
    }

    return Response.json({
      executionMode: 'PAPER',
      isLive,
      verifiedRealMarketDays,
      continuousCoverageMs: this.continuousCoverageMs,
      collectorDesiredRunning: this.collectorDesiredRunning,
      requiredStreamCount: REQUIRED_PAPER_STREAMS.length,
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
      windowMetrics,
      closedCycles: this.journal.getClosedCycles(),
    });
  }
}
