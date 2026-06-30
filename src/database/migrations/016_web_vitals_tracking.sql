-- ============================================================
-- Web Vitals Tracking (Migration 016)
-- Adds web_vitals table and indexes for performance monitoring
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================
-- WEB VITALS TABLE
-- ============================================
-- Stores Core Web Vitals metrics collected from client-side reporting
-- Metrics: LCP, FID, CLS, FCP, TTFB
--
-- Usage:
-- - Client sends metrics via POST /api/analytics/web-vitals
-- - Dashboard aggregates for performance monitoring
-- - Alerts can be configured for threshold breaches
-- ============================================

CREATE TABLE IF NOT EXISTS web_vitals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL CHECK (name IN ('LCP', 'FID', 'CLS', 'FCP', 'TTFB')),
  value REAL NOT NULL,
  rating TEXT NOT NULL CHECK (rating IN ('good', 'needs-improvement', 'poor')),
  delta REAL NOT NULL,
  metric_id TEXT NOT NULL,
  navigation_type TEXT,
  url TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for fast querying

CREATE INDEX IF NOT EXISTS idx_web_vitals_created ON web_vitals(created_at);
CREATE INDEX IF NOT EXISTS idx_web_vitals_name ON web_vitals(name);
CREATE INDEX IF NOT EXISTS idx_web_vitals_date_metric ON web_vitals(date(created_at), name);
CREATE INDEX IF NOT EXISTS idx_web_vitals_url ON web_vitals(url);
CREATE INDEX IF NOT EXISTS idx_web_vitals_rating_value ON web_vitals(rating, value);

-- Migration completed
SELECT 'Migration 016: Web Vitals tracking table created' as status;
