/**
 * Alert Storage Layer
 *
 * Provides CRUD operations and query methods for the alerts table.
 * Handles alert persistence, retrieval, and retention management.
 */

import type { D1Database } from '@/types/d1';
import type {
  Alert,
  AlertWithMetadata,
  AlertQueryOptions,
  AlertStats,
  CreateAlertInput,
  UpdateAlertInput,
  AlertSeverity,
  AlertStatus,
} from '@/types/alerts';

export class AlertStorage {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ============================================================================
  // Create Operations
  // ============================================================================

  /**
   * Create a new alert
   * Returns null when the insert succeeds but the row cannot be read back.
   */
  async create(input: CreateAlertInput): Promise<Alert | null> {
    const id = `alert_${crypto.randomUUID()}`;
    const now = new Date().toISOString();

    const result = await this.db
      .prepare(`
        INSERT INTO alerts (
          id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        input.rule_id,
        input.severity,
        input.message,
        input.triggered_at ? input.triggered_at.toISOString() : now,
        null,
        input.snoozed_until ? input.snoozed_until.toISOString() : null,
        input.context ? JSON.stringify(input.context) : JSON.stringify({})
      )
      .run();

    if (!result.success) {
      throw new Error('Failed to create alert');
    }

    return this.getById(id);
  }

  // ============================================================================
  // Read Operations
  // ============================================================================

  /**
   * Get alert by ID
   */
  async getById(id: string): Promise<Alert | null> {
    const result = await this.db
      .prepare('SELECT * FROM alerts WHERE id = ?')
      .bind(id)
      .first<AlertRow>();

    return result ? this.normalizeRow(result) : null;
  }

  /**
   * List alerts with optional filtering
   */
  async list(options: AlertQueryOptions = {}): Promise<AlertWithMetadata[]> {
    const {
      status = 'all',
      severity = 'all',
      rule_id,
      limit = 50,
      offset = 0,
      since,
      until,
    } = options;

    let query = `
      SELECT a.*,
        ar.name as rule_name,
        ar.source as source,
        ar.metric as metric_type
      FROM alerts a
      LEFT JOIN alert_rules ar ON a.rule_id = ar.id
      WHERE 1=1
    `;
    const params: unknown[] = [];

    // Status filter
    if (status !== 'all') {
      query += ' AND a.status = ?';
      params.push(status);
    }

    // Severity filter
    if (severity !== 'all') {
      query += ' AND a.severity = ?';
      params.push(severity);
    }

    // Rule ID filter
    if (rule_id) {
      query += ' AND a.rule_id = ?';
      params.push(rule_id);
    }

    // Date range filters
    if (since) {
      query += ' AND a.triggered_at >= ?';
      params.push(since.toISOString());
    }
    if (until) {
      query += ' AND a.triggered_at <= ?';
      params.push(until.toISOString());
    }

    query += ' ORDER BY a.triggered_at DESC LIMIT ? OFFSET ?';
    params.push(limit, offset);

    const result = await this.db.prepare(query).bind(...params).all<AlertRow & {
      rule_name?: string;
      source?: string;
      metric_type?: string;
    }>();

    return result.results.map(row => this.normalizeRowWithMetadata(row));
  }

  /**
   * Get active alerts (status = 'active')
   */
  async getActiveAlerts(severity?: AlertSeverity): Promise<AlertWithMetadata[]> {
    let query = `
      SELECT a.*,
        ar.name as rule_name,
        ar.source as source,
        ar.metric as metric_type
      FROM alerts a
      LEFT JOIN alert_rules ar ON a.rule_id = ar.id
      WHERE a.status = 'active'
    `;
    const params: unknown[] = [];

    if (severity) {
      query += ' AND a.severity = ?';
      params.push(severity);
    }

    query += ' ORDER BY a.triggered_at DESC';

    const result = await this.db.prepare(query).bind(...params).all<AlertRow & {
      rule_name?: string;
      source?: string;
      metric_type?: string;
    }>();

    return result.results.map(row => this.normalizeRowWithMetadata(row));
  }

  /**
   * Get snoozed alerts
   */
  async getSnoozedAlerts(): Promise<AlertWithMetadata[]> {
    const result = await this.db
      .prepare(`
        SELECT a.*,
          ar.name as rule_name,
          ar.source as source,
          ar.metric as metric_type
        FROM alerts a
        LEFT JOIN alert_rules ar ON a.rule_id = ar.id
        WHERE a.status = 'snoozed'
        ORDER BY a.snoozed_until ASC
      `)
      .all<AlertRow & {
        rule_name?: string;
        source?: string;
        metric_type?: string;
      }>();

    return result.results.map(row => this.normalizeRowWithMetadata(row));
  }

  /**
   * Get resolved alerts within time range (for history)
   */
  async getResolvedHistory(since?: Date, until?: Date, limit = 100): Promise<AlertWithMetadata[]> {
    let query = `
      SELECT a.*,
        ar.name as rule_name,
        ar.source as source,
        ar.metric as metric_type,
        (julianday(a.resolved_at) - julianday(a.triggered_at)) * 24 * 60 as resolution_time_minutes
      FROM alerts a
      LEFT JOIN alert_rules ar ON a.rule_id = ar.id
      WHERE a.status = 'resolved'
    `;
    const params: unknown[] = [];

    if (since) {
      query += ' AND a.triggered_at >= ?';
      params.push(since.toISOString());
    }
    if (until) {
      query += ' AND a.triggered_at <= ?';
      params.push(until.toISOString());
    }

    query += ' ORDER BY a.triggered_at DESC LIMIT ? OFFSET ?';
    params.push(limit, 0);

    const result = await this.db.prepare(query).bind(...params).all<AlertRow & {
      rule_name?: string;
      source?: string;
      metric_type?: string;
      resolution_time_minutes?: number;
    }>();

    return result.results.map(row => this.normalizeRowWithMetadata(row));
  }

  // ============================================================================
  // Update Operations
  // ============================================================================

  /**
   * Update alert fields
   */
  async update(id: string, updates: UpdateAlertInput): Promise<Alert | null> {
    const fields: string[] = [];
    const values: unknown[] = [];
    let derivedStatus: AlertStatus | undefined;

    if (updates.resolved_at !== undefined) {
      fields.push('resolved_at = ?');
      values.push(updates.resolved_at.toISOString());
      derivedStatus = 'resolved';
    }
    if (updates.snoozed_until !== undefined) {
      fields.push('snoozed_until = ?');
      values.push(updates.snoozed_until ? updates.snoozed_until.toISOString() : null);
      if (updates.snoozed_until && derivedStatus !== 'resolved') {
        derivedStatus = 'snoozed';
      } else if (!updates.snoozed_until && derivedStatus !== 'resolved') {
        derivedStatus = 'active';
      }
    }

    if (fields.length === 0) {
      return this.getById(id);
    }

    if (derivedStatus) {
      fields.push('status = ?');
      values.push(derivedStatus);
    }

    values.push(id);

    const result = await this.db
      .prepare(`UPDATE alerts SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    if (!result.success || result.meta.changes === 0) {
      return null;
    }

    return this.getById(id);
  }

  /**
   * Resolve an alert (set resolved_at to now)
   */
  async resolve(id: string): Promise<Alert | null> {
    return this.update(id, { resolved_at: new Date() });
  }

  /**
   * Snooze an alert until specified time
   */
  async snooze(id: string, until: Date): Promise<Alert | null> {
    return this.update(id, { snoozed_until: until });
  }

  /**
   * Clear snooze on an alert
   */
  async clearSnooze(id: string): Promise<Alert | null> {
    return this.update(id, { snoozed_until: null });
  }

  // ============================================================================
  // Delete Operations
  // ============================================================================

  /**
   * Delete an alert by ID
   */
  async delete(id: string): Promise<boolean> {
    const result = await this.db
      .prepare('DELETE FROM alerts WHERE id = ?')
      .bind(id)
      .run();

    return result.success && result.meta.changes > 0;
  }

  // ============================================================================
  // Statistics & Retention
  // ============================================================================

  /**
   * Get alert statistics
   */
  async getStats(since?: Date): Promise<AlertStatsSummary> {
    let dateFilter = '';
    const params: unknown[] = [];

    if (since) {
      dateFilter = 'WHERE triggered_at >= ?';
      params.push(since.toISOString());
    }

    const [
      total,
      bySeverity,
      byStatus,
      byRule,
      avgResolutionTime,
    ] = await Promise.all([
      this.db
        .prepare(`SELECT COUNT(*) as count FROM alerts ${dateFilter}`)
        .bind(...params)
        .first<{ count: number }>(),
      this.db
        .prepare(`
          SELECT severity, COUNT(*) as count
          FROM alerts ${dateFilter}
          GROUP BY severity
        `)
        .bind(...params)
        .all<{ severity: string; count: number }>(),
      this.db
        .prepare(`
          SELECT status, COUNT(*) as count
          FROM alerts ${dateFilter}
          GROUP BY status
        `)
        .bind(...params)
        .all<{ status: string; count: number }>(),
      this.db
        .prepare(`
          SELECT rule_id, COUNT(*) as count
          FROM alerts ${dateFilter}
          GROUP BY rule_id
          ORDER BY count DESC
          LIMIT 10
        `)
        .bind(...params)
        .all<{ rule_id: string; count: number }>(),
      this.db
        .prepare(`
          SELECT AVG(
            (julianday(resolved_at) - julianday(triggered_at)) * 24 * 60
          ) as avg_minutes
          FROM alerts
          WHERE status = 'resolved'
            ${since ? 'AND triggered_at >= ?' : ''}
        `)
        .bind(...(since ? [since.toISOString()] : []))
        .first<{ avg_minutes: number | null }>(),
    ]);

    return {
      total: total?.count || 0,
      bySeverity: bySeverity.results.reduce((acc, row) => {
        acc[row.severity as AlertSeverity] = row.count;
        return acc;
      }, {} as Record<AlertSeverity, number>),
      byStatus: byStatus.results.reduce((acc, row) => {
        acc[row.status as AlertStatus] = row.count;
        return acc;
      }, {} as Record<AlertStatus, number>),
      topRules: byRule.results,
      avgResolutionTimeMinutes: avgResolutionTime?.avg_minutes || null,
    };
  }

  /**
   * Clean up old resolved alerts based on retention policy (90 days)
   * Returns number of deleted alerts
   */
  async cleanupOldAlerts(retentionDays: number = 90): Promise<number> {
    const result = await this.db
      .prepare(`
        DELETE FROM alerts
        WHERE status = 'resolved'
          AND triggered_at < datetime('now', '-' || ? || ' days')
      `)
      .bind(retentionDays)
      .run();

    return result.meta.changes || 0;
  }

  /**
   * Clean up expired snoozes (set status back to active for alerts where snooze expired)
   */
  async cleanupExpiredSnoozes(): Promise<number> {
    const result = await this.db
      .prepare(`
        UPDATE alerts
        SET snoozed_until = NULL
        WHERE status = 'snoozed'
          AND snoozed_until < datetime('now')
      `)
      .run();

    return result.meta.changes || 0;
  }

  /**
   * Get alerts that need reminder notifications (snooze expired, still active)
   */
  async getExpiredSnoozesForReminder(): Promise<AlertWithMetadata[]> {
    const result = await this.db
      .prepare(`
        SELECT a.*,
          ar.name as rule_name,
          ar.source as source,
          ar.metric as metric_type
        FROM alerts a
        LEFT JOIN alert_rules ar ON a.rule_id = ar.id
        WHERE a.status = 'active'
          AND a.snoozed_until IS NOT NULL
          AND a.snoozed_until < datetime('now')
      `)
      .all<AlertRow & {
        rule_name?: string;
        source?: string;
        metric_type?: string;
      }>();

    return result.results.map(row => this.normalizeRowWithMetadata(row));
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  /**
   * Normalize database row to Alert type
   */
  private normalizeRow(row: AlertRow): Alert {
    let context: Record<string, unknown> = {};
    try {
      context = row.context ? JSON.parse(row.context) : {};
    } catch {
      context = {};
    }

    return {
      id: row.id,
      rule_id: row.rule_id,
      severity: row.severity as AlertSeverity,
      message: row.message,
      triggered_at: row.triggered_at,
      resolved_at: row.resolved_at,
      snoozed_until: row.snoozed_until,
      context,
      status: row.status as AlertStatus,
    };
  }

  /**
   * Normalize row with metadata to AlertWithMetadata
   */
  private normalizeRowWithMetadata(
    row: AlertRow & {
      rule_name?: string;
      source?: string;
      metric_type?: string;
      resolution_time_minutes?: number;
      minutes_active?: number;
    }
  ): AlertWithMetadata {
    const alert = this.normalizeRow(row);
    return {
      ...alert,
      rule_name: row.rule_name,
      source: row.source as 'business' | 'd1' | 'custom',
      metric_type: row.metric_type,
      resolution_time_minutes: row.resolution_time_minutes,
      minutes_active: row.minutes_active,
    };
  }
}

/**
 * Database row shape for alerts table
 */
interface AlertRow {
  id: string;
  rule_id: string;
  severity: string;
  message: string;
  triggered_at: string;
  resolved_at: string | null;
  snoozed_until: string | null;
  context: string;
  status: string;
  created_at: string;
  updated_at: string;
}

/**
 * Alert statistics summary
 */
export interface AlertStatsSummary {
  total: number;
  bySeverity: Record<AlertSeverity, number>;
  byStatus: Record<AlertStatus, number>;
  topRules: { rule_id: string; count: number }[];
  avgResolutionTimeMinutes: number | null;
}

// ============================================================================
// Singleton Pattern
// ============================================================================

let globalStorage: AlertStorage | null = null;

export function getAlertStorage(db: D1Database): AlertStorage {
  if (!globalStorage) {
    globalStorage = new AlertStorage(db);
  }
  return globalStorage;
}
