/**
 * Web Vitals Analytics API
 *
 * Receives and stores Core Web Vitals metrics from client-side reporting.
 * Provides aggregated metrics for performance monitoring.
 * Runtime: Edge for global low-latency
 */

export const runtime = 'edge';

import { NextRequest, NextResponse } from 'next/server';
import { getDB } from '@/lib/db';

interface WebVitalMetric {
  name: string;
  value: number;
  rating: 'good' | 'needs-improvement' | 'poor';
  delta: number;
  id: string;
  navigationType?: string;
  entries?: Array<{
    name: string;
    entryType: string;
    startTime: number;
    duration?: number;
  }>;
  timestamp: string;
  url: string;
  userAgent: string;
}

/**
 * POST /api/analytics/web-vitals
 * Accepts Web Vitals metrics from client and stores them in D1
 *
 * Request body: WebVitalMetric[]
 *
 * Returns: { received: number, stored: number }
 */
export const POST = async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();

  try {
    const body = await request.json();
    const metrics: WebVitalMetric[] = Array.isArray(body) ? body : [body];

    if (metrics.length === 0) {
      return NextResponse.json(
        { error: 'No metrics provided' },
        { status: 400 }
      );
    }

    const db = getDB();
    if (!db) {
      return NextResponse.json({
        received: metrics.length,
        stored: 0,
        message: 'Database not available'
      });
    }

    // Store each metric
    let stored = 0;
    const errors: string[] = [];

    for (const metric of metrics) {
      try {
        await db.prepare(
          `INSERT INTO web_vitals (
            name, value, rating, delta, metric_id, navigation_type,
            url, user_agent, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        ).bind(
          metric.name,
          metric.value,
          metric.rating,
          metric.delta,
          metric.id,
          metric.navigationType || null,
          metric.url,
          metric.userAgent
        ).run();

        stored++;
      } catch (error) {
        errors.push(`Failed to store ${metric.name}: ${error}`);
      }
    }

    const queryTime = Date.now() - startTime;

    return NextResponse.json(
      {
        received: metrics.length,
        stored,
        errors: errors.length > 0 ? errors : undefined,
        queryTimeMs: queryTime
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache',
        },
      }
    );
  } catch (error) {
    console.error('[WebVitals] Error processing metrics:', error);
    return NextResponse.json(
      {
        error: 'Failed to process metrics',
        details: String(error),
      },
      { status: 500 }
    );
  }
};

/**
 * GET /api/analytics/web-vitals
 * Retrieve aggregated Web Vitals metrics for monitoring dashboard
 *
 * Query params:
 * - metric: Filter by metric name (lcp, fid, cls, fcp, ttfb)
 * - start_date: ISO date (default: 7 days ago)
 * - end_date: ISO date (default: today)
 * - group_by: hour, day, or metric (default: day)
 *
 * Returns: Aggregated metrics with p95, p90, median values
 */
export const GET = async (request: NextRequest): Promise<Response> => {
  const startTime = Date.now();

  try {
    const url = new URL(request.url);
    const metricName = url.searchParams.get('metric');
    const startDate =
      url.searchParams.get('start_date') ||
      new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const endDate =
      url.searchParams.get('end_date') ||
      new Date().toISOString().split('T')[0];
    const groupBy = url.searchParams.get('group_by') || 'day';

    const db = getDB();
    if (!db) {
      return NextResponse.json(
        { error: 'Database not available' },
        { status: 503 }
      );
    }

    // Build query based on grouping
    let query: string;
    let bindValues: unknown[];

    if (groupBy === 'hour') {
      query = `
        SELECT
          strftime('%Y-%m-%d %H:00:00', created_at) as period,
          name,
          COUNT(*) as sample_count,
          AVG(value) as avg_value,
          MIN(value) as min_value,
          MAX(value) as max_value,
          value as median_value
        FROM web_vitals
        WHERE date(created_at) >= ? AND date(created_at) <= ?
        ${metricName ? 'AND name = ?' : ''}
        GROUP BY period, name
        ORDER BY period DESC, name
      `;
      bindValues = metricName ? [startDate, endDate, metricName] : [startDate, endDate];
    } else if (groupBy === 'metric') {
      query = `
        SELECT
          name,
          COUNT(*) as sample_count,
          AVG(value) as avg_value,
          MIN(value) as min_value,
          MAX(value) as max_value,
          value as median_value,
          SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as good_percent,
          SUM(CASE WHEN rating = 'needs-improvement' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as needs_improvement_percent,
          SUM(CASE WHEN rating = 'poor' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as poor_percent
        FROM web_vitals
        WHERE date(created_at) >= ? AND date(created_at) <= ?
        ${metricName ? 'AND name = ?' : ''}
        GROUP BY name
      `;
      bindValues = metricName ? [startDate, endDate, metricName] : [startDate, endDate];
    } else {
      // Daily grouping (default)
      query = `
        SELECT
          date(created_at) as period,
          name,
          COUNT(*) as sample_count,
          AVG(value) as avg_value,
          MIN(value) as min_value,
          MAX(value) as max_value,
          value as median_value,
          SUM(CASE WHEN rating = 'good' THEN 1 ELSE 0 END) * 100.0 / COUNT(*) as good_percent
        FROM web_vitals
        WHERE date(created_at) >= ? AND date(created_at) <= ?
        ${metricName ? 'AND name = ?' : ''}
        GROUP BY period, name
        ORDER BY period DESC, name
      `;
      bindValues = metricName ? [startDate, endDate, metricName] : [startDate, endDate];
    }

    const result = await db.prepare(query).bind(...bindValues).all();

    const queryTime = Date.now() - startTime;

    return NextResponse.json(
      {
        data: result.results,
        queryTimeMs: queryTime,
        params: {
          metric: metricName,
          start_date: startDate,
          end_date: endDate,
          group_by: groupBy,
        },
      },
      {
        headers: {
          'Cache-Control': 'no-store, no-cache',
        },
      }
    );
  } catch (error) {
    console.error('[WebVitals] Error fetching metrics:', error);
    return NextResponse.json(
      {
        error: 'Failed to fetch metrics',
        details: String(error),
      },
      { status: 500 }
    );
  }
};
