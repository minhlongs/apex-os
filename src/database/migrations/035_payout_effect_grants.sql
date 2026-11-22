-- Every emergency-control mutation invalidates effect grants, including pause and resume.
-- A grant and flag write serialize as writes on the D1 primary, but the external request
-- necessarily occurs after this statement and cannot be made atomic with it.
CREATE TABLE IF NOT EXISTS system_safety_epoch (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  epoch INTEGER NOT NULL CHECK (epoch >= 0)
);

INSERT OR IGNORE INTO system_safety_epoch (singleton, epoch) VALUES (1, 1);

CREATE TRIGGER IF NOT EXISTS trg_system_safety_epoch_flag_insert
AFTER INSERT ON system_runtime_flags
WHEN NEW.flag_key IN ('EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE')
BEGIN
  UPDATE system_safety_epoch SET epoch = epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_system_safety_epoch_flag_update
AFTER UPDATE ON system_runtime_flags
WHEN OLD.flag_key IN ('EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE')
  OR NEW.flag_key IN ('EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE')
BEGIN
  UPDATE system_safety_epoch SET epoch = epoch + 1 WHERE singleton = 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_system_safety_epoch_flag_delete
AFTER DELETE ON system_runtime_flags
WHEN OLD.flag_key IN ('EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE')
BEGIN
  UPDATE system_safety_epoch SET epoch = epoch + 1 WHERE singleton = 1;
END;

-- Ownership is not a lease: expiry or a timeout cannot prove a worker stopped.
CREATE TABLE IF NOT EXISTS payout_effect_attempts (
  attempt_id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL,
  safety_epoch INTEGER NOT NULL CHECK (safety_epoch >= 1),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  worker_id TEXT,
  failed_tx_hash TEXT,
  lock_batch_id TEXT,
  owner_id TEXT,
  owner_type TEXT,
  chain TEXT,
  signer_address TEXT,
  assigned_nonce INTEGER,
  stellar_sequence TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_payout_effect_attempt_active
  ON payout_effect_attempts(payout_id) WHERE active = 1;

-- Each row is a one-shot authorization record for one intended network request.
-- Callers must never replay a grant after an uncertain provider outcome.
CREATE TABLE IF NOT EXISTS payout_effect_grants (
  grant_id TEXT PRIMARY KEY,
  payout_id TEXT NOT NULL REFERENCES settlement_broadcasts(payout_id) ON DELETE RESTRICT,
  attempt_id TEXT NOT NULL REFERENCES payout_effect_attempts(attempt_id),
  effect_kind TEXT NOT NULL CHECK (effect_kind IN (
    'TURNKEY_SIGN', 'STELLAR_SIGN', 'EVM_BROADCAST', 'EVM_REBROADCAST',
    'EVM_RBF_SIGN', 'EVM_RBF_BROADCAST', 'STELLAR_SUBMIT', 'COLD_SUBMIT'
  )),
  tx_hash TEXT,
  payload_sha256 TEXT NOT NULL CHECK (
    length(payload_sha256) = 64 AND payload_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  safety_epoch INTEGER NOT NULL CHECK (safety_epoch >= 1),
  granted_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (payout_id, attempt_id, effect_kind)
);

CREATE INDEX IF NOT EXISTS idx_payout_effect_grants_payout
  ON payout_effect_grants(payout_id, granted_at);

-- Capture the identity and reservation in the same atomic write as first admission.
CREATE TRIGGER IF NOT EXISTS trg_payout_effect_bind_attempt
AFTER INSERT ON payout_effect_grants
BEGIN
  UPDATE payout_effect_attempts
  SET (lock_batch_id, owner_id, owner_type, chain, signer_address, assigned_nonce, stellar_sequence) = (
    SELECT b.lock_batch_id, b.affiliate_id, json_extract(l.metadata, '$.ownerType'),
           b.chain, b.signer_address, b.assigned_nonce, b.stellar_sequence
    FROM settlement_broadcasts b JOIN ledger_journal_batches l ON l.id = b.lock_batch_id
    WHERE b.payout_id = NEW.payout_id
  )
  WHERE attempt_id = NEW.attempt_id AND signer_address IS NULL;
END;

-- Terminal proof retires the attempt and transitions the exact broadcast in one write.
CREATE TRIGGER IF NOT EXISTS trg_payout_effect_publish_failed_receipt
AFTER UPDATE OF failed_tx_hash ON payout_effect_attempts
WHEN OLD.failed_tx_hash IS NULL AND NEW.failed_tx_hash IS NOT NULL
BEGIN
  UPDATE settlement_broadcasts SET state = 'FAILED_ABORTED', tx_hash = NEW.failed_tx_hash,
    error_reason = 'Transaction failed on-chain', updated_at = datetime('now')
  WHERE payout_id = NEW.payout_id AND lock_batch_id = NEW.lock_batch_id AND state = 'BROADCAST_PENDING';
END;

-- The reconciler and direct ledger callers share this write boundary. Neither may
-- refund a retained claim based on age, expiry or absence of stored signed bytes.
CREATE TRIGGER IF NOT EXISTS trg_payout_effect_retain_withdrawal
BEFORE INSERT ON ledger_journal_batches
WHEN NEW.journal_type = 'WITHDRAWAL_REVERTED' AND EXISTS (
  SELECT 1 FROM payout_effect_attempts a
  WHERE a.lock_batch_id = json_extract(NEW.metadata, '$.lockBatchId') AND a.active = 1
    AND (a.worker_id IS NOT NULL OR a.signer_address IS NOT NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'Withdrawal refund denied by retained payout attempt');
END;
