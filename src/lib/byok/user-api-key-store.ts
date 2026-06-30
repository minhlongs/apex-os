/**
 * User API Key Store - BYOK (Bring Your Own Key)
 *
 * Lưu trữ API keys của user từ các provider (Binance, Bybit, Resend)
 * với mã hóa AES-GCM.
 *
 * Schema (user_api_keys table):
 *   user_id       TEXT NOT NULL
 *   provider      TEXT NOT NULL
 *   encrypted_key BLOB NOT NULL (base64 string)
 *   created_at    TEXT (datetime)
 *   updated_at    TEXT (datetime)
 *   PRIMARY KEY (user_id, provider)
 */

import type { DB } from '@/lib/db/client';
import { encryptApiKey, decryptApiKey } from './crypto';

/**
 * Provider types được hỗ trợ
 */
export type ByokProvider = 'binance' | 'bybit' | 'resend';

/**
 * API Key record metadata
 */
export interface ApiKeyMetadata {
  provider: ByokProvider;
  created_at: string;
  updated_at: string;
}

/**
 * Store errors
 */
export class ByokStoreError extends Error {
  constructor(message: string, public readonly provider?: ByokProvider, public readonly userId?: string) {
    super(message);
    this.name = 'ByokStoreError';
  }
}

/**
 * Internal helper: lấy DB instance từ global scope
 */
function getDb(): DB {
  const globalDb = (globalThis as unknown as { DB: DB }).DB;
  if (!globalDb) {
    throw new ByokStoreError('Database not available in global scope');
  }
  return globalDb;
}

/**
 * Lưu (hoặc cập nhật) API key của user
 */
export async function setUserApiKey(
  userId: string,
  provider: ByokProvider,
  plainKey: string
): Promise<void> {
  if (!userId) throw new ByokStoreError('User ID is required', provider);
  if (!provider) throw new ByokStoreError('Provider is required', undefined, userId);
  if (!plainKey) throw new ByokStoreError('API key cannot be empty', provider, userId);

  try {
    const encrypted = await encryptApiKey(plainKey);
    const sql = `INSERT OR REPLACE INTO user_api_keys (user_id, provider, encrypted_key, updated_at) VALUES (?, ?, ?, datetime('now'))`;
    getDb().prepare(sql).bind(userId, provider, encrypted).run();
    console.log('[BYOK] API key stored', { userId, provider });
  } catch (error) {
    console.error('[BYOK] setUserApiKey error:', error, { userId, provider });
    throw new ByokStoreError(`Failed to store API key: ${error instanceof Error ? error.message : 'unknown error'}`, provider, userId);
  }
}

/**
 * Lấy API key của user
 */
export async function getUserApiKey(
  userId: string,
  provider: ByokProvider
): Promise<string | null> {
  if (!userId) throw new ByokStoreError('User ID is required', provider);
  if (!provider) throw new ByokStoreError('Provider is required', undefined, userId);

  try {
    const sql = `SELECT encrypted_key FROM user_api_keys WHERE user_id = ? AND provider = ?`;
    const row = await getDb().prepare(sql).bind(userId, provider).first<{ encrypted_key: string }>();
    if (!row) return null;
    return await decryptApiKey(row.encrypted_key);
  } catch (error) {
    console.error('[BYOK] getUserApiKey error:', error, { userId, provider });
    throw new ByokStoreError(`Failed to retrieve API key: ${error instanceof Error ? error.message : 'unknown error'}`, provider, userId);
  }
}

/**
 * Xóa API key của user
 */
export async function deleteUserApiKey(
  userId: string,
  provider: ByokProvider
): Promise<void> {
  if (!userId) throw new ByokStoreError('User ID is required', provider);
  if (!provider) throw new ByokStoreError('Provider is required', undefined, userId);

  try {
    const sql = `DELETE FROM user_api_keys WHERE user_id = ? AND provider = ?`;
    getDb().prepare(sql).bind(userId, provider).run();
    console.log('[BYOK] API key deleted', { userId, provider });
  } catch (error) {
    console.error('[BYOK] deleteUserApiKey error:', error, { userId, provider });
    throw new ByokStoreError(`Failed to delete API key: ${error instanceof Error ? error.message : 'unknown error'}`, provider, userId);
  }
}

/**
 * Liệt kê API keys metadata của user
 */
export async function listUserApiKeys(
  userId: string
): Promise<Array<ApiKeyMetadata>> {
  if (!userId) throw new ByokStoreError('User ID is required');

  try {
    const sql = `SELECT provider, created_at, updated_at FROM user_api_keys WHERE user_id = ? ORDER BY provider`;
    const result = await getDb().prepare(sql).bind(userId).all<ApiKeyMetadata>();
    return result.results;
  } catch (error) {
    console.error('[BYOK] listUserApiKeys error:', error, { userId });
    throw new ByokStoreError(`Failed to list API keys: ${error instanceof Error ? error.message : 'unknown error'}`, undefined, userId);
  }
}

/**
 * Kiểm tra user đã có API key cho provider chưa
 */
export async function hasUserApiKey(
  userId: string,
  provider: ByokProvider
): Promise<boolean> {
  try {
    const keys = await listUserApiKeys(userId);
    return keys.some((k) => k.provider === provider);
  } catch (error) {
    if (error instanceof ByokStoreError) throw error;
    console.error('[BYOK] hasUserApiKey error:', error, { userId, provider });
    throw new ByokStoreError(`Failed to check API key: ${error instanceof Error ? error.message : 'unknown error'}`, provider, userId);
  }
}
