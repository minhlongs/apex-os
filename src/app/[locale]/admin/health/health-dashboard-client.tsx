'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  AlertTriangle,
  AlertCircle,
  CheckCircle,
  TrendingUp,
  TrendingDown,
  DollarSign,
  MousePointerClick,
  Wallet,
  Activity,
  RefreshCw,
  Clock,
  BarChart3,
  PieChart,
  AlertOctagon,
} from 'lucide-react';

interface HealthMetric {
  label: string;
  value: string | number;
  change?: string;
  changeType?: 'positive' | 'negative' | 'neutral';
  icon: React.ElementType;
  color: 'green' | 'blue' | 'yellow' | 'red' | 'purple' | 'indigo';
}

interface Alert {
  id: string;
  type: 'critical' | 'warning' | 'info';
  title: string;
  description: string;
  current_value: number;
  triggered_at: string;
}

interface HealthData {
  conversions: {
    last24h: number;
    last7d: number;
    last30d: number;
    trend24h: number;
    status_breakdown: {
      pending: number;
      approved: number;
      rejected: number;
      refunded: number;
    };
    failure_rate: number;
  };
  commissions: {
    pending_amount: number;
    paid_amount: number;
    total_amount: number;
    avg_commission_rate: number;
    by_level: {
      level1: number;
      level2: number;
      level3: number;
    };
  };
  payouts: {
    total: number;
    completed: number;
    failed: number;
    pending: number;
    processing: number;
    cancelled: number;
    success_rate: number;
    failure_rate: number;
    total_amount: number;
    net_amount: number;
    total_fees: number;
    avg_payout_amount: number;
    failure_reasons: Array<{ reason: string; count: number }>;
    by_method: Array<{ method: string; count: number; amount: number }>;
  };
  alerts: Alert[];
  system: {
    healthy: boolean;
    overall_status: 'healthy' | 'degraded' | 'critical';
    last_conversion_at: string | null;
    hours_since_last_conversion: number;
    database_status: string;
  };
}

interface HealthDashboardClientProps {
  locale: string;
}

const colorClasses = {
  green: 'bg-green-50 text-green-600 border-green-200',
  blue: 'bg-blue-50 text-blue-600 border-blue-200',
  yellow: 'bg-yellow-50 text-yellow-600 border-yellow-200',
  red: 'bg-red-50 text-red-600 border-red-200',
  purple: 'bg-purple-50 text-purple-600 border-purple-200',
  indigo: 'bg-indigo-50 text-indigo-600 border-indigo-200',
};

const badgeClasses = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  info: 'bg-blue-100 text-blue-800 border-blue-200',
  healthy: 'bg-green-100 text-green-800 border-green-200',
  degraded: 'bg-yellow-100 text-yellow-800 border-yellow-200',
};

export default function HealthDashboardClient({ locale }: HealthDashboardClientProps) {
  const t = useTranslations('admin.health');
  const [healthData, setHealthData] = useState<HealthData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [autoRefresh, setAutoRefresh] = useState(true);

  const fetchHealthData = useCallback(async () => {
    try {
      const response = await fetch('/api/admin/health/payout');
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          window.location.href = `/${locale}/login?redirect=/${locale}/admin/health`;
          return;
        }
        throw new Error('Failed to fetch health data');
      }
      const result = await response.json();
      if (result.success) {
        setHealthData(result.data);
        setError(null);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load health data');
    } finally {
      setLoading(false);
    }
  }, [locale]);

  useEffect(() => {
    fetchHealthData();
  }, [fetchHealthData]);

  // Auto-refresh every 5 minutes
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchHealthData();
      setLastRefresh(new Date());
    }, 5 * 60 * 1000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchHealthData]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat(locale === 'vi' ? 'vi-VN' : 'en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatNumber = (num: number) => {
    return num.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US');
  };

  const formatPercent = (value: number) => {
    return `${value.toFixed(1)}%`;
  };

  const formatTimeAgo = (dateString: string | null) => {
    if (!dateString) return 'Never';
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffMins = Math.floor(diffMs / (1000 * 60));

    if (diffHours > 24) {
      return `${Math.floor(diffHours / 24)} days ago`;
    }
    if (diffHours > 0) {
      return `${diffHours}h ago`;
    }
    return `${diffMins}m ago`;
  };

  const getStatusIcon = (type: 'critical' | 'warning' | 'info' | 'healthy' | 'degraded') => {
    switch (type) {
      case 'critical':
        return <AlertOctagon className="w-5 h-5" />;
      case 'warning':
        return <AlertTriangle className="w-5 h-5" />;
      case 'healthy':
        return <CheckCircle className="w-5 h-5" />;
      case 'degraded':
        return <AlertCircle className="w-5 h-5" />;
      default:
        return <Activity className="w-5 h-5" />;
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
          {[1, 2, 3, 4].map(i => (
            <div key={i} className="bg-white rounded-lg shadow p-6 animate-pulse">
              <div className="h-4 bg-gray-200 rounded w-1/2 mb-4"></div>
              <div className="h-8 bg-gray-200 rounded w-3/4"></div>
            </div>
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {[1, 2].map(i => (
            <div key={i} className="bg-white rounded-lg shadow p-6 animate-pulse h-64"></div>
          ))}
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-8 text-center">
        <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
        <h3 className="text-lg font-semibold text-red-800 mb-2">{t('errors.loadFailed')}</h3>
        <p className="text-red-600 mb-4">{error}</p>
        <button
          onClick={fetchHealthData}
          className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2 mx-auto"
        >
          <RefreshCw className="w-4 h-4" />
          {t('common.retry')}
        </button>
      </div>
    );
  }

  if (!healthData) {
    return null;
  }

  const { conversions, commissions, payouts, alerts, system } = healthData;

  // Build metrics cards
  const metricsCards: HealthMetric[] = [
    {
      label: t('metrics.conversions24h'),
      value: formatNumber(conversions.last24h),
      change: `${conversions.trend24h >= 0 ? '+' : ''}${formatPercent(conversions.trend24h)} vs prev 24h`,
      changeType: conversions.trend24h >= 0 ? 'positive' : 'negative',
      icon: MousePointerClick,
      color: 'blue',
    },
    {
      label: t('metrics.approvedConversions'),
      value: formatNumber(conversions.status_breakdown.approved),
      change: `${formatPercent(100 - conversions.failure_rate)} success rate`,
      changeType: conversions.failure_rate < 5 ? 'positive' : conversions.failure_rate < 10 ? 'neutral' : 'negative',
      icon: CheckCircle,
      color: 'green',
    },
    {
      label: t('metrics.pendingCommissions'),
      value: formatCurrency(commissions.pending_amount),
      icon: Wallet,
      color: 'yellow',
    },
    {
      label: t('metrics.payoutSuccessRate'),
      value: formatPercent(payouts.success_rate),
      change: `${payouts.failed} failed`,
      changeType: payouts.failure_rate < 5 ? 'positive' : payouts.failure_rate < 10 ? 'neutral' : 'negative',
      icon: Activity,
      color: payouts.failure_rate < 5 ? 'green' : payouts.failure_rate < 10 ? 'yellow' : 'red',
    },
  ];

  return (
    <div className="space-y-6">
      {/* System Status Bar */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className={`flex items-center gap-2 px-3 py-1 rounded-full border ${badgeClasses[system.overall_status]}`}>
              {getStatusIcon(system.overall_status)}
              <span className="font-medium">
                {system.overall_status === 'healthy' ? t('status.healthy') :
                 system.overall_status === 'degraded' ? t('status.degraded') :
                 t('status.critical')}
              </span>
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-500">
              <Clock className="w-4 h-4" />
              <span>{t('lastConversion')}: {formatTimeAgo(system.last_conversion_at)}</span>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                fetchHealthData();
                setLastRefresh(new Date());
              }}
              className="flex items-center gap-2 px-3 py-2 text-sm text-gray-600 hover:text-gray-900 hover:bg-gray-100 rounded-lg transition-colors"
            >
              <RefreshCw className="w-4 h-4" />
              {t('common.refresh')}
            </button>
            <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(e) => setAutoRefresh(e.target.checked)}
                className="rounded text-indigo-600 focus:ring-indigo-500"
              />
              {t('common.autoRefresh')}
            </label>
            <span className="text-xs text-gray-400">
              {lastRefresh.toLocaleTimeString()}
            </span>
          </div>
        </div>
      </div>

      {/* Alerts Section */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
            <AlertTriangle className="w-5 h-5 text-yellow-500" />
            {t('alerts.title')} ({alerts.length})
          </h2>
          {alerts.map((alert) => (
            <div
              key={alert.id}
              className={`rounded-lg border p-4 ${badgeClasses[alert.type]}`}
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="font-semibold">{alert.title}</h3>
                  <p className="text-sm mt-1 opacity-90">{alert.description}</p>
                </div>
                <div className="flex items-center gap-2 text-sm">
                  <span className="font-medium">
                    {alert.type === 'critical' ? t('alerts.critical') :
                     alert.type === 'warning' ? t('alerts.warning') : t('alerts.info')}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Key Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        {metricsCards.map((metric, index) => (
          <div key={index} className="bg-white rounded-lg shadow p-6 border-l-4 border-l-indigo-500">
            <div className="flex items-center justify-between mb-4">
              <div className={`p-2 rounded-lg ${colorClasses[metric.color]}`}>
                <metric.icon className="w-5 h-5" />
              </div>
            </div>
            <div className="text-sm text-gray-500 mb-1">{metric.label}</div>
            <div className="text-2xl font-bold text-gray-900">{metric.value}</div>
            {metric.change && (
              <div className={`flex items-center gap-1 text-sm mt-2 ${metric.changeType === 'positive' ? 'text-green-600' : metric.changeType === 'negative' ? 'text-red-600' : 'text-gray-500'}`}>
                {metric.changeType === 'positive' && <TrendingUp className="w-4 h-4" />}
                {metric.changeType === 'negative' && <TrendingDown className="w-4 h-4" />}
                {metric.change}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Two Column Layout: Conversions & Commissions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Conversions Health */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-blue-600" />
            {t('sections.conversions')}
          </h3>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('conversions.last24h')}</div>
                <div className="text-xl font-bold text-gray-900">{formatNumber(conversions.last24h)}</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('conversions.last7d')}</div>
                <div className="text-xl font-bold text-gray-900">{formatNumber(conversions.last7d)}</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('conversions.last30d')}</div>
                <div className="text-xl font-bold text-gray-900">{formatNumber(conversions.last30d)}</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('conversions.failureRate')}</div>
                <div className={`text-xl font-bold ${conversions.failure_rate < 5 ? 'text-green-600' : conversions.failure_rate < 10 ? 'text-yellow-600' : 'text-red-600'}`}>
                  {formatPercent(conversions.failure_rate)}
                </div>
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="text-sm font-medium text-gray-700 mb-3">{t('conversions.statusBreakdown')}</div>
              <div className="space-y-2">
                {Object.entries(conversions.status_breakdown).map(([status, count]) => {
                  const total = conversions.last30d || 1;
                  const percentage = (count / total) * 100;
                  let color = 'bg-gray-500';
                  if (status === 'approved') color = 'bg-green-500';
                  else if (status === 'pending') color = 'bg-yellow-500';
                  else if (status === 'rejected') color = 'bg-red-500';
                  else if (status === 'refunded') color = 'bg-orange-500';

                  return (
                    <div key={status} className="flex items-center gap-3">
                      <div className="w-24 text-sm text-gray-600 capitalize">{status}</div>
                      <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                        <div
                          className={`h-full ${color} transition-all duration-500`}
                          style={{ width: `${Math.min(percentage, 100)}%` }}
                        />
                      </div>
                      <div className="w-20 text-sm text-right text-gray-700">{formatNumber(count)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {/* Commissions Health */}
        <div className="bg-white rounded-lg shadow p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <DollarSign className="w-5 h-5 text-green-600" />
            {t('sections.commissions')}
          </h3>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-4">
              <div className="p-4 bg-green-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('commissions.pending')}</div>
                <div className="text-xl font-bold text-green-600">{formatCurrency(commissions.pending_amount)}</div>
              </div>
              <div className="p-4 bg-blue-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('commissions.paid')}</div>
                <div className="text-xl font-bold text-blue-600">{formatCurrency(commissions.paid_amount)}</div>
              </div>
              <div className="p-4 bg-purple-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('commissions.total')}</div>
                <div className="text-xl font-bold text-purple-600">{formatCurrency(commissions.total_amount)}</div>
              </div>
              <div className="p-4 bg-gray-50 rounded-lg">
                <div className="text-sm text-gray-500">{t('commissions.avgRate')}</div>
                <div className="text-xl font-bold text-gray-900">{formatPercent(commissions.avg_commission_rate)}</div>
              </div>
            </div>

            <div className="border-t pt-4">
              <div className="text-sm font-medium text-gray-700 mb-3">{t('commissions.byLevel')}</div>
              <div className="space-y-2">
                {[
                  { level: 1, amount: commissions.by_level.level1, label: t('commissions.tier1') },
                  { level: 2, amount: commissions.by_level.level2, label: t('commissions.tier2') },
                  { level: 3, amount: commissions.by_level.level3, label: t('commissions.tier3') },
                ].map(({ level, amount, label }) => (
                  <div key={level} className="flex items-center gap-3">
                    <div className="w-24 text-sm text-gray-600">{label}</div>
                    <div className="flex-1 bg-gray-100 rounded-full h-4 overflow-hidden">
                      <div
                        className="h-full bg-indigo-500 transition-all duration-500"
                        style={{ width: `${Math.min((amount / Math.max(commissions.total_amount, 1)) * 100, 100)}%` }}
                      />
                    </div>
                    <div className="w-20 text-sm text-right text-gray-700 font-medium">{formatCurrency(amount)}</div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Payouts Detailed Section */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Wallet className="w-5 h-5 text-indigo-600" />
          {t('sections.payouts')}
        </h3>

        {/* Payout Status Overview */}
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4 mb-6">
          {[
            { label: t('payouts.total'), value: payouts.total, color: 'bg-gray-100 text-gray-700' },
            { label: t('payouts.completed'), value: payouts.completed, color: 'bg-green-100 text-green-700' },
            { label: t('payouts.processing'), value: payouts.processing, color: 'bg-blue-100 text-blue-700' },
            { label: t('payouts.pending'), value: payouts.pending, color: 'bg-yellow-100 text-yellow-700' },
            { label: t('payouts.failed'), value: payouts.failed, color: 'bg-red-100 text-red-700' },
            { label: t('payouts.cancelled'), value: payouts.cancelled, color: 'bg-gray-100 text-gray-700' },
          ].map((item, index) => (
            <div key={index} className={`rounded-lg p-4 ${item.color}`}>
              <div className="text-sm opacity-75">{item.label}</div>
              <div className="text-2xl font-bold">{formatNumber(item.value)}</div>
            </div>
          ))}
        </div>

        {/* Payout Metrics */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-6 p-4 bg-gray-50 rounded-lg">
          <div>
            <div className="text-sm text-gray-500">{t('payouts.successRate')}</div>
            <div className={`text-lg font-bold ${payouts.success_rate >= 95 ? 'text-green-600' : payouts.success_rate >= 90 ? 'text-yellow-600' : 'text-red-600'}`}>
              {formatPercent(payouts.success_rate)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500">{t('payouts.failureRate')}</div>
            <div className={`text-lg font-bold ${payouts.failure_rate < 5 ? 'text-green-600' : payouts.failure_rate < 10 ? 'text-yellow-600' : 'text-red-600'}`}>
              {formatPercent(payouts.failure_rate)}
            </div>
          </div>
          <div>
            <div className="text-sm text-gray-500">{t('payouts.totalAmount')}</div>
            <div className="text-lg font-bold text-gray-900">{formatCurrency(payouts.total_amount)}</div>
          </div>
          <div>
            <div className="text-sm text-gray-500">{t('payouts.totalFees')}</div>
            <div className="text-lg font-bold text-gray-900">{formatCurrency(payouts.total_fees)}</div>
          </div>
        </div>

        {/* Payout Methods & Failure Reasons */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Payout Methods */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
              <PieChart className="w-4 h-4" />
              {t('payouts.byMethod')}
            </h4>
            {payouts.by_method.length > 0 ? (
              <div className="space-y-2">
                {payouts.by_method.map(({ method, count, amount }) => (
                  <div key={method} className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <div>
                      <div className="font-medium text-gray-900 capitalize">{method.replace('_', ' ')}</div>
                      <div className="text-sm text-gray-500">{formatNumber(count)} payouts</div>
                    </div>
                    <div className="text-right">
                      <div className="font-medium text-gray-900">{formatCurrency(amount)}</div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500 text-sm italic">{t('payouts.noData')}</div>
            )}
          </div>

          {/* Failure Reasons */}
          <div>
            <h4 className="text-sm font-medium text-gray-700 mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4" />
              {t('payouts.failureReasons')}
            </h4>
            {payouts.failure_reasons.length > 0 ? (
              <div className="space-y-2">
                {payouts.failure_reasons.map(({ reason, count }) => (
                  <div key={reason} className="flex items-center justify-between p-3 bg-red-50 rounded-lg">
                    <div className="flex-1">
                      <div className="font-medium text-gray-900 truncate" title={reason}>{reason}</div>
                      <div className="text-sm text-red-600">{formatNumber(count)} failures</div>
                    </div>
                    <div className="ml-4">
                      <div className="text-sm font-medium text-red-600">
                        {((count / payouts.failed) * 100).toFixed(0)}%
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-gray-500 text-sm italic">{t('payouts.noFailures')}</div>
            )}
          </div>
        </div>
      </div>

      {/* System Health */}
      <div className="bg-white rounded-lg shadow p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Activity className="w-5 h-5 text-indigo-600" />
          {t('sections.system')}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-sm text-gray-500">{t('system.database')}</div>
            <div className={`text-lg font-bold ${system.database_status === 'connected' ? 'text-green-600' : 'text-red-600'}`}>
              {system.database_status === 'connected' ? t('system.connected') : t('system.disconnected')}
            </div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-sm text-gray-500">{t('system.lastConversion')}</div>
            <div className="text-lg font-bold text-gray-900">
              {formatTimeAgo(system.last_conversion_at)}
            </div>
          </div>
          <div className="p-4 bg-gray-50 rounded-lg">
            <div className="text-sm text-gray-500">{t('system.hoursSinceLast')}</div>
            <div className={`text-lg font-bold ${system.hours_since_last_conversion > 24 ? 'text-red-600' : system.hours_since_last_conversion > 12 ? 'text-yellow-600' : 'text-green-600'}`}>
              {system.hours_since_last_conversion.toFixed(1)}h
            </div>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="text-center text-sm text-gray-500">
        <p>{t('common.autoRefreshNote')}</p>
        <p className="text-xs mt-1">
          {t('common.dataRefresh')}: {lastRefresh.toLocaleTimeString()}
        </p>
      </div>
    </div>
  );
}
