import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';
/**
 * Replay Protection for Webhooks
 * Uses Cloudflare KV to track processed webhook events with 24h TTL
 *
 * This module provides idempotency handling to prevent duplicate webhook processing
 * from retries or malicious replay attacks.
 */

// 24 hours in seconds
export const REPLAY_PROTECTION_TTL = 24 * 60 * 60;

/**
 * KV namespace interface (Cloudflare Workers)
 */
export interface ReplayProtectionKV {
  get(key: string): Promise<string | null>;
  add(key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean>;
}

/**
 * Get KV namespace from global Cloudflare bindings
 */
export function getReplayProtectionKV(): ReplayProtectionKV | null {
  // @ts-ignore - Cloudflare KV binding from wrangler.toml
  const kv = globalThis.KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.add !== 'function') {
    return null;
  }
  return kv as ReplayProtectionKV;
}

/**
 * Build the KV key for a webhook event
 * Format: webhook:replay:{exchange}:{symbol}:{orderId}
 */
export function buildReplayKey(
  exchange: string,
  orderId: string,
  symbol: string
): string {
  return `webhook:replay:${exchange}:${symbol}:${orderId}`;
}

/**
 * Check if a webhook has already been processed
 *
 * @param exchange - Exchange name (binance, bybit, etc.)
 * @param orderId - Exchange order ID
 * @param symbol - Trading symbol
 * @returns true if this webhook was already processed, false otherwise
 *
 * @note Fail-open: returns false if KV is unavailable or on errors
 */
export async function isWebhookReplay(
  exchange: string,
  orderId: string,
  symbol: string
): Promise<boolean> {
  const kv = getReplayProtectionKV();
  if (!kv) {
    logWarn('[ReplayProtection] KV not available, skipping replay check');
    return false; // Fail open - allow if KV unavailable
  }

  const key = buildReplayKey(exchange, orderId, symbol);

  try {
    const existing = await kv.get(key);
    return existing === 'processed';
  } catch (error) {
    logError('[ReplayProtection] Error checking replay:', error);
    return false; // Fail open on errors
  }
}

/**
 * Mark a webhook as processed
 *
 * Stores a flag in KV with 24h TTL. Uses atomic add operation to avoid
 * race conditions when the same webhook is received concurrently.
 *
 * @param exchange - Exchange name (binance, bybit, etc.)
 * @param orderId - Exchange order ID
 * @param symbol - Trading symbol
 *
 * @note This function is idempotent - multiple calls are safe
 */
export async function markWebhookProcessed(
  exchange: string,
  orderId: string,
  symbol: string
): Promise<void> {
  const kv = getReplayProtectionKV();
  if (!kv) {
    logWarn('[ReplayProtection] KV not available, cannot mark webhook as processed');
    return;
  }

  const key = buildReplayKey(exchange, orderId, symbol);

  try {
    // Use add to avoid race conditions - only succeeds if key doesn't exist
    const added = await kv.add(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
    if (added) {
      logInfo(`[ReplayProtection] Marked webhook as processed: ${exchange} ${symbol} ${orderId}`);
    } else {
      logWarn(`[ReplayProtection] Key already exists during mark (race): ${exchange} ${symbol} ${orderId}`);
    }
  } catch (error) {
    logError('[ReplayProtection] Error marking webhook as processed:', error);
  }
}

/**
 * Check and mark in one atomic operation
 * Returns true if this was the first time processing (not a replay)
 */
export async function checkAndMarkWebhook(
  exchange: string,
  orderId: string,
  symbol: string
): Promise<boolean> {
  const kv = getReplayProtectionKV();
  if (!kv) {
    logWarn('[ReplayProtection] KV not available, skipping replay check');
    return true; // Fail open - allow if KV unavailable
  }

  const key = buildReplayKey(exchange, orderId, symbol);

  try {
    // Try to add the key - if it succeeds, this is the first time processing
    const added = await kv.add(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
    if (added) {
      logInfo(`[ReplayProtection] First processing: ${exchange} ${symbol} ${orderId}`);
      return true;
    } else {
      logWarn(`[ReplayProtection] Replay detected: ${exchange} ${symbol} ${orderId}`);
      return false;
    }
  } catch (error) {
    logError('[ReplayProtection] Error in check-and-mark:', error);
    return true; // Fail open on errors
  }
}
