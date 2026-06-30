/**
 * Webhook crypto utilities
 * HMAC-SHA256 verification for exchange webhooks
 */

import { subtle } from 'crypto';
import { TextDecoder } from 'util';

// Default timestamp tolerance window (5 minutes in milliseconds)
export const DEFAULT_TIMESTAMP_WINDOW_MS = 5 * 60 * 1000;

/**
 * Hash a string using SHA-256
 */
export async function sha256Hash(data: string): Promise<string> {
  const encoder = new TextEncoder();
  const dataBuffer = encoder.encode(data);
  const hashBuffer = await subtle.digest('SHA-256', dataBuffer);
  return Buffer.from(hashBuffer).toString('hex');
}

export class WebhookCrypto {
  /**
   * Verify HMAC-SHA256 signature
   * Used by Binance and Bybit with different payload formats
   *
   * @param payload - Raw request body string (as received)
   * @param signature - Signature from header (hex string)
   * @param secret - Webhook secret from environment
   * @returns true if signature is valid
   */
  static async verifyHmacSha256(
    payload: string,
    signature: string,
    secret: string
  ): Promise<boolean> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const payloadData = encoder.encode(payload);

    const key = await subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );

    const signatureBuffer = this.hexToBuffer(signature);
    if (!signatureBuffer) {
      return false;
    }

    const isValid = await subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      payloadData
    );

    return isValid;
  }

  /**
   * Convert hex string to ArrayBuffer
   */
  private static hexToBuffer(hex: string): ArrayBuffer | null {
    if (hex.startsWith('0x')) {
      hex = hex.slice(2);
    }
    if (hex.length % 2 !== 0) {
      hex = '0' + hex;
    }
    try {
      const buffer = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) {
        buffer[i / 2] = parseInt(hex.substr(i, 2), 16);
      }
      return buffer.buffer;
    } catch {
      return null;
    }
  }

  /**
   * Compute HMAC-SHA256 signature (for testing/debugging)
   */
  static async computeSignature(
    payload: string,
    secret: string
  ): Promise<string> {
    const encoder = new TextEncoder();
    const keyData = encoder.encode(secret);
    const payloadData = encoder.encode(payload);

    const key = await subtle.importKey(
      'raw',
      keyData,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signature = await subtle.sign('HMAC', key, payloadData);
    return Buffer.from(signature).toString('hex');
  }

  /**
   * Extract timestamp from webhook headers or payload
   * Returns timestamp in milliseconds or null if not found
   */
  static extractTimestamp(
    exchange: 'binance' | 'bybit' | 'okx' | 'kucoin',
    headers: Record<string, string>,
    body: Record<string, unknown>
  ): number | null {
    switch (exchange) {
      case 'binance':
        // Binance includes event time (E) at top level and transaction time (T) in order
        const eventTime = body.E as number | undefined;
        const orderTime = (body.o as any)?.T as number | undefined;
        const timestampMs = eventTime ?? orderTime;
        return timestampMs ? Number(timestampMs) : null;

      case 'bybit':
        // Bybit includes timestamp in header (X-Bybit-Signature-Timestamp) and in body (transactTime)
        const headerTimestamp = headers['x-bybit-signature-timestamp'] || headers['timestamp'];
        const bodyTimestamp = body.transactTime as number | undefined ?? body.execTime as number | undefined;
        const bybitTimestamp = headerTimestamp ?? bodyTimestamp;
        return bybitTimestamp ? Number(bybitTimestamp) : null;

      case 'okx':
        // OKX includes timestamp in header (OK-ACCESS-TIMESTAMP) and optionally in body (ts)
        const okxHeaderTimestamp = headers['ok-access-timestamp'];
        const okxBodyTimestamp = (body as any)?.ts as number | undefined;
        const okxTimestamp = okxHeaderTimestamp ?? okxBodyTimestamp;
        return okxTimestamp ? Number(okxTimestamp) : null;

      case 'kucoin':
        // KuCoin includes timestamp in header (KC-API-TIMESTAMP) and in body (ts)
        const kucoinHeaderTimestamp = headers['kc-api-timestamp'];
        const kucoinBodyTimestamp = body.ts as number | undefined;
        const kucoinTimestamp = kucoinHeaderTimestamp ?? kucoinBodyTimestamp;
        return kucoinTimestamp ? Number(kucoinTimestamp) : null;

      default:
        return null;
    }
  }

  /**
   * Validate webhook timestamp is within acceptable window
   * @param webhookTimestamp - Timestamp from webhook (milliseconds)
   * @param now - Current time (milliseconds, defaults to Date.now())
   * @param windowMs - Acceptable window in milliseconds (default 5 minutes)
   * @returns ValidationResult with valid flag and optional error
   */
  static validateTimestamp(
    webhookTimestamp: number,
    now?: number,
    windowMs: number = DEFAULT_TIMESTAMP_WINDOW_MS
  ): { valid: boolean; error?: string; ageMs: number } {
    const currentTime = now ?? Date.now();
    const ageMs = Math.abs(currentTime - webhookTimestamp);

    if (isNaN(webhookTimestamp) || webhookTimestamp <= 0) {
      return {
        valid: false,
        error: 'Invalid timestamp format',
        ageMs,
      };
    }

    if (ageMs > windowMs) {
      return {
        valid: false,
        error: `Timestamp outside acceptable window (${windowMs / 1000}s). Age: ${(ageMs / 1000).toFixed(1)}s`,
        ageMs,
      };
    }

    return {
      valid: true,
      ageMs,
    };
  }

  /**
   * Compute hash of payload for replay protection
   */
  static async hashPayload(payload: string): Promise<string> {
    return sha256Hash(payload);
  }

  /**
   * Compute hash of signature for nonce tracking
   */
  static async hashSignature(signature: string): Promise<string> {
    return sha256Hash(signature);
  }
}

/**
 * Binance signature verification
 * Signature is HMAC-SHA256 of the raw request body
 *
 * Header: `X-Binance-Signature` or `signature`
 */
export async function verifyBinanceSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string
): Promise<boolean> {
  if (!signatureHeader) {
    return false;
  }
  return WebhookCrypto.verifyHmacSha256(payload, signatureHeader, secret);
}

/**
 * Bybit signature verification
 * Bybit uses: HMAC-SHA256 of (timestamp + method + path + body)
 *
 * Header: `X-Bybit-HMAC-Signature`
 * @see https://bybit-exchange.github.io/docs/v5/account/transaction
 */
export async function verifyBybitSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  timestamp: string | null,
  method: string = 'POST',
  path: string = '/api/webhooks/exchange'
): Promise<boolean> {
  if (!signatureHeader || !timestamp) {
    return false;
  }

  // Bybit signature format: timestamp + method + path + body
  const signString = timestamp + method.toUpperCase() + path + payload;

  return WebhookCrypto.verifyHmacSha256(signString, signatureHeader, secret);
}

/**
 * OKX signature verification
 * OKX uses: HMAC-SHA256 of (timestamp + method + requestPath + body), signature is hex-encoded
 *
 * Headers: `OK-ACCESS-KEY`, `OK-ACCESS-SIGN`, `OK-ACCESS-TIMESTAMP`, `OK-ACCESS-PASSPHRASE`
 * @see https://www.okx.com/docs-v5/en/#rest-api-webhooks
 */
export async function verifyOkxSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  timestamp: string | null,
  method: string = 'POST',
  path: string = '/api/webhooks/exchange/okx'
): Promise<boolean> {
  if (!signatureHeader || !timestamp) {
    return false;
  }

  // OKX signature format: timestamp + method + requestPath + body
  const signString = timestamp + method.toUpperCase() + path + payload;

  return WebhookCrypto.verifyHmacSha256(signString, signatureHeader, secret);
}

/**
 * KuCoin signature verification
 * KuCoin uses: base64(HMAC-SHA256(secret, timestamp + method + requestPath + body))
 *
 * Headers: `KC-API-KEY`, `KC-API-SIGN`, `KC-API-TIMESTAMP`, `KC-API-PASSPHRASE`
 * @see https://docs.kucoin.com/#webhooks
 */
export async function verifyKuCoinSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  timestamp: string | null,
  method: string = 'POST',
  path: string = '/api/webhooks/exchange/kucoin'
): Promise<boolean> {
  if (!signatureHeader || !timestamp) {
    return false;
  }

  // KuCoin signature format: timestamp + method + requestPath + body
  const signString = timestamp + method.toUpperCase() + path + payload;

  // KuCoin signature is base64 encoded, need to decode before verifying
  try {
    // Convert base64 signature to hex for verification
    const signatureHex = base64ToHex(signatureHeader);
    if (!signatureHex) {
      console.error('[KuCoin] Failed to decode base64 signature');
      return false;
    }
    return WebhookCrypto.verifyHmacSha256(signString, signatureHex, secret);
  } catch (error) {
    console.error('[KuCoin] Signature verification error:', error);
    return false;
  }
}

/**
 * Convert base64 string to hex string
 */
function base64ToHex(base64: string): string | null {
  try {
    // Decode base64 to binary string
    const binaryString = Buffer.from(base64, 'base64').toString('binary');
    // Convert binary to hex
    let hex = '';
    for (let i = 0; i < binaryString.length; i++) {
      const hexChar = binaryString.charCodeAt(i).toString(16).padStart(2, '0');
      hex += hexChar;
    }
    return hex;
  } catch (error) {
    console.error('[Crypto] Base64 to hex conversion failed:', error);
    return null;
  }
}

/**
 * Get signature header name for exchange
 */
export function getSignatureHeaderName(exchange: 'binance' | 'bybit' | 'okx' | 'kucoin'): string {
  switch (exchange) {
    case 'binance':
      return 'x-binance-signature';
    case 'bybit':
      return 'x-bybit-hmac-signature';
    case 'okx':
      return 'ok-access-sign';
    case 'kucoin':
      return 'kc-api-sign';
    default:
      return '';
  }
}

/**
 * Check if signature header is present
 */
export function hasSignatureHeader(
  exchange: 'binance' | 'bybit' | 'okx' | 'kucoin',
  headers: Record<string, string>
): boolean {
  const headerName = getSignatureHeaderName(exchange);
  return !!headers[headerName] || !!headers[headerName.replace(/-/g, '')];
}
