'use client';

import React, { useState, useMemo } from 'react';
import type { ArbitrageOpportunityItem } from '@/data/stitch-terminal-data';

export interface StitchArbitrageMatrixProps {
  readonly opportunities: readonly ArbitrageOpportunityItem[];
  readonly locale: 'en' | 'vi';
}

export function StitchArbitrageMatrix({
  opportunities,
  locale,
}: Readonly<StitchArbitrageMatrixProps>) {
  const isVi = locale === 'vi';

  // Canonical benchmark defaults: $150,000 monthly volume, 50% maker/taker blend -> $810/yr savings
  const [monthlyVolumeUsd, setMonthlyVolumeUsd] = useState<number>(150000);
  const [makerBlendPct, setMakerBlendPct] = useState<number>(50);
  const [selectedDealFilter, setSelectedDealFilter] = useState<
    'ALL' | 'FEE_SPREAD' | 'CASHBACK_MAX' | 'VIP_PROMOTION'
  >('ALL');

  const savingsMetrics = useMemo(() => {
    // At $150,000/mo ($1.8M/yr) and 50% maker blend, 4.5 bps net cashback+spread advantage = $810.00/yr
    const blendMultiplier = 1 + (50 - makerBlendPct) * 0.004;
    const effectiveBps = 4.5 * blendMultiplier;
    const monthlySavingsUsd = (monthlyVolumeUsd * effectiveBps) / 10000;
    const annualSavingsUsd = monthlySavingsUsd * 12;
    return {
      effectiveBps: effectiveBps.toFixed(2),
      monthlySavingsUsd: monthlySavingsUsd.toFixed(2),
      annualSavingsUsd: annualSavingsUsd.toFixed(2),
    };
  }, [monthlyVolumeUsd, makerBlendPct]);

  const filteredOpportunities = useMemo(() => {
    if (selectedDealFilter === 'ALL') return opportunities;
    return opportunities.filter((item) => item.dealType === selectedDealFilter);
  }, [opportunities, selectedDealFilter]);

  return (
    <section
      aria-labelledby="arbitrage-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 2 · CÔNG CỤ TÍNH CHÊNH LỆCH PHÍ & CRAWLER SĂN DEAL'
              : 'SCREEN 2 · CROSS-EXCHANGE ARBITRAGE & DEAL CRAWLER MATRIX'}
          </p>
          <h2
            id="arbitrage-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Máy Tính Tiết Kiệm Phí Basis-Point (bps) & Săn Deal'
              : 'Interactive Fee Arbitrage Calculator & Deal Crawler'}
          </h2>
        </div>
        <div className="flex items-center gap-2">
          <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-cyan">
            CRAWLER SYNC: 4/4 OK · 12s AGO
          </span>
        </div>
      </header>

      {/* Interactive ArbitrageFinder Calculator */}
      <article className="stitch-obsidian-card p-6">
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div className="space-y-5 lg:col-span-2">
            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="monthly-volume-slider"
                  className="text-sm font-medium text-stitch-primary"
                >
                  {isVi ? 'Khối Lượng Giao Dịch Hàng Tháng (USD)' : 'Monthly Trading Volume (USD)'}
                </label>
                <span className="font-mono text-sm font-bold text-stitch-cyan stitch-tabular-nums">
                  ${monthlyVolumeUsd.toLocaleString('en-US')} / mo
                </span>
              </div>
              <input
                id="monthly-volume-slider"
                type="range"
                min={10000}
                max={1000000}
                step={10000}
                value={monthlyVolumeUsd}
                onChange={(e) => setMonthlyVolumeUsd(Number(e.target.value))}
                className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
              />
              <div className="mt-1 flex justify-between font-mono text-xs text-stitch-muted">
                <span>$10k</span>
                <span>Canonical Benchmark: $150k/mo</span>
                <span>$1M</span>
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between">
                <label
                  htmlFor="maker-blend-slider"
                  className="text-sm font-medium text-stitch-primary"
                >
                  {isVi ? 'Tỷ Lệ Lệnh Maker / Taker (%)' : 'Maker / Taker Execution Blend (%)'}
                </label>
                <span className="font-mono text-sm font-bold text-stitch-violet stitch-tabular-nums">
                  {makerBlendPct}% Maker / {100 - makerBlendPct}% Taker
                </span>
              </div>
              <input
                id="maker-blend-slider"
                type="range"
                min={0}
                max={100}
                step={5}
                value={makerBlendPct}
                onChange={(e) => setMakerBlendPct(Number(e.target.value))}
                className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-secondary-500"
              />
              <div className="mt-1 flex justify-between font-mono text-xs text-stitch-muted">
                <span>0% Maker (100% Taker)</span>
                <span>50% Balanced Blend</span>
                <span>100% Maker Limit</span>
              </div>
            </div>
          </div>

          {/* Projected Savings Output Box */}
          <div
            aria-live="polite"
            className="flex flex-col justify-between rounded-xl border border-stitch-divider bg-stitch-well/80 p-5"
          >
            <div>
              <span className="inline-block rounded-md bg-stitch-surface px-2.5 py-1 font-mono text-xs text-stitch-cyan">
                NET SPREAD EDGE: +{savingsMetrics.effectiveBps} bps
              </span>
              <p className="mt-3 text-xs uppercase tracking-wider text-stitch-muted">
                {isVi ? 'Tiết Kiệm Dự Kiến Hàng Năm' : 'Projected Annual Fee Savings'}
              </p>
              <p className="mt-1 text-4xl font-display font-bold text-stitch-emerald stitch-tabular-nums">
                ${Number(savingsMetrics.annualSavingsUsd).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                })}
                <span className="ml-1 text-sm font-mono text-stitch-muted">/yr</span>
              </p>
              <p className="mt-1 font-mono text-xs text-stitch-primary">
                ${Number(savingsMetrics.monthlySavingsUsd).toLocaleString('en-US', {
                  minimumFractionDigits: 2,
                })}{' '}
                USDC / month
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                setMonthlyVolumeUsd(150000);
                setMakerBlendPct(50);
              }}
              className="mt-4 w-full rounded-lg border border-stitch-divider bg-stitch-surface px-3 py-2 font-mono text-xs font-medium text-stitch-primary transition-colors hover:border-stitch-cyan focus-visible:ring-2 focus-visible:ring-primary-500"
            >
              {isVi
                ? 'Đặt Lại Chuẩn $150k/tháng ($810/năm)'
                : 'Reset to $150k/mo Benchmark ($810.00/yr)'}
            </button>
          </div>
        </div>
      </article>

      {/* Filter Bar & Arbitrage Matrix Table */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <h3 className="text-lg font-display font-bold text-stitch-primary">
            {isVi
              ? 'Bảng Chênh Lệch Phí & Khuyến Mãi VIP Thời Gian Thực'
              : 'Live Basis-Point (bps) Spread & VIP Promotion Matrix'}
          </h3>
          <div className="flex flex-wrap gap-2" role="group" aria-label="Deal category filter">
            {(['ALL', 'FEE_SPREAD', 'CASHBACK_MAX', 'VIP_PROMOTION'] as const).map((filter) => {
              const active = selectedDealFilter === filter;
              return (
                <button
                  key={filter}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedDealFilter(filter)}
                  className={`rounded-lg px-3 py-1.5 font-mono text-xs transition-colors ${
                    active
                      ? 'bg-gradient-primary font-bold text-stitch-primary'
                      : 'border border-stitch-divider bg-stitch-well text-stitch-muted hover:text-stitch-primary'
                  }`}
                >
                  {filter}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Pair</th>
                <th className="px-3 py-3">Optimal Leg A</th>
                <th className="px-3 py-3">Optimal Leg B</th>
                <th className="px-3 py-3">Net Edge (bps)</th>
                <th className="px-3 py-3">Deal Type</th>
                <th className="px-3 py-3">Est. Annual Yield</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border">
              {filteredOpportunities.map((opp) => (
                <tr key={opp.id} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4 font-mono font-bold text-stitch-primary">
                    {opp.pair}
                  </td>
                  <td className="px-3 py-3.5 text-xs text-stitch-primary">{opp.buyExchange}</td>
                  <td className="px-3 py-3.5 text-xs text-stitch-primary">{opp.sellExchange}</td>
                  <td className="px-3 py-3.5 font-mono text-sm font-bold text-stitch-cyan stitch-tabular-nums">
                    +{opp.netAfterRebateBps.toFixed(1)} bps
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="rounded-md bg-stitch-well px-2.5 py-1 font-mono text-xs text-stitch-violet">
                      {opp.dealType}
                    </span>
                  </td>
                  <td className="px-3 py-3.5 font-mono text-sm font-semibold text-stitch-emerald stitch-tabular-nums">
                    +${opp.estimatedAnnualSavingsUsd.toLocaleString('en-US')}/yr ({opp.confidencePct}%)
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
