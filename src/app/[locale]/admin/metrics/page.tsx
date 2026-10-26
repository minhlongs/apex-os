'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  CartesianGrid,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Calendar, RefreshCw, TrendingUp, Users, MousePointerClick, Target, DollarSign, Award } from 'lucide-react';
import AdminNav from '@/components/admin/admin-nav';
import type { BusinessMetricsResponse } from '@/types/metrics';

type DateRange = {
  start_date: string;
  end_date: string;
};

export default function BusinessMetricsPage({ locale }: { locale: string }) {
  const t = useTranslations('admin.metrics');
  const [dateRange, setDateRange] = useState<DateRange>(() => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);
    return {
      start_date: start.toISOString().split('T')[0],
      end_date: end.toISOString().split('T')[0],
    };
  });
  const [tempStartDate, setTempStartDate] = useState(dateRange.start_date);
  const [tempEndDate, setTempEndDate] = useState(dateRange.end_date);
  const [data, setData] = useState<BusinessMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const params = new URLSearchParams({
        start_date: dateRange.start_date,
        end_date: dateRange.end_date,
      });

      const response = await fetch(`/api/metrics/business?${params}`, {
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error || 'Failed to fetch metrics');
      }

      const result = await response.json();
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [dateRange]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const applyDateRange = () => {
    const start = new Date(tempStartDate);
    const end = new Date(tempEndDate);

    if (start > end) {
      setError('Start date must be before end date');
      return;
    }

    setDateRange({
      start_date: tempStartDate,
      end_date: tempEndDate,
    });
    setError(null);
  };

  const resetDateRange = () => {
    const end = new Date();
    const start = new Date();
    start.setDate(end.getDate() - 30);
    const defaultStart = start.toISOString().split('T')[0];
    const defaultEnd = end.toISOString().split('T')[0];
    setTempStartDate(defaultStart);
    setTempEndDate(defaultEnd);
    setDateRange({
      start_date: defaultStart,
      end_date: defaultEnd,
    });
  };

  const revenueChartData = useMemo(() => {
    if (!data?.daily_revenue) return [];
    return data.daily_revenue.map(d => ({
      date: d.date,
      revenue: d.revenue,
      conversions: d.conversions,
      commission: d.commission_paid,
      unique_customers: d.unique_customers,
    })).reverse();
  }, [data]);

  const funnelData = useMemo(() => {
    if (!data?.conversion_rates) return [];

    const latest = data.conversion_rates[0];
    if (!latest) return [];

    return [
      {
        stage: 'visitors',
        label: t('funnel.visitorsLabel'),
        count: latest.unique_visitors,
        color: '#3B82F6',
      },
      {
        stage: 'clicks',
        label: t('funnel.clicksLabel'),
        count: latest.total_clicks,
        color: '#10B981',
      },
      {
        stage: 'converted',
        label: t('funnel.conversionsLabel'),
        count: latest.total_conversions,
        color: '#F59E0B',
      },
    ];
  }, [data, t]);

  const topDealsChartData = useMemo(() => {
    if (!data?.top_deals?.deals) return [];

    return data.top_deals.deals.map(d => ({
      name: d.name.length > 25 ? d.name.slice(0, 25) + '...' : d.name,
      fullName: d.name,
      revenue: d.total_revenue,
      conversions: d.total_conversions,
      conversion_rate: d.conversion_rate,
      exchange: d.exchange || 'Unknown',
    }));
  }, [data]);

  const formatCurrency = (value: number) => {
    return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  const formatCompact = (value: number) => {
    if (value >= 1000000) {
      return (value / 1000000).toFixed(1) + 'M';
    }
    if (value >= 1000) {
      return (value / 1000).toFixed(1) + 'K';
    }
    return value.toString();
  };

  interface FunnelDataItem {
    stage: string;
    label: string;
    count: number;
    color: string;
  }

  const FunnelChart = ({ data }: { data: FunnelDataItem[] }) => {
    const maxValue = Math.max(...data.map(d => d.count), 1);

    return (
      <div className="space-y-4">
        {data.map((item, index) => {
          const width = (item.count / maxValue) * 100;
          const isLast = index === data.length - 1;

          return (
            <div key={item.stage} className="flex items-center gap-4">
              <div
                className="text-sm font-medium text-gray-700 w-24 text-right"
                style={{ width: '80px' }}
              >
                {item.label}
              </div>
              <div className="flex-1 relative">
                <div
                  className="h-12 rounded transition-all duration-500 flex items-center justify-end pr-3"
                  style={{
                    width: `${width}%`,
                    backgroundColor: item.color,
                    clipPath: isLast
                      ? 'polygon(0 0, 100% 0, 100% 100%, 0 100%)'
                      : 'polygon(0 0, 100% 0, 98% 100%, 2% 100%)',
                  }}
                >
                  <span className="text-white font-semibold text-sm">
                    {formatCompact(item.count)}
                  </span>
                </div>
              </div>
              <div className="text-sm text-gray-600 w-20">
                {((item.count / data[0]?.count) * 100).toFixed(1)}%
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <AdminNav locale={locale} />
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="text-gray-600 mt-1">{t('subtitle')}</p>
          </div>
          <div className="h-10 w-64 bg-gray-200 rounded-lg animate-pulse"></div>
        </div>
        <div className="animate-pulse space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            {[1, 2, 3, 4, 5, 6, 7].map(i => (
              <div key={i} className="h-24 bg-gray-200 rounded-lg"></div>
            ))}
          </div>
          <div className="h-80 bg-gray-200 rounded-lg"></div>
          <div className="h-80 bg-gray-200 rounded-lg"></div>
          <div className="h-80 bg-gray-200 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="space-y-6">
        <AdminNav locale={locale} />
        <div className="flex justify-between items-center">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
            <p className="text-gray-600 mt-1">{t('subtitle')}</p>
          </div>
          <div className="h-10 w-64 bg-gray-200 rounded-lg"></div>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <h3 className="text-lg font-semibold text-red-800 mb-2">{t('errors.loadFailed')}</h3>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={fetchData}
            className="bg-red-600 text-white px-4 py-2 rounded-lg hover:bg-red-700 transition-colors flex items-center gap-2"
          >
            <RefreshCw className="w-4 h-4" />
            {t('errors.retry')}
          </button>
        </div>
      </div>
    );
  }

  const summary = data?.summary;
  const funnelStages = funnelData.length > 0 ? [
    funnelData[0]?.count || 0,
    funnelData[1]?.count || 0,
    funnelData[2]?.count || 0,
  ] : [0, 0, 0];

  return (
    <div className="space-y-6">
      <AdminNav locale={locale} />

      <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="text-gray-600 mt-1">{t('subtitle')}</p>
        </div>

        <div className="flex flex-col sm:flex-row items-end sm:items-center gap-3 bg-white p-4 rounded-lg shadow">
          <div className="flex items-center gap-2 text-sm text-gray-600">
            <Calendar className="w-4 h-4" />
            {t('dateRange.title')}
          </div>
          <div className="flex flex-col sm:flex-row items-end gap-2">
            <div className="flex flex-col">
              <label className="text-xs text-gray-500 mb-1">{t('dateRange.start')}</label>
              <input
                type="date"
                value={tempStartDate}
                onChange={(e) => setTempStartDate(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
            <div className="flex flex-col">
              <label className="text-xs text-gray-500 mb-1">{t('dateRange.end')}</label>
              <input
                type="date"
                value={tempEndDate}
                onChange={(e) => setTempEndDate(e.target.value)}
                className="border border-gray-300 rounded px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
              />
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={applyDateRange}
              className="bg-brand-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-brand-700 transition-colors"
            >
              {t('dateRange.apply')}
            </button>
            <button
              onClick={resetDateRange}
              className="border border-gray-300 text-gray-700 px-4 py-2 rounded-lg text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              {t('dateRange.reset')}
            </button>
            <button
              onClick={fetchData}
              className="border border-gray-300 text-gray-700 px-3 py-2 rounded-lg hover:bg-gray-50 transition-colors"
              title="Refresh"
            >
              <RefreshCw className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      {summary && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 xl:grid-cols-7 gap-4">
          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <DollarSign className="w-5 h-5 text-green-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.totalRevenue')}</span>
            </div>
            <div className="text-xl font-bold text-gray-900">{formatCurrency(summary.total_revenue)}</div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <Target className="w-5 h-5 text-blue-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.totalConversions')}</span>
            </div>
            <div className="text-xl font-bold text-gray-900">{summary.total_conversions.toLocaleString()}</div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <MousePointerClick className="w-5 h-5 text-purple-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.conversionRate')}</span>
            </div>
            <div className="text-xl font-bold text-gray-900">{summary.overall_conversion_rate.toFixed(1)}%</div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-5 h-5 text-orange-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.activeAffiliates')}</span>
            </div>
            <div className="text-xl font-bold text-gray-900">{summary.active_affiliates_count.toLocaleString()}</div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <TrendingUp className="w-5 h-5 text-red-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.totalCommission')}</span>
            </div>
            <div className="text-xl font-bold text-gray-900">{formatCurrency(summary.total_commission_liability)}</div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <Award className="w-5 h-5 text-yellow-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.topDeal')}</span>
            </div>
            <div className="text-sm font-bold text-gray-900 truncate" title={summary.top_deal_name}>
              {summary.top_deal_name}
            </div>
          </div>

          <div className="bg-white rounded-lg shadow p-4">
            <div className="flex items-center gap-2 mb-2">
              <Users className="w-5 h-5 text-indigo-600" />
              <span className="text-xs text-gray-500 uppercase font-medium">{t('kpi.topAffiliate')}</span>
            </div>
            <div className="text-sm font-bold text-gray-900 truncate" title={summary.top_affiliate_name}>
              {summary.top_affiliate_name}
            </div>
          </div>
        </div>
      )}

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.revenueTrend')}</h2>
        <div className="h-80">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={revenueChartData} margin={{ top: 5, right: 30, left: 20, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                dataKey="date"
                stroke="#6B7280"
                fontSize={12}
                tickFormatter={(value: string) => {
                  const date = new Date(value);
                  return date.toLocaleDateString(locale === 'vi' ? 'vi-VN' : 'en-US', {
                    month: 'short',
                    day: 'numeric',
                  });
                }}
              />
              <YAxis stroke="#6B7280" fontSize={12} tickFormatter={(value) => formatCompact(value)} />
              <Tooltip
                formatter={(value, name) => {
                  if (name === 'Revenue' || name === 'Commission') {
                    return [formatCurrency(value as number), name];
                  }
                  return [(value as number).toLocaleString(), name];
                }}
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #E5E7EB',
                  borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                }}
              />
              <Legend />
              <Line
                type="monotone"
                dataKey="revenue"
                name={t('charts.revenue')}
                stroke="#10B981"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="conversions"
                name={t('charts.conversions')}
                stroke="#3B82F6"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
              <Line
                type="monotone"
                dataKey="commission"
                name={t('charts.commissionPaid')}
                stroke="#F59E0B"
                strokeWidth={2}
                dot={{ r: 3 }}
                activeDot={{ r: 5 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.conversionFunnel')}</h2>
        <div className="h-80 flex items-center justify-center">
          {funnelData.length > 0 ? (
            <div className="w-full max-w-2xl px-8">
              <FunnelChart data={funnelData} />

              <div className="mt-6 grid grid-cols-3 gap-4 text-center">
                <div>
                  <div className="text-2xl font-bold text-blue-600">{formatCompact(funnelStages[0])}</div>
                  <div className="text-sm text-gray-500">{t('funnel.visitorsLabel')}</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-green-600">{formatCompact(funnelStages[1])}</div>
                  <div className="text-sm text-gray-500">{t('funnel.clicksLabel')}</div>
                </div>
                <div>
                  <div className="text-2xl font-bold text-amber-600">{formatCompact(funnelStages[2])}</div>
                  <div className="text-sm text-gray-500">{t('funnel.conversionsLabel')}</div>
                </div>
              </div>

              <div className="mt-4 flex justify-center gap-8 text-sm">
                <div className="text-center">
                  <span className="text-gray-600">Click-through rate: </span>
                  <span className="font-semibold text-green-600">
                    {funnelStages[0] > 0 ? ((funnelStages[1] / funnelStages[0]) * 100).toFixed(1) : 0}%
                  </span>
                </div>
                <div className="text-center">
                  <span className="text-gray-600">Conversion rate: </span>
                  <span className="font-semibold text-amber-600">
                    {funnelStages[1] > 0 ? ((funnelStages[2] / funnelStages[1]) * 100).toFixed(1) : 0}%
                  </span>
                </div>
              </div>
            </div>
          ) : (
            <p className="text-gray-500">{t('conversions.empty')}</p>
          )}
        </div>
      </div>

      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t('charts.topDeals')}</h2>
        <div className="h-96">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart
              data={topDealsChartData}
              layout="vertical"
              margin={{ top: 5, right: 30, left: 100, bottom: 5 }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#E5E7EB" />
              <XAxis
                type="number"
                stroke="#6B7280"
                fontSize={12}
                tickFormatter={(value: number) => formatCompact(value)}
              />
              <YAxis
                dataKey="name"
                type="category"
                stroke="#6B7280"
                fontSize={12}
                width={100}
                tick={{ fontSize: 12 }}
              />
              <Tooltip
                formatter={(value, name) => {
                  if (name === 'revenue') {
                    return [formatCurrency(value as number), t('charts.totalRevenue')];
                  }
                  if (name === 'conversions') {
                    return [(value as number).toLocaleString(), t('charts.conversions')];
                  }
                  if (name === 'conversion_rate') {
                    return [`${(value as number).toFixed(1)}%`, t('charts.conversionRate')];
                  }
                  return [value, name];
                }}
                labelFormatter={(label) => {
                  const item = topDealsChartData.find((d: any) => d.name === label);
                  return item ? item.fullName : label;
                }}
                contentStyle={{
                  backgroundColor: '#fff',
                  border: '1px solid #E5E7EB',
                  borderRadius: '8px',
                  boxShadow: '0 4px 6px -1px rgb(0 0 0 / 0.1)',
                }}
              />
              <Legend />
              <Bar
                dataKey="revenue"
                name={t('charts.totalRevenue')}
                fill="#10B981"
                radius={[0, 4, 4, 0]}
              />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="mt-6 overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('charts.dealName')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('charts.totalRevenue')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('charts.conversions')}
                </th>
                <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                  {t('charts.conversionRate')}
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {topDealsChartData.slice(0, 5).map((deal: any, index: number) => (
                <tr key={index} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-sm text-gray-900 truncate max-w-xs">
                    {deal.fullName}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-900 text-right font-medium">
                    {formatCurrency(deal.revenue)}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 text-right">
                    {deal.conversions.toLocaleString()}
                  </td>
                  <td className="px-4 py-3 text-sm text-gray-600 text-right">
                    {deal.conversion_rate.toFixed(1)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {data?.generated_at && (
        <div className="text-sm text-gray-500 text-center">
          {t('overview.lastUpdated')}: {new Date(data.generated_at).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')}
          {data.cached && (
            <span className="ml-2 text-amber-600">(cached)</span>
          )}
        </div>
      )}
    </div>
  );
}
