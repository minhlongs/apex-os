/**
 * GET /api/admin/settings/stellar
 * Returns Stellar configuration and health status
 */

import { NextRequest, NextResponse } from 'next/server';
import { getStellarSettings, requireAdmin } from '@/lib/admin/stellar-actions';
import { error as logError } from '@/lib/logger';

export async function GET(request: NextRequest) {
  try {
    const isAdmin = await requireAdmin();
    if (!isAdmin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }

    const { config, health } = await getStellarSettings();

    return NextResponse.json({
      success: true,
      data: { config, health },
    });
  } catch (error) {
logError('Stellar settings GET error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

/**
 * PUT /api/admin/settings/stellar
 * Updates Stellar configuration (network, horizon URL)
 * Note: Secret key is managed via environment variables only
 */
export async function PUT(request: NextRequest) {
  try {
    const isAdmin = await requireAdmin();
    if (!isAdmin) {
      return NextResponse.json({ success: false, error: 'Unauthorized' }, { status: 403 });
    }

    const body = await request.json();
    const { network, horizonUrl } = body;

    const { updateStellarConfig } = await import('@/lib/admin/stellar-actions');
    const result = await updateStellarConfig({ network, horizonUrl });

    return NextResponse.json(result);
  } catch (error) {
logError('Stellar settings PUT error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
