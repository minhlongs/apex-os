/**
 * src/lib/payouts/crypto/rlp.ts
 *
 * Lightweight Recursive Length Prefix (RLP) encoder for Ethereum transactions.
 * Zero external dependencies.
 */

export type RlpInput = Uint8Array | string | number | bigint | RlpInput[];

export function encodeRlp(input: RlpInput): Uint8Array {
  if (Array.isArray(input)) {
    const encodedItems = input.map(encodeRlp);
    const totalPayloadLength = encodedItems.reduce((acc, curr) => acc + curr.length, 0);
    const payload = new Uint8Array(totalPayloadLength);
    let offset = 0;
    for (const item of encodedItems) {
      payload.set(item, offset);
      offset += item.length;
    }

    if (totalPayloadLength <= 55) {
      const result = new Uint8Array(1 + totalPayloadLength);
      result[0] = 0xc0 + totalPayloadLength;
      result.set(payload, 1);
      return result;
    } else {
      const lenBytes = encodeLength(totalPayloadLength);
      const result = new Uint8Array(1 + lenBytes.length + totalPayloadLength);
      result[0] = 0xf7 + lenBytes.length;
      result.set(lenBytes, 1);
      result.set(payload, 1 + lenBytes.length);
      return result;
    }
  }

  // Handle single item
  const bytes = toUint8Array(input);
  if (bytes.length === 1 && bytes[0] < 0x80) {
    return bytes;
  }

  if (bytes.length <= 55) {
    const result = new Uint8Array(1 + bytes.length);
    result[0] = 0x80 + bytes.length;
    result.set(bytes, 1);
    return result;
  } else {
    const lenBytes = encodeLength(bytes.length);
    const result = new Uint8Array(1 + lenBytes.length + bytes.length);
    result[0] = 0xb7 + lenBytes.length;
    result.set(lenBytes, 1);
    result.set(bytes, 1 + lenBytes.length);
    return result;
  }
}

function encodeLength(len: number): Uint8Array {
  const hex = len.toString(16);
  const padded = hex.length % 2 === 0 ? hex : '0' + hex;
  const bytes = new Uint8Array(padded.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function toUint8Array(input: Uint8Array | string | number | bigint): Uint8Array {
  if (input instanceof Uint8Array) {
    return input;
  }
  if (typeof input === 'string') {
    if (input.startsWith('0x')) {
      const clean = input.slice(2);
      if (clean.length === 0) return new Uint8Array(0);
      const padded = clean.length % 2 === 0 ? clean : '0' + clean;
      const bytes = new Uint8Array(padded.length / 2);
      for (let i = 0; i < bytes.length; i++) {
        bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
      }
      return bytes;
    }
    return new TextEncoder().encode(input);
  }
  if (typeof input === 'number' || typeof input === 'bigint') {
    if (input === 0 || input === BigInt(0)) {
      return new Uint8Array(0);
    }
    const hex = input.toString(16);
    const padded = hex.length % 2 === 0 ? hex : '0' + hex;
    const bytes = new Uint8Array(padded.length / 2);
    for (let i = 0; i < bytes.length; i++) {
      bytes[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }
  return new Uint8Array(0);
}
