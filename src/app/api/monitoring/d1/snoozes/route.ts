/**
 * Alert Snoozes API
 * GET /api/monitoring/d1/snoozes - List active snoozes
 * POST /api/monitoring/d1/snoozes - Create a new snooze
 */

import { NextRequest, NextResponse } from 'next/server';
import { error as logError } from '@/lib/logger';

import {
  getActiveSnoozes,
  createSnooze,
} from '@/lib/monitoring/d1-monitor';

// ============================================================================
// GET /api/monitoring/d1/snoozes
// ============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const snoozes = await getActiveSnoozes(db);

    return NextResponse.json({
      success: true,
      data: snoozes.map(s => ({
        id: s.id,
        alertConfigId: s.alertConfigId,
        durationMinutes: s.durationMinutes,
        createdAt: s.createdAt.toISOString(),
        expiresAt: s.expiresAt.toISOString(),
        reason: s.reason,
        metadata: s.metadata,
      })),
    });
  } catch (error) {
    logError('Get snoozes error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST /api/monitoring/d1/snoozes
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const { alertConfigId, durationMinutes, reason, snoozedBy } = body as {
      alertConfigId: string;
      durationMinutes: number;
      reason?: string;
      snoozedBy?: string;
    };

    if (!alertConfigId || !durationMinutes) {
      return NextResponse.json(
        { success: false, error: 'alertConfigId and durationMinutes are required' },
        { status: 400 }
      );
    }

    // Validate duration (only allow preset values)
    const allowedDurations = [60, 360, 1440]; // 1h, 6h, 24h
    if (!allowedDurations.includes(durationMinutes)) {
      return NextResponse.json(
        { success: false, error: `durationMinutes must be one of: ${allowedDurations.join(', ')}` },
        { status: 400 }
      );
    }

    // @ts-ignore
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    // Check if alert config exists and is enabled
    const config = await db
      .prepare('SELECT id, is_enabled FROM d1_alert_configs WHERE id = ?')
      .bind(alertConfigId)
      .first<{ id: string; is_enabled: number }>();

    if (!config) {
      return NextResponse.json(
        { success: false, error: 'Alert configuration not found' },
        { status: 404 }
      );
    }

    if (!config.is_enabled) {
      return NextResponse.json(
        { success: false, error: 'Alert configuration is not enabled' },
        { status: 400 }
      );
    }

    // Check if already snoozed
    const existingSnooze = await getActiveSnoozes(db);
    if (existingSnooze.some(s => s.alertConfigId === alertConfigId)) {
      return NextResponse.json(
        { success: false, error: 'This alert is already snoozed' },
        { status: 409 }
      );
    }

    const snooze = await createSnooze(db, {
      alertConfigId,
      durationMinutes,
      snoozedBy,
      reason,
    });

    return NextResponse.json({
      success: true,
      data: {
        id: snooze.id,
        alertConfigId: snooze.alertConfigId,
        durationMinutes: snooze.durationMinutes,
        createdAt: snooze.createdAt.toISOString(),
        expiresAt: snooze.expiresAt.toISOString(),
        reason: snooze.reason,
      },
    });
  } catch (error) {
    logError('Create snooze error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
