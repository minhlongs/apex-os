'use client';

import React, { useState } from 'react';
import type { AiArbitrageAgentEntry } from '@/data/stitch-terminal-data';

export interface StitchAiAgentArbitrageBotProps {
  readonly agents: readonly AiArbitrageAgentEntry[];
  readonly locale: 'en' | 'vi';
}

export function StitchAiAgentArbitrageBot({
  agents,
  locale,
}: Readonly<StitchAiAgentArbitrageBotProps>) {
  const isVi = locale === 'vi';

  const [targetSpreadBps, setTargetSpreadBps] = useState<number>(22);
  const [simulatedSlippageBps, setSimulatedSlippageBps] = useState<number>(6);

  const isRiskGateHalted = simulatedSlippageBps > 15 || targetSpreadBps <= simulatedSlippageBps;
  const netCapturedSpreadBps = Math.max(0, targetSpreadBps - simulatedSlippageBps);

  return (
    <section
      aria-labelledby="ai-arbitrage-bot-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 15 · HỆ THỐNG BOT ĐA TÁC TỬ ARBITRAGE BASIS-POINT & CỔNG QUẢN TRỊ RỦI RO'
              : 'SCREEN 15 · AUTONOMOUS MULTI-AGENT BASIS-POINT ARBITRAGE & RISK-GATED EXECUTION'}
          </p>
          <h2
            id="ai-arbitrage-bot-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Đội Ngũ Agent Tự Hành Săn Chênh Lệch Phí & Cắt Mạch Trượt Giá'
              : 'Autonomous Multi-Agent Arbitrage Swarm & Risk-Gate Command'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          SWARM: 4/4 AGENTS ARMED · ZERO WITHDRAW SCOPE · 15.0 bps SLIPPAGE CAP
        </span>
      </header>

      {/* 4 Hero Multi-Agent Swarm KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Autonomous Agent Swarm
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums">
            4 / 4 Armed
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-cyan">
            Sub-second Edge Ingestion Loop
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            30d Autonomous Alpha
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-primary stitch-tabular-nums">
            +$19,420.00
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-emerald">
            Sharpe Ratio 3.42 · 0 Liquidations
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Net Captured Edge (bps)
          </p>
          <p
            aria-live="polite"
            className="mt-2 text-2xl font-display font-bold text-stitch-cyan stitch-tabular-nums"
          >
            +{netCapturedSpreadBps.toFixed(1)} bps
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-muted">
            Spread {targetSpreadBps} bps − Slippage {simulatedSlippageBps} bps
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Sentinel-Gamma Risk Gate
          </p>
          <p
            aria-live="polite"
            className={`mt-2 text-lg font-mono font-bold ${
              isRiskGateHalted ? 'text-stitch-crimson' : 'text-stitch-emerald'
            }`}
          >
            {isRiskGateHalted
              ? '423 LOCKED · RISK_GATE_HALTED'
              : '200 EXECUTING · SLIPPAGE_SAFE'}
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-violet">
            Max Drawdown Ceiling: 15.0 bps
          </p>
        </article>
      </div>

      {/* Multi-Agent Swarm Matrix & Interactive Risk-Gate Simulator */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              Autonomous Multi-Agent Pipeline &amp; Slippage Circuit Breaker Simulator
            </h3>
            <p className="text-xs text-stitch-muted">
              Adjust market spread and simulated orderbook slippage to test `Sentinel-Gamma` automatic execution halt
            </p>
          </div>
          <span className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-cyan">
            BYOK POLICY: READ_TRADE_ONLY (NO WITHDRAWAL PERMISSION)
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="ai-spread-slider" className="text-stitch-muted">
                Target Cross-Exchange Fee + Funding Spread (bps):
              </label>
              <span className="font-bold text-stitch-cyan">{targetSpreadBps} bps</span>
            </div>
            <input
              id="ai-spread-slider"
              type="range"
              min={5}
              max={50}
              step={1}
              value={targetSpreadBps}
              onChange={(e) => setTargetSpreadBps(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
            />
          </div>

          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="ai-slippage-slider" className="text-stitch-muted">
                Simulated Orderbook Slippage (bps):
              </label>
              <span className="font-bold text-stitch-violet">{simulatedSlippageBps} bps</span>
            </div>
            <input
              id="ai-slippage-slider"
              type="range"
              min={1}
              max={30}
              step={1}
              value={simulatedSlippageBps}
              onChange={(e) => setSimulatedSlippageBps(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
            />
          </div>
        </div>

        <div className="mt-5 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Agent Node</th>
                <th className="px-3 py-3">Role &amp; Execution Scope</th>
                <th className="px-3 py-3">Min Spread Trigger</th>
                <th className="px-3 py-3">Slippage Cap</th>
                <th className="px-3 py-3">24h Captured Alpha</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border font-mono text-xs">
              {agents.map((agent) => (
                <tr key={agent.agentId} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4 font-bold text-stitch-primary">
                    {agent.agentName}
                  </td>
                  <td className="px-3 py-3.5 text-stitch-muted">{agent.roleSummary}</td>
                  <td className="px-3 py-3.5 text-stitch-cyan">
                    {agent.minSpreadTriggerBps.toFixed(1)} bps
                  </td>
                  <td className="px-3 py-3.5 text-stitch-violet">
                    {agent.maxSlippageGuardBps.toFixed(1)} bps
                  </td>
                  <td className="px-3 py-3.5 font-bold text-stitch-emerald">
                    +${agent.captured24hUsdc.toFixed(2)} USDC
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
