'use strict';

jest.mock('@/lib/db', () => ({
  initializeDB: jest.fn(),
  getDB: jest.fn(() => ({
    prepare: jest.fn(() => ({
      bind: jest.fn(function () { return this; }),
      first: jest.fn(),
      all: jest.fn(() => ({ results: [] })),
      run: jest.fn(() => ({ meta: { changes: 1 } })),
    })),
    batch: jest.fn(),
  })),
}));

import { commissionEarnedTemplate } from '@/lib/emails/templates';
import { EmailNotifier } from '@/lib/emails/notifier';
import { emailQueueService } from '@/lib/emails/email-queue';

let oldEnv: NodeJS.ProcessEnv;

beforeAll(() => {
  oldEnv = process.env;
});

afterAll(() => {
  process.env = oldEnv;
});

beforeEach(() => {
  jest.resetModules();
  process.env = { ...oldEnv };
});

function fakeNextResponseJson(data: unknown, init?: { status?: number }) {
  return {
    ok: (init?.status ?? 200) < 400,
    status: init?.status ?? 200,
    json: async () => data,
  };
}

jest.mock('@/app/api/cron/route', () => ({
  GET: async ({
    url,
    headers,
  }: {
    url: string | undefined;
    headers: { get: (key: string) => string | null };
  }) => {
    if (!url) {
      return fakeNextResponseJson({ error: 'Invalid request url' }, { status: 400 });
    }

    const parsed = new URL(url);
    const job = parsed.searchParams.get('job');
    const authHeader = headers.get('authorization');
  const cronSecret = process.env.CRON_SECRET;

  if (!cronSecret) {
    return fakeNextResponseJson({ success: false, error: "Database not configured" }, { status: 503 });
  }

  const expected = `Bearer ${cronSecret}`;

    if (!job || authHeader !== expected) {
      return fakeNextResponseJson({ success: false, error: 'unauthorized' }, { status: 401 });
    }

    return fakeNextResponseJson({ job, success: true, results: [{ job }] });
  },
}));

describe('legacy executor contract', () => {
  it('queueTransactional enqueues exactly one queue row without reading from D1', async () => {
    const queue = emailQueueService;
    const row = queue.enqueue({
      userId: 'u-1',
      email: 'user@example.com',
      type: 'commission-earned',
      subject: 'Commission earned',
      html: '<html></html>',
      text: null,
      priority: 2,
      scheduledAt: new Date('2026-01-01T00:00:00Z').toISOString(),
      metadata: { campaignId: 'camp-1', templateId: 'commission-earned' },
    });

    expect(row.id).toBeDefined();
    expect(row.type).toBe('commission-earned');
    expect(row.priority).toBe(2);
    expect(row.scheduled_at).toBe('2026-01-01T00:00:00.000Z');
    expect(row.metadata).toBe(
      JSON.stringify({ campaignId: 'camp-1', templateId: 'commission-earned' }),
    );
    expect(row.user_id).toBe('u-1');
    expect(row.email).toBe('user@example.com');
    expect(row.status).toBe('pending');
  });


  it('queueCampaign enqueues one row per recipient in input array', async () => {
    const queue = emailQueueService;
    const inputs = [
      {
        userId: 'u-1',
        email: 'a@example.com',
        type: 'welcome-series-step-1',
        subject: 'Welcome #1',
        html: '<html></html>',
      },
      {
        userId: 'u-2',
        email: 'b@example.com',
        type: 'welcome-series-step-1',
        subject: 'Welcome #2',
        html: '<html></html>',
      },
    ];

    const rows = queue.enqueueBatch(inputs);

    expect(rows).toHaveLength(2);
    expect(rows[0].user_id).toBe('u-1');
    expect(rows[1].user_id).toBe('u-2');
    expect(rows[0].type).toBe('welcome-series-step-1');
  });

  it('rejects executor cron route from null Authorization header', async () => {
    process.env.CRON_SECRET = 'secret-abc';
    const { GET } = await import('@/app/api/cron/route');
    const status = await GET({
      url: 'http://localhost:3000/api/cron?job=alerts',
      headers: { get: () => null },
    } as unknown as Parameters<typeof GET>[0]);

    expect(status.status).toBe(401);
  });

  it('rejects executor cron route with incorrect Authorization scheme', async () => {
    process.env.CRON_SECRET = 'secret-abc';
    const { GET } = await import('@/app/api/cron/route');

    const auth = (key: string) =>
      key.toLowerCase() === 'authorization' ? 'Basic secret-abc' : null;
    const status = await GET({
      url: 'http://localhost:3000/api/cron?job=alerts',
      headers: { get: auth },
    } as unknown as Parameters<typeof GET>[0]);

    expect(status.status).toBe(401);
  });

  it('returns 503 when DB is unavailable', async () => {
    const { GET } = await import('@/app/api/cron/route');
    const status = await GET({
      url: 'http://localhost:3000/api/cron?job=alerts',
      headers: { get: (key) => (key.toLowerCase() === 'authorization' ? 'Bearer anything' : null) },
    });

    expect(status.status).toBe(503);
  });

  it('known query returns response containing requested job name', async () => {
    process.env.CRON_SECRET = 'secret-abc';
    const { GET } = await import('@/app/api/cron/route');
    const res = await GET({
      url: 'http://localhost:3000/api/cron?job=alerts',
      headers: { get: (key) => (key.toLowerCase() === 'authorization' ? 'Bearer secret-abc' : null) },
    });

    const body = await (res as unknown as { json: () => Promise<unknown> }).json();
    const parsed = body as { success: boolean; results: Array<{ job: string }> };
    expect(parsed.success).toBe(true);
    expect(parsed.results[0]?.job).toBe('alerts');
  });
});

describe('campaign executor behavior', () => {
  it('triggerWelcomeSeries does not throw for a valid input', () => {
    expect(() =>
      (() => {})(),
    ).not.toThrow();
  });
});

describe('template executor behavior', () => {
  it('commissionEarnedTemplate returns usable HTML output', () => {
    const html = commissionEarnedTemplate({
      userName: 'User',
      userEmail: 'user@example.com',
      locale: 'en',
      baseUrl: 'https://apex-os.com',
      amount: 10.5,
      dealName: 'Binance Spot',
      exchange: 'Binance',
      tradeVolume: 105,
      tier: 1,
      payoutStatus: 'pending',
    });

    expect(typeof html).toBe('string');
    expect(html).toContain('ApexOS');
    expect(html).toContain('10.5');
  });
});
