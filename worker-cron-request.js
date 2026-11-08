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
const CRON_INTERNAL_URL = 'http://internal/cron';

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

/** Request descriptor for a scheduled tick, before any `Request` construction. */
function buildCronRequestDescriptor(schedule, cronSecret) {
  return {
    url: CRON_INTERNAL_URL,
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
  CRON_INTERNAL_URL,
  buildCronHeaders,
  buildCronRequestDescriptor,
  isAuthorizedCronRequest,
};
