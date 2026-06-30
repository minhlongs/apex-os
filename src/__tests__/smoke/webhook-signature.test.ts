/**
 * Smoke Test: Webhook Signature Verification
 * Tests HMAC-SHA256 signature verification for Binance and Bybit
 */

import * as crypto from 'crypto';

// Signature verification functions using Node.js crypto
function verifyHmacSha256(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(payload);
  const expected = hmac.digest('hex');

  // Normalize: remove 0x prefix and convert to lowercase
  const normalized = signature.replace(/^0x/, '').toLowerCase();
  const expectedHex = expected.toLowerCase();

  if (normalized.length !== expectedHex.length) {
    return false;
  }

  // Use timingSafeEqual for constant-time comparison
  try {
    return crypto.timingSafeEqual(Buffer.from(normalized, 'hex'), Buffer.from(expectedHex, 'hex'));
  } catch {
    return false;
  }
}

function verifyBinanceSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string
): boolean {
  if (!signatureHeader) {
    return false;
  }
  return verifyHmacSha256(payload, signatureHeader, secret);
}

function verifyBybitSignature(
  payload: string,
  signatureHeader: string | null,
  secret: string,
  timestamp: string | null,
  method: string = 'POST',
  path: string = '/v5/account/transaction'
): boolean {
  if (!signatureHeader || !timestamp) {
    return false;
  }

  const signString = timestamp + method.toUpperCase() + path + payload;
  return verifyHmacSha256(signString, signatureHeader, secret);
}

// Fixtures
const BINANCE_SECRET = 'test-binance-secret-key';
const BYBIT_SECRET = 'test-bybit-secret-key';

const binanceValidPayload = JSON.stringify({
  e: 'executionReport',
  E: 1625040000000,
  s: 'BTCUSDT',
  o: {
    s: 'BTCUSDT',
    c: 'test-order-123',
    S: 'BUY',
    o: 'MARKET',
    f: 'GTC',
    q: '0.01',
    p: '0',
    ap: '30000',
    sp: '0',
    x: 'TRADE',
    X: 'FILLED',
    i: 123456789,
    l: '0.01',
    z: '0.01',
    L: '30000',
    n: '0.01',
    N: 'BTC',
    T: 1625040000000,
    t: 12345,
  },
  u: 'user-123',
});

const bybitValidPayload = JSON.stringify({
  symbol: 'BTCUSDT',
  side: 'Buy',
  size: '0.01',
  avgPrice: '30000',
  execType: 'Trade',
  orderType: 'Market',
  orderId: '123456789',
  fee: '0.0001',
  feeCurrency: 'BTC',
  transactTime: '1625040000000',
  accountId: 'aff-1',
  category: 'spot',
});

function computeSignature(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('hex');
}

describe('Webhook Signature Verification - Smoke Tests', () => {

  describe('Binance Signature Verification', () => {
    it('should verify valid Binance signature', async () => {
      const signature = computeSignature(binanceValidPayload, BINANCE_SECRET);
      const isValid = verifyBinanceSignature(binanceValidPayload, signature, BINANCE_SECRET);
      expect(isValid).toBe(true);
    });

    it('should reject invalid Binance signature', async () => {
      const isValid = verifyBinanceSignature(binanceValidPayload, 'invalid-signature', BINANCE_SECRET);
      expect(isValid).toBe(false);
    });

    it('should handle signature with 0x prefix', async () => {
      const signature = computeSignature(binanceValidPayload, BINANCE_SECRET);
      const signatureWithPrefix = '0x' + signature;
      const isValid = verifyBinanceSignature(binanceValidPayload, signatureWithPrefix, BINANCE_SECRET);
      expect(isValid).toBe(true);
    });

    it('should reject when signature header is missing', async () => {
      const isValid = verifyBinanceSignature(binanceValidPayload, null, BINANCE_SECRET);
      expect(isValid).toBe(false);
    });

    it('should reject empty signature', async () => {
      const isValid = verifyBinanceSignature(binanceValidPayload, '', BINANCE_SECRET);
      expect(isValid).toBe(false);
    });

    it('should handle different payloads with same secret', async () => {
      const payload1 = JSON.stringify({ test: 1 });
      const payload2 = JSON.stringify({ test: 2 });

      const sig1 = computeSignature(payload1, BINANCE_SECRET);
      const sig2 = computeSignature(payload2, BINANCE_SECRET);

      expect(verifyBinanceSignature(payload1, sig1, BINANCE_SECRET)).toBe(true);
      expect(verifyBinanceSignature(payload2, sig2, BINANCE_SECRET)).toBe(true);
      expect(verifyBinanceSignature(payload1, sig2, BINANCE_SECRET)).toBe(false);
    });

    it('should reject with wrong secret', async () => {
      const signature = computeSignature(binanceValidPayload, BINANCE_SECRET);
      const wrongSecret = 'wrong-secret-key';
      const isValid = verifyBinanceSignature(binanceValidPayload, signature, wrongSecret);
      expect(isValid).toBe(false);
    });
  });

  describe('Bybit Signature Verification', () => {
    it('should verify valid Bybit signature', async () => {
      const timestamp = '1625040000000';
      const signString = timestamp + 'POST' + '/v5/account/transaction' + bybitValidPayload;
      const signature = computeSignature(signString, BYBIT_SECRET);

      const isValid = verifyBybitSignature(
        bybitValidPayload,
        signature,
        BYBIT_SECRET,
        timestamp
      );
      expect(isValid).toBe(true);
    });

    it('should reject invalid Bybit signature', async () => {
      const isValid = verifyBybitSignature(
        bybitValidPayload,
        'invalid-signature',
        BYBIT_SECRET,
        '1625040000000'
      );
      expect(isValid).toBe(false);
    });

    it('should reject when timestamp is missing', async () => {
      const isValid = verifyBybitSignature(
        bybitValidPayload,
        'some-signature',
        BYBIT_SECRET,
        null
      );
      expect(isValid).toBe(false);
    });

    it('should reject when signature is missing', async () => {
      const isValid = verifyBybitSignature(
        bybitValidPayload,
        null,
        BYBIT_SECRET,
        '1625040000000'
      );
      expect(isValid).toBe(false);
    });

    it('should construct correct sign string with timestamp+method+path+body', async () => {
      const timestamp = '1625040000000';
      const method = 'POST';
      const path = '/v5/account/transaction';
      const signString = timestamp + method.toUpperCase() + path + bybitValidPayload;
      const signature = computeSignature(signString, BYBIT_SECRET);

      const isValid = verifyBybitSignature(
        bybitValidPayload,
        signature,
        BYBIT_SECRET,
        timestamp,
        method,
        path
      );
      expect(isValid).toBe(true);
    });

    it('should handle different HTTP methods', async () => {
      const timestamp = '1625040000000';
      const signString = timestamp + 'GET' + '/v5/account/transaction' + bybitValidPayload;
      const signature = computeSignature(signString, BYBIT_SECRET);

      const isValid = verifyBybitSignature(
        bybitValidPayload,
        signature,
        BYBIT_SECRET,
        timestamp,
        'GET'
      );
      expect(isValid).toBe(true);
    });

    it('should reject with different method in signature', async () => {
      const timestamp = '1625040000000';
      const signString = timestamp + 'POST' + '/v5/account/transaction' + bybitValidPayload;
      const signature = computeSignature(signString, BYBIT_SECRET);

      const isValid = verifyBybitSignature(
        bybitValidPayload,
        signature,
        BYBIT_SECRET,
        timestamp,
        'GET'
      );
      expect(isValid).toBe(false);
    });

    it('should reject with wrong timestamp', async () => {
      const timestamp = '1625040000000';
      const signString = timestamp + 'POST' + '/v5/account/transaction' + bybitValidPayload;
      const signature = computeSignature(signString, BYBIT_SECRET);

      const isValid = verifyBybitSignature(
        bybitValidPayload,
        signature,
        BYBIT_SECRET,
        '9999999999999'
      );
      expect(isValid).toBe(false);
    });
  });

  describe('Signature Computation', () => {
    it('should compute consistent signature for same payload', async () => {
      const sig1 = computeSignature('test-payload', 'secret');
      const sig2 = computeSignature('test-payload', 'secret');
      expect(sig1).toBe(sig2);
    });

    it('should compute different signatures for different payloads', async () => {
      const sig1 = computeSignature('payload-1', 'secret');
      const sig2 = computeSignature('payload-2', 'secret');
      expect(sig1).not.toBe(sig2);
    });

    it('should compute different signatures for different secrets', async () => {
      const sig1 = computeSignature('test-payload', 'secret-1');
      const sig2 = computeSignature('test-payload', 'secret-2');
      expect(sig1).not.toBe(sig2);
    });

    it('should return hex string', async () => {
      const sig = computeSignature('test', 'secret');
      expect(/^[a-f0-9]+$/.test(sig)).toBe(true);
    });
  });

  describe('Real-world Payloads', () => {
    it('should verify Binance executionReport payload', async () => {
      const payload = JSON.stringify({
        e: 'executionReport',
        E: 1625040000000,
        s: 'BTCUSDT',
        o: {
          s: 'BTCUSDT',
          c: 'client-order-id',
          S: 'BUY',
          o: 'MARKET',
          f: 'GTC',
          q: '0.01',
          p: '0',
          ap: '30000',
          sp: '0',
          x: 'TRADE',
          X: 'FILLED',
          i: 123456789,
          l: '0.01',
          z: '0.01',
          L: '30000',
          n: '0.01',
          N: 'BTC',
          T: 1625040000000,
          t: 12345,
        },
      });

      const signature = computeSignature(payload, BINANCE_SECRET);
      const isValid = verifyBinanceSignature(payload, signature, BINANCE_SECRET);
      expect(isValid).toBe(true);
    });

    it('should verify Bybit transaction payload', async () => {
      const timestamp = '1625040000000';
      const payload = JSON.stringify({
        symbol: 'BTCUSDT',
        side: 'Buy',
        size: '0.01',
        avgPrice: '30000',
        execType: 'Trade',
        orderType: 'Market',
        orderId: '123456789',
        fee: '0.0001',
        feeCurrency: 'BTC',
        transactTime: timestamp,
        accountId: 'aff-1',
        category: 'spot',
      });

      const signString = timestamp + 'POST' + '/v5/account/transaction' + payload;
      const signature = computeSignature(signString, BYBIT_SECRET);

      const isValid = verifyBybitSignature(
        payload,
        signature,
        BYBIT_SECRET,
        timestamp
      );
      expect(isValid).toBe(true);
    });
  });

  describe('Edge Cases', () => {
    it('should handle Unicode characters in payload', async () => {
      const payload = '{"test": "data"}';
      const signature = computeSignature(payload, BINANCE_SECRET);
      const isValid = verifyBinanceSignature(payload, signature, BINANCE_SECRET);
      expect(isValid).toBe(true);
    });

    it('should handle empty payload', async () => {
      const payload = '';
      const signature = computeSignature(payload, BINANCE_SECRET);
      const isValid = verifyBinanceSignature(payload, signature, BINANCE_SECRET);
      expect(isValid).toBe(true);
    });

    it('should handle large payload', async () => {
      const largePayload = JSON.stringify({ data: 'x'.repeat(10000) });
      const signature = computeSignature(largePayload, BINANCE_SECRET);
      const isValid = verifyBinanceSignature(largePayload, signature, BINANCE_SECRET);
      expect(isValid).toBe(true);
    });

    it('should handle case sensitivity in hex signature', async () => {
      const payload = 'test-payload';
      const signature = computeSignature(payload, BINANCE_SECRET);
      const uppercaseSig = signature.toUpperCase();
      const lowercaseSig = signature.toLowerCase();

      expect(verifyBinanceSignature(payload, uppercaseSig, BINANCE_SECRET)).toBe(true);
      expect(verifyBinanceSignature(payload, lowercaseSig, BINANCE_SECRET)).toBe(true);
    });
  });
});
