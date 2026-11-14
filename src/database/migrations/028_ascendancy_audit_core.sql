-- ============================================================================
-- Migration 028: Ascendancy Viability Audit Core Schema
-- Atomic Double-Entry Ledger (BIGINT 10^-8 USD), R2 SHA-256 Evidence Vault,
-- CASH_COLLECTED Reconciliation, T+7 Hold, Turnkey/Safe Nonce & Broadcast
-- Recovery, 48h Wallet Timelock, WebAuthn Passkeys, and Short Links (/r/:code)
-- ============================================================================

PRAGMA foreign_keys = ON;

-- ============================================================================
-- 1. System Runtime Flags (Circuit Breakers & Emergency Kill-Switches)
-- ============================================================================
CREATE TABLE IF NOT EXISTS system_runtime_flags (
  flag_key TEXT PRIMARY KEY,
  flag_value TEXT NOT NULL,
  reason TEXT,
  updated_by TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO system_runtime_flags (flag_key, flag_value, reason) VALUES
  ('EMERGENCY_LEDGER_FREEZE', 'false', 'Default operational state'),
  ('EMERGENCY_PAUSE', 'false', 'Default settlement operational state'),
  ('BLOCK_VN_SIGNUPS', 'false', 'Default Vietnam Geo-Fence kill-switch state');

-- ============================================================================
-- 2. R2 Cryptographic Evidence Vault (5-year immutable SHA-256 audit anchor)
-- ============================================================================
CREATE TABLE IF NOT EXISTS r2_evidence_objects (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  source_kind TEXT NOT NULL CHECK (source_kind IN ('rest_poll', 'csv_statement', 'wallet_statement')),
  r2_object_key TEXT NOT NULL UNIQUE,
  payload_sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL CHECK (byte_length >= 0),
  statement_period_start TEXT NOT NULL,
  statement_period_end TEXT NOT NULL,
  retention_until TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_r2_evidence_exchange_period
  ON r2_evidence_objects(exchange, statement_period_start, statement_period_end);
CREATE INDEX IF NOT EXISTS idx_r2_evidence_sha256
  ON r2_evidence_objects(payload_sha256);

-- ============================================================================
-- 3. Partner Cash Reconciliation Batches (CASH_COLLECTED Gate)
-- ============================================================================
CREATE TABLE IF NOT EXISTS partner_cash_reconciliations (
  id TEXT PRIMARY KEY,
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  evidence_id TEXT NOT NULL REFERENCES r2_evidence_objects(id) ON DELETE RESTRICT,
  wallet_evidence_id TEXT REFERENCES r2_evidence_objects(id) ON DELETE RESTRICT,
  uid_allocated_units INTEGER NOT NULL CHECK (uid_allocated_units >= 0),
  wallet_cash_collected_units INTEGER NOT NULL CHECK (wallet_cash_collected_units >= 0),
  discrepancy_units INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL CHECK (status IN ('MATCHED', 'DISCREPANCY_HALTED', 'CLAWBACK_ADJUSTED')),
  reconciled_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_partner_recon_exchange_status
  ON partner_cash_reconciliations(exchange, status, reconciled_at);
CREATE INDEX IF NOT EXISTS idx_partner_recon_evidence
  ON partner_cash_reconciliations(evidence_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_recon_unique_matched_evidence
  ON partner_cash_reconciliations(evidence_id) WHERE status = 'MATCHED';
CREATE UNIQUE INDEX IF NOT EXISTS idx_partner_recon_unique_matched_wallet_evidence
  ON partner_cash_reconciliations(wallet_evidence_id) WHERE status = 'MATCHED' AND wallet_evidence_id IS NOT NULL;

-- ============================================================================
-- 4. Atomic Double-Entry Ledger (BIGINT 10^-8 USD minor units)
-- ============================================================================
CREATE TABLE IF NOT EXISTS ledger_accounts (
  id TEXT PRIMARY KEY,
  owner_type TEXT NOT NULL CHECK (owner_type IN ('system', 'trader', 'affiliate', 'agency', 'treasury', 'reserve')),
  owner_id TEXT NOT NULL,
  account_code TEXT NOT NULL UNIQUE,
  currency TEXT NOT NULL DEFAULT 'USDC',
  settled_balance_units INTEGER NOT NULL DEFAULT 0,
  inflight_balance_units INTEGER NOT NULL DEFAULT 0,
  allow_negative INTEGER NOT NULL DEFAULT 0 CHECK (allow_negative IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (allow_negative = 1 OR settled_balance_units >= 0)
);

CREATE INDEX IF NOT EXISTS idx_ledger_accounts_owner
  ON ledger_accounts(owner_type, owner_id);

CREATE TABLE IF NOT EXISTS ledger_journal_batches (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_fingerprint TEXT NOT NULL,
  journal_type TEXT NOT NULL CHECK (journal_type IN (
    'COMMISSION_INFLIGHT',
    'COMMISSION_SETTLED',
    'COMMISSION_VOID_CLAWBACK',
    'POST_SETTLEMENT_CLAWBACK',
    'WITHDRAWAL_LOCK',
    'WITHDRAWAL_FINALIZED',
    'WITHDRAWAL_REVERTED'
  )),
  status TEXT NOT NULL CHECK (status IN ('INFLIGHT', 'SETTLED', 'VOIDED')),
  exchange TEXT,
  trader_uid TEXT,
  reconciliation_id TEXT REFERENCES partner_cash_reconciliations(id) ON DELETE RESTRICT,
  evidence_id TEXT REFERENCES r2_evidence_objects(id) ON DELETE RESTRICT,
  gross_commission_units INTEGER NOT NULL DEFAULT 0 CHECK (gross_commission_units >= 0),
  hold_until TEXT,
  settled_tx_hash TEXT,
  payout_id TEXT,
  metadata TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_batches_status_hold
  ON ledger_journal_batches(status, hold_until);
CREATE INDEX IF NOT EXISTS idx_ledger_batches_recon
  ON ledger_journal_batches(reconciliation_id);
CREATE INDEX IF NOT EXISTS idx_ledger_batches_exchange_uid
  ON ledger_journal_batches(exchange, trader_uid, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ledger_withdrawal_lock_active_payout
  ON ledger_journal_batches(payout_id)
  WHERE journal_type = 'WITHDRAWAL_LOCK' AND status IN ('INFLIGHT', 'SETTLED') AND payout_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS ledger_postings (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES ledger_journal_batches(id) ON DELETE RESTRICT,
  account_id TEXT NOT NULL REFERENCES ledger_accounts(id) ON DELETE RESTRICT,
  direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
  amount_units INTEGER NOT NULL CHECK (amount_units > 0),
  leg_role TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ledger_postings_batch
  ON ledger_postings(batch_id);
CREATE INDEX IF NOT EXISTS idx_ledger_postings_account_created
  ON ledger_postings(account_id, created_at);

-- ============================================================================
-- 5. Deterministic Signer Nonces, Broadcast Recovery & Safe Cold Queue
-- ============================================================================
CREATE TABLE IF NOT EXISTS signer_nonces (
  chain TEXT NOT NULL CHECK (chain IN ('arbitrum', 'base', 'stellar')),
  signer_address TEXT NOT NULL,
  next_nonce INTEGER NOT NULL DEFAULT 0 CHECK (next_nonce >= 0),
  next_sequence_text TEXT,
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (chain, signer_address)
);

CREATE TABLE IF NOT EXISTS settlement_broadcasts (
  payout_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  affiliate_id TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('stellar', 'arbitrum', 'base')),
  recipient_address TEXT NOT NULL,
  amount_units_1e8 INTEGER NOT NULL CHECK (amount_units_1e8 >= 1000000000),
  chain_token_units TEXT NOT NULL,
  chain_decimals INTEGER NOT NULL CHECK (chain_decimals IN (6, 7)),
  state TEXT NOT NULL CHECK (state IN (
    'QUEUED_COLD_SAFE',
    'SIGNING',
    'BROADCAST_PENDING',
    'CONFIRMED',
    'EXPIRED_RECOVERED',
    'FAILED_ABORTED'
  )),
  signer_address TEXT,
  assigned_nonce INTEGER,
  stellar_sequence TEXT,
  timebounds_max_unix INTEGER,
  tx_hash TEXT,
  signed_raw_tx TEXT,
  rbf_candidate_tx_hash TEXT,
  lock_batch_id TEXT,
  turnkey_activity_id TEXT,
  safe_multisig_tx_hash TEXT,
  error_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_settlement_broadcasts_state_chain
  ON settlement_broadcasts(state, chain, updated_at);
CREATE INDEX IF NOT EXISTS idx_settlement_broadcasts_affiliate_created
  ON settlement_broadcasts(affiliate_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_broadcasts_lock_batch
  ON settlement_broadcasts(lock_batch_id) WHERE lock_batch_id IS NOT NULL;

-- ============================================================================
-- 6. 48-Hour Wallet Timelock & Admin WebAuthn Passkeys
-- ============================================================================
CREATE TABLE IF NOT EXISTS wallet_change_requests (
  id TEXT PRIMARY KEY,
  profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  previous_address TEXT,
  previous_chain TEXT,
  proposed_address TEXT NOT NULL,
  proposed_chain TEXT NOT NULL CHECK (proposed_chain IN ('stellar', 'arbitrum', 'base')),
  unlock_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('PENDING_TIMELOCK', 'ACTIVATED', 'CANCELLED')),
  passkey_verified INTEGER NOT NULL DEFAULT 0 CHECK (passkey_verified IN (0, 1)),
  requested_ip TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_wallet_change_profile_status
  ON wallet_change_requests(profile_id, status, unlock_at);
CREATE INDEX IF NOT EXISTS idx_wallet_change_proposed_addr
  ON wallet_change_requests(proposed_chain, proposed_address);

CREATE TABLE IF NOT EXISTS webauthn_credentials (
  credential_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  public_key_base64 TEXT NOT NULL,
  counter INTEGER NOT NULL DEFAULT 0,
  transports TEXT NOT NULL DEFAULT '[]',
  device_name TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_used_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_webauthn_credentials_user
  ON webauthn_credentials(user_id);

CREATE TABLE IF NOT EXISTS webauthn_challenges (
  challenge_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  challenge TEXT NOT NULL,
  purpose TEXT NOT NULL CHECK (purpose IN ('registration', 'admin_step_up', 'wallet_change')),
  expires_at TEXT NOT NULL,
  consumed INTEGER NOT NULL DEFAULT 0 CHECK (consumed IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_webauthn_challenges_user_purpose
  ON webauthn_challenges(user_id, purpose, consumed, expires_at);

-- ============================================================================
-- 7. Clean-Room Short Links (/r/:code)
-- ============================================================================
CREATE TABLE IF NOT EXISTS short_links (
  code TEXT PRIMARY KEY,
  affiliate_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  deal_id TEXT REFERENCES deals(id) ON DELETE SET NULL,
  exchange TEXT NOT NULL CHECK (exchange IN ('bybit', 'okx', 'bitget', 'kucoin', 'gateio')),
  destination_url TEXT NOT NULL,
  campaign_tag TEXT,
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  click_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_short_links_affiliate_active
  ON short_links(affiliate_id, is_active);
