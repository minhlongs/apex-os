/**
 * Analytics Refresh Cron
 * POST /api/cron/refresh-analytics
 * Auth: secret token (ANALYTICS_REFRESH_SECRET)
 * Refreshes all materialized analytics views
 */

import { NextRequest, NextResponse } from 'next/server';
import { error as logError, info as logInfo, warn as logWarn } from '@/lib/logger';
import { refreshAnalyticsViews } from '@/lib/analytics/refresh';

function isAuthorized(request: NextRequest): boolean {
  const secret = request.headers.get('x-refresh-secret');
  // Fallback: check query param for testing only
  const querySecret = new URL(request.url).searchParams.get('secret');
  const expected = process.env.ANALYTICS_REFRESH_SECRET;
  if (!expected) return false;
  return secret === expected || querySecret === expected;
}

interface RefreshResponse {
  success: boolean;
  started_at: string;
  completed_at: string;
  duration_ms: number;
  views_refreshed: number;
  error?: string;
}

export const POST = async (_request: NextRequest): Promise<Response> => {
  const startedAt = new Date();
  const startedIso = startedAt.toISOString();

  if (!isAuthorized(_request)) {
    logWarn('[Analytics:Cron] Unauthorized refresh attempt');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // @ts-ignore — runtime global DB binding
    const DB = (globalThis as unknown as { DB: Parameters<typeof refreshAnalyticsViews>[0] }).DB;
    if (!DB) {
      return NextResponse.json({ error: 'Database not available' }, { status: 503 });
    }

    logInfo('[Analytics:Cron] Refresh started');
    await refreshAnalyticsViews(DB);
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    const response: RefreshResponse = {
      success: true,
      started_at: startedIso,
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      views_refreshed: 5,
    };

    logInfo(`[Analytics:Cron] Refresh complete in ${durationMs}ms`);
    return NextResponse.json(response);
  } catch (error) {
    const completedAt = new Date();
    const durationMs = completedAt.getTime() - startedAt.getTime();

    logError('[Analytics:Cron] Refresh failed:', error);
    const response: RefreshResponse = {
      success: false,
      started_at: startedIso,
      completed_at: completedAt.toISOString(),
      duration_ms: durationMs,
      views_refreshed: 0,
      error: String(error),
    };
    return NextResponse.json(response, { status: 500 });
  }
};
