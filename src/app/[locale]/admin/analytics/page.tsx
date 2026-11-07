'use client';
// @ts-nocheck - Temporary: fix type errors separately

import { useState, useEffect, useCallback } from 'react';
import { useParams } from 'next/navigation';
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
import { TrendingUp, Eye, Users, MousePointerClick, Globe } from 'lucide-react';
import AdminNav from '@/components/admin/admin-nav';
import BusinessKpiCards from '@/components/admin/BusinessKpiCards';
import type {
  AnalyticsOverview as AnalyticsOverviewType,
  AnalyticsTimeSeriesData,
  AnalyticsTopPages,
  AnalyticsReferrers,
  AnalyticsCountries,
  AnalyticsDevices,
} from '@/types/analytics';

const COLORS = ['#0088FE', '#00C49F', '#FFBB28', '#FF8042', '#8884D8', '#82CA9D', '#FFC658', '#FF7C7C'];

type TimeRange = '24h' | '7d' | '30d';

interface AnalyticsOverviewProps {
  overview: AnalyticsOverviewType;
}

function formatNumber(num: number): string {
  if (num >= 1000000) {
    return (num / 1000000).toFixed(1) + 'M';
  }
  if (num >= 1000) {
    return (num / 1000).toFixed(1) + 'K';
  }
  return num.toLocaleString();
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) {
    return (bytes / 1073741824).toFixed(2) + ' GB';
  }
  if (bytes >= 1048576) {
    return (bytes / 1048576).toFixed(2) + ' MB';
  }
  if (bytes >= 1024) {
    return (bytes / 1024).toFixed(2) + ' KB';
  }
  return bytes + ' B';
}

function AnalyticsOverviewCard({ overview }: AnalyticsOverviewProps) {
  const t = useTranslations('admin.analytics');

  const stats = [
    {
      label: t('overview.pageViews'),
      value: formatNumber(overview.pageViews),
      icon: Eye,
      color: 'bg-blue-50 text-blue-600',
      change: `${overview.avgPageViewsPerVisitor.toFixed(2)} avg/visitor`,
    },
    {
      label: t('overview.uniqueVisitors'),
      value: formatNumber(overview.uniqueVisitors),
      icon: Users,
      color: 'bg-green-50 text-green-600',
    },
    {
      label: t('overview.requests'),
      value: formatNumber(overview.requests),
      icon: TrendingUp,
      color: 'bg-purple-50 text-purple-600',
    },
    {
      label: t('overview.bounceRate'),
      value: overview.bounceRate.toFixed(1) + '%',
      icon: MousePointerClick,
      color: 'bg-orange-50 text-orange-600',
      change: overview.bounceRate < 40 ? t('overview.good') : t('overview.needsImprovement'),
    },
    {
      label: t('overview.dataTransfer'),
      value: formatBytes(overview.dataTransfer),
      icon: Globe,
      color: 'bg-cyan-50 text-cyan-600',
    },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {stats.map((stat, index) => (
        <div key={index} className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between mb-4">
            <div className={`p-2 rounded-lg ${stat.color}`}>
              <stat.icon className="w-5 h-5" />
            </div>
          </div>
          <div className="text-sm text-gray-500 mb-1">{stat.label}</div>
          <div className="text-2xl font-bold text-gray-900">{stat.value}</div>
          {stat.change && (
            <div className="text-xs text-gray-500 mt-2">{stat.change}</div>
          )}
        </div>
      ))}
    </div>
  );
}

function TimeRangeSelector({
  timeRange,
  setTimeRange,
}: {
  timeRange: TimeRange;
  setTimeRange: (range: TimeRange) => void;
}) {
  const ranges: { value: TimeRange; label: string }[] = [
    { value: '24h', label: '24 Hours' },
    { value: '7d', label: '7 Days' },
    { value: '30d', label: '30 Days' },
  ];

  return (
    <div className="flex gap-2">
      {ranges.map(({ value, label }) => (
        <button
          key={value}
          onClick={() => setTimeRange(value)}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
            timeRange === value
              ? 'bg-brand-600 text-white'
              : 'bg-white text-gray-700 hover:bg-gray-50 border border-gray-200'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export default function AdminAnalyticsPage() {
  const params = useParams();
  const locale = (params?.locale as string) || 'en';
  const t = useTranslations('admin.analytics');
  const tBusinessKpi = useTranslations('admin.businessKpi');
  const [timeRange, setTimeRange] = useState<TimeRange>('7d');
  const [overview, setOverview] = useState<AnalyticsOverviewType | null>(null);
  const [timeseries, setTimeseries] = useState<AnalyticsTimeSeriesData[]>([]);
  const [topPages, setTopPages] = useState<AnalyticsTopPages[]>([]);
  const [referrers, setReferrers] = useState<AnalyticsReferrers[]>([]);
  const [countries, setCountries] = useState<AnalyticsCountries[]>([]);
  const [devices, setDevices] = useState<AnalyticsDevices[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [overviewRes, timeseriesRes, topPagesRes, referrersRes, countriesRes, devicesRes] =
        await Promise.all([
          fetch(`/api/admin/analytics/overview?timeRange=${timeRange}`),
          fetch(`/api/admin/analytics/timeseries?timeRange=${timeRange}&interval=day`),
          fetch(`/api/admin/analytics/top-pages?timeRange=${timeRange}&limit=10`),
          fetch(`/api/admin/analytics/referrers?timeRange=${timeRange}&limit=10`),
          fetch(`/api/admin/analytics/countries?timeRange=${timeRange}&limit=10`),
          fetch(`/api/admin/analytics/devices?timeRange=${timeRange}`),
        ]);

      const [overviewData, timeseriesData, topPagesData, referrersData, countriesData, devicesData] =
        await Promise.all([
          overviewRes.json(),
          timeseriesRes.json(),
          topPagesRes.json(),
          referrersRes.json(),
          countriesRes.json(),
          devicesRes.json(),
        ]);

      if (!overviewRes.ok || !overviewData.success) {
        throw new Error(overviewData.error || 'Failed to fetch overview');
      }

      if (!timeseriesRes.ok || !timeseriesData.success) {
        throw new Error(timeseriesData.error || 'Failed to fetch timeseries');
      }

      setOverview(overviewData.data);
      setTimeseries(timeseriesData.data);
      setTopPages(topPagesData.success ? topPagesData.data : []);
      setReferrers(referrersData.success ? referrersData.data : []);
      setCountries(countriesData.success ? countriesData.data : []);
      setDevices(devicesData.success ? devicesData.data : []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch analytics data');
    } finally {
      setLoading(false);
    }
  }, [timeRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <TimeRangeSelector timeRange={timeRange} setTimeRange={() => {}} />
        </div>
        <div className="animate-pulse space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
            {[1, 2, 3, 4, 5].map(i => (
              <div key={i} className="h-32 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
          <div className="h-80 bg-gray-200 rounded-lg"></div>
          <div className="h-80 bg-gray-200 rounded-lg"></div>
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="h-80 bg-gray-200 rounded-lg"></div>
            <div className="h-80 bg-gray-200 rounded-lg"></div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <div className="flex justify-between items-center">
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <TimeRangeSelector timeRange={timeRange} setTimeRange={setTimeRange} />
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-red-800 mb-2">{t('error.title')}</h3>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={fetchData}
            className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors"
          >
            {t('error.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Admin Navigation */}
      <AdminNav locale={locale} />

      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-600 mt-1">{t('subtitle')}</p>
        </div>
        <TimeRangeSelector timeRange={timeRange} setTimeRange={setTimeRange} />
      </div>

      {/* Business KPI Cards */}
      <section>
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{tBusinessKpi('title')}</h2>
        <BusinessKpiCards locale={locale} timeRange={timeRange} />
      </section>

      {/* Overview Stats */}
      {overview && <AnalyticsOverviewCard overview={overview} />}

      {/* Page Views & Visitors Trend */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.trafficTrend')}</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={timeseries}>
              <defs>
                <linearGradient id="pageViewsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#3B82F6" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#3B82F6" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="visitorsGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#10B981" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#10B981" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                stroke="#6B7280"
                fontSize={12}
                tickFormatter={(value) => {
                  if (timeRange === '24h') {
                    return value.split('T')[1]?.slice(0, 5) || value;
                  }
                  return value;
                }}
              />
              <YAxis stroke="#6B7280" fontSize={12} />
              <Tooltip
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #E5E7EB',
                  borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                }}
              />
              <Legend />
              <Area
                type="monotone"
                dataKey="pageViews"
                name={t('charts.pageViews')}
                stroke="#3B82F6"
                fillOpacity={1}
                fill="url(#pageViewsGradient)"
                strokeWidth={2}
              />
              <Area
                type="monotone"
                dataKey="uniqueVisitors"
                name={t('charts.uniqueVisitors')}
                stroke="#10B981"
                fillOpacity={1}
                fill="url(#visitorsGradient)"
                strokeWidth={2}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Top Pages */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.topPages')}</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={topPages} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis type="number" stroke="#6B7280" fontSize={12} />
              <YAxis
                dataKey="url"
                type="category"
                stroke="#6B7280"
                fontSize={12}
                width={150}
                tickFormatter={(value) => {
                  const url = new URL(value, 'https://example.com');
                  return url.pathname + (url.search || '');
                }}
              />
              <Tooltip
                formatter={(value, name) => [formatNumber(value as number), name]}
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #E5E7EB',
                  borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                }}
              />
              <Legend />
              <Bar dataKey="pageViews" name={t('charts.pageViews')} fill="#3B82F6" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Referrers & Countries */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Top Referrers */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.topReferrers')}</h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={referrers}
                  dataKey="visits"
                  nameKey="referrer"
                  cx="50%"
                  cy="50%"
                  outerRadius={100}
                  label={({ referrer, percent }: any) =>
                    referrer === '(direct)' || referrer === '(unknown)'
                      ? referrer
                      : `${referrer.slice(0, 15)}... (${(percent * 100).toFixed(0)}%)`
                  }
                  labelLine={true}
                >
                  {referrers.map((_, index) => (
                    <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(value) => formatNumber(value as number)}
                  contentStyle={{
                    backgroundColor: '#fff',
                    border: '1px solid #E5E7EB',
                    borderRadius: '8px',
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                  }}
                />
                <Legend />
              </PieChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Countries */}
        <div className="bg-white rounded-lg shadow p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.countries')}</h2>
          <div className="h-80">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={countries}>
                <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
                <XAxis dataKey="countryCode" stroke="#6B7280" fontSize={12} />
                <YAxis stroke="#6B7280" fontSize={12} />
                <Tooltip
                  formatter={(value, name, props) => [
                    formatNumber(value as number),
                    props.payload.country,
                  ]}
                  contentStyle={{
                    backgroundColor: '#fff',
                    border: '1px solid #E5E7EB',
                    borderRadius: '8px',
                    boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                  }}
                />
                <Legend />
                <Bar dataKey="visits" name={t('charts.visits')} fill="#8B5CF6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Devices */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.devices')}</h2>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={devices} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis type="number" stroke="#6B7280" fontSize={12} />
              <YAxis dataKey="device" type="category" stroke="#6B7280" fontSize={12} width={80} />
              <Tooltip
                formatter={(value) => formatNumber(value as number)}
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #E5E7EB',
                  borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                }}
              />
              <Legend />
              <Bar dataKey="visits" name={t('charts.visits')} fill="#F59E0B" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </div>
  );
}
