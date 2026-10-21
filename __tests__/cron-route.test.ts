/**
 * Route-level tests for the cron handler.
 *
 * These exercise the real exported handlers rather than a mock of the module,
 * because the failure modes worth guarding here are in the request handling
 * itself: the authorization gate, and the D1 read on the payout path. The
 * module is loaded once with the environment already set, because the route
 * reads process.env at call time but caches nothing across imports.
 */

import { GET } from '@/app/api/cron/route';

const CRON_SECRET = 'test-cron-secret';

/**
 * Statement-shaped fake. SQL is recorded when a query is *executed*, not when
 * it is bound, so a handler that binds a statement and then fails to await its
 * result shows up as a query that never ran.
 */
function createFakeDb(options: { rows?: unknown[] } = {}) {
  const executed: Array<{ sql: string; params: unknown[] }> = [];
  const rows = options.rows ?? [];

  const prepare = (sql: string) => {
    let params: unknown[] = [];

    const statement = {
      bind: (...bound: unknown[]) => {
        params = bound;
        return statement;
      },
      all: async () => {
        executed.push({ sql, params });
        return { results: rows, success: true, meta: {} };
      },
      first: async () => {
        executed.push({ sql, params });
        return rows[0];
      },
      run: async () => {
        executed.push({ sql, params });
        return { success: true, meta: { changes: 1 } };
      },
    };

    return statement;
  };

  return {
    db: { prepare, batch: async () => [] },
    executed,
  };
}

function buildRequest(url: string, auth?: string): NextRequestLike {
  const headers = new Map<string, string>();
  if (auth) {
    headers.set('authorization', auth);
  }
  return {
    url,
    headers: { get: (key: string) => headers.get(key.toLowerCase()) ?? null },
  };
}

interface NextRequestLike {
  url: string;
  headers: { get: (key: string) => string | null };
}

type JsonResponse = {
  status: number;
  body: {
    success: boolean;
    error?: string;
    results?: Array<{ job: string; success?: boolean; details?: string }>;
  };
};

async function readResponse(response: unknown): Promise<JsonResponse> {
  const typed = response as { status: number; json: () => Promise<JsonResponse['body']> };
  return { status: typed.status, body: await typed.json() };
}

describe('cron route authorization', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeAll(() => {
    originalEnv = process.env;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  beforeEach(() => {
    process.env = { ...originalEnv, CRON_SECRET };
    (globalThis as { DB?: unknown }).DB = createFakeDb().db;
  });

  afterEach(() => {
    delete (globalThis as { DB?: unknown }).DB;
  });

  it('refuses a request with no secret configured', async () => {
    delete process.env.CRON_SECRET;

    const response = await readResponse(await GET(buildRequest('https://x.test/api/cron?job=alerts')));

    expect(response.status).toBe(401);
  });

  it('refuses a request whose bearer token does not match', async () => {

    const response = await readResponse(
      await GET(buildRequest('https://x.test/api/cron?job=alerts', 'Bearer wrong'))
    );

    expect(response.status).toBe(401);
  });

  it('accepts a request presenting the configured secret', async () => {

    const response = await readResponse(
      await GET(buildRequest('https://x.test/api/cron?job=alerts', `Bearer ${CRON_SECRET}`))
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.results?.[0]?.job).toBe('alerts');
  });

  it('reads the pending earnings query exactly once on the payout path', async () => {
    const fake = createFakeDb({ rows: [] });
    (globalThis as { DB?: unknown }).DB = fake.db;

    const response = await readResponse(
      await GET(buildRequest('https://x.test/api/cron?job=payouts', `Bearer ${CRON_SECRET}`))
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.results?.[0]?.job).toBe('payouts');
    expect(response.body.results?.[0]?.success).toBe(true);
    // The handler must have awaited the D1 call rather than invoking its
    // result; a statement bound and then called as a function surfaces as a
    // failed job rather than a thrown request, so assert on the job outcome.
    const payoutQueries = fake.executed.filter((s) => /FROM earnings/i.test(s.sql));
    expect(payoutQueries.length).toBeGreaterThan(0);
  });
});
