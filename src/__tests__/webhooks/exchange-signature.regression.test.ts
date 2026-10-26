/**
 * Regression test: exchange webhook body-read ordering.
 *
 * A Request body is a single-use stream. Reading `await request.json()`
 * before `await request.text()` consumes the stream, so the HMAC is then
 * computed over '' and every legitimately signed webhook is rejected.
 *
 * This test imports the REAL route handler and builds a genuinely signed
 * payload, so it fails on the old ordering and passes only when the raw
 * bytes reach the signature check.
 */

import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';

const EXCHANGE_SECRET = 'regression-binance-secret-key-32b';

jest.mock('@/lib/webhooks/crypto', () => {
  const actual = jest.requireActual('@/lib/webhooks/crypto');
  return { ...actual };
});

// Binance signs HMAC-SHA256 of the exact raw body bytes.
function signBinance(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

function buildSignedBinanceRequest(secret: string): NextRequest {
  const rawBody = JSON.stringify({
    e: 'executionReport',
    E: Date.now(),
    o: { i: 1, c: 'regression-1' },
  });
  const signature = signBinance(rawBody, secret);
  return new NextRequest('http://localhost:3000/api/webhooks/exchange', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-binance-signature': signature,
    },
    body: rawBody,
  });
}

describe('exchange webhook signature verification (real handler)', () => {
  // The route resolves its secret from the environment, so the test must
  // publish the same secret it signs with. The handler is also wrapped in
  // withRateLimit, which resolves a KV-backed limiter from the D1 binding.
  beforeAll(() => {
    process.env.BINANCE_WEBHOOK_SECRET = EXCHANGE_SECRET;
    (globalThis as unknown as { DB: unknown }).DB = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          all: async () => ({ results: [] }),
          run: async () => ({ success: true }),
        }),
      }),
    };
  });

  it('verifies HMAC over the exact raw request bytes, not an empty body', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/route');
    const request = buildSignedBinanceRequest(EXCHANGE_SECRET);

    const response = await POST(request);

    // An empty-body HMAC can never match a real signature, so the old
    // json()-then-text() ordering returned 401 here. Reaching any other
    // status proves the raw bytes reached verification.
    expect(response.status).not.toBe(401);
  });

  it('rejects a request whose signature does not match the body', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/route');
    const request = buildSignedBinanceRequest('a-different-secret-entirely');

    const response = await POST(request);

    expect(response.status).toBe(401);
  });
});
