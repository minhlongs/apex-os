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

CREATE VIEW IF NOT EXISTS v_daily_revenue AS
SELECT
  DATE(converted_at) as date,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  AVG(c.revenue) as avg_order_value,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_visitors,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN (COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id))
    ELSE 0
  END) as conversion_rate_percent,
  COUNT(DISTINCT c.affiliate_id) as converting_affiliates
FROM conversions c
LEFT JOIN earnings e ON e.conversion_id = c.id
LEFT JOIN deal_clicks dc ON dc.deal_id = c.deal_id
  AND dc.created_at >= DATE(c.converted_at, '-30 days')
  AND dc.created_at <= c.converted_at
WHERE c.status = 'approved'
GROUP BY DATE(converted_at)
ORDER BY date DESC;

-- ============================================================
-- STEP 2: Create conversion rate metrics view
-- ============================================================

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

CREATE VIEW IF NOT EXISTS v_active_affiliates AS
SELECT
  p.id,
  p.email,
  p.full_name,
  COALESCE(rt.level, 1) as level,
  COALESCE(rt.total_earnings, 0) as lifetime_earnings,
  COALESCE(SUM(CASE WHEN e.is_paid = 0 THEN e.amount ELSE 0 END), 0) as pending_earnings,
  COUNT(DISTINCT c.id) as total_conversions,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(ap.conversion_rate, 0) as conversion_rate,
  COUNT(DISTINCT dc.id) as total_clicks,
  CASE
    WHEN MAX(dc.created_at) >= datetime('now', '-30 days') THEN 1
    WHEN MAX(c.converted_at) >= datetime('now', '-30 days') THEN 1
    ELSE 0
  END as is_active,
  MAX(dc.created_at) as last_click_date,
  MAX(c.converted_at) as last_conversion_date,
  rt.total_direct_referrals,
  rt.total_indirect_referrals,
  COALESCE(ac.commission_rate, 0.10) as commission_rate,
  (SELECT MAX(paid_at)
   FROM payouts po
   WHERE po.affiliate_id = p.id AND po.status = 'completed') as last_payout_date,
  p.created_at as joined_date
FROM profiles p
LEFT JOIN referral_tree rt ON rt.affiliate_id = p.id
LEFT JOIN affiliate_codes ac ON ac.affiliate_id = p.id AND ac.is_active = 1
LEFT JOIN earnings e ON e.affiliate_id = p.id
LEFT JOIN conversions c ON c.affiliate_id = p.id AND c.status = 'approved'
LEFT JOIN deal_clicks dc ON dc.affiliate_id = p.id
LEFT JOIN v_affiliate_performance ap ON ap.affiliate_id = p.id
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
GROUP BY p.id, p.email, p.full_name, rt.level, rt.total_earnings,
         rt.total_direct_referrals, rt.total_indirect_referrals,
         ap.conversion_rate, ac.commission_rate, p.created_at
ORDER BY lifetime_earnings DESC;

-- ============================================================
-- STEP 4: Create deal performance view
-- ============================================================

CREATE VIEW IF NOT EXISTS v_deal_performance AS
SELECT
  d.id,
  d.name,
  d.deal_type,
  d.exchange,
  d.category,
  d.cashback_percent,
  d.is_active,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  COALESCE(AVG(c.revenue), 0) as avg_order_value,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate_percent,
  COALESCE(AVG(ac.commission_rate), d.default_commission_rate) as avg_commission_rate,
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
LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
LEFT JOIN conversions c ON c.deal_id = d.id AND c.status = 'approved'
LEFT JOIN earnings e ON e.conversion_id = c.id
LEFT JOIN affiliate_codes ac ON ac.code = c.affiliate_code
GROUP BY d.id, d.name, d.deal_type, d.exchange, d.category,
         d.cashback_percent, d.is_active, d.default_commission_rate,
         d.created_at, d.starts_at, d.ends_at
ORDER BY total_revenue DESC;

-- ============================================================
-- STEP 5: Create period summary view
-- ============================================================

CREATE VIEW IF NOT EXISTS v_period_summary AS
SELECT
  'lifetime' as period,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  COUNT(DISTINCT p.id) as active_affiliates_count,
  COUNT(DISTINCT dc.session_id) as total_unique_visitors,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
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
LEFT JOIN earnings e ON e.conversion_id = c.id
LEFT JOIN profiles p ON p.role IN ('affiliate', 'admin', 'master_trader')
LEFT JOIN deal_clicks dc ON dc.deal_id = c.deal_id
  AND dc.created_at >= DATE(c.converted_at, '-30 days')
WHERE c.status = 'approved'
UNION ALL
SELECT
  'last_30_days' as period,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  COUNT(DISTINCT p.id) as active_affiliates_count,
  COUNT(DISTINCT dc.session_id) as total_unique_visitors,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
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
LEFT JOIN earnings e ON e.conversion_id = c.id
LEFT JOIN profiles p ON p.role IN ('affiliate', 'admin', 'master_trader')
LEFT JOIN deal_clicks dc ON dc.deal_id = c.deal_id
  AND dc.created_at >= DATE(c.converted_at, '-30 days')
  AND dc.created_at <= c.converted_at
LEFT JOIN deals d ON d.id = c.deal_id
WHERE c.status = 'approved'
  AND c.converted_at >= datetime('now', '-30 days');

-- ============================================================
-- STEP 6: Create new affiliate activity view
-- ============================================================

CREATE VIEW IF NOT EXISTS v_affiliate_activity AS
SELECT
  p.id,
  p.email,
  p.full_name,
  p.created_at as joined_date,
  MIN(dc.created_at) as first_click_date,
  MIN(c.converted_at) as first_conversion_date,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  CASE
    WHEN p.created_at >= datetime('now', '-30 days') THEN 'new'
    WHEN MAX(c.converted_at) >= datetime('now', '-30 days') THEN 'active'
    ELSE 'inactive'
  END as activity_status
FROM profiles p
LEFT JOIN deal_clicks dc ON dc.affiliate_id = p.id
LEFT JOIN conversions c ON c.affiliate_id = p.id AND c.status = 'approved'
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
GROUP BY p.id, p.email, p.full_name, p.created_at
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
SELECT 'Views created:' as status
UNION ALL
SELECT 'v_daily_revenue' as view_name
UNION ALL
SELECT 'v_conversion_rates'
UNION ALL
SELECT 'v_active_affiliates'
UNION ALL
SELECT 'v_deal_performance'
UNION ALL
SELECT 'v_period_summary'
UNION ALL
SELECT 'v_affiliate_activity';
