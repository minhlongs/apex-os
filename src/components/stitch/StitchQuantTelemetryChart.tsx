'use client';

import React, { useState } from 'react';
import { Activity, TrendingUp, Zap, ShieldCheck } from 'lucide-react';
import type { TerminalLocale } from '@/data/stitch-terminal-data';

export type TelemetryTimeframe = '24H' | '7D' | '30D' | 'ALL';

interface DataPoint {
  label: string;
  rebateUsd: number;
  spreadBps: number;
  settlementMs: number;
}

const TELEMETRY_SERIES: Record<TelemetryTimeframe, DataPoint[]> = {
  '24H': [
    { label: '00:00', rebateUsd: 16200, spreadBps: 18.4, settlementMs: 410 },
    { label: '04:00', rebateUsd: 19400, spreadBps: 21.2, settlementMs: 395 },
    { label: '08:00', rebateUsd: 24800, spreadBps: 26.8, settlementMs: 380 },
    { label: '12:00', rebateUsd: 22100, spreadBps: 23.5, settlementMs: 405 },
    { label: '16:00', rebateUsd: 28900, spreadBps: 31.0, settlementMs: 372 },
    { label: '20:00', rebateUsd: 26400, spreadBps: 27.9, settlementMs: 388 },
    { label: '23:59', rebateUsd: 30620, spreadBps: 33.4, settlementMs: 365 },
  ],
  '7D': [
    { label: 'Mon', rebateUsd: 118400, spreadBps: 22.1, settlementMs: 402 },
    { label: 'Tue', rebateUsd: 134200, spreadBps: 24.8, settlementMs: 390 },
    { label: 'Wed', rebateUsd: 129800, spreadBps: 23.6, settlementMs: 398 },
    { label: 'Thu', rebateUsd: 152600, spreadBps: 28.4, settlementMs: 379 },
    { label: 'Fri', rebateUsd: 168900, spreadBps: 31.2, settlementMs: 368 },
    { label: 'Sat', rebateUsd: 144500, spreadBps: 26.5, settlementMs: 384 },
    { label: 'Sun', rebateUsd: 179400, spreadBps: 33.8, settlementMs: 362 },
  ],
  '30D': [
    { label: 'W1', rebateUsd: 540200, spreadBps: 21.8, settlementMs: 412 },
    { label: 'W2', rebateUsd: 618900, spreadBps: 25.4, settlementMs: 394 },
    { label: 'W3', rebateUsd: 692400, spreadBps: 28.9, settlementMs: 381 },
    { label: 'W4', rebateUsd: 784500, spreadBps: 32.6, settlementMs: 366 },
  ],
  ALL: [
    { label: 'Q1', rebateUsd: 1420000, spreadBps: 19.5, settlementMs: 440 },
    { label: 'Q2', rebateUsd: 2180000, spreadBps: 24.2, settlementMs: 408 },
    { label: 'Q3', rebateUsd: 3090000, spreadBps: 29.1, settlementMs: 382 },
    { label: 'Q4', rebateUsd: 4289410, spreadBps: 34.0, settlementMs: 362 },
  ],
};

interface StitchQuantTelemetryChartProps {
  locale?: TerminalLocale;
}

export function StitchQuantTelemetryChart({ locale = 'en' }: StitchQuantTelemetryChartProps) {
  const [timeframe, setTimeframe] = useState<TelemetryTimeframe>('24H');
  const [selectedIndex, setSelectedIndex] = useState<number | null>(null);
  const isVi = locale === 'vi';

  const series = TELEMETRY_SERIES[timeframe];
  const activePoint = selectedIndex !== null && series[selectedIndex] ? series[selectedIndex] : series[series.length - 1];

  const maxRebate = Math.max(...series.map((d) => d.rebateUsd));
  const minRebate = Math.min(...series.map((d) => d.rebateUsd)) * 0.85;

  const width = 640;
  const height = 160;
  const padX = 28;
  const padY = 20;

  const points = series.map((pt, idx) => {
    const x = padX + (idx / Math.max(1, series.length - 1)) * (width - padX * 2);
    const ratio = (pt.rebateUsd - minRebate) / Math.max(1, maxRebate - minRebate);
    const y = height - padY - ratio * (height - padY * 2);
    return { x, y, pt, idx };
  });

  const polylinePoints = points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(' ');
  const areaPoints = `${points[0].x.toFixed(1)},${height - padY} ${polylinePoints} ${points[points.length - 1].x.toFixed(1)},${height - padY}`;

  return (
    <section
      aria-label={isVi ? 'Biểu Đồ Telemetry Định Lượng Thực Thi' : 'Quant Rebate & Basis Spread Telemetry Chart'}
      className="bg-[#11131a] border border-[#1e2330] rounded-lg p-5 space-y-4"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-[#1e2330] pb-3.5">
        <div>
          <div className="flex items-center gap-2">
            <Activity className="w-4 h-4 text-[#00F0FF]" />
            <h2 className="text-xs font-mono uppercase tracking-wider text-slate-300 font-semibold">
              {isVi
                ? 'TELEMETRY HOÀN PHÍ & CHÊNH LỆCH ĐIỂM CƠ BẢN (PRO MAX SVG)'
                : 'QUANT REBATE VELOCITY & BASIS SPREAD TELEMETRY (PRO MAX SVG)'}
            </h2>
            <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-[#00FF9D]/10 text-[#00FF9D] border border-[#00FF9D]/30">
              WCAG 2.1 AA
            </span>
          </div>
          <p className="text-[11px] text-slate-400 mt-0.5">
            {isVi
              ? 'Đường cong hoàn phí T+0 trực tiếp kết hợp độ trễ thanh toán Edge và biên lợi nhuận bps.'
              : 'Live T+0 rebate velocity curve fused with edge settlement latency and basis-point yield.'}
          </p>
        </div>

        {/* Timeframe Selector */}
        <div
          role="group"
          aria-label={isVi ? 'Chọn khung thời gian biểu đồ' : 'Select chart timeframe'}
          className="flex items-center bg-[#0B0C10] border border-[#1e2330] rounded p-0.5 self-start sm:self-auto"
        >
          {(['24H', '7D', '30D', 'ALL'] as TelemetryTimeframe[]).map((tf) => {
            const active = timeframe === tf;
            return (
              <button
                key={tf}
                type="button"
                onClick={() => {
                  setTimeframe(tf);
                  setSelectedIndex(null);
                }}
                aria-pressed={active}
                data-testid={`telemetry-tf-${tf}`}
                className={`px-2.5 py-1 rounded text-[11px] font-mono font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#00F0FF] ${
                  active
                    ? 'bg-[#00F0FF]/15 text-[#00F0FF] border border-[#00F0FF]/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tf}
              </button>
            );
          })}
        </div>
      </div>

      {/* Active Point Telemetry Readout Strip */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 bg-[#0B0C10] border border-[#1e2330] rounded p-3">
        <div>
          <div className="text-[10px] font-mono uppercase text-slate-400">
            {isVi ? 'MỐC THỜI GIAN' : 'ACTIVE WINDOW'}
          </div>
          <div className="text-sm font-mono font-bold text-white mt-0.5" data-testid="telemetry-active-label">
            {timeframe} • {activePoint.label}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase text-slate-400">
            {isVi ? 'HOÀN PHÍ ĐÃ CHỐT' : 'REBATE CAPTURED'}
          </div>
          <div className="text-sm font-mono font-bold text-[#00FF9D] mt-0.5 flex items-center gap-1" data-testid="telemetry-active-rebate">
            <TrendingUp className="w-3.5 h-3.5" />
            ${activePoint.rebateUsd.toLocaleString('en-US')}
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase text-slate-400">
            {isVi ? 'BIÊN CHÊNH LỆCH RÒNG' : 'NET BASIS SPREAD'}
          </div>
          <div className="text-sm font-mono font-bold text-[#00F0FF] mt-0.5 flex items-center gap-1">
            <Zap className="w-3.5 h-3.5" />
            +{activePoint.spreadBps.toFixed(1)} bps
          </div>
        </div>
        <div>
          <div className="text-[10px] font-mono uppercase text-slate-400">
            {isVi ? 'ĐỘ TRỄ THANH TOÁN P99' : 'P99 EDGE FINALITY'}
          </div>
          <div className="text-sm font-mono font-bold text-slate-200 mt-0.5 flex items-center gap-1">
            <ShieldCheck className="w-3.5 h-3.5 text-[#00FF9D]" />
            {activePoint.settlementMs} ms
          </div>
        </div>
      </div>

      {/* Accessible Interactive SVG Chart */}
      <div className="relative bg-[#0B0C10] border border-[#1e2330] rounded p-3 overflow-hidden">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          role="img"
          aria-label={`ApexOS Quant Rebate Telemetry SVG Chart (${timeframe})`}
          className="w-full h-36 overflow-visible"
        >
          <defs>
            <linearGradient id="apexProMaxCyanGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#00F0FF" stopOpacity="0.32" />
              <stop offset="100%" stopColor="#00FF9D" stopOpacity="0.0" />
            </linearGradient>
          </defs>

          {/* Horizontal reference grid lines */}
          {[0.2, 0.5, 0.8].map((ratio, idx) => {
            const y = padY + ratio * (height - padY * 2);
            return (
              <line
                key={idx}
                x1={padX}
                y1={y}
                x2={width - padX}
                y2={y}
                stroke="#1e2330"
                strokeDasharray="3 3"
                strokeWidth="1"
              />
            );
          })}

          {/* Shaded Gradient Area */}
          <polygon points={areaPoints} fill="url(#apexProMaxCyanGrad)" />

          {/* Primary Velocity Curve */}
          <polyline
            fill="none"
            stroke="#00F0FF"
            strokeWidth="2.25"
            strokeLinecap="round"
            strokeLinejoin="round"
            points={polylinePoints}
          />

          {/* Interactive Data Nodes */}
          {points.map(({ x, y, pt, idx }) => {
            const isSelected =
              (selectedIndex === null && idx === points.length - 1) || selectedIndex === idx;
            return (
              <g
                key={pt.label}
                className="cursor-pointer"
                onClick={() => setSelectedIndex(idx)}
                onMouseEnter={() => setSelectedIndex(idx)}
              >
                <circle
                  cx={x}
                  cy={y}
                  r={isSelected ? 5.5 : 3.5}
                  fill={isSelected ? '#00FF9D' : '#0B0C10'}
                  stroke={isSelected ? '#00FF9D' : '#00F0FF'}
                  strokeWidth="2"
                />
                <text
                  x={x}
                  y={height - 4}
                  textAnchor="middle"
                  fill={isSelected ? '#00F0FF' : '#64748b'}
                  fontSize="10"
                  fontFamily="JetBrains Mono, monospace"
                >
                  {pt.label}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </section>
  );
}
