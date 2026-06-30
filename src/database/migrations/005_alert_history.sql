-- ============================================================
-- Migration 005: Alert History Table for Payout Health Dashboard
-- Stores alert history for tracking and resolution
-- ============================================================

PRAGMA foreign_keys = ON;

-- Create alert_history table
CREATE TABLE IF NOT EXISTS alert_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  alert_id TEXT NOT NULL,  -- e.g., 'no-conversions-24h', 'payout-failure-rate'
  type TEXT NOT NULL CHECK (type IN ('no_conversions_24h', 'payout_failure_rate', 'conversion_failure_rate', 'pending_commissions', 'custom')),
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  current_value REAL NOT NULL,
  threshold REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  triggered_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history(type);
CREATE INDEX IF NOT EXISTS idx_alert_history_severity ON alert_history(severity);
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history(triggered_at);
CREATE INDEX IF NOT EXISTS idx_alert_history_resolved ON alert_history(resolved_at);

-- Trigger for auto-updating timestamps
CREATE TRIGGER IF NOT EXISTS trg_alert_history_updated
AFTER UPDATE ON alert_history
FOR EACH ROW
BEGIN
  UPDATE alert_history SET updated_at = datetime('now') WHERE id = old.id;
END;

-- Views for alert monitoring

-- Active alerts view
CREATE VIEW IF NOT EXISTS v_active_alerts AS
SELECT
  id,
  alert_id,
  type,
  title,
  description,
  current_value,
  threshold,
  severity,
  triggered_at,
  TIMEDIFF(datetime('now'), triggered_at) as duration
FROM alert_history
WHERE resolved_at IS NULL
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'warning' THEN 2
    ELSE 3
  END,
  triggered_at DESC;

-- Alert summary view
CREATE VIEW IF NOT EXISTS v_alert_summary AS
SELECT
  type,
  severity,
  COUNT(*) as total_alerts,
  SUM(CASE WHEN resolved_at IS NULL THEN 1 ELSE 0 END) as active_count,
  SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END) as resolved_count,
  MAX(triggered_at) as last_triggered,
  AVG(current_value) as avg_current_value
FROM alert_history
GROUP BY type, severity
ORDER BY total_alerts DESC;

-- Migration completed successfully
-- ============================================================
