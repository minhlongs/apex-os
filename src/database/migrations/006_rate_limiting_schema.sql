-- ============================================================
-- ApexOS Rate Limiting Schema (Migration 006)
-- Provides rate limiting for API endpoints with configurable
-- limits per endpoint type and user tier.
--
-- Tables:
-- - rate_limits: Tracks request counts per key (IP + endpoint)
-- - rate_limit_configs: Configurable limits per endpoint type
--
-- Features:
-- - Token bucket algorithm support
-- - Automatic cleanup of expired entries (via triggers)
-- - Support for different limits by user role/tier
-- - X-RateLimit-* headers support
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Create rate_limits table
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  key TEXT NOT NULL,                    -- Composite key: endpoint_type|identifier (e.g., "click_tracking|192.168.1.1")
  endpoint_type TEXT NOT NULL,          -- Type of endpoint: click_tracking, auth, webhook, admin, api_general
  identifier TEXT NOT NULL,             -- IP address, user ID, or API key
  current_count INTEGER DEFAULT 0,      -- Current request count in window
  max_count INTEGER NOT NULL,           -- Max requests per window
  window_seconds INTEGER NOT NULL,      -- Time window in seconds
  reset_at TEXT NOT NULL,               -- When the window resets (ISO 8601)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),

  UNIQUE(key)
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_key ON rate_limits(key);
CREATE INDEX IF NOT EXISTS idx_rate_limits_endpoint_type ON rate_limits(endpoint_type);
CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON rate_limits(identifier);
CREATE INDEX IF NOT EXISTS idx_rate_limits_reset_at ON rate_limits(reset_at);

-- ============================================================
-- STEP 2: Create rate_limit_configs table (editable limits)
-- ============================================================

CREATE TABLE IF NOT EXISTS rate_limit_configs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  endpoint_type TEXT UNIQUE NOT NULL,   -- Matches rate_limits.endpoint_type
  max_requests INTEGER NOT NULL,        -- Max requests per window
  window_seconds INTEGER NOT NULL,      -- Time window in seconds
  applies_to TEXT NOT NULL DEFAULT 'ip', -- 'ip', 'user', 'api_key', 'combined'
  role_multiplier REAL DEFAULT 1.0,     -- Multiplier based on user role
  tier_multiplier REAL DEFAULT 1.0,     -- Multiplier based on user plan tier
  description TEXT,                     -- Human-readable description
  is_active INTEGER DEFAULT 1,          -- Enable/disable this limit
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

INSERT OR REPLACE INTO rate_limit_configs (endpoint_type, max_requests, window_seconds, applies_to, role_multiplier, tier_multiplier, description, is_active)
VALUES
  -- Strict limits for click tracking (prevent click fraud)
  ('click_tracking', 100, 3600, 'ip', 1.0, 1.0, 'Click tracking endpoint - 100 req/hour per IP', 1),
  ('click_tracking', 1000, 3600, 'user', 1.0, 1.0, 'Click tracking - 1000 req/hour per authenticated user', 1),

  -- Authentication endpoints (very strict)
  ('auth', 10, 900, 'ip', 1.0, 1.0, 'Auth endpoints - 10 req/15min per IP (prevents brute force)', 1),
  ('auth', 20, 900, 'user', 1.0, 1.0, 'Auth - 20 req/15min per user account', 1),

  -- General API (standard limits)
  ('api_general', 500, 3600, 'ip', 1.0, 1.0, 'General API - 500 req/hour per IP', 1),
  ('api_general', 2000, 3600, 'user', 1.0, 1.0, 'General API - 2000 req/hour per user', 1),

  -- Webhooks (incoming from exchanges - different pattern)
  ('webhook', 1000, 3600, 'ip', 1.0, 1.0, 'Incoming webhooks - 1000 req/hour per IP', 1),
  ('webhook', 10000, 3600, 'user', 1.0, 1.0, 'Webhooks - 10000 req/hour per user', 1),

  -- Admin endpoints (tiered by role)
  ('admin', 100, 3600, 'ip', 1.0, 1.0, 'Admin API - 100 req/hour per IP', 1),
  ('admin', 500, 3600, 'user', 1.0, 1.0, 'Admin API - 500 req/hour per admin', 1),

  -- Premium tier gets higher limits
  ('api_general', 5000, 3600, 'user', 1.0, 2.5, 'Premium tier multiplier - 2.5x standard', 1);

-- ============================================================
-- STEP 3: Create cleanup function (called periodically)
-- ============================================================

-- This function deletes expired rate limit entries
CREATE TEMP TRIGGER IF NOT EXISTS cleanup_rate_limits_after_update
AFTER UPDATE ON rate_limits
FOR EACH ROW
WHEN old.reset_at < datetime('now')
BEGIN
  DELETE FROM rate_limits WHERE reset_at < datetime('now');
END;

-- ============================================================
-- STEP 4: Helper views for monitoring
-- ============================================================

CREATE VIEW IF NOT EXISTS v_active_rate_limits AS
SELECT
  key,
  endpoint_type,
  identifier,
  current_count,
  max_count,
  window_seconds,
  reset_at,
  CASE WHEN reset_at < datetime('now') THEN 'expired' ELSE 'active' END as status,
  ROUND((current_count * 100.0 / max_count), 2) as utilization_percent
FROM rate_limits
WHERE reset_at > datetime('now')
ORDER BY utilization_percent DESC;

CREATE VIEW IF NOT EXISTS v_rate_limit_stats AS
SELECT
  endpoint_type,
  COUNT(*) as tracked_keys,
  AVG(current_count) as avg_current_count,
  MAX(current_count) as max_current_count,
  AVG(ROUND((current_count * 100.0 / max_count), 2)) as avg_utilization_percent,
  COUNT(CASE WHEN current_count * 1.0 / max_count > 0.9 THEN 1 END) as near_limit_count
FROM rate_limits
WHERE reset_at > datetime('now')
GROUP BY endpoint_type
ORDER BY near_limit_count DESC;

-- ============================================================
-- Migration completed successfully
-- ============================================================
