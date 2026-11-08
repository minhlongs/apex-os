/**
 * D1 Alert Engine & Monitoring Migrations + Runtime Verification Tests
 *
 * Verifies:
 * 1. Sequential application of the full monitoring/alerting migration chain on
 *    real SQLite (better-sqlite3) and idempotent re-application of 012/013/014.
 * 2. `alert_rules` accepts `threshold_type = 'drop_pct'` required by
 *    DEFAULT_BUSINESS_ALERT_RULES.
 * 3. `alerts` writable `status` column, triggers, and `v_active_alerts` /
 *    `v_alert_history` / `v_alert_statistics` views execute without error.
 * 4. `fetchBusinessMetricsSnapshot` queries `webhook_failure_stats` and
 *    `stellar_balance_history` (defined in 012_business_alerting.sql) on a real
 *    SQLite schema.
 * 5. `collectStorageMetrics` falls back to `D1Result.meta.size_after` when
 *    Cloudflare D1 blocks `PRAGMA page_count` / `page_size` with `SQLITE_AUTH`.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import type { D1Database, D1ExecResult, D1QueryResult, D1Statement, D1PreparedStatement } from '@/types/d1';
import { collectStorageMetrics } from '@/lib/monitoring/d1-monitor';
import { fetchBusinessMetricsSnapshot } from '@/lib/metrics/business-metrics-fetcher';
import { evaluateBusinessAlerts } from '@/lib/notifications/business-alert-engine';
import { AlertStorage } from '@/lib/alerts/alert-storage';

const MIGRATION_CHAIN = [
  'src/database/migrations/001_initial_schema_d1.sql',
  'src/database/migrations/003_affiliate_schema.sql',
  'src/database/migrations/005_alert_history.sql',
  'src/database/migrations/009_evaluation_state_schema.sql',
  'src/database/migrations/005_d1_monitoring.sql',
  'src/database/migrations/012_alert_snoozes.sql',
  'src/database/migrations/012_alert_engine.sql',
  'src/database/migrations/012_business_alerting.sql',
  'src/database/migrations/013_alert_is_read.sql',
  'src/database/migrations/013_alert_history_fix.sql',
  'src/database/migrations/014_alerts_table.sql',
];

const TARGET_TABLES = [
  'alert_rules',
  'circuit_breaker_state',
  'evaluation_runs',
  'rule_evaluation_history',
  'evaluation_errors',
  'alert_engine_metrics',
  'alerts',
  'alert_snoozes',
  'd1_metrics_history',
  'd1_slow_queries',
  'd1_alert_configs',
  'd1_alert_history',
  'business_alert_configs',
  'business_alert_history',
  'alert_notification_log',
  'webhook_failure_stats',
  'payout_failure_stats',
  'stellar_balance_history',
  'alert_history',
];

/**
 * Wrap a better-sqlite3 Database in the async D1Database interface so real SQL
 * queries can be exercised end-to-end without mocks.
 */
function wrapBetterSqliteAsD1(sqlite: Database.Database, simulatedSizeAfter = 1056768): D1Database {
  const createPrepared = (sql: string, boundParams: unknown[]): D1PreparedStatement => ({
    async first<T = unknown>(): Promise<T | undefined> {
      const stmt = sqlite.prepare(sql);
      const row = stmt.get(...boundParams) as T | undefined;
      return row ?? undefined;
    },
    async all<T = unknown>(): Promise<D1QueryResult<T>> {
      const stmt = sqlite.prepare(sql);
      const rows = stmt.all(...boundParams) as T[];
      return {
        results: rows,
        meta: {
          last_row_id: 0,
          rows_written: 0,
          changes: 0,
          duration: 1,
          size_after: simulatedSizeAfter,
        },
      };
    },
    async run(): Promise<D1ExecResult> {
      const stmt = sqlite.prepare(sql);
      const info = stmt.run(...boundParams);
      return {
        success: true,
        meta: {
          last_row_id: Number(info.lastInsertRowid),
          rows_written: info.changes,
          changes: info.changes,
          duration: 1,
          size_after: simulatedSizeAfter,
        },
      };
    },
  });

  return {
    prepare(sql: string): D1Statement {
      const base = createPrepared(sql, []);
      return {
        bind(...values: unknown[]): D1PreparedStatement {
          return createPrepared(sql, values);
        },
        first: base.first,
        all: base.all,
        run: base.run,
      };
    },
    async exec(sql: string): Promise<D1ExecResult> {
      sqlite.exec(sql);
      return {
        success: true,
        meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 1, size_after: simulatedSizeAfter },
      };
    },
    async batch() {
      return { results: [], success: true };
    },
    async close() {
      sqlite.close();
    },
  };
}

describe('D1 Alert Engine & Monitoring Migrations + Runtime Fixes', () => {
  let sqlite: Database.Database;
  let d1: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');

    for (const relPath of MIGRATION_CHAIN) {
      const absPath = path.resolve(process.cwd(), relPath);
      const sql = fs.readFileSync(absPath, 'utf8');
      sqlite.exec(sql);
    }

    d1 = wrapBetterSqliteAsD1(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('1. Migration Chain & Schema Completeness', () => {
    it('provisions all 19 target monitoring and alerting tables', () => {
      const rows = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all() as Array<{ name: string }>;
      const existingTables = rows.map(r => r.name);

      for (const expectedTable of TARGET_TABLES) {
        expect(existingTables).toContain(expectedTable);
      }
    });

    it('re-applies 012_business_alerting, 013_alert_history_fix, and 014_alerts_table idempotently', () => {
      const rerunFiles = [
        'src/database/migrations/012_business_alerting.sql',
        'src/database/migrations/013_alert_history_fix.sql',
        'src/database/migrations/014_alerts_table.sql',
      ];

      expect(() => {
        for (const relPath of rerunFiles) {
          const sql = fs.readFileSync(path.resolve(process.cwd(), relPath), 'utf8');
          sqlite.exec(sql);
        }
      }).not.toThrow();
    });

    it('accepts threshold_type = drop_pct in alert_rules', () => {
      expect(() => {
        sqlite
          .prepare(
            `INSERT INTO alert_rules (
              id, name, description, source, metric, threshold_type, threshold_value,
              evaluation_window_minutes, severity, alert_channels, cooldown_minutes, is_enabled
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            'biz-revenue-drop-pct',
            'Revenue Drop Percentage Alert',
            'Triggers when revenue drops by more than 50%',
            'business',
            'revenue_drop',
            'drop_pct',
            50,
            120,
            'critical',
            '["email"]',
            60,
            1
          );
      }).not.toThrow();

      const row = sqlite
        .prepare('SELECT threshold_type FROM alert_rules WHERE id = ?')
        .get('biz-revenue-drop-pct') as { threshold_type: string } | undefined;
      expect(row?.threshold_type).toBe('drop_pct');
    });
  });

  describe('2. Alerts Table, Triggers, Views, and AlertStorage Integration', () => {
    it('supports AlertStorage create/update/resolve/snooze and queries v_active_alerts without error', async () => {
      const storage = new AlertStorage(d1);

      const created = await storage.create({
        rule_id: 'biz-revenue-drop',
        severity: 'warning',
        message: 'Daily revenue dropped below threshold',
        context: { currentValue: 45, thresholdValue: 100 },
      });

      expect(created.status).toBe('active');

      // Query v_active_alerts view (previously failed with no such column: ar.metric_type)
      const activeViewRows = sqlite
        .prepare('SELECT id, rule_id, rule_name, source, metric_type, status FROM v_active_alerts')
        .all() as Array<{
          id: string;
          rule_id: string;
          rule_name: string;
          source: string;
          metric_type: string;
          status: string;
        }>;

      expect(activeViewRows).toHaveLength(1);
      expect(activeViewRows[0].id).toBe(created.id);
      expect(activeViewRows[0].metric_type).toBe('daily_revenue');

      // Snooze via AlertStorage.update (writes to status column directly)
      const snoozeUntil = new Date(Date.now() + 30 * 60 * 1000);
      const snoozed = await storage.snooze(created.id, snoozeUntil);
      expect(snoozed?.status).toBe('snoozed');

      // Expire snooze and run cleanupExpiredSnoozes
      const expiredIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      sqlite.prepare('UPDATE alerts SET snoozed_until = ? WHERE id = ?').run(expiredIso, created.id);
      const clearedCount = await storage.cleanupExpiredSnoozes();
      expect(clearedCount).toBe(1);

      const reactivated = await storage.getById(created.id);
      expect(reactivated?.status).toBe('active');
      expect(reactivated?.snoozed_until).toBeNull();

      // Resolve via AlertStorage.resolve
      const resolved = await storage.resolve(created.id);
      expect(resolved?.status).toBe('resolved');
      expect(resolved?.resolved_at).toBeTruthy();

      const historyViewRows = sqlite
        .prepare('SELECT id, status, metric_type FROM v_alert_history')
        .all() as Array<{ id: string; status: string; metric_type: string }>;
      expect(historyViewRows).toHaveLength(1);
      expect(historyViewRows[0].id).toBe(created.id);

      const statsViewRows = sqlite
        .prepare('SELECT rule_id, total_triggered, resolved_count FROM v_alert_statistics')
        .all() as Array<{ rule_id: string; total_triggered: number; resolved_count: number }>;
      expect(statsViewRows).toHaveLength(1);
      expect(statsViewRows[0].resolved_count).toBe(1);
    });
  });

  describe('3. fetchBusinessMetricsSnapshot Real Schema Queries', () => {
    it('reads webhook failure rates from webhook_failure_stats and Stellar balance from stellar_balance_history', async () => {
      const nowIso = new Date().toISOString();
      const windowStartIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      sqlite
        .prepare(
          `INSERT INTO webhook_failure_stats (
            id, webhook_type, endpoint_path, total_attempts, successful_attempts,
            failed_attempts, window_start, window_end
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('wh-1', 'exchange', '/api/webhooks/exchange', 20, 17, 3, windowStartIso, nowIso);

      sqlite
        .prepare(
          `INSERT INTO stellar_balance_history (
            id, balance_usdc, balance_native, wallet_address, network, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('sb-1', 425.75, 50000000, 'GABC1234567890', 'testnet', nowIso);

      const snapshot = await fetchBusinessMetricsSnapshot(d1, 120);

      expect(snapshot.webhookTotalAttempts).toBe(20);
      expect(snapshot.webhookFailedAttempts).toBe(3);
      expect(snapshot.webhookFailureRate).toBeCloseTo(15, 2);
      expect(snapshot.stellarBalance).toBeCloseTo(425.75, 2);
    });
  });

  describe('4. collectStorageMetrics D1 SQLITE_AUTH Fallback', () => {
    it('falls back to SELECT 1 and D1Result.meta.size_after when PRAGMA throws SQLITE_AUTH', async () => {
      const expectedBytes = 1056768;

      const remoteD1Mock: D1Database = {
        prepare(sql: string): D1Statement {
          const runPrepared = (): D1PreparedStatement => ({
            async first<T = unknown>(): Promise<T | undefined> {
              if (sql.trim().toUpperCase().startsWith('PRAGMA')) {
                throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
              }
              return { 1: 1 } as unknown as T;
            },
            async all<T = unknown>(): Promise<D1QueryResult<T>> {
              if (sql.trim().toUpperCase().startsWith('PRAGMA')) {
                throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
              }
              return {
                results: [{ 1: 1 } as unknown as T],
                meta: {
                  last_row_id: 0,
                  rows_written: 0,
                  changes: 0,
                  duration: 0.4,
                  size_after: expectedBytes,
                },
              };
            },
            async run(): Promise<D1ExecResult> {
              throw new Error('D1_ERROR: not authorized: SQLITE_AUTH');
            },
          });

          const base = runPrepared();
          return {
            bind(): D1PreparedStatement {
              return runPrepared();
            },
            first: base.first,
            all: base.all,
            run: base.run,
          };
        },
        async exec(): Promise<D1ExecResult> {
          return {
            success: true,
            meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0, size_after: expectedBytes },
          };
        },
        async batch() {
          return { results: [], success: true };
        },
        async close() {},
      };

      const metrics = await collectStorageMetrics(remoteD1Mock);
      expect(metrics.storageBytes).toBe(expectedBytes);
      expect(metrics.pageSize).toBe(4096);
      expect(metrics.pageCount).toBe(Math.ceil(expectedBytes / 4096));
      expect(metrics.walSizeBytes).toBe(0);
    });

    it('reads page_count and page_size from PRAGMA on local SQLite', async () => {
      const metrics = await collectStorageMetrics(d1);

      expect(metrics.pageSize).toBe(4096);
      expect(metrics.pageCount).toBeGreaterThan(0);
      expect(metrics.storageBytes).toBe(metrics.pageCount * metrics.pageSize);
    });
  });

  describe('5. evaluateBusinessAlerts Real Schema Queries', () => {
    it('evaluates enabled configs against webhook_failure_stats and stellar_balance_history', async () => {
      sqlite.exec(`
        CREATE VIEW IF NOT EXISTS v_daily_revenue AS
        SELECT DATE(converted_at) AS date, COALESCE(SUM(revenue), 0) AS revenue
        FROM conversions WHERE status = 'approved' GROUP BY DATE(converted_at);

        CREATE VIEW IF NOT EXISTS v_conversion_rates AS
        SELECT DATE(created_at) AS date, COUNT(*) AS total_clicks, 0 AS total_conversions, 0.0 AS conversion_rate
        FROM deal_clicks GROUP BY DATE(created_at);
      `);

      const nowIso = new Date().toISOString();
      const windowStartIso = new Date(Date.now() - 30 * 60 * 1000).toISOString();

      sqlite
        .prepare(
          `INSERT INTO webhook_failure_stats (
            id, webhook_type, endpoint_path, total_attempts, successful_attempts,
            failed_attempts, window_start, window_end
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('wh-1', 'exchange', '/api/webhooks/exchange', 100, 80, 20, windowStartIso, nowIso);

      sqlite
        .prepare(
          `INSERT INTO stellar_balance_history (
            id, balance_usdc, balance_native, wallet_address, network, recorded_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('sb-1', 25.5, 50000000, 'GABC1234567890', 'testnet', nowIso);

      const result = await evaluateBusinessAlerts(d1, true);
      const webhookTriggered = result.triggered.find(a => a.config_id === 'alert-webhook-failures');
      const stellarTriggered = result.triggered.find(a => a.config_id === 'alert-stellar-balance');

      expect(webhookTriggered).toBeDefined();
      expect(webhookTriggered?.current_value).toBeCloseTo(20, 2);
      expect(stellarTriggered).toBeDefined();
      expect(stellarTriggered?.current_value).toBeCloseTo(25.5, 2);

      const historyRow = sqlite
        .prepare('SELECT COUNT(*) as count FROM business_alert_history WHERE alert_config_id = ?')
        .get('alert-webhook-failures') as { count: number } | undefined;
      expect(historyRow?.count).toBe(1);
    });
  });
});
