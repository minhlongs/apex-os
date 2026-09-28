'use client';

/**
 * src/components/deals/ArbitrageFinder.tsx
 *
 * Interactive Cross-Exchange Arbitrage & High-Yield Yield Finder
 * Features:
 * - Live trading volume slider ($10k, $50k, $250k, $1M+) with custom input
 * - Maker/taker order blend ratio slider (0% to 100%)
 * - Market type filter (All, Spot, Futures)
 * - Canonical pair selector (BTC/USDT, ETH/USDT, SOL/USDT, etc.)
 * - Live fee savings calculator with monthly and annual savings ($810/yr benchmark display)
 * - Opportunity classification badges: FEE_SPREAD, CASHBACK_MAX, VIP_PROMOTION
 * - 1-click CTA button routing directly to affiliate deal link
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import Link from 'next/link';
import {
  TrendingUp,
  Sliders,
  DollarSign,
  Zap,
  ArrowRight,
  ExternalLink,
  RefreshCw,
  Percent,
  CheckCircle2,
  Sparkles,
  Layers,
} from 'lucide-react';
import type { MarketType, OpportunityType, ExchangeId, ArbitrageOpportunity } from '@/types/arbitrage';

export interface ArbitrageFinderProps {
  initialVolume?: number;
  initialMakerPercent?: number;
  initialMarketType?: MarketType | 'all';
  initialPair?: string;
  className?: string;
}

// Preset volume milestones
const VOLUME_PRESETS = [
  { label: '$10k', value: 10000 },
  { label: '$50k', value: 50000 },
  { label: '$250k', value: 250000, highlight: true },
  { label: '$1M', value: 1000000 },
];

const POPULAR_PAIRS = ['ALL', 'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'XRP/USDT', 'DOGE/USDT'];

// Deterministic default opportunities for immediate preview and offline testing
const DEFAULT_OPPORTUNITIES: ArbitrageOpportunity[] = [
  {
    id: 'arb-btc-futures-bybit-binance',
    pair: 'BTC/USDT',
    market_type: 'futures',
    base_exchange: 'binance',
    target_exchange: 'bybit',
    base_taker_fee: 0.00075,
    target_taker_fee: 0.00055,
    base_maker_fee: 0.0002,
    target_maker_fee: 0.0002,
    base_cashback_pct: 20.0,
    target_cashback_pct: 40.0,
    net_base_fee: 0.0006,
    net_target_fee: 0.00033,
    spread_bps: 2.7,
    savings_pct: 45.0,
    opportunity_type: 'CASHBACK_MAX',
    recommendation: 'Switch futures taker volume to Bybit for 40% rebate',
    deal_id: 'deal-bybit-futures-40',
    monthly_savings_10k: 2.7,
    monthly_savings_50k: 13.5,
    monthly_savings_250k: 67.5,
    annual_savings_10k: 32.4,
    annual_savings_50k: 162.0,
    annual_savings_250k: 810.0,
    is_active: 1,
    detected_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  },
  {
    id: 'arb-eth-spot-okx-binance',
    pair: 'ETH/USDT',
    market_type: 'spot',
    base_exchange: 'binance',
    target_exchange: 'okx',
    base_taker_fee: 0.001,
    target_taker_fee: 0.0007,
    base_maker_fee: 0.001,
    target_maker_fee: 0.0005,
    base_cashback_pct: 10.0,
    target_cashback_pct: 25.0,
    net_base_fee: 0.0009,
    net_target_fee: 0.000525,
    spread_bps: 3.75,
    savings_pct: 41.67,
    opportunity_type: 'FEE_SPREAD',
    recommendation: 'Switch spot volume to OKX for 25% cashback',
    deal_id: 'deal-okx-spot-30',
    monthly_savings_10k: 3.75,
    monthly_savings_50k: 18.75,
    monthly_savings_250k: 93.75,
    annual_savings_10k: 45.0,
    annual_savings_50k: 225.0,
    annual_savings_250k: 1125.0,
    is_active: 1,
    detected_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  },
  {
    id: 'arb-sol-futures-bybit-kucoin',
    pair: 'SOL/USDT',
    market_type: 'futures',
    base_exchange: 'kucoin',
    target_exchange: 'bybit',
    base_taker_fee: 0.0006,
    target_taker_fee: 0.00055,
    base_maker_fee: 0.0002,
    target_maker_fee: 0.0002,
    base_cashback_pct: 15.0,
    target_cashback_pct: 40.0,
    net_base_fee: 0.00051,
    net_target_fee: 0.00033,
    spread_bps: 1.8,
    savings_pct: 35.29,
    opportunity_type: 'CASHBACK_MAX',
    recommendation: 'Migrate SOL contracts to Bybit for 40% rebate',
    deal_id: 'deal-bybit-futures-40',
    monthly_savings_10k: 1.8,
    monthly_savings_50k: 9.0,
    monthly_savings_250k: 45.0,
    annual_savings_10k: 21.6,
    annual_savings_50k: 108.0,
    annual_savings_250k: 540.0,
    is_active: 1,
    detected_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  },
  {
    id: 'arb-btc-spot-kucoin-okx',
    pair: 'BTC/USDT',
    market_type: 'spot',
    base_exchange: 'kucoin',
    target_exchange: 'bybit',
    base_taker_fee: 0.001,
    target_taker_fee: 0.001,
    base_maker_fee: 0.001,
    target_maker_fee: 0.001,
    base_cashback_pct: 25.0,
    target_cashback_pct: 40.0,
    net_base_fee: 0.00075,
    net_target_fee: 0.0006,
    spread_bps: 1.5,
    savings_pct: 20.0,
    opportunity_type: 'CASHBACK_MAX',
    recommendation: 'Maximize cashback to 40% on Bybit Spot',
    deal_id: 'deal-bybit-spot-40',
    monthly_savings_10k: 1.5,
    monthly_savings_50k: 7.5,
    monthly_savings_250k: 37.5,
    annual_savings_10k: 18.0,
    annual_savings_50k: 90.0,
    annual_savings_250k: 450.0,
    is_active: 1,
    detected_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 86400000).toISOString(),
  },
];

/**
 * Calculates blended savings based on volume and maker/taker order ratio
 */
export function calculateBlendedSavings(
  opp: ArbitrageOpportunity,
  monthlyVolumeUsd: number,
  makerPercent: number
): {
  blendedBaseFee: number;
  blendedTargetFee: number;
  netSpreadBps: number;
  monthlySavings: number;
  annualSavings: number;
  badgeVariant: 'neutral' | 'success' | 'super';
} {
  const clampedMaker = Math.max(0, Math.min(100, makerPercent));
  const clampedTaker = 100 - clampedMaker;

  // Base Net Fees
  const baseMakerNet =
    opp.base_maker_fee >= 0
      ? opp.base_maker_fee * (1 - opp.base_cashback_pct / 100)
      : opp.base_maker_fee;
  const baseTakerNet = opp.base_taker_fee * (1 - opp.base_cashback_pct / 100);
  const blendedBaseFee = (baseMakerNet * clampedMaker + baseTakerNet * clampedTaker) / 100;

  // Target Net Fees
  const targetMakerNet =
    opp.target_maker_fee >= 0
      ? opp.target_maker_fee * (1 - opp.target_cashback_pct / 100)
      : opp.target_maker_fee;
  const targetTakerNet = opp.target_taker_fee * (1 - opp.target_cashback_pct / 100);
  const blendedTargetFee = (targetMakerNet * clampedMaker + targetTakerNet * clampedTaker) / 100;

  const netSpread = blendedBaseFee - blendedTargetFee;
  const netSpreadBps = Math.round(netSpread * 10000 * 100) / 100;

  if (netSpread <= 0) {
    return {
      blendedBaseFee,
      blendedTargetFee,
      netSpreadBps: 0,
      monthlySavings: 0,
      annualSavings: 0,
      badgeVariant: 'neutral',
    };
  }

  const monthlySavings = Math.round(monthlyVolumeUsd * netSpread * 100) / 100;
  const annualSavings = Math.round(monthlySavings * 12 * 100) / 100;

  let badgeVariant: 'neutral' | 'success' | 'super' = 'neutral';
  if (netSpreadBps >= 25.0) {
    badgeVariant = 'super';
  } else if (netSpreadBps >= 15.0) {
    badgeVariant = 'success';
  }

  return {
    blendedBaseFee,
    blendedTargetFee,
    netSpreadBps,
    monthlySavings,
    annualSavings,
    badgeVariant,
  };
}

export default function ArbitrageFinder({
  initialVolume = 250000,
  initialMakerPercent = 0,
  initialMarketType = 'all',
  initialPair = 'ALL',
  className = '',
}: ArbitrageFinderProps) {
  // Interactive state
  const [monthlyVolume, setMonthlyVolume] = useState<number>(initialVolume);
  const [makerPercent, setMakerPercent] = useState<number>(initialMakerPercent);
  const [marketType, setMarketType] = useState<MarketType | 'all'>(initialMarketType);
  const [selectedPair, setSelectedPair] = useState<string>(initialPair);
  const [minSpreadFilter, setMinSpreadFilter] = useState<number>(0);

  // Opportunities and loading state
  const [opportunities, setOpportunities] = useState<ArbitrageOpportunity[]>(DEFAULT_OPPORTUNITIES);
  const [loading, setLoading] = useState<boolean>(false);
  const [lastUpdated, setLastUpdated] = useState<string>(new Date().toLocaleTimeString());

  // Fetch live opportunities from public API
  const fetchOpportunities = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (selectedPair !== 'ALL') params.set('pair', selectedPair);
      if (marketType !== 'all') params.set('market_type', marketType);
      if (minSpreadFilter > 0) params.set('min_spread', minSpreadFilter.toString());
      params.set('limit', '50');

      const res = await fetch(`/api/deals/arbitrage?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success && Array.isArray(json.data) && json.data.length > 0) {
          setOpportunities(json.data);
          setLastUpdated(new Date().toLocaleTimeString());
        }
      }
    } catch {
      // Retain fallback data on fetch failure
    } finally {
      setLoading(false);
    }
  }, [selectedPair, marketType, minSpreadFilter]);

  useEffect(() => {
    fetchOpportunities();
  }, [fetchOpportunities]);

  // Filtered & computed opportunities
  const computedList = useMemo(() => {
    return opportunities
      .filter((opp) => {
        if (marketType !== 'all' && opp.market_type !== marketType) return false;
        if (selectedPair !== 'ALL' && opp.pair.toUpperCase() !== selectedPair.toUpperCase()) return false;
        return true;
      })
      .map((opp) => {
        const calc = calculateBlendedSavings(opp, monthlyVolume, makerPercent);
        return {
          ...opp,
          calc,
        };
      })
      .sort((a, b) => b.calc.netSpreadBps - a.calc.netSpreadBps);
  }, [opportunities, marketType, selectedPair, monthlyVolume, makerPercent]);

  // Key KPI highlights
  const topOpportunity = computedList[0];
  const maxSpreadBps = topOpportunity ? topOpportunity.calc.netSpreadBps : 0;
  const topAnnualSavings = topOpportunity ? topOpportunity.calc.annualSavings : 0;

  return (
    <div className={`space-y-8 ${className}`}>
      {/* 1. Header Banner */}
      <div className="bg-gradient-to-r from-gray-900 via-indigo-950 to-slate-900 rounded-2xl p-6 sm:p-8 text-white shadow-xl border border-indigo-900/50">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div>
            <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-indigo-500/20 text-indigo-300 text-xs font-semibold tracking-wide uppercase mb-3 border border-indigo-500/30">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              Live Fee Arbitrage Engine
            </div>
            <h2 className="text-2xl sm:text-3xl font-extrabold tracking-tight">
              Cross-Exchange Yield & Cashback Finder
            </h2>
            <p className="mt-2 text-sm sm:text-base text-gray-300 max-w-2xl">
              Compare maker and taker fees across major exchanges, apply ApexOS partner rebates,
              and route your orders where you retain the highest net profit.
            </p>
          </div>

          <div className="flex items-center gap-3 self-start md:self-auto">
            <button
              onClick={fetchOpportunities}
              disabled={loading}
              className="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-indigo-600 hover:bg-indigo-500 text-white text-sm font-semibold transition-all shadow-md active:scale-95 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
              Sync Rates
            </button>
          </div>
        </div>

        {/* 2. Top Summary KPI Cards */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-8 pt-6 border-t border-indigo-800/40">
          <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Top Net Spread</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-bold text-amber-400">
                {maxSpreadBps.toFixed(1)} <span className="text-sm font-normal text-gray-300">bps</span>
              </span>
            </div>
            <span className="text-xs text-gray-400 mt-1 block">Fee savings advantage</span>
          </div>

          <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Est. Annual Savings</span>
            <div className="mt-1 flex items-baseline gap-2">
              <span className="text-2xl sm:text-3xl font-bold text-emerald-400">
                ${topAnnualSavings.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}
                <span className="text-sm font-normal text-gray-300">/yr</span>
              </span>
            </div>
            <span className="text-xs text-emerald-300/80 mt-1 block">
              At ${(monthlyVolume / 1000).toFixed(0)}k/mo volume
            </span>
          </div>

          <div className="bg-white/5 backdrop-blur-sm rounded-xl p-4 border border-white/10">
            <span className="text-xs font-medium text-gray-400 uppercase tracking-wider">Benchmark Highlight</span>
            <div className="mt-1 text-sm font-semibold text-white">
              Binance → Bybit Futures
            </div>
            <span className="text-xs text-indigo-300 mt-1 block">
              Save <strong className="text-white">$810/yr</strong> on $250k volume with 40% rebate
            </span>
          </div>
        </div>
      </div>

      {/* 3. Interactive Calculator Toolbar Card */}
      <div className="bg-white rounded-2xl p-6 sm:p-8 shadow-sm border border-gray-200 space-y-6">
        <div className="flex items-center justify-between pb-4 border-b border-gray-100">
          <div className="flex items-center gap-2">
            <Sliders className="w-5 h-5 text-indigo-600" />
            <h3 className="text-lg font-bold text-gray-900">Interactive Savings Calculator</h3>
          </div>
          <span className="text-xs text-gray-500">Updated: {lastUpdated}</span>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Volume Controls (7 cols) */}
          <div className="lg:col-span-7 space-y-5">
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-gray-800">
                  Monthly Trading Volume (USD)
                </label>
                <div className="relative">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 text-sm font-semibold">
                    $
                  </span>
                  <input
                    type="number"
                    min={1000}
                    max={10000000}
                    step={1000}
                    value={monthlyVolume}
                    onChange={(e) => setMonthlyVolume(Math.max(0, Number(e.target.value)))}
                    className="w-40 pl-7 pr-3 py-1.5 text-right font-bold text-gray-900 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 focus:border-indigo-500"
                  />
                </div>
              </div>

              {/* Range Slider */}
              <input
                type="range"
                min={10000}
                max={1000000}
                step={5000}
                value={monthlyVolume}
                onChange={(e) => setMonthlyVolume(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />

              {/* Volume Presets */}
              <div className="flex items-center gap-2 mt-3">
                {VOLUME_PRESETS.map((preset) => (
                  <button
                    key={preset.value}
                    onClick={() => setMonthlyVolume(preset.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                      monthlyVolume === preset.value
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                    }`}
                  >
                    {preset.label}
                    {preset.highlight && <span className="ml-1 text-[10px] text-amber-300">★</span>}
                  </button>
                ))}
              </div>
            </div>

            {/* Maker/Taker Order Blending Slider */}
            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
                  Order Execution Blend
                  <span className="text-xs font-normal text-gray-500">
                    ({makerPercent}% Maker / {100 - makerPercent}% Taker)
                  </span>
                </label>
                <span className="text-xs font-bold text-indigo-600">{makerPercent}% Limit Orders</span>
              </div>
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={makerPercent}
                onChange={(e) => setMakerPercent(Number(e.target.value))}
                className="w-full h-2 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
              />
              <div className="flex justify-between text-[11px] text-gray-400 mt-1">
                <span>100% Market Orders (Pure Taker)</span>
                <span>50 / 50 Blend</span>
                <span>100% Limit Orders (Pure Maker)</span>
              </div>
            </div>
          </div>

          {/* Filter Chips (5 cols) */}
          <div className="lg:col-span-5 flex flex-col justify-between space-y-5 bg-gray-50/70 p-5 rounded-xl border border-gray-100">
            {/* Market Type Switcher */}
            <div>
              <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-2">
                Market Type
              </label>
              <div className="grid grid-cols-3 gap-2">
                {(['all', 'spot', 'futures'] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => setMarketType(m)}
                    className={`py-2 text-xs font-semibold rounded-lg capitalize transition-all ${
                      marketType === m
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
                    }`}
                  >
                    {m}
                  </button>
                ))}
              </div>
            </div>

            {/* Canonical Pair Selector */}
            <div>
              <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-2">
                Trading Pair
              </label>
              <div className="flex flex-wrap gap-1.5">
                {POPULAR_PAIRS.map((p) => (
                  <button
                    key={p}
                    onClick={() => setSelectedPair(p)}
                    className={`px-2.5 py-1 text-xs font-medium rounded-md transition-all ${
                      selectedPair === p
                        ? 'bg-gray-900 text-white'
                        : 'bg-white text-gray-700 hover:bg-gray-100 border border-gray-200'
                    }`}
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>

            {/* Min Spread Filter */}
            <div>
              <label className="text-xs font-bold text-gray-600 uppercase tracking-wider block mb-2">
                Minimum Spread Threshold
              </label>
              <select
                value={minSpreadFilter}
                onChange={(e) => setMinSpreadFilter(Number(e.target.value))}
                className="w-full bg-white border border-gray-200 rounded-lg py-1.5 px-3 text-xs font-medium text-gray-800 focus:ring-2 focus:ring-indigo-500"
              >
                <option value={0}>Any Spread (&gt; 0 bps)</option>
                <option value={1.5}>≥ 1.5 bps</option>
                <option value={2.5}>≥ 2.5 bps</option>
                <option value={5.0}>≥ 5.0 bps</option>
                <option value={15.0}>≥ 15.0 bps (Alert Tier)</option>
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* 4. Opportunities Results Table */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-200 overflow-hidden">
        <div className="p-5 sm:p-6 border-b border-gray-100 flex flex-col sm:flex-row sm:items-center justify-between gap-4">
          <div>
            <h3 className="text-base font-bold text-gray-900">
              Active Arbitrage Opportunities ({computedList.length})
            </h3>
            <p className="text-xs text-gray-500 mt-0.5">
              Ranked by net basis point spread after negotiated ApexOS cashback rebates
            </p>
          </div>

          <div className="flex items-center gap-2">
            <span className="inline-flex items-center gap-1.5 text-xs text-emerald-700 bg-emerald-50 px-2.5 py-1 rounded-full font-medium border border-emerald-200">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Verified Rates
            </span>
          </div>
        </div>

        {computedList.length === 0 ? (
          <div className="p-12 text-center">
            <Layers className="w-12 h-12 text-gray-300 mx-auto mb-3" />
            <p className="text-gray-600 font-semibold">No arbitrage opportunities found</p>
            <p className="text-xs text-gray-400 mt-1">Try widening your filters or lowering the minimum spread.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-gray-50/80 text-xs font-semibold text-gray-500 uppercase tracking-wider border-b border-gray-100">
                <tr>
                  <th className="py-3.5 px-4 sm:px-6">Pair &amp; Market</th>
                  <th className="py-3.5 px-4">Standard Exchange</th>
                  <th className="py-3.5 px-4">ApexOS Recommended</th>
                  <th className="py-3.5 px-4">Net Spread</th>
                  <th className="py-3.5 px-4">Est. Monthly</th>
                  <th className="py-3.5 px-4">Est. Annual</th>
                  <th className="py-3.5 px-4 sm:px-6 text-right">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {computedList.map((opp) => {
                  const targetName =
                    opp.target_exchange.charAt(0).toUpperCase() + opp.target_exchange.slice(1);
                  const baseName =
                    opp.base_exchange.charAt(0).toUpperCase() + opp.base_exchange.slice(1);

                  // Badge coloring based on variant
                  const badgeClass =
                    opp.calc.badgeVariant === 'super'
                      ? 'bg-purple-100 text-purple-800 border-purple-200 font-bold'
                      : opp.calc.badgeVariant === 'success'
                      ? 'bg-emerald-100 text-emerald-800 border-emerald-200 font-bold'
                      : 'bg-blue-50 text-blue-700 border-blue-200';

                  const ctaUrl = `/deals?exchange=${opp.target_exchange}&pair=${encodeURIComponent(
                    opp.pair
                  )}`;

                  return (
                    <tr key={opp.id || `${opp.pair}-${opp.market_type}-${opp.base_exchange}-${opp.target_exchange}`} className="hover:bg-gray-50/80 transition-colors">
                      {/* Pair & Market */}
                      <td className="py-4 px-4 sm:px-6 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <span className="font-bold text-gray-900">{opp.pair}</span>
                          <span
                            className={`text-[10px] font-bold px-2 py-0.5 rounded-full uppercase ${
                              opp.market_type === 'futures'
                                ? 'bg-amber-100 text-amber-800 border border-amber-200'
                                : 'bg-blue-100 text-blue-800 border border-blue-200'
                            }`}
                          >
                            {opp.market_type}
                          </span>
                        </div>
                        <span className="text-[11px] text-gray-400 block mt-0.5">
                          {opp.opportunity_type}
                        </span>
                      </td>

                      {/* Standard Base Exchange */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <div className="font-medium text-gray-700">{baseName}</div>
                        <div className="text-xs text-gray-400">
                          Taker: {(opp.base_taker_fee * 100).toFixed(3)}%
                          {opp.base_cashback_pct > 0 && ` (${opp.base_cashback_pct}% back)`}
                        </div>
                      </td>

                      {/* ApexOS Target Exchange */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <div className="font-bold text-indigo-600 flex items-center gap-1.5">
                          {targetName}
                          <span className="inline-flex items-center px-1.5 py-0.2 rounded bg-indigo-50 text-indigo-700 text-[10px] font-bold border border-indigo-200">
                            +{opp.target_cashback_pct}% back
                          </span>
                        </div>
                        <div className="text-xs text-gray-500">
                          Net: {(opp.net_target_fee * 100).toFixed(4)}%
                        </div>
                      </td>

                      {/* Net Spread */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <span
                          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs border ${badgeClass}`}
                        >
                          +{opp.calc.netSpreadBps.toFixed(2)} bps
                        </span>
                        <span className="text-[11px] text-gray-400 block mt-0.5">
                          {opp.savings_pct.toFixed(1)}% savings
                        </span>
                      </td>

                      {/* Monthly Savings */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <span className="font-semibold text-gray-900">
                          ${opp.calc.monthlySavings.toFixed(2)}
                        </span>
                        <span className="text-xs text-gray-400 block">/month</span>
                      </td>

                      {/* Annual Savings */}
                      <td className="py-4 px-4 whitespace-nowrap">
                        <span className="font-extrabold text-emerald-600">
                          ${opp.calc.annualSavings.toFixed(2)}
                        </span>
                        <span className="text-xs text-gray-400 block">/year</span>
                      </td>

                      {/* Action CTA */}
                      <td className="py-4 px-4 sm:px-6 whitespace-nowrap text-right">
                        <Link
                          href={ctaUrl}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-semibold shadow-sm transition-all active:scale-95"
                        >
                          Claim Deal
                          <ArrowRight className="w-3.5 h-3.5" />
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
