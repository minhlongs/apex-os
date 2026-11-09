-- ============================================================
-- Business Metrics Views (Migration 010)
-- Optimized views and indexes for the business metrics API
--
-- This migration adds:
-- 1. Materialized daily aggregations view
-- 2. Conversion performance views
-- 3. Affiliate activity views
-- 4. Deal performance views
-- 5. Composite indexes for fast aggregation queries
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Create daily aggregations view
-- ============================================================

DROP VIEW IF EXISTS v_daily_revenue;
CREATE VIEW IF NOT EXISTS v_daily_revenue AS
SELECT
  DATE(c.converted_at) as date,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(c.revenue), 0) as revenue,
  COALESCE(SUM(e.total_commission), 0) as total_commission,
  AVG(c.revenue) as avg_order_value,
  COALESCE((
    SELECT COUNT(DISTINCT dc.id)
    FROM deal_clicks dc
    WHERE dc.deal_id IN (
      SELECT DISTINCT c2.deal_id FROM conversions c2
      WHERE c2.status = 'approved' AND DATE(c2.converted_at) = DATE(c.converted_at)
    )
      AND dc.created_at >= DATE(c.converted_at, '-30 days')
      AND DATE(dc.created_at) <= DATE(c.converted_at)
  ), 0) as total_clicks,
  COALESCE((
    SELECT COUNT(DISTINCT dc.session_id)
    FROM deal_clicks dc
    WHERE dc.deal_id IN (
      SELECT DISTINCT c2.deal_id FROM conversions c2
      WHERE c2.status = 'approved' AND DATE(c2.converted_at) = DATE(c.converted_at)
    )
      AND dc.created_at >= DATE(c.converted_at, '-30 days')
      AND DATE(dc.created_at) <= DATE(c.converted_at)
  ), 0) as unique_visitors,
  (CASE
    WHEN (
      SELECT COUNT(DISTINCT dc.id)
      FROM deal_clicks dc
      WHERE dc.deal_id IN (
        SELECT DISTINCT c2.deal_id FROM conversions c2
        WHERE c2.status = 'approved' AND DATE(c2.converted_at) = DATE(c.converted_at)
      )
        AND dc.created_at >= DATE(c.converted_at, '-30 days')
        AND DATE(dc.created_at) <= DATE(c.converted_at)
    ) > 0
    THEN (
      COUNT(DISTINCT c.id) * 100.0 / (
        SELECT COUNT(DISTINCT dc.id)
        FROM deal_clicks dc
        WHERE dc.deal_id IN (
          SELECT DISTINCT c2.deal_id FROM conversions c2
          WHERE c2.status = 'approved' AND DATE(c2.converted_at) = DATE(c.converted_at)
        )
          AND dc.created_at >= DATE(c.converted_at, '-30 days')
          AND DATE(dc.created_at) <= DATE(c.converted_at)
      )
    )
    ELSE 0
  END) as conversion_rate_percent,
  COUNT(DISTINCT c.affiliate_id) as converting_affiliates
FROM conversions c
LEFT JOIN (
  SELECT conversion_id, SUM(amount) as total_commission
  FROM earnings
  GROUP BY conversion_id
) e ON e.conversion_id = c.id
WHERE c.status = 'approved'
GROUP BY DATE(c.converted_at)
ORDER BY date DESC;

-- ============================================================
-- STEP 2: Create conversion rate metrics view
-- ============================================================

DROP VIEW IF EXISTS v_conversion_rates;
CREATE VIEW IF NOT EXISTS v_conversion_rates AS
SELECT
  DATE(dc.created_at) as date,
  COUNT(DISTINCT dc.session_id) as unique_visitors,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate_percent,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate,
  COALESCE(AVG(
    (julianday(c.converted_at) - julianday(dc.created_at)) * 86400
  ), 0) as avg_seconds_to_conversion,
  COUNT(DISTINCT c.affiliate_id) as converting_affiliates_count
FROM deal_clicks dc
LEFT JOIN conversions c ON c.deal_id = dc.deal_id
  AND c.customer_id IS NOT NULL
  AND c.status = 'approved'
  AND c.converted_at <= datetime(dc.created_at, '+30 days')
  AND c.converted_at >= dc.created_at
GROUP BY DATE(dc.created_at)
ORDER BY date DESC;

-- ============================================================
-- STEP 3: Create active affiliates view
-- ============================================================

DROP VIEW IF EXISTS v_active_affiliates;
CREATE VIEW IF NOT EXISTS v_active_affiliates AS
SELECT
  p.id,
  p.email,
  p.full_name,
  COALESCE(rt.level, 1) as level,
  COALESCE(rt.total_earnings, 0) as lifetime_earnings,
  COALESCE(e_agg.pending_earnings, 0) as pending_earnings,
  COALESCE(c_agg.total_conversions, 0) as total_conversions,
  COALESCE(c_agg.total_revenue, 0) as total_revenue,
  COALESCE(ap.conversion_rate, 0) as conversion_rate,
  COALESCE(dc_agg.total_clicks, 0) as total_clicks,
  CASE
    WHEN dc_agg.last_click_date >= datetime('now', '-30 days') THEN 1
    WHEN c_agg.last_conversion_date >= datetime('now', '-30 days') THEN 1
    ELSE 0
  END as is_active,
  dc_agg.last_click_date as last_click_date,
  c_agg.last_conversion_date as last_conversion_date,
  rt.total_direct_referrals,
  rt.total_indirect_referrals,
  COALESCE(ac_agg.commission_rate, 0.10) as commission_rate,
  (SELECT MAX(paid_at)
   FROM payouts po
   WHERE po.affiliate_id = p.id AND po.status = 'completed') as last_payout_date,
  p.created_at as joined_date
FROM profiles p
LEFT JOIN referral_tree rt ON rt.affiliate_id = p.id
LEFT JOIN (
  SELECT affiliate_id, AVG(commission_rate) as commission_rate
  FROM affiliate_codes
  WHERE is_active = 1
  GROUP BY affiliate_id
) ac_agg ON ac_agg.affiliate_id = p.id
LEFT JOIN (
  SELECT affiliate_id, SUM(CASE WHEN is_paid = 0 THEN amount ELSE 0 END) as pending_earnings
  FROM earnings
  GROUP BY affiliate_id
) e_agg ON e_agg.affiliate_id = p.id
LEFT JOIN (
  SELECT
    affiliate_id,
    COUNT(DISTINCT id) as total_conversions,
    COALESCE(SUM(revenue), 0) as total_revenue,
    MAX(converted_at) as last_conversion_date
  FROM conversions
  WHERE status = 'approved'
  GROUP BY affiliate_id
) c_agg ON c_agg.affiliate_id = p.id
LEFT JOIN (
  SELECT
    affiliate_id,
    COUNT(DISTINCT id) as total_clicks,
    MAX(created_at) as last_click_date
  FROM deal_clicks
  GROUP BY affiliate_id
) dc_agg ON dc_agg.affiliate_id = p.id
LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
ORDER BY lifetime_earnings DESC;

-- ============================================================
-- STEP 4: Create deal performance view
-- ============================================================

DROP VIEW IF EXISTS v_deal_performance;
CREATE VIEW IF NOT EXISTS v_deal_performance AS
SELECT
  d.id,
  d.name,
  d.deal_type,
  d.exchange,
  d.category,
  d.cashback_percent,
  d.is_active,
  COALESCE(dc_agg.total_clicks, 0) as total_clicks,
  COALESCE(dc_agg.unique_clicks, 0) as unique_clicks,
  COALESCE(c_agg.total_conversions, 0) as total_conversions,
  COALESCE(c_agg.unique_customers, 0) as unique_customers,
  COALESCE(c_agg.total_revenue, 0) as total_revenue,
  COALESCE(c_agg.total_commission, 0) as total_commission,
  COALESCE(c_agg.avg_order_value, 0) as avg_order_value,
  (CASE
    WHEN COALESCE(dc_agg.total_clicks, 0) > 0
    THEN ROUND((COALESCE(c_agg.total_conversions, 0) * 100.0 / dc_agg.total_clicks), 2)
    ELSE 0
  END) as conversion_rate_percent,
  COALESCE(c_agg.avg_commission_rate, d.default_commission_rate) as avg_commission_rate,
  -- Top performing affiliate for this deal
  (SELECT p.email
   FROM conversions c2
   JOIN profiles p ON p.id = c2.affiliate_id
   WHERE c2.deal_id = d.id AND c2.status = 'approved'
   GROUP BY c2.affiliate_id, p.email
   ORDER BY SUM(c2.revenue) DESC
   LIMIT 1) as top_affiliate_email,
  (SELECT COUNT(DISTINCT c2.affiliate_id)
   FROM conversions c2
   WHERE c2.deal_id = d.id AND c2.status = 'approved') as affiliate_count,
  d.created_at,
  d.starts_at,
  d.ends_at
FROM deals d
LEFT JOIN (
  SELECT
    deal_id,
    COUNT(DISTINCT id) as total_clicks,
    COUNT(DISTINCT session_id) as unique_clicks
  FROM deal_clicks
  GROUP BY deal_id
) dc_agg ON dc_agg.deal_id = d.id
LEFT JOIN (
  SELECT
    c.deal_id,
    COUNT(DISTINCT c.id) as total_conversions,
    COUNT(DISTINCT c.customer_id) as unique_customers,
    COALESCE(SUM(c.revenue), 0) as total_revenue,
    COALESCE(SUM(e.total_commission), 0) as total_commission,
    COALESCE(AVG(c.revenue), 0) as avg_order_value,
    AVG(ac.commission_rate) as avg_commission_rate
  FROM conversions c
  LEFT JOIN (
    SELECT conversion_id, SUM(amount) as total_commission
    FROM earnings
    GROUP BY conversion_id
  ) e ON e.conversion_id = c.id
  LEFT JOIN affiliate_codes ac ON ac.code = c.affiliate_code
  WHERE c.status = 'approved'
  GROUP BY c.deal_id
) c_agg ON c_agg.deal_id = d.id
ORDER BY total_revenue DESC;

-- ============================================================
-- STEP 5: Create period summary view
-- ============================================================

DROP VIEW IF EXISTS v_period_summary;
CREATE VIEW IF NOT EXISTS v_period_summary AS
SELECT
  'lifetime' as period,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.total_commission), 0) as total_commission,
  (SELECT COUNT(DISTINCT p.id) FROM profiles p WHERE p.role IN ('affiliate', 'admin', 'master_trader')) as active_affiliates_count,
  COALESCE((
    SELECT COUNT(DISTINCT dc.session_id)
    FROM deal_clicks dc
    JOIN conversions c2 ON c2.deal_id = dc.deal_id
      AND c2.status = 'approved'
      AND dc.created_at >= DATE(c2.converted_at, '-30 days')
      AND dc.created_at <= c2.converted_at
  ), 0) as total_unique_visitors,
  (CASE
    WHEN (
      SELECT COUNT(DISTINCT dc.id)
      FROM deal_clicks dc
      JOIN conversions c2 ON c2.deal_id = dc.deal_id
        AND c2.status = 'approved'
        AND dc.created_at >= DATE(c2.converted_at, '-30 days')
        AND dc.created_at <= c2.converted_at
    ) > 0
    THEN ROUND((
      COUNT(DISTINCT c.id) * 100.0 / (
        SELECT COUNT(DISTINCT dc.id)
        FROM deal_clicks dc
        JOIN conversions c2 ON c2.deal_id = dc.deal_id
          AND c2.status = 'approved'
          AND dc.created_at >= DATE(c2.converted_at, '-30 days')
          AND dc.created_at <= c2.converted_at
      )
    ), 2)
    ELSE 0
  END) as overall_conversion_rate,
  MAX(d.name) as top_deal_name,
  (SELECT p.full_name
   FROM profiles p
   JOIN earnings e2 ON e2.affiliate_id = p.id
   GROUP BY p.id, p.full_name
   ORDER BY SUM(e2.amount) DESC
   LIMIT 1) as top_affiliate_name
FROM conversions c
LEFT JOIN (
  SELECT conversion_id, SUM(amount) as total_commission
  FROM earnings
  GROUP BY conversion_id
) e ON e.conversion_id = c.id
LEFT JOIN deals d ON d.id = c.deal_id
WHERE c.status = 'approved'
UNION ALL
SELECT
  'last_30_days' as period,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.total_commission), 0) as total_commission,
  (SELECT COUNT(DISTINCT p.id) FROM profiles p WHERE p.role IN ('affiliate', 'admin', 'master_trader')) as active_affiliates_count,
  COALESCE((
    SELECT COUNT(DISTINCT dc.session_id)
    FROM deal_clicks dc
    JOIN conversions c2 ON c2.deal_id = dc.deal_id
      AND c2.status = 'approved'
      AND c2.converted_at >= datetime('now', '-30 days')
      AND dc.created_at >= DATE(c2.converted_at, '-30 days')
      AND dc.created_at <= c2.converted_at
  ), 0) as total_unique_visitors,
  (CASE
    WHEN (
      SELECT COUNT(DISTINCT dc.id)
      FROM deal_clicks dc
      JOIN conversions c2 ON c2.deal_id = dc.deal_id
        AND c2.status = 'approved'
        AND c2.converted_at >= datetime('now', '-30 days')
        AND dc.created_at >= DATE(c2.converted_at, '-30 days')
        AND dc.created_at <= c2.converted_at
    ) > 0
    THEN ROUND((
      COUNT(DISTINCT c.id) * 100.0 / (
        SELECT COUNT(DISTINCT dc.id)
        FROM deal_clicks dc
        JOIN conversions c2 ON c2.deal_id = dc.deal_id
          AND c2.status = 'approved'
          AND c2.converted_at >= datetime('now', '-30 days')
          AND dc.created_at >= DATE(c2.converted_at, '-30 days')
          AND dc.created_at <= c2.converted_at
      )
    ), 2)
    ELSE 0
  END) as overall_conversion_rate,
  MAX(d.name) as top_deal_name,
  (SELECT p.full_name
   FROM profiles p
   JOIN earnings e2 ON e2.affiliate_id = p.id
   JOIN conversions c2 ON c2.id = e2.conversion_id
   WHERE c2.converted_at >= datetime('now', '-30 days')
   GROUP BY p.id, p.full_name
   ORDER BY SUM(e2.amount) DESC
   LIMIT 1) as top_affiliate_name
FROM conversions c
LEFT JOIN (
  SELECT conversion_id, SUM(amount) as total_commission
  FROM earnings
  GROUP BY conversion_id
) e ON e.conversion_id = c.id
LEFT JOIN deals d ON d.id = c.deal_id
WHERE c.status = 'approved'
  AND c.converted_at >= datetime('now', '-30 days');

-- ============================================================
-- STEP 6: Create new affiliate activity view
-- ============================================================

DROP VIEW IF EXISTS v_affiliate_activity;
CREATE VIEW IF NOT EXISTS v_affiliate_activity AS
SELECT
  p.id,
  p.email,
  p.full_name,
  p.created_at as joined_date,
  dc_agg.first_click_date as first_click_date,
  c_agg.first_conversion_date as first_conversion_date,
  COALESCE(dc_agg.total_clicks, 0) as total_clicks,
  COALESCE(c_agg.total_conversions, 0) as total_conversions,
  COALESCE(c_agg.total_revenue, 0) as total_revenue,
  CASE
    WHEN p.created_at >= datetime('now', '-30 days') THEN 'new'
    WHEN c_agg.last_conversion_date >= datetime('now', '-30 days') THEN 'active'
    ELSE 'inactive'
  END as activity_status
FROM profiles p
LEFT JOIN (
  SELECT
    affiliate_id,
    MIN(created_at) as first_click_date,
    COUNT(DISTINCT id) as total_clicks
  FROM deal_clicks
  GROUP BY affiliate_id
) dc_agg ON dc_agg.affiliate_id = p.id
LEFT JOIN (
  SELECT
    affiliate_id,
    MIN(converted_at) as first_conversion_date,
    MAX(converted_at) as last_conversion_date,
    COUNT(DISTINCT id) as total_conversions,
    COALESCE(SUM(revenue), 0) as total_revenue
  FROM conversions
  WHERE status = 'approved'
  GROUP BY affiliate_id
) c_agg ON c_agg.affiliate_id = p.id
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
ORDER BY p.created_at DESC;

-- ============================================================
-- STEP 7: Add composite indexes for aggregation queries
-- ============================================================

-- Date-based aggregations
CREATE INDEX IF NOT EXISTS idx_conversions_status_converted ON conversions(status, converted_at);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_created ON deal_clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_created ON earnings(created_at);

-- Covering indexes for common aggregation patterns
CREATE INDEX IF NOT EXISTS idx_conv_rev_agg ON conversions(status, converted_at, revenue, affiliate_id, deal_id, customer_id)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_clicks_agg ON deal_clicks(deal_id, affiliate_id, created_at, session_id);

CREATE INDEX IF NOT EXISTS idx_earnings_affiliate_agg ON earnings(affiliate_id, is_paid, amount, conversion_id);

-- Deal performance index
CREATE INDEX IF NOT EXISTS idx_deals_performance ON deals(is_active, exchange, category, deal_type);

-- Affiliate activity index
CREATE INDEX IF NOT EXISTS idx_profiles_activity ON profiles(role, created_at);

-- ============================================================
-- Migration completed successfully
-- ============================================================

-- Verify views were created
SELECT name as view_name
FROM sqlite_master
WHERE type = 'view'
  AND name IN (
    'v_daily_revenue',
    'v_conversion_rates',
    'v_active_affiliates',
    'v_deal_performance',
    'v_period_summary',
    'v_affiliate_activity'
  )
ORDER BY name;
