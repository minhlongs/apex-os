'use client';

import React, { useState } from 'react';
import type { VipWhaleHedgingPair } from '@/data/stitch-terminal-data';

export interface StitchVipWhaleDeskProps {
  readonly hedgingPairs: readonly VipWhaleHedgingPair[];
  readonly locale: 'en' | 'vi';
}

export function StitchVipWhaleDesk({
  hedgingPairs,
  locale,
}: Readonly<StitchVipWhaleDeskProps>) {
  const isVi = locale === 'vi';

  const [notionalPositionUsd, setNotionalPositionUsd] = useState<number>(2500000);
  const [selectedPair, setSelectedPair] = useState<string>('BTC-PERP');

  const activeLeg = hedgingPairs.find((p) => p.symbol === selectedPair) ?? hedgingPairs[0];
  const projectedAnnualYieldUsd = Math.round(
    (notionalPositionUsd * activeLeg.combinedNetApyPct) / 100
  );

  return (
    <section
      aria-labelledby="vip-whale-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 11 · BÀN GIAO DỊCH CÁ VOI VIP & HEDGING BASIS-POINT ĐA SÀN'
              : 'SCREEN 11 · INSTITUTIONAL VIP WHALE REBATE DESK & BASIS-POINT HEDGING'}
          </p>
          <h2
            id="vip-whale-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Quản Lý Thanh Khoản Cá Voi VIP & Chiến Lược Delta-Neutral'
              : 'Institutional VIP Whale Desk & Delta-Neutral Funding Terminal'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          PRIME TIER: -0.5 bps MAKER REBATE · 55% TAKER CASHBACK
        </span>
      </header>

      {/* 4 Hero Institutional KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            30d Institutional Volume
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-primary stitch-tabular-nums">
            $42,850,000
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-cyan">
            Binance VIP 9 · Bybit Supreme · OKX VIP 8
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Maker Rebate Credit
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums">
            -0.50 bps
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-muted">
            Preserved Unmodified (`calculateNetMakerFee`)
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Combined Funding + Rebate APY
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-cyan stitch-tabular-nums">
            +{activeLeg.combinedNetApyPct.toFixed(1)}% APY
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-emerald">
            Delta-Neutral Cross-Margin
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Projected Whale Desk Yield
          </p>
          <p
            aria-live="polite"
            className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums"
          >
            +${projectedAnnualYieldUsd.toLocaleString('en-US')}/yr
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-violet">
            On ${(notionalPositionUsd / 1_000_000).toFixed(2)}M Notional
          </p>
        </article>
      </div>

      {/* Interactive Delta-Neutral Hedge Simulator + Matrix */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              Cross-Exchange Funding Rate &amp; VIP Maker Rebate Matrix
            </h3>
            <p className="text-xs text-stitch-muted">
              Select an institutional perpetual pair and adjust notional capital allocation
            </p>
          </div>
          <div className="flex gap-2" role="group" aria-label="Select institutional hedge pair">
            {hedgingPairs.map((pair) => (
              <button
                key={pair.symbol}
                type="button"
                aria-pressed={selectedPair === pair.symbol}
                onClick={() => setSelectedPair(pair.symbol)}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs transition-colors ${
                  selectedPair === pair.symbol
                    ? 'bg-gradient-primary font-bold text-stitch-primary'
                    : 'border border-stitch-divider bg-stitch-well text-stitch-muted hover:text-stitch-primary'
                }`}
              >
                {pair.symbol}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-4">
          <div className="flex justify-between font-mono text-xs">
            <label htmlFor="whale-notional-slider" className="text-stitch-muted">
              Institutional Delta-Neutral Notional Allocation (USD):
            </label>
            <span className="font-bold text-stitch-cyan">
              ${notionalPositionUsd.toLocaleString('en-US')} USD
            </span>
          </div>
          <input
            id="whale-notional-slider"
            type="range"
            min={250000}
            max={10000000}
            step={250000}
            value={notionalPositionUsd}
            onChange={(e) => setNotionalPositionUsd(Number(e.target.value))}
            className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
          />
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Perp Contract</th>
                <th className="px-3 py-3">Long Venue (Maker Rebate)</th>
                <th className="px-3 py-3">Short Venue (Funding Yield)</th>
                <th className="px-3 py-3">8h Funding Spread</th>
                <th className="px-3 py-3">Combined Net APY</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border font-mono text-xs">
              {hedgingPairs.map((row) => (
                <tr key={row.symbol} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4 font-bold text-stitch-primary">{row.symbol}</td>
                  <td className="px-3 py-3.5 text-stitch-emerald">{row.longVenue}</td>
                  <td className="px-3 py-3.5 text-stitch-cyan">{row.shortVenue}</td>
                  <td className="px-3 py-3.5 font-bold text-stitch-violet">
                    +{row.fundingSpread8hBps.toFixed(2)} bps / 8h
                  </td>
                  <td className="px-3 py-3.5 font-bold text-stitch-emerald">
                    +{row.combinedNetApyPct.toFixed(1)}% APY
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
