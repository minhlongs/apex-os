'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { DollarSign, TrendingUp, Users, Percent, ArrowUp, ArrowDown } from 'lucide-react';
import type { BusinessMetricsResponse } from '@/types/metrics';

interface BusinessKpiCardsProps {
  locale: string;
  timeRange?: '24h' | '7d' | '30d';
}

interface KpiData {
  totalRevenue: number;
  payoutVolume: number;
  conversionRate: number;
  activeUsers: number;
}

interface KpiCardConfig {
  key: keyof KpiData;
  labelKey: string;
  icon: React.ElementType;
  color: string;
  format: (value: number) => string;
}

export default function BusinessKpiCards({ locale, timeRange = '30d' }: BusinessKpiCardsProps) {
  const t = useTranslations('admin.businessKpi');

  const [currentPeriod, setCurrentPeriod] = useState<KpiData | null>(null);
  const [previousPeriod, setPreviousPeriod] = useState<KpiData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Convert timeRange to days
  const getDays = (range: '24h' | '7d' | '30d'): number => {
    switch (range) {
      case '24h': return 1;
      case '7d': return 7;
      case '30d': return 30;
    }
  };

  // Calculate date range for given days
  const getDateRange = (days: number): { start_date: string; end_date: string } => {
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 24 * 60 * 60 * 1000);
    return {
      start_date: startDate.toISOString().split('T')[0],
      end_date: endDate.toISOString().split('T')[0],
    };
  };

  // Fetch metrics for a given date range
  const fetchMetrics = useCallback(async (days: number): Promise<KpiData | null> => {
    const { start_date, end_date } = getDateRange(days);
    try {
      const response = await fetch(
        `/api/metrics/business?start_date=${start_date}&end_date=${end_date}`
      );
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      const data: BusinessMetricsResponse = await response.json();

      if (!data.summary) {
        return null;
      }

      return {
        totalRevenue: data.summary.total_revenue,
        payoutVolume: data.summary.total_commission_liability,
        conversionRate: data.summary.overall_conversion_rate,
        activeUsers: data.summary.active_affiliates_count,
      };
    } catch (err) {
      console.error(`Failed to fetch metrics for ${days} days:`, err);
      throw err;
    }
  }, []); // Empty deps - getDateRange doesn't depend on component state

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const days = getDays(timeRange);
      const [current, previous] = await Promise.all([
        fetchMetrics(days),
        fetchMetrics(days * 2), // Previous period: double the duration ending at same date
      ]);

      setCurrentPeriod(current);
      setPreviousPeriod(previous);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load metrics');
    } finally {
      setLoading(false);
    }
  }, [timeRange, fetchMetrics]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Calculate percentage change
  const calculateChange = (current: number, previous: number): { value: number; isPositive: boolean } => {
    if (previous === 0) {
      return current > 0 ? { value: 100, isPositive: true } : { value: 0, isPositive: true };
    }
    const change = ((current - previous) / Math.abs(previous)) * 100;
    return {
      value: Math.round(change * 10) / 10,
      isPositive: change >= 0,
    };
  };

  // Format currency
  const formatCurrency = (value: number): string => {
    return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  };

  // Format percentage
  const formatPercentage = (value: number): string => {
    return `${value.toFixed(1)}%`;
  };

  // Format number with locale
  const formatNumber = (value: number): string => {
    return value.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US');
  };

  const kpiConfigs: KpiCardConfig[] = [
    {
      key: 'totalRevenue',
      labelKey: 'totalRevenue',
      icon: DollarSign,
      color: 'bg-green-50 text-green-600',
      format: formatCurrency,
    },
    {
      key: 'payoutVolume',
      labelKey: 'payoutVolume',
      icon: TrendingUp,
      color: 'bg-blue-50 text-blue-600',
      format: formatCurrency,
    },
    {
      key: 'conversionRate',
      labelKey: 'conversionRate',
      icon: Percent,
      color: 'bg-purple-50 text-purple-600',
      format: formatPercentage,
    },
    {
      key: 'activeUsers',
      labelKey: 'activeUsers',
      icon: Users,
      color: 'bg-orange-50 text-orange-600',
      format: formatNumber,
    },
  ];

  if (loading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {kpiConfigs.map((config) => (
          <div key={config.key} className="bg-white rounded-lg shadow p-6 animate-pulse">
            <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
            <div className="h-8 bg-gray-200 rounded w-3/4"></div>
          </div>
        ))}
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6">
        <p className="text-red-600">{t('error.loadFailed', { error })}</p>
      </div>
    );
  }

  if (!currentPeriod) {
    return (
      <div className="bg-white rounded-lg shadow p-6">
        <p className="text-gray-500">{t('noData')}</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
      {kpiConfigs.map((config) => {
        const currentValue = currentPeriod[config.key];
        const previousValue = previousPeriod?.[config.key] ?? 0;
        const { value: changePercent, isPositive } = calculateChange(currentValue, previousValue);
        const formattedValue = config.format(currentValue);

        const isChangePositive = config.key === 'conversionRate' || config.key === 'activeUsers'
          ? changePercent >= 0
          : isPositive;

        const ArrowIcon = isChangePositive ? ArrowUp : ArrowDown;
        const arrowColor = isChangePositive ? 'text-green-500' : 'text-red-500';

        return (
          <div key={config.key} className="bg-white rounded-lg shadow p-6 hover:shadow-md transition-shadow">
            <div className="flex items-center justify-between mb-4">
              <div className={`p-2 rounded-lg ${config.color}`}>
                <config.icon className="w-5 h-5" />
              </div>
              {previousValue > 0 && (
                <div className={`flex items-center gap-1 text-sm ${arrowColor}`}>
                  <ArrowIcon className="w-4 h-4" />
                  <span>{Math.abs(changePercent)}%</span>
                </div>
              )}
            </div>
            <div className="text-sm text-gray-500 mb-1">{t(config.labelKey)}</div>
            <div className="text-2xl font-bold text-gray-900">{formattedValue}</div>
            {previousValue > 0 && (
              <div className={`text-xs mt-2 ${isChangePositive ? 'text-green-600' : 'text-red-600'}`}>
                {isChangePositive ? t('vsPreviousPeriod.up') : t('vsPreviousPeriod.down')}
                {' ' }{t('vsPreviousPeriod.label')}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
