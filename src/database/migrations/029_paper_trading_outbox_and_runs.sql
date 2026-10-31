-- src/database/migrations/029_paper_trading_outbox_and_runs.sql
-- Additive migration for tracking official paper trading runs, verified observation days,
-- and DO persistence outbox reconciliation.

CREATE TABLE IF NOT EXISTS paper_trading_runs (
  run_id TEXT PRIMARY KEY,
  model_version TEXT NOT NULL,
  config_hash TEXT NOT NULL,
  strategy_id TEXT NOT NULL CHECK(strategy_id IN ('spot-2exch', 'spot-perp')),
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_heartbeat_at TEXT NOT NULL DEFAULT (datetime('now')),
  verified_real_market_days REAL NOT NULL DEFAULT 0.0,
  closed_cycles_count INTEGER NOT NULL DEFAULT 0,
  realized_net_pnl_usdt REAL NOT NULL DEFAULT 0.0,
  max_drawdown_pct REAL NOT NULL DEFAULT 0.0,
  verdict TEXT NOT NULL DEFAULT 'NO_GO' CHECK(verdict IN ('GO', 'NO_GO')),
  execution_mode TEXT NOT NULL DEFAULT 'PAPER' CHECK(execution_mode = 'PAPER'),
  is_active INTEGER NOT NULL DEFAULT 1
);

CREATE INDEX IF NOT EXISTS idx_paper_runs_strategy_active ON paper_trading_runs(strategy_id, is_active);
CREATE INDEX IF NOT EXISTS idx_paper_runs_verdict ON paper_trading_runs(verdict);

CREATE TABLE IF NOT EXISTS paper_trading_outbox (
  outbox_id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  d1_persisted INTEGER NOT NULL DEFAULT 0,
  r2_persisted INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_paper_outbox_pending ON paper_trading_outbox(d1_persisted, r2_persisted);
