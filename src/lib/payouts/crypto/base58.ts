/**
 * src/lib/payouts/crypto/base58.ts
 *
 * Pure TypeScript Base58 encoder and decoder with Bitcoin/Solana alphabet.
 * Zero external dependencies, fully compatible with Edge Runtime (Cloudflare Workers/Pages).
 */

export const BASE58_ALPHABET =
  '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

const BASE58_MAP: Record<string, number> = {};
for (let i = 0; i < BASE58_ALPHABET.length; i++) {
  BASE58_MAP[BASE58_ALPHABET.charAt(i)] = i;
}

/**
 * Decode a Base58 string into Uint8Array
 * @param str - Base58-encoded string
 * @returns Decoded byte array
 * @throws Error if string contains characters not in the Base58 alphabet
 */
export function decodeBase58(str: string): Uint8Array {
  if (typeof str !== 'string' || str.length === 0) {
    return new Uint8Array(0);
  }

  // Count leading '1's (representing leading zero bytes)
  let zeroes = 0;
  while (zeroes < str.length && str[zeroes] === '1') {
    zeroes++;
  }

  // Allocate enough space in big-endian base-256 buffer
  // log(58) / log(256) ~= 0.733
  const size = Math.floor(((str.length - zeroes) * 733) / 1000) + 1;
  const b256 = new Uint8Array(size);
  let length = 0;

  for (let i = zeroes; i < str.length; i++) {
    const c = str[i];
    const val = BASE58_MAP[c];
    if (val === undefined) {
      throw new Error(`Invalid Base58 character: '${c}'`);
    }

    let carry = val;
    let j = 0;
    for (let it = size - 1; (carry !== 0 || j < length) && it >= 0; it--, j++) {
      carry += 58 * b256[it];
      b256[it] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    length = j;
  }

  // Skip leading zeroes in temporary buffer
  let it = size - length;
  while (it < size && b256[it] === 0) {
    it++;
  }

  // Assemble final buffer with leading zeroes
  const result = new Uint8Array(zeroes + (size - it));
  let rIdx = zeroes;
  while (it < size) {
    result[rIdx++] = b256[it++];
  }

  return result;
}

/**
 * Encode a Uint8Array into a Base58 string
 * @param buffer - Raw bytes to encode
 * @returns Base58 encoded string
 */
export function encodeBase58(buffer: Uint8Array): string {
  if (!buffer || buffer.length === 0) {
    return '';
  }

  // Count leading zeroes
  let zeroes = 0;
  while (zeroes < buffer.length && buffer[zeroes] === 0) {
    zeroes++;
  }

  // Allocate space in big-endian base-58 buffer
  // log(256) / log(58) ~= 1.366
  const size = Math.floor(((buffer.length - zeroes) * 1366) / 1000) + 1;
  const b58 = new Uint8Array(size);
  let length = 0;

  for (let i = zeroes; i < buffer.length; i++) {
    let carry = buffer[i];
    let j = 0;
    for (let it = size - 1; (carry !== 0 || j < length) && it >= 0; it--, j++) {
      carry += 256 * b58[it];
      b58[it] = carry % 58;
      carry = Math.floor(carry / 58);
    }
    length = j;
  }

  let it = size - length;
  while (it < size && b58[it] === 0) {
    it++;
  }

  let str = '';
  for (let i = 0; i < zeroes; i++) {
    str += '1';
  }
  for (; it < size; ++it) {
    str += BASE58_ALPHABET[b58[it]];
  }

  return str;
}

/**
 * Validates a Solana public key address
 * Checks Base58 validity and confirms it decodes to exactly 32 bytes (Ed25519 public key)
 * @param address - Address string to validate
 * @returns boolean
 */
export function isValidSolanaAddress(address: string): boolean {
  if (typeof address !== 'string' || address.length < 32 || address.length > 44) {
    return false;
  }
  try {
    const bytes = decodeBase58(address);
    return bytes.length === 32;
  } catch {
    return false;
  }
}
