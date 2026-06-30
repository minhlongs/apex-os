-- ============================================================
-- Migration 013: Add is_read to alert_history
-- Tracks whether an admin has viewed an alert
-- ============================================================

PRAGMA foreign_keys = ON;

-- Add is_read column to alert_history
ALTER TABLE alert_history ADD COLUMN is_read INTEGER DEFAULT 0;

-- Index for efficient querying of unread alerts
CREATE INDEX IF NOT EXISTS idx_alert_history_is_read ON alert_history(is_read);

-- Migration completed successfully
-- ============================================================
