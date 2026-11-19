/**
 * Guards the cron contract between the Worker config and the dispatcher.
 *
 * Cloudflare echoes the configured schedule string back in the
 * `cf-cron-schedule` header, so if the two disagree a job silently never runs.
 * This test makes that disagreement a build failure instead of a mystery.
 */

import fs from 'fs';
import path from 'path';
import {
  CRON_ALERT_ENGINE,
  CRON_D1_METRICS,
  CRON_PARTNER_RECONCILIATION,
  CRON_T7_HOLD_RELEASE,
  CRON_WEEKLY_PAYOUTS,
} from '../worker-cron-schedules.js';

const REPO_ROOT = path.resolve(__dirname, '..');

/** Reads `crons` from wrangler.jsonc by stripping its comments. */
function readConfiguredCrons(): string[] {
  const raw = fs.readFileSync(path.join(REPO_ROOT, 'wrangler.jsonc'), 'utf8');
  const withoutComments = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:"'\\])\/\/.*$/gm, '$1');
  const withoutTrailingCommas = withoutComments.replace(/,(\s*[}\]])/g, '$1');
  const match = /"crons"\s*:\s*(\[[^\]]*\])/.exec(withoutTrailingCommas);
  if (!match) {
    throw new Error('wrangler.jsonc has no "crons" array');
  }
  return (match[1].match(/"([^"]*)"/g) ?? []).map((quoted) => quoted.slice(1, -1));
}

/** Reads the schedule strings the dispatcher actually compares against. */
function readDispatchedCrons(): string[] {
  const wrapper = fs.readFileSync(path.join(REPO_ROOT, 'worker-wrapper.js'), 'utf8');
  const compared = new Set<string>();
  // Matches either a named constant or a quoted literal, and deliberately does
  // not run past the closing paren of the enclosing `if`.
  const pattern = /cronSchedule\s*===\s*([A-Z][A-Z0-9_]*|'[^']*'|"[^"]*")/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(wrapper)) !== null) {
    const expression = match[1].trim();
    if (expression.startsWith("'") || expression.startsWith('"')) {
      compared.add(expression.slice(1, -1));
      continue;
    }
    resolvedForTest(expression, compared);
  }

  return [...compared];
}

function resolvedForTest(name: string, into: Set<string>): void {
  const values: Record<string, string> = {
    CRON_ALERT_ENGINE,
    CRON_D1_METRICS,
    CRON_PARTNER_RECONCILIATION,
    CRON_WEEKLY_PAYOUTS,
    CRON_T7_HOLD_RELEASE,
  };
  const value = values[name];
  if (value !== undefined) {
    into.add(value);
  }
}

describe('cron schedule contract', () => {
  it('declares exactly the five schedules the dispatcher handles', () => {
    expect(readConfiguredCrons().sort()).toEqual([
      CRON_ALERT_ENGINE,
      CRON_D1_METRICS,
      CRON_PARTNER_RECONCILIATION,
      CRON_WEEKLY_PAYOUTS,
      CRON_T7_HOLD_RELEASE,
    ].sort());
  });

  it('dispatches on every configured schedule', () => {
    expect(readDispatchedCrons().sort()).toEqual([
      CRON_ALERT_ENGINE,
      CRON_D1_METRICS,
      CRON_PARTNER_RECONCILIATION,
      CRON_WEEKLY_PAYOUTS,
      CRON_T7_HOLD_RELEASE,
    ].sort());
  });

  it('uses day-of-week forms Cloudflare accepts', () => {
    // Cloudflare follows Quartz rules: 1=Sunday .. 7=Saturday, and 0 is invalid.
    for (const schedule of [CRON_WEEKLY_PAYOUTS]) {
      const dayOfWeek = schedule.split(/\s+/)[4];
      expect(dayOfWeek).not.toBe('0');
      expect(dayOfWeek).toMatch(/^(SUN|MON|TUE|WED|THU|FRI|SAT|[1-7])$/);
    }
  });

  it('never contains the numeric 7 for a Sunday schedule', () => {
    // 7 is Saturday under Quartz rules, so a payout scheduled that way runs on
    // the wrong day while still looking plausible in review.
    expect(CRON_WEEKLY_PAYOUTS).toBe('0 0 * * SUN');
  });
});

describe('cron scheduled entrypoint wiring', () => {
  // worker-wrapper.js cannot be imported in Jest - its module graph reaches the
  // OpenNext bundle and `cloudflare:` protocol imports only Wrangler resolves -
  // so the wiring that would otherwise fail in production as "Handler does not
  // export a scheduled() function" is asserted against the source text.
  const wrapper = fs.readFileSync(path.join(REPO_ROOT, 'worker-wrapper.js'), 'utf8');

  it('exports a scheduled() entrypoint the Cron Trigger runtime can call', () => {
    expect(wrapper).toMatch(/^\s*async scheduled\s*\(/m);
  });

  it('synthesizes the cron request through buildCronRequestDescriptor', () => {
    // The dispatcher reads cf-cron-trigger / cf-cron-schedule from a request, so
    // a scheduled() that instead re-implemented schedule matching would drift
    // from the fetch() path it is supposed to share.
    expect(wrapper).toMatch(/buildCronRequestDescriptor\(/);
  });

  it('hands the descriptor result to the request it builds', () => {
    // Calling the builder and discarding its result would leave the scheduled
    // tick without the schedule header, so every tick would 400 "Unknown cron
    // schedule" while this line still matched on the call alone.
    expect(wrapper).toMatch(/const\s+syntheticRequest\s*=\s*new Request\(\s*descriptor\.url/);
    expect(wrapper).toMatch(/headers:\s*descriptor\.headers/);
  });

  it('authorizes the spoofable fetch() cron path with the shared secret', () => {
    expect(wrapper).toMatch(/isAuthorizedCronRequest\(/);
  });

  it('rejects the fetch() cron path when the guard refuses', () => {
    // The guard's return value must gate the dispatch, not merely be called.
    expect(wrapper).toMatch(/if\s*\(\s*!isAuthorizedCronRequest\(/);
    expect(wrapper).toMatch(/status:\s*401/);
  });

  it('registers the awaited handler with waitUntil', () => {
    // A `throw` outside ctx.waitUntil would leave the cron work unregistered, so
    // the invocation would end before the job ran and the failure would be lost.
    expect(wrapper).toMatch(/return ctx\.waitUntil\(\(async \(\)\s*=>\s*\{/);
    expect(wrapper).toMatch(/const response = await this\.handleCron\(/);
  });

  it('propagates cron failures to Cloudflare instead of resolving them away', () => {
    // Every sub-handler reports failure as a Response, not a rejection, and
    // ctx.waitUntil only records a failure when the promise rejects. Without
    // this the dashboard shows a green tick for a red run.
    expect(wrapper).toMatch(/if\s*\(statusFailure \|\| bodyFailure\)/);
    expect(wrapper).toMatch(/throw new Error\(/);
  });

  it('treats a 200 carrying success:false as a failure', () => {
    // /api/cron?job=payouts answers 200 with `success: false` when a payout batch
    // partially fails, so checking only the status would record that red run as
    // a green cron tick - the exact class of miss this suite exists to prevent.
    expect(wrapper).toMatch(/response\.clone\(\)\.json\(\)/);
    expect(wrapper).toMatch(/body\?\.success === false/);
  });

  it('passes the deployment host so the synthesized origin is routable', () => {
    expect(wrapper).toMatch(/buildCronRequestDescriptor\([\s\S]*FORWARDED_HOST_HEADER/);
    expect(wrapper).toMatch(/import \{[\s\S]*FORWARDED_HOST_HEADER/);
  });

  it('dispatches the hourly T+7 hold release schedule to its own handler', () => {
    // Without a dispatch branch this schedule reaches the unknown-schedule 400,
    // so the holds only ever release as a side effect of the daily poller run.
    expect(wrapper).toMatch(/cronSchedule === CRON_T7_HOLD_RELEASE/);
    expect(wrapper).toMatch(/return this\.handleT7ReleaseCron\(request, env, ctx\)/);
  });

  it('delegates the T+7 hold release to /api/cron?job=t7_release with the cron secret', () => {
    expect(wrapper).toMatch(/async handleT7ReleaseCron\(request, env, ctx\)/);
    expect(wrapper).toMatch(/\/api\/cron\?job=t7_release/);
    expect(wrapper).toMatch(/Authorization: `Bearer \$\{env\.CRON_SECRET \|\| ''\}`/);
  });
});
