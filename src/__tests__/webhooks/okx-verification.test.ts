/**
 * OKX Webhook Signature Verification Tests
 * Tests HMAC-SHA256 signature verification for OKX exchange
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

function verifyOkxSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  timestamp: string | null,
  method: string = 'POST',
  path: string = '/api/webhooks/exchange/okx'
): boolean {
  if (!signatureHeader || !timestamp) {
    return false;
  }

  const signString = String(timestamp) + method.toUpperCase() + path + payload;
  return verifyHmacSha256(signString, signatureHeader, secret);
}

function computeSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

// Fixtures
const OKX_SECRET = 'test-okx-webhook-secret';

const okxValidPayload = JSON.stringify({
  instId: 'BTC-USDT',
  ordId: '123456789',
  sz: '0.01',
  px: '50000',
  fee: '0.5',
  side: 'buy',
  tradeId: '789',
  ts: '1625040000000',
});

const okxValidSignaturePayload = JSON.stringify({
  instId: 'ETH-USDT',
  ordId: '987654321',
  sz: '1.5',
  px: '3000',
  fee: '1.5',
  side: 'sell',
  ts: '1625040000000',
});

describe('OKX Webhook Signature Verification', () => {
  const timestamp = '1625040000000';
  const path = '/api/webhooks/exchange/okx';
  const signString = timestamp + 'POST' + path + okxValidPayload;

  describe('Valid Signatures', () => {
    it('should verify valid OKX signature', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should verify signature with different payload', () => {
      const signString2 = timestamp + 'POST' + path + okxValidSignaturePayload;
      const signature = computeSignature(signString2, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidSignaturePayload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle signature with 0x prefix', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const signatureWithPrefix = '0x' + signature;
      const isValid = verifyOkxSignature(okxValidPayload, signatureWithPrefix, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle uppercase hex signature', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const uppercaseSig = signature.toUpperCase();
      const isValid = verifyOkxSignature(okxValidPayload, uppercaseSig, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });
  });

  describe('Invalid Signatures', () => {
    it('should reject invalid signature', () => {
      const isValid = verifyOkxSignature(okxValidPayload, 'invalid-signature', OKX_SECRET, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject signature with wrong secret', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const wrongSecret = 'wrong-secret-key';
      const isValid = verifyOkxSignature(okxValidPayload, signature, wrongSecret, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject when timestamp does not match signature string', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const wrongTimestamp = '9999999999999';
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, wrongTimestamp);
      expect(isValid).toBe(false);
    });

    it('should reject when HTTP method differs', () => {
      // Tạo signature từ method đúng (POST), nhưng verify với method khác (GET)
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, timestamp, 'GET');
      expect(isValid).toBe(false);
    });

    it('should reject when path differs', () => {
      const wrongPath = '/api/webhooks/exchange/okx/test';
      // Tạo signature từ path đúng, nhưng verify với path khác
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, timestamp, 'POST', wrongPath);
      expect(isValid).toBe(false);
    });

    it('should reject when signature header is missing', () => {
      const isValid = verifyOkxSignature(okxValidPayload, null, OKX_SECRET, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject when timestamp is missing', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, null);
      expect(isValid).toBe(false);
    });

    it('should reject empty signature', () => {
      const isValid = verifyOkxSignature(okxValidPayload, '', OKX_SECRET, timestamp);
      expect(isValid).toBe(false);
    });

    it('should reject empty timestamp', () => {
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, '');
      expect(isValid).toBe(false);
    });
  });

  describe('Signature String Construction', () => {
    it('should construct correct sign string with timestamp+method+path+body', () => {
      const expectedSignString = timestamp + 'POST' + path + okxValidPayload;
      const signature = computeSignature(expectedSignString, OKX_SECRET);
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should use uppercase method in sign string', () => {
      const signStringLower = timestamp + 'post' + path + okxValidPayload;
      const signature = computeSignature(signStringLower, OKX_SECRET);
      // Using POST (uppercase) for verification - the signature from lowercase method won't match
      const isValid = verifyOkxSignature(okxValidPayload, signature, OKX_SECRET, timestamp, 'POST');
      expect(isValid).toBe(false);

      // Verify with correct uppercase method signature
      const correctSignString = timestamp + 'POST' + path + okxValidPayload;
      const correctSignature = computeSignature(correctSignString, OKX_SECRET);
      const correctIsValid = verifyOkxSignature(okxValidPayload, correctSignature, OKX_SECRET, timestamp, 'POST');
      expect(correctIsValid).toBe(true);
    });

    it('should produce different signatures for different timestamps', () => {
      const sig1 = computeSignature(timestamp + 'POST' + path + okxValidPayload, OKX_SECRET);
      const sig2 = computeSignature('9999999999999' + 'POST' + path + okxValidPayload, OKX_SECRET);
      expect(sig1).not.toBe(sig2);
    });
  });

  describe('Edge Cases', () => {
    it('should handle Unicode characters in payload', () => {
      const unicodePayload = JSON.stringify({ instId: 'BTC-USDT', ordId: 'test', note: 'Hợp đồng giao dịch' });
      const signString = timestamp + 'POST' + path + unicodePayload;
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(unicodePayload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle empty payload', () => {
      const payload = '';
      const signString = timestamp + 'POST' + path + payload;
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(payload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle large payload', () => {
      const largePayload = JSON.stringify({ instId: 'BTC-USDT', ordId: 'test', data: 'x'.repeat(10000) });
      const signString = timestamp + 'POST' + path + largePayload;
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(largePayload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should handle payload with special characters', () => {
      const specialPayload = JSON.stringify({
        instId: 'BTC-USDT',
        ordId: 'test',
        specialChars: '!@#$%^&*()_+-=[]{}|;:",.<>?'
      });
      const signString = timestamp + 'POST' + path + specialPayload;
      const signature = computeSignature(signString, OKX_SECRET);
      const isValid = verifyOkxSignature(specialPayload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });
  });

  describe('Real-world Payloads', () => {
    it('should verify typical OKX order update payload', () => {
      const payload = JSON.stringify({
        instId: 'BTC-USDT',
        ordId: '1234567890123456789',
        sz: '0.001',
        px: '52000.00',
        fee: '0.052',
        side: 'buy',
        tradeId: '987654321',
        ts: '1625040000000',
      });

      const timestamp = '1625040000000';
      const signString = timestamp + 'POST' + path + payload;
      const signature = computeSignature(signString, OKX_SECRET);

      const isValid = verifyOkxSignature(payload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });

    it('should verify OKX sell order payload', () => {
      const payload = JSON.stringify({
        instId: 'ETH-USDT',
        ordId: 'order-123',
        sz: '2.5',
        px: '2800.50',
        fee: '1.75',
        side: 'sell',
        ts: '1625040000000',
      });

      const timestamp = '1625040000000';
      const signString = timestamp + 'POST' + path + payload;
      const signature = computeSignature(signString, OKX_SECRET);

      const isValid = verifyOkxSignature(payload, signature, OKX_SECRET, timestamp);
      expect(isValid).toBe(true);
    });
  });

  describe('Consistency', () => {
    it('should produce consistent signature for same inputs', () => {
      const sig1 = computeSignature(signString, OKX_SECRET);
      const sig2 = computeSignature(signString, OKX_SECRET);
      expect(sig1).toBe(sig2);
    });

    it('should produce different signatures for different secrets', () => {
      const sig1 = computeSignature(signString, OKX_SECRET);
      const sig2 = computeSignature(signString, 'different-secret');
      expect(sig1).not.toBe(sig2);
    });
  });
});
