/**
 * API Key Resolution Module
 * Resolve API key từ user key hoặc fallback to global secret
 */

import type { ByokProvider } from './user-api-key-store';
import type { ResolveApiKeyOptions } from './types';
import { getUserApiKey } from './user-api-key-store';

export type { ResolveApiKeyOptions as ResolveOptions };
export type { ResolveApiKeyOptions };

function isByokEnabled(): boolean {
  return process.env.BYOK_ENABLED === 'true';
}

/**
 * Lấy global secret từ environment variables
 * @param provider - Provider cần lấy secret
 * @returns Global secret string
 */
function getGlobalSecret(provider: ByokProvider): string {
  switch (provider) {
    case 'binance':
      if (!process.env.BINANCE_WEBHOOK_SECRET) {
        throw new Error('BINANCE_WEBHOOK_SECRET không được thiết lập trong environment');
      }
      return process.env.BINANCE_WEBHOOK_SECRET;
    case 'bybit':
      if (!process.env.BYBIT_WEBHOOK_SECRET) {
        throw new Error('BYBIT_WEBHOOK_SECRET không được thiết lập trong environment');
      }
      return process.env.BYBIT_WEBHOOK_SECRET;
    case 'resend':
      if (!process.env.RESEND_API_KEY) {
        throw new Error('RESEND_API_KEY không được thiết lập trong environment');
      }
      return process.env.RESEND_API_KEY;
    default:
      throw new Error(`Provider không được hỗ trợ: ${provider}`);
  }
}

/**
 * Kiểm tra userId có hợp lệ không
 * Valid: non-empty string
 * Invalid: null, undefined, empty string ''
 */
function isValidUserId(userId: string | null | undefined): boolean {
  return typeof userId === 'string' && userId.length > 0;
}

/**
 * Kiểm tra userId có thể fallback được không
 * - null: có thể fallback (userId không được cung cấp)
 * - undefined: không thể fallback (lỗi nghiêm trọng)
 * - empty string: không thể fallback (invalid format)
 */
function canFallbackOnInvalidUserId(userId: string | null | undefined): boolean {
  return userId === null;
}

/**
 * Resolve API key cho một user và provider
 *
 * Logic ưu tiên:
 * 1. Nếu BYOK disabled → luôn dùng global secret (ignore fallbackToGlobal)
 * 2. Nếu userId không hợp lệ (null/undefined/empty string):
 *    - fallbackToGlobal=true → global secret
 *    - fallbackToGlobal=false → throw error
 * 3. Có userId hợp lệ: gọi getUserApiKey
 *    - Nếu userKey tồn tại (kể cả empty string '') → return userKey
 *    - Nếu userKey null:
 *      * fallbackToGlobal=true → global secret
 *      * requireUserKey=true → throw error
 *      * fallbackToGlobal=false, requireUserKey=false → throw unreachable error
 *
 * @param userId - ID của user (có thể null/undefined/empty)
 * @param provider - Provider cần lấy key
 * @param options - Resolve options
 * @returns Promise<string> - API key đã resolve
 */
export async function resolveApiKey(
  userId: string | null | undefined,
  provider: ByokProvider,
  options: ResolveApiKeyOptions = {}
): Promise<string> {
  const { fallbackToGlobal = true, requireUserKey = false } = options;

  // Case 1: BYOK disabled → luôn dùng global (ignore all options)
  if (!isByokEnabled()) {
    return getGlobalSecret(provider);
  }

  // Case 2: Kiểm tra userId hợp lệ
  if (!isValidUserId(userId)) {
    if (fallbackToGlobal && canFallbackOnInvalidUserId(userId)) {
      return getGlobalSecret(provider);
    }
    throw new Error('BYOK bị disable hoặc userId không được cung cấp');
  }

  // Case 3: Có userId hợp lệ, thử lấy user key
  const userKey = await getUserApiKey(userId, provider);
  if (userKey !== null) {
    // userKey có thể là empty string '', đó là valid key
    return userKey;
  }

  // Case 4: Không có user key (userKey === null)
  if (fallbackToGlobal) {
    return getGlobalSecret(provider);
  }

  if (requireUserKey) {
    throw new Error(`Không tìm thấy API key cho provider ${provider} của user ${userId}`);
  }

  // Unreachable nếu requireUserKey=false và fallbackToGlobal=false
  throw new Error('Không thể resolve API key: không có user key và không cho phép fallback');
}
