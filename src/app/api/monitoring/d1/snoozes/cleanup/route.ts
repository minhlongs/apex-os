/**
 * Cleanup expired snoozes
 * POST /api/monitoring/d1/snoozes/cleanup
 */

import { NextRequest, NextResponse } from 'next/server';
import { cleanupExpiredSnoozes } from '@/lib/monitoring/d1-monitor';
import { error as logError } from '@/lib/logger';

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const deletedCount = await cleanupExpiredSnoozes(db);

    return NextResponse.json({
      success: true,
      data: { deletedCount },
    });
  } catch (error) {
    logError('Snooze cleanup error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
