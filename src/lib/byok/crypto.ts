/**
 * BYOK (Bring Your Own Key) Crypto Utilities
 * Sử dụng Web Crypto API với AES-GCM để mã hóa/giải mã API keys
 *
 * Format packed: [IV (12 bytes)][ciphertext + authTag] (stored as base64)
 */

export const ALGORITHM = 'AES-GCM';
export const IV_BYTES = 12;
export const KEY_LEN_BITS = 256;

/**
 * Import master key từ environment variable
 * Key phải là base64 string (32 bytes khi decode)
 */
let cachedMasterKey: CryptoKey | null = null;

async function getMasterKey(): Promise<CryptoKey> {
  if (cachedMasterKey) {
    return cachedMasterKey;
  }

  const base64Key = process.env.BYOK_ENCRYPTION_KEY;

  if (!base64Key) {
    throw new Error('[BYOK Crypto] BYOK_ENCRYPTION_KEY environment variable không được thiết lập');
  }

  try {
    // Decode base64 to ArrayBuffer (phải là 32 bytes cho AES-256)
    const keyBuffer = Buffer.from(base64Key, 'base64');
    if (keyBuffer.length < 32) {
      throw new Error('[BYOK Crypto] BYOK_ENCRYPTION_KEY phải là ít nhất 32 bytes khi decode');
    }

    // Import key cho AES-GCM
    // Sử dụng Uint8Array để tương thích với Node.js webcrypto
    const cryptoKey = await crypto.subtle.importKey(
      'raw',
      new Uint8Array(keyBuffer),
      {
        name: ALGORITHM,
        length: KEY_LEN_BITS,
      },
      false, // Không extractable
      ['encrypt', 'decrypt']
    );

    cachedMasterKey = cryptoKey;
    return cryptoKey;
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`[BYOK Crypto] Không thể import master key: ${error.message}`);
    }
    throw new Error('[BYOK Crypto] Không thể import master key: lỗi không xác định');
  }
}

/**
 * Mã hóa API key
 * @param plain - Plaintext API key cần mã hóa
 * @returns Base64 string chứa [IV (12 bytes)][ciphertext + authTag]
 */
export async function encryptApiKey(plain: string): Promise<string> {
  if (typeof plain !== 'string') {
    throw new Error('[BYOK Crypto] Plaintext phải là string');
  }

  if (plain.length === 0) {
    throw new Error('[BYOK Crypto] Plaintext không được để trống');
  }

  // Validate master key
  const key = await getMasterKey();

  try {
    // Tạo IV ngẫu nhiên 12 bytes
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));

    // Convert plaintext to buffer
    const plainBuffer = new TextEncoder().encode(plain);

    // Encrypt với AES-GCM
    const cipherBuffer = await crypto.subtle.encrypt(
      {
        name: ALGORITHM,
        iv: iv,
      },
      key,
      plainBuffer
    );

    // Pack: [IV (12 bytes)][ciphertext + authTag]
    const packed = new Uint8Array(IV_BYTES + cipherBuffer.byteLength);
    packed.set(iv, 0);
    packed.set(new Uint8Array(cipherBuffer), IV_BYTES);

    // Encode thành base64 string
    return Buffer.from(packed).toString('base64');
  } catch (error) {
    console.error('[BYOK Crypto] Encryption failed:', error);
    if (error instanceof Error) {
      throw new Error(`[BYOK Crypto] Mã hóa thất bại: ${error.message}`);
    }
    throw new Error('[BYOK Crypto] Mã hóa thất bại: lỗi không xác định');
  }
}

/**
 * Giải mã API key
 * @param encryptedBase64 - Base64 string chứa [IV (12 bytes)][ciphertext + authTag]
 * @returns Plaintext string
 */
export async function decryptApiKey(encryptedBase64: string): Promise<string> {
  if (typeof encryptedBase64 !== 'string') {
    throw new Error('[BYOK Crypto] Input phải là string');
  }

  if (encryptedBase64.length === 0) {
    throw new Error('[BYOK Crypto] Input không được để trống');
  }

  try {
    // Decode base64
    const packed = Buffer.from(encryptedBase64, 'base64');
    if (packed.length < IV_BYTES) {
      throw new Error(`[BYOK Crypto] Encrypted data quá ngắn: cần tối thiểu ${IV_BYTES} bytes, nhận được: ${packed.length} bytes`);
    }

    // Validate master key
    const key = await getMasterKey();

    // Extract IV (12 bytes đầu)
    const iv = packed.slice(0, IV_BYTES);

    // Extract ciphertext (phần còn lại, bao gồm authTag)
    const cipherBuffer = packed.slice(IV_BYTES);

    // Decrypt
    const plainBuffer = await crypto.subtle.decrypt(
      {
        name: ALGORITHM,
        iv: iv,
      },
      key,
      cipherBuffer
    );

    // Convert buffer to string
    const plaintext = new TextDecoder().decode(plainBuffer);

    return plaintext;
  } catch (error) {
    console.error('[BYOK Crypto] Decryption failed:', error);
    if (error instanceof Error) {
      throw new Error(`[BYOK Crypto] Giải mã thất bại: ${error.message}`);
    }
    throw new Error('[BYOK Crypto] Giải mã thất bại: lỗi không xác định');
  }
}

/**
 * Kiểm tra BYOK encryption key đã được config chưa
 * Dùng cho health check
 */
export function isByokConfigured(): boolean {
  return !!process.env.BYOK_ENCRYPTION_KEY;
}
