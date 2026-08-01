/**
 * Admin Alerts Server Actions
 * Provides data fetching and operations for the alerts dashboard
 */

'use server'

import { getDB } from '@/lib/db';
import { error as logError } from '@/lib/logger';
import { requireAdmin } from '@/lib/admin-auth';
import type { D1Database } from '@/lib/db';

// UI Alert types for admin dashboard
export interface Alert {
  id: string;
  alertId: string;
  type: string;
  title: string;
  description: string;
  currentValue: number;
  threshold: number;
  severity: AlertSeverity;
  triggeredAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  isRead: boolean;
  isSilenced: boolean;
  silencedUntil?: string;
  metadata: Record<string, unknown>;
  [key: string]: unknown;
}

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'resolved' | 'snoozed' | 'acknowledged';

export interface AlertFilters {
  status?: AlertStatus | 'all';
  severity?: AlertSeverity | 'all';
  type?: string | 'all';
  isRead?: boolean;
  isSilenced?: boolean;
  startDate?: string;
  endDate?: string;
}


export interface AlertsResponse {
  alerts: Alert[];
  total: number;
  totalPages: number;
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

/**
 * GET alerts with filtering and pagination
 */
export async function fetchAlerts(filters: AlertFilters & {
  page: number;
  limit: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  search?: string;
}): Promise<AlertsResponse> {
  try {
    const admin = await requireAdmin();
    if (!admin) {
      return { alerts: [], total: 0, totalPages: 0, summary: getEmptySummary() };
    }

    const db = getDB();

    // Build query for alert_history and d1_alert_history combined
    // First, get alerts from alert_history (payout health alerts)
    let alertQuery = `
      SELECT
        id,
        alert_id as alertId,
        type,
        title,
        description,
        current_value as currentValue,
        threshold as threshold,
        severity,
        triggered_at as triggeredAt,
        resolved_at as resolvedAt,
        acknowledged_at as acknowledgedAt,
        acknowledged_by as acknowledgedBy,
        is_read as isRead,
        '0' as is_silenced,
        NULL as silenced_until,
        metadata,
        created_at as createdAt,
        updated_at as updatedAt
      FROM alert_history
      WHERE 1=1
    `;

    const params: unknown[] = [];

    // Apply status filter
    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'active') {
        alertQuery += ' AND resolved_at IS NULL';
      } else if (filters.status === 'resolved') {
        alertQuery += ' AND resolved_at IS NOT NULL';
      } else if (filters.status === 'acknowledged') {
        alertQuery += ' AND acknowledged_at IS NOT NULL';
      }
    }

    // Apply severity filter
    if (filters.severity && filters.severity !== 'all') {
      alertQuery += ` AND severity = ?`;
      params.push(filters.severity);
    }

    // Apply type filter
    if (filters.type && filters.type !== 'all') {
      alertQuery += ` AND type = ?`;
      params.push(filters.type);
    }

    // Apply read filter
    if (filters.isRead !== undefined) {
      alertQuery += ` AND is_read = ?`;
      params.push(filters.isRead ? 1 : 0);
    }

    // Apply date range
    if (filters.startDate) {
      alertQuery += ' AND triggered_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      alertQuery += ' AND triggered_at <= ?';
      params.push(filters.endDate);
    }

    alertQuery += ' ORDER BY triggered_at DESC LIMIT ? OFFSET ?';
    params.push(filters.limit * 2, (filters.page - 1) * filters.limit * 2); // Get more to account for combined results

    const alertRows = await db.prepare(alertQuery).bind(...params).all();

    // Also get D1 alerts
    let d1Query = `
      SELECT
        h.id,
        c.name as alertId,
        c.metric_type as type,
        c.name as title,
        c.description,
        h.current_value as currentValue,
        h.threshold_value as threshold,
        (SELECT severity FROM d1_alert_configs WHERE id = h.alert_config_id) as severity,
        h.triggered_at as triggeredAt,
        h.resolved_at as resolvedAt,
        NULL as acknowledgedAt,
        NULL as acknowledgedBy,
        '0' as isRead,
        CASE WHEN s.id IS NOT NULL THEN 1 ELSE 0 END as is_silenced,
        s.expires_at as silenced_until,
        h.details as metadata,
        h.triggered_at as createdAt,
        h.triggered_at as updatedAt
      FROM d1_alert_history h
      JOIN d1_alert_configs c ON h.alert_config_id = c.id
      LEFT JOIN d1_snoozes s ON c.id = s.alert_config_id AND s.expires_at > datetime('now')
      WHERE 1=1
    `;

    const d1Params: unknown[] = [];

    if (filters.status && filters.status !== 'all') {
      d1Query += ` AND h.status = ?`;
      d1Params.push(filters.status);
    }

    if (filters.severity && filters.severity !== 'all') {
      d1Query += ` AND c.severity = ?`;
      d1Params.push(filters.severity);
    }

    if (filters.isSilenced !== undefined) {
      if (filters.isSilenced) {
        d1Query += ' AND s.id IS NOT NULL';
      } else {
        d1Query += ' AND s.id IS NULL';
      }
    }

    d1Query += ' ORDER BY h.triggered_at DESC LIMIT ? OFFSET ?';
    d1Params.push(filters.limit * 2, (filters.page - 1) * filters.limit * 2);

    const d1Rows = await db.prepare(d1Query).bind(...d1Params).all();

    // Combine and normalize results
    const allAlerts: Alert[] = [
      ...normalizeAlertRows((alertRows.results as any[]) || [], false),
      ...normalizeAlertRows((d1Rows.results as any[]) || [], true),
    ];

    // Apply search filter if provided
    let filteredAlerts = allAlerts;
    if (filters.search) {
      const searchLower = filters.search.toLowerCase();
      filteredAlerts = allAlerts.filter(
        alert =>
          alert.title.toLowerCase().includes(searchLower) ||
          alert.description.toLowerCase().includes(searchLower) ||
          alert.type.toLowerCase().includes(searchLower)
      );
    }

    // Apply sorting
    filteredAlerts.sort((a, b) => {
      const { sortBy, sortOrder } = filters;
      const multiplier = sortOrder === 'asc' ? 1 : -1;

      if (sortBy === 'triggeredAt' || sortBy === 'triggered_at') {
        return multiplier * (new Date(b.triggeredAt).getTime() - new Date(a.triggeredAt).getTime());
      }
      if (sortBy === 'severity') {
        const severityOrder = { critical: 0, warning: 1, info: 2 };
        return multiplier * ((severityOrder[a.severity] || 999) - (severityOrder[b.severity] || 999));
      }
      return 0;
    });

    // Apply pagination
    const start = (filters.page - 1) * filters.limit;
    const paginatedAlerts = filteredAlerts.slice(start, start + filters.limit);

    // Get total count for pagination (approximate from both tables)
    const [alertCount, d1Count] = await Promise.all([
      db.prepare('SELECT COUNT(*) as total FROM alert_history').first<{ total: number }>(),
      db.prepare('SELECT COUNT(*) as total FROM d1_alert_history').first<{ total: number }>(),
    ]);
    const total = (alertCount?.total || 0) + (d1Count?.total || 0);
    const totalPages = Math.ceil(total / filters.limit);

    // Get summary statistics for current view
    const summary = await getAlertsSummary(db, filters);

    return {
      alerts: paginatedAlerts,
      total,
      totalPages,
      summary,
    };
  } catch (error) {
    logError('Error fetching alerts:', error);
    return { alerts: [], total: 0, totalPages: 0, summary: getEmptySummary() };
  }
}

function normalizeAlertRows(rows: any[], _isD1: boolean): Alert[] {
  return rows.map(row => ({
    id: row.id as string,
    alertId: row.alertId as string,
    type: (row.type as Alert['type']) || 'custom',
    title: row.title as string,
    description: row.description as string,
    currentValue: Number(row.currentValue) || 0,
    threshold: Number(row.threshold) || 0,
    severity: (row.severity as Alert['severity']) || 'info',
    triggeredAt: row.triggeredAt as string,
    resolvedAt: row.resolvedAt as string | undefined,
    acknowledgedAt: row.acknowledgedAt as string | undefined,
    acknowledgedBy: row.acknowledgedBy as string | undefined,
    isRead: Boolean(Number(row.isRead) || 0),
    isSilenced: Boolean(Number(row.isSilenced) || 0),
    silencedUntil: row.silenced_until as string | undefined,
    metadata: normalizeMetadata(row.metadata),
  }));
}

function normalizeMetadata(metadata: string | null | undefined): Record<string, unknown> {
  if (!metadata) return {};
  try {
    return typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
  } catch {
    return {};
  }
}

async function getAlertsSummary(
  db: D1Database,
  baseFilters: Omit<AlertFilters, 'limit' | 'offset'>
): Promise<AlertsResponse['summary']> {
  // Get summary from alert_history
  const alertConditions: string[] = [];
  const alertValues: unknown[] = [];

  if (baseFilters.status && baseFilters.status !== 'all') {
    if (baseFilters.status === 'active') {
      alertConditions.push('resolved_at IS NULL');
    } else {
      alertConditions.push('resolved_at IS NOT NULL');
    }
  }

  if (baseFilters.severity && baseFilters.severity !== 'all') {
    alertConditions.push('severity = ?');
    alertValues.push(baseFilters.severity);
  }

  const alertWhere = alertConditions.length > 0 ? `WHERE ${alertConditions.join(' AND ')}` : '';

  const [activeResult, severityResult, typeResult, overallResult] = await Promise.all([
    db.prepare(`SELECT COUNT(*) as count FROM alert_history ${alertWhere}`).bind(...alertValues).first<{ count: number }>(),
    db.prepare(`SELECT severity, COUNT(*) as count FROM alert_history ${alertWhere} GROUP BY severity`).bind(...alertValues).all<{ severity: string; count: number }>(),
    db.prepare(`SELECT type, COUNT(*) as count FROM alert_history ${alertWhere} GROUP BY type`).bind(...alertValues).all<{ type: string; count: number }>(),
    db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN resolved_at IS NOT NULL THEN 1 END) as resolved,
        COUNT(CASE WHEN is_read = 0 THEN 1 END) as unread,
        MAX(triggered_at) as lastTriggered
      FROM alert_history
    `).first<{ total: number; resolved: number; unread: number; lastTriggered: string }>(),
  ]);

  const activeCount = activeResult?.count ?? 0;
  const severityCounts = severityResult.results;
  const typeCounts = typeResult.results;
  const overall = overallResult;

  // Get counts by severity and type
  const bySeverity: Record<string, number> = {};
  const byType: Record<string, number> = {};

  (severityCounts as any[] || []).forEach((row: { severity: string; count: number }) => {
    bySeverity[row.severity] = row.count;
  });

  (typeCounts as any[] || []).forEach((row: { type: string; count: number }) => {
    byType[row.type] = row.count;
  });

  return {
    activeAlerts: activeCount,
    unreadAlerts: overall?.unread ?? 0,
    criticalCount: bySeverity.critical ?? 0,
    warningCount: bySeverity.warning ?? 0,
    infoCount: bySeverity.info ?? 0,
    totalAlerts: overall?.total ?? 0,
    resolvedAlerts: overall?.resolved ?? 0,
    byType,
    bySeverity,
  };
}

function getEmptySummary(): AlertsResponse['summary'] {
  return {
    activeAlerts: 0,
    unreadAlerts: 0,
    criticalCount: 0,
    warningCount: 0,
    infoCount: 0,
    totalAlerts: 0,
    resolvedAlerts: 0,
    byType: {},
    bySeverity: {},
  };
}
