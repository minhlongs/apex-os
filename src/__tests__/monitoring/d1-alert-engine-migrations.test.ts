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
import {
  fetchBusinessMetricsSnapshot,
  fetchDailyRevenue,
  fetchConversionRates,
  fetchActiveAffiliates,
  fetchTopDeals,
} from '@/lib/metrics/business-metrics-fetcher';
import { evaluateBusinessAlerts } from '@/lib/notifications/business-alert-engine';
import { AlertStorage } from '@/lib/alerts/alert-storage';
import { AlertEngine } from '@/lib/monitoring/alert-engine';
import { EvaluationStateStorage } from '@/lib/monitoring/evaluation-state-storage';

const MIGRATION_CHAIN = [
  'src/database/migrations/001_initial_schema_d1.sql',
  'src/database/migrations/003_affiliate_schema.sql',
  'src/database/migrations/004_add_deals_filters.sql',
  'src/database/migrations/005_alert_history.sql',
  'src/database/migrations/009_evaluation_state_schema.sql',
  'src/database/migrations/005_d1_monitoring.sql',
  'src/database/migrations/010_business_metrics_views.sql',
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

    it('re-applies 010_business_metrics_views, 012_business_alerting, 013_alert_history_fix, and 014_alerts_table idempotently', () => {
      const rerunFiles = [
        'src/database/migrations/010_business_metrics_views.sql',
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
    it('evaluates enabled configs against real 010_business_metrics_views, webhook_failure_stats, and stellar_balance_history', async () => {
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

  describe('6. AlertEngine Evaluates Rules Seeded by 012_alert_engine.sql', () => {
    it('evaluates all 8 default database rules rather than skipping snake_case rows', async () => {
      // Clear external channels so the test measures database rule evaluation
      // without waiting on email/webhook retry backoffs.
      sqlite.prepare("UPDATE alert_rules SET alert_channels = '[]'").run();

      const engine = new AlertEngine({ persistAlerts: false });
      await engine.initialize(d1);
      // Bind a dedicated storage instance to this test's in-memory database.
      engine['evaluationStorage'] = new EvaluationStateStorage(d1);

      await engine.runCycle();

      const runRow = sqlite
        .prepare('SELECT rules_evaluated, status, errors_count FROM evaluation_runs ORDER BY started_at DESC LIMIT 1')
        .get() as { rules_evaluated: number; status: string; errors_count: number } | undefined;

      expect(runRow).toBeDefined();
      expect(runRow?.status).toBe('completed');
      expect(runRow?.errors_count).toBe(0);
      expect(runRow?.rules_evaluated).toBe(8);
    });
  });

  describe('7. 010_business_metrics_views.sql Views & Business Metrics Fetcher', () => {
    it('executes all 6 views in 010_business_metrics_views including v_period_summary with top_deal_name and prevents multi-row fan-out', async () => {
      const todayDate = new Date().toISOString().split('T')[0];
      const nowIso = new Date().toISOString();

      sqlite.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)').run('u-1', 'Alice', 'alice@example.com');
      sqlite.prepare('INSERT INTO users (id, name, email) VALUES (?, ?, ?)').run('u-2', 'Bob', 'bob@example.com');
      sqlite
        .prepare('INSERT INTO profiles (id, email, full_name, role) VALUES (?, ?, ?, ?)')
        .run('u-1', 'alice@example.com', 'Alice Trader', 'affiliate');
      sqlite
        .prepare('INSERT INTO profiles (id, email, full_name, role) VALUES (?, ?, ?, ?)')
        .run('u-2', 'bob@example.com', 'Bob Referrer', 'affiliate');

      sqlite
        .prepare(
          `INSERT INTO deals (id, name, deal_type, url, exchange, category, cashback_percent, default_commission_rate, is_active)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('deal-1', 'Binance VIP Rebate', 'service', 'https://binance.com', 'binance', 'futures', 20, 0.2, 1);

      sqlite
        .prepare('INSERT INTO affiliate_codes (id, code, affiliate_id, deal_id, commission_rate) VALUES (?, ?, ?, ?, ?)')
        .run('ac-1', 'ALICE20', 'u-1', 'deal-1', 0.2);

      // Insert 3 clicks across 2 sessions to verify joins do NOT multiply revenue/commission by click count
      sqlite
        .prepare(
          `INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('click-1', 'deal-1', 'ALICE20', 'u-1', 'sess-1', nowIso);
      sqlite
        .prepare(
          `INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('click-2', 'deal-1', 'ALICE20', 'u-1', 'sess-1', nowIso);
      sqlite
        .prepare(
          `INSERT INTO deal_clicks (id, deal_id, affiliate_code, affiliate_id, session_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run('click-3', 'deal-1', 'ALICE20', 'u-1', 'sess-2', nowIso);

      // Insert 2 conversions on the same day (500 + 300 = 800 total revenue)
      sqlite
        .prepare(
          `INSERT INTO conversions (
            id, deal_id, deal_click_id, affiliate_code, affiliate_id, customer_id,
            revenue, commission_amount, status, converted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('conv-1', 'deal-1', 'click-1', 'ALICE20', 'u-1', 'cust-1', 500, 100, 'approved', nowIso);
      sqlite
        .prepare(
          `INSERT INTO conversions (
            id, deal_id, deal_click_id, affiliate_code, affiliate_id, customer_id,
            revenue, commission_amount, status, converted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run('conv-2', 'deal-1', 'click-3', 'ALICE20', 'u-1', 'cust-2', 300, 60, 'approved', nowIso);

      // Insert 1 earnings row per conversion (100 + 60 = 160 total commission)
      sqlite
        .prepare('INSERT INTO earnings (id, conversion_id, affiliate_id, amount, is_paid) VALUES (?, ?, ?, ?, ?)')
        .run('earn-1', 'conv-1', 'u-1', 100, 0);
      sqlite
        .prepare('INSERT INTO earnings (id, conversion_id, affiliate_id, amount, is_paid) VALUES (?, ?, ?, ?, ?)')
        .run('earn-2', 'conv-2', 'u-1', 60, 0);

      // Query all 6 views from 010_business_metrics_views.sql
      const periodRows = sqlite.prepare('SELECT * FROM v_period_summary').all() as Array<{
        period: string;
        total_conversions: number;
        total_revenue: number;
        total_commission: number;
        active_affiliates_count: number;
        top_deal_name: string | null;
        top_affiliate_name: string | null;
      }>;
      expect(periodRows).toHaveLength(2);
      const lifetimeRow = periodRows.find(r => r.period === 'lifetime');
      const last30Row = periodRows.find(r => r.period === 'last_30_days');
      expect(lifetimeRow?.top_deal_name).toBe('Binance VIP Rebate');
      expect(lifetimeRow?.total_conversions).toBe(2);
      expect(lifetimeRow?.total_revenue).toBe(800);
      expect(lifetimeRow?.total_commission).toBe(160);
      expect(lifetimeRow?.active_affiliates_count).toBe(2);
      expect(last30Row?.top_deal_name).toBe('Binance VIP Rebate');
      expect(last30Row?.total_revenue).toBe(800);
      expect(last30Row?.total_commission).toBe(160);

      const dailyRevRows = sqlite.prepare('SELECT * FROM v_daily_revenue').all() as Array<{
        date: string;
        total_conversions: number;
        total_revenue: number;
        revenue: number;
        total_commission: number;
        total_clicks: number;
      }>;
      expect(dailyRevRows).toHaveLength(1);
      expect(dailyRevRows[0].total_conversions).toBe(2);
      expect(dailyRevRows[0].total_revenue).toBe(800);
      expect(dailyRevRows[0].revenue).toBe(800);
      expect(dailyRevRows[0].total_commission).toBe(160);
      expect(dailyRevRows[0].total_clicks).toBe(3);

      const convRateRows = sqlite.prepare('SELECT * FROM v_conversion_rates').all() as Array<{
        date: string;
        total_clicks: number;
        total_conversions: number;
        conversion_rate_percent: number;
        conversion_rate: number;
      }>;
      expect(convRateRows).toHaveLength(1);
      expect(convRateRows[0].total_clicks).toBe(3);
      expect(convRateRows[0].total_conversions).toBe(2);
      expect(convRateRows[0].conversion_rate_percent).toBeCloseTo(66.67, 2);
      expect(convRateRows[0].conversion_rate).toBeCloseTo(66.67, 2);

      const activeAffRows = sqlite.prepare('SELECT * FROM v_active_affiliates ORDER BY id ASC').all() as Array<{
        id: string;
        pending_earnings: number;
        total_conversions: number;
        total_revenue: number;
        total_clicks: number;
      }>;
      expect(activeAffRows).toHaveLength(2);
      expect(activeAffRows[0].id).toBe('u-1');
      expect(activeAffRows[0].pending_earnings).toBe(160);
      expect(activeAffRows[0].total_conversions).toBe(2);
      expect(activeAffRows[0].total_revenue).toBe(800);
      expect(activeAffRows[0].total_clicks).toBe(3);

      const dealPerfRows = sqlite.prepare('SELECT * FROM v_deal_performance').all() as Array<{
        id: string;
        total_clicks: number;
        unique_clicks: number;
        total_conversions: number;
        total_revenue: number;
        total_commission: number;
      }>;
      expect(dealPerfRows).toHaveLength(1);
      expect(dealPerfRows[0].total_clicks).toBe(3);
      expect(dealPerfRows[0].unique_clicks).toBe(2);
      expect(dealPerfRows[0].total_conversions).toBe(2);
      expect(dealPerfRows[0].total_revenue).toBe(800);
      expect(dealPerfRows[0].total_commission).toBe(160);

      const affActivityRows = sqlite.prepare('SELECT * FROM v_affiliate_activity ORDER BY id ASC').all() as Array<{
        id: string;
        total_clicks: number;
        total_conversions: number;
        total_revenue: number;
      }>;
      expect(affActivityRows).toHaveLength(2);
      expect(affActivityRows[0].total_clicks).toBe(3);
      expect(affActivityRows[0].total_conversions).toBe(2);
      expect(affActivityRows[0].total_revenue).toBe(800);

      // Verify fetcher functions both unfiltered and filtered (deal_type + exchange)
      const baseParams = {
        start_date: todayDate,
        end_date: todayDate,
        startDateObj: new Date(`${todayDate}T00:00:00.000Z`),
        endDateObj: new Date(`${todayDate}T23:59:59.999Z`),
      };

      const unfilteredRev = await fetchDailyRevenue(d1, baseParams);
      expect(unfilteredRev).toHaveLength(1);
      expect(unfilteredRev?.[0].revenue).toBe(800);
      expect(unfilteredRev?.[0].conversions).toBe(2);
      expect(unfilteredRev?.[0].commission_paid).toBe(160);

      const filteredRev = await fetchDailyRevenue(d1, {
        ...baseParams,
        deal_type: 'service',
        exchange: 'binance',
        status: 'approved',
      });
      expect(filteredRev).toHaveLength(1);
      expect(filteredRev?.[0].revenue).toBe(800);
      expect(filteredRev?.[0].conversions).toBe(2);
      expect(filteredRev?.[0].commission_paid).toBe(160);

      const filteredConv = await fetchConversionRates(d1, {
        ...baseParams,
        deal_type: 'service',
        exchange: 'binance',
      });
      expect(filteredConv).toHaveLength(1);
      expect(filteredConv?.[0].total_clicks).toBe(3);
      expect(filteredConv?.[0].total_conversions).toBe(2);
      expect(filteredConv?.[0].unique_visitors).toBe(2);

      const unfilteredAff = await fetchActiveAffiliates(d1, baseParams);
      expect(unfilteredAff?.total_affiliates).toBe(1);

      const filteredAff = await fetchActiveAffiliates(d1, {
        ...baseParams,
        deal_type: 'service',
        exchange: 'binance',
      });
      expect(filteredAff?.total_affiliates).toBe(1);

      const topDeals = await fetchTopDeals(d1, {
        ...baseParams,
        deal_type: 'service',
        exchange: 'binance',
      });
      expect(topDeals?.deals).toHaveLength(1);
      expect(topDeals?.deals[0].name).toBe('Binance VIP Rebate');
      expect(topDeals?.deals[0].total_revenue).toBe(800);
      expect(topDeals?.deals[0].total_clicks).toBe(3);
    });

    it('applies 010_business_metrics_views.sql cleanly on top of schema-complete.sql', () => {
      const freshSqlite = new Database(':memory:');
      try {
        const schemaCompleteSql = fs.readFileSync(
          path.resolve(process.cwd(), 'src/database/schema-complete.sql'),
          'utf8'
        );
        const metricsViewsSql = fs.readFileSync(
          path.resolve(process.cwd(), 'src/database/migrations/010_business_metrics_views.sql'),
          'utf8'
        );

        expect(() => {
          freshSqlite.exec(schemaCompleteSql);
          freshSqlite.exec(metricsViewsSql);
        }).not.toThrow();

        const views = [
          'v_daily_revenue',
          'v_conversion_rates',
          'v_active_affiliates',
          'v_deal_performance',
          'v_period_summary',
          'v_affiliate_activity',
        ];
        for (const viewName of views) {
          expect(() => freshSqlite.prepare(`SELECT * FROM ${viewName}`).all()).not.toThrow();
        }
      } finally {
        freshSqlite.close();
      }
    });
  });
});
