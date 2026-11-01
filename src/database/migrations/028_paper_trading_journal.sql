-- src/database/migrations/028_paper_trading_journal.sql
-- Greenfield Paper Trading Immutable Journal and Strategy Snapshots
-- Enforces execution_mode = 'PAPER' with zero live CEX permissions.

CREATE TABLE IF NOT EXISTS paper_trade_journal (
  id TEXT PRIMARY KEY,
  cycle_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  strategy_id TEXT NOT NULL CHECK(strategy_id IN ('spot-2exch', 'spot-perp')),
  pair TEXT NOT NULL CHECK(pair IN ('BTC/USDT', 'ETH/USDT')),
  entry_ts INTEGER NOT NULL,
  exit_ts INTEGER NOT NULL,
  entry_seq_a INTEGER NOT NULL,
  entry_seq_b INTEGER NOT NULL,
  exit_seq_a INTEGER NOT NULL,
  exit_seq_b INTEGER NOT NULL,
  notional_usdt REAL NOT NULL,
  quantity_base REAL NOT NULL,
  leg_a_exchange TEXT NOT NULL,
  leg_a_market TEXT NOT NULL,
  leg_b_exchange TEXT NOT NULL,
  leg_b_market TEXT NOT NULL,
  entry_leg_a_price REAL NOT NULL,
  entry_leg_b_price REAL NOT NULL,
  exit_leg_a_price REAL NOT NULL,
  exit_leg_b_price REAL NOT NULL,
  raw_spread_bps REAL NOT NULL,
  net_spread_bps REAL NOT NULL,
  gross_pnl_usdt REAL NOT NULL,
  total_fees_usdt REAL NOT NULL,
  funding_delta_usdt REAL NOT NULL DEFAULT 0,
  net_pnl_usdt REAL NOT NULL,
  model_version TEXT NOT NULL,
  replay_object_key TEXT NOT NULL,
  execution_mode TEXT NOT NULL DEFAULT 'PAPER' CHECK(execution_mode = 'PAPER'),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Enforce append-only immutability triggers (block UPDATE and DELETE)
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

CREATE INDEX IF NOT EXISTS idx_paper_journal_strategy_pair ON paper_trade_journal(strategy_id, pair);
CREATE INDEX IF NOT EXISTS idx_paper_journal_exit_ts ON paper_trade_journal(exit_ts);
CREATE INDEX IF NOT EXISTS idx_paper_journal_idempotency ON paper_trade_journal(idempotency_key);

CREATE TABLE IF NOT EXISTS paper_strategy_snapshots (
  strategy_id TEXT NOT NULL PRIMARY KEY CHECK(strategy_id IN ('spot-2exch', 'spot-perp')),
  strategy_name TEXT NOT NULL,
  model_version TEXT NOT NULL,
  initial_capital_usdt REAL NOT NULL DEFAULT 10000.0,
  cash_balance_usdt REAL NOT NULL,
  allocated_notional_usdt REAL NOT NULL,
  equity_usdt REAL NOT NULL,
  peak_equity_usdt REAL NOT NULL,
  realized_net_pnl_usdt REAL NOT NULL,
  total_fees_paid_usdt REAL NOT NULL,
  total_funding_usdt REAL NOT NULL DEFAULT 0,
  max_drawdown_pct REAL NOT NULL DEFAULT 0,
  halted_by_drawdown INTEGER NOT NULL DEFAULT 0,
  open_cycles_count INTEGER NOT NULL DEFAULT 0,
  closed_cycles_count INTEGER NOT NULL DEFAULT 0,
  win_rate_pct REAL NOT NULL DEFAULT 0,
  execution_mode TEXT NOT NULL DEFAULT 'PAPER' CHECK(execution_mode = 'PAPER'),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
