-- ============================================================================
-- Migration 031: Ascendancy Phase 2 — Non-Custodial Trader UID Binding,
-- Short-Link Click Telemetry, Shadow Reconciliation, Exclusive Deposit
-- Ownership, Automated 5-Exchange Partner Poller Telemetry & B2B Contracts
--
-- Strictly additive migration building on 028_ascendancy_audit_core.sql:
-- 1. trader_exchange_uids: Non-custodial read-only UID binding across the 5
--    approved partner exchanges (bybit, okx, bitget, kucoin, gateio) with
--    global UNIQUE(exchange, exchange_uid) Sybil/claim protection.
-- 2. short_link_clicks: First-class DDL for /r/[code] click telemetry so
--    fresh D1 deployments have deterministic schema + indexes before traffic.
-- 3. partner_shadow_reconciliations: 30-day shadow audit log for KuCoin UTA v2
--    and Gate.io v4 (and dry-run batches) anchored to immutable R2 SHA-256
--    evidence objects without minting live ledger balances prematurely.
-- 4. partner_poller_runs: Operational telemetry for scheduled cron and manual
--    Passkey-gated partner polling runs (including SKIPPED_MISSING_CREDENTIALS).
-- 5. partner_reconciliation_deposits & partner_reconciliation_items: Global
--    exclusive deposit and external record ownership bound atomically inside
--    db.batch(...) so no wallet deposit can ever fund two reconciliations across
--    sequential or concurrent poller cycles.
-- 6. b2b_agency_contracts: White-label B2B partner split schedules enforcing
--    Safe-Spread Waterfall Invariant I4 (sum of basis points === 10000).
-- 7. system_runtime_flags: Seeds PARTNER_KUCOIN_LIVE='false' and
--    PARTNER_GATEIO_LIVE='false' so promotion to live ledger minting is a
--    Passkey-gated runtime toggle rather than a code redeploy.
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. Non-Custodial Trader Exchange UID Bindings
-- ============================================================================
CREATE TABLE IF NOT EXISTS trader_exchange_uids (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  exchange_uid TEXT NOT NULL,
  linked_short_code TEXT REFERENCES short_links(code) ON DELETE SET NULL,
  verification_status TEXT NOT NULL DEFAULT 'PENDING_FIRST_TRADE' CHECK (
    verification_status IN ('PENDING_FIRST_TRADE', 'VERIFIED_BY_PARTNER', 'REJECTED')
  ),
  verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (exchange, exchange_uid)
);

CREATE INDEX IF NOT EXISTS idx_trader_exchange_uids_profile
  ON trader_exchange_uids(profile_id, exchange);
CREATE INDEX IF NOT EXISTS idx_trader_exchange_uids_lookup
  ON trader_exchange_uids(exchange, exchange_uid, verification_status);

-- ============================================================================
-- 2. Clean-Room Short-Link Click Telemetry (/r/[code])
-- ============================================================================
CREATE TABLE IF NOT EXISTS short_link_clicks (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  affiliate_id TEXT NOT NULL,
  deal_id TEXT,
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  ip_hash TEXT NOT NULL,
  ua_hash TEXT NOT NULL,
  country_code TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_short_link_clicks_code_created
  ON short_link_clicks(code, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_short_link_clicks_affiliate_created
  ON short_link_clicks(affiliate_id, created_at DESC);

-- ============================================================================
-- 3. Partner Shadow Reconciliations (30-Day Shadow Gate for KuCoin & Gate.io)
-- ============================================================================
CREATE TABLE IF NOT EXISTS partner_shadow_reconciliations (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  evidence_id TEXT NOT NULL REFERENCES r2_evidence_objects(id) ON DELETE RESTRICT,
  wallet_evidence_id TEXT REFERENCES r2_evidence_objects(id) ON DELETE RESTRICT,
  row_count INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
  mapped_uid_count INTEGER NOT NULL DEFAULT 0 CHECK (mapped_uid_count >= 0),
  unmapped_uid_count INTEGER NOT NULL DEFAULT 0 CHECK (unmapped_uid_count >= 0),
  simulated_gross_units INTEGER NOT NULL DEFAULT 0,
  wallet_cash_collected_units INTEGER NOT NULL DEFAULT 0 CHECK (wallet_cash_collected_units >= 0),
  discrepancy_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('SHADOW_LOGGED', 'SHADOW_DISCREPANCY', 'PROMOTED_READY')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_partner_shadow_recon_exchange_created
  ON partner_shadow_reconciliations(exchange, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_shadow_recon_evidence
  ON partner_shadow_reconciliations(evidence_id);

-- ============================================================================
-- 4. Automated Partner HTTP Poller Run Telemetry
-- ============================================================================
CREATE TABLE IF NOT EXISTS partner_poller_runs (
  id TEXT PRIMARY KEY,
  trigger_source TEXT NOT NULL CHECK (trigger_source IN ('cron', 'admin_manual')),
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  mode TEXT NOT NULL CHECK (mode IN ('ACTIVE', 'SHADOW_ONLY', 'SKIPPED_MISSING_CREDENTIALS', 'HALTED_FLAG')),
  status TEXT NOT NULL CHECK (status IN ('SUCCESS', 'SKIPPED_MISSING_CREDENTIALS', 'DISCREPANCY_HALTED', 'ERROR')),
  fetched_rows INTEGER NOT NULL DEFAULT 0 CHECK (fetched_rows >= 0),
  minted_batches INTEGER NOT NULL DEFAULT 0 CHECK (minted_batches >= 0),
  evidence_id TEXT REFERENCES r2_evidence_objects(id) ON DELETE SET NULL,
  reconciliation_id TEXT,
  error_code TEXT,
  details TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  completed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_partner_poller_runs_exchange_started
  ON partner_poller_runs(exchange, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_partner_poller_runs_started
  ON partner_poller_runs(started_at DESC);

-- ============================================================================
-- 5. Exclusive Wallet Deposit Ownership & Authorized Reconciliation Items
-- ============================================================================
CREATE TABLE IF NOT EXISTS partner_reconciliation_deposits (
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  deposit_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL REFERENCES partner_cash_reconciliations(id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (exchange, deposit_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_recon_deposits_reconciliation
  ON partner_reconciliation_deposits(reconciliation_id);

CREATE TABLE IF NOT EXISTS partner_reconciliation_items (
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  external_record_id TEXT NOT NULL,
  reconciliation_id TEXT NOT NULL REFERENCES partner_cash_reconciliations(id) ON DELETE RESTRICT,
  journal_kind TEXT NOT NULL CHECK (journal_kind IN ('COMMISSION_INFLIGHT', 'CLAWBACK')),
  gross_units INTEGER NOT NULL CHECK (gross_units > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (exchange, external_record_id)
);

CREATE INDEX IF NOT EXISTS idx_partner_recon_items_reconciliation
  ON partner_reconciliation_items(reconciliation_id);

-- ============================================================================
-- 6. White-Label B2B Agency Split Contracts (Safe-Spread Waterfall I4)
--    Mirrors src/lib/ledger/waterfall.ts (WaterfallConfig) in basis points:
--    - clawback_reserve_bps: fraction of gross C (default 500 = 5.00%)
--    - trader_cashback_bps: fraction of distributable D = C - R (default 5000 = 50.00%)
--    - tier1_spread_bps: L1 share of spread S = D - E_trader (default 3000 = 30.00%)
--    - tier2_spread_bps: B2B agency override share of spread S (default 1000 = 10.00%, max 1000)
--    - tier3_spread_bps: hard-locked 0 per Vietnam Decree 40/2018/ND-CP
--    - Solvency cap: tier1_spread_bps + tier2_spread_bps <= 4500 (45.00% of spread S)
-- ============================================================================
CREATE TABLE IF NOT EXISTS b2b_agency_contracts (
  id TEXT PRIMARY KEY,
  agency_profile_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
  agency_name TEXT NOT NULL,
  clawback_reserve_bps INTEGER NOT NULL DEFAULT 500 CHECK (clawback_reserve_bps >= 500 AND clawback_reserve_bps <= 2500),
  trader_cashback_bps INTEGER NOT NULL DEFAULT 5000 CHECK (trader_cashback_bps >= 0 AND trader_cashback_bps <= 8000),
  tier1_spread_bps INTEGER NOT NULL DEFAULT 3000 CHECK (tier1_spread_bps >= 0 AND tier1_spread_bps <= 4500),
  tier2_spread_bps INTEGER NOT NULL DEFAULT 1000 CHECK (tier2_spread_bps >= 0 AND tier2_spread_bps <= 1000),
  tier3_spread_bps INTEGER NOT NULL DEFAULT 0 CHECK (tier3_spread_bps = 0),
  status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'PAUSED', 'TERMINATED')),
  notes TEXT,
  created_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (tier1_spread_bps + tier2_spread_bps <= 4500)
);

CREATE INDEX IF NOT EXISTS idx_b2b_agency_contracts_status
  ON b2b_agency_contracts(status, updated_at DESC);

-- ============================================================================
-- 7. Runtime Feature Flags for Shadow-to-Live Exchange Promotion
-- ============================================================================
INSERT OR IGNORE INTO system_runtime_flags (flag_key, flag_value, reason) VALUES
  ('PARTNER_KUCOIN_LIVE', 'false', '30-day shadow reconciliation gate for KuCoin UTA v2'),
  ('PARTNER_GATEIO_LIVE', 'false', '30-day shadow reconciliation gate for Gate.io v4');
