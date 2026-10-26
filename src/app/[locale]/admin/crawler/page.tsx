'use client';

/**
 * src/app/[locale]/admin/crawler/page.tsx
 *
 * Admin Exchange Crawler & Arbitrage Management Dashboard
 * Features:
 * - Real-time crawler system status (Operational / Degraded)
 * - Exchange status cards (Binance, Bybit, OKX, KuCoin) with rate card counts & last sync
 * - Manual crawl trigger across all exchanges or per-exchange
 * - Recent crawler sync runs table with run_id, items count, duration, and error alerts
 * - Key performance metrics: total rate cards, error rates, active opportunities
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import {
  Play,
  RefreshCw,
  Activity,
  AlertTriangle,
  CheckCircle,
  Clock,
  Layers,
  Zap,
  TrendingUp,
  AlertCircle,
  ExternalLink,
  ChevronRight,
  ShieldAlert,
} from 'lucide-react';
import AdminNav from '@/components/admin/admin-nav';

interface ExchangeStatusSummary {
  rate_cards_count: number;
  last_sync: string | null;
  status: 'healthy' | 'degraded' | 'syncing';
}

interface SyncRunItem {
  id?: string;
  run_id: string;
  exchange: string;
  status: 'success' | 'failed' | 'running';
  items_count: number;
  duration_ms: number;
  error_message?: string | null;
  created_at: string;
}

interface CrawlerStatusData {
  status: 'operational' | 'degraded';
  timestamp: string;
  exchanges: Record<string, ExchangeStatusSummary>;
  recent_sync_runs: SyncRunItem[];
  metrics: {
    total_rate_cards: number;
    total_sync_runs: number;
    error_rate_pct: number;
    active_arbitrage_opportunities: number;
  };
}

const SUPPORTED_EXCHANGES = [
  { id: 'binance', name: 'Binance', logo: '🟡', desc: 'Spot, Futures taker/maker & VIP tiers' },
  { id: 'bybit', name: 'Bybit', logo: '🟠', desc: 'Perpetual & Spot discount structures' },
  { id: 'okx', name: 'OKX', logo: '⚪', desc: 'Multi-tier fee structure & VIP volume' },
  { id: 'kucoin', name: 'KuCoin', logo: '🟢', desc: 'Contract & Spot trading fee schedules' },
];

export default function AdminCrawlerPage() {
  const params = useParams();
  const locale = (params?.locale as string) || 'en';

  const [loading, setLoading] = useState<boolean>(true);
  const [triggering, setTriggering] = useState<boolean>(false);
  const [triggeringExchange, setTriggeringExchange] = useState<string | null>(null);
  const [statusData, setStatusData] = useState<CrawlerStatusData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastActionResult, setLastActionResult] = useState<string | null>(null);

  // Fetch status from API
  const fetchStatus = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const res = await fetch('/api/admin/crawler/status');
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Admin authorization required. Please log in with admin privileges.');
        }
        throw new Error(`Failed to load crawler status (HTTP ${res.status})`);
      }
      const json = await res.json();
      if (json.success && json.data) {
        setStatusData(json.data);
      } else {
        throw new Error(json.error || 'Invalid crawler status response');
      }
    } catch (err: any) {
      setError(err.message || 'Error fetching crawler status');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStatus();
  }, [fetchStatus]);

  // Trigger manual crawl
  const handleTriggerCrawl = async (exchanges?: string[]) => {
    try {
      if (exchanges && exchanges.length === 1) {
        setTriggeringExchange(exchanges[0]);
      } else {
        setTriggering(true);
      }
      setLastActionResult(null);
      setError(null);

      const payload = exchanges ? { exchanges, force_refresh: true } : { force_refresh: true };
      const res = await fetch('/api/admin/crawler/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error || `Crawl failed with HTTP ${res.status}`);
      }

      const json = await res.json();
      const count = json.data?.rate_cards_synced || 0;
      const opps = json.data?.opportunities_found || 0;
      const duration = json.data?.duration_ms || 0;
      setLastActionResult(
        `Crawl executed successfully: ${count} rate cards synced, ${opps} arbitrage opportunities analyzed in ${duration}ms (Run ID: ${json.data?.run_id || 'batch'}).`
      );

      // Refresh status after crawl
      await fetchStatus();
    } catch (err: any) {
      setError(err.message || 'Failed to trigger crawler run');
    } finally {
      setTriggering(false);
      setTriggeringExchange(null);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 pb-16">
      <AdminNav locale={locale} />

      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* Header & Controls */}
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
          <div>
            <div className="flex items-center gap-3">
              <h1 className="text-3xl font-extrabold text-gray-900 tracking-tight">
                Exchange Crawler & Arbitrage Engine
              </h1>
              {statusData && (
                <span
                  className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-semibold ${
                    statusData.status === 'operational'
                      ? 'bg-emerald-100 text-emerald-800 border border-emerald-300'
                      : 'bg-amber-100 text-amber-800 border border-amber-300'
                  }`}
                >
                  <span
                    className={`w-2 h-2 rounded-full mr-1.5 ${
                      statusData.status === 'operational' ? 'bg-emerald-500' : 'bg-amber-500'
                    }`}
                  />
                  {statusData.status.toUpperCase()}
                </span>
              )}
            </div>
            <p className="mt-1 text-sm text-gray-600">
              Automated fee indexing across Binance, Bybit, OKX, and KuCoin with live arbitrage yield matrix computation.
            </p>
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={fetchStatus}
              disabled={loading || triggering}
              className="inline-flex items-center px-3.5 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-lg text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              <RefreshCw className={`w-4 h-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </button>
            <button
              onClick={() => handleTriggerCrawl()}
              disabled={triggering || loading}
              className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-lg shadow-sm text-white bg-indigo-600 hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-indigo-500 disabled:opacity-50"
            >
              <Play className={`w-4 h-4 mr-2 ${triggering ? 'animate-pulse' : ''}`} />
              {triggering ? 'Crawling Exchanges...' : 'Trigger Full Crawl'}
            </button>
          </div>
        </div>

        {/* Action Messages */}
        {error && (
          <div className="mb-6 rounded-lg bg-rose-50 border border-rose-200 p-4 flex items-start gap-3">
            <AlertCircle className="w-5 h-5 text-rose-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-rose-800">
              <span className="font-semibold">Error: </span>
              {error}
            </div>
          </div>
        )}

        {lastActionResult && (
          <div className="mb-6 rounded-lg bg-emerald-50 border border-emerald-200 p-4 flex items-start gap-3">
            <CheckCircle className="w-5 h-5 text-emerald-600 flex-shrink-0 mt-0.5" />
            <div className="text-sm text-emerald-800">
              <span className="font-semibold">Success: </span>
              {lastActionResult}
            </div>
          </div>
        )}

        {/* Metrics Grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Indexed Rate Cards
              </span>
              <Layers className="w-5 h-5 text-indigo-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-gray-900">
              {statusData?.metrics.total_rate_cards ?? '--'}
            </div>
            <p className="mt-1 text-xs text-gray-500">Across spot & futures market tiers</p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Active Arbitrage Ops
              </span>
              <Zap className="w-5 h-5 text-amber-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-gray-900">
              {statusData?.metrics.active_arbitrage_opportunities ?? '--'}
            </div>
            <p className="mt-1 text-xs text-gray-500">Spread ≥ 5 bps with affiliate deal routing</p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Crawler Error Rate
              </span>
              <Activity className="w-5 h-5 text-emerald-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-gray-900">
              {statusData?.metrics.error_rate_pct != null
                ? `${statusData.metrics.error_rate_pct}%`
                : '--'}
            </div>
            <p className="mt-1 text-xs text-gray-500">Over recent sync execution history</p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
                Total Sync Runs
              </span>
              <Clock className="w-5 h-5 text-blue-500" />
            </div>
            <div className="mt-2 text-2xl font-bold text-gray-900">
              {statusData?.metrics.total_sync_runs ?? '--'}
            </div>
            <p className="mt-1 text-xs text-gray-500">Persisted in crawler_sync_runs</p>
          </div>
        </div>

        {/* Exchange Health Cards */}
        <h2 className="text-lg font-bold text-gray-900 mb-4 flex items-center gap-2">
          <span>Connected Exchanges</span>
          <span className="text-xs font-normal text-gray-500">(4 Adapters Active)</span>
        </h2>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5 mb-8">
          {SUPPORTED_EXCHANGES.map((ex) => {
            const exchangeStats = statusData?.exchanges?.[ex.id];
            const isSyncingThis = triggeringExchange === ex.id;

            return (
              <div
                key={ex.id}
                className="bg-white rounded-xl border border-gray-200 p-5 shadow-sm flex flex-col justify-between"
              >
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{ex.logo}</span>
                      <h3 className="font-bold text-gray-900">{ex.name}</h3>
                    </div>
                    <span
                      className={`text-xs px-2 py-0.5 rounded-full font-semibold ${
                        exchangeStats?.status === 'healthy' || exchangeStats?.rate_cards_count
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-gray-100 text-gray-600'
                      }`}
                    >
                      {exchangeStats?.rate_cards_count ? 'ONLINE' : 'PENDING'}
                    </span>
                  </div>
                  <p className="text-xs text-gray-500 mb-4">{ex.desc}</p>

                  <div className="space-y-1.5 text-xs text-gray-600 border-t border-gray-100 pt-3">
                    <div className="flex justify-between">
                      <span className="text-gray-500">Rate Cards:</span>
                      <span className="font-semibold text-gray-900">
                        {exchangeStats?.rate_cards_count ?? 0}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-500">Last Synced:</span>
                      <span className="font-mono text-gray-700">
                        {exchangeStats?.last_sync
                          ? new Date(exchangeStats.last_sync).toLocaleTimeString()
                          : 'Never'}
                      </span>
                    </div>
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-gray-100">
                  <button
                    onClick={() => handleTriggerCrawl([ex.id])}
                    disabled={isSyncingThis || triggering || loading}
                    className="w-full inline-flex items-center justify-center px-3 py-1.5 border border-gray-300 text-xs font-medium rounded-lg text-gray-700 bg-gray-50 hover:bg-gray-100 disabled:opacity-50"
                  >
                    <RefreshCw
                      className={`w-3.5 h-3.5 mr-1.5 ${isSyncingThis ? 'animate-spin' : ''}`}
                    />
                    {isSyncingThis ? 'Crawling...' : `Crawl ${ex.name}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>

        {/* Recent Sync Runs Table */}
        <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden mb-8">
          <div className="px-6 py-4 border-b border-gray-200 flex items-center justify-between">
            <div>
              <h2 className="text-base font-bold text-gray-900">Recent Crawler Sync Runs</h2>
              <p className="text-xs text-gray-500">
                Audited crawler execution logs, duration benchmarks, and error diagnostics
              </p>
            </div>
            <Link
              href={`/${locale}/deals?tab=arbitrage`}
              className="text-xs font-semibold text-indigo-600 hover:text-indigo-800 flex items-center gap-1"
            >
              <span>View Public Matrix</span>
              <ChevronRight className="w-3.5 h-3.5" />
            </Link>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-left">
              <thead className="bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
                <tr>
                  <th className="px-6 py-3">Run ID</th>
                  <th className="px-6 py-3">Exchange</th>
                  <th className="px-6 py-3">Status</th>
                  <th className="px-6 py-3">Items Synced</th>
                  <th className="px-6 py-3">Duration</th>
                  <th className="px-6 py-3">Executed At</th>
                  <th className="px-6 py-3">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 text-sm">
                {!statusData?.recent_sync_runs || statusData.recent_sync_runs.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-gray-500">
                      No crawler runs recorded yet. Click &quot;Trigger Full Crawl&quot; to initialize data.
                    </td>
                  </tr>
                ) : (
                  statusData.recent_sync_runs.map((run, idx) => {
                    const isSuccess = run.status === 'success';
                    return (
                      <tr key={run.id || `${run.run_id}-${idx}`} className="hover:bg-gray-50">
                        <td className="px-6 py-3.5 font-mono text-xs text-gray-700">
                          {run.run_id.length > 24 ? `${run.run_id.slice(0, 24)}...` : run.run_id}
                        </td>
                        <td className="px-6 py-3.5 font-semibold text-gray-900 capitalize">
                          {run.exchange}
                        </td>
                        <td className="px-6 py-3.5">
                          <span
                            className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                              isSuccess
                                ? 'bg-emerald-100 text-emerald-800'
                                : 'bg-rose-100 text-rose-800'
                            }`}
                          >
                            {isSuccess ? (
                              <CheckCircle className="w-3 h-3 mr-1 text-emerald-600" />
                            ) : (
                              <AlertTriangle className="w-3 h-3 mr-1 text-rose-600" />
                            )}
                            {run.status.toUpperCase()}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-gray-700">
                          {run.items_count} cards
                        </td>
                        <td className="px-6 py-3.5 text-gray-600 font-mono text-xs">
                          {run.duration_ms}ms
                        </td>
                        <td className="px-6 py-3.5 text-gray-500 text-xs">
                          {new Date(run.created_at).toLocaleString()}
                        </td>
                        <td className="px-6 py-3.5 text-xs text-gray-500">
                          {run.error_message ? (
                            <span className="text-rose-600 font-medium">{run.error_message}</span>
                          ) : (
                            <span className="text-gray-400">All checks passed</span>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      </main>
    </div>
  );
}
