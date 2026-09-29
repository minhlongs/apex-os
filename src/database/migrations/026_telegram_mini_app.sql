-- ============================================================================
-- Migration 026: Telegram Mini App (TMA), Bot Events & Viral Social Referral Schema
-- Module: ApexOS Telegram Mini App & Viral Social Referral Bot
-- Sprint: 14
-- Target Database: Cloudflare D1 (SQLite)
--
-- Features:
-- 1. telegram_users: Telegram account identities, profile association, and auth timestamps
-- 2. telegram_referrals: Viral social referral mappings, status tracking, and bonus attribution
-- 3. telegram_bot_events: Immutable audit trail of bot commands, inline queries, and webhook events
-- 4. High-performance composite indexes for instant seeks and leaderboard queries
-- 5. Immutability triggers on telegram_bot_events and auto-update timestamp triggers
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- STEP 1: Define telegram_users table
-- Maps Telegram accounts to ApexOS user profiles and stores auth metadata
-- ============================================================================

CREATE TABLE IF NOT EXISTS telegram_users (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  telegram_id INTEGER NOT NULL UNIQUE,
  user_id TEXT UNIQUE REFERENCES profiles(id) ON DELETE SET NULL,
  username TEXT,
  first_name TEXT NOT NULL,
  last_name TEXT,
  photo_url TEXT,
  language_code TEXT DEFAULT 'en',
  is_premium INTEGER DEFAULT 0 CHECK (is_premium IN (0, 1)),
  auth_date INTEGER,
  last_active_at TEXT DEFAULT (datetime('now')),
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for telegram_users
CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_users_tid 
  ON telegram_users(telegram_id);

CREATE INDEX IF NOT EXISTS idx_telegram_users_uid 
  ON telegram_users(user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_users_lookup 
  ON telegram_users(telegram_id, user_id);

CREATE INDEX IF NOT EXISTS idx_telegram_users_username 
  ON telegram_users(username COLLATE NOCASE);

CREATE INDEX IF NOT EXISTS idx_telegram_users_active 
  ON telegram_users(last_active_at DESC);

-- ============================================================================
-- STEP 2: Define telegram_referrals table
-- Tracks viral referral relationships initiated via Telegram bot or TMA deep links
-- ============================================================================

CREATE TABLE IF NOT EXISTS telegram_referrals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  referrer_id INTEGER REFERENCES telegram_users(telegram_id) ON DELETE SET NULL,
  referee_id INTEGER NOT NULL UNIQUE REFERENCES telegram_users(telegram_id) ON DELETE CASCADE,
  referrer_user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  referee_user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  referral_code TEXT NOT NULL,
  source_chat_id TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'active', 'converted', 'completed', 'rewarded', 'invalid', 'rejected')),
  reward_amount REAL DEFAULT 0.00,
  reward_currency TEXT DEFAULT 'USD',
  converted_at TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for telegram_referrals
CREATE INDEX IF NOT EXISTS idx_telegram_referrals_referrer_code 
  ON telegram_referrals(referrer_id, referral_code);

CREATE INDEX IF NOT EXISTS idx_telegram_referrals_referee 
  ON telegram_referrals(referee_id);

CREATE INDEX IF NOT EXISTS idx_telegram_referrals_referrer 
  ON telegram_referrals(referrer_id);

CREATE INDEX IF NOT EXISTS idx_telegram_referrals_code 
  ON telegram_referrals(referral_code);

CREATE INDEX IF NOT EXISTS idx_telegram_referrals_status_created 
  ON telegram_referrals(status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_referrals_referrer_status 
  ON telegram_referrals(referrer_id, status);

-- ============================================================================
-- STEP 3: Define telegram_bot_events table
-- Append-only immutable audit trail of inbound bot interactions and delivery status
-- ============================================================================

CREATE TABLE IF NOT EXISTS telegram_bot_events (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  event_type TEXT NOT NULL CHECK (event_type IN ('command', 'message', 'inline_query', 'chosen_inline_result', 'callback_query', 'delivery_status', 'referral_start', 'error', 'notification')),
  telegram_id INTEGER,
  chat_id TEXT,
  command TEXT,
  query TEXT,
  payload TEXT DEFAULT '{}',
  delivery_status TEXT DEFAULT 'success' CHECK (delivery_status IN ('pending', 'sent', 'success', 'delivered', 'failed', 'ignored')),
  error_message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Indexes for telegram_bot_events
CREATE INDEX IF NOT EXISTS idx_telegram_bot_events_type_created 
  ON telegram_bot_events(event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_events_command 
  ON telegram_bot_events(command, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_events_user_type 
  ON telegram_bot_events(telegram_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_events_created 
  ON telegram_bot_events(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_telegram_bot_events_status 
  ON telegram_bot_events(delivery_status, created_at DESC);

-- ============================================================================
-- STEP 4: Immutability triggers on telegram_bot_events
-- Prohibit UPDATE and DELETE operations to ensure an immutable audit ledger
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_telegram_bot_events_no_update
BEFORE UPDATE ON telegram_bot_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'telegram_bot_events records are immutable and cannot be updated');
END;

CREATE TRIGGER IF NOT EXISTS trg_telegram_bot_events_no_delete
BEFORE DELETE ON telegram_bot_events
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'telegram_bot_events records are immutable and cannot be deleted');
END;

-- ============================================================================
-- STEP 5: Auto-update timestamp triggers for mutable tables
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_telegram_users_updated
AFTER UPDATE ON telegram_users
FOR EACH ROW
BEGIN
  UPDATE telegram_users SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_telegram_referrals_updated
AFTER UPDATE ON telegram_referrals
FOR EACH ROW
BEGIN
  UPDATE telegram_referrals SET updated_at = datetime('now') WHERE id = old.id;
END;
