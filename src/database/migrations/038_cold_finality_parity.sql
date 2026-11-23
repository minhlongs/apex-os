-- Migration 038: Cold Finality Parity & Evidence Uniqueness
-- Brings COLD settlement finality enforcement to full parity with HOT:
-- 1. Enforces non-empty, whitespace-free payout_id, lock_batch_id, distinct safe_multisig_tx_hash
--    and tx_hash, state = 'CONFIRMED', matching signing_lane, and fresh bounded
--    confirmation_observed_at on COLD INSERT and UPDATE.
-- 2. Enforces UNVERIFIED_HOT invariants, blocks NULL-lane bypasses on CONFIRMED transitions,
--    and rejects unknown signing_lane / confirmation_lane values.
-- 3. Blocks HOT <-> COLD signing_lane switching except legitimate pre-broadcast
--    HOT -> COLD escalation into QUEUED_COLD_SAFE, and preserves confirmed lineage
--    (including chain_token_units, chain_decimals, signer_address, idempotency_key).
-- 4. Enforces unique non-empty tx_hash on HOT/non-COLD rows (allowing multi-op batched COLD
--    settlements enforced by cold_settlement_claims PRIMARY KEY (network, tx_hash, operation_id))
--    and unique safe_multisig_tx_hash (Case A invariant: 1:1 Safe proposal hash per payout;
--    Safe MultiSend shared proposal hashes are NOT currently supported and are intentionally rejected).
-- Additive and idempotent: never alters historical settlement rows and never blocks pending COLD rows.

DROP INDEX IF EXISTS idx_settlement_broadcasts_unique_tx_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_broadcasts_unique_tx_hash
  ON settlement_broadcasts(lower(trim(tx_hash, ' ' || char(9) || char(10) || char(13))))
  WHERE tx_hash IS NOT NULL
    AND length(trim(tx_hash, ' ' || char(9) || char(10) || char(13))) > 0
    AND safe_multisig_tx_hash IS NULL
    AND (signing_lane IS NULL OR signing_lane != 'COLD')
    AND (confirmation_lane IS NULL OR confirmation_lane != 'COLD');

DROP INDEX IF EXISTS idx_settlement_broadcasts_unique_safe_tx_hash;
CREATE UNIQUE INDEX IF NOT EXISTS idx_settlement_broadcasts_unique_safe_tx_hash
  ON settlement_broadcasts(lower(trim(safe_multisig_tx_hash, ' ' || char(9) || char(10) || char(13))))
  WHERE safe_multisig_tx_hash IS NOT NULL
    AND length(trim(safe_multisig_tx_hash, ' ' || char(9) || char(10) || char(13))) > 0;

DROP INDEX IF EXISTS idx_cold_settlement_claims_canonical_op;
CREATE UNIQUE INDEX IF NOT EXISTS idx_cold_settlement_claims_canonical_op
  ON cold_settlement_claims(
    lower(trim(network, ' ' || char(9) || char(10) || char(13))),
    lower(trim(tx_hash, ' ' || char(9) || char(10) || char(13))),
    trim(operation_id, ' ' || char(9) || char(10) || char(13))
  );

DROP TRIGGER IF EXISTS trg_settlement_enforce_hot_finality_promotion;
CREATE TRIGGER trg_settlement_enforce_hot_finality_promotion
BEFORE UPDATE ON settlement_broadcasts
WHEN (
  -- Block HOT <-> COLD signing_lane switching once lane is set, except legitimate
  -- pre-broadcast HOT -> COLD escalation into QUEUED_COLD_SAFE.
  (
    OLD.signing_lane IS NOT NULL
    AND NEW.signing_lane IS NOT OLD.signing_lane
    AND NOT (
      OLD.signing_lane = 'HOT'
      AND NEW.signing_lane = 'COLD'
      AND OLD.state IN ('SIGNING', 'FAILED_ABORTED', 'EXPIRED_RECOVERED')
      AND NEW.state = 'QUEUED_COLD_SAFE'
      AND OLD.tx_hash IS NULL
      AND OLD.signed_raw_tx IS NULL
      AND OLD.confirmation_lane IS NULL
      AND NEW.confirmation_lane IS NULL
    )
  )
) OR (
  -- Reject unknown signing_lane values
  (NEW.signing_lane IS NOT NULL AND NEW.signing_lane NOT IN ('HOT', 'COLD'))
) OR (
  -- Reject unknown confirmation_lane values
  (NEW.confirmation_lane IS NOT NULL AND NEW.confirmation_lane NOT IN ('HOT', 'COLD', 'UNVERIFIED_HOT'))
) OR (
  -- Block NULL-lane bypass when transitioning into CONFIRMED
  (OLD.state IS NOT 'CONFIRMED' AND NEW.state = 'CONFIRMED' AND NEW.confirmation_lane IS NULL)
) OR (
  -- Enforce UNVERIFIED_HOT invariants on UPDATE
  (OLD.confirmation_lane IS NOT 'UNVERIFIED_HOT' OR OLD.state IS NOT 'CONFIRMED')
  AND NEW.confirmation_lane = 'UNVERIFIED_HOT'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.safe_multisig_tx_hash IS NOT NULL
    OR (NEW.signing_lane IS NOT NULL AND NEW.signing_lane != 'HOT')
    OR NEW.payout_id IS NULL
    OR length(trim(NEW.payout_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.payout_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
  )
) OR (
  -- Full HOT finality invariants on promotion into confirmation_lane = 'HOT'
  (OLD.confirmation_lane IS NOT 'HOT' OR OLD.state IS NOT 'CONFIRMED')
  AND NEW.confirmation_lane = 'HOT'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.payout_id IS NULL
    OR length(trim(NEW.payout_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.payout_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.safe_multisig_tx_hash IS NOT NULL
    OR NEW.signing_lane IS NOT 'HOT'
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR typeof(NEW.confirmation_observed_at) != 'integer'
    OR NEW.confirmation_observed_at <= 0
    OR NEW.confirmation_observed_at > unixepoch('now')
    OR NEW.confirmation_observed_at < unixepoch('now') - 300
  )
) OR (
  -- Full COLD finality parity on promotion into confirmation_lane = 'COLD'
  (OLD.confirmation_lane IS NOT 'COLD' OR OLD.state IS NOT 'CONFIRMED')
  AND NEW.confirmation_lane = 'COLD'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.payout_id IS NULL
    OR length(trim(NEW.payout_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.payout_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.lock_batch_id IS NULL
    OR length(trim(NEW.lock_batch_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.lock_batch_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.signing_lane IS NOT 'COLD'
    OR NEW.safe_multisig_tx_hash IS NULL
    OR length(trim(NEW.safe_multisig_tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.safe_multisig_tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR lower(trim(NEW.safe_multisig_tx_hash, ' ' || char(9) || char(10) || char(13)))
       = lower(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13)))
    OR typeof(NEW.confirmation_observed_at) != 'integer'
    OR NEW.confirmation_observed_at <= 0
    OR NEW.confirmation_observed_at > unixepoch('now')
    OR NEW.confirmation_observed_at < unixepoch('now') - 300
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Settlement finality promotion requires valid lane, distinct evidence, and fresh timestamp');
END;

DROP TRIGGER IF EXISTS trg_settlement_preserve_confirmed_finality;
CREATE TRIGGER trg_settlement_preserve_confirmed_finality
BEFORE UPDATE ON settlement_broadcasts
WHEN OLD.state = 'CONFIRMED'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.payout_id IS NOT OLD.payout_id
    OR NEW.idempotency_key IS NOT OLD.idempotency_key
    OR NEW.tx_hash IS NOT OLD.tx_hash
    OR NEW.lock_batch_id IS NOT OLD.lock_batch_id
    OR NEW.amount_units_1e8 IS NOT OLD.amount_units_1e8
    OR NEW.chain_token_units IS NOT OLD.chain_token_units
    OR NEW.chain_decimals IS NOT OLD.chain_decimals
    OR NEW.signer_address IS NOT OLD.signer_address
    OR NEW.affiliate_id IS NOT OLD.affiliate_id
    OR NEW.chain IS NOT OLD.chain
    OR NEW.recipient_address IS NOT OLD.recipient_address
    OR NEW.safe_multisig_tx_hash IS NOT OLD.safe_multisig_tx_hash
    OR NEW.signing_lane IS NOT OLD.signing_lane
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
  SELECT RAISE(ABORT, 'Confirmed settlement lineage and finalized HOT/COLD timestamp are immutable');
END;

DROP TRIGGER IF EXISTS trg_settlement_enforce_insert_finality;
CREATE TRIGGER trg_settlement_enforce_insert_finality
BEFORE INSERT ON settlement_broadcasts
WHEN (
  -- Reject unknown signing_lane values
  (NEW.signing_lane IS NOT NULL AND NEW.signing_lane NOT IN ('HOT', 'COLD'))
) OR (
  -- Reject unknown confirmation_lane values
  (NEW.confirmation_lane IS NOT NULL AND NEW.confirmation_lane NOT IN ('HOT', 'COLD', 'UNVERIFIED_HOT'))
) OR (
  -- Block NULL-lane bypass on direct CONFIRMED INSERT
  (NEW.state = 'CONFIRMED' AND NEW.confirmation_lane IS NULL)
) OR (
  -- Enforce UNVERIFIED_HOT invariants on direct INSERT
  NEW.confirmation_lane = 'UNVERIFIED_HOT'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.safe_multisig_tx_hash IS NOT NULL
    OR (NEW.signing_lane IS NOT NULL AND NEW.signing_lane != 'HOT')
    OR NEW.payout_id IS NULL
    OR length(trim(NEW.payout_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.payout_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
  )
) OR (
  -- Full HOT finality invariants on direct INSERT
  NEW.confirmation_lane = 'HOT'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.payout_id IS NULL
    OR length(trim(NEW.payout_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.payout_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.safe_multisig_tx_hash IS NOT NULL
    OR NEW.signing_lane IS NOT 'HOT'
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR typeof(NEW.confirmation_observed_at) != 'integer'
    OR NEW.confirmation_observed_at <= 0
    OR NEW.confirmation_observed_at > unixepoch('now')
    OR NEW.confirmation_observed_at < unixepoch('now') - 300
  )
) OR (
  -- Full COLD finality parity on direct INSERT
  NEW.confirmation_lane = 'COLD'
  AND (
    NEW.state IS NOT 'CONFIRMED'
    OR NEW.payout_id IS NULL
    OR length(trim(NEW.payout_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.payout_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.lock_batch_id IS NULL
    OR length(trim(NEW.lock_batch_id, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.lock_batch_id GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.signing_lane IS NOT 'COLD'
    OR NEW.safe_multisig_tx_hash IS NULL
    OR length(trim(NEW.safe_multisig_tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.safe_multisig_tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR NEW.tx_hash IS NULL
    OR length(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13))) = 0
    OR NEW.tx_hash GLOB '*[ ' || char(9) || char(10) || char(13) || ']*'
    OR lower(trim(NEW.safe_multisig_tx_hash, ' ' || char(9) || char(10) || char(13)))
       = lower(trim(NEW.tx_hash, ' ' || char(9) || char(10) || char(13)))
    OR typeof(NEW.confirmation_observed_at) != 'integer'
    OR NEW.confirmation_observed_at <= 0
    OR NEW.confirmation_observed_at > unixepoch('now')
    OR NEW.confirmation_observed_at < unixepoch('now') - 300
  )
)
BEGIN
  SELECT RAISE(ABORT, 'Direct INSERT into HOT/COLD confirmation lane requires verified finality evidence');
END;
