import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { error as logError, warn as logWarn } from '@/lib/logger';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';

const TIER_MAP: Record<string, string> = {
  BASIC: 'basic-plan',
  PREMIUM: 'premium-plan',
  ENTERPRISE: 'enterprise-plan',
  MASTER: 'master-plan',
};

const PLAN_AMOUNTS: Record<'BASIC' | 'PREMIUM' | 'ENTERPRISE' | 'MASTER', number> = {
  BASIC: 9,
  PREMIUM: 29,
  ENTERPRISE: 99,
  MASTER: 299,
};

const CreatePaymentSchema = z.object({
  plan: z.enum(['BASIC', 'PREMIUM', 'ENTERPRISE', 'MASTER']),
});

function generateOrderId(userId: string | null, plan: string): string {
  const uid = userId ?? 'anon';
  return `apex-${uid.slice(0, 8)}-${plan.toLowerCase()}-${Date.now()}`;
}

function buildCallbackUrl(request: NextRequest): string {
  const proto = request.headers.get('x-forwarded-proto') ?? 'https';
  const host = request.headers.get('host') ?? 'apex-os.com';
  return `${proto}://${host}/api/webhooks/ipn`;
}

function getDatabase(): D1Database | null {
  try {
    return getDB();
  } catch {
    return resolveDatabase();
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Parse and validate request body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid or missing JSON body' },
        { status: 400 }
      );
    }

    const parseResult = CreatePaymentSchema.safeParse(body);
    if (!parseResult.success) {
      return NextResponse.json(
        { success: false, error: 'Validation failed', details: parseResult.error.issues },
        { status: 400 }
      );
    }
    const { plan } = parseResult.data;

    // 3. Verify payment provider configuration
    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) {
      logWarn('[Payments] NOWPAYMENTS_API_KEY not configured');
      return NextResponse.json(
        { success: false, error: 'Payment service not configured' },
        { status: 503 }
      );
    }

    const nowPaymentsPlan = TIER_MAP[plan];
    if (!nowPaymentsPlan) {
      return NextResponse.json(
        { success: false, error: `Unsupported plan: ${plan}` },
        { status: 400 }
      );
    }

    const amount = PLAN_AMOUNTS[plan];
    const callbackUrl = buildCallbackUrl(request);
    const orderId = generateOrderId(user.id, plan);

    // 4. Contact NOWPayments upstream API
    let upstream: Response;
    try {
      upstream = await fetch('https://api.nowpayments.io/v1/payment', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          price_amount: amount,
          price_currency: 'usd',
          order_id: orderId,
          order_description: `ApexOS ${plan} subscription`,
          pay_amount: 0,
          pay_currency: 'usdterc20',
          ipn_callback_url: callbackUrl,
          plan,
        }),
      });
    } catch (err) {
      logError('[Payments] NOWPayments request failed:', err);
      return NextResponse.json(
        { success: false, error: 'Payment provider unreachable' },
        { status: 502 }
      );
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      logWarn('[Payments] NOWPayments rejected:', data);
      return NextResponse.json(
        { success: false, error: data?.message ?? 'Payment creation failed' },
        { status: upstream.status >= 500 ? 502 : upstream.status }
      );
    }

    // 5. Validate upstream response fields
    const rawPaymentId = data?.payment_id ?? data?.id;
    const checkoutUrl = data?.payment_url ?? data?.invoice_url;

    if (
      !data ||
      typeof data !== 'object' ||
      rawPaymentId === undefined ||
      rawPaymentId === null ||
      String(rawPaymentId).trim() === '' ||
      String(rawPaymentId).trim().toLowerCase() === 'undefined' ||
      !checkoutUrl ||
      typeof checkoutUrl !== 'string' ||
      checkoutUrl.trim() === '' ||
      checkoutUrl.trim().toLowerCase() === 'undefined'
    ) {
      logWarn('[Payments] NOWPayments returned invalid payment response payload:', data);
      return NextResponse.json(
        { success: false, error: 'Invalid response from payment provider' },
        { status: 502 }
      );
    }

    const paymentId = String(rawPaymentId);
    const internalId = crypto.randomUUID();

    // 6. Persist pending payment in Cloudflare D1 (fail-closed)
    try {
      const db = getDatabase();
      if (!db) {
        logError('[Payments] Database unavailable for recording pending payment');
        return NextResponse.json(
          { success: false, error: 'Failed to record payment' },
          { status: 500 }
        );
      }

      await db
        .prepare(
          `INSERT INTO payments (id, payment_id, status, plan, user_id, amount, currency, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`
        )
        .bind(internalId, paymentId, 'pending', plan, user.id, amount, 'USDT')
        .run();
    } catch (dbErr) {
      logError('[Payments] Failed to record pending payment in database:', dbErr);
      return NextResponse.json(
        { success: false, error: 'Failed to record payment' },
        { status: 500 }
      );
    }

    // 7. Return structured checkout response
    return NextResponse.json(
      {
        success: true,
        paymentId,
        checkoutUrl,
        id: internalId,
        status: 'pending',
        orderId: data.order_id ?? orderId,
        expiresAt: data.valid_until,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json(
        { success: false, error: 'Validation failed', details: error.issues },
        { status: 400 }
      );
    }
    logError('[Payments] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
