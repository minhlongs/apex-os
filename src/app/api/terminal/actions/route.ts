import { NextRequest, NextResponse } from 'next/server';
import {
  calculateArbitrageMetrics,
  calculateVolumeSavings,
} from '@/lib/arbitrage/math';
import { sanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import { WebhookCrypto, sha256Hash } from '@/lib/webhooks/crypto';
import type { SupportedPayoutChain } from '@/lib/payouts/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const action = body?.action as string | undefined;

    if (action === 'check_sanctions') {
      const address = String(body?.address || '');
      const chain = (body?.chain || 'ethereum') as SupportedPayoutChain;
      const result = await sanctionsScreeningService.checkAddress(address, chain);
      return NextResponse.json(
        {
          ok: true,
          action,
          chain,
          address,
          result,
        },
        { status: 200 }
      );
    }

    if (action === 'verify_webhook_hmac') {
      const payload = String(body?.payload || '{}');
      const secret = String(body?.secret || 'apex_os_webhook_secret_key_2026');
      const computedSignature = await WebhookCrypto.computeSignature(payload, secret);
      const providedSignature = String(body?.signature || computedSignature);
      const isValid = await WebhookCrypto.verifyHmacSha256(
        payload,
        providedSignature,
        secret
      );
      const payloadDigest = await sha256Hash(payload);

      return NextResponse.json(
        {
          ok: true,
          action,
          isValid,
          computedSignature,
          payloadDigest,
        },
        { status: 200 }
      );
    }

    if (action === 'calculate_arbitrage') {
      const monthlyVolumeUsd = Number(body?.monthlyVolumeUsd || 150000);
      const baseTakerFee = Number(body?.baseTakerFee || 0.00065);
      const baseCashbackPct = Number(body?.baseCashbackPct || 0);
      const targetTakerFee = Number(body?.targetTakerFee || 0.0004);
      const targetCashbackPct = Number(body?.targetCashbackPct || 50);

      const metrics = calculateArbitrageMetrics(
        baseTakerFee,
        baseCashbackPct,
        targetTakerFee,
        targetCashbackPct
      );
      const customVolumeSavings = calculateVolumeSavings(
        metrics.spreadBps,
        monthlyVolumeUsd
      );

      return NextResponse.json(
        {
          ok: true,
          action,
          metrics,
          customVolumeSavings,
        },
        { status: 200 }
      );
    }

    return NextResponse.json(
      { ok: false, error: `Unsupported terminal action: ${String(action)}` },
      { status: 400 }
    );
  } catch (err) {
    return NextResponse.json(
      { ok: false, error: err instanceof Error ? err.message : 'Internal error' },
      { status: 500 }
    );
  }
}
