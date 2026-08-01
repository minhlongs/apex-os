/**
 * Query Cost Monitoring System
 *
 * Tracks D1 query execution metrics:
 * - Execution time (duration in milliseconds)
 * - Rows scanned (rows_read from D1 meta)
 * - Rows returned
 * - SQL query text
 *
 * Logs expensive queries based on thresholds:
 * - Slow queries: duration > 100ms
 * - High scan queries: rows_scanned > 10000
 *
 * Integrates transparently with D1 database by wrapping
 * the prepare/bind/all/run API.
 */

import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';
import type { D1QueryResult, D1ExecResult } from '@/lib/auth/adapters/d1-adapter';

// Use global crypto.randomUUID() (available in Cloudflare Workers)
function generateUUID(): string {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
      const r = Math.random() * 16 | 0;
      const v = c === 'x' ? r : (r & 0x3 | 0x8);
      return v.toString(16);
    });
}

// ============================================================================
// Configuration
// ============================================================================

export interface QueryMonitorConfig {
  slowQueryThresholdMs?: number;
  highRowScanThreshold?: number;
  enableConsoleLog?: boolean;
  persistenceDb?: D1Database;
  defaultContext?: { endpointPath?: string; userId?: string };
}

const DEFAULT_CONFIG: Required<Omit<QueryMonitorConfig, 'persistenceDb' | 'defaultContext'>> = {
  slowQueryThresholdMs: 100,
  highRowScanThreshold: 10000,
  enableConsoleLog: true,
};

// ============================================================================
// Metrics Types
// ============================================================================

export interface QueryMetrics {
  id: string;
  sql: string;
  durationMs: number;
  rowsScanned: number;
  rowsReturned: number;
  endpointPath?: string;
  userId?: string;
  completedAt: Date;
  isSlow: boolean;
  isHighScan: boolean;
}

export interface QueryMonitorStats {
  totalQueries: number;
  totalDurationMs: number;
  avgDurationMs: number;
  slowQueryCount: number;
  highScanCount: number;
  maxDurationMs: number;
  totalRowsScanned: number;
}

// ============================================================================
// Query Monitor Class
// ============================================================================

export class QueryMonitor {
  private _config: Required<Omit<QueryMonitorConfig, 'persistenceDb' | 'defaultContext'>> & {
    enableConsoleLog: boolean;
    persistenceDb?: D1Database;
    defaultContext?: { endpointPath?: string; userId?: string };
  };
  private _stats: QueryMonitorStats;
  private _recentQueries: QueryMetrics[];
  private _maxRecentQueries: number;

  constructor(config: QueryMonitorConfig = {}) {
    this._config = { ...DEFAULT_CONFIG, ...config };
    this._config.enableConsoleLog = config.enableConsoleLog ?? true;
    this._config.defaultContext = config.defaultContext;
    this.persistenceDb = config.persistenceDb;

    this._stats = {
      totalQueries: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      slowQueryCount: 0,
      highScanCount: 0,
      maxDurationMs: 0,
      totalRowsScanned: 0,
    };

    this._recentQueries = [];
    this._maxRecentQueries = 100;
  }

  private persistenceDb?: D1Database;

  recordQuery(metrics: Omit<QueryMetrics, 'id' | 'completedAt' | 'isSlow' | 'isHighScan'>): void {
    const completedAt = new Date();
    const isSlow = metrics.durationMs > this._config.slowQueryThresholdMs;
    const isHighScan = metrics.rowsScanned > this._config.highRowScanThreshold;

    const fullMetrics: QueryMetrics = {
      ...metrics,
      id: generateUUID(),
      completedAt,
      isSlow,
      isHighScan,
    };

    this._stats.totalQueries++;
    this._stats.totalDurationMs += metrics.durationMs;
    this._stats.avgDurationMs = this._stats.totalDurationMs / this._stats.totalQueries;
    this._stats.maxDurationMs = Math.max(this._stats.maxDurationMs, metrics.durationMs);
    this._stats.totalRowsScanned += metrics.rowsScanned;
    if (isSlow) this._stats.slowQueryCount++;
    if (isHighScan) this._stats.highScanCount++;

    this._recentQueries.push(fullMetrics);
    if (this._recentQueries.length > this._maxRecentQueries) {
      this._recentQueries.shift();
    }

    if (isSlow || isHighScan) {
      this._logExpensiveQuery(fullMetrics);
    }

    if (isSlow && this.persistenceDb) {
      this._persistSlowQuery(fullMetrics).catch(err => {
        logError('Failed to persist slow query:', err);
      });
    }
  }

  _logExpensiveQuery(metrics: QueryMetrics): void {
    if (!this._config.enableConsoleLog) return;

    const reasons: string[] = [];
    if (metrics.isSlow) {
      reasons.push(`duration ${metrics.durationMs}ms > threshold ${this._config.slowQueryThresholdMs}ms`);
    }
    if (metrics.isHighScan) {
      reasons.push(`rows scanned ${metrics.rowsScanned} > threshold ${this._config.highRowScanThreshold}`);
    }

    const context: string[] = [];
    if (metrics.endpointPath) context.push(`endpoint: ${metrics.endpointPath}`);
    if (metrics.userId) context.push(`user: ${metrics.userId}`);

    logWarn(
      `[QueryMonitor] Expensive query detected (${reasons.join('; ')})\n` +
      ` SQL: ${metrics.sql.substring(0, 200)}${metrics.sql.length > 200 ? '...' : ''}\n` +
      ` Duration: ${metrics.durationMs}ms\n` +
      ` Rows Scanned: ${metrics.rowsScanned}\n` +
      ` Rows Returned: ${metrics.rowsReturned}\n` +
      ` ${context.length ? 'Context: ' + context.join(', ') + '\n' : ''}` +
      ` Query ID: ${metrics.id}`
    );
  }

  _persistSlowQuery(metrics: QueryMetrics): Promise<void> {
    if (!this.persistenceDb) return Promise.resolve();

    const thresholds = {
      slow: this._config.slowQueryThresholdMs,
      highScan: this._config.highRowScanThreshold,
    };

    return this.persistenceDb
      .prepare(`
        INSERT INTO d1_slow_queries (
          query_text, duration_ms, rows_scanned, rows_returned,
          endpoint_path, user_id, context, logged_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        metrics.sql, metrics.durationMs, metrics.rowsScanned, metrics.rowsReturned,
        metrics.endpointPath ?? null, metrics.userId ?? null,
        JSON.stringify({ queryId: metrics.id, thresholds }),
        metrics.completedAt.toISOString()
      )
      .run()
      .then(() => {})
      .catch(error => {
        logError('Failed to persist slow query to database:', error);
      });
  }

  getStats(): QueryMonitorStats {
    return { ...this._stats };
  }

  resetStats(): void {
    this._stats = {
      totalQueries: 0,
      totalDurationMs: 0,
      avgDurationMs: 0,
      slowQueryCount: 0,
      highScanCount: 0,
      maxDurationMs: 0,
      totalRowsScanned: 0,
    };
  }

  getRecentQueries(): QueryMetrics[] {
    return [...this._recentQueries];
  }

  getSlowQueries(): QueryMetrics[] {
    return this._recentQueries.filter(q => q.isSlow);
  }

  getHighScanQueries(): QueryMetrics[] {
    return this._recentQueries.filter(q => q.isHighScan);
  }

  setDefaultContext(context: { endpointPath?: string; userId?: string }): void {
    this._config.defaultContext = context;
  }
}

// ============================================================================
// Statement Wrapping
// ============================================================================

function wrapPreparedStatement(
  original: D1PreparedStatement,
  sql: string,
  monitor: QueryMonitor,
  context: { endpointPath?: string; userId?: string }
): D1PreparedStatement {
  return {
    bind(...values: unknown[]): D1PreparedStatement {
      const bound = original.bind(...values);
      return wrapPreparedStatement(bound, sql, monitor, context);
    },

    async first<T = unknown>(): Promise<T | null> {
      const startTime = Date.now();
      try {
        const result = await original.first<T>();
        const durationMs = Date.now() - startTime;

        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: result ? 1 : 0,
          rowsReturned: result ? 1 : 0,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });

        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: 0,
          rowsReturned: 0,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });
        throw error;
      }
    },

    async firstColumnMap(): Promise<Map<unknown, unknown> | null> {
      const startTime = Date.now();
      try {
        const queryResult = await original.all<Record<string, unknown>>();
        const rows = queryResult.results;
        const map = new Map<unknown, unknown>();
        for (const row of rows) {
          const values = Object.values(row);
          if (values.length >= 2) {
            map.set(values[0], values[1]);
          }
        }
        const durationMs = Date.now() - startTime;
        const rowsScanned = map.size;

        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned,
          rowsReturned: rowsScanned,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });

        return map.size > 0 ? map : null;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: 0,
          rowsReturned: 0,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });
        throw error;
      }
    },

    async all<T = unknown>(): Promise<D1QueryResult<T>> {
      const startTime = Date.now();
      try {
        const result = await original.all<T>();
        const durationMs = Date.now() - startTime;

        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: result.results.length,
          rowsReturned: result.results.length,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });

        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: 0,
          rowsReturned: 0,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });
        throw error;
      }
    },

    async run(): Promise<D1ExecResult> {
      const startTime = Date.now();
      try {
        const result = await original.run();
        const durationMs = Date.now() - startTime;

        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: 0,
          rowsReturned: 0,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });

        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        monitor.recordQuery({
          sql,
          durationMs,
          rowsScanned: 0,
          rowsReturned: 0,
          endpointPath: context.endpointPath,
          userId: context.userId,
        });
        throw error;
      }
    },

    raw<T = unknown>(): AsyncIterable<T> {
      return original.raw<T>();
    },
  };
}

function wrapPreparedStatementWithSql(
  original: D1PreparedStatement,
  sql: string,
  monitor: QueryMonitor,
  context: { endpointPath?: string; userId?: string }
): D1PreparedStatement {
  return wrapPreparedStatement(original, sql, monitor, context);
}

// ============================================================================
// Database Wrapping
// ============================================================================

export function wrapDatabase(
  originalDb: D1Database,
  context: { endpointPath?: string; userId?: string } = {}
): D1Database {
  const monitor = getGlobalMonitor() || new QueryMonitor();

  return {
    prepare(sql: string): D1PreparedStatement {
      const statement = originalDb.prepare(sql);
      return wrapPreparedStatementWithSql(statement, sql, monitor, context);
    },

    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      const startTime = Date.now();
      try {
        const result = await originalDb.batch(statements);
        const durationMs = Date.now() - startTime;

        // Record each statement in the batch
        const perStmtDuration = Math.floor(durationMs / statements.length);
        for (const stmt of statements) {
          // Note: We can't extract SQL from wrapped statements easily.
          // In practice, batch queries are rare and mostly for inserts.
          monitor.recordQuery({
            sql: '[batch statement]',
            durationMs: perStmtDuration,
            rowsScanned: 0,
            rowsReturned: 0,
            endpointPath: context.endpointPath,
            userId: context.userId,
          });
        }

        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        for (const stmt of statements) {
          monitor.recordQuery({
            sql: '[batch statement]',
            durationMs,
            rowsScanned: 0,
            rowsReturned: 0,
            endpointPath: context.endpointPath,
            userId: context.userId,
          });
        }
        throw error;
      }
    },

    async exec(sql: string): Promise<D1ExecResult> {
      return originalDb.exec(sql);
    },

    async dump(): Promise<string> {
      return originalDb.dump();
    },

    async close(): Promise<void> {
      return originalDb.close();
    },
  };
}

// ============================================================================
// Global Monitor Instance
// ============================================================================

let globalMonitor: QueryMonitor | null = null;

export function initializeQueryMonitor(config: QueryMonitorConfig = {}): QueryMonitor {
  if (globalMonitor) {
    logWarn('[QueryMonitor] Already initialized, returning existing instance');
    return globalMonitor;
  }

  const thresholds = {
    slowQueryThresholdMs: config.slowQueryThresholdMs ?? DEFAULT_CONFIG.slowQueryThresholdMs,
    highRowScanThreshold: config.highRowScanThreshold ?? DEFAULT_CONFIG.highRowScanThreshold,
  };

  globalMonitor = new QueryMonitor(config);
  logInfo('[QueryMonitor] Initialized with config:', thresholds);

  return globalMonitor;
}

export function getGlobalMonitor(): QueryMonitor | null {
  return globalMonitor;
}

export function resetGlobalMonitor(): void {
  globalMonitor = null;
}
