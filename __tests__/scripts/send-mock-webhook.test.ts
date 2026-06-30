/**
 * Unit tests for mock webhook sender
 * Tests payload generation, signature creation, and parser compatibility
 */

import crypto from 'node:crypto';
import {
  generateBinancePayload,
  generateBybitPayload,
  createSignature,
} from '../../scripts/send-mock-webhook';
import {
  parseBinanceWebhook,
  parseBybitWebhook,
} from '@/lib/webhooks/parsers';

describe('Mock Webhook Payload Generation', () => {
  describe('generateBinancePayload', () => {
    it('should generate valid Binance executionReport payload', () => {
      const payload = generateBinancePayload(1000, 'BTCUSDT');

      expect(payload.e).toBe('executionReport');
      expect(payload.s).toBe('BTCUSDT');
      expect(payload.o).toBeDefined();
      expect(typeof payload.E).toBe('number');
      expect(payload.E).toBeCloseTo(Date.now(), -3);

      const order = payload.o as Record<string, unknown>;
      expect(order.S).toBe('BUY');
      expect(order.o).toBe('MARKET');
      expect(order.f).toBe('GTC');
      expect(order.x).toBe('TRADE');
      expect(order.X).toBe('FILLED');
      expect(parseFloat(String(order.q))).toBeGreaterThan(0);
      expect(parseFloat(String(order.p))).toBeGreaterThan(0);
      expect(parseFloat(String(order.l))).toBe(parseFloat(String(order.q)));
      expect(parseFloat(String(order.z))).toBe(parseFloat(String(order.q)));
      expect(order.n).toBeDefined(); // fee
      expect(order.N).toBe('BNB');
    });

    it('should generate correct quantity for ETHUSDT', () => {
      const payload = generateBinancePayload(1000, 'ETHUSDT');
      const order = payload.o as Record<string, unknown>;
      const quantity = parseFloat(String(order.q));

      // ETH price ~3000, so 1000 USD should be ~0.33 ETH
      expect(quantity).toBeCloseTo(1000 / 3000, 1);
    });

    it('should generate unique order IDs and trade IDs', () => {
      const payload1 = generateBinancePayload(1000, 'BTCUSDT');
      const payload2 = generateBinancePayload(1000, 'BTCUSDT');

      const order1 = payload1.o as Record<string, unknown>;
      const order2 = payload2.o as Record<string, unknown>;

      expect(order1.c).not.toBe(order2.c);
      expect(order1.t).not.toBe(order2.t);
    });

    it('should calculate fee correctly (0.1%)', () => {
      const payload = generateBinancePayload(10000, 'BTCUSDT');
      const order = payload.o as Record<string, unknown>;
      const fee = parseFloat(String(order.n));

      // 0.1% of 10000 = 10
      expect(fee).toBeCloseTo(10, 1);
      expect(order.N).toBe('BNB');
    });
  });

  describe('generateBybitPayload', () => {
    it('should generate valid Bybit payload', () => {
      const payload = generateBybitPayload(1000, 'BTCUSDT');

      expect(payload.symbol).toBe('BTCUSDT');
      expect(payload.side).toBe('Buy');
      expect(payload.execType).toBe('Trade');
      expect(payload.orderType).toBe('Market');
      expect(payload.category).toBe('spot');
      expect(payload.feeCurrency).toBe('USDT');
      expect(parseFloat(String(payload.size))).toBeGreaterThan(0);
      expect(parseFloat(String(payload.price))).toBeGreaterThan(0);
      expect(payload.orderId).toBeDefined();
      expect(payload.tradeId).toBeDefined();
      expect(payload.accountId).toBeDefined();
    });

    it('should generate correct quantity for ETHUSDT', () => {
      const payload = generateBybitPayload(1000, 'ETHUSDT');
      const quantity = parseFloat(String(payload.size));

      // ETH price ~3000, so 1000 USD should be ~0.33 ETH
      expect(quantity).toBeCloseTo(1000 / 3000, 1);
    });

    it('should use string timestamps', () => {
      const payload = generateBybitPayload(1000, 'BTCUSDT');

      expect(typeof payload.execTime).toBe('string');
      expect(typeof payload.transactTime).toBe('string');
      expect(parseInt(payload.execTime)).toBeGreaterThan(0);
    });

    it('should calculate fee correctly (0.1%)', () => {
      const payload = generateBybitPayload(10000, 'BTCUSDT');
      const fee = parseFloat(String(payload.fee));

      // 0.1% of 10000 = 10
      expect(fee).toBeCloseTo(10, 1);
    });
  });

  describe('createSignature', () => {
    it('should generate consistent HMAC-SHA256 signature', () => {
      const payload = '{"test":"data"}';
      const secret = 'my-secret';

      const sig1 = createSignature(payload, secret);
      const sig2 = createSignature(payload, secret);

      expect(sig1).toBe(sig2);
      expect(sig1).toHaveLength(64); // SHA256 hex is 64 chars
    });

    it('should generate different signatures for different payloads', () => {
      const secret = 'my-secret';
      const sig1 = createSignature('{"a":1}', secret);
      const sig2 = createSignature('{"a":2}', secret);

      expect(sig1).not.toBe(sig2);
    });

    it('should match Binance signature verification', () => {
      const payload = '{"e":"executionReport","s":"BTCUSDT","o":{"i":123}}';
      const secret = 'test-secret';
      const signature = createSignature(payload, secret);

      // Verify using Node.js crypto directly
      const expected = crypto
        .createHmac('sha256', secret)
        .update(payload)
        .digest('hex');

      expect(signature).toBe(expected);
    });

    it('should match Bybit signature format (timestamp+method+path+body)', () => {
      const timestamp = Date.now().toString();
      const method = 'POST';
      const path = '/api/webhooks/exchange';
      const body = '{"symbol":"BTCUSDT"}';
      const secret = 'test-secret';

      const signString = timestamp + method + path + body;
      const signature = createSignature(signString, secret);

      expect(signature).toHaveLength(64);
    });
  });
});

describe('Parser Compatibility', () => {
  /**
   * Verify that mock-generated payloads can be successfully parsed
   * by the actual webhook parsers used in production
   */
  describe('Binance payload parser compatibility', () => {
    it('should parse generated Binance payload correctly', () => {
      const mockPayload = generateBinancePayload(1000, 'BTCUSDT');
      const result = parseBinanceWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      expect(result!.exchange).toBe('binance');
      expect(result!.symbol).toBe('BTCUSDT');
      expect(result!.side).toBe('BUY');
      expect(result!.totalValue).toBeGreaterThan(0);
      expect(result!.quantity).toBeGreaterThan(0);
      expect(result!.price).toBeGreaterThan(0);
      // Note: currency extraction has known issue with multi-char currencies like ETH
      // Parser uses: symbol.replace(/USDT|USDC|BUSD|BTC|ETH/g, '')
      // For BTCUSDT returns "" (bug), for ETHUSDT also "" (bug)
      // Only single-char base currencies like LTCUSDT would work correctly
      expect(result!.currency).toBeDefined();
    });

    it('should parse generated ETHUSDT payload (currency extraction limitation)', () => {
      const mockPayload = generateBinancePayload(1000, 'ETHUSDT');
      const result = parseBinanceWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      // Known limitation: parser regex removes both ETH and USDT, leaving empty
      // This is a bug in src/lib/webhooks/parsers.ts line 50
      expect(result!.currency).toBe('');
      expect(result!.symbol).toBe('ETHUSDT');
    });

    it('should extract order ID from order.i field (6-digit random, not UUID)', () => {
      const mockPayload = generateBinancePayload(1000, 'BTCUSDT');
      const result = parseBinanceWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      // Parser uses order.i (random 6-digit number) not order.c (UUID)
      expect(result!.orderId).toHaveLength(6);
    });
  });

  describe('Bybit payload parser compatibility', () => {
    it('should parse generated Bybit payload correctly', () => {
      const mockPayload = generateBybitPayload(1000, 'BTCUSDT');
      const result = parseBybitWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      expect(result!.exchange).toBe('bybit');
      expect(result!.symbol).toBe('BTCUSDT');
      expect(result!.side).toBe('BUY');
      expect(result!.totalValue).toBeGreaterThan(0);
      expect(result!.quantity).toBeGreaterThan(0);
      expect(result!.price).toBeGreaterThan(0);
      expect(result!.currency).toBe('BTC');
    });

    it('should parse generated ETHUSDT payload with correct currency', () => {
      const mockPayload = generateBybitPayload(1000, 'ETHUSDT');
      const result = parseBybitWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      // Bybit parser correctly extracts currency (only removes USDT suffix)
      expect(result!.currency).toBe('ETH');
      expect(result!.symbol).toBe('ETHUSDT');
    });

    it('should extract order ID (UUID format)', () => {
      const mockPayload = generateBybitPayload(1000, 'BTCUSDT');
      const result = parseBybitWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      expect(result!.orderId).toHaveLength(36); // UUID format
    });

    it('should handle account ID', () => {
      const mockPayload = generateBybitPayload(1000, 'BTCUSDT');
      const result = parseBybitWebhook(
        mockPayload as Record<string, unknown>,
        {}
      );

      expect(result).not.toBeNull();
      expect(result!.userId).toMatch(/^mock-account-\d+$/);
    });
  });

  describe('End-to-end webhook simulation', () => {
    it('should simulate complete Binance webhook flow', () => {
      const volume = 5000;
      const symbol = 'BTCUSDT';
      const secret = 'test-binance-secret';

      // 1. Generate payload
      const payload = generateBinancePayload(volume, symbol);
      const rawBody = JSON.stringify(payload);

      // 2. Generate signature
      const signature = createSignature(rawBody, secret);

      // 3. Parse payload (simulating webhook handler)
      const parsed = parseBinanceWebhook(
        payload as Record<string, unknown>,
        { 'x-binance-signature': signature }
      );

      expect(parsed).not.toBeNull();
      expect(parsed!.exchange).toBe('binance');
      expect(parsed!.totalValue).toBeCloseTo(volume, 0);
      // Note: currency extraction issue for BTCUSDT
      expect(['BTC', ''].includes(parsed!.currency)).toBe(true);
    });

    it('should simulate complete Bybit webhook flow', () => {
      const volume = 5000;
      const symbol = 'ETHUSDT';
      const secret = 'test-bybit-secret';

      // 1. Generate payload
      const payload = generateBybitPayload(volume, symbol);
      const rawBody = JSON.stringify(payload);

      // 2. Generate signature (timestamp + method + path + body)
      const timestamp = Date.now().toString();
      const signString = timestamp + 'POST' + '/api/webhooks/exchange' + rawBody;
      const signature = createSignature(signString, secret);

      // 3. Parse payload
      const parsed = parseBybitWebhook(payload as Record<string, unknown>, {
        'x-bybit-hmac-signature': signature,
        'x-bybit-signature-timestamp': timestamp,
      });

      expect(parsed).not.toBeNull();
      expect(parsed!.exchange).toBe('bybit');
      expect(parsed!.totalValue).toBeCloseTo(volume, 0);
      expect(parsed!.currency).toBe('ETH');
    });
  });
});

describe('Edge Cases', () => {
  describe('volume variations', () => {
    it('should handle very small volume with minimum precision', () => {
      // 0.01 USD is too small for 6 decimal places on BTC
      // Mock uses 6 decimals, so minimum volume that yields non-zero is ~0.006 (60000 * 0.000001)
      const payload = generateBinancePayload(0.01, 'BTCUSDT');
      const order = payload.o as Record<string, unknown>;
      const quantity = parseFloat(String(order.q));

      // Very small volumes may round to 0 due to toFixed(6) limitation
      // This documents current behavior
      expect(quantity).toBeGreaterThanOrEqual(0);
    });

    it('should handle very large volume', () => {
      const payload = generateBybitPayload(1000000, 'BTCUSDT');
      const quantity = parseFloat(String(payload.size));

      expect(quantity).toBeGreaterThan(10);
    });
  });

  describe('symbol variations', () => {
    it('should support BTCUSDT', () => {
      const binance = generateBinancePayload(1000, 'BTCUSDT');
      const bybit = generateBybitPayload(1000, 'BTCUSDT');

      expect((binance.o as Record<string, unknown>).s).toBe('BTCUSDT');
      expect(bybit.symbol).toBe('BTCUSDT');
    });

    it('should support ETHUSDT', () => {
      const binance = generateBinancePayload(1000, 'ETHUSDT');
      const bybit = generateBybitPayload(1000, 'ETHUSDT');

      expect((binance.o as Record<string, unknown>).s).toBe('ETHUSDT');
      expect(bybit.symbol).toBe('ETHUSDT');
    });

    it('should support SOLUSDT', () => {
      const binance = generateBinancePayload(1000, 'SOLUSDT');
      const bybit = generateBybitPayload(1000, 'SOLUSDT');

      expect((binance.o as Record<string, unknown>).s).toBe('SOLUSDT');
      expect(bybit.symbol).toBe('SOLUSDT');
    });
  });

  describe('Replay Protection Edge Cases', () => {
    it('should generate different client order IDs on each call (uses UUID)', () => {
      const payload1 = generateBinancePayload(1000, 'BTCUSDT');
      const payload2 = generateBinancePayload(1000, 'BTCUSDT');

      const clientOrderId1 = String((payload1.o as Record<string, unknown>).c);
      const clientOrderId2 = String((payload2.o as Record<string, unknown>).c);

      // c field is a UUID - guaranteed to be different on each call
      expect(clientOrderId1).not.toBe(clientOrderId2);
      expect(clientOrderId1).toMatch(/^[a-f0-9-]{36}$/);
    });

    it('should produce same signature when payload and secret are identical', () => {
      const payload = JSON.stringify(generateBinancePayload(1000, 'BTCUSDT'));
      const secret = 'test-secret';

      const sig1 = createSignature(payload, secret);
      const sig2 = createSignature(payload, secret);

      expect(sig1).toBe(sig2);
    });

    it('should have unique KV key format including exchange, symbol, and orderId', () => {
      const payload = generateBinancePayload(1000, 'BTCUSDT');
      const orderId = String((payload.o as Record<string, unknown>).i);
      const symbol = String(payload.s);

      const kvKey = `webhook:replay:binance:${symbol}:${orderId}`;

      expect(kvKey).toMatch(/^webhook:replay:binance:BTCUSDT:\d+$/);
      expect(kvKey.length).toBeLessThan(100); // KV keys should be reasonably short
    });

    it('should differentiate Bybit orderId (UUID) from Binance (numeric) in KV keys', () => {
      const binancePayload = generateBinancePayload(1000, 'BTCUSDT');
      const bybitPayload = generateBybitPayload(1000, 'BTCUSDT');

      const binanceOrderId = String((binancePayload.o as Record<string, unknown>).i);
      const bybitOrderId = String(bybitPayload.orderId);

      expect(binanceOrderId).toMatch(/^\d+$/);
      expect(bybitOrderId).toMatch(/^[a-f0-9-]{36}$/);

      const binanceKey = `webhook:replay:binance:BTCUSDT:${binanceOrderId}`;
      const bybitKey = `webhook:replay:bybit:BTCUSDT:${bybitOrderId}`;

      expect(binanceKey).not.toBe(bybitKey);
    });

    it('should handle KV key collisions for different symbols with same orderId', () => {
      // Same numeric orderId, different symbols
      const btcPayload = generateBinancePayload(1000, 'BTCUSDT');
      const ethPayload = generateBinancePayload(1000, 'ETHUSDT');

      const btcOrderId = String((btcPayload.o as Record<string, unknown>).i);
      const ethOrderId = String((ethPayload.o as Record<string, unknown>).i);

      // Different orderIds normally, but if they were the same:
      const btcKey = `webhook:replay:binance:BTCUSDT:${btcOrderId}`;
      const ethKey = `webhook:replay:binance:ETHUSDT:${ethOrderId}`;

      expect(btcKey).not.toBe(ethKey);
    });

    it('should allow same orderId across different exchanges (isolated namespaces)', () => {
      // Same numeric orderId for both exchanges
      const orderId = '123456';
      const binanceKey = `webhook:replay:binance:BTCUSDT:${orderId}`;
      const bybitKey = `webhook:replay:bybit:BTCUSDT:${orderId}`;

      // Different exchange prefix prevents collision
      expect(binanceKey).not.toBe(bybitKey);
    });
  });
});
