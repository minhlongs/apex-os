'use client';

import { useState, useCallback, useTransition, useEffect, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Table, { Column } from '@/components/Table/DataTable';
import {
  AlertCircle,
  AlertTriangle,
  AlertOctagon,
  CheckCircle,
  Bell,
  BellOff,
  Clock,
  Eye,
  EyeOff,
  X,
  RefreshCw,
  Filter,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { Alert, AlertFilters } from './actions';

interface AlertsClientProps {
  initialAlerts: Alert[];
  total: number;
  totalPages: number;
  currentPage: number;
  limit: number;
  initialFilters: AlertFilters;
  summary: {
    activeAlerts: number;
    unreadAlerts: number;
    criticalCount: number;
    warningCount: number;
    infoCount: number;
    totalAlerts: number;
    resolvedAlerts: number;
    byType: Record<string, number>;
    bySeverity: Record<string, number>;
  };
}

const SEVERITY_OPTIONS = [
  { value: 'all', labelKey: 'severity.all' },
  { value: 'critical', labelKey: 'severity.critical' },
  { value: 'warning', labelKey: 'severity.warning' },
  { value: 'info', labelKey: 'severity.info' },
];

const STATUS_OPTIONS = [
  { value: 'active', labelKey: 'status.active' },
  { value: 'resolved', labelKey: 'status.resolved' },
  { value: 'acknowledged', labelKey: 'status.acknowledged' },
  { value: 'all', labelKey: 'status.all' },
];

const SNOOZE_OPTIONS = [
  { value: 60, label: '1 giờ', labelEn: '1 hour' },
  { value: 360, label: '6 giờ', labelEn: '6 hours' },
  { value: 1440, label: '24 giờ', labelEn: '24 hours' },
  { value: 10080, label: '7 ngày', labelEn: '7 days' },
];

const TYPE_LABELS: Record<string, { vi: string; en: string }> = {
  no_conversions_24h: { vi: 'Không có chuyển đổi (24h)', en: 'No Conversions (24h)' },
  payout_failure_rate: { vi: 'Tỷ lệ thất bại thanh toán', en: 'Payout Failure Rate' },
  conversion_failure_rate: { vi: 'Tỷ lệ thất bại chuyển đổi', en: 'Conversion Failure Rate' },
  pending_commissions: { vi: 'Hoa hồng đang chờ', en: 'Pending Commissions' },
  custom: { vi: 'Tùy chỉnh', en: 'Custom' },
  query_duration: { vi: 'Thời gian truy vấn', en: 'Query Duration' },
  storage_usage: { vi: 'Sử dụng lưu trữ', en: 'Storage Usage' },
  slow_query_count: { vi: 'Số truy vấn chậm', en: 'Slow Query Count' },
  rows_scanned: { vi: 'Số hàng quét', en: 'Rows Scanned' },
};

const severityColors = {
  critical: 'bg-red-100 text-red-800 border-red-200',
  warning: 'bg-yellow-100 text-yellow-800 border-yellow-200',
  info: 'bg-blue-100 text-blue-800 border-blue-200',
};

const severityIcons = {
  critical: AlertOctagon,
  warning: AlertTriangle,
  info: AlertCircle,
};

const statusIcons = {
  active: AlertCircle,
  resolved: CheckCircle,
  acknowledged: Bell,
};

export default function AlertsClient({
  initialAlerts,
  total,
  totalPages,
  currentPage,
  limit,
  initialFilters,
  summary,
}: AlertsClientProps) {
  const t = useTranslations('admin.alerts');
  const [isPending, startTransition] = useTransition();
  const [alerts, setAlerts] = useState<Alert[]>(initialAlerts);
  const [totalAlerts, setTotalAlerts] = useState(total);
  const [summaryData, setSummaryData] = useState(summary);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Real-time refresh state
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshInterval, setRefreshInterval] = useState(30000); // 30 seconds
  const [lastRefresh, setLastRefresh] = useState<Date>(new Date());
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<'connected' | 'error'>('connected');
  const refreshTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Local state for filters and UI
  const [showSilenceModal, setShowSilenceModal] = useState<string | null>(null);
  const [snoozeDuration, setSnoozeDuration] = useState<number>(60);
  const [snoozeReason, setSnoozeReason] = useState('');
  const [selectedAlerts, setSelectedAlerts] = useState<Set<string>>(new Set());
  const [bulkAction, setBulkAction] = useState<'markRead' | 'markUnread' | 'resolve' | 'acknowledge' | null>(null);
  const [showBulkConfirm, setShowBulkConfirm] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const handleLimitChange = useCallback((newLimit: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('limit', newLimit.toString());
    params.set('page', '1');
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const handleFilterChange = useCallback((filterName: string, value: string | undefined) => {
    const params = new URLSearchParams(searchParams);
    if (value && value !== 'all') {
      params.set(filterName, value);
    } else {
      params.delete(filterName);
    }
    params.set('page', '1');
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const executeAction = useCallback(async (
    action: string,
    alertId?: string,
    alertIds?: string[],
    extra?: { snoozeUntil?: string }
  ) => {
    setActionLoading(alertId || 'bulk');
    try {
      const response = await fetch('/api/admin/alerts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          alertId,
          alertIds,
          ...extra,
        }),
      });

      if (!response.ok) {
        throw new Error(`Action failed: ${response.statusText}`);
      }

      // Refresh the data
      router.refresh();
    } catch (error) {
      console.error('Alert action error:', error);
      alert(t('actions.error') || 'Failed to perform action');
    } finally {
      setActionLoading(null);
      setShowSilenceModal(null);
      setSnoozeReason('');
    }
  }, [router, t]);

  const handleMarkRead = useCallback((alertId: string) => {
    executeAction('markRead', alertId);
  }, [executeAction]);

  const handleMarkUnread = useCallback((alertId: string) => {
    executeAction('markUnread', alertId);
  }, [executeAction]);

  const handleAcknowledge = useCallback((alertId: string) => {
    executeAction('acknowledge', alertId);
  }, [executeAction]);

  const handleResolve = useCallback((alertId: string) => {
    if (confirm(t('actions.confirmResolve'))) {
      executeAction('resolve', alertId);
    }
  }, [executeAction, t]);

  const handleOpenSilenceModal = useCallback((alertId: string) => {
    setShowSilenceModal(alertId);
  }, []);

  const handleSilence = useCallback(() => {
    if (showSilenceModal) {
      const snoozeUntil = new Date(Date.now() + snoozeDuration * 60 * 1000).toISOString();
      executeAction('snooze', showSilenceModal, undefined, { snoozeUntil });
    }
  }, [showSilenceModal, snoozeDuration, executeAction]);


  // Lấy dữ liệu alerts từ API với cache busting
  const fetchAlertsData = useCallback(async (): Promise<boolean> => {
    if (isRefreshing) return false;

    setIsRefreshing(true);
    try {
      const params = new URLSearchParams(searchParams);
      // Thêm timestamp để tránh cache và lấy dữ liệu mới nhất
      params.set('_t', Date.now().toString());
      const response = await fetch(`/api/admin/alerts?${params.toString()}`, {
        next: { revalidate: 0 },
      });

      if (!response.ok) {
        setConnectionStatus('error');
        return false;
      }

      const data = await response.json();
      if (data.success) {
        setAlerts(data.data);
        setTotalAlerts(data.pagination?.total || 0);
        setSummaryData(data.summary);
        setLastRefresh(new Date());
        setConnectionStatus('connected');
        return true;
      }
      setConnectionStatus('error');
      return false;
    } catch (error) {
      console.error('Không thể tải alerts:', error);
      setConnectionStatus('error');
      return false;
    } finally {
      setIsRefreshing(false);
    }
  }, [searchParams, isRefreshing]);

  // Manual refresh
  const handleManualRefresh = useCallback(async () => {
    await fetchAlertsData();
  }, [fetchAlertsData]);

  // Auto-refresh polling
  useEffect(() => {
    if (!autoRefresh) {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
        refreshTimerRef.current = null;
      }
      return;
    }

    // Initial fetch
    fetchAlertsData();

    // Set up polling
    refreshTimerRef.current = setInterval(() => {
      fetchAlertsData();
    }, refreshInterval);

    return () => {
      if (refreshTimerRef.current) {
        clearInterval(refreshTimerRef.current);
      }
    };
  }, [autoRefresh, refreshInterval, fetchAlertsData]);

  // Update when filters change - trigger manual refresh after navigation
  const handleFilterChangeWithRefresh = useCallback((filterName: string, value: string | undefined) => {
    handleFilterChange(filterName, value);
    // Trigger refresh after navigation completes
    setTimeout(() => fetchAlertsData(), 500);
  }, [handleFilterChange, fetchAlertsData]);

  const handlePageChange = useCallback((newPage: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('page', newPage.toString());
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
    setTimeout(() => fetchAlertsData(), 500);
  }, [searchParams, router, pathname, fetchAlertsData]);

  const handleBulkAction = useCallback(() => {
    if (selectedAlerts.size === 0) return;
    setShowBulkConfirm(true);
  }, [selectedAlerts]);

  const confirmBulkAction = useCallback(() => {
    if (!bulkAction || selectedAlerts.size === 0) return;
    executeAction('bulk', undefined, Array.from(selectedAlerts), { [bulkAction]: true });
    setSelectedAlerts(new Set());
    setShowBulkConfirm(false);
    setBulkAction(null);
    // Refresh after bulk action
    setTimeout(() => fetchAlertsData(), 500);
  }, [bulkAction, selectedAlerts, executeAction, fetchAlertsData]);


  const formatNumber = (num: number) => {
    return num.toLocaleString();
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const formatTimeAgo = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / (1000 * 60));
    const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
    const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    return `${diffDays}d ago`;
  };

  const getTypeLabel = (type: string) => {
    const label = TYPE_LABELS[type];
    return label ? label.en : type;
  };

  const getSeverityBadge = (severity: string, isSilenced?: boolean) => {
    const Icon = severityIcons[severity as keyof typeof severityIcons] || AlertCircle;
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium border ${isSilenced ? 'bg-gray-100 text-gray-600 border-gray-200' : severityColors[severity as keyof typeof severityColors]}`}>
        <Icon className="w-3 h-3" />
        {severity}
        {isSilenced && <BellOff className="w-3 h-3" />}
      </span>
    );
  };

  const getStatusBadge = (status: 'active' | 'resolved' | 'acknowledged') => {
    const Icon = statusIcons[status] || AlertCircle;
    const colors = {
      active: 'bg-red-100 text-red-800',
      resolved: 'bg-green-100 text-green-800',
      acknowledged: 'bg-blue-100 text-blue-800',
    };
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-full text-xs font-medium ${colors[status]}`}>
        <Icon className="w-3 h-3" />
        {status}
      </span>
    );
  };

  const columns: Column<Alert>[] = [
    {
      key: 'severity',
      label: t('columns.severity'),
      width: '120px',
      sortable: true,
      render: (_, row) => (
        <div className="flex items-center gap-2">
          {getSeverityBadge(row.severity, row.isSilenced)}
        </div>
      ),
    },
    {
      key: 'title',
      label: t('columns.title'),
      sortable: true,
      render: (_, row) => (
        <div>
          <div className="font-medium text-gray-900">{row.title}</div>
          <div className="text-sm text-gray-500 truncate max-w-md">{row.description}</div>
          {row.isSilenced && row.silencedUntil && (
            <div className="text-xs text-gray-400 flex items-center gap-1 mt-1">
              <Clock className="w-3 h-3" />
              {t('common.silencedUntil')}: {formatTimeAgo(row.silencedUntil)}
            </div>
          )}
        </div>
      ),
    },
    {
      key: 'type',
      label: t('columns.type'),
      width: '180px',
      sortable: true,
      render: (value) => (
        <span className="text-sm text-gray-600">{getTypeLabel(value as string)}</span>
      ),
    },
    {
      key: 'currentValue',
      label: t('columns.currentValue'),
      width: '120px',
      sortable: true,
      render: (value, row) => (
        <div>
          <div className="font-medium">{formatNumber(value as number)}</div>
          <div className="text-xs text-gray-500">
            threshold: {formatNumber(row.threshold)}
          </div>
        </div>
      ),
    },
    {
      key: 'triggeredAt',
      label: t('columns.triggeredAt'),
      width: '160px',
      sortable: true,
      render: (value) => (
        <div>
          <div className="text-sm">{formatDate(value as string)}</div>
          <div className="text-xs text-gray-500">{formatTimeAgo(value as string)}</div>
        </div>
      ),
    },
    {
      key: 'isRead',
      label: t('columns.status'),
      width: '140px',
      sortable: true,
      render: (value, row) => {
        const isActive = !row.resolvedAt;
        const isAcknowledged = row.acknowledgedAt;
        const status = isActive
          ? (isAcknowledged ? 'acknowledged' : 'active')
          : 'resolved';
        return getStatusBadge(status);
      },
    },
    {
      key: 'actions',
      label: t('columns.actions'),
      width: '280px',
      render: (_, row) => (
        <div className="flex items-center gap-1">
          {!row.isRead && (
            <button
              onClick={() => handleMarkRead(row.id)}
              disabled={actionLoading === row.id}
              className="p-1.5 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-50"
              title={t('actions.markRead')}
            >
              <Eye className="w-4 h-4" />
            </button>
          )}
          {row.isRead && !row.resolvedAt && (
            <button
              onClick={() => handleMarkUnread(row.id)}
              disabled={actionLoading === row.id}
              className="p-1.5 text-gray-500 hover:text-yellow-600 hover:bg-yellow-50 rounded disabled:opacity-50"
              title={t('actions.markUnread')}
            >
              <EyeOff className="w-4 h-4" />
            </button>
          )}
          {!row.resolvedAt && !row.acknowledgedAt && (
            <button
              onClick={() => handleAcknowledge(row.id)}
              disabled={actionLoading === row.id}
              className="p-1.5 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded disabled:opacity-50"
              title={t('actions.acknowledge')}
            >
              <Bell className="w-4 h-4" />
            </button>
          )}
          {!row.resolvedAt && (
            <>
              <button
                onClick={() => handleOpenSilenceModal(row.id)}
                disabled={actionLoading === row.id || row.isSilenced}
                className="p-1.5 text-gray-500 hover:text-orange-600 hover:bg-orange-50 rounded disabled:opacity-50"
                title={t('actions.silence')}
              >
                <BellOff className="w-4 h-4" />
              </button>
              <button
                onClick={() => handleResolve(row.id)}
                disabled={actionLoading === row.id}
                className="p-1.5 text-gray-500 hover:text-green-600 hover:bg-green-50 rounded disabled:opacity-50"
                title={t('actions.resolve')}
              >
                <CheckCircle className="w-4 h-4" />
              </button>
            </>
          )}
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header with stats */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4">
        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-l-blue-500">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{t('stats.totalAlerts')}</p>
              <p className="text-2xl font-bold text-gray-900">{formatNumber(totalAlerts)}</p>
            </div>
            <AlertCircle className="w-8 h-8 text-blue-500" />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-l-red-500">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{t('stats.activeAlerts')}</p>
              <p className="text-2xl font-bold text-red-600">{formatNumber(summaryData.activeAlerts)}</p>
            </div>
            <AlertOctagon className="w-8 h-8 text-red-500" />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-l-yellow-500">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{t('stats.unreadAlerts')}</p>
              <p className="text-2xl font-bold text-yellow-600">{formatNumber(summaryData.unreadAlerts)}</p>
            </div>
            <Bell className="w-8 h-8 text-yellow-500" />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-l-purple-500">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{t('stats.critical')}</p>
              <p className="text-2xl font-bold text-red-600">{formatNumber(summaryData.criticalCount)}</p>
            </div>
            <AlertOctagon className="w-8 h-8 text-red-500" />
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-4 border-l-4 border-l-orange-500">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-500">{t('stats.silenced')}</p>
              <p className="text-2xl font-bold text-gray-600">{formatNumber(summaryData.bySeverity?.['silenced'] || alerts.filter(a => a.isSilenced && !a.resolvedAt).length)}</p>
            </div>
            <BellOff className="w-8 h-8 text-gray-500" />
          </div>
        </div>
      </div>

      {/* Auto-refresh status indicator */}
      <div className="flex items-center justify-between bg-white rounded-lg shadow p-3 border border-gray-100">
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2">
            {connectionStatus === 'connected' ? (
              <Wifi className="w-4 h-4 text-green-500" />
            ) : (
              <WifiOff className="w-4 h-4 text-red-500" />
            )}
            <span className="text-xs text-gray-500">
              {connectionStatus === 'connected' ? t('common.connected') : t('common.disconnected')}
            </span>
          </div>
          <div className="text-xs text-gray-400">
            {t('common.lastRefresh')}: {lastRefresh.toLocaleTimeString()}
            {isRefreshing && <span className="ml-2 text-blue-500">({t('common.updating')}...)</span>}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(e) => setAutoRefresh(e.target.checked)}
              className="w-4 h-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
            />
            <span className="text-sm text-gray-600">{t('common.autoRefresh')}</span>
          </label>
          {autoRefresh && (
            <select
              value={refreshInterval / 1000}
              onChange={(e) => setRefreshInterval(parseInt(e.target.value) * 1000)}
              className="px-2 py-1 text-xs border border-gray-300 rounded"
            >
              <option value="10">10s</option>
              <option value="30">30s</option>
              <option value="60">1m</option>
              <option value="300">5m</option>
            </select>
          )}
          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* Filters and Actions */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-col lg:flex-row gap-4 items-start lg:items-center justify-between">
          {/* Filters */}
          <div className="flex flex-wrap gap-3">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-gray-400" />
              <span className="text-sm text-gray-600">{t('filters.status')}:</span>
              <select
                value={initialFilters.status || 'active'}
                onChange={(e) => handleFilterChangeWithRefresh('status', e.target.value)}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
              >
                {STATUS_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">{t('filters.severity')}:</span>
              <select
                value={initialFilters.severity || 'all'}
                onChange={(e) => handleFilterChangeWithRefresh('severity', e.target.value)}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
              >
                {SEVERITY_OPTIONS.map(opt => (
                  <option key={opt.value} value={opt.value}>
                    {t(opt.labelKey)}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">{t('filters.readStatus')}:</span>
              <select
                value={initialFilters.isRead === undefined ? 'all' : initialFilters.isRead ? 'read' : 'unread'}
                onChange={(e) => {
                  const val = e.target.value;
                  handleFilterChangeWithRefresh('isRead', val === 'all' ? undefined : val === 'read' ? 'true' : 'false');
                }}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">{t('filters.all')}</option>
                <option value="unread">{t('filters.unread')}</option>
                <option value="read">{t('filters.read')}</option>
              </select>
            </div>

            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">{t('filters.silenced')}:</span>
              <select
                value={initialFilters.isSilenced === undefined ? 'all' : initialFilters.isSilenced ? 'silenced' : 'notSilenced'}
                onChange={(e) => {
                  const val = e.target.value;
                  handleFilterChangeWithRefresh('isSilenced', val === 'all' ? undefined : val === 'silenced' ? 'true' : 'false');
                }}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
              >
                <option value="all">{t('filters.all')}</option>
                <option value="silenced">{t('filters.silenced')}</option>
                <option value="notSilenced">{t('filters.notSilenced')}</option>
              </select>
            </div>
          </div>

          {/* Bulk Actions */}
          {selectedAlerts.size > 0 && (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">
                {t('bulk.selected', { count: selectedAlerts.size })}
              </span>
              <select
                value={bulkAction || ''}
                onChange={(e) => setBulkAction(e.target.value as typeof bulkAction)}
                className="px-2 py-1.5 text-sm border border-gray-300 rounded focus:ring-2 focus:ring-indigo-500"
              >
                <option value="">{t('bulk.selectAction')}</option>
                <option value="markRead">{t('bulk.markRead')}</option>
                <option value="markUnread">{t('bulk.markUnread')}</option>
                <option value="acknowledge">{t('bulk.acknowledge')}</option>
                <option value="resolve">{t('bulk.resolve')}</option>
              </select>
              <button
                onClick={handleBulkAction}
                disabled={!bulkAction}
                className="px-3 py-1.5 text-sm bg-indigo-600 text-white rounded hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('bulk.apply')}
              </button>
              <button
                onClick={() => setSelectedAlerts(new Set())}
                className="px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50"
              >
                {t('bulk.clear')}
              </button>
            </div>
          )}

          {/* Refresh button */}
          <button
            onClick={handleManualRefresh}
            disabled={isRefreshing}
            className="flex items-center gap-2 px-3 py-1.5 text-sm text-gray-600 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isRefreshing ? 'animate-spin' : ''}`} />
            {t('common.refresh')}
          </button>
        </div>
      </div>

      {/* Alerts Table */}
      <Table
        data={alerts}
        columns={columns}
        total={totalAlerts}
        page={currentPage}
        totalPages={totalPages}
        limit={limit}
        defaultSortBy="triggeredAt"
        defaultSortOrder="desc"
        searchable={true}
        onPageChange={handlePageChange}
        onLimitChange={handleLimitChange}
        onSortChange={(sortBy, sortOrder) => {
          const params = new URLSearchParams(searchParams);
          params.set('sortBy', sortBy);
          params.set('sortOrder', sortOrder);
          startTransition(() => router.push(`${pathname}?${params.toString()}`));
          setTimeout(() => fetchAlertsData(), 500);
        }}
        onSearch={(search) => {
          const params = new URLSearchParams(searchParams);
          if (search) {
            params.set('search', search);
          } else {
            params.delete('search');
          }
          params.set('page', '1');
          startTransition(() => router.push(`${pathname}?${params.toString()}`));
          setTimeout(() => fetchAlertsData(), 500);
        }}
        exportFileName="alerts"
        isLoading={isPending || isRefreshing}
        emptyMessage={t('empty.noAlerts')}
      />

      {/* Silence Modal */}
      {showSilenceModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <BellOff className="w-5 h-5 text-orange-500" />
                {t('silence.title')}
              </h3>
              <button
                onClick={() => setShowSilenceModal(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              {t('silence.description')}
            </p>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('silence.duration')}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {SNOOZE_OPTIONS.map(opt => (
                    <button
                      key={opt.value}
                      onClick={() => setSnoozeDuration(opt.value)}
                      className={`px-3 py-2 text-sm rounded-lg border transition-colors ${
                        snoozeDuration === opt.value
                          ? 'bg-orange-100 border-orange-300 text-orange-700'
                          : 'bg-white border-gray-200 hover:border-orange-200'
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  {t('silence.reason')} ({t('common.optional')})
                </label>
                <textarea
                  value={snoozeReason}
                  onChange={(e) => setSnoozeReason(e.target.value)}
                  rows={3}
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-orange-500 focus:border-transparent text-sm"
                  placeholder={t('silence.reasonPlaceholder')}
                />
              </div>
            </div>

            <div className="flex justify-end gap-3 mt-6">
              <button
                onClick={() => setShowSilenceModal(null)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSilence}
                disabled={actionLoading === showSilenceModal}
                className="px-4 py-2 text-sm bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 flex items-center gap-2"
              >
                {actionLoading === showSilenceModal ? (
                  <RefreshCw className="w-4 h-4 animate-spin" />
                ) : (
                  <BellOff className="w-4 h-4" />
                )}
                {t('silence.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bulk Confirm Modal */}
      {showBulkConfirm && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl max-w-md w-full mx-4 p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
                <AlertCircle className="w-5 h-5 text-orange-500" />
                {t('bulk.confirmTitle')}
              </h3>
              <button
                onClick={() => setShowBulkConfirm(false)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <p className="text-sm text-gray-600 mb-4">
              {t('bulk.confirmMessage', { count: selectedAlerts.size, action: bulkAction ?? '' })}
            </p>

            <div className="flex justify-end gap-3">
              <button
                onClick={() => setShowBulkConfirm(false)}
                className="px-4 py-2 text-sm text-gray-600 border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={confirmBulkAction}
                className="px-4 py-2 text-sm bg-red-600 text-white rounded-lg hover:bg-red-700 flex items-center gap-2"
              >
                <AlertCircle className="w-4 h-4" />
                {t('bulk.confirm')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
