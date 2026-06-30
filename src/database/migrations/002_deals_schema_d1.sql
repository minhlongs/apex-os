-- ApexOS Deals Table
-- Public trading deals/signals listing with exchange and category filters

CREATE TABLE IF NOT EXISTS deals (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  slug TEXT UNIQUE NOT NULL,
  exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken')),
  category TEXT NOT NULL CHECK (category IN ('spot', 'futures', 'options', 'margin')),
  symbol TEXT NOT NULL,
  side TEXT NOT NULL CHECK (side IN ('LONG', 'SHORT')),
  entry_price REAL NOT NULL,
  stop_loss REAL,
  take_profit REAL,
  leverage INTEGER DEFAULT 1,
  risk_level TEXT DEFAULT 'medium' CHECK (risk_level IN ('low', 'medium', 'high')),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'closed', 'cancelled', 'expired')),
  title TEXT NOT NULL,
  description TEXT,
  roi_percent REAL,
  duration_days INTEGER,
  affiliate_url TEXT NOT NULL,
  affiliate_clicks INTEGER DEFAULT 0,
  master_trader_id TEXT REFERENCES users(id),
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_deals_exchange ON deals(exchange);
CREATE INDEX IF NOT EXISTS idx_deals_category ON deals(category);
CREATE INDEX IF NOT EXISTS idx_deals_status ON deals(status);
CREATE INDEX IF NOT EXISTS idx_deals_created ON deals(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_deals_master ON deals(master_trader_id);
CREATE INDEX IF NOT EXISTS idx_deals_slug ON deals(slug);

-- Affiliate clicks tracking for analytics
CREATE TABLE IF NOT EXISTS affiliate_clicks (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  deal_id TEXT NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES profiles(id) ON DELETE SET NULL,
  session_id TEXT,
  user_agent TEXT,
  ip_address TEXT,
  clicked_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_deal ON affiliate_clicks(deal_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_user ON affiliate_clicks(user_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_session ON affiliate_clicks(session_id);
CREATE INDEX IF NOT EXISTS idx_affiliate_clicks_clicked_at ON affiliate_clicks(clicked_at);

-- Auto-update updatedAt timestamps
CREATE TRIGGER IF NOT EXISTS trg_deals_updated
AFTER UPDATE ON deals
FOR EACH ROW
BEGIN
  UPDATE deals SET updated_at = datetime('now') WHERE id = old.id;
END;
