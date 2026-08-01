/**
 * Time-Series Metrics API
 * Provides aggregated time-series data for charts and dashboards
 *
 * Endpoint: GET /api/metrics/timeseries
 * Query params:
 *   - start: ISO date (required)
 *   - end: ISO date (required)
 *   - interval: 'hour' | 'day' | 'week' | 'month' (required)
 *   - metric: 'conversions' | 'revenue' | 'clicks' | 'earnings' | 'payouts' | 'conversion_rate' | 'unique_affiliates' (optional, default: conversions)
 *   - dealId: string (optional)
 *   - affiliateId: string (optional)
 *   - status: 'pending' | 'approved' | 'rejected' | 'refunded' (optional)
 *
 * Response: TimeSeriesResponse with labels, values, and data points
 */

import { NextRequest, NextResponse } from 'next/server';
import { getTimeSeriesData, validateTimeSeriesParams } from '@/lib/metrics/time-series';
import type { TimeSeriesQueryParams } from '@/types/metrics';
import { error as logError } from '@/lib/logger';

// ============================================================================
// GET Handler
// ============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore - D1 binding from wrangler.toml
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const searchParams = url.searchParams;

    // Build query params from request
    const params: TimeSeriesQueryParams = {
      start: searchParams.get('start') || '',
      end: searchParams.get('end') || '',
      interval: (searchParams.get('interval') as TimeSeriesQueryParams['interval']) || 'day',
      metric: (searchParams.get('metric') as TimeSeriesQueryParams['metric']) || 'conversions',
      dealId: searchParams.get('dealId') || undefined,
      affiliateId: searchParams.get('affiliateId') || undefined,
      status: (searchParams.get('status') as TimeSeriesQueryParams['status']) || undefined,
    };

    // Validate parameters
    const validationErrors = validateTimeSeriesParams(params);
    if (validationErrors.length > 0) {
      return NextResponse.json(
        { success: false, error: 'Validation failed', details: validationErrors },
        { status: 400 }
      );
    }

    // Get time-series data
    const data = await getTimeSeriesData(db, params);

    return NextResponse.json({
      success: true,
      ...data,
    });
  } catch (error) {
    logError('Time-series metrics API error:', error);

    const message = error instanceof Error ? error.message : 'Unknown error';
    const status = message.includes('date') || message.includes('range') ? 400 : 500;

    return NextResponse.json(
      { success: false, error: message },
      { status }
    );
  }
}

// ============================================================================
// OPTIONS Handler (for CORS preflight)
// ============================================================================

export async function OPTIONS(): Promise<NextResponse> {
  return NextResponse.json(
    { success: true, message: 'Time-series metrics API' },
    {
      status: 200,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      },
    }
  );
}
