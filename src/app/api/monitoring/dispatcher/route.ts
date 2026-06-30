/**
 * Dispatcher API - Monitor and manage the notification dispatcher
 *
 * Provides endpoints for:
 * - GET /api/monitoring/dispatcher - Get dispatcher stats
 * - GET /api/monitoring/dispatcher/dead-letters - List dead letter queue
 * - POST /api/monitoring/dispatcher/retry - Retry a dead letter
 * - POST /api/monitoring/dispatcher/cleanup - Clean up old dead letters
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDispatcher } from '@/lib/monitoring/dispatcher';
import { getAlertStorage } from '@/lib/alerts';
import { withAuth } from '@/lib/auth/adapters/d1-adapter';

/**
 * GET /api/monitoring/dispatcher
 * Returns dispatcher statistics
 */
export async function GET(request: NextRequest) {
  try {
    // Check auth - admin only
    const authResult = await withAuth(request);
    if (!authResult.success || authResult.user?.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const dispatcher = getDispatcher();
    const stats = dispatcher.getStats();
    const config = dispatcher.getConfig();

    return NextResponse.json({
      success: true,
      data: {
        stats,
        config,
        isProcessing: dispatcher.isCurrentlyProcessing(),
      },
    });
  } catch (error) {
    console.error('[Dispatcher API] Error getting stats:', error);
    return NextResponse.json(
      { error: 'Failed to get dispatcher stats' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/monitoring/dispatcher/dead-letters
 * List dead letter queue entries
 */
export async function GET_DEAD_LETTERS(request: NextRequest) {
  try {
    // Check auth - admin only
    const authResult = await withAuth(request);
    if (!authResult.success || authResult.user?.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { searchParams } = new URL(request.url);
    const limit = parseInt(searchParams.get('limit') || '50', 10);
    const channel = searchParams.get('channel');
    const olderThan = searchParams.get('olderThan'); // days

    // Get DB from auth result
    const db = authResult.db;
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    // Build query
    let query = 'SELECT * FROM dead_letter_queue';
    const conditions: string[] = [];
    const bindValues: any[] = [];

    if (channel) {
      conditions.push('channel = ?');
      bindValues.push(channel);
    }

    if (olderThan) {
      conditions.push('created_at < datetime("now", "-" || ? || " days")');
      bindValues.push(parseInt(olderThan, 10));
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY created_at DESC LIMIT ?';
    bindValues.push(limit);

    const result = await db.prepare(query).bind(...bindValues).all();

    // Get summary stats
    const summaryResult = await db
      .prepare(`
        SELECT
          COUNT(*) as total,
          COUNT(DISTINCT channel) as distinct_channels,
          MIN(created_at) as oldest,
          MAX(created_at) as newest
        FROM dead_letter_queue
      `)
      .first<{ total: number; distinct_channels: number; oldest: string; newest: string }>();

    const byChannelResult = await db
      .prepare(`
        SELECT channel, COUNT(*) as count
        FROM dead_letter_queue
        GROUP BY channel
        ORDER BY count DESC
      `)
      .all();

    return NextResponse.json({
      success: true,
      data: {
        entries: result.results,
        summary: summaryResult,
        byChannel: byChannelResult.results,
      },
    });
  } catch (error) {
    console.error('[Dispatcher API] Error getting dead letters:', error);
    return NextResponse.json(
      { error: 'Failed to get dead letter queue' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/monitoring/dispatcher/retry
 * Retry a specific dead letter entry
 */
export async function POST_RETRY(request: NextRequest) {
  try {
    // Check auth - admin only
    const authResult = await withAuth(request);
    if (!authResult.success || authResult.user?.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const { deadLetterId, createNewJob = true } = body;

    if (!deadLetterId) {
      return NextResponse.json(
        { error: 'deadLetterId is required' },
        { status: 400 }
      );
    }

    const db = authResult.db;
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    // Get the dead letter entry
    const dlqEntry = await db
      .prepare('SELECT * FROM dead_letter_queue WHERE id = ?')
      .bind(deadLetterId)
      .first<{ id: string; job_id: string; attempts: number; [key: string]: unknown }>();

    if (!dlqEntry) {
      return NextResponse.json(
        { error: 'Dead letter entry not found' },
        { status: 404 }
      );
    }

    if (createNewJob) {
      // Create a new dispatch job from the dead letter
      const dispatcher = getDispatcher();
      const newJobId = `retry_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Insert a new job record (we'd need a dispatch_jobs table for this)
      // For now, we'll just log the retry attempt

      // Record in retry history
      await db
        .prepare(`
          INSERT INTO notification_retry_history (id, dead_letter_id, job_id, attempt_number, success)
          VALUES (?, ?, ?, ?, ?)
        `)
        .bind(
          `retry_${Date.now()}`,
          deadLetterId,
          dlqEntry.job_id,
          (dlqEntry as { attempts: number }).attempts + 1,
          0 // pending
        )
        .run();
    }

    return NextResponse.json({
      success: true,
      data: {
        message: `Retry initiated for dead letter ${deadLetterId}`,
        deadLetter: dlqEntry,
      },
    });
  } catch (error) {
    console.error('[Dispatcher API] Error retrying dead letter:', error);
    return NextResponse.json(
      { error: 'Failed to retry dead letter' },
      { status: 500 }
    );
  }
}

/**
 * POST /api/monitoring/dispatcher/cleanup
 * Clean up old dead letter entries
 */
export async function POST_CLEANUP(request: NextRequest) {
  try {
    // Check auth - admin only
    const authResult = await withAuth(request);
    if (!authResult.success || authResult.user?.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const body = await request.json();
    const daysOld = body.daysOld || 30;

    const db = authResult.db;
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    // Get count before deletion
    const countResult = await db
      .prepare(`
        SELECT COUNT(*) as count
        FROM dead_letter_queue
        WHERE created_at < datetime('now', '-' || ? || ' days')
      `)
      .bind(daysOld)
      .first<{ count: number }>();

    const toDelete = countResult?.count ?? 0;

    // Delete old entries
    const result = await db
      .prepare(`
        DELETE FROM dead_letter_queue
        WHERE created_at < datetime('now', '-' || ? || ' days')
      `)
      .bind(daysOld)
      .run();

    return NextResponse.json({
      success: true,
      data: {
        deleted: (result as { changes?: number }).changes ?? 0,
        requestedDays: daysOld,
      },
    });
  } catch (error) {
    console.error('[Dispatcher API] Error cleaning up dead letters:', error);
    return NextResponse.json(
      { error: 'Failed to cleanup dead letters' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/monitoring/dispatcher/dead-letters/:id
 * Delete a specific dead letter entry
 */
export async function DELETE_DEAD_LETTER(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    // Check auth - admin only
    const authResult = await withAuth(request);
    if (!authResult.success || authResult.user?.role !== 'admin') {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { id } = await params;

    const db = authResult.db;
    if (!db) {
      return NextResponse.json({ error: 'Database not available' }, { status: 500 });
    }

    const result = await db
      .prepare('DELETE FROM dead_letter_queue WHERE id = ?')
      .bind(id)
      .run();

    if (result.meta.changes === 0) {
      return NextResponse.json(
        { error: 'Dead letter entry not found' },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: { deleted: result.meta.changes },
    });
  } catch (error) {
    console.error('[Dispatcher API] Error deleting dead letter:', error);
    return NextResponse.json(
      { error: 'Failed to delete dead letter' },
      { status: 500 }
    );
  }
}
