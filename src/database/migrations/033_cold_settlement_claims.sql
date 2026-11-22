-- A finalized token movement can be attributed to exactly one withdrawal. Claims are retained
-- even when ledger writes fail or are frozen, so another payout cannot consume that movement.
CREATE TABLE IF NOT EXISTS cold_settlement_claims (
  network TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  payout_id TEXT NOT NULL UNIQUE REFERENCES settlement_broadcasts(payout_id) ON DELETE RESTRICT,
  lock_batch_id TEXT NOT NULL UNIQUE REFERENCES ledger_journal_batches(id) ON DELETE RESTRICT,
  chain TEXT NOT NULL CHECK (chain IN ('stellar', 'arbitrum', 'base')),
  block_reference TEXT NOT NULL,
  source_address TEXT NOT NULL,
  recipient_address TEXT NOT NULL,
  asset TEXT NOT NULL,
  amount_token_units TEXT NOT NULL,
  claimed_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (network, tx_hash, operation_id)
);
