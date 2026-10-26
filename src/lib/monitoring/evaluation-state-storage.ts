/**
 * Evaluation State Storage Layer
 *
 * Provides CRUD operations and query methods for evaluation state persistence:
 * - Evaluation runs tracking
 * - Rule evaluation history
 * - Error tracking
 * - Circuit breaker state management
 * - Alert engine metrics
 */

import type { D1Database } from '@/types/d1';
import type {
  EvaluationRun,
  CreateEvaluationRunInput,
  UpdateEvaluationRunInput,
  RuleEvaluationHistory,
  CreateRuleEvaluationInput,
  EvaluationError,
  CreateEvaluationErrorInput,
  CircuitBreakerEntry,
  CreateCircuitBreakerInput,
  UpdateCircuitBreakerInput,
  AlertEngineMetrics,
  RecordMetricsInput,
  EvaluationStats,
  RuleStats,
} from '@/types/evaluation-state';

export class EvaluationStateStorage {
  private db: D1Database;

  constructor(db: D1Database) {
    this.db = db;
  }

  // ============================================================================
  // Evaluation Runs
  // ============================================================================

  async createRun(input: CreateEvaluationRunInput = {}): Promise<string> {
    const id = `run_${crypto.randomUUID()}`;
    const startedAt = input.started_at?.toISOString() || new Date().toISOString();

    const result = await this.db
      .prepare(`
        INSERT INTO evaluation_runs (id, started_at, status, metadata)
        VALUES (?, ?, 'running', ?)
      `)
      .bind(id, startedAt, JSON.stringify(input.metadata || {}))
      .run();

    if (!result.success) {
      throw new Error('Failed to create evaluation run');
    }

    return id;
  }

  async getRun(id: string): Promise<EvaluationRun | null> {
    const result = await this.db
      .prepare('SELECT * FROM evaluation_runs WHERE id = ?')
      .bind(id)
      .first<DatabaseRunRow>();

    return result ? this.normalizeRun(result) : null;
  }

  async updateRun(id: string, updates: UpdateEvaluationRunInput): Promise<EvaluationRun | null> {
    const fields: string[] = [];
    const values: unknown[] = [];

    if (updates.completed_at !== undefined) {
      fields.push('completed_at = ?');
      values.push(updates.completed_at.toISOString());
    }
    if (updates.duration_ms !== undefined) {
      fields.push('duration_ms = ?');
      values.push(updates.duration_ms);
    }
    if (updates.status !== undefined) {
      fields.push('status = ?');
      values.push(updates.status);
    }
    if (updates.rules_evaluated !== undefined) {
      fields.push('rules_evaluated = ?');
      values.push(updates.rules_evaluated);
    }
    if (updates.alerts_triggered !== undefined) {
      fields.push('alerts_triggered = ?');
      values.push(updates.alerts_triggered);
    }
    if (updates.errors_count !== undefined) {
      fields.push('errors_count = ?');
      values.push(updates.errors_count);
    }

    if (fields.length === 0) {
      return this.getRun(id);
    }

    values.push(id);

    const result = await this.db
      .prepare(`UPDATE evaluation_runs SET ${fields.join(', ')} WHERE id = ?`)
      .bind(...values)
      .run();

    if (!result.success || result.meta.changes === 0) {
      return null;
    }

    return this.getRun(id);
  }

  async completeRun(
    id: string,
    durationMs: number,
    stats: { rulesEvaluated: number; alertsTriggered: number; errorsCount: number }
  ): Promise<void> {
    await this.updateRun(id, {
      completed_at: new Date(),
      duration_ms: durationMs,
      status: stats.errorsCount > 0 ? 'partial_failure' : 'completed',
      rules_evaluated: stats.rulesEvaluated,
      alerts_triggered: stats.alertsTriggered,
      errors_count: stats.errorsCount,
    });
  }

  async failRun(id: string, error: Error): Promise<void> {
    await this.updateRun(id, {
      completed_at: new Date(),
      status: 'failed',
      errors_count: 1,
    });
  }

  async getRecentRuns(limit: number = 50): Promise<EvaluationRun[]> {
    const result = await this.db
      .prepare(`
        SELECT * FROM evaluation_runs
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .bind(limit)
      .all<DatabaseRunRow>();

    return result.results.map(row => this.normalizeRun(row));
  }

  async getFailedRuns(since: Date, limit: number = 20): Promise<EvaluationRun[]> {
    const result = await this.db
      .prepare(`
        SELECT * FROM evaluation_runs
        WHERE status IN ('failed', 'partial_failure')
          AND started_at >= ?
        ORDER BY started_at DESC
        LIMIT ?
      `)
      .bind(since.toISOString(), limit)
      .all<DatabaseRunRow>();

    return result.results.map(row => this.normalizeRun(row));
  }

  async getRunMetrics(
    since: Date,
    groupBy: 'hour' | 'day' = 'day'
  ): Promise<
    Array<{
      period: string;
      total_runs: number;
      success_rate: number;
      avg_duration_ms: number;
      total_alerts: number;
      total_errors: number;
    }>
  > {
    const groupExpr = groupBy === 'hour'
      ? "strftime('%Y-%m-%d %H:00:00', started_at)"
      : "strftime('%Y-%m-%d', started_at)";

    const result = await this.db
      .prepare(`
        SELECT
          ${groupExpr} as period,
          COUNT(*) as total_runs,
          AVG(CASE WHEN status = 'completed' THEN 1.0 ELSE 0.0 END) * 100 as success_rate,
          AVG(duration_ms) as avg_duration_ms,
          SUM(alerts_triggered) as total_alerts,
          SUM(errors_count) as total_errors
        FROM evaluation_runs
        WHERE started_at >= ?
        GROUP BY ${groupExpr}
        ORDER BY period DESC
      `)
      .bind(since.toISOString())
      .all<{
        period: string;
        total_runs: number;
        success_rate: number;
        avg_duration_ms: number | null;
        total_alerts: number;
        total_errors: number;
      }>();

    return result.results.map(row => ({
      period: row.period,
      total_runs: row.total_runs,
      success_rate: Math.round(row.success_rate * 100) / 100,
      avg_duration_ms: row.avg_duration_ms || 0,
      total_alerts: row.total_alerts,
      total_errors: row.total_errors,
    }));
  }

  // ============================================================================
  // Rule Evaluation History
  // ============================================================================

  async recordRuleEvaluation(input: CreateRuleEvaluationInput): Promise<void> {
    const id = `hist_${crypto.randomUUID()}`;
    const evaluatedAt = new Date().toISOString();

    await this.db
      .prepare(`
        INSERT INTO rule_evaluation_history (
          id, evaluation_run_id, rule_id, rule_name, metric_name,
          metric_value, baseline_value, threshold_type, threshold_value,
          triggered, evaluation_time_ms, error_message, error_type, evaluated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        input.evaluation_run_id,
        input.rule_id,
        input.rule_name,
        input.metric_name,
        input.metric_value ?? null,
        input.baseline_value ?? null,
        input.threshold_type ?? null,
        input.threshold_value ?? null,
        input.triggered ? 1 : 0,
        input.evaluation_time_ms ?? null,
        input.error?.message ?? null,
        input.error?.type ?? null,
        evaluatedAt
      )
      .run();
  }

  async getRuleHistory(
    ruleId: string,
    limit: number = 100,
    since?: Date
  ): Promise<RuleEvaluationHistory[]> {
    let query = `
      SELECT * FROM rule_evaluation_history
      WHERE rule_id = ?
    `;
    const params: unknown[] = [ruleId];

    if (since) {
      query += ' AND evaluated_at >= ?';
      params.push(since.toISOString());
    }

    query += ' ORDER BY evaluated_at DESC LIMIT ?';
    params.push(limit);

    const result = await this.db.prepare(query).bind(...params).all<DatabaseHistoryRow>();

    return result.results.map(row => this.normalizeHistory(row));
  }

  async getRuleStats(ruleId?: string, days: number = 7): Promise<RuleStats[]> {
    const ruleFilter = ruleId ? 'WHERE reh.rule_id = ?' : '';
    const params: unknown[] = [days];
    if (ruleId) params.push(ruleId);

    const result = await this.db
      .prepare(`
        SELECT
          reh.rule_id,
          reh.rule_name,
          COUNT(*) as total_evaluations,
          SUM(CASE WHEN reh.triggered = 1 THEN 1 ELSE 0 END) as total_triggers,
          AVG(reh.evaluation_time_ms) as avg_evaluation_time_ms,
          MAX(reh.evaluated_at) as last_evaluated,
          MAX(CASE WHEN reh.triggered = 1 THEN reh.evaluated_at END) as last_triggered,
          SUM(CASE WHEN reh.error_message IS NOT NULL THEN 1 ELSE 0 END) as error_count
        FROM rule_evaluation_history reh
        ${ruleFilter}
        WHERE reh.evaluated_at >= datetime('now', '-' || ? || ' days')
        GROUP BY reh.rule_id, reh.rule_name
        ORDER BY total_evaluations DESC
      `)
      .bind(...params)
      .all<{
        rule_id: string;
        rule_name: string;
        total_evaluations: number;
        total_triggers: number;
        avg_evaluation_time_ms: number | null;
        last_evaluated: string | null;
        last_triggered: string | null;
        error_count: number;
      }>();

    return result.results.map(row => ({
      rule_id: row.rule_id,
      rule_name: row.rule_name,
      total_evaluations: row.total_evaluations,
      total_triggers: row.total_triggers,
      trigger_rate_percent: row.total_evaluations > 0
        ? Math.round((row.total_triggers / row.total_evaluations) * 10000) / 100
        : 0,
      avg_evaluation_time_ms: row.avg_evaluation_time_ms || 0,
      last_evaluated: row.last_evaluated,
      last_triggered: row.last_triggered,
      error_count: row.error_count,
    }));
  }

  // ============================================================================
  // Evaluation Errors
  // ============================================================================

  async recordError(input: CreateEvaluationErrorInput): Promise<void> {
    const id = `err_${crypto.randomUUID()}`;
    const occurredAt = input.occurred_at?.toISOString() || new Date().toISOString();

    await this.db
      .prepare(`
        INSERT INTO evaluation_errors (
          id, evaluation_run_id, rule_id, error_type, error_message,
          stack_trace, context, is_transient, retry_attempts, occurred_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        input.evaluation_run_id ?? null,
        input.rule_id ?? null,
        input.error_type,
        input.error_message,
        input.stack_trace ?? null,
        JSON.stringify(input.context || {}),
        input.is_transient ? 1 : 0,
        input.retry_attempts || 0,
        occurredAt
      )
      .run();
  }

  async getErrors(
    since?: Date,
    ruleId?: string,
    errorType?: string,
    limit: number = 100
  ): Promise<EvaluationError[]> {
    let query = 'SELECT * FROM evaluation_errors WHERE 1=1';
    const params: unknown[] = [];

    if (since) {
      query += ' AND occurred_at >= ?';
      params.push(since.toISOString());
    }
    if (ruleId) {
      query += ' AND rule_id = ?';
      params.push(ruleId);
    }
    if (errorType) {
      query += ' AND error_type = ?';
      params.push(errorType);
    }

    query += ' ORDER BY occurred_at DESC LIMIT ?';
    params.push(limit);

    const result = await this.db.prepare(query).bind(...params).all<DatabaseErrorRow>();

    return result.results.map(row => this.normalizeError(row));
  }

  async getErrorStats(since: Date = new Date(Date.now() - 24 * 60 * 60 * 1000)): Promise<{
    total: number;
    by_type: Record<string, number>;
    by_rule: Record<string, number>;
    transient_count: number;
    permanent_count: number;
  }> {
    const [
      total,
      byType,
      byRule,
      transientCount,
    ] = await Promise.all([
      this.db
        .prepare('SELECT COUNT(*) as count FROM evaluation_errors WHERE occurred_at >= ?')
        .bind(since.toISOString())
        .first<{ count: number }>(),
      this.db
        .prepare(`
          SELECT error_type, COUNT(*) as count
          FROM evaluation_errors
          WHERE occurred_at >= ?
          GROUP BY error_type
        `)
        .bind(since.toISOString())
        .all<{ error_type: string; count: number }>(),
      this.db
        .prepare(`
          SELECT rule_id, COUNT(*) as count
          FROM evaluation_errors
          WHERE occurred_at >= ? AND rule_id IS NOT NULL
          GROUP BY rule_id
          ORDER BY count DESC
        `)
        .bind(since.toISOString())
        .all<{ rule_id: string; count: number }>(),
      this.db
        .prepare(`
          SELECT COUNT(*) as count FROM evaluation_errors
          WHERE occurred_at >= ? AND is_transient = 1
        `)
        .bind(since.toISOString())
        .first<{ count: number }>(),
    ]);

    return {
      total: total?.count || 0,
      by_type: byType.results.reduce((acc, row) => {
        acc[row.error_type] = row.count;
        return acc;
      }, {} as Record<string, number>),
      by_rule: byRule.results.reduce((acc, row) => {
        acc[row.rule_id] = row.count;
        return acc;
      }, {} as Record<string, number>),
      transient_count: transientCount?.count || 0,
      permanent_count: (total?.count || 0) - (transientCount?.count || 0),
    };
  }

  // ============================================================================
  // Circuit Breaker State
  // ============================================================================

  async getCircuitBreaker(name: string): Promise<CircuitBreakerEntry | null> {
    const result = await this.db
      .prepare('SELECT * FROM circuit_breaker_state WHERE name = ?')
      .bind(name)
      .first<DatabaseCircuitBreakerRow>();

    return result ? this.normalizeCircuitBreaker(result) : null;
  }

  async upsertCircuitBreaker(
    name: string,
    updates: UpdateCircuitBreakerInput
  ): Promise<CircuitBreakerEntry | null> {
    const existing = await this.getCircuitBreaker(name);

    if (existing) {
      const fields: string[] = [];
      const values: unknown[] = [];

      if (updates.state !== undefined) {
        fields.push('state = ?');
        values.push(updates.state);
      }
      if (updates.failure_count !== undefined) {
        fields.push('failure_count = ?');
        values.push(updates.failure_count);
      }
      if (updates.last_failure_at !== undefined) {
        fields.push('last_failure_at = ?');
        values.push(updates.last_failure_at?.toISOString() || null);
      }
      if (updates.last_success_at !== undefined) {
        fields.push('last_success_at = ?');
        values.push(updates.last_success_at?.toISOString() || null);
      }
      if (updates.next_attempt_at !== undefined) {
        fields.push('next_attempt_at = ?');
        values.push(updates.next_attempt_at?.toISOString() || null);
      }

      values.push(name);

      await this.db
        .prepare(`UPDATE circuit_breaker_state SET ${fields.join(', ')} WHERE name = ?`)
        .bind(...values)
        .run();
    } else {
      // Create new with defaults if config exists
      await this.db
        .prepare(`
          INSERT INTO circuit_breaker_state (name, state, failure_count, metadata)
          VALUES (?, 'closed', 0, '{}')
        `)
        .bind(name)
        .run();
    }

    return this.getCircuitBreaker(name);
  }

  async recordCircuitBreakerSuccess(name: string): Promise<void> {
    await this.upsertCircuitBreaker(name, {
      state: 'closed',
      failure_count: 0,
      last_success_at: new Date(),
      next_attempt_at: null,
    });
  }

  async recordCircuitBreakerFailure(
    name: string,
    increment: number = 1,
    shouldOpen: boolean = false
  ): Promise<void> {
    const existing = await this.getCircuitBreaker(name);
    const newFailureCount = (existing?.failure_count || 0) + increment;

    const updates: UpdateCircuitBreakerInput = {
      failure_count: newFailureCount,
      last_failure_at: new Date(),
    };

    if (shouldOpen || newFailureCount >= (existing?.failure_threshold || 5)) {
      updates.state = 'open';
      const timeoutMs = (existing?.timeout_seconds || 60) * 1000;
      updates.next_attempt_at = new Date(Date.now() + timeoutMs);
    }

    await this.upsertCircuitBreaker(name, updates);
  }

  async getAllCircuitBreakers(): Promise<CircuitBreakerEntry[]> {
    const result = await this.db
      .prepare('SELECT * FROM circuit_breaker_state ORDER BY name')
      .all<DatabaseCircuitBreakerRow>();

    return result.results.map(row => this.normalizeCircuitBreaker(row));
  }

  async resetCircuitBreaker(name: string): Promise<void> {
    await this.upsertCircuitBreaker(name, {
      state: 'closed',
      failure_count: 0,
      next_attempt_at: null,
    });
  }

  // ============================================================================
  // Alert Engine Metrics
  // ============================================================================

  async recordMetrics(input: RecordMetricsInput): Promise<void> {
    const id = `metric_${crypto.randomUUID()}`;
    const timestamp = new Date().toISOString();

    await this.db
      .prepare(`
        INSERT INTO alert_engine_metrics (
          id, timestamp, evaluation_run_id,
          total_evaluation_time_ms, avg_rule_evaluation_time_ms,
          slowest_rule_evaluation_ms, fastest_rule_evaluation_ms,
          rules_checked, rules_passed, rules_failed, alerts_generated,
          metrics_api_latency_ms, database_latency_ms, cache_hit_rate,
          memory_usage_mb, concurrent_evaluations
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(
        id,
        timestamp,
        input.evaluation_run_id ?? null,
        input.total_evaluation_time_ms ?? null,
        input.avg_rule_evaluation_time_ms ?? null,
        input.slowest_rule_evaluation_ms ?? null,
        input.fastest_rule_evaluation_ms ?? null,
        input.rules_checked ?? null,
        input.rules_passed ?? null,
        input.rules_failed ?? null,
        input.alerts_generated ?? null,
        input.metrics_api_latency_ms ?? null,
        input.database_latency_ms ?? null,
        input.cache_hit_rate ?? null,
        input.memory_usage_mb ?? null,
        input.concurrent_evaluations ?? null
      )
      .run();
  }

  async getEngineMetrics(
    since: Date,
    groupBy: 'hour' | 'day' = 'hour'
  ): Promise<AlertEngineMetrics[]> {
    const groupExpr = groupBy === 'hour'
      ? "strftime('%Y-%m-%d %H:00:00', timestamp)"
      : "strftime('%Y-%m-%d', timestamp)";

    const result = await this.db
      .prepare(`
        SELECT
          ${groupExpr} as period,
          AVG(total_evaluation_time_ms) as total_evaluation_time_ms,
          AVG(avg_rule_evaluation_time_ms) as avg_rule_evaluation_time_ms,
          MAX(slowest_rule_evaluation_ms) as slowest_rule_evaluation_ms,
          MIN(fastest_rule_evaluation_ms) as fastest_rule_evaluation_ms,
          AVG(rules_checked) as rules_checked,
          AVG(rules_passed) as rules_passed,
          AVG(rules_failed) as rules_failed,
          SUM(alerts_generated) as alerts_generated,
          AVG(metrics_api_latency_ms) as metrics_api_latency_ms,
          AVG(database_latency_ms) as database_latency_ms,
          AVG(cache_hit_rate) as cache_hit_rate,
          AVG(memory_usage_mb) as memory_usage_mb,
          AVG(concurrent_evaluations) as concurrent_evaluations
        FROM alert_engine_metrics
        WHERE timestamp >= ?
        GROUP BY ${groupExpr}
        ORDER BY period DESC
      `)
      .bind(since.toISOString())
      .all<{
        period: string;
        total_evaluation_time_ms: number | null;
        avg_rule_evaluation_time_ms: number | null;
        slowest_rule_evaluation_ms: number | null;
        fastest_rule_evaluation_ms: number | null;
        rules_checked: number | null;
        rules_passed: number | null;
        rules_failed: number | null;
        alerts_generated: number | null;
        metrics_api_latency_ms: number | null;
        database_latency_ms: number | null;
        cache_hit_rate: number | null;
        memory_usage_mb: number | null;
        concurrent_evaluations: number | null;
      }>();

    return result.results.map(row => ({
      id: `agg_${crypto.randomUUID()}`, // Generated ID for typed result
      timestamp: row.period,
      evaluation_run_id: null,
      total_evaluation_time_ms: row.total_evaluation_time_ms || null,
      avg_rule_evaluation_time_ms: row.avg_rule_evaluation_time_ms || null,
      slowest_rule_evaluation_ms: row.slowest_rule_evaluation_ms || null,
      fastest_rule_evaluation_ms: row.fastest_rule_evaluation_ms || null,
      rules_checked: Math.round(row.rules_checked || 0),
      rules_passed: Math.round(row.rules_passed || 0),
      rules_failed: Math.round(row.rules_failed || 0),
      alerts_generated: row.alerts_generated || 0,
      metrics_api_latency_ms: row.metrics_api_latency_ms || null,
      database_latency_ms: row.database_latency_ms || null,
      cache_hit_rate: row.cache_hit_rate || null,
      memory_usage_mb: row.memory_usage_mb || null,
      concurrent_evaluations: Math.round(row.concurrent_evaluations || 0),
    }));
  }

  async getLatestMetrics(limit: number = 10): Promise<AlertEngineMetrics[]> {
    const result = await this.db
      .prepare(`
        SELECT * FROM alert_engine_metrics
        ORDER BY timestamp DESC
        LIMIT ?
      `)
      .bind(limit)
      .all<DatabaseMetricsRow>();

    return result.results.map(row => this.normalizeMetrics(row));
  }

  // ============================================================================
  // Cleanup and Maintenance
  // ============================================================================

  async cleanupOldData(retentionDays: number = 90): Promise<{
    runsDeleted: number;
    errorsDeleted: number;
    historyDeleted: number;
    metricsDeleted: number;
  }> {
    const cutoffDate = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const cutoffStr = cutoffDate.toISOString();

    const [runsResult, errorsResult, historyResult, metricsResult] = await Promise.all([
      this.db
        .prepare('DELETE FROM evaluation_runs WHERE started_at < ?')
        .bind(cutoffStr)
        .run(),
      this.db
        .prepare('DELETE FROM evaluation_errors WHERE occurred_at < ?')
        .bind(cutoffStr)
        .run(),
      this.db
        .prepare('DELETE FROM rule_evaluation_history WHERE evaluated_at < ?')
        .bind(cutoffStr)
        .run(),
      this.db
        .prepare('DELETE FROM alert_engine_metrics WHERE timestamp < ?')
        .bind(cutoffStr)
        .run(),
    ]);

    return {
      runsDeleted: runsResult.meta.changes || 0,
      errorsDeleted: errorsResult.meta.changes || 0,
      historyDeleted: historyResult.meta.changes || 0,
      metricsDeleted: metricsResult.meta.changes || 0,
    };
  }

  // ============================================================================
  // Evaluation Statistics
  // ============================================================================

  async getEvaluationStats(since: Date = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)): Promise<EvaluationStats> {
    const [
      runs,
      successRuns,
      failedRuns,
      avgDuration,
      alertsGen,
      rulesCount,
    ] = await Promise.all([
      this.db
        .prepare('SELECT COUNT(*) as count FROM evaluation_runs WHERE started_at >= ?')
        .bind(since.toISOString())
        .first<{ count: number }>(),
      this.db
        .prepare("SELECT COUNT(*) as count FROM evaluation_runs WHERE started_at >= ? AND status = 'completed'")
        .bind(since.toISOString())
        .first<{ count: number }>(),
      this.db
        .prepare("SELECT COUNT(*) as count FROM evaluation_runs WHERE started_at >= ? AND status IN ('failed', 'partial_failure')")
        .bind(since.toISOString())
        .first<{ count: number }>(),
      this.db
        .prepare('SELECT AVG(duration_ms) as avg_duration FROM evaluation_runs WHERE started_at >= ? AND duration_ms IS NOT NULL')
        .bind(since.toISOString())
        .first<{ avg_duration: number | null }>(),
      this.db
        .prepare('SELECT SUM(alerts_triggered) as total FROM evaluation_runs WHERE started_at >= ?')
        .bind(since.toISOString())
        .first<{ total: number | null }>(),
      this.db
        .prepare('SELECT COUNT(DISTINCT rule_id) as count FROM rule_evaluation_history WHERE evaluated_at >= ?')
        .bind(since.toISOString())
        .first<{ count: number }>(),
    ]);

    const byRule = await this.getRuleStats(undefined, Math.ceil((Date.now() - since.getTime()) / (24 * 60 * 60 * 1000)));

    return {
      period_start: since,
      period_end: new Date(),
      total_runs: runs?.count || 0,
      successful_runs: successRuns?.count || 0,
      failed_runs: failedRuns?.count || 0,
      avg_run_duration_ms: avgDuration?.avg_duration || 0,
      total_alerts_generated: alertsGen?.total || 0,
      rules_evaluated_count: rulesCount?.count || 0,
      error_rate_percent: runs?.count && runs.count > 0
        ? Math.round(((failedRuns?.count || 0) / runs.count) * 10000) / 100
        : 0,
      by_rule: byRule.map(rule => ({
        rule_id: rule.rule_id,
        rule_name: rule.rule_name,
        evaluations: rule.total_evaluations,
        triggers: rule.total_triggers,
        avg_evaluation_time_ms: rule.avg_evaluation_time_ms,
        error_count: rule.error_count,
      })),
    };
  }

  // ============================================================================
  // Helper Methods
  // ============================================================================

  private normalizeRun(row: DatabaseRunRow): EvaluationRun {
    return {
      id: row.id,
      started_at: row.started_at,
      completed_at: row.completed_at,
      duration_ms: row.duration_ms ?? null,
      status: row.status as EvaluationRun['status'],
      rules_evaluated: row.rules_evaluated,
      alerts_triggered: row.alerts_triggered,
      errors_count: row.errors_count,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      created_at: row.created_at,
    };
  }

  private normalizeHistory(row: DatabaseHistoryRow): RuleEvaluationHistory {
    return {
      id: row.id,
      evaluation_run_id: row.evaluation_run_id,
      rule_id: row.rule_id,
      rule_name: row.rule_name,
      metric_name: row.metric_name,
      metric_value: row.metric_value ?? null,
      baseline_value: row.baseline_value ?? null,
      threshold_type: row.threshold_type ?? null,
      threshold_value: row.threshold_value ?? null,
      triggered: row.triggered ? 1 : 0,
      evaluation_time_ms: row.evaluation_time_ms ?? null,
      error_message: row.error_message ?? null,
      error_type: row.error_type ?? null,
      evaluated_at: row.evaluated_at,
    };
  }

  private normalizeError(row: DatabaseErrorRow): EvaluationError {
    let context: Record<string, unknown> = {};
    try {
      context = row.context ? JSON.parse(row.context) : {};
    } catch {
      context = {};
    }

    return {
      id: row.id,
      evaluation_run_id: row.evaluation_run_id,
      rule_id: row.rule_id,
      error_type: row.error_type,
      error_message: row.error_message,
      stack_trace: row.stack_trace ?? null,
      context,
      is_transient: row.is_transient ? 1 : 0,
      retry_attempts: row.retry_attempts,
      occurred_at: row.occurred_at,
    };
  }

  private normalizeCircuitBreaker(row: DatabaseCircuitBreakerRow): CircuitBreakerEntry {
    return {
      id: row.id,
      name: row.name,
      state: row.state as CircuitBreakerEntry['state'],
      failure_count: row.failure_count,
      last_failure_at: row.last_failure_at,
      last_success_at: row.last_success_at,
      next_attempt_at: row.next_attempt_at,
      failure_threshold: row.failure_threshold,
      timeout_seconds: row.timeout_seconds,
      metadata: row.metadata ? JSON.parse(row.metadata) : {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  private normalizeMetrics(row: DatabaseMetricsRow): AlertEngineMetrics {
    return {
      id: row.id,
      timestamp: row.timestamp,
      evaluation_run_id: row.evaluation_run_id,
      total_evaluation_time_ms: row.total_evaluation_time_ms ?? null,
      avg_rule_evaluation_time_ms: row.avg_rule_evaluation_time_ms ?? null,
      slowest_rule_evaluation_ms: row.slowest_rule_evaluation_ms ?? null,
      fastest_rule_evaluation_ms: row.fastest_rule_evaluation_ms ?? null,
      rules_checked: row.rules_checked ?? null,
      rules_passed: row.rules_passed ?? null,
      rules_failed: row.rules_failed ?? null,
      alerts_generated: row.alerts_generated ?? null,
      metrics_api_latency_ms: row.metrics_api_latency_ms ?? null,
      database_latency_ms: row.database_latency_ms ?? null,
      cache_hit_rate: row.cache_hit_rate ?? null,
      memory_usage_mb: row.memory_usage_mb ?? null,
      concurrent_evaluations: row.concurrent_evaluations ?? null,
    };
  }
}

// Database row interfaces for type-safe queries
interface DatabaseRunRow {
  id: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: string;
  rules_evaluated: number;
  alerts_triggered: number;
  errors_count: number;
  metadata: string;
  created_at: string;
}

interface DatabaseHistoryRow {
  id: string;
  evaluation_run_id: string;
  rule_id: string;
  rule_name: string;
  metric_name: string;
  metric_value: number | null;
  baseline_value: number | null;
  threshold_type: string | null;
  threshold_value: number | null;
  triggered: number;
  evaluation_time_ms: number | null;
  error_message: string | null;
  error_type: string | null;
  evaluated_at: string;
}

interface DatabaseErrorRow {
  id: string;
  evaluation_run_id: string | null;
  rule_id: string | null;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  context: string;
  is_transient: number;
  retry_attempts: number;
  occurred_at: string;
}

interface DatabaseCircuitBreakerRow {
  id: string;
  name: string;
  state: string;
  failure_count: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  next_attempt_at: string | null;
  failure_threshold: number;
  timeout_seconds: number;
  metadata: string;
  created_at: string;
  updated_at: string;
}

interface DatabaseMetricsRow {
  id: string;
  timestamp: string;
  evaluation_run_id: string | null;
  total_evaluation_time_ms: number | null;
  avg_rule_evaluation_time_ms: number | null;
  slowest_rule_evaluation_ms: number | null;
  fastest_rule_evaluation_ms: number | null;
  rules_checked: number | null;
  rules_passed: number | null;
  rules_failed: number | null;
  alerts_generated: number | null;
  metrics_api_latency_ms: number | null;
  database_latency_ms: number | null;
  cache_hit_rate: number | null;
  memory_usage_mb: number | null;
  concurrent_evaluations: number | null;
}

// ============================================================================
// Factory Function
// ============================================================================

let globalEvaluationStorage: EvaluationStateStorage | null = null;

export function getEvaluationStateStorage(db: D1Database): EvaluationStateStorage {
  if (!globalEvaluationStorage) {
    globalEvaluationStorage = new EvaluationStateStorage(db);
  }
  return globalEvaluationStorage;
}
