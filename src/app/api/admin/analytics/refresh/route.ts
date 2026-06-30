import { NextRequest, NextResponse } from 'next/server';
import { requireAdminRole } from '@/lib/auth-guard';
import { refreshAnalyticsViews, getRefreshStatus, getAnalyticsRowCounts } from '@/lib/analytics/refresh';
import { getDB } from '@/lib/db';

// ============================================================================
// GET /api/admin/analytics/refresh
//   Returns current refresh status and row counts
// POST /api/admin/analytics/refresh
//   Triggers a manual refresh of all analytics views
// ============================================================================

export async function GET(request: NextRequest) {
  const admin = await requireAdminRole(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const DB = getDB();
    if (!DB) {
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 503 }
      );
    }

    const status = await getRefreshStatus(DB);
    const rowCounts = await getAnalyticsRowCounts(DB);

    return NextResponse.json({
      success: true,
      status,
      row_counts: rowCounts,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const admin = await requireAdminRole(request);
  if (!admin) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const DB = getDB();
    if (!DB) {
      return NextResponse.json(
        { error: 'Database not configured' },
        { status: 503 }
      );
    }

    const body = await request.json().catch(() => ({}));
    const viewNames = body.views as string[] | undefined;

    const results = await refreshAnalyticsViews(DB, viewNames);
    const successCount = results.filter(r => r.success).length;
    const allSuccess = successCount === results.length;

    return NextResponse.json({
      success: allSuccess,
      refreshed: successCount,
      total: results.length,
      results,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Internal server error', details: String(error) },
      { status: 500 }
    );
  }
}
