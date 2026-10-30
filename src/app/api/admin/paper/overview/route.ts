/**
 * src/app/api/admin/paper/overview/route.ts
 *
 * Admin API: Greenfield Paper Trading Simulator Status & Replay Overview
 * Endpoint: GET /api/admin/paper/overview
 *
 * Delivers:
 *   1. Realtime terminal metrics (feed latency, raw spread, net spread)
 *   2. Closed cycles table and strategy equity curves (two 10k USDT ledgers)
 *   3. Deterministic replay digest verification
 *   4. Descriptive economic research report (non-blocking)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { buildCanonical50TickSequence } from '@/lib/paper/fixtures';
import { PaperReplayEngine } from '@/lib/paper/replay';

function resolveDb(request?: NextRequest): D1Database | null {
  const reqAny = request as unknown as { env?: { DB?: D1Database } };
  if (reqAny?.env?.DB) {
    return reqAny.env.DB;
  }
  const globalAny = globalThis as unknown as { DB?: D1Database };
  if (globalAny.DB) {
    return globalAny.DB;
  }
  try {
    return getDB();
  } catch {
    return null;
  }
}

export async function GET(request: NextRequest) {
  try {
    const db = resolveDb(request);

    // Optional admin auth check with graceful degradation in sandbox/demo mode
    if (db) {
      try {
        const adminAuthModule = await import('@/lib/payouts/admin-auth');
        if (typeof adminAuthModule.verifyAdminPayoutAccess === 'function') {
          const authRes = await adminAuthModule.verifyAdminPayoutAccess(request, db);
          if (!authRes.authorized && process.env.NODE_ENV === 'production' && authRes.response) {
            return authRes.response;
          }
        }
      } catch {
        // Allow sandbox read in local/testing
      }
    }

    const ticks = buildCanonical50TickSequence();
    const replayResult = PaperReplayEngine.runReplay(ticks, {
      modelVersion: 'paper-v1.0.0',
    });
    const determinism = PaperReplayEngine.verifyDeterminism(ticks, 'paper-v1.0.0');
    const economicSummary = PaperReplayEngine.buildEconomicResearchSummary(replayResult, {
      generatedAt: new Date().toISOString(),
    });

    return NextResponse.json(
      {
        executionMode: 'PAPER',
        watermark: 'PAPER SIMULATION ONLY - ZERO LIVE CEX ORDERS OR WITHDRAWALS',
        liveTradingEnabled: false,
        modelVersion: replayResult.modelVersion,
        syncedAt: new Date().toISOString(),
        replayVerification: {
          tickCount: replayResult.tickCount,
          digest: replayResult.digest,
          bitIdentical: determinism.bitIdentical,
        },
        strategies: replayResult.strategies,
        closedCycles: replayResult.closedCycles,
        recentDecisions: replayResult.decisions.slice(-20),
        sequencerStates: replayResult.sequencerStates,
        economicResearchReport: economicSummary,
      },
      { status: 200 }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        executionMode: 'PAPER',
        error: `Failed to load paper trading overview: ${message}`,
      },
      { status: 500 }
    );
  }
}
