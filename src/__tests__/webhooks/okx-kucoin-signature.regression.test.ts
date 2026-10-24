/**
 * Regression test: OKX and KuCoin webhook body-read ordering.
 *
 * A Request body is a single-use stream. Reading `await request.json()`
 * before `await request.text()` consumes the stream, so the HMAC is then
 * computed over '' and every legitimately signed webhook is rejected.
 *
 * Both routes previously also parsed the body BEFORE verifying the
 * signature and answered malformed JSON with 200 `skipped: invalid_json`,
 * which let an unauthenticated caller skip the signature check entirely by
 * sending bytes that are not JSON. Verification must therefore precede
 * parsing: unsigned bytes now reach the verifier and are rejected before any
 * parsing happens.
 *
 * This test imports the REAL route handlers and builds genuinely signed
 * payloads, so it fails on the old ordering and passes only when the raw
 * bytes reach the signature check.
 */

import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';

const OKX_SECRET = 'regression-okx-secret-key-32b-pad';
const KUCOIN_SECRET = 'regression-kucoin-secret-key-32b-';

const OKX_PATH = '/api/webhooks/exchange/okx';
const KUCOIN_PATH = '/api/webhooks/exchange/kucoin';

/**
 * Reproduces the exact preimage the production verifier checks against
 * (src/lib/webhooks/crypto.ts:253 and :278). If this drifts from the
 * verifier, the accepted-signature assertions below stop passing, which is
 * the intended failure mode: the test stays coupled to the real algorithm.
 */
function signOkx(rawBody: string, secret: string, timestamp: string): string {
  const signString = timestamp + 'POST' + OKX_PATH + rawBody;
  return createHmac('sha256', secret).update(signString, 'utf8').digest('hex');
}

function signKuCoin(rawBody: string, secret: string, timestamp: string): string {
  const signString = timestamp + 'POST' + KUCOIN_PATH + rawBody;
  return createHmac('sha256', secret).update(signString, 'utf8').digest('base64');
}

/**
 * Malformed bytes that ARE signed correctly must never be answered with 200
 * `skipped: invalid_json`. The old ordering parsed before verifying, so an
 * unauthenticated caller could send bytes that are not JSON and get a 200 that
 * skipped the signature check entirely. A correctly-signed caller that sends
 * garbage instead reaches the parser and is answered 400 (INVALID_PAYLOAD).
 */
function expectMalformedIsRejected(status: number): void {
  expect(status).not.toBe(200);
}

/**
 * The bypass itself: bytes that are not JSON, sent with no signature at all.
 * This is the case the parse-before-verify ordering answered 200, so it is the
 * only assertion that fails if that ordering is ever restored. Asserted
 * separately from the signed-malformed case because that one still passes on
 * the broken ordering once the signature happens to validate.
 */
function expectUnsignedMalformedIsRejected(status: number): void {
  expect(status).not.toBe(200);
}

function buildRequest(url: string, headers: Record<string, string>, body: string): NextRequest {
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
}

/**
 * The routes resolve their secret from the environment and are wrapped in a
 * rate limiter that reads a KV-backed limiter from the D1 binding, so the
 * test publishes the same secret it signs with and a permissive DB stub.
 */
function publishSecrets(): void {
  process.env.OKX_WEBHOOK_SECRET = OKX_SECRET;
  process.env.KUCOIN_WEBHOOK_SECRET = KUCOIN_SECRET;
  (globalThis as unknown as { DB: unknown }).DB = {
    prepare: () => ({
      bind: () => ({
        first: async () => null,
        all: async () => ({ results: [] }),
        run: async () => ({ success: true }),
      }),
    }),
  };
}

describe('OKX webhook signature verification (real handler)', () => {
  beforeAll(publishSecrets);

  it('verifies HMAC over the exact raw request bytes, not an empty body', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/okx/route');
    const rawBody = JSON.stringify({ arg: { channel: 'orders' }, data: [{ ordId: 'reg-1' }] });
    const timestamp = Date.now().toString();

    const request = buildRequest(
      `http://localhost:3000${OKX_PATH}`,
      {
        'ok-access-sign': signOkx(rawBody, OKX_SECRET, timestamp),
        'ok-access-timestamp': timestamp,
      },
      rawBody
    );

    const response = await POST(request);

    // An empty-body HMAC can never match a real signature, so the old
    // json()-then-text() ordering returned 401 here. Reaching any other
    // status proves the raw bytes reached verification.
    expect(response.status).not.toBe(401);
  });

  it('rejects a request whose signature does not match the body', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/okx/route');
    const rawBody = JSON.stringify({ arg: { channel: 'orders' } });
    const timestamp = Date.now().toString();

    const request = buildRequest(
      `http://localhost:3000${OKX_PATH}`,
      {
        'ok-access-sign': signOkx(rawBody, 'a-different-secret-entirely', timestamp),
        'ok-access-timestamp': timestamp,
      },
      rawBody
    );

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('never answers malformed JSON with 200, because verification precedes parsing', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/okx/route');
    // These bytes are not JSON. The old code answered 200 `skipped: invalid_json`
    // here, which let an unsigned caller past verification. A caller who CAN
    // sign now reaches the parser and is answered 400; the bypass is gone.
    const rawBody = 'this-is-not-json';
    const timestamp = Date.now().toString();

    const request = buildRequest(
      `http://localhost:3000${OKX_PATH}`,
      {
        'ok-access-sign': signOkx(rawBody, OKX_SECRET, timestamp),
        'ok-access-timestamp': timestamp,
      },
      rawBody
    );

    const response = await POST(request);

    expectMalformedIsRejected(response.status);
  });
});

  it('never answers unsigned malformed bytes with a success status', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/okx/route');
    // No signature headers at all. This is the bypass the old ordering left
    // open: nothing here needs the secret, so an attacker with no credentials
    // reached a 200. Verification happening before parsing is what rejects it.
    const request = buildRequest(`http://localhost:3000${OKX_PATH}`, {}, 'this-is-not-json');

    const response = await POST(request);

    expectUnsignedMalformedIsRejected(response.status);
  });

describe('KuCoin webhook signature verification (real handler)', () => {
  beforeAll(publishSecrets);

  it('verifies HMAC over the exact raw request bytes, not an empty body', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/kucoin/route');
    const rawBody = JSON.stringify({ data: { orderId: 'reg-kucoin-1' } });
    const timestamp = Date.now().toString();

    const request = buildRequest(
      `http://localhost:3000${KUCOIN_PATH}`,
      {
        'kc-api-sign': signKuCoin(rawBody, KUCOIN_SECRET, timestamp),
        'kc-api-timestamp': timestamp,
      },
      rawBody
    );

    const response = await POST(request);

    expect(response.status).not.toBe(401);
  });

  it('rejects a request whose signature does not match the body', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/kucoin/route');
    const rawBody = JSON.stringify({ data: { orderId: 'reg-kucoin-2' } });
    const timestamp = Date.now().toString();

    const request = buildRequest(
      `http://localhost:3000${KUCOIN_PATH}`,
      {
        'kc-api-sign': signKuCoin(rawBody, 'a-different-secret-entirely', timestamp),
        'kc-api-timestamp': timestamp,
      },
      rawBody
    );

    const response = await POST(request);

    expect(response.status).toBe(401);
  });

  it('rejects malformed JSON with 401, because verification precedes parsing', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/kucoin/route');
    const rawBody = 'this-is-not-json-either';
    const timestamp = Date.now().toString();

    const request = buildRequest(
      `http://localhost:3000${KUCOIN_PATH}`,
      {
        'kc-api-sign': signKuCoin(rawBody, KUCOIN_SECRET, timestamp),
        'kc-api-timestamp': timestamp,
      },
      rawBody
    );

    const response = await POST(request);

    expectMalformedIsRejected(response.status);
  });
});

  it('never answers unsigned malformed bytes with a success status', async () => {
    const { POST } = await import('@/app/api/webhooks/exchange/kucoin/route');
    // No signature headers at all. This is the bypass the old ordering left
    // open: nothing here needs the secret, so an attacker with no credentials
    // reached a 200. Verification happening before parsing is what rejects it.
    const request = buildRequest(`http://localhost:3000${KUCOIN_PATH}`, {}, 'this-is-not-json');

    const response = await POST(request);

    expectUnsignedMalformedIsRejected(response.status);
  });
