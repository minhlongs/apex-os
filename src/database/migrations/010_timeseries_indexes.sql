-- ============================================================
-- Time-Series Metrics Indexes (Migration 010)
-- Adds optimized indexes for time-series queries on business metrics
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Conversions Time-Series Indexes
-- ============================================================

-- Index for time-series queries on conversions by date
CREATE INDEX IF NOT EXISTS idx_conversions_converted_at ON conversions(converted_at);
CREATE INDEX IF NOT EXISTS idx_conversions_status_converted ON conversions(status, converted_at);
CREATE INDEX IF NOT EXISTS idx_conversions_deal_converted ON conversions(deal_id, converted_at);
CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_converted_status ON conversions(affiliate_id, converted_at, status);

-- ============================================================
-- STEP 2: Deal Clicks Time-Series Indexes
-- ============================================================

-- Index for time-series queries on deal clicks by date
CREATE INDEX IF NOT EXISTS idx_deal_clicks_created_at ON deal_clicks(created_at);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_created ON deal_clicks(deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate_created ON deal_clicks(affiliate_id, created_at);

-- ============================================================
-- STEP 3: Earnings Time-Series Indexes
-- ============================================================

-- Index for time-series queries on earnings by date
CREATE INDEX IF NOT EXISTS idx_earnings_created_at ON earnings(created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_affiliate_created ON earnings(affiliate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_is_paid_created ON earnings(is_paid, created_at);
CREATE INDEX IF NOT EXISTS idx_earnings_period ON earnings(earnings_period_start, earnings_period_end);

-- ============================================================
-- STEP 4: Payouts Time-Series Indexes
-- ============================================================

-- Index for time-series queries on payouts by date
CREATE INDEX IF NOT EXISTS idx_payouts_created_at ON payouts(created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_affiliate_created ON payouts(affiliate_id, created_at);
CREATE INDEX IF NOT EXISTS idx_payouts_status_scheduled ON payouts(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_payouts_status_paid ON payouts(status, paid_at);

-- ============================================================
-- STEP 5: Composite Indexes for Common Aggregation Queries
-- ============================================================

-- Revenue by date (for daily revenue reports)
CREATE INDEX IF NOT EXISTS idx_conversions_date_revenue ON conversions(date(converted_at), status, revenue);
CREATE INDEX IF NOT EXISTS idx_conversions_deal_date_revenue ON conversions(deal_id, date(converted_at), revenue);

-- Click-through rate calculations
CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_click_type ON deal_clicks(deal_id, click_type, created_at);

-- Commission tracking by period
CREATE INDEX IF NOT EXISTS idx_earnings_level_created ON earnings(level, created_at, amount);

-- ============================================================
-- Migration completed successfully
-- ============================================================

SELECT 'Time-series indexes created successfully' as status;
