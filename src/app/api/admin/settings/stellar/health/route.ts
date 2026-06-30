/**
 * GET /api/admin/settings/stellar/health
 * Returns detailed health status of Stellar connection
 */

import { NextRequest, NextResponse } from 'next/server';
import { StellarService } from '@/lib/payouts/stellar-service';
import { getStellarSettings, requireAdmin } from '@/lib/admin/stellar-actions';

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await requireAdmin();
    if (!isAdmin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }

    const { config } = await getStellarSettings();

    // Check if secret key is available
    const secretKey = process.env.STELLAR_SECRET_KEY;
    if (!secretKey) {
      return NextResponse.json({
        healthy: false,
        network: config.network,
        senderAccount: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        horizonConnected: false,
        errors: ['STELLAR_SECRET_KEY not set in environment variables'],
      });
    }

    // Create service with current config
    const service = new StellarService({
      network: config.network,
      horizonUrl: config.horizonUrl || undefined,
      secretKey,
    });

    const health = await service.healthCheck();

    return NextResponse.json(health);
  } catch (error) {
    console.error('Stellar health check error:', error);
    return NextResponse.json(
      {
        healthy: false,
        network: 'unknown',
        senderAccount: null,
        senderBalanceUSDC: 0,
        senderBalanceXLM: 0,
        horizonConnected: false,
        errors: [error instanceof Error ? error.message : 'Unknown error'],
      },
      { status: 500 }
    );
  }
}
