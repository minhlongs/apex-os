-- VN: Không suy đoán dữ liệu cũ; khoản chưa rõ vẫn chiếm hạn mức.
-- EN: No historical backfill; unresolved legacy obligations retain exposure.
ALTER TABLE settlement_broadcasts ADD COLUMN signing_lane TEXT;
ALTER TABLE settlement_broadcasts ADD COLUMN confirmation_lane TEXT;
ALTER TABLE settlement_broadcasts ADD COLUMN confirmation_observed_at INTEGER;
ALTER TABLE settlement_broadcasts ADD COLUMN exposure_release_kind TEXT;
ALTER TABLE settlement_broadcasts ADD COLUMN exposure_released_at INTEGER;
ALTER TABLE settlement_broadcasts ADD COLUMN exposure_release_attempt_id TEXT;
ALTER TABLE payout_effect_attempts ADD COLUMN failed_finality_ledger INTEGER;

CREATE INDEX IF NOT EXISTS idx_settlement_exposure_observation
  ON settlement_broadcasts(state, confirmation_lane, confirmation_observed_at);

-- VN: Cùng một lệnh ghi lưu chứng cứ và trạng thái cho đúng lần gửi.
-- EN: Replace the prior publisher, not a second order-dependent trigger.
-- Status-only failure retains exposure until chain finality / Stellar ledger inclusion is proven.
DROP TRIGGER IF EXISTS trg_payout_effect_publish_failed_receipt;
CREATE TRIGGER trg_payout_effect_publish_failed_receipt
AFTER UPDATE OF failed_tx_hash ON payout_effect_attempts
WHEN OLD.failed_tx_hash IS NULL AND NEW.failed_tx_hash IS NOT NULL
BEGIN
  UPDATE settlement_broadcasts SET state = 'FAILED_ABORTED', tx_hash = NEW.failed_tx_hash,
    exposure_release_kind = CASE
      WHEN typeof(NEW.failed_finality_ledger) = 'integer' AND NEW.failed_finality_ledger > 0
      THEN 'CHAIN_FINALIZED_FAILURE'
      ELSE NULL
    END,
    exposure_released_at = CASE
      WHEN typeof(NEW.failed_finality_ledger) = 'integer' AND NEW.failed_finality_ledger > 0
      THEN unixepoch('now')
      ELSE NULL
    END,
    exposure_release_attempt_id = CASE
      WHEN typeof(NEW.failed_finality_ledger) = 'integer' AND NEW.failed_finality_ledger > 0
      THEN NEW.attempt_id
      ELSE NULL
    END,
    error_reason = 'Transaction failed on-chain', updated_at = datetime('now')
  WHERE payout_id = NEW.payout_id AND lock_batch_id = NEW.lock_batch_id
    AND affiliate_id = NEW.owner_id AND state = 'BROADCAST_PENDING'
    AND chain = NEW.chain AND signer_address IS NEW.signer_address
    AND assigned_nonce IS NEW.assigned_nonce AND stellar_sequence IS NEW.stellar_sequence
    AND EXISTS (SELECT 1 FROM payout_effect_grants g
      WHERE g.attempt_id = NEW.attempt_id AND g.payout_id = NEW.payout_id
        AND g.safety_epoch = NEW.safety_epoch AND lower(g.tx_hash) = lower(NEW.failed_tx_hash)
        AND ((NEW.chain = 'stellar' AND g.effect_kind = 'STELLAR_SUBMIT') OR
          (NEW.chain IN ('arbitrum', 'base') AND g.effect_kind IN
            ('EVM_BROADCAST', 'EVM_REBROADCAST', 'EVM_RBF_BROADCAST'))));
END;

-- The same evidence predicate governs budget, retries and ledger refunds.
CREATE VIEW IF NOT EXISTS settlement_verified_exposure_releases AS
SELECT b.payout_id FROM settlement_broadcasts b
WHERE b.state IN ('FAILED_ABORTED', 'EXPIRED_RECOVERED')
  AND typeof(b.exposure_released_at) = 'integer'
  AND b.exposure_released_at > 0 AND b.exposure_released_at <= unixepoch('now')
  AND EXISTS (SELECT 1 FROM payout_effect_attempts a
    WHERE a.attempt_id = b.exposure_release_attempt_id AND a.payout_id = b.payout_id
      AND a.lock_batch_id IS b.lock_batch_id AND a.owner_id = b.affiliate_id
      AND b.state = 'FAILED_ABORTED'
      AND (
        (b.exposure_release_kind = 'PRE_SUBMISSION_ABORT'
          AND NOT EXISTS (SELECT 1 FROM payout_effect_grants g WHERE g.attempt_id = a.attempt_id))
        OR
        (b.exposure_release_kind = 'CHAIN_FINALIZED_FAILURE'
          AND a.active = 0
          AND a.failed_tx_hash IS NOT NULL
          AND b.tx_hash IS NOT NULL
          AND lower(a.failed_tx_hash) = lower(b.tx_hash)
          AND typeof(a.failed_finality_ledger) = 'integer'
          AND a.failed_finality_ledger > 0
          AND EXISTS (SELECT 1 FROM payout_effect_grants g
            WHERE g.attempt_id = a.attempt_id AND g.payout_id = b.payout_id
              AND g.safety_epoch = a.safety_epoch AND lower(g.tx_hash) = lower(a.failed_tx_hash)
              AND ((b.chain = 'stellar' AND g.effect_kind = 'STELLAR_SUBMIT') OR
                (b.chain IN ('arbitrum', 'base') AND g.effect_kind IN
                  ('EVM_BROADCAST', 'EVM_REBROADCAST', 'EVM_RBF_BROADCAST')))))
      ));

-- VN: Nhãn kết thúc lịch sử không đủ để hoàn tiền, kể cả gọi ledger trực tiếp.
-- EN: Enforce proof at the shared ledger write boundary, including direct callers.
CREATE TRIGGER IF NOT EXISTS trg_withdrawal_require_terminal_proof
BEFORE INSERT ON ledger_journal_batches
WHEN NEW.journal_type = 'WITHDRAWAL_REVERTED' AND EXISTS (
  SELECT 1 FROM settlement_broadcasts b
  JOIN ledger_journal_batches lock ON lock.id = json_extract(NEW.metadata, '$.lockBatchId')
    AND (b.lock_batch_id = lock.id OR (b.lock_batch_id IS NULL AND b.payout_id = lock.payout_id))
  WHERE NOT EXISTS (SELECT 1 FROM settlement_verified_exposure_releases proof
                    WHERE proof.payout_id = b.payout_id)
)
BEGIN
  SELECT RAISE(ABORT, 'Withdrawal refund requires exact durable terminal proof');
END;
