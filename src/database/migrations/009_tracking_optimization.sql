-- ============================================================
-- ApexOS Wallet Connections & Query Optimization
-- Migration 008: Add wallet_connections table and composite indexes
--
-- Issues fixed:
-- 1. Missing wallet_connections table used by matcher.ts lookupUser
-- 2. N+1 query pattern in resolveClick - add composite index on deal_clicks
-- 3. Add composite index on referral_tree(affiliate_id, is_active) as requested
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Create wallet_connections table
-- ============================================================

CREATE TABLE IF NOT EXISTS wallet_connections (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  wallet_address TEXT NOT NULL,
  preferred_chain TEXT DEFAULT 'ethereum',
  is_primary INTEGER DEFAULT 1,
  connected_at TEXT DEFAULT (datetime('now')),
  last_used_at TEXT,
  UNIQUE(profile_id, wallet_address)
);

-- Indexes for wallet_connections
-- Composite covering index for the matcher lookup query:
-- SELECT p.* FROM profiles p JOIN wallet_connections wc ON p.id = wc.profile_id
-- WHERE wc.wallet_address = ? AND wc.is_primary = 1 LIMIT 1
CREATE INDEX IF NOT EXISTS idx_wallet_connections_address_primary ON wallet_connections(wallet_address, is_primary, profile_id);

-- Index for reverse lookups (finding all wallets for a profile)
CREATE INDEX IF NOT EXISTS idx_wallet_connections_profile ON wallet_connections(profile_id);

-- Index for chain-based queries
CREATE INDEX IF NOT EXISTS idx_wallet_connections_chain ON wallet_connections(preferred_chain);

-- ============================================================
-- STEP 2: Add composite index on deal_clicks for resolveClick query
-- ============================================================

-- The resolveClick query pattern:
-- SELECT * FROM deal_clicks
-- WHERE deal_id = ? AND created_at >= ? AND affiliate_code IS NOT NULL AND affiliate_code != ''
-- ORDER BY CASE WHEN affiliate_id = ? THEN 0 ELSE 1 END, created_at DESC
-- LIMIT 1
--
-- This composite index optimizes the WHERE clause filters:
-- - deal_id (equality)
-- - created_at (range for cookie window)
-- Includes affiliate_code to cover the IS NOT NULL check
CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_created_code ON deal_clicks(deal_id, created_at DESC, affiliate_code);

-- Separate index for the affiliate_id ordering preference (used in ORDER BY CASE)
-- This helps when we need to prioritize clicks from a specific affiliate
CREATE INDEX IF NOT EXISTS idx_deal_clicks_deal_affiliate_created ON deal_clicks(deal_id, affiliate_id, created_at DESC);

-- ============================================================
-- STEP 3: Add composite index on referral_tree as requested
-- ============================================================

-- Composite index (affiliate_id, is_active) for queries that filter by affiliate and active status
-- The existing single-column index on affiliate_id is already good for lookups,
-- but this composite is more efficient when is_active filtering is added
CREATE INDEX IF NOT EXISTS idx_referral_tree_affiliate_active ON referral_tree(affiliate_id, is_active);

-- Covering index for the referral tree path queries that join with profiles
-- This helps queries that fetch descendants: WHERE path LIKE ?
CREATE INDEX IF NOT EXISTS idx_referral_tree_path_level ON referral_tree(path, level);

-- ============================================================
-- STEP 4: Add composite index on profiles for referral_code lookups
-- ============================================================

-- The resolveReferralTree query joins referral_tree with profiles on affiliate_id
-- and filters by profiles.referral_code. A covering index helps:
-- SELECT rt.* FROM referral_tree rt JOIN profiles p ON rt.affiliate_id = p.id
-- WHERE p.referral_code = ? OR rt.affiliate_id = ? LIMIT 1
--
-- The existing idx_profiles_referral_code is already good, but adding id makes it covering
CREATE INDEX IF NOT EXISTS idx_profiles_referral_code_id ON profiles(referral_code, id);

-- ============================================================
-- Migration completed
-- ============================================================
