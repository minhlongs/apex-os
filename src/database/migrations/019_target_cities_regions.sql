-- ApexOS: Add city and region targeting to deals table
-- Migration 019: target_cities and target_regions JSON columns

ALTER TABLE deals ADD COLUMN target_cities TEXT DEFAULT '[]';
ALTER TABLE deals ADD COLUMN target_regions TEXT DEFAULT '[]';

-- Index for JSON containment queries (SQLite JSON functions)
CREATE INDEX IF NOT EXISTS idx_deals_target_cities ON deals((json_extract(target_cities, '$')));
CREATE INDEX IF NOT EXISTS idx_deals_target_regions ON deals((json_extract(target_regions, '$')));
