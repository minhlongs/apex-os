-- ============================================================================
-- Migration 025: Cross-Exchange Arbitrage & High-Yield Deal Crawler Schema
-- Module: ApexOS Arbitrage & Yield Matrix Engine
-- Sprint: 13
-- Target Database: Cloudflare D1 (SQLite)
--
-- Features:
-- 1. exchange_rate_cards: Normalizes spot/futures maker & taker fees, VIP tiers, and ApexOS cashback %
-- 2. arbitrage_opportunities: Pre-computed cross-exchange fee spreads, cashback advantage, and savings tiers
-- 3. crawler_sync_runs: Audit logging for crawler executions, latency, item count, and status
-- 4. Composite indexes for high-speed matrix querying, pair seeks, and alerting thresholds
-- 5. Auto-update triggers for audit timestamp integrity
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- STEP 1: Define exchange_rate_cards table
-- Stores current normalized fee schedules, volume tiers, and ApexOS cashback
-- ============================================================================

CREATE TABLE IF NOT EXISTS exchange_rate_cards (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit', 'okx', 'kucoin')),
  market_type TEXT NOT NULL CHECK (market_type IN ('spot', 'futures')),
  pair TEXT NOT NULL,
  raw_symbol TEXT,
  maker_fee REAL NOT NULL DEFAULT 0.0,
  taker_fee REAL NOT NULL DEFAULT 0.0,
  default_cashback_pct REAL NOT NULL DEFAULT 0.0 CHECK (default_cashback_pct >= 0.0 AND default_cashback_pct <= 100.0),
  vip_tier TEXT NOT NULL DEFAULT 'VIP0',
  volume_30d_usd REAL DEFAULT 0.0,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (exchange, market_type, pair, vip_tier)
);

CREATE INDEX IF NOT EXISTS idx_rate_cards_pair_mkt 
  ON exchange_rate_cards(pair, market_type);

CREATE INDEX IF NOT EXISTS idx_rate_cards_lookup 
  ON exchange_rate_cards(exchange, market_type, pair, vip_tier);

CREATE INDEX IF NOT EXISTS idx_rate_cards_exchange 
  ON exchange_rate_cards(exchange);

CREATE INDEX IF NOT EXISTS idx_rate_cards_updated 
  ON exchange_rate_cards(updated_at DESC);

-- ============================================================================
-- STEP 2: Define arbitrage_opportunities table
-- Stores pre-calculated fee spreads, cashback differentials, and savings tiers
-- ============================================================================

CREATE TABLE IF NOT EXISTS arbitrage_opportunities (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  pair TEXT NOT NULL,
  market_type TEXT NOT NULL CHECK (market_type IN ('spot', 'futures')),
  base_exchange TEXT NOT NULL CHECK (base_exchange IN ('binance', 'bybit', 'okx', 'kucoin')),
  target_exchange TEXT NOT NULL CHECK (target_exchange IN ('binance', 'bybit', 'okx', 'kucoin')),
  base_taker_fee REAL NOT NULL,
  target_taker_fee REAL NOT NULL,
  base_maker_fee REAL NOT NULL,
  target_maker_fee REAL NOT NULL,
  base_cashback_pct REAL NOT NULL DEFAULT 0.0,
  target_cashback_pct REAL NOT NULL DEFAULT 0.0,
  net_base_fee REAL NOT NULL,
  net_target_fee REAL NOT NULL,
  spread_bps REAL NOT NULL,
  savings_pct REAL NOT NULL,
  opportunity_type TEXT NOT NULL CHECK (opportunity_type IN ('FEE_SPREAD', 'CASHBACK_MAX', 'VIP_PROMOTION')),
  recommendation TEXT NOT NULL,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  monthly_savings_10k REAL DEFAULT 0.00,
  monthly_savings_50k REAL DEFAULT 0.00,
  monthly_savings_250k REAL DEFAULT 0.00,
  annual_savings_10k REAL DEFAULT 0.00,
  annual_savings_50k REAL DEFAULT 0.00,
  annual_savings_250k REAL DEFAULT 0.00,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  detected_at TEXT DEFAULT (datetime('now')),
  expires_at TEXT NOT NULL,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now')),
  UNIQUE (pair, market_type, base_exchange, target_exchange)
);

CREATE INDEX IF NOT EXISTS idx_arbitrage_active_spread 
  ON arbitrage_opportunities(is_active, spread_bps DESC);

CREATE INDEX IF NOT EXISTS idx_arbitrage_pair_active 
  ON arbitrage_opportunities(pair, market_type, is_active);

CREATE INDEX IF NOT EXISTS idx_arbitrage_type_active 
  ON arbitrage_opportunities(opportunity_type, is_active);

CREATE INDEX IF NOT EXISTS idx_arbitrage_deal 
  ON arbitrage_opportunities(deal_id);

CREATE INDEX IF NOT EXISTS idx_arbitrage_expires 
  ON arbitrage_opportunities(is_active, expires_at);

-- ============================================================================
-- STEP 3: Define crawler_sync_runs table
-- Audit and monitoring ledger for crawler sync executions
-- ============================================================================

CREATE TABLE IF NOT EXISTS crawler_sync_runs (
  run_id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  exchange TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'running', 'success', 'partial', 'failed', 'fallback_used')),
  items_count INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_crawler_runs_exchange_created 
  ON crawler_sync_runs(exchange, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_crawler_runs_status 
  ON crawler_sync_runs(status, created_at DESC);

-- ============================================================================
-- STEP 4: Auto-update timestamp triggers
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_exchange_rate_cards_updated
AFTER UPDATE ON exchange_rate_cards
FOR EACH ROW
BEGIN
  UPDATE exchange_rate_cards SET updated_at = datetime('now') WHERE id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_arbitrage_opportunities_updated
AFTER UPDATE ON arbitrage_opportunities
FOR EACH ROW
BEGIN
  UPDATE arbitrage_opportunities SET updated_at = datetime('now') WHERE id = old.id;
END;
