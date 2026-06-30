-- ============================================================
-- ApexOS Evaluation State Schema (Migration 009)
-- Adds state persistence for alert engine evaluation:
-- - evaluation_runs: Track each evaluation cycle
-- - rule_evaluation_history: Track rule evaluation results over time
-- - evaluation_errors: Track errors during evaluation
-- - circuit_breaker_state: Track circuit breaker state for resilience
--
-- This migration is IDEMPOTENT - safe to run multiple times.
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Create evaluation_runs table
-- Tracks each complete evaluation cycle of the alert engine
-- ============================================================

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT,
  duration_ms INTEGER,
  status TEXT DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed', 'partial_failure')),
  rules_evaluated INTEGER DEFAULT 0,
  alerts_triggered INTEGER DEFAULT 0,
  errors_count INTEGER DEFAULT 0,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_evaluation_runs_started_at ON evaluation_runs(started_at);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_status ON evaluation_runs(status);
CREATE INDEX IF NOT EXISTS idx_evaluation_runs_created_at ON evaluation_runs(created_at);

-- ============================================================
-- STEP 2: Create rule_evaluation_history table
-- Tracks individual rule evaluation results for historical analysis
-- ============================================================

CREATE TABLE IF NOT EXISTS rule_evaluation_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  evaluation_run_id TEXT REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  rule_id TEXT NOT NULL,
  rule_name TEXT NOT NULL,
  metric_name TEXT NOT NULL,
  metric_value REAL,
  baseline_value REAL,
  threshold_type TEXT,
  threshold_value REAL,
  triggered INTEGER DEFAULT 0, -- 0=no, 1=yes
  evaluation_time_ms INTEGER,
  error_message TEXT,
  error_type TEXT,
  evaluated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rule_eval_history_run_id ON rule_evaluation_history(evaluation_run_id);
CREATE INDEX IF NOT EXISTS idx_rule_eval_history_rule_id ON rule_evaluation_history(rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_eval_history_evaluated_at ON rule_evaluation_history(evaluated_at);
CREATE INDEX IF NOT EXISTS idx_rule_eval_history_triggered ON rule_evaluation_history(triggered);

-- ============================================================
-- STEP 3: Create evaluation_errors table
-- Dedicated table for tracking evaluation errors with stack traces
-- ============================================================

CREATE TABLE IF NOT EXISTS evaluation_errors (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  evaluation_run_id TEXT REFERENCES evaluation_runs(id) ON DELETE SET NULL,
  rule_id TEXT,
  error_type TEXT NOT NULL,
  error_message TEXT NOT NULL,
  stack_trace TEXT,
  context TEXT DEFAULT '{}',
  is_transient INTEGER DEFAULT 0, -- 0=permanent, 1=transient/retryable
  retry_attempts INTEGER DEFAULT 0,
  occurred_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_eval_errors_run_id ON evaluation_errors(evaluation_run_id);
CREATE INDEX IF NOT EXISTS idx_eval_errors_rule_id ON evaluation_errors(rule_id);
CREATE INDEX IF NOT EXISTS idx_eval_errors_error_type ON evaluation_errors(error_type);
CREATE INDEX IF NOT EXISTS idx_eval_errors_occurred_at ON evaluation_errors(occurred_at);
CREATE INDEX IF NOT EXISTS idx_eval_errors_transient ON evaluation_errors(is_transient);

-- ============================================================
-- STEP 4: Create circuit_breaker_state table
-- Tracks circuit breaker state per rule or metric source
-- ============================================================

CREATE TABLE IF NOT EXISTS circuit_breaker_state (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL UNIQUE, -- rule_id or 'metrics-api' or 'd1-database'
  state TEXT DEFAULT 'closed' CHECK (state IN ('closed', 'open', 'half_open')),
  failure_count INTEGER DEFAULT 0,
  last_failure_at TEXT,
  last_success_at TEXT,
  next_attempt_at TEXT,
  failure_threshold INTEGER DEFAULT 5,
  timeout_seconds INTEGER DEFAULT 60,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_circuit_breaker_name ON circuit_breaker_state(name);
CREATE INDEX IF NOT EXISTS idx_circuit_breaker_state ON circuit_breaker_state(state);

-- ============================================================
-- STEP 5: Create alert_engine_metrics table
-- Time-series metrics for alert engine health monitoring
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_engine_metrics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  evaluation_run_id TEXT REFERENCES evaluation_runs(id) ON DELETE SET NULL,

  -- Timing metrics
  total_evaluation_time_ms INTEGER,
  avg_rule_evaluation_time_ms REAL,
  slowest_rule_evaluation_ms INTEGER,
  fastest_rule_evaluation_ms INTEGER,

  -- Throughput metrics
  rules_checked INTEGER,
  rules_passed INTEGER,
  rules_failed INTEGER,
  alerts_generated INTEGER,

  -- Health metrics
  metrics_api_latency_ms INTEGER,
  database_latency_ms INTEGER,
  cache_hit_rate REAL,

  -- System metrics
  memory_usage_mb REAL,
  concurrent_evaluations INTEGER
);

CREATE INDEX IF NOT EXISTS idx_alert_engine_metrics_timestamp ON alert_engine_metrics(timestamp);
CREATE INDEX IF NOT EXISTS idx_alert_engine_metrics_run_id ON alert_engine_metrics(evaluation_run_id);

-- ============================================================
-- STEP 6: Create triggers for auto-updating timestamps
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_circuit_breaker_updated
AFTER UPDATE ON circuit_breaker_state
FOR EACH ROW
BEGIN
  UPDATE circuit_breaker_state SET updated_at = datetime('now') WHERE id = old.id;
END;

-- ============================================================
-- STEP 7: Insert default circuit breaker configurations
-- ============================================================

INSERT OR IGNORE INTO circuit_breaker_state (name, state, failure_threshold, timeout_seconds, metadata)
VALUES
  ('metrics-api', 'closed', 5, 300, '{"service": "business_metrics_fetcher", "description": "Circuit breaker for business metrics API calls"}'),
  ('d1-database', 'closed', 10, 60, '{"service": "d1_database", "description": "Circuit breaker for D1 database operations"}'),
  ('notification-email', 'closed', 3, 300, '{"service": "resend_email", "description": "Circuit breaker for email notifications"}'),
  ('notification-slack', 'closed', 3, 300, '{"service": "slack_webhook", "description": "Circuit breaker for Slack notifications"}'),
  ('notification-webhook', 'closed', 3, 300, '{"service": "generic_webhook", "description": "Circuit breaker for generic webhook notifications"}');

-- ============================================================
-- Migration completed successfully
-- ============================================================
