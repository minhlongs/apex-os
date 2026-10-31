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

const round4 = (n: number): number => Number(n.toFixed(4));

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
    it('initializes with exactly 10,000 USDT of capital, none of it granted as free inventory', () => {
      const spotEngine = new PaperStrategyEngine({ strategyId: 'spot-2exch' });
      const perpEngine = new PaperStrategyEngine({ strategyId: 'spot-perp' });

      expect(spotEngine.initialCapitalUsdt).toBe(10000);
      expect(perpEngine.initialCapitalUsdt).toBe(10000);

      // NAV is exactly the allocated capital at t=0, and it is fully covered by
      // free collateral plus the cost basis of the base inventory that was
      // bought out of that same capital. No asset exists outside the capital.
      for (const engine of [spotEngine, perpEngine]) {
        const snap = engine.getSnapshot();
        const venueCash =
          (snap.venueBalances?.binance.freeCollateralUsdt ?? 0) +
          (snap.venueBalances?.bybit.freeCollateralUsdt ?? 0);
        const inventoryCost =
          (snap.venueBalances?.binance.baseInventoryCostBasisUsdt?.['BTC/USDT'] ??
            0) +
          (snap.venueBalances?.binance.baseInventoryCostBasisUsdt?.['ETH/USDT'] ??
            0) +
          (snap.venueBalances?.bybit.baseInventoryCostBasisUsdt?.['BTC/USDT'] ??
            0) +
          (snap.venueBalances?.bybit.baseInventoryCostBasisUsdt?.['ETH/USDT'] ?? 0);

        expect(engine.getCurrentEquityUsdt()).toBe(10000);
        expect(round4(venueCash + inventoryCost)).toBe(10000);
      }
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

      // Verify that >= 2.0% halts the strategy via venue collateral / MTM drop
      (engine as any).peakEquityUsdt = 10000;
      (engine as any).venueBalances.binance.freeCollateralUsdt -= 210; // $210 loss = 2.1% drawdown
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

      // Each venue is funded with half the capital. Base inventory is bought out
      // of that half, so free collateral is the half minus its cost basis.
      const binanceInventoryCost =
        (snap.venueBalances?.binance.baseInventoryCostBasisUsdt?.['BTC/USDT'] ?? 0) +
        (snap.venueBalances?.binance.baseInventoryCostBasisUsdt?.['ETH/USDT'] ?? 0);
      const bybitInventoryCost =
        (snap.venueBalances?.bybit.baseInventoryCostBasisUsdt?.['BTC/USDT'] ?? 0) +
        (snap.venueBalances?.bybit.baseInventoryCostBasisUsdt?.['ETH/USDT'] ?? 0);

      expect(snap.venueBalances?.binance.freeCollateralUsdt).toBe(5000 - binanceInventoryCost);
      expect(snap.venueBalances?.bybit.freeCollateralUsdt).toBe(5000 - bybitInventoryCost);
      expect(snap.venueBalances?.binance.allocatedCollateralUsdt).toBe(0);
      expect(snap.venueBalances?.bybit.allocatedCollateralUsdt).toBe(0);
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

      // Crossing the 8-hour boundary (8h = 28,800,000 ms) with fresh synchronized books
      const afterBoundaryTs = baseTs + 28800000 + 1000;
      sequencer.resyncSnapshot(
        {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 100,
          exchangeTs: afterBoundaryTs,
          receivedTs: afterBoundaryTs + 5,
          bids: [{ price: 68000, quantity: 2 }],
          asks: [{ price: 68010, quantity: 2 }],
        },
        afterBoundaryTs + 10
      );
      sequencer.resyncSnapshot(
        {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 100,
          exchangeTs: afterBoundaryTs,
          receivedTs: afterBoundaryTs + 5,
          bids: [{ price: 68200, quantity: 2 }],
          asks: [{ price: 68210, quantity: 2 }],
          fundingRateBps: 1.5,
          fundingEventId: 'binance:BTC/USDT:funding:1761868800000',
        },
        afterBoundaryTs + 10
      );

      const postDec1 = engine1.evaluatePair(sequencer, 'BTC/USDT', 60, afterBoundaryTs + 10);
      const postDec2 = engine2.evaluatePair(sequencer, 'BTC/USDT', 60, afterBoundaryTs + 10);
      expect(postDec1.decision).toBe('HOLD');
      expect(postDec2.decision).toBe('HOLD');

      // Both must have accrued identical non-zero funding of 500 * 1.5 bps = 0.075 USDT
      const snap1 = engine1.getSnapshot();
      const snap2 = engine2.getSnapshot();
      expect(snap1.fundingLedger?.length).toBe(1);
      expect(snap2.fundingLedger?.length).toBe(1);
      expect(snap1.fundingLedger?.[0].fundingDeltaUsdt).toBeCloseTo(0.075, 4);
      expect(snap2.fundingLedger?.[0].fundingDeltaUsdt).toBeCloseTo(0.075, 4);
      expect(snap1.unrealizedPnlUsdt).toBe(snap2.unrealizedPnlUsdt);
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

      let journalInserts = 0;
      const mockDb: any = {
        prepare: (sql: string) => ({
          bind: () => ({
            run: async () => {
              if (sql.includes('INSERT OR IGNORE INTO paper_trade_journal')) {
                journalInserts += 1;
                if (journalInserts === 1) {
                  throw new Error('D1 Connection Timeout');
                }
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
      expect(journalInserts).toBe(1);

      // Second attempt must NOT be rejected as duplicate; it should retry D1 and succeed
      const secondResult = await journal.recordClosedCycle(cycle, mockDb);
      expect(secondResult).toBe(true);
      expect(journalInserts).toBe(2);

      // Third attempt is an actual duplicate and returns false without running D1
      const thirdResult = await journal.recordClosedCycle(cycle, mockDb);
      expect(thirdResult).toBe(false);
      expect(journalInserts).toBe(2);
    });

    it('P23-01 & P23-02: conserves initial 10,000 USDT NAV and resets unrealized P&L on close/restore without double counting', () => {
      const engine = new PaperStrategyEngine({
        strategyId: 'spot-2exch',
        initialCapitalUsdt: 10000,
      });
      const initSnap = engine.getSnapshot();
      // At t=0: cash (6,000) + inventory cost basis (4,000) === 10,000 USDT
      expect(initSnap.cashBalanceUsdt).toBe(6000);
      expect(initSnap.inventoryValueUsdt).toBe(4000);
      expect(initSnap.equityUsdt).toBe(10000);
      expect(initSnap.unrealizedPnlUsdt).toBe(0);

      // Run up to tick 6 (first cycle opens on tick 2, holds on 3..5, closes on 6)
      const ticks = buildCanonical50TickSequence().slice(0, 6);
      const sequencer = new OrderbookSequencer();
      for (const tick of ticks) {
        for (const book of tick.books) {
          sequencer.ingest(book, tick.nowTs);
        }
        engine.evaluatePair(sequencer, 'BTC/USDT', tick.tickIndex, tick.nowTs);
        engine.evaluatePair(sequencer, 'ETH/USDT', tick.tickIndex, tick.nowTs);
      }

      const postCloseSnap = engine.getSnapshot();
      expect(postCloseSnap.openCyclesCount).toBe(0);
      expect(postCloseSnap.closedCyclesCount).toBeGreaterThanOrEqual(1);
      // Unrealized P&L must be strictly 0 when all cycles are closed
      expect(postCloseSnap.unrealizedPnlUsdt).toBe(0);
      // Total equity must equal initialCapitalUsdt + realizedNetPnlUsdt (no stale unrealized P&L double-counting)
      expect(postCloseSnap.equityUsdt).toBeCloseTo(
        10000 + postCloseSnap.realizedNetPnlUsdt,
        3
      );

      // Serialize and restore into a fresh engine: equity and unrealized P&L must match identically
      const saved = engine.serializeState();
      const restored = new PaperStrategyEngine({
        strategyId: 'spot-2exch',
        initialCapitalUsdt: 10000,
      });
      restored.restoreState(saved);
      const restoredSnap = restored.getSnapshot();
      expect(restoredSnap.unrealizedPnlUsdt).toBe(0);
      expect(restoredSnap.equityUsdt).toBe(postCloseSnap.equityUsdt);
      expect(restoredSnap.peakEquityUsdt).toBe(postCloseSnap.peakEquityUsdt);
    });

    it('P23-05: supports multi-venue spot-perp on Bybit and records discrete funding settlements in fundingLedger', () => {
      const engine = new PaperStrategyEngine({
        strategyId: 'spot-perp',
        initialCapitalUsdt: 10000,
      });
      const sequencer = new OrderbookSequencer();
      // Start 10 seconds before an 8-hour UTC boundary (e.g. 28800000 * 61175 = 1761840000000)
      const boundaryTs = Math.ceil(1761840000000 / 28800000) * 28800000;
      const entryTs = boundaryTs - 5000;

      // Ingest only Bybit spot + linear_perp with wide positive basis (Binance omitted or tighter)
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 1,
        exchangeTs: entryTs,
        receivedTs: entryTs + 5,
        bids: [{ price: 67995, quantity: 2 }],
        asks: [{ price: 68000, quantity: 2 }],
      }, entryTs + 10);
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'linear_perp',
        sequenceId: 1,
        exchangeTs: entryTs,
        receivedTs: entryTs + 5,
        bids: [{ price: 68250, quantity: 2 }],
        asks: [{ price: 68255, quantity: 2 }],
        fundingRateBps: 2.5,
        fundingEventId: 'bybit-btc-funding-1',
      }, entryTs + 10);

      const openDec = engine.evaluatePair(sequencer, 'BTC/USDT', 1, entryTs + 10);
      expect(openDec.decision).toBe('OPEN_CYCLE');
      expect(openDec.reason).toContain('bybit');

      // Cross the 8-hour boundary
      const afterTs = boundaryTs + 1000;
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'spot',
        sequenceId: 2,
        exchangeTs: afterTs,
        receivedTs: afterTs + 5,
        bids: [{ price: 68000, quantity: 2 }],
        asks: [{ price: 68005, quantity: 2 }],
      }, afterTs + 10);
      sequencer.ingest({
        exchange: 'bybit',
        pair: 'BTC/USDT',
        marketType: 'linear_perp',
        sequenceId: 2,
        exchangeTs: afterTs,
        receivedTs: afterTs + 5,
        bids: [{ price: 68240, quantity: 2 }],
        asks: [{ price: 68245, quantity: 2 }],
        fundingRateBps: 2.5,
        fundingEventId: 'bybit-btc-funding-1',
      }, afterTs + 10);

      engine.evaluatePair(sequencer, 'BTC/USDT', 2, afterTs + 10);
      const snap = engine.getSnapshot();
      expect(snap.fundingLedger?.length).toBe(1);
      expect(snap.fundingLedger?.[0].eventId).toBe('bybit-btc-funding-1');
      expect(snap.fundingLedger?.[0].exchange).toBe('bybit');
      expect(snap.fundingLedger?.[0].fundingDeltaUsdt).toBeCloseTo(500 * 0.00025, 4);
    });

    it('P23-03 & P23-04: PaperTradingDurableObject reports truthful isLive status only when all 8 required feeds are fresh and synced', async () => {
      const { PaperTradingDurableObject } = await import('../worker-do');
      const { REQUIRED_PAPER_STREAMS } = await import('../orderbook-sequencer');
      const store = new Map<string, unknown>();
      const doInstance = new PaperTradingDurableObject({
        storage: {
          get: async (k) => store.get(k) as any,
          put: async (k, v) => {
            store.set(k, v);
          },
        },
      });

      // Idle DO must report isLive = false
      const idleRes = await doInstance.fetch(new Request('http://internal/status'));
      const idleJson = (await idleRes.json()) as any;
      expect(idleJson.isLive).toBe(false);
      expect(idleJson.dataSource).toBe('DURABLE_OBJECT_IDLE_OR_STALE');

      // Ingest only 1 stream -> still NOT live because 7 streams are missing
      const now = Date.now();
      await doInstance.ingestOrderbook(
        {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 100,
          exchangeTs: now - 10,
          receivedTs: now,
          bids: [{ price: 68000, quantity: 2 }],
          asks: [{ price: 68005, quantity: 2 }],
        },
        now
      );
      expect(doInstance.isCollectorLive(now)).toBe(false);

      // Ingest all 8 required streams -> now isCollectorLive is true
      for (const s of REQUIRED_PAPER_STREAMS) {
        const mid = s.pair === 'BTC/USDT' ? 68000 : 2600;
        await doInstance.ingestOrderbook(
          {
            exchange: s.exchange,
            pair: s.pair,
            marketType: s.marketType,
            sequenceId: 101,
            exchangeTs: now - 5,
            receivedTs: now,
            bids: [{ price: mid, quantity: 2 }],
            asks: [{ price: mid + 5, quantity: 2 }],
          },
          now
        );
      }

      expect(doInstance.isCollectorLive(now)).toBe(true);
      // 10 seconds later without new messages -> stale -> isCollectorLive must be false
      expect(doInstance.isCollectorLive(now + 10000)).toBe(false);
    });

    it('P23-06: PaperJournal records outbox, surfaces R2 errors, and reconciles pending R2 objects with SHA-256 metadata', async () => {
      const { PaperJournal } = await import('../journal');
      const journal = new PaperJournal();

      const outboxState = new Map<string, any>();
      const mockDb: any = {
        prepare: (sql: string) => ({
          bind: (...args: any[]) => ({
            run: async () => {
              if (sql.includes('INSERT OR IGNORE INTO paper_trading_outbox')) {
                outboxState.set(args[1], {
                  outbox_id: args[0],
                  idempotency_key: args[1],
                  payload_json: args[2],
                  d1_persisted: 1,
                  r2_persisted: 0,
                  attempts: 1,
                  last_error: null,
                });
              } else if (sql.includes('UPDATE paper_trading_outbox') && sql.includes('d1_persisted = ?')) {
                const entry = outboxState.get(args[3]);
                if (entry) {
                  entry.d1_persisted = args[0];
                  entry.r2_persisted = args[1];
                  entry.last_error = args[2];
                }
              } else if (sql.includes('SET r2_persisted = 1')) {
                const entry = outboxState.get(args[0]);
                if (entry) {
                  entry.r2_persisted = 1;
                  entry.last_error = null;
                  entry.attempts += 1;
                }
              }
              return { success: true };
            },
          }),
          all: async () => ({
            results: Array.from(outboxState.values()).filter((r) => r.r2_persisted === 0),
          }),
        }),
      };

      let r2ShouldFail = true;
      const r2Stored = new Map<string, { val: any; opts: any }>();
      const mockR2: any = {
        put: async (key: string, val: any, opts: any) => {
          if (r2ShouldFail) {
            throw new Error('R2 Bucket Unavailable');
          }
          r2Stored.set(key, { val, opts });
        },
        get: async () => null,
      };

      const cycle: any = {
        cycleId: 'c-outbox-1',
        idempotencyKey: 'idem_outbox_1',
        strategyId: 'spot-2exch',
        pair: 'BTC/USDT',
        entryTs: 1000,
        exitTs: 2000,
        entrySeqA: 1,
        entrySeqB: 1,
        exitSeqA: 2,
        exitSeqB: 2,
        notionalUsdt: 500,
        quantityBase: 0.01,
        legAExchange: 'binance',
        legAMarket: 'spot',
        legBExchange: 'bybit',
        legBMarket: 'spot',
        entryLegAPrice: 68000,
        entryLegBPrice: 68100,
        exitLegAPrice: 68050,
        exitLegBPrice: 68045,
        rawSpreadBps: 14,
        netSpreadBps: 7,
        grossPnlUsdt: 0.5,
        totalFeesUsdt: 0.15,
        fundingDeltaUsdt: 0,
        netPnlUsdt: 0.35,
        modelVersion: 'paper-v1.1.0',
        replayObjectKey: 'r2://apex-os-paper/cycles/idem_outbox_1.json',
        executionMode: 'PAPER',
      };

      await journal.recordClosedCycle(cycle, mockDb, mockR2);
      const pending = outboxState.get('idem_outbox_1');
      expect(pending).toBeDefined();
      expect(pending.d1_persisted).toBe(1);
      expect(pending.r2_persisted).toBe(0);
      expect(pending.last_error).toContain('R2 Bucket Unavailable');

      // Now R2 recovers and reconcileOutbox retries
      r2ShouldFail = false;
      const rec = await journal.reconcileOutbox(mockDb, mockR2);
      expect(rec.retriedR2).toBe(1);
      expect(outboxState.get('idem_outbox_1').r2_persisted).toBe(1);
      expect(outboxState.get('idem_outbox_1').last_error).toBeNull();
      const archived = r2Stored.get('cycles/idem_outbox_1.json');
      expect(archived).toBeDefined();
      expect(archived?.opts.customMetadata.sha256).toMatch(/^[a-f0-9]{64}$/);
    });

    it('P23-07: verify-paper-economic-gate.cjs blocks when runs are missing or incomplete and passes only when both strategies meet 30d/100cycles/>0PnL/<=2%DD', () => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { evaluateRuns, EXPECTED_CONFIG_HASH, EXPECTED_MODEL_VERSION } = require('../../../../scripts/verify-paper-economic-gate.cjs');

      const emptyRes = evaluateRuns([]);
      expect(emptyRes.passed).toBe(false);
      expect(emptyRes.verdict).toBe('NO_GO');

      const nowIso = new Date().toISOString();

      const partialRes = evaluateRuns([
        {
          run_id: 'run_spot-2exch_1761840000000',
          strategy_id: 'spot-2exch',
          model_version: EXPECTED_MODEL_VERSION,
          is_active: 1,
          verified_real_market_days: 12.5,
          closed_cycles_count: 110,
          realized_net_pnl_usdt: 45.2,
          max_drawdown_pct: 0.8,
          config_hash: EXPECTED_CONFIG_HASH,
          last_heartbeat_at: nowIso,
          verdict: 'NO_GO',
        },
      ]);
      expect(partialRes.passed).toBe(false);

      const passingRes = evaluateRuns([
        {
          run_id: 'run_spot-2exch_1761840000000',
          strategy_id: 'spot-2exch',
          model_version: EXPECTED_MODEL_VERSION,
          is_active: 1,
          verified_real_market_days: 30.5,
          closed_cycles_count: 142,
          realized_net_pnl_usdt: 128.4,
          max_drawdown_pct: 1.15,
          config_hash: EXPECTED_CONFIG_HASH,
          last_heartbeat_at: nowIso,
          verdict: 'GO',
        },
        {
          run_id: 'run_spot-perp_1761840000000',
          strategy_id: 'spot-perp',
          model_version: EXPECTED_MODEL_VERSION,
          is_active: 1,
          verified_real_market_days: 30.5,
          closed_cycles_count: 118,
          realized_net_pnl_usdt: 94.7,
          max_drawdown_pct: 0.92,
          config_hash: EXPECTED_CONFIG_HASH,
          last_heartbeat_at: nowIso,
          verdict: 'GO',
        },
      ]);
      expect(passingRes.passed).toBe(true);
      expect(passingRes.verdict).toBe('GO');
    });

    describe('7. Adversarial Remediation Verification (V1 through V7)', () => {
      it('V1: values standing base inventory at live orderbook prices and halts strategy when 50% market drop triggers >=2% drawdown even with 0 open cycles', () => {
        const engine = new PaperStrategyEngine({
          strategyId: 'spot-2exch',
          initialCapitalUsdt: 10000,
          maxDrawdownLimitPct: 2.0,
        });
        const sequencer = new OrderbookSequencer();
        const now = 1761840000000;

        // At t=0, standing inventory has reference cost basis 4,000 USDT (2,000 BTC + 2,000 ETH)
        // Cash is 6,000 USDT -> total NAV = 10,000 USDT exactly, drawdown = 0%
        expect(engine.getCurrentEquityUsdt()).toBe(10000);
        expect(engine.isHalted()).toBe(false);

        // Adversarial market crash: BTC drops 50% (68,000 -> 34,000), ETH drops 50% (2,600 -> 1,300)
        // No open cycles exist!
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 10,
          exchangeTs: now,
          receivedTs: now + 5,
          bids: [{ price: 34000, quantity: 1 }],
          asks: [{ price: 34005, quantity: 1 }],
        });
        sequencer.ingest({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 10,
          exchangeTs: now,
          receivedTs: now + 5,
          bids: [{ price: 34000, quantity: 1 }],
          asks: [{ price: 34005, quantity: 1 }],
        });
        sequencer.ingest({
          exchange: 'binance',
          pair: 'ETH/USDT',
          marketType: 'spot',
          sequenceId: 10,
          exchangeTs: now,
          receivedTs: now + 5,
          bids: [{ price: 1300, quantity: 10 }],
          asks: [{ price: 1301, quantity: 10 }],
        });
        sequencer.ingest({
          exchange: 'bybit',
          pair: 'ETH/USDT',
          marketType: 'spot',
          sequenceId: 10,
          exchangeTs: now,
          receivedTs: now + 5,
          bids: [{ price: 1300, quantity: 10 }],
          asks: [{ price: 1301, quantity: 10 }],
        });

        // Trigger mark-to-market update
        const mtm = engine.updateMarkToMarketDrawdown(sequencer, now + 10);

        // Standing inventory 4,000 USDT drops to ~2,000 USDT -> total equity ~8,000 USDT (20% drawdown)
        expect(mtm.equityUsdt).toBeLessThan(8010);
        expect(mtm.equityUsdt).toBeGreaterThan(7990);
        expect(mtm.drawdownPct).toBeGreaterThanOrEqual(19.9);
        expect(mtm.halted).toBe(true);
        expect(engine.isHalted()).toBe(true);

        // Strategy must refuse to open new cycles and return HALTED_DRAWDOWN
        const dec = engine.evaluatePair(sequencer, 'BTC/USDT', 1, now + 15);
        expect(dec.decision).toBe('HALTED_DRAWDOWN');
        expect(dec.reason).toContain('halted from opening new cycles');
      });

      it('V2: requires all 8 streams synced, refuses to synthesize 31 market days from single stream or downtime, and resets on unrecoverable gap', async () => {
        const { PaperTradingDurableObject } = await import('../worker-do');
        const { REQUIRED_PAPER_STREAMS } = await import('../orderbook-sequencer');
        const store = new Map<string, unknown>();
        // Simulate a past run started 31 days ago in storage without verified continuous coverage
        const pastStartMs = Date.now() - 31 * 86400 * 1000;
        store.set('run_started_at_ms', pastStartMs);
        store.set('continuous_coverage_ms', 0); // No continuous coverage accrued!

        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => {
              store.set(k, v);
            },
          },
        });
        await doInstance.ensureRestored();

        const now = Date.now();
        // Ingest only 1 stream
        await doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 1,
            exchangeTs: now - 5,
            receivedTs: now,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68005, quantity: 1 }],
          },
          now
        );

        // DO must NOT be live, and verified days must be 0 (never synthesized from run_started_at_ms!)
        expect(doInstance.isCollectorLive(now)).toBe(false);
        const statusRes = await doInstance.fetch(new Request('http://internal/status'));
        const statusJson = (await statusRes.json()) as any;
        expect(statusJson.verifiedRealMarketDays).toBe(0);
        expect(statusJson.isLive).toBe(false);

        // Now ingest all 8 streams to start continuous coverage
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 68000 : 2600;
          await doInstance.ingestOrderbook(
            {
              exchange: s.exchange,
              pair: s.pair,
              marketType: s.marketType,
              sequenceId: 2,
              exchangeTs: now - 2,
              receivedTs: now,
              bids: [{ price: mid, quantity: 1 }],
              asks: [{ price: mid + 5, quantity: 1 }],
            },
            now
          );
        }
        expect(doInstance.isCollectorLive(now)).toBe(true);

        // Advance 600ms with all 8 streams still fresh (< 1000ms) to accrue continuous coverage
        const nextTickTs = now + 600;
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 68000 : 2600;
          await doInstance.ingestOrderbook(
            {
              exchange: s.exchange,
              pair: s.pair,
              marketType: s.marketType,
              sequenceId: 3,
              exchangeTs: nextTickTs - 2,
              receivedTs: nextTickTs,
              bids: [{ price: mid, quantity: 1 }],
              asks: [{ price: mid + 5, quantity: 1 }],
            },
            nextTickTs
          );
        }
        const liveRes = await doInstance.fetch(new Request('http://internal/status'));
        const liveJson = (await liveRes.json()) as any;
        expect(liveJson.continuousCoverageMs).toBeGreaterThanOrEqual(600);
        expect(liveJson.verifiedRealMarketDays).toBeGreaterThan(0);

        // Simulate an unrecoverable feed gap (> 15 seconds of silence) followed by new tick
        const afterGapTs = nextTickTs + 60000; // 60s silence (> 15s gap limit)
        await doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 4,
            exchangeTs: afterGapTs - 2,
            receivedTs: afterGapTs,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68005, quantity: 1 }],
          },
          afterGapTs
        );

        // The unrecoverable gap must reset continuous coverage to 0
        const resetRes = await doInstance.fetch(new Request('http://internal/status'));
        const resetJson = (await resetRes.json()) as any;
        expect(resetJson.continuousCoverageMs).toBe(0);
        expect(resetJson.verifiedRealMarketDays).toBe(0);
      });

      it('V3: restores collector and reschedules alarm after DO restart, while respecting stop-collector', async () => {
        const { PaperTradingDurableObject } = await import('../worker-do');
        const store = new Map<string, unknown>();
        let scheduledAlarmTime: number | null = null;

        const mockState: any = {
          storage: {
            get: async (k: string) => store.get(k),
            put: async (k: string, v: unknown) => {
              store.set(k, v);
            },
            getAlarm: async () => scheduledAlarmTime,
            setAlarm: async (time: number) => {
              scheduledAlarmTime = time;
            },
            deleteAlarm: async () => {
              scheduledAlarmTime = null;
            },
          },
        };

        const doInstance = new PaperTradingDurableObject(mockState);
        // Start collector via POST
        const startRes = await doInstance.fetch(
          new Request('http://internal/start-collector', { method: 'POST' })
        );
        expect(startRes.status).toBe(200);
        expect(store.get('collector_desired_running')).toBe(true);
        expect(scheduledAlarmTime).toBeGreaterThan(Date.now());

        // Simulate crash and restart DO
        const restartedDO = new PaperTradingDurableObject(mockState);
        await restartedDO.ensureRestored();
        await new Promise((r) => setTimeout(r, 20));
        expect((restartedDO as any).collector).not.toBeNull();

        // Simulate alarm firing on restarted DO
        await restartedDO.alarm();
        expect(scheduledAlarmTime).toBeGreaterThan(Date.now());

        // Stop collector via POST
        const stopRes = await restartedDO.fetch(
          new Request('http://internal/stop-collector', { method: 'POST' })
        );
        expect(stopRes.status).toBe(200);
        expect(store.get('collector_desired_running')).toBe(false);

        // Crash and restart again: collector must NOT be auto-started when desired_running is false
        const stoppedDO = new PaperTradingDurableObject(mockState);
        await stoppedDO.ensureRestored();
        expect((stoppedDO as any).collector).toBeNull();
      });

      it('V4 & V5: enforces frozen canonical config hash and hardened economic verifier', () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { evaluateRuns, EXPECTED_CONFIG_HASH, EXPECTED_MODEL_VERSION } = require('../../../../scripts/verify-paper-economic-gate.cjs');
        const { PAPER_CANONICAL_CONFIG, PAPER_FROZEN_CONFIG_HASH } = require('../strategy-engine');

        // Engine and verifier must agree 100% on the canonical config hash and model version
        expect(PAPER_FROZEN_CONFIG_HASH).toBe(EXPECTED_CONFIG_HASH);
        expect(PAPER_CANONICAL_CONFIG.modelVersion).toBe(EXPECTED_MODEL_VERSION);

        const nowIso = new Date().toISOString();

        // 1. Rejects wrong config_hash
        const badHash = evaluateRuns([
          {
            run_id: 'run_spot-2exch_1',
            strategy_id: 'spot-2exch',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: 'bad_hash_123',
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
          {
            run_id: 'run_spot-perp_1',
            strategy_id: 'spot-perp',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: 'bad_hash_123',
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
        ]);
        expect(badHash.passed).toBe(false);
        expect(badHash.reason).toContain('failed the mandatory');

        // 2. Rejects stale heartbeat (> 15 minutes old)
        const staleIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
        const staleHb = evaluateRuns([
          {
            run_id: 'run_spot-2exch_1',
            strategy_id: 'spot-2exch',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: staleIso,
            verdict: 'GO',
          },
          {
            run_id: 'run_spot-perp_1',
            strategy_id: 'spot-perp',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: staleIso,
            verdict: 'GO',
          },
        ]);
        expect(staleHb.passed).toBe(false);

        // 3. Rejects duplicate active rows for a single strategy
        const dupRows = evaluateRuns([
          {
            run_id: 'run_spot-2exch_1',
            strategy_id: 'spot-2exch',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
          {
            run_id: 'run_spot-2exch_2',
            strategy_id: 'spot-2exch',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
          {
            run_id: 'run_spot-perp_1',
            strategy_id: 'spot-perp',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
        ]);
        expect(dupRows.passed).toBe(false);
        expect(dupRows.details.some((d: any) => d.reason?.includes('Multiple active'))).toBe(true);

        // 4. Rejects mismatched run window timestamps
        const mismatchedWindow = evaluateRuns([
          {
            run_id: 'run_spot-2exch_1761840000000',
            strategy_id: 'spot-2exch',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
          {
            run_id: 'run_spot-perp_1761850000000',
            strategy_id: 'spot-perp',
            model_version: EXPECTED_MODEL_VERSION,
            is_active: 1,
            verified_real_market_days: 31,
            closed_cycles_count: 120,
            realized_net_pnl_usdt: 100,
            max_drawdown_pct: 1.0,
            config_hash: EXPECTED_CONFIG_HASH,
            last_heartbeat_at: nowIso,
            verdict: 'GO',
          },
        ]);
        expect(mismatchedWindow.passed).toBe(false);
      });

      it('V6: buffers and bridges WebSocket deltas during REST snapshot resync', () => {
        const { LiveMarketCollector } = require('../live-collector');
        const collector = new LiveMarketCollector(new OrderbookSequencer());

        const streamKey = OrderbookSequencer.makeStreamKey('binance', 'BTC/USDT', 'spot');
        collector.beginBootstrapping(streamKey);

        // Ingest WS delta while snapshot is in flight -> must be buffered
        const buffered = collector.ingestOrBufferWsBook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 105,
          exchangeTs: 1000,
          receivedTs: 1005,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68005, quantity: 1 }],
        });
        expect(buffered).toBe(true);

        // Deliver REST snapshot with sequenceId 100
        const drained = collector.applySnapshotAndDrainBuffer(streamKey, {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 100,
          exchangeTs: 990,
          receivedTs: 995,
          bids: [{ price: 67990, quantity: 2 }],
          asks: [{ price: 68010, quantity: 2 }],
        });
        expect(drained.length).toBe(1);
        expect(drained[0].sequenceId).toBe(105);

        // Subsequent WS delta must be ingested directly
        const direct = collector.ingestOrBufferWsBook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 106,
          exchangeTs: 1010,
          receivedTs: 1015,
          bids: [{ price: 68001, quantity: 1 }],
          asks: [{ price: 68006, quantity: 1 }],
        });
        expect(direct).toBe(false);
      });

      it('V7: separates physical spot cashflow from linear perp short margin in spot-perp strategy', () => {
        const engine = new PaperStrategyEngine({
          strategyId: 'spot-perp',
          initialCapitalUsdt: 10000,
        });
        const sequencer = new OrderbookSequencer();
        const now = 1761840000000;

        const initVenue = engine.getSnapshot().venueBalances;
        const binanceInitBtc = initVenue?.binance.baseInventory['BTC/USDT'] ?? 0;
        expect(binanceInitBtc).toBeGreaterThan(0);

        // Feed wide spread on Binance spot vs linear perp to open cycle
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: now,
          receivedTs: now + 5,
          bids: [{ price: 68000, quantity: 2 }],
          asks: [{ price: 68005, quantity: 2 }],
        });
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 1,
          exchangeTs: now,
          receivedTs: now + 5,
          bids: [{ price: 68300, quantity: 2 }],
          asks: [{ price: 68305, quantity: 2 }],
          fundingRateBps: 2.0,
        });

        const openDec = engine.evaluatePair(sequencer, 'BTC/USDT', 1, now + 10);
        expect(openDec.decision).toBe('OPEN_CYCLE');

        const postOpenVenue = engine.getSnapshot().venueBalances;
        // In spot-perp, Leg A is physical spot buy -> adds to baseInventory
        // Leg B is linear perp short -> reserves margin in allocatedCollateral, NEVER mutates or depletes baseInventory
        const expectedBtc = binanceInitBtc + (500 / 68005);
        expect(postOpenVenue?.binance.baseInventory['BTC/USDT']).toBeCloseTo(expectedBtc, 4);
        expect(postOpenVenue?.binance.allocatedCollateralUsdt).toBeGreaterThanOrEqual(1000); // 500 spot buy + 500 perp margin
      });

      it('C1: resets continuousCoverageMs and runStartedAtMs when feed gap exceeds 15s, even when polled incrementally every 1s', async () => {
        const { PaperTradingDurableObject } = await import('../worker-do');
        const { REQUIRED_PAPER_STREAMS } = await import('../orderbook-sequencer');
        const store = new Map<string, unknown>();
        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => { store.set(k, v); },
            delete: async (k) => { store.delete(k); },
          },
        });
        await doInstance.ensureRestored();

        const baseTs = 1761840000000;
        // Ingest all 8 streams to establish live state
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 68000 : 2600;
          await doInstance.ingestOrderbook({
            exchange: s.exchange,
            pair: s.pair,
            marketType: s.marketType,
            sequenceId: 10,
            exchangeTs: baseTs - 5,
            receivedTs: baseTs,
            bids: [{ price: mid, quantity: 1 }],
            asks: [{ price: mid + 5, quantity: 1 }],
          }, baseTs);
        }
        expect(doInstance.isCollectorLive(baseTs)).toBe(true);

        // Advance 5 seconds with live stream updates: coverage should accrue ~5s
        const tLive = baseTs + 5000;
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 68000 : 2600;
          await doInstance.ingestOrderbook({
            exchange: s.exchange,
            pair: s.pair,
            marketType: s.marketType,
            sequenceId: 11,
            exchangeTs: tLive - 5,
            receivedTs: tLive,
            bids: [{ price: mid, quantity: 1 }],
            asks: [{ price: mid + 5, quantity: 1 }],
          }, tLive);
        }
        const status1 = (await (await doInstance.fetch(new Request('http://internal/status'))).json()) as any;
        expect(status1.continuousCoverageMs).toBeGreaterThanOrEqual(5000);

        // Now simulate a 60s outage where check/tick occurs every 1s without receiving all required streams
        for (let s = 1; s <= 60; s++) {
          const tickTs = tLive + s * 1000;
          // Ingest only 1 stream so the feed is non-live (isCollectorLive = false)
          await doInstance.ingestOrderbook({
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 12 + s,
            exchangeTs: tickTs - 5,
            receivedTs: tickTs,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68005, quantity: 1 }],
          }, tickTs);
        }

        // After 60s of outage with 1s steps, the window MUST have reset to 0 (Finding C1 Repro 1)
        const statusAfterOutage = (await (await doInstance.fetch(new Request('http://internal/status'))).json()) as any;
        expect(statusAfterOutage.continuousCoverageMs).toBe(0);
        expect(statusAfterOutage.verifiedRealMarketDays).toBe(0);

        // Reconnect after 31 days with no intermediate checks: must NOT credit 31 days of continuous coverage! (Finding C1 Repro 2)
        const t31DaysLater = tLive + 31 * 86400 * 1000;
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 68000 : 2600;
          await doInstance.ingestOrderbook({
            exchange: s.exchange,
            pair: s.pair,
            marketType: s.marketType,
            sequenceId: 200,
            exchangeTs: t31DaysLater - 5,
            receivedTs: t31DaysLater,
            bids: [{ price: mid, quantity: 1 }],
            asks: [{ price: mid + 5, quantity: 1 }],
          }, t31DaysLater);
        }
        const status31Days = (await (await doInstance.fetch(new Request('http://internal/status'))).json()) as any;
        expect(status31Days.continuousCoverageMs).toBe(0);
        expect(status31Days.verifiedRealMarketDays).toBe(0);
      });

      it('C2: OrderbookSequencer preserves authentic delta metadata and correctly verifies range continuity or flags FEED_DESYNC', () => {
        const sequencer = new OrderbookSequencer();
        const baseTs = 1761840000000;

        // Ingest REST snapshot with sequenceId = 100
        const snap = sequencer.resyncSnapshot({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 100,
          exchangeTs: baseTs,
          receivedTs: baseTs + 5,
          isDelta: false,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        }, baseTs + 5);
        expect(snap.status).toBe('SYNCED');
        expect(snap.lastSequenceId).toBe(100);

        // Delta that legitimately bridges snapshot (U <= 101 && u >= 101, e.g. U=95, u=105)
        const validBridge = sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          firstUpdateId: 95,
          sequenceId: 105,
          exchangeTs: baseTs + 10,
          receivedTs: baseTs + 15,
          isDelta: true,
          bids: [{ price: 68001, quantity: 1 }],
          asks: [{ price: 68009, quantity: 1 }],
        }, baseTs + 15);
        expect(validBridge.status).toBe('SYNCED');
        expect(validBridge.lastSequenceId).toBe(105);

        // Delta with true missing sequence gap (U = 110 > 106, missing 106..109)
        const gappedDelta = sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          firstUpdateId: 110,
          sequenceId: 120,
          exchangeTs: baseTs + 20,
          receivedTs: baseTs + 25,
          isDelta: true,
          bids: [{ price: 68002, quantity: 1 }],
          asks: [{ price: 68008, quantity: 1 }],
        }, baseTs + 25);
        // Must reject authentic gap as FEED_DESYNC, not mask it
        expect(gappedDelta.status).toBe('FEED_DESYNC');
      });
    });
  });
});

