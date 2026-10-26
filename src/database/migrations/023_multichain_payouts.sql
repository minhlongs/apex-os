-- ============================================================================
-- Migration 023: Multichain Payout Rails, Batches, and Immutable Audit Logs
-- Module: ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
-- Author: worker_m1
-- ============================================================================

-- ============================================================================
-- STEP 1: Define payout_batches table
-- Tracks batch settlement runs, execution status, multi-chain metrics, and totals
-- ============================================================================

CREATE TABLE IF NOT EXISTS payout_batches (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  batch_number TEXT NOT NULL UNIQUE,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'partially_failed', 'failed', 'cancelled')),
  chain TEXT CHECK (chain IN ('stellar', 'ethereum', 'solana') OR chain IS NULL),
  total_payouts INTEGER DEFAULT 0,
  successful_payouts INTEGER DEFAULT 0,
  failed_payouts INTEGER DEFAULT 0,
  total_amount REAL DEFAULT 0.00,
  total_fee REAL DEFAULT 0.00,
  total_gas_fee_usd REAL DEFAULT 0.00,
  executed_by TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  dry_run INTEGER DEFAULT 0,
  scheduled_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  metadata TEXT DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payout_batches_status ON payout_batches(status);
CREATE INDEX IF NOT EXISTS idx_payout_batches_chain ON payout_batches(chain);
CREATE INDEX IF NOT EXISTS idx_payout_batches_created_at ON payout_batches(created_at);

-- ============================================================================
-- STEP 2: Define payout_audit_logs table
-- Append-only audit ledger recording every administrative or automated decision
-- ============================================================================

CREATE TABLE IF NOT EXISTS payout_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  batch_id TEXT REFERENCES payout_batches(id) ON DELETE SET NULL,
  payout_id TEXT REFERENCES payouts(id) ON DELETE SET NULL,
  action TEXT NOT NULL CHECK (action IN ('batch_execution', 'approval', 'override', 'cancellation', 'retry', 'circuit_breaker_pause', 'circuit_breaker_resume')),
  admin_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  admin_email TEXT,
  chain TEXT CHECK (chain IN ('stellar', 'ethereum', 'solana') OR chain IS NULL),
  details TEXT NOT NULL DEFAULT '{}',
  ip_address TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payout_audit_batch ON payout_audit_logs(batch_id);
CREATE INDEX IF NOT EXISTS idx_payout_audit_payout ON payout_audit_logs(payout_id);
CREATE INDEX IF NOT EXISTS idx_payout_audit_action ON payout_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_payout_audit_created_at ON payout_audit_logs(created_at);

-- ============================================================================
-- STEP 3: Immutability triggers on payout_audit_logs
-- Strictly prohibits UPDATE and DELETE operations at database engine level
-- ============================================================================

CREATE TRIGGER IF NOT EXISTS trg_payout_audit_no_update
BEFORE UPDATE ON payout_audit_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'payout_audit_logs records are immutable and cannot be updated/deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_payout_audit_no_delete
BEFORE DELETE ON payout_audit_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'payout_audit_logs records are immutable and cannot be updated/deleted');
END;

-- ============================================================================
-- STEP 4: Extend existing payouts table with multi-chain & ledger audit columns
-- ============================================================================

ALTER TABLE payouts ADD COLUMN batch_id TEXT REFERENCES payout_batches(id) ON DELETE SET NULL;
ALTER TABLE payouts ADD COLUMN chain TEXT DEFAULT 'stellar' CHECK (chain IN ('stellar', 'ethereum', 'solana'));
ALTER TABLE payouts ADD COLUMN idempotency_key TEXT;
ALTER TABLE payouts ADD COLUMN gas_fee_native REAL DEFAULT 0.00;
ALTER TABLE payouts ADD COLUMN gas_fee_usd REAL DEFAULT 0.00;
ALTER TABLE payouts ADD COLUMN error_message TEXT;
ALTER TABLE payouts ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE payouts ADD COLUMN last_retried_at TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_payouts_idempotency_key ON payouts(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_payouts_batch_id ON payouts(batch_id);
CREATE INDEX IF NOT EXISTS idx_payouts_chain_status ON payouts(chain, status);

