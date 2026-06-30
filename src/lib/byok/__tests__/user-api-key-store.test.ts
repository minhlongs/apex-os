/**
 * Unit tests cho User API Key Store
 * File: /Users/macbook/apex-os/src/lib/byok/__tests__/user-api-key-store.test.ts
 */

// Mock crypto module FIRST (jest hoists this)
jest.mock('../crypto', () => ({
  encryptApiKey: jest.fn(),
  decryptApiKey: jest.fn(),
  isByokConfigured: jest.fn().mockReturnValue(true),
}));

import {
  setUserApiKey,
  getUserApiKey,
  deleteUserApiKey,
  listUserApiKeys,
  hasUserApiKey,
  ByokStoreError,
  ByokProvider,
  ApiKeyMetadata,
} from '../user-api-key-store';

import { encryptApiKey, decryptApiKey } from '../crypto';

// Get mocked functions from the jest.mocked module
const mockEncryptApiKey = encryptApiKey as jest.Mock;
const mockDecryptApiKey = decryptApiKey as jest.Mock;

// Mock DB interface - fresh for each test
const createMockDB = () => {
  const statements: Map<string, any> = new Map();

  return {
    prepare: (sql: string) => {
      if (!statements.has(sql)) {
        statements.set(sql, {
          bind: jest.fn().mockReturnThis(),
          first: jest.fn(),
          all: jest.fn(),
          run: jest.fn().mockResolvedValue({ changes: 0 }),
        });
      }
      return statements.get(sql)!;
    },
  };
};

describe('UserApiKeyStore', () => {
  const TEST_USER_ID = 'user_12345';
  const TEST_PROVIDER: ByokProvider = 'binance';
  const TEST_API_KEY = 'binance-secret-api-key-xyz';
  const TEST_ENCRYPTED = 'encrypted-buffer-base64';

  beforeEach(() => {
    jest.clearAllMocks();
    mockEncryptApiKey.mockResolvedValue(TEST_ENCRYPTED);
    mockDecryptApiKey.mockResolvedValue(TEST_API_KEY);

    // Setup fresh global DB for each test
    (globalThis as any).DB = createMockDB();
  });

  afterEach(() => {
    delete (globalThis as any).DB;
  });

  describe('setUserApiKey', () => {
    it('should encrypt key and store in DB with INSERT OR REPLACE', async () => {
      const db = (globalThis as any).DB;
      const sql = `INSERT OR REPLACE INTO user_api_keys (user_id, provider, encrypted_key, updated_at) VALUES (?, ?, ?, datetime('now'))`;
      const statement = db.prepare(sql);
      const runMock = jest.fn().mockResolvedValue({ changes: 1 });
      statement.run = runMock;

      await setUserApiKey(TEST_USER_ID, TEST_PROVIDER, TEST_API_KEY);

      expect(mockEncryptApiKey).toHaveBeenCalledWith(TEST_API_KEY);
      expect(statement.bind).toHaveBeenCalledWith(TEST_USER_ID, TEST_PROVIDER, TEST_ENCRYPTED);
      expect(runMock).toHaveBeenCalled();
    });

    it('should throw when userId is empty', async () => {
      await expect(setUserApiKey('', TEST_PROVIDER, TEST_API_KEY))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when provider is empty', async () => {
      await expect(setUserApiKey(TEST_USER_ID, '', TEST_API_KEY))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when plainKey is empty', async () => {
      await expect(setUserApiKey(TEST_USER_ID, TEST_PROVIDER, ''))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when DB is not available', async () => {
      delete (globalThis as any).DB;
      await expect(setUserApiKey(TEST_USER_ID, TEST_PROVIDER, TEST_API_KEY))
        .rejects.toThrow('Database not available in global scope');
    });

    it('should wrap encryption errors in ByokStoreError', async () => {
      mockEncryptApiKey.mockRejectedValue(new Error('Encryption failed'));

      await expect(setUserApiKey(TEST_USER_ID, TEST_PROVIDER, TEST_API_KEY))
        .rejects.toThrow(ByokStoreError);
    });
  });

  describe('getUserApiKey', () => {
    it('should return decrypted key when found', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT encrypted_key FROM user_api_keys WHERE user_id = ? AND provider = ?`;
      const statement = db.prepare(sql);
      statement.first = jest.fn().mockResolvedValue({ encrypted_key: TEST_ENCRYPTED });

      const result = await getUserApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(statement.bind).toHaveBeenCalledWith(TEST_USER_ID, TEST_PROVIDER);
      expect(mockDecryptApiKey).toHaveBeenCalledWith(TEST_ENCRYPTED);
      expect(result).toBe(TEST_API_KEY);
    });

    it('should return null when key not found', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT encrypted_key FROM user_api_keys WHERE user_id = ? AND provider = ?`;
      const statement = db.prepare(sql);
      statement.first = jest.fn().mockResolvedValue(undefined);

      const result = await getUserApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(result).toBeNull();
      expect(mockDecryptApiKey).not.toHaveBeenCalled();
    });

    it('should throw when userId is empty', async () => {
      await expect(getUserApiKey('', TEST_PROVIDER))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when provider is empty', async () => {
      await expect(getUserApiKey(TEST_USER_ID, ''))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when DB is not available', async () => {
      delete (globalThis as any).DB;
      await expect(getUserApiKey(TEST_USER_ID, TEST_PROVIDER))
        .rejects.toThrow('Database not available in global scope');
    });

    it('should wrap retrieval errors in ByokStoreError', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT encrypted_key FROM user_api_keys WHERE user_id = ? AND provider = ?`;
      const statement = db.prepare(sql);
      statement.first = jest.fn().mockRejectedValue(new Error('DB error'));

      await expect(getUserApiKey(TEST_USER_ID, TEST_PROVIDER))
        .rejects.toThrow(ByokStoreError);
    });
  });

  describe('deleteUserApiKey', () => {
    it('should execute DELETE query correctly', async () => {
      const db = (globalThis as any).DB;
      const sql = `DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?`;
      const statement = db.prepare(sql);
      const runMock = jest.fn().mockResolvedValue({ changes: 1 });
      statement.run = runMock;

      await deleteUserApiKey(TEST_USER_ID, TEST_PROVIDER);

      expect(statement.bind).toHaveBeenCalledWith(TEST_USER_ID, TEST_PROVIDER);
      expect(runMock).toHaveBeenCalled();
    });

    it('should throw when userId is empty', async () => {
      await expect(deleteUserApiKey('', TEST_PROVIDER))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when provider is empty', async () => {
      await expect(deleteUserApiKey(TEST_USER_ID, ''))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when DB is not available', async () => {
      delete (globalThis as any).DB;
      await expect(deleteUserApiKey(TEST_USER_ID, TEST_PROVIDER))
        .rejects.toThrow('Database not available in global scope');
    });
  });

  describe('listUserApiKeys', () => {
    const mockMetadata: ApiKeyMetadata[] = [
      { provider: 'binance', created_at: '2025-01-01T00:00:00Z', updated_at: '2025-01-01T00:00:00Z' },
      { provider: 'bybit', created_at: '2025-01-02T00:00:00Z', updated_at: '2025-01-02T00:00:00Z' },
    ];

    it('should return array of metadata sorted by provider', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT provider, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY provider`;
      const statement = db.prepare(sql);
      statement.all = jest.fn().mockResolvedValue({ results: mockMetadata });

      const result = await listUserApiKeys(TEST_USER_ID);

      expect(statement.bind).toHaveBeenCalledWith(TEST_USER_ID);
      expect(result).toEqual(mockMetadata);
    });

    it('should return empty array when user has no keys', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT provider, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY provider`;
      const statement = db.prepare(sql);
      statement.all = jest.fn().mockResolvedValue({ results: [] });

      const result = await listUserApiKeys(TEST_USER_ID);

      expect(result).toEqual([]);
    });

    it('should throw when userId is empty', async () => {
      await expect(listUserApiKeys(''))
        .rejects.toThrow(ByokStoreError);
    });

    it('should throw when DB is not available', async () => {
      delete (globalThis as any).DB;
      await expect(listUserApiKeys(TEST_USER_ID))
        .rejects.toThrow('Database not available in global scope');
    });
  });

  describe('hasUserApiKey', () => {
    it('should return true when user has the provider key', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT provider, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY provider`;
      const statement = db.prepare(sql);
      statement.all = jest.fn().mockResolvedValue({
        results: [
          { provider: 'binance', created_at: '...', updated_at: '...' },
          { provider: 'bybit', created_at: '...', updated_at: '...' },
        ],
      });

      const result = await hasUserApiKey(TEST_USER_ID, 'binance');

      expect(result).toBe(true);
    });

    it('should return false when user does not have the provider key', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT provider, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY provider`;
      const statement = db.prepare(sql);
      statement.all = jest.fn().mockResolvedValue({
        results: [
          { provider: 'bybit', created_at: '...', updated_at: '...' },
        ],
      });

      const result = await hasUserApiKey(TEST_USER_ID, 'binance');

      expect(result).toBe(false);
    });

    it('should throw when listUserApiKeys throws', async () => {
      const db = (globalThis as any).DB;
      const sql = `SELECT provider, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY provider`;
      const statement = db.prepare(sql);
      statement.all = jest.fn().mockRejectedValue(new Error('DB error'));

      await expect(hasUserApiKey(TEST_USER_ID, 'binance'))
        .rejects.toThrow(ByokStoreError);
    });
  });

  describe('ByokStoreError', () => {
    it('should have correct name', () => {
      const error = new ByokStoreError('Test message');
      expect(error.name).toBe('ByokStoreError');
    });

    it('should include provider and userId when provided', () => {
      const error = new ByokStoreError('Test message', 'binance', 'user_123');
      expect(error.provider).toBe('binance');
      expect(error.userId).toBe('user_123');
    });

    it('should allow undefined provider and userId', () => {
      const error = new ByokStoreError('Test message');
      expect(error.provider).toBeUndefined();
      expect(error.userId).toBeUndefined();
    });
  });

  describe('ByokProvider type', () => {
    it('should accept valid providers', async () => {
      const providers: ByokProvider[] = ['binance', 'bybit', 'resend'];
      for (const provider of providers) {
        await expect(setUserApiKey(TEST_USER_ID, provider, 'key')).resolves.not.toThrow();
        await expect(getUserApiKey(TEST_USER_ID, provider)).resolves.not.toThrow();
        await expect(deleteUserApiKey(TEST_USER_ID, provider)).resolves.not.toThrow();
      }
    });
  });
});
