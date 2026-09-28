-- ============================================================================
-- Migration 024: KYC Tiers, Sanctions Watchlist, and Compliance Audit Trail
-- Module: ApexOS KYC & Regulatory Compliance Engine
-- Author: worker_kyc_m1
-- ============================================================================

-- ============================================================================
-- STEP 1: Extend profiles table with KYC verification tier and status
-- ============================================================================

ALTER TABLE profiles ADD COLUMN kyc_status TEXT DEFAULT 'unverified' CHECK (kyc_status IN ('unverified', 'pending', 'approved', 'rejected', 'requires_action'));
ALTER TABLE profiles ADD COLUMN kyc_tier TEXT DEFAULT 'tier0_unverified';
ALTER TABLE profiles ADD COLUMN kyc_verified_at TEXT;

CREATE INDEX IF NOT EXISTS idx_profiles_kyc_status ON profiles(kyc_status);
CREATE INDEX IF NOT EXISTS idx_profiles_kyc_tier ON profiles(kyc_tier);

-- ============================================================================
-- STEP 2: Define sanctioned_addresses table
-- Multi-chain sanctions database (OFAC SDN, mixer contracts, high-risk clusters)
-- ============================================================================

CREATE TABLE IF NOT EXISTS sanctioned_addresses (
  address TEXT NOT NULL,
  chain TEXT NOT NULL CHECK (chain IN ('ethereum', 'solana', 'stellar')),
  source TEXT,
  risk_score REAL DEFAULT 1.0,
  added_at TEXT DEFAULT (datetime('now')),
  PRIMARY KEY (chain, address)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sanctioned_addresses_chain_addr 
  ON sanctioned_addresses(chain, address COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_sanctioned_addresses_chain 
  ON sanctioned_addresses(chain);

-- Pre-populate known high-profile sanctions & OFAC SDN addresses
INSERT OR IGNORE INTO sanctioned_addresses (address, chain, source, risk_score) VALUES
  ('0xd90e2f925da726b50c4ed8d0fb90ad053324f31b', 'ethereum', 'OFAC SDN - Tornado Cash Router', 1.0),
  ('0x8589427373d6d84e98730d7795d8f6f8731fda16', 'ethereum', 'OFAC SDN - Tornado Cash 0.1 ETH', 1.0),
  ('0x722122df12d4e14e13ac3b6895a86e84145b6967', 'ethereum', 'OFAC SDN - Tornado Cash 1 ETH', 1.0),
  ('0x1da5821544e25c636c1417ba96ade4cf6d2f9b5a', 'ethereum', 'OFAC SDN - Lazarus Group Ronin Exploiter', 1.0),
  ('0x098b716b8aaf21512996dc57eb0615e2383e2f96', 'ethereum', 'OFAC SDN - Lazarus Group Main', 1.0),
  ('4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM', 'solana', 'OFAC SDN - Flagged Malicious Drainer', 1.0),
  ('9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM', 'solana', 'OFAC SDN - Flagged Exploit Cluster', 1.0),
  ('GARF4Z2QYF477XG2LFFXZN2C77X6QXXZ5N4YFXG6Q6NXWNZG6Q6NXWNZ', 'stellar', 'OFAC SDN - Sanctioned Entity Account', 1.0);

-- ============================================================================
-- STEP 3: Define compliance_audit_logs table
-- Append-only audit ledger recording compliance holds, sanctions blocks, and overrides
-- ============================================================================

CREATE TABLE IF NOT EXISTS compliance_audit_logs (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  action TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  actor_id TEXT,
  target_id TEXT,
  details TEXT NOT NULL DEFAULT '{}',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_compliance_audit_action ON compliance_audit_logs(action);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_target ON compliance_audit_logs(target_id);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_severity ON compliance_audit_logs(severity);
CREATE INDEX IF NOT EXISTS idx_compliance_audit_created_at ON compliance_audit_logs(created_at);

-- Immutability triggers on compliance_audit_logs: prohibit UPDATE and DELETE
CREATE TRIGGER IF NOT EXISTS trg_compliance_audit_no_update
BEFORE UPDATE ON compliance_audit_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'compliance_audit_logs records are immutable and cannot be updated/deleted');
END;

CREATE TRIGGER IF NOT EXISTS trg_compliance_audit_no_delete
BEFORE DELETE ON compliance_audit_logs
FOR EACH ROW
BEGIN
  SELECT RAISE(ABORT, 'compliance_audit_logs records are immutable and cannot be updated/deleted');
END;

-- ============================================================================
-- STEP 4: Extend payouts table with compliance tracking columns
-- ============================================================================

ALTER TABLE payouts ADD COLUMN compliance_status TEXT DEFAULT 'clean' CHECK (compliance_status IN ('clean', 'pending_review', 'kyc_required', 'compliance_blocked', 'approved', 'rejected'));
ALTER TABLE payouts ADD COLUMN compliance_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_payouts_compliance_status ON payouts(compliance_status);
