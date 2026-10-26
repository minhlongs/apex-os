import { GET } from '../route';

describe('T2.1 — GET /api/version', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('returns { sha, builtAt, environment } with status 200 and never leaks secret env vars', async () => {
    process.env.NEXT_PUBLIC_COMMIT_SHA = 'abc1234def5678';
    process.env.NEXT_PUBLIC_BUILD_TIME = '2026-10-25T12:00:00.000Z';
    process.env.APP_ENV = 'staging';
    process.env.BETTER_AUTH_SECRET = 'do-not-leak-auth-secret';
    process.env.STELLAR_SECRET_KEY = 'S_DO_NOT_LEAK_STELLAR_KEY';
    process.env.CRON_SECRET = 'do-not-leak-cron-secret';

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    const rawText = JSON.stringify(body);
    expect(rawText).not.toContain('do-not-leak');
    expect(rawText).not.toContain('S_DO_NOT_LEAK');

    expect(Object.keys(body).sort()).toEqual(['builtAt', 'environment', 'sha']);
    expect(body).toEqual({
      sha: 'abc1234def5678',
      builtAt: '2026-10-25T12:00:00.000Z',
      environment: 'staging',
    });
  });

  it('falls back safely when NEXT_PUBLIC_COMMIT_SHA and NEXT_PUBLIC_BUILD_TIME are unset', async () => {
    delete process.env.NEXT_PUBLIC_COMMIT_SHA;
    delete process.env.NEXT_PUBLIC_BUILD_TIME;
    delete process.env.APP_ENV;
    process.env.NODE_ENV = 'test';

    const res = await GET();
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      sha: 'unknown',
      builtAt: null,
      environment: 'test',
    });
  });
});
