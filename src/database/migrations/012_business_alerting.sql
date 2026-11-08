-- ============================================================
-- Business Metrics Alerting System (Migration 012)
-- Monitors critical business KPIs and sends alerts when thresholds are breached
--
-- Alert Rules:
-- 1. Revenue drop >50% day-over-day (compared to 7-day moving average)
-- 2. Conversion rate <2%
-- 3. Webhook failures >10% (failure rate in last hour)
-- 4. Payout failures >5% (failed Stellar transactions)
-- 5. Stellar balance <100 USDC
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Business Alert Configurations Table
-- Stores alert rules and thresholds for business metrics
-- ============================================================

CREATE TABLE IF NOT EXISTS business_alert_configs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT,
  metric_type TEXT NOT NULL CHECK (metric_type IN (
    'revenue_drop',
    'conversion_rate',
    'webhook_failures',
    'payout_failures',
    'stellar_balance'
  )),
  -- Threshold configuration
  threshold_type TEXT NOT NULL CHECK (threshold_type IN ('gt', 'lt', 'gte', 'lte', 'eq', 'drop_pct')),
  threshold_value REAL NOT NULL,
  -- Comparison period for day-over-day metrics
  comparison_period_days INTEGER DEFAULT 1,
  -- Moving average window for revenue comparison
  moving_average_days INTEGER DEFAULT 7,
  -- Evaluation window (in minutes) - how far back to look
  evaluation_window_minutes INTEGER DEFAULT 60,
  -- Minimum data points required for evaluation
  min_data_points INTEGER DEFAULT 1,
  -- Severity level
  severity TEXT DEFAULT 'warning' CHECK (severity IN ('info', 'warning', 'critical')),
  -- Alert channels (JSON array: email, webhook, slack, telegram)
  alert_channels TEXT DEFAULT '["email"]',
  -- Cooldown period (minutes) to prevent alert spam
  cooldown_minutes INTEGER DEFAULT 15,
  -- Whether to include daily context in notifications
  include_context INTEGER DEFAULT 1,
  -- Status
  is_enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_business_alert_configs_enabled ON business_alert_configs(is_enabled);
CREATE INDEX IF NOT EXISTS idx_business_alert_configs_metric ON business_alert_configs(metric_type);

-- Insert default business alert configurations
INSERT OR IGNORE INTO business_alert_configs (id, name, description, metric_type, threshold_type, threshold_value, severity) VALUES
  ('alert-revenue-drop', 'Revenue Drop Alert', 'Triggers when daily revenue drops >50% compared to 7-day moving average', 'revenue_drop', 'drop_pct', 50, 'critical'),
  ('alert-conversion-rate', 'Low Conversion Rate', 'Triggers when conversion rate falls below 2%', 'conversion_rate', 'lt', 2, 'warning'),
  ('alert-webhook-failures', 'High Webhook Failure Rate', 'Triggers when webhook failure rate exceeds 10% in the last hour', 'webhook_failures', 'gt', 10, 'critical'),
  ('alert-payout-failures', 'High Payout Failure Rate', 'Triggers when payout failure rate exceeds 5%', 'payout_failures', 'gt', 5, 'critical'),
  ('alert-stellar-balance', 'Low Stellar USDC Balance', 'Triggers when Stellar wallet balance falls below 100 USDC', 'stellar_balance', 'lt', 100, 'critical');

-- ============================================================
-- STEP 2: Business Alert History Table
-- Tracks triggered business alerts and their resolution
-- ============================================================

CREATE TABLE IF NOT EXISTS business_alert_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  alert_config_id TEXT NOT NULL REFERENCES business_alert_configs(id),
  triggered_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT,
  -- Current value that triggered the alert
  current_value REAL NOT NULL,
  threshold_value REAL NOT NULL,
  -- Additional context (JSON with comparison data, trend, etc.)
  details TEXT DEFAULT '{}',
  -- Status: active, resolved, acknowledged
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'resolved', 'acknowledged')),
  -- Metadata (JSON with affected entities, links, etc.)
  metadata TEXT DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS idx_business_alert_history_triggered ON business_alert_history(triggered_at DESC);
CREATE INDEX IF NOT EXISTS idx_business_alert_history_config ON business_alert_history(alert_config_id);
CREATE INDEX IF NOT EXISTS idx_business_alert_history_status ON business_alert_history(status);
CREATE INDEX IF NOT EXISTS idx_business_alert_history_metric ON business_alert_history(
  json_extract(details, '$.metricType')
);

-- ============================================================
-- STEP 3: Alert Notification Log Table
-- Tracks sent notifications for audit trail
-- ============================================================

CREATE TABLE IF NOT EXISTS alert_notification_log (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  alert_history_id TEXT NOT NULL REFERENCES business_alert_history(id),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'webhook', 'slack', 'telegram')),
  recipient TEXT NOT NULL,
  -- Notification status
  status TEXT DEFAULT 'sent' CHECK (status IN ('pending', 'sent', 'failed', 'retrying')),
  -- Response from notification service
  response TEXT,
  -- Number of attempts
  attempts INTEGER DEFAULT 1,
  -- Timestamps
  sent_at TEXT,
  delivered_at TEXT,
  failed_at TEXT,
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_notification_log_alert ON alert_notification_log(alert_history_id);
CREATE INDEX IF NOT EXISTS idx_notification_log_channel ON alert_notification_log(channel);
CREATE INDEX IF NOT EXISTS idx_notification_log_status ON alert_notification_log(status);
CREATE INDEX IF NOT EXISTS idx_notification_log_sent ON alert_notification_log(sent_at DESC);

-- ============================================================
-- STEP 4: Webhook Failure Tracking Table
-- Tracks webhook delivery attempts and outcomes
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_failure_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  webhook_type TEXT NOT NULL, -- 'exchange', 'polar', 'resend', etc.
  endpoint_path TEXT NOT NULL,
  -- Failure counts
  total_attempts INTEGER DEFAULT 0,
  successful_attempts INTEGER DEFAULT 0,
  failed_attempts INTEGER DEFAULT 0,
  -- Failure reasons (JSON array)
  failure_reasons TEXT DEFAULT '[]',
  -- Time window for stats
  window_start TEXT NOT NULL, -- Start of evaluation window
  window_end TEXT NOT NULL, -- End of evaluation window
  -- Last update
  last_attempt_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webhook_failure_type ON webhook_failure_stats(webhook_type);
CREATE INDEX IF NOT EXISTS idx_webhook_failure_window ON webhook_failure_stats(window_start, window_end);
CREATE INDEX IF NOT EXISTS idx_webhook_failure_window_end ON webhook_failure_stats(window_end);
CREATE INDEX IF NOT EXISTS idx_webhook_failure_updated ON webhook_failure_stats(updated_at DESC);

-- ============================================================
-- STEP 5: Payout Failure Tracking Table
-- Tracks Stellar payout transaction outcomes
-- ============================================================

CREATE TABLE IF NOT EXISTS payout_failure_stats (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  -- Period for aggregation
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  -- Payout stats
  total_payouts INTEGER DEFAULT 0,
  successful_payouts INTEGER DEFAULT 0,
  failed_payouts INTEGER DEFAULT 0,
  -- Failure breakdown (JSON: { "insufficient_balance": 2, "network_error": 1 })
  failure_breakdown TEXT DEFAULT '{}',
  -- Total amount attempted
  total_amount_usdc REAL DEFAULT 0,
  successful_amount_usdc REAL DEFAULT 0,
  failed_amount_usdc REAL DEFAULT 0,
  -- Last update
  last_payout_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payout_failure_period ON payout_failure_stats(period_start, period_end);
CREATE INDEX IF NOT EXISTS idx_payout_failure_updated ON payout_failure_stats(updated_at DESC);

-- ============================================================
-- STEP 6: Stellar Balance History Table
-- Tracks Stellar wallet balance over time
-- ============================================================

CREATE TABLE IF NOT EXISTS stellar_balance_history (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  balance_usdc REAL NOT NULL,
  balance_native INTEGER NOT NULL, -- XLM balance (stroops)
  -- Wallet info
  wallet_address TEXT NOT NULL,
  network TEXT NOT NULL CHECK (network IN ('testnet', 'mainnet')),
  -- Sequence number for transaction prevention
  sequence_number INTEGER,
  -- Last transaction hash
  last_transaction_hash TEXT,
  -- Recorded timestamp
  recorded_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_stellar_balance_recorded ON stellar_balance_history(recorded_at DESC);
CREATE INDEX IF NOT EXISTS idx_stellar_balance_wallet ON stellar_balance_history(wallet_address, network);
CREATE INDEX IF NOT EXISTS idx_stellar_balance_low ON stellar_balance_history(balance_usdc) WHERE balance_usdc < 100;

-- ============================================================
-- STEP 7: Alert Aggregation Views
-- ============================================================

-- Current business alerts summary view
CREATE VIEW IF NOT EXISTS v_business_alerts_summary AS
SELECT
  c.name,
  c.description,
  c.metric_type,
  c.severity,
  c.threshold_type,
  c.threshold_value,
  COUNT(h.id) as total_triggered,
  SUM(CASE WHEN h.status = 'active' THEN 1 ELSE 0 END) as active_count,
  SUM(CASE WHEN h.status = 'resolved' THEN 1 ELSE 0 END) as resolved_count,
  MAX(h.triggered_at) as last_triggered
FROM business_alert_configs c
LEFT JOIN business_alert_history h ON h.alert_config_id = c.id
GROUP BY c.id, c.name, c.description, c.metric_type, c.severity, c.threshold_type, c.threshold_value
ORDER BY
  CASE c.severity
    WHEN 'critical' THEN 1
    WHEN 'warning' THEN 2
    WHEN 'info' THEN 3
    ELSE 4
  END,
  c.name;

-- Active business alerts view
CREATE VIEW IF NOT EXISTS v_active_business_alerts AS
SELECT
  h.id,
  h.alert_config_id,
  c.name as alert_name,
  c.description,
  c.metric_type,
  c.severity,
  c.alert_channels,
  h.current_value,
  h.threshold_value,
  h.triggered_at,
  (julianday('now') - julianday(h.triggered_at)) * 24 * 60 as minutes_active,
  h.details,
  h.metadata
FROM business_alert_history h
JOIN business_alert_configs c ON h.alert_config_id = c.id
WHERE h.status = 'active'
ORDER BY
  CASE c.severity
    WHEN 'critical' THEN 1
    WHEN 'warning' THEN 2
    ELSE 3
  END,
  h.triggered_at DESC;

-- Recent alert history view (last 7 days)
CREATE VIEW IF NOT EXISTS v_recent_business_alerts AS
SELECT
  h.id,
  h.alert_config_id,
  c.name as alert_name,
  c.metric_type,
  c.severity,
  h.current_value,
  h.threshold_value,
  h.triggered_at,
  h.resolved_at,
  h.status,
  (julianday(h.resolved_at) - julianday(h.triggered_at)) * 24 * 60 as resolution_time_minutes
FROM business_alert_history h
JOIN business_alert_configs c ON h.alert_config_id = c.id
WHERE h.triggered_at >= datetime('now', '-7 days')
ORDER BY h.triggered_at DESC;

-- ============================================================
-- STEP 8: Notification Delivery Status View
-- ============================================================

CREATE VIEW IF NOT EXISTS v_alert_notification_status AS
SELECT
  h.id as alert_id,
  h.alert_config_id,
  c.name as alert_name,
  c.severity,
  nl.channel,
  nl.recipient,
  nl.status as notification_status,
  nl.sent_at,
  nl.delivered_at,
  nl.error_message,
  nl.attempts
FROM business_alert_history h
JOIN alert_notification_log nl ON nl.alert_history_id = h.id
JOIN business_alert_configs c ON h.alert_config_id = c.id
WHERE h.triggered_at >= datetime('now', '-24 hours')
ORDER BY h.triggered_at DESC, nl.sent_at DESC;

-- ============================================================
-- STEP 9: Create Triggers for Auto-updating Timestamps
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_business_alert_configs_updated
AFTER UPDATE ON business_alert_configs
FOR EACH ROW
BEGIN
  UPDATE business_alert_configs SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_webhook_failure_stats_updated
AFTER UPDATE ON webhook_failure_stats
FOR EACH ROW
BEGIN
  UPDATE webhook_failure_stats SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_failure_stats_updated
AFTER UPDATE ON payout_failure_stats
FOR EACH ROW
BEGIN
  UPDATE payout_failure_stats SET updated_at = datetime('now') WHERE id = old.id;
END;

-- ============================================================
-- Migration completed successfully
-- ============================================================

-- Verify tables created
SELECT 'Business Alerting tables and views created successfully' as status;
