/**
 * Custom Worker Wrapper for Cloudflare
 * Sets globalThis.D* bindings from env for code expecting global scope access
 * then delegates to OpenNext generated worker
 */

import openNextWorker from './.open-next/worker.js';
import {
  CRON_ALERT_ENGINE,
  CRON_D1_METRICS,
  CRON_WEEKLY_PAYOUTS,
} from './worker-cron-schedules.js';
import {
  FORWARDED_HOST_HEADER,
  buildCronRequestDescriptor,
  isAuthorizedCronRequest,
} from './worker-cron-request.js';

// Re-export named exports from OpenNext worker (Durable Objects, etc.)
export { DOQueueHandler, DOShardedTagCache, BucketCachePurge } from './.open-next/worker.js';
export { PaperTradingDurableObject } from './src/lib/paper/worker-do.ts';

export default {
  async fetch(request, env, ctx) {
    // Set bindings on globalThis for OpenNext route handlers
    this.bindEnv(env);

    // Handle cron-triggered payouts.
    //
    // `cf-cron-trigger` is a request header, so a client can spoof it and reach
    // the payout path from outside Cloudflare's scheduler. Require the shared
    // secret that the scheduled invocation is configured to carry, and refuse
    // anything else.
    if (request.headers.get('cf-cron-trigger')) {
      if (!isAuthorizedCronRequest(request.headers, env.CRON_SECRET)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Unauthorized',
        }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return this.handleCron(request, env, ctx);
    }

    // Delegate to OpenNext worker
    return openNextWorker.fetch(request, env, ctx);
  },

  /**
   * Cloudflare Cron Trigger entrypoint. The runtime invokes `scheduled()` for a
   * ScheduledEvent; a Worker that exports only `fetch()` fails every cron tick
   * with "Handler does not export a scheduled() function", so the configured
   * schedules never run at all.
   *
   * `handleCron` reads `cf-cron-trigger` and `cf-cron-schedule` from a request,
   * so synthesize that request from the ScheduledEvent and reuse one dispatcher
   * rather than duplicating the schedule matching here.
   *
   * Every sub-handler reports failure by returning a `Response` rather than by
   * rejecting, and `ctx.waitUntil` only marks an invocation failed when the
   * promise rejects - a resolved `Response` with `ok === false` is recorded as
   * a successful cron run. Await the handler and rethrow on a non-2xx response
   * so an unknown schedule, an unauthorized delegation, or a failing job shows
   * up as `outcome: "exception"` in Cron Trigger history instead of
   * masquerading as success.
   */
  async scheduled(event, env, ctx) {
    this.bindEnv(env);

    const descriptor = buildCronRequestDescriptor(
      event.cron,
      env.CRON_SECRET,
      // The runtime supplies the deployment host on a cron invocation; without it
      // the synthesized request would fall back to an origin that is not routable.
      event.request?.headers?.get?.(FORWARDED_HOST_HEADER) ?? env.CRON_FORWARDED_HOST,
      env.NEXT_PUBLIC_APP_URL
    );
    const syntheticRequest = new Request(descriptor.url, {
      method: descriptor.method,
      headers: descriptor.headers,
    });

    return ctx.waitUntil((async () => {
      const response = await this.handleCron(syntheticRequest, env, ctx);

      // `!response.ok` misses the sub-handler that reports failure in the body:
      // /api/cron answers 200 with `success: false` when a payout batch partially
      // fails, so a red payout run would still record as a green cron tick.
      const statusFailure = !response.ok;

      let bodyFailure = false;
      if (!statusFailure) {
        bodyFailure = await response.clone().json().then(
          (body) => body?.success === false,
          () => false
        );
      }

      if (statusFailure || bodyFailure) {
        throw new Error(
          `Cron ${event.cron || '(unknown schedule)'} failed with status ${response.status}`
        );
      }
      return response;
    })());
  },

  /**
   * Expose the Cloudflare bindings on globalThis so OpenNext route handlers and
   * the imported paper modules can reach them without threading `env` through.
   */
  bindEnv(env) {
    globalThis.env = env;
    if (env.DB) {
      globalThis.DB = env.DB;
    }
    if (env.apex_os_staging_db) {
      globalThis.apex_os_staging_db = env.apex_os_staging_db;
    }
    if (env.KV) {
      globalThis.KV = env.KV;
    }
    if (env.STORAGE) {
      globalThis.STORAGE = env.STORAGE;
    }
    if (env.PAPER_TRADING_DO) {
      globalThis.PAPER_TRADING_DO = env.PAPER_TRADING_DO;
    }
  },

  async handleCron(request, env, ctx) {
    // Determine cron schedule from request headers
    const cronSchedule = request.headers.get('cf-cron-schedule') || '';

    // Execute alert engine evaluation (every 5 minutes)
    if (cronSchedule === CRON_ALERT_ENGINE) {
      return this.handleAlertEngineCron(request, env, ctx);
    }

    // Execute D1 metrics monitoring (every 30 minutes)
    if (cronSchedule === CRON_D1_METRICS) {
      return this.handleMonitoringCron(request, env, ctx);
    }

    // Execute weekly payouts (Sunday at 00:00 UTC)
    if (cronSchedule === CRON_WEEKLY_PAYOUTS) {
      return this.handlePayoutCron(request, env, ctx);
    }

    // Unknown schedule
    return new Response(JSON.stringify({
      success: false,
      error: 'Unknown cron schedule',
      schedule: cronSchedule,
    }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  },

  async handlePayoutCron(request, env, ctx) {
    // Delegate weekly payouts to the single BatchSettlementService authority via /api/cron?job=payouts
    try {
      const db = env.DB;
      if (!db) {
        return new Response('Database not available', { status: 503 });
      }

      if (String(env.AUTO_SETTLE_PAYOUTS || '').toLowerCase() === 'false') {
        return new Response(JSON.stringify({
          success: true,
          message: 'Manual-first rollout: set AUTO_SETTLE_PAYOUTS=true to enable automatic cron payouts',
          processed: 0,
          totalAmount: 0,
          timestamp: new Date().toISOString(),
        }), {
          headers: { 'Content-Type': 'application/json' },
        });
      }

      const cronUrl = new URL('/api/cron?job=payouts', request.url);
      const delegatedRequest = new Request(cronUrl.toString(), {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.CRON_SECRET || ''}`,
        },
      });

      return await openNextWorker.fetch(delegatedRequest, env, ctx);
    } catch (error) {
      console.error('Cron payout execution error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Payout execution failed',
        details: String(error),
        timestamp: new Date().toISOString(),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async handleMonitoringCron(request, env, ctx) {
    // Execute D1 metrics monitoring
    try {
      // Import monitoring module
      const { runMonitoringCycle, collectStorageMetrics } = await import('./src/lib/monitoring/d1-monitor.js');

      const db = env.DB;
      if (!db) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Database not available for monitoring',
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Run monitoring cycle
      const { snapshot, alerts } = await runMonitoringCycle(db);

      // Build summary response
      const storageGB = snapshot.storage.storageBytes / (1024 * 1024 * 1024);
      const storagePercentage = (storageGB / 10) * 100; // Assuming 10GB quota

      const response = {
        success: true,
        timestamp: snapshot.timestamp.toISOString(),
        storage: {
          bytes: snapshot.storage.storageBytes,
          mb: snapshot.storage.storageBytes / 1024 / 1024,
          gb: storageGB,
          percentage: storagePercentage.toFixed(1),
          pageCount: snapshot.storage.pageCount,
        },
        queries: {
          total: snapshot.queryMetrics.totalQueries,
          avgDurationMs: snapshot.queryMetrics.avgDurationMs.toFixed(2),
          maxDurationMs: snapshot.queryMetrics.maxDurationMs,
          slowQueries: snapshot.queryMetrics.slowQueryCount,
          avgRowsScanned: Math.round(snapshot.queryMetrics.avgRowsScanned),
        },
        alerts: alerts.map(a => ({
          id: a.id,
          name: a.details.metricName,
          severity: a.details.severity,
          metricType: a.details.metricType,
          currentValue: a.currentValue,
          thresholdValue: a.thresholdValue,
        })),
        alertCount: alerts.length,
      };

      // If there are alerts, log them prominently
      if (alerts.length > 0) {
        console.warn(`[D1 Monitoring] ${alerts.length} alert(s) triggered:`, alerts.map(a => ({
          name: a.details.metricName,
          severity: a.details.severity,
          value: a.currentValue,
          threshold: a.thresholdValue,
        })));
      }

      return new Response(JSON.stringify(response, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('Cron monitoring execution error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Monitoring execution failed',
        details: String(error),
        timestamp: new Date().toISOString(),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },

  async handleAlertEngineCron(request, env, ctx) {
    // Execute alert engine evaluation every 5 minutes
    try {
      // Import alert engine module
      const { runAlertEngine, getAlertEngine } = await import('./src/lib/monitoring/alert-engine.js');

      const db = env.DB;
      if (!db) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Database not available for alert engine',
        }), {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      // Run alert evaluation cycle
      const alerts = await runAlertEngine(db);

      // Build summary response
      const response = {
        success: true,
        timestamp: new Date().toISOString(),
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
      };

      // Log alerts prominently
      if (alerts.length > 0) {
        console.warn(`[Alert Engine] ${alerts.length} alert(s) triggered:`, alerts.map(a => ({
          rule: a.ruleName,
          severity: a.severity,
          metric: a.metric,
          value: a.currentValue,
          threshold: a.thresholdValue,
        })));
      }

      return new Response(JSON.stringify(response, null, 2), {
        headers: { 'Content-Type': 'application/json' },
      });

    } catch (error) {
      console.error('Cron alert engine execution error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: 'Alert engine execution failed',
        details: String(error),
        timestamp: new Date().toISOString(),
      }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  },
};
