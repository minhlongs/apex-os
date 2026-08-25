'use client';

import { useCallback, useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  AreaChart,
  Area,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { RefreshCw } from 'lucide-react';
import { error as logError } from '@/lib/logger';

const COLORS = ['#3B82F6', '#10B981', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#F97316', '#6366F1'];

interface BusinessChartsProps {
  locale: string;
  timeRange: '24h' | '7d' | '30d';
}

function getDateRange(timeRange: '24h' | '7d' | '30d'): { date_from: string; date_to: string } {
  const now = new Date();
  const to = now.toISOString().split('T')[0];
  const days = timeRange === '24h' ? 1 : timeRange === '7d' ? 7 : 30;
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  return { date_from: from.toISOString().split('T')[0], date_to: to };
}

interface ApiResponse<T> {
  success: boolean;
  data: T[];
  meta?: { generated_at?: string; cached?: boolean };
  error?: string;
}

interface DealPoint { date: string; total_clicks: number; total_conversions: number; }

interface ExchangeSlice { exchange: string; total_volume: number; total_clicks: number; total_conversions: number; }

interface PairPoint { pair_type: string; exchange: string; total_volume: number; total_conversions: number; }

interface FunnelRow { date: string; visits: number; clicks: number; signups: number; conversions: number; }

function formatCurrency(v: number) {
  if (v >= 1e9) return '$' + (v / 1e9).toFixed(2) + 'B';
  if (v >= 1e6) return '$' + (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
  return '$' + v.toFixed(0);
}

function formatCompact(v: number) {
  if (v >= 1e6) return (v / 1e6).toFixed(1) + 'M';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toLocaleString();
}

export default function BusinessCharts({ locale, timeRange }: BusinessChartsProps) {
  const t = useTranslations('admin.analytics');
  const [dealsData, setDealsData] = useState<DealPoint[]>([]);
  const [exchangeData, setExchangeData] = useState<ExchangeSlice[]>([]);
  const [pairsData, setPairsData] = useState<PairPoint[]>([]);
  const [funnelData, setFunnelData] = useState<FunnelRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchKey, setFetchKey] = useState(0);

  const fetchDeals = useCallback(async (df: string, dt: string): Promise<DealPoint[]> => {
    const res = await fetch(`/api/analytics/deals?date_from=${df}&date_to=${dt}&refresh=true`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to fetch deals');
    }
    const json: ApiResponse<DealPoint> = await res.json();
    if (!json.success || !json.data) {
      throw new Error(json.error || 'Deals API returned no data');
    }
    // API returns DESC, reverse for chronological chart
    return [...json.data].reverse();
  }, []);

  const fetchExchanges = useCallback(async (df: string, dt: string): Promise<{ breakdown: ExchangeSlice[]; pairs: PairPoint[] }> => {
    const res = await fetch(`/api/analytics/exchanges?date_from=${df}&date_to=${dt}&include_top_pairs=true&refresh=true`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to fetch exchanges');
    }
    const json: { success: boolean; breakdown: ExchangeSlice[]; top_pairs: PairPoint[]; meta?: Record<string, unknown>; error?: string } = await res.json();
    if (!json.success) throw new Error(json.error || 'Exchanges API returned no data');
    return { breakdown: json.breakdown || [], pairs: json.top_pairs || [] };
  }, []);

  const fetchFunnel = useCallback(async (df: string, dt: string): Promise<FunnelRow[]> => {
    const res = await fetch(`/api/analytics/funnel?date_from=${df}&date_to=${dt}&refresh=true`, { cache: 'no-store' });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to fetch funnel');
    }
    const json: ApiResponse<FunnelRow> = await res.json();
    if (!json.success || !json.data) {
      throw new Error(json.error || 'Funnel API returned no data');
    }
    // API returns DESC, reverse for chronological chart
    return [...json.data].reverse();
  }, []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    const { date_from, date_to } = getDateRange(timeRange);
    try {
      const [deals, exchanges, funnel] = await Promise.all([
        fetchDeals(date_from, date_to),
        fetchExchanges(date_from, date_to),
        fetchFunnel(date_from, date_to),
      ]);
      setDealsData(deals);
      setExchangeData(exchanges.breakdown);
      setPairsData(exchanges.pairs);
      setFunnelData(funnel);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load business analytics';
      setError(message);
      logError('[BusinessCharts]', message);
    } finally {
      setLoading(false);
    }
  }, [timeRange, fetchDeals, fetchExchanges, fetchFunnel]);

  useEffect(() => { fetchData(); }, [fetchData, fetchKey]);

  const handleRetry = () => setFetchKey((k) => k + 1);

  if (loading) {
    return (
      <div className="space-y-6">
        <p className="text-sm text-gray-500">{t('charts.loadingBusinessAnalytics')}</p>
        <div className="space-y-4">
          <div className="h-80 bg-gray-100 rounded-xl animate-pulse" />
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80 bg-gray-100 rounded-xl animate-pulse" />
            <div className="h-80 bg-gray-100 rounded-xl animate-pulse" />
          </div>
          <div className="h-80 bg-gray-100 rounded-xl animate-pulse" />
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-red-800 mb-2">{t('error.title')}</h3>
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={handleRetry}
          className="inline-flex items-center gap-2 bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
        >
          <RefreshCw className="w-4 h-4" />
          {t('error.retry')}
        </button>
      </div>
    );
  }

  const tooltipStyle = {
    backgroundColor: '#fff',
    border: '1px solid #E5E7EB',
    borderRadius: '8px',
    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
  };

  return (
    <div className="space-y-6">
      {/* Deals Trend */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.dealsTrend')}</h2>
        {dealsData.length === 0 ? (
          <div className="h-80 flex items-center justify-center text-gray-400">{t('charts.noDealsData')}</div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={dealsData}>
                <defs>
                  <linearGradient id="clicksGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="convGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10B981" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis
                  dataKey="date"
                  stroke="#6B7280"
                  fontSize={12}
                  tickFormatter={(v: string) => {
                    const d = new Date(v);
                    if (timeRange === '24h') return d.toLocaleTimeString(locale === 'vi' ? 'vi-VN' : 'en-US', { hour: '2-digit', minute: '2-digit' });
                    return d.toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', { month: 'short', day: 'numeric' });
                  }}
                />
                <YAxis stroke="#6B7280" fontSize={12} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [formatCompact(v), n === 'total_clicks' ? t('charts.totalClicks') : t('charts.totalConversions')]} />
                <Legend formatter={(v: string) => v === 'total_clicks' ? t('charts.totalClicks') : t('charts.totalConversions')} />
                <Area type="monotone" dataKey="total_clicks" stroke="#3B82F6" fill="url(#clicksGrad)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#3B82F6' }} />
                <Area type="monotone" dataKey="total_conversions" stroke="#10B981" fill="url(#convGrad)" strokeWidth={2} dot={false} activeDot={{ r: 4, fill: '#10B981' }} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>

      {/* Exchange Breakdown + Top Pairs */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.exchangesBreakdown')}</h2>
          {exchangeData.length === 0 ? (
            <div className="h-80 flex items-center justify-center text-gray-400">{t('charts.noExchangesData')}</div>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={exchangeData}
                    dataKey="total_volume"
                    nameKey="exchange"
                    cx="50%"
                    cy="50%"
                    outerRadius={100}
          label={({ name, percent }: { name?: string; percent?: number }) => {
  const pct = typeof percent === 'number' ? (percent * 100).toFixed(0) : '0';
  const lbl = typeof name === 'string' ? name : '';
  return `${lbl.slice(0, 12)} (${pct}%)`;
}}
                  >
                    {exchangeData.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
                  </Pie>
                  <Tooltip formatter={(v: number) => [formatCompact(v), 'Volume']} contentStyle={tooltipStyle} />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.topPairsTitle')}</h2>
          {pairsData.length === 0 ? (
            <div className="h-80 flex items-center justify-center text-gray-400">{t('charts.noPairsData')}</div>
          ) : (
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pairsData.slice(0, 10)} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                  <XAxis type="number" stroke="#6B7280" fontSize={12} tickFormatter={(v: number) => formatCompact(v)} />
                  <YAxis dataKey="pair_type" type="category" stroke="#6B7280" fontSize={12} width={100} />
                  <Tooltip formatter={(v: number) => [formatCurrency(v), 'Volume']} contentStyle={tooltipStyle} />
                  <Legend />
                  <Bar dataKey="total_volume" fill="#8B5CF6" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      {/* Funnel */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.conversionFunnel')}</h2>
        {funnelData.length === 0 ? (
          <div className="h-80 flex items-center justify-center text-gray-400">{t('charts.noFunnelData')}</div>
        ) : (
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={funnelData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis dataKey="date" stroke="#6B7280" fontSize={12} tickFormatter={(v: string) => new Date(v).toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', { month: 'short', day: 'numeric' })} />
                <YAxis stroke="#6B7280" fontSize={12} />
                <Tooltip contentStyle={tooltipStyle} formatter={(v: number, n: string) => [formatCompact(v), n === 'visits' ? t('charts.funnelVisits') : n === 'clicks' ? t('charts.funnelClicks') : n === 'signups' ? t('charts.funnelSignups') : t('charts.funnelConversions')]} />
                <Legend formatter={(v: string) => v === 'visits' ? t('charts.funnelVisits') : v === 'clicks' ? t('charts.funnelClicks') : v === 'signups' ? t('charts.funnelSignups') : t('charts.funnelConversions')} />
                <Bar dataKey="visits" fill={COLORS[0]} radius={[4, 4, 0, 0]} name="visits" />
                <Bar dataKey="clicks" fill={COLORS[1]} radius={[4, 4, 0, 0]} name="clicks" />
                <Bar dataKey="signups" fill={COLORS[2]} radius={[4, 4, 0, 0]} name="signups" />
                <Bar dataKey="conversions" fill={COLORS[3]} radius={[4, 4, 0, 0]} name="conversions" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </div>
  );
}
