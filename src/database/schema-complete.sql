-- ApexOS Complete Database Schema
-- For local development and staging setup
-- Run: wrangler d1 execute apex-os-db --file src/database/schema-complete.sql

PRAGMA foreign_keys = ON;

-- ============================================
-- DROP EXISTING TABLES (clean slate)
-- ============================================

DROP TABLE IF EXISTS v_affiliate_performance;
DROP TABLE IF EXISTS v_pending_earnings;
DROP TABLE IF EXISTS v_payout_summary;
DROP TABLE IF EXISTS deep_link_analytics;
DROP TABLE IF EXISTS device_tokens;
DROP TABLE IF EXISTS email_events;
DROP TABLE IF EXISTS email_queue;
DROP TABLE IF EXISTS tier_activations;
DROP TABLE IF EXISTS payments;
DROP TABLE IF EXISTS fraud_reviews;
DROP TABLE IF EXISTS blocked_ips;
DROP TABLE IF EXISTS web_vitals;
DROP TABLE IF EXISTS earnings;
DROP TABLE IF EXISTS payouts;
DROP TABLE IF EXISTS conversions;
DROP TABLE IF EXISTS deal_clicks;
DROP TABLE IF EXISTS affiliate_codes;
DROP TABLE IF EXISTS deals;
DROP TABLE IF EXISTS referral_tree;
DROP TABLE IF EXISTS profiles;
DROP TABLE IF EXISTS verifications;
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS users;

-- ============================================
-- BETTER AUTH TABLES
-- ============================================

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT NOT NULL UNIQUE,
  email_verified INTEGER DEFAULT 0,
  image TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  session_token TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(session_token);

CREATE TABLE verifications (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL,
  value TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_verifications_identifier ON verifications(identifier);

-- ============================================
-- PROFILES TABLE (extended user info)
-- ============================================

CREATE TABLE profiles (
  id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL UNIQUE,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'shopper' CHECK (role IN ('shopper', 'affiliate', 'admin', 'master_trader')),
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'growth', 'premium', 'master')),
  tier TEXT DEFAULT 'BASIC',
  wallet_address TEXT,
  preferred_chain TEXT,
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  notification_settings TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON profiles(referral_code);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);
CREATE INDEX IF NOT EXISTS idx_profiles_tier ON profiles(tier);
CREATE INDEX IF NOT EXISTS idx_profiles_wallet_address ON profiles(wallet_address);

-- ============================================
-- DEALS TABLE (affiliate offers)
-- ============================================

CREATE TABLE deals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  name TEXT NOT NULL,
  description TEXT,
  deal_type TEXT DEFAULT 'product' CHECK (deal_type IN ('product', 'service', 'subscription', 'course')),
  product_id TEXT,
  url TEXT NOT NULL,
  default_commission_rate REAL NOT NULL DEFAULT 0.10,
  default_commission_type TEXT DEFAULT 'percentage' CHECK (default_commission_type IN ('percentage', 'fixed')),
  fixed_commission_amount REAL DEFAULT 0.00,
  cookie_duration_days INTEGER DEFAULT 30,
  exchange TEXT CHECK (exchange IN ('binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken')),
  category TEXT CHECK (category IN ('spot', 'futures', 'options', 'margin')),
  cashback_pct REAL DEFAULT 0.10,
  cashback_percent REAL,
  risk_level TEXT DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high')),
  is_active INTEGER DEFAULT 1,
  starts_at TEXT,
  ends_at TEXT,
  metadata TEXT DEFAULT '{}',
  created_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deals_type ON deals(deal_type);
CREATE INDEX IF NOT EXISTS idx_deals_active ON deals(is_active);
CREATE INDEX IF NOT EXISTS idx_deals_exchange ON deals(exchange);
CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);
CREATE INDEX IF NOT EXISTS idx_deals_dates ON deals(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_deals_creator ON deals(created_by);
CREATE INDEX IF NOT EXISTS idx_deals_active_created ON deals(is_active, created_at DESC);

-- ============================================
-- AFFILIATE CODES TABLE
-- ============================================

CREATE TABLE affiliate_codes (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  code TEXT UNIQUE NOT NULL,
  affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  commission_rate REAL NOT NULL DEFAULT 0.10,
  commission_type TEXT DEFAULT 'percentage' CHECK (commission_type IN ('percentage', 'fixed')),
  max_uses INTEGER DEFAULT -1,
  used_count INTEGER DEFAULT 0,
  is_active INTEGER DEFAULT 1,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_affiliate_codes_code ON affiliate_codes(code);
CREATE INDEX IF NOT EXISTS idx_affiliate_codes_affiliate ON affiliate_codes(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_codes_deal ON affiliate_codes(deal_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_codes_active ON affiliate_codes(is_active);

-- ============================================
-- REFERRAL TREE TABLE (multi-level)
-- ============================================

CREATE TABLE referral_tree (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  affiliate_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES referral_tree(id) ON DELETE SET NULL,
  root_id TEXT REFERENCES referral_tree(id) ON DELETE SET NULL,
  level INTEGER DEFAULT 1 CHECK (level >= 1 AND level <= 10),
  path TEXT,
  total_direct_referrals INTEGER DEFAULT 0,
  total_indirect_referrals INTEGER DEFAULT 0,
  total_earnings REAL DEFAULT 0.00,
  total_payouts REAL DEFAULT 0.00,
  is_active INTEGER DEFAULT 1,
  joined_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_referral_tree_affiliate ON referral_tree(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_referral_tree_parent ON referral_tree(parent_id);
CREATE INDEX IF NOT EXISTS idx_referral_tree_root ON referral_tree(root_id);
CREATE INDEX IF NOT EXISTS idx_referral_tree_level ON referral_tree(level);
CREATE INDEX IF NOT EXISTS idx_referral_tree_path ON referral_tree(path);

-- ============================================
-- DEAL CLICKS TABLE (attribution)
-- ============================================

CREATE TABLE deal_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  affiliate_code TEXT REFERENCES affiliate_codes(code) ON DELETE SET NULL,
  affiliate_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  session_id TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  referrer_url TEXT,
  country_code TEXT,
  device_type TEXT,
  click_type TEXT DEFAULT 'link' CHECK (click_type IN ('link', 'banner', 'email', 'social', 'qr')),
  is_unique INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  -- Fraud Detection Engine extensions (Migration 021)
  is_suspicious INTEGER DEFAULT 0,
  flag_reasons TEXT,
  anomaly_score REAL DEFAULT 0.0
);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal ON deal_clicks(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate_code ON deal_clicks(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate ON deal_clicks(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_session ON deal_clicks(session_id);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_created ON deal_clicks(created_at);

-- Composite indexes for query optimization (Migration 008)
CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_created ON deal_clicks(deal_id, created_at);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate_created ON deal_clicks(affiliate_id, created_at);

-- Fraud Detection Engine & Performance indexes (Migrations 021 & 022)
CREATE INDEX IF NOT EXISTS idx_deal_clicks_ip_created ON deal_clicks(ip_address, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_session_created ON deal_clicks(session_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_is_suspicious ON deal_clicks(is_suspicious);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_suspicious_created ON deal_clicks(is_suspicious, created_at DESC);

-- ============================================
-- CONVERSIONS TABLE (verified trades)
-- ============================================

CREATE TABLE conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  deal_click_id TEXT REFERENCES deal_clicks(id) ON DELETE SET NULL,
  affiliate_code TEXT REFERENCES affiliate_codes(code) ON DELETE SET NULL,
  affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id TEXT,
  order_id TEXT,
  exchange_trade_id TEXT,
  exchange_name TEXT CHECK (exchange_name IN ('binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken')),
  revenue REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  commission_amount REAL NOT NULL,
  commission_type TEXT DEFAULT 'percentage' CHECK (commission_type IN ('percentage', 'fixed')),
  conversion_type TEXT DEFAULT 'sale' CHECK (conversion_type IN ('sale', 'lead', 'signup', 'install')),
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'refunded')),
  conversion_data TEXT DEFAULT '{}',
  converted_at TEXT DEFAULT (datetime('now')),
  approved_at TEXT,
  rejected_at TEXT,
  refunded_at TEXT,
  notes TEXT
);

CREATE INDEX IF NOT EXISTS idx_conversions_deal ON conversions(deal_id);
CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_code ON conversions(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_conversions_affiliate ON conversions(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_conversions_status ON conversions(status);
CREATE INDEX IF NOT EXISTS idx_conversions_converted ON conversions(converted_at);
CREATE INDEX IF NOT EXISTS idx_conversions_order ON conversions(order_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversions_trade_id ON conversions(exchange_trade_id, exchange_name) WHERE exchange_trade_id IS NOT NULL AND exchange_name IS NOT NULL;

-- Composite indexes for query optimization (Migration 008)
CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_convert ON conversions(affiliate_id, converted_at);
CREATE INDEX IF NOT EXISTS idx_conversions_affiliate_status ON conversions(affiliate_id, status);

-- ============================================
-- EARNINGS TABLE (double-entry ledger)
-- ============================================

CREATE TABLE earnings (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  conversion_id TEXT NOT NULL UNIQUE REFERENCES conversions(id) ON DELETE CASCADE,
  affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  referral_tree_id TEXT REFERENCES referral_tree(id) ON DELETE SET NULL,
  amount REAL NOT NULL,
  commission_type TEXT DEFAULT 'percentage' CHECK (commission_type IN ('percentage', 'fixed')),
  commission_rate REAL,
  level INTEGER DEFAULT 1 CHECK (level >= 1 AND level <= 10),
  parent_earnings_id TEXT REFERENCES earnings(id) ON DELETE SET NULL,
  earnings_period_start TEXT,
  earnings_period_end TEXT,
  is_paid INTEGER DEFAULT 0,
  paid_at TEXT,
  payout_id TEXT REFERENCES payouts(id) ON DELETE SET NULL,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_earnings_conversion ON earnings(conversion_id);
CREATE INDEX IF NOT EXISTS idx_earnings_affiliate ON earnings(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_earnings_referral_tree ON earnings(referral_tree_id);
CREATE INDEX IF NOT EXISTS idx_earnings_payout ON earnings(payout_id);
CREATE INDEX IF NOT EXISTS idx_earnings_is_paid ON earnings(is_paid);
CREATE INDEX IF NOT EXISTS idx_earnings_period ON earnings(earnings_period_start, earnings_period_end);

-- Composite indexes for query optimization (Migration 008)
CREATE INDEX IF NOT EXISTS idx_earnings_affiliate_is_paid ON earnings(affiliate_id, is_paid);
CREATE INDEX IF NOT EXISTS idx_earnings_is_paid_affiliate ON earnings(is_paid, affiliate_id);
CREATE INDEX IF NOT EXISTS idx_earnings_conversion_affiliate ON earnings(conversion_id, affiliate_id);

-- ============================================
-- PAYOUTS TABLE
-- ============================================

CREATE TABLE payouts (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  payout_method TEXT CHECK (payout_method IN ('bank_transfer', 'crypto', 'paypal', 'stripe', 'momo', 'sepay', 'vnpay')),
  payout_method_details TEXT DEFAULT '{}',
  amount REAL NOT NULL,
  currency TEXT DEFAULT 'USD',
  fee REAL DEFAULT 0.00,
  net_amount REAL NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'cancelled')),
  scheduled_at TEXT,
  paid_at TEXT,
  transaction_id TEXT UNIQUE,
  notes TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payouts_affiliate ON payouts(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_payouts_status ON payouts(status);
CREATE INDEX IF NOT EXISTS idx_payouts_scheduled ON payouts(scheduled_at);
CREATE INDEX IF NOT EXISTS idx_payouts_transaction ON payouts(transaction_id);

-- Composite index for query optimization (Migration 008)
CREATE INDEX IF NOT EXISTS idx_payouts_affiliate_status ON payouts(affiliate_id, status);

-- ============================================
-- TRIGGERS (auto-update timestamps)
-- ============================================

CREATE TRIGGER IF NOT EXISTS trg_profiles_updated
AFTER UPDATE ON profiles
FOR EACH ROW
BEGIN
  UPDATE profiles SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_affiliate_codes_updated
AFTER UPDATE ON affiliate_codes
FOR EACH ROW
BEGIN
  UPDATE affiliate_codes SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_deals_updated
AFTER UPDATE ON deals
FOR EACH ROW
BEGIN
  UPDATE deals SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_referral_tree_updated
AFTER UPDATE ON referral_tree
FOR EACH ROW
BEGIN
  UPDATE referral_tree SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_earnings_updated
AFTER UPDATE ON earnings
FOR EACH ROW
BEGIN
  UPDATE earnings SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_payouts_updated
AFTER UPDATE ON payouts
FOR EACH ROW
BEGIN
  UPDATE payouts SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_earnings_paid
AFTER UPDATE OF is_paid ON earnings
FOR EACH ROW
WHEN new.is_paid = 1 AND old.is_paid = 0
BEGIN
  UPDATE earnings SET paid_at = datetime('now') WHERE id = new.id;
END;

-- ============================================
-- VIEWS
-- ============================================

CREATE VIEW IF NOT EXISTS v_affiliate_performance AS
SELECT
  p.id as affiliate_id,
  p.full_name,
  p.email,
  rt.level,
  rt.total_earnings as lifetime_earnings,
  rt.total_payouts as lifetime_payouts,
  COUNT(DISTINCT c.id) as total_conversions,
  COALESCE(SUM(c.revenue), 0) as total_revenue,
  COUNT(DISTINCT dc.id) as total_clicks,
  rt.total_direct_referrals,
  rt.total_indirect_referrals,
  (CASE WHEN COUNT(DISTINCT dc.id) > 0 THEN (COUNT(DISTINCT c.id) * 1.0 / COUNT(DISTINCT dc.id)) ELSE 0 END) as conversion_rate
FROM profiles p
LEFT JOIN referral_tree rt ON p.id = rt.affiliate_id
LEFT JOIN conversions c ON p.id = c.affiliate_id AND c.status = 'approved'
LEFT JOIN deal_clicks dc ON p.id = dc.affiliate_id
GROUP BY p.id, rt.level, rt.total_earnings, rt.total_payouts, rt.total_direct_referrals, rt.total_indirect_referrals;

CREATE VIEW IF NOT EXISTS v_pending_earnings AS
SELECT
  e.id,
  e.affiliate_id,
  p.full_name,
  p.email,
  e.amount,
  e.level,
  rt.path as referral_path,
  c.deal_id,
  d.name as deal_name,
  c.order_id,
  e.created_at
FROM earnings e
JOIN profiles p ON e.affiliate_id = p.id
LEFT JOIN referral_tree rt ON e.referral_tree_id = rt.id
JOIN conversions c ON e.conversion_id = c.id
LEFT JOIN deals d ON c.deal_id = d.id
WHERE e.is_paid = 0
ORDER BY e.created_at DESC;

CREATE VIEW IF NOT EXISTS v_payout_summary AS
SELECT
  p.id as affiliate_id,
  p.full_name,
  p.email,
  COALESCE(SUM(e.amount), 0) as pending_earnings,
  COUNT(DISTINCT e.id) as pending_conversions,
  COUNT(DISTINCT po.id) as total_payouts,
  COALESCE(SUM(po.amount), 0) as total_payout_amount,
  MAX(po.scheduled_at) as last_payout_date
FROM profiles p
LEFT JOIN earnings e ON p.id = e.affiliate_id AND e.is_paid = 0
LEFT JOIN payouts po ON p.id = po.affiliate_id AND po.status IN ('completed', 'processing')
GROUP BY p.id, p.full_name, p.email
HAVING pending_earnings > 0;

-- ============================================
-- WEB VITALS TABLE (Performance Monitoring)
-- ============================================

-- Store Core Web Vitals metrics for performance monitoring and alerting
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

-- Indexes for fast querying of web vitals

-- Index for time-series queries by date and metric name
CREATE INDEX IF NOT EXISTS idx_web_vitals_created ON web_vitals(created_at);

-- Index for filtering by metric name (for dashboard queries)
CREATE INDEX IF NOT EXISTS idx_web_vitals_name ON web_vitals(name);

-- Composite index for date + metric queries (most common dashboard pattern)
CREATE INDEX IF NOT EXISTS idx_web_vitals_date_metric ON web_vitals(date(created_at), name);

-- Index for URL-based analysis (which pages are slow)
CREATE INDEX IF NOT EXISTS idx_web_vitals_url ON web_vitals(url);

-- Composite covering index for rating-based queries
CREATE INDEX IF NOT EXISTS idx_web_vitals_rating_value ON web_vitals(rating, value);

-- ============================================
-- FRAUD DETECTION & ANOMALY SCHEMA (Migration 021)
-- ============================================

-- Blocked IPs table for real-time blacklist enforcement
CREATE TABLE IF NOT EXISTS blocked_ips (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  ip_address TEXT UNIQUE NOT NULL,
  reason TEXT NOT NULL,
  blocked_by TEXT DEFAULT 'system',
  created_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT,
  is_active INTEGER DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_blocked_ips_ip ON blocked_ips(ip_address);
CREATE INDEX IF NOT EXISTS idx_blocked_ips_active ON blocked_ips(is_active, ip_address);

-- Fraud Reviews table (Immutable Audit Log)
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

CREATE INDEX IF NOT EXISTS idx_fraud_reviews_click ON fraud_reviews(click_id);
CREATE INDEX IF NOT EXISTS idx_fraud_reviews_ip ON fraud_reviews(ip_address);
CREATE INDEX IF NOT EXISTS idx_fraud_reviews_reviewer ON fraud_reviews(reviewer_id);
CREATE INDEX IF NOT EXISTS idx_fraud_reviews_action ON fraud_reviews(action);
CREATE INDEX IF NOT EXISTS idx_fraud_reviews_reviewed_at ON fraud_reviews(reviewed_at DESC);

-- Immutability triggers on fraud_reviews (Audit log cannot be updated or purged)
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

-- ============================================
-- PAYMENTS & TIER ACTIVATIONS (Migration 012 & 022)
-- ============================================

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  payment_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed', 'expired', 'refunded')),
  plan TEXT,
  user_id TEXT,
  amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'USDT',
  txn_id TEXT,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id);
CREATE INDEX IF NOT EXISTS idx_payments_user_created ON payments(user_id, created_at DESC);

-- Tier activation log (audit trail)
CREATE TABLE IF NOT EXISTS tier_activations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  payment_id TEXT,
  old_tier TEXT,
  new_tier TEXT NOT NULL,
  activated_by TEXT DEFAULT 'ipn',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tier_activations_user ON tier_activations(user_id);

-- ============================================
-- EMAIL QUEUE & EVENTS (Migration 018)
-- ============================================

CREATE TABLE IF NOT EXISTS email_queue (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  email TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL,
  html TEXT NOT NULL,
  text TEXT,
  priority INTEGER NOT NULL DEFAULT 2,
  status TEXT NOT NULL DEFAULT 'pending',
  scheduled_at TEXT NOT NULL DEFAULT (datetime('now')),
  sent_at TEXT,
  error TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_email_queue_status_scheduled ON email_queue(status, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_email_queue_user ON email_queue(user_id);
CREATE INDEX IF NOT EXISTS idx_email_queue_type ON email_queue(type);

-- Auto-update updated_at on email_queue
CREATE TRIGGER IF NOT EXISTS trg_email_queue_updated
AFTER UPDATE ON email_queue
FOR EACH ROW
BEGIN
  UPDATE email_queue SET updated_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TABLE IF NOT EXISTS email_events (
  id TEXT PRIMARY KEY,
  queue_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  email TEXT NOT NULL,
  resend_id TEXT,
  reason TEXT,
  payload TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (queue_id) REFERENCES email_queue(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_email_events_queue_id ON email_events(queue_id);
CREATE INDEX IF NOT EXISTS idx_email_events_type ON email_events(event_type);
CREATE INDEX IF NOT EXISTS idx_email_events_created ON email_events(created_at);

-- ============================================
-- DEVICE TOKENS & DEEP LINK ANALYTICS (Migration 020)
-- ============================================

CREATE TABLE IF NOT EXISTS device_tokens (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT NOT NULL,
  platform TEXT NOT NULL CHECK (platform IN ('ios', 'android', 'web')),
  token TEXT,
  expo_token TEXT,
  apns_token TEXT,
  fcm_token TEXT,
  is_active INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_expo ON device_tokens(expo_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_apns ON device_tokens(apns_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_fcm ON device_tokens(fcm_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_platform ON device_tokens(platform);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active ON device_tokens(user_id, is_active);

-- Auto-update updated_at on device_tokens
CREATE TRIGGER IF NOT EXISTS trg_device_tokens_updated
AFTER UPDATE ON device_tokens
FOR EACH ROW
BEGIN
  UPDATE device_tokens SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TABLE IF NOT EXISTS deep_link_analytics (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  user_id TEXT,
  kind TEXT NOT NULL,
  route TEXT NOT NULL,
  source TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  metadata TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_user ON deep_link_analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_kind ON deep_link_analytics(kind);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_route ON deep_link_analytics(route);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_source ON deep_link_analytics(source);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_timestamp ON deep_link_analytics(timestamp);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_created ON deep_link_analytics(created_at);

-- ============================================
-- Schema completed successfully
-- ============================================

SELECT 'Schema installed successfully' as status;
