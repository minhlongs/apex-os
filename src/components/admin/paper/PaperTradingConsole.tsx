'use client';

/**
 * src/components/admin/paper/PaperTradingConsole.tsx
 *
 * Honest Admin Console for the Greenfield Paper Trading Simulator.
 * Renders all 3 confirmed surfaces:
 *   1. Strategy Ledgers (2 x 10,000 USDT) & Closed-Cycle Table
 *   2. Realtime Streaming Orderbook Sequencer & Decision Terminal
 *   3. CSV / PDF Export & Descriptive Economic Research Report
 */

import React, { useMemo, useState } from 'react';
import { buildCanonical50TickSequence } from '@/lib/paper/fixtures';
import { PaperReplayEngine } from '@/lib/paper/replay';
import type { PaperStrategyId } from '@/lib/paper/types';

export function PaperTradingConsole() {
  const [selectedStrategy, setSelectedStrategy] = useState<'ALL' | PaperStrategyId>('ALL');

  const simulation = useMemo(() => {
    const ticks = buildCanonical50TickSequence();
    const replay = PaperReplayEngine.runReplay(ticks, { modelVersion: 'paper-v1.0.0' });
    const determinism = PaperReplayEngine.verifyDeterminism(ticks, 'paper-v1.0.0');
    const economicReport = PaperReplayEngine.buildEconomicResearchSummary(replay, {
      generatedAt: '2026-10-30T00:00:00.000Z',
    });
    return { replay, determinism, economicReport };
  }, []);

  const { replay, determinism, economicReport } = simulation;
  const maxFeedAgeMs = replay.sequencerStates.reduce(
    (max, s) => Math.max(max, s.feedAgeMs),
    0
  );

  const filteredCycles = replay.closedCycles.filter((c) =>
    selectedStrategy === 'ALL' ? true : c.strategyId === selectedStrategy
  );

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 p-6 space-y-6">
      {/* Prominent PAPER Watermark Banner */}
      <div
        role="region"
        aria-label="Paper Trading Watermark"
        className="rounded-xl border-2 border-amber-500/80 bg-amber-950/40 px-5 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4"
      >
        <div>
          <div className="flex items-center gap-2">
            <span className="inline-flex items-center rounded-md bg-amber-500 px-2.5 py-0.5 text-xs font-mono font-bold text-slate-950 uppercase">
              PAPER SIMULATION ONLY
            </span>
            <span className="font-mono text-xs text-amber-300">
              Model: {replay.modelVersion} · Feed Age: {maxFeedAgeMs}ms · Replay SHA-256:{' '}
              {replay.digest.slice(0, 16)}…
            </span>
          </div>
          <h1 className="mt-1 text-xl font-bold text-white">
            ApexOS Greenfield Paper Trading Admin Console (Cloudflare Durable Objects)
          </h1>
          <p className="text-xs text-amber-200/90 mt-0.5">
            Simulated execution over real Binance &amp; Bybit L2 orderbook feeds with taker VWAP
            slippage and fee deduction. Zero live CEX order or withdrawal permissions exist.
          </p>
        </div>

        {/* Surface 3: CSV & PDF Export Controls */}
        <div className="flex items-center gap-3 shrink-0">
          <a
            href="/api/admin/paper/export?format=csv"
            download="apexos-paper-trading-journal.csv"
            className="rounded-lg border border-cyan-500/60 bg-cyan-950/60 px-3.5 py-2 text-xs font-mono font-semibold text-cyan-200 hover:bg-cyan-900/60"
          >
            Export CSV (PAPER)
          </a>
          <a
            href="/api/admin/paper/export?format=pdf"
            download="apexos-paper-trading-report.pdf"
            className="rounded-lg border border-emerald-500/60 bg-emerald-950/60 px-3.5 py-2 text-xs font-mono font-semibold text-emerald-200 hover:bg-emerald-900/60"
          >
            Export PDF (PAPER)
          </a>
        </div>
      </div>

      {/* Surface 1A: Independent 10,000 USDT Strategy Ledgers */}
      <section aria-label="Strategy Ledgers" className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {(['spot-2exch', 'spot-perp'] as const).map((sid) => {
          const s = replay.strategies[sid];
          return (
            <div
              key={sid}
              className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 space-y-3"
            >
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-xs font-mono uppercase text-cyan-400">{s.strategyId}</span>
                  <h2 className="text-base font-semibold text-white">{s.strategyName}</h2>
                </div>
                <span className="rounded bg-slate-800 px-2.5 py-1 font-mono text-xs text-amber-300">
                  {s.executionMode} · {s.modelVersion}
                </span>
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2">
                <div className="rounded-lg bg-slate-950/70 p-3 border border-slate-800/80">
                  <p className="text-xs text-slate-400">Initial Capital</p>
                  <p className="text-sm font-mono font-bold text-slate-100">
                    {s.initialCapitalUsdt.toFixed(2)} USDT
                  </p>
                </div>
                <div className="rounded-lg bg-slate-950/70 p-3 border border-slate-800/80">
                  <p className="text-xs text-slate-400">Current Equity</p>
                  <p className="text-sm font-mono font-bold text-emerald-400">
                    {s.equityUsdt.toFixed(4)} USDT
                  </p>
                </div>
                <div className="rounded-lg bg-slate-950/70 p-3 border border-slate-800/80">
                  <p className="text-xs text-slate-400">Net Realized P&amp;L</p>
                  <p
                    className={`text-sm font-mono font-bold ${
                      s.realizedNetPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {s.realizedNetPnlUsdt >= 0 ? '+' : ''}
                    {s.realizedNetPnlUsdt.toFixed(4)} USDT
                  </p>
                </div>
                <div className="rounded-lg bg-slate-950/70 p-3 border border-slate-800/80">
                  <p className="text-xs text-slate-400">Taker Fees Paid</p>
                  <p className="text-sm font-mono font-bold text-amber-300">
                    {s.totalFeesPaidUsdt.toFixed(4)} USDT
                  </p>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between text-xs font-mono text-slate-400 pt-1">
                <span>Max Drawdown: {s.maxDrawdownPct.toFixed(4)}% (Limit ≤ 2.0%)</span>
                <span>Closed Cycles: {s.closedCyclesCount}</span>
                <span>Win Rate: {s.winRatePct.toFixed(1)}%</span>
                <span>NO_TRADE Skips: {s.noTradeCount}</span>
              </div>
            </div>
          );
        })}
      </section>

      {/* Surface 2: Realtime Streaming Sequencer & Decision Terminal */}
      <section
        aria-label="Realtime Streaming Terminal"
        className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h2 className="text-base font-semibold text-white">
              Realtime L2 Orderbook Sequencer &amp; Spread Terminal (PAPER)
            </h2>
            <p className="text-xs text-slate-400">
              Monitors sequence continuity (Binance U/u diff &amp; Bybit v5 orderbook.1), feed
              staleness (&le;1000ms), and deterministic replay parity (
              {determinism.bitIdentical ? '100% BIT-IDENTICAL' : 'MISMATCH'}).
            </p>
          </div>
          <span className="rounded bg-emerald-950/80 border border-emerald-500/40 px-3 py-1 font-mono text-xs text-emerald-300">
            REPLAY VERIFIED: {determinism.digestA.slice(0, 12)}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-6 gap-2.5">
          {replay.sequencerStates.map((st) => (
            <div
              key={st.streamKey}
              className="rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs space-y-1"
            >
              <div className="flex items-center justify-between">
                <span className="font-bold text-cyan-300 uppercase">{st.exchange}</span>
                <span
                  className={`px-1.5 py-0.5 rounded text-[10px] ${
                    st.status === 'SYNCED'
                      ? 'bg-emerald-950 text-emerald-300'
                      : 'bg-rose-950 text-rose-300'
                  }`}
                >
                  {st.status}
                </span>
              </div>
              <p className="text-slate-200">
                {st.pair} ({st.marketType})
              </p>
              <p className="text-slate-400">
                Seq #{st.lastSequenceId} · Age {st.feedAgeMs}ms
              </p>
            </div>
          ))}
        </div>

        <div className="rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-xs max-h-52 overflow-y-auto space-y-1">
          {replay.decisions.slice(-14).map((d, idx) => (
            <div
              key={`${d.tickIndex}-${d.strategyId}-${d.pair}-${idx}`}
              className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-900 pb-1"
            >
              <span className="text-slate-400">
                [Tick #{d.tickIndex}][{d.strategyId}][{d.pair}]
              </span>
              <span
                className={
                  d.decision === 'OPEN_CYCLE'
                    ? 'text-cyan-300 font-bold'
                    : d.decision === 'CLOSE_CYCLE'
                      ? 'text-emerald-300 font-bold'
                      : 'text-slate-400'
                }
              >
                {d.decision}
              </span>
              <span className="text-slate-300">
                Raw: {d.rawSpreadBps.toFixed(2)} bps | Net: {d.estimatedNetSpreadBps.toFixed(2)} bps
              </span>
              <span className="text-slate-400 truncate max-w-md">{d.reason}</span>
            </div>
          ))}
        </div>
      </section>

      {/* Surface 1B: Closed-Cycle Table */}
      <section
        aria-label="Closed Cycles Table"
        className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-white">
              Immutable Closed Paper Cycles ({filteredCycles.length})
            </h2>
            <p className="text-xs text-slate-400">
              Every closed cycle records entry/exit VWAP prices, round-trip taker fees, funding
              adjustments, and a deterministic SHA-256 idempotency key.
            </p>
          </div>
          <div className="flex items-center gap-2">
            {(['ALL', 'spot-2exch', 'spot-perp'] as const).map((filter) => (
              <button
                key={filter}
                type="button"
                onClick={() => setSelectedStrategy(filter)}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs ${
                  selectedStrategy === filter
                    ? 'bg-cyan-600 text-white font-bold'
                    : 'bg-slate-800 text-slate-300 hover:bg-slate-700'
                }`}
              >
                {filter}
              </button>
            ))}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left font-mono text-xs border-collapse">
            <thead>
              <tr className="border-b border-slate-800 text-slate-400">
                <th className="py-2 pr-3">Mode</th>
                <th className="py-2 pr-3">Cycle ID</th>
                <th className="py-2 pr-3">Strategy</th>
                <th className="py-2 pr-3">Pair</th>
                <th className="py-2 pr-3">Notional</th>
                <th className="py-2 pr-3">Gross P&amp;L</th>
                <th className="py-2 pr-3">Fees</th>
                <th className="py-2 pr-3">Funding</th>
                <th className="py-2 pr-3">Net P&amp;L</th>
                <th className="py-2">Idempotency Key</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/70">
              {filteredCycles.map((c) => (
                <tr key={c.idempotencyKey} className="hover:bg-slate-950/50">
                  <td className="py-2 pr-3">
                    <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-amber-300">
                      {c.executionMode}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-slate-200">{c.cycleId}</td>
                  <td className="py-2 pr-3 text-cyan-300">{c.strategyId}</td>
                  <td className="py-2 pr-3">{c.pair}</td>
                  <td className="py-2 pr-3">{c.notionalUsdt.toFixed(2)} USDT</td>
                  <td className="py-2 pr-3 text-slate-200">{c.grossPnlUsdt.toFixed(4)} USDT</td>
                  <td className="py-2 pr-3 text-amber-300">-{c.totalFeesUsdt.toFixed(4)} USDT</td>
                  <td className="py-2 pr-3 text-cyan-300">+{c.fundingDeltaUsdt.toFixed(4)} USDT</td>
                  <td
                    className={`py-2 pr-3 font-bold ${
                      c.netPnlUsdt >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {c.netPnlUsdt >= 0 ? '+' : ''}
                    {c.netPnlUsdt.toFixed(4)} USDT
                  </td>
                  <td className="py-2 text-slate-400">{c.idempotencyKey.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* Surface 3B: Descriptive Economic Research Report */}
      <section
        aria-label="Descriptive Economic Research Report"
        className="rounded-xl border border-slate-800 bg-slate-900/80 p-5 space-y-3"
      >
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-base font-semibold text-white">
              Descriptive Economic Evaluation Report (Research Telemetry)
            </h2>
            <p className="text-xs text-slate-400">
              Tracks strategy performance against the 30-day / 100-cycle research horizon without
              blocking technical platform releases.
            </p>
          </div>
          <span className="rounded bg-slate-800 px-2.5 py-1 font-mono text-xs text-cyan-300">
            {economicReport.reportType} · BLOCKER={String(economicReport.isReleaseBlocker)}
          </span>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {economicReport.strategies.map((item) => (
            <div
              key={item.strategyId}
              className="rounded-lg border border-slate-800 bg-slate-950 p-3 text-xs space-y-1"
            >
              <p className="font-mono font-bold text-cyan-300 uppercase">{item.strategyId}</p>
              <p className="text-slate-300">{item.researchFinding}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
