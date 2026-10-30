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
   * Descriptive research evaluation only (NOT a deployment gate).
   */
  static buildEconomicResearchSummary(
    result: ReplayExecutionResult,
    options?: {
      generatedAt?: string;
      targetBenchmarkDays?: number;
      targetBenchmarkCycles?: number;
    }
  ): EconomicResearchSummary {
    const targetBenchmarkDays = options?.targetBenchmarkDays ?? 30;
    const targetBenchmarkCycles = options?.targetBenchmarkCycles ?? 100;

    return {
      reportType: 'DESCRIPTIVE_RESEARCH_ONLY',
      isReleaseBlocker: false,
      generatedAt:
        options?.generatedAt ?? new Date(0).toISOString(),
      modelVersion: result.modelVersion,
      strategies: STRATEGY_IDS.map((sid) => {
        const s = result.strategies[sid];
        const observedDays = Math.max(1, Math.floor(result.tickCount / 24));
        return {
          strategyId: sid,
          observedContinuousDays: observedDays,
          targetBenchmarkDays,
          closedCyclesCount: s.closedCyclesCount,
          targetBenchmarkCycles,
          netPnlUsdt: s.realizedNetPnlUsdt,
          maxDrawdownPct: s.maxDrawdownPct,
          maxDrawdownLimitPct: s.maxDrawdownPct,
          researchFinding:
            `Over ${observedDays} continuous observation days and ${s.closedCyclesCount} closed cycles, ` +
            `strategy realized net P&L of ${s.realizedNetPnlUsdt.toFixed(4)} USDT with max drawdown ${s.maxDrawdownPct.toFixed(4)}% ` +
            `and taker fees of ${s.totalFeesPaidUsdt.toFixed(4)} USDT in paper simulation.`,
        };
      }),
    };
  }
}
