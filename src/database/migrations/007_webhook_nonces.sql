-- ============================================================
-- Migration 007: Webhook Nonce Table for Replay Protection
-- ============================================================
-- This migration adds a table to track processed webhook signatures
-- to prevent replay attacks. Each webhook is identified by its
-- signature hash and timestamp, and old entries are cleaned up
-- after the replay protection window (5 minutes).
--
-- IDEMPOTENT: Safe to run multiple times
-- ============================================================

PRAGMA foreign_keys = ON;

-- Create webhook_nonces table for replay protection
-- Stores processed webhook signatures to prevent replay attacks
CREATE TABLE IF NOT EXISTS webhook_nonces (
  id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
  exchange TEXT NOT NULL CHECK (exchange IN ('binance', 'bybit')),
  signature_hash TEXT NOT NULL,          -- SHA256 hash of the webhook signature
  payload_hash TEXT NOT NULL,            -- SHA256 hash of the raw payload body
  webhook_timestamp INTEGER NOT NULL,    -- Unix timestamp from webhook (milliseconds)
  received_at TEXT DEFAULT (datetime('now')),
  -- Composite unique constraint to prevent duplicate processing
  UNIQUE(exchange, signature_hash)
);

-- Indexes for efficient lookups and cleanup
CREATE INDEX IF NOT EXISTS idx_webhook_nonces_exchange ON webhook_nonces(exchange);
CREATE INDEX IF NOT EXISTS idx_webhook_nonces_timestamp ON webhook_nonces(webhook_timestamp);
CREATE INDEX IF NOT EXISTS idx_webhook_nonces_received ON webhook_nonces(received_at);
CREATE INDEX IF NOT EXISTS idx_webhook_nonces_signature ON webhook_nonces(signature_hash);

-- Trigger to auto-delete old nonces after replay protection window
-- SQLite doesn't support ON DELETE triggers on time-based conditions,
-- so we'll handle cleanup in application code (or via cron)
-- This index supports the cleanup query: DELETE FROM webhook_nonces WHERE webhook_timestamp < ?

-- Migration completed successfully
-- ============================================================
