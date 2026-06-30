/**
 * Delete a specific snooze
 * DELETE /api/monitoring/d1/snoozes/[id]
 */

import { NextRequest, NextResponse } from 'next/server';
import { deleteSnooze } from '@/lib/monitoring/d1-monitor';

export async function DELETE(
  request: NextRequest,
  context: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  try {
    const { id: snoozeId } = await context.params;

    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const deleted = await deleteSnooze(db, snoozeId);

    if (!deleted) {
      return NextResponse.json(
        { success: false, error: 'Snooze not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: { deleted: true, snoozeId },
    });
  } catch (error) {
    console.error('Delete snooze error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
