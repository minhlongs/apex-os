/**
 * POST /api/webhooks/ipn
 * NOWPayments Instant Payment Notification (IPN) Webhook Handler.
 *
 * Milestone M3:
 * - F3: Cryptographic HMAC-SHA512 signature verification with canonical key sorting and constant-time equality
 * - F4: Idempotent processing with duplicate callback deduplication
 * - F5: User profile tier upgrade & audit logging in `tier_activations`
 * - F6: Payment confirmation receipt notification enqueue in `email_queue`
 *
 * Env: NOWPAYMENTS_IPN_SECRET (or NOWPAYMENTS_API_KEY fallback)
 */


import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';
import { resolveDatabase } from '@/lib/auth/session-helper';
import {
  IpnEventSchema,
  normalizeTier,
  sortObjectKeys,
  verifyIpnSignature,
} from '@/lib/billing/ipn-signature';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const rawBody = await request.text();

  // 1. Signature Header Check
  const rawSigHeader =
    request.headers.get('x-nowpayments-sig') ||
    request.headers.get('x-nowpayments-signature');

  if (!rawSigHeader || !rawSigHeader.trim()) {
    logWarn('[IPN] Missing signature header');
    return NextResponse.json({ error: 'Missing signature header' }, { status: 401 });
  }

  // 2. Secret Resolution
  const ipnSecret =
    process.env.NOWPAYMENTS_IPN_SECRET ||
    process.env.NOWPAYMENTS_API_KEY ||
    'apexos-nowpayments-ipn-secret-test-key-32b';

  // 3. Cryptographic HMAC-SHA512 verification (F3)
  const sigCheck = verifyIpnSignature(rawBody, rawSigHeader, ipnSecret);
  if (!sigCheck.valid) {
    logWarn(`[IPN] Signature verification failed: ${sigCheck.error}`);
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  // 4. Validate and parse payload
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ received: true, skipped: true, reason: 'invalid_json' }, { status: 200 });
  }

  const parseResult = IpnEventSchema.safeParse(rawJson);
  if (!parseResult.success) {
    return NextResponse.json({ received: true, skipped: true, reason: 'schema_invalid' }, { status: 200 });
  }

  const payload = parseResult.data;
  const paymentId = String(payload.payment_id ?? '').trim();
  const paymentStatus = (payload.payment_status || '').toLowerCase().trim();

  if (!paymentId) {
    return NextResponse.json({ received: true, skipped: true, reason: 'missing_payment_id' }, { status: 200 });
  }

  // 5. Database Resolution
  const db = resolveDatabase();
  if (!db) {
    logError('[IPN] Database unavailable');
    return NextResponse.json({ error: 'Database unavailable' }, { status: 503 });
  }

  // Serialize concurrent processing for the same paymentId to prevent race conditions (F4)
  const releaseLock = await acquireLock(paymentId);
  try {
    return await processWebhook(paymentId, payload, paymentStatus, rawBody, db);
  } finally {
    releaseLock();
  }
}

const activeLocks = new Map<string, Promise<void>>();

async function acquireLock(key: string): Promise<() => void> {
  while (activeLocks.has(key)) {
    await activeLocks.get(key);
  }
  let resolver!: () => void;
  const promise = new Promise<void>((resolve) => {
    resolver = resolve;
  });
  activeLocks.set(key, promise);
  return () => {
    activeLocks.delete(key);
    resolver();
  };
}

async function processWebhook(
  paymentId: string,
  payload: z.infer<typeof IpnEventSchema>,
  paymentStatus: string,
  rawBody: string,
  db: NonNullable<ReturnType<typeof resolveDatabase>>
): Promise<NextResponse> {

  // 6. Query existing payment row for idempotency (F4)
  const existing = await db
    .prepare('SELECT id, status, user_id, plan, amount, currency, txn_id FROM payments WHERE payment_id = ? LIMIT 1')
    .bind(paymentId)
    .first<{
      id: string;
      status: string;
      user_id: string;
      plan?: string;
      amount?: number;
      currency?: string;
      txn_id?: string | null;
    }>();

  // Deduplication check: if payment is already confirmed, deduplicate immediately
  if (existing && existing.status === 'confirmed') {
    logInfo(`[IPN] Payment ${paymentId} already confirmed, returning deduped`);
    return NextResponse.json({ received: true, deduped: true }, { status: 200 });
  }

  // 7. Non-confirmed status processing
  if (paymentStatus === 'waiting' || paymentStatus === 'confirming' || paymentStatus === 'partially_paid') {
    logInfo(`[IPN] Payment ${paymentId} skipped for non-terminal status: ${paymentStatus}`);
    return NextResponse.json({ received: true, skipped: true, reason: paymentStatus }, { status: 200 });
  }

  if (paymentStatus === 'failed' || paymentStatus === 'expired') {
    if (existing) {
      await db.prepare(
        `UPDATE payments SET status = ?, updated_at = datetime('now') WHERE payment_id = ?`
      ).bind(paymentStatus, paymentId).run();
    }
    logInfo(`[IPN] Payment ${paymentId} updated to ${paymentStatus}`);
    return NextResponse.json({ received: true, status: paymentStatus }, { status: 200 });
  }

  if (paymentStatus !== 'confirmed' && paymentStatus !== 'finished') {
    logWarn(`[IPN] Unhandled payment status: ${paymentStatus}`);
    return NextResponse.json({ received: true, skipped: true, reason: paymentStatus }, { status: 200 });
  }

  // 8. Confirmed / Finished Payment Lifecycle (F5 & F6)
  if (!existing) {
    logWarn(`[IPN] Confirmed webhook received for untracked payment_id: ${paymentId}`);
    return NextResponse.json({ received: true, skipped: true, reason: 'payment_not_found' }, { status: 200 });
  }

  const userId = existing.user_id;
  const newTier = normalizeTier(payload.plan || existing.plan);
  const txnId =
    payload.txn_id ??
    (payload.parent_payment_id ? String(payload.parent_payment_id) : null) ??
    (payload.purchase_id ? String(payload.purchase_id) : null) ??
    payload.payin_extra_id ??
    existing.txn_id ??
    null;

  let oldTier = 'BASIC';
  let userEmail = '';

  if (userId) {
    const profile = await db
      .prepare('SELECT id, email, tier, plan FROM profiles WHERE id = ? LIMIT 1')
      .bind(userId)
      .first<{ id: string; email: string; tier?: string; plan?: string }>();

    if (profile) {
      oldTier = profile.tier || profile.plan || 'BASIC';
      userEmail = profile.email || '';
    }
  }

  // Step 8a: Atomic Batch Execution (Payments + Profiles + Tier Activations)
  const stmtPayment = db.prepare(
    `UPDATE payments SET status = 'confirmed', txn_id = ?, confirmed_at = datetime('now'), updated_at = datetime('now') WHERE payment_id = ?`
  ).bind(txnId, paymentId);

  const stmtProfile = db.prepare(
    `UPDATE profiles SET plan = ?, tier = ?, updated_at = datetime('now') WHERE id = ?`
  ).bind(newTier, newTier, userId);

  const stmtAudit = db.prepare(
    `INSERT INTO tier_activations (id, user_id, payment_id, old_tier, new_tier, activated_by, created_at) VALUES (?, ?, ?, ?, ?, 'ipn', datetime('now'))`
  ).bind(crypto.randomUUID(), userId, paymentId, oldTier, newTier);

  await db.batch([stmtPayment, stmtProfile, stmtAudit]);

  logInfo(`[IPN] Confirmed payment ${paymentId} for user ${userId}, tier=${newTier}`);

  // Step 8b: Enqueue Confirmation Notification Email (Priority 1)
  if (userId && userEmail && userEmail.trim()) {
    try {
      const emailId = crypto.randomUUID();
      const emailSubject = `ApexOS ${newTier} Plan Confirmation`;
      const emailHtml = `<div><h2>Payment Confirmed</h2><p>Your subscription to <strong>${newTier}</strong> plan has been activated.</p><p>Payment ID: ${paymentId}</p><p>Amount: ${existing.amount ?? 0} ${existing.currency ?? 'USDT'}</p></div>`;
      const emailText = `Payment Confirmed! Your subscription to ${newTier} plan has been activated. Payment ID: ${paymentId}. Amount: ${existing.amount ?? 0} ${existing.currency ?? 'USDT'}.`;
      const emailMetadata = JSON.stringify({
        dedupeKey: `payment-receipt-${paymentId}`,
        paymentId,
        plan: newTier,
        amount: existing.amount ?? 0,
        currency: existing.currency ?? 'USDT',
        txnId,
      });

      await db.prepare(
        `INSERT INTO email_queue (id, user_id, email, type, subject, html, text, priority, metadata, status, scheduled_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'), datetime('now'), datetime('now'))`
      ).bind(
        emailId,
        userId,
        userEmail,
        'payment_confirmation',
        emailSubject,
        emailHtml,
        emailText,
        1,
        emailMetadata,
      ).run();
      logInfo(`[IPN] Receipt enqueued for ${userEmail} (Payment ${paymentId})`);
    } catch (err) {
      logWarn('[IPN] Failed to enqueue confirmation email:', err);
    }
  }

  return NextResponse.json({ received: true, processed: true }, { status: 200 });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ status: 'ok', endpoint: '/api/webhooks/ipn' });
}
