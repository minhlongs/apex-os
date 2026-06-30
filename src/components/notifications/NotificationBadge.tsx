'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { Bell, AlertOctagon, AlertTriangle, AlertCircle, X, ExternalLink, RefreshCw } from 'lucide-react';
import { useUnreadAlertsCount } from '@/hooks/use-unread-alerts-count';

interface AlertPreview {
  id: string;
  title: string;
  description: string;
  severity: 'info' | 'warning' | 'critical';
  triggeredAt: string;
  type: string;
}

interface NotificationBadgeProps {
  locale: string;
}

const MAX_PREVIEW_ALERTS = 5;
const POLLING_INTERVAL_MS = 30_000;

// Animation keyframes for count changes
const countChangeAnimation = `
  @keyframes badge-pop {
    0% { transform: scale(1); }
    50% { transform: scale(1.3); }
    100% { transform: scale(1); }
  }
  .badge-pop { animation: badge-pop 0.3s ease-out; }

  @keyframes badge-pulse-new {
    0%, 100% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); }
    50% { box-shadow: 0 0 0 6px rgba(239, 68, 68, 0); }
  }
  .badge-pulse-new { animation: badge-pulse-new 2s ease-in-out infinite; }
`;

const severityIcons = {
  critical: AlertOctagon,
  warning: AlertTriangle,
  info: AlertCircle,
};

const severityColors = {
  critical: 'bg-red-500 hover:bg-red-600',
  warning: 'bg-yellow-500 hover:bg-yellow-600',
  info: 'bg-blue-500 hover:bg-blue-600',
};

function formatTimeAgo(dateString: string): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / (1000 * 60));
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${diffDays}d ago`;
}

function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
}

function AlertPreviewItem({ alert }: { alert: AlertPreview }) {
  const SeverityIcon = severityIcons[alert.severity];
  const t = useTranslations('admin.alerts');

  return (
    <div className="flex items-start gap-3 p-3 hover:bg-gray-50 transition-colors border-b border-gray-100 last:border-0">
      <div className={`mt-0.5 p-1 rounded-full ${severityColors[alert.severity].replace('hover:bg-', 'bg-').replace('hover:', '')}`}>
        <SeverityIcon className="w-3 h-3 text-white" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-gray-900 truncate">{truncateText(alert.title, 50)}</p>
        <p className="text-xs text-gray-500 mt-0.5">{formatTimeAgo(alert.triggeredAt)}</p>
      </div>
    </div>
  );
}

function TooltipContent({
  alerts,
  loading,
  onRefresh,
  onViewAll,
  unreadCount
}: {
  alerts: AlertPreview[];
  loading: boolean;
  onRefresh: () => void;
  onViewAll: () => void;
  unreadCount: number;
}) {
  const t = useTranslations('admin.alerts');

  return (
    <div className="absolute right-0 mt-2 w-80 bg-white rounded-lg shadow-xl border border-gray-200 z-50 overflow-hidden" style={{ top: '100%' }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b border-gray-100">
        <div>
          <h4 className="text-sm font-semibold text-gray-900">{t('badge.unreadAlerts')}</h4>
          <p className="text-xs text-gray-500">{unreadCount} {t('stats.unreadAlerts').toLowerCase()}</p>
        </div>
        <button
          onClick={onRefresh}
          disabled={loading}
          className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded transition-colors disabled:opacity-50"
          title={t('common.refresh')}
        >
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Alerts List */}
      <div className="max-h-80 overflow-y-auto">
        {loading ? (
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-brand-500"></div>
          </div>
        ) : alerts.length === 0 ? (
          <div className="py-8 text-center">
            <Bell className="w-8 h-8 text-gray-300 mx-auto mb-2" />
            <p className="text-sm text-gray-500">{t('badge.noUnreadAlerts')}</p>
          </div>
        ) : (
          <>
            {alerts.map(alert => (
              <AlertPreviewItem key={alert.id} alert={alert} />
            ))}
            {/* See all link */}
            <div className="p-3 bg-gray-50 border-t border-gray-100">
              <button
                onClick={onViewAll}
                className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium text-brand-600 hover:text-brand-700 hover:bg-brand-50 rounded transition-colors"
              >
                {t('badge.viewAllAlerts')}
                <ExternalLink className="w-3 h-3" />
              </button>
            </div>
          </>
        )}
      </div>

      {/* Tooltip Arrow */}
      <div className="absolute top-0 right-6 -mt-1.5 w-3 h-3 bg-white border-l border-t border-gray-200 transform rotate-45"></div>
    </div>
  );
}

export default function NotificationBadge({ locale }: NotificationBadgeProps) {
  const t = useTranslations('admin.alerts');
  const { count: unreadCount, loading, error, refresh } = useUnreadAlertsCount();

  const [previewAlerts, setPreviewAlerts] = useState<AlertPreview[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [showTooltip, setShowTooltip] = useState(false);
  const [prevCount, setPrevCount] = useState(unreadCount);
  const [isAnimating, setIsAnimating] = useState(false);

  const badgeRef = useRef<HTMLButtonElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // Detect count changes for animation
  useEffect(() => {
    if (unreadCount !== prevCount) {
      setIsAnimating(true);
      const timer = setTimeout(() => setIsAnimating(false), 300);
      setPrevCount(unreadCount);
      return () => clearTimeout(timer);
    }
  }, [unreadCount, prevCount]);

  // Fetch recent unread alerts for tooltip
  const fetchPreviewAlerts = useCallback(async () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    abortControllerRef.current = new AbortController();

    try {
      setPreviewLoading(true);
      const response = await fetch('/api/admin/alerts?limit=5&status=active&isRead=false', {
        signal: abortControllerRef.current.signal,
      });

      if (response.ok) {
        const data = await response.json();
        if (data.success && data.data) {
          setPreviewAlerts(data.data.slice(0, MAX_PREVIEW_ALERTS));
        }
      }
    } catch (err) {
      if (err instanceof Error && err.name !== 'AbortError') {
        console.error('Failed to fetch alert preview:', err);
      }
    } finally {
      setPreviewLoading(false);
    }
  }, []);

  // Fetch preview alerts when tooltip opens
  useEffect(() => {
    if (showTooltip) {
      fetchPreviewAlerts();
    }
  }, [showTooltip, fetchPreviewAlerts]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      abortControllerRef.current?.abort();
    };
  }, []);

  // Close tooltip on click outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowTooltip(false);
      }
    };

    if (showTooltip) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [showTooltip]);

  const handleRefresh = useCallback(() => {
    refresh();
    fetchPreviewAlerts();
  }, [refresh, fetchPreviewAlerts]);

  const handleViewAll = useCallback(() => {
    window.location.href = `/${locale}/admin/alerts`;
  }, [locale]);

  // Determine badge color based on highest severity in preview
  const badgeColor = useMemo(() => {
    if (previewAlerts.length === 0) return 'bg-red-500';
    const hasCritical = previewAlerts.some(a => a.severity === 'critical');
    const hasWarning = previewAlerts.some(a => a.severity === 'warning');
    if (hasCritical) return 'bg-red-600';
    if (hasWarning) return 'bg-yellow-500';
    return 'bg-red-500';
  }, [previewAlerts]);

  const displayCount = unreadCount > 99 ? '99+' : unreadCount;

  return (
    <>
      <style jsx>{countChangeAnimation}</style>
      <div ref={containerRef} className="relative inline-flex items-center">
        <button
          ref={badgeRef}
          onClick={() => setShowTooltip(!showTooltip)}
          onMouseEnter={() => !showTooltip && setShowTooltip(true)}
          className="relative p-2 rounded-lg hover:bg-gray-100 transition-colors focus:outline-none focus:ring-2 focus:ring-brand-500"
          aria-label={`${t('nav.alerts')} - ${unreadCount} ${t('stats.unreadAlerts').toLowerCase()}`}
          aria-haspopup="true"
          aria-expanded={showTooltip}
        >
          <Bell className="w-5 h-5 text-gray-500" />

          {/* Animated Badge */}
          {unreadCount > 0 && (
            <span
              className={`absolute -top-0.5 -right-0.5 flex items-center justify-center min-w-[20px] h-5 px-1 text-xs font-bold text-white ${badgeColor} rounded-full border-2 border-white shadow-sm ${isAnimating ? 'badge-pop' : ''} ${unreadCount > 9 ? 'px-1' : ''}`}
            >
              {displayCount}
            </span>
          )}

          {/* Pulse indicator for new alerts */}
          {unreadCount > 0 && !isAnimating && (
            <span className="absolute -top-1 -right-1 flex h-3 w-3">
              <span className="badge-pulse-new animate-ping absolute inline-flex h-full w-full rounded-full bg-red-400 opacity-75"></span>
            </span>
          )}
        </button>

        {/* Tooltip */}
        {showTooltip && (
          <TooltipContent
            alerts={previewAlerts}
            loading={previewLoading}
            onRefresh={handleRefresh}
            onViewAll={handleViewAll}
            unreadCount={unreadCount}
          />
        )}
      </div>
    </>
  );
}
