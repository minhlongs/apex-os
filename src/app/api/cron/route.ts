/**
 * Cron Jobs Handler
 *
 * This endpoint handles scheduled jobs triggered by Cloudflare Workers Cron.
 * Configured in wrangler.toml with:
 * - every 5 minutes - Alert evaluation
 * - 0 0 * * 0 - Weekly payouts (Sunday midnight)
 * - every 30 minutes - D1 metrics collection
 * - every 15 minutes - Email queue processing
 * - 0 0 * * 0 - Lifecycle campaign scan
 *
 * Each cron pattern calls this endpoint with a `job` query parameter.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runMonitoringCycle } from '@/lib/monitoring/d1-monitor';
import { runAlertEngine } from '@/lib/monitoring/alert-engine';
import { refreshAnalyticsViews } from '@/lib/analytics/refresh';
import { processEmailQueue, retryFailedEmails } from '@/lib/emails/email-scheduler';
import { runLifecycleCampaigns } from '@/lib/emails/email-campaigns';

// ============================================================================
// Cron Job Handlers
// ============================================================================

async function handleAlertEvaluation(db: any): Promise<{ success: boolean; alerts: number; details: string }> {
  try {
    const alerts = await runAlertEngine(db);
    return {
      success: true,
      alerts: alerts.length,
      details: `Evaluated alert rules, triggered ${alerts.length} alert(s)`,
    };
  } catch (error) {
    return {
      success: false,
      alerts: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleD1MetricsCollection(db: any): Promise<{ success: boolean; alerts: number; details: string }> {
  try {
    const result = await runMonitoringCycle(db);
    return {
      success: true,
      alerts: result.alerts.length,
      details: `Collected metrics snapshot, triggered ${result.alerts.length} alert(s)`,
    };
  } catch (error) {
    return {
      success: false,
      alerts: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleWeeklyPayouts(db: any): Promise<{ success: boolean; details: string }> {
  try {
    return {
      success: true,
      details: 'Weekly payouts job triggered - endpoint implementation pending',
    };
  } catch (error) {
    return {
      success: false,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleEmailQueue(): Promise<{ success: boolean; sent: number; failed: number; details: string }> {
  try {
    const result = await processEmailQueue();
    return {
      success: result.failed === 0 || result.sent > 0,
      sent: result.sent,
      failed: result.failed,
      details: `Processed ${result.processed} emails: ${result.sent} sent, ${result.failed} failed (${result.durationMs}ms)`,
    };
  } catch (error) {
    return {
      success: false,
      sent: 0,
      failed: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleEmailRetry(): Promise<{ success: boolean; sent: number; failed: number; details: string }> {
  try {
    const result = await retryFailedEmails();
    return {
      success: result.failed === 0 || result.sent > 0,
      sent: result.sent,
      failed: result.failed,
      details: `Retried ${result.processed} emails: ${result.sent} sent, ${result.failed} failed (${result.durationMs}ms)`,
    };
  } catch (error) {
    return {
      success: false,
      sent: 0,
      failed: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleLifecycleCampaigns(): Promise<{ success: boolean; sent: number; details: string }> {
  try {
    const result = await runLifecycleCampaigns();
    const total = result.welcomeSeries + result.reEngagement + result.winBack;
    return {
      success: result.errors.length === 0,
      sent: total,
      details: `Campaigns enqueued: ${result.welcomeSeries} welcome, ${result.reEngagement} re-engagement, ${result.winBack} win-back. Errors: ${result.errors.length}`,
    };
  } catch (error) {
    return {
      success: false,
      sent: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleAnalyticsRefresh(db: any): Promise<{ success: boolean; views_refreshed: number; details: string }> {
  try {
    const results = await refreshAnalyticsViews(db);
    const successCount = results.filter((r: { success: boolean }) => r.success).length;
    const allSuccess = successCount === results.length;
    return {
      success: allSuccess,
      views_refreshed: successCount,
      details: `Refreshed ${successCount}/${results.length} analytics views`,
    };
  } catch (error) {
    return {
      success: false,
      views_refreshed: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Main Handler
// ============================================================================

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    // @ts-ignore - D1 binding in Cloudflare Workers
    const db = typeof DB !== 'undefined' ? DB : null;

    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database not configured' },
        { status: 503 }
      );
    }

    const url = new URL(request.url);
    const job = url.searchParams.get('job');

    const cronSecret = process.env.CRON_SECRET;
    const authHeader = request.headers.get('Authorization');
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const results: Array<{ job: string; success: boolean; alerts?: number; sent?: number; failed?: number; views_refreshed?: number; details: string }> = [];

    if (job) {
      switch (job) {
        case 'alerts': {
          const r = await handleAlertEvaluation(db);
          results.push({ job: 'alerts', ...r });
          break;
        }
        case 'd1-metrics': {
          const r = await handleD1MetricsCollection(db);
          results.push({ job: 'd1-metrics', ...r });
          break;
        }
        case 'payouts': {
          const r = await handleWeeklyPayouts(db);
          results.push({ job: 'payouts', ...r });
          break;
        }
 case 'analytics-refresh': {
   const r = await handleAnalyticsRefresh(db);
   results.push({ job: 'analytics-refresh', ...r });
   break;
 }
        case 'email-queue': {
          const r = await handleEmailQueue();
          results.push({ job: 'email-queue', ...r });
          break;
        }
        case 'email-retry': {
          const r = await handleEmailRetry();
          results.push({ job: 'email-retry', ...r });
          break;
        }
        case 'campaigns': {
          const r = await handleLifecycleCampaigns();
          results.push({ job: 'campaigns', ...r });
          break;
        }
        default:
          return NextResponse.json(
            { success: false, error: `Unknown job: ${job}` },
            { status: 400 }
          );
      }
    } else {
      const alertEval = await handleAlertEvaluation(db);
      results.push({ job: 'alerts', ...alertEval });

      const d1Metrics = await handleD1MetricsCollection(db);
      results.push({ job: 'd1-metrics', ...d1Metrics });

      const weeklyPayouts = await handleWeeklyPayouts(db);
      results.push({ job: 'payouts', ...weeklyPayouts });
 const analyticsRefresh = await handleAnalyticsRefresh(db);
 results.push({ job: 'analytics-refresh', ...analyticsRefresh });

      const emailQueue = await handleEmailQueue();
      results.push({ job: 'email-queue', ...emailQueue });

      const emailRetry = await handleEmailRetry();
      results.push({ job: 'email-retry', ...emailRetry });

      const campaigns = await handleLifecycleCampaigns();
      results.push({ job: 'campaigns', ...campaigns });

    const allSuccessful = results.every((r) => r.success);

    return NextResponse.json({
      success: allSuccessful,
      timestamp: new Date().toISOString(),
      results,
    });
    }
  } catch (error) {
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  return GET(request);
}
