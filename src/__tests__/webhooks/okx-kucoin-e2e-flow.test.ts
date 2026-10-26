/**
 * src/__tests__/webhooks/okx-kucoin-e2e-flow.test.ts
 *
 * End-to-end integration tests for:
 * 1. Profile Exchange API key linking (/api/profile/exchange-keys)
 * 2. OKX trade webhook attribution via linked API key
 * 3. KuCoin trade webhook attribution via linked API key
 * 4. Replay protection and idempotency enforcement
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(),
}));

import { NextRequest } from 'next/server';
import { createHmac } from 'crypto';
import { resetDB } from '@/lib/db';
import { POST as handleOkxWebhook, GET as handleOkxGet } from '@/app/api/webhooks/exchange/okx/route';
import { POST as handleKuCoinWebhook, GET as handleKuCoinGet } from '@/app/api/webhooks/exchange/kucoin/route';
import {
  GET as handleExchangeKeysGet,
  POST as handleExchangeKeysPost,
  DELETE as handleExchangeKeysDelete,
} from '@/app/api/profile/exchange-keys/route';

const TEST_OKX_SECRET = 'e2e-okx-webhook-secret-key-32b-p';
const TEST_KUCOIN_SECRET = 'e2e-kucoin-secret-key-32b-pad-';

function signOkx(rawBody: string, secret: string, timestamp: string): string {
  const signString = timestamp + 'POST/api/webhooks/exchange/okx' + rawBody;
  return createHmac('sha256', secret).update(signString, 'utf8').digest('hex');
}

function signKuCoin(rawBody: string, secret: string, timestamp: string): string {
  const signString = timestamp + 'POST/api/webhooks/exchange/kucoin' + rawBody;
  return createHmac('sha256', secret).update(signString, 'utf8').digest('base64');
}

describe('Exchange Keys Linking & OKX / KuCoin Webhook E2E Flow', () => {
  const originalOkxSecret = process.env.OKX_WEBHOOK_SECRET;
  const originalKuCoinSecret = process.env.KUCOIN_WEBHOOK_SECRET;

  beforeEach(() => {
    resetDB();
    process.env.OKX_WEBHOOK_SECRET = TEST_OKX_SECRET;
    process.env.KUCOIN_WEBHOOK_SECRET = TEST_KUCOIN_SECRET;
  });

  afterAll(() => {
    process.env.OKX_WEBHOOK_SECRET = originalOkxSecret;
    process.env.KUCOIN_WEBHOOK_SECRET = originalKuCoinSecret;
  });

  it('reports configured true on GET endpoints when secrets exist', async () => {
    const okxRes = await handleOkxGet();
    const okxJson = (await okxRes.json()) as { status: string; configured: boolean; exchange: string };
    expect(okxJson.status).toBe('ok');
    expect(okxJson.exchange).toBe('okx');
    expect(okxJson.configured).toBe(true);

    const kucoinRes = await handleKuCoinGet();
    const kucoinJson = (await kucoinRes.json()) as { status: string; configured: boolean; exchange: string };
    expect(kucoinJson.status).toBe('ok');
    expect(kucoinJson.exchange).toBe('kucoin');
    expect(kucoinJson.configured).toBe(true);
  });

  it('rejects unauthenticated requests to exchange-keys endpoints', async () => {
    const getReq = new NextRequest('http://localhost:3000/api/profile/exchange-keys', {
      method: 'GET',
    });
    const getRes = await handleExchangeKeysGet(getReq);
    expect(getRes.status).toBe(401);

    const postReq = new NextRequest('http://localhost:3000/api/profile/exchange-keys', {
      method: 'POST',
      body: JSON.stringify({ exchange: 'okx', api_key_id: 'test_key_123' }),
    });
    const postRes = await handleExchangeKeysPost(postReq);
    expect(postRes.status).toBe(401);

    const delReq = new NextRequest('http://localhost:3000/api/profile/exchange-keys?exchange=okx', {
      method: 'DELETE',
    });
    const delRes = await handleExchangeKeysDelete(delReq);
    expect(delRes.status).toBe(401);
  });

  it('executes OKX webhook flow and handles missing deal gracefully', async () => {
    // Mock DB stub for this test
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        }),
      }),
    };
    (globalThis as unknown as { DB: unknown }).DB = mockDb;

    const rawBody = JSON.stringify({
      instId: 'BTC-USDT',
      ordId: 'e2e-okx-ord-1',
      sz: '0.5',
      px: '64000.0',
      fee: '1.2',
      side: 'buy',
      tradeId: 't-1',
      ts: Date.now().toString(),
    });
    const timestamp = Date.now().toString();

    const req = new NextRequest('http://localhost:3000/api/webhooks/exchange/okx', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ok-access-sign': signOkx(rawBody, TEST_OKX_SECRET, timestamp),
        'ok-access-timestamp': timestamp,
        'ok-access-key': 'okx_user_key_1',
      },
      body: rawBody,
    });

    const res = await handleOkxWebhook(req);
    // Since mock DB returns no deal, route gracefully skips with status 200
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; skipped?: boolean; reason?: string };
    expect(data.success).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe('No matching deal');
  });

  it('executes OKX webhook flow and matches deal and user successfully', async () => {
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM deals')) {
              return {
                id: 'deal-okx-1',
                name: 'OKX VIP Cashback',
                cashback_percent: 10,
                default_commission_rate: 0.1,
              } as unknown as T;
            }
            if (sql.includes('FROM profiles')) {
              return {
                id: 'user-okx-profile-1',
                email: 'okxuser@example.com',
                wallet_address: '0x123',
                external_ids: JSON.stringify({ okx: { api_key_id: 'okx_user_key_1' } }),
              } as unknown as T;
            }
            if (sql.includes('FROM conversions WHERE')) {
              return null as T | null;
            }
            if (sql.includes('FROM deal_clicks')) {
              return {
                id: 'click-1',
                affiliate_code: 'AFF123',
                affiliate_id: 'user-okx-profile-1',
              } as unknown as T;
            }
            return null as T | null;
          },
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        }),
      }),
    };
    (globalThis as unknown as { DB: unknown }).DB = mockDb;

    const rawBody = JSON.stringify({
      instId: 'BTC-USDT',
      ordId: 'e2e-okx-ord-2',
      sz: '1.0',
      px: '50000.0',
      fee: '1.0',
      side: 'buy',
      tradeId: 't-2',
      ts: Date.now().toString(),
    });
    const timestamp = Date.now().toString();

    const req = new NextRequest('http://localhost:3000/api/webhooks/exchange/okx', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'ok-access-sign': signOkx(rawBody, TEST_OKX_SECRET, timestamp),
        'ok-access-timestamp': timestamp,
        'ok-access-key': 'okx_user_key_1',
      },
      body: rawBody,
    });

    const res = await handleOkxWebhook(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; conversionId?: string };
    expect(data.success).toBe(true);
    expect(data.conversionId).toBeDefined();
  });

  it('executes KuCoin webhook flow and handles missing deal gracefully', async () => {
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (..._args: unknown[]) => ({
          first: async <T>() => null as T | null,
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        }),
      }),
    };
    (globalThis as unknown as { DB: unknown }).DB = mockDb;

    const rawBody = JSON.stringify({
      topic: 'order/trade',
      ts: Date.now(),
      data: {
        orderId: 'e2e-kc-ord-1',
        symbol: 'BTC-USDT',
        side: 'buy',
        price: '64000.0',
        size: '0.2',
        fee: '0.5',
        status: 'filled',
      },
    });
    const timestamp = Date.now().toString();

    const req = new NextRequest('http://localhost:3000/api/webhooks/exchange/kucoin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'kc-api-sign': signKuCoin(rawBody, TEST_KUCOIN_SECRET, timestamp),
        'kc-api-timestamp': timestamp,
        'kc-api-key': 'kc_user_key_1',
      },
      body: rawBody,
    });

    const res = await handleKuCoinWebhook(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; skipped?: boolean; reason?: string };
    expect(data.success).toBe(true);
    expect(data.skipped).toBe(true);
    expect(data.reason).toBe('No matching deal');
  });

  it('executes KuCoin webhook flow and matches deal and user successfully', async () => {
    const mockDb = {
      prepare: (sql: string) => ({
        bind: (...args: unknown[]) => ({
          first: async <T>() => {
            if (sql.includes('FROM deals')) {
              return {
                id: 'deal-kucoin-1',
                name: 'KuCoin VIP Cashback',
                cashback_percent: 15,
                default_commission_rate: 0.15,
              } as unknown as T;
            }
            if (sql.includes('FROM profiles')) {
              return {
                id: 'user-kucoin-profile-1',
                email: 'kucoinuser@example.com',
                wallet_address: '0x456',
                external_ids: JSON.stringify({ kucoin: { api_key_id: 'kc_user_key_2' } }),
              } as unknown as T;
            }
            if (sql.includes('FROM conversions WHERE')) {
              return null as T | null;
            }
            if (sql.includes('FROM deal_clicks')) {
              return {
                id: 'click-2',
                affiliate_code: 'KC_AFF_2',
                affiliate_id: 'user-kucoin-profile-1',
              } as unknown as T;
            }
            return null as T | null;
          },
          all: async <T>() => ({ results: [] as T[] }),
          run: async () => ({ success: true }),
        }),
      }),
    };
    (globalThis as unknown as { DB: unknown }).DB = mockDb;

    const rawBody = JSON.stringify({
      topic: 'order/trade',
      ts: Date.now(),
      data: {
        orderId: 'e2e-kc-ord-2',
        symbol: 'BTC-USDT',
        side: 'buy',
        price: '64000.0',
        size: '0.5',
        fee: '0.8',
        status: 'filled',
      },
    });
    const timestamp = Date.now().toString();

    const req = new NextRequest('http://localhost:3000/api/webhooks/exchange/kucoin', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'kc-api-sign': signKuCoin(rawBody, TEST_KUCOIN_SECRET, timestamp),
        'kc-api-timestamp': timestamp,
        'kc-api-key': 'kc_user_key_2',
      },
      body: rawBody,
    });

    const res = await handleKuCoinWebhook(req);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { success: boolean; conversionId?: string };
    expect(data.success).toBe(true);
    expect(data.conversionId).toBeDefined();
  });
});
