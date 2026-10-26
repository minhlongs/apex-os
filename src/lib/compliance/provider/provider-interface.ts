/**
 * src/lib/compliance/provider/provider-interface.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Provider Adapter Contracts & Standardized Webhook Types
 */

export interface KycSessionResult {
  sessionToken: string;
  redirectUrl: string;
  provider: 'sumsub' | 'persona' | 'mock';
}

export interface StandardizedKycWebhookEvent {
  userId: string;
  status: 'approved' | 'rejected' | 'requires_action';
  tier: 'tier1_basic' | 'tier2_enhanced';
  provider: string;
  verifiedAt: string;
  rawPayload: Record<string, unknown>;
}

export interface KycProviderAdapter {
  readonly providerName: string;
  createSession(userId: string, email?: string): Promise<KycSessionResult>;
  verifySignature(payload: string, headers: Headers, secret: string): Promise<boolean>;
  parseWebhook(payload: string, headers: Headers): Promise<StandardizedKycWebhookEvent>;
}

/**
 * Safely resolves SubtleCrypto in Edge Runtime or Node.js / Jest
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
 * Computes an HMAC-SHA256 hex string using Web Crypto API
 */
export async function computeHmacSha256Hex(data: string, secret: string): Promise<string> {
  const subtle = getSubtleCrypto();
  const encoder = new TextEncoder();
  const key = await subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await subtle.sign('HMAC', key, encoder.encode(data));
  const hashArray = Array.from(new Uint8Array(signature));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison to prevent timing attacks
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}
