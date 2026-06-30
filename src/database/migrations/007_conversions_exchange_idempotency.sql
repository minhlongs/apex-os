-- ============================================================
-- ApexOS Migration 007: Add Exchange Trade Idempotency Constraint
-- ============================================================
-- This migration adds idempotency protection for exchange webhooks
-- by ensuring unique (exchange_trade_id, exchange_name) pairs.
--
-- Changes:
--  1. Add exchange_trade_id column to conversions (if not exists)
--  2. Add exchange_name column to conversions (if not exists)
--  3. Create unique index on (exchange_trade_id, exchange_name)
--  4. Backfill existing records from conversion_data JSON
--  5. Update webhook handler to populate these columns
--
-- Idempotency: SAFE to run multiple times
-- ============================================================

PRAGMA foreign_keys = ON;

-- ============================================================
-- STEP 1: Add exchange_trade_id column if not exists
-- ============================================================

ALTER TABLE conversions ADD COLUMN IF NOT EXISTS exchange_trade_id TEXT;

-- ============================================================
-- STEP 2: Add exchange_name column if not exists
-- ============================================================

ALTER TABLE conversions ADD COLUMN IF NOT EXISTS exchange_name TEXT;

-- ============================================================
-- STEP 3: Backfill existing records from conversion_data JSON
-- ============================================================
-- For existing conversions, extract exchange and order/trade info
-- from the conversion_data JSON column and populate the new columns

UPDATE conversions
SET
  exchange_name = json_extract(conversion_data, '$.exchange'),
  exchange_trade_id = json_extract(conversion_data, '$.orderId')
WHERE
  exchange_name IS NULL
  AND exchange_trade_id IS NULL
  AND conversion_data IS NOT NULL
  AND json_type(conversion_data) = 'object';

-- ============================================================
-- STEP 4: Create unique index (IF NOT EXISTS)
-- ============================================================
-- This ensures that each (exchange_trade_id, exchange_name) pair
-- can only appear once, preventing duplicate conversions from
-- the same exchange trade webhook.

CREATE UNIQUE INDEX IF NOT EXISTS idx_conversions_trade_id
ON conversions(exchange_trade_id, exchange_name)
WHERE exchange_trade_id IS NOT NULL
  AND exchange_name IS NOT NULL;

-- ============================================================
-- Migration completed successfully
-- ============================================================

SELECT 'Migration 007: Exchange trade idempotency constraint added' as status;
