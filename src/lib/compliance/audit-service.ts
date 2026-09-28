/**
 * src/lib/compliance/audit-service.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Immutable Compliance Audit Service
 *
 * Provides atomic dual-writes and prepared statements for compliance audit logging.
 * Protected by SQLite BEFORE UPDATE and BEFORE DELETE triggers.
 */

import type { D1Database, D1PreparedStatement } from '../db';
import type {
  ComplianceAuditEntry,
  ComplianceAuditLogRecord,
  ComplianceAuditLogFilter,
  PaginatedComplianceAuditLogs,
  IComplianceAuditService,
} from './types';
import * as logger from '../logger';

function generateLogId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'cal_' + Date.now().toString(36) + Math.random().toString(36).substring(2, 11);
}

export class ComplianceAuditService implements IComplianceAuditService {
  /**
   * Constructs an atomic D1PreparedStatement for insertion into compliance_audit_logs.
   * Can be combined inside db.batch([...]) for atomic multi-table transactions.
   */
  createAuditStatement(db: D1Database, entry: ComplianceAuditEntry): D1PreparedStatement {
    const id = generateLogId();
    const detailsStr =
      typeof entry.details === 'string'
        ? entry.details
        : JSON.stringify(entry.details ?? {});

    return db
      .prepare(`
        INSERT INTO compliance_audit_logs (
          id, action, severity, actor_id, target_id, details, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
      `)
      .bind(
        id,
        entry.action,
        entry.severity,
        entry.actorId ?? null,
        entry.targetId ?? null,
        detailsStr
      );
  }

  /**
   * Persist a compliance audit entry immediately
   */
  async log(db: D1Database, entry: ComplianceAuditEntry): Promise<void> {
    try {
      const stmt = this.createAuditStatement(db, entry);
      await stmt.run();
      logger.info(
        `[ComplianceAudit] [${entry.severity.toUpperCase()}] Action: ${entry.action}, Target: ${entry.targetId ?? 'N/A'}`
      );
    } catch (err: any) {
      logger.error(
        `[ComplianceAudit] Failed to persist compliance audit log: ${err?.message || String(err)}`
      );
      throw err;
    }
  }

  /**
   * Query paginated compliance audit logs with optional filtering
   */
  async getAuditLogs(
    db: D1Database,
    filter?: ComplianceAuditLogFilter
  ): Promise<PaginatedComplianceAuditLogs> {
    const page = Math.max(1, filter?.page ?? 1);
    const limit = Math.min(100, Math.max(1, filter?.limit ?? 20));
    const offset = (page - 1) * limit;

    const conditions: string[] = ['1=1'];
    const params: unknown[] = [];

    if (filter?.action) {
      conditions.push('action = ?');
      params.push(filter.action);
    }

    if (filter?.severity) {
      conditions.push('severity = ?');
      params.push(filter.severity);
    }

    if (filter?.targetId) {
      conditions.push('target_id = ?');
      params.push(filter.targetId);
    }

    if (filter?.actorId) {
      conditions.push('actor_id = ?');
      params.push(filter.actorId);
    }

    if (filter?.startDate) {
      conditions.push('created_at >= ?');
      params.push(filter.startDate);
    }

    if (filter?.endDate) {
      conditions.push('created_at <= ?');
      params.push(filter.endDate);
    }

    const whereClause = conditions.join(' AND ');

    // 1. Total count
    const countSql = `SELECT COUNT(*) as total FROM compliance_audit_logs WHERE ${whereClause}`;
    const countRow = await db
      .prepare(countSql)
      .bind(...params)
      .first<{ total: number }>();
    const total = Number(countRow?.total ?? 0);

    // 2. Query rows
    const dataSql = `
      SELECT id, action, severity, actor_id, target_id, details, created_at
      FROM compliance_audit_logs
      WHERE ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;
    const dataParams = [...params, limit, offset];
    const result = await db.prepare(dataSql).bind(...dataParams).all<ComplianceAuditLogRecord>();

    const rows = (result.results ?? []).map((row) => ({
      ...row,
      action: row.action,
      severity: row.severity,
    }));

    return {
      data: rows,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit) || 1,
    };
  }
}

/**
 * Singleton instance of ComplianceAuditService
 */
export const complianceAuditService = new ComplianceAuditService();
