-- ============================================================
-- Migration 012: Alert Snooze/Silence System
-- Allows temporary silencing of specific alert configurations
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Alert Snoozes Table
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_snoozes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  alert_config_id TEXT NOT NULL REFERENCES d1_alert_configs(id) ON DELETE CASCADE,
  -- Who snoozed the alert (null = system/auto-snooze)
  snoozed_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  -- Duration in minutes (60=1h, 360=6h, 1440=24h)
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  -- When the snooze was created
  created_at TEXT DEFAULT (datetime('now')),
  -- When the snooze expires (computed)
  expires_at TEXT GENERATED ALWAYS AS (
    datetime(created_at, '+' || duration_minutes || ' minutes')
  ) VIRTUAL,
  -- Reason for snoozing (optional, for audit trail)
  reason TEXT,
  -- Metadata (e.g., auto-snooze flags, recurrence info)
  metadata TEXT DEFAULT '{}',
  -- Indexes
  FOREIGN KEY (alert_config_id) REFERENCES d1_alert_configs(id) ON DELETE CASCADE
);

-- Indexes for efficient querying
CREATE INDEX IF NOT EXISTS idx_alert_snoozes_config ON alert_snoozes(alert_config_id);
CREATE INDEX IF NOT EXISTS idx_alert_snoozes_expires ON alert_snoozes(expires_at);
CREATE INDEX IF NOT EXISTS idx_alert_snoozes_snoozed_by ON alert_snoozes(snoozed_by);

-- ============================================================
-- STEP 2: Useful Views
-- ============================================================

-- Active snoozes view (not expired)
CREATE VIEW IF NOT EXISTS v_active_snoozes AS
SELECT
  s.id as snooze_id,
  s.alert_config_id,
  c.name as alert_config_name,
  c.metric_type,
  s.snoozed_by,
  p.full_name as snoozed_by_name,
  s.duration_minutes,
  s.created_at,
  s.expires_at,
  julianday(s.expires_at) - julianday('now') as hours_remaining,
  s.reason,
  CASE
    WHEN julianday(s.expires_at) - julianday('now') <= 0 THEN 'expired'
    WHEN julianday(s.expires_at) - julianday('now') < 1 THEN 'expiring_soon'
    ELSE 'active'
  END as status
FROM alert_snoozes s
JOIN d1_alert_configs c ON s.alert_config_id = c.id
LEFT JOIN profiles p ON s.snoozed_by = p.id
WHERE julianday(s.expires_at) > julianday('now');

-- Snooze history view (all snoozes including expired)
CREATE VIEW IF NOT EXISTS v_snooze_history AS
SELECT
  s.id,
  s.alert_config_id,
  c.name as alert_config_name,
  c.metric_type,
  s.snoozed_by,
  p.full_name as snoozed_by_name,
  s.duration_minutes,
  s.created_at,
  s.expires_at,
  s.reason,
  CASE
    WHEN julianday(s.expires_at) > julianday('now') THEN 'active'
    ELSE 'expired'
  END as status,
  (julianday(s.expires_at) - julianday(s.created_at)) * 24 as duration_hours
FROM alert_snoozes s
JOIN d1_alert_configs c ON s.alert_config_id = c.id
LEFT JOIN profiles p ON s.snoozed_by = p.id
ORDER BY s.created_at DESC;

-- ============================================================
-- STEP 3: Helper Functions (via Triggers for cleanup)
-- ============================================================

-- Note: SQLite doesn't support stored functions. Cleanup of expired snoozes
-- should be done via a scheduled cron job or on-demand via API:
-- DELETE FROM alert_snoozes WHERE expires_at <= datetime('now');

-- Create a trigger to log snooze activity (optional audit trail)
-- This could be extended to insert into a separate audit_log table

-- ============================================================
-- Migration completed successfully
-- ============================================================
