-- ApexOS Staging Database Seed Data
-- This script populates the database with admin user and sample deals

-- ============================================================
-- STEP 1: Create Admin User (Better Auth)
-- ============================================================

INSERT OR IGNORE INTO users (id, email, email_verified, name, created_at, updated_at)
VALUES (
  'admin-001',
  'admin@apex-os.com',
  1,
  'Admin Apex',
  datetime('now'),
  datetime('now')
);

-- ============================================================
-- STEP 2: Create Admin Profile
-- ============================================================

INSERT OR IGNORE INTO profiles (id, email, full_name, avatar_url, role, plan, referral_code, created_at, updated_at)
VALUES (
  'admin-001',
  'admin@apex-os.com',
  'Admin Apex',
  'https://api.dicebear.com/7.x/avataaars/svg?seed=admin',
  'admin',
  'master',
  'ADMIN001',
  datetime('now'),
  datetime('now')
);

-- ============================================================
-- STEP 3: Create Sample Affiliate Users (for testing referral tree)
-- ============================================================

INSERT OR IGNORE INTO users (id, email, email_verified, name, created_at, updated_at)
VALUES
  ('user-001', 'affiliate1@test.com', 1, 'Affiliate One', datetime('now'), datetime('now')),
  ('user-002', 'affiliate2@test.com', 1, 'Affiliate Two', datetime('now'), datetime('now')),
  ('user-003', 'shopper1@test.com', 1, 'Shopper One', datetime('now'), datetime('now')),
  ('user-004', 'shopper2@test.com', 1, 'Shopper Two', datetime('now'), datetime('now'));

INSERT OR IGNORE INTO profiles (id, email, full_name, avatar_url, role, plan, referral_code, referred_by, created_at, updated_at)
VALUES
  ('user-001', 'affiliate1@test.com', 'Affiliate One', 'https://api.dicebear.com/7.x/avataaars/svg?seed=aff1', 'affiliate', 'growth', 'AFF001', NULL, datetime('now'), datetime('now')),
  ('user-002', 'affiliate2@test.com', 'Affiliate Two', 'https://api.dicebear.com/7.x/avataaars/svg?seed=aff2', 'affiliate', 'starter', 'AFF002', 'AFF001', datetime('now'), datetime('now')),
  ('user-003', 'shopper1@test.com', 'Shopper One', 'https://api.dicebear.com/7.x/avataaars/svg?seed=shop1', 'shopper', 'free', 'SHOP001', 'AFF001', datetime('now'), datetime('now')),
  ('user-004', 'shopper2@test.com', 'Shopper Two', 'https://api.dicebear.com/7.x/avataaars/svg?seed=shop2', 'shopper', 'free', 'SHOP002', 'AFF002', datetime('now'), datetime('now'));

-- ============================================================
-- STEP 4: Create Referral Tree Structure
-- ============================================================
-- Note: referral_tree.id references the same value as affiliate_id for easy self-referencing
-- ============================================================

INSERT OR IGNORE INTO referral_tree (id, affiliate_id, parent_id, root_id, level, path, total_direct_referrals, total_indirect_referrals, total_earnings, total_payouts, is_active, joined_at, updated_at)
VALUES
  ('user-001', 'user-001', NULL, NULL, 1, 'user-001', 2, 1, 0.00, 0.00, 1, datetime('now'), datetime('now')),
  ('user-002', 'user-002', 'user-001', 'user-001', 2, 'user-001/user-002', 1, 0, 0.00, 0.00, 1, datetime('now'), datetime('now')),
  ('user-003', 'user-003', 'user-001', 'user-001', 2, 'user-001/user-003', 0, 0, 0.00, 0.00, 1, datetime('now'), datetime('now')),
  ('user-004', 'user-004', 'user-002', 'user-001', 3, 'user-001/user-002/user-004', 0, 0, 0.00, 0.00, 1, datetime('now'), datetime('now'));

-- ============================================================
-- STEP 5: Create Affiliate Codes for Each User
-- ============================================================

INSERT OR IGNORE INTO affiliate_codes (code, affiliate_id, commission_rate, commission_type, max_uses, used_count, is_active, metadata, created_at, updated_at)
VALUES
  ('ADMIN001', 'admin-001', 0.30, 'percentage', -1, 0, 1, '{"type": "master_trader"}', datetime('now'), datetime('now')),
  ('AFF001', 'user-001', 0.30, 'percentage', -1, 0, 1, '{"tier": 1}', datetime('now'), datetime('now')),
  ('AFF002', 'user-002', 0.10, 'percentage', -1, 0, 1, '{"tier": 2}', datetime('now'), datetime('now')),
  ('SHOP001', 'user-003', 0.05, 'percentage', -1, 0, 1, '{"tier": 3}', datetime('now'), datetime('now')),
  ('SHOP002', 'user-004', 0.05, 'percentage', -1, 0, 1, '{"tier": 3}', datetime('now'), datetime('now'));

-- ============================================================
-- STEP 6: Create Sample Deals (Affiliate Offers)
-- ============================================================

INSERT OR IGNORE INTO deals (
  id, name, description, deal_type, product_id, url,
  exchange, category, cashback_pct, is_active,
  starts_at, ends_at, metadata, created_by, created_at, updated_at
) VALUES
-- Binance Deals
  (
    'deal-001',
    'Binance Signup & Trade',
    'Earn cashback when users sign up on Binance and trade. New users get 10% fee discount.',
    'service',
    'binance-signup',
    'https://binance.com/en/register?ref=ADMIN001',
    'binance',
    'spot',
    30.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["exchange", "signup", "trading"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),
  (
    'deal-002',
    'Binance Futures Trading',
    'Higher commission for users who trade futures. 30% of trading fees from referred futures traders.',
    'service',
    'binance-futures',
    'https://binance.com/en/futures/ref?ref=ADMIN001',
    'binance',
    'futures',
    40.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["futures", "leverage", "derivatives"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),

-- Bybit Deals
  (
    'deal-003',
    'Bybit Exchange Signup',
    'Refer users to Bybit and earn 30% commission on their trading fees. Supports spot and futures.',
    'service',
    'bybit-signup',
    'https://bybit.com/en/register?ref=ADMIN001',
    'bybit',
    'spot',
    30.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["exchange", "signup"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),
  (
    'deal-004',
    'Bybit Copy Trading',
    'Earn commission when users join copy trading. Higher payout for successful referrals.',
    'service',
    'bybit-copytrading',
    'https://bybit.com/en/copy-trading?ref=ADMIN001',
    'bybit',
    'futures',
    35.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["copy-trading", "social-trading"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),

-- OKX Deals
  (
    'deal-005',
    'OKX Exchange Signup',
    'One of the largest exchanges. Earn 25% commission on spot and futures trading fees.',
    'service',
    'okx-signup',
    'https://okx.com/affiliate?ref=ADMIN001',
    'okx',
    'spot',
    25.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["exchange", "signup"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),
  (
    'deal-006',
    'OKX DeFi & Web3 Wallet',
    'Promote OKX Web3 wallet and DeFi services. Higher commission for wallet signups.',
    'service',
    'okx-defi',
    'https://okx.com/web3?ref=ADMIN001',
    'okx',
    'spot',
    30.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["defi", "web3", "wallet"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),

-- Coinbase Deals
  (
    'deal-007',
    'Coinbase Signup Bonus',
    'The largest US exchange. Earn $10 worth of crypto for each verified signup.',
    'product',
    'coinbase-signup',
    'https://coinbase.com/affiliate?ref=ADMIN001',
    'coinbase',
    'spot',
    30.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["exchange", "signup", "us"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),

-- Kraken Deals
  (
    'deal-008',
    'Kraken Exchange Signup',
    'Trusted established exchange. Earn 20% commission on spot trading fees.',
    'service',
    'kraken-signup',
    'https://kraken.com/affiliate?ref=ADMIN001',
    'kraken',
    'spot',
    20.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["exchange", "signup"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),

-- Educational/Service Deals
  (
    'deal-009',
    'Crypto Trading Course',
    'Premium trading course with 50% revenue share. High conversion offer.',
    'course',
    'trading-course-101',
    'https://apex-os.com/partners/trading-course?ref=ADMIN001',
    NULL,
    NULL,
    50.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["course", "education", "trading"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  ),

-- High Commission Limited Offer
  (
    'deal-010',
    'Premium VPN for Traders',
    'VPN service for secure trading access worldwide. $15 fixed commission per signup.',
    'subscription',
    'vpn-premium',
    'https://apex-os.com/partners/vpn?ref=ADMIN001',
    NULL,
    NULL,
    0.0,
    1,
    datetime('now'),
    NULL,
    '{"keywords": ["security", "vpn", "privacy"]}',
    'admin-001',
    datetime('now'),
    datetime('now')
  );

-- ============================================================
-- STEP 7: Create Sample Deal Clicks (for analytics)
-- ============================================================

INSERT OR IGNORE INTO deal_clicks (
  id,
  deal_id,
  affiliate_id,
  ip_address,
  user_agent,
  referrer_url,
  session_id,
  created_at
) VALUES
  ('click-001', 'deal-001', 'user-003', '192.168.1.100', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)', 'https://t.me/apexos_signals', 'sess-001', datetime('now', '-2 days')),
  ('click-002', 'deal-001', 'user-004', '192.168.1.101', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)', 'https://twitter.com/apexos', 'sess-002', datetime('now', '-1 day')),
  ('click-003', 'deal-002', 'user-003', '192.168.1.102', 'Mozilla/5.0 (Windows NT 10.0)', 'https://discord.com/channels/123', 'sess-003', datetime('now', '-12 hours')),
  ('click-004', 'deal-003', NULL, '203.0.113.45', 'Mozilla/5.0 (iPad; CPU OS 17_0)', 'https://google.com', 'sess-004', datetime('now', '-6 hours')),
  ('click-005', 'deal-004', NULL, '198.51.100.22', 'Mozilla/5.0 (X11; Linux x86_64)', 'https://youtube.com', 'sess-005', datetime('now', '-3 hours'));

-- ============================================================
-- STEP 8: Create Sample Conversions (for testing earnings)
-- ============================================================

INSERT OR IGNORE INTO conversions (
  id,
  deal_id,
  deal_click_id,
  affiliate_code,
  affiliate_id,
  customer_id,
  order_id,
  revenue,
  currency,
  commission_amount,
  commission_type,
  conversion_type,
  status,
  conversion_data,
  converted_at,
  approved_at
) VALUES
  ('conv-001', 'deal-001', 'click-001', 'SHOP001', 'user-003', 'cust-001', 'ORD-001', 500.00, 'USD', 5.50, 'percentage', 'sale', 'approved', '{"volume_usd": 500, "exchange": "binance"}', datetime('now', '-1 day'), datetime('now')),
  ('conv-002', 'deal-002', 'click-003', 'SHOP001', 'user-003', 'cust-002', 'ORD-002', 250.00, 'USD', 1.75, 'percentage', 'sale', 'approved', '{"volume_usd": 250, "exchange": "binance"}', datetime('now', '-6 hours'), datetime('now')),
  ('conv-003', 'deal-003', 'click-004', NULL, 'admin-001', 'cust-003', 'ORD-003', 1000.00, 'USD', 100.00, 'percentage', 'sale', 'approved', '{"volume_usd": 1000, "exchange": "bybit"}', datetime('now', '-3 hours'), datetime('now'));

-- ============================================================
-- STEP 9: Create Earnings (Multi-tier Commission Distribution)
-- ============================================================

INSERT OR IGNORE INTO earnings (
  id,
  conversion_id,
  affiliate_id,
  referral_tree_id,
  amount,
  commission_type,
  commission_rate,
  level,
  parent_earnings_id,
  earnings_period_start,
  earnings_period_end,
  is_paid,
  paid_at,
  payout_id,
  created_at,
  updated_at
) VALUES
-- Direct commission (Level 1) for conv-001 - affiliate AFF001 (user-001)
  ('earn-001', 'conv-001', 'user-001', 'user-001', 1.65, 'percentage', 0.30, 1, NULL, date('now', 'start of month'), date('now', 'start of month', '+1 month', '-1 day'), 0, NULL, NULL, datetime('now'), datetime('now')),
-- Level 2 commission for conv-001 - affiliate AFF002 (user-002) gets 10%
  ('earn-002', 'conv-001', 'user-002', 'user-002', 0.55, 'percentage', 0.10, 2, 'earn-001', date('now', 'start of month'), date('now', 'start of month', '+1 month', '-1 day'), 0, NULL, NULL, datetime('now'), datetime('now')),
-- Level 3 commission for conv-001 - shopper gets 5%
  ('earn-003', 'conv-001', 'user-003', NULL, 0.00, 'percentage', 0.05, 3, 'earn-002', date('now', 'start of month'), date('now', 'start of month', '+1 month', '-1 day'), 0, NULL, NULL, datetime('now'), datetime('now')),

-- Direct commission for conv-002
  ('earn-004', 'conv-002', 'user-001', 'user-001', 0.525, 'percentage', 0.30, 1, NULL, date('now', 'start of month'), date('now', 'start of month', '+1 month', '-1 day'), 0, NULL, NULL, datetime('now'), datetime('now')),
-- Level 2 for conv-002
  ('earn-005', 'conv-002', 'user-002', 'user-002', 0.175, 'percentage', 0.10, 2, 'earn-004', date('now', 'start of month'), date('now', 'start of month', '+1 month', '-1 day'), 0, NULL, NULL, datetime('now'), datetime('now')),

-- Direct commission for conv-003 (organic, no affiliate code)
  ('earn-006', 'conv-003', 'admin-001', NULL, 100.00, 'percentage', 0.30, 1, NULL, date('now', 'start of month'), date('now', 'start of month', '+1 month', '-1 day'), 0, NULL, NULL, datetime('now'), datetime('now'));

-- ============================================================
-- STEP 10: Create Sample Payout Record
-- ============================================================

INSERT OR IGNORE INTO payouts (
  id,
  affiliate_id,
  payout_method,
  payout_method_details,
  amount,
  currency,
  fee,
  net_amount,
  status,
  scheduled_at,
  paid_at,
  transaction_id,
  notes,
  metadata,
  created_at,
  updated_at
) VALUES
  ('payout-001', 'user-001', 'crypto', '{"network": "stellar", "address": "GABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890"}', 2.175, 'USDC', 0.00, 2.175, 'completed', date('now', '-7 days'), datetime('now'), 'txn_abc123def456', 'Weekly payout for June 2026 week 1', '{"stellar_tx_hash": "abc123..."}', datetime('now', '-7 days'), datetime('now'));

-- ============================================================
-- Seed completed successfully
-- ============================================================

SELECT '✅ Seed data inserted successfully!' as message;
SELECT COUNT(*) as user_count FROM users;
SELECT COUNT(*) as profile_count FROM profiles;
SELECT COUNT(*) as deal_count FROM deals;
SELECT COUNT(*) as affiliate_code_count FROM affiliate_codes;
SELECT COUNT(*) as conversion_count FROM conversions;
SELECT COUNT(*) as earning_count FROM earnings;
