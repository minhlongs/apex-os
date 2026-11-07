/**
 * NOWPayments IPN signature primitives.
 *
 * These live outside the route module because Next.js route handlers may only export
 * HTTP method handlers plus its own metadata keys. Keeping them here lets the route
 * stay validator-clean while remaining importable by tests and other callers.
 */

import * as crypto from 'crypto';
import { z } from 'zod';

export type SubscriptionTier = 'BASIC' | 'PREMIUM' | 'ENTERPRISE' | 'MASTER';

export const IpnEventSchema = z.object({
  payment_id: z.union([z.number(), z.string()]).optional(),
  payment_status: z.string().optional(),
  order_id: z.string().optional(),
  pay_amount: z.union([z.number(), z.string()]).optional(),
  pay_currency: z.string().optional(),
  price_amount: z.union([z.number(), z.string()]).optional(),
  price_currency: z.string().optional(),
  plan: z.string().optional(),
  purchaser_identified: z.boolean().optional(),
  txn_id: z.string().optional(),
  parent_payment_id: z.union([z.number(), z.string()]).optional(),
  purchase_id: z.union([z.number(), z.string()]).optional(),
  payin_extra_id: z.string().optional(),
}).passthrough();

/**
 * Recursively sort JSON object keys alphabetically to produce canonical payload string.
 * Required by NOWPayments IPN HMAC-SHA512 verification specification.
 */
export function sortObjectKeys(obj: unknown): unknown {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return obj;
  }
  const record = obj as Record<string, unknown>;
  return Object.keys(record)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = sortObjectKeys(record[key]);
      return acc;
    }, {});
}

/**
 * Normalizes any plan string or composite label (e.g. 'enterprise-plan', 'master', 'pro')
 * to standard SubscriptionTier enum ('BASIC' | 'PREMIUM' | 'ENTERPRISE' | 'MASTER').
 */
export function normalizeTier(plan?: string | null): SubscriptionTier {
  if (!plan) return 'BASIC';
  const p = plan.toUpperCase().trim();
  if (p.includes('MASTER')) return 'MASTER';
  if (p.includes('ENTERPRISE')) return 'ENTERPRISE';
  if (p.includes('PREMIUM') || p.includes('PRO')) return 'PREMIUM';
  if (p.includes('BASIC')) return 'BASIC';
  return 'BASIC';
}

/**
 * Verifies NOWPayments HMAC-SHA512 signature in constant time.
 */
export function verifyIpnSignature(
  rawBody: string,
  sigHeader: string | null | undefined,
  secret: string
): { valid: boolean; error?: string } {
  if (!sigHeader) {
    return { valid: false, error: 'Missing signature header' };
  }

  const cleanedSig = sigHeader.trim().toLowerCase();
  if (!cleanedSig) {
    return { valid: false, error: 'Empty signature header' };
  }

  // SHA-512 hex digest must be exactly 128 hexadecimal characters (64 bytes)
  if (!/^[0-9a-f]{128}$/.test(cleanedSig)) {
    return { valid: false, error: 'Invalid signature format' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody);
  } catch {
    return { valid: false, error: 'Malformed JSON body' };
  }

  const canonicalSorted = sortObjectKeys(parsed);
  const canonicalString = JSON.stringify(canonicalSorted);

  const expectedHex = crypto
    .createHmac('sha512', secret)
    .update(canonicalString)
    .digest('hex')
    .toLowerCase();

  const bufIncoming = Buffer.from(cleanedSig);
  const bufExpected = Buffer.from(expectedHex);

  if (bufIncoming.length !== bufExpected.length) {
    return { valid: false, error: 'Signature length mismatch' };
  }

  const matches = crypto.timingSafeEqual(bufIncoming, bufExpected);
  if (!matches) {
    return { valid: false, error: 'Signature mismatch' };
  }

  return { valid: true };
}
