/**
 * POST /api/webhooks/ipn
 * NOWPayments Instant Payment Notification webhook.
 *
 * On confirmed payment → update profile.tier → notify mobile via Firebase (future).
 * Security: verify NOWPayments HMAC signature, idempotent on payment_id.
 *
 * Env: NOWPAYMENTS_IPN_SECRET (shared secret from NOWPayments dashboard)
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';

const IpnEventSchema = z.object({
  payment_id: z.union([z.number(), z.string()]),
  payment_status: z.enum(['waiting', 'confirming', 'confirmed', 'failed', 'expired']),
  order_id: z.string().optional(),
  pay_amount: z.union([z.number(), z.string()]).optional(),
  pay_currency: z.string().optional(),
  price_amount: z.union([z.number(), z.string()]).optional(),
  price_currency: z.string().optional(),
  plan: z.string().optional(),
  purchaser_identified: z.boolean().optional(),
});

function buildPaymentId(raw: unknown): string {
  return String(raw ?? '');
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();
  const signatureHeader = request.headers.get('x-nowpayments-signature');

  try {
    IpnEventSchema.parse(JSON.parse(rawBody));
  } catch {
    return NextResponse.json({ received: true, skipped: true, reason: 'invalid_payload' }, { status: 200 });
  }

  const ipnSecret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (ipnSecret) {
    const expected = (await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(ipnSecret),
      { name: 'HMAC', hash: 'SHA-512' },
      false,
      ['sign']
    ));
    const expectedSig = Buffer.from(
      await crypto.subtle.sign('HMAC', expected, new TextEncoder().encode(rawBody))
    ).toString('base64');

    if (signatureHeader !== expectedSig) {
      logWarn('[IPN] Signature verification failed');
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let event: z.infer<typeof IpnEventSchema>;
  try {
    event = JSON.parse(rawBody) as z.infer<typeof IpnEventSchema>;
  } catch {
    return NextResponse.json({ received: true, skipped: true, reason: 'invalid_json' }, { status: 200 });
  }

  const trimmed = IpnEventSchema.safeParse(event);
  if (!trimmed.success) {
    return NextResponse.json({ received: true, skipped: true, reason: 'schema_invalid' }, { status: 200 });
  }
  const payload = trimmed.data;
  const paymentId = buildPaymentId(payload.payment_id);
  const status = payload.payment_status;

  if (!['confirmed', 'failed', 'expired'].includes(status)) {
    return NextResponse.json({ received: true, skipped: true, reason: status }, { status: 200 });
  }

  const db = getDB();
  if (!db) {
    logError('[IPN] DB not initialized');
    return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
  }

  const existing = await db
    .prepare('SELECT id, status, user_id FROM payments WHERE payment_id = ? LIMIT 1')
    .bind(paymentId)
    .first<{ id: string; status: string; user_id: string }>();

  if (existing && existing.status !== 'pending') {
    return NextResponse.json({ received: true, deduped: true }, { status: 200 });
  }

  const tier = extractTier(payload.plan);

  if (status === 'confirmed') {
    await db.prepare(
      `UPDATE profiles SET plan = ?, tier = ?, updated_at = datetime('now') WHERE id = ?`
    ).bind(tier.toUpperCase(), tier.toUpperCase(), existing?.user_id ?? '').run();

    await db.prepare(
      `INSERT OR REPLACE INTO payments (id, payment_id, status, plan, user_id, amount, currency, confirmed_at, created_at, updated_at)
       VALUES (COALESCE((SELECT id FROM payments WHERE payment_id = ?), ?), ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'), datetime('now'))`
    ).bind(
      paymentId,
      crypto.randomUUID(),
      paymentId,
      'confirmed',
      tier.toUpperCase(),
      existing?.user_id ?? '',
      payload.price_amount ?? payload.pay_amount ?? 0,
      payload.price_currency ?? payload.pay_currency ?? 'USDT',
    ).run();

    logInfo(`[IPN] Confirmed payment ${paymentId} for user ${existing?.user_id}, tier=${tier.toUpperCase()}`);
  } else {
    await db.prepare(
      `UPDATE payments SET status = ?, updated_at = datetime('now') WHERE payment_id = ?`
    ).bind(status, paymentId).run();
  }

  return NextResponse.json({ received: true, processed: true }, { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok', endpoint: '/api/webhooks/ipn' });
}

function getDB() {
  // @ts-ignore
  return typeof DB !== 'undefined' ? DB : null;
}

function extractTier(plan?: string): string {
  const p = (plan ?? '').toLowerCase();
  if (p.includes('enter')) return 'ENTERPRISE';
  if (p.includes('master')) return 'MASTER';
  if (p.includes('premium') || p.includes('pro')) return 'PREMIUM';
  return 'BASIC';
}
