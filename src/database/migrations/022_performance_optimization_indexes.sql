-- ============================================================
-- ApexOS Performance Optimization Indexes (Migration 022)
-- Sprint 10: API Performance & Caching Optimization
-- Target Database: Cloudflare D1 (SQLite)
--
-- Features:
-- 1. Composite index for active deals sorted by created_at DESC (GET /api/deals)
-- 2. Composite index for user payment history sorted by created_at DESC (GET /api/payments/history)
-- 3. Composite indexes for deal clicks velocity lookups by IP and session (POST /api/deals/:id/click)
-- ============================================================

PRAGMA foreign_keys = ON;

-- Deals active + created_at sorting
CREATE INDEX IF NOT EXISTS idx_deals_active_created 
  ON deals(is_active, created_at DESC);

-- Payments user_id + created_at sorting
CREATE INDEX IF NOT EXISTS idx_payments_user_created 
  ON payments(user_id, created_at DESC);

-- Deal clicks velocity check index seeks
CREATE INDEX IF NOT EXISTS idx_deal_clicks_ip_created 
  ON deal_clicks(ip_address, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_session_created 
  ON deal_clicks(session_id, created_at DESC);
