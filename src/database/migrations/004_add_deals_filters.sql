-- ApexOS: Add exchange and category filters to deals table
-- Migration 004: Add exchange and category columns to deals

-- Add exchange column
ALTER TABLE deals ADD COLUMN exchange TEXT;
-- Create index for exchange after adding
CREATE INDEX IF NOT EXISTS idx_deals_exchange ON deals(exchange);

-- Add category column
ALTER TABLE deals ADD COLUMN category TEXT;
-- Create index for category after adding
CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);

-- Update existing deals with default values based on deal_type or name if possible
-- This is optional but helps with data consistency
UPDATE deals SET exchange = 'binance' WHERE exchange IS NULL AND name LIKE '%Binance%';
UPDATE deals SET exchange = 'bybit' WHERE exchange IS NULL AND name LIKE '%Bybit%';
UPDATE deals SET exchange = 'okx' WHERE exchange IS NULL AND name LIKE '%OKX%';
UPDATE deals SET exchange = 'coinbase' WHERE exchange IS NULL AND name LIKE '%Coinbase%';

UPDATE deals SET category = 'spot' WHERE category IS NULL AND deal_type = 'product';
UPDATE deals SET category = 'futures' WHERE category IS NULL AND name LIKE '%Futures%';
UPDATE deals SET category = 'margin' WHERE category IS NULL AND name LIKE '%Margin%';

-- Add cashback_percent column for display in listings (derived from commission_rate)
ALTER TABLE deals ADD COLUMN cashback_percent REAL;
UPDATE deals SET cashback_percent = default_commission_rate * 100 WHERE cashback_percent IS NULL;

-- Add risk_level for filtering/sorting
ALTER TABLE deals ADD COLUMN risk_level TEXT DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high'));
