'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { ShieldAlert, Ban, FileText, CheckCircle } from 'lucide-react';
import {
  FlaggedClickDetail,
  FraudStatsSummary,
  PaginationMeta,
} from '@/types/fraud';
import { FraudHeader } from './FraudHeader';
import { FraudKpiCards } from './FraudKpiCards';
import { FraudFilterToolbar, FraudFiltersState } from './FraudFilterToolbar';
import { FlaggedClicksTable } from './FlaggedClicksTable';
import { AnomalyBreakdownDrawer } from './AnomalyBreakdownDrawer';
import { BulkActionBar } from './BulkActionBar';
import { BlockIpModal } from './BlockIpModal';
import { BulkActionModal } from './BulkActionModal';
import { BlockedIpsView } from './BlockedIpsView';
import { AuditTrailView } from './AuditTrailView';

export type ExtendedFraudStats = FraudStatsSummary & {
  activeBlockedIps?: number;
  fraudRate24h?: number;
};

interface FraudDashboardProps {
  locale: string;
  initialClicks?: FlaggedClickDetail[];
  initialStats?: ExtendedFraudStats;
  initialPagination?: PaginationMeta;
}

const defaultStats: ExtendedFraudStats = {
  totalClicksEvaluated: 0,
  totalFlaggedClicks: 0,
  flaggedPercentage: 0,
  totalBlockedIps: 0,
  activeBlockedIps: 0,
  pendingReviews: 0,
  approvedReviews: 0,
  rejectedReviews: 0,
  burstClicksCount: 0,
  ratioAnomaliesCount: 0,
  rateLimitViolationsCount: 0,
  topFlaggedAffiliates: [],
  topFlaggedIps: [],
  fraudRate24h: 0,
};

export const FraudDashboard: React.FC<FraudDashboardProps> = ({
  initialClicks = [],
  initialStats,
  initialPagination,
}) => {
  // Navigation tabs
  const [activeTab, setActiveTab] = useState<'clicks' | 'blocked-ips' | 'audit'>('clicks');

  // Core data states
  const [clicks, setClicks] = useState<FlaggedClickDetail[]>(initialClicks);
  const [stats, setStats] = useState<ExtendedFraudStats>(
    initialStats || defaultStats
  );
  const [pagination, setPagination] = useState<PaginationMeta>(
    initialPagination || { page: 1, limit: 20, total: 0, totalPages: 1 }
  );

  // Loading & refresh states
  const [isLoading, setIsLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [lastRefreshed, setLastRefreshed] = useState<Date>(new Date());
  const [notification, setNotification] = useState<{ message: string; type: 'success' | 'error' } | null>(null);

  // Filters state
  const [filters, setFilters] = useState<FraudFiltersState>({
    search: '',
    status: 'all',
    reason: 'ALL',
    affiliateCode: '',
    dateRange: '24h',
  });

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Modal & Drawer states
  const [inspectingClick, setInspectingClick] = useState<FlaggedClickDetail | null>(null);
  const [blockIpModalState, setBlockIpModalState] = useState<{ isOpen: boolean; ip: string; clickId?: string }>({
    isOpen: false,
    ip: '',
  });
  const [bulkActionModalState, setBulkActionModalState] = useState<{ isOpen: boolean; action: 'approve' | 'reject' }>({
    isOpen: false,
    action: 'approve',
  });

  const showNotification = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 4000);
  };

  // Fetch telemetry and clicks data
  const fetchData = useCallback(
    async (isBackground = false) => {
      if (!isBackground) {
        setIsRefreshing(true);
        setIsLoading(true);
      }

      try {
        // Build query params
        const params = new URLSearchParams();
        params.set('page', String(pagination.page));
        params.set('limit', String(pagination.limit));
        if (filters.status !== 'all') params.set('status', filters.status);
        if (filters.reason !== 'ALL') params.set('reason', filters.reason);
        if (filters.affiliateCode) params.set('affiliateId', filters.affiliateCode);
        if (filters.search) params.set('search', filters.search);

        if (filters.dateRange === '24h') {
          params.set('dateFrom', new Date(Date.now() - 24 * 3600 * 1000).toISOString());
        } else if (filters.dateRange === '7d') {
          params.set('dateFrom', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
        } else if (filters.dateRange === '30d') {
          params.set('dateFrom', new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString());
        }

        // Fetch clicks and stats in parallel
        const [clicksRes, statsRes] = await Promise.all([
          fetch(`/api/admin/fraud/clicks?${params.toString()}`),
          fetch('/api/admin/fraud/stats'),
        ]);

        if (clicksRes.ok) {
          const clicksJson = await clicksRes.json();
          setClicks(clicksJson.data || clicksJson.clicks || []);
          if (clicksJson.pagination) {
            setPagination(clicksJson.pagination);
          }
        }

        if (statsRes.ok) {
          const statsJson = await statsRes.json();
          setStats(statsJson.data || statsJson.stats || defaultStats);
        }

        setLastRefreshed(new Date());
      } catch (err) {
        console.error('Failed to fetch fraud dashboard data:', err);
      } finally {
        setIsRefreshing(false);
      }
    },
    [pagination.page, pagination.limit, filters]
  );

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  // Automated 30s polling
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      fetchData(true);
    }, 30000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Selection handlers
  const handleToggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleToggleSelectAll = () => {
    const allVisibleSelected = clicks.length > 0 && clicks.every((c) => selectedIds.has(c.id));
    if (allVisibleSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(clicks.map((c) => c.id)));
    }
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
  };

  // Filter handlers
  const handleFilterChange = (newFilters: Partial<FraudFiltersState>) => {
    setFilters((prev) => ({ ...prev, ...newFilters }));
    setPagination((prev) => ({ ...prev, page: 1 }));
    setSelectedIds(new Set());
  };

  const handleResetFilters = () => {
    setFilters({
      search: '',
      status: 'all',
      reason: 'ALL',
      affiliateCode: '',
      dateRange: '24h',
    });
    setPagination((prev) => ({ ...prev, page: 1 }));
    setSelectedIds(new Set());
  };

  // Action handlers
  const handleApprove = async (click: FlaggedClickDetail) => {
    const reason = window.prompt(
      `Approve click ${click.id} as legitimate? Reason:`,
      'Manual inspection verified legitimate trade'
    );
    if (!reason || !reason.trim()) return;

    try {
      const res = await fetch('/api/admin/fraud/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'approve',
          clickId: click.id,
          reason: reason.trim(),
        }),
      });

      if (res.ok) {
        showNotification(`Click ${click.id} approved successfully`);
        if (inspectingClick?.id === click.id) setInspectingClick(null);
        await fetchData(true);
      } else {
        const err = await res.json();
        showNotification(err.error || 'Failed to approve click', 'error');
      }
    } catch (err: any) {
      showNotification(err.message || 'Network error approving click', 'error');
    }
  };

  const handleReject = async (click: FlaggedClickDetail) => {
    const reason = window.prompt(
      `Reject click ${click.id} as fraudulent? Reason:`,
      'Confirmed attribution anomaly'
    );
    if (!reason || !reason.trim()) return;

    try {
      const res = await fetch('/api/admin/fraud/actions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'reject',
          clickId: click.id,
          reason: reason.trim(),
        }),
      });

      if (res.ok) {
        showNotification(`Click ${click.id} rejected successfully`);
        if (inspectingClick?.id === click.id) setInspectingClick(null);
        await fetchData(true);
      } else {
        const err = await res.json();
        showNotification(err.error || 'Failed to reject click', 'error');
      }
    } catch (err: any) {
      showNotification(err.message || 'Network error rejecting click', 'error');
    }
  };

  const handleBlockIpSubmit = async (ip: string, reason: string, expiresAt?: string | null) => {
    const res = await fetch('/api/admin/fraud/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'block_ip',
        ip,
        reason,
        expiresAt,
        clickId: blockIpModalState.clickId,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Failed to block IP');
    }

    showNotification(`IP address ${ip} added to edge blacklist`);
    await fetchData(true);
  };

  const handleBulkActionSubmit = async (
    action: 'approve' | 'reject',
    reason: string,
    blockIpAlso?: boolean
  ) => {
    const clickIds = Array.from(selectedIds);
    const res = await fetch('/api/admin/fraud/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'bulk_resolve',
        clickIds,
        resolution: action,
        reason,
        blockIpAlso,
      }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || `Failed to bulk ${action} clicks`);
    }

    showNotification(`Bulk ${action} executed for ${clickIds.length} clicks`);
    setSelectedIds(new Set());
    await fetchData(true);
  };

  const handleUnblockIp = async (ip: string, reason: string) => {
    const res = await fetch('/api/admin/fraud/actions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'unblock_ip',
        ip,
        reason,
      }),
    });

    if (res.ok) {
      showNotification(`IP ${ip} removed from blacklist`);
      await fetchData(true);
    } else {
      const data = await res.json();
      showNotification(data.error || 'Failed to unblock IP', 'error');
    }
  };

  const handleExportReport = () => {
    if (clicks.length === 0) {
      showNotification('No click data available to export', 'error');
      return;
    }

    const headers = ['Click ID', 'Deal ID', 'Affiliate', 'IP', 'Anomaly Score', 'Reasons', 'Status', 'Timestamp'];
    const rows = clicks.map((c) => [
      c.id,
      c.dealId,
      c.affiliateCode || c.affiliateId || 'Direct',
      c.ipAddress || '',
      c.anomalyScore.toFixed(4),
      (c.flagReasons || []).join('; '),
      c.reviewStatus,
      c.createdAt,
    ]);

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      [headers.join(','), ...rows.map((e) => e.map((val) => `"${val}"`).join(','))].join('\n');

    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `fraud_clicks_report_${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="container mx-auto px-4 py-8 max-w-7xl">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center gap-2 px-4 py-2.5 rounded-xl shadow-lg border text-xs font-semibold animate-in fade-in slide-in-from-top-2 ${
            notification.type === 'error'
              ? 'bg-red-50 text-red-800 border-red-200'
              : 'bg-emerald-50 text-emerald-800 border-emerald-200'
          }`}
        >
          <CheckCircle className="w-4 h-4" />
          <span>{notification.message}</span>
        </div>
      )}

      {/* Header */}
      <FraudHeader
        isRefreshing={isRefreshing}
        autoRefresh={autoRefresh}
        lastRefreshed={lastRefreshed}
        onRefresh={() => fetchData()}
        onToggleAutoRefresh={() => setAutoRefresh((prev) => !prev)}
        onOpenBlockIpModal={() => setBlockIpModalState({ isOpen: true, ip: '' })}
        onExportReport={handleExportReport}
      />

      {/* KPI Cards */}
      <FraudKpiCards stats={stats} isLoading={isLoading} />

      {/* Sub-Navigation Tabs */}
      <div className="border-b border-gray-200 mb-6">
        <nav className="flex space-x-8">
          <button
            type="button"
            onClick={() => setActiveTab('clicks')}
            className={`py-3 px-1 border-b-2 font-medium text-xs flex items-center gap-2 transition-colors ${
              activeTab === 'clicks'
                ? 'border-blue-600 text-blue-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            <span>Flagged Suspicious Clicks</span>
            <span className="ml-1 bg-red-100 text-red-700 py-0.5 px-2 rounded-full text-[10px] font-bold">
              {stats.pendingReviews ?? 0}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('blocked-ips')}
            className={`py-3 px-1 border-b-2 font-medium text-xs flex items-center gap-2 transition-colors ${
              activeTab === 'blocked-ips'
                ? 'border-purple-600 text-purple-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <Ban className="w-4 h-4" />
            <span>Active Blocked IPs</span>
            <span className="ml-1 bg-purple-100 text-purple-700 py-0.5 px-2 rounded-full text-[10px] font-bold">
              {stats.activeBlockedIps ?? 0}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('audit')}
            className={`py-3 px-1 border-b-2 font-medium text-xs flex items-center gap-2 transition-colors ${
              activeTab === 'audit'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <FileText className="w-4 h-4" />
            <span>Immutable Audit Trail</span>
          </button>
        </nav>
      </div>

      {/* Tab 1: Clicks Queue */}
      {activeTab === 'clicks' && (
        <>
          <FraudFilterToolbar
            filters={filters}
            onFilterChange={handleFilterChange}
            onResetFilters={handleResetFilters}
            isLoading={isLoading}
          />

          <FlaggedClicksTable
            clicks={clicks}
            selectedIds={selectedIds}
            isLoading={isLoading}
            onToggleSelect={handleToggleSelect}
            onToggleSelectAll={handleToggleSelectAll}
            onInspect={(click) => setInspectingClick(click)}
            onApprove={handleApprove}
            onReject={handleReject}
            onBlockIp={(ip, clickId) => setBlockIpModalState({ isOpen: true, ip, clickId })}
            onFilterByReason={(reason) => handleFilterChange({ reason })}
          />

          {/* Pagination Controls */}
          {pagination.totalPages > 1 && (
            <div className="flex items-center justify-between border-t border-gray-200 bg-white px-4 py-3 sm:px-6 rounded-b-xl">
              <div className="text-xs text-gray-700">
                Showing Page <span className="font-semibold">{pagination.page}</span> of{' '}
                <span className="font-semibold">{pagination.totalPages}</span> ({pagination.total} total clicks)
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={pagination.page <= 1}
                  onClick={() => setPagination((prev) => ({ ...prev, page: prev.page - 1 }))}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Previous
                </button>
                <button
                  type="button"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setPagination((prev) => ({ ...prev, page: prev.page + 1 }))}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50"
                >
                  Next
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Tab 2: Blocked IPs */}
      {activeTab === 'blocked-ips' && (
        <BlockedIpsView
          onOpenBlockModal={() => setBlockIpModalState({ isOpen: true, ip: '' })}
          onUnblockIp={handleUnblockIp}
        />
      )}

      {/* Tab 3: Immutable Audit Trail */}
      {activeTab === 'audit' && <AuditTrailView />}

      {/* Persistent Floating Bulk Action Bar */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        onBulkApprove={() => setBulkActionModalState({ isOpen: true, action: 'approve' })}
        onBulkReject={() => setBulkActionModalState({ isOpen: true, action: 'reject' })}
        onClearSelection={handleClearSelection}
      />

      {/* Inspection Drawer */}
      <AnomalyBreakdownDrawer
        click={inspectingClick}
        isOpen={Boolean(inspectingClick)}
        onClose={() => setInspectingClick(null)}
        onApprove={handleApprove}
        onReject={handleReject}
        onBlockIp={(ip, clickId) => setBlockIpModalState({ isOpen: true, ip, clickId })}
      />

      {/* Block IP Confirmation Modal */}
      <BlockIpModal
        isOpen={blockIpModalState.isOpen}
        targetIp={blockIpModalState.ip}
        clickId={blockIpModalState.clickId}
        onClose={() => setBlockIpModalState({ isOpen: false, ip: '' })}
        onSubmit={handleBlockIpSubmit}
      />

      {/* Bulk Action Confirmation Modal */}
      <BulkActionModal
        isOpen={bulkActionModalState.isOpen}
        action={bulkActionModalState.action}
        selectedCount={selectedIds.size}
        onClose={() => setBulkActionModalState({ isOpen: false, action: 'approve' })}
        onSubmit={handleBulkActionSubmit}
      />
    </div>
  );
};
