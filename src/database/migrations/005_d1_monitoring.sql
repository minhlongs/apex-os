-- ============================================================
-- D1 Metrics Monitoring (Migration 005)
-- Tracks query performance, storage usage, and alert history
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: D1 Metrics History Table
-- Stores collected metrics over time for trend analysis
-- ============================================================

CREATE TABLE IF NOT EXISTS d1_metrics_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  timestamp TEXT NOT NULL DEFAULT (datetime('now')),
  -- Storage metrics (bytes)
  storage_bytes INTEGER NOT NULL,
  storage_mb REAL GENERATED ALWAYS AS (storage_bytes / 1024.0 / 1024.0) VIRTUAL,
  page_count INTEGER NOT NULL,
  page_size INTEGER NOT NULL,
  -- Query performance metrics
  avg_query_duration_ms REAL NOT NULL,
  max_query_duration_ms REAL NOT NULL,
  slow_query_count INTEGER DEFAULT 0,
  total_queries INTEGER DEFAULT 0,
  -- Row scan metrics
  total_rows_scanned INTEGER DEFAULT 0,
  avg_rows_scanned REAL GENERATED ALWAYS AS (
    CASE WHEN total_queries > 0 THEN total_rows_scanned * 1.0 / total_queries ELSE 0 END
  ) VIRTUAL,
  -- Cache hit ratio (if available)
  cache_hit_ratio REAL,
  -- WAL file size (if using WAL mode)
  wal_size_bytes INTEGER DEFAULT 0,
  -- Metadata
  collected_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_d1_metrics_timestamp ON d1_metrics_history(timestamp);
CREATE INDEX IF NOT EXISTS idx_d1_metrics_storage ON d1_metrics_history(storage_bytes);

-- ============================================================
-- STEP 2: Slow Queries Log Table
-- Logs individual queries that exceed threshold
-- ============================================================

CREATE TABLE IF NOT EXISTS d1_slow_queries (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  logged_at TEXT NOT NULL DEFAULT (datetime('now')),
  query_text TEXT NOT NULL,
  duration_ms REAL NOT NULL,
  rows_scanned INTEGER NOT NULL,
  rows_returned INTEGER DEFAULT 0,
  -- Optional: originating endpoint if tracked
  endpoint_path TEXT,
  user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  -- Stack trace or context if available
  context TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_slow_queries_logged ON d1_slow_queries(logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_duration ON d1_slow_queries(duration_ms DESC);
CREATE INDEX IF NOT EXISTS idx_slow_queries_user ON d1_slow_queries(user_id);

-- ============================================================
-- STEP 3: Alert Configurations Table
-- Stores alert rules and thresholds
-- ============================================================

CREATE TABLE IF NOT EXISTS d1_alert_configs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT,
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'query_duration',
    'storage_usage',
    'rows_scanned',
    'slow_query_count',
    'cache_hit_ratio'
  )),
  -- Threshold configuration
  threshold_type TEXT NOT NULL CHECK (threshold_type IN ('gt', 'lt', 'gte', 'lte', 'eq')),
  threshold_value REAL NOT NULL,
  -- Evaluation window (in minutes)
  evaluation_window_minutes INTEGER DEFAULT 60,
  -- Severity level
  severity TEXT DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  -- Alert channels (JSON array: email, webhook, etc.)
  alert_channels TEXT DEFAULT '["email"]',
  -- Cooldown period (minutes) to prevent alert spam
  cooldown_minutes INTEGER DEFAULT 15,
  -- Status
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_configs_enabled ON d1_alert_configs(is_enabled);
CREATE INDEX IF NOT EXISTS idx_alert_configs_metric ON d1_alert_configs(metric_type);

-- Insert default alert configurations
INSERT OR IGNORE INTO d1_alert_configs (id, name, description, metric_type, threshold_type, threshold_value, evaluation_window_minutes, severity) VALUES
  ('alert-slow-query', 'Slow Query Alert', 'Triggers when average query duration exceeds 1 second', 'query_duration', 'gt', 1000, 60, 'warning'),
  ('alert-storage', 'High Storage Usage', 'Triggers when storage usage exceeds 80% of allocated quota', 'storage_usage', 'gte', 80, 60, 'critical'),
  ('alert-slow-count', 'Excessive Slow Queries', 'Triggers when more than 10 queries exceed 1s in the evaluation window', 'slow_query_count', 'gt', 10, 60, 'warning'),
  ('alert-rows-scanned', 'High Row Scan Count', 'Triggers when average rows scanned per query exceeds 10000', 'rows_scanned', 'gt', 10000, 60, 'warning');

-- ============================================================
-- STEP 4: Alert History Table
-- Tracks triggered alerts and their resolution
-- ============================================================

CREATE TABLE IF NOT EXISTS d1_alert_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  alert_config_id TEXT NOT NULL REFERENCES d1_alert_configs(id),
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  -- Current value that triggered the alert
  current_value REAL NOT NULL,
  threshold_value REAL NOT NULL,
  -- Additional context
  details TEXT DEFAULT '{}',
  -- Status: active, resolved, acknowledged
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'acknowledged')),
  -- Metadata
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON d1_alert_history(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_config ON d1_alert_history(alert_config_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_status ON d1_alert_history(status);

-- ============================================================
-- STEP 5: Create Triggers for Auto-updating Timestamps
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_d1_alert_configs_updated
AFTER UPDATE ON d1_alert_configs
FOR EACH ROW
BEGIN
  UPDATE d1_alert_configs SET updated_at = datetime('now') WHERE id = old.id;
END;

-- ============================================================
-- STEP 6: Useful Views for Dashboard
-- ============================================================

-- Current storage usage summary
CREATE VIEW IF NOT EXISTS v_d1_storage_current AS
SELECT
  storage_bytes,
  storage_mb,
  page_count,
  page_size,
  wal_size_bytes,
  (storage_bytes * 100.0 / (10 * 1024 * 1024 * 1024)) as storage_percent_of_10gb -- Assuming 10GB allocation
FROM d1_metrics_history
WHERE timestamp = (
  SELECT MAX(timestamp) FROM d1_metrics_history
);

-- Recent performance metrics (last 24 hours)
CREATE VIEW IF NOT EXISTS v_d1_performance_24h AS
SELECT
  AVG(avg_query_duration_ms) as avg_duration_all,
  MAX(max_query_duration_ms) as peak_duration,
  AVG(slow_query_count) as avg_slow_queries,
  SUM(total_queries) as total_queries,
  AVG(avg_rows_scanned) as avg_rows_scanned,
  MAX(cache_hit_ratio) as best_cache_hit_ratio,
  MIN(cache_hit_ratio) as worst_cache_hit_ratio
FROM d1_metrics_history
WHERE timestamp >= datetime('now', '-24 hours');

-- Active alerts summary
CREATE VIEW IF NOT EXISTS v_d1_active_alerts AS
SELECT
  c.name,
  c.description,
  c.metric_type,
  c.severity,
  h.current_value,
  h.threshold_value,
  h.triggered_at,
  (julianday('now') - julianday(h.triggered_at)) * 24 * 60 as minutes_active
FROM d1_alert_history h
JOIN d1_alert_configs c ON h.alert_config_id = c.id
WHERE h.status = 'active'
ORDER BY
  CASE c.severity
    WHEN 'critical' THEN 1
    WHEN 'warning' THEN 2
    WHEN 'info' THEN 3
    ELSE 4
  END,
  h.triggered_at DESC;

-- ============================================================
-- Migration completed successfully
-- ============================================================
