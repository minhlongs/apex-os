-- Migration 032: Persistent D1 Rate Limits for Auth, UID-Binding, and Short-Link Endpoints (F-03)
-- Created: 2026-11-18
-- Ensures atomic, isolate-restart-proof SQLite/D1 rate limiting across Cloudflare Worker isolates.

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL UNIQUE,
  endpoint_type TEXT NOT NULL,
  identifier TEXT NOT NULL,
  current_count INTEGER NOT NULL DEFAULT 0,
  max_count INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  reset_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);
CREATE INDEX IF NOT EXISTS idx_rate_limits_endpoint_identifier ON rate_limits(endpoint_type, identifier);

CREATE TABLE IF NOT EXISTS rate_limit_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_type TEXT NOT NULL UNIQUE,
  max_requests INTEGER NOT NULL,
  window_seconds INTEGER NOT NULL,
  description TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO rate_limit_configs (endpoint_type, max_requests, window_seconds, description) VALUES
  ('auth_ip', 10, 60, 'Better Auth credential/recovery requests per IP per minute'),
  ('auth_account', 5, 60, 'Better Auth credential/recovery requests per account email per minute'),
  ('auth_telegram_ip', 15, 60, 'Telegram Mini App authentication requests per IP per minute'),
  ('auth_passkey_ip', 15, 60, 'Admin WebAuthn passkey & runtime flag mutations per IP per minute'),
  ('auth_passkey_user', 10, 60, 'Admin WebAuthn passkey & runtime flag mutations per admin per minute'),
  ('uid_bind_user', 10, 60, 'Affiliate exchange UID binding mutations per user per minute'),
  ('uid_bind_ip', 20, 60, 'Affiliate exchange UID binding mutations per IP per minute'),
  ('uid_delete_user', 15, 60, 'Affiliate exchange UID unbind mutations per user per minute'),
  ('short_link_redirect_ip', 30, 60, 'Public /r/[code] clean-room short-link resolution per IP per minute'),
  ('short_link_create_user', 15, 60, 'Affiliate short-link creation per user per minute'),
  ('short_link_create_ip', 30, 60, 'Affiliate short-link creation per IP per minute'),
  ('short_link_mutate_user', 30, 60, 'Affiliate short-link status toggle per user per minute');
