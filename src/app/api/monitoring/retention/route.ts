/**
 * Alert Retention Cleanup Cron Endpoint
 *
 * Scheduled cleanup of old resolved alerts based on 90-day retention policy.
 * Run daily via cron: 0 2 * * * (2 AM daily)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAlertStorage } from '@/lib/alerts';
import { runRetentionCleanup } from '@/lib/alerts/retention-service';
import { error as logError } from '@/lib/logger';

export async function GET(request: NextRequest): Promise<NextResponse> {
  // Simple auth check - only allow from internal cron or with secret token
  const authHeader = request.headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401 }
    );
  }

  try {
    // @ts-ignore - D1 binding
    const db = typeof DB !== 'undefined' ? DB : null;
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const result = await runRetentionCleanup(db, {
      dryRun: false,
      retentionDays: 90,
      cleanupExpiredSnoozes: true,
    });

    return NextResponse.json({
      success: true,
      data: result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    logError('Retention cleanup failed:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
