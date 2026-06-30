/**
 * Alert Rules Database Schema (Migration 012)
 *
 * Stores configurable alert rules for the unified alert engine.
 * Supports multiple sources (business metrics, D1 metrics) and channels.
 */

PRAGMA foreign_keys = ON;

-- ============================================================
-- Alert Rules Table
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_rules (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  source TEXT NOT NULL CHECK (source IN ('business', 'd1', 'custom')),
  metric TEXT NOT NULL,
  threshold_type TEXT NOT NULL CHECK (threshold_type IN ('gt', 'gte', 'lt', 'lte', 'eq')),
  threshold_value REAL NOT NULL,
  evaluation_window_minutes INTEGER DEFAULT 60,
  severity TEXT DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  alert_channels TEXT DEFAULT '["email"]', -- JSON array
  cooldown_minutes INTEGER DEFAULT 15,
  is_enabled INTEGER DEFAULT 1,
  filters TEXT, -- JSON object with optional filters
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_alert_rules_enabled ON alert_rules(is_enabled);
CREATE INDEX IF NOT EXISTS idx_alert_rules_source ON alert_rules(source);
CREATE INDEX IF NOT EXISTS idx_alert_rules_severity ON alert_rules(severity);

-- Insert default business alert rules
INSERT OR IGNORE INTO alert_rules (id, name, description, source, metric, threshold_type, threshold_value, evaluation_window_minutes, severity, alert_channels, cooldown_minutes, is_enabled) VALUES
  ('biz-revenue-drop', 'Revenue Drop Alert', 'Triggers when daily revenue drops below threshold', 'business', 'daily_revenue', 'lt', 100, 120, 'warning', '["email","webhook"]', 60, 1),
  ('biz-conversion-rate-low', 'Low Conversion Rate Alert', 'Triggers when conversion rate drops below threshold', 'business', 'conversion_rate', 'lt', 2.0, 120, 'warning', '["email"]', 60, 1),
  ('biz-zero-conversions', 'No Conversions Alert', 'Triggers when no conversions detected for 24 hours', 'business', 'total_conversions', 'eq', 0, 1440, 'critical', '["email","webhook"]', 180, 1),
  ('biz-high-commission-liability', 'High Commission Liability Alert', 'Triggers when pending commission liability exceeds threshold', 'business', 'pending_commission', 'gte', 10000, 60, 'warning', '["email","webhook"]', 60, 1);

-- Insert default D1 alert rules (synced with existing d1_alert_configs)
INSERT OR IGNORE INTO alert_rules (id, name, description, source, metric, threshold_type, threshold_value, evaluation_window_minutes, severity, alert_channels, cooldown_minutes, is_enabled) VALUES
  ('d1-slow-query', 'Slow Query Alert', 'Triggers when average query duration exceeds 1 second', 'd1', 'avg_query_duration_ms', 'gt', 1000, 60, 'warning', '["email"]', 15, 1),
  ('d1-storage-critical', 'High Storage Usage', 'Triggers when storage usage exceeds 80% of quota', 'd1', 'storage_usage_percent', 'gte', 80, 60, 'critical', '["email","webhook"]', 15, 1),
  ('d1-excessive-slow-queries', 'Excessive Slow Queries', 'Triggers when more than 10 slow queries in evaluation window', 'd1', 'slow_query_count', 'gt', 10, 60, 'warning', '["email"]', 15, 1),
  ('d1-high-rows-scanned', 'High Row Scan Count', 'Triggers when average rows scanned per query exceeds 10000', 'd1', 'avg_rows_scanned', 'gt', 10000, 60, 'warning', '["email"]', 15, 1);

-- ============================================================
-- Migration completed successfully
-- ============================================================
