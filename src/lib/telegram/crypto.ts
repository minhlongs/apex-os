/**
 * src/lib/telegram/crypto.ts
 *
 * Edge-Compatible Telegram WebApp initData & Login Verification Service
 * Uses Web Crypto SubtleCrypto for HMAC-SHA256 cryptographic verification,
 * replay attack prevention (24h window), and Telegram payload extraction.
 */

import type {
  TelegramUserPayload,
  ParsedTelegramInitData,
  VerificationResult,
} from '@/types/telegram';

// Re-export types for caller convenience
export type { TelegramUserPayload, ParsedTelegramInitData, VerificationResult };

/**
 * Resolves SubtleCrypto across Cloudflare Workers Edge runtime, Node.js, and Jest.
 * Completely zero-dependency with no hard C++ native addon requirements.
 */
export function getSubtleCrypto(): SubtleCrypto {
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    return globalThis.crypto.subtle;
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const nodeCrypto = require('crypto');
    if (nodeCrypto.webcrypto?.subtle) {
      return nodeCrypto.webcrypto.subtle;
    }
  } catch {
    // Fall through to error
  }
  throw new Error('Web Crypto API (subtle) not available');
}

/**
 * Constant-time string equality comparison to prevent timing attacks.
 * Operates on character codes via bitwise XOR.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

/**
 * Builds the data-check-string from parsed parameters.
 * Alphabetically sorts keys (excluding 'hash'), formatted as "key=value\n...".
 */
export function buildDataCheckString(
  params: Map<string, string> | URLSearchParams | Record<string, string>
): string {
  const entries: [string, string][] = [];

  if (params instanceof Map || params instanceof URLSearchParams) {
    for (const [key, value] of params.entries()) {
      if (key !== 'hash') {
        entries.push([key, value]);
      }
    }
  } else {
    for (const key of Object.keys(params)) {
      if (key !== 'hash') {
        entries.push([key, params[key]]);
      }
    }
  }

  // Sort alphabetically by key name
  entries.sort((a, b) => a[0].localeCompare(b[0]));
  return entries.map(([key, value]) => `${key}=${value}`).join('\n');
}

/**
 * Computes Telegram WebApp HMAC-SHA256 signature using SubtleCrypto
 *
 * Specification:
 *   secret_key = HMAC_SHA256("WebAppData", botToken)
 *   hash = HMAC_SHA256(secret_key, dataCheckString)
 *
 * @param dataCheckString - Alphabetically sorted parameters formatted with newlines
 * @param botToken - Telegram Bot API Token
 * @returns 64-character lowercase hexadecimal hash string
 */
export async function computeTelegramHmac(
  dataCheckString: string,
  botToken: string
): Promise<string> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();

  // Stage 1: Compute secret_key = HMAC_SHA256("WebAppData", botToken)
  const webAppDataKey = await subtle.importKey(
    'raw',
    encoder.encode('WebAppData'),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const secretKeyBuffer = await subtle.sign(
    'HMAC',
    webAppDataKey,
    encoder.encode(botToken)
  );

  // Stage 2: Import secretKeyBuffer as key for dataCheckString HMAC
  const hmacKey = await subtle.importKey(
    'raw',
    secretKeyBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await subtle.sign(
    'HMAC',
    hmacKey,
    encoder.encode(dataCheckString)
  );

  // Convert binary buffer to lowercase hex string
  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Computes Telegram Login Widget HMAC-SHA256 signature (alternate format)
 *
 * Specification:
 *   secret_key = SHA256(botToken)
 *   hash = HMAC_SHA256(secret_key, dataCheckString)
 *
 * @param dataCheckString - Alphabetically sorted parameters formatted with newlines
 * @param botToken - Telegram Bot API Token
 * @returns 64-character lowercase hexadecimal hash string
 */
export async function computeTelegramWidgetHmac(
  dataCheckString: string,
  botToken: string
): Promise<string> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();

  // Compute secret_key = SHA256(botToken)
  const tokenHashBuffer = await subtle.digest(
    'SHA-256',
    encoder.encode(botToken)
  );

  const widgetKey = await subtle.importKey(
    'raw',
    tokenHashBuffer,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await subtle.sign(
    'HMAC',
    widgetKey,
    encoder.encode(dataCheckString)
  );

  const hashArray = Array.from(new Uint8Array(signatureBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Helper to generate and sign raw initData string for testing and mock sessions.
 *
 * @param params - Key-value map of parameters (e.g. user, auth_date, query_id)
 * @param botToken - Telegram bot token to sign with
 * @param useWidgetAlgorithm - Set true to use widget SHA256(token) algorithm
 * @returns Fully signed URL query string (including hash=...)
 */
export async function signTelegramInitData(
  params: Record<string, any>,
  botToken: string,
  useWidgetAlgorithm = false
): Promise<string> {
  const rawParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(params)) {
    if (key === 'hash') continue;
    if (typeof value === 'object' && value !== null) {
      rawParams[key] = JSON.stringify(value);
    } else {
      rawParams[key] = String(value);
    }
  }

  const dataCheckString = buildDataCheckString(rawParams);
  const hash = useWidgetAlgorithm
    ? await computeTelegramWidgetHmac(dataCheckString, botToken)
    : await computeTelegramHmac(dataCheckString, botToken);

  const searchParams = new URLSearchParams();
  for (const [key, value] of Object.entries(rawParams)) {
    searchParams.set(key, value);
  }
  searchParams.set('hash', hash);

  return searchParams.toString();
}

/**
 * Validates Telegram initData with 24-hour replay protection and cryptographic verification.
 *
 * @param initDataRaw - The raw URL-encoded string from Telegram.WebApp.initData
 * @param botToken - Telegram Bot API Token
 * @param maxAgeSeconds - Max allowed age in seconds (default 86,400 = 24h). Set to 0 to disable age check.
 */
export async function verifyTelegramInitData(
  initDataRaw: string,
  botToken: string,
  maxAgeSeconds = 86400
): Promise<VerificationResult> {
  if (!initDataRaw || typeof initDataRaw !== 'string' || initDataRaw.trim().length === 0) {
    return { isValid: false, error: 'Empty or missing initData' };
  }
  if (!botToken || typeof botToken !== 'string' || botToken.trim().length === 0) {
    return { isValid: false, error: 'Server configuration error: missing bot token' };
  }

  try {
    const searchParams = new URLSearchParams(initDataRaw);
    const receivedHash = searchParams.get('hash');

    if (!receivedHash || receivedHash.trim().length === 0) {
      return { isValid: false, error: 'Missing hash parameter in initData' };
    }

    // Extract parameters into Map and record
    const paramMap = new Map<string, string>();
    const rawParamsRecord: Record<string, string> = {};
    for (const [key, value] of searchParams.entries()) {
      paramMap.set(key, value);
      rawParamsRecord[key] = value;
    }

    // 1. Replay attack validation: check auth_date
    const authDateStr = searchParams.get('auth_date');
    if (!authDateStr || authDateStr.trim().length === 0) {
      return { isValid: false, error: 'Missing auth_date in initData' };
    }

    const authDate = parseInt(authDateStr, 10);
    if (isNaN(authDate)) {
      return { isValid: false, error: 'Invalid auth_date format' };
    }

    const nowSeconds = Math.floor(Date.now() / 1000);
    const ageSeconds = nowSeconds - authDate;

    // Check expiration (> 24h by default)
    if (maxAgeSeconds > 0 && ageSeconds > maxAgeSeconds) {
      return {
        isValid: false,
        error: `Authentication data expired (age: ${ageSeconds}s, limit: ${maxAgeSeconds}s)`,
      };
    }

    // Check future timestamp with 5-minute (300s) clock skew tolerance
    if (authDate > nowSeconds + 300) {
      return {
        isValid: false,
        error: 'Authentication date is in the future',
      };
    }

    // 2. Cryptographic verification
    const dataCheckString = buildDataCheckString(paramMap);
    const calculatedHmac = await computeTelegramHmac(dataCheckString, botToken);

    let isMatch = timingSafeEqual(calculatedHmac.toLowerCase(), receivedHash.toLowerCase());

    // Fallback: check Telegram Login Widget algorithm if TMA WebApp algorithm does not match
    if (!isMatch) {
      const widgetHmac = await computeTelegramWidgetHmac(dataCheckString, botToken);
      if (timingSafeEqual(widgetHmac.toLowerCase(), receivedHash.toLowerCase())) {
        isMatch = true;
      }
    }

    if (!isMatch) {
      return { isValid: false, error: 'Cryptographic signature mismatch' };
    }

    // 3. Parse and validate user payload
    const userJson = searchParams.get('user');
    if (!userJson || userJson.trim().length === 0) {
      return { isValid: false, error: 'Missing user object in initData' };
    }

    let user: TelegramUserPayload;
    try {
      user = JSON.parse(userJson);
      if (
        !user ||
        typeof user !== 'object' ||
        typeof user.id !== 'number' ||
        isNaN(user.id) ||
        !user.first_name ||
        typeof user.first_name !== 'string' ||
        user.first_name.trim().length === 0
      ) {
        return { isValid: false, error: 'Malformed user payload: missing id or first_name' };
      }
    } catch {
      return { isValid: false, error: 'Failed to parse user JSON from initData' };
    }

    return {
      isValid: true,
      data: {
        user,
        auth_date: authDate,
        hash: receivedHash,
        query_id: searchParams.get('query_id') || undefined,
        start_param: searchParams.get('start_param') || undefined,
        chat_type: searchParams.get('chat_type') || undefined,
        chat_instance: searchParams.get('chat_instance') || undefined,
        raw_params: rawParamsRecord,
      },
    };
  } catch (err) {
    return {
      isValid: false,
      error: err instanceof Error ? err.message : 'Unknown validation error',
    };
  }
}
