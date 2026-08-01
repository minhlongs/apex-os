/**
 * Monitoring API Routes
 * Provides endpoints for D1 metrics collection and alert management
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  runMonitoringCycle,
  getRecentMetrics,
  getActiveAlerts,
  getStoragePercentage,
  executeMonitoredQuery,
  DEFAULT_ALERT_CONFIGS,
  AlertConfig,
  getActiveSnoozes,
} from '@/lib/monitoring/d1-monitor';
import type { D1MetricsHistoryRow, D1SlowQueryRow } from '@/types/d1';
import { error as logError } from '@/lib/logger';

// ============================================================================
// Types
// ============================================================================

interface MonitoringResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  alerts?: Array<{
    id: string;
    configId: string;
    configName: string;
    severity: string;
    metricType: string;
    currentValue: number;
    thresholdValue: number;
    triggeredAt: string;
  }>;
  snoozes?: Array<{
    id: string;
    alertConfigId: string;
    durationMinutes: number;
    createdAt: string;
    expiresAt: string;
    reason: string | null;
  }>;
}

// ============================================================================
// GET /api/monitoring/d1
// ============================================================================
// Returns current metrics and active alerts
// Also can trigger a manual collection via ?run=true

export async function GET(request: NextRequest): Promise<NextResponse<MonitoringResponse>> {
  try {
    // @ts-ignore - D1 binding from wrangler.toml
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const shouldRun = url.searchParams.get('run') === 'true';

    let alerts: MonitoringResponse['alerts'] = [];
    let metricsSnapshot: { storagePercentage: number; recentMetricsCount: number; activeAlertsCount: number } | null = null;
    let activeSnoozes: MonitoringResponse['snoozes'] = [];

    // Always fetch active snoozes
    const snoozes = await getActiveSnoozes(db);
    activeSnoozes = snoozes.map(s => ({
      id: s.id,
      alertConfigId: s.alertConfigId,
      durationMinutes: s.durationMinutes,
      createdAt: s.createdAt.toISOString(),
      expiresAt: s.expiresAt.toISOString(),
      reason: s.reason,
    }));

    if (shouldRun) {
      // Run manual monitoring cycle
      const { snapshot, alerts: newAlerts } = await runMonitoringCycle(db);

      const storageGB = snapshot.storage.storageBytes / (1024 * 1024 * 1024);
      metricsSnapshot = {
        storagePercentage: (storageGB / 10) * 100, // Assuming 10GB quota
        recentMetricsCount: 1,
        activeAlertsCount: newAlerts.length,
      };

      alerts = newAlerts.map(a => ({
        id: a.id,
        configId: a.configId,
        configName: (a.details.metricName as string | undefined) ?? a.configId,
        severity: (a.details.severity as string | undefined) ?? 'warning',
        metricType: (a.details.metricType as string | undefined) ?? 'unknown',
        currentValue: a.currentValue,
        thresholdValue: a.thresholdValue,
        triggeredAt: a.triggeredAt.toISOString(),
      }));
    } else {
      // Just fetch current status
      const storagePercentage = await getStoragePercentage(db);
      const activeAlerts = await getActiveAlerts(db);

      alerts = activeAlerts.map(a => ({
        id: a.id,
        configId: a.configId,
        configName: a.configName ?? (a.details.metricName as string | undefined) ?? 'Unknown',
        severity: (a.details.severity as string | undefined) ?? 'warning',
        metricType: (a.details.metricType as string | undefined) ?? 'unknown',
        currentValue: a.currentValue,
        thresholdValue: a.thresholdValue,
        triggeredAt: a.triggeredAt.toISOString(),
      }));

      metricsSnapshot = {
        storagePercentage,
        recentMetricsCount: 0,
        activeAlertsCount: activeAlerts.length,
      };
    }

    return NextResponse.json({
      success: true,
      data: metricsSnapshot,
      alerts,
      snoozes: activeSnoozes,
    });
  } catch (error) {
    logError('Monitoring API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST /api/monitoring/d1
// ============================================================================
// Run monitoring cycle and optionally acknowledge/resolve alerts

export async function POST(request: NextRequest): Promise<NextResponse<MonitoringResponse>> {
  try {
    const body = await request.json();
    const { action, alertId } = body as { action?: 'acknowledge' | 'resolve'; alertId?: string };

    // @ts-ignore - D1 binding from wrangler.toml
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    if (action === 'acknowledge' && alertId) {
      await db
        .prepare('UPDATE d1_alert_history SET status = ? WHERE id = ?')
        .bind('acknowledged', alertId)
        .run();

      return NextResponse.json({ success: true, data: { action: 'acknowledged', alertId } });
    }

    if (action === 'resolve' && alertId) {
      await db
        .prepare('UPDATE d1_alert_history SET status = ?, resolved_at = datetime("now") WHERE id = ?')
        .bind('resolved', alertId)
        .run();

      return NextResponse.json({ success: true, data: { action: 'resolved', alertId } });
    }

    // Default: run monitoring cycle
    const { snapshot, alerts } = await runMonitoringCycle(db);

    return NextResponse.json({
      success: true,
      data: {
        timestamp: snapshot.timestamp.toISOString(),
        storage: {
          bytes: snapshot.storage.storageBytes,
          mb: snapshot.storage.storageBytes / 1024 / 1024,
          pageCount: snapshot.storage.pageCount,
        },
        queries: {
          total: snapshot.queryMetrics.totalQueries,
          avgDurationMs: snapshot.queryMetrics.avgDurationMs,
          maxDurationMs: snapshot.queryMetrics.maxDurationMs,
          slowQueries: snapshot.queryMetrics.slowQueryCount,
          avgRowsScanned: snapshot.queryMetrics.totalQueries > 0
            ? snapshot.queryMetrics.totalRowsScanned / snapshot.queryMetrics.totalQueries
            : 0,
        },
      },
      alerts: alerts.map(a => ({
        id: a.id,
        configId: a.configId,
        configName: (a.details.metricName as string | undefined) ?? a.configId,
        severity: (a.details.severity as string | undefined) ?? 'warning',
        metricType: (a.details.metricType as string | undefined) ?? 'unknown',
        currentValue: a.currentValue,
        thresholdValue: a.thresholdValue,
        triggeredAt: a.triggeredAt.toISOString(),
      })),
    });
  } catch (error) {
    logError('Monitoring API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/monitoring/d1/config
// ============================================================================
// Get or update alert configurations

export async function GET_CONFIG(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const configs = await db
      .prepare('SELECT * FROM d1_alert_configs ORDER BY created_at ASC')
      .all<AlertConfig & { id: string }>();

    return NextResponse.json({
      success: true,
      data: configs,
      defaultConfigs: DEFAULT_ALERT_CONFIGS,
    });
  } catch (error) {
    logError('Get config error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST /api/monitoring/d1/config
// ============================================================================
// Update alert configuration

export async function POST_CONFIG(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { config } = body as { config: Partial<AlertConfig> & { id?: string } };

    if (!config?.id) {
      return NextResponse.json(
        { success: false, error: 'Config ID required' },
        { status: 400 }
      );
    }

    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const allowedFields = [
      'name', 'description', 'threshold_type', 'threshold_value',
      'evaluation_window_minutes', 'severity', 'alert_channels',
      'cooldown_minutes', 'is_enabled'
    ];

    const setClause = allowedFields
      .filter(f => config[f as keyof typeof config] !== undefined)
      .map(f => `${snakeCase(f)} = ?`)
      .join(', ');

    if (setClause) {
      const values = allowedFields
        .filter(f => config[f as keyof typeof config] !== undefined)
        .map(f => {
          const val = config[f as keyof typeof config];
          if (f === 'alert_channels' && Array.isArray(val)) {
            return JSON.stringify(val);
          }
          return val;
        });

      await db
        .prepare(`UPDATE d1_alert_configs SET ${setClause}, updated_at = datetime('now') WHERE id = ?`)
        .bind(...values, config.id)
        .run();
    }

    return NextResponse.json({ success: true });
  } catch (error) {
    logError('Update config error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/monitoring/d1/history
// ============================================================================
// Get metrics history

export async function GET_HISTORY(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const hours = parseInt(url.searchParams.get('hours') ?? '24', 10);
    const limit = parseInt(url.searchParams.get('limit') ?? '100', 10);

    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const rows = await db
      .prepare(`
        SELECT * FROM d1_metrics_history
        WHERE timestamp >= datetime('now', '-' || ? || ' hours')
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .bind(hours, limit)
      .all<D1MetricsHistoryRow>();

    const data = (rows.results as D1MetricsHistoryRow[]).map(row => ({
      id: row.id,
      timestamp: row.timestamp,
      storage: {
        bytes: row.storage_bytes,
        mb: row.storage_bytes / 1024 / 1024,
        pageCount: row.page_count,
      },
      queries: {
        avgDurationMs: row.avg_query_duration_ms,
        maxDurationMs: row.max_query_duration_ms,
        slowQueryCount: row.slow_query_count,
        totalQueries: row.total_queries,
        avgRowsScanned: row.total_rows_scanned / Math.max(row.total_queries, 1),
      },
    }));

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logError('History error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// GET /api/monitoring/d1/slow-queries
// ============================================================================
// Get recent slow queries

export async function GET_SLOW_QUERIES(request: NextRequest): Promise<NextResponse> {
  try {
    const url = new URL(request.url);
    const hours = parseInt(url.searchParams.get('hours') ?? '24', 10);
    const limit = parseInt(url.searchParams.get('limit') ?? '50', 10);

    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const rows = await db
      .prepare(`
        SELECT * FROM d1_slow_queries
        WHERE logged_at >= datetime('now', '-' || ? || ' hours')
        ORDER BY logged_at DESC, duration_ms DESC
        LIMIT ?
      `)
      .bind(hours, limit)
      .all<D1SlowQueryRow>();

    const data = (rows.results as D1SlowQueryRow[]).map(row => ({
      id: row.id,
      loggedAt: row.logged_at,
      queryText: row.query_text,
      durationMs: row.duration_ms,
      rowsScanned: row.rows_scanned,
      rowsReturned: row.rows_returned,
      endpointPath: row.endpoint_path,
      userId: row.user_id,
    }));

    return NextResponse.json({ success: true, data });
  } catch (error) {
    logError('Slow queries error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// Utility
// ============================================================================

function snakeCase(str: string): string {
  return str.replace(/[A-Z]/g, letter => `_${letter.toLowerCase()}`);
}
