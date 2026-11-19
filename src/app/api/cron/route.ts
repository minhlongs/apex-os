/**
 * Cron Jobs Handler
 *
 * This endpoint handles scheduled jobs triggered by Cloudflare Workers Cron.
 * The schedule strings are defined once in worker-cron-schedules.js and
 * mirrored into the `crons` array of wrangler.jsonc: every 5 minutes for alert
 * evaluation, every 30 minutes for D1 metrics collection, and Sunday midnight
 * UTC for weekly payouts.
 *
 * Each cron pattern calls this endpoint with a `job` query parameter.
 *
 * Authorization: this route moves money and sends notifications, so it never
 * runs unauthenticated. When CRON_SECRET is not configured the request is
 * refused rather than allowed, because a missing secret is a deployment error
 * and an open trigger is the worse outcome.
 */

import { NextRequest, NextResponse } from 'next/server';
import { runMonitoringCycle } from '@/lib/monitoring/d1-monitor';
import { evaluateBusinessAlerts } from '@/lib/notifications/business-alert-engine';
import { refreshAnalyticsViews } from '@/lib/analytics/refresh';
import { processEmailQueue, retryFailedEmails } from '@/lib/emails/email-scheduler';
import { runLifecycleCampaigns } from '@/lib/emails/email-campaigns';
import {
  BatchSettlementService,
  reconcilePendingSettlementBroadcasts,
} from '@/lib/payouts';
import {
  DoubleEntryLedgerService,
  LedgerFrozenError,
  type R2BucketLike,
} from '@/lib/ledger';
import { runPartnerPollerCycle } from '@/lib/partners';
import { error as logError } from '@/lib/logger';

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

    const autoSettle = process.env.AUTO_SETTLE_PAYOUTS?.trim().toLowerCase();
    const isProd =
      process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production';
    let hasAuditedLedger = false;
    try {
      const sentinel = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'settlement_broadcasts' LIMIT 1"
        )
        .first();
      hasAuditedLedger = Boolean(sentinel?.name === 'settlement_broadcasts');
    } catch {
      hasAuditedLedger = false;
    }

    if (hasAuditedLedger || autoSettle === 'false' || (isProd && autoSettle !== 'true')) {
      return {
        success: true,
        processed: 0,
        totalAmount: 0,
        details: hasAuditedLedger
          ? 'Phase 1 Turnkey HSM + Passkey step-up active: legacy raw-key cron payouts disabled in favor of /api/admin/settlement/dispatch'
          : 'Manual-first rollout: set AUTO_SETTLE_PAYOUTS=true to enable automatic cron payouts',
      };
    }

    // The batch settlement service owns the whole cycle: it selects the
    // eligible affiliates, reserves their earnings atomically, performs the
    // transfer, then reconciles the ledger from the on-chain verdict. Earnings
    // become paid only on a confirmed broadcast, so the cron schedules money
    // without ever asserting that money moved.
    const result = await new BatchSettlementService({ db }).executeBatch({
      chain: 'stellar',
      minThreshold: 10,
    });

    const totalAmount = result.totalAmount;
    const failed = result.failedPayouts;

    if (failed > 0) {
      logError(
        `[Payouts:Cron] ${failed} payout(s) failed of ${result.totalPayouts} attempted`
      );
    }

    if (result.totalPayouts === 0) {
      return {
        success: true,
        processed: 0,
        totalAmount: 0,
        details: 'No payouts above minimum threshold found',
      };
    }

    return {
      success: failed === 0,
      processed: result.successfulPayouts,
      totalAmount,
      details: `Processed ${result.successfulPayouts} payouts totaling ${totalAmount.toFixed(2)} USDC${failed > 0 ? `, ${failed} failed` : ''}`,
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

async function handlePartnerReconciliation(
  db: any
): Promise<{ success: boolean; minted_batches: number; fetched_rows: number; details: string }> {
  try {
    const bindings = globalThis as unknown as {
      STORAGE?: R2BucketLike;
      env?: Record<string, string | undefined>;
    };
    const cycle = await runPartnerPollerCycle({
      db,
      r2: bindings.STORAGE ?? null,
      env: bindings.env,
      triggerSource: 'cron',
    });

    const mintedBatches = cycle.runs.reduce((acc, r) => acc + r.mintedBatches, 0);
    const fetchedRows = cycle.runs.reduce((acc, r) => acc + r.fetchedRows, 0);
    const failedRuns = cycle.runs.filter(
      (r) => r.status === 'ERROR' || r.status === 'DISCREPANCY_HALTED'
    );
      const perExchangeSummary = cycle.runs
      .map((r) => `${r.exchange}:${r.mode}/${r.status}(rows=${r.fetchedRows},minted=${r.mintedBatches})`)
      .join(', ');

    const t7Release = await handleT7HoldRelease(db);

    return {
      success: failedRuns.length === 0 && t7Release.success,
      minted_batches: mintedBatches,
      fetched_rows: fetchedRows,
      details: `Partner HTTP poller completed (${perExchangeSummary}); T+7 release: ${t7Release.details}`,
    };
  } catch (error) {
    logError('Partner reconciliation cron error', error);
    return {
      success: false,
      minted_batches: 0,
      fetched_rows: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

/**
 * Releases `COMMISSION_INFLIGHT` batches whose T+7 `hold_until` has elapsed.
 *
 * `hold_until <= now` is a property of the row, not of the caller, so the query
 * is the authority on maturity. A freeze halts the whole ledger, so the first
 * `LedgerFrozenError` ends the run: continuing would keep throwing for every
 * remaining batch and bury the real cause in a wall of identical failures.
 */
async function handleT7HoldRelease(
  db: any
): Promise<{ success: boolean; released: number; failed: number; details: string }> {
  try {
    if (!db) {
      return {
        success: false,
        released: 0,
        failed: 0,
        details: 'Database not available',
      };
    }

    let hasAuditedLedger = false;
    try {
      const sentinel = await db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ledger_journal_batches' LIMIT 1"
        )
        .first();
      hasAuditedLedger = Boolean(sentinel?.name === 'ledger_journal_batches');
    } catch {
      hasAuditedLedger = false;
    }

    if (!hasAuditedLedger) {
      return {
        success: true,
        released: 0,
        failed: 0,
        details: 'Audited ledger table not initialized',
      };
    }

    const nowIso = new Date().toISOString();
    const matured = (await db
      .prepare(
        `SELECT id FROM ledger_journal_batches
         WHERE journal_type = 'COMMISSION_INFLIGHT'
           AND status = 'INFLIGHT'
           AND hold_until IS NOT NULL
           AND hold_until <= ?
         ORDER BY hold_until ASC
         LIMIT 200`
      )
      .bind(nowIso)
      .all()) as { results?: Array<{ id: string }> };

    const maturedIds = matured.results ?? [];
    const ledger = new DoubleEntryLedgerService(db);
    let released = 0;
    let failed = 0;

    for (const row of maturedIds) {
      try {
        await ledger.releaseMaturedInflightBatch(row.id, nowIso);
        released += 1;
      } catch (err) {
        if (err instanceof LedgerFrozenError) {
          return {
            success: true,
            released,
            failed,
            details: 'Skipped T+7 hold release: EMERGENCY_LEDGER_FREEZE active',
          };
        }
        failed += 1;
        logError(`[T7HoldRelease] Failed to release batch ${row.id}`, err);
      }
    }

    let reconcileNote = '';
    try {
      const reconciled = await reconcilePendingSettlementBroadcasts(db);
      if (reconciled.scanned > 0) {
        reconcileNote = `; settlement broadcasts scanned=${reconciled.scanned}, confirmed=${reconciled.confirmed}, reverted=${reconciled.reverted}, pending=${reconciled.stillPending}`;
      }
    } catch (reconcileErr) {
      logError('[T7HoldRelease] Passive settlement broadcast reconciliation error', reconcileErr);
    }

    return {
      success: failed === 0,
      released,
      failed,
      details:
        (maturedIds.length === 0
          ? 'No matured T+7 hold batches found'
          : `Released ${released} matured T+7 hold batch(es)${failed > 0 ? `, ${failed} failed` : ''}`) +
        reconcileNote,
    };
  } catch (error) {
    logError('T+7 hold release cron error', error);
    return {
      success: false,
      released: 0,
      failed: 0,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

async function handleSettlementReconciliation(db: any): Promise<{
  success: boolean;
  released: number;
  failed: number;
  details: string;
}> {
  try {
    const summary = await reconcilePendingSettlementBroadcasts(db);
    if (summary.scanned === 0) {
      return {
        success: true,
        released: 0,
        failed: 0,
        details: 'No pending settlement broadcasts to reconcile',
      };
    }
    if (summary.skippedNoMachine) {
      return {
        success: true,
        released: 0,
        failed: 0,
        details: `Skipped ${summary.scanned} pending settlement broadcast(s): settlement signer/RPC not configured`,
      };
    }
    return {
      success: summary.errors.length === 0,
      released: summary.confirmed + summary.reverted,
      failed: summary.errors.length,
      details: `Reconciled ${summary.scanned} pending settlement broadcast(s): confirmed=${summary.confirmed}, reverted=${summary.reverted}, still_pending=${summary.stillPending}${summary.errors.length > 0 ? `, errors=${summary.errors.length}` : ''}`,
    };
  } catch (error) {
    logError('Settlement broadcast reconciliation cron error', error);
    return {
      success: false,
      released: 0,
      failed: 1,
      details: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  const maxLength = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < maxLength; i += 1) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
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
    if (!cronSecret || !authHeader || !constantTimeEqual(authHeader, `Bearer ${cronSecret}`)) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const results: Array<{
      job: string;
      success: boolean;
      alerts?: number;
      sent?: number;
      failed?: number;
      released?: number;
      views_refreshed?: number;
      minted_batches?: number;
      fetched_rows?: number;
      details: string;
    }> = [];

    if (job) {
      switch (job) {
        case 'alerts': {
          const r = await handleAlertEvaluation(db);
          results.push({ job: 'alerts', ...r });
          break;
        }
        case 'monitoring':
        case 'd1-metrics': {
          const r = await handleD1MetricsCollection(db);
          results.push({ job, ...r });
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
        case 'partner_reconciliation':
        case 'partner-reconciliation': {
          const r = await handlePartnerReconciliation(db);
          results.push({ job: 'partner_reconciliation', ...r });
          break;
        }
        case 't7_release':
        case 't7-release': {
          const r = await handleT7HoldRelease(db);
          results.push({ job: 't7_release', ...r });
          break;
        }
        case 'settlement_reconcile':
        case 'settlement-reconcile': {
          const r = await handleSettlementReconciliation(db);
          results.push({ job: 'settlement_reconcile', ...r });
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
