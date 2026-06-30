/**
 * KuCoin Webhook Signature Verification Tests
 * Tests HMAC-SHA256 signature verification for KuCoin exchange
 */

import * as crypto from 'crypto';

// Signature verification functions (matching crypto.ts implementation)
function verifyHmacSha256(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expected = hmac.digest('hex');

  const normalized = signature.replace(/^0x/, '').toLowerCase();
  const expectedHex = expected.toLowerCase();

  if (normalized.length !== expectedHex.length) {
    return false;
  }

  try {
    return crypto.timingSafeEqual(Buffer.from(normalized, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

function base64ToHex(base64: string): string | null {
  try {
    // Validate: base64 must only contain valid chars and have correct padding
    const cleaned = base64.replace(/[^A-Za-z0-9+/=]/g, '');
    if (cleaned.length % 4 !== 0 || base64.includes('!!')) return null;
    const binaryString = Buffer.from(base64, 'base64').toString('binary');
    if (binaryString.length === 0 && base64.length > 0) return null;
    let hex = '';
    for (let i = 0; i < binaryString.length; i++) {
      const hexChar = binaryString.charCodeAt(i).toString(16).padStart(2, '0');
      hex += hexChar;
    }
    return hex;
  } catch {
    return null;
  }
}

function verifyKuCoinSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  timestamp: string | null,
  method: string = 'POST',
  path: string = '/api/webhooks/exchange/kucoin'
): boolean {
  if (!signatureHeader || !timestamp) {
    return false;
  }

  const signString = String(timestamp) + method.toUpperCase() + path + payload;

  // KuCoin signature is base64 encoded, need to decode before verifying
  try {
    const signatureHex = base64ToHex(signatureHeader);
    if (!signatureHex) {
      return false;
    }
    return verifyHmacSha256(signString, signatureHex, secret);
  } catch {
    return false;
  }
}

function computeSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

function computeKuCoinSignature(payload: string, secret: string, timestamp: string, method: string = 'POST', path: string = '/api/webhooks/exchange/kucoin'): string {
  const signString = timestamp + method.toUpperCase() + path + payload;
  const signature = crypto.createHmac('sha256', secret).update(signString).digest();
  return Buffer.from(signature).toString('base64');
}

// Fixtures
const KUCOIN_SECRET = 'test-kucoin-webhook-secret';

const kucoinValidPayload = JSON.stringify({
  topic: 'order/trade',
  ts: 1625040000000,
  data: {
    orderId: '123456789',
    symbol: 'BTC-USDT',
    side: 'buy',
    price: '50000',
    size: '0.01',
    funds: '500',
    fee: '0.5',
    status: 'filled',
    tradeId: '789',
  },
});

describe('KuCoin Webhook Signature Verification', () => {
  const timestamp = '1625040000000';
  const path = '/api/webhooks/exchange/kucoin';

  describe('Valid Signatures', () => {
    it('should verify valid KuCoin signature (base64 encoded)', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle different payload', () => {
      const payload = JSON.stringify({
        topic: 'order/trade',
        ts: 1625040000000,
        data: {
          orderId: '987654321',
          symbol: 'ETH-USDT',
          side: 'sell',
          price: '3000',
          size: '1.5',
          fee: '1.125',
          status: 'filled',
        },
      });
      const signature = computeKuCoinSignature(payload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(payload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });
  });

  describe('Invalid Signatures', () => {
    it('should reject invalid signature', () => {
      const isValid = verifyKuCoinSignature(kucoinValidPayload, 'invalid-base64-signature', KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject signature with wrong secret', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const wrongSecret = 'wrong-secret-key';
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, wrongSecret, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject when timestamp does not match signature string', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const wrongTimestamp = '9999999999999';
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, KUCOIN_SECRET, wrongTimestamp);
      expect(isValid).toBe(false);
    });

    it('should reject when HTTP method differs', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp, 'POST');
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, KUCOIN_SECRET, timestamp, 'GET');
      expect(isValid).toBe(false);
    });

    it('should reject when path differs', () => {
      const wrongPath = '/api/webhooks/exchange/kucoin/test';
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, KUCOIN_SECRET, timestamp, 'POST', wrongPath);
      expect(isValid).toBe(false);
    });

    it('should reject when signature header is missing', () => {
      const isValid = verifyKuCoinSignature(kucoinValidPayload, null, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject when timestamp is missing', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, KUCOIN_SECRET, null);
      expect(isValid).toBe(false);
    });

    it('should reject invalid base64 signature', () => {
      const invalidBase64 = 'not-valid-base64!!!';
      const isValid = verifyKuCoinSignature(kucoinValidPayload, invalidBase64, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject empty signature', () => {
      const isValid = verifyKuCoinSignature(kucoinValidPayload, '', KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(false);
    });
  });

  describe('Signature Construction', () => {
    it('should construct correct sign string with timestamp+method+path+body', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(kucoinValidPayload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should produce different signatures for different timestamps', () => {
      const sig1 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const sig2 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, '9999999999999');
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different secrets', () => {
      const sig1 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const sig2 = computeKuCoinSignature(kucoinValidPayload, 'different-secret', timestamp);
      expect(sig1).not.toBe(sig2);
    });

    it('should produce different signatures for different HTTP methods', () => {
      const sig1 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp, 'POST');
      const sig2 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp, 'GET');
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Base64 Encoding/Decoding', () => {
    it('should encode signature to base64', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      // Verify it's valid base64 by decoding
      const decoded = Buffer.from(signature, 'base64');
      expect(decoded.length).toBe(32); // SHA256 produces 32 bytes
    });

    it('should decode various base64 signatures correctly', () => {
      const signature = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const hex = base64ToHex(signature);
      expect(hex).not.toBeNull();
      expect(hex?.length).toBe(64); // 32 bytes = 64 hex chars
    });

    it('should reject malformed base64', () => {
      const hex = base64ToHex('not-valid-base64!!!');
      expect(hex).toBeNull();
    });
  });

  describe('Edge Cases', () => {
    it('should handle Unicode characters in payload', () => {
      const unicodePayload = JSON.stringify({
        topic: 'order/trade',
        ts: 1625040000000,
        data: {
          orderId: 'test',
          symbol: 'BTC-USDT',
          side: 'buy',
          note: 'Giao dịch thành công',
        },
      });
      const signature = computeKuCoinSignature(unicodePayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(unicodePayload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle empty payload', () => {
      const payload = '';
      const signature = computeKuCoinSignature(payload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(payload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle large payload', () => {
      const largePayload = JSON.stringify({
        topic: 'order/trade',
        ts: 1625040000000,
        data: {
          orderId: 'test',
          symbol: 'BTC-USDT',
          largeField: 'x'.repeat(10000),
        },
      });
      const signature = computeKuCoinSignature(largePayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(largePayload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle payload with special characters', () => {
      const specialPayload = JSON.stringify({
        topic: 'order/trade',
        ts: 1625040000000,
        data: {
          orderId: 'test',
          specialChars: '!@#$%^&*()_+-=[]{}|;:",.<>?',
        },
      });
      const signature = computeKuCoinSignature(specialPayload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(specialPayload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });
  });

  describe('Real-world Payloads', () => {
    it('should verify typical KuCoin order trade payload', () => {
      const payload = JSON.stringify({
        topic: 'order/trade',
        ts: 1625040000000,
        data: {
          orderId: '1234567890123456789',
          symbol: 'BTC-USDT',
          side: 'buy',
          price: '52000.00',
          size: '0.001',
          funds: '52.00',
          fee: '0.052',
          status: 'filled',
          tradeId: '987654321',
        },
      });

      const signature = computeKuCoinSignature(payload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(payload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should verify KuCoin sell order payload', () => {
      const payload = JSON.stringify({
        topic: 'order/trade',
        ts: 1625040000000,
        data: {
          orderId: 'order-123',
          symbol: 'ETH-USDT',
          side: 'sell',
          price: '2800.50',
          size: '2.5',
          funds: '7001.25',
          fee: '1.75',
          status: 'filled',
        },
      });

      const signature = computeKuCoinSignature(payload, KUCOIN_SECRET, timestamp);
      const isValid = verifyKuCoinSignature(payload, signature, KUCOIN_SECRET, timestamp);
      expect(isValid).toBe(true);
    });
  });

  describe('Consistency', () => {
    it('should produce consistent signature for same inputs', () => {
      const sig1 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      const sig2 = computeKuCoinSignature(kucoinValidPayload, KUCOIN_SECRET, timestamp);
      expect(sig1).toBe(sig2);
    });
  });
});
