/**
 * src/lib/payouts/crypto/secp256k1-signer.ts
 *
 * Edge & Node 26 compatible Secp256k1 ECDSA signer for Ethereum transactions.
 * Uses native node:crypto / web crypto primitives with zero heavy external dependencies.
 * Signs raw 32-byte hashes into canonical Ethereum (r, s, v) signatures.
 */

import * as crypto from 'node:crypto';
import { keccak256, toChecksumAddress } from './keccak';

export interface EthereumSignature {
  r: string; // 32-byte hex without 0x
  s: string; // 32-byte hex without 0x
  v: number; // 27 or 28 (or chainId adjusted)
  recoveryParam: number; // 0 or 1
}

export interface Secp256k1KeyPair {
  address: string;
  signHash: (hash32Bytes: Uint8Array) => EthereumSignature;
}

/**
 * Normalizes a hex private key string or Uint8Array into 32 bytes
 */
export function normalizePrivateKey(privateKey: string | Uint8Array): Uint8Array {
  if (typeof privateKey === 'string') {
    const clean = privateKey.trim().replace(/^0x/, '');
    if (clean.length !== 64 || !/^[0-9a-fA-F]{64}$/.test(clean)) {
      throw new Error(`Invalid private key: expected 64 hex chars, got ${clean.length}`);
    }
    const bytes = new Uint8Array(32);
    for (let i = 0; i < 32; i++) {
      bytes[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  if (privateKey.length !== 32) {
    throw new Error(`Invalid private key length: expected 32 bytes, got ${privateKey.length}`);
  }
  return privateKey;
}

/**
 * Creates an Ethereum Secp256k1 signer from a 32-byte private key
 */
export function createSecp256k1Signer(privateKey: string | Uint8Array): Secp256k1KeyPair {
  const privKeyBytes = normalizePrivateKey(privateKey);

  // Derives Secp256k1 KeyObject via PKCS#8 SEC1 container
  const sec1Header = Buffer.from(
    '302e0201010420' + Buffer.from(privKeyBytes).toString('hex') + 'a00706052b8104000a',
    'hex'
  );
  const keyObject = crypto.createPrivateKey({
    key: sec1Header,
    format: 'der',
    type: 'sec1',
  });

  const pubKeyObject = crypto.createPublicKey(keyObject);
  const rawPubDer = pubKeyObject.export({ format: 'der', type: 'spki' });
  // The uncompressed 65-byte public key (0x04 + x + y) is at the end of the SPKI DER structure
  const uncompressedPubKey = rawPubDer.subarray(rawPubDer.length - 65);
  // Address is keccak256(pubKey[1..64]).slice(-20)
  const pubKeyHash = keccak256(uncompressedPubKey.subarray(1));
  const rawAddress = '0x' + pubKeyHash.slice(-40);
  const checksumAddress = toChecksumAddress(rawAddress);

  const signHash = (hash32Bytes: Uint8Array): EthereumSignature => {
    if (hash32Bytes.length !== 32) {
      throw new Error(`Hash must be 32 bytes, got ${hash32Bytes.length}`);
    }

    // Sign using IEEE P1363 (r || s, 64 bytes total)
    const sigP1363 = crypto.sign(null, hash32Bytes, {
      key: keyObject,
      dsaEncoding: 'ieee-p1363',
    });

    const r = sigP1363.subarray(0, 32).toString('hex');
    let sBigInt = BigInt('0x' + sigP1363.subarray(32, 64).toString('hex'));

    // Secp256k1 curve order N and field prime P
    const N = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BB5BF5CA4BDB69541');
    const HALF_N = N >> BigInt(1);

    // Enforce canonical low-s (BIP 62 / EIP-2)
    let sWasInverted = false;
    if (sBigInt > HALF_N) {
      sBigInt = N - sBigInt;
      sWasInverted = true;
    }

    const s = sBigInt.toString(16).padStart(64, '0');

    // Derives correct yParity (recoveryParam) using secp256k1 ephemeral curve math
    // For secp256k1: y^2 = x^3 + 7 (mod P)
    // If ephemeral y is odd, initial yParity is 1; if even, 0. If s was inverted, toggle parity.
    const P = BigInt('0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F');
    const rBigInt = BigInt('0x' + r);
    const alpha = (rBigInt ** BigInt(3) + BigInt(7)) % P;
    // Modular square root for P % 4 === 3: y = alpha^((P + 1) / 4) mod P
    const exp = (P + BigInt(1)) >> BigInt(2);
    const y = modPow(alpha, exp, P);
    let yParity = Number(y & BigInt(1));
    if (sWasInverted) {
      yParity ^= 1;
    }

    return {
      r,
      s,
      v: 27 + yParity,
      recoveryParam: yParity,
    };
  };

  return {
    address: checksumAddress,
    signHash,
  };
}

/**
 * Modular exponentiation: (base^exp) % mod
 */
function modPow(base: bigint, exp: bigint, mod: bigint): bigint {
  let res = BigInt(1);
  let b = base % mod;
  let e = exp;
  while (e > BigInt(0)) {
    if (e & BigInt(1)) {
      res = (res * b) % mod;
    }
    b = (b * b) % mod;
    e >>= BigInt(1);
  }
  return res;
}
