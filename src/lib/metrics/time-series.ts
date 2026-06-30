/**
 * Time-Series Metrics Utilities
 * Provides aggregation functions for business metrics with date bucketing
 */

import type { D1Database } from '@/types/d1';
import type { TimeSeriesQueryParams, TimeSeriesResponse, TimeSeriesDataPoint, TimeSeriesMetricType } from '@/types/metrics';
import { TIME_SERIES_METRIC_DEFINITIONS } from '@/types/metrics';

// ============================================================================
// Date Utilities (UTC-based)
// ============================================================================

/**
 * Truncate a date to the start of the specified interval (UTC)
 */
export function truncateToInterval(date: Date, interval: string): Date {
  const result = new Date(date);

  switch (interval) {
    case 'hour':
      result.setUTCMinutes(0, 0, 0);
      break;
    case 'day':
      result.setUTCHours(0, 0, 0, 0);
      break;
    case 'week':
      // Start of week (Sunday) in UTC
      const day = result.getUTCDay();
      result.setUTCDate(result.getUTCDate() - day);
      result.setUTCHours(0, 0, 0, 0);
      break;
    case 'month':
      result.setUTCDate(1);
      result.setUTCHours(0, 0, 0, 0);
      break;
  }

  return result;
}

/**
 * Format a date for the given interval (UTC)
 */
export function formatDateForInterval(date: Date, interval: string): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hours = String(date.getUTCHours()).padStart(2, '0');

  switch (interval) {
    case 'hour':
      return `${year}-${month}-${day}T${hours}:00:00Z`;
    case 'day':
      return `${year}-${month}-${day}`;
    case 'week':
      return `${year}-W${String(getWeekNumber(date)).padStart(2, '0')}`;
    case 'month':
      return `${year}-${month}`;
    default:
      return `${year}-${month}-${day}`;
  }
}

/**
 * Get week number from date (ISO 8601, UTC)
 */
function getWeekNumber(date: Date): number {
  // ISO week: Monday is day 1, Sunday is day 7
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return weekNo;
}

/**
 * Generate all dates in a range at the specified interval (UTC)
 */
export function generateDateRange(start: Date, end: Date, interval: string): Date[] {
  const dates: Date[] = [];
  const current = new Date(truncateToInterval(start, interval));

  while (current <= end) {
    dates.push(new Date(current));

    switch (interval) {
      case 'hour':
        current.setUTCHours(current.getUTCHours() + 1);
        break;
      case 'day':
        current.setUTCDate(current.getUTCDate() + 1);
        break;
      case 'week':
        current.setUTCDate(current.getUTCDate() + 7);
        break;
      case 'month':
        current.setUTCMonth(current.getUTCMonth() + 1);
        break;
    }
  }

  return dates;
}

// ============================================================================
// Query Building
// ============================================================================

/**
 * Build SQL for time-series aggregation
 */
export function buildTimeSeriesQuery(
  params: TimeSeriesQueryParams
): { sql: string; bindings: unknown[] } {
  const metric = params.metric || 'conversions';
  const metricDef = TIME_SERIES_METRIC_DEFINITIONS[metric];
  const interval = params.interval || 'day';

  // Handle conversion rate specially (requires two subqueries)
  if (metric === 'conversion_rate') {
    return buildConversionRateQuery(params);
  }

  let sql = `
    SELECT
      DATE(${metricDef.dateColumn}) as date,
      ${metricDef.valueColumn} as value
    FROM ${metricDef.table}
    WHERE ${metricDef.dateColumn} >= ?
      AND ${metricDef.dateColumn} < ?
  `;

  const bindings: unknown[] = [params.start, new Date(new Date(params.end).getTime() + 24 * 60 * 60 * 1000).toISOString()];

  // Add filters
  if (params.dealId) {
    sql += ' AND deal_id = ?';
    bindings.push(params.dealId);
  }

  if (params.affiliateId) {
    sql += ' AND affiliate_id = ?';
    bindings.push(params.affiliateId);
  }

  if (params.status && metricDef.table === 'conversions') {
    sql += ' AND status = ?';
    bindings.push(params.status);
  }

  // Group by interval
  let groupByClause: string;
  switch (interval) {
    case 'hour':
      groupByClause = "strftime('%Y-%m-%dT%H:00:00', ${metricDef.dateColumn})";
      break;
    case 'day':
      groupByClause = 'DATE(' + metricDef.dateColumn + ')';
      break;
    case 'week':
      groupByClause = "strftime('%Y-W%W', ${metricDef.dateColumn})";
      break;
    case 'month':
      groupByClause = "strftime('%Y-%m', ${metricDef.dateColumn})";
      break;
    default:
      groupByClause = 'DATE(' + metricDef.dateColumn + ')';
  }

  sql = sql.replace(/DATE\(\${\w+\.dateColumn}\)/g, groupByClause);
  sql += ` GROUP BY ${groupByClause} ORDER BY ${groupByClause} ASC`;

  return { sql, bindings };
}

/**
 * Build query for conversion rate (requires click + conversion join)
 */
function buildConversionRateQuery(
  params: TimeSeriesQueryParams
): { sql: string; bindings: unknown[] } {
  const interval = params.interval || 'day';

  let groupByExpr: string;
  switch (interval) {
    case 'hour':
      groupByExpr = "strftime('%Y-%m-%dT%H:00:00', c.converted_at)";
      break;
    case 'day':
      groupByExpr = 'DATE(c.converted_at)';
      break;
    case 'week':
      groupByExpr = "strftime('%Y-W%W', c.converted_at)";
      break;
    case 'month':
      groupByExpr = "strftime('%Y-%m', c.converted_at)";
      break;
    default:
      groupByExpr = 'DATE(c.converted_at)';
  }

  const sql = `
    SELECT
      ${groupByExpr} as date,
      COUNT(DISTINCT c.id) as conversions,
      COUNT(DISTINCT dc.id) as clicks,
      CASE WHEN COUNT(DISTINCT dc.id) > 0
        THEN (COUNT(DISTINCT c.id) * 100.0) / COUNT(DISTINCT dc.id)
        ELSE 0
      END as value
    FROM conversions c
    LEFT JOIN deal_clicks dc ON
      dc.deal_id = c.deal_id
      AND dc.created_at >= datetime(c.converted_at, '-30 days')
      AND dc.created_at <= c.converted_at
    WHERE c.converted_at >= ?
      AND c.converted_at < ?
      ${params.dealId ? 'AND c.deal_id = ?' : ''}
      ${params.affiliateId ? 'AND c.affiliate_id = ?' : ''}
      ${params.status ? 'AND c.status = ?' : ''}
    GROUP BY ${groupByExpr}
    ORDER BY ${groupByExpr} ASC
  `;

  const bindings: unknown[] = [params.start, new Date(new Date(params.end).getTime() + 24 * 60 * 60 * 1000).toISOString()];

  if (params.dealId) bindings.push(params.dealId);
  if (params.affiliateId) bindings.push(params.affiliateId);
  if (params.status) bindings.push(params.status);

  return { sql, bindings };
}

// ============================================================================
// Aggregation and Response Building
// ============================================================================

/**
 * Query and aggregate time-series data
 */
export async function getTimeSeriesData(
  db: D1Database,
  params: TimeSeriesQueryParams
): Promise<TimeSeriesResponse> {
  const metric = params.metric || 'conversions';
  const interval = params.interval || 'day';

  const startDate = new Date(params.start);
  const endDate = new Date(params.end);

  // Build and execute query
  const { sql, bindings } = buildTimeSeriesQuery(params);

  const result = await db.prepare(sql).bind(...bindings).all();

  // Get all dates in range for filling gaps
  const allDates = generateDateRange(startDate, endDate, interval);
  const dataMap = new Map<string, number>();

  // Populate with actual data
  for (const row of result.results as Array<{ date: string; value: number }>) {
    const key = formatDateKey(row.date, interval);
    dataMap.set(key, row.value || 0);
  }

  // Build response arrays with zero-filling
  const labels: string[] = [];
  const values: number[] = [];
  const data: TimeSeriesDataPoint[] = [];

  for (const date of allDates) {
    const key = formatDateKey(date.toISOString(), interval);
    const value = dataMap.get(key) || 0;

    labels.push(formatDateForInterval(date, interval));
    values.push(value);
    data.push({
      date: formatDateForInterval(date, interval),
      value,
    });
  }

  // Calculate summary statistics
  const summary = calculateSummary(values);

  return {
    meta: {
      metric,
      startDate: params.start,
      endDate: params.end,
      interval,
      totalDataPoints: data.length,
    },
    labels,
    values,
    data,
    summary,
  };
}

/**
 * Format a date string to a consistent key for the interval
 */
export function formatDateKey(dateStr: string, interval: string): string {
  const date = new Date(dateStr);
  const truncated = truncateToInterval(date, interval);

  switch (interval) {
    case 'hour':
      return truncated.toISOString().slice(0, 13) + ':00:00';
    case 'day':
      return truncated.toISOString().slice(0, 10);
    case 'week':
      return `${truncated.getUTCFullYear()}-W${String(getWeekNumber(truncated)).padStart(2, '0')}`;
    case 'month':
      return `${truncated.getUTCFullYear()}-${String(truncated.getUTCMonth() + 1).padStart(2, '0')}`;
    default:
      return truncated.toISOString().slice(0, 10);
  }
}

/**
 * Calculate summary statistics from values array
 */
export function calculateSummary(values: number[]): TimeSeriesResponse['summary'] {
  if (values.length === 0) {
    return {
      total: 0,
      average: 0,
      min: 0,
      max: 0,
      trend: 'stable',
      trendPercentage: 0,
    };
  }

  const total = values.reduce((sum, v) => sum + v, 0);
  const average = total / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Calculate trend by comparing first half to second half
  const mid = Math.floor(values.length / 2);
  const firstHalf = values.slice(0, mid).reduce((sum, v) => sum + v, 0);
  const secondHalf = values.slice(mid).reduce((sum, v) => sum + v, 0);

  let trend: 'up' | 'down' | 'stable' = 'stable';
  let trendPercentage = 0;

  if (firstHalf > 0) {
    const change = ((secondHalf - firstHalf) / firstHalf) * 100;
    trendPercentage = change;

    if (change > 5) {
      trend = 'up';
    } else if (change < -5) {
      trend = 'down';
    } else {
      trend = 'stable';
    }
  }

  return {
    total,
    average,
    min,
    max,
    trend,
    trendPercentage,
  };
}

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate time-series query parameters
 */
export function validateTimeSeriesParams(params: TimeSeriesQueryParams): string[] {
  const errors: string[] = [];

  if (!params.start) {
    errors.push('start date is required');
  } else if (isNaN(Date.parse(params.start))) {
    errors.push('start date must be a valid ISO date');
  }

  if (!params.end) {
    errors.push('end date is required');
  } else if (isNaN(Date.parse(params.end))) {
    errors.push('end date must be a valid ISO date');
  }

  if (!params.interval) {
    errors.push('interval is required');
  } else if (!['hour', 'day', 'week', 'month'].includes(params.interval)) {
    errors.push('interval must be one of: hour, day, week, month');
  }

  if (params.metric && !TIME_SERIES_METRIC_DEFINITIONS[params.metric]) {
    errors.push(`metric must be one of: ${Object.keys(TIME_SERIES_METRIC_DEFINITIONS).join(', ')}`);
  }

  // Validate date range
  if (params.start && params.end) {
    const startDate = new Date(params.start);
    const endDate = new Date(params.end);

    if (startDate >= endDate) {
      errors.push('start date must be before end date');
    }

    // Check days difference
    const daysDiff = (endDate.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000);
    if (daysDiff > 365) {
      errors.push('date range cannot exceed 365 days');
    }
  }

  return errors;
}
