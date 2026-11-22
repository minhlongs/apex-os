-- Hardening migration 037:
-- 1. Bind exact withdrawal lock identity, payout_id, amount, uniqueness, and terminal proof on WITHDRAWAL_REVERTED.
-- 2. Enforce verified finality timestamps on any transition into HOT, block NULL/COLD lane bypasses,
--    and preserve confirmed lineage against UPDATE or DELETE tampering.
-- Additive and idempotent: never alters historical settlement rows.

DROP TRIGGER IF EXISTS trg_payout_effect_retain_withdrawal;
CREATE TRIGGER trg_payout_effect_retain_withdrawal
BEFORE INSERT ON ledger_journal_batches
WHEN NEW.journal_type = 'WITHDRAWAL_REVERTED' AND EXISTS (
  SELECT 1 FROM payout_effect_attempts a
  WHERE a.active = 1
    AND (a.worker_id IS NOT NULL OR a.signer_address IS NOT NULL)
    AND (
      a.lock_batch_id = json_extract(NEW.metadata, '$.lockBatchId')
      OR (NEW.payout_id IS NOT NULL AND a.payout_id = NEW.payout_id)
      OR EXISTS (
        SELECT 1 FROM ledger_journal_batches lock
        WHERE lock.id = json_extract(NEW.metadata, '$.lockBatchId')
          AND lock.payout_id IS NOT NULL
          AND a.payout_id = lock.payout_id
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'Withdrawal refund denied by retained payout attempt');
END;

DROP TRIGGER IF EXISTS trg_withdrawal_require_terminal_proof;
CREATE TRIGGER trg_withdrawal_require_terminal_proof
BEFORE INSERT ON ledger_journal_batches
WHEN NEW.journal_type = 'WITHDRAWAL_REVERTED' AND (
  -- 1. Must reference a valid INFLIGHT WITHDRAWAL_LOCK with exact matching amount and payout_id (NULL-safe IS)
  NOT EXISTS (
    SELECT 1 FROM ledger_journal_batches lock
    WHERE lock.id = json_extract(NEW.metadata, '$.lockBatchId')
      AND lock.journal_type = 'WITHDRAWAL_LOCK'
      AND lock.status = 'INFLIGHT'
      AND lock.gross_commission_units = NEW.gross_commission_units
      AND NEW.payout_id IS lock.payout_id
  )
  OR
  -- 2. Reject duplicate WITHDRAWAL_REVERTED or WITHDRAWAL_FINALIZED against the same lockBatchId
  EXISTS (
    SELECT 1 FROM ledger_journal_batches prev
    WHERE prev.journal_type IN ('WITHDRAWAL_REVERTED', 'WITHDRAWAL_FINALIZED')
      AND json_extract(prev.metadata, '$.lockBatchId') = json_extract(NEW.metadata, '$.lockBatchId')
  )
  OR
  -- 3. Any broadcast bound to this lock or payout must have exact verified terminal proof and matching amount
  EXISTS (
    SELECT 1 FROM settlement_broadcasts b
    JOIN ledger_journal_batches lock ON lock.id = json_extract(NEW.metadata, '$.lockBatchId')
    WHERE (
      b.lock_batch_id = lock.id
      OR (b.lock_batch_id IS NULL AND lock.payout_id IS NOT NULL AND b.payout_id = lock.payout_id)
      OR (NEW.payout_id IS NOT NULL AND b.payout_id = NEW.payout_id)
    )
      AND (
        NOT EXISTS (
          SELECT 1 FROM settlement_verified_exposure_releases proof
          WHERE proof.payout_id = b.payout_id
        )
        OR (b.lock_batch_id IS NOT NULL AND b.lock_batch_id != lock.id)
        OR (lock.payout_id IS NOT NULL AND b.payout_id != lock.payout_id)
        OR b.amount_units_1e8 != lock.gross_commission_units
      )
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Withdrawal refund requires exact bound lock and durable terminal proof');
END;

-- Enforce fresh, bounded verified finality timestamp on ANY transition into confirmation_lane = 'HOT',
-- and require safe_multisig_tx_hash on any transition into confirmation_lane = 'COLD'.
-- Prevents NULL-lane two-step bypasses, stale/backdated timestamps, and fake COLD exposure releases.
DROP TRIGGER IF EXISTS trg_settlement_enforce_hot_finality_promotion;
CREATE TRIGGER trg_settlement_enforce_hot_finality_promotion
BEFORE UPDATE OF confirmation_lane, confirmation_observed_at, state, safe_multisig_tx_hash ON settlement_broadcasts
WHEN (
  OLD.confirmation_lane IS NOT 'HOT'
  AND NEW.confirmation_lane = 'HOT'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.safe_multisig_tx_hash IS NOT NULL
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash)) = 0
    OR typeof(NEW.confirmation_observed_at) != 'integer'
    OR NEW.confirmation_observed_at <= 0
    OR NEW.confirmation_observed_at > unixepoch('now')
    OR NEW.confirmation_observed_at < unixepoch('now') - 300
  )
) OR (
  OLD.confirmation_lane IS NOT 'COLD'
  AND NEW.confirmation_lane = 'COLD'
  AND (
    NEW.safe_multisig_tx_hash IS NULL
    OR length(trim(NEW.safe_multisig_tx_hash)) = 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'UNVERIFIED_HOT to HOT promotion requires fresh verified finality timestamp and tx_hash');
END;

-- Preserve confirmed transaction lineage, lane transitions, and finalized HOT/COLD observations against tampering.
-- Uses IS NOT (NULL-safe) so SQLite three-valued logic cannot bypass with NULL.
DROP TRIGGER IF EXISTS trg_settlement_preserve_confirmed_finality;
CREATE TRIGGER trg_settlement_preserve_confirmed_finality
BEFORE UPDATE ON settlement_broadcasts
WHEN OLD.state = 'CONFIRMED'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.payout_id IS NOT OLD.payout_id
    OR NEW.tx_hash IS NOT OLD.tx_hash
    OR NEW.lock_batch_id IS NOT OLD.lock_batch_id
    OR NEW.amount_units_1e8 IS NOT OLD.amount_units_1e8
    OR NEW.affiliate_id IS NOT OLD.affiliate_id
    OR NEW.chain IS NOT OLD.chain
    OR NEW.recipient_address IS NOT OLD.recipient_address
    OR NEW.safe_multisig_tx_hash IS NOT OLD.safe_multisig_tx_hash
    OR (
      OLD.confirmation_lane = 'HOT'
      AND (
        NEW.confirmation_lane IS NOT 'HOT'
        OR NEW.confirmation_observed_at IS NOT OLD.confirmation_observed_at
      )
    )
    OR (
      OLD.confirmation_lane = 'COLD'
      AND (
        NEW.confirmation_lane IS NOT 'COLD'
        OR NEW.confirmation_observed_at IS NOT OLD.confirmation_observed_at
      )
    )
    OR (
      OLD.confirmation_lane = 'UNVERIFIED_HOT'
      AND (
        NEW.confirmation_lane IS NULL
        OR NEW.confirmation_lane NOT IN ('UNVERIFIED_HOT', 'HOT')
      )
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'Confirmed settlement lineage and finalized HOT timestamp are immutable');
END;

-- Prevent erasing confirmed settlement lineage or active rolling hot exposure via DELETE.
DROP TRIGGER IF EXISTS trg_settlement_prevent_confirmed_delete;
CREATE TRIGGER trg_settlement_prevent_confirmed_delete
BEFORE DELETE ON settlement_broadcasts
WHEN OLD.state = 'CONFIRMED'
BEGIN
  SELECT RAISE(ABORT, 'Confirmed settlement broadcast rows cannot be deleted');
END;

-- Enforce identical finality invariants on direct INSERT into HOT or COLD lanes so callers
-- cannot bypass UPDATE triggers by inserting pre-forged CONFIRMED HOT/COLD rows.
DROP TRIGGER IF EXISTS trg_settlement_enforce_insert_finality;
CREATE TRIGGER trg_settlement_enforce_insert_finality
BEFORE INSERT ON settlement_broadcasts
WHEN (
  NEW.confirmation_lane = 'HOT'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.safe_multisig_tx_hash IS NOT NULL
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash)) = 0
    OR typeof(NEW.confirmation_observed_at) != 'integer'
    OR NEW.confirmation_observed_at <= 0
    OR NEW.confirmation_observed_at > unixepoch('now')
    OR NEW.confirmation_observed_at < unixepoch('now') - 300
  )
) OR (
  NEW.confirmation_lane = 'COLD'
  AND (
    NEW.safe_multisig_tx_hash IS NULL
    OR length(trim(NEW.safe_multisig_tx_hash)) = 0
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Direct INSERT into HOT/COLD confirmation lane requires verified finality evidence');
END;
