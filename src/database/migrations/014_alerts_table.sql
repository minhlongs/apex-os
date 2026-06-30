-- ============================================================
-- Alerts Table (Migration 014)
--
-- Unified alert storage for all alert types (business, D1, custom)
-- Schema: id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- ALERTS TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS alerts (
  -- UUID primary key
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

  -- Which rule/config triggered this alert (references alert_rules or business_alert_configs)
  rule_id TEXT NOT NULL,

  -- Severity level: info, warning, critical
  severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'critical')),

  -- Human-readable alert message
  message TEXT NOT NULL,

  -- When the alert was triggered
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- When the alert was resolved (NULL if still active)
  resolved_at TEXT,

  -- Snooze expiration time (NULL if not snoozed)
  snoozed_until TEXT,

  -- Additional context as JSON (metric values, affected entities, etc.)
  context TEXT DEFAULT '{}',

  -- Alert status derived from resolved_at/snoozed_until: active, resolved, snoozed
  status TEXT GENERATED ALWAYS AS (
    CASE
      WHEN snoozed_until > datetime('now') THEN 'snoozed'
      WHEN resolved_at IS NOT NULL THEN 'resolved'
      ELSE 'active'
    END
  ) STORED
);

-- ============================================================
-- INDEXES FOR QUERYING
-- ============================================================

-- Find active alerts quickly
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status);

-- Query by rule/rule_id (for specific alert type)
CREATE INDEX IF NOT EXISTS idx_alerts_rule_id ON alerts(rule_id);

-- Query by severity for prioritization
CREATE INDEX IF NOT EXISTS idx_alerts_severity ON alerts(severity);

-- Time-based queries: recent alerts, alert history
CREATE INDEX IF NOT EXISTS idx_alerts_triggered_at ON alerts(triggered_at DESC);

-- Resolution tracking
CREATE INDEX IF NOT EXISTS idx_alerts_resolved_at ON alerts(resolved_at);

-- Snooze management: find expired snoozes for cleanup
CREATE INDEX IF NOT EXISTS idx_alerts_snoozed_until ON alerts(snoozed_until);

-- Composite index for common admin dashboard query: active alerts by severity
CREATE INDEX IF NOT EXISTS idx_alerts_status_severity_triggered ON alerts(status, severity, triggered_at DESC);

-- Composite index for rule-specific history queries
CREATE INDEX IF NOT EXISTS idx_alerts_rule_id_triggered ON alerts(rule_id, triggered_at DESC);

-- Composite index for retention cleanup (old resolved alerts)
CREATE INDEX IF NOT EXISTS idx_alerts_resolved_triggered ON alerts(resolved_at, triggered_at DESC);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update resolved_at when status changes to resolved (for manual updates)
CREATE TRIGGER IF NOT EXISTS trg_alerts_set_resolved_at
AFTER UPDATE OF status ON alerts
FOR EACH ROW
WHEN new.status = 'resolved' AND old.status != 'resolved' AND new.resolved_at IS NULL
BEGIN
  UPDATE alerts SET resolved_at = datetime('now') WHERE id = new.id;
END;

-- ============================================================
-- VIEWS
-- ============================================================

-- Active alerts view (excludes snoozed unless explicitly requested)
CREATE VIEW IF NOT EXISTS v_active_alerts AS
SELECT
  a.*,
  COALESCE(ar.name, bac.name) as rule_name,
  COALESCE(ar.source, 'business') as source,
  COALESCE(ar.metric_type, bac.metric_type) as metric_type,
  (julianday('now') - julianday(a.triggered_at)) * 24 * 60 as minutes_active
FROM alerts a
LEFT JOIN alert_rules ar ON a.rule_id = ar.id
LEFT JOIN business_alert_configs bac ON a.rule_id = bac.id
WHERE a.status = 'active'
ORDER BY
  CASE a.severity
    WHEN 'critical' THEN 1
    WHEN 'warning' THEN 2
    WHEN 'info' THEN 3
    ELSE 4
  END,
  a.triggered_at DESC;

-- Alert history view (resolved alerts, last 90 days)
CREATE VIEW IF NOT EXISTS v_alert_history AS
SELECT
  a.*,
  COALESCE(ar.name, bac.name) as rule_name,
  COALESCE(ar.source, 'business') as source,
  COALESCE(ar.metric_type, bac.metric_type) as metric_type,
  (julianday(a.resolved_at) - julianday(a.triggered_at)) * 24 * 60 as resolution_time_minutes
FROM alerts a
LEFT JOIN alert_rules ar ON a.rule_id = ar.id
LEFT JOIN business_alert_configs bac ON a.rule_id = bac.id
WHERE a.status = 'resolved'
  AND a.triggered_at >= datetime('now', '-90 days')
ORDER BY a.triggered_at DESC;

-- Alert statistics view
CREATE VIEW IF NOT EXISTS v_alert_statistics AS
SELECT
  rule_id,
  severity,
  COUNT(*) as total_triggered,
  SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) as active_count,
  SUM(CASE WHEN status = 'snoozed' THEN 1 ELSE 0 END) as snoozed_count,
  SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
  AVG(CASE WHEN status = 'resolved' THEN
    (julianday(resolved_at) - julianday(triggered_at)) * 24 * 60
  END) as avg_resolution_time_minutes,
  MIN(triggered_at) as first_triggered,
  MAX(triggered_at) as last_triggered
FROM alerts
WHERE triggered_at >= datetime('now', '-30 days')
GROUP BY rule_id, severity
ORDER BY total_triggered DESC;

-- ============================================================
-- Migration completed successfully
-- ============================================================

SELECT 'Alerts table and indexes created successfully' as status;
