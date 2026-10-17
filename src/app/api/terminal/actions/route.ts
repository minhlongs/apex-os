import { NextRequest, NextResponse } from 'next/server';
import { R2_MERKLE_SNAPSHOTS, SEPAY_VIETQR_RAILS } from '@/data/stitch-terminal-data';
import {
  calculateArbitrageMetrics,
  calculateVolumeSavings,
} from '@/lib/arbitrage/math';
import { sanctionsScreeningService } from '@/lib/compliance/sanctions-service';
import { WebhookCrypto, sha256Hash } from '@/lib/webhooks/crypto';
import type { SupportedPayoutChain } from '@/lib/payouts/types';

const FX_RATE_VND_PER_USDC = 25400;
const SEPAY_SETTLEMENT_FEE_RATE = 0.01;
const AI_MAX_SLIPPAGE_GUARD_BPS = 15.0;

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON payload: expected an object' },
        { status: 400 }
      );
    }
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Malformed JSON body' },
      { status: 400 }
    );
  }

  try {
    const action = typeof body.action === 'string' ? body.action : '';

    if (action === 'check_sanctions') {
      const address = String(body.address ?? '').trim();
      if (!address) {
        return NextResponse.json(
          { ok: false, error: 'Missing required field: address' },
          { status: 400 }
        );
      }
      const chain = (body.chain || 'ethereum') as SupportedPayoutChain;
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
      const payload = String(body.payload ?? '{}');
      const secret = String(body.secret ?? 'apex_os_webhook_secret_key_2026');
      const computedSignature = await WebhookCrypto.computeSignature(payload, secret);
      const providedSignature = String(body.signature ?? computedSignature);
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
        { status: isValid ? 200 : 401 }
      );
    }

    if (action === 'calculate_arbitrage') {
      const monthlyVolumeUsd = Number(body.monthlyVolumeUsd ?? 150000);
      const baseTakerFee = Number(body.baseTakerFee ?? 0.00065);
      const baseCashbackPct = Number(body.baseCashbackPct ?? 0);
      const targetTakerFee = Number(body.targetTakerFee ?? 0.0004);
      const targetCashbackPct = Number(body.targetCashbackPct ?? 50);

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

    if (action === 'calculate_sepay_payout') {
      const usdcAmount = Number(body.usdcAmount ?? 1000);
      if (!Number.isFinite(usdcAmount) || usdcAmount <= 0) {
        return NextResponse.json(
          { ok: false, error: 'usdcAmount must be a positive number' },
          { status: 400 }
        );
      }
      const bankCode = String(body.bankCode ?? 'VCB').toUpperCase();
      const bankRail =
        SEPAY_VIETQR_RAILS.find((b) => b.bankCode === bankCode) ?? SEPAY_VIETQR_RAILS[0];
      const netUsdcAfterFee = Number(
        (usdcAmount * (1 - SEPAY_SETTLEMENT_FEE_RATE)).toFixed(2)
      );
      const netVndPayout = Math.round(netUsdcAfterFee * FX_RATE_VND_PER_USDC);

      return NextResponse.json(
        {
          ok: true,
          action,
          bankCode: bankRail.bankCode,
          napasBin: bankRail.napasBin,
          usdcAmount,
          netUsdcAfterFee,
          netVndPayout,
          fxRateVndPerUsdc: FX_RATE_VND_PER_USDC,
        },
        { status: 200 }
      );
    }

    if (action === 'verify_r2_merkle_snapshot') {
      const snapshotId = String(body.snapshotId ?? R2_MERKLE_SNAPSHOTS[0].snapshotId);
      const snapshot =
        R2_MERKLE_SNAPSHOTS.find((s) => s.snapshotId === snapshotId) ??
        R2_MERKLE_SNAPSHOTS[0];
      const expectedRoot = snapshot.merkleRootHash;
      const providedRoot = String(body.merkleRootHash ?? expectedRoot);
      const verified = providedRoot === expectedRoot;
      const bundleDigest = await sha256Hash(
        `${snapshot.r2ObjectKey}:${providedRoot}:${snapshot.rowCount}`
      );

      return NextResponse.json(
        {
          ok: true,
          action,
          snapshotId: snapshot.snapshotId,
          r2ObjectKey: snapshot.r2ObjectKey,
          verified,
          expectedRoot,
          providedRoot,
          bundleDigest,
        },
        { status: verified ? 200 : 409 }
      );
    }

    if (action === 'evaluate_ai_agent_risk_gate') {
      const targetSpreadBps = Number(body.targetSpreadBps ?? 22);
      const simulatedSlippageBps = Number(body.simulatedSlippageBps ?? 6);
      const halted =
        simulatedSlippageBps > AI_MAX_SLIPPAGE_GUARD_BPS ||
        targetSpreadBps <= simulatedSlippageBps;
      const netCapturedSpreadBps = Math.max(0, targetSpreadBps - simulatedSlippageBps);

      return NextResponse.json(
        {
          ok: true,
          action,
          halted,
          gateState: halted ? 'RISK_GATE_HALTED' : 'SLIPPAGE_SAFE',
          maxSlippageGuardBps: AI_MAX_SLIPPAGE_GUARD_BPS,
          targetSpreadBps,
          simulatedSlippageBps,
          netCapturedSpreadBps,
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
