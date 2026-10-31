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

function resolveEnv(request?: NextRequest): { DB?: D1Database; PAPER_TRADING_DO?: { get(id: unknown): { fetch(req: Request): Promise<Response> }; idFromName(name: string): unknown } } | null {
  const reqAny = request as unknown as { env?: { DB?: D1Database; PAPER_TRADING_DO?: { get(id: unknown): { fetch(req: Request): Promise<Response> }; idFromName(name: string): unknown } } };
  if (reqAny?.env) {
    return reqAny.env;
  }
  const globalAny = globalThis as unknown as { env?: { DB?: D1Database; PAPER_TRADING_DO?: { get(id: unknown): { fetch(req: Request): Promise<Response> }; idFromName(name: string): unknown } } };
  return globalAny.env ?? null;
}

export async function GET(request: NextRequest) {
  try {
    const env = resolveEnv(request);
    const db = resolveDb(request);

    // Strict Fail-Closed Admin RBAC guard
    const adminAuthModule = await import('@/lib/payouts/admin-auth');
    const authRes = await adminAuthModule.verifyAdminPayoutAccess(
      request,
      db ?? undefined
    );
    if (!authRes.authorized) {
      return authRes.response;
    }

    // Try reading live Durable Object state if bound
    if (env?.PAPER_TRADING_DO) {
      try {
        const doId = env.PAPER_TRADING_DO.idFromName('global-paper-engine');
        const stub = env.PAPER_TRADING_DO.get(doId);
        const doRes = await stub.fetch(new Request('http://internal/status'));
        if (doRes.ok) {
          const doData = await doRes.json();
          return NextResponse.json({
            ...doData,
            isLive: true,
            dataSource: 'LIVE_DURABLE_OBJECT_STREAM',
            watermark: 'PAPER SIMULATION ONLY - ZERO LIVE CEX ORDERS OR WITHDRAWALS',
            syncedAt: new Date().toISOString(),
          }, { status: 200 });
        }
      } catch (doErr) {
        console.warn('[PaperOverview] DO fetch failed, falling back to deterministic fixture:', doErr);
      }
    }

    const ticks = buildCanonical50TickSequence();
    const replayResult = PaperReplayEngine.runReplay(ticks, {
      modelVersion: 'paper-v1.1.0',
    });
    const determinism = PaperReplayEngine.verifyDeterminism(ticks, 'paper-v1.1.0');
    const economicSummary = PaperReplayEngine.buildEconomicResearchSummary(replayResult, {
      generatedAt: new Date().toISOString(),
    });

    return NextResponse.json(
      {
        executionMode: 'PAPER',
        isLive: false,
        dataSource: 'FIXTURE_REPLAY_FALLBACK',
        watermark: 'PAPER SIMULATION ONLY - ZERO LIVE CEX ORDERS OR WITHDRAWALS',
        liveTradingEnabled: false,
        overallVerdict: economicSummary.overallVerdict,
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
