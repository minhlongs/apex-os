-- ============================================================================
-- Migration 027: Profiles External Exchange Identifiers (external_ids)
-- Module: ApexOS Exchange Webhook Attribution & Profile API Key Linking
-- Target Database: Cloudflare D1 (SQLite)
--
-- Features:
-- 1. Adds external_ids JSON column to profiles for linking exchange API key IDs
--    (e.g. $.okx.api_key_id, $.kucoin.api_key_id, $.binance.api_key_id, $.bybit.api_key_id)
-- 2. Expression indexes on json_extract(external_ids, '$.okx.api_key_id') and
--    json_extract(external_ids, '$.kucoin.api_key_id') for O(1) webhook user matching
-- ============================================================================

PRAGMA foreign_keys = ON;

ALTER TABLE profiles ADD COLUMN external_ids TEXT DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_profiles_okx_api_key
  ON profiles(json_extract(external_ids, '$.okx.api_key_id'));

CREATE INDEX IF NOT EXISTS idx_profiles_kucoin_api_key
  ON profiles(json_extract(external_ids, '$.kucoin.api_key_id'));
