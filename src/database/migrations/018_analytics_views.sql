-- ============================================================
-- Analytics Materialized Views (Migration 018)
-- Sprint 3: Analytics Engine
-- Adds daily deal/affiliate aggregations and supporting indexes
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Daily deals aggregation view
-- ============================================================

CREATE VIEW IF NOT EXISTS analytics_daily_deals AS
SELECT
  DATE(dc.created_at) as date,
  d.id as deal_id,
  d.name as deal_name,
  d.exchange,
  d.deal_type,
  d.category,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_commission,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate_percent,
  COALESCE(AVG(c.revenue), 0) as avg_order_value,
  COUNT(DISTINCT c.affiliate_id) as converting_affiliates_count
FROM deals d
LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
  AND dc.created_at >= DATE('now', '-90 days')
LEFT JOIN conversions c ON c.deal_id = d.id
  AND c.status = 'approved'
  AND c.converted_at >= DATE(dc.created_at, '-30 days')
  AND c.converted_at <= datetime(dc.created_at, '+30 days')
LEFT JOIN earnings e ON e.conversion_id = c.id
WHERE dc.created_at >= DATE('now', '-90 days')
GROUP BY DATE(dc.created_at), d.id, d.name, d.exchange, d.deal_type, d.category
ORDER BY date DESC;

-- ============================================================
-- STEP 2: Daily affiliates aggregation view
-- ============================================================

CREATE VIEW IF NOT EXISTS analytics_daily_affiliates AS
SELECT
  DATE(c.converted_at) as date,
  p.id as affiliate_id,
  p.email,
  p.full_name,
  COALESCE(rt.level, 1) as level,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT dc.id) as total_clicks,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COALESCE(SUM(e.amount), 0) as total_earnings,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate_percent,
  COALESCE(AVG(c.revenue), 0) as avg_order_value,
  COUNT(DISTINCT c.deal_id) as unique_deals_promoted
FROM profiles p
LEFT JOIN conversions c ON c.affiliate_id = p.id
  AND c.status = 'approved'
  AND c.converted_at >= DATE('now', '-90 days')
LEFT JOIN deal_clicks dc ON dc.affiliate_id = p.id
  AND dc.created_at >= DATE(c.converted_at, '-30 days')
  AND dc.created_at <= datetime(c.converted_at, '+30 days')
LEFT JOIN earnings e ON e.affiliate_id = p.id AND e.conversion_id = c.id
LEFT JOIN referral_tree rt ON rt.affiliate_id = p.id
WHERE p.role IN ('affiliate', 'admin', 'master_trader')
  AND c.converted_at >= DATE('now', '-90 days')
GROUP BY DATE(c.converted_at), p.id, p.email, p.full_name, rt.level
ORDER BY date DESC;

-- ============================================================
-- STEP 3: Exchange breakdown view
-- ============================================================

CREATE VIEW IF NOT EXISTS analytics_exchange_breakdown AS
SELECT
  d.exchange,
  COUNT(DISTINCT d.id) as total_deals,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT dc.session_id) as unique_visitors,
  COUNT(DISTINCT c.id) as total_conversions,
  COUNT(DISTINCT c.customer_id) as unique_customers,
  COALESCE(SUM(c.revenue), 0) as total_volume,
  COALESCE(SUM(e.amount), 0) as total_commission,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate_percent,
  COALESCE(AVG(c.revenue), 0) as avg_order_value
FROM deals d
LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
  AND dc.created_at >= DATE('now', '-90 days')
LEFT JOIN conversions c ON c.deal_id = d.id
  AND c.status = 'approved'
  AND c.converted_at >= DATE(dc.created_at, '-30 days')
  AND c.converted_at <= datetime(dc.created_at, '+30 days')
LEFT JOIN earnings e ON e.conversion_id = c.id
WHERE d.exchange IS NOT NULL
GROUP BY d.exchange
ORDER BY total_volume DESC;

-- ============================================================
-- STEP 4: Top trading pairs view
-- ============================================================

CREATE VIEW IF NOT EXISTS analytics_top_pairs AS
SELECT
  d.exchange,
  d.deal_type as pair_type,
  d.category as pair_category,
  COUNT(DISTINCT d.id) as deal_count,
  COUNT(DISTINCT dc.id) as total_clicks,
  COUNT(DISTINCT c.id) as total_conversions,
  COALESCE(SUM(c.revenue), 0) as total_volume,
  (CASE
    WHEN COUNT(DISTINCT dc.id) > 0
    THEN ROUND((COUNT(DISTINCT c.id) * 100.0 / COUNT(DISTINCT dc.id)), 2)
    ELSE 0
  END) as conversion_rate_percent
FROM deals d
LEFT JOIN deal_clicks dc ON dc.deal_id = d.id
  AND dc.created_at >= DATE('now', '-90 days')
LEFT JOIN conversions c ON c.deal_id = d.id
  AND c.status = 'approved'
  AND c.converted_at >= DATE(dc.created_at, '-30 days')
  AND c.converted_at <= datetime(dc.created_at, '+30 days')
WHERE d.exchange IS NOT NULL
  AND d.category IS NOT NULL
GROUP BY d.exchange, d.deal_type, d.category
ORDER BY total_volume DESC;

-- ============================================================
-- STEP 5: Funnel metrics view (visit -> click -> signup -> conversion)
-- ============================================================

CREATE VIEW IF NOT EXISTS analytics_funnel_daily AS
SELECT
  DATE(ev.created_at) as date,
  COUNT(DISTINCT CASE WHEN ev.event_type = 'page_view' THEN ev.session_id END) as visits,
  COUNT(DISTINCT CASE WHEN ev.event_type = 'deal_click' THEN ev.session_id END) as clicks,
  COUNT(DISTINCT CASE WHEN ev.event_type = 'signup' THEN ev.user_id END) as signups,
  COUNT(DISTINCT CASE WHEN ev.event_type = 'activation' THEN ev.user_id END) as activations,
  COUNT(DISTINCT CASE WHEN ev.event_type = 'conversion' THEN ev.user_id END) as conversions,
  (CASE
    WHEN COUNT(DISTINCT CASE WHEN ev.event_type = 'deal_click' THEN ev.session_id END) > 0
    THEN ROUND(
      (COUNT(DISTINCT CASE WHEN ev.event_type = 'conversion' THEN ev.user_id END) * 100.0) /
      COUNT(DISTINCT CASE WHEN ev.event_type = 'deal_click' THEN ev.session_id END),
      2
    )
    ELSE 0
  END) as click_to_conversion_rate,
  (CASE
    WHEN COUNT(DISTINCT CASE WHEN ev.event_type = 'signup' THEN ev.user_id END) > 0
    THEN ROUND(
      (COUNT(DISTINCT CASE WHEN ev.event_type = 'activation' THEN ev.user_id END) * 100.0) /
      COUNT(DISTINCT CASE WHEN ev.event_type = 'signup' THEN ev.user_id END),
      2
    )
    ELSE 0
  END) as activation_rate
FROM events ev
WHERE ev.created_at >= DATE('now', '-90 days')
GROUP BY DATE(ev.created_at)
ORDER BY date DESC;

-- ============================================================
-- STEP 6: Supporting indexes for analytics queries
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_deal_clicks_created_exchange
  ON deal_clicks(created_at, deal_id);

CREATE INDEX IF NOT EXISTS idx_conversions_approved_converted
  ON conversions(status, converted_at, deal_id, affiliate_id, customer_id, revenue)
  WHERE status = 'approved';

CREATE INDEX IF NOT EXISTS idx_earnings_conversion
  ON earnings(conversion_id, affiliate_id, amount);

CREATE INDEX IF NOT EXISTS idx_deals_exchange_type
  ON deals(exchange, deal_type, category, is_active)
  WHERE exchange IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_events_created_type
  ON events(created_at, event_type, session_id, user_id);

-- ============================================================
-- Verify views created
-- ============================================================

SELECT 'Analytics views created:' as status
UNION ALL SELECT 'analytics_daily_deals'
UNION ALL SELECT 'analytics_daily_affiliates'
UNION ALL SELECT 'analytics_exchange_breakdown'
UNION ALL SELECT 'analytics_top_pairs'
UNION ALL SELECT 'analytics_funnel_daily';
