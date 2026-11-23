/**
 * Track B — Targeted Security Closure Suite (G27.B1 & G27.B2)
 *
 * G27.B1 (10 scenarios):
 *   1. Missing `cf-connecting-ip` in production -> HTTP 403 MISSING_TRUSTED_CLIENT_IP + Cache-Control: no-store
 *   2. Empty ("") and whitespace-only ("   \t ") `cf-connecting-ip` in production -> HTTP 403 MISSING_TRUSTED_CLIENT_IP
 *   3. Spoofed `X-Forwarded-For` and `X-Real-IP` without `cf-connecting-ip` in production -> HTTP 403
 *   4. Valid trusted `cf-connecting-ip` in production -> HTTP 200 + Cache-Control: no-store, persisted in `rate_limits`
 *   5. Unauthorized flood with valid `cf-connecting-ip` -> HTTP 429 on request 121 before auth/session lookup
 *   6. Two Worker isolates sharing one SQLite D1 DB -> atomic counter shared (60 + 60 = 120 allowed, 121st = 429)
 *   7. Database failure on pre-auth limiter -> fail-closed HTTP 503 + Cache-Control: no-store
 *   8. Legitimate authenticated service caller (`x-b2b-api-key`) without `cf-connecting-ip` in production ->
 *      admitted via dedicated durable `b2b_proof_svc_ingress` bucket (HTTP 200, hashed `svc_ingress:` key, throttled at 121st with 429)
 *   9. Invalid query (`?aiTools=execute_payout` or missing `batchId`/`affiliateId`) when `cf-connecting-ip` is missing
 *      in production -> HTTP 403 MISSING_TRUSTED_CLIENT_IP BEFORE query/AI-tool parsing
 *  10. Zero D1 session lookup (`getAuthenticatedUser` called 0 times) when pre-auth admission fails (403 & 429)
 *
 * G27.B2 (5 scenarios):
 *   1. Spy on `db.prepare` in production & staging -> ZERO `CREATE TABLE` SQL statements ever executed
 *   2. Missing `rate_limits` table in production/staging -> HTTP 503 RATE_LIMIT_STORE_UNAVAILABLE + Cache-Control: no-store
 *   3. Approved Migration 032 schema in production/staging -> HTTP 200 + atomic counters
 *   4. Cross-isolate atomic counters preserved without runtime DDL in production/staging
 *   5. Local test/dev fixtures (`!isProductionOrStagingRuntime()`) remain deterministic and still bootstrap cleanly
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { GET as getProofOfRebate } from '@/app/api/b2b/proof-of-rebate/route';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import { enforcePersistentD1RateLimit } from '@/lib/security/d1-rate-limiter';
import type { D1Database as LegacyD1Database } from '@/lib/db';

jest.mock('@/lib/auth/session-helper', () => ({
  getAuthenticatedUser: jest.fn(),
}));

const mockedGetAuthenticatedUser = getAuthenticatedUser as jest.MockedFunction<
  typeof getAuthenticatedUser
>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const MIGRATION_032_SQL = fs.readFileSync(
  path.join(REPO_ROOT, 'src/database/migrations/032_persistent_d1_rate_limits.sql'),
  'utf8'
);

function createSqliteD1Adapter(
  sqlite: Database.Database,
  onPrepare?: (sql: string) => void
): AuthD1Database {
  const wrap = (sql: string) => {
    onPrepare?.(sql);
    const stmt = sqlite.prepare(sql);
    let boundArgs: unknown[] = [];
    const statementObj = {
      bind(...args: unknown[]) {
        boundArgs = args;
        return statementObj;
      },
      async first<T = Record<string, unknown>>(colName?: string): Promise<T | null> {
        const row = stmt.get(...boundArgs) as Record<string, unknown> | undefined;
        if (!row) return null;
        if (colName) return (row[colName] as T) ?? null;
        return row as T;
      },
      async all<T = Record<string, unknown>>() {
        const results = stmt.all(...boundArgs) as T[];
        return { results, success: true, meta: {} };
      },
      async run() {
        const info = stmt.run(...boundArgs);
        return {
          success: true,
          meta: {
            changes: info.changes,
            last_row_id: Number(info.lastInsertRowid ?? 0),
          },
        };
      },
    };
    return statementObj;
  };

  return {
    prepare: (sql: string) => wrap(sql),
    batch: async () => [],
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  } as unknown as AuthD1Database;
}

function seedProofTables(sqlite: Database.Database, includeMigration032: boolean): void {
  if (includeMigration032) {
    sqlite.exec(MIGRATION_032_SQL);
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id TEXT PRIMARY KEY,
      role TEXT NOT NULL DEFAULT 'shopper'
    );
    CREATE TABLE IF NOT EXISTS ledger_journal_batches (
      id TEXT PRIMARY KEY,
      metadata TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_accounts (
      id TEXT PRIMARY KEY,
      owner_type TEXT NOT NULL,
      owner_id TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ledger_postings (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      amount_units INTEGER NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
  sqlite.prepare('INSERT INTO profiles (id, role) VALUES (?, ?)').run('tenant_alpha', 'affiliate');
  sqlite.prepare('INSERT INTO ledger_journal_batches (id, metadata) VALUES (?, ?)').run(
    'batch_alpha_001',
    JSON.stringify({
      traderId: 'trader_secret_alpha',
      l1AffiliateId: 'tenant_alpha',
      exchange: 'binance',
      reconciliationStatus: 'CASH_COLLECTED',
      payloadSha256: 'a'.repeat(64),
      settledTxHash: '0xsettled_alpha',
    })
  );
  sqlite
    .prepare('INSERT INTO ledger_accounts (id, owner_type, owner_id) VALUES (?, ?, ?)')
    .run('acct_l1_alpha', 'l1_affiliate', 'tenant_alpha');
  sqlite
    .prepare(
      'INSERT INTO ledger_postings (id, batch_id, account_id, amount_units) VALUES (?, ?, ?, ?)'
    )
    .run('post_alpha_1', 'batch_alpha_001', 'acct_l1_alpha', 150000000);
}

describe('G27.B1 — Missing Client-IP Pre-Auth Rate-Limit Gap Closure', () => {
  let sqlite: Database.Database;
  let db: AuthD1Database;
  const originalEnv = {
    APP_ENV: process.env.APP_ENV,
    APEX_ENVIRONMENT: process.env.APEX_ENVIRONMENT,
    NODE_ENV: process.env.NODE_ENV,
    B2B_PROOF_API_KEY: process.env.B2B_PROOF_API_KEY,
  };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    seedProofTables(sqlite, true);
    db = createSqliteD1Adapter(sqlite);
    (globalThis as unknown as { DB?: AuthD1Database }).DB = db;
    mockedGetAuthenticatedUser.mockReset();
    delete process.env.APP_ENV;
    delete process.env.APEX_ENVIRONMENT;
    process.env.B2B_PROOF_API_KEY = 'g27-super-secret-service-key';
  });

  afterEach(() => {
    delete (globalThis as unknown as { DB?: AuthD1Database }).DB;
    if (originalEnv.APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv.APP_ENV;

    if (originalEnv.APEX_ENVIRONMENT === undefined) delete process.env.APEX_ENVIRONMENT;
    else process.env.APEX_ENVIRONMENT = originalEnv.APEX_ENVIRONMENT;

    if (originalEnv.NODE_ENV === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv.NODE_ENV;

    if (originalEnv.B2B_PROOF_API_KEY === undefined) delete process.env.B2B_PROOF_API_KEY;
    else process.env.B2B_PROOF_API_KEY = originalEnv.B2B_PROOF_API_KEY;

    sqlite.close();
  });

  it('1. rejects missing cf-connecting-ip in production with 403 MISSING_TRUSTED_CLIENT_IP and Cache-Control: no-store', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001');
    const res = await getProofOfRebate(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body).toMatchObject({
      success: false,
      error: 'MISSING_TRUSTED_CLIENT_IP',
    });
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('2. rejects empty ("") and whitespace-only ("   \\t ") cf-connecting-ip in production with 403', async () => {
    process.env.APEX_ENVIRONMENT = 'production';

    for (const badHeader of ['', '   \t ']) {
      const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
        headers: { 'cf-connecting-ip': badHeader },
      });
      const res = await getProofOfRebate(req);
      const body = await res.json();

      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(body.error).toBe('MISSING_TRUSTED_CLIENT_IP');
    }
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('3. ignores spoofed X-Forwarded-For and X-Real-IP without cf-connecting-ip in production (403)', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
      headers: {
        'x-forwarded-for': '203.0.113.99, 10.0.0.1',
        'x-real-ip': '203.0.113.99',
      },
    });
    const res = await getProofOfRebate(req);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error).toBe('MISSING_TRUSTED_CLIENT_IP');
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('4. admits valid trusted cf-connecting-ip in production (200 + Cache-Control: no-store) and persists counter in rate_limits', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    mockedGetAuthenticatedUser.mockResolvedValue({ id: 'tenant_alpha', email: 'alpha@example.com' });

    const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
      headers: { 'cf-connecting-ip': '198.51.100.42' },
    });
    const res = await getProofOfRebate(req);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.success).toBe(true);

    const ipRow = sqlite
      .prepare("SELECT endpoint_type, identifier, current_count FROM rate_limits WHERE endpoint_type = 'b2b_proof_ip'")
      .get() as { endpoint_type: string; identifier: string; current_count: number } | undefined;
    expect(ipRow).toBeDefined();
    expect(ipRow?.current_count).toBe(1);
    expect(ipRow?.identifier).toMatch(/^ip:[a-f0-9]{32}$/);
    expect(ipRow?.identifier).not.toContain('198.51.100.42');
  });

  it('5. throttles unauthorized flood with valid cf-connecting-ip on request 121 (429) before auth/session lookup', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    mockedGetAuthenticatedUser.mockResolvedValue(null);

    for (let i = 1; i <= 120; i++) {
      const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
        headers: { 'cf-connecting-ip': '198.51.100.77' },
      });
      const res = await getProofOfRebate(req);
      expect(res.status).toBe(401);
    }

    mockedGetAuthenticatedUser.mockClear();
    const blockedReq = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
      headers: { 'cf-connecting-ip': '198.51.100.77' },
    });
    const blockedRes = await getProofOfRebate(blockedReq);
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get('cache-control')).toBe('no-store');
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('6. shares atomic counter across two Worker isolates backed by one SQLite D1 DB (60 + 60 = 120 allowed, 121st = 429)', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    mockedGetAuthenticatedUser.mockResolvedValue(null);

    const isolateADb = createSqliteD1Adapter(sqlite);
    const isolateBDb = createSqliteD1Adapter(sqlite);

    (globalThis as unknown as { DB?: AuthD1Database }).DB = isolateADb;
    for (let i = 0; i < 60; i++) {
      const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
        headers: { 'cf-connecting-ip': '203.0.113.55' },
      });
      const res = await getProofOfRebate(req);
      expect(res.status).toBe(401);
    }

    (globalThis as unknown as { DB?: AuthD1Database }).DB = isolateBDb;
    for (let i = 0; i < 60; i++) {
      const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
        headers: { 'cf-connecting-ip': '203.0.113.55' },
      });
      const res = await getProofOfRebate(req);
      expect(res.status).toBe(401);
    }

    const req121 = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
      headers: { 'cf-connecting-ip': '203.0.113.55' },
    });
    const res121 = await getProofOfRebate(req121);
    expect(res121.status).toBe(429);
    expect(res121.headers.get('cache-control')).toBe('no-store');
  });

  it('7. fails closed with HTTP 503 and Cache-Control: no-store on D1 error during pre-auth rate limit', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    const brokenDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => {
            throw new Error('D1_NETWORK_ERROR');
          },
          run: async () => {
            throw new Error('D1_NETWORK_ERROR');
          },
        }),
      }),
    } as unknown as AuthD1Database;
    (globalThis as unknown as { DB?: AuthD1Database }).DB = brokenDb;

    const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
      headers: { 'cf-connecting-ip': '198.51.100.12' },
    });
    const res = await getProofOfRebate(req);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.error).toBe('RATE_LIMIT_STORE_UNAVAILABLE');
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('8. admits legitimate x-b2b-api-key service caller without cf-connecting-ip via durable b2b_proof_svc_ingress bucket and throttles at 121st', async () => {
    process.env.APEX_ENVIRONMENT = 'production';

    const okReq = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
      headers: { 'x-b2b-api-key': 'g27-super-secret-service-key' },
    });
    const okRes = await getProofOfRebate(okReq);
    expect(okRes.status).toBe(200);
    expect(okRes.headers.get('cache-control')).toBe('no-store');

    const svcRow = sqlite
      .prepare(
        "SELECT endpoint_type, identifier, current_count FROM rate_limits WHERE endpoint_type = 'b2b_proof_svc_ingress'"
      )
      .get() as { endpoint_type: string; identifier: string; current_count: number } | undefined;
    expect(svcRow).toBeDefined();
    expect(svcRow?.current_count).toBe(1);
    expect(svcRow?.identifier).toMatch(/^svc_ingress:[a-f0-9]{32}$/);
    expect(svcRow?.identifier).not.toContain('g27-super-secret-service-key');

    // Advance the durable ingress bucket to 120 via 119 more pre-auth ingress calls (missing query param returns 400
    // after b2b_proof_svc_ingress check, before b2b_proof_caller)
    for (let i = 2; i <= 120; i++) {
      const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate', {
        headers: { 'x-b2b-api-key': 'g27-super-secret-service-key' },
      });
      const res = await getProofOfRebate(req);
      expect(res.status).toBe(400);
    }

    const req121 = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
      headers: { 'x-b2b-api-key': 'g27-super-secret-service-key' },
    });
    const res121 = await getProofOfRebate(req121);
    expect(res121.status).toBe(429);
    expect(res121.headers.get('cache-control')).toBe('no-store');
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('9. rejects invalid query (?aiTools=execute_payout or missing batchId/affiliateId) with 403 MISSING_TRUSTED_CLIENT_IP BEFORE query/AI-tool parsing', async () => {
    process.env.APEX_ENVIRONMENT = 'production';

    const aiToolReq = new NextRequest(
      'https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001&aiTools=execute_payout'
    );
    const aiToolRes = await getProofOfRebate(aiToolReq);
    const aiToolBody = await aiToolRes.json();
    expect(aiToolRes.status).toBe(403);
    expect(aiToolBody.error).toBe('MISSING_TRUSTED_CLIENT_IP');

    const missingParamReq = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate');
    const missingParamRes = await getProofOfRebate(missingParamReq);
    const missingParamBody = await missingParamRes.json();
    expect(missingParamRes.status).toBe(403);
    expect(missingParamBody.error).toBe('MISSING_TRUSTED_CLIENT_IP');
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('10. performs zero D1 session lookups when pre-auth admission fails (both 403 missing IP and 429 IP flood)', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    mockedGetAuthenticatedUser.mockResolvedValue({ id: 'tenant_alpha' });

    // Case A: 403 missing IP
    const missingIpRes = await getProofOfRebate(
      new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001')
    );
    expect(missingIpRes.status).toBe(403);
    expect(mockedGetAuthenticatedUser).toHaveBeenCalledTimes(0);

    // Case B: 429 IP flood (trigger 1st request to create hashed key row, then bump to 120)
    const primingRes = await getProofOfRebate(
      new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: { 'cf-connecting-ip': '198.51.100.200' },
      })
    );
    expect(primingRes.status).toBe(200);
    sqlite
      .prepare("UPDATE rate_limits SET current_count = 120 WHERE endpoint_type = 'b2b_proof_ip'")
      .run();
    mockedGetAuthenticatedUser.mockClear();

    const floodedRes = await getProofOfRebate(
      new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: { 'cf-connecting-ip': '198.51.100.200' },
      })
    );
    expect(floodedRes.status).toBe(429);
    expect(mockedGetAuthenticatedUser).toHaveBeenCalledTimes(0);
  });
});

describe('G27.B2 — Remove Uncontrolled Runtime Schema Creation in Production/Staging', () => {
  const originalEnv = {
    APP_ENV: process.env.APP_ENV,
    APEX_ENVIRONMENT: process.env.APEX_ENVIRONMENT,
    NODE_ENV: process.env.NODE_ENV,
  };

  afterEach(() => {
    delete (globalThis as unknown as { DB?: AuthD1Database }).DB;
    if (originalEnv.APP_ENV === undefined) delete process.env.APP_ENV;
    else process.env.APP_ENV = originalEnv.APP_ENV;

    if (originalEnv.APEX_ENVIRONMENT === undefined) delete process.env.APEX_ENVIRONMENT;
    else process.env.APEX_ENVIRONMENT = originalEnv.APEX_ENVIRONMENT;

    if (originalEnv.NODE_ENV === undefined) delete (process.env as Record<string, string | undefined>).NODE_ENV;
    else (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv.NODE_ENV;
  });

  it('1. executes ZERO CREATE TABLE SQL statements in production and staging (including when APP_ENV is empty string)', async () => {
    for (const envName of ['production', 'staging'] as const) {
      // Also prove empty/whitespace APP_ENV cannot shadow APEX_ENVIRONMENT
      process.env.APP_ENV = '   ';
      process.env.APEX_ENVIRONMENT = envName;

      const sqlite = new Database(':memory:');
      seedProofTables(sqlite, true);
      const preparedSqls: string[] = [];
      const db = createSqliteD1Adapter(sqlite, (sql) => preparedSqls.push(sql));

      const result = await enforcePersistentD1RateLimit(db as unknown as LegacyD1Database, {
        endpointType: 'b2b_proof_ip',
        identifier: 'ip:test123',
        maxRequests: 10,
        windowSeconds: 60,
        failClosed: false, // Even explicit failClosed: false must stay fail-closed in prod/staging
      });

      expect(result.allowed).toBe(true);
      expect(result.source).toBe('d1');
      const ddlCalls = preparedSqls.filter((sql) => /CREATE\s+TABLE/i.test(sql));
      expect(ddlCalls).toHaveLength(0);
      sqlite.close();
    }
  });

  it('2. fails closed with HTTP 503 RATE_LIMIT_STORE_UNAVAILABLE when rate_limits table is missing in production/staging', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    const sqlite = new Database(':memory:');
    seedProofTables(sqlite, false); // Intentionally omit Migration 032
    const preparedSqls: string[] = [];
    const db = createSqliteD1Adapter(sqlite, (sql) => preparedSqls.push(sql));
    (globalThis as unknown as { DB?: AuthD1Database }).DB = db;

    const req = new NextRequest('https://apex-os.example/api/b2b/proof-of-rebate?batchId=batch_alpha_001', {
      headers: { 'cf-connecting-ip': '198.51.100.88' },
    });
    const res = await getProofOfRebate(req);
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(body.error).toBe('RATE_LIMIT_STORE_UNAVAILABLE');
    expect(preparedSqls.filter((sql) => /CREATE\s+TABLE/i.test(sql))).toHaveLength(0);
    sqlite.close();
  });

  it('3. works cleanly with approved Migration 032 schema in production/staging (HTTP 200 + atomic counters)', async () => {
    process.env.APEX_ENVIRONMENT = 'staging';
    const sqlite = new Database(':memory:');
    seedProofTables(sqlite, true);
    const db = createSqliteD1Adapter(sqlite);
    (globalThis as unknown as { DB?: AuthD1Database }).DB = db;
    mockedGetAuthenticatedUser.mockResolvedValue({ id: 'tenant_alpha', email: 'alpha@example.com' });

    const req = new NextRequest('https://staging.apex-os.example/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
      headers: { 'cf-connecting-ip': '198.51.100.90' },
    });
    const res = await getProofOfRebate(req);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    sqlite.close();
  });

  it('4. preserves cross-isolate atomic counters without runtime DDL in production/staging', async () => {
    process.env.APEX_ENVIRONMENT = 'production';
    const sqlite = new Database(':memory:');
    seedProofTables(sqlite, true);
    const preparedSqls: string[] = [];
    const isolate1 = createSqliteD1Adapter(sqlite, (sql) => preparedSqls.push(sql)) as unknown as LegacyD1Database;
    const isolate2 = createSqliteD1Adapter(sqlite, (sql) => preparedSqls.push(sql)) as unknown as LegacyD1Database;

    const r1 = await enforcePersistentD1RateLimit(isolate1, {
      endpointType: 'b2b_proof_ip',
      identifier: 'ip:shared',
      maxRequests: 2,
      windowSeconds: 60,
      failClosed: true,
    });
    const r2 = await enforcePersistentD1RateLimit(isolate2, {
      endpointType: 'b2b_proof_ip',
      identifier: 'ip:shared',
      maxRequests: 2,
      windowSeconds: 60,
      failClosed: true,
    });
    const r3 = await enforcePersistentD1RateLimit(isolate1, {
      endpointType: 'b2b_proof_ip',
      identifier: 'ip:shared',
      maxRequests: 2,
      windowSeconds: 60,
      failClosed: true,
    });

    expect(r1.allowed).toBe(true);
    expect(r1.currentCount).toBe(1);
    expect(r2.allowed).toBe(true);
    expect(r2.currentCount).toBe(2);
    expect(r3.allowed).toBe(false);
    expect(r3.status).toBe(429);
    expect(preparedSqls.filter((sql) => /CREATE\s+TABLE/i.test(sql))).toHaveLength(0);
    sqlite.close();
  });

  it('5. local dev/test runtime (!isProductionOrStagingRuntime()) remains deterministic and bootstraps cleanly', async () => {
    delete process.env.APP_ENV;
    delete process.env.APEX_ENVIRONMENT;
    (process.env as Record<string, string | undefined>).NODE_ENV = 'test';

    const sqlite = new Database(':memory:');
    // No Migration 032 pre-applied: local dev/test may bootstrap `rate_limits`
    const db = createSqliteD1Adapter(sqlite) as unknown as LegacyD1Database;
    const res = await enforcePersistentD1RateLimit(db, {
      endpointType: 'b2b_proof_ip',
      identifier: 'ip:local',
      maxRequests: 5,
      windowSeconds: 60,
      failClosed: true,
    });

    expect(res.allowed).toBe(true);
    expect(res.source).toBe('d1');
    expect(res.currentCount).toBe(1);
    sqlite.close();
  });
});
