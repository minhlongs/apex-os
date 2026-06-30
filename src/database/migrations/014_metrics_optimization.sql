-- ============================================================
-- Metrics Performance Optimization (Migration 014)
-- Optimizes Business Metrics and Time-Series API response times
--
-- This migration adds:
-- 1. Pre-aggregated daily summary tables (materialized, refreshed periodically)
-- 2. Composite indexes for time-series queries
-- 3. Covering indexes for common query patterns
-- 4. Optimized indexes for 30-day window joins
--
-- Target: <500ms response time for metrics endpoints under load
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Create daily metrics summary table
-- Pre-aggregates daily revenue and conversion data
-- ============================================================

CREATE TABLE IF NOT EXISTS daily_metrics_summary (
  date TEXT PRIMARY KEY, -- ISO date: YYYY-MM-DD
  total_conversions INTEGER NOT NULL DEFAULT 0,
  unique_customers INTEGER NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  total_commission REAL NOT NULL DEFAULT 0,
  avg_order_value REAL NOT NULL DEFAULT 0,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  conversion_rate_percent REAL NOT NULL DEFAULT 0,
  converting_affiliates INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Indexes for the summary table
CREATE INDEX IF NOT EXISTS idx_daily_metrics_date ON daily_metrics_summary(date);
CREATE INDEX IF NOT EXISTS idx_daily_metrics_updated ON daily_metrics_summary(updated_at);

-- ============================================================
-- STEP 2: Create hourly metrics summary table
-- For finer-grained time-series queries
-- ============================================================

CREATE TABLE IF NOT EXISTS hourly_metrics_summary (
  hour_start TEXT NOT NULL, -- ISO datetime: YYYY-MM-DDTHH:00:00Z
  date TEXT NOT NULL, -- Date part for easier querying
  total_conversions INTEGER NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  unique_visitors INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (hour_start, date)
);

CREATE INDEX IF NOT EXISTS idx_hourly_metrics_date ON hourly_metrics_summary(date);
CREATE INDEX IF NOT EXISTS idx_hourly_metrics_hour_start ON hourly_metrics_summary(hour_start);

-- ============================================================
-- STEP 3: Create deal daily performance table
-- Pre-computed deal metrics by day
-- ============================================================

CREATE TABLE IF NOT EXISTS deal_daily_performance (
  id TEXT NOT NULL, -- deal_id + date composite key
  deal_id TEXT NOT NULL,
  date TEXT NOT NULL, -- ISO date
  total_clicks INTEGER NOT NULL DEFAULT 0,
  unique_clicks INTEGER NOT NULL DEFAULT 0,
  total_conversions INTEGER NOT NULL DEFAULT 0,
  unique_customers INTEGER NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  total_commission REAL NOT NULL DEFAULT 0,
  conversion_rate_percent REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE(deal_id, date)
);

CREATE INDEX IF NOT EXISTS idx_deal_daily_deal_date ON deal_daily_performance(deal_id, date);
CREATE INDEX IF NOT EXISTS idx_deal_daily_date ON deal_daily_performance(date);
CREATE INDEX IF NOT EXISTS idx_deal_daily_revenue ON deal_daily_performance(date, total_revenue DESC);

-- ============================================================
-- STEP 4: Create affiliate daily metrics table
-- Pre-computed affiliate performance by day
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate_daily_metrics (
  id TEXT NOT NULL, -- affiliate_id + date composite key
  affiliate_id TEXT NOT NULL,
  date TEXT NOT NULL,
  total_clicks INTEGER NOT NULL DEFAULT 0,
  total_conversions INTEGER NOT NULL DEFAULT 0,
  total_revenue REAL NOT NULL DEFAULT 0,
  total_commission REAL NOT NULL DEFAULT 0,
  conversion_rate_percent REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (id),
  UNIQUE(affiliate_id, date)
);

CREATE INDEX IF NOT EXISTS idx_affiliate_daily_affiliate_date ON affiliate_daily_metrics(affiliate_id, date);
CREATE INDEX IF NOT EXISTS idx_affiliate_daily_date ON affiliate_daily_metrics(date);
CREATE INDEX IF NOT EXISTS idx_affiliate_daily_perf ON affiliate_daily_metrics(date, total_commission DESC);

-- ============================================================
-- STEP 5: Create real-time metrics cache table
-- Cache for the Business Metrics API responses with query parameter hash
-- ============================================================

CREATE TABLE IF NOT EXISTS metrics_response_cache (
  cache_key TEXT PRIMARY KEY,
  response_data TEXT NOT NULL, -- JSON response
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  hit_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_metrics_cache_expires ON metrics_response_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_metrics_cache_created ON metrics_response_cache(created_at);

-- ============================================================
-- STEP 6: Additional optimized indexes for live queries
-- These complement existing indexes for specific query patterns
-- ============================================================

-- For the 30-day click window join in v_daily_revenue
-- This index helps with: dc.deal_id = c.deal_id AND dc.created_at BETWEEN date(c.converted_at, '-30 days') AND c.converted_at
CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_created_covering
ON deal_clicks(deal_id, created_at, session_id);

-- For conversion rate time-series with date truncation
CREATE INDEX IF NOT EXISTS idx_conversions_date_covering
ON conversions(date(converted_at), status, revenue, affiliate_id, deal_id, customer_id);

-- For deal performance queries filtering by active status
CREATE INDEX IF NOT EXISTS idx_deals_active_exchange_category
ON deals(is_active, exchange, category, deal_type, id);

-- For affiliate activity queries
CREATE INDEX IF NOT EXISTS idx_profiles_role_created_covering
ON profiles(role, created_at, id, email, full_name);

-- For earnings aggregation with level information
CREATE INDEX IF NOT EXISTS idx_earnings_level_covering
ON earnings(level, created_at, amount, affiliate_id, conversion_id, is_paid);

-- For payouts summary queries
CREATE INDEX IF NOT EXISTS idx_payouts_status_affiliate_covering
ON payouts(status, affiliate_id, id, amount, paid_at, scheduled_at);

-- ============================================================
-- STEP 7: Views optimized to use summary tables when available
-- ============================================================

-- Optimized v_daily_revenue that falls back to summary table when date range is covered
CREATE VIEW IF NOT EXISTS v_daily_revenue_optimized AS
SELECT
  date,
  total_conversions,
  unique_customers,
  total_revenue,
  total_commission,
  avg_order_value,
  total_clicks,
  unique_visitors,
  conversion_rate_percent,
  converting_affiliates
FROM daily_metrics_summary
WHERE date >= date('now', '-365 days')
ORDER BY date DESC;

-- Keep original view for compatibility but add optimization hint comment
-- (SQLite doesn't support materialized views, so we use a summary table + view)

-- ============================================================
-- STEP 8: Helper function to populate summary tables
-- This should be called by a cron job (hourly) to refresh aggregated data
-- ============================================================

-- Note: In D1/SQLite, we use regular SQL statements that can be run
-- via a scheduled cron job to refresh the summary tables.

-- To refresh daily_metrics_summary for a specific date range:
--
-- INSERT OR REPLACE INTO daily_metrics_summary (date, total_conversions, unique_customers, total_revenue, total_commission, avg_order_value, total_clicks, unique_visitors, conversion_rate_percent, converting_affiliates, updated_at)
-- SELECT
--   DATE(c.converted_at) as date,
--   COUNT(DISTINCT c.id) as total_conversions,
--   COUNT(DISTINCT c.customer_id) as unique_customers,
--   COALESCE(SUM(c.revenue), 0) as total_revenue,
--   COALESCE(SUM(e.amount), 0) as total_commission,
--   AVG(c.revenue) as avg_order_value,
--   COUNT(DISTINCT dc.id) as total_clicks,
--   COUNT(DISTINCT dc.session_id) as unique_visitors,
--   CASE
--     WHEN COUNT(DISTINCT dc.id) > 0
--     THEN (COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id))
--     ELSE 0
--   END as conversion_rate_percent,
--   COUNT(DISTINCT c.affiliate_id) as converting_affiliates,
--   datetime('now') as updated_at
-- FROM conversions c
-- LEFT JOIN earnings e ON e.conversion_id = c.id
-- LEFT JOIN deal_clicks dc ON dc.deal_id = c.deal_id
--   AND dc.created_at >= DATE(c.converted_at, '-30 days')
--   AND dc.created_at <= c.converted_at
-- WHERE c.status = 'approved'
--   AND c.converted_at >= ?
--   AND c.converted_at < ?
-- GROUP BY DATE(c.converted_at);

-- ============================================================
-- MIGRATION COMPLETED
-- ============================================================

SELECT 'Migration 014: Metrics performance optimizations added' as status;
SELECT 'Summary tables created: daily_metrics_summary, hourly_metrics_summary, deal_daily_performance, affiliate_daily_metrics';
SELECT 'Cache table created: metrics_response_cache';
SELECT 'Additional indexes added for optimized query patterns';

-- Verification queries
SELECT 'Indexes created:' as verification;
SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_metrics%' ORDER BY name;
SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_deal_clicks_deal_created_covering%';
SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_conversions_date_covering%';
