-- Sprint 7 Phase 2: Billing & Wallet Connect
-- Payments table for NOWPayments + tier activation

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  payment_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'confirming', 'confirmed', 'failed', 'expired', 'refunded')),
  plan TEXT,
  user_id TEXT,
  amount REAL DEFAULT 0,
  currency TEXT DEFAULT 'USDT',
  txn_id TEXT,
  confirmed_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_payments_user ON payments(user_id);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_payment_id ON payments(payment_id);

-- Tier activation log (audit trail)
CREATE TABLE IF NOT EXISTS tier_activations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  payment_id TEXT,
  old_tier TEXT,
  new_tier TEXT NOT NULL,
  activated_by TEXT DEFAULT 'ipn',
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tier_activations_user ON tier_activations(user_id);
