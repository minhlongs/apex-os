/**
 * GET /api/admin/settings/stellar/health
 * Returns detailed health status of Stellar connection
 */

import { NextRequest, NextResponse } from 'next/server';
import {
  StellarService,
  isValidStellarAccountId,
  sanitizeStellarDiagnosticError,
} from '@/lib/payouts/stellar-service';
import { getStellarSettings, requireAdmin } from '@/lib/admin/stellar-actions';
import { error as logError } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await requireAdmin();
    if (!isAdmin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }

    const { config } = await getStellarSettings();

    // Read-only Turnkey HSM hot-wallet public key boundary:
    // NEVER read or fall back to raw STELLAR_SECRET_KEY in Worker health checks.
    const rawCandidate =
      process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim() ||
      config.senderAccountId?.trim() ||
      undefined;

    if (!rawCandidate) {
      return NextResponse.json({
        healthy: false,
        network: config.network,
        senderAccount: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        horizonConnected: false,
        errors: [
          'TURNKEY_STELLAR_HOT_WALLET_ADDRESS not set in environment variables (Turnkey HSM Stellar hot wallet)',
        ],
      });
    }

    if (!isValidStellarAccountId(rawCandidate)) {
      return NextResponse.json({
        healthy: false,
        network: config.network,
        senderAccount: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        horizonConnected: false,
        errors: [
          'Invalid Stellar public account ID configured for TURNKEY_STELLAR_HOT_WALLET_ADDRESS (expected G... Ed25519 StrKey)',
        ],
      });
    }

    const service = new StellarService({
      network: config.network,
      horizonUrl: config.horizonUrl || undefined,
      usdcIssuer: config.usdcIssuer || undefined,
      senderPublicKey: rawCandidate,
    });

    const health = await service.healthCheck();

    return NextResponse.json({
      ...health,
      errors: health.errors.map(sanitizeStellarDiagnosticError),
    });
  } catch (error) {
    const safeMessage = sanitizeStellarDiagnosticError(
      error instanceof Error ? error.message : 'Unknown error'
    );
    logError('Stellar health check error:', safeMessage);
    return NextResponse.json(
      {
        healthy: false,
        network: 'unknown',
        senderAccount: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        horizonConnected: false,
        errors: [safeMessage],
      },
      { status: 500 }
    );
  }
}
