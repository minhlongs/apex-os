/**
 * Guards the request the cron entrypoints hand to the dispatcher.
 *
 * `worker-wrapper.js` cannot be imported here: its module graph reaches the
 * OpenNext bundle and `cloudflare:`-protocol imports that only Wrangler can
 * resolve, so neither Jest nor plain Node can load it. The wrapper's cron wiring
 * is therefore a thin boundary over these pure helpers, and what matters
 * behaviourally lives here: which headers a scheduled tick presents, and which
 * presentations the spoofable `fetch()` path accepts.
 *
 * The helper module is CommonJS, so read it through `require` the same way the
 * other plain-JS test subjects in this repo are read.
 */

// eslint-disable-next-line @typescript-eslint/no-var-requires
const cronRequest = require('../worker-cron-request.js') as {
  CRON_INTERNAL_URL: string;
  CRON_SCHEDULE_HEADER: string;
  CRON_TRIGGER_HEADER: string;
  buildCronHeaders: (schedule: string | undefined, cronSecret: string | undefined) => Record<string, string>;
  buildCronRequestDescriptor: (
    schedule: string | undefined,
    cronSecret: string | undefined,
  ) => { url: string; method: string; headers: Record<string, string> };
  isAuthorizedCronRequest: (
    headers: { get: (name: string) => string | null },
    cronSecret: string | undefined,
  ) => boolean;
};

const { buildCronHeaders, buildCronRequestDescriptor, isAuthorizedCronRequest } = cronRequest;

function headersOf(entries: Record<string, string>): Headers {
  return new Headers(entries);
}

describe('cron request headers', () => {
  it('marks a scheduled tick with the trigger and schedule headers', () => {
    const headers = buildCronHeaders('*/5 * * * *', 'secret');
    expect(headers).toEqual({
      'cf-cron-trigger': '1',
      'cf-cron-schedule': '*/5 * * * *',
      authorization: 'Bearer secret',
    });
  });

  it('presents the schedule Cloudflare echoed back, verbatim', () => {
    // The dispatcher compares the header with `===` against the schedule
    // constants, so any normalisation here turns a matching cron into a 400
    // "Unknown cron schedule".
    expect(buildCronHeaders('0 0 * * SUN', 'secret')['cf-cron-schedule']).toBe('0 0 * * SUN');
  });

  it('keeps the header names the dispatcher reads', () => {
    const built = buildCronHeaders('*/30 * * * *', 'secret');
    expect(Object.keys(built)).toEqual([
      cronRequest.CRON_TRIGGER_HEADER,
      cronRequest.CRON_SCHEDULE_HEADER,
      'authorization',
    ]);
  });

  it('falls back to an empty schedule when the event carries none', () => {
    expect(buildCronHeaders(undefined, 'secret')['cf-cron-schedule']).toBe('');
    expect(buildCronHeaders(null, 'secret')['cf-cron-schedule']).toBe('');
  });

  it('omits the bearer prefix when no secret is configured', () => {
    // An empty `Bearer ` would otherwise satisfy the dispatcher's own credential
    // check while meaning nothing.
    expect(buildCronHeaders('*/5 * * * *', '').authorization).toBe('');
    expect(buildCronHeaders('*/5 * * * *', undefined).authorization).toBe('');
  });

  it('builds a GET descriptor for the internal cron URL', () => {
    const descriptor = buildCronRequestDescriptor('*/5 * * * *', 'secret');
    expect(descriptor.url).toBe(cronRequest.CRON_INTERNAL_URL);
    expect(descriptor.method).toBe('GET');
    expect(descriptor.headers['cf-cron-trigger']).toBe('1');
  });
});

describe('cron authorization', () => {
  it('accepts the configured shared secret', () => {
    expect(isAuthorizedCronRequest(headersOf({ authorization: 'Bearer s3cret' }), 's3cret')).toBe(true);
  });

  it('rejects a missing, malformed, or wrong bearer token', () => {
    expect(isAuthorizedCronRequest(headersOf({}), 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest(headersOf({ authorization: 's3cret' }), 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest(headersOf({ authorization: 'Bearer wrong' }), 's3cret')).toBe(false);
    expect(isAuthorizedCronRequest(headersOf({ authorization: 'basic czNjdGV0' }), 's3cret')).toBe(false);
  });

  it('refuses every presentation when no secret is configured', () => {
    // The `cf-cron-trigger` header is externally settable, so an unconfigured
    // deployment must not leave the payout path open to a bare `Bearer `.
    expect(isAuthorizedCronRequest(headersOf({}), '')).toBe(false);
    expect(isAuthorizedCronRequest(headersOf({ authorization: 'Bearer ' }), '')).toBe(false);
    expect(isAuthorizedCronRequest(headersOf({ authorization: 'Bearer anything' }), undefined)).toBe(false);
  });

  it('does not treat the schedule header as a credential', () => {
    expect(
      isAuthorizedCronRequest(
        headersOf({ 'cf-cron-trigger': '1', 'cf-cron-schedule': '0 0 * * SUN' }),
        's3cret',
      ),
    ).toBe(false);
  });
});
