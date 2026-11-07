-- src/database/migrations/030_paper_trading_triggers_and_outbox_sync.sql
-- Additive forward migration ensuring append-only triggers on paper_trade_journal
-- exist on staging and production databases where 028 was applied prior to trigger addition.

CREATE TRIGGER IF NOT EXISTS trg_prevent_paper_journal_update
BEFORE UPDATE ON paper_trade_journal
BEGIN
  SELECT RAISE(ABORT, 'paper_trade_journal is strictly append-only: UPDATE prohibited');
END;

CREATE TRIGGER IF NOT EXISTS trg_prevent_paper_journal_delete
BEFORE DELETE ON paper_trade_journal
BEGIN
  SELECT RAISE(ABORT, 'paper_trade_journal is strictly append-only: DELETE prohibited');
END;
