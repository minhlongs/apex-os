/**
 * Evaluation State Types
 * Types for alert engine evaluation state persistence and monitoring
 */

import type { AlertRule, AlertResult } from '@/lib/monitoring/alert-engine';
import type { AlertSeverity, AlertStatus } from './alerts';

// ============================================================================
// Evaluation Run Tracking
// ============================================================================

export interface EvaluationRun {
  id: string;
  started_at: string;
  completed_at: string | null;
  duration_ms: number | null;
  status: 'running' | 'completed' | 'failed' | 'partial_failure';
  rules_evaluated: number;
  alerts_triggered: number;
  errors_count: number;
  metadata: Record<string, unknown>;
  created_at: string;
}

export interface CreateEvaluationRunInput {
  started_at?: Date;
  metadata?: Record<string, unknown>;
}

export interface UpdateEvaluationRunInput {
  completed_at?: Date;
  duration_ms?: number;
  status?: EvaluationRun['status'];
  rules_evaluated?: number;
  alerts_triggered?: number;
  errors_count?: number;
}

// ============================================================================
// Rule Evaluation History
// ============================================================================

export interface RuleEvaluationHistory {
  id: string;
  evaluation_run_id: string;
  rule_id: string;
  rule_name: string;
  metric_name: string;
  metric_value: number | null;
  baseline_value: number | null;
  threshold_type: string | null;
  threshold_value: number | null;
  triggered: 0 | 1;
  evaluation_time_ms: number | null;
  error_message: string | null;
  error_type: string | null;
  evaluated_at: string;
}

export interface CreateRuleEvaluationInput {
  evaluation_run_id: string;
  rule_id: string;
  rule_name: string;
  metric_name: string;
  metric_value: number | null;
  baseline_value: number | null;
  threshold_type: string | null;
  threshold_value: number | null;
  triggered: boolean;
  evaluation_time_ms: number | null;
  error?: {
    message: string;
    type: string;
  };
}

// ============================================================================
// Evaluation Errors
// ============================================================================

export interface EvaluationError {
  id: string;
  evaluation_run_id: string | null;
  rule_id: string | null;
  error_type: string;
  error_message: string;
  stack_trace: string | null;
  context: Record<string, unknown>;
  is_transient: 0 | 1;
  retry_attempts: number;
  occurred_at: string;
}

export interface CreateEvaluationErrorInput {
  evaluation_run_id?: string;
  rule_id?: string;
  error_type: string;
  error_message: string;
  stack_trace?: string | null;
  context?: Record<string, unknown>;
  is_transient?: boolean;
  retry_attempts?: number;
  occurred_at?: Date;
}

// ============================================================================
// Circuit Breaker State
// ============================================================================

export type CircuitBreakerState = 'closed' | 'open' | 'half_open';

export interface CircuitBreakerConfig {
  failureThreshold: number;
  timeoutSeconds: number;
  resetTimeoutMs: number; // How long to wait before half_open
  halfOpenMaxCalls: number;
}

export interface CircuitBreakerEntry {
  id: string;
  name: string;
  state: CircuitBreakerState;
  failure_count: number;
  last_failure_at: string | null;
  last_success_at: string | null;
  next_attempt_at: string | null;
  failure_threshold: number;
  timeout_seconds: number;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface CreateCircuitBreakerInput {
  name: string;
  state?: CircuitBreakerState;
  failure_threshold?: number;
  timeout_seconds?: number;
  metadata?: Record<string, unknown>;
}

export interface UpdateCircuitBreakerInput {
  state?: CircuitBreakerState;
  failure_count?: number;
  last_failure_at?: Date | null;
  last_success_at?: Date | null;
  next_attempt_at?: Date | null;
}

// ============================================================================
// Alert Engine Metrics (Health Monitoring)
// ============================================================================

export interface AlertEngineMetrics {
  id: string;
  timestamp: string;
  evaluation_run_id: string | null;

  // Timing metrics
  total_evaluation_time_ms: number | null;
  avg_rule_evaluation_time_ms: number | null;
  slowest_rule_evaluation_ms: number | null;
  fastest_rule_evaluation_ms: number | null;

  // Throughput metrics
  rules_checked: number | null;
  rules_passed: number | null;
  rules_failed: number | null;
  alerts_generated: number | null;

  // Health metrics
  metrics_api_latency_ms: number | null;
  database_latency_ms: number | null;
  cache_hit_rate: number | null;

  // System metrics
  memory_usage_mb: number | null;
  concurrent_evaluations: number | null;
}

export interface RecordMetricsInput {
  evaluation_run_id?: string;
  total_evaluation_time_ms?: number;
  avg_rule_evaluation_time_ms?: number;
  slowest_rule_evaluation_ms?: number;
  fastest_rule_evaluation_ms?: number;
  rules_checked?: number;
  rules_passed?: number;
  rules_failed?: number;
  alerts_generated?: number;
  metrics_api_latency_ms?: number;
  database_latency_ms?: number;
  cache_hit_rate?: number;
  memory_usage_mb?: number;
  concurrent_evaluations?: number;
}

// ============================================================================
// Evaluation Statistics
// ============================================================================

export interface EvaluationStats {
  period_start: Date;
  period_end: Date;
  total_runs: number;
  successful_runs: number;
  failed_runs: number;
  avg_run_duration_ms: number;
  total_alerts_generated: number;
  rules_evaluated_count: number;
  error_rate_percent: number;
  by_rule: Array<{
    rule_id: string;
    rule_name: string;
    evaluations: number;
    triggers: number;
    avg_evaluation_time_ms: number;
    error_count: number;
  }>;
}

export interface RuleStats {
  rule_id: string;
  rule_name: string;
  total_evaluations: number;
  total_triggers: number;
  trigger_rate_percent: number;
  avg_evaluation_time_ms: number;
  last_evaluated: string | null;
  last_triggered: string | null;
  error_count: number;
}

// ============================================================================
// Error Classification
// ============================================================================

export enum ErrorCategory {
  TRANSIENT_NETWORK = 'transient_network',
  TRANSIENT_RATE_LIMIT = 'transient_rate_limit',
  TRANSIENT_TIMEOUT = 'transient_timeout',
  PERMANENT_CONFIG = 'permanent_config',
  PERMANENT_AUTH = 'permanent_auth',
  PERMANENT_DATA = 'permanent_data',
  PERMANENT_LOGIC = 'permanent_logic',
  UNKNOWN = 'unknown',
}

export interface ErrorClassification {
  category: ErrorCategory;
  is_retryable: boolean;
  suggested_action: 'retry' | 'escalate' | 'fix_config' | 'ignore' | 'investigate';
  user_message?: string;
}

// ============================================================================
// Evaluation Configuration
// ============================================================================

export interface EvaluationConfig {
  enabled: boolean;
  evaluation_interval_minutes: number;
  max_alerts_per_run: number;
  persist_evaluation_state: boolean;
  persist_rule_history: boolean;
  persist_errors: boolean;
  circuit_breaker_enabled: boolean;
  metrics_collection_enabled: boolean;
  retention_days: number;
}

export const DEFAULT_EVALUATION_CONFIG: EvaluationConfig = {
  enabled: true,
  evaluation_interval_minutes: 5,
  max_alerts_per_run: 100,
  persist_evaluation_state: true,
  persist_rule_history: true,
  persist_errors: true,
  circuit_breaker_enabled: true,
  metrics_collection_enabled: true,
  retention_days: 90,
};

// ============================================================================
// Evaluation State Manager Types
// ============================================================================

export interface EvaluationStateManager {
  startRun(): Promise<string>; // Returns run_id
  completeRun(runId: string, stats: { rulesEvaluated: number; alertsTriggered: number; errorsCount: number }): Promise<void>;
  failRun(runId: string, error: Error): Promise<void>;
  recordRuleEvaluation(input: CreateRuleEvaluationInput): Promise<void>;
  recordError(input: CreateEvaluationErrorInput): Promise<void>;
  getRun(runId: string): Promise<EvaluationRun | null>;
  getRecentRuns(limit?: number): Promise<EvaluationRun[]>;
  getRuleStats(ruleId?: string, days?: number): Promise<RuleStats[]>;
  getErrorStats(since?: Date): Promise<{
    total: number;
    by_type: Record<string, number>;
    by_rule: Record<string, number>;
    transient_count: number;
    permanent_count: number;
  }>;
  cleanupOldData(retentionDays: number): Promise<{ runsDeleted: number; errorsDeleted: number; historyDeleted: number }>;
}

// ============================================================================
// Circuit Breaker Types
// ============================================================================

export interface CircuitBreaker {
  name: string;
  execute<T>(fn: () => Promise<T>): Promise<T>;
  reset(): void;
  getState(): CircuitBreakerEntry;
  isAvailable(): boolean;
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  timeoutSeconds?: number;
  resetTimeoutMs?: number;
  halfOpenMaxCalls?: number;
  onStateChange?: (name: string, oldState: CircuitBreakerState, newState: CircuitBreakerState) => void;
}
