/**
 * Regression test: a trade the USDC scale cannot hold exactly stays visible.
 *
 * `0.00000001 BTC` at `33333.33` is worth 0.0003333333 USDC, which is finer than
 * six decimals. No exact commission exists for it, so the conversion is recorded
 * without one. It used to be recorded without any trace of why: the only signal
 * was `total === null`, consumed silently by "create no earnings rows", and the
 * analytics event reported `earnings_count: 0` exactly as it did for a trade
 * whose shopper had no referral tree.
 *
 * The conversion row therefore carries `exact_notional` in its payload, the
 * analytics event carries the same flag, and a line is logged at the boundary.
 * This test imports the REAL handler, signs the payload with the SAME secret the
 * route resolves, and inspects what the route actually bound -- so it fails on
 * the pre-fix code, where the write carried no marker and no log line.
 */

import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';

const BINANCE_SECRET = 'inexact-notional-binance-secret-32b';

/** What the route bound into its INSERT, captured by the DB stub. */
interface CapturedWrite {
  sql: string;
  values: unknown[];
}

const writes: CapturedWrite[] = [];
const warnings: string[] = [];

jest.mock('@/lib/logger', () => ({
  info: jest.fn(),
  warn: jest.fn((message: string) => { warnings.push(String(message)); }),
  error: jest.fn(),
}));

/**
 * The route resolves a deal, a profile and a recent click before it writes, and
 * is wrapped in a rate limiter that reads a KV-backed limiter from the binding,
 * so the stub answers each query the route makes in the order it makes them.
 */
function installDbStub(): void {
  (globalThis as unknown as { DB: unknown }).DB = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => {
        writes.push({ sql, values });
        const normalized = sql.replace(/\s+/g, ' ').trim().toLowerCase();

        // Rate limiter, replay protection, and the processed-marker write.
        if (normalized.includes('webhook_rate') || normalized.includes('replay')) {
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          };
        }
        // The active deal, whose cashback percentage drives the commission.
        if (normalized.startsWith('select') && normalized.includes('from deals')) {
          return {
            first: async () => ({ id: 'deal-1', name: 'Binance Deal', cashback_percent: 10, is_active: 1 }),
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          };
        }
        // The idempotency check: no existing conversion for this order.
        if (normalized.includes('from conversions')) {
          return {
            first: async () => null,
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          };
        }
        // The shopper this trade belongs to.
        if (normalized.includes('from profiles')) {
          return {
            first: async () => ({ id: 'profile-1', email: 'shopper@example.com', full_name: 'Shopper', role: 'shopper', wallet_address: null }),
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          };
        }
        // The referral tree, so a tier is entitled to a share of the commission.
        if (normalized.includes('from referral_tree')) {
          return {
            first: async () => ({ id: 'tree-1', affiliate_id: 'profile-1', parent_id: 'parent-1', level: 3 }),
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          };
        }
        if (normalized.includes('from deal_clicks')) {
          return {
            first: async () => ({ id: 'click-1', affiliate_code: 'AFF1', affiliate_id: 'profile-1' }),
            all: async () => ({ results: [] }),
            run: async () => ({ success: true }),
          };
        }
        // Inserting the conversion and its earnings rows.
        return {
          first: async () => ({ id: 'row-1' }),
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        };
      },
    }),
  };
}

/** Binance signs HMAC-SHA256 over the exact raw body bytes. */
function signBinance(rawBody: string): string {
  return createHmac('sha256', BINANCE_SECRET).update(rawBody, 'utf8').digest('hex');
}

/**
 * A signed Binance fill whose quantity times price is 0.0003333333 USDC --
 * finer than the USDC scale holds, so no exact notional is reported.
 */
function buildInexactRequest(): NextRequest {
  const rawBody = JSON.stringify({
    e: 'executionReport',
    E: Date.now(),
    u: 'inexact-shopper',
    o: {
      s: 'BTCUSDT',
      S: 'BUY',
      i: 77,
      c: 'inexact-order-1',
      l: '0.00000001',
      L: '33333.33',
      n: '0.001',
      N: 'BTC',
      T: Date.now(),
    },
  });

  return new NextRequest('http://localhost:3000/api/webhooks/exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-binance-signature': signBinance(rawBody),
    },
    body: rawBody,
  });
}

/** The conversion INSERT, whose payload column records the marker. */
function conversionWrite(): CapturedWrite {
  const write = writes.find(
    (w) => w.sql.replace(/\s+/g, ' ').trim().toLowerCase().startsWith('insert into conversions')
  );
  if (!write) {
    throw new Error('the route never inserted a conversion');
  }
  return write;
}

describe('an inexact notional reaches the observability surfaces', () => {
  beforeAll(() => {
    process.env.BINANCE_WEBHOOK_SECRET = BINANCE_SECRET;
  });

  beforeEach(() => {
    writes.length = 0;
    warnings.length = 0;
    installDbStub();
  });

  it('marks the conversion so it is distinguishable from no referral tree', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/route');

    const response = await POST(buildInexactRequest());
    expect(response.status).toBe(200);

    // The payload column carries the marker. Its position among the bound
    // values is not asserted; only that the recorded payload says the notional
    // could not be held exactly.
    const payload = conversionWrite()
      .values
      .map((value) => (typeof value === 'string' && value.startsWith('{') ? JSON.parse(value) as Record<string, unknown> : null))
      .find((parsed) => parsed !== null);

    expect(payload).toBeDefined();
    expect(payload?.exact_notional).toBe(false);
  });

  it('logs a line naming the trade, so the zero commission has a cause', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/route');

    await POST(buildInexactRequest());

    // The line names the exchange, the order, and the symbol, so an operator can
    // find the exact fill. Binance reports its exchange order id (`i`), which is
    // what `trade.orderId` carries, so that is the identifier asserted here.
    const line = warnings.find((message) => message.includes('no exact notional'));
    expect(line).toBeDefined();
    expect(line).toContain('binance');
    expect(line).toContain('BTCUSDT');
    expect(line).toContain('77');
  });

  it('still records the conversion, because the trade did happen', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/route');

    const response = await POST(buildInexactRequest());
    const body = await response.json() as { success: boolean; conversionId?: string };

    // The fix is visibility, not rejection: a real trade stays on record with a
    // revenue figure and no commission, rather than being dropped or rounded.
    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.conversionId).toBeDefined();
    expect(conversionWrite().values).toContain('approved');
  });
});
