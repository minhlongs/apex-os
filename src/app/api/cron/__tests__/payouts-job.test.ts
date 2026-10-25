/**
 * src/app/api/cron/__tests__/payouts-job.test.ts
 *
 * Pins the contract between the weekly payout cron job and the batch
 * settlement service.
 *
 * The cron delegates the whole cycle to `executeBatch`: selecting affiliates,
 * reserving earnings, performing the transfer and reconciling the ledger from
 * the on-chain verdict. It must not select, reserve, or retire earnings itself.
 * These tests defend that delegation, because a reverted inline implementation
 * would pass every test in the settlement service's own suite while silently
 * restoring the defect the cron is supposed to be free of.
 */

import { GET } from '../route';

// ============================================================================
// Harness
// ============================================================================

interface BatchCall {
  options?: Record<string, unknown>;
}

let batchCall: BatchCall;
let batchResult: Record<string, unknown>;
let batchThrow: Error | null;

const serviceDeps: unknown[] = [];

jest.mock('@/lib/payouts', () => ({
  ...jest.requireActual('@/lib/payouts'),
  BatchSettlementService: jest.fn().mockImplementation((deps?: { db?: unknown }) => {
    serviceDeps.push(deps);
    return {
      executeBatch: jest.fn(async (options?: Record<string, unknown>) => {
        batchCall = { options };
        if (batchThrow) throw batchThrow;
        return batchResult;
      }),
    };
  }),
}));

/** Minimal D1 stub: the cron only checks that a binding is present. */
function createDbStub(): unknown {
  return {};
}

function buildRequest(job: string): Request {
  return new Request(`https://apex-os.com/api/cron?job=${job}`, {
    headers: { Authorization: `Bearer ${process.env.CRON_SECRET}` },
  });
}

beforeEach(() => {
  batchCall = { options: undefined };
  batchThrow = null;
  batchResult = {
    totalPayouts: 2,
    successfulPayouts: 2,
    failedPayouts: 0,
    totalAmount: 120,
    payouts: [],
  };
  serviceDeps.length = 0;
  (globalThis as { DB?: unknown }).DB = createDbStub();
  process.env.CRON_SECRET = 'test-secret';
});

afterEach(() => {
  delete (globalThis as { DB?: unknown }).DB;
});

// ============================================================================
// Delegation
// ============================================================================

describe('weekly payouts job', () => {
  it('runs the settlement cycle through executeBatch', async () => {
    const response = await GET(buildRequest('payouts') as never);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.results[0].job).toBe('payouts');
    expect(batchCall.options).toBeDefined();
    expect(body.results[0].success).toBe(true);
  });

  it('passes the request-scoped binding to the service, not a shared global', async () => {
    const db = createDbStub();
    (globalThis as { DB?: unknown }).DB = db;

    await GET(buildRequest('payouts') as never);

    expect(serviceDeps).toHaveLength(1);
    expect((serviceDeps[0] as { db: unknown }).db).toBe(db);
  });

  it('applies the earnings floor so sub-threshold balances are not paid', async () => {
    await GET(buildRequest('payouts') as never);

    expect(batchCall.options).toMatchObject({ minThreshold: 10 });
  });

  it('reports the unsettled count as a failure so the run is not silently green', async () => {
    batchResult = { totalPayouts: 3, successfulPayouts: 1, failedPayouts: 2, totalAmount: 60, payouts: [] };

    const response = await GET(buildRequest('payouts') as never);
    const body = await response.json();

    expect(body.results[0].success).toBe(false);
    expect(body.results[0].processed).toBe(1);
    expect(body.success).toBe(false);
  });

  it('treats an empty eligible set as success with nothing processed', async () => {
    batchResult = { totalPayouts: 0, successfulPayouts: 0, failedPayouts: 0, totalAmount: 0, payouts: [] };

    const response = await GET(buildRequest('payouts') as never);
    const body = await response.json();

    expect(body.results[0].success).toBe(true);
    expect(body.results[0].processed).toBe(0);
  });

  it('surfaces a settlement error instead of reporting a clean run', async () => {
    batchThrow = new Error('treasury health unavailable');

    const response = await GET(buildRequest('payouts') as never);
    const body = await response.json();

    expect(body.results[0].success).toBe(false);
    expect(body.results[0].details).toContain('treasury health unavailable');
  });

  it('skips automatic batch settlement when AUTO_SETTLE_PAYOUTS=false (manual-first rollout)', async () => {
    const prev = process.env.AUTO_SETTLE_PAYOUTS;
    process.env.AUTO_SETTLE_PAYOUTS = 'false';
    try {
      const response = await GET(buildRequest('payouts') as never);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.results[0].success).toBe(true);
      expect(body.results[0].processed).toBe(0);
      expect(body.results[0].details).toContain('Manual-first rollout');
      expect(batchCall.options).toBeUndefined();
    } finally {
      if (prev === undefined) delete process.env.AUTO_SETTLE_PAYOUTS;
      else process.env.AUTO_SETTLE_PAYOUTS = prev;
    }
  });
});
