/**
 * Unit tests cho BYOK Crypto Utilities
 * File: /Users/macbook/apex-os/src/lib/byok/__tests__/crypto.test.ts
 */

// Polyfill crypto.subtle BEFORE importing crypto module
import { webcrypto } from 'node:crypto';

if (!global.crypto?.subtle) {
  // @ts-expect-error - polyfilling webcrypto
  global.crypto = global.crypto || {};
  // @ts-expect-error
  global.crypto.subtle = webcrypto.subtle;
  // Also ensure getRandomValues
  if (!global.crypto.getRandomValues) {
    // @ts-expect-error
    global.crypto.getRandomValues = webcrypto.getRandomValues;
  }
}

// Valid 32-byte key encoded as base64 (for AES-256)
const VALID_MASTER_KEY_BASE64 = 'E8b1qfc4+VxkSSWKkwxnxBpS65KnybbliF3+sh6Q4/8=';

// Helper to set env
const setKey = (key: string | undefined) => {
  if (key) {
    process.env.BYOK_ENCRYPTION_KEY = key;
  } else {
    delete process.env.BYOK_ENCRYPTION_KEY;
  }
};

// Helper to get fresh imports (clears module cache)
async function getCryptoModule() {
  jest.resetModules();
  const mod = await import('../crypto');
  return mod;
}

describe('BYOK Crypto', () => {
  describe('encryptApiKey / decryptApiKey round-trip', () => {
    const testCases = [
      { name: 'short key', plaintext: 'sk_test_123' },
      { name: 'medium key', plaintext: 'binance_api_key_abcdef1234567890xyz' },
      { name: 'long key', plaintext: 'very_long_api_key_' + 'a'.repeat(200) },
      { name: 'unicode key', plaintext: 'api-key-日本語-🌟-🔥' },
      { name: 'special chars', plaintext: '!@#$%^&*()_+-=[]{}|;:",.<>?/~`' },
      { name: 'json-like', plaintext: '{"apiKey":"secret123","secret":"xyz789"}' },
      { name: 'multiline', plaintext: 'line1\nline2\r\nline3\ttab' },
      { name: 'binary-like', plaintext: String.fromCharCode(...Array.from({ length: 100 }, (_, i) => i % 256)) },
    ];

    testCases.forEach(({ name, plaintext }) => {
      it(`should encrypt and decrypt ${name} correctly`, async () => {
        setKey(VALID_MASTER_KEY_BASE64);
        const { encryptApiKey, decryptApiKey } = await getCryptoModule();

        const encrypted = await encryptApiKey(plaintext);

        expect(typeof encrypted).toBe('string');
        expect(encrypted.length).toBeGreaterThan(0);

        const decrypted = await decryptApiKey(encrypted);
        expect(decrypted).toBe(plaintext);
      });
    });

    it('should produce different ciphertexts for same plaintext (IV randomization)', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey, decryptApiKey } = await getCryptoModule();

      const encrypted1 = await encryptApiKey('same-key');
      const encrypted2 = await encryptApiKey('same-key');

      expect(encrypted1).not.toBe(encrypted2);
      expect(await decryptApiKey(encrypted1)).toBe('same-key');
      expect(await decryptApiKey(encrypted2)).toBe('same-key');
    });

    it('should maintain format: [IV (12 bytes)][ciphertext + authTag]', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey } = await getCryptoModule();
      const IV_BYTES = 12;

      const encrypted = await encryptApiKey('test-key');
      const buffer = Buffer.from(encrypted, 'base64');

      expect(buffer.length).toBeGreaterThanOrEqual(IV_BYTES);
      const iv = buffer.slice(0, IV_BYTES);
      expect(iv.length).toBe(IV_BYTES);
    });
  });

  describe('encryptApiKey validation', () => {
    it('should throw when plaintext is empty string', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey } = await getCryptoModule();

      await expect(encryptApiKey('')).rejects.toThrow('[BYOK Crypto] Plaintext không được để trống');
    });

    it('should throw when plaintext is not a string', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey } = await getCryptoModule();

      // @ts-expect-error - testing invalid input
      await expect(encryptApiKey(null as any)).rejects.toThrow('[BYOK Crypto] Plaintext phải là string');
      // @ts-expect-error - testing invalid input
      await expect(encryptApiKey(123 as any)).rejects.toThrow('[BYOK Crypto] Plaintext phải là string');
      // @ts-expect-error - testing invalid input
      await expect(encryptApiKey(undefined as any)).rejects.toThrow('[BYOK Crypto] Plaintext phải là string');
    });

    it('should throw when BYOK_ENCRYPTION_KEY is not set', async () => {
      setKey(undefined); // Ensure key is not set
      const { encryptApiKey } = await getCryptoModule();

      await expect(encryptApiKey('test')).rejects.toThrow('[BYOK Crypto] BYOK_ENCRYPTION_KEY environment variable không được thiết lập');
    });

    it('should throw when BYOK_ENCRYPTION_KEY is too short', async () => {
      setKey('short-key'); // Less than 32 bytes when base64 decoded
      const { encryptApiKey } = await getCryptoModule();

      await expect(encryptApiKey('test')).rejects.toThrow('[BYOK Crypto] BYOK_ENCRYPTION_KEY phải là ít nhất 32 bytes khi decode');
    });
  });

  describe('decryptApiKey validation', () => {
    it('should throw when encrypted data is empty string', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { decryptApiKey } = await getCryptoModule();

      await expect(decryptApiKey('')).rejects.toThrow('[BYOK Crypto] Input không được để trống');
    });

    it('should throw when encrypted data is not a string', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { decryptApiKey } = await getCryptoModule();

      // @ts-expect-error - testing invalid input
      await expect(decryptApiKey(null as any)).rejects.toThrow('[BYOK Crypto] Input phải là string');
      // @ts-expect-error - testing invalid input
      await expect(decryptApiKey(123 as any)).rejects.toThrow('[BYOK Crypto] Input phải là string');
    });

    it('should throw when encrypted data is too short (invalid length)', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { decryptApiKey } = await getCryptoModule();

      // Less than 12 bytes (IV size)
      await expect(decryptApiKey('aGVsbG8=')).rejects.toThrow(/Encrypted data quá ngắn/);
    });

    it('should throw when encrypted data has invalid base64', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { decryptApiKey } = await getCryptoModule();

      await expect(decryptApiKey('not-valid-base64!!!')).rejects.toThrow();
    });

    it('should throw when BYOK_ENCRYPTION_KEY is not set', async () => {
      // First encrypt with key set
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey } = await getCryptoModule();
      const encrypted = await encryptApiKey('test');

      // Now remove key and import fresh module (clears cache)
      setKey(undefined);
      const { decryptApiKey } = await getCryptoModule();

      await expect(decryptApiKey(encrypted)).rejects.toThrow('[BYOK Crypto] BYOK_ENCRYPTION_KEY environment variable không được thiết lập');
    });

    it('should throw when encrypted with different key', async () => {
      // Encrypt with first key
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey } = await getCryptoModule();
      const encrypted = await encryptApiKey('test');

      // Switch to different key and import fresh module
      setKey('dGVzdF9rZXlfdG9fZG93bmxvYWRfZG93bmxvYWRfZG93bmxvY2==');
      const { decryptApiKey } = await getCryptoModule();

      await expect(decryptApiKey(encrypted)).rejects.toThrow('[BYOK Crypto] Giải mã thất bại');
    });
  });

  describe('corrupted data scenarios', () => {
    it('should detect tampered ciphertext', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey, decryptApiKey } = await getCryptoModule();

      const encrypted = await encryptApiKey('secret123');

      // Tamper with the ciphertext (change a byte after IV)
      const buffer = Buffer.from(encrypted, 'base64');
      buffer[15] = buffer[15] ^ 0xFF; // Flip a bit in ciphertext
      const tampered = buffer.toString('base64');

      await expect(decryptApiKey(tampered)).rejects.toThrow('[BYOK Crypto] Giải mã thất bại');
    });

    it('should detect tampered IV', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey, decryptApiKey } = await getCryptoModule();

      const encrypted = await encryptApiKey('secret123');

      // Tamper with the IV (first 12 bytes)
      const buffer = Buffer.from(encrypted, 'base64');
      buffer[0] = buffer[0] ^ 0xFF; // Flip a bit in IV
      const tampered = buffer.toString('base64');

      await expect(decryptApiKey(tampered)).rejects.toThrow('[BYOK Crypto] Giải mã thất bại');
    });

    it('should detect truncated data (missing auth tag)', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { encryptApiKey, decryptApiKey } = await getCryptoModule();

      const encrypted = await encryptApiKey('secret123');
      const buffer = Buffer.from(encrypted, 'base64');

      // Remove last few bytes (auth tag is part of ciphertext in AES-GCM)
      const truncated = buffer.slice(0, buffer.length - 5).toString('base64');

      await expect(decryptApiKey(truncated)).rejects.toThrow('[BYOK Crypto] Giải mã thất bại');
    });
  });

  describe('isByokConfigured', () => {
    it('should return false when BYOK_ENCRYPTION_KEY is not set', async () => {
      setKey(undefined);
      const { isByokConfigured } = await getCryptoModule();
      expect(isByokConfigured()).toBe(false);
    });

    it('should return true when BYOK_ENCRYPTION_KEY is set to non-empty string', async () => {
      setKey(VALID_MASTER_KEY_BASE64);
      const { isByokConfigured } = await getCryptoModule();
      expect(isByokConfigured()).toBe(true);
    });

    it('should return false when BYOK_ENCRYPTION_KEY is empty string', async () => {
      setKey('');
      const { isByokConfigured } = await getCryptoModule();
      expect(isByokConfigured()).toBe(false);
    });
  });

  describe('constants', () => {
    it('should have correct algorithm', async () => {
      const { ALGORITHM } = await getCryptoModule();
      expect(ALGORITHM).toBe('AES-GCM');
    });

    it('should have correct IV size (12 bytes for GCM)', async () => {
      const { IV_BYTES } = await getCryptoModule();
      expect(IV_BYTES).toBe(12);
    });

    it('should have correct key length (256 bits)', async () => {
      const { KEY_LEN_BITS } = await getCryptoModule();
      expect(KEY_LEN_BITS).toBe(256);
    });
  });
});
