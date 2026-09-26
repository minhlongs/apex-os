-- ============================================================
-- ApexOS Fraud Detection & Anomaly Schema (Migration 021)
-- Sprint: Fraud Detection & Anomaly Engine
-- Target Database: Cloudflare D1 (SQLite)
--
-- Features:
-- 1. Extend deal_clicks with is_suspicious, flag_reasons, and anomaly_score
-- 2. Create blocked_ips table for real-time IP blacklist enforcement
-- 3. Create fraud_reviews table for immutable audit trail
-- 4. Create immutability triggers on fraud_reviews (BEFORE UPDATE / DELETE)
-- 5. Create performance query indexes for velocity checks & blocklist lookups
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Extend deal_clicks table
-- ============================================================

-- Add is_suspicious: 0 = legitimate/clean, 1 = flagged suspicious
ALTER TABLE deal_clicks ADD COLUMN is_suspicious INTEGER DEFAULT 0;

-- Add flag_reasons: JSON array of string reason codes e.g. ["BURST_CLICK"]
ALTER TABLE deal_clicks ADD COLUMN flag_reasons TEXT;

-- Add anomaly_score: continuous numerical risk score (0.0 to 1.0+)
ALTER TABLE deal_clicks ADD COLUMN anomaly_score REAL DEFAULT 0.0;

-- Performance indexes for fast velocity lookups and admin filtering
CREATE INDEX IF NOT EXISTS idx_deal_clicks_ip_created 
  ON deal_clicks(ip_address, created_at);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_session_created 
  ON deal_clicks(session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_is_suspicious 
  ON deal_clicks(is_suspicious);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_suspicious_created 
  ON deal_clicks(is_suspicious, created_at DESC);

-- ============================================================
-- STEP 2: Create blocked_ips table
-- ============================================================

CREATE TABLE IF NOT EXISTS blocked_ips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ip_address TEXT UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  blocked_by TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  is_active INTEGER DEFAULT 1
);

-- Index for real-time IP blocklist checking on incoming click requests
CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip 
  ON blocked_ips(ip_address);

CREATE INDEX IF NOT EXISTS idx_blocked_ips_active 
  ON blocked_ips(is_active, ip_address);

-- ============================================================
-- STEP 3: Create fraud_reviews table (Immutable Audit Log)
-- ============================================================

CREATE TABLE IF NOT EXISTS fraud_reviews (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  click_id TEXT,
  ip_address TEXT,
  reviewer_id TEXT,
  reviewed_by TEXT,
  action TEXT NOT NULL,
  reason TEXT NOT NULL,
  reviewed_at TEXT DEFAULT (datetime('now')),
  created_at TEXT DEFAULT (datetime('now')),
  details TEXT
);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_click 
  ON fraud_reviews(click_id);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_ip 
  ON fraud_reviews(ip_address);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_reviewer 
  ON fraud_reviews(reviewer_id);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_action 
  ON fraud_reviews(action);

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_reviewed_at 
  ON fraud_reviews(reviewed_at DESC);

-- ============================================================
-- STEP 4: Immutability triggers on fraud_reviews
-- ============================================================

CREATE TRIGGER IF NOT EXISTS trg_fraud_reviews_prevent_update BEFORE UPDATE ON fraud_reviews
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'fraud_reviews audit log is immutable: UPDATE operations are prohibited');
END;

CREATE TRIGGER IF NOT EXISTS trg_fraud_reviews_prevent_delete BEFORE DELETE ON fraud_reviews
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'fraud_reviews audit log is immutable: DELETE operations are prohibited');
END;
