/**
 * Track B — Public PWA / GA Hygiene Adversarial & Regression Suite (G26.B1–G26.B5)
 *
 * Verifies:
 *  - G26.B1: Durable D1 rate limiting on /api/b2b/proof-of-rebate (cross-isolate,
 *    burst, expired window, multi-tenant, spoofed XFF/X-Real-IP, fail-closed on D1 error,
 *    no raw PII in rate_limits keys, auth & IDOR enforcement)
 *  - G26.B2: PWA icon PNG binary headers (192x192 & 512x512), manifest.json schema,
 *    and layout metadata wiring
 *  - G26.B3: GitHub Actions immutable 40-char SHA pinning, least-privilege permissions,
 *    required check name preservation, deploy.yml boundaries, rollback-staging isolation
 *  - G26.B5: Public API privacy headers, PII/UID redaction, sanitized errors, and
 *    ProofOfRebateVerifier WCAG/ARIA semantics
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { GET as getProofOfRebate } from '@/app/api/b2b/proof-of-rebate/route';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';

jest.mock('@/lib/auth/session-helper', () => ({
  getAuthenticatedUser: jest.fn(),
}));

const mockedGetAuthenticatedUser = getAuthenticatedUser as jest.MockedFunction<
  typeof getAuthenticatedUser
>;

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function createRealSqliteD1Adapter(sqlite: Database.Database): AuthD1Database {
  const wrap = (sql: string) => {
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

describe('G26.B1 — Durable D1 Rate Limit on /api/b2b/proof-of-rebate', () => {
  let sqlite: Database.Database;
  let db: AuthD1Database;
  const originalB2bKey = process.env.B2B_PROOF_API_KEY;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const migration032 = fs.readFileSync(
      path.join(REPO_ROOT, 'src/database/migrations/032_persistent_d1_rate_limits.sql'),
      'utf8'
    );
    sqlite.exec(migration032);
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
    sqlite
      .prepare('INSERT INTO profiles (id, role) VALUES (?, ?), (?, ?)')
      .run('tenant_alpha', 'affiliate', 'tenant_beta', 'affiliate');
    sqlite
      .prepare('INSERT INTO ledger_journal_batches (id, metadata) VALUES (?, ?)')
      .run(
        'batch_alpha_001',
        JSON.stringify({
          traderId: 'trader_secret_alpha',
          l1AffiliateId: 'tenant_alpha',
          b2bAgencyId: 'agency_alpha',
        })
      );

    db = createRealSqliteD1Adapter(sqlite);
    (globalThis as unknown as { DB?: AuthD1Database }).DB = db;
    process.env.B2B_PROOF_API_KEY = 'super-secret-b2b-key-g26';
    mockedGetAuthenticatedUser.mockReset();
  });

  afterEach(() => {
    delete (globalThis as unknown as { DB?: AuthD1Database }).DB;
    if (originalB2bKey === undefined) {
      delete process.env.B2B_PROOF_API_KEY;
    } else {
      process.env.B2B_PROOF_API_KEY = originalB2bKey;
    }
    sqlite.close();
  });

  it('rejects unauthenticated and invalid API credential requests with 401 and Cache-Control: no-store', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue(null);

    const noAuthRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha')
    );
    expect(noAuthRes.status).toBe(401);
    expect(noAuthRes.headers.get('Cache-Control')).toContain('no-store');

    const badKeyRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: { 'x-b2b-api-key': 'wrong-key' },
      })
    );
    expect(badKeyRes.status).toBe(401);
    expect(badKeyRes.headers.get('Cache-Control')).toContain('no-store');
  });

  it('blocks cross-tenant IDOR batchId and affiliateId lookups with 403 FORBIDDEN_TENANT_SCOPE', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_beta',
      email: 'beta@example.com',
    } as never);

    const batchIdorRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?batchId=batch_alpha_001')
    );
    expect(batchIdorRes.status).toBe(403);
    const batchIdorBody = await batchIdorRes.json();
    expect(batchIdorBody.error).toBe('FORBIDDEN_TENANT_SCOPE');

    const listIdorRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha')
    );
    expect(listIdorRes.status).toBe(403);
    const listIdorBody = await listIdorRes.json();
    expect(listIdorBody.error).toBe('FORBIDDEN_TENANT_SCOPE');
  });

  it('enforces durable D1 60 req/min limit across isolates, ignores spoofed XFF/X-Real-IP, hashes keys, and resets after window expiry', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_alpha',
      email: 'alpha@example.com',
    } as never);

    // Simulate 60 requests with rotating spoofed X-Forwarded-For & X-Real-IP headers
    for (let i = 0; i < 60; i++) {
      const req = new NextRequest(
        'https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha',
        {
          headers: {
            'x-forwarded-for': `203.0.113.${(i % 250) + 1}`,
            'x-real-ip': `198.51.100.${(i % 250) + 1}`,
          },
        }
      );
      const res = await getProofOfRebate(req);
      expect(res.status).toBe(200);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
    }

    // 61st request from a second distinct D1 adapter wrapper (simulating a new Worker isolate)
    // with yet another spoofed XFF MUST still be rate-limited (429)
    const secondIsolateDb = createRealSqliteD1Adapter(sqlite);
    (globalThis as unknown as { DB?: AuthD1Database }).DB = secondIsolateDb;
    const throttledRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: {
          'x-forwarded-for': '192.0.2.99',
          'x-real-ip': '192.0.2.100',
        },
      })
    );
    expect(throttledRes.status).toBe(429);
    expect(Number(throttledRes.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
    expect(throttledRes.headers.get('Cache-Control')).toContain('no-store');
    const throttledBody = await throttledRes.json();
    expect(throttledBody.error).toBe('RATE_LIMITED');

    // Verify no raw userId or raw IP or raw API key is stored in rate_limits
    const rows = sqlite
      .prepare('SELECT key, endpoint_type, identifier, current_count FROM rate_limits')
      .all() as Array<{
      key: string;
      endpoint_type: string;
      identifier: string;
      current_count: number;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0].endpoint_type).toBe('b2b_proof_caller');
    expect(rows[0].current_count).toBe(61);
    expect(rows[0].key).not.toContain('tenant_alpha');
    expect(rows[0].identifier).not.toContain('tenant_alpha');
    expect(rows[0].key).not.toContain('203.0.113');

    // Tenant isolation: tenant_beta is NOT blocked when tenant_alpha is throttled
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_beta',
      email: 'beta@example.com',
    } as never);
    const betaRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_beta')
    );
    expect(betaRes.status).toBe(200);
    expect(betaRes.headers.get('Cache-Control')).toContain('no-store');

    // Expire tenant_alpha window in D1 -> next request succeeds
    sqlite
      .prepare("UPDATE rate_limits SET reset_at = '2020-01-01T00:00:00.000Z' WHERE endpoint_type = 'b2b_proof_caller'")
      .run();
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_alpha',
      email: 'alpha@example.com',
    } as never);
    const recoveredRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha')
    );
    expect(recoveredRes.status).toBe(200);
    expect(recoveredRes.headers.get('Cache-Control')).toContain('no-store');
  });

  it('tracks multiple users behind one trusted cf-connecting-ip independently until IP cap', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_alpha',
      email: 'alpha@example.com',
    } as never);
    const resAlpha = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: { 'cf-connecting-ip': '198.51.100.42' },
      })
    );
    expect(resAlpha.status).toBe(200);
    expect(resAlpha.headers.get('Cache-Control')).toContain('no-store');

    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_beta',
      email: 'beta@example.com',
    } as never);
    const resBeta = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_beta', {
        headers: { 'cf-connecting-ip': '198.51.100.42' },
      })
    );
    expect(resBeta.status).toBe(200);
    expect(resBeta.headers.get('Cache-Control')).toContain('no-store');

    const ipRows = sqlite
      .prepare("SELECT identifier, current_count FROM rate_limits WHERE endpoint_type = 'b2b_proof_ip'")
      .all() as Array<{ identifier: string; current_count: number }>;
    expect(ipRows.length).toBe(1);
    expect(ipRows[0].current_count).toBe(2);
    expect(ipRows[0].identifier).not.toContain('198.51.100.42');
  });

  it('enforces pre-auth 120 req/min b2b_proof_ip cap on unauthenticated floods before session lookup', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue(null);

    for (let i = 0; i < 120; i++) {
      const res = await getProofOfRebate(
        new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
          headers: { 'cf-connecting-ip': '203.0.113.77' },
        })
      );
      expect(res.status).toBe(401);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
    }

    mockedGetAuthenticatedUser.mockClear();
    const blockedRes = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: { 'cf-connecting-ip': '203.0.113.77' },
      })
    );
    expect(blockedRes.status).toBe(429);
    expect(blockedRes.headers.get('Cache-Control')).toContain('no-store');
    expect(mockedGetAuthenticatedUser).not.toHaveBeenCalled();
  });

  it('authenticates x-b2b-api-key and stores only hashed svc: identifier in rate_limits', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue(null);

    const res = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha', {
        headers: { 'x-b2b-api-key': 'super-secret-b2b-key-g26' },
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Cache-Control')).toContain('no-store');

    const svcRows = sqlite
      .prepare("SELECT key, identifier, current_count FROM rate_limits WHERE endpoint_type = 'b2b_proof_caller'")
      .all() as Array<{ key: string; identifier: string; current_count: number }>;
    expect(svcRows.length).toBe(1);
    expect(svcRows[0].identifier.startsWith('svc:')).toBe(true);
    expect(svcRows[0].key).not.toContain('super-secret-b2b-key-g26');
    expect(svcRows[0].identifier).not.toContain('super-secret-b2b-key-g26');
    expect(svcRows[0].current_count).toBe(1);
  });

  it('fails closed with HTTP 503 when D1 rate_limits write fails', async () => {
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_alpha',
      email: 'alpha@example.com',
    } as never);

    // Replace D1 with a failing rate_limits writer
    const failingDb = {
      prepare(sql: string) {
        if (sql.includes('rate_limits')) {
          return {
            bind() {
              return this;
            },
            async first() {
              throw new Error('D1_STORAGE_WRITE_FAILED');
            },
            async run() {
              throw new Error('D1_STORAGE_WRITE_FAILED');
            },
          };
        }
        return db.prepare(sql);
      },
    } as unknown as AuthD1Database;
    (globalThis as unknown as { DB?: AuthD1Database }).DB = failingDb;

    const res = await getProofOfRebate(
      new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha')
    );
    expect(res.status).toBe(503);
    expect(res.headers.get('Cache-Control')).toContain('no-store');
    const body = await res.json();
    expect(body.error).toBe('RATE_LIMIT_STORE_UNAVAILABLE');
  });
});

describe('G26.B2 — PWA Assets & Manifest Completeness', () => {
  const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  it('ships valid 192x192 and 512x512 PNG icons with valid magic bytes and IHDR dimensions', () => {
    for (const size of [192, 512]) {
      const iconPath = path.join(REPO_ROOT, 'public/assets/icons', `icon-${size}.png`);
      expect(fs.existsSync(iconPath)).toBe(true);
      const buf = fs.readFileSync(iconPath);
      expect(buf.subarray(0, 8).equals(PNG_SIGNATURE)).toBe(true);
      expect(buf.subarray(12, 16).toString('ascii')).toBe('IHDR');
      expect(buf.readUInt32BE(16)).toBe(size);
      expect(buf.readUInt32BE(20)).toBe(size);
    }
  });

  it('has a valid W3C manifest.json with standalone display and existing icon paths', () => {
    const manifestPath = path.join(REPO_ROOT, 'public/manifest.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
      name: string;
      short_name: string;
      display: string;
      icons: Array<{ src: string; sizes: string; type: string; purpose?: string }>;
    };
    expect(manifest.display).toBe('standalone');
    expect(Array.isArray(manifest.icons)).toBe(true);
    expect(manifest.icons.length).toBeGreaterThanOrEqual(4);

    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const diskPath = path.join(REPO_ROOT, 'public', icon.src.replace(/^\//, ''));
      expect(fs.existsSync(diskPath)).toBe(true);
    }

    const purposes = new Set(manifest.icons.map((i) => i.purpose));
    expect(purposes.has('any')).toBe(true);
    expect(purposes.has('maskable')).toBe(true);
  });

  it('wires manifest and apple touch icon metadata in locale layout', () => {
    const layoutSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/app/[locale]/layout.tsx'),
      'utf8'
    );
    expect(layoutSource).toContain("manifest: '/manifest.json'");
    expect(layoutSource).toContain("apple: '/assets/icons/icon-192.png'");
  });
});

describe('G26.B3 — GitHub Actions Modernization & Immutable SHA Pinning', () => {
  const workflowsDir = path.join(REPO_ROOT, '.github/workflows');
  const workflowFiles = fs
    .readdirSync(workflowsDir)
    .filter((f) => f.endsWith('.yml') || f.endsWith('.yaml'));

  it('pins every uses: action in .github/workflows/*.yml to a 40-char immutable commit SHA', () => {
    expect(workflowFiles.length).toBeGreaterThanOrEqual(2);
    const usesRegex = /^\s*-?\s*uses:\s*([^\s#]+)/gm;
    const shaPinRegex = /^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*@[0-9a-f]{40}$/;

    for (const file of workflowFiles) {
      const content = fs.readFileSync(path.join(workflowsDir, file), 'utf8');
      const matches = [...content.matchAll(usesRegex)];
      expect(matches.length).toBeGreaterThan(0);
      for (const match of matches) {
        expect(match[1]).toMatch(shaPinRegex);
      }
      expect(content).toMatch(/^permissions:\s*\n\s+contents:\s*read/m);
      expect(content).not.toMatch(/:\s*write\b/);
      expect(content).not.toContain('write-all');
    }
  });

  it('preserves exact required check name in ci.yml', () => {
    const ciYaml = fs.readFileSync(path.join(workflowsDir, 'ci.yml'), 'utf8');
    expect(ciYaml).toContain('name: Typecheck, Lint, Test & Worker Bundle');
  });

  it('keeps deploy.yml workflow_dispatch-only, enforces production master/environment gates, and enforces staging isolation before rollback-staging', () => {
    const deployYaml = fs.readFileSync(path.join(workflowsDir, 'deploy.yml'), 'utf8');
    expect(deployYaml).toMatch(/^on:\s*\n\s+workflow_dispatch:/m);
    expect(deployYaml).not.toMatch(/^\s+push:/m);
    expect(deployYaml).not.toMatch(/^\s+pull_request:/m);

    const deployProdStart = deployYaml.indexOf('deploy-production:');
    const rollbackStagingStart = deployYaml.indexOf('rollback-staging:');
    const rollbackProdStart = deployYaml.indexOf('rollback-production:');
    expect(deployProdStart).toBeGreaterThan(-1);
    expect(rollbackStagingStart).toBeGreaterThan(deployProdStart);
    expect(rollbackProdStart).toBeGreaterThan(rollbackStagingStart);

    const deployProdSection = deployYaml.slice(deployProdStart, rollbackStagingStart);
    expect(deployProdSection).toContain("github.ref == 'refs/heads/master'");
    expect(deployProdSection).toMatch(/environment:\s*\n\s+name:\s*production/);

    const rollbackStagingSection = deployYaml.slice(rollbackStagingStart, rollbackProdStart);
    const assertIdx = rollbackStagingSection.indexOf('bash scripts/assert-staging-isolation.sh');
    const rollbackCmdIdx = rollbackStagingSection.indexOf('wrangler rollback --config wrangler.staging.jsonc');
    expect(assertIdx).toBeGreaterThan(-1);
    expect(rollbackCmdIdx).toBeGreaterThan(assertIdx);

    const rollbackProdSection = deployYaml.slice(rollbackProdStart);
    expect(rollbackProdSection).toContain("github.ref == 'refs/heads/master'");
    expect(rollbackProdSection).toMatch(/environment:\s*\n\s+name:\s*production/);
  });

  it('excludes manifest.json and robots.txt from locale redirect in middleware.ts', () => {
    const middlewareSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/middleware.ts'),
      'utf8'
    );
    expect(middlewareSource).toContain('manifest\\\\.json');
    expect(middlewareSource).toContain('robots\\\\.txt');
  });
});

describe('G26.B5 — Public API Privacy & ProofOfRebateVerifier Accessibility', () => {
  it('returns sanitized HTTP 500 with Cache-Control: no-store and no raw SQLite error text on internal DB failure', async () => {
    const sqlite = new Database(':memory:');
    const migration032 = fs.readFileSync(
      path.join(REPO_ROOT, 'src/database/migrations/032_persistent_d1_rate_limits.sql'),
      'utf8'
    );
    sqlite.exec(migration032);
    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS profiles (
        id TEXT PRIMARY KEY,
        role TEXT NOT NULL DEFAULT 'shopper'
      );
    `);
    sqlite.prepare('INSERT INTO profiles (id, role) VALUES (?, ?)').run('tenant_alpha', 'affiliate');

    const baseDb = createRealSqliteD1Adapter(sqlite);
    const failingLedgerDb = {
      prepare(sql: string) {
        if (sql.includes('ledger_accounts')) {
          return {
            bind() {
              return this;
            },
            async all() {
              throw new Error('SQLITE_CORRUPT: sensitive internal table schema detail');
            },
          };
        }
        return baseDb.prepare(sql);
      },
    } as unknown as AuthD1Database;
    (globalThis as unknown as { DB?: AuthD1Database }).DB = failingLedgerDb;
    mockedGetAuthenticatedUser.mockResolvedValue({
      id: 'tenant_alpha',
      email: 'alpha@example.com',
    } as never);

    try {
      const res = await getProofOfRebate(
        new NextRequest('https://apexos.app/api/b2b/proof-of-rebate?affiliateId=tenant_alpha')
      );
      expect(res.status).toBe(500);
      expect(res.headers.get('Cache-Control')).toContain('no-store');
      const body = await res.json();
      expect(body.error).toBe('INTERNAL_SERVER_ERROR');
      expect(JSON.stringify(body)).not.toContain('SQLITE_CORRUPT');
      expect(JSON.stringify(body)).not.toContain('sensitive internal table schema detail');
    } finally {
      delete (globalThis as unknown as { DB?: AuthD1Database }).DB;
      sqlite.close();
    }
  });

  it('enforces semantic labels, ARIA alert/region roles, and focus-visible rings on ProofOfRebateVerifier', () => {
    const componentSource = fs.readFileSync(
      path.join(REPO_ROOT, 'src/components/b2b/proof-of-rebate-verifier.tsx'),
      'utf8'
    );
    expect(componentSource).toContain('htmlFor="proof-batch-id"');
    expect(componentSource).toContain('id="proof-batch-id"');
    expect(componentSource).toContain('htmlFor="proof-api-key"');
    expect(componentSource).toContain('id="proof-api-key"');
    expect(componentSource).toContain('role="status"');
    expect(componentSource).toContain('role="alert"');
    expect(componentSource).toContain('aria-live="assertive"');
    expect(componentSource).toContain('role="region"');
    expect(componentSource).toContain('focus-visible:ring-2');
  });
});
