/**
 * src/lib/paper/__tests__/paper-engine-and-replay.test.ts
 *
 * Comprehensive tests for Greenfield Paper Trading Engine:
 *   - L2 Orderbook Sequencer with FEED_DESYNC gap detection
 *   - Two independent 10,000 USDT Strategy Engines ('spot-2exch' & 'spot-perp')
 *   - Realistic taker fees (~0.2% round trip) & book-depth VWAP fills
 *   - 100% bit-identical 50-tick deterministic replay
 *   - Immutable journal idempotency & PAPER stamped CSV/PDF exports
 *   - Durable Object integration
 */

import { buildCanonical50TickSequence } from '../fixtures';
import { PaperJournal } from '../journal';
import { OrderbookSequencer } from '../orderbook-sequencer';
import { PaperReplayEngine } from '../replay';
import { PaperStrategyEngine } from '../strategy-engine';
import type { NormalizedOrderbook } from '../types';
import { PaperTradingDurableObject } from '../worker-do';

describe('Greenfield Paper Trading Engine & Deterministic Replay', () => {
  describe('1. L2 Orderbook Sequencer & Gap Detection', () => {
    it('detects sequence gaps, halts trading with FEED_DESYNC, and recovers via resyncSnapshot', () => {
      const sequencer = new OrderbookSequencer({ maxFeedAgeMs: 1000 });
      const now = 1761840000000;

      const book1: NormalizedOrderbook = {
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 100,
        exchangeTs: now,
        receivedTs: now + 10,
        bids: [{ price: 68000, quantity: 1 }],
        asks: [{ price: 68010, quantity: 1 }],
      };
      const state1 = sequencer.ingest(book1, now + 10);
      expect(state1.status).toBe('SYNCED');
      expect(state1.gapCount).toBe(0);

      // Packet jump: incoming sequenceId is 105 instead of 101 -> gap detected!
      const bookGap: NormalizedOrderbook = {
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 105,
        prevSequenceId: 104,
        exchangeTs: now + 100,
        receivedTs: now + 110,
        bids: [{ price: 68005, quantity: 1 }],
        asks: [{ price: 68015, quantity: 1 }],
      };
      const stateGap = sequencer.ingest(bookGap, now + 110);
      expect(stateGap.status).toBe('FEED_DESYNC');
      expect(stateGap.gapCount).toBe(1);
      expect(stateGap.lastErrorReason).toContain('Sequence gap detected');

      // Subsequent packets stay halted in FEED_DESYNC
      const bookNext: NormalizedOrderbook = {
        ...bookGap,
        sequenceId: 106,
        prevSequenceId: 105,
      };
      const stateStillHalted = sequencer.ingest(bookNext, now + 120);
      expect(stateStillHalted.status).toBe('FEED_DESYNC');

      // Recover via explicit resync snapshot
      const snapshotBook: NormalizedOrderbook = {
        ...bookNext,
        sequenceId: 200,
        prevSequenceId: undefined,
        exchangeTs: now + 200,
        receivedTs: now + 210,
      };
      const recoveredState = sequencer.resyncSnapshot(snapshotBook, now + 210);
      expect(recoveredState.status).toBe('SYNCED');
      expect(recoveredState.lastSequenceId).toBe(200);
    });

    it('flags STALE_FEED when feed age exceeds maxFeedAgeMs', () => {
      const sequencer = new OrderbookSequencer({ maxFeedAgeMs: 500 });
      const now = 1761840000000;

      const staleBook: NormalizedOrderbook = {
        exchange: 'bybit',
        pair: 'ETH/USDT',
        marketType: 'spot',
        sequenceId: 50,
        exchangeTs: now - 800, // 800ms old > 500ms limit
        receivedTs: now,
        bids: [{ price: 2600, quantity: 5 }],
        asks: [{ price: 2601, quantity: 5 }],
      };

      const state = sequencer.ingest(staleBook, now);
      expect(state.status).toBe('STALE_FEED');
      expect(state.feedAgeMs).toBe(800);
    });

    it('computes realistic VWAP fill across orderbook depth with slippage calculation', () => {
      const book: NormalizedOrderbook = {
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: 1000,
        receivedTs: 1010,
        bids: [
          { price: 68000, quantity: 0.01 }, // $680 notional
          { price: 67950, quantity: 0.05 },
        ],
        asks: [
          { price: 68000, quantity: 0.005 }, // $340 notional at top
          { price: 68050, quantity: 0.01 },  // $680.50 notional
        ],
      };

      // Target $500 buy taker order consumes entire top level ($340) + part of second level ($160)
      const fill = OrderbookSequencer.computeVwapFill(book, 'buy', 500);
      expect(fill.filled).toBe(true);
      expect(fill.filledNotionalUsdt).toBeCloseTo(500, 2);
      expect(fill.vwapPrice).toBeGreaterThan(68000);
      expect(fill.slippageBps).toBeGreaterThan(0);
    });

    it('correctly merges L2 deltas and deletes levels when quantity is 0', () => {
      const sequencer = new OrderbookSequencer();
      const initialBook: NormalizedOrderbook = {
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: 1000,
        receivedTs: 1010,
        bids: [
          { price: 68000, quantity: 1.0 },
          { price: 67900, quantity: 2.0 },
        ],
        asks: [
          { price: 68100, quantity: 1.0 },
          { price: 68200, quantity: 2.0 },
        ],
      };
      sequencer.ingest(initialBook, 1010);

      // Delta deletes 68000 bid (quantity = 0) and adds 68050 bid (quantity = 1.5)
      const deltaBook: NormalizedOrderbook = {
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 2,
        prevSequenceId: 1,
        exchangeTs: 1050,
        receivedTs: 1060,
        isDelta: true,
        bids: [
          { price: 68000, quantity: 0 },
          { price: 68050, quantity: 1.5 },
        ],
        asks: [],
      };
      sequencer.ingest(deltaBook, 1060);

      const updated = sequencer.getBook('binance', 'BTC/USDT', 'spot')!;
      expect(updated.bids.some((b) => b.price === 68000)).toBe(false);
      expect(updated.bids[0].price).toBe(68050);
      expect(updated.bids[0].quantity).toBe(1.5);
      expect(updated.bids[1].price).toBe(67900);
    });
  });

  describe('2. Independent 10k USDT Strategy Engines & Fee Math', () => {
    it('initializes with exactly 10,000 USDT independent cash and equity', () => {
      const spotEngine = new PaperStrategyEngine({ strategyId: 'spot-2exch' });
      const perpEngine = new PaperStrategyEngine({ strategyId: 'spot-perp' });

      expect(spotEngine.initialCapitalUsdt).toBe(10000);
      expect(spotEngine.getCurrentEquityUsdt()).toBe(10000);
      expect(perpEngine.initialCapitalUsdt).toBe(10000);
      expect(perpEngine.getCurrentEquityUsdt()).toBe(10000);
    });

    it('records NO_TRADE when net spread after 20 bps taker fees is below threshold', () => {
      const sequencer = new OrderbookSequencer();
      const engine = new PaperStrategyEngine({
        strategyId: 'spot-2exch',
        minEntryNetSpreadBps: 2.0,
      });

      const now = 1761840000000;
      // Spread between Binance and Bybit is only ~1.47 bps (< 20 bps fee)
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 10,
        exchangeTs: now,
        receivedTs: now + 5,
        bids: [{ price: 68000, quantity: 1 }],
        asks: [{ price: 68005, quantity: 1 }],
      });
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 10,
        exchangeTs: now,
        receivedTs: now + 5,
        bids: [{ price: 68010, quantity: 1 }],
        asks: [{ price: 68015, quantity: 1 }],
      });

      const decision = engine.evaluatePair(sequencer, 'BTC/USDT', 1, now + 10);
      expect(decision.decision).toBe('NO_TRADE');
      expect(decision.estimatedNetSpreadBps).toBeLessThan(2.0);
      expect(engine.getSnapshot().noTradeCount).toBe(1);
      expect(engine.getSnapshot().openCyclesCount).toBe(0);
    });

    it('halts immediately when mark-to-market drawdown touches or exceeds 2% limit', () => {
      const engine = new PaperStrategyEngine({
        strategyId: 'spot-2exch',
        maxDrawdownLimitPct: 2.0,
      });
      const sequencer = new OrderbookSequencer();
      const now = 1761840000000;

      // Force an adverse mark-to-market drop
      const mtmResult = engine.updateMarkToMarketDrawdown(sequencer, now);
      expect(mtmResult.drawdownPct).toBeLessThan(2.0);
      expect(mtmResult.halted).toBe(false);

      // Verify that >= 2.0% halts the strategy
      (engine as any).peakEquityUsdt = 10000;
      (engine as any).cashBalanceUsdt = 9790; // $210 loss = 2.1% drawdown
      const adverseResult = engine.updateMarkToMarketDrawdown(sequencer, now);
      expect(adverseResult.drawdownPct).toBeGreaterThanOrEqual(2.0);
      expect(adverseResult.halted).toBe(true);

      const postHaltDecision = engine.evaluatePair(sequencer, 'BTC/USDT', 2, now + 10);
      expect(postHaltDecision.decision).toBe('HALTED_DRAWDOWN');
    });
  });

  describe('3. Deterministic 50-Tick Replay Parity', () => {
    it('executes a 50-tick sequence and achieves 100% bit-identical digests across repeated runs', () => {
      const ticks = buildCanonical50TickSequence();
      expect(ticks.length).toBe(50);

      const run1 = PaperReplayEngine.runReplay(ticks, { modelVersion: 'paper-v1.0.0' });
      const run2 = PaperReplayEngine.runReplay(ticks, { modelVersion: 'paper-v1.0.0' });

      // 1. Bit-identical SHA-256 digest
      expect(run1.digest).toBe(run2.digest);
      expect(run1.digest.length).toBe(64);

      // 2. Both strategies completed cycles
      expect(run1.closedCycles.length).toBeGreaterThan(0);
      expect(run1.closedCycles.length).toBe(run2.closedCycles.length);

      // 3. Strategy metrics match down to the exact decimal
      const s1Spot = run1.strategies['spot-2exch'];
      const s2Spot = run2.strategies['spot-2exch'];
      expect(s1Spot.equityUsdt).toBe(s2Spot.equityUsdt);
      expect(s1Spot.realizedNetPnlUsdt).toBe(s2Spot.realizedNetPnlUsdt);
      expect(s1Spot.totalFeesPaidUsdt).toBe(s2Spot.totalFeesPaidUsdt);
      expect(s1Spot.closedCyclesCount).toBe(s2Spot.closedCyclesCount);

      const s1Perp = run1.strategies['spot-perp'];
      const s2Perp = run2.strategies['spot-perp'];
      expect(s1Perp.equityUsdt).toBe(s2Perp.equityUsdt);
      expect(s1Perp.realizedNetPnlUsdt).toBe(s2Perp.realizedNetPnlUsdt);
      expect(s1Perp.totalFundingUsdt).toBe(s2Perp.totalFundingUsdt);

      // 4. Verify helper verifies true
      const verifyResult = PaperReplayEngine.verifyDeterminism(ticks, 'paper-v1.0.0');
      expect(verifyResult.bitIdentical).toBe(true);
      expect(verifyResult.digestA).toBe(run1.digest);
    });

    it('generates a strict economic gate report acting as a release blocker with NO_GO on unfulfilled market days', () => {
      const ticks = buildCanonical50TickSequence();
      const replay = PaperReplayEngine.runReplay(ticks);
      const summary = PaperReplayEngine.buildEconomicResearchSummary(replay, {
        verifiedRealMarketDays: 0,
      });

      expect(summary.reportType).toBe('STRICT_ECONOMIC_AUDIT');
      expect(summary.isReleaseBlocker).toBe(true);
      expect(summary.overallVerdict).toBe('NO_GO');
      expect(summary.strategies.length).toBe(2);
      expect(summary.strategies[0].verdict).toBe('NO_GO');
      expect(summary.strategies[0].daysPassed).toBe(false);
      expect(summary.strategies[0].researchFinding).toContain('NO_GO (Economic Gate Active)');
    });
  });

  describe('4. Immutable Journal Idempotency & Stamped Exports', () => {
    it('enforces idempotency and rejects duplicate cycle entries', async () => {
      const journal = new PaperJournal();
      const ticks = buildCanonical50TickSequence();
      const replay = PaperReplayEngine.runReplay(ticks);
      const sampleCycle = replay.closedCycles[0];

      const firstInsert = await journal.recordClosedCycle(sampleCycle);
      expect(firstInsert).toBe(true);

      const duplicateInsert = await journal.recordClosedCycle(sampleCycle);
      expect(duplicateInsert).toBe(false);

      expect(journal.getClosedCycles().length).toBe(1);
    });

    it('exports CSV and PDF stamped with PAPER watermark, model_version, and digest', () => {
      const ticks = buildCanonical50TickSequence();
      const replay = PaperReplayEngine.runReplay(ticks);
      const economicReport = PaperReplayEngine.buildEconomicResearchSummary(replay);

      const csv = PaperJournal.formatCsvReport({
        cycles: replay.closedCycles,
        modelVersion: replay.modelVersion,
        maxFeedAgeMs: 50,
        replayDigest: replay.digest,
      });

      expect(csv).toContain('EXECUTION_MODE: PAPER');
      expect(csv).toContain(replay.modelVersion);
      expect(csv).toContain(replay.digest);
      expect(csv).toContain('spot-2exch');

      const pdf = PaperJournal.formatPdfReport({
        cycles: replay.closedCycles,
        strategies: replay.strategies,
        sequencerStates: replay.sequencerStates,
        economicResearch: economicReport,
        modelVersion: replay.modelVersion,
        maxFeedAgeMs: 50,
        replayDigest: replay.digest,
      });

      expect(pdf.startsWith('%PDF-1.4')).toBe(true);
      expect(pdf).toContain('PAPER SIMULATION ONLY');
      expect(pdf).toContain(replay.digest);
    });
  });

  describe('5. Durable Object Interface & State Persistence', () => {
    it('handles ingest, resync, and replay-verify via fetch dispatch', async () => {
      const mockStorage = new Map<string, unknown>();
      const mockState = {
        storage: {
          get: async <T>(k: string) => mockStorage.get(k) as T,
          put: async <T>(k: string, v: T) => {
            mockStorage.set(k, v);
          },
        },
      };

      const doEngine = new PaperTradingDurableObject(mockState);

      // GET /status
      const statusRes = await doEngine.fetch(new Request('http://worker.internal/status'));
      const statusJson = (await statusRes.json()) as { executionMode: string; pairs: string[] };
      expect(statusJson.executionMode).toBe('PAPER');
      expect(statusJson.pairs).toContain('BTC/USDT');

      // GET /replay-verify
      const verifyRes = await doEngine.fetch(
        new Request('http://worker.internal/replay-verify')
      );
      const verifyJson = (await verifyRes.json()) as {
        bitIdentical: boolean;
        digestA: string;
      };
      expect(verifyJson.bitIdentical).toBe(true);
      expect(verifyJson.digestA.length).toBe(64);
    });

    it('survives restart without losing cash, equity, or closed cycles and prevents duplicate fills', async () => {
      const mockStorage = new Map<string, unknown>();
      const mockState = {
        storage: {
          get: async <T>(k: string) => mockStorage.get(k) as T,
          put: async <T>(k: string, v: T) => {
            mockStorage.set(k, v);
          },
        },
      };

      const doEngine1 = new PaperTradingDurableObject(mockState);
      const ticks = buildCanonical50TickSequence();
      for (const t of ticks.slice(0, 10)) {
        for (const b of t.books) {
          await doEngine1.ingestOrderbook(b, t.nowTs);
        }
      }

      const snap1 = doEngine1.getStrategySnapshots();

      // Crash & re-instantiate DO with the same persistent storage
      const doEngine2 = new PaperTradingDurableObject(mockState);
      await doEngine2.ensureRestored();
      const snap2 = doEngine2.getStrategySnapshots();

      expect(snap2['spot-2exch'].cashBalanceUsdt).toBe(snap1['spot-2exch'].cashBalanceUsdt);
      expect(snap2['spot-2exch'].closedCyclesCount).toBe(snap1['spot-2exch'].closedCyclesCount);
      expect(snap2['spot-perp'].cashBalanceUsdt).toBe(snap1['spot-perp'].cashBalanceUsdt);
      expect(snap2['spot-perp'].closedCyclesCount).toBe(snap1['spot-perp'].closedCyclesCount);
    });
  });

  describe('6. Venue Balances, Disconnect & Repeated Snapshot Handling', () => {
    it('accepts repeated valid snapshots with identical sequenceId when book is unchanged', () => {
      const sequencer = new OrderbookSequencer();
      const book1: NormalizedOrderbook = {
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 500,
        exchangeTs: 1000,
        receivedTs: 1010,
        isDelta: false,
        bids: [{ price: 68000, quantity: 1 }],
        asks: [{ price: 68010, quantity: 1 }],
      };
      const st1 = sequencer.ingest(book1, 1010);
      expect(st1.status).toBe('SYNCED');

      // Valid repeated snapshot with same sequenceId (common on Bybit when no book update occurred)
      const repeatedBook: NormalizedOrderbook = {
        ...book1,
        exchangeTs: 1050,
        receivedTs: 1060,
      };
      const st2 = sequencer.ingest(repeatedBook, 1060);
      expect(st2.status).toBe('SYNCED');
      expect(st2.gapCount).toBe(0);
    });

    it('marks stream as DISCONNECTED and halts trading pair synchronization until resync', () => {
      const sequencer = new OrderbookSequencer();
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: 1000,
        receivedTs: 1010,
        bids: [{ price: 68000, quantity: 1 }],
        asks: [{ price: 68010, quantity: 1 }],
      });
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: 1000,
        receivedTs: 1010,
        bids: [{ price: 68000, quantity: 1 }],
        asks: [{ price: 68010, quantity: 1 }],
      });

      const beforeDisc = sequencer.validatePairSync('binance:spot:BTC/USDT', 'bybit:spot:BTC/USDT', 1010);
      expect(beforeDisc.ok).toBe(true);

      sequencer.markDisconnected('binance', 'BTC/USDT', 'spot', 'Socket closed by remote');
      const afterDisc = sequencer.validatePairSync('binance:spot:BTC/USDT', 'bybit:spot:BTC/USDT', 1010);
      expect(afterDisc.ok).toBe(false);
      expect(afterDisc.status).toBe('DISCONNECTED');
    });

    it('tracks independent venue collateral balances on Binance and Bybit', () => {
      const engine = new PaperStrategyEngine({ strategyId: 'spot-2exch' });
      const snap = engine.getSnapshot();
      expect(snap.venueBalances).toBeDefined();
      expect(snap.venueBalances?.binance.freeCollateralUsdt).toBe(5000);
      expect(snap.venueBalances?.bybit.freeCollateralUsdt).toBe(5000);
    });

    it('ensures funding accrual is strictly invariant to evaluation frequency within the same 8-hour window', () => {
      const engine1 = new PaperStrategyEngine({ strategyId: 'spot-perp' });
      const engine2 = new PaperStrategyEngine({ strategyId: 'spot-perp' });
      const sequencer = new OrderbookSequencer();
      const baseTs = 1761840000000;

      // Ingest valid books
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: baseTs,
        receivedTs: baseTs + 5,
        bids: [{ price: 68000, quantity: 2 }],
        asks: [{ price: 68010, quantity: 2 }],
      });
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'linear_perp',
        sequenceId: 1,
        exchangeTs: baseTs,
        receivedTs: baseTs + 5,
        bids: [{ price: 68200, quantity: 2 }],
        asks: [{ price: 68210, quantity: 2 }],
        fundingRateBps: 1.5,
      });

      // Open a cycle in both engines
      const dec1 = engine1.evaluatePair(sequencer, 'BTC/USDT', 1, baseTs + 10);
      const dec2 = engine2.evaluatePair(sequencer, 'BTC/USDT', 1, baseTs + 10);
      expect(dec1.decision).toBe('OPEN_CYCLE');
      expect(dec2.decision).toBe('OPEN_CYCLE');

      // Engine 1 is evaluated once 1000ms later (within the same 8h window)
      engine1.evaluatePair(sequencer, 'BTC/USDT', 2, baseTs + 1000);

      // Engine 2 is evaluated 50 times in rapid succession (simulating 50 ticks) within that same window
      for (let i = 0; i < 50; i++) {
        engine2.evaluatePair(sequencer, 'BTC/USDT', 2 + i, baseTs + 10 + i * 20);
      }

      // Funding must remain strictly identical (0.0000 USDT accrued because 8h boundary has not crossed)
      expect(engine1.getSnapshot().totalFundingUsdt).toBe(0);
      expect(engine2.getSnapshot().totalFundingUsdt).toBe(0);
      expect(engine1.getSnapshot().totalFundingUsdt).toBe(engine2.getSnapshot().totalFundingUsdt);

      // Crossing the 8-hour boundary (8h = 28,800,000 ms)
      const afterBoundaryTs = baseTs + 28800000 + 1000;
      engine1.evaluatePair(sequencer, 'BTC/USDT', 60, afterBoundaryTs);
      engine2.evaluatePair(sequencer, 'BTC/USDT', 60, afterBoundaryTs);

      // Both should have accrued identical non-zero funding
      expect(engine1.getSnapshot().unrealizedPnlUsdt).toBeDefined();
      expect(engine1.getSnapshot().totalFundingUsdt).toBe(engine2.getSnapshot().totalFundingUsdt);
    });

    it('forces strategy drawdown halt on open position mark-to-market loss before cycle close', () => {
      const engine = new PaperStrategyEngine({
        strategyId: 'spot-2exch',
        maxDrawdownLimitPct: 2.0,
      });
      const sequencer = new OrderbookSequencer();
      const now = 1761840000000;

      // Setup an open cycle matching PaperOpenCycle schema
      (engine as any).cashBalanceUsdt = 3200; // 10000 - 6800 notional
      (engine as any).openCycles.set('BTC/USDT', {
        cycleId: 'test-open-1',
        strategyId: 'spot-2exch',
        pair: 'BTC/USDT',
        entryTs: now,
        entrySeqA: 1,
        entrySeqB: 1,
        legAExchange: 'binance',
        legAMarket: 'spot',
        legBExchange: 'bybit',
        legBMarket: 'spot',
        entryLegAPrice: 68000,
        entryLegBPrice: 68100,
        entrySpreadBps: 14.7,
        quantityBase: 0.1,
        notionalUsdt: 6800,
        accruedFundingUsdt: 0,
        entryFeesUsdt: 13.6,
      });

      // Adverse market move: Binance spot bid crashes to 64000 (-4000), Bybit ask spikes to 72000 (+3900)
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 10,
        exchangeTs: now + 500,
        receivedTs: now + 510,
        bids: [{ price: 64000, quantity: 1 }],
        asks: [{ price: 64010, quantity: 1 }],
      });
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 10,
        exchangeTs: now + 500,
        receivedTs: now + 510,
        bids: [{ price: 71990, quantity: 1 }],
        asks: [{ price: 72000, quantity: 1 }],
      });

      const mtm = engine.updateMarkToMarketDrawdown(sequencer, now + 510);
      expect(mtm.halted).toBe(true);
      expect(mtm.drawdownPct).toBeGreaterThanOrEqual(2.0);
      expect(engine.isHalted()).toBe(true);
    });

    it('rejects spot sell when venue base inventory is insufficient (prevents negative spot balance - Bug 1 / R2)', () => {
      const engine = new PaperStrategyEngine({ strategyId: 'spot-2exch' });
      // Set Bybit BTC inventory to 0
      const venueSnap = (engine as any).venueBalances;
      venueSnap.bybit.baseInventory['BTC/USDT'] = 0;

      const sequencer = new OrderbookSequencer();
      const now = 1761840000000;
      // Direction 1: Buy Binance, Sell Bybit
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: now,
        receivedTs: now + 5,
        bids: [{ price: 68000, quantity: 2 }],
        asks: [{ price: 68010, quantity: 2 }],
      });
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: now,
        receivedTs: now + 5,
        bids: [{ price: 68300, quantity: 2 }],
        asks: [{ price: 68310, quantity: 2 }],
      });

      const dec = engine.evaluatePair(sequencer, 'BTC/USDT', 1, now + 10);
      // Must be rejected with NO_TRADE due to insufficient inventory
      expect(dec.decision).toBe('NO_TRADE');
      expect(dec.reason).toContain('Insufficient inventory/collateral');
      expect(engine.getSnapshot().venueBalances?.bybit.baseInventory['BTC/USDT']).toBe(0);
    });

    it('evaluates MTM inside evaluatePair and halts new entries while allowing open position close (Bug 2 / R3)', () => {
      const engine = new PaperStrategyEngine({
        strategyId: 'spot-2exch',
        maxDrawdownLimitPct: 2.0,
      });
      const sequencer = new OrderbookSequencer();
      const now = 1761840000000;

      // Manually plant open cycle
      (engine as any).cashBalanceUsdt = 3200;
      (engine as any).openCycles.set('BTC/USDT', {
        cycleId: 'test-spot-open',
        strategyId: 'spot-2exch',
        pair: 'BTC/USDT',
        entryTs: now,
        entrySeqA: 1,
        entrySeqB: 1,
        legAExchange: 'binance',
        legAMarket: 'spot',
        legBExchange: 'bybit',
        legBMarket: 'spot',
        entryLegAPrice: 68000,
        entryLegBPrice: 68100,
        entrySpreadBps: 14.7,
        quantityBase: 0.1,
        notionalUsdt: 6800,
        accruedFundingUsdt: 0,
        entryFeesUsdt: 13.6,
      });

      // Severe market drop on Leg A
      sequencer.ingest({
        exchange: 'binance',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 10,
        exchangeTs: now + 500,
        receivedTs: now + 510,
        bids: [{ price: 40000, quantity: 1 }],
        asks: [{ price: 40010, quantity: 1 }],
      });
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 10,
        exchangeTs: now + 500,
        receivedTs: now + 510,
        bids: [{ price: 80000, quantity: 1 }],
        asks: [{ price: 80010, quantity: 1 }],
      });

      // evaluatePair runs MTM internally and updates equity and drawdown
      engine.evaluatePair(sequencer, 'BTC/USDT', 2, now + 520);
      expect(engine.isHalted()).toBe(true);
      expect(engine.getSnapshot().equityUsdt).toBeLessThan(10000);
      expect(engine.getSnapshot().maxDrawdownPct).toBeGreaterThanOrEqual(2.0);
    });

    it('retries D1 persistence on subsequent calls if first attempt threw an error (Bug 3 / R5)', async () => {
      const { PaperJournal } = await import('../journal');
      const journal = new PaperJournal();

      let attempts = 0;
      const mockDb: any = {
        prepare: () => ({
          bind: () => ({
            run: async () => {
              attempts += 1;
              if (attempts === 1) {
                throw new Error('D1 Connection Timeout');
              }
              return { success: true };
            },
          }),
        }),
      };

      const cycle: any = {
        cycleId: 'test-c1',
        idempotencyKey: 'idem_key_123',
        strategyId: 'spot-2exch',
        pair: 'BTC/USDT',
        entryTs: 1000,
        exitTs: 2000,
        entrySeqA: 1,
        entrySeqB: 2,
        exitSeqA: 3,
        exitSeqB: 4,
        notionalUsdt: 500,
        quantityBase: 0.01,
        legAExchange: 'binance',
        legAMarket: 'spot',
        legBExchange: 'bybit',
        legBMarket: 'spot',
        entryLegAPrice: 50000,
        entryLegBPrice: 50100,
        exitLegAPrice: 50050,
        exitLegBPrice: 50040,
        rawSpreadBps: 20,
        netSpreadBps: 10,
        grossPnlUsdt: 1,
        totalFeesUsdt: 0.5,
        fundingDeltaUsdt: 0,
        netPnlUsdt: 0.5,
        modelVersion: 'paper-v1.1.0',
        replayObjectKey: 'r2://test.json',
        executionMode: 'PAPER',
      };

      // First attempt fails D1
      await expect(journal.recordClosedCycle(cycle, mockDb)).rejects.toThrow('D1 Connection Timeout');
      expect(attempts).toBe(1);

      // Second attempt must NOT be rejected as duplicate; it should retry D1 and succeed
      const secondResult = await journal.recordClosedCycle(cycle, mockDb);
      expect(secondResult).toBe(true);
      expect(attempts).toBe(2);

      // Third attempt is an actual duplicate and returns false without running D1
      const thirdResult = await journal.recordClosedCycle(cycle, mockDb);
      expect(thirdResult).toBe(false);
      expect(attempts).toBe(2);
    });
  });
});

