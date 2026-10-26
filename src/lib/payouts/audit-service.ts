/**
 * src/lib/payouts/audit-service.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Immutable Payout Audit Service & Atomic Dual-Write Helper
 *
 * Features:
 * - Immutability: Logs directly to payout_audit_logs protected by database engine triggers
 * - Atomic Dual-Write: Exposes createAuditStatement() for inclusion in D1 db.batch([...])
 * - Multi-Chain Querying: Filter by batch_id, payout_id, action, chain, date range with pagination
 */

import { getDB, type D1Database, type D1PreparedStatement } from '../db';
import type {
  AuditAction,
  PaginatedAuditLogs,
  PayoutAuditLogFilter,
  PayoutAuditLogInput,
  PayoutAuditLogRecord,
  SupportedPayoutChain,
} from './types';

// ============================================================================
// Standalone Helper Functions
// ============================================================================

/**
 * Creates a D1PreparedStatement for inserting an immutable payout audit log entry.
 * Designed specifically for atomic dual-write operations in db.batch([...]).
 */
export function createAuditStatement(
  db: D1Database,
  entry: PayoutAuditLogInput
): D1PreparedStatement {
  const id = entry.id || crypto.randomUUID().replace(/-/g, '').slice(0, 32);
  const details: string =
    typeof entry.details === 'object' && entry.details !== null
      ? JSON.stringify(entry.details)
      : typeof entry.details === 'string'
      ? entry.details
      : '{}';
  const now = entry.created_at || new Date().toISOString();

  return db.prepare(`
    INSERT INTO payout_audit_logs (
      id,
      batch_id,
      payout_id,
      action,
      admin_id,
      admin_email,
      chain,
      details,
      ip_address,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    entry.batch_id ?? null,
    entry.payout_id ?? null,
    entry.action,
    entry.admin_id ?? null,
    entry.admin_email ?? null,
    entry.chain ?? null,
    details,
    entry.ip_address ?? null,
    now
  );
}

// ============================================================================
// PayoutAuditService Class
// ============================================================================

export class PayoutAuditService {
  private db?: D1Database;

  constructor(db?: D1Database) {
    this.db = db;
  }

  private resolveDatabase(passedDb?: D1Database): D1Database {
    if (passedDb) return passedDb;
    if (this.db) return this.db;
    return getDB();
  }

  /**
   * Helper to create prepared statement for atomic batch operations.
   */
  createAuditStatement(
    dbOrEntry: D1Database | PayoutAuditLogInput,
    maybeEntry?: PayoutAuditLogInput
  ): D1PreparedStatement {
    if (maybeEntry !== undefined) {
      return createAuditStatement(dbOrEntry as D1Database, maybeEntry);
    }
    const resolvedDb = this.resolveDatabase();
    return createAuditStatement(resolvedDb, dbOrEntry as PayoutAuditLogInput);
  }

  /**
   * Static helper to create a prepared statement for atomic batch operations.
   */
  static createAuditStatement(
    db: D1Database,
    entry: PayoutAuditLogInput
  ): D1PreparedStatement {
    return createAuditStatement(db, entry);
  }

  /**
   * Records an immutable entry in payout_audit_logs.
   * Can be called as log(db, entry) or log(entry) if db was provided to constructor.
   */
  async log(
    dbOrEntry: D1Database | PayoutAuditLogInput,
    maybeEntry?: PayoutAuditLogInput
  ): Promise<PayoutAuditLogRecord> {
    let db: D1Database;
    let entry: PayoutAuditLogInput;

    if (maybeEntry !== undefined) {
      db = dbOrEntry as D1Database;
      entry = maybeEntry;
    } else {
      db = this.resolveDatabase();
      entry = dbOrEntry as PayoutAuditLogInput;
    }

    const id = entry.id || crypto.randomUUID().replace(/-/g, '').slice(0, 32);
    const details: string =
      typeof entry.details === 'object' && entry.details !== null
        ? JSON.stringify(entry.details)
        : typeof entry.details === 'string'
        ? entry.details
        : '{}';
    const now = entry.created_at || new Date().toISOString();

    const stmt = createAuditStatement(db, {
      ...entry,
      id,
      details,
      created_at: now,
    });

    await stmt.run();

    return {
      id,
      batch_id: entry.batch_id ?? null,
      payout_id: entry.payout_id ?? null,
      action: entry.action,
      admin_id: entry.admin_id ?? null,
      admin_email: entry.admin_email ?? null,
      chain: entry.chain ?? null,
      details,
      ip_address: entry.ip_address ?? null,
      created_at: now,
    };
  }

  /**
   * Static method to insert an audit log entry.
   */
  static async log(
    db: D1Database,
    entry: PayoutAuditLogInput
  ): Promise<PayoutAuditLogRecord> {
    const service = new PayoutAuditService(db);
    return service.log(db, entry);
  }

  /**
   * Queries audit logs with pagination and filters by batch_id, payout_id, action, chain.
   */
  async query(
    dbOrFilters?: D1Database | PayoutAuditLogFilter,
    maybeFilters?: PayoutAuditLogFilter
  ): Promise<PaginatedAuditLogs> {
    let db: D1Database;
    let filters: PayoutAuditLogFilter | undefined;

    if (
      dbOrFilters &&
      typeof (dbOrFilters as D1Database).prepare === 'function'
    ) {
      db = dbOrFilters as D1Database;
      filters = maybeFilters;
    } else {
      db = this.resolveDatabase();
      filters = dbOrFilters as PayoutAuditLogFilter | undefined;
    }

    const page = Math.max(1, filters?.page ?? 1);
    const limit = Math.min(100, Math.max(1, filters?.limit ?? 20));
    const offset = (page - 1) * limit;

    const whereConditions: string[] = [];
    const params: unknown[] = [];

    if (filters?.batch_id) {
      whereConditions.push('batch_id = ?');
      params.push(filters.batch_id);
    }

    if (filters?.payout_id) {
      whereConditions.push('payout_id = ?');
      params.push(filters.payout_id);
    }

    if (filters?.action) {
      whereConditions.push('action = ?');
      params.push(filters.action);
    }

    if (filters?.chain) {
      whereConditions.push('chain = ?');
      params.push(filters.chain);
    }

    if (filters?.admin_id) {
      whereConditions.push('admin_id = ?');
      params.push(filters.admin_id);
    }

    if (filters?.startDate) {
      whereConditions.push('created_at >= ?');
      params.push(filters.startDate);
    }

    if (filters?.endDate) {
      whereConditions.push('created_at <= ?');
      params.push(filters.endDate);
    }

    const whereClause =
      whereConditions.length > 0 ? `WHERE ${whereConditions.join(' AND ')}` : '';

    // 1. Get total count
    const countQuery = `SELECT COUNT(*) as total FROM payout_audit_logs ${whereClause}`;
    const countStmt = db.prepare(countQuery);
    const countBound = params.length > 0 ? countStmt.bind(...params) : countStmt;
    const countResult = await countBound.first<{ total: number } | number>();

    let total = 0;
    if (typeof countResult === 'number') {
      total = countResult;
    } else if (
      countResult &&
      typeof countResult === 'object' &&
      'total' in countResult
    ) {
      total = Number(countResult.total) || 0;
    }

    // 2. Fetch paginated records
    const selectQuery = `
      SELECT
        id,
        batch_id,
        payout_id,
        action,
        admin_id,
        admin_email,
        chain,
        details,
        ip_address,
        created_at
      FROM payout_audit_logs
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `;

    const selectParams = [...params, limit, offset];
    const selectStmt = db.prepare(selectQuery).bind(...selectParams);
    const res = await selectStmt.all<PayoutAuditLogRecord>();

    const data: PayoutAuditLogRecord[] = Array.isArray(res)
      ? res
      : (res?.results || []);

    const totalPages = Math.ceil(total / limit) || (total === 0 ? 0 : 1);

    return {
      data,
      total,
      page,
      limit,
      totalPages,
    };
  }

  /**
   * Static method to query audit logs.
   */
  static async query(
    db: D1Database,
    filters?: PayoutAuditLogFilter
  ): Promise<PaginatedAuditLogs> {
    const service = new PayoutAuditService(db);
    return service.query(db, filters);
  }

  /**
   * Retrieves a single audit log entry by its primary key ID.
   */
  async getById(
    dbOrId: D1Database | string,
    maybeId?: string
  ): Promise<PayoutAuditLogRecord | null> {
    let db: D1Database;
    let id: string;

    if (typeof dbOrId === 'string') {
      db = this.resolveDatabase();
      id = dbOrId;
    } else {
      db = dbOrId;
      id = maybeId!;
    }

    const row = await db
      .prepare(
        `SELECT id, batch_id, payout_id, action, admin_id, admin_email, chain, details, ip_address, created_at
         FROM payout_audit_logs WHERE id = ?`
      )
      .bind(id)
      .first<PayoutAuditLogRecord>();

    return row || null;
  }

  /**
   * Queries all audit logs for a specific batch.
   */
  async getByBatchId(
    dbOrBatchId: D1Database | string,
    maybeBatchIdOrLimit?: string | number,
    maybeLimit?: number
  ): Promise<PayoutAuditLogRecord[]> {
    let db: D1Database;
    let batchId: string;
    let limit: number;

    if (typeof dbOrBatchId === 'string') {
      db = this.resolveDatabase();
      batchId = dbOrBatchId;
      limit = typeof maybeBatchIdOrLimit === 'number' ? maybeBatchIdOrLimit : 100;
    } else {
      db = dbOrBatchId;
      batchId = maybeBatchIdOrLimit as string;
      limit = maybeLimit ?? 100;
    }

    const res = await db
      .prepare(
        `SELECT id, batch_id, payout_id, action, admin_id, admin_email, chain, details, ip_address, created_at
         FROM payout_audit_logs WHERE batch_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .bind(batchId, limit)
      .all<PayoutAuditLogRecord>();

    return Array.isArray(res) ? res : (res?.results || []);
  }

  /**
   * Queries all audit logs for a specific payout ID.
   */
  async getByPayoutId(
    dbOrPayoutId: D1Database | string,
    maybePayoutIdOrLimit?: string | number,
    maybeLimit?: number
  ): Promise<PayoutAuditLogRecord[]> {
    let db: D1Database;
    let payoutId: string;
    let limit: number;

    if (typeof dbOrPayoutId === 'string') {
      db = this.resolveDatabase();
      payoutId = dbOrPayoutId;
      limit = typeof maybePayoutIdOrLimit === 'number' ? maybePayoutIdOrLimit : 100;
    } else {
      db = dbOrPayoutId;
      payoutId = maybePayoutIdOrLimit as string;
      limit = maybeLimit ?? 100;
    }

    const res = await db
      .prepare(
        `SELECT id, batch_id, payout_id, action, admin_id, admin_email, chain, details, ip_address, created_at
         FROM payout_audit_logs WHERE payout_id = ? ORDER BY created_at DESC LIMIT ?`
      )
      .bind(payoutId, limit)
      .all<PayoutAuditLogRecord>();

    return Array.isArray(res) ? res : (res?.results || []);
  }
}

/**
 * Singleton instance of PayoutAuditService
 */
export const payoutAuditService = new PayoutAuditService();
