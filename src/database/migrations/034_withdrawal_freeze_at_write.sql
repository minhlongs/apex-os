-- Withdrawal mutations insert their journal batch before applying postings. Abort
-- that write in the same transaction if the mandatory freeze control is not open.
CREATE TRIGGER IF NOT EXISTS trg_withdrawal_journal_requires_unfrozen_ledger
BEFORE INSERT ON ledger_journal_batches
WHEN NEW.journal_type IN ('WITHDRAWAL_LOCK', 'WITHDRAWAL_FINALIZED', 'WITHDRAWAL_REVERTED')
  AND NOT EXISTS (
    SELECT 1 FROM system_runtime_flags
    WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE' AND flag_value = 'false'
  )
BEGIN
  SELECT RAISE(ABORT, 'Withdrawal ledger mutation denied by emergency freeze control');
END;
