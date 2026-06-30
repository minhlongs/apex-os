-- ============================================================
-- Email Queue & Events (Migration 018)
-- Email queue for batch sending + event tracking from Resend
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- Email Queue Table
-- ============================================================

DROP TRIGGER IF EXISTS trg_email_queue_updated;
DROP INDEX IF EXISTS idx_email_queue_status_scheduled;
DROP INDEX IF EXISTS idx_email_queue_user;
DROP INDEX IF EXISTS idx_email_queue_type;
DROP TABLE IF EXISTS email_queue;

CREATE TABLE email_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  error TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_email_queue_status_scheduled
  ON email_queue(status, scheduled_at);
CREATE INDEX idx_email_queue_user
  ON email_queue(user_id);
CREATE INDEX idx_email_queue_type
  ON email_queue(type);

-- Auto-update updated_at
CREATE TRIGGER trg_email_queue_updated
AFTER UPDATE ON email_queue
FOR EACH ROW
BEGIN
  UPDATE email_queue SET updated_at = datetime('now') WHERE id = NEW.id;
END;

-- ============================================================
-- Email Events Table
-- Tracks bounce, delivered, opened, clicked events from Resend
-- ============================================================

DROP TRIGGER IF EXISTS trg_email_events_updated;
DROP INDEX IF EXISTS idx_email_events_queue_id;
DROP INDEX IF EXISTS idx_email_events_type;
DROP INDEX IF EXISTS idx_email_events_created;
DROP TABLE IF EXISTS email_events;

CREATE TABLE email_events (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  email TEXT NOT NULL,
  resend_id TEXT,
  reason TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (queue_id) REFERENCES email_queue(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_events_queue_id
  ON email_events(queue_id);
CREATE INDEX idx_email_events_type
  ON email_events(event_type);
CREATE INDEX idx_email_events_created
  ON email_events(created_at);

-- Auto-update updated_at
CREATE TRIGGER trg_email_events_updated
AFTER UPDATE ON email_events
FOR EACH ROW
BEGIN
  UPDATE email_events SET created_at = created_at WHERE id = NEW.id;
END;

-- ============================================================
-- Migration completed
-- ============================================================
SELECT 'email_queue and email_events tables created' AS status;
