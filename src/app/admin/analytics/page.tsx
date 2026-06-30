'use client';

import { useEffect, useState, useMemo, Suspense, lazy } from 'react';
import {
  TrendingUp,
  TrendingDown,
  Minus,
  Users,
  MousePointerClick,
  DollarSign,
} from 'lucide-react';
import MetricCard from '@/components/admin/analytics/MetricCard';
import { DynamicLoading, TableSkeleton } from '@/components/DynamicLoader';
import type {
  BusinessMetricsResponse,
  DailyRevenue,
  DealMetrics,
} from '@/types/metrics';

// Dynamically loaded heavy components (code splitting)
const RevenueChart = lazy(() => import('@/components/admin/analytics/RevenueChart'));
const TopDealsTable = lazy(() => import('@/components/admin/analytics/TopDealsTable'));
const RecentActivityTable = lazy(() => import('@/components/admin/analytics/RecentActivityTable'));
const TopAffiliatesTable = lazy(() => import('@/components/admin/analytics/TopAffiliatesTable'));

// Default date range: last 30 days
function getDefaultDateRange() {
  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - 30);
  return {
    start_date: startDate.toISOString().split('T')[0],
    end_date: endDate.toISOString().split('T')[0],
  };
}

export default function AdminAnalyticsDashboard() {
  const [metrics, setMetrics] = useState<BusinessMetricsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dateRange, setDateRange] = useState(getDefaultDateRange);

  const fetchMetrics = async (startDate: string, endDate: string) => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        start_date: startDate,
        end_date: endDate,
      });
      const res = await fetch(`/api/metrics/business?${params}`);
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) {
          throw new Error('Authentication required. Admin access only.');
        }
        throw new Error(`Failed to fetch metrics: ${res.statusText}`);
      }
      const data = await res.json();
      setMetrics(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchMetrics(dateRange.start_date, dateRange.end_date);
  }, [dateRange.start_date, dateRange.end_date]);

  const handleDateChange = (type: 'start' | 'end', value: string) => {
    setDateRange(prev => ({ ...prev, [type === 'start' ? 'start_date' : 'end_date']: value }));
  };

  const refreshData = () => {
    fetchMetrics(dateRange.start_date, dateRange.end_date);
  };

  // Format currency
  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  // Format large numbers
  const formatNumber = (num: number) => {
    return num.toLocaleString();
  };

  const formatPercent = (value: number): string => {
    return `${value.toFixed(1)}%`;
  };

  // Generate mock recent activity from conversions data
  // In production, this would come from a dedicated /api/activity/recent endpoint
  const recentActivity = useMemo(() => {
    if (!metrics?.conversion_rates) return [];

    // Convert conversion rate periods into mock activity items
    // Each period represents aggregated data for that day
    return metrics.conversion_rates.slice(0, 8).map((period, idx) => ({
      id: `period-${period.period}-${idx}`,
      type: 'conversion' as const,
      dealName: 'Trading Fee Rebate',
      affiliateEmail: `affiliate${idx + 1}@example.com`,
      amount: period.total_conversions * 50, // Mock: avg $50 per conversion
      status: 'approved' as const,
      timestamp: new Date(`${period.period}T12:00:00`).toISOString(),
      metadata: {
        exchange: 'binance',
      },
    }));
  }, [metrics?.conversion_rates]);

  if (loading && !metrics) {
    return (
      <div className="container mx-auto py-8">
        <div className="animate-pulse space-y-6">
          {/* Header skeleton */}
          <div className="flex justify-between items-center">
            <div>
              <div className="h-8 bg-gray-200 rounded w-64 mb-2"></div>
              <div className="h-4 bg-gray-200 rounded w-96"></div>
            </div>
            <div className="h-10 bg-gray-200 rounded w-48"></div>
          </div>

          {/* Metric cards skeleton */}
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
            {[1, 2, 3, 4].map(i => (
              <div key={i} className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
                <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
                <div className="h-8 bg-gray-200 rounded w-3/4"></div>
              </div>
            ))}
          </div>

          {/* Chart skeleton */}
          <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
            <div className="h-6 bg-gray-200 rounded w-48 mb-6"></div>
            <div className="h-80 bg-gray-200 rounded"></div>
          </div>

          {/* Table skeleton */}
          <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
            <div className="h-16 bg-gray-200 rounded-t-lg"></div>
            <div className="p-4 space-y-3">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="h-12 bg-gray-100 rounded"></div>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container mx-auto py-8">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-red-100 rounded-full flex items-center justify-center">
              <span className="text-red-600 text-lg">!</span>
            </div>
            <div>
              <h3 className="font-semibold text-red-900">Error Loading Metrics</h3>
              <p className="text-red-700 text-sm mt-1">{error}</p>
            </div>
          </div>
          <button
            onClick={refreshData}
            className="mt-4 px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 text-sm"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  const summary = metrics?.summary;
  const dailyRevenue = metrics?.daily_revenue || [];
  const topDeals = metrics?.top_deals?.deals || [];
  const affiliates = metrics?.active_affiliates;

  return (
    <div className="container mx-auto py-8 space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Business Metrics Dashboard</h1>
          <p className="text-gray-500 mt-1">
            Overview of revenue, conversions, and affiliate performance
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">From:</label>
            <input
              type="date"
              value={dateRange.start_date}
              onChange={(e) => handleDateChange('start', e.target.value)}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-2">
            <label className="text-sm text-gray-600">To:</label>
            <input
              type="date"
              value={dateRange.end_date}
              onChange={(e) => handleDateChange('end', e.target.value)}
              max={dateRange.start_date}
              className="px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button
            onClick={refreshData}
            disabled={loading}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 text-sm font-medium"
          >
            {loading ? 'Loading...' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* Cache indicator */}
      {metrics?.cached && (
        <div className="bg-blue-50 border border-blue-200 rounded-lg px-4 py-2 text-sm text-blue-700">
          <span className="font-medium">Cached</span> — Data served from cache (TTL: {metrics.cache_ttl_remaining}s remaining)
        </div>
      )}

      {/* Key Metric Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <MetricCard
          title="Total Revenue"
          value={formatCurrency(summary?.total_revenue || 0)}
          change={summary?.period_start && summary?.period_end ?
            `${new Date(summary.period_end).toLocaleDateString()} - ${new Date(summary.period_start).toLocaleDateString()}` : undefined}
          icon={DollarSign}
          iconColor="text-green-600"
          iconBgColor="bg-green-50"
        />
        <MetricCard
          title="Total Conversions"
          value={formatNumber(summary?.total_conversions || 0)}
          change={`${formatPercent(summary?.overall_conversion_rate || 0)} conversion rate`}
          icon={TrendingUp}
          iconColor="text-blue-600"
          iconBgColor="bg-blue-50"
        />
        <MetricCard
          title="Active Affiliates"
          value={formatNumber(summary?.active_affiliates_count || 0)}
          change={affiliates ?
            `${affiliates.affiliates_with_conversions} with conversions` : undefined}
          icon={Users}
          iconColor="text-purple-600"
          iconBgColor="bg-purple-50"
        />
        <MetricCard
          title="Commission Liability"
          value={formatCurrency(summary?.total_commission_liability || 0)}
          change="Pending payouts"
          icon={MousePointerClick}
          iconColor="text-orange-600"
          iconBgColor="bg-orange-50"
        />
      </div>

      {/* Affiliate Level Distribution */}
      {affiliates && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="text-sm text-gray-500 mb-1">Level 1 Affiliates</div>
            <div className="text-2xl font-bold text-gray-900">
              {affiliates.distribution_by_level.level_1}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="text-sm text-gray-500 mb-1">Level 2 Affiliates</div>
            <div className="text-2xl font-bold text-gray-900">
              {affiliates.distribution_by_level.level_2}
            </div>
          </div>
          <div className="bg-white rounded-lg border border-gray-200 p-6">
            <div className="text-sm text-gray-500 mb-1">Level 3 Affiliates</div>
            <div className="text-2xl font-bold text-gray-900">
              {affiliates.distribution_by_level.level_3}
            </div>
          </div>
        </div>
      )}

      {/* Revenue Chart */}
      {dailyRevenue.length > 0 && (
        <Suspense fallback={<DynamicLoading message="Loading revenue chart..." />}>
          <RevenueChart
            data={dailyRevenue}
            title={`Revenue Trend (${dateRange.start_date} to ${dateRange.end_date})`}
          />
        </Suspense>
      )}

      {/* Top Deals Table & Recent Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2">
          {topDeals.length > 0 ? (
            <Suspense fallback={<TableSkeleton rows={10} />}>
              <TopDealsTable deals={topDeals} />
            </Suspense>
          ) : (
            <div className="bg-white rounded-lg border border-gray-200 p-8 text-center text-gray-500">
              <p>No deal data available for the selected period</p>
            </div>
          )}
        </div>

        <div className="lg:col-span-1">
          <Suspense fallback={<TableSkeleton rows={8} />}>
            <RecentActivityTable
              activities={recentActivity}
              title="Recent Conversions"
              maxItems={8}
            />
          </Suspense>
        </div>
      </div>

      {/* Top Affiliates Table */}
      <Suspense fallback={<TableSkeleton rows={15} />}>
        <TopAffiliatesTable />
      </Suspense>
    </div>
  );
}
