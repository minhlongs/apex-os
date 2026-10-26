'use client';

/**
 * src/components/admin/treasury/treasury-dashboard-client.tsx
 *
 * Interactive Admin Multi-Chain Treasury & Payout Preview Dashboard
 * Connects to:
 *   - GET /api/admin/payouts/treasury
 *   - POST /api/admin/payouts/batch (action: 'preview' | 'execute')
 */

import React, { useState, useEffect, useCallback } from 'react';
import {
  Wallet,
  RefreshCw,
  CheckCircle,
  AlertTriangle,
  AlertOctagon,
  Play,
  Eye,
  ShieldCheck,
  Clock,
  Layers,
} from 'lucide-react';
import AdminNav from '@/components/admin/admin-nav';
import type {
  SupportedPayoutChain,
  TreasuryHealthReport,
  BatchPreviewResult,
  BatchExecutionResult,
} from '@/lib/payouts/types';
import { getHealthBadgeStyle, formatChainDisplayName } from './treasury-helpers';

export { getHealthBadgeStyle, formatChainDisplayName };

export interface PendingQueuesSummary {
  unpaidEarnings: {
    totalCount: number;
    totalAmount: number;
    byChain: Record<SupportedPayoutChain, { count: number; totalAmount: number }>;
  };
  pendingBatches: {
    pendingCount: number;
    processingCount: number;
    totalPendingCount: number;
  };
  inFlightPayouts: {
    totalCount: number;
    totalAmount: number;
    byChain: Record<
      SupportedPayoutChain,
      { pendingCount: number; processingCount: number; count: number; totalAmount: number }
    >;
  };
}

export interface TreasuryApiResponse {
  success: boolean;
  treasuryHealth: TreasuryHealthReport;
  pendingQueues: PendingQueuesSummary;
  timestamp: string;
  error?: string;
}

interface TreasuryDashboardClientProps {
  locale: string;
}

export function TreasuryDashboardClient({ locale }: TreasuryDashboardClientProps) {
  const [treasuryData, setTreasuryData] = useState<TreasuryApiResponse | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const [selectedChain, setSelectedChain] = useState<SupportedPayoutChain | 'all'>('all');
  const [minThreshold, setMinThreshold] = useState<string>('50');
  const [batchLimit, setBatchLimit] = useState<string>('50');

  const [previewResult, setPreviewResult] = useState<BatchPreviewResult | null>(null);
  const [executionResult, setExecutionResult] = useState<BatchExecutionResult | null>(null);
  const [actionLoading, setActionLoading] = useState<boolean>(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const fetchTreasuryStatus = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch('/api/admin/payouts/treasury');
      const json = (await response.json()) as TreasuryApiResponse;
      if (!response.ok || !json.success) {
        throw new Error(json.error || 'Failed to load treasury status');
      }
      setTreasuryData(json);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Unable to fetch treasury health';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchTreasuryStatus();
  }, [fetchTreasuryStatus]);

  const handleBatchAction = async (action: 'preview' | 'execute', dryRun: boolean) => {
    setActionLoading(true);
    setActionError(null);
    try {
      const parsedThreshold = parseFloat(minThreshold);
      const parsedLimit = parseInt(batchLimit, 10);

      const response = await fetch('/api/admin/payouts/batch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          chain: selectedChain,
          minThreshold: Number.isFinite(parsedThreshold) ? parsedThreshold : 50,
          limit: Number.isInteger(parsedLimit) ? parsedLimit : 50,
          dryRun,
        }),
      });

      const json = (await response.json()) as {
        success: boolean;
        data?: BatchPreviewResult | BatchExecutionResult;
        error?: string;
      };

      if (!response.ok || !json.success) {
        throw new Error(json.error || `Failed to ${action} payout batch`);
      }

      if (action === 'preview' && json.data) {
        setPreviewResult(json.data as BatchPreviewResult);
        setExecutionResult(null);
      } else if (action === 'execute' && json.data) {
        setExecutionResult(json.data as BatchExecutionResult);
        await fetchTreasuryStatus();
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Batch operation failed';
      setActionError(msg);
    } finally {
      setActionLoading(false);
    }
  };

  const health = treasuryData?.treasuryHealth;
  const queues = treasuryData?.pendingQueues;
  const chains: SupportedPayoutChain[] = ['stellar', 'ethereum', 'solana'];

  return (
    <div>
      <AdminNav locale={locale} />

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between mb-6 gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 flex items-center gap-2">
            <Wallet className="w-7 h-7 text-indigo-600" />
            <span>Multi-Chain Treasury & Settlement Rails</span>
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            Inspect Stellar, Ethereum, and Solana hot-wallet reserves, circuit-breaker gates, and execute batch payouts.
          </p>
        </div>

        <button
          type="button"
          onClick={fetchTreasuryStatus}
          disabled={loading}
          className="inline-flex items-center px-4 py-2 border border-gray-300 rounded-lg shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          Refresh Reserves
        </button>
      </div>

      {error ? (
        <div className="mb-6 rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-center gap-2">
          <AlertOctagon className="w-5 h-5 shrink-0" />
          <span>{error}</span>
        </div>
      ) : null}

      {/* Global Circuit Breaker Banner */}
      {health ? (
        <div
          className={`mb-6 rounded-xl border p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 ${getHealthBadgeStyle(
            health.globalStatus
          )}`}
        >
          <div className="flex items-center gap-3">
            {health.canSettle ? (
              <CheckCircle className="w-6 h-6 text-emerald-600 shrink-0" />
            ) : (
              <AlertTriangle className="w-6 h-6 text-red-600 shrink-0" />
            )}
            <div>
              <div className="font-semibold text-base">
                Global Treasury Status: {health.globalStatus} —{' '}
                {health.canSettle ? 'Settlement Rails Armed' : 'Circuit Breaker Paused'}
              </div>
              <div className="text-xs opacity-80">
                Last verified: {new Date(health.checkedAt).toLocaleString()}
              </div>
            </div>
          </div>
          <span className="inline-flex items-center px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider bg-white/80 border">
            {health.canSettle ? 'CAN SETTLE: TRUE' : 'CAN SETTLE: FALSE'}
          </span>
        </div>
      ) : null}

      {/* Per-Chain Treasury Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 mb-8">
        {chains.map((chainKey) => {
          const chainHealth = health?.chains?.[chainKey];
          const unpaid = queues?.unpaidEarnings?.byChain?.[chainKey];
          const inFlight = queues?.inFlightPayouts?.byChain?.[chainKey];

          return (
            <div
              key={chainKey}
              className="bg-white rounded-xl border border-gray-200 shadow-sm p-5 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-center justify-between mb-3">
                  <h2 className="text-lg font-bold text-gray-900">
                    {formatChainDisplayName(chainKey)}
                  </h2>
                  {chainHealth ? (
                    <span
                      className={`px-2.5 py-0.5 rounded-full text-xs font-semibold border ${getHealthBadgeStyle(
                        chainHealth.status
                      )}`}
                    >
                      {chainHealth.status}
                    </span>
                  ) : null}
                </div>

                <div className="text-xs text-gray-500 font-mono truncate mb-4" title={chainHealth?.hotWalletAddress}>
                  Hot Wallet: {chainHealth?.hotWalletAddress || 'Not configured'}
                </div>

                <div className="space-y-2 text-sm border-t border-gray-100 pt-3">
                  <div className="flex justify-between">
                    <span className="text-gray-500">USDC Reserve:</span>
                    <span className="font-semibold text-gray-900">
                      ${(chainHealth?.stablecoinBalance ?? 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Reserve Floor:</span>
                    <span className="text-gray-700">
                      ${(chainHealth?.stablecoinReserveFloor ?? 0).toLocaleString()}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">Native Gas:</span>
                    <span className="font-medium text-gray-900">
                      {(chainHealth?.nativeGasBalance ?? 0).toFixed(4)} {chainHealth?.nativeGasSymbol || ''}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-gray-500">RPC Node:</span>
                    <span className={chainHealth?.rpcHealthy ? 'text-emerald-600 font-medium' : 'text-red-600 font-medium'}>
                      {chainHealth?.rpcHealthy ? 'Connected' : 'Unreachable'}
                    </span>
                  </div>
                </div>
              </div>

              <div className="mt-4 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2 text-xs">
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="text-gray-500">Unpaid Queue</div>
                  <div className="font-bold text-gray-900 mt-0.5">
                    {unpaid?.count ?? 0} (${(unpaid?.totalAmount ?? 0).toFixed(2)})
                  </div>
                </div>
                <div className="bg-gray-50 rounded-lg p-2">
                  <div className="text-gray-500">In-Flight</div>
                  <div className="font-bold text-gray-900 mt-0.5">
                    {inFlight?.count ?? 0} (${(inFlight?.totalAmount ?? 0).toFixed(2)})
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Batch Settlement Preview & Execution Control Panel */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6 mb-8">
        <div className="flex items-center gap-2 mb-4">
          <Layers className="w-5 h-5 text-indigo-600" />
          <h2 className="text-lg font-bold text-gray-900">
            Batch Settlement Preview & Execution
          </h2>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-4">
          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase mb-1">
              Target Chain
            </label>
            <select
              value={selectedChain}
              onChange={(e) => setSelectedChain(e.target.value as SupportedPayoutChain | 'all')}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
            >
              <option value="all">All Chains (Stellar + Ethereum + Solana)</option>
              <option value="stellar">Stellar Only</option>
              <option value="ethereum">Ethereum Only</option>
              <option value="solana">Solana Only</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase mb-1">
              Min Threshold (USD)
            </label>
            <input
              type="number"
              min="0"
              step="1"
              value={minThreshold}
              onChange={(e) => setMinThreshold(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-gray-600 uppercase mb-1">
              Max Affiliates Limit
            </label>
            <input
              type="number"
              min="1"
              max="500"
              value={batchLimit}
              onChange={(e) => setBatchLimit(e.target.value)}
              className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            disabled={actionLoading}
            onClick={() => handleBatchAction('preview', true)}
            className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Eye className="w-4 h-4 mr-2" />
            Preview Eligible Batch
          </button>

          <button
            type="button"
            disabled={actionLoading}
            onClick={() => handleBatchAction('execute', true)}
            className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4 mr-2" />
            Execute Dry-Run Settlement
          </button>

          <button
            type="button"
            disabled={actionLoading || (health ? !health.canSettle : false)}
            onClick={() => handleBatchAction('execute', false)}
            className="inline-flex items-center px-4 py-2 rounded-lg text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <Play className="w-4 h-4 mr-2" />
            Execute Live On-Chain Batch
          </button>
        </div>

        {actionError ? (
          <div className="mt-4 rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">
            {actionError}
          </div>
        ) : null}

        {/* Preview Summary Table */}
        {previewResult ? (
          <div className="mt-6 border-t border-gray-200 pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
              <h3 className="text-sm font-bold text-gray-900">
                Preview Batch: {previewResult.batchNumber}
              </h3>
              <span className="text-xs text-gray-600">
                Eligible Affiliates: <strong>{previewResult.eligibleAffiliatesCount}</strong> | Total Net:{' '}
                <strong>${previewResult.totalNetAmountUsd.toFixed(2)}</strong> | Est. Gas:{' '}
                <strong>${previewResult.totalEstimatedGasFeeUsd.toFixed(4)}</strong>
              </span>
            </div>

            {previewResult.payoutsPreview.length === 0 ? (
              <p className="text-sm text-gray-500 py-4">
                No unpaid affiliate earnings currently meet the minimum threshold.
              </p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-gray-200 text-sm">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Affiliate</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Chain</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Recipient</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-600">Net USD</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Compliance</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {previewResult.payoutsPreview.map((item) => (
                      <tr key={item.affiliateId}>
                        <td className="px-3 py-2 font-medium text-gray-900">
                          {item.affiliateEmail || item.affiliateId}
                        </td>
                        <td className="px-3 py-2 uppercase text-xs font-bold text-gray-700">
                          {item.chain}
                        </td>
                        <td className="px-3 py-2 font-mono text-xs text-gray-600">
                          {item.recipientAddress.slice(0, 8)}...{item.recipientAddress.slice(-6)}
                        </td>
                        <td className="px-3 py-2 text-right font-semibold text-gray-900">
                          ${item.netAmount.toFixed(2)}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-800 font-medium">
                            {item.complianceStatus || 'clean'}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        ) : null}

        {/* Execution Result Summary */}
        {executionResult ? (
          <div className="mt-6 border-t border-gray-200 pt-4">
            <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-900">
              <div className="font-bold flex items-center gap-2">
                <Clock className="w-4 h-4" />
                <span>
                  Batch {executionResult.batchNumber} ({executionResult.dryRun ? 'Dry-Run' : 'Live'}) — Status:{' '}
                  {executionResult.status.toUpperCase()}
                </span>
              </div>
              <div className="mt-1 text-xs">
                Total Payouts: {executionResult.totalPayouts} | Succeeded: {executionResult.successfulPayouts} | Failed:{' '}
                {executionResult.failedPayouts} | Disbursed: ${executionResult.totalAmount.toFixed(2)}
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
