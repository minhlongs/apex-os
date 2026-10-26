/**
 * src/lib/payouts/crypto/ed25519-signer.ts
 *
 * Edge-compatible Ed25519 signer and Solana transaction serializer.
 * Uses Web Crypto API (SubtleCrypto) supported natively in Cloudflare Workers and Node.js 26.
 * Zero heavy external dependencies.
 */

import { decodeBase58, encodeBase58 } from './base58';

/**
 * 32-byte PKCS#8 prefix for Ed25519 private keys per RFC 8410.
 * Allows importing raw 32-byte seeds directly into Web Crypto SubtleCrypto.
 */
const ED25519_PKCS8_HEADER = new Uint8Array([
  0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
]);

export interface Ed25519KeyPair {
  publicKeyBytes: Uint8Array;
  publicKeyBase58: string;
  sign: (message: Uint8Array) => Promise<Uint8Array>;
}

/**
 * Creates an Ed25519 signer from a 32-byte seed or 64-byte secret key (base58 or Uint8Array)
 */
export async function createEd25519Signer(
  secretKeyOrSeed: string | Uint8Array
): Promise<Ed25519KeyPair> {
  let rawBytes: Uint8Array;
  if (typeof secretKeyOrSeed === 'string') {
    rawBytes = decodeBase58(secretKeyOrSeed.trim());
  } else {
    rawBytes = secretKeyOrSeed;
  }

  // Solana keypairs in Base58 are commonly 64 bytes (32-byte seed + 32-byte public key)
  // or 32 bytes (raw seed). Take the first 32 bytes as the private seed.
  if (rawBytes.length !== 32 && rawBytes.length !== 64) {
    throw new Error(
      `Invalid Ed25519 secret key length: expected 32 or 64 bytes, received ${rawBytes.length} bytes`
    );
  }

  const seed = rawBytes.slice(0, 32);

  // Wrap seed in PKCS#8 container for SubtleCrypto importKey
  const pkcs8 = new Uint8Array(48);
  pkcs8.set(ED25519_PKCS8_HEADER, 0);
  pkcs8.set(seed, 16);

  const cryptoKey = await crypto.subtle.importKey(
    'pkcs8',
    pkcs8,
    { name: 'Ed25519' },
    true,
    ['sign']
  );

  const jwk = await crypto.subtle.exportKey('jwk', cryptoKey);
  if (!jwk.x) {
    throw new Error('Failed to derive Ed25519 public key');
  }

  // Base64url to Uint8Array
  const pubB64 = jwk.x.replace(/-/g, '+').replace(/_/g, '/');
  const pad = pubB64.length % 4;
  const paddedPubB64 = pad ? pubB64 + '='.repeat(4 - pad) : pubB64;
  const binStr = atob(paddedPubB64);
  const publicKeyBytes = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) {
    publicKeyBytes[i] = binStr.charCodeAt(i);
  }

  const publicKeyBase58 = encodeBase58(publicKeyBytes);

  return {
    publicKeyBytes,
    publicKeyBase58,
    sign: async (message: Uint8Array): Promise<Uint8Array> => {
      const msgCopy = new Uint8Array(message.length);
      msgCopy.set(message);
      const sigBuffer = await crypto.subtle.sign('Ed25519', cryptoKey, msgCopy);
      return new Uint8Array(sigBuffer);
    },
  };
}

/**
 * Compact-u16 encoder for Solana wire transactions
 */
export function encodeCompactU16(value: number): Uint8Array {
  const bytes: number[] = [];
  let rem = value;
  while (rem >= 0x80) {
    bytes.push((rem & 0x7f) | 0x80);
    rem >>= 7;
  }
  bytes.push(rem);
  return new Uint8Array(bytes);
}

export interface SolanaInstruction {
  programIdIndex: number;
  accountIndices: number[];
  data: Uint8Array;
}

export interface SolanaMessageParams {
  numRequiredSignatures: number;
  numReadonlySignedAccounts: number;
  numReadonlyUnsignedAccounts: number;
  accountKeys: Uint8Array[]; // 32-byte public keys
  recentBlockhash: Uint8Array; // 32-byte blockhash
  instructions: SolanaInstruction[];
}

/**
 * Serializes a legacy Solana Message into raw bytes to be signed
 */
export function serializeSolanaMessage(params: SolanaMessageParams): Uint8Array {
  const parts: Uint8Array[] = [];

  // 1. Header (3 bytes)
  parts.push(
    new Uint8Array([
      params.numRequiredSignatures,
      params.numReadonlySignedAccounts,
      params.numReadonlyUnsignedAccounts,
    ])
  );

  // 2. Account Keys
  parts.push(encodeCompactU16(params.accountKeys.length));
  for (const key of params.accountKeys) {
    if (key.length !== 32) {
      throw new Error(`Account key must be 32 bytes, got ${key.length}`);
    }
    parts.push(key);
  }

  // 3. Recent Blockhash (32 bytes)
  if (params.recentBlockhash.length !== 32) {
    throw new Error(`Recent blockhash must be 32 bytes, got ${params.recentBlockhash.length}`);
  }
  parts.push(params.recentBlockhash);

  // 4. Instructions
  parts.push(encodeCompactU16(params.instructions.length));
  for (const ix of params.instructions) {
    parts.push(new Uint8Array([ix.programIdIndex]));
    parts.push(encodeCompactU16(ix.accountIndices.length));
    parts.push(new Uint8Array(ix.accountIndices));
    parts.push(encodeCompactU16(ix.data.length));
    parts.push(ix.data);
  }

  // Concatenate parts
  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }

  return result;
}

/**
 * Serializes signed Solana transaction wire format [signatures, message]
 */
export function serializeSolanaTransaction(
  signatures: Uint8Array[],
  serializedMessage: Uint8Array
): Uint8Array {
  const parts: Uint8Array[] = [];
  parts.push(encodeCompactU16(signatures.length));
  for (const sig of signatures) {
    if (sig.length !== 64) {
      throw new Error(`Ed25519 signature must be 64 bytes, got ${sig.length}`);
    }
    parts.push(sig);
  }
  parts.push(serializedMessage);

  const totalLength = parts.reduce((acc, p) => acc + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const p of parts) {
    result.set(p, offset);
    offset += p.length;
  }

  return result;
}
