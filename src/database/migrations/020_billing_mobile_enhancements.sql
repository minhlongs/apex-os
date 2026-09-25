-- ============================================================
-- Billing & Mobile Enhancements (Migration 020)
-- Sprint 7: Billing & Wallet Connect + Mobile Push & Analytics
--
-- Target Database: Cloudflare D1 (SQLite)
--
-- Enhancements:
-- 1. Extend profiles table with tier, wallet_address, and preferred_chain
-- 2. Create device_tokens table for push token registration (Expo, APNs, FCM)
-- 3. Create deep_link_analytics table for mobile deep-link batch event ingestion
-- 4. Create performance indexes and triggers for data consistency
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Extend profiles table
-- ============================================================

-- Add tier column with 'BASIC' default (matches Sprint 7 tier levels: BASIC, PREMIUM, ENTERPRISE, MASTER)
ALTER TABLE profiles ADD COLUMN tier TEXT DEFAULT 'BASIC';

-- Add wallet_address column for cryptocurrency wallet binding
ALTER TABLE profiles ADD COLUMN wallet_address TEXT;

-- Add preferred_chain column ('ethereum', 'solana', 'stellar')
ALTER TABLE profiles ADD COLUMN preferred_chain TEXT;

-- Indexes for profile lookups by tier and wallet address
CREATE INDEX IF NOT EXISTS idx_profiles_tier ON profiles(tier);
CREATE INDEX IF NOT EXISTS idx_profiles_wallet_address ON profiles(wallet_address);

-- ============================================================
-- STEP 2: Device Tokens Table (Push Notifications)
-- ============================================================

-- Stores push notification tokens for mobile devices
-- Supports Expo push tokens, native Apple APNs tokens, and Google FCM tokens
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

-- Indexes for device tokens
CREATE INDEX IF NOT EXISTS idx_device_tokens_user ON device_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_device_tokens_token ON device_tokens(token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_expo ON device_tokens(expo_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_apns ON device_tokens(apns_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_fcm ON device_tokens(fcm_token);
CREATE INDEX IF NOT EXISTS idx_device_tokens_platform ON device_tokens(platform);
CREATE INDEX IF NOT EXISTS idx_device_tokens_user_active ON device_tokens(user_id, is_active);

-- Auto-update updated_at timestamp on record modification
CREATE TRIGGER IF NOT EXISTS trg_device_tokens_updated
AFTER UPDATE ON device_tokens
FOR EACH ROW
BEGIN
  UPDATE device_tokens SET updated_at = datetime('now') WHERE id = old.id;
END;

-- ============================================================
-- STEP 3: Deep-Link Analytics Table
-- ============================================================

-- Ingests batched deep-link analytics events from mobile clients
-- Supports authenticated and anonymous client foreground sync
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

-- Indexes for analytics query performance and aggregation
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_user ON deep_link_analytics(user_id);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_kind ON deep_link_analytics(kind);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_route ON deep_link_analytics(route);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_source ON deep_link_analytics(source);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_timestamp ON deep_link_analytics(timestamp);
CREATE INDEX IF NOT EXISTS idx_deep_link_analytics_created ON deep_link_analytics(created_at);
