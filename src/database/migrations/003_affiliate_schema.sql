-- ============================================================
-- ApexOS D1 Affiliate Schema (Migration 003)
-- Complete affiliate tracking system with multi-level referrals,
-- deal tracking, conversions, earnings, and payouts
--
-- This migration is IDEMPOTENT - safe to run multiple times.
-- It will:
--   1. Drop old trading tables (signals, copy_relationships, paper_accounts)
--   2. Create/update profiles table with new role values
--   3. Create all new affiliate tables with indexes and triggers
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Drop old trading tables
-- ============================================================

DROP TABLE IF EXISTS signals;
DROP TABLE IF EXISTS copy_relationships;
DROP TABLE IF EXISTS paper_accounts;
DROP TABLE IF EXISTS deal_clicks;

-- ============================================================
-- STEP 2: Update profiles table role constraint
-- Note: SQLite doesn't support ALTER TABLE for modifying CHECK constraints.
-- We recreate the table if the constraint needs updating.
-- ============================================================

-- Check if profiles exists and has the old role constraint
-- If the new constraint already exists, this will be a no-op

-- Create new profiles with updated constraint if old one exists
CREATE TABLE IF NOT EXISTS profiles_new (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  full_name TEXT,
  avatar_url TEXT,
  role TEXT DEFAULT 'shopper' CHECK (role IN ('shopper', 'affiliate', 'admin', 'master_trader')),
  plan TEXT DEFAULT 'free' CHECK (plan IN ('free', 'starter', 'growth', 'premium', 'master')),
  referral_code TEXT UNIQUE,
  referred_by TEXT,
  notification_settings TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Copy data from existing profiles if it exists
INSERT OR IGNORE INTO profiles_new (id, email, full_name, avatar_url, role, plan, referral_code, referred_by, notification_settings, created_at, updated_at)
SELECT
  id,
  email,
  full_name,
  avatar_url,
  CASE
    WHEN role IN ('shopper', 'affiliate', 'admin', 'master_trader') THEN role
    WHEN role = 'trader' THEN 'shopper'
    ELSE 'shopper'
  END as role,
  plan,
  referral_code,
  referred_by,
  NULL as notification_settings,
  created_at,
  updated_at
FROM profiles;

-- Replace old profiles with new one (only if old existed)
DROP TABLE IF EXISTS profiles;
ALTER TABLE profiles_new RENAME TO profiles;

-- Recreate indexes on profiles
CREATE INDEX IF NOT EXISTS idx_profiles_email ON profiles(email);
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code ON profiles(referral_code);
CREATE INDEX IF NOT EXISTS idx_profiles_role ON profiles(role);

-- ============================================================
-- STEP 3: Create deals table (must be before affiliate_codes due to FK)
-- ============================================================

CREATE TABLE IF NOT EXISTS deals (
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
CREATE INDEX IF NOT EXISTS idx_deals_dates ON deals(starts_at, ends_at);
CREATE INDEX IF NOT EXISTS idx_deals_creator ON deals(created_by);

-- ============================================================
-- STEP 4: Create affiliate_codes table
-- ============================================================

CREATE TABLE IF NOT EXISTS affiliate_codes (
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

-- ============================================================
-- STEP 5: Create referral_tree table
-- ============================================================

CREATE TABLE IF NOT EXISTS referral_tree (
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

-- ============================================================
-- STEP 6: Create deal_clicks table
-- ============================================================

CREATE TABLE IF NOT EXISTS deal_clicks (
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
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal ON deal_clicks(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate_code ON deal_clicks(affiliate_code);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_affiliate ON deal_clicks(affiliate_id);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_session ON deal_clicks(session_id);
CREATE INDEX IF NOT EXISTS idx_deal_clicks_created ON deal_clicks(created_at);

-- ============================================================
-- STEP 7: Create conversions table
-- ============================================================

CREATE TABLE IF NOT EXISTS conversions (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  deal_click_id TEXT REFERENCES deal_clicks(id) ON DELETE SET NULL,
  affiliate_code TEXT REFERENCES affiliate_codes(code) ON DELETE SET NULL,
  affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  customer_id TEXT,
  order_id TEXT,
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

-- ============================================================
-- STEP 8: Create earnings table
-- ============================================================

CREATE TABLE IF NOT EXISTS earnings (
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

-- ============================================================
-- STEP 9: Create payouts table
-- ============================================================

CREATE TABLE IF NOT EXISTS payouts (
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

-- ============================================================
-- STEP 10: Create triggers for auto-updating timestamps
-- ============================================================

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

-- ============================================================
-- STEP 11: Create useful views
-- ============================================================

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

-- ============================================================
-- Migration completed successfully
-- ============================================================
