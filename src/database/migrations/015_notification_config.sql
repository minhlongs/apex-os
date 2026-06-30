-- ============================================================
-- Notification Configuration Table (Migration 015)
--
-- Stores admin-configured notification channel settings
-- Encrypted storage for sensitive data (webhook URLs, API keys, bot tokens)
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- NOTIFICATION_CONFIG TABLE
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_config (
  -- UUID primary key (single row for all config)
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),

  -- Channel type: slack, email, telegram
  channel_type TEXT NOT NULL CHECK (channel_type IN ('slack', 'email', 'telegram')),

  -- Whether this channel is enabled
  enabled INTEGER NOT NULL DEFAULT 0,

  -- Encrypted configuration JSON (channel-specific settings)
  -- For slack: { webhookUrl, channel, username, iconEmoji, iconUrl }
  -- For email: { apiKey, fromEmail, fromName, defaultRecipients[], replyTo }
  -- For telegram: { botToken, chatIds[], parseMode, disableWebPagePreview }
  config_encrypted TEXT NOT NULL,

  -- Unencrypted non-sensitive config (for quick queries)
  config_public TEXT, -- JSON with enabled status, channel names, recipient count, etc.

  -- Audit fields
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  -- Version for optimistic locking
  version INTEGER NOT NULL DEFAULT 1
);

-- Unique constraint: one config per channel type
CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_config_channel
  ON notification_config(channel_type);

-- Index for querying enabled channels
CREATE INDEX IF NOT EXISTS idx_notification_config_enabled
  ON notification_config(enabled);

-- Index for updated_at (for cache invalidation)
CREATE INDEX IF NOT EXISTS idx_notification_config_updated
  ON notification_config(updated_at DESC);

-- ============================================================
-- TRIGGERS
-- ============================================================

-- Auto-update updated_at on row modification
CREATE TRIGGER IF NOT EXISTS trg_notification_config_updated_at
AFTER UPDATE ON notification_config
FOR EACH ROW
BEGIN
  UPDATE notification_config
  SET updated_at = datetime('now')
  WHERE id = NEW.id;
END;

-- ============================================================
-- VIEWS
-- ============================================================

-- Active channels view (for quick lookup)
CREATE VIEW IF NOT EXISTS v_active_notification_channels AS
SELECT
  channel_type,
  enabled,
  json_extract(config_public, '$.displayName') as display_name,
  json_extract(config_public, '$.recipientCount') as recipient_count,
  updated_at
FROM notification_config
WHERE enabled = 1
ORDER BY channel_type;

-- ============================================================
-- MIGRATION COMPLETION
-- ============================================================

SELECT 'Notification configuration table created successfully' as status;
