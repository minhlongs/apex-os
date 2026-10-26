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
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  add?(key: string, value: string, options?: { expirationTtl?: number }): Promise<boolean>;
  delete?(key: string): Promise<boolean | void>;
}

/**
 * Get KV namespace from global Cloudflare bindings
 */
export function getReplayProtectionKV(): ReplayProtectionKV | null {
  // @ts-ignore - Cloudflare KV binding from wrangler.toml
  const kv = globalThis.KV;
  if (!kv || typeof kv.get !== 'function' || typeof kv.put !== 'function') {
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
    if (typeof kv.add === 'function') {
      const added = await kv.add(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
      if (added) {
        logInfo(`[ReplayProtection] Marked webhook as processed: ${exchange} ${symbol} ${orderId}`);
      } else {
        logWarn(`[ReplayProtection] Key already exists during mark (race): ${exchange} ${symbol} ${orderId}`);
      }
      return;
    }

    await kv.put(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
    logInfo(`[ReplayProtection] Marked webhook as processed: ${exchange} ${symbol} ${orderId}`);
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
    if (typeof kv.add === 'function') {
      const added = await kv.add(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
      if (added) {
        logInfo(`[ReplayProtection] First processing: ${exchange} ${symbol} ${orderId}`);
        return true;
      } else {
        logWarn(`[ReplayProtection] Replay detected: ${exchange} ${symbol} ${orderId}`);
        return false;
      }
    }

    const existing = await kv.get(key);
    if (existing) {
      logWarn(`[ReplayProtection] Replay detected: ${exchange} ${symbol} ${orderId}`);
      return false;
    }
    await kv.put(key, 'processed', { expirationTtl: REPLAY_PROTECTION_TTL });
    logInfo(`[ReplayProtection] First processing: ${exchange} ${symbol} ${orderId}`);
    return true;
  } catch (error) {
    logError('[ReplayProtection] Error in check-and-mark:', error);
    return true; // Fail open on errors
  }
}

/**
 * Check and record a nonce to prevent replay attacks
 *
 * Checks if the nonce has already been seen using standard Cloudflare KV methods.
 * If unseen, records it with the specified TTL.
 *
 * @param nonce - Unique request nonce
 * @param timestamp - Request timestamp (optional epoch ms or seconds)
 * @param ttlSeconds - TTL for replay protection (defaults to REPLAY_PROTECTION_TTL)
 * @returns true if nonce is valid and recorded (first time), false if duplicate, invalid, or KV unavailable
 */
export async function checkAndRecordNonce(
  nonce: string,
  timestamp?: number,
  ttlSeconds: number = REPLAY_PROTECTION_TTL
): Promise<boolean> {
  if (!nonce) {
    return false;
  }

  const kv = getReplayProtectionKV();
  if (!kv) {
    logWarn('[ReplayProtection] KV not available, rejecting nonce check to prevent replay attacks');
    return false; // Does NOT fail open
  }

  const key = `replay:${nonce}`;

  try {
    const existing = await kv.get(key);
    if (existing) {
      logWarn(`[ReplayProtection] Nonce replay detected: ${nonce}`);
      return false;
    }
    await kv.put(key, '1', { expirationTtl: ttlSeconds });
    logInfo(`[ReplayProtection] Recorded nonce: ${nonce}`);
    return true;
  } catch (error) {
    logError('[ReplayProtection] Error in checkAndRecordNonce:', error);
    return false; // Does NOT fail open on error
  }
}
