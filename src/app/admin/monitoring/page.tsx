'use client';

import { useEffect, useState } from 'react';
import { RefreshCw, AlertTriangle, CheckCircle, XCircle, Activity, HardDrive, Clock, BarChart3, BellOff } from 'lucide-react';

interface MetricSnapshot {
  storage: {
    bytes: number;
    mb: number;
    pageCount: number;
  };
  queries: {
    total: number;
    avgDurationMs: number;
    maxDurationMs: number;
    slowQueries: number;
    avgRowsScanned: number;
  };
}

interface Alert {
  id: string;
  configId: string;
  configName: string;
  severity: 'info' | 'warning' | 'critical';
  metricType: string;
  currentValue: number;
  thresholdValue: number;
  triggeredAt: string;
  status?: 'active' | 'resolved' | 'acknowledged';
}

interface Snooze {
  id: string;
  alertConfigId: string;
  durationMinutes: number;
  createdAt: string;
  expiresAt: string;
  reason: string | null;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function formatSnoozeDuration(minutes: number): string {
  if (minutes === 60) return '1 hour';
  if (minutes === 360) return '6 hours';
  if (minutes === 1440) return '24 hours';
  return `${minutes} minutes`;
}

export default function MonitoringDashboard() {
  const [metrics, setMetrics] = useState<MetricSnapshot | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [snoozes, setSnoozes] = useState<Snooze[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchData = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/monitoring/d1');
      if (!res.ok) throw new Error('Failed to fetch monitoring data');
      const data = await res.json();
      if (data.success) {
        setMetrics(data.data);
        setAlerts(data.alerts || []);
        setSnoozes(data.snoozes || []);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setLoading(false);
    }
  };

  const acknowledgeAlert = async (alertId: string) => {
    try {
      await fetch('/api/monitoring/d1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'acknowledge', alertId }),
      });
      setAlerts(alerts.filter(a => a.id !== alertId));
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };

  const resolveAlert = async (alertId: string) => {
    try {
      await fetch('/api/monitoring/d1', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'resolve', alertId }),
      });
      setAlerts(alerts.filter(a => a.id !== alertId));
    } catch (err) {
      console.error('Failed to resolve alert:', err);
    }
  };

  const snoozeAlert = async (alertConfigId: string, durationMinutes: number, reason?: string) => {
    try {
      const res = await fetch('/api/monitoring/d1/snoozes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          alertConfigId,
          durationMinutes,
          reason: reason || 'Manual snooze from admin dashboard',
        }),
      });
      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Failed to snooze alert');
      }
      await fetchData(); // Refresh to show updated snoozes and alerts
    } catch (err) {
      console.error('Failed to snooze alert:', err);
      alert(err instanceof Error ? err.message : 'Failed to snooze alert');
    }
  };

  const cancelSnooze = async (snoozeId: string) => {
    try {
      const res = await fetch(`/api/monitoring/d1/snoozes/${snoozeId}`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        throw new Error('Failed to cancel snooze');
      }
      await fetchData(); // Refresh
    } catch (err) {
      console.error('Failed to cancel snooze:', err);
      alert('Failed to cancel snooze');
    }
  };

  useEffect(() => {
    fetchData();
    // Auto-refresh every 60 seconds
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, []);

  const activeAlerts = alerts.filter(a => a.status === 'active');
  const storageGB = metrics ? metrics.storage.bytes / (1024 * 1024 * 1024) : 0;
  const storagePercent = Math.min((storageGB / 10) * 100, 100);

  // Build a map of snoozed config IDs for quick lookup
  const snoozedConfigIds = new Set(snoozes.map(s => s.alertConfigId));

  // Alert configs data
  const alertConfigs = [
    { id: 'alert-slow-query', name: 'Slow Query Alert', metric: 'query_duration (avg)', threshold: '> 1000 ms', severity: 'warning' as const },
    { id: 'alert-storage', name: 'High Storage Usage', metric: 'storage_usage (%)', threshold: '≥ 80%', severity: 'critical' as const },
    { id: 'alert-slow-count', name: 'Excessive Slow Queries', metric: 'slow_query_count', threshold: '> 10', severity: 'warning' as const },
    { id: 'alert-rows-scanned', name: 'High Row Scan Count', metric: 'rows_scanned (avg)', threshold: '> 10000', severity: 'warning' as const },
  ];

  return (
    <div className="container mx-auto py-8">
      <div className="flex justify-between items-center mb-8">
        <div>
          <h1 className="text-3xl font-bold text-gray-900">D1 Database Monitoring</h1>
          <p className="text-gray-500 mt-1">
            Real-time metrics and alerts for your D1 database
          </p>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {loading ? (
            <RefreshCw className="h-4 w-4 animate-spin" />
          ) : (
            <BarChart3 className="h-4 w-4" />
          )}
          Refresh
        </button>
      </div>

      {error && (
        <div className="mb-8 p-4 border border-red-200 bg-red-50 rounded-lg">
          <div className="flex items-center gap-2 text-red-600">
            <XCircle className="h-5 w-5" />
            <span className="font-medium">Error: {error}</span>
          </div>
        </div>
      )}

      {/* Metrics Cards */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-sm font-medium text-gray-500">Storage Usage</h3>
            <HardDrive className="h-4 w-4 text-gray-400" />
          </div>
          <div className="text-2xl font-bold text-gray-900">{storageGB.toFixed(2)} GB</div>
          <div className="mt-2 h-2 w-full rounded-full bg-gray-200">
            <div
              className={`h-full rounded-full transition-all ${
                storagePercent > 80 ? 'bg-red-500' : storagePercent > 60 ? 'bg-yellow-500' : 'bg-green-500'
              }`}
              style={{ width: `${storagePercent}%` }}
            />
          </div>
          <p className="text-xs text-gray-500 mt-1">
            {storagePercent.toFixed(1)}% of 10GB quota
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-sm font-medium text-gray-500">Avg Query Duration</h3>
            <Clock className="h-4 w-4 text-gray-400" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {metrics ? formatDuration(metrics.queries.avgDurationMs) : '--'}
          </div>
          <p className="text-xs text-gray-500">
            Max: {metrics ? formatDuration(metrics.queries.maxDurationMs) : '--'}
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-sm font-medium text-gray-500">Total Queries</h3>
            <Activity className="h-4 w-4 text-gray-400" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {metrics?.queries.total.toLocaleString() ?? '--'}
          </div>
          <p className="text-xs text-gray-500">
            Slow queries: {metrics?.queries.slowQueries ?? 0}
          </p>
        </div>

        <div className="bg-white border border-gray-200 rounded-lg p-6 shadow-sm">
          <div className="flex items-center justify-between pb-2">
            <h3 className="text-sm font-medium text-gray-500">Avg Rows Scanned</h3>
            <BarChart3 className="h-4 w-4 text-gray-400" />
          </div>
          <div className="text-2xl font-bold text-gray-900">
            {metrics ? metrics.queries.avgRowsScanned.toLocaleString() : '--'}
          </div>
          <p className="text-xs text-gray-500">
            per query
          </p>
        </div>
      </div>

      {/* Alerts Section */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm mb-8">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Active Alerts</h2>
          <p className="text-sm text-gray-500">
            Threshold violations requiring attention
          </p>
        </div>
        <div className="p-6">
          {activeAlerts.length === 0 ? (
            <div className="flex items-center gap-2 text-green-600 py-4">
              <CheckCircle className="h-5 w-5" />
              <span className="font-medium">No active alerts - all metrics within thresholds</span>
            </div>
          ) : (
            <div className="space-y-4">
              {activeAlerts.map(alert => {
                const isSnoozed = snoozedConfigIds.has(alert.configId);
                return (
                  <div
                    key={alert.id}
                    className={`rounded-lg border p-4 ${
                      isSnoozed
                        ? 'border-gray-200 bg-gray-50 opacity-75'
                        : alert.severity === 'critical'
                        ? 'border-red-200 bg-red-50'
                        : alert.severity === 'warning'
                        ? 'border-yellow-200 bg-yellow-50'
                        : 'border-blue-200 bg-blue-50'
                    }`}
                  >
                    <div className="flex items-start justify-between">
                      <div className="flex items-center gap-2">
                        {isSnoozed ? (
                          <BellOff className="h-5 w-5 flex-shrink-0 text-gray-500" />
                        ) : (
                          <AlertTriangle
                            className={`h-5 w-5 flex-shrink-0 ${
                              alert.severity === 'critical'
                                ? 'text-red-600'
                                : alert.severity === 'warning'
                                ? 'text-yellow-600'
                                : 'text-blue-600'
                            }`}
                          />
                        )}
                        <div>
                          <p className="font-medium text-gray-900">
                            {alert.configName}
                            {isSnoozed && (
                              <span className="ml-2 px-2 py-0.5 text-xs font-medium rounded-full bg-gray-100 text-gray-600">
                                Snoozed
                              </span>
                            )}
                          </p>
                          <p className="text-sm text-gray-600">
                            {alert.metricType}: <span className="font-mono font-medium">{alert.currentValue.toLocaleString()}</span>
                            {' / threshold: '}{alert.thresholdValue.toLocaleString()}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 ml-4">
                        <span
                          className={`px-2 py-1 text-xs font-medium rounded-full ${
                            alert.severity === 'critical'
                              ? 'bg-red-100 text-red-800'
                              : alert.severity === 'warning'
                              ? 'bg-yellow-100 text-yellow-800'
                              : 'bg-blue-100 text-blue-800'
                          }`}
                        >
                          {alert.severity}
                        </span>
                        {isSnoozed ? (
                          <span className="px-3 py-1 text-sm border border-gray-300 rounded bg-gray-100 text-gray-600">
                            Snoozed
                          </span>
                        ) : (
                          <>
                            <button
                              onClick={() => acknowledgeAlert(alert.id)}
                              className="px-3 py-1 text-sm border border-gray-300 rounded hover:bg-gray-50"
                            >
                              Acknowledge
                            </button>
                            <button
                              onClick={() => resolveAlert(alert.id)}
                              className="px-3 py-1 text-sm bg-blue-600 text-white rounded hover:bg-blue-700"
                            >
                              Resolve
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-gray-500 mt-2">
                      Triggered: {new Date(alert.triggeredAt).toLocaleString()}
                    </p>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Active Snoozes Section */}
      {snoozes.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-lg shadow-sm mb-8">
          <div className="px-6 py-4 border-b border-gray-200">
            <h2 className="text-lg font-semibold text-gray-900">Silenced Alerts</h2>
            <p className="text-sm text-gray-500">
              Alert configurations currently snoozed and not sending notifications
            </p>
          </div>
          <div className="p-6">
            <div className="space-y-4">
              {snoozes.map(snooze => (
                <div
                  key={snooze.id}
                  className="rounded-lg border border-gray-200 bg-gray-50 p-4"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <BellOff className="h-5 w-5 text-gray-500" />
                      <div>
                        <p className="font-medium text-gray-900">
                          {snooze.alertConfigId}
                        </p>
                        <p className="text-sm text-gray-500">
                          Snoozed for {formatSnoozeDuration(snooze.durationMinutes)}
                          {' · Expires '}{new Date(snooze.expiresAt).toLocaleString()}
                        </p>
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="px-2 py-1 text-xs font-medium rounded-full bg-gray-100 text-gray-700">
                        silenced
                      </span>
                      <button
                        onClick={() => cancelSnooze(snooze.id)}
                        className="px-3 py-1 text-sm border border-red-300 text-red-700 rounded hover:bg-red-50"
                      >
                        Cancel Snooze
                      </button>
                    </div>
                  </div>
                  {snooze.reason && (
                    <p className="text-sm text-gray-500 mt-2">
                      Reason: {snooze.reason}
                    </p>
                  )}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Alert Configs Section */}
      <div className="bg-white border border-gray-200 rounded-lg shadow-sm">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-semibold text-gray-900">Alert Configurations</h2>
          <p className="text-sm text-gray-500">
            Configured thresholds for D1 metrics
          </p>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left py-3 px-4 font-medium text-gray-600">Name</th>
                <th className="text-left py-3 px-4 font-medium text-gray-600">Metric</th>
                <th className="text-left py-3 px-4 font-medium text-gray-600">Threshold</th>
                <th className="text-left py-3 px-4 font-medium text-gray-600">Severity</th>
                <th className="text-left py-3 px-4 font-medium text-gray-600">Status</th>
                <th className="text-left py-3 px-4 font-medium text-gray-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {alertConfigs.map(config => {
                const isSnoozed = snoozedConfigIds.has(config.id);
                return (
                  <tr key={config.id} className="border-t border-gray-200">
                    <td className="py-3 px-4 text-gray-900">{config.name}</td>
                    <td className="py-3 px-4 text-gray-600">{config.metric}</td>
                    <td className="py-3 px-4">
                      <code className="px-2 py-1 bg-gray-100 rounded text-xs">
                        {config.threshold}
                      </code>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                        config.severity === 'critical'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-yellow-100 text-yellow-800'
                      }`}>
                        {config.severity}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      <span className={`px-2 py-1 rounded-full text-xs font-medium ${
                        isSnoozed
                          ? 'bg-gray-100 text-gray-700'
                          : 'bg-green-100 text-green-800'
                      }`}>
                        {isSnoozed ? 'snoozed' : 'enabled'}
                      </span>
                    </td>
                    <td className="py-3 px-4">
                      {isSnoozed ? (
                        <button
                          onClick={() => {
                            const snooze = snoozes.find(s => s.alertConfigId === config.id);
                            if (snooze) cancelSnooze(snooze.id);
                          }}
                          className="px-3 py-1 text-sm border border-green-300 text-green-700 rounded hover:bg-green-50"
                        >
                          Cancel Snooze
                        </button>
                      ) : (
                        <div className="flex gap-1">
                          <button
                            onClick={() => snoozeAlert(config.id, 60, `1 hour from config: ${config.name}`)}
                            className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                            title="Snooze for 1 hour"
                          >
                            1h
                          </button>
                          <button
                            onClick={() => snoozeAlert(config.id, 360, `6 hours from config: ${config.name}`)}
                            className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                            title="Snooze for 6 hours"
                          >
                            6h
                          </button>
                          <button
                            onClick={() => snoozeAlert(config.id, 1440, `24 hours from config: ${config.name}`)}
                            className="px-2 py-1 text-xs border border-gray-300 rounded hover:bg-gray-50"
                            title="Snooze for 24 hours"
                          >
                            24h
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
