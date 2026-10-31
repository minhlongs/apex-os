/**
 * src/lib/paper/replay.ts
 *
 * Deterministic Replay Engine: re-executes a 50-tick sequence and computes a
 * bit-identical SHA-256 digest of the entire journal, proving 1:1 reproducibility.
 */

import { createHash } from 'crypto';
import { OrderbookSequencer } from './orderbook-sequencer';
import { PaperStrategyEngine } from './strategy-engine';
import type {
  EconomicResearchSummary,
  PaperStrategyId,
  ReplayExecutionResult,
  ReplayTick,
  StrategyEconomicAudit,
} from './types';

const STRATEGY_IDS: PaperStrategyId[] = ['spot-2exch', 'spot-perp'];

export class PaperReplayEngine {
  static computeDigest(payload: unknown): string {
    return createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
  }

  /**
   * Execute a deterministic replay of a tick sequence.
   * Given identical input ticks and model config, output is bit-identical.
   */
  static runReplay(
    ticks: ReplayTick[],
    options?: {
      modelVersion?: string;
      replayBatchId?: string;
    }
  ): ReplayExecutionResult {
    const modelVersion = options?.modelVersion ?? 'paper-v1.0.0';
    const replayBatchId = options?.replayBatchId ?? 'replay-50-tick';
    const sequencer = new OrderbookSequencer();

    const engines = new Map<PaperStrategyId, PaperStrategyEngine>();
    for (const sid of STRATEGY_IDS) {
      engines.set(
        sid,
        new PaperStrategyEngine({
          strategyId: sid,
          modelVersion,
        })
      );
    }

    const PAIRS: Array<PaperStrategyId extends never ? never : 'BTC/USDT' | 'ETH/USDT'> = [
      'BTC/USDT',
      'ETH/USDT',
    ];

    for (const tick of ticks) {
      for (const book of tick.books) {
        sequencer.ingest(book, book.receivedTs);
      }

      for (const engine of engines.values()) {
        for (const pair of PAIRS) {
          engine.evaluatePair(sequencer, pair, tick.tickIndex, tick.nowTs, replayBatchId);
        }
      }
    }

    const strategies = {} as Record<PaperStrategyId, ReplayExecutionResult['strategies'][PaperStrategyId]>;
    const allClosedCycles: ReplayExecutionResult['closedCycles'] = [];
    const allDecisions: ReplayExecutionResult['decisions'] = [];

    for (const sid of STRATEGY_IDS) {
      const engine = engines.get(sid)!;
      // Force deterministic ordering
      allClosedCycles.push(
        ...[...engine.getClosedCycles()].sort((a, b) => {
          if (a.entryTs !== b.entryTs) return a.entryTs - b.entryTs;
          return a.cycleId.localeCompare(b.cycleId);
        })
      );
      allDecisions.push(
        ...[...engine.getDecisions()].sort((a, b) => {
          if (a.tickIndex !== b.tickIndex) return a.tickIndex - b.tickIndex;
          return a.strategyId.localeCompare(b.strategyId);
        })
      );
    }

    for (const sid of STRATEGY_IDS) {
      strategies[sid] = engines.get(sid)!.getSnapshot();
    }

    const digest = PaperReplayEngine.computeDigest({
      modelVersion,
      tickCount: ticks.length,
      closedCycles: allClosedCycles,
      decisions: allDecisions,
    });

    return {
      modelVersion,
      tickCount: ticks.length,
      digest,
      strategies,
      closedCycles: allClosedCycles,
      decisions: allDecisions,
      sequencerStates: sequencer.getAllStates(),
    };
  }

  /**
   * Verify determinism: running the same replay twice yields identical digests.
   */
  static verifyDeterminism(ticks: ReplayTick[], modelVersion = 'paper-v1.0.0'): {
    digestA: string;
    digestB: string;
    bitIdentical: boolean;
  } {
    const a = PaperReplayEngine.runReplay(ticks, { modelVersion });
    const b = PaperReplayEngine.runReplay(ticks, { modelVersion });
    return {
      digestA: a.digest,
      digestB: b.digest,
      bitIdentical: a.digest === b.digest,
    };
  }

  /**
   * Strict Economic Gate & Audit verification (Blocking for GO-LIVE).
   * Gate requirements per strategy:
   *   1. >= 30 continuous real-market days (from verified timestamps, never tick-count formula)
   *   2. >= 100 valid closed cycles
   *   3. Net realized P&L > 0 after all fees and funding
   *   4. Max drawdown <= 2.0% (including unrealized mark-to-market positions)
   */
  static buildEconomicResearchSummary(
    result: ReplayExecutionResult,
    options?: {
      generatedAt?: string;
      targetBenchmarkDays?: number;
      targetBenchmarkCycles?: number;
      verifiedRealMarketDays?: number;
    }
  ): EconomicResearchSummary {
    const targetBenchmarkDays = options?.targetBenchmarkDays ?? 30;
    const targetBenchmarkCycles = options?.targetBenchmarkCycles ?? 100;
    // Verified observation days must come from explicit market timestamps, defaulting to 0 for replay/fixtures
    const verifiedDays = options?.verifiedRealMarketDays ?? 0;

    const strategies: StrategyEconomicAudit[] = STRATEGY_IDS.map((sid) => {
      const s = result.strategies[sid];
      const daysPassed = verifiedDays >= targetBenchmarkDays;
      const cyclesPassed = s.closedCyclesCount >= targetBenchmarkCycles;
      const pnlPassed = s.realizedNetPnlUsdt > 0;
      const maxDrawdownLimitPct = 2.0;
      const drawdownPassed = s.maxDrawdownPct <= maxDrawdownLimitPct;
      const isReadyForLive = daysPassed && cyclesPassed && pnlPassed && drawdownPassed;

      return {
        strategyId: sid,
        observedContinuousDays: verifiedDays,
        targetBenchmarkDays,
        daysPassed,
        closedCyclesCount: s.closedCyclesCount,
        targetBenchmarkCycles,
        cyclesPassed,
        netPnlUsdt: s.realizedNetPnlUsdt,
        pnlPassed,
        maxDrawdownPct: s.maxDrawdownPct,
        maxDrawdownLimitPct,
        drawdownPassed,
        isReadyForLive,
        verdict: isReadyForLive ? 'GO' : 'NO_GO',
        researchFinding:
          `Observed ${verifiedDays}/${targetBenchmarkDays} continuous market days, ` +
          `${s.closedCyclesCount}/${targetBenchmarkCycles} closed cycles. ` +
          `Net P&L: ${s.realizedNetPnlUsdt.toFixed(4)} USDT (Pass=${pnlPassed}), ` +
          `Max DD: ${s.maxDrawdownPct.toFixed(4)}% <= 2.0% (Pass=${drawdownPassed}). ` +
          `Strategy Verdict: ${isReadyForLive ? 'GO' : 'NO_GO (Economic Gate Active)'}`,
      };
    });

    const allPassed = strategies.every((st) => st.isReadyForLive);

    return {
      reportType: 'STRICT_ECONOMIC_AUDIT',
      isReleaseBlocker: true,
      overallVerdict: allPassed ? 'GO' : 'NO_GO',
      generatedAt: options?.generatedAt ?? new Date(0).toISOString(),
      modelVersion: result.modelVersion,
      strategies,
    };
  }
}
