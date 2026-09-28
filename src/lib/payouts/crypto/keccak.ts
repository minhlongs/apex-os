/**
 * src/lib/payouts/crypto/keccak.ts
 *
 * Pure TypeScript Keccak-256 implementation using 64-bit word sponge construction
 * (Keccak-f[1600], rate 1088, capacity 512, delimiter 0x01).
 * Zero external dependencies, fully compatible with Edge Runtime (Cloudflare Workers/Pages).
 * Compatible with ES2017 target (using BigInt() constructors instead of BigInt literal suffix).
 */

const U64_MAX = BigInt('0xffffffffffffffff');
const ZERO_BIGINT = BigInt(0);
const SIXTY_FOUR_BIGINT = BigInt(64);
const MASK_FF = BigInt(0xff);

const RC: bigint[] = [
  BigInt('0x0000000000000001'),
  BigInt('0x0000000000008082'),
  BigInt('0x800000000000808a'),
  BigInt('0x8000000080008000'),
  BigInt('0x000000000000808b'),
  BigInt('0x0000000080000001'),
  BigInt('0x8000000080008081'),
  BigInt('0x8000000000008009'),
  BigInt('0x000000000000008a'),
  BigInt('0x0000000000000088'),
  BigInt('0x0000000080008009'),
  BigInt('0x000000008000000a'),
  BigInt('0x000000008000808b'),
  BigInt('0x800000000000008b'),
  BigInt('0x8000000000008089'),
  BigInt('0x8000000000008003'),
  BigInt('0x8000000000008002'),
  BigInt('0x8000000000000080'),
  BigInt('0x000000000000800a'),
  BigInt('0x800000008000000a'),
  BigInt('0x8000000080008081'),
  BigInt('0x8000000000008080'),
  BigInt('0x0000000080000001'),
  BigInt('0x8000000080008008'),
];

const ROT: number[][] = [
  [0, 36, 3, 41, 18],
  [1, 44, 10, 45, 2],
  [62, 6, 43, 15, 61],
  [28, 55, 25, 21, 56],
  [27, 20, 39, 8, 14],
];

function rotl(x: bigint, n: number): bigint {
  const s = BigInt(n % 64);
  if (s === ZERO_BIGINT) return x;
  return ((x << s) | (x >> (SIXTY_FOUR_BIGINT - s))) & U64_MAX;
}

/**
 * Pure TypeScript Keccak-256 hash function
 * @param data - Input string (UTF-8) or Uint8Array
 * @returns Hex string prefixed with 0x (66 characters total)
 */
export function keccak256(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const rate = 136; // 1088 bits / 8
  const state = new BigUint64Array(25);
  const nBlocks = Math.floor(bytes.length / rate) + 1;
  const padded = new Uint8Array(nBlocks * rate);
  padded.set(bytes);
  padded[bytes.length] = 0x01; // Keccak-256 padding delimiter
  padded[padded.length - 1] |= 0x80;

  const view = new DataView(padded.buffer, padded.byteOffset, padded.byteLength);

  for (let b = 0; b < nBlocks; b++) {
    const offset = b * rate;
    for (let i = 0; i < rate / 8; i++) {
      state[i] ^= view.getBigUint64(offset + i * 8, true);
    }

    for (let round = 0; round < 24; round++) {
      // Theta
      const C = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) {
        C[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
      }
      const D = new BigUint64Array(5);
      for (let x = 0; x < 5; x++) {
        D[x] = C[(x + 4) % 5] ^ rotl(C[(x + 1) % 5], 1);
      }
      for (let i = 0; i < 25; i++) {
        state[i] ^= D[i % 5];
      }

      // Rho and Pi
      const B = new BigUint64Array(25);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          B[y + ((2 * x + 3 * y) % 5) * 5] = rotl(state[x + y * 5], ROT[x][y]);
        }
      }

      // Chi
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          state[x + y * 5] =
            B[x + y * 5] ^ ((~B[((x + 1) % 5) + y * 5]) & B[((x + 2) % 5) + y * 5]);
        }
      }

      // Iota
      state[0] ^= RC[round];
    }
  }

  // Squeeze 256 bits (32 bytes)
  let hex = '';
  for (let i = 0; i < 4; i++) {
    const word = state[i];
    for (let j = 0; j < 8; j++) {
      const byte = Number((word >> BigInt(j * 8)) & MASK_FF);
      hex += byte.toString(16).padStart(2, '0');
    }
  }

  return '0x' + hex;
}

/**
 * Converts an Ethereum address to EIP-55 checksum format
 * @param address - 40-hex-character Ethereum address (with or without 0x)
 * @returns Checksummed 0x-prefixed address
 */
export function toChecksumAddress(address: string): string {
  if (typeof address !== 'string' || !/^(0x)?[0-9a-fA-F]{40}$/.test(address)) {
    throw new Error(`Invalid Ethereum address format: ${address}`);
  }
  const clean = address.replace(/^0x/, '').toLowerCase();
  const hash = keccak256(clean).slice(2);
  let checksum = '0x';
  for (let i = 0; i < 40; i++) {
    if (parseInt(hash[i], 16) >= 8) {
      checksum += clean[i].toUpperCase();
    } else {
      checksum += clean[i];
    }
  }
  return checksum;
}

/**
 * Verifies whether an address matches exact EIP-55 checksum format
 * @param address - Address string to test
 * @returns boolean true if valid EIP-55 checksum address
 */
export function isValidChecksumAddress(address: string): boolean {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return false;
  }
  return address === toChecksumAddress(address);
}

/**
 * Validates an Ethereum address with optional strict EIP-55 checksum enforcement
 * @param address - Address string
 * @param strictChecksum - If true, requires exact EIP-55 checksum casing. If false, accepts all-lowercase, all-uppercase, or correctly checksummed mixed-case.
 * @returns boolean
 */
export function isValidEthereumAddress(address: string, strictChecksum = false): boolean {
  if (typeof address !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return false;
  }
  if (strictChecksum) {
    return isValidChecksumAddress(address);
  }
  const raw = address.slice(2);
  const isAllLower = raw === raw.toLowerCase();
  const isAllUpper = raw === raw.toUpperCase();
  if (isAllLower || isAllUpper) {
    return true;
  }
  // Mixed-case address must match checksum
  return address === toChecksumAddress(address);
}
