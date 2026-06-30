/**
 * Evaluation Metrics API Route
 *
 * Provides metrics and statistics about the alert engine evaluation system:
 * - Evaluation run history and statistics
 * - Rule evaluation performance
 * - Error tracking and classification
 * - Circuit breaker status
 *
 * GET /api/monitoring/evaluation
 *   ?stats=true           - Get evaluation statistics
 *   ?runs=true            - Get recent evaluation runs
 *   ?rules=true           - Get rule performance stats
 *   ?errors=true          - Get error statistics
 *   ?circuit-breakers=true - Get circuit breaker states
 *   ?days=N               - Time period in days (default: 7)
 *
 * POST /api/monitoring/evaluation
 *   ?action=cleanup      - Clean up old evaluation data
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAlertEngine } from '@/lib/monitoring/alert-engine';

// ============================================================================
// GET /api/monitoring/evaluation
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
    const days = Math.min(parseInt(url.searchParams.get('days') || '7', 10), 90); // Cap at 90 days
    const includeStats = url.searchParams.get('stats') === 'true';
    const includeRuns = url.searchParams.get('runs') === 'true';
    const includeRules = url.searchParams.get('rules') === 'true';
    const includeErrors = url.searchParams.get('errors') === 'true';
    const includeCircuitBreakers = url.searchParams.get('circuit-breakers') === 'true';

    const engine = await getAlertEngine(db);
    const response: any = { success: true, data: {} };

    // Get evaluation statistics
    if (includeStats) {
      const stats = await engine.getEvaluationStats(days);
      if (stats) {
        response.data.stats = stats;
      }
    }

    // Get recent evaluation runs
    if (includeRuns) {
      const limit = Math.min(parseInt(url.searchParams.get('runLimit') || '50', 10), 200);
      const runs = await engine.getRecentRuns(limit);
      response.data.runs = runs;
    }

    // Get rule statistics
    if (includeRules) {
      const ruleId = url.searchParams.get('ruleId');
      const ruleStats = await engine.getRuleStats(ruleId || undefined, days);
      response.data.rules = ruleStats;
    }

    // Get error statistics
    if (includeErrors) {
      const errorStats = await engine.getErrorStats();
      response.data.errors = errorStats;
    }

    // Get circuit breaker states
    if (includeCircuitBreakers) {
      const breakerStates = await engine.getCircuitBreakerStates();
      response.data.circuitBreakers = breakerStates;
    }

    // If no specific data requested, return summary
    if (!includeStats && !includeRuns && !includeRules && !includeErrors && !includeCircuitBreakers) {
      const summaryStats = await engine.getEvaluationStats(1);
      const recentRuns = await engine.getRecentRuns(5);
      const breakerStates = await engine.getCircuitBreakerStates();

      response.data = {
        stats: summaryStats,
        recentRuns,
        circuitBreakers: breakerStates,
        config: engine.getConfig(),
      };
    }

    return NextResponse.json(response);
  } catch (error) {
    console.error('Evaluation Metrics API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

// ============================================================================
// POST /api/monitoring/evaluation
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
    const { action } = body as { action?: 'cleanup' | 'run' };
    const engine = await getAlertEngine(db);

    if (action === 'cleanup') {
      const retentionDays = body.retentionDays ?? 90;
      const storage = (engine as any).evaluationStorage;
      if (!storage) {
        return NextResponse.json(
          { success: false, error: 'Evaluation storage not initialized' },
          { status: 503 }
        );
      }

      const result = await storage.cleanupOldData(retentionDays);
      return NextResponse.json({
        success: true,
        data: {
          message: `Cleanup completed: ${result.runsDeleted} runs, ${result.errorsDeleted} errors, ${result.historyDeleted} history records, ${result.metricsDeleted} metrics deleted`,
          ...result,
        },
      });
    }

    if (action === 'run') {
      const alerts = await engine['runCycle']();
      return NextResponse.json({
        success: true,
        data: {
          alertsTriggered: alerts.length,
          alerts: alerts.map(a => ({
            id: a.id,
            ruleName: a.ruleName,
            severity: a.severity,
            metric: a.metric,
            currentValue: a.currentValue,
            triggeredAt: a.triggeredAt.toISOString(),
          })),
        },
      });
    }

    return NextResponse.json(
      { success: false, error: 'Invalid action. Supported: cleanup, run' },
      { status: 400 }
    );
  } catch (error) {
    console.error('Evaluation Metrics API error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}
