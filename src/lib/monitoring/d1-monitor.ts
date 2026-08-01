/**
 * D1 Metrics Monitoring System
 *
 * Collects and monitors D1 database metrics:
 * - Query duration (slow query detection)
 * - Rows scanned
 * - Storage usage
 *
 * Triggers alerts based on configurable thresholds.
 */

import { randomUUID } from 'crypto';
import type { D1Database, D1QueryResult, D1MetricsHistoryRow, D1SlowQueryRow, D1AlertConfigRow, D1AlertWithConfigRow, D1AlertHistoryRow, D1AlertSnoozeRow } from '@/types/d1';
import { error as logError, warn as logWarn } from '@/lib/logger';

// ============================================================================
// Configuration
// ============================================================================

export const SLOW_QUERY_THRESHOLD_MS = 1000;
export const METRICS_EVALUATION_WINDOW_MINUTES = 60;

// ============================================================================
// Types

export interface D1StorageMetrics {
  storageBytes: number;
  pageCount: number;
  pageSize: number;
  walSizeBytes: number;
}

export interface D1QueryMetrics {
  durationMs: number;
  rowsScanned: number;
  rowsReturned: number;
  queryText: string;
  endpointPath?: string;
  userId?: string;
}

export interface D1MetricsSnapshot {
  timestamp: Date;
  storage: D1StorageMetrics;
  queryMetrics: {
    avgDurationMs: number;
    maxDurationMs: number;
    slowQueryCount: number;
    totalQueries: number;
    totalRowsScanned: number;
  };
  cacheHitRatio?: number | null;
}

export interface AlertConfig {
  id: string;
  name: string;
  description?: string;
  metricType: 'query_duration' | 'storage_usage' | 'rows_scanned' | 'slow_query_count' | 'cache_hit_ratio';
  thresholdType: 'gt' | 'lt' | 'gte' | 'lte' | 'eq';
  thresholdValue: number;
  evaluationWindowMinutes: number;
  severity: 'info' | 'warning' | 'critical';
  alertChannels: string[];
  cooldownMinutes: number;
  isEnabled: boolean;
}

export interface Alert {
  id: string;
  configId: string;
  configName?: string;
  triggeredAt: Date;
  currentValue: number;
  thresholdValue: number;
  details: Record<string, unknown>;
  status: 'active' | 'resolved' | 'acknowledged';
}

// ============================================================================
// Default Alert Configs (matches database defaults)
// ============================================================================

export const DEFAULT_ALERT_CONFIGS: AlertConfig[] = [
  {
    id: 'alert-slow-query',
    name: 'Slow Query Alert',
    description: 'Triggers when average query duration exceeds 1 second',
    metricType: 'query_duration',
    thresholdType: 'gt',
    thresholdValue: 1000,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    alertChannels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'alert-storage',
    name: 'High Storage Usage',
    description: 'Triggers when storage usage exceeds 80% of allocated quota',
    metricType: 'storage_usage',
    thresholdType: 'gte',
    thresholdValue: 80,
    evaluationWindowMinutes: 60,
    severity: 'critical',
    alertChannels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'alert-slow-count',
    name: 'Excessive Slow Queries',
    description: 'Triggers when more than 10 queries exceed 1s in the evaluation window',
    metricType: 'slow_query_count',
    thresholdType: 'gt',
    thresholdValue: 10,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    alertChannels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'alert-rows-scanned',
    name: 'High Row Scan Count',
    description: 'Triggers when average rows scanned per query exceeds 10000',
    metricType: 'rows_scanned',
    thresholdType: 'gt',
    thresholdValue: 10000,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    alertChannels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
];

// ============================================================================
// Storage Metrics Collector
// ============================================================================

/**
 * Collects storage metrics from D1 database using PRAGMA statements
 */
export async function collectStorageMetrics(db: D1Database): Promise<D1StorageMetrics> {
  try {
    // Get page count and page size
    const pageCountResult = await db.prepare('PRAGMA page_count').first<{ page_count: number }>();
    const pageSizeResult = await db.prepare('PRAGMA page_size').first<{ page_size: number }>();

    const pageCount = pageCountResult?.page_count ?? 0;
    const pageSize = pageSizeResult?.page_size ?? 0;
    const storageBytes = pageCount * pageSize;

    // Get WAL file size if available (approximate via freelist info)
    // Note: WAL size tracking may vary based on D1 implementation
    let walSizeBytes = 0;
    try {
      const walInfo = await db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').run();
      // WAL info not directly exposed, this is a placeholder
      walSizeBytes = 0;
    } catch {
      walSizeBytes = 0;
    }

    return {
      storageBytes,
      pageCount,
      pageSize,
      walSizeBytes,
    };
  } catch (error) {
    logError('Failed to collect storage metrics:', error);
    throw error;
  }
}

// ============================================================================
// Query Performance Collector (Deprecated - use direct persistence)
// ============================================================================

/**
 * Note: The in-memory collector is not used in serverless environments
 * because state doesn't persist across invocations. Instead, slow queries
 * are persisted directly to the d1_slow_queries table.
 */
class QueryMetricsCollector {
  private queries: D1QueryMetrics[] = [];
  private slowQueryThresholdMs: number = SLOW_QUERY_THRESHOLD_MS;

  constructor(slowQueryThresholdMs?: number) {
    if (slowQueryThresholdMs) {
      this.slowQueryThresholdMs = slowQueryThresholdMs;
    }
  }

  recordQuery(metrics: D1QueryMetrics): void {
    this.queries.push(metrics);
    // Auto-persist slow queries to database
    if (metrics.durationMs > this.slowQueryThresholdMs) {
      // This will be called within a request context; we need DB but don't have it here.
      // Instead, executeMonitoredQuery will handle persistence.
    }
  }

  getAndClearMetrics(): { avgDurationMs: number; maxDurationMs: number; slowQueryCount: number; totalQueries: number; totalRowsScanned: number } {
    if (this.queries.length === 0) {
      return {
        avgDurationMs: 0,
        maxDurationMs: 0,
        slowQueryCount: 0,
        totalQueries: 0,
        totalRowsScanned: 0,
      };
    }

    const totalDuration = this.queries.reduce((sum, q) => sum + q.durationMs, 0);
    const maxDuration = Math.max(...this.queries.map(q => q.durationMs));
    const slowQueries = this.queries.filter(q => q.durationMs > this.slowQueryThresholdMs);
    const totalRowsScanned = this.queries.reduce((sum, q) => sum + q.rowsScanned, 0);

    const result = {
      avgDurationMs: totalDuration / this.queries.length,
      maxDurationMs: maxDuration,
      slowQueryCount: slowQueries.length,
      totalQueries: this.queries.length,
      totalRowsScanned,
    };

    this.queries = [];
    return result;
  }

  getSlowQueries(): D1QueryMetrics[] {
    return this.queries.filter(q => q.durationMs > this.slowQueryThresholdMs);
  }

  setSlowQueryThreshold(thresholdMs: number): void {
    this.slowQueryThresholdMs = thresholdMs;
  }
}

// Global collector instance (legacy, not used for cron)
export const queryMetricsCollector = new QueryMetricsCollector(SLOW_QUERY_THRESHOLD_MS);

// ============================================================================
// Metrics Storage
// ============================================================================

/**
 * Save metrics snapshot to database
 */
export async function saveMetricsSnapshot(
  db: D1Database,
  snapshot: D1MetricsSnapshot
): Promise<void> {
  const sql = `
    INSERT INTO d1_metrics_history (
      timestamp, storage_bytes, page_count, page_size,
      avg_query_duration_ms, max_query_duration_ms, slow_query_count,
      total_queries, total_rows_scanned, cache_hit_ratio, wal_size_bytes
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;

  await db
    .prepare(sql)
    .bind(
      snapshot.timestamp.toISOString(),
      snapshot.storage.storageBytes,
      snapshot.storage.pageCount,
      snapshot.storage.pageSize,
      snapshot.queryMetrics.avgDurationMs,
      snapshot.queryMetrics.maxDurationMs,
      snapshot.queryMetrics.slowQueryCount,
      snapshot.queryMetrics.totalQueries,
      snapshot.queryMetrics.totalRowsScanned,
      snapshot.cacheHitRatio ?? null,
      snapshot.storage.walSizeBytes
    )
    .run();
}

/**
 * Save slow queries to log table
 */
export async function saveSlowQueries(
  db: D1Database,
  queries: D1QueryMetrics[]
): Promise<void> {
  if (queries.length === 0) return;

  const sql = `
    INSERT INTO d1_slow_queries (query_text, duration_ms, rows_scanned, rows_returned, endpoint_path, user_id, context)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const stmt = db.prepare(sql);

  for (const query of queries) {
    await stmt
      .bind(
        query.queryText,
        query.durationMs,
        query.rowsScanned,
        query.rowsReturned,
        query.endpointPath ?? null,
        query.userId ?? null,
        JSON.stringify({}) // Empty context for now
      )
      .run();
  }
}

// ============================================================================
// Alert Notifications
// ============================================================================

/**
 * Send alert notifications via configured channels
 */
export async function sendAlertNotifications(
  config: AlertConfig,
  alert: Alert
): Promise<void> {
  for (const channel of config.alertChannels) {
    switch (channel) {
      case 'email':
        await sendEmailAlert(config, alert);
        break;
      case 'webhook':
        await sendWebhookAlert(config, alert);
        break;
      case 'slack':
        await sendSlackAlert(config, alert);
        break;
    }
  }
}

/**
 * Send email alert via Resend
 */
async function sendEmailAlert(config: AlertConfig, alert: Alert): Promise<void> {
  const resendApiKey = process.env.RESEND_API_KEY;
  const alertEmail = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL;

  if (!resendApiKey || !alertEmail) {
    logWarn('Email alerts not configured: RESEND_API_KEY or ALERT_EMAIL missing');
    return;
  }

  const severityEmoji = config.severity === 'critical' ? '🔴' : config.severity === 'warning' ? '🟡' : '🟢';

  const subject = `[${severityEmoji} ${config.severity.toUpperCase()}] ApexOS D1 Alert: ${config.name}`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background: ${config.severity === 'critical' ? '#dc2626' : '#f59e0b'}; color: white; padding: 15px; border-radius: 8px 8px 0 0; }
        .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
        .metric { background: white; padding: 12px; margin: 10px 0; border-radius: 6px; border-left: 4px solid ${config.severity === 'critical' ? '#dc2626' : '#f59e0b'}; }
        .metric-label { font-weight: 600; color: #6b7280; font-size: 12px; text-transform: uppercase; }
        .metric-value { font-size: 24px; font-weight: 700; color: #111827; }
        .threshold { color: #ef4444; font-size: 14px; }
        .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0;">${config.name}</h1>
          <p style="margin: 5px 0 0; opacity: 0.9;">ApexOS Database Monitoring</p>
        </div>
        <div class="content">
          <p><strong>Status:</strong> <span style="color: ${config.severity === 'critical' ? '#dc2626' : '#f59e0b'}">${config.severity.toUpperCase()}</span></p>

          <div class="metric">
            <div class="metric-label">Current Value</div>
            <div class="metric-value">${formatMetricValue(config.metricType, alert.currentValue)}</div>
            <div class="threshold">Threshold: ${config.thresholdType} ${formatMetricValue(config.metricType, config.thresholdValue)}</div>
          </div>

          <h3>Details</h3>
          <ul style="padding-left: 20px;">
            <li><strong>Triggered:</strong> ${new Date(alert.triggeredAt).toLocaleString()}</li>
            <li><strong>Metric Type:</strong> ${config.metricType}</li>
            <li><strong>Severity:</strong> ${config.severity}</li>
            <li><strong>Alert ID:</strong> ${alert.id}</li>
          </ul>

          <div class="footer">
            <p>This alert was generated automatically by the ApexOS monitoring system.</p>
            <p>View the monitoring dashboard: <a href="https://apex-os.pages.dev/admin/monitoring">Admin Dashboard</a></p>
          </div>
        </div>
      </div>
    </body>
    </html>
  `;

  const textContent = `
[${config.severity.toUpperCase()}] ${config.name}

Current Value: ${formatMetricValue(config.metricType, alert.currentValue)}
Threshold: ${config.thresholdType} ${formatMetricValue(config.metricType, config.thresholdValue)}

Triggered: ${new Date(alert.triggeredAt).toLocaleString()}
Metric Type: ${config.metricType}
Alert ID: ${alert.id}

View dashboard: https://apex-os.pages.dev/admin/monitoring
  `;

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${resendApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: 'ApexOS Monitoring <monitoring@apex-os.com>',
        to: [alertEmail],
        subject,
        html: htmlContent,
        text: textContent,
      }),
    });

    if (!response.ok) {
      const error = await response.text();
      logError('Failed to send email alert:', error);
    }
  } catch (error) {
    logError('Error sending email alert:', error);
  }
}

/**
 * Send webhook alert
 */
async function sendWebhookAlert(config: AlertConfig, alert: Alert): Promise<void> {
  const webhookUrl = process.env.ALERT_WEBHOOK_URL;
  if (!webhookUrl) return;

  try {
    await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        alert: config.name,
        severity: config.severity,
        metricType: config.metricType,
        currentValue: alert.currentValue,
        thresholdValue: config.thresholdValue,
        triggeredAt: alert.triggeredAt,
        details: alert.details,
      }),
    });
  } catch (error) {
    logError('Error sending webhook alert:', error);
  }
}

/**
 * Send Slack alert
 */
async function sendSlackAlert(config: AlertConfig, alert: Alert): Promise<void> {
  const slackWebhook = process.env.SLACK_WEBHOOK_URL;
  if (!slackWebhook) return;

  const emoji = config.severity === 'critical' ? '🔴' : '🟡';

  try {
    await fetch(slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `${emoji} *${config.name}*`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${emoji} *${config.name}*\n<${config.severity.toUpperCase()}> alert triggered`,
            },
          },
          {
            type: 'section',
            fields: [
              { type: 'mrkdwn', text: `*Current Value:*\n${formatMetricValue(config.metricType, alert.currentValue)}` },
              { type: 'mrkdwn', text: `*Threshold:*\n${config.thresholdType} ${formatMetricValue(config.metricType, config.thresholdValue)}` },
              { type: 'mrkdwn', text: `*Metric:*\n${config.metricType}` },
              { type: 'mrkdwn', text: `*Triggered:*\n${new Date(alert.triggeredAt).toLocaleString()}` },
            ],
          },
        ],
      }),
    });
  } catch (error) {
    logError('Error sending Slack alert:', error);
  }
}

/**
 * Format metric value for display
 */
function formatMetricValue(metricType: string, value: number): string {
  switch (metricType) {
    case 'query_duration':
    case 'rows_scanned':
      return `${Math.round(value).toLocaleString()} ms`;
    case 'storage_usage':
      return `${value.toFixed(1)}%`;
    case 'slow_query_count':
      return `${Math.round(value)} queries`;
    case 'cache_hit_ratio':
      return `${(value * 100).toFixed(1)}%`;
    default:
      return value.toFixed(2);
  }
}

// ============================================================================
// Main Monitoring Runner
// ============================================================================

/**
 * Run a complete monitoring cycle
 *
 * In serverless environments, this computes query metrics from the
 * d1_slow_queries table instead of relying on in-memory collectors.
 */
export async function runMonitoringCycle(
  db: D1Database,
  _slowQueries?: D1QueryMetrics[]
): Promise<{ snapshot: D1MetricsSnapshot; alerts: Alert[] }> {
  // Clean up expired snoozes (lightweight, idempotent)
  try {
    await cleanupExpiredSnoozes(db);
  } catch (error) {
    logWarn('Snooze cleanup failed (non-critical):', error);
  }

  // Collect storage metrics
  const storage = await collectStorageMetrics(db);

  // Compute query metrics from persistent slow queries table (last evaluation window)
  const windowMinutes = METRICS_EVALUATION_WINDOW_MINUTES;
  const slowQueryStats = await db
    .prepare(`
      SELECT
        COUNT(*) as count,
        AVG(duration_ms) as avg_duration,
        MAX(duration_ms) as max_duration,
        SUM(rows_scanned) as total_rows_scanned
      FROM d1_slow_queries
      WHERE logged_at >= datetime('now', '-' || ? || ' minutes')
    `)
    .bind(windowMinutes)
    .first<{ count: number; avg_duration: number | null; max_duration: number | null; total_rows_scanned: number | null }>();

  const slowQueryCount = slowQueryStats?.count ?? 0;
  const queryMetrics = {
    avgDurationMs: slowQueryStats?.avg_duration ?? 0,
    maxDurationMs: slowQueryStats?.max_duration ?? 0,
    slowQueryCount,
    totalQueries: slowQueryCount, // Without full query logging, slow queries = total in window
    totalRowsScanned: slowQueryStats?.total_rows_scanned ?? 0,
  };

  // Create snapshot
  const snapshot: D1MetricsSnapshot = {
    timestamp: new Date(),
    storage,
    queryMetrics,
  };

  // Save snapshot
  await saveMetricsSnapshot(db, snapshot);

  // Evaluate alerts
  const alerts = await evaluateAlerts(db, snapshot);

  return { snapshot, alerts };
}

// ============================================================================
// Query Wrapper for Automatic Metrics Collection
// ============================================================================

/**
 * Wrapper for D1 queries that automatically collects metrics
 * and persists slow queries to the database.
 *
 * Usage:
 *   const { result, metrics } = await executeMonitoredQuery(db, sql, bindings);
 */
export async function executeMonitoredQuery<T>(
  db: D1Database,
  sql: string,
  bindings?: unknown[],
  options?: { endpointPath?: string; userId?: string }
): Promise<{ result: T; metrics: D1QueryMetrics }> {
  const startTime = Date.now();
  let rowsScanned = 0;
  let result: T;

  try {
    const stmt = db.prepare(sql);
    let execResult: D1QueryResult<unknown>;
    if (bindings && bindings.length > 0) {
      execResult = await stmt.bind(...bindings).all();
    } else {
      execResult = await stmt.all();
    }

    result = execResult as unknown as T;
    rowsScanned = execResult.results.length;
  } catch (error) {
    throw error;
  }

  const durationMs = Date.now() - startTime;

  const metrics: D1QueryMetrics = {
    durationMs,
    rowsScanned,
    rowsReturned: 0,
    queryText: sql,
    endpointPath: options?.endpointPath,
    userId: options?.userId,
  };

  // Persist slow queries directly to database
  if (durationMs > SLOW_QUERY_THRESHOLD_MS) {
    try {
      await db
        .prepare(`
          INSERT INTO d1_slow_queries (query_text, duration_ms, rows_scanned, rows_returned, endpoint_path, user_id, context)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          sql,
          durationMs,
          rowsScanned,
          0,
          options?.endpointPath ?? null,
          options?.userId ?? null,
          JSON.stringify({})
        )
        .run();
    } catch (err) {
      logError('Failed to log slow query:', err);
    }
  }

  return { result, metrics };
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get current storage usage percentage (assuming 10GB quota)
 */
export async function getStoragePercentage(db: D1Database): Promise<number> {
  const metrics = await collectStorageMetrics(db);
  const quotaGB = 10;
  const storageGB = metrics.storageBytes / (1024 * 1024 * 1024);
  return (storageGB / quotaGB) * 100;
}

/**
 * Get recent metrics history
 */
export async function getRecentMetrics(
  db: D1Database,
  hours: number = 24
): Promise<D1MetricsSnapshot[]> {
  const rows = await db
    .prepare(`
      SELECT * FROM d1_metrics_history
      WHERE timestamp >= datetime('now', '-' || ? || ' hours')
      ORDER BY timestamp ASC
    `)
    .bind(hours)
    .all<D1MetricsHistoryRow>();

  return rows.results.map(row => ({
    timestamp: new Date(row.timestamp),
    storage: {
      storageBytes: row.storage_bytes,
      pageCount: row.page_count,
      pageSize: row.page_size,
      walSizeBytes: row.wal_size_bytes,
    },
    queryMetrics: {
      avgDurationMs: row.avg_query_duration_ms,
      maxDurationMs: row.max_query_duration_ms,
      slowQueryCount: row.slow_query_count,
      totalQueries: row.total_queries,
      totalRowsScanned: row.total_rows_scanned,
    },
    cacheHitRatio: row.cache_hit_ratio,
  }));
}

/**
 * Get active alerts, excluding those from snoozed configurations
 */
export async function getActiveAlerts(db: D1Database): Promise<Alert[]> {
  // First, get active snoozed config IDs
  const snoozedRows = await db
    .prepare(`
      SELECT alert_config_id
      FROM alert_snoozes
      WHERE expires_at > datetime('now')
    `)
    .all<{ alert_config_id: string }>();

  const snoozedConfigIds = new Set(snoozedRows.results.map(r => r.alert_config_id));

  const rows = await db
    .prepare(`
      SELECT h.*, c.name as config_name, c.severity, c.metric_type
      FROM d1_alert_history h
      JOIN d1_alert_configs c ON h.alert_config_id = c.id
      WHERE h.status = 'active'
      ORDER BY h.triggered_at DESC
    `)
    .all<D1AlertWithConfigRow>();

  return rows.results
    .filter(row => !snoozedConfigIds.has(row.alert_config_id))
    .map(row => ({
      id: row.id,
      configId: row.alert_config_id,
      configName: row.config_name,
      triggeredAt: new Date(row.triggered_at),
      currentValue: row.current_value,
      thresholdValue: row.threshold_value,
      details: JSON.parse(row.details || '{}'),
      status: row.status as 'active' | 'resolved' | 'acknowledged',
    }));
}

export type { D1Database } from '@/types/d1';

// ============================================================================
// Alert Snooze Types
// ============================================================================

export interface AlertSnooze {
  id: string;
  alertConfigId: string;
  snoozedBy: string | null;
  durationMinutes: number;
  createdAt: Date;
  expiresAt: Date;
  reason: string | null;
  metadata: Record<string, unknown>;
}

export interface CreateSnoozeInput {
  alertConfigId: string;
  durationMinutes: number;
  snoozedBy?: string;
  reason?: string;
  metadata?: Record<string, unknown>;
}

// ============================================================================
// Alert Snooze Management
// ============================================================================

/**
 * Check if an alert configuration is currently snoozed
 */
export async function isAlertSnoozed(
  db: D1Database,
  alertConfigId: string
): Promise<boolean> {
  const result = await db
    .prepare(`
      SELECT 1 FROM alert_snoozes
      WHERE alert_config_id = ?
        AND expires_at > datetime('now')
      LIMIT 1
    `)
    .bind(alertConfigId)
    .first<{ 1: number }>();

  return !!result;
}

/**
 * Get all active snoozes
 */
export async function getActiveSnoozes(
  db: D1Database
): Promise<AlertSnooze[]> {
  const rows = await db
    .prepare(`
      SELECT s.*, c.name as config_name, c.metric_type
      FROM alert_snoozes s
      JOIN d1_alert_configs c ON s.alert_config_id = c.id
      WHERE s.expires_at > datetime('now')
      ORDER BY s.created_at DESC
    `)
    .all<D1AlertSnoozeRow & { config_name: string; metric_type: string }>();

  return rows.results.map(row => ({
    id: row.id,
    alertConfigId: row.alert_config_id,
    snoozedBy: row.snoozed_by,
    durationMinutes: row.duration_minutes,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    reason: row.reason,
    metadata: JSON.parse(row.metadata || '{}'),
  }));
}

/**
 * Create a new snooze for an alert configuration
 */
export async function createSnooze(
  db: D1Database,
  input: CreateSnoozeInput
): Promise<AlertSnooze> {
  const { alertConfigId, durationMinutes, snoozedBy, reason, metadata } = input;

  const result = await db
    .prepare(`
      INSERT INTO alert_snoozes (alert_config_id, snoozed_by, duration_minutes, reason, metadata)
      VALUES (?, ?, ?, ?, ?)
    `)
    .bind(
      alertConfigId,
      snoozedBy ?? null,
      durationMinutes,
      reason ?? null,
      JSON.stringify(metadata ?? {})
    )
    .run();

  const snoozeId = String(result.meta.last_row_id);

  // Fetch the created snooze
  const row = await db
    .prepare('SELECT * FROM alert_snoozes WHERE id = ?')
    .bind(snoozeId)
    .first<D1AlertSnoozeRow>();

  if (!row) {
    throw new Error('Failed to create snooze');
  }

  return {
    id: row.id,
    alertConfigId: row.alert_config_id,
    snoozedBy: row.snoozed_by,
    durationMinutes: row.duration_minutes,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    reason: row.reason,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

/**
 * Delete (cancel) a snooze by ID
 */
export async function deleteSnooze(
  db: D1Database,
  snoozeId: string
): Promise<boolean> {
  const result = await db
    .prepare('DELETE FROM alert_snoozes WHERE id = ?')
    .bind(snoozeId)
    .run();

  return result.meta.changes > 0;
}

/**
 * Delete all expired snoozes
 */
export async function cleanupExpiredSnoozes(
  db: D1Database
): Promise<number> {
  const result = await db
    .prepare("DELETE FROM alert_snoozes WHERE expires_at <= datetime('now')")
    .run();

  return result.meta.changes;
}

/**
 * Get snooze info for a specific alert config
 */
export async function getSnoozeForConfig(
  db: D1Database,
  alertConfigId: string
): Promise<AlertSnooze | null> {
  const row = await db
    .prepare(`
      SELECT s.*, c.name as config_name, c.metric_type
      FROM alert_snoozes s
      JOIN d1_alert_configs c ON s.alert_config_id = c.id
      WHERE s.alert_config_id = ?
        AND s.expires_at > datetime('now')
      LIMIT 1
    `)
    .bind(alertConfigId)
    .first<D1AlertSnoozeRow & { config_name: string; metric_type: string }>();

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    alertConfigId: row.alert_config_id,
    snoozedBy: row.snoozed_by,
    durationMinutes: row.duration_minutes,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    reason: row.reason,
    metadata: JSON.parse(row.metadata || '{}'),
  };
}

/**
 * Get snooze history for an alert config
 */
export async function getSnoozeHistory(
  db: D1Database,
  alertConfigId: string,
  limit?: number
): Promise<AlertSnooze[]> {
  const rows = await db
    .prepare(`
      SELECT s.*
      FROM alert_snoozes s
      WHERE s.alert_config_id = ?
      ORDER BY s.created_at DESC
      LIMIT ?
    `)
    .bind(alertConfigId, limit ?? 50)
    .all<D1AlertSnoozeRow>();

  return rows.results.map(row => ({
    id: row.id,
    alertConfigId: row.alert_config_id,
    snoozedBy: row.snoozed_by,
    durationMinutes: row.duration_minutes,
    createdAt: new Date(row.created_at),
    expiresAt: new Date(row.expires_at),
    reason: row.reason,
    metadata: JSON.parse(row.metadata || '{}'),
  }));
}

// ============================================================================
// Modified Alert Evaluation with Snooze Support
// ============================================================================

/**
 * Evaluate a threshold condition
 */
function evaluateThreshold(
  current: number,
  thresholdType: AlertConfig['thresholdType'],
  threshold: number
): boolean {
  switch (thresholdType) {
    case 'gt': return current > threshold;
    case 'lt': return current < threshold;
    case 'gte': return current >= threshold;
    case 'lte': return current <= threshold;
    case 'eq': return Math.abs(current - threshold) < 0.0001; // Float tolerance
    default: return false;
  }
}

/**
 * Evaluate metrics against alert configurations, respecting snoozes
 */
export async function evaluateAlerts(
  db: D1Database,
  snapshot: D1MetricsSnapshot
): Promise<Alert[]> {
  // Fetch enabled alert configs
  const configsResult = await db
    .prepare('SELECT * FROM d1_alert_configs WHERE is_enabled = 1')
    .all<AlertConfig & D1AlertConfigRow>();

  // Get active snoozes for efficient lookup
  const activeSnoozes = new Set<string>();
  const snoozedRows = await db
    .prepare("SELECT alert_config_id FROM alert_snoozes WHERE expires_at > datetime('now')")
    .all<{ alert_config_id: string }>();
  for (const row of snoozedRows.results) {
    activeSnoozes.add(row.alert_config_id);
  }

  const triggeredAlerts: Alert[] = [];

  for (const config of configsResult.results) {
    // Skip if this alert config is currently snoozed
    if (activeSnoozes.has(config.id)) {
      continue;
    }

    // Check cooldown period
    const recentAlert = await db
      .prepare(`
        SELECT * FROM d1_alert_history
        WHERE alert_config_id = ? AND status = 'active'
        AND triggered_at >= datetime('now', '-' || ? || ' minutes')
      `)
      .bind(config.id, config.cooldownMinutes)
      .first();

    if (recentAlert) {
      continue; // Still in cooldown
    }

    // Evaluate threshold
    let currentValue: number;
    switch (config.metricType) {
      case 'storage_usage':
        // Calculate storage percentage (assuming 10GB quota for now)
        const storageGB = snapshot.storage.storageBytes / (1024 * 1024 * 1024);
        const quotaGB = 10; // TODO: Make configurable
        currentValue = (storageGB / quotaGB) * 100;
        break;
      case 'query_duration':
        currentValue = snapshot.queryMetrics.avgDurationMs;
        break;
      case 'slow_query_count':
        currentValue = snapshot.queryMetrics.slowQueryCount;
        break;
      case 'rows_scanned':
        currentValue = snapshot.queryMetrics.totalRowsScanned / Math.max(snapshot.queryMetrics.totalQueries, 1);
        break;
      default:
        continue;
    }

    // Check if threshold is breached
    const isBreached = evaluateThreshold(currentValue, config.thresholdType, config.thresholdValue);

    if (isBreached) {
      const alert: Alert = {
        id: randomUUID(),
        configId: config.id,
        triggeredAt: new Date(),
        currentValue,
        thresholdValue: config.thresholdValue,
        details: {
          metricType: config.metricType,
          severity: config.severity,
          metricName: config.name,
          snapshot: {
            storageBytes: snapshot.storage.storageBytes,
            avgQueryDuration: snapshot.queryMetrics.avgDurationMs,
            totalQueries: snapshot.queryMetrics.totalQueries,
          },
        },
        status: 'active',
      };
      triggeredAlerts.push(alert);

      // Record alert in database
      await db
        .prepare(`
          INSERT INTO d1_alert_history (alert_config_id, current_value, threshold_value, details, status)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(
          config.id,
          currentValue,
          config.thresholdValue,
          JSON.stringify(alert.details),
          'active'
        )
        .run();

      // Send notifications
      await sendAlertNotifications(config, alert);
    }
  }

  return triggeredAlerts;
}
