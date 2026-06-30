/**
 * Resend Webhook Endpoint
 * Handles email delivery events: delivered, bounced, complained, opened, clicked, failed
 *
 * Resend uses Svix for webhook signing.
 * Headers: svix-signature, svix-timestamp, svix-id
 *
 * POST /api/webhooks/resend
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { getDB } from '@/lib/db';

// ============================================================================
// Svix Webhook Verification
// ============================================================================

async function svixSign(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret.replace('whsec_', '')),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(`${timestamp}.${body}`));
  const b64 = Buffer.from(sig).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return `v1,${b64}`;
}

async function verifySvixSignature(payload: string, headers: Headers, secret: string): Promise<boolean> {
  const svixTimestamp = headers.get('svix-timestamp');
  const svixSignature = headers.get('svix-signature');

  if (!svixTimestamp || !svixSignature) return false;

  const timestampAge = Date.now() / 1000 - parseInt(svixTimestamp, 10);
  if (timestampAge > 300) return false;

  const expectedSig = await svixSign(secret, svixTimestamp, payload);
  const signatures = svixSignature.split(',').map(s => s.trim());
  const expectedParts = expectedSig.split(',').map(s => s.trim());

  const expectedV1 = expectedParts.find(p => p.startsWith('v1='));
  const actualV1 = signatures.find(s => s.startsWith('v1='));

  if (!expectedV1 || !actualV1) return false;

  const expectedVal = expectedV1.slice(3);
  const actualVal = actualV1.slice(3);
  if (expectedVal.length !== actualVal.length) return false;

  let result = 0;
  for (let i = 0; i < expectedVal.length; i++) {
    result |= expectedVal.charCodeAt(i) ^ actualVal.charCodeAt(i);
  }
  return result === 0;
}

// ============================================================================
// Zod Schemas
// ============================================================================

const ResendEventSchema = z.object({
  type: z.enum([
    'email.delivered',
    'email.bounced',
    'email.complained',
    'email.opened',
    'email.clicked',
    'email.failed',
    'email.scheduled',
  ]),
  created_at: z.string(),
  data: z.object({
    email_id: z.string(),
    from: z.string().email(),
    to: z.array(z.string().email()).min(1),
    subject: z.string(),
    created_at: z.string(),
    bounce: z
      .object({
        messageId: z.string(),
        subType: z.enum(['undetermined', 'general', 'mailboxFull', 'suppressed', 'spam']),
      })
      .optional(),
    failed: z
      .object({
        messageId: z.string(),
        reason: z.string(),
      })
      .optional(),
  }),
});

// ============================================================================
// Route Handler
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  const body = await request.text();
  const webhookSecret = process.env.RESEND_WEBHOOK_SECRET;

  if (webhookSecret) {
    const valid = await verifySvixSignature(body, request.headers, webhookSecret);
    if (!valid) {
      return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
    }
  }

  let parsed: z.infer<typeof ResendEventSchema>;
  try {
    parsed = ResendEventSchema.parse(JSON.parse(body));
  } catch {
    return NextResponse.json({ error: 'Invalid payload' }, { status: 400 });
  }

  const db = getDB();
  if (!db) {
    return NextResponse.json({ error: 'Database not configured' }, { status: 503 });
  }

  const resendEmailId = parsed.data.email_id;
  const recipientEmail = parsed.data.to[0];
  const eventType = parsed.type;

  try {
    const queueRow = await db
      .prepare(
        `SELECT * FROM email_queue
         WHERE email = ?
           AND status = 'sent'
           AND created_at >= datetime('now', '-7 days')
         ORDER BY sent_at DESC
         LIMIT 1`
      )
      .bind(recipientEmail)
      .first<{ id: string }>();

    if (!queueRow) {
      await db.prepare(
        `INSERT INTO email_events (id, queue_id, event_type, email, resend_id, payload, created_at)
         VALUES (?, ?, ?, ?, ?, ?, datetime('now'))`
      )
        .bind(crypto.randomUUID(), 'unknown', eventType, recipientEmail, resendEmailId, body)
        .run();

      return NextResponse.json({ received: true, matched: false });
    }

    const queueId = queueRow.id;

    let eventReason: string | null = null;
    if (eventType === 'email.bounced' && parsed.data.bounce) {
      eventReason = parsed.data.bounce.subType;
    } else if (eventType === 'email.failed' && parsed.data.failed) {
      eventReason = parsed.data.failed.reason;
    }

    await db.prepare(
      `INSERT INTO email_events (id, queue_id, event_type, email, resend_id, reason, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
    )
      .bind(crypto.randomUUID(), queueId, eventType, recipientEmail, resendEmailId, eventReason, body)
      .run();

    if (eventType === 'email.bounced') {
      await db.prepare(
        `UPDATE email_queue SET status = 'bounced', error = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(eventReason, queueId).run();
    } else if (eventType === 'email.complained') {
      await db.prepare(
        `UPDATE email_queue SET status = 'bounced', error = 'complained', updated_at = datetime('now') WHERE id = ?`
      ).bind(queueId).run();
    } else if (eventType === 'email.failed') {
      await db.prepare(
        `UPDATE email_queue SET status = 'failed', error = ?, updated_at = datetime('now') WHERE id = ?`
      ).bind(eventReason, queueId).run();
    }

    return NextResponse.json({ received: true, matched: true, eventType });
  } catch {
    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    status: 'ok',
    endpoint: '/api/webhooks/resend',
    events: [
      'email.delivered',
      'email.bounced',
      'email.complained',
      'email.opened',
      'email.clicked',
      'email.failed',
    ],
  });
}
