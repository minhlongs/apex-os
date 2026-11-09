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
import { LiveMarketCollector } from '../live-collector';
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
      it('V1: remains market-neutral at 0 open cycles when market crashes 50%, and halts strategy when unhedged post-seed inventory suffers >=2% drawdown', () => {
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

        // Adversarial market crash at 0 open cycles: BTC drops 50% (68,000 -> 34,000), ETH drops 50% (2,600 -> 1,300)
        // Because operational seed inventory is re-anchored to live price on first mark with deltaStandingQty = 0,
        // 0-cycle price moves produce zero passive beta drawdown!
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

        // Trigger mark-to-market update at 0 open cycles: NAV remains 10,000 USDT (market-neutral)
        const mtmNeutral = engine.updateMarkToMarketDrawdown(sequencer, now + 10);
        expect(mtmNeutral.equityUsdt).toBe(10000);
        expect(mtmNeutral.drawdownPct).toBe(0);
        expect(mtmNeutral.halted).toBe(false);

        // Now simulate an unhedged base inventory deficit (-0.01 BTC below seed) that causes >= 2% NAV loss (~340 USDT)
        const saved = engine.serializeState();
        saved.venueBalances.binance.baseInventory['BTC/USDT'] = Number(
          (saved.venueBalances.binance.baseInventory['BTC/USDT'] - 0.01).toFixed(8)
        );
        engine.restoreState(saved);

        const mtm = engine.updateMarkToMarketDrawdown(sequencer, now + 12);
        expect(mtm.equityUsdt).toBeLessThan(9700);
        expect(mtm.drawdownPct).toBeGreaterThanOrEqual(2.0);
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
        expect(binanceInitBtc).toBe(0);
        expect(initVenue?.binance.freeCollateralUsdt).toBe(5000);
        expect(initVenue?.bybit.freeCollateralUsdt).toBe(5000);

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

      it('C3: a sustained outage resets the window exactly once, not once per subsequent tick', async () => {
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

        // First tick past the 15s boundary legitimately forfeits the window once.
        const firstOutageTick = baseTs + 20000;
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 100,
          exchangeTs: firstOutageTick - 5,
          receivedTs: firstOutageTick,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68005, quantity: 1 }],
        }, firstOutageTick);

        const afterFirstForfeiture = (await (await doInstance.fetch(new Request('http://internal/status'))).json() as any);
        expect(afterFirstForfeiture.continuousCoverageMs).toBe(0);
        const runStartAfterForfeiture = afterFirstForfeiture.runStartedAtMs;

        // Sustained partial outage: one stream keeps ticking, so the feed stays non-live.
        // The window is already forfeited, so no further tick may rewrite it.
        for (let i = 1; i <= 20; i++) {
          const tickTs = baseTs + 20000 + i * 250;
          await doInstance.ingestOrderbook({
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 100 + i,
            exchangeTs: tickTs - 5,
            receivedTs: tickTs,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68005, quantity: 1 }],
          }, tickTs);
        }

        const status = (await (await doInstance.fetch(new Request('http://internal/status'))).json()) as any;
        expect(status.continuousCoverageMs).toBe(0);
        expect(status.runStartedAtMs).toBe(runStartAfterForfeiture);
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

      it('C3: a re-delivered delta with the same sequence id is idempotent and does not latch FEED_DESYNC', () => {
        const sequencer = new OrderbookSequencer();
        const baseTs = 1761840000000;

        // Bybit WS native snapshot establishes the stream in the WS sequence space
        const snap = sequencer.resyncSnapshot({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 8218112,
          exchangeTs: baseTs,
          receivedTs: baseTs + 5,
          isDelta: false,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        }, baseTs + 5);
        expect(snap.status).toBe('SYNCED');

        const makeDelta = (u: number): NormalizedOrderbook => ({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: u,
          prevSequenceId: u - 1,
          exchangeTs: baseTs + 10,
          receivedTs: baseTs + 15,
          isDelta: true,
          bids: [{ price: 68005, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        });

        // First delta with u=8218113 bridges the snapshot
        const d1 = sequencer.ingest(makeDelta(8218113), baseTs + 15);
        expect(d1.status).toBe('SYNCED');
        expect(d1.lastSequenceId).toBe(8218113);
        const bookAfterFirst = sequencer.getBook('bybit', 'BTC/USDT', 'spot');

        // Bybit can re-emit the identical frame; re-applying must stay SYNCED, not FEED_DESYNC
        const d2 = sequencer.ingest(makeDelta(8218113), baseTs + 20);
        expect(d2.status).toBe('SYNCED');
        expect(d2.lastSequenceId).toBe(8218113);
        expect(d2.gapCount).toBe(0);

        // Re-applying the same delta must not corrupt the merged book (levels are set by price)
        const bookAfterRepeat = sequencer.getBook('bybit', 'BTC/USDT', 'spot');
        expect(bookAfterRepeat?.bids.length).toBe(bookAfterFirst?.bids.length);
        expect(bookAfterRepeat?.bids[0].price).toBe(bookAfterFirst?.bids[0].price);
        expect(bookAfterRepeat?.bids[0].quantity).toBe(bookAfterFirst?.bids[0].quantity);

        // A genuine forward delta still advances the stream normally
        const d3 = sequencer.ingest(makeDelta(8218114), baseTs + 25);
        expect(d3.status).toBe('SYNCED');
        expect(d3.lastSequenceId).toBe(8218114);
      });

      it('N1: resets window metrics to 0 cycles / 0 PnL after feed gap reset without losing historical cycles', async () => {
        const { PaperTradingDurableObject } = await import('../worker-do');
        const { REQUIRED_PAPER_STREAMS } = await import('../orderbook-sequencer');
        const store = new Map<string, unknown>();
        const syncedRuns: any[] = [];
        const mockDb: any = {
          prepare: (query: string) => ({
            bind: (...args: any[]) => ({
              run: async () => {
                if (query.includes('INSERT INTO paper_trading_runs')) {
                  syncedRuns.push({
                    run_id: args[0],
                    strategy_id: args[1],
                    closed_cycles_count: args[5],
                    realized_net_pnl_usdt: args[6],
                    max_drawdown_pct: args[7],
                    verdict: args[8],
                  });
                }
                return { success: true };
              },
              all: async () => [],
            }),
            all: async () => [],
          }),
        };

        const doInstance = new PaperTradingDurableObject(
          {
            storage: {
              get: async (k) => store.get(k) as any,
              put: async (k, v) => { store.set(k, v); },
              delete: async (k) => { store.delete(k); },
            },
          },
          { DB: mockDb }
        );
        await doInstance.ensureRestored();

        // Seed strategy with prior closed cycles & profit (e.g. 100 cycles, 123 USDT profit)
        const engine = (doInstance as any).strategies.get('spot-2exch');
        for (let i = 0; i < 100; i++) {
          engine.closedCycles.push({
            cycleId: `seed_${i}`,
            idempotencyKey: `seed_${i}`,
            strategyId: 'spot-2exch',
            pair: 'BTC/USDT',
            entryTs: 1000 + i * 10,
            exitTs: 1005 + i * 10,
            netPnlUsdt: 1.23,
            grossPnlUsdt: 1.5,
            totalFeesUsdt: 0.27,
            fundingDeltaUsdt: 0,
            notionalUsdt: 1000,
            quantityBase: 0.015,
            entrySeqA: 1,
            entrySeqB: 1,
            exitSeqA: 2,
            exitSeqB: 2,
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
            modelVersion: 'paper-v1.1.0',
            replayObjectKey: `r2://seed_${i}`,
            executionMode: 'PAPER',
          });
        }
        engine.realizedNetPnlUsdt = 123.0;

        const baseTs = 1761840000000;
        // Ingest initial streams
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

        // Simulate a 60-second feed gap (> 15s)
        const gapTs = baseTs + 60000;
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 11,
          exchangeTs: gapTs - 5,
          receivedTs: gapTs,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68005, quantity: 1 }],
        }, gapTs);

        // Fetch DO status
        const statusRes = await doInstance.fetch(new Request('http://internal/status'));
        const status = (await statusRes.json()) as any;
        expect(status.continuousCoverageMs).toBe(0);
        // Lifetime engine snapshot retains 100 cycles
        expect(status.strategies['spot-2exch'].closedCyclesCount).toBe(100);
        expect(status.strategies['spot-2exch'].realizedNetPnlUsdt).toBe(123.0);
        // Window metrics for the new window must be strictly 0
        expect(status.windowMetrics['spot-2exch'].windowClosedCyclesCount).toBe(0);
        expect(status.windowMetrics['spot-2exch'].windowRealizedNetPnlUsdt).toBe(0);

        // Synced run in D1 must reflect window closed cycles = 0, PnL = 0
        const latestRun = syncedRuns[syncedRuns.length - 1];
        expect(latestRun).toBeDefined();
        expect(latestRun.closed_cycles_count).toBe(0);
        expect(latestRun.realized_net_pnl_usdt).toBe(0);
      });

      it('N2: retains and archives full raw ticks for cycles exceeding 500 ticks and across DO restarts', async () => {
        const { PaperTradingDurableObject } = await import('../worker-do');
        const store = new Map<string, unknown>();
        const archivedReplays = new Map<string, any>();

        const mockR2: any = {
          put: async (key: string, data: string) => {
            archivedReplays.set(key, JSON.parse(data));
          },
        };

        const doInstance1 = new PaperTradingDurableObject(
          {
            storage: {
              get: async (k) => store.get(k) as any,
              put: async (k, v) => { store.set(k, v); },
              delete: async (k) => { store.delete(k); },
            },
          },
          { STORAGE: mockR2 }
        );
        await doInstance1.ensureRestored();

        const baseTs = 1761840000000;
        // Open a cycle on spot-2exch: Binance ask 68000, Bybit bid 68150 (spread 22 bps)
        await doInstance1.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs + 1,
          bids: [{ price: 67990, quantity: 2 }],
          asks: [{ price: 68000, quantity: 2 }],
        }, baseTs + 1);

        await doInstance1.ingestOrderbook({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs + 2,
          bids: [{ price: 68150, quantity: 2 }],
          asks: [{ price: 68160, quantity: 2 }],
        }, baseTs + 2);

        const openCycles = (doInstance1 as any).strategies.get('spot-2exch').getOpenCycles();
        expect(openCycles.length).toBe(1);
        const cycleId = openCycles[0].cycleId;

        // Feed 550 intermediate ticks while the cycle remains open (> 500 sessionTicks ring buffer)
        for (let i = 0; i < 550; i++) {
          const t = baseTs + 10 + i * 10;
          await doInstance1.ingestOrderbook({
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 10 + i,
            exchangeTs: t,
            receivedTs: t + 1,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68100, quantity: 1 }],
          }, t + 1);
        }

        // Active cycle ticks ledger in storage must have preserved all ticks
        const activeLedger1 = store.get('active_cycle_ticks_ledger') as any;
        expect(activeLedger1).toBeDefined();
        expect(activeLedger1[cycleId].length).toBeGreaterThan(500);

        // Simulate DO restart / recreation
        const doInstance2 = new PaperTradingDurableObject(
          {
            storage: {
              get: async (k) => store.get(k) as any,
              put: async (k, v) => { store.set(k, v); },
              delete: async (k) => { store.delete(k); },
            },
          },
          { STORAGE: mockR2 }
        );
        await doInstance2.ensureRestored();

        // Feed close condition: Binance bid 68080, Bybit ask 68075 (spread compressed)
        const closeTs = baseTs + 10000;
        await doInstance2.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 2000,
          exchangeTs: closeTs,
          receivedTs: closeTs + 1,
          bids: [{ price: 68080, quantity: 2 }],
          asks: [{ price: 68085, quantity: 2 }],
        }, closeTs + 1);

        await doInstance2.ingestOrderbook({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 2000,
          exchangeTs: closeTs,
          receivedTs: closeTs + 2,
          bids: [{ price: 68070, quantity: 2 }],
          asks: [{ price: 68075, quantity: 2 }],
        }, closeTs + 2);

        const closedCycles = (doInstance2 as any).strategies.get('spot-2exch').getClosedCycles();
        expect(closedCycles.length).toBe(1);

        // Find archived replay in R2
        let replayFound: any = null;
        for (const [k, v] of archivedReplays.entries()) {
          if (k.endsWith('.raw.json')) {
            replayFound = v;
            break;
          }
        }
        expect(replayFound).toBeDefined();
        expect(replayFound.cycleTicks.length).toBeGreaterThan(500);
        const verifyRestarted550 = PaperReplayEngine.replayCycleFromArtifact(replayFound);
        expect(verifyRestarted550.reasons).toEqual([]);
        expect(verifyRestarted550.matched).toBe(true);
      });

      it('N3: rejects synthetic 8h boundary crossing without authentic exchange fundingEventId, and ACKs funding only after commit', async () => {
        const engine = new PaperStrategyEngine({
          strategyId: 'spot-perp',
          initialCapitalUsdt: 10000,
        });
        const sequencer = new OrderbookSequencer();
        const baseTs = 1761840000000; // t = 0

        // Ingest spot & linear perp to open cycle
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs + 5,
          bids: [{ price: 68000, quantity: 2 }],
          asks: [{ price: 68005, quantity: 2 }],
        }, baseTs + 5);

        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs + 5,
          fundingRateBps: 2.0,
          bids: [{ price: 68300, quantity: 2 }],
          asks: [{ price: 68305, quantity: 2 }],
        }, baseTs + 5);

        engine.evaluatePair(sequencer, 'BTC/USDT', 1, baseTs + 10, 'key1');
        const openCycles = engine.getOpenCycles();
        expect(openCycles.length).toBe(1);
        expect(openCycles[0].accruedFundingUsdt).toBe(0);

        // Advance 9 hours past UTC 8h boundary WITHOUT fundingEventId
        const nineHoursLater = baseTs + 9 * 3600 * 1000;
        // Ingest spot book at nineHoursLater so both spot and linear_perp legs stay fresh (< 1000ms maxFeedAge)
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 2,
          exchangeTs: nineHoursLater,
          receivedTs: nineHoursLater + 5,
          bids: [{ price: 68000, quantity: 2 }],
          asks: [{ price: 68005, quantity: 2 }],
        }, nineHoursLater + 5);

        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 2,
          exchangeTs: nineHoursLater,
          receivedTs: nineHoursLater + 5,
          fundingRateBps: 2.0,
          bids: [{ price: 68300, quantity: 2 }],
          asks: [{ price: 68305, quantity: 2 }],
        }, nineHoursLater + 5);

        engine.evaluatePair(sequencer, 'BTC/USDT', 2, nineHoursLater + 10, 'key2');
        // Without authentic fundingEventId, accrual must remain 0 (no synthetic fallback)
        expect(openCycles[0].accruedFundingUsdt).toBe(0);
        expect(engine.getSnapshot().fundingLedger.length).toBe(0);

        // Now provide authentic funding event from exchange
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 3,
          exchangeTs: nineHoursLater + 60,
          receivedTs: nineHoursLater + 65,
          bids: [{ price: 68000, quantity: 2 }],
          asks: [{ price: 68005, quantity: 2 }],
        }, nineHoursLater + 65);

        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 3,
          exchangeTs: nineHoursLater + 60,
          receivedTs: nineHoursLater + 65,
          fundingEventId: 'binance_btc_funding_20261031_0800',
          fundingSettlementTs: nineHoursLater,
          fundingRateBps: 2.0,
          bids: [{ price: 68300, quantity: 2 }],
          asks: [{ price: 68305, quantity: 2 }],
        }, nineHoursLater + 65);

        engine.evaluatePair(sequencer, 'BTC/USDT', 3, nineHoursLater + 70, 'key3');
        // Now funding is legitimately accrued
        expect(openCycles[0].accruedFundingUsdt).toBeGreaterThan(0);
        expect(engine.getSnapshot().fundingLedger.length).toBe(1);
        expect(engine.getSnapshot().fundingLedger[0].eventId).toBe('binance_btc_funding_20261031_0800');

        // Test DO ACK on both normal ingest and resync
        const store = new Map<string, unknown>();
        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => { store.set(k, v); },
            delete: async (k) => { store.delete(k); },
          },
        });
        await doInstance.ensureRestored();

        const ackCalls: string[] = [];
        (doInstance as any).collector = {
          ackFundingSettlement: (streamKey: string, eventId: string) => {
            ackCalls.push(`${streamKey}:${eventId}`);
          },
        };

        // Ingest normal book with fundingEventId
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 4,
          exchangeTs: nineHoursLater + 100,
          receivedTs: nineHoursLater + 105,
          fundingEventId: 'binance_btc_funding_evt_1',
          bids: [{ price: 68150, quantity: 1 }],
          asks: [{ price: 68155, quantity: 1 }],
        }, nineHoursLater + 105);

        expect(ackCalls).toContain('binance:linear_perp:BTC/USDT:binance_btc_funding_evt_1');

        // Resync book with fundingEventId
        await doInstance.resyncStream({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 10,
          exchangeTs: nineHoursLater + 200,
          receivedTs: nineHoursLater + 205,
          isDelta: false,
          fundingEventId: 'binance_btc_funding_evt_resync',
          bids: [{ price: 68150, quantity: 1 }],
          asks: [{ price: 68155, quantity: 1 }],
        }, nineHoursLater + 205);

        expect(ackCalls).toContain('binance:linear_perp:BTC/USDT:binance_btc_funding_evt_resync');
      });

      it('N1 Acceptance: Carry-over position (+100 USDT profit pre-reset) closed post-reset at same price yields 0 window P&L and is excluded from 100 qualifying cycles', async () => {
        const store = new Map<string, unknown>();
        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => { store.set(k, v); },
            delete: async (k) => { store.delete(k); },
          },
        });
        await doInstance.ensureRestored();

        const baseTs = 1730000000000;
        const engines = (doInstance as any).strategies as Map<string, PaperStrategyEngine>;
        const spot2Engine = engines.get('spot-2exch')!;

        // 1. Manually inject a pre-reset open cycle with ~100 USDT unrealized profit
        // Bought Leg A at 10000, Sold Leg B at 11000.
        // Current market has Leg B converging to 10000 (meaning buying back Leg B yields +100 USDT gross profit).
        // Entry fee = 1.0, exit fee at 10000/10000 is 1.0 (5 bps per leg) -> total fee = 2.0. Net unrealized profit = 98.0 USDT.
        const preResetOpenCycle = {
          cycleId: 'pre_reset_cycle_1',
          strategyId: 'spot-2exch' as const,
          pair: 'BTC/USDT' as const,
          entryTs: baseTs - 50000,
          entrySeqA: 1,
          entrySeqB: 1,
          notionalUsdt: 1000,
          quantityBase: 0.1,
          legAExchange: 'binance' as const,
          legAMarket: 'spot' as const,
          legBExchange: 'bybit' as const,
          legBMarket: 'spot' as const,
          entryLegAPrice: 10000,
          entryLegBPrice: 11000, // bought at 10000, sold at 11000
          entrySpreadBps: 1000,
          entryFeesUsdt: 1.0,
          accruedFundingUsdt: 0,
          lastUnrealizedPnlUsdt: 98.0,
        };
        (spot2Engine as any).openCycles.set('pre_reset_cycle_1', preResetOpenCycle);
        spot2Engine.getSnapshot().cashBalanceUsdt = 10000;
        spot2Engine.getSnapshot().equityUsdt = 10098; // baseline includes the +98 unrealized profit

        // 2. Trigger window reset (>15s feed gap)
        await (doInstance as any).resetContinuousWindow(baseTs);

        // Verify cycle is marked carryOver with baseline mark of 98 USDT
        const carryCycle = spot2Engine.getOpenCycles().find((c) => c.cycleId === 'pre_reset_cycle_1');
        expect(carryCycle).toBeDefined();
        expect(carryCycle!.isCarryOver).toBe(true);
        expect(carryCycle!.baselineUnrealizedPnlUsdt).toBe(98.0);

        // 3. Close the cycle post-reset at the EXACT SAME mark prices (legA: 10000, legB: 10000)
        // (no new profit formed post-reset)
        const closed = (spot2Engine as any).closeOpenCycle(
          carryCycle,
          10000, // exitLegAPrice
          10000, // exitLegBPrice (bought back at 10000 -> +100 gross, -2.0 total fees = 98.0 net)
          100,
          100,
          baseTs + 5000,
          0,
          'replay_test'
        );

        expect(closed.isCarryOver).toBe(true);
        expect(closed.netPnlUsdt).toBe(98.0);
        // Lifetime net P&L was 98 USDT, but window attributable P&L formed POST-baseline is 0!
        expect(closed.windowAttributableNetPnlUsdt).toBe(0);

        // 4. Ingest an orderbook tick to trigger status/D1 calculation
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 101,
          exchangeTs: baseTs + 6000,
          receivedTs: baseTs + 6005,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        }, baseTs + 6005);

        // 5. Query status endpoint and verify window metrics
        const res = await doInstance.fetch(new Request('http://localhost/status'));
        const body = (await res.json()) as any;
        const spotMetrics = body.windowMetrics['spot-2exch'];

        // Must NOT count the carry-over cycle in window qualifying cycles
        expect(spotMetrics.windowClosedCyclesCount).toBe(0);
        // Must NOT receive the +100 USDT pre-reset profit in window P&L!
        expect(spotMetrics.windowRealizedNetPnlUsdt).toBeLessThanOrEqual(0.0);
      });

      it('N2 Acceptance: Independent PaperReplayEngine reconstructs cycle >550 ticks solely from artifact', async () => {
        const baseTs = 1730000000000;
        const initialLegA: NormalizedOrderbook = {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs,
          bids: [{ price: 67900, quantity: 2 }],
          asks: [{ price: 68000, quantity: 2 }],
        };
        const initialLegB: NormalizedOrderbook = {
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs,
          bids: [{ price: 68200, quantity: 2 }],
          asks: [{ price: 68300, quantity: 2 }],
        };

        const cycleTicks: Array<{ tickIndex: number; nowTs: number; book: NormalizedOrderbook }> = [];
        // Generate >550 ticks across the cycle life
        for (let i = 1; i <= 560; i++) {
          const tTs = baseTs + i * 100;
          // Every tick alternates updating binance and bybit
          const isBinance = i % 2 === 1;
          const book: NormalizedOrderbook = {
            exchange: isBinance ? 'binance' : 'bybit',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: i + 1,
            exchangeTs: tTs,
            receivedTs: tTs,
            bids: [{ price: isBinance ? 67900 + (i * 0.1) : 68200 - (i * 0.1), quantity: 2 }],
            asks: [{ price: isBinance ? 68000 + (i * 0.1) : 68300 - (i * 0.1), quantity: 2 }],
          };
          cycleTicks.push({
            tickIndex: i,
            nowTs: tTs,
            book,
          });
        }

        const mockClosedCycle: PaperClosedCycle = {
          cycleId: 'cycle_test_replay_550',
          idempotencyKey: 'idemp_550',
          strategyId: 'spot-2exch',
          pair: 'BTC/USDT',
          entryTs: baseTs + 100,
          exitTs: baseTs + 56000,
          entrySeqA: 1,
          entrySeqB: 1,
          exitSeqA: 559,
          exitSeqB: 560,
          notionalUsdt: 1000,
          quantityBase: 0.0147,
          legAExchange: 'binance',
          legAMarket: 'spot',
          legBExchange: 'bybit',
          legBMarket: 'spot',
          entryLegAPrice: 68000,
          entryLegBPrice: 68200,
          exitLegAPrice: 68050,
          exitLegBPrice: 68150,
          rawSpreadBps: 29.41,
          netSpreadBps: 5.41,
          grossPnlUsdt: 2.94,
          totalFeesUsdt: 2.4,
          fundingDeltaUsdt: 0,
          netPnlUsdt: 0.54,
          modelVersion: 'paper-v1.0.0',
          replayObjectKey: 'binance/BTC/USDT/test-550',
          executionMode: 'PAPER',
        };

        const artifact: PaperCycleArtifact = {
          cycle: mockClosedCycle,
          modelVersion: 'paper-v1.0.0',
          initialBooks: {
            legA: initialLegA,
            legB: initialLegB,
          },
          triggerBook: cycleTicks[0].book,
          decision: {
            tickIndex: 1,
            timestamp: baseTs + 100,
            strategyId: 'spot-2exch',
            pair: 'BTC/USDT',
            decision: 'OPEN_CYCLE',
            rawSpreadBps: 29.41,
            estimatedNetSpreadBps: 5.41,
            reason: 'Test cycle',
          },
          cycleTicks,
          decisions: [],
          fundingLedger: [],
          sequencerStates: [],
        };

        // Replay cycle independently solely from artifact
        const verification = PaperReplayEngine.replayCycleFromArtifact(artifact);
        expect(verification.cycleId).toBe('cycle_test_replay_550');
        expect(verification.decisionsCount).toBe(560);
      });

      it('N2 Rigorous: Independent replay verifies matched=true, decision/fill/funding equality and rejects mutated/corrupted artifact', async () => {
        // Run full cycle via DO using canonical ticks to produce a genuine runtime artifact
        const store = new Map<string, unknown>();
        const savedArtifacts = new Map<string, any>();
        const mockStorage: any = {
          put: async (k: string, v: string) => {
            savedArtifacts.set(k, JSON.parse(v));
          },
        };

        const doInstance = new PaperTradingDurableObject(
          {
            storage: {
              get: async (k) => store.get(k) as any,
              put: async (k, v) => { store.set(k, v); },
              delete: async (k) => { store.delete(k); },
            },
          },
          { STORAGE: mockStorage } as any
        );
        await doInstance.ensureRestored();

        // Feed first 10 canonical ticks (ticks 1..10 form 1 full open-hold-close cycle)
        const ticks = buildCanonical50TickSequence().slice(0, 10);
        for (const tick of ticks) {
          for (const b of tick.books) {
            await doInstance.ingestOrderbook(b, tick.nowTs);
          }
        }

        // Check closed cycles on DO
        const closed = doInstance.journal.getClosedCycles();
        expect(closed.length).toBeGreaterThanOrEqual(1);
        const cycle = closed[0];

        // Retrieve actual artifact persisted to STORAGE
        const objectPath = `${cycle.replayObjectKey}.raw.json`.replace(/^r2:\/\/[^/]+\//, '');
        const runtimeArtifact = savedArtifacts.get(objectPath);
        expect(runtimeArtifact).toBeDefined();
        expect(runtimeArtifact.cycle.cycleId).toBe(cycle.cycleId);

        // Independent replay verification from runtime artifact
        const verification = PaperReplayEngine.replayCycleFromArtifact(runtimeArtifact);
        expect(verification.matched).toBe(true);
        expect(verification.pnlDifferenceUsdt).toBeLessThanOrEqual(0.0001);
        expect(verification.fillsCount).toBeGreaterThanOrEqual(2);
        expect(verification.reasons).toEqual([]);
        expect(runtimeArtifact.engineConfig).toBeDefined();
        expect(runtimeArtifact.initialStrategyState).toBeDefined();
        expect(runtimeArtifact.finalSnapshot).toBeDefined();
        expect(runtimeArtifact.decisions.length).toBe(verification.decisionsCount);

        // Mutation Test 1: Corrupted/altered cycle P&L in artifact must be rejected
        const tamperedArtifact = JSON.parse(JSON.stringify(runtimeArtifact));
        tamperedArtifact.cycle.netPnlUsdt += 10.0; // Fabricate extra profit
        const tamperedVerification = PaperReplayEngine.replayCycleFromArtifact(tamperedArtifact);
        expect(tamperedVerification.matched).toBe(false);
        expect(tamperedVerification.reasons.some((r: string) => r.includes('P&L mismatch'))).toBe(true);

        // Mutation Test 2: Missing tick in cycleTicks preventing close must fail
        const missingTicksArtifact = JSON.parse(JSON.stringify(runtimeArtifact));
        missingTicksArtifact.cycleTicks.pop(); // Remove exit tick
        const missingVerification = PaperReplayEngine.replayCycleFromArtifact(missingTicksArtifact);
        expect(missingVerification.matched).toBe(false);

        // Mutation Test 3: Altered funding ledger must be caught
        const tamperedFundingArtifact = JSON.parse(JSON.stringify(runtimeArtifact));
        tamperedFundingArtifact.fundingLedger = [
          {
            eventId: 'fake_funding_event',
            exchange: 'binance',
            pair: 'BTC/USDT',
            settlementTs: 1761840000000 + 1000,
            fundingRateBps: 2.0,
            notionalUsdt: 1000,
            fundingDeltaUsdt: 0.2,
          },
        ];
        const tamperedFundingVerification = PaperReplayEngine.replayCycleFromArtifact(tamperedFundingArtifact);
        expect(tamperedFundingVerification.matched).toBe(false);
        expect(tamperedFundingVerification.reasons.some((r: string) => r.includes('Funding ledger'))).toBe(true);

        // Mutation Test 4 (Strict N2): Alter a single intermediate decision OR fill price/quantity while keeping netPnlUsdt identical -> replay MUST reject
        const decisionMutatedArtifact = JSON.parse(JSON.stringify(runtimeArtifact));
        // Keep netPnlUsdt identical, but mutate an intermediate decision in artifact.decisions
        const holdDecisionIdx = decisionMutatedArtifact.decisions.findIndex(
          (d: any) => d.decision !== 'OPEN_CYCLE' && d.decision !== 'CLOSE_CYCLE'
        );
        if (holdDecisionIdx >= 0) {
          decisionMutatedArtifact.decisions[holdDecisionIdx].decision = 'NO_TRADE';
          decisionMutatedArtifact.decisions[holdDecisionIdx].rawSpreadBps += 5.0;
        } else {
          decisionMutatedArtifact.decisions[0].rawSpreadBps += 5.0;
        }
        const decisionMutatedVerif = PaperReplayEngine.replayCycleFromArtifact(decisionMutatedArtifact);
        expect(decisionMutatedVerif.pnlDifferenceUsdt).toBe(0);
        expect(decisionMutatedVerif.matched).toBe(false);
        expect(decisionMutatedVerif.reasons.some((r: string) => r.includes('Decision mismatch'))).toBe(true);

        // Mutation Test 5 (Strict N2): Shift entry & exit fill prices by the exact same offset (+50 USDT) or alter quantityBase while keeping netPnlUsdt identical -> replay MUST reject
        const fillMutatedArtifact = JSON.parse(JSON.stringify(runtimeArtifact));
        fillMutatedArtifact.cycle.entryLegAPrice += 50;
        fillMutatedArtifact.cycle.exitLegAPrice += 50;
        fillMutatedArtifact.cycle.quantityBase += 0.0025;
        // netPnlUsdt is left untouched!
        const fillMutatedVerif = PaperReplayEngine.replayCycleFromArtifact(fillMutatedArtifact);
        expect(fillMutatedVerif.pnlDifferenceUsdt).toBe(0);
        expect(fillMutatedVerif.matched).toBe(false);
        expect(
          fillMutatedVerif.reasons.some((r: string) => r.includes('Entry LegA price mismatch'))
        ).toBe(true);
        expect(
          fillMutatedVerif.reasons.some((r: string) => r.includes('Exit LegA price mismatch'))
        ).toBe(true);
        expect(
          fillMutatedVerif.reasons.some((r: string) => r.includes('Quantity base mismatch'))
        ).toBe(true);

        // Mutation Test 6 (Strict N2): Tamper finalSnapshot equity while keeping cycle netPnlUsdt identical -> replay MUST reject
        const snapshotMutatedArtifact = JSON.parse(JSON.stringify(runtimeArtifact));
        snapshotMutatedArtifact.finalSnapshot.equityUsdt += 25.0;
        const snapshotMutatedVerif = PaperReplayEngine.replayCycleFromArtifact(snapshotMutatedArtifact);
        expect(snapshotMutatedVerif.pnlDifferenceUsdt).toBe(0);
        expect(snapshotMutatedVerif.matched).toBe(false);
        expect(
          snapshotMutatedVerif.reasons.some((r: string) => r.includes('Final snapshot equityUsdt mismatch'))
        ).toBe(true);
      });

      it('N3 Acceptance: Synced perp stream with missing spot counterpart yields HALTED_DESYNC, does NOT ACK, and retries once on recovery', async () => {
        const store = new Map<string, unknown>();
        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => { store.set(k, v); },
            delete: async (k) => { store.delete(k); },
          },
        });
        await doInstance.ensureRestored();

        const ackCalls: string[] = [];
        (doInstance as any).collector = {
          ackFundingSettlement: (streamKey: string, eventId: string) => {
            ackCalls.push(`${streamKey}:${eventId}`);
          },
        };

        const perpEngine = ((doInstance as any).strategies as Map<string, PaperStrategyEngine>).get('spot-perp')!;
        const baseTs = 1730000000000;

        // Manually place an open spot-perp position on binance
        (perpEngine as any).openCycles.set('BTC/USDT', {
          cycleId: 'cycle_active_perp_1',
          strategyId: 'spot-perp',
          pair: 'BTC/USDT',
          entryTs: baseTs,
          entrySeqA: 1,
          entrySeqB: 1,
          notionalUsdt: 1000,
          quantityBase: 0.0147,
          legAExchange: 'binance',
          legAMarket: 'spot',
          legBExchange: 'binance',
          legBMarket: 'linear_perp',
          entryLegAPrice: 68000,
          entryLegBPrice: 68100,
          entrySpreadBps: 14.7,
          entryFeesUsdt: 2.4,
          accruedFundingUsdt: 0,
          appliedFundingEventIds: [],
        });

        // Scenario: Binance linear_perp stream is incoming and SYNCED, but spot counterpart has NOT arrived (missing)
        const perpBookSynced: NormalizedOrderbook = {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 1,
          exchangeTs: baseTs + 1000,
          receivedTs: baseTs + 1005,
          fundingEventId: 'funding_evt_missing_spot_1',
          fundingSettlementTs: baseTs + 1000,
          fundingRateBps: 1.5,
          bids: [{ price: 68100, quantity: 1 }],
          asks: [{ price: 68110, quantity: 1 }],
        };

        // Ingest the perp book. Note: DO NOT ingest binance spot book yet.
        const ingestRes = await doInstance.ingestOrderbook(perpBookSynced, baseTs + 1005);
        // The perp stream itself is SYNCED
        expect(ingestRes.streamState.status).toBe('SYNCED');

        // But perp strategy evaluated pair yields HALTED_DESYNC because spot counterpart is missing
        const lastDec = perpEngine.getDecisions().find((d) => d.decision === 'HALTED_DESYNC');
        expect(lastDec).toBeDefined();

        // Critical N3: Funding ledger must be 0, and collector MUST NOT be ACKed!
        expect(perpEngine.getSnapshot().fundingLedger.length).toBe(0);
        expect(ackCalls).not.toContain('binance:linear_perp:BTC/USDT:funding_evt_missing_spot_1');

        // Disposition persisted in DO storage must be 'retry'
        const savedDisp = store.get('funding_disp_funding_evt_missing_spot_1') as any;
        expect(savedDisp).toBeDefined();
        expect(savedDisp.disposition).toBe('retry');

        // Recovery: Ingest the missing spot counterpart book
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 1,
          exchangeTs: baseTs + 1010,
          receivedTs: baseTs + 1010,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        }, baseTs + 1010);

        // Collector retries the unacknowledged event
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 2,
          exchangeTs: baseTs + 1020,
          receivedTs: baseTs + 1020,
          fundingEventId: 'funding_evt_missing_spot_1',
          fundingSettlementTs: baseTs + 1000,
          fundingRateBps: 1.5,
          bids: [{ price: 68100, quantity: 1 }],
          asks: [{ price: 68110, quantity: 1 }],
        }, baseTs + 1020);

        // Now pair is synced -> funding applied exactly once and ACKed!
        expect(perpEngine.getSnapshot().fundingLedger.length).toBe(1);
        expect(perpEngine.getSnapshot().fundingLedger[0].eventId).toBe('funding_evt_missing_spot_1');
        expect(ackCalls).toContain('binance:linear_perp:BTC/USDT:funding_evt_missing_spot_1');

        // And duplicate arrival does not apply funding again
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 3,
          exchangeTs: baseTs + 1030,
          receivedTs: baseTs + 1030,
          fundingEventId: 'funding_evt_missing_spot_1',
          fundingSettlementTs: baseTs + 1000,
          fundingRateBps: 1.5,
          bids: [{ price: 68100, quantity: 1 }],
          asks: [{ price: 68110, quantity: 1 }],
        }, baseTs + 1030);

        expect(perpEngine.getSnapshot().fundingLedger.length).toBe(1);
      });

      it('N3 Acceptance: HALTED_DESYNC suppresses ACK; event retried and applied once on resync; post-settlement open receives no funding', async () => {
        const store = new Map<string, unknown>();
        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => { store.set(k, v); },
            delete: async (k) => { store.delete(k); },
          },
        });
        await doInstance.ensureRestored();

        const ackCalls: string[] = [];
        (doInstance as any).collector = {
          ackFundingSettlement: (streamKey: string, eventId: string) => {
            ackCalls.push(`${streamKey}:${eventId}`);
          },
        };

        const baseTs = 1730000000000;

        // 1. Ingest normal initial spot book so sequencer has stream state
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 1,
          exchangeTs: baseTs,
          receivedTs: baseTs,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        }, baseTs);

        // 2. Ingest out-of-order sequence (e.g. sequence 10 with prevSequenceId 5 -> gap -> FEED_DESYNC)
        const desyncBook: NormalizedOrderbook = {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 10,
          prevSequenceId: 5,
          exchangeTs: baseTs + 500,
          receivedTs: baseTs + 505,
          fundingEventId: 'gap_funding_event_1',
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        };

        const ingestRes = await doInstance.ingestOrderbook(desyncBook, baseTs + 505);
        expect(ingestRes.streamState.status).toBe('FEED_DESYNC');
        // Critical N3: ACK must NOT be called on FEED_DESYNC / HALTED_DESYNC!
        expect(ackCalls).not.toContain('binance:linear_perp:BTC/USDT:gap_funding_event_1');

        // 3. Resync stream with snapshot book containing the event -> status becomes SYNCED
        const resyncBook: NormalizedOrderbook = {
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 10,
          exchangeTs: baseTs + 1000,
          receivedTs: baseTs + 1005,
          isDelta: false,
          fundingEventId: 'gap_funding_event_1',
          fundingSettlementTs: baseTs + 800,
          fundingRateBps: 1.5,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        };

        const resyncRes = await doInstance.resyncStream(resyncBook, baseTs + 1005);
        expect(resyncRes.status).toBe('SYNCED');
        // Critical N3: Now on resync SYNCED, ACK is triggered!
        expect(ackCalls).toContain('binance:linear_perp:BTC/USDT:gap_funding_event_1');

        // 4. Post-settlement open eligibility test:
        // Position opened at baseTs + 900 (AFTER settlement at baseTs + 800) must receive zero funding
        const perpEngine = ((doInstance as any).strategies as Map<string, PaperStrategyEngine>).get('spot-perp')!;
        (perpEngine as any).openCycles.set('post_settlement_cycle', {
          cycleId: 'post_settlement_cycle',
          strategyId: 'spot-perp',
          pair: 'BTC/USDT',
          entryTs: baseTs + 900, // > settlementTs (baseTs + 800)
          entrySeqA: 1,
          entrySeqB: 1,
          notionalUsdt: 1000,
          quantityBase: 0.1,
          legAExchange: 'binance',
          legAMarket: 'spot',
          legBExchange: 'binance',
          legBMarket: 'linear_perp',
          entryLegAPrice: 68000,
          entryLegBPrice: 68000,
          entrySpreadBps: 0,
          entryFeesUsdt: 1.0,
          accruedFundingUsdt: 0,
          appliedFundingEventIds: [],
        });

        // Ingest another book with the old settlement event
        await doInstance.ingestOrderbook({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 11,
          exchangeTs: baseTs + 1100,
          receivedTs: baseTs + 1105,
          fundingEventId: 'gap_funding_event_1',
          fundingSettlementTs: baseTs + 800,
          fundingRateBps: 1.5,
          bids: [{ price: 68000, quantity: 1 }],
          asks: [{ price: 68010, quantity: 1 }],
        }, baseTs + 1105);

        const postPos = perpEngine.getOpenCycles().find((c) => c.cycleId === 'post_settlement_cycle');
        expect(postPos).toBeDefined();
        // Accrued funding must remain 0 because entryTs (baseTs + 900) > settlementTs (baseTs + 800)
        expect(postPos!.accruedFundingUsdt).toBe(0);
      });

      it('N3 Acceptance: Bybit funding event does not apply to an open Binance position (venue/market isolation)', () => {
        const engine = new PaperStrategyEngine({ strategyId: 'spot-perp' });
        const sequencer = new OrderbookSequencer();
        const baseTs = 1730000000000;

        (engine as any).openCycles.set('BTC/USDT', {
          cycleId: 'cycle_binance_perp',
          strategyId: 'spot-perp',
          pair: 'BTC/USDT',
          entryTs: baseTs,
          entrySeqA: 1,
          entrySeqB: 1,
          notionalUsdt: 1000,
          quantityBase: 0.0147,
          legAExchange: 'binance',
          legAMarket: 'spot',
          legBExchange: 'binance',
          legBMarket: 'linear_perp',
          entryLegAPrice: 68000,
          entryLegBPrice: 68100,
          entrySpreadBps: 14.7,
          entryFeesUsdt: 2.4,
          accruedFundingUsdt: 0,
          appliedFundingEventIds: [],
        });

        // Foreign-venue Bybit linear_perp book carrying a funding settlement event
        const foreignVenueBook: NormalizedOrderbook = {
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: 1,
          exchangeTs: baseTs + 100,
          receivedTs: baseTs + 105,
          fundingEventId: 'bybit_funding_evt_1',
          fundingSettlementTs: baseTs + 100,
          fundingRateBps: 3.0,
          bids: [{ price: 68100, quantity: 1 }],
          asks: [{ price: 68110, quantity: 1 }],
        };

        const result = engine.processFundingSettlementEvent(sequencer, foreignVenueBook, baseTs + 105);

        expect(result.disposition).toBe('not-applicable');
        expect(engine.getSnapshot().fundingLedger.length).toBe(0);
        expect(engine.getSnapshot().totalFundingUsdt).toBe(0);
        const pos = engine.getOpenCycles().find((c) => c.cycleId === 'cycle_binance_perp')!;
        expect(pos.accruedFundingUsdt).toBe(0);
        expect(pos.appliedFundingEventIds ?? []).not.toContain('bybit_funding_evt_1');

        // Same constraint at the DO layer: ACK must not fire for a non-applicable foreign position
        const store = new Map<string, unknown>();
        return (async () => {
          const doInstance = new PaperTradingDurableObject({
            storage: {
              get: async (k) => store.get(k) as any,
              put: async (k, v) => { store.set(k, v); },
              delete: async (k) => { store.delete(k); },
            },
          });
          await doInstance.ensureRestored();

          const ackCalls: string[] = [];
          (doInstance as any).collector = {
            ackFundingSettlement: (streamKey: string, eventId: string) => {
              ackCalls.push(`${streamKey}:${eventId}`);
            },
          };

          const doEngine = ((doInstance as any).strategies as Map<string, PaperStrategyEngine>).get('spot-perp')!;
          (doEngine as any).openCycles.set('BTC/USDT', {
            cycleId: 'cycle_binance_perp',
            strategyId: 'spot-perp',
            pair: 'BTC/USDT',
            entryTs: baseTs,
            entrySeqA: 1,
            entrySeqB: 1,
            notionalUsdt: 1000,
            quantityBase: 0.0147,
            legAExchange: 'binance',
            legAMarket: 'spot',
            legBExchange: 'binance',
            legBMarket: 'linear_perp',
            entryLegAPrice: 68000,
            entryLegBPrice: 68100,
            entrySpreadBps: 14.7,
            entryFeesUsdt: 2.4,
            accruedFundingUsdt: 0,
            appliedFundingEventIds: [],
          });

          const res = await doInstance.ingestOrderbook(foreignVenueBook, baseTs + 105);
          expect(doEngine.getSnapshot().fundingLedger.length).toBe(0);
          expect(doEngine.getSnapshot().totalFundingUsdt).toBe(0);
          const doDisp = store.get('funding_disp_bybit_funding_evt_1') as any;
          expect(doDisp).toBeDefined();
          expect(doDisp.disposition).toBe('not-applicable');
          expect(doDisp.reason).toContain('does not match open position perp leg');
          expect(res.snapshots['spot-perp'].fundingLedger?.length ?? 0).toBe(0);
          // Collector is ACKed once disposition 'not-applicable' is durably persisted so it does not loop forever
          expect(ackCalls).toContain('bybit:linear_perp:BTC/USDT:bybit_funding_evt_1');
        })();
      });

      it('N3 Acceptance: crash at any boundary between apply funding, save strategy state, save disposition, and ACK recovers exactly once', async () => {
        const baseTs = 1730000000000;
        const fundingEventId = 'crash_boundary_evt_1';

        /**
         * Build a fresh DO + engine over `store`. If `store` does not yet have a
         * persisted `strategy_state_spot-perp`, seed the open Binance spot-perp
         * position; if it does have persisted state (post-crash restart), keep the
         * restored state from `ensureRestored()`.
         */
        const buildDo = async (
          store: Map<string, unknown>,
          ackCalls: string[],
          failures: { stateWrite?: boolean; dispWrite?: boolean } = {}
        ) => {
          const hadSavedStrategyState = store.has('strategy_state_spot-perp');
          let allowStateWriteFailure = false;
          const doInstance = new PaperTradingDurableObject({
            storage: {
              get: async (k: string) => store.get(k),
              put: async (k: string, v: unknown) => {
                if (allowStateWriteFailure && failures.stateWrite && k === 'strategy_state_spot-perp') {
                  throw new Error('Simulated persistence failure on strategy_state_spot-perp');
                }
                if (failures.dispWrite && k === `funding_disp_${fundingEventId}`) {
                  throw new Error(`Simulated persistence failure on funding_disp_${fundingEventId}`);
                }
                store.set(k, v);
              },
              delete: async (k: string) => {
                store.delete(k);
              },
            },
          });
          await doInstance.ensureRestored();

          (doInstance as any).collector = {
            ackFundingSettlement: (streamKey: string, eventId: string) => {
              ackCalls.push(`${streamKey}:${eventId}`);
            },
          };

          const perpEngine = ((doInstance as any).strategies as Map<string, PaperStrategyEngine>).get('spot-perp')!;
          if (!hadSavedStrategyState) {
            (perpEngine as any).openCycles.set('BTC/USDT', {
              cycleId: 'cycle_crash_1',
              strategyId: 'spot-perp',
              pair: 'BTC/USDT',
              entryTs: baseTs,
              entrySeqA: 1,
              entrySeqB: 1,
              notionalUsdt: 1000,
              quantityBase: 0.0147,
              legAExchange: 'binance',
              legAMarket: 'spot',
              legBExchange: 'binance',
              legBMarket: 'linear_perp',
              entryLegAPrice: 68000,
              entryLegBPrice: 68100,
              entrySpreadBps: 14.7,
              entryFeesUsdt: 2.4,
              accruedFundingUsdt: 0,
              appliedFundingEventIds: [],
            });
          }
          return {
            doInstance,
            perpEngine,
            enableStateWriteFault: () => {
              allowStateWriteFailure = true;
            },
          };
        };

        const makeFundingBook = (seq: number, ts: number): NormalizedOrderbook => ({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'linear_perp',
          sequenceId: seq,
          exchangeTs: ts,
          receivedTs: ts,
          fundingEventId,
          fundingSettlementTs: baseTs,
          fundingRateBps: 1.5,
          bids: [{ price: 68100, quantity: 1 }],
          asks: [{ price: 68110, quantity: 1 }],
        });

        // Baseline: both legs synced so funding is applicable and ACK fires once
        const baselineStore = new Map<string, unknown>();
        const baselineAcks: string[] = [];
        const baseline = await buildDo(baselineStore, baselineAcks);
        await baseline.doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 1,
            exchangeTs: baseTs + 10,
            receivedTs: baseTs + 10,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68010, quantity: 1 }],
          },
          baseTs + 10
        );
        await baseline.doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'linear_perp',
            sequenceId: 1,
            exchangeTs: baseTs + 10,
            receivedTs: baseTs + 10,
            bids: [{ price: 68100, quantity: 1 }],
            asks: [{ price: 68110, quantity: 1 }],
          },
          baseTs + 10
        );
        await baseline.doInstance.ingestOrderbook(makeFundingBook(2, baseTs + 20), baseTs + 20);
        expect(baseline.perpEngine.getSnapshot().fundingLedger.length).toBe(1);
        expect(baselineAcks.filter((a) => a.endsWith(fundingEventId)).length).toBe(1);
        const appliedDelta = baseline.perpEngine.getSnapshot().fundingLedger[0].fundingDeltaUsdt;

        // Crash point A: state write succeeds, disposition write fails -> no ACK, event must be re-applied exactly once on retry
        const storeA = new Map<string, unknown>();
        const acksA: string[] = [];
        const crashA = await buildDo(storeA, acksA, { dispWrite: true });
        await crashA.doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 1,
            exchangeTs: baseTs + 10,
            receivedTs: baseTs + 10,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68010, quantity: 1 }],
          },
          baseTs + 10
        );
        await crashA.doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'linear_perp',
            sequenceId: 1,
            exchangeTs: baseTs + 10,
            receivedTs: baseTs + 10,
            bids: [{ price: 68100, quantity: 1 }],
            asks: [{ price: 68110, quantity: 1 }],
          },
          baseTs + 10
        );
        await crashA.doInstance.ingestOrderbook(makeFundingBook(2, baseTs + 20), baseTs + 20);
        // The funding was applied in-memory, but ACK must be suppressed because disposition persistence failed
        expect(crashA.perpEngine.getSnapshot().fundingLedger.length).toBe(1);
        expect(acksA.filter((a) => a.endsWith(fundingEventId)).length).toBe(0);
        expect(storeA.get(`funding_disp_${fundingEventId}`)).toBeUndefined();
        // Engine state was durably written -> retry must NOT double-count funding
        const serializedA = storeA.get('strategy_state_spot-perp') as any;
        expect(serializedA).toBeDefined();

        // Restart DO from the crashed storage, retry the same funding event: exactly-once funding before ACK
        const restartStoreA = new Map<string, unknown>(storeA);
        const acksRestartA: string[] = [];
        const restartA = await buildDo(restartStoreA, acksRestartA);
        expect(restartA.perpEngine.getSnapshot().fundingLedger.length).toBe(1);
        await restartA.doInstance.ingestOrderbook(makeFundingBook(3, baseTs + 30), baseTs + 30);
        expect(restartA.perpEngine.getSnapshot().fundingLedger.length).toBe(1);
        expect(restartA.perpEngine.getSnapshot().fundingLedger[0].eventId).toBe(fundingEventId);
        expect(restartA.perpEngine.getSnapshot().fundingLedger[0].fundingDeltaUsdt).toBeCloseTo(
          appliedDelta,
          4
        );
        expect(acksRestartA.filter((a) => a.endsWith(fundingEventId)).length).toBe(1);
        const restartDispA = restartStoreA.get(`funding_disp_${fundingEventId}`) as any;
        expect(restartDispA).toBeDefined();
        expect(restartDispA.disposition).toBe('applied');
        expect(restartDispA.appliedDeltaUsdt).toBeCloseTo(appliedDelta, 4);

        // Crash point B: strategy state write fails -> nothing applied durably, no ACK; restart replays funding exactly once
        const storeB = new Map<string, unknown>();
        const acksB: string[] = [];
        const crashB = await buildDo(storeB, acksB, { stateWrite: true });
        await crashB.doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 1,
            exchangeTs: baseTs + 10,
            receivedTs: baseTs + 10,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68010, quantity: 1 }],
          },
          baseTs + 10
        );
        await crashB.doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'linear_perp',
            sequenceId: 1,
            exchangeTs: baseTs + 10,
            receivedTs: baseTs + 10,
            bids: [{ price: 68100, quantity: 1 }],
            asks: [{ price: 68110, quantity: 1 }],
          },
          baseTs + 10
        );
        crashB.enableStateWriteFault();
        await crashB.doInstance.ingestOrderbook(makeFundingBook(2, baseTs + 20), baseTs + 20);
        // Persistence failure must suppress ACK entirely
        expect(acksB.filter((a) => a.endsWith(fundingEventId)).length).toBe(0);
        expect(storeB.get(`funding_disp_${fundingEventId}`)).toBeUndefined();

        // Restart from storeB (which has pre-funding state before the faulted state write)
        const storeBRestart = new Map<string, unknown>(storeB);
        const acksBRestart: string[] = [];
        const restartB = await buildDo(storeBRestart, acksBRestart);
        // Pre-funding state restored: fundingLedger is 0 prior to collector retry
        expect(restartB.perpEngine.getSnapshot().fundingLedger.length).toBe(0);
        await restartB.doInstance.ingestOrderbook(makeFundingBook(3, baseTs + 30), baseTs + 30);
        expect(restartB.perpEngine.getSnapshot().fundingLedger.length).toBe(1);
        expect(restartB.perpEngine.getSnapshot().fundingLedger[0].fundingDeltaUsdt).toBeCloseTo(
          appliedDelta,
          4
        );
        expect(acksBRestart.filter((a) => a.endsWith(fundingEventId)).length).toBe(1);
        const restartDispB = storeBRestart.get(`funding_disp_${fundingEventId}`) as any;
        expect(restartDispB).toBeDefined();
        expect(restartDispB.disposition).toBe('applied');
      });

      it('N1/N2/N3 Code-Review Regressions: baseline provenance re-anchors on live recovery, deactivatePriorRuns uses schema-valid SQL, and resync stale stream suppresses ACK', async () => {
        const store = new Map<string, unknown>();
        const executedQueries: Array<{ sql: string; args: any[] }> = [];
        const mockDb: any = {
          prepare: (sql: string) => ({
            bind: (...args: any[]) => ({
              run: async () => {
                executedQueries.push({ sql, args });
                return { success: true };
              },
              all: async () => [],
            }),
            all: async () => [],
          }),
        };

        const doInstance = new PaperTradingDurableObject(
          {
            storage: {
              get: async (k) => store.get(k) as any,
              put: async (k, v) => {
                store.set(k, v);
              },
              delete: async (k) => {
                store.delete(k);
              },
            },
          },
          { DB: mockDb }
        );
        await doInstance.ensureRestored();

        const ackCalls: string[] = [];
        (doInstance as any).collector = {
          getStreamStatuses: () => [],
          ackFundingSettlement: (streamKey: string, eventId: string) => {
            ackCalls.push(`${streamKey}:${eventId}`);
          },
        };

        const baseTs = Date.now() - 25000;
        const { REQUIRED_PAPER_STREAMS } = await import('../orderbook-sequencer');

        // 1. Ingest only 1 stream at t=baseTs and another at t=baseTs+20000 (>15s non-live outage)
        await doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 1,
            exchangeTs: baseTs - 5,
            receivedTs: baseTs,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68005, quantity: 1 }],
          },
          baseTs
        );

        const outageTs = baseTs + 20000;
        await doInstance.ingestOrderbook(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 2,
            exchangeTs: outageTs - 5,
            receivedTs: outageTs,
            bids: [{ price: 68000, quantity: 1 }],
            asks: [{ price: 68005, quantity: 1 }],
          },
          outageTs
        );

        // During non-live outage, baseline provenance MUST be PENDING_LIVE_VALUATION (stale marks are not trusted)
        const outageStatus = (await (
          await doInstance.fetch(new Request('http://internal/status'))
        ).json()) as any;
        expect(outageStatus.windowMetrics['spot-2exch'].baselineProvenance).toBe(
          'PENDING_LIVE_VALUATION'
        );
        expect(outageStatus.runStartedAtMs).toBe(outageTs);

        // Verify deactivatePriorRuns SQL does NOT reference non-existent `ended_at` column
        const deactivateSqls = executedQueries.filter((q) =>
          q.sql.includes('UPDATE paper_trading_runs')
        );
        expect(deactivateSqls.length).toBeGreaterThan(0);
        for (const q of deactivateSqls) {
          expect(q.sql).not.toContain('ended_at');
        }

        // 2. Now all 8 streams recover at recoveryTs = Date.now() with fresh marks
        const recoveryTs = Date.now();
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 68100 : 2620;
          await doInstance.ingestOrderbook(
            {
              exchange: s.exchange,
              pair: s.pair,
              marketType: s.marketType,
              sequenceId: 10,
              exchangeTs: recoveryTs - 5,
              receivedTs: recoveryTs,
              bids: [{ price: mid, quantity: 1 }],
              asks: [{ price: mid + 5, quantity: 1 }],
            },
            recoveryTs
          );
        }

        // Baseline must now re-anchor at recoveryTs with LIVE_VERIFIED provenance and updated runStartedAtMs
        const liveStatus = (await (
          await doInstance.fetch(new Request('http://internal/status'))
        ).json()) as any;
        expect(liveStatus.isLive).toBe(true);
        expect(liveStatus.windowMetrics['spot-2exch'].baselineProvenance).toBe('LIVE_VERIFIED');
        expect(liveStatus.runStartedAtMs).toBe(recoveryTs);

        // 3. Resync with a STALE snapshot (exchangeTs 5000ms behind nowTs) carrying a funding event must NOT ACK
        const staleResyncTs = recoveryTs + 10000;
        const staleResyncRes = await doInstance.resyncStream(
          {
            exchange: 'binance',
            pair: 'BTC/USDT',
            marketType: 'linear_perp',
            sequenceId: 50,
            exchangeTs: staleResyncTs - 5000, // 5000ms old > 1000ms maxFeedAgeMs -> STALE_FEED
            receivedTs: staleResyncTs,
            isDelta: false,
            fundingEventId: 'stale_resync_funding_evt_1',
            fundingSettlementTs: staleResyncTs - 5000,
            fundingRateBps: 2.0,
            bids: [{ price: 68100, quantity: 1 }],
            asks: [{ price: 68105, quantity: 1 }],
          },
          staleResyncTs
        );
        expect(staleResyncRes.status).toBe('STALE_FEED');
        expect(ackCalls).not.toContain(
          'binance:linear_perp:BTC/USDT:stale_resync_funding_evt_1'
        );
        const staleDisp = store.get('funding_disp_stale_resync_funding_evt_1') as any;
        expect(staleDisp).toBeDefined();
        expect(staleDisp.disposition).toBe('retry');
      });

      it('R1 (Blocker 1): Bybit Spot WS snapshot (isDelta: false) applies immediately even while in bootstrappingKeys, and FEED_DESYNC triggers resyncBybitWsStream without REST u~68.3M overwrite', async () => {
        const { LiveMarketCollector } = await import('../live-collector');
        const receivedBooks: NormalizedOrderbook[] = [];
        const collector = new LiveMarketCollector({
          pairs: ['BTC/USDT'],
          onBook: (b) => receivedBooks.push(b),
        });

        const key = 'bybit:spot:BTC/USDT';
        // Simulate stream still marked as bootstrapping when WS snapshot arrives first
        (collector as any).bootstrappingKeys.add(key);

        const now = Date.now();
        const wsSnapshot: NormalizedOrderbook = {
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 7671467,
          exchangeTs: now - 5,
          receivedTs: now,
          isDelta: false,
          bids: [{ price: 68500, quantity: 1.5 }],
          asks: [{ price: 68502, quantity: 1.5 }],
        };
        const wsDelta: NormalizedOrderbook = {
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 7671468,
          exchangeTs: now - 2,
          receivedTs: now + 2,
          isDelta: true,
          bids: [{ price: 68501, quantity: 2.0 }],
          asks: [{ price: 68502, quantity: 1.5 }],
        };

        // Ingest WS snapshot while key is in bootstrappingKeys -> must NOT buffer or drop!
        (collector as any).ingestOrBufferWsBook(wsSnapshot);
        expect((collector as any).bootstrappingKeys.has(key)).toBe(false);
        expect(receivedBooks.length).toBe(1);
        expect(receivedBooks[0].isDelta).toBe(false);
        expect(receivedBooks[0].sequenceId).toBe(7671467);

        // Subsequent WS delta applies cleanly in the 7.6M WS sequence space
        (collector as any).ingestOrBufferWsBook(wsDelta);
        expect(receivedBooks.length).toBe(2);
        expect(receivedBooks[1].sequenceId).toBe(7671468);

        // Verify resyncBybitWsStream sends unsubscribe + subscribe on open WS socket and respects 2000ms cooldown
        const sentPayloads: any[] = [];
        (collector as any).sockets.set(key, {
          readyState: 1,
          send: (msg: string) => sentPayloads.push(JSON.parse(msg)),
          close: () => {},
        });

        const firstResync = await collector.resyncBybitWsStream('BTC/USDT', 'spot');
        expect(firstResync).toBe(true);
        expect(sentPayloads.length).toBe(2);
        expect(sentPayloads[0]).toEqual({ op: 'unsubscribe', args: ['orderbook.50.BTCUSDT'] });
        expect(sentPayloads[1]).toEqual({ op: 'subscribe', args: ['orderbook.50.BTCUSDT'] });

        // Immediate second call within 2000ms cooldown returns false without spamming WS
        const secondResync = await collector.resyncBybitWsStream('BTC/USDT', 'spot');
        expect(secondResync).toBe(false);
        expect(sentPayloads.length).toBe(2);

        collector.close();
      });

      it('R2 (Blocker 2): Binance Perp rotates across fallback REST bases, caches premiumIndex independently, and pumps 400ms REST snapshots when WS is disconnected', async () => {
        const { LiveMarketCollector, BINANCE_PERP_REST_BASES } = await import('../live-collector');
        expect(BINANCE_PERP_REST_BASES.length).toBeGreaterThanOrEqual(4);
        expect(BINANCE_PERP_REST_BASES).toContain('https://www.binance.com');

        const fetchedUrls: string[] = [];
        const customFetch: typeof fetch = async (input: RequestInfo | URL) => {
          const url = String(input);
          fetchedUrls.push(url);
          // Simulate primary fapi.binance.com HTTP 451 / network block
          if (url.startsWith('https://fapi.binance.com')) {
            return new Response('Restricted location', { status: 451 });
          }
          if (url.includes('/fapi/v1/depth')) {
            return new Response(
              JSON.stringify({
                lastUpdateId: 900100,
                E: Date.now(),
                bids: [['68400.00', '2.5']],
                asks: [['68405.00', '2.5']],
              }),
              { status: 200 }
            );
          }
          // Simulate premiumIndex failing with 503 to prove decoupled funding does NOT break depth
          if (url.includes('/fapi/v1/premiumIndex')) {
            return new Response('Service Unavailable', { status: 503 });
          }
          return new Response('{}', { status: 200 });
        };

        const collector = new LiveMarketCollector({
          pairs: ['BTC/USDT'],
          fetchImpl: customFetch,
        });

        const snap = await collector.fetchBinancePerpDepth('BTC/USDT');
        expect(snap.book).not.toBeNull();
        expect(snap.book?.exchange).toBe('binance');
        expect(snap.book?.marketType).toBe('linear_perp');
        expect(snap.book?.isDelta).toBe(false);
        expect(snap.book?.sequenceId).toBe(900100);
        // Sticky index memoized to fallback endpoint (index 1: www.binance.com)
        expect((collector as any).preferredBinancePerpRestIdx).toBe(1);

        collector.close();
      });

      it('R3 (Blocker 3): spot-perp starts 100% USDT and spot-2exch re-anchors operational seed inventory with zero passive beta drawdown at 0 cycles and no open-cycle double-counting', () => {
        const spotPerp = new PaperStrategyEngine({
          strategyId: 'spot-perp',
          initialCapitalUsdt: 10000,
        });
        const spot2Exch = new PaperStrategyEngine({
          strategyId: 'spot-2exch',
          initialCapitalUsdt: 10000,
        });
        const sequencer = new OrderbookSequencer();
        const now = 1761840000000;

        // 1. Verify spot-perp initial state: 100% USDT (5,000 per venue), 0 baseInventory
        const perpInit = spotPerp.getSnapshot();
        expect(perpInit.equityUsdt).toBe(10000);
        expect(perpInit.venueBalances?.binance.freeCollateralUsdt).toBe(5000);
        expect(perpInit.venueBalances?.bybit.freeCollateralUsdt).toBe(5000);
        expect(perpInit.venueBalances?.binance.baseInventory['BTC/USDT']).toBe(0);
        expect(perpInit.venueBalances?.binance.baseInventory['ETH/USDT']).toBe(0);

        // 2. Ingest live prices far from static reference (e.g. BTC = $95,000, ETH = $1,800) at 0 open cycles
        for (const exchange of ['binance', 'bybit'] as const) {
          for (const marketType of ['spot', 'linear_perp'] as const) {
            sequencer.ingest({
              exchange,
              pair: 'BTC/USDT',
              marketType,
              sequenceId: 1,
              exchangeTs: now,
              receivedTs: now + 2,
              bids: [{ price: 95000, quantity: 2 }],
              asks: [{ price: 95005, quantity: 2 }],
            });
            sequencer.ingest({
              exchange,
              pair: 'ETH/USDT',
              marketType,
              sequenceId: 1,
              exchangeTs: now,
              receivedTs: now + 2,
              bids: [{ price: 1800, quantity: 10 }],
              asks: [{ price: 1801, quantity: 10 }],
            });
          }
        }

        const perpMtm1 = spotPerp.updateMarkToMarketDrawdown(sequencer, now + 5);
        const spotMtm1 = spot2Exch.updateMarkToMarketDrawdown(sequencer, now + 5);
        expect(perpMtm1.equityUsdt).toBe(10000);
        expect(perpMtm1.drawdownPct).toBe(0);
        expect(spotMtm1.equityUsdt).toBe(10000);
        expect(spotMtm1.drawdownPct).toBe(0);

        // 3. Subsequent +/- 30% market swing at 0 open cycles still yields 10,000 USDT and 0% drawdown
        for (const exchange of ['binance', 'bybit'] as const) {
          sequencer.ingest({
            exchange,
            pair: 'BTC/USDT',
            marketType: 'spot',
            sequenceId: 2,
            exchangeTs: now + 50,
            receivedTs: now + 52,
            bids: [{ price: 66000, quantity: 2 }],
            asks: [{ price: 66005, quantity: 2 }],
          });
          sequencer.ingest({
            exchange,
            pair: 'ETH/USDT',
            marketType: 'spot',
            sequenceId: 2,
            exchangeTs: now + 50,
            receivedTs: now + 52,
            bids: [{ price: 2400, quantity: 10 }],
            asks: [{ price: 2401, quantity: 10 }],
          });
        }
        const spotMtm2 = spot2Exch.updateMarkToMarketDrawdown(sequencer, now + 60);
        expect(spotMtm2.equityUsdt).toBe(10000);
        expect(spotMtm2.drawdownPct).toBe(0);
        expect(spotMtm2.halted).toBe(false);

        // 4. Open a spot-2exch cycle and verify open-cycle base legs are NOT double-counted in standingInventoryMarkToMarketUsdt
        sequencer.ingest({
          exchange: 'binance',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 3,
          exchangeTs: now + 100,
          receivedTs: now + 102,
          bids: [{ price: 66000, quantity: 2 }],
          asks: [{ price: 66005, quantity: 2 }],
        });
        sequencer.ingest({
          exchange: 'bybit',
          pair: 'BTC/USDT',
          marketType: 'spot',
          sequenceId: 3,
          exchangeTs: now + 100,
          receivedTs: now + 102,
          bids: [{ price: 66350, quantity: 2 }],
          asks: [{ price: 66355, quantity: 2 }],
        });

        const openDec = spot2Exch.evaluatePair(sequencer, 'BTC/USDT', 3, now + 105);
        expect(openDec.decision).toBe('OPEN_CYCLE');
        // Standing inventory MTM remains exactly 4,000 USDT while cycle is open because effectiveStandingQty subtracts openCycleBaseDelta
        expect(spot2Exch.getSnapshot().inventoryValueUsdt).toBe(4000);
      });

      it('R4 (reset-rehearsal): clears haltedByDrawdown, resets both strategies to 10,000 USDT and 0% drawdown, and transitions to LIVE_VERIFIED on 8/8 SYNCED', async () => {
        const store = new Map<string, unknown>();
        const doInstance = new PaperTradingDurableObject({
          storage: {
            get: async (k) => store.get(k) as any,
            put: async (k, v) => {
              store.set(k, v);
            },
            delete: async (k) => {
              store.delete(k);
            },
          },
        });
        await doInstance.ensureRestored();

        // Corrupt state to simulate pre-fix poisoned staging DO (haltedByDrawdown = true, maxDrawdownPct = 7.98)
        for (const sid of ['spot-2exch', 'spot-perp'] as const) {
          const eng = ((doInstance as any).strategies as Map<string, PaperStrategyEngine>).get(sid)!;
          const st = eng.serializeState();
          st.haltedByDrawdown = true;
          st.maxDrawdownPct = 7.98;
          st.cashBalanceUsdt = 5200;
          eng.restoreState(st);
          store.set(`strategy_state_${sid}`, eng.serializeState());
        }

        const beforeStatus = (await (
          await doInstance.fetch(new Request('http://internal/status'))
        ).json()) as any;
        expect(beforeStatus.strategies['spot-2exch'].haltedByDrawdown).toBe(true);
        expect(beforeStatus.strategies['spot-perp'].haltedByDrawdown).toBe(true);

        // Execute POST /reset-rehearsal (with restartCollector: false so unit test does not open live sockets)
        const resetTs = Date.now();
        const resetRes = await doInstance.fetch(
          new Request('http://internal/reset-rehearsal', {
            method: 'POST',
            body: JSON.stringify({ nowTs: resetTs, restartCollector: false }),
          })
        );
        expect(resetRes.status).toBe(200);
        const resetData = (await resetRes.json()) as any;
        expect(resetData.reset).toBe(true);
        expect(resetData.strategies['spot-2exch'].equityUsdt).toBe(10000);
        expect(resetData.strategies['spot-2exch'].maxDrawdownPct).toBe(0);
        expect(resetData.strategies['spot-2exch'].haltedByDrawdown).toBe(false);
        expect(resetData.strategies['spot-perp'].equityUsdt).toBe(10000);
        expect(resetData.strategies['spot-perp'].maxDrawdownPct).toBe(0);
        expect(resetData.strategies['spot-perp'].haltedByDrawdown).toBe(false);

        // Now ingest all 8 streams at live prices -> baselineProvenance transitions to LIVE_VERIFIED and equity stays 10,000
        const { REQUIRED_PAPER_STREAMS } = await import('../orderbook-sequencer');
        const liveTs = Date.now();
        for (const s of REQUIRED_PAPER_STREAMS) {
          const mid = s.pair === 'BTC/USDT' ? 74500 : 2320;
          await doInstance.ingestOrderbook(
            {
              exchange: s.exchange,
              pair: s.pair,
              marketType: s.marketType,
              sequenceId: 1,
              exchangeTs: liveTs - 5,
              receivedTs: liveTs,
              bids: [{ price: mid, quantity: 2 }],
              asks: [{ price: mid + 2, quantity: 2 }],
            },
            liveTs
          );
        }

        const afterLive = (await (
          await doInstance.fetch(new Request('http://internal/status'))
        ).json()) as any;
        expect(afterLive.isLive).toBe(true);
        expect(afterLive.windowMetrics['spot-2exch'].baselineProvenance).toBe('LIVE_VERIFIED');
        expect(afterLive.windowMetrics['spot-perp'].baselineProvenance).toBe('LIVE_VERIFIED');
        expect(afterLive.strategies['spot-2exch'].equityUsdt).toBe(10000);
        expect(afterLive.strategies['spot-2exch'].haltedByDrawdown).toBe(false);
        expect(afterLive.strategies['spot-perp'].equityUsdt).toBe(10000);
        expect(afterLive.strategies['spot-perp'].haltedByDrawdown).toBe(false);
      });

      it('R5 (DO hibernation cold-start alarm): restores collector across isolate eviction, synchronizes all 8 streams within maxFeedAgeMs, drains ingestQueue, and advances continuousCoverageMs + D1 heartbeat across 15s alarm ticks', async () => {
        const store = new Map<string, unknown>();
        store.set('collector_desired_running', true);
        let scheduledAlarmTime: number | null = null;

        const runRows = new Map<
          string,
          {
            run_id: string;
            strategy_id: string;
            verified_real_market_days: number;
            is_active: number;
            heartbeatCount: number;
          }
        >();

        const mockDb: any = {
          prepare: (sql: string) => ({
            bind: (...args: any[]) => ({
              run: async () => {
                if (sql.includes('INSERT INTO paper_trading_runs')) {
                  const [runId, , , strategyId, verifiedDays, , , , , isActive] = args;
                  const prev = runRows.get(runId);
                  runRows.set(runId, {
                    run_id: runId,
                    strategy_id: strategyId,
                    verified_real_market_days: Number(verifiedDays),
                    is_active: Number(isActive),
                    heartbeatCount: (prev?.heartbeatCount ?? 0) + 1,
                  });
                } else if (sql.includes('UPDATE paper_trading_runs') && sql.includes('SET is_active = 0')) {
                  const [strategyId, activeRunId] = args;
                  for (const row of runRows.values()) {
                    if (row.strategy_id === strategyId && row.run_id !== activeRunId && row.is_active === 1) {
                      row.is_active = 0;
                    }
                  }
                }
                return { success: true };
              },
              all: async () => ({ results: [] }),
            }),
            all: async () => ({ results: [] }),
          }),
        };

        const v8 = require('node:v8');
        const mockState: any = {
          storage: {
            get: async (k: string) => store.get(k),
            put: async (k: string, v: unknown) => {
              const byteLen = v8.serialize(v).length;
              if (byteLen > 131072) {
                throw new RangeError(
                  `Values cannot be larger than 131072 bytes. A value of size ${byteLen} was provided for key ${k}.`
                );
              }
              store.set(k, v);
            },
            delete: async (k: string) => {
              store.delete(k);
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

        const originalFetch = globalThis.fetch;
        const OriginalWebSocket = (globalThis as any).WebSocket;

        // Simulate realistic Cloudflare Edge environment:
        // - WS connections do NOT immediately emit native snapshots during cold-start
        // - fapi/www binance endpoints return 451 with 150ms latency so un-cached rotation would age earlier snapshots
        // - data-api.binance.vision and api.bybit.com return fresh L2 depth snapshots
        class QuietColdStartWebSocket {
          send(_data: string): void {}
          close(): void {}
          addEventListener(_type: string, _listener: (evt: any) => void): void {}
        }
        (globalThis as any).WebSocket = QuietColdStartWebSocket;

        // Production exchanges emit strictly monotonic sequence ids: Binance advances
        // `lastUpdateId` (spot depth and fapi depth) and Bybit advances `u` on every
        // published snapshot. Deriving the id from `now % 10000` instead produced a
        // sawtooth that wrapped every 10s, so a snapshot taken after the wrap carried a
        // LOWER id than the one already in the sequencer. `resyncSnapshot` rejects such a
        // snapshot as out-of-order, which left the stream pinned to its stale timestamp
        // and intermittently starved continuous coverage. Count up instead.
        let binanceSequenceCursor = 0;
        let bybitSequenceCursor = 0;
        const emittedBinanceIds: number[] = [];
        const emittedBybitIds: number[] = [];

        // Pin the invariant the cursors exist for. The flaw this test rides on was
        // a fixture that derived ids from the clock and wrapped, so assert the ids
        // the stub hands the sequencer only ever advance; without this the regression
        // would return silently the next time a duration leaks into the id.
        function recordMonotonicId(bucket: number[], id: number): void {
          const previous = bucket[bucket.length - 1];
          expect(typeof id).toBe('number');
          if (previous !== undefined) {
            expect(id).toBeGreaterThan(previous);
          }
          bucket.push(id);
        }

        globalThis.fetch = (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (
            url.startsWith('https://fapi.binance.com') ||
            url.startsWith('https://www.binance.com') ||
            url.startsWith('https://www.binance.info') ||
            url.startsWith('https://fapi.binance.me') ||
            url.startsWith('https://fapi1.binance.com') ||
            url.startsWith('https://fapi2.binance.com')
          ) {
            await new Promise((r) => setTimeout(r, 150));
            return new Response('Restricted location', { status: 451 });
          }
          const now = Date.now();
          const isBtc = url.includes('BTCUSDT');
          const mid = isBtc ? '68400.00' : '2620.00';
          const ask = isBtc ? '68402.00' : '2620.50';
          if (url.includes('binance.vision') || url.includes('binance.com')) {
            const lastUpdateId = 910000 + (binanceSequenceCursor += 1);
            recordMonotonicId(emittedBinanceIds, lastUpdateId);
            return new Response(
              JSON.stringify({
                lastUpdateId,
                E: now,
                bids: [[mid, '2.5']],
                asks: [[ask, '2.5']],
              }),
              { status: 200 }
            );
          }
          if (url.includes('api.bybit.com') && url.includes('/v5/market/orderbook')) {
            const updateId = 59100000 + (bybitSequenceCursor += 1);
            recordMonotonicId(emittedBybitIds, updateId);
            return new Response(
              JSON.stringify({
                retCode: 0,
                retMsg: 'OK',
                result: {
                  s: isBtc ? 'BTCUSDT' : 'ETHUSDT',
                  b: [[mid, '2.5']],
                  a: [[ask, '2.5']],
                  ts: now,
                  u: updateId,
                },
              }),
              { status: 200 }
            );
          }
          if (url.includes('api.bybit.com') && url.includes('/v5/market/tickers')) {
            return new Response(
              JSON.stringify({
                retCode: 0,
                result: { list: [{ fundingRate: '0.0001' }] },
              }),
              { status: 200 }
            );
          }
          return new Response('{}', { status: 200 });
        }) as typeof fetch;

        try {
          // Tick 1: Isolate cold-starts from hibernation on alarm()
          const coldDO1 = new PaperTradingDurableObject(mockState, { DB: mockDb });
          await coldDO1.alarm();
          if ((coldDO1 as any).collector) {
            (coldDO1 as any).collector.close();
          }

          const syncCheck1 = (coldDO1 as any).sequencer.areAllRequiredStreamsSynced(
            (coldDO1 as any).lastLiveIngestTsMs
          );
          expect(syncCheck1.missingOrStaleKeys).toEqual([]);
          expect(syncCheck1.ok).toBe(true);
          expect(syncCheck1.syncedCount).toBe(8);
          expect(store.get('last_live_confirmed_ts_ms')).toEqual(expect.any(Number));
          const activeRunsAfterTick1 = Array.from(runRows.values()).filter(
            (r) => r.is_active === 1
          );
          expect(activeRunsAfterTick1.length).toBe(2);

          // Simulate 5-second hibernation gap and a second cold-start alarm wake-up
          const firstConfirmedTs = store.get('last_live_confirmed_ts_ms') as number;
          store.set('last_live_confirmed_ts_ms', firstConfirmedTs - 5000);

          const coldDO2 = new PaperTradingDurableObject(mockState, { DB: mockDb });
          await coldDO2.alarm();
          if ((coldDO2 as any).collector) {
            (coldDO2 as any).collector.close();
          }

          expect((coldDO2 as any).continuousCoverageMs).toBeGreaterThanOrEqual(5000);
          const activeRuns = Array.from(runRows.values()).filter((r) => r.is_active === 1);
          expect(activeRuns.length).toBe(2);
          for (const run of activeRuns) {
            expect(run.verified_real_market_days).toBeGreaterThan(0);
            expect(run.heartbeatCount).toBeGreaterThanOrEqual(2);
          }

          // Verify Bybit REST (~59.1M) -> Bybit native WS snapshot (~8.5M) sequence transition
          // and contiguous WS delta (~8.5M + 1) acceptance without FEED_DESYNC
          const snapTs = Date.now();
          const bybitWsSnap = OrderbookSequencer.parseBybitDepth(
            {
              topic: 'orderbook.50.BTCUSDT',
              type: 'snapshot',
              ts: snapTs,
              data: {
                s: 'BTCUSDT',
                b: [['68405.00', '3.0']],
                a: [['68406.00', '3.0']],
                u: 8500100,
              },
            },
            'spot',
            snapTs
          );
          expect(bybitWsSnap.isWsSnapshot).toBe(true);
          const wsSnapState = (coldDO2 as any).sequencer.resyncSnapshot(bybitWsSnap, snapTs);
          expect(wsSnapState.status).toBe('SYNCED');
          expect(wsSnapState.lastSequenceId).toBe(8500100);

          const deltaTs = snapTs + 10;
          const bybitWsDelta = OrderbookSequencer.parseBybitDepth(
            {
              topic: 'orderbook.50.BTCUSDT',
              type: 'delta',
              ts: deltaTs,
              data: {
                s: 'BTCUSDT',
                b: [['68405.50', '1.5']],
                a: [],
                u: 8500101,
              },
            },
            'spot',
            deltaTs
          );
          const wsDeltaState = (coldDO2 as any).sequencer.ingest(bybitWsDelta, deltaTs);
          expect(wsDeltaState.status).toBe('SYNCED');
          expect(wsDeltaState.lastSequenceId).toBe(8500101);

          // Verify cold-start `GET /status` awaits collector restoration instead of
          // returning before `startWebSocketStreams()` and `setAlarm()` complete, so an
          // isolate eviction during bootstrap can never leave the DO unscheduled.
          const coldDO3 = new PaperTradingDurableObject(mockState, { DB: mockDb });
          scheduledAlarmTime = null;
          const statusRequest = new Request('https://do/status');
          const statusRes = await coldDO3.fetch(statusRequest);
          expect(statusRes.status).toBe(200);
          expect(scheduledAlarmTime).toBeGreaterThan(Date.now() - 1000);
          const statusBody: any = await statusRes.json();
          expect(statusBody.requiredStreamCount).toBe(8);
          expect(statusBody.sequencerStates.length).toBe(8);
          if ((coldDO3 as any).collector) {
            (coldDO3 as any).collector.close();
          }

          // Verify >900 NO_TRADE ticks never exceed Cloudflare's 131,072-byte DO value limit
          // on `resetContinuousWindow` or `serializeState()`
          const baseTs = Date.now();
          for (let i = 1; i <= 460; i++) {
            const t = baseTs + i * 100;
            for (const pair of ['BTC/USDT', 'ETH/USDT'] as const) {
              for (const exchange of ['binance', 'bybit'] as const) {
                for (const marketType of ['spot', 'linear_perp'] as const) {
                  await coldDO3.resyncStream(
                    {
                      exchange,
                      pair,
                      marketType,
                      sequenceId: 99000000 + i,
                      exchangeTs: t,
                      receivedTs: t,
                      isDelta: false,
                      bids: [{ price: pair === 'BTC/USDT' ? 68400 : 2620, quantity: 2.5 }],
                      asks: [{ price: pair === 'BTC/USDT' ? 68402 : 2620.5, quantity: 2.5 }],
                    },
                    t
                  );
                }
              }
            }
          }
          await (coldDO3 as any).resetContinuousWindow(baseTs + 50000);
          const serializedSpot2Exch = store.get('strategy_state_spot-2exch');
          expect(v8.serialize(serializedSpot2Exch).length).toBeLessThanOrEqual(131072);
        } finally {
          globalThis.fetch = originalFetch;
          (globalThis as any).WebSocket = OriginalWebSocket;
        }
      });

      it('R6: sustains 30-day window across quiet Bybit WS streams (1.5s-9s) in bootstrapSnapshots and throttles open-cycle tick DO writes without starving ingestQueue', async () => {
        const store = new Map<string, unknown>();
        let activeCycleLedgerWrites = 0;
        const setAlarmHistory: number[] = [];
        const mockState = {
          storage: {
            get: async (k: string) => store.get(k) as any,
            put: async (k: string, v: unknown) => {
              if (k === 'active_cycle_ticks_ledger') {
                activeCycleLedgerWrites += 1;
              }
              store.set(k, v);
            },
            delete: async (k: string) => {
              store.delete(k);
            },
            getAlarm: async () => setAlarmHistory[setAlarmHistory.length - 1] ?? null,
            setAlarm: async (time: number) => {
              setAlarmHistory.push(time);
            },
            deleteAlarm: async () => {},
          },
        };

        const ingestedBooks: NormalizedOrderbook[] = [];
        const collector = new LiveMarketCollector({
          pairs: ['BTC/USDT', 'ETH/USDT'],
          onBook: (b) => {
            ingestedBooks.push(b);
          },
          fetchImpl: async (input: RequestInfo | URL) => {
            const url = String(input);
            const now = Date.now();
            const isBtc = url.includes('BTCUSDT');
            if (url.includes('binance')) {
              return new Response(
                JSON.stringify({
                  lastUpdateId: 950000 + Math.floor(Math.random() * 100),
                  E: now,
                  bids: [[isBtc ? '68400.00' : '2620.00', '2.5']],
                  asks: [[isBtc ? '68402.00' : '2620.50', '2.5']],
                }),
                { status: 200 }
              );
            }
            return new Response(
              JSON.stringify({
                retCode: 0,
                retMsg: 'OK',
                result: {
                  s: isBtc ? 'BTCUSDT' : 'ETHUSDT',
                  b: [[isBtc ? '68400.00' : '2620.00', '2.5']],
                  a: [[isBtc ? '68402.00' : '2620.50', '2.5']],
                  ts: now,
                  u: 69000000,
                },
              }),
              { status: 200 }
            );
          },
        });

        // Simulate active Bybit WS streams whose last WS frame arrived 3,500ms ago (> 1,000ms maxFeedAgeMs, < 10,000ms WS active window)
        const quietWsTs = Date.now() - 3500;
        (collector as any).sockets.set('bybit:spot', { close: () => {} });
        (collector as any).sockets.set('bybit:linear_perp', { close: () => {} });
        for (const pair of ['BTC/USDT', 'ETH/USDT'] as const) {
          for (const marketType of ['spot', 'linear_perp'] as const) {
            const key = OrderbookSequencer.makeStreamKey('bybit', pair, marketType);
            const wsSeq = marketType === 'spot' ? 8500500 : 6200500;
            (collector as any).wsOpenedKeys.add(key);
            (collector as any).wsReceiveCounts.set(key, 5);
            (collector as any).lastWsReceiveTs.set(key, quietWsTs);
            // Initial WS snapshot with 2 depth levels
            (collector as any).recordBookIngest({
              exchange: 'bybit',
              pair,
              marketType,
              sequenceId: wsSeq - 1,
              exchangeTs: quietWsTs - 50,
              receivedTs: quietWsTs - 50,
              isDelta: false,
              isWsSnapshot: true,
              bids: [
                { price: pair === 'BTC/USDT' ? 68405 : 2622, quantity: 3 },
                { price: pair === 'BTC/USDT' ? 68400 : 2620, quantity: 5 },
              ],
              asks: [
                { price: pair === 'BTC/USDT' ? 68406 : 2623, quantity: 3 },
                { price: pair === 'BTC/USDT' ? 68410 : 2625, quantity: 4 },
              ],
            });
            // Subsequent WS delta updating only top bid level (asks empty in raw delta frame)
            (collector as any).recordBookIngest({
              exchange: 'bybit',
              pair,
              marketType,
              sequenceId: wsSeq,
              prevSequenceId: wsSeq - 1,
              exchangeTs: quietWsTs,
              receivedTs: quietWsTs,
              isDelta: true,
              bids: [{ price: pair === 'BTC/USDT' ? 68405.5 : 2622.5, quantity: 4 }],
              asks: [],
            });
          }
        }

        ingestedBooks.length = 0;
        await collector.bootstrapSnapshots();
        collector.close();

        // All 4 Bybit streams must be re-emitted with fresh syncedAt timestamps, preserving their WS sequenceId
        // AND the full merged L2 book (all 3 bid levels and both ask levels, not the raw 1-bid/0-ask delta!)
        const bybitReemitted = ingestedBooks.filter((b) => b.exchange === 'bybit');
        expect(bybitReemitted.length).toBe(4);
        for (const b of bybitReemitted) {
          expect(b.isDelta).toBe(false);
          expect(b.prevSequenceId).toBeUndefined();
          expect(b.sequenceId).toBe(b.marketType === 'spot' ? 8500500 : 6200500);
          expect(b.bids.length).toBe(3);
          expect(b.asks.length).toBe(2);
          expect(b.bids[0].price).toBe(b.pair === 'BTC/USDT' ? 68405.5 : 2622.5);
          expect(Date.now() - b.receivedTs).toBeLessThan(1000);
        }

        // Now verify open-cycle tick throttling and bounding inside PaperTradingDurableObject
        const doInstance = new PaperTradingDurableObject(mockState as any);
        (doInstance as any).collector = {
          isHealthy: () => true,
          bootstrapSnapshots: async () => [],
          close: () => {},
        };
        const t0 = 1762000000000;

        // Open a cycle on spot-2exch by feeding a profitable cross-exchange spread
        for (const pair of ['BTC/USDT', 'ETH/USDT'] as const) {
          for (const exchange of ['binance', 'bybit'] as const) {
            for (const marketType of ['spot', 'linear_perp'] as const) {
              const isBybitSpotBtc =
                exchange === 'bybit' && marketType === 'spot' && pair === 'BTC/USDT';
              await doInstance.ingestOrderbook(
                {
                  exchange,
                  pair,
                  marketType,
                  sequenceId: 1,
                  exchangeTs: t0,
                  receivedTs: t0,
                  isDelta: false,
                  bids: [
                    {
                      price: isBybitSpotBtc ? 68750 : pair === 'BTC/USDT' ? 68400 : 2620,
                      quantity: 2.5,
                    },
                  ],
                  asks: [
                    {
                      price: isBybitSpotBtc ? 68755 : pair === 'BTC/USDT' ? 68402 : 2621,
                      quantity: 2.5,
                    },
                  ],
                },
                t0
              );
            }
          }
        }

        const spot2ExchEngine = (doInstance as any).strategies.get('spot-2exch');
        expect(spot2ExchEngine.getOpenCycles().length).toBeGreaterThan(0);
        const openCycleId = spot2ExchEngine.getOpenCycles()[0].cycleId;
        const writesAfterOpen = activeCycleLedgerWrites;
        expect(writesAfterOpen).toBeGreaterThan(0);

        // Stream 1,500 sub-second live delta ticks within a single 500ms window while collector is active
        for (let i = 2; i <= 1501; i++) {
          const tickTs = t0 + Math.floor((i - 1) / 4); // stays within t0..t0+375ms (< 1,000ms snapshot interval)
          await doInstance.ingestOrderbook(
            {
              exchange: 'binance',
              pair: 'BTC/USDT',
              marketType: 'spot',
              sequenceId: i,
              prevSequenceId: i - 1,
              exchangeTs: tickTs,
              receivedTs: tickTs,
              isDelta: true,
              bids: [{ price: 68400, quantity: 2.5 }],
              asks: [{ price: 68402, quantity: 2.5 }],
            },
            tickTs
          );
        }

        // Because all 1,500 deltas arrived within the same <1s persistence window and neither opened nor closed a cycle,
        // `active_cycle_ticks_ledger` must NOT have been written 1,500 times!
        expect(activeCycleLedgerWrites - writesAfterOpen).toBeLessThanOrEqual(2);

        // Furthermore, the in-memory tick buffer preserves the complete contiguous tick chain for replay parity
        const bufferedTicks = (doInstance as any).activeCycleTicks.get(openCycleId);
        expect(bufferedTicks.length).toBe(1506);
        expect(bufferedTicks[0].nowTs).toBe(t0);
        expect(bufferedTicks[bufferedTicks.length - 1].sequenceId ?? bufferedTicks[bufferedTicks.length - 1].book.sequenceId).toBe(1501);

        // Running alarm() pre-schedules the next alarm and flushes activeCycleTicks to storage in bounded chunks
        const alarmsBefore = setAlarmHistory.length;
        await doInstance.alarm();
        expect(setAlarmHistory.length).toBeGreaterThanOrEqual(alarmsBefore + 1);
        expect(activeCycleLedgerWrites).toBeGreaterThan(writesAfterOpen);
        expect(store.get(`active_cycle_ticks_overflow_count_${openCycleId}`)).toBe(3);
      });
    });
  });
});

