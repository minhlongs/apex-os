'use client';

import React from 'react';
import {
  AlertTriangle,
  Clock,
  Ban,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from 'lucide-react';
import { FraudStatsSummary } from '@/types/fraud';

interface FraudKpiCardsProps {
  stats: FraudStatsSummary & { activeBlockedIps?: number; fraudRate24h?: number };
  isLoading?: boolean;
}

export const FraudKpiCards: React.FC<FraudKpiCardsProps> = ({
  stats,
  isLoading = false,
}) => {
  // Boundary calculations (F10-B2: 0% on no clicks, F10-B3: 100% when all suspicious)
  const totalClicks = stats.totalClicksEvaluated ?? 0;
  const flaggedClicks = stats.totalFlaggedClicks ?? 0;
  const fraudRate =
    totalClicks > 0
      ? Math.min(100, Math.max(0, Math.round((flaggedClicks / totalClicks) * 10000) / 100))
      : 0;

  const pendingReviews = stats.pendingReviews ?? 0;
  const activeBlockedIps = stats.activeBlockedIps ?? 0;
  const totalBlockedIps = stats.totalBlockedIps ?? 0;

  // Estimated platform capital saved ($30 avg commission * flagged clicks)
  const estimatedSavingsUsd = flaggedClicks * 30;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 my-6">
      {/* 1. Flagged Clicks */}
      <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm relative overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Flagged Clicks
          </span>
          <div className="p-2 bg-red-50 text-red-600 rounded-lg">
            <AlertTriangle className="w-5 h-5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-extrabold text-gray-900">
            {isLoading ? '...' : flaggedClicks.toLocaleString()}
          </span>
          <span className="text-xs font-medium text-gray-500">
            / {totalClicks.toLocaleString()} total
          </span>
        </div>
        <div className="mt-3 flex items-center text-xs text-red-600 font-medium gap-1">
          <TrendingUp className="w-3.5 h-3.5" />
          <span>{fraudRate.toFixed(1)}% of evaluated traffic</span>
        </div>
      </div>

      {/* 2. Pending Reviews */}
      <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm relative overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Pending Reviews
          </span>
          <div className="p-2 bg-amber-50 text-amber-600 rounded-lg">
            <Clock className="w-5 h-5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-extrabold text-gray-900">
            {isLoading ? '...' : pendingReviews.toLocaleString()}
          </span>
          {pendingReviews > 0 && (
            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
              Action Required
            </span>
          )}
        </div>
        <div className="mt-3 text-xs text-gray-500">
          <span>{stats.approvedReviews ?? 0} approved • {stats.rejectedReviews ?? 0} rejected</span>
        </div>
      </div>

      {/* 3. Blocked IPs */}
      <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm relative overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Active Blocked IPs
          </span>
          <div className="p-2 bg-purple-50 text-purple-600 rounded-lg">
            <Ban className="w-5 h-5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-extrabold text-gray-900">
            {isLoading ? '...' : activeBlockedIps.toLocaleString()}
          </span>
          <span className="text-xs font-medium text-gray-500">
            / {totalBlockedIps.toLocaleString()} total
          </span>
        </div>
        <div className="mt-3 flex items-center text-xs text-purple-700 font-medium gap-1">
          <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
          <span>Active Edge Blacklist Enforcement</span>
        </div>
      </div>

      {/* 4. Estimated Fraud Prevented */}
      <div className="bg-white rounded-xl p-5 border border-gray-200 shadow-sm relative overflow-hidden">
        <div className="flex items-center justify-between">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
            Estimated Fraud Prevented
          </span>
          <div className="p-2 bg-emerald-50 text-emerald-600 rounded-lg">
            <ShieldCheck className="w-5 h-5" />
          </div>
        </div>
        <div className="mt-2 flex items-baseline gap-2">
          <span className="text-3xl font-extrabold text-emerald-600">
            {isLoading ? '...' : `$${estimatedSavingsUsd.toLocaleString()}`}
          </span>
          <span className="text-xs font-medium text-gray-500">USD</span>
        </div>
        <div className="mt-3 flex items-center text-xs text-emerald-700 font-medium gap-1">
          <TrendingDown className="w-3.5 h-3.5" />
          <span>Capital saved from fraudulent attribution</span>
        </div>
      </div>
    </div>
  );
};
