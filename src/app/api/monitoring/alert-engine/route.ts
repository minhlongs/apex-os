/**
 * Alert Engine API Route
 *
 * Enhanced with evaluation state persistence, error handling, and circuit breaker monitoring
 *
 * GET /api/monitoring/alert-engine
 *   - Run alert evaluation cycle (?run=true)
 *   - Get alert engine status (?stats=true, ?errors=true, &circuit-breakers=true)
 *
 * POST /api/monitoring/alert-engine
 *   - Trigger alert evaluation cycle
 *   - Manage alert rules
 *   - Reset circuit breaker (?action=reset-breaker&name=...)
 *
 * This endpoint is called by Cloudflare Workers Cron every 5 minutes:
 *   (every 5 minutes)
 */

import { NextRequest, NextResponse } from 'next/server';
import { runAlertEngine, getAlertRules, getAlertEngine } from '@/lib/monitoring/alert-engine';
import type { EvaluationStats, CircuitBreakerEntry } from '@/types/evaluation-state';
import { error as logError } from '@/lib/logger';

// ============================================================================
// GET /api/monitoring/alert-engine
// ============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore - D1 binding
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const shouldRun = url.searchParams.get('run') === 'true';
    const includeStats = url.searchParams.get('stats') === 'true';
    const includeErrors = url.searchParams.get('errors') === 'true';
    const includeCircuitBreakers = url.searchParams.get('circuit-breakers') === 'true';
    const days = parseInt(url.searchParams.get('days') || '7', 10);

    if (shouldRun) {
      const alerts = await runAlertEngine(db);

      return NextResponse.json({
        success: true,
        data: {
          alertsTriggered: alerts.length,
          alerts: alerts.map(a => ({
            id: a.id,
            ruleId: a.ruleId,
            ruleName: a.ruleName,
            severity: a.severity,
            metric: a.metric,
            currentValue: a.currentValue,
            thresholdValue: a.thresholdValue,
            triggeredAt: a.triggeredAt.toISOString(),
            channels: a.channels,
            status: a.status,
          })),
        },
      });
    }

    // Get engine instance for detailed stats
    const engine = await getAlertEngine(db);
    const rules = await getAlertRules(db);

    const response: any = {
      success: true,
      data: {
        rules: rules.filter(r => r.isEnabled).length,
        totalRules: rules.length,
        enabledRules: rules.filter(r => r.isEnabled).map(r => ({
          id: r.id,
          name: r.name,
          source: r.source,
          metric: r.metric,
          severity: r.severity,
          channels: r.channels,
        })),
        config: engine.getConfig(),
        lastRun: engine.getLastRun()?.toISOString() || null,
        isEvaluating: engine.isEvaluating(),
        currentRunId: engine.getCurrentRunId() || null,
      },
    };

    // Include evaluation statistics if requested
    if (includeStats) {
      const stats = await engine.getEvaluationStats(days);
      if (stats) {
        response.data.evaluationStats = stats;
      }
    }

    // Include error statistics if requested
    if (includeErrors) {
      const errorStats = await engine.getErrorStats();
      response.data.errorStats = errorStats;

      // Also include recent failed runs
      const recentFailed = await engine.getRecentRuns(10);
      response.data.recentRuns = recentFailed.filter(r => r.status === 'failed' || r.status === 'partial_failure');
    }

    // Include circuit breaker states if requested
    if (includeCircuitBreakers) {
      const breakerStates = await engine.getCircuitBreakerStates();
      response.data.circuitBreakers = breakerStates;
    }

    return NextResponse.json(response);
  } catch (error) {
    logError('Alert Engine API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST /api/monitoring/alert-engine
// ============================================================================

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore - D1 binding
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const body = await request.json();
    const { action } = body as { action?: 'run' | 'status' | 'reset-breaker' | 'reset-all-breakers' };
    const engine = await getAlertEngine(db);

    if (action === 'run' || !action) {
      // Run alert evaluation cycle
      const alerts = await runAlertEngine(db);

      return NextResponse.json({
        success: true,
        data: {
          alertsTriggered: alerts.length,
          alerts: alerts.map(a => ({
            id: a.id,
            ruleId: a.ruleId,
            ruleName: a.ruleName,
            severity: a.severity,
            metric: a.metric,
            currentValue: a.currentValue,
            thresholdValue: a.thresholdValue,
            triggeredAt: a.triggeredAt.toISOString(),
            channels: a.channels,
            status: a.status,
          })),
        },
      });
    }

    if (action === 'status') {
      const rules = await getAlertRules(db);
      return NextResponse.json({
        success: true,
        data: {
          totalRules: rules.length,
          enabledRules: rules.filter(r => r.isEnabled).length,
          lastRun: engine.getLastRun()?.toISOString() || null,
          isEvaluating: engine.isEvaluating(),
          config: engine.getConfig(),
        },
      });
    }

    if (action === 'reset-breaker') {
      const { name } = body as { name: string };
      if (!name) {
        return NextResponse.json(
          { success: false, error: 'Circuit breaker name required' },
          { status: 400 }
        );
      }
      await engine.resetCircuitBreaker(name);
      return NextResponse.json({
        success: true,
        data: { message: `Circuit breaker '${name}' reset successfully` },
      });
    }

    if (action === 'reset-all-breakers') {
      await (engine as any).resetAllCircuitBreakers?.();
      return NextResponse.json({
        success: true,
        data: { message: 'All circuit breakers reset successfully' },
      });
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action' },
      { status: 400 }
    );
  } catch (error) {
    logError('Alert Engine API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
