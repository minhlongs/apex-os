-- ============================================================
-- Dead Letter Queue for Notification Dispatcher (Migration 006)
-- Stores failed notification attempts for retry and analysis
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Dead Letter Queue Table
-- ============================================================

CREATE TABLE IF NOT EXISTS dead_letter_queue (
  -- Unique entry ID
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

  -- Original dispatch job ID (for tracing)
  job_id TEXT NOT NULL,

  -- Associated alert ID (links to alerts table)
  alert_id TEXT REFERENCES alerts(id) ON DELETE SET NULL,

  -- Notification channel that failed
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack', 'telegram', 'webhook', 'console')),

  -- Full payload that was attempted
  payload TEXT NOT NULL DEFAULT '{}',

  -- Error message from the failure
  error TEXT NOT NULL,

  -- Number of attempts made before DLQ
  attempts INTEGER DEFAULT 1,

  -- Maximum allowed retries (stored for reference)
  max_attempts INTEGER DEFAULT 3,

  -- When this entry was created
  created_at TEXT DEFAULT (datetime('now')),

  -- When the job actually failed
  failed_at TEXT DEFAULT (datetime('now')),

  -- When this entry should be retried (null means no more retries)
  next_retry_at TEXT,

  -- Optional: reason for final dead letter (e.g., 'max_attempts_exceeded', 'invalid_payload')
  dead_letter_reason TEXT,

  -- Optional: admin notes for manual investigation
  admin_notes TEXT
);

-- Indexes for efficient queries
CREATE INDEX IF NOT EXISTS idx_dlq_created ON dead_letter_queue(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_failed_at ON dead_letter_queue(failed_at DESC);
CREATE INDEX IF NOT EXISTS idx_dlq_next_retry ON dead_letter_queue(next_retry_at);
CREATE INDEX IF NOT EXISTS idx_dlq_alert_id ON dead_letter_queue(alert_id);
CREATE INDEX IF NOT EXISTS idx_dlq_channel ON dead_letter_queue(channel);
CREATE INDEX IF NOT EXISTS idx_dlq_job_id ON dead_letter_queue(job_id);

-- ============================================================
-- STEP 2: Dispatcher Statistics Table (optional aggregation)
-- ============================================================

CREATE TABLE IF NOT EXISTS dispatcher_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

  -- Time window (hourly, daily, etc.)
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,

  -- Processing statistics
  total_jobs_processed INTEGER DEFAULT 0,
  successful_jobs INTEGER DEFAULT 0,
  failed_jobs INTEGER DEFAULT 0,
  dead_letters_created INTEGER DEFAULT 0,
  batches_processed INTEGER DEFAULT 0,

  -- Performance metrics
  avg_processing_time_ms REAL,
  max_processing_time_ms REAL,
  min_processing_time_ms REAL,

  -- Breakdown by channel
  channel_breakdown TEXT DEFAULT '{}',  -- JSON: { "email": 100, "slack": 50 }

  -- Created automatically
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_dispatcher_stats_period ON dispatcher_stats(period_start, period_end);

-- ============================================================
-- STEP 3: Retry History Table (for audit trail)
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_retry_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

  -- Reference to dead letter entry (if applicable)
  dead_letter_id TEXT REFERENCES dead_letter_queue(id) ON DELETE SET NULL,

  -- Job ID being retried
  job_id TEXT NOT NULL,

  -- Attempt number (1, 2, 3, ...)
  attempt_number INTEGER NOT NULL,

  -- Error encountered (if failed)
  error TEXT,

  -- Timestamps
  attempted_at TEXT DEFAULT (datetime('now')),

  -- Outcome
  success INTEGER DEFAULT 0  -- 0 = failed, 1 = succeeded
);

CREATE INDEX IF NOT EXISTS idx_retry_history_job ON notification_retry_history(job_id);
CREATE INDEX IF NOT EXISTS idx_retry_history_dlq ON notification_retry_history(dead_letter_id);
CREATE INDEX IF NOT EXISTS idx_retry_history_attempted ON notification_retry_history(attempted_at DESC);

-- ============================================================
-- STEP 4: Triggers for Auto-cleanup and Stats Aggregation
-- ============================================================

-- Trigger: Update dispatcher stats when a job is processed
-- This would be called from the application code, not automatically

-- ============================================================
-- STEP 5: Views for Monitoring
-- ============================================================

-- View: Dead letter summary by channel and reason
CREATE VIEW IF NOT EXISTS v_dead_letter_summary AS
SELECT
  channel,
  dead_letter_reason,
  COUNT(*) as count,
  AVG(attempts) as avg_attempts,
  MIN(created_at) as earliest,
  MAX(created_at) as latest
FROM dead_letter_queue
GROUP BY channel, dead_letter_reason
ORDER BY count DESC;

-- View: Recent failed notifications (last 24 hours)
CREATE VIEW IF NOT EXISTS v_recent_dead_letters AS
SELECT
  dlq.*,
  a.rule_name as alert_name,
  a.severity as alert_severity
FROM dead_letter_queue dlq
LEFT JOIN alerts a ON dlq.alert_id = a.id
WHERE dlq.created_at >= datetime('now', '-24 hours')
ORDER BY dlq.created_at DESC;

-- View: Retry success rate
CREATE VIEW IF NOT EXISTS v_retry_metrics AS
SELECT
  job_id,
  COUNT(*) as total_attempts,
  MAX(CASE WHEN success = 1 THEN 1 ELSE 0 END) as succeeded,
  MAX(error) as last_error
FROM notification_retry_history
GROUP BY job_id
HAVING total_attempts > 1;

-- ============================================================
-- Migration completed successfully
-- ============================================================
