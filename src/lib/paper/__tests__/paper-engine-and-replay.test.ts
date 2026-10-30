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

    it('generates a descriptive research report without acting as a release blocker', () => {
      const ticks = buildCanonical50TickSequence();
      const replay = PaperReplayEngine.runReplay(ticks);
      const summary = PaperReplayEngine.buildEconomicResearchSummary(replay);

      expect(summary.reportType).toBe('DESCRIPTIVE_RESEARCH_ONLY');
      expect(summary.isReleaseBlocker).toBe(false);
      expect(summary.strategies.length).toBe(2);
      expect(summary.strategies[0].researchFinding).toContain('continuous observation days');
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

  describe('5. Durable Object Interface', () => {
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
  });
});
