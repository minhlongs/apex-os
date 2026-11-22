/**
 * Atomic Runtime-Flag Mutation + Compliance Audit Persistence
 *
 * Enforces the governance invariant:
 *   FINANCIAL_FLAG_CHANGED => AUDIT_EVENT_PERSISTED
 *
 * Every mutation to `system_runtime_flags` from an admin HTTP route MUST
 * execute in a single atomic `db.batch([flagUpsert, auditInsert])` transaction
 * so that an audit-store failure rolls back the flag mutation and fails closed.
 */

export interface AtomicFlagAuditDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): unknown;
  };
  batch(statements: unknown[]): Promise<unknown[]>;
}

export interface PersistRuntimeFlagWithAuditParams {
  flagKey: string;
  flagValue: string;
  reason: string;
  updatedBy: string;
  source: string;
  updatedAtIso?: string;
  extraDetails?: Record<string, unknown>;
}

export interface PersistRuntimeFlagWithAuditResult {
  auditId: string;
  previousValue: string | null;
}

export class RuntimeFlagAuditPersistenceError extends Error {
  public readonly code = 'AUDIT_PERSISTENCE_FAILED' as const;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'RuntimeFlagAuditPersistenceError';
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

/**
 * Atomically upserts `system_runtime_flags` and appends an immutable
 * `compliance_audit_logs` record inside a single D1 `batch()` transaction.
 *
 * Throws `RuntimeFlagAuditPersistenceError` (and rolls back the flag change)
 * if `db.batch` is unavailable or if either statement fails.
 */
export async function persistRuntimeFlagWithAudit(
  db: AtomicFlagAuditDatabase,
  params: PersistRuntimeFlagWithAuditParams
): Promise<PersistRuntimeFlagWithAuditResult> {
  if (typeof db.batch !== 'function') {
    throw new RuntimeFlagAuditPersistenceError(
      'Database binding does not support atomic batch() transactions for runtime flag audit persistence'
    );
  }

  let previousValue: string | null = null;
  try {
    const prevStmt = db
      .prepare(
        `SELECT flag_value FROM system_runtime_flags WHERE flag_key = ? LIMIT 1`
      )
      .bind(params.flagKey) as {
      first<T = unknown>(): Promise<T | null | undefined>;
    };
    const prevRow = await prevStmt.first<{ flag_value: string | null }>();
    previousValue = prevRow?.flag_value ?? null;
  } catch (err: unknown) {
    throw new RuntimeFlagAuditPersistenceError(
      `Failed to read prior value for runtime flag ${params.flagKey}`,
      err
    );
  }

  const auditId = crypto.randomUUID();
  const timestampExpr = params.updatedAtIso ? '?' : `datetime('now')`;

  const flagStmt = params.updatedAtIso
    ? db
        .prepare(
          `INSERT INTO system_runtime_flags (flag_key, flag_value, reason, updated_by, updated_at)
           VALUES (?, ?, ?, ?, ${timestampExpr})
           ON CONFLICT(flag_key) DO UPDATE SET
             flag_value = excluded.flag_value,
             reason = excluded.reason,
             updated_by = excluded.updated_by,
             updated_at = excluded.updated_at`
        )
        .bind(
          params.flagKey,
          params.flagValue,
          params.reason,
          params.updatedBy,
          params.updatedAtIso
        )
    : db
        .prepare(
          `INSERT INTO system_runtime_flags (flag_key, flag_value, reason, updated_by, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(flag_key) DO UPDATE SET
             flag_value = excluded.flag_value,
             reason = excluded.reason,
             updated_by = excluded.updated_by,
             updated_at = datetime('now')`
        )
        .bind(params.flagKey, params.flagValue, params.reason, params.updatedBy);

  const auditDetails = JSON.stringify({
    flagKey: params.flagKey,
    previousValue,
    flagValue: params.flagValue,
    reason: params.reason,
    source: params.source,
    ...(params.extraDetails ?? {}),
  });

  const auditStmt = db
    .prepare(
      `INSERT INTO compliance_audit_logs (
         id, action, severity, actor_id, target_id, details, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
    )
    .bind(
      auditId,
      'runtime_flag_updated',
      'high',
      params.updatedBy,
      params.flagKey,
      auditDetails
    );

  try {
    const results = await db.batch([flagStmt, auditStmt]);
    if (!Array.isArray(results) || results.length !== 2) {
      throw new RuntimeFlagAuditPersistenceError(
        'Atomic runtime-flag audit batch returned an unexpected result count'
      );
    }
    for (const res of results) {
      const typed = res as { success?: boolean; error?: string } | null | undefined;
      if (typed && typed.success === false) {
        throw new RuntimeFlagAuditPersistenceError(
          typed.error || 'Atomic runtime-flag audit batch statement failed'
        );
      }
    }
  } catch (err: unknown) {
    if (err instanceof RuntimeFlagAuditPersistenceError) {
      throw err;
    }
    throw new RuntimeFlagAuditPersistenceError(
      `Failed to atomically persist runtime flag ${params.flagKey} with compliance audit log`,
      err
    );
  }

  return { auditId, previousValue };
}
