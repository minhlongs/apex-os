/**
 * Admin Alerts API
 * Provides alert history, status management, and silencing options
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAdmin } from '../actions';

export interface Alert {
  id: string;
  alertId: string;
  type: 'no_conversions_24h' | 'payout_failure_rate' | 'conversion_failure_rate' | 'pending_commissions' | 'custom' | 'query_duration' | 'storage_usage' | 'slow_query_count' | 'rows_scanned';
  title: string;
  description: string;
  currentValue: number;
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  triggeredAt: string;
  resolvedAt?: string;
  acknowledgedAt?: string;
  acknowledgedBy?: string;
  isRead: boolean;
  isSilenced: boolean;
  silencedUntil?: string;
  metadata: Record<string, unknown>;
}

export interface AlertFilters {
  status?: 'active' | 'resolved' | 'acknowledged' | 'all';
  severity?: 'info' | 'warning' | 'critical' | 'all';
  type?: string | 'all';
  isRead?: boolean;
  isSilenced?: boolean;
  startDate?: string;
  endDate?: string;
  limit?: number;
  offset?: number;
}

// Alerts are stored in both alert_history and d1_alert_history tables
// This API consolidates them into a unified view

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // Verify admin access
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const url = new URL(request.url);
    const searchParams = url.searchParams;

    // Parse filters
    const filters: AlertFilters = {
      status: (searchParams.get('status') as AlertFilters['status']) || 'active',
      severity: (searchParams.get('severity') as AlertFilters['severity']) || 'all',
      type: searchParams.get('type') || 'all',
      isRead: searchParams.get('isRead') ? searchParams.get('isRead') === 'true' : undefined,
      isSilenced: searchParams.get('isSilenced') ? searchParams.get('isSilenced') === 'true' : undefined,
      startDate: searchParams.get('startDate') || undefined,
      endDate: searchParams.get('endDate') || undefined,
      limit: searchParams.get('limit') ? parseInt(searchParams.get('limit')!, 10) : 50,
      offset: searchParams.get('offset') ? parseInt(searchParams.get('offset')!, 10) : 0,
    };

    // @ts-ignore - D1 binding
    const db = typeof DB !== 'undefined' ? DB : null;
    if (!db) {
      return NextResponse.json({ success: false, error: 'Database not configured' }, { status: 503 });
    }

    // Build query for alert_history (payout health alerts) and d1_alert_history (D1 monitoring)
    // We'll query both and merge results
    let query = `
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
        '0' as is_read,
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
        query += ' AND resolved_at IS NULL';
      } else {
        query += ' AND resolved_at IS NOT NULL';
      }
    }

    // Apply severity filter
    if (filters.severity && filters.severity !== 'all') {
      query += ` AND severity = ?`;
      params.push(filters.severity);
    }

    // Apply type filter
    if (filters.type && filters.type !== 'all') {
      query += ` AND type = ?`;
      params.push(filters.type);
    }

    // Apply date range
    if (filters.startDate) {
      query += ' AND triggered_at >= ?';
      params.push(filters.startDate);
    }
    if (filters.endDate) {
      query += ' AND triggered_at <= ?';
      params.push(filters.endDate);
    }

    query += ' ORDER BY triggered_at DESC LIMIT ? OFFSET ?';
    params.push(filters.limit!, filters.offset!);

    const rows = await db.prepare(query).bind(...params).all();

    // Also query d1_alert_history for D1 monitoring alerts
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
        '0' as is_read,
        '0' as is_silenced,
        NULL as silenced_until,
        h.details as metadata,
        h.triggered_at as createdAt,
        h.triggered_at as updatedAt
      FROM d1_alert_history h
      JOIN d1_alert_configs c ON h.alert_config_id = c.id
      WHERE 1=1
    `;

    const d1Params: unknown[] = [];

    if (filters.status && filters.status !== 'all') {
      if (filters.status === 'active') {
        d1Query += ' AND h.status = "active"';
      } else if (filters.status === 'acknowledged') {
        d1Query += ' AND h.status = "acknowledged"';
      } else if (filters.status === 'resolved') {
        d1Query += ' AND h.status = "resolved"';
      }
    }

    if (filters.severity && filters.severity !== 'all') {
      d1Query += ` AND c.severity = ?`;
      d1Params.push(filters.severity);
    }

    // D1 alerts don't have type filtering in the same way, skip for now

    if (filters.startDate) {
      d1Query += ' AND h.triggered_at >= ?';
      d1Params.push(filters.startDate);
    }
    if (filters.endDate) {
      d1Query += ' AND h.triggered_at <= ?';
      d1Params.push(filters.endDate);
    }

    d1Query += ' ORDER BY h.triggered_at DESC LIMIT ? OFFSET ?';
    d1Params.push(filters.limit!, filters.offset!);

    const d1Rows = await db.prepare(d1Query).bind(...d1Params).all();

    // Combine and normalize results
    const allAlerts: Alert[] = [
      ...(rows.results as any[]).map(normalizeAlertRow),
      ...(d1Rows.results as any[]).map(normalizeAlertRow),
    ];

    // Get total count for pagination (simplified)
    const countResult = await db.prepare('SELECT COUNT(*) as total FROM alert_history').first();
    const d1CountResult = await db.prepare('SELECT COUNT(*) as total FROM d1_alert_history').first();
    const total = (countResult?.total || 0) + (d1CountResult?.total || 0);

    // Get summary statistics
    const summary = await getAlertSummary(db);

    return NextResponse.json({
      success: true,
      data: allAlerts,
      pagination: {
        total,
        limit: filters.limit,
        offset: filters.offset,
        hasMore: total > filters.limit! + filters.offset!,
      },
      summary,
    });
  } catch (error) {
    console.error('Alerts API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

function normalizeAlertRow(row: Record<string, unknown>): Alert {
  const metadataStr = row.metadata as string | null;
  let metadata: Record<string, unknown> = {};
  try {
    metadata = metadataStr ? JSON.parse(metadataStr) : {};
  } catch {
    metadata = {};
  }

  return {
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
    silencedUntil: row.silencedUntil as string | undefined,
    metadata,
  };
}

async function getAlertSummary(db: any) {
  // Get summary by status, severity, and type
  const [activeCount, severityCounts, typeCounts, recentActivity] = await Promise.all([
    db.prepare('SELECT COUNT(*) as count FROM alert_history WHERE resolved_at IS NULL').first(),
    db.prepare(`
      SELECT severity, COUNT(*) as count
      FROM alert_history
      WHERE resolved_at IS NULL
      GROUP BY severity
    `).all(),
    db.prepare(`
      SELECT type, COUNT(*) as count
      FROM alert_history
      WHERE resolved_at IS NULL
      GROUP BY type
    `).all(),
    db.prepare(`
      SELECT
        COUNT(*) as total,
        COUNT(CASE WHEN resolved_at IS NOT NULL THEN 1 END) as resolved,
        COUNT(CASE WHEN is_read = 0 THEN 1 END) as unread,
        MAX(triggered_at) as lastTriggered
      FROM alert_history
    `).first(),
  ]);

  return {
    activeAlerts: activeCount?.count || 0,
    bySeverity: (severityCounts.results as any[]).reduce((acc, row) => {
      acc[row.severity as string] = row.count;
      return acc;
    }, {} as Record<string, number>),
    byType: (typeCounts.results as any[]).reduce((acc, row) => {
      acc[row.type as string] = row.count;
      return acc;
    }, {} as Record<string, number>),
    totalAlerts: recentActivity?.total || 0,
    resolvedAlerts: recentActivity?.resolved || 0,
    unreadAlerts: recentActivity?.unread || 0,
    lastTriggered: recentActivity?.lastTriggered || null,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // Verify admin access
    const admin = await requireAdmin(request);
    if (!admin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { action, alertId, alertIds, snoozeUntil } = body as {
      action: 'markRead' | 'markUnread' | 'acknowledge' | 'resolve' | 'snooze' | 'silence' | 'bulk';
      alertId?: string;
      alertIds?: string[];
      snoozeUntil?: string;
    };

    // @ts-ignore - D1 binding
    const db = typeof DB !== 'undefined' ? DB : null;
    if (!db) {
      return NextResponse.json({ success: false, error: 'Database not configured' }, { status: 503 });
    }

    if (action === 'markRead' && alertId) {
      await db
        .prepare('UPDATE alert_history SET is_read = 1 WHERE id = ?')
        .bind(alertId)
        .run();
      return NextResponse.json({ success: true, data: { action: 'markedRead', alertId } });
    }

    if (action === 'markUnread' && alertId) {
      await db
        .prepare('UPDATE alert_history SET is_read = 0 WHERE id = ?')
        .bind(alertId)
        .run();
      return NextResponse.json({ success: true, data: { action: 'markedUnread', alertId } });
    }

    if (action === 'acknowledge' && alertId) {
      await db
        .prepare('UPDATE alert_history SET acknowledged_at = datetime("now"), acknowledged_by = ? WHERE id = ?')
        .bind(admin.userId, alertId)
        .run();
      return NextResponse.json({ success: true, data: { action: 'acknowledged', alertId } });
    }

    if (action === 'resolve' && alertId) {
      await db
        .prepare('UPDATE alert_history SET resolved_at = datetime("now") WHERE id = ?')
        .bind(alertId)
        .run();
      return NextResponse.json({ success: true, data: { action: 'resolved', alertId } });
    }

    if (action === 'snooze' && alertId && snoozeUntil) {
      await db
        .prepare('UPDATE alert_history SET silenced_until = ? WHERE id = ?')
        .bind(snoozeUntil, alertId)
        .run();
      return NextResponse.json({ success: true, data: { action: 'snoozed', alertId, until: snoozeUntil } });
    }

    if (action === 'bulk' && alertIds && alertIds.length > 0) {
      const updates: string[] = [];
      const values: unknown[] = [];

      // Handle bulk actions with correct key names from client
      if (body.markRead !== undefined) {
        updates.push(`is_read = ?`);
        values.push(body.markRead ? 1 : 0);
      }
      if (body.markUnread !== undefined) {
        updates.push(`is_read = ?`);
        values.push(body.markUnread ? 0 : 1);
      }
      if (body.acknowledge !== undefined && body.acknowledge) {
        updates.push(`acknowledged_at = datetime('now'), acknowledged_by = ?`);
        values.push(admin.userId);
      }
      if (body.resolve !== undefined && body.resolve) {
        updates.push(`resolved_at = datetime('now')`);
      }

      if (updates.length === 0) {
        return NextResponse.json({ success: false, error: 'No updates specified' }, { status: 400 });
      }

      const placeholders = alertIds.map(() => '?').join(',');
      await db
        .prepare(`UPDATE alert_history SET ${updates.join(', ')} WHERE id IN (${placeholders})`)
        .bind(...values, ...alertIds)
        .run();

      return NextResponse.json({
        success: true,
        data: { action: 'bulkUpdated', count: alertIds.length },
      });
    }

    return NextResponse.json({ success: false, error: 'Invalid action or missing parameters' }, { status: 400 });
  } catch (error) {
    console.error('Alerts API POST error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
