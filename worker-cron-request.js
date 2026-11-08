/**
 * Cron request construction and authorization for the Worker wrapper.
 *
 * Cloudflare's Cron Trigger runtime invokes `scheduled(event, env, ctx)` with the
 * configured schedule string on `event.cron`; it never sets request headers. The
 * dispatcher inside the wrapper reads `cf-cron-trigger` / `cf-cron-schedule`
 * headers instead, so the scheduled entrypoint has to synthesize that request
 * rather than re-implementing schedule matching.
 *
 * These helpers are pure string and object work with no Cloudflare dependency,
 * so the wrapper stays a thin boundary and the header contract is testable
 * without booting the Workers runtime — the wrapper's own module graph pulls in
 * `cloudflare:`-protocol imports that only Wrangler can resolve.
 */

const CRON_TRIGGER_HEADER = 'cf-cron-trigger';
const CRON_SCHEDULE_HEADER = 'cf-cron-schedule';

/**
 * Host header name the Workers runtime sets on a scheduled invocation.
 *
 * A ScheduledEvent carries no request, so the wrapper has to synthesize one. The
 * synthesized request's origin must be a real deployment origin rather than a
 * placeholder: `runWithCloudflareRequestContext` pins `process.env.OPEN_NEXT_ORIGIN`
 * from the URL of the first request an isolate serves, and the Next middleware
 * reads that value. A hosts-only placeholder therefore leaks into every
 * subsequent response that isolate produces.
 */
const FORWARDED_HOST_HEADER = 'x-forwarded-host';

/**
 * Headers a scheduled tick presents to the dispatcher.
 *
 * The bearer token is filled from the same secret the scheduled invocation
 * carries so both entrypoints authorize identically.
 */
function buildCronHeaders(schedule, cronSecret) {
  return {
    [CRON_TRIGGER_HEADER]: '1',
    [CRON_SCHEDULE_HEADER]: typeof schedule === 'string' ? schedule : '',
    authorization: cronSecret ? `Bearer ${cronSecret}` : '',
  };
}

/**
 * Origin for the synthesized cron request, as `scheme://host`.
 *
 * Prefers the deployment origin the runtime reports, then an explicitly
 * configured public URL, and falls back to the local Workers origin. It never
 * invents a hostname that is not routable, because the payout delegation
 * resolves `/api/cron?job=payouts` against this base.
 */
function buildCronOrigin(forwardedHost, configuredUrl) {
  const candidates = [forwardedHost, configuredUrl];

  for (const candidate of candidates) {
    if (typeof candidate !== 'string') {
      continue;
    }
    const trimmed = candidate.trim();
    if (trimmed === '') {
      continue;
    }
    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        if (parsed.host) {
          return `${parsed.origin}/cron`;
        }
      } catch {
        // Not a parseable absolute URL; fall through to the next candidate.
      }
      continue;
    }
    // `x-forwarded-host` can carry a comma-separated proxy chain; the deployment
    // is the first entry.
    const host = trimmed.split(',')[0].trim();
    // A bare candidate is only a host when it could not be anything else: a
    // space, slash, or port punctuation means a misconfigured URL that lost its
    // scheme, which must not be prefixed and quietly accepted.
    if (host && !/[\s/?#]/.test(host)) {
      return `https://${host}/cron`;
    }
  }

  return 'https://placeholder.invalid/cron';
}

/** Request descriptor for a scheduled tick, before any `Request` construction. */
function buildCronRequestDescriptor(schedule, cronSecret, forwardedHost, configuredUrl) {
  return {
    url: buildCronOrigin(forwardedHost, configuredUrl),
    method: 'GET',
    headers: buildCronHeaders(schedule, cronSecret),
  };
}

/**
 * `cf-cron-trigger` is a request header, so any client can set it and reach the
 * cron path from outside Cloudflare's scheduler. The scheduled entrypoint is
 * trusted because only the runtime can call it; this guard exists to refuse the
 * spoofed `fetch()` route.
 *
 * A missing secret refuses everything: a configured-but-empty secret would
 * otherwise let `Bearer ` through, and an unset one must not silently open the
 * payout path.
 */
function isAuthorizedCronRequest(headers, cronSecret) {
  if (!cronSecret) {
    return false;
  }
  return headers.get('authorization') === `Bearer ${cronSecret}`;
}

module.exports = {
  CRON_TRIGGER_HEADER,
  CRON_SCHEDULE_HEADER,
  FORWARDED_HOST_HEADER,
  buildCronHeaders,
  buildCronOrigin,
  buildCronRequestDescriptor,
  isAuthorizedCronRequest,
};
