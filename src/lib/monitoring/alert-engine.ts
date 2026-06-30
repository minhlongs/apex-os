/**
 * Alert Engine - Unified Metrics Alerting System
 *
 * Evaluates metrics against thresholds every 5 minutes and triggers alerts
 * via multiple channels (email, webhook, Slack).
 *
 * Deployment options:
 * 1. Cloudflare Workers Cron: Add cron expression to wrangler.toml
 * 2. External service: Call /api/monitoring/alert-engine endpoint
 */

import { randomUUID } from 'crypto';
import type { D1Database } from '@/types/d1';
import { getAlertStorage } from '@/lib/alerts';
import type { CreateAlertInput } from '@/lib/alerts';
import { withRetry, DEFAULT_RETRY_CONFIG } from '@/lib/notifications/retry';
import { fetchBusinessMetricsSnapshot } from '@/lib/metrics/business-metrics-fetcher';
import { getDispatcher, NotificationDispatcher, DispatchJob } from './dispatcher';
import { getEvaluationStateStorage, EvaluationStateStorage } from './evaluation-state-storage';
import { getCircuitBreaker, CircuitBreaker } from './circuit-breaker';
import type {
  EvaluationRun,
  RuleEvaluationHistory,
  CreateRuleEvaluationInput,
  CreateEvaluationErrorInput,
  EvaluationStats,
} from '@/types/evaluation-state';

// ============================================================================
// Types
// ============================================================================

export type MetricSource = 'business' | 'd1' | 'custom';
export type AlertChannel = 'email' | 'webhook' | 'slack' | 'console';
export type AlertSeverity = 'info' | 'warning' | 'critical';

export interface AlertRule {
  id: string;
  name: string;
  description?: string;
  source: MetricSource;
  metric: string;
  thresholdType: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'drop_pct';
  thresholdValue: number;
  evaluationWindowMinutes: number;
  severity: AlertSeverity;
  channels: AlertChannel[];
  cooldownMinutes: number;
  isEnabled: boolean;
  filters?: AlertFilters;
  // Optional baseline period for drop_pct comparisons (in days)
  baselinePeriodDays?: number;
}

export interface AlertFilters {
  deal_type?: string;
  exchange?: string;
  status?: string;
  affiliate_id?: string;
}

export interface AlertContext {
  rule: AlertRule;
  currentValue: number;
  thresholdValue: number;
  snapshot: Record<string, unknown>;
  triggeredAt: Date;
}

export interface AlertResult {
  id: string;
  ruleId: string;
  ruleName: string;
  severity: AlertSeverity;
  metric: string;
  currentValue: number;
  thresholdValue: number;
  triggeredAt: Date;
  channels: AlertChannel[];
  details: Record<string, unknown>;
  status: 'triggered' | 'sent' | 'failed';
}

export interface AlertEngineConfig {
  enabled: boolean;
  evaluationIntervalMinutes: number;
  maxAlertsPerRun: number;
  persistAlerts: boolean;
  persistEvaluationState: boolean;
  circuitBreakerEnabled: boolean;
  collectMetrics: boolean;
}

// ============================================================================
// Default Alert Rules
// ============================================================================

export const DEFAULT_BUSINESS_ALERT_RULES: AlertRule[] = [
  {
    id: 'biz-revenue-drop-pct',
    name: 'Revenue Drop Percentage Alert',
    description: 'Triggers when daily revenue drops by more than 50% compared to 7-day average',
    source: 'business',
    metric: 'daily_revenue',
    thresholdType: 'drop_pct',
    thresholdValue: 50,
    evaluationWindowMinutes: 120,
    severity: 'critical',
    channels: ['email', 'webhook'],
    cooldownMinutes: 60,
    isEnabled: true,
    filters: { status: 'approved' },
    baselinePeriodDays: 7,
  },
  {
    id: 'biz-revenue-low',
    name: 'Low Revenue Alert',
    description: 'Triggers when daily revenue falls below $100',
    source: 'business',
    metric: 'daily_revenue',
    thresholdType: 'lt',
    thresholdValue: 100,
    evaluationWindowMinutes: 120,
    severity: 'warning',
    channels: ['email', 'webhook'],
    cooldownMinutes: 60,
    isEnabled: true,
    filters: { status: 'approved' },
  },
  {
    id: 'biz-conversion-rate-low',
    name: 'Low Conversion Rate Alert',
    description: 'Triggers when conversion rate drops below 2%',
    source: 'business',
    metric: 'conversion_rate',
    thresholdType: 'lt',
    thresholdValue: 2.0,
    evaluationWindowMinutes: 120,
    severity: 'warning',
    channels: ['email'],
    cooldownMinutes: 60,
    isEnabled: true,
  },
  {
    id: 'biz-conversion-rate-drop-pct',
    name: 'Conversion Rate Drop Alert',
    description: 'Triggers when conversion rate drops by more than 30% compared to 7-day average',
    source: 'business',
    metric: 'conversion_rate',
    thresholdType: 'drop_pct',
    thresholdValue: 30,
    evaluationWindowMinutes: 120,
    severity: 'warning',
    channels: ['email'],
    cooldownMinutes: 60,
    isEnabled: false, // Disabled by default
    baselinePeriodDays: 7,
  },
  {
    id: 'biz-zero-conversions',
    name: 'No Conversions Alert',
    description: 'Triggers when no conversions detected for 24 hours',
    source: 'business',
    metric: 'total_conversions',
    thresholdType: 'eq',
    thresholdValue: 0,
    evaluationWindowMinutes: 1440, // 24 hours
    severity: 'critical',
    channels: ['email', 'webhook'],
    cooldownMinutes: 180,
    isEnabled: true,
  },
  {
    id: 'biz-high-commission-liability',
    name: 'High Commission Liability Alert',
    description: 'Triggers when pending commission liability exceeds $10,000',
    source: 'business',
    metric: 'pending_commission',
    thresholdType: 'gte',
    thresholdValue: 10000,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    channels: ['email', 'webhook'],
    cooldownMinutes: 60,
    isEnabled: true,
  },
  {
    id: 'biz-high-webhook-failures',
    name: 'High Webhook Failure Rate',
    description: 'Triggers when webhook failure rate exceeds 10% in evaluation window',
    source: 'business',
    metric: 'webhook_failures',
    thresholdType: 'gt',
    thresholdValue: 10,
    evaluationWindowMinutes: 60,
    severity: 'critical',
    channels: ['email', 'slack'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'biz-high-payout-failures',
    name: 'High Payout Failure Rate',
    description: 'Triggers when payout failure rate exceeds 5%',
    source: 'business',
    metric: 'payout_failures',
    thresholdType: 'gte',
    thresholdValue: 5,
    evaluationWindowMinutes: 120,
    severity: 'critical',
    channels: ['email', 'slack'],
    cooldownMinutes: 30,
    isEnabled: true,
  },
  {
    id: 'biz-low-stellar-balance',
    name: 'Low Stellar USDC Balance',
    description: 'Triggers when Stellar wallet balance falls below 100 USDC',
    source: 'business',
    metric: 'stellar_balance',
    thresholdType: 'lt',
    thresholdValue: 100,
    evaluationWindowMinutes: 60,
    severity: 'critical',
    channels: ['email', 'slack'],
    cooldownMinutes: 120,
    isEnabled: true,
  },
];

export const DEFAULT_D1_ALERT_RULES: AlertRule[] = [
  {
    id: 'd1-slow-query',
    name: 'Slow Query Alert',
    description: 'Triggers when average query duration exceeds 1 second',
    source: 'd1',
    metric: 'avg_query_duration_ms',
    thresholdType: 'gt',
    thresholdValue: 1000,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    channels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'd1-storage-critical',
    name: 'High Storage Usage',
    description: 'Triggers when storage usage exceeds 80% of quota',
    source: 'd1',
    metric: 'storage_usage_percent',
    thresholdType: 'gte',
    thresholdValue: 80,
    evaluationWindowMinutes: 60,
    severity: 'critical',
    channels: ['email', 'webhook'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'd1-excessive-slow-queries',
    name: 'Excessive Slow Queries',
    description: 'Triggers when more than 10 slow queries in evaluation window',
    source: 'd1',
    metric: 'slow_query_count',
    thresholdType: 'gt',
    thresholdValue: 10,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    channels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
  {
    id: 'd1-high-rows-scanned',
    name: 'High Row Scan Count',
    description: 'Triggers when average rows scanned per query exceeds 10000',
    source: 'd1',
    metric: 'avg_rows_scanned',
    thresholdType: 'gt',
    thresholdValue: 10000,
    evaluationWindowMinutes: 60,
    severity: 'warning',
    channels: ['email'],
    cooldownMinutes: 15,
    isEnabled: true,
  },
];

export const ALL_DEFAULT_RULES: AlertRule[] = [
  ...DEFAULT_BUSINESS_ALERT_RULES,
  ...DEFAULT_D1_ALERT_RULES,
];

// ============================================================================
// Alert Engine Core
// ============================================================================

export class AlertEngine {
  private config: AlertEngineConfig;
  private db: D1Database | null = null;
  private alertStorage: ReturnType<typeof getAlertStorage> | null = null;
  private evaluationStorage: EvaluationStateStorage | null = null;
  private rules: AlertRule[] = [];
  private lastRun: Date | null = null;
  private dispatcher: NotificationDispatcher | null = null;
  private circuitBreakers: Map<string, CircuitBreaker> = new Map();
  private currentRunId: string | null = null;
  private evaluationStartTime: number = 0;

  constructor(config: Partial<AlertEngineConfig> = {}) {
    this.config = {
      enabled: true,
      evaluationIntervalMinutes: 5,
      maxAlertsPerRun: 100,
      persistAlerts: true,
      persistEvaluationState: true,
      circuitBreakerEnabled: true,
      collectMetrics: true,
      ...config,
    };
  }

  /**
   * Initialize the alert engine with database connection
   */
  async initialize(db: D1Database): Promise<void> {
    this.db = db;
    this.alertStorage = getAlertStorage(db);
    this.evaluationStorage = getEvaluationStateStorage(db);
    await this.loadRulesFromDatabase();

    // Initialize dispatcher with required configuration
    this.dispatcher = getDispatcher({
      batchSize: 10,
      concurrency: 3,
      timeoutMs: 30000,
      maxRetries: 3,
      enabledChannels: ['email', 'slack', 'telegram', 'webhook'],
    });

    // Initialize circuit breakers if enabled
    if (this.config.circuitBreakerEnabled) {
      await this.initializeCircuitBreakers();
    }

    console.log('[AlertEngine] Initialized with notification dispatcher and evaluation state storage');
  }

  /**
   * Initialize circuit breakers for external service protection
   */
  private async initializeCircuitBreakers(): Promise<void> {
    const breakerNames = ['metrics-api', 'notification-email', 'notification-slack', 'notification-webhook'];

    for (const name of breakerNames) {
      const breaker = getCircuitBreaker(name, {}, this.db);
      await breaker.initialize(this.db);
      this.circuitBreakers.set(name, breaker);
    }

    console.log('[AlertEngine] Circuit breakers initialized');
  }

  /**
   * Load alert rules from database (with fallback to defaults)
   */
  private async loadRulesFromDatabase(): Promise<void> {
    if (!this.db) return;

    try {
      const result = await this.db
        .prepare('SELECT * FROM alert_rules WHERE is_enabled = 1')
        .all<AlertRule & { id: string; alert_channels: string }>();

      if (result.results.length > 0) {
        this.rules = result.results.map(row => ({
          ...row,
          channels: JSON.parse(row.alert_channels || '[]'),
        }));
      } else {
        // No custom rules, use defaults
        this.rules = ALL_DEFAULT_RULES;
      }
    } catch (error) {
      console.warn('Failed to load rules from database, using defaults:', error);
      this.rules = ALL_DEFAULT_RULES;
    }
  }

  /**
   * Run a complete alert evaluation cycle
   * Enhanced with state persistence, circuit breakers, and comprehensive error handling
   */
  async runCycle(): Promise<AlertResult[]> {
    if (!this.config.enabled) return [];
    if (!this.db || !this.evaluationStorage) throw new Error('AlertEngine not initialized with database');

    this.lastRun = new Date();
    this.evaluationStartTime = Date.now();

    // Start evaluation run tracking
    const runId = this.config.persistEvaluationState
      ? await this.evaluationStorage.createRun({ started_at: new Date() })
      : `run_${crypto.randomUUID()}`;

    this.currentRunId = runId;

    const results: AlertResult[] = [];
    let rulesEvaluated = 0;
    let rulesFailed = 0;
    const evaluationTimes: number[] = [];
    const errors: CreateEvaluationErrorInput[] = [];

    // Check if metrics API circuit breaker is closed
    const metricsBreaker = this.circuitBreakers.get('metrics-api');
    if (metricsBreaker && !(await metricsBreaker.isAvailable())) {
      console.warn('[AlertEngine] Metrics API circuit breaker is OPEN - skipping evaluation cycle');
      await this.recordEvaluationError({
        error_type: 'circuit_breaker_open',
        error_message: 'Metrics API circuit breaker is OPEN - evaluation skipped',
        context: { component: 'metrics-api' },
        is_transient: true,
        evaluation_run_id: runId,
      });
      await this.completeEvaluationRun(runId, 0, 0, 1, evaluationTimes, errors);
      return [];
    }

    try {
      for (const rule of this.rules) {
        if (!rule.isEnabled) continue;
        if (results.length >= this.config.maxAlertsPerRun) break;

        const ruleStartTime = Date.now();
        let ruleError: CreateEvaluationErrorInput | undefined;

        try {
          // Evaluate rule (with internal circuit breaker protection)
          const alert = await this.evaluateRule(rule);

          if (alert) {
            results.push(alert);
            await this.sendAlert(alert);
            alert.status = 'sent';
          }
        } catch (error: any) {
          rulesFailed++;
          const errorMessage = error?.message || String(error);
          console.error(`Failed to evaluate rule ${rule.id}:`, error);

          ruleError = {
            rule_id: rule.id,
            error_type: this.classifyError(error),
            error_message: errorMessage,
            stack_trace: error.stack,
            context: { rule_id: rule.id, rule_name: rule.name },
            is_transient: this.isTransientError(error),
            retry_attempts: 1,
            evaluation_run_id: runId,
          };
          errors.push(ruleError);
        }

        // Record rule evaluation history
        if (this.config.persistEvaluationState) {
          const evalTime = Date.now() - ruleStartTime;
          evaluationTimes.push(evalTime);

          await this.evaluationStorage.recordRuleEvaluation({
            evaluation_run_id: runId,
            rule_id: rule.id,
            rule_name: rule.name,
            metric_name: rule.metric,
            metric_value: ruleError ? null : results.find(r => r.ruleId === rule.id)?.currentValue ?? null,
            baseline_value: null, // Could be tracked if needed
            threshold_type: rule.thresholdType,
            threshold_value: rule.thresholdValue,
            triggered: results.some(r => r.ruleId === rule.id),
            evaluation_time_ms: evalTime,
            error: ruleError ? { message: ruleError.error_message, type: ruleError.error_type } : undefined,
          });
        }

        rulesEvaluated++;
      }
    } catch (cycleError: any) {
      console.error('[AlertEngine] Evaluation cycle failed:', cycleError);
      await this.recordEvaluationError({
        error_type: 'cycle_failure',
        error_message: cycleError?.message || String(cycleError),
        stack_trace: cycleError.stack,
        context: { rules_evaluated: rulesEvaluated, alerts_triggered: results.length },
        is_transient: false,
        occurred_at: new Date(),
        evaluation_run_id: runId,
      });
    } finally {
      // Complete evaluation run tracking
      await this.completeEvaluationRun(
        runId,
        rulesEvaluated,
        results.length,
        rulesFailed + errors.length,
        evaluationTimes,
        errors
      );

      // Record engine metrics
      if (this.config.collectMetrics && this.evaluationStorage) {
        await this.recordEngineMetrics(runId, evaluationTimes, rulesEvaluated, results.length, rulesFailed);
      }

      this.currentRunId = null;
    }

    return results;
  }

  /**
   * Evaluate a single rule with circuit breaker protection
   */
  private async evaluateRule(rule: AlertRule): Promise<AlertResult | null> {
    // Check if metrics API circuit breaker blocks evaluation
    const metricsBreaker = this.circuitBreakers.get('metrics-api');
    if (metricsBreaker && !(await metricsBreaker.isAvailable())) {
      throw new Error(`Metrics API circuit breaker is OPEN - skipping rule ${rule.id}`);
    }

    // Check cooldown (checks ALL alerts within window, including resolved)
    const inCooldown = await this.checkCooldown(rule);
    if (inCooldown) return null;

    // Fetch metrics with circuit breaker protection
    const { currentValue, baselineValue } = await this.fetchMetricValueWithBreaker(rule, metricsBreaker);
    if (currentValue === null) return null;

    // Evaluate threshold (may use baseline for drop_pct)
    const isBreached = this.evaluateThreshold(currentValue, baselineValue ?? currentValue, rule.thresholdType, rule.thresholdValue);
    if (!isBreached) return null;

    // Create alert result
    return {
      id: randomUUID(),
      ruleId: rule.id,
      ruleName: rule.name,
      severity: rule.severity,
      metric: rule.metric,
      currentValue,
      thresholdValue: rule.thresholdValue,
      triggeredAt: new Date(),
      channels: rule.channels,
      details: {
        source: rule.source,
        description: rule.description,
        filters: rule.filters,
        evaluationWindowMinutes: rule.evaluationWindowMinutes,
        baselineValue: baselineValue !== null ? baselineValue : undefined,
        thresholdType: rule.thresholdType,
      },
      status: 'triggered',
    };
  }

  /**
   * Complete evaluation run with statistics
   */
  private async completeEvaluationRun(
    runId: string,
    rulesEvaluated: number,
    alertsTriggered: number,
    errorsCount: number,
    evaluationTimes: number[],
    errors: CreateEvaluationErrorInput[]
  ): Promise<void> {
    if (!this.evaluationStorage) return;

    const duration = Date.now() - this.evaluationStartTime;

    await this.evaluationStorage.completeRun(runId, duration, {
      rulesEvaluated,
      alertsTriggered,
      errorsCount,
    });

    // Record any errors that occurred
    for (const error of errors) {
      await this.evaluationStorage.recordError(error);
    }

    // Record any transient errors in circuit breakers
    for (const error of errors) {
      if (error.is_transient) {
        const breakerName = this.mapErrorToCircuitBreaker(error.error_type);
        if (breakerName) {
          const breaker = this.circuitBreakers.get(breakerName);
          if (breaker) {
            await breaker.recordFailure();
          }
        }
      }
    }

    console.log(`[AlertEngine] Evaluation run ${runId} completed: ${rulesEvaluated} rules, ${alertsTriggered} alerts, ${errorsCount} errors in ${duration}ms`);
  }

  /**
   * Record engine performance metrics
   */
  private async recordEngineMetrics(
    runId: string,
    evaluationTimes: number[],
    rulesChecked: number,
    alertsGenerated: number,
    rulesFailed: number
  ): Promise<void> {
    if (!this.evaluationStorage) return;

    const avgTime = evaluationTimes.length > 0
      ? evaluationTimes.reduce((a, b) => a + b, 0) / evaluationTimes.length
      : 0;

    await this.evaluationStorage.recordMetrics({
      evaluation_run_id: runId,
      total_evaluation_time_ms: Date.now() - this.evaluationStartTime,
      avg_rule_evaluation_time_ms: Math.round(avgTime),
      slowest_rule_evaluation_ms: evaluationTimes.length > 0 ? Math.max(...evaluationTimes) : null,
      fastest_rule_evaluation_ms: evaluationTimes.length > 0 ? Math.min(...evaluationTimes) : null,
      rules_checked: rulesChecked,
      rules_passed: rulesChecked - rulesFailed,
      rules_failed: rulesFailed,
      alerts_generated: alertsGenerated,
    });
  }

  /**
   * Map error type to circuit breaker name
   */
  private mapErrorToCircuitBreaker(errorType: string): string | null {
    const mapping: Record<string, string> = {
      'metrics_api_error': 'metrics-api',
      'd1_database_error': 'd1-database',
      'email_error': 'notification-email',
      'slack_error': 'notification-slack',
      'webhook_error': 'notification-webhook',
      'timeout': 'metrics-api',
      'network_error': 'metrics-api',
    };
    return mapping[errorType] || null;
  }

  /**
   * Classify error into category
   */
  private classifyError(error: any): string {
    const message = error?.message?.toLowerCase() || String(error).toLowerCase();

    if (message.includes('timeout') || message.includes('etimedout')) {
      return 'transient_timeout';
    }
    if (message.includes('econnreset') || message.includes('network') || message.includes('fetch failed')) {
      return 'transient_network';
    }
    if (message.includes('429') || message.includes('rate limit')) {
      return 'transient_rate_limit';
    }
    if (message.includes('config') || message.includes('missing') && message.includes('env')) {
      return 'permanent_config';
    }
    if (message.includes('auth') || message.includes('unauthorized') || message.includes('forbidden')) {
      return 'permanent_auth';
    }
    if (message.includes('table') && message.includes('not found')) {
      return 'permanent_data';
    }
    if (message.includes('duplicate') || message.includes('constraint')) {
      return 'permanent_logic';
    }

    return 'unknown';
  }

  /**
   * Determine if error is transient (retryable)
   */
  private isTransientError(error: any): boolean {
    const category = this.classifyError(error);
    return category.startsWith('transient_');
  }

  /**
   * Record an evaluation error
   */
  private async recordEvaluationError(input: CreateEvaluationErrorInput): Promise<void> {
    if (!this.evaluationStorage || !this.config.persistEvaluationState) return;
    await this.evaluationStorage.recordError(input);
  }

  /**
   * Fetch current metric value based on rule source
   * Returns { currentValue, baselineValue } where baseline is used for drop_pct comparisons
   */
  private async fetchMetricValue(rule: AlertRule): Promise<{ currentValue: number; baselineValue: number | null }> {
    switch (rule.source) {
      case 'business':
        return await this.fetchBusinessMetric(rule);
      case 'd1':
        const d1Value = await this.fetchD1Metric(rule);
        return { currentValue: d1Value, baselineValue: null };
      default:
        return { currentValue: null, baselineValue: null };
    }
  }

  /**
   * Fetch business metric using the shared metrics fetcher
   * Queries /api/metrics/business equivalent logic directly from database
   * Returns { currentValue, baselineValue } where baseline is used for drop_pct comparisons
   */
  private async fetchBusinessMetric(rule: AlertRule): Promise<{ currentValue: number; baselineValue: number | null }> {
    if (!this.db) return { currentValue: null, baselineValue: null };

    try {
      const snapshot = await fetchBusinessMetricsSnapshot(this.db, rule.evaluationWindowMinutes);
      const now = new Date();
      const baselineDays = rule.baselinePeriodDays || 7; // Default to 7-day baseline

      // Determine baseline value based on metric type
      let baselineValue: number | null = null;
      if (rule.thresholdType === 'drop_pct') {
        // For drop_pct, compare today's value with N-day average
        const cutoffDate = new Date(now.getTime() - baselineDays * 24 * 60 * 60 * 1000);
        const comparisonDateStr = cutoffDate.toISOString().split('T')[0];

        switch (rule.metric) {
          case 'daily_revenue': {
            const result = await this.db
              .prepare(`
                SELECT COALESCE(AVG(revenue), 0) as avg_revenue
                FROM (
                  SELECT DATE(converted_at) as date, COALESCE(SUM(revenue), 0) as revenue
                  FROM conversions
                  WHERE converted_at >= ? AND converted_at < ?
                    AND status = 'approved'
                  GROUP BY DATE(converted_at)
                ) as daily
              `)
              .bind(comparisonDateStr, now.toISOString())
              .first<{ avg_revenue: number }>();
            baselineValue = result?.avg_revenue ?? 0;
            break;
          }
          case 'conversion_rate': {
            const result = await this.db
              .prepare(`
                SELECT AVG(conv_rate) as avg_rate
                FROM (
                  SELECT
                    DATE(dc.created_at) as date,
                    CASE WHEN COUNT(DISTINCT dc.id) > 0
                      THEN (COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id))
                      ELSE 0
                    END as conv_rate
                  FROM deal_clicks dc
                  LEFT JOIN conversions c ON
                    c.deal_id = dc.deal_id
                    AND c.converted_at >= datetime(?, '-30 days')
                    AND c.converted_at >= dc.created_at
                  WHERE dc.created_at >= ?
                  GROUP BY DATE(dc.created_at)
                ) as daily
              `)
              .bind(comparisonDateStr, comparisonDateStr)
              .first<{ avg_rate: number }>();
            baselineValue = result?.avg_rate ?? 0;
            break;
          }
          case 'total_conversions': {
            const result = await this.db
              .prepare(`
                SELECT AVG(daily_count) as avg_count
                FROM (
                  SELECT COUNT(*) as daily_count
                  FROM conversions
                  WHERE converted_at >= ?
                  GROUP BY DATE(converted_at)
                ) as daily
              `)
              .bind(comparisonDateStr)
              .first<{ avg_count: number }>();
            baselineValue = result?.avg_count ?? 0;
            break;
          }
        }
      }

      // Return current value and optional baseline
      let currentValue: number;
      switch (rule.metric) {
        case 'daily_revenue':
          currentValue = snapshot.todayRevenue;
          break;
        case 'conversion_rate':
          currentValue = snapshot.todayConversionRate;
          break;
        case 'total_conversions':
          currentValue = snapshot.conversionsToday;
          break;
        case 'pending_commission':
          // Query pending commission directly (not in snapshot)
          const pendingResult = await this.db
            .prepare(`
              SELECT COALESCE(SUM(amount), 0) as total
              FROM earnings
              WHERE is_paid = 0
            `)
            .first<{ total: number }>();
          currentValue = pendingResult?.total ?? 0;
          break;
        case 'webhook_failures':
          currentValue = snapshot.webhookFailureRate;
          break;
        case 'payout_failures':
          currentValue = snapshot.payoutFailureRate;
          break;
        case 'stellar_balance':
          currentValue = snapshot.stellarBalance;
          break;
        default:
          console.warn(`Unknown business metric: ${rule.metric}`);
          throw new Error(`Unknown business metric: ${rule.metric}`);
      }

      return { currentValue, baselineValue };
    } catch (error) {
      console.error(`Error fetching business metric ${rule.metric}:`, error);
      // Re-throw with context for circuit breaker classification
      throw new Error(`metrics_api_error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Fetch metric value with circuit breaker protection
   */
  private async fetchMetricValueWithBreaker(
    rule: AlertRule,
    breaker: CircuitBreaker | undefined
  ): Promise<{ currentValue: number; baselineValue: number | null }> {
    if (!breaker) {
      // No circuit breaker, fall back to direct fetch
      return await this.fetchMetricValue(rule);
    }

    try {
      return await breaker.execute(async () => {
        return await this.fetchMetricValue(rule);
      });
    } catch (error: any) {
      console.error(`[AlertEngine] Circuit breaker '${breaker.getState().name}' blocked operation:`, error.message);
      throw error;
    }
  }

  /**
   * Fetch D1 database metric
   */
  private async fetchD1Metric(rule: AlertRule): Promise<number | null> {
    if (!this.db) return null;

    try {
      switch (rule.metric) {
        case 'avg_query_duration_ms': {
          const result = await this.db
            .prepare(`
              SELECT AVG(duration_ms) as avg_duration
              FROM d1_slow_queries
              WHERE logged_at >= datetime('now', '-' || ? || ' minutes')
            `)
            .bind(rule.evaluationWindowMinutes)
            .first<{ avg_duration: number | null }>();
          return result?.avg_duration ?? 0;
        }

        case 'storage_usage_percent': {
          const result = await this.db
            .prepare(`
              SELECT storage_bytes
              FROM d1_metrics_history
              WHERE timestamp = (
                SELECT MAX(timestamp) FROM d1_metrics_history
              )
            `)
            .first<{ storage_bytes: number }>();
          if (result) {
            const storageGB = result.storage_bytes / (1024 * 1024 * 1024);
            const quotaGB = 10;
            return (storageGB / quotaGB) * 100;
          }
          return 0;
        }

        case 'slow_query_count': {
          const result = await this.db
            .prepare(`
              SELECT COUNT(*) as count
              FROM d1_slow_queries
              WHERE logged_at >= datetime('now', '-' || ? || ' minutes')
            `)
            .bind(rule.evaluationWindowMinutes)
            .first<{ count: number }>();
          return result?.count ?? 0;
        }

        case 'avg_rows_scanned': {
          const result = await this.db
            .prepare(`
              SELECT AVG(rows_scanned) as avg_rows
              FROM d1_slow_queries
              WHERE logged_at >= datetime('now', '-' || ? || ' minutes')
            `)
            .bind(rule.evaluationWindowMinutes)
            .first<{ avg_rows: number | null }>();
          return result?.avg_rows ?? 0;
        }

        default:
          throw new Error(`Unknown D1 metric: ${rule.metric}`);
      }
    } catch (error) {
      console.error(`Error fetching D1 metric ${rule.metric}:`, error);
      throw new Error(`d1_database_error: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /**
   * Check if rule is in cooldown period
   *
   * IMPORTANT: Check ALL alerts within cooldown window, regardless of status.
   * This ensures proper deduplication - even if an alert was resolved,
   * we don't want to spam notifications within the cooldown period.
   */
  private async checkCooldown(rule: AlertRule): Promise<boolean> {
    if (!this.db) return false;

    // Check for ANY alerts (including resolved) within cooldown window
    // This prevents duplicate notifications for the same condition
    const result = await this.db
      .prepare(`
        SELECT id FROM alerts
        WHERE rule_id = ?
          AND triggered_at >= datetime('now', '-' || ? || ' minutes')
        LIMIT 1
      `)
      .bind(rule.id, rule.cooldownMinutes)
      .first<{ id: string }>();

    return !!result;
  }

  /**
   * Evaluate threshold condition
   * Supports: gt, gte, lt, lte, eq, drop_pct
   *
   * For drop_pct: returns true if (baseline - current) / baseline * 100 >= thresholdValue
   * (i.e., value dropped by at least threshold percent)
   */
  private evaluateThreshold(
    current: number,
    baseline: number,
    type: AlertRule['thresholdType'],
    threshold: number
  ): boolean {
    switch (type) {
      case 'gt': return current > threshold;
      case 'gte': return current >= threshold;
      case 'lt': return current < threshold;
      case 'lte': return current <= threshold;
      case 'eq': return Math.abs(current - threshold) < 0.0001;
      case 'drop_pct': {
        // Avoid division by zero
        if (baseline === 0) return false;
        const dropPercent = ((baseline - current) / baseline) * 100;
        return dropPercent >= threshold;
      }
      default: return false;
    }
  }

  /**
   * Send alert via configured channels using the dispatcher
   * The dispatcher handles batching, concurrency control, timeouts, and dead letter queue.
   */
  private async sendAlert(alert: AlertResult): Promise<void> {
    if (!this.dispatcher || !this.db) return;

    // Create dispatch jobs for each channel
    const jobs: DispatchJob[] = alert.channels.map(channel =>
      NotificationDispatcher.createDispatchJob(
        alert.id,
        channel,
        this.mapSeverityToPriority(alert.severity),
        {
          alertId: alert.id,
          ruleId: alert.ruleId,
          ruleName: alert.ruleName,
          severity: alert.severity,
          metric: alert.metric,
          currentValue: alert.currentValue,
          thresholdValue: alert.thresholdValue,
          triggeredAt: alert.triggeredAt,
          details: alert.details,
          channels: alert.channels,
        }
      )
    );

    // Send function that routes to the appropriate channel method
    const sendFn = async (job: DispatchJob): Promise<void> => {
      const channel = job.payload.channel as AlertChannel;

      switch (channel) {
        case 'email':
          await this.sendEmailInternal(alert);
          break;
        case 'webhook':
          await this.sendWebhookInternal(alert);
          break;
        case 'slack':
          await this.sendSlackInternal(alert);
          break;
        case 'console':
          this.logToConsole(alert);
          break;
        default:
          throw new Error(`Unknown channel: ${channel}`);
      }
    };

    // Process the batch with dispatcher
    const result = await this.dispatcher.processBatch(jobs, sendFn, this.db);

    console.log(`[AlertEngine] Alert ${alert.id} dispatched: ${result.completed} succeeded, ${result.failed} failed, ${result.deadLetters} dead letters`);

    // Record alert as sent if at least one channel succeeded
    if (result.completed > 0) {
      await this.recordAlertSent(alert);
    }
  }

  /**
   * Send email alert via Resend with retry (internal, without dispatcher)
   */
  private async sendEmailInternal(alert: AlertResult): Promise<void> {
    const resendApiKey = process.env.RESEND_API_KEY;
    const alertEmail = process.env.ALERT_EMAIL || process.env.ADMIN_EMAIL;

    if (!resendApiKey || !alertEmail) {
      console.warn('Email alerts not configured: RESEND_API_KEY or ALERT_EMAIL missing');
    return;
    }

    const severityEmoji = this.getSeverityEmoji(alert.severity);
    const appName = process.env.NEXT_PUBLIC_APP_NAME || 'ApexOS';
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.pages.dev';

    const subject = `[${severityEmoji} ${alert.severity.toUpperCase()}] ${appName} Alert: ${alert.ruleName}`;

    const htmlContent = `
      <!DOCTYPE html>
      <html>
      <head>
        <style>
          body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background: ${this.getSeverityColor(alert.severity)}; color: white; padding: 15px; border-radius: 8px 8px 0 0; }
          .content { background: #f9fafb; padding: 20px; border: 1px solid #e5e7eb; border-top: none; border-radius: 0 0 8px 8px; }
          .metric { background: white; padding: 12px; margin: 10px 0; border-radius: 6px; border-left: 4px solid ${this.getSeverityColor(alert.severity)}; }
          .metric-label { font-weight: 600; color: #6b7280; font-size: 12px; text-transform: uppercase; }
          .metric-value { font-size: 24px; font-weight: 700; color: #111827; }
          .threshold { color: #ef4444; font-size: 14px; }
          .details-list { padding-left: 20px; }
          .action-buttons { margin-top: 24px; text-align: center; }
          .button { display: inline-block; padding: 12px 24px; background-color: #6366f1; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; margin: 8px 4px; }
          .button.secondary { background-color: #f3f4f6; color: #374151; }
          .footer { margin-top: 20px; padding-top: 20px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; }
          .quick-links { margin-top: 16px; padding: 12px; background: #f3f4f6; border-radius: 8px; }
          .quick-links a { color: #6366f1; text-decoration: none; margin: 0 8px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1 style="margin: 0;">${alert.ruleName}</h1>
            <p style="margin: 5px 0 0; opacity: 0.9;">${appName} Alert Engine</p>
          </div>
          <div class="content">
            <p><strong>Status:</strong> <span style="color: ${this.getSeverityColor(alert.severity)}">${alert.severity.toUpperCase()}</span></p>

            <div class="metric">
              <div class="metric-label">Current Value</div>
              <div class="metric-value">${this.formatMetricValue(alert.metric, alert.currentValue)}</div>
              <div class="threshold">Threshold: ${this.formatComparison(alert.details.thresholdType as string | undefined)} ${this.formatMetricValue(alert.metric, alert.thresholdValue)}</div>
            </div>

            <h3>Details</h3>
            <ul class="details-list">
              <li><strong>Triggered:</strong> ${new Date(alert.triggeredAt).toLocaleString()}</li>
              <li><strong>Metric:</strong> ${alert.metric}</li>
              <li><strong>Alert ID:</strong> ${alert.id}</li>
              ${alert.details.description ? `<li><strong>Description:</strong> ${alert.details.description}</li>` : ''}
            </ul>

            <div class="quick-links">
              <strong>Quick Actions:</strong><br>
              <a href="${baseUrl}/admin/monitoring" class="button">View Dashboard</a>
              <a href="${baseUrl}/admin/alerts" class="button secondary">Manage Alerts</a>
              <a href="${baseUrl}/admin/alerts/config" class="button secondary">Alert Config</a>
            </div>

            <div class="footer">
              <p>This alert was generated by the ${appName} monitoring system.</p>
              <p>Need help? Contact <a href="mailto:support@apexos.io">support@apexos.io</a></p>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    const textContent = `
[${alert.severity.toUpperCase()}] ${alert.ruleName}

Current Value: ${this.formatMetricValue(alert.metric, alert.currentValue)}
Threshold: ${this.formatComparison(alert.details.thresholdType as string | undefined)} ${this.formatMetricValue(alert.metric, alert.thresholdValue)}

Triggered: ${new Date(alert.triggeredAt).toLocaleString()}
Metric: ${alert.metric}
Alert ID: ${alert.id}
${alert.details.description ? `Description: ${alert.details.description}` : ''}

Quick Actions:
- View Dashboard: ${baseUrl}/admin/monitoring
- Manage Alerts: ${baseUrl}/admin/alerts
- Alert Config: ${baseUrl}/admin/alerts/config

This alert was generated by the ${appName} monitoring system.
    `;

    const retryConfig = {
      maxAttempts: parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10),
      backoffMs: parseInt(process.env.NOTIFICATION_RETRY_BACKOFF || '1000', 10),
      maxBackoffMs: 30000,
      retryablePatterns: DEFAULT_RETRY_CONFIG.retryablePatterns,
      nonRetryablePatterns: DEFAULT_RETRY_CONFIG.nonRetryablePatterns,
    };

    await withRetry(
      async () => {
        const response = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${resendApiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: `${appName} Alerts <alerts@apexos.io>`,
            to: [alertEmail],
            subject,
            html: htmlContent,
            text: textContent,
          }),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Resend API error: ${response.status} - ${errorText}`);
        }

        return true;
      },
      retryConfig,
      (attempt, error, delayMs) => {
        console.log(`[AlertEngine] Email retry attempt ${attempt} after ${delayMs}ms:`, error.message);
      }
    );
  }

  /**
   * Send webhook alert with retry (internal)
   */
  private async sendWebhookInternal(alert: AlertResult): Promise<void> {
    const webhookUrl = process.env.ALERT_WEBHOOK_URL;
    if (!webhookUrl) {
      console.warn('Webhook alerts not configured: ALERT_WEBHOOK_URL missing');
    return;
    }

    const payload = {
      alert: alert.ruleName,
      severity: alert.severity,
      metric: alert.metric,
      currentValue: alert.currentValue,
      thresholdValue: alert.thresholdValue,
      triggeredAt: alert.triggeredAt.toISOString(),
      alertId: alert.id,
      details: alert.details,
    };

    const retryConfig = {
      maxAttempts: parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10),
      backoffMs: parseInt(process.env.NOTIFICATION_RETRY_BACKOFF || '1000', 10),
      maxBackoffMs: 30000,
      retryablePatterns: DEFAULT_RETRY_CONFIG.retryablePatterns,
      nonRetryablePatterns: DEFAULT_RETRY_CONFIG.nonRetryablePatterns,
    };

    await withRetry(
      async () => {
        const response = await fetch(webhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Webhook failed: ${response.status} - ${errorText}`);
        }

        return true;
      },
      retryConfig,
      (attempt, error, delayMs) => {
        console.log(`[AlertEngine] Webhook retry attempt ${attempt} after ${delayMs}ms:`, error.message);
      }
    );
  }

  /**
   * Send Slack alert with retry and quick action links (internal)
   */
  private async sendSlackInternal(alert: AlertResult): Promise<void> {
    const slackWebhook = process.env.SLACK_WEBHOOK_URL;
    if (!slackWebhook) {
      console.warn('Slack alerts not configured: SLACK_WEBHOOK_URL missing');
    return;
    }

    const emoji = this.getSeverityEmoji(alert.severity);
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.pages.dev';

    const payload = {
      text: `${emoji} *${alert.ruleName}*`,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `${emoji} *${alert.ruleName}*\n<${alert.severity.toUpperCase()}> alert triggered`,
          },
        },
        {
          type: 'section',
          fields: [
            { type: 'mrkdwn', text: `*Current Value:*\n${this.formatMetricValue(alert.metric, alert.currentValue)}` },
            { type: 'mrkdwn', text: `*Threshold:*\n${alert.thresholdValue}` },
            { type: 'mrkdwn', text: `*Metric:*\n${alert.metric}` },
            { type: 'mrkdwn', text: `*Triggered:*\n${new Date(alert.triggeredAt).toLocaleString()}` },
          ],
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: 'View Dashboard' },
              url: `${baseUrl}/admin/monitoring`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Manage Alerts' },
              url: `${baseUrl}/admin/alerts`,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Alert Config' },
              url: `${baseUrl}/admin/alerts/config`,
              style: 'secondary',
            },
          ],
        },
      ],
    };

    const retryConfig = {
      maxAttempts: parseInt(process.env.NOTIFICATION_MAX_RETRIES || '3', 10),
      backoffMs: parseInt(process.env.NOTIFICATION_RETRY_BACKOFF || '1000', 10),
      maxBackoffMs: 30000,
      retryablePatterns: DEFAULT_RETRY_CONFIG.retryablePatterns,
      nonRetryablePatterns: DEFAULT_RETRY_CONFIG.nonRetryablePatterns,
    };

    await withRetry(
      async () => {
        const response = await fetch(slackWebhook, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Slack webhook failed: ${response.status} - ${errorText}`);
        }

        return true;
      },
      retryConfig,
      (attempt, error, delayMs) => {
        console.log(`[AlertEngine] Slack retry attempt ${attempt} after ${delayMs}ms:`, error.message);
      }
    );
  }

  /**
   * Log alert to console (development)
   */
  private logToConsole(alert: AlertResult): void {
    const emoji = this.getSeverityEmoji(alert.severity);
    console.log(
      `%c${emoji} ALERT: ${alert.ruleName}`,
      'font-weight: bold; color: ' + this.getSeverityColor(alert.severity)
    );
    console.log(`  Metric: ${alert.metric}`);
    console.log(`  Current: ${this.formatMetricValue(alert.metric, alert.currentValue)}`);
    console.log(`  Threshold: ${this.formatComparison(alert.details.thresholdType as string | undefined)} ${this.formatMetricValue(alert.metric, alert.thresholdValue)}`);
    console.log(`  Triggered: ${new Date(alert.triggeredAt).toLocaleString()}`);
  }

  /**
   * Record alert in database using the new alerts table
   */
  private async recordAlertSent(alert: AlertResult): Promise<void> {
    if (!this.alertStorage || !this.config.persistAlerts) return;

    try {
      await this.alertStorage.create({
        rule_id: alert.ruleId,
        severity: alert.severity,
        message: alert.ruleName,
        triggered_at: alert.triggeredAt,
        context: {
          channels: alert.channels,
          snapshot: alert.details,
          metric: alert.metric,
          currentValue: alert.currentValue,
          thresholdValue: alert.thresholdValue,
          ruleName: alert.ruleName,
        },
      });
    } catch (error) {
      console.error('Failed to record alert in storage:', error);
    }
  }

  /**
   * Map metric name to alert type
   */
  private mapMetricToType(metric: string): string {
    const mapping: Record<string, string> = {
      'daily_revenue': 'revenue_drop',
      'conversion_rate': 'conversion_rate_low',
      'total_conversions': 'zero_conversions',
      'pending_commission': 'high_commission_liability',
      'avg_query_duration_ms': 'slow_query',
      'storage_usage_percent': 'storage_critical',
      'slow_query_count': 'excessive_slow_queries',
      'avg_rows_scanned': 'high_rows_scanned',
    };
    return mapping[metric] || 'custom';
  }

  // ==========================================================================
  // Utility Methods
  // ==========================================================================

  /**
   * Map alert severity to dispatcher priority
   */
  private mapSeverityToPriority(
    severity: AlertSeverity
  ): 'low' | 'normal' | 'high' | 'critical' {
    switch (severity) {
      case 'critical':
        return 'critical';
      case 'warning':
        return 'high';
      case 'info':
        return 'low';
      default:
        return 'normal';
    }
  }

  private getSeverityEmoji(severity: AlertSeverity): string {
    switch (severity) {
      case 'critical': return '🔴';
      case 'warning': return '🟡';
      case 'info': return '🟢';
      default: return '⚪';
    }
  }

  private getSeverityColor(severity: AlertSeverity): string {
    switch (severity) {
      case 'critical': return '#dc2626';
      case 'warning': return '#f59e0b';
      case 'info': return '#10b981';
      default: return '#6b7280';
    }
  }

  private formatMetricValue(metric: string, value: number): string {
    switch (metric) {
      case 'avg_query_duration_ms':
      case 'avg_rows_scanned':
        return `${Math.round(value).toLocaleString()} ms`;
      case 'storage_usage_percent':
        return `${value.toFixed(1)}%`;
      case 'slow_query_count':
        return `${Math.round(value)} queries`;
      case 'conversion_rate':
        return `${value.toFixed(2)}%`;
      default:
        return value.toLocaleString('en-US', {
          style: 'currency',
          currency: 'USD',
          minimumFractionDigits: 2,
        });
    }
  }

  private formatComparison(type?: string): string {
    switch (type) {
      case 'gt': return '>';
      case 'gte': return '≥';
      case 'lt': return '<';
      case 'lte': return '≤';
      case 'eq': return '=';
      default: return '';
    }
  }

  /**
   * Get last run timestamp
   */
  getLastRun(): Date | null {
    return this.lastRun;
  }

  /**
   * Reload rules from database
   */
  async reloadRules(): Promise<void> {
    await this.loadRulesFromDatabase();
  }

  /**
   * Add or update a rule
   */
  async upsertRule(rule: AlertRule): Promise<void> {
    if (!this.db) return;

    const exists = await this.db
      .prepare('SELECT id FROM alert_rules WHERE id = ?')
      .bind(rule.id)
      .first();

    if (exists) {
      await this.db
        .prepare(`
          UPDATE alert_rules SET
            name = ?, description = ?, metric = ?, threshold_type = ?,
            threshold_value = ?, evaluation_window_minutes = ?, severity = ?,
            alert_channels = ?, cooldown_minutes = ?, is_enabled = ?, filters = ?
          WHERE id = ?
        `)
        .bind(
          rule.name,
          rule.description,
          rule.metric,
          rule.thresholdType,
          rule.thresholdValue,
          rule.evaluationWindowMinutes,
          rule.severity,
          JSON.stringify(rule.channels),
          rule.cooldownMinutes,
          rule.isEnabled ? 1 : 0,
          rule.filters ? JSON.stringify(rule.filters) : null,
          rule.id
        )
        .run();
    } else {
      await this.db
        .prepare(`
          INSERT INTO alert_rules (
            id, name, description, source, metric, threshold_type, threshold_value,
            evaluation_window_minutes, severity, alert_channels, cooldown_minutes, is_enabled, filters
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .bind(
          rule.id,
          rule.name,
          rule.description,
          rule.source,
          rule.metric,
          rule.thresholdType,
          rule.thresholdValue,
          rule.evaluationWindowMinutes,
          rule.severity,
          JSON.stringify(rule.channels),
          rule.cooldownMinutes,
          rule.isEnabled ? 1 : 0,
          rule.filters ? JSON.stringify(rule.filters) : null
        )
        .run();
    }

    await this.reloadRules();
  }

  /**
   * Disable a rule
   */
  async disableRule(ruleId: string): Promise<void> {
    if (!this.db) return;

    await this.db
      .prepare('UPDATE alert_rules SET is_enabled = 0 WHERE id = ?')
      .bind(ruleId)
      .run();

    await this.reloadRules();
  }

  // ============================================================================
  // Evaluation State & Metrics Accessors
  // ============================================================================

  /**
   * Get evaluation statistics
   */
  async getEvaluationStats(days: number = 7): Promise<EvaluationStats | null> {
    if (!this.evaluationStorage) return null;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    return this.evaluationStorage.getEvaluationStats(since);
  }

  /**
   * Get rule-specific statistics
   */
  async getRuleStats(ruleId?: string, days: number = 7): Promise<import('@/types/evaluation-state').RuleStats[]> {
    if (!this.evaluationStorage) return [];
    return this.evaluationStorage.getRuleStats(ruleId, days);
  }

  /**
   * Get recent evaluation runs
   */
  async getRecentRuns(limit: number = 50): Promise<EvaluationRun[]> {
    if (!this.evaluationStorage) return [];
    return this.evaluationStorage.getRecentRuns(limit);
  }

  /**
   * Get error statistics
   */
  async getErrorStats(since?: Date): Promise<{
    total: number;
    by_type: Record<string, number>;
    by_rule: Record<string, number>;
    transient_count: number;
    permanent_count: number;
  }> {
    if (!this.evaluationStorage) {
      return { total: 0, by_type: {}, by_rule: {}, transient_count: 0, permanent_count: 0 };
    }
    return this.evaluationStorage.getErrorStats(since);
  }

  /**
   * Get all circuit breaker states
   */
  async getCircuitBreakerStates(): Promise<Array<{
    name: string;
    state: string;
    failure_count: number;
    last_failure_at: string | null;
    next_attempt_at: string | null;
  }>> {
    if (!this.evaluationStorage) return [];
    return this.evaluationStorage.getAllCircuitBreakers().then(breakers =>
      breakers.map(b => ({
        name: b.name,
        state: b.state,
        failure_count: b.failure_count,
        last_failure_at: b.last_failure_at,
        next_attempt_at: b.next_attempt_at,
      }))
    );
  }

  /**
   * Reset a circuit breaker
   */
  async resetCircuitBreaker(name: string): Promise<void> {
    if (!this.evaluationStorage) return;
    await this.evaluationStorage.resetCircuitBreaker(name);
    const breaker = this.circuitBreakers.get(name);
    if (breaker) {
      await breaker.reset();
    }
  }

  /**
   * Reset all circuit breakers
   */
  async resetAllCircuitBreakers(): Promise<void> {
    for (const breaker of this.circuitBreakers.values()) {
      await breaker.reset();
    }
  }

  /**
   * Get current evaluation run ID (for debugging/tracing)
   */
  getCurrentRunId(): string | null {
    return this.currentRunId;
  }

  /**
   * Check if an evaluation is currently running
   */
  isEvaluating(): boolean {
    return this.currentRunId !== null;
  }

  /**
   * Get evaluation engine configuration
   */
  getConfig(): AlertEngineConfig {
    return { ...this.config };
  }

  /**
   * Update evaluation engine configuration
   */
  async updateConfig(updates: Partial<AlertEngineConfig>): Promise<void> {
    Object.assign(this.config, updates);
  }
}

// ============================================================================
// Singleton Instance & Helper Functions
// ============================================================================

let globalEngine: AlertEngine | null = null;

export async function getAlertEngine(db: D1Database, config?: Partial<AlertEngineConfig>): Promise<AlertEngine> {
  if (!globalEngine) {
    globalEngine = new AlertEngine(config);
    await globalEngine.initialize(db);
  }
  return globalEngine;
}

/**
 * Run alert evaluation cycle (cron endpoint entry point)
 */
export async function runAlertEngine(db: D1Database): Promise<AlertResult[]> {
  const engine = await getAlertEngine(db);
  return await engine.runCycle();
}

/**
 * Get active alert rules
 */
export async function getAlertRules(db: D1Database): Promise<AlertRule[]> {
  const engine = await getAlertEngine(db);
  return engine['rules'];
}
