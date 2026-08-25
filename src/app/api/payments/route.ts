import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { error as logError, warn as logWarn } from '@/lib/logger';

const TIER_MAP: Record<string, string> = {
  BASIC: 'basic-plan',
  PREMIUM: 'premium-plan',
  ENTERPRISE: 'enterprise-plan',
  MASTER: 'master-plan',
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

async function extractUserId(request: NextRequest): Promise<string | null> {
  try {
    const sessionRes = await fetch(`${request.nextUrl.origin}/api/auth/session`, {
      headers: { cookie: request.headers.get('cookie') ?? '' },
      next: { revalidate: 0 },
    });
    if (!sessionRes.ok) return null;
    const data = await sessionRes.json();
    return data?.user?.id ?? null;
  } catch {
    return null;
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { plan } = CreatePaymentSchema.parse(body);

    const apiKey = process.env.NOWPAYMENTS_API_KEY;
    if (!apiKey) {
      logWarn('[Payments] NOWPAYMENTS_API_KEY not configured');
      return NextResponse.json({ success: false, error: 'Payment service not configured' }, { status: 503 });
    }

    const nowPaymentsPlan = TIER_MAP[plan];
    if (!nowPaymentsPlan) {
      return NextResponse.json({ success: false, error: `Unsupported plan: ${plan}` }, { status: 400 });
    }

    const userId = await extractUserId(request);
    const callbackUrl = buildCallbackUrl(request);

    let upstream: Response;
    try {
      upstream = await fetch('https://api.nowpayments.io/v1/payment', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          price_amount: null,
          price_currency: 'usd',
          order_id: generateOrderId(userId, plan),
          order_description: `ApexOS ${plan} subscription`,
          pay_amount: 0,
          pay_currency: 'usdterc20',
          ipn_callback_url: callbackUrl,
          plan,
        }),
      });
    } catch (err) {
      logError('[Payments] NOWPayments request failed:', err);
      return NextResponse.json({ success: false, error: 'Payment provider unreachable' }, { status: 502 });
    }

    const data = await upstream.json();
    if (!upstream.ok) {
      logWarn('[Payments] NOWPayments rejected:', data);
      return NextResponse.json(
        { success: false, error: data?.message ?? 'Payment creation failed' },
        { status: upstream.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        checkoutUrl: data.payment_url ?? data.invoice_url,
        paymentId: String(data.payment_id ?? data.id),
        orderId: data.order_id,
        expiresAt: data.valid_until,
      },
      { status: 200 }
    );
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ success: false, error: 'Validation failed', details: error.errors }, { status: 400 });
    }
    logError('[Payments] Error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
