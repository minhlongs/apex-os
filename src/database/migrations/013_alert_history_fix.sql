/**
 * Migration: Fix alert_history for unified alert engine
 *
 * This migration modifies the alert_history table to support the unified
 * alert engine (alert_rules). Changes:
 * - Add 'status' column for alert lifecycle management
 * - Expand 'type' CHECK constraint to accept all metric types from alert_rules
 * - Add index for cooldown/deduplication queries
 */

PRAGMA foreign_keys = ON;

-- ============================================================================
-- STEP 1: Expand type constraint to include all alert_rules metrics
-- ============================================================================

-- First, we need to recreate the table with an expanded type constraint
-- Since SQLite doesn't support ALTER TABLE ADD COLUMN with CHECK constraint modification,
-- we'll create a new table, copy data, and swap.

CREATE TABLE IF NOT EXISTS alert_history_new (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  alert_id TEXT NOT NULL,
  type TEXT NOT NULL, -- Expanded to accept all metric types from alert_rules + legacy types
  title TEXT NOT NULL,
  description TEXT NOT NULL,
  current_value REAL NOT NULL,
  threshold REAL NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'acknowledged')),
  triggered_at TEXT DEFAULT (datetime('now')),
  resolved_at TEXT,
  acknowledged_at TEXT,
  acknowledged_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  is_read INTEGER DEFAULT 0,
  is_silenced INTEGER DEFAULT 0,
  silenced_until TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_alert_history_alert_id ON alert_history_new(alert_id);
CREATE INDEX IF NOT EXISTS idx_alert_history_type ON alert_history_new(type);
CREATE INDEX IF NOT EXISTS idx_alert_history_severity ON alert_history_new(severity);
CREATE INDEX IF NOT EXISTS idx_alert_history_triggered ON alert_history_new(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_alert_history_status ON alert_history_new(status);
CREATE INDEX IF NOT EXISTS idx_alert_history_is_read ON alert_history_new(is_read);
CREATE INDEX IF NOT EXISTS idx_alert_history_cooldown ON alert_history_new(alert_id, status, triggered_at);

-- Copy existing data from old table (preserving is_read from 013_alert_is_read and deriving status)
INSERT INTO alert_history_new (
  id, alert_id, type, title, description, current_value, threshold,
  severity, status, triggered_at, resolved_at, acknowledged_at, acknowledged_by,
  is_read, metadata, created_at, updated_at
)
SELECT
  id, alert_id, type, title, description, current_value, threshold,
  severity,
  CASE
    WHEN resolved_at IS NOT NULL THEN 'resolved'
    WHEN acknowledged_at IS NOT NULL THEN 'acknowledged'
    ELSE 'active'
  END,
  triggered_at, resolved_at, acknowledged_at, acknowledged_by,
  COALESCE(is_read, 0), metadata, created_at, updated_at
FROM alert_history;

-- Drop views referencing alert_history before swapping the table (required by Cloudflare D1)
DROP VIEW IF EXISTS v_active_alerts;
DROP VIEW IF EXISTS v_alert_summary;

-- Drop old table and rename new
DROP TABLE alert_history;
ALTER TABLE alert_history_new RENAME TO alert_history;

-- ============================================================================
-- STEP 2: Create/Replace Triggers for auto-updating timestamps
-- ============================================================================

DROP TRIGGER IF EXISTS trg_alert_history_updated;

CREATE TRIGGER IF NOT EXISTS trg_alert_history_updated
AFTER UPDATE ON alert_history
FOR EACH ROW
BEGIN
  UPDATE alert_history SET updated_at = datetime('now') WHERE id = old.id;
END;

-- ============================================================================
-- STEP 3: Update views to include status column
-- ============================================================================

-- Recreate active alerts view with status-based filtering
DROP VIEW IF EXISTS v_active_alerts;

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
  resolved_at,
  status,
  TIMEDIFF(datetime('now'), triggered_at) as duration,
  is_read,
  is_silenced,
  silenced_until,
  metadata
FROM alert_history
WHERE status = 'active'
ORDER BY
  CASE severity
    WHEN 'critical' THEN 1
    WHEN 'warning' THEN 2
    ELSE 3
  END,
  triggered_at DESC;

-- Update alert summary view
DROP VIEW IF EXISTS v_alert_summary;

CREATE VIEW IF NOT EXISTS v_alert_summary AS
SELECT
  type,
  severity,
  COUNT(*) as total_alerts,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
  SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
  SUM(CASE WHEN status = 'acknowledged' THEN 1 ELSE 0 END) as acknowledged_count,
  MAX(triggered_at) as last_triggered,
  AVG(current_value) as avg_current_value
FROM alert_history
GROUP BY type, severity
ORDER BY total_alerts DESC;

-- ============================================================================
-- Migration completed successfully
-- ============================================================================

SELECT 'Alert history table updated for unified alert engine' as status;
