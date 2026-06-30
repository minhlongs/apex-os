/**
 * Tests for webhook timestamp validation
 */

import { WebhookCrypto, DEFAULT_TIMESTAMP_WINDOW_MS } from '@/lib/webhooks/crypto';

describe('WebhookCrypto Timestamp Validation', () => {
  describe('extractTimestamp', () => {
    it('should extract timestamp from Binance payload event time (E field)', () => {
      const body = { E: 1704067200000, e: 'executionReport' };
      const headers: Record<string, string> = {};
      const timestamp = WebhookCrypto.extractTimestamp('binance', headers, body);
      expect(timestamp).toBe(1704067200000);
    });

    it('should fall back to order transaction time for Binance', () => {
      const body = { o: { T: 1704067200000 } };
      const headers: Record<string, string> = {};
      const timestamp = WebhookCrypto.extractTimestamp('binance', headers, body);
      expect(timestamp).toBe(1704067200000);
    });

    it('should prefer event time over order time for Binance', () => {
      const body = { E: 1704067200000, o: { T: 1704067190000 } };
      const headers: Record<string, string> = {};
      const timestamp = WebhookCrypto.extractTimestamp('binance', headers, body);
      expect(timestamp).toBe(1704067200000); // event time is used
    });

    it('should extract timestamp from Bybit header', () => {
      const body = { symbol: 'BTCUSDT', execType: 'Trade' };
      const headers = { 'x-bybit-signature-timestamp': '1704067200000' };
      const timestamp = WebhookCrypto.extractTimestamp('bybit', headers, body);
      expect(timestamp).toBe(1704067200000);
    });

    it('should fall back to body transactTime for Bybit', () => {
      const body = { symbol: 'BTCUSDT', execType: 'Trade', transactTime: '1704067200000' };
      const headers: Record<string, string> = {};
      const timestamp = WebhookCrypto.extractTimestamp('bybit', headers, body);
      expect(timestamp).toBe(1704067200000);
    });

    it('should prefer header timestamp over body for Bybit', () => {
      const body = { symbol: 'BTCUSDT', execType: 'Trade', transactTime: '1704067190000' };
      const headers = { 'x-bybit-signature-timestamp': '1704067200000' };
      const timestamp = WebhookCrypto.extractTimestamp('bybit', headers, body);
      expect(timestamp).toBe(1704067200000); // header is used
    });

    it('should return null for unknown exchange', () => {
      const body = {};
      const headers: Record<string, string> = {};
      // @ts-expect-error - testing unknown exchange
      const timestamp = WebhookCrypto.extractTimestamp('unknown' as any, headers, body);
      expect(timestamp).toBeNull();
    });

    it('should return null when no timestamp found', () => {
      const body = { e: 'otherEvent' };
      const headers: Record<string, string> = {};
      const timestamp = WebhookCrypto.extractTimestamp('binance', headers, body);
      expect(timestamp).toBeNull();
    });
  });

  describe('validateTimestamp', () => {
    const now = 1704067200000; // 2024-01-01T00:00:00.000Z

    it('should accept timestamp within window', () => {
      const result = WebhookCrypto.validateTimestamp(now, now, 5 * 60 * 1000);
      expect(result.valid).toBe(true);
      expect(result.ageMs).toBe(0);
    });

    it('should accept timestamp 2 minutes ago', () => {
      const twoMinutesAgo = now - 2 * 60 * 1000;
      const result = WebhookCrypto.validateTimestamp(twoMinutesAgo, now, 5 * 60 * 1000);
      expect(result.valid).toBe(true);
      expect(result.ageMs).toBe(2 * 60 * 1000);
    });

    it('should accept timestamp 2 minutes in future (clock skew)', () => {
      const twoMinutesFuture = now + 2 * 60 * 1000;
      const result = WebhookCrypto.validateTimestamp(twoMinutesFuture, now, 5 * 60 * 1000);
      expect(result.valid).toBe(true);
      expect(result.ageMs).toBe(2 * 60 * 1000);
    });

    it('should reject timestamp 6 minutes ago (outside window)', () => {
      const sixMinutesAgo = now - 6 * 60 * 1000;
      const result = WebhookCrypto.validateTimestamp(sixMinutesAgo, now, 5 * 60 * 1000);
      expect(result.valid).toBe(false);
      expect(result.error).toContain('outside acceptable window');
      expect(result.ageMs).toBe(6 * 60 * 1000);
    });

    it('should reject timestamp 10 minutes in future', () => {
      const tenMinutesFuture = now + 10 * 60 * 1000;
      const result = WebhookCrypto.validateTimestamp(tenMinutesFuture, now, 5 * 60 * 1000);
      expect(result.valid).toBe(false);
      expect(result.ageMs).toBe(10 * 60 * 1000);
    });

    it('should reject zero timestamp', () => {
      const result = WebhookCrypto.validateTimestamp(0, now, 5 * 60 * 1000);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid timestamp format');
    });

    it('should reject negative timestamp', () => {
      const result = WebhookCrypto.validateTimestamp(-1, now, 5 * 60 * 1000);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Invalid timestamp format');
    });

    it('should use default window when not specified', () => {
      const now = Date.now();
      const fiveMinutesAgo = now - 5 * 60 * 1000;
      const result = WebhookCrypto.validateTimestamp(fiveMinutesAgo);
      expect(result.valid).toBe(true); // exactly 5 minutes should be valid (not >)
    });

    it('should reject exactly 5 minutes and 1 second ago', () => {
      const now = 1704067200000;
      const fiveMinOneSecAgo = now - (5 * 60 * 1000 + 1000);
      const result = WebhookCrypto.validateTimestamp(fiveMinOneSecAgo, now, 5 * 60 * 1000);
      expect(result.valid).toBe(false);
    });
  });

  describe('hashPayload and hashSignature', () => {
    it('should produce consistent SHA256 hash', async () => {
      const payload = '{"test":"data"}';
      const hash1 = await WebhookCrypto.hashPayload(payload);
      const hash2 = await WebhookCrypto.hashPayload(payload);
      expect(hash1).toBe(hash2);
      expect(hash1).toHaveLength(64); // SHA256 hex is 64 chars
    });

    it('should produce different hashes for different payloads', async () => {
      const hash1 = await WebhookCrypto.hashPayload('{"a":1}');
      const hash2 = await WebhookCrypto.hashPayload('{"a":2}');
      expect(hash1).not.toBe(hash2);
    });

    it('should hash signature consistently', async () => {
      const signature = 'abc123signature';
      const hash1 = await WebhookCrypto.hashSignature(signature);
      const hash2 = await WebhookCrypto.hashSignature(signature);
      expect(hash1).toBe(hash2);
    });
  });
});
