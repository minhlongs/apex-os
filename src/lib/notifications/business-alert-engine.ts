/**
 * Business Alert Engine
 * Evaluates business metrics against configured thresholds and triggers alerts
 */

import { randomUUID } from 'crypto';
import type { D1Database } from '@/types/d1';
import type {
  BusinessAlertConfig,
  BusinessAlert,
  AlertEvaluationContext,
  AlertStatus,
  NotificationChannel,
  AlertDetails,
  AlertSeverity,
  BusinessMetricType,
} from '@/types/business-alerting';
import { sendBusinessAlertNotification } from './business-notifications';

// ============================================================================
// Configuration
// ============================================================================

const ALERT_EVALUATION_WINDOW_HOURS = 24;
const COOLDOWN_BUFFER_MINUTES = 1; // Add buffer to cooldown to prevent edge cases

// ============================================================================
// Alert Evaluation Functions
// ============================================================================

/**
 * Evaluate all business alerts against current metrics
 */
export async function evaluateBusinessAlerts(
  db: D1Database,
  force?: boolean
): Promise<{ triggered: BusinessAlert[]; skipped: string[] }> {
  const configs = await getEnabledAlertConfigs(db);
  const triggeredAlerts: BusinessAlert[] = [];
  const skippedAlerts: string[] = [];

  // Get current evaluation context
  const context = await buildAlertEvaluationContext(db);

  for (const config of configs) {
    // Check cooldown unless force evaluation
    if (!force && await isInCooldown(db, config.id, config.cooldown_minutes)) {
      skippedAlerts.push(config.id);
      continue;
    }

    // Evaluate the alert
    const isBreached = await evaluateAlert(config, context);

    if (isBreached) {
      const alert = await createAlert(db, config, context);
      triggeredAlerts.push(alert);

      // Send notifications asynchronously (don't await to avoid blocking)
      sendBusinessAlertNotification(config, alert, context).catch(console.error);
    } else {
      skippedAlerts.push(config.id);
    }
  }

  return { triggered: triggeredAlerts, skipped: skippedAlerts };
}

/**
 * Build comprehensive evaluation context from database
 */
async function buildAlertEvaluationContext(db: D1Database): Promise<AlertEvaluationContext> {
  const now = new Date();
  const evaluationTimestamp = now.toISOString();

  // Get revenue metrics (last 8 days for 7-day moving average)
  const eightDaysAgo = new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000);
  const revenueData = await getDailyRevenueData(db, eightDaysAgo, now);

  // Calculate revenue metrics
  const todayRevenue = revenueData[0]?.revenue || 0;
  const yesterdayRevenue = revenueData[1]?.revenue || 0;
  const last7DayAvg = calculateMovingAverage(revenueData.slice(1, 8), 'revenue');
  const revenueTrend = calculateTrend(revenueData.slice(0, 7), 'revenue');

  // Get conversion metrics (last 2 days for current rate)
  const twoDaysAgo = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const conversionData = await getDailyConversionData(db, twoDaysAgo, now);

  const todayClicks = conversionData[0]?.total_clicks || 0;
  const todayConversions = conversionData[0]?.conversions || 0;
  const todayConversionRate = todayClicks > 0 ? (todayConversions / todayClicks) * 100 : 0;
  const last7DayAvgConversion = calculateMovingAverage(conversionData.slice(0, 7), 'conversion_rate');

  // Get webhook failure stats (last hour)
  const webhookStats = await getWebhookFailureStats(db, 60);
  const webhookFailureRate = webhookStats.total_attempts > 0
    ? (webhookStats.failed_attempts / webhookStats.total_attempts) * 100
    : 0;

  // Get payout failure stats (last 24 hours)
  const payoutStats = await getPayoutFailureStats(db, 24);
  const payoutFailureRate = payoutStats.total_payouts > 0
    ? (payoutStats.failed_payouts / payoutStats.total_payouts) * 100
    : 0;

  // Get latest Stellar balance
  const stellarBalance = await getLatestStellarBalance(db);

  return {
    evaluationTimestamp,
    evaluationWindowMinutes: 120,

    // Revenue context
    todayRevenue,
    yesterdayRevenue,
    sevenDayAvgRevenue: last7DayAvg,
    revenueTrend,

    // Conversion context
    todayConversionRate,
    last7DayAvgConversionRate: last7DayAvgConversion,
    clicksToday: todayClicks,
    conversionsToday: todayConversions,

    // Webhook context
    webhookFailureRate,
    webhookTotalAttempts: webhookStats.total_attempts,
    webhookFailedAttempts: webhookStats.failed_attempts,

    // Payout context
    payoutFailureRate,
    totalPayouts: payoutStats.total_payouts,
    failedPayouts: payoutStats.failed_payouts,

    // Stellar context
    stellarBalance,
  };
}

/**
 * Evaluate a single alert configuration against context
 */
export function evaluateAlert(
  config: BusinessAlertConfig,
  context: AlertEvaluationContext
): boolean {
  let currentValue: number | undefined;

  switch (config.metric_type) {
    case 'revenue_drop':
      // Calculate percentage drop from moving average
      if (!context.todayRevenue || !context.sevenDayAvgRevenue || context.sevenDayAvgRevenue === 0) {
        return false;
      }
      const expectedRevenue = context.sevenDayAvgRevenue;
      const dropPct = ((expectedRevenue - context.todayRevenue) / expectedRevenue) * 100;
      currentValue = dropPct;
      break;

    case 'conversion_rate':
      currentValue = context.todayConversionRate;
      break;

    case 'webhook_failures':
      currentValue = context.webhookFailureRate;
      break;

    case 'payout_failures':
      currentValue = context.payoutFailureRate;
      break;

    case 'stellar_balance':
      currentValue = context.stellarBalance;
      break;
  }

  if (currentValue === undefined) {
    return false;
  }

  // Evaluate threshold based on type
  switch (config.threshold_type) {
    case 'gt':
      return currentValue > config.threshold_value;
    case 'gte':
      return currentValue >= config.threshold_value;
    case 'lt':
      return currentValue < config.threshold_value;
    case 'lte':
      return currentValue <= config.threshold_value;
    case 'eq':
      return Math.abs(currentValue - config.threshold_value) < 0.0001;
    case 'drop_pct':
      return currentValue > config.threshold_value;
    default:
      return false;
  }
}

// ============================================================================
// Alert Creation & Persistence
// ============================================================================

/**
 * Create a new alert record in database
 */
async function createAlert(
  db: D1Database,
  config: BusinessAlertConfig,
  context: AlertEvaluationContext
): Promise<BusinessAlert> {
  const alertId = randomUUID();
  const now = new Date();

  // Build details JSON
  const details = buildAlertDetails(config, context);

  await db
    .prepare(`
      INSERT INTO business_alert_history (
        id, alert_config_id, triggered_at, current_value, threshold_value, details, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      alertId,
      config.id,
      now.toISOString(),
      getCurrentValue(config, context),
      config.threshold_value,
      JSON.stringify(details),
      'active'
    )
    .run();

  return {
    id: alertId,
    config_id: config.id,
    triggered_at: now,
    current_value: getCurrentValue(config, context),
    threshold_value: config.threshold_value,
    details,
    status: 'active',
    metadata: {
      dashboardUrl: `/admin/monitoring/alerts/${alertId}`,
    },
  };
}

/**
 * Build alert details based on metric type and context
 */
function buildAlertDetails(
  config: BusinessAlertConfig,
  context: AlertEvaluationContext
): AlertDetails {
  const baseDetails: AlertDetails = {
    metricType: config.metric_type,
    severity: config.severity,
    metricName: config.name,
  };

  switch (config.metric_type) {
    case 'revenue_drop':
      return {
        ...baseDetails,
        comparisonValue: context.sevenDayAvgRevenue,
        period: 'today',
        trend: context.revenueTrend,
        affectedEntities: context.revenueTrend === 'down' ? [
          { type: 'affiliate', id: 'all', value: context.todayRevenue || 0 },
        ] : undefined,
      };

    case 'conversion_rate':
      return {
        ...baseDetails,
        comparisonValue: context.last7DayAvgConversionRate,
        period: 'today',
        affectedEntities: [
          { type: 'deal', id: 'all', value: context.conversionsToday || 0 },
        ],
      };

    case 'webhook_failures':
      return {
        ...baseDetails,
        period: 'last hour',
        affectedEntities: [
          {
            type: 'webhook',
            id: context.webhookType || 'all',
            value: context.webhookFailedAttempts || 0,
          },
        ],
      };

    case 'payout_failures':
      return {
        ...baseDetails,
        period: 'last 24h',
        affectedEntities: [
          {
            type: 'payout',
            id: 'batch',
            value: context.failedPayouts || 0,
          },
        ],
      };

    case 'stellar_balance':
      return {
        ...baseDetails,
        affectedEntities: [
          {
            type: 'affiliate',
            id: 'treasury',
            value: context.stellarBalance || 0,
          },
        ],
      };

    default:
      return baseDetails;
  }
}

function getCurrentValue(
  config: BusinessAlertConfig,
  context: AlertEvaluationContext
): number {
  switch (config.metric_type) {
    case 'revenue_drop':
      return context.todayRevenue ? ((context.sevenDayAvgRevenue || 0) - context.todayRevenue) / (context.sevenDayAvgRevenue || 1) * 100 : 0;
    case 'conversion_rate':
      return context.todayConversionRate || 0;
    case 'webhook_failures':
      return context.webhookFailureRate || 0;
    case 'payout_failures':
      return context.payoutFailureRate || 0;
    case 'stellar_balance':
      return context.stellarBalance || 0;
    default:
      return 0;
  }
}

// ============================================================================
// Alert Management Functions
// ============================================================================

/**
 * Get all enabled alert configurations
 */
export async function getEnabledAlertConfigs(db: D1Database): Promise<BusinessAlertConfig[]> {
  const result = await db
    .prepare('SELECT * FROM business_alert_configs WHERE is_enabled = 1')
    .all<BusinessAlertConfig & { alert_channels: string }>();

  return result.results.map(row => ({
    ...row,
    alert_channels: JSON.parse(row.alert_channels || '[]'),
  }));
}

/**
 * Get all alert configurations
 */
export async function getAllAlertConfigs(db: D1Database): Promise<BusinessAlertConfig[]> {
  const result = await db
    .prepare('SELECT * FROM business_alert_configs ORDER BY created_at DESC')
    .all<BusinessAlertConfig & { alert_channels: string }>();

  return result.results.map(row => ({
    ...row,
    alert_channels: JSON.parse(row.alert_channels || '[]'),
  }));
}

/**
 * Update an alert configuration
 */
export async function updateAlertConfig(
  db: D1Database,
  configId: string,
  updates: Partial<BusinessAlertConfig>
): Promise<BusinessAlertConfig | null> {
  const allowedFields = [
    'name', 'description', 'threshold_value', 'comparison_period_days',
    'moving_average_days', 'evaluation_window_minutes', 'severity',
    'alert_channels', 'cooldown_minutes', 'is_enabled'
  ];

  const setClauses: string[] = [];
  const bindings: unknown[] = [];

  for (const [key, value] of Object.entries(updates)) {
    if (!allowedFields.includes(key)) continue;

    if (key === 'alert_channels' && Array.isArray(value)) {
      setClauses.push(`${key} = ?`);
      bindings.push(JSON.stringify(value));
    } else if (typeof value !== 'undefined') {
      setClauses.push(`${key} = ?`);
      bindings.push(value);
    }
  }

  if (setClauses.length === 0) {
    return null;
  }

  bindings.push(configId);

  await db
    .prepare(`UPDATE business_alert_configs SET ${setClauses.join(', ')} WHERE id = ?`)
    .bind(...bindings)
    .run();

  // Fetch updated config
  const updated = await db
    .prepare('SELECT * FROM business_alert_configs WHERE id = ?')
    .bind(configId)
    .first<BusinessAlertConfig & { alert_channels: string }>();

  if (updated) {
    return {
      ...updated,
      alert_channels: JSON.parse(updated.alert_channels || '[]'),
    };
  }

  return null;
}

/**
 * Resolve an active alert
 */
export async function resolveAlert(
  db: D1Database,
  alertId: string,
  resolvedBy?: string
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE business_alert_history
      SET status = 'resolved', resolved_at = datetime('now'), metadata = ?
      WHERE id = ? AND status = 'active'
    `)
    .bind(JSON.stringify({ resolved_by: resolvedBy }), alertId)
    .run();

  return result.meta.changes > 0;
}

/**
 * Acknowledge an active alert
 */
export async function acknowledgeAlert(
  db: D1Database,
  alertId: string,
  acknowledgedBy?: string
): Promise<boolean> {
  const result = await db
    .prepare(`
      UPDATE business_alert_history
      SET status = 'acknowledged', metadata = ?
      WHERE id = ? AND status = 'active'
    `)
    .bind(JSON.stringify({ acknowledged_by: acknowledgedBy }), alertId)
    .run();

  return result.meta.changes > 0;
}

// ============================================================================
// Cooldown & State Checking
// ============================================================================

/**
 * Check if an alert config is in cooldown period
 */
export async function isInCooldown(
  db: D1Database,
  configId: string,
  cooldownMinutes: number
): Promise<boolean> {
  const result = await db
    .prepare(`
      SELECT COUNT(*) as count FROM business_alert_history
      WHERE alert_config_id = ?
        AND status = 'active'
        AND triggered_at >= datetime('now', '-' || ? || ' minutes')
    `)
    .bind(configId, cooldownMinutes + COOLDOWN_BUFFER_MINUTES)
    .first<{ count: number }>();

  return (result?.count || 0) > 0;
}

// ============================================================================
// Data Fetching Helpers
// ============================================================================

/**
 * Get daily revenue data from v_daily_revenue view
 */
async function getDailyRevenueData(
  db: D1Database,
  startDate: Date,
  endDate: Date
): Promise<Array<{ date: string; revenue: number }>> {
  const result = await db
    .prepare(`
      SELECT date, total_revenue as revenue FROM v_daily_revenue
      WHERE date >= ? AND date <= ?
      ORDER BY date DESC
    `)
    .bind(startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0])
    .all<{ date: string; revenue: number }>();

  return result.results;
}

/**
 * Get daily conversion data from v_conversion_rates view
 */
async function getDailyConversionData(
  db: D1Database,
  startDate: Date,
  endDate: Date
): Promise<Array<{ date: string; total_clicks: number; conversions: number; conversion_rate: number }>> {
  const result = await db
    .prepare(`
      SELECT
        date,
        total_clicks,
        total_conversions as conversions,
        conversion_rate_percent as conversion_rate
      FROM v_conversion_rates
      WHERE date >= ? AND date <= ?
      ORDER BY date DESC
    `)
    .bind(startDate.toISOString().split('T')[0], endDate.toISOString().split('T')[0])
    .all<{ date: string; total_clicks: number; conversions: number; conversion_rate: number }>();

  return result.results;
}

/**
 * Get webhook failure stats from tracking table
 */
async function getWebhookFailureStats(
  db: D1Database,
  windowMinutes: number
): Promise<{ total_attempts: number; successful_attempts: number; failed_attempts: number }> {
  const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();

  const result = await db
    .prepare(`
      SELECT
        COALESCE(SUM(total_attempts), 0) as total,
        COALESCE(SUM(successful_attempts), 0) as success,
        COALESCE(SUM(failed_attempts), 0) as failed
      FROM webhook_failure_stats
      WHERE window_end >= ?
    `)
    .bind(windowStart)
    .first<{ total: number; success: number; failed: number }>();

  if (!result) {
    return { total_attempts: 0, successful_attempts: 0, failed_attempts: 0 };
  }

  return {
    total_attempts: result.total || 0,
    successful_attempts: result.success || 0,
    failed_attempts: result.failed || 0,
  };
}

/**
 * Get payout failure stats from payouts table
 */
async function getPayoutFailureStats(
  db: D1Database,
  windowHours: number
): Promise<{ total_payouts: number; successful_payouts: number; failed_payouts: number }> {
  const windowStart = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  const result = await db
    .prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as success,
        SUM(CASE WHEN status IN ('failed', 'error', 'cancelled') THEN 1 ELSE 0 END) as failed
      FROM payouts
      WHERE created_at >= ?
    `)
    .bind(windowStart)
    .first<{ total: number; success: number; failed: number }>();

  if (!result) {
    return { total_payouts: 0, successful_payouts: 0, failed_payouts: 0 };
  }

  return {
    total_payouts: result.total || 0,
    successful_payouts: result.success || 0,
    failed_payouts: result.failed || 0,
  };
}

/**
 * Get latest Stellar balance from history table
 */
async function getLatestStellarBalance(db: D1Database): Promise<number> {
  const result = await db
    .prepare(`
      SELECT balance_usdc FROM stellar_balance_history
      ORDER BY recorded_at DESC
      LIMIT 1
    `)
    .first<{ balance_usdc: number }>();

  return result?.balance_usdc || 0;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Calculate moving average for a metric
 */
export function calculateMovingAverage<T extends Record<string, unknown>>(
  data: T[],
  metricKey: keyof T
): number {
  if (data.length === 0) return 0;

  const sum = data.reduce((acc, item) => {
    const value = Number(item[metricKey]) || 0;
    return acc + value;
  }, 0);
  return sum / data.length;
}

/**
 * Calculate trend direction from time series data
 */
export function calculateTrend<T extends Record<string, unknown>>(
  data: T[],
  metricKey: keyof T
): 'up' | 'down' | 'stable' {
  if (data.length < 2) return "stable";

  // Normalize to oldest-first regardless of input order, then use overlapping
  // slices so small arrays (2-3 elements) compare the same window → stable.
  const values = [...data].reverse().map(item => Number(item[metricKey]) || 0);
  const recent = values.slice(0, 3);
  const older = values.slice(-3);

  if (older.length === 0 || recent.length === 0) return "stable";

  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const changePct = ((recentAvg - olderAvg) / olderAvg) * 100;

  if (changePct > 5) return "up";
  if (changePct < -5) return "down";
  return "stable";
}


/**
 * Get active alerts count
 */
export async function getActiveAlertsCount(db: D1Database): Promise<number> {
  const result = await db
    .prepare("SELECT COUNT(*) as count FROM business_alert_history WHERE status = 'active'")
    .first<{ count: number }>();

  return result?.count || 0;
}

/**
 * Get recent alerts with pagination
 */
export async function getRecentAlerts(
  db: D1Database,
  limit: number = 50,
  offset: number = 0,
  status?: AlertStatus | 'all'
): Promise<BusinessAlert[]> {
  let query = `
    SELECT h.*, c.name as config_name, c.severity, c.metric_type
    FROM business_alert_history h
    JOIN business_alert_configs c ON h.alert_config_id = c.id
  `;

  const bindings: unknown[] = [];

  if (status && status !== 'all') {
    query += ' WHERE h.status = ?';
    bindings.push(status);
  }

  query += ' ORDER BY h.triggered_at DESC LIMIT ? OFFSET ?';
  bindings.push(limit, offset);

  const result = await db.prepare(query).bind(...bindings).all<{
    id: string;
    alert_config_id: string;
    triggered_at: string;
    current_value: number;
    threshold_value: number;
    details: string;
    status: string;
    config_name: string;
    severity: string;
    metric_type: string;
  }>();

  return result.results.map(row => ({
    id: row.id,
    config_id: row.alert_config_id,
    triggered_at: new Date(row.triggered_at),
    current_value: row.current_value,
    threshold_value: row.threshold_value,
    details: JSON.parse(row.details || '{}'),
    status: row.status as AlertStatus,
    metadata: {
      configName: row.config_name,
      severity: row.severity as AlertSeverity,
      metricType: row.metric_type as BusinessMetricType,
    },
  }));
}
