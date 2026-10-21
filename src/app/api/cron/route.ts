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
import { evaluateBusinessAlerts } from '@/lib/notifications/business-alert-engine';
import { refreshAnalyticsViews } from '@/lib/analytics/refresh';
import { processEmailQueue, retryFailedEmails } from '@/lib/emails/email-scheduler';
import { runLifecycleCampaigns } from '@/lib/emails/email-campaigns';
import { createPayoutsService } from '@/lib/payouts';
import { error as logError, warn as logWarn, info as logInfo } from '@/lib/logger';

// ============================================================================
// Cron Job Handlers
// ============================================================================

async function handleAlertEvaluation(db: any): Promise<{ success: boolean; alerts: number; details: string }> {
  try {
    const result = await evaluateBusinessAlerts(db);
    return {
      success: true,
      alerts: result.triggered.length,
      details: `Evaluated alert rules, triggered ${result.triggered.length} alert(s), skipped ${result.skipped.length}`,
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

async function handleWeeklyPayouts(
  db: any
): Promise<{ success: boolean; processed: number; totalAmount: number; details: string }> {
  try {
    if (!db) {
      return {
        success: false,
        processed: 0,
        totalAmount: 0,
        details: 'Database not available',
      };
    }

    const MIN_PAYOUT_THRESHOLD = 10.0;
    const FEE_RATE = 0.01;

    const pendingEarningsQuery = `
      SELECT e.affiliate_id, SUM(e.amount) as total_amount, GROUP_CONCAT(e.id) as earning_ids
      FROM earnings e
      WHERE e.is_paid = 0
      GROUP BY e.affiliate_id
      HAVING total_amount >= ?
    `;

    const pendingResults = await db
      .prepare(pendingEarningsQuery)
      .bind(MIN_PAYOUT_THRESHOLD)
      .all()();

    if (pendingResults.results.length === 0) {
      return {
        success: true,
        processed: 0,
        totalAmount: 0,
        details: 'No payouts above minimum threshold found',
      };
    }

    const affiliateIds = pendingResults.results.map((r: { affiliate_id: string }) => r.affiliate_id);
    const placeholders = affiliateIds.map(() => '?').join(',');
    const affiliates = await db
      .prepare(
        `SELECT id, email, full_name, payout_method, payout_method_details FROM profiles WHERE id IN (${placeholders})`
      )
      .bind(...affiliateIds)
      .all()();

    interface AffiliateProfileRow {
      id: string;
      email: string;
      full_name: string | null;
      payout_method: string | null;
      payout_method_details: string | null;
    }

    const affiliateMap = new Map(
      affiliates.results.map((a: AffiliateProfileRow) => [a.id, a] as const)
    );
    const payoutsService = createPayoutsService(db);
    const results: Array<{
      affiliate_id: string;
      affiliate_email: string;
      amount: number;
      payout_id: string;
    }> = [];
    let totalPayoutAmount = 0;

    for (const pending of pendingResults.results) {
      const affiliate = affiliateMap.get(pending.affiliate_id) as {
        id: string;
        email: string;
        full_name: string | null;
        payout_method: string | null;
        payout_method_details: string | null;
      } | undefined;
      if (!affiliate) {
        logWarn(
          `[Payouts:Cron] Affiliate not found: ${pending.affiliate_id}`
        );
        continue;
      }

      const payoutMethod = affiliate.payout_method || 'crypto';
      const payoutDetails = affiliate.payout_method_details
        ? JSON.parse(affiliate.payout_method_details)
        : {};

      try {
        const netAmount = pending.total_amount * (1 - FEE_RATE);
        const payout = await payoutsService.createPayout({
          affiliate_id: pending.affiliate_id,
          payout_method: payoutMethod as
            | 'crypto'
            | 'sepay'
            | 'bank_transfer',
          payout_method_details: payoutDetails,
          amount: pending.total_amount,
          net_amount: netAmount,
          currency: 'USDC',
          fee: pending.total_amount * FEE_RATE,
          scheduled_at: new Date().toISOString(),
          status: 'processing',
          notes: `Auto-generated payout for ${pending.earning_ids.split(',').length} earnings`,
        });

        const earningIds = pending.earning_ids.split(',');
        for (const earningId of earningIds) {
          await db
            .prepare(
              'UPDATE earnings SET is_paid = 1, paid_at = datetime("now"), payout_id = ? WHERE id = ?'
            )
            .bind(payout.id, earningId)
            .run();
        }

        results.push({
          affiliate_id: pending.affiliate_id,
          affiliate_email: affiliate.email,
          amount: pending.total_amount,
          payout_id: payout.id,
        });
        totalPayoutAmount += pending.total_amount;
      } catch (error) {
        logError(
          `[Payouts:Cron] Failed to create payout for ${pending.affiliate_id}:`,
          error
        );
      }
    }

    logInfo(
      `[Payouts:Cron] Processed ${results.length} payouts, total ${totalPayoutAmount} USDC`
    );

    // Sprint 4: Queue payout-sent emails (non-blocking)
    for (const result of results) {
      void (async () => {
        try {
          const affiliate = affiliateMap.get(
            result.affiliate_id
          ) as { email?: string; full_name?: string } | undefined;
          if (!affiliate?.email) return;
          const { payoutCompletedTemplate } = await import(
            '@/lib/emails/templates'
          );
          const { getEmailQueueService } = await import(
            '@/lib/emails/email-queue'
          );
          const html = payoutCompletedTemplate({
            userName: affiliate.full_name || 'Affiliate',
            userEmail: affiliate.email,
            locale: 'en',
            baseUrl:
              process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.com',
            amount: Number(result.amount ?? 0),
            transactionHash: result.payout_id,
            walletAddress: '',
            network: 'testnet',
            payoutDate: new Date().toISOString(),
            explorerUrl: '',
          });
          void getEmailQueueService().enqueue({
            userId: result.affiliate_id,
            email: affiliate.email,
            type: 'payout-sent',
            subject: `Payout processed: ${Number(result.amount ?? 0).toFixed(2)} USDC`,
            html,
            text: '',
            priority: 1,
            metadata: {
              payoutId: result.payout_id,
              amount: Number(result.amount ?? 0),
            },
          });
        } catch {
          // non-blocking
        }
      })();
    }

    return {
      success: true,
      processed: results.length,
      totalAmount: totalPayoutAmount,
      details: `Processed ${results.length} payouts totaling ${totalPayoutAmount.toFixed(2)} USDC`,
    };
  } catch (error) {
    return {
      success: false,
      processed: 0,
      totalAmount: 0,
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
    }

    const allSuccessful = results.every((r) => r.success);

    return NextResponse.json({
      success: allSuccessful,
      timestamp: new Date().toISOString(),
      results,
    });
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
