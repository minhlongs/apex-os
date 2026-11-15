/**
 * Gate G11 Sandbox Verification: Edge Geo-Fence + BLOCK_VN_SIGNUPS + DEFAULT_LOCALE = 'en',
 * Law 91/2025/QH15 KYC Data Minimization (410), PII Redactor for Read-Only AI,
 * Apple Guideline 3.1.5(v) + PWA Manifest Compliance, and Zero Copyleft License Audit
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

jest.mock('@/lib/auth/session-helper', () => {
  const actual = jest.requireActual('@/lib/auth/session-helper');
  return {
    ...actual,
    getAuthenticatedUser: jest.fn(),
  };
});

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import * as sessionHelper from '@/lib/auth/session-helper';
import {
  EEA_MEMBER_STATES,
  HARD_BLOCKED_JURISDICTIONS,
  evaluateGeoFence,
} from '@/lib/compliance/geo-fence';
import {
  redactPiiForReadOnlyAi,
  assertReadOnlyAiTools,
  maskWalletAddress,
} from '@/lib/compliance/pii-redactor';
import {
  assertAppStorePolicyCompliance,
  evaluateAppStorePolicyCompliance,
} from '@/lib/compliance/app-store-policy';
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, middleware } from '@/middleware';
import { POST as kycInitiatePost } from '@/app/api/kyc/initiate/route';

function createMinimalFlagDb(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let params: unknown[] = [];
      const stmt = sqlite.prepare(sql);
      const wrapped: D1PreparedStatement = {
        bind(...values: unknown[]) {
          params = values;
          return wrapped;
        },
        async first<T = unknown>(): Promise<T | null> {
          const row = stmt.get(...params) as T | undefined;
          return row ?? null;
        },
        async run<T = unknown>(): Promise<D1Result<T>> {
          const info = stmt.run(...params);
          return {
            results: [],
            success: true,
            meta: {
              duration: 0,
              changes: info.changes,
              last_row_id: Number(info.lastInsertRowid),
              served_by: 'sqlite-g11',
            },
          };
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          return {
            results: stmt.all(...params) as T[],
            success: true,
            meta: { duration: 0, changes: 0, last_row_id: 0, served_by: 'sqlite-g11' },
          };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return stmt.raw().all(...params) as T[];
        },
      };
      return wrapped;
    },
    async batch<T = unknown>(): Promise<D1Result<T>[]> {
      return [];
    },
    async exec(sql: string): Promise<{ count: number; duration: number }> {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async close(): Promise<void> {
      sqlite.close();
    },
  };
}

describe('Gate G11: Regulatory Geo-Fence, Law 91/2025/QH15 Data Minimization, AI PII Redaction, Apple 3.1.5(v) & License Compliance', () => {
  const originalBlockVn = process.env.BLOCK_VN_SIGNUPS;
  const originalLegacyKyc = process.env.ALLOW_LEGACY_KYC_SESSION_FOR_TESTS;

  afterEach(() => {
    if (originalBlockVn === undefined) {
      delete process.env.BLOCK_VN_SIGNUPS;
    } else {
      process.env.BLOCK_VN_SIGNUPS = originalBlockVn;
    }
    if (originalLegacyKyc === undefined) {
      delete process.env.ALLOW_LEGACY_KYC_SESSION_FOR_TESTS;
    } else {
      process.env.ALLOW_LEGACY_KYC_SESSION_FOR_TESTS = originalLegacyKyc;
    }
    jest.clearAllMocks();
  });

  it('blocks all hard-restricted & sanctioned jurisdictions with HTTP 451 while allowing health/cron bypass and local dev', async () => {
    expect(EEA_MEMBER_STATES).toHaveLength(30);

    const requiredBlockedSample = [
      'SG',
      'US',
      'GB',
      ...EEA_MEMBER_STATES,
      'CN',
      'HK',
      'JP',
      'TR',
      'RU',
      'BY',
      'KP',
      'IR',
      'SY',
      'CU',
    ];

    for (const country of requiredBlockedSample) {
      expect(HARD_BLOCKED_JURISDICTIONS.has(country)).toBe(true);

      const req = new NextRequest('https://apexos.app/en/signup', {
        headers: { 'CF-IPCountry': country },
      });
      const res = await middleware(req);
      expect(res.status).toBe(451);
      const body = (await res.json()) as {
        code: string;
        country: string;
        error: string;
      };
      expect(body.code).toBe('GEO_RESTRICTED');
      expect(body.country).toBe(country);
    }

    // /api/health and /api/cron must bypass geo-fencing even from SG/US
    const healthRes = await middleware(
      new NextRequest('https://apexos.app/api/health', {
        headers: { 'CF-IPCountry': 'SG' },
      })
    );
    expect(healthRes.status).not.toBe(451);

    const cronRes = await middleware(
      new NextRequest('https://apexos.app/api/cron', {
        headers: { 'CF-IPCountry': 'US' },
      })
    );
    expect(cronRes.status).not.toBe(451);

    // Local dev / unit tests with no CF-IPCountry header pass cleanly
    const localDecision = await evaluateGeoFence(
      new Request('http://localhost:3000/en/deals')
    );
    expect(localDecision.allowed).toBe(true);
    expect(localDecision.status).toBe(200);
  });

  it('defaults BLOCK_VN_SIGNUPS to false (allowing VN) and immediately blocks VN signups/referrals with 451 when enabled', async () => {
    delete process.env.BLOCK_VN_SIGNUPS;

    // Default false -> VN signup & shortlink allowed
    const vnDefaultAllowed = await evaluateGeoFence(
      new Request('https://apexos.app/en/signup', {
        headers: { 'CF-IPCountry': 'VN' },
      })
    );
    expect(vnDefaultAllowed.allowed).toBe(true);

    // Env kill-switch enabled -> 451 GEO_RESTRICTED_VN_KILLSWITCH
    process.env.BLOCK_VN_SIGNUPS = 'true';
    const vnMiddlewareBlocked = await middleware(
      new NextRequest('https://apexos.app/en/signup', {
        headers: { 'CF-IPCountry': 'VN' },
      })
    );
    expect(vnMiddlewareBlocked.status).toBe(451);
    const vnJson = (await vnMiddlewareBlocked.json()) as {
      code: string;
      country: string;
    };
    expect(vnJson.code).toBe('GEO_RESTRICTED_VN_KILLSWITCH');
    expect(vnJson.country).toBe('VN');

    const vnShortlinkBlocked = await evaluateGeoFence(
      new Request('https://apexos.app/r/toptrader', {
        headers: { 'CF-IPCountry': 'VN' },
      })
    );
    expect(vnShortlinkBlocked.allowed).toBe(false);
    expect(vnShortlinkBlocked.code).toBe('GEO_RESTRICTED_VN_KILLSWITCH');

    // D1 runtime flag kill-switch (when env var is unset) also triggers immediate 451
    delete process.env.BLOCK_VN_SIGNUPS;
    const sqlite = new Database(':memory:');
    sqlite.exec(`
      CREATE TABLE system_runtime_flags (
        flag_key TEXT PRIMARY KEY,
        flag_value TEXT NOT NULL
      );
      INSERT INTO system_runtime_flags (flag_key, flag_value) VALUES ('BLOCK_VN_SIGNUPS', 'true');
    `);
    const flagDb = createMinimalFlagDb(sqlite);
    const d1KillSwitchVerdict = await evaluateGeoFence(
      new Request('https://apexos.app/api/auth/signup', {
        method: 'POST',
        headers: { 'CF-IPCountry': 'VN' },
      }),
      { db: flagDb }
    );
    expect(d1KillSwitchVerdict.allowed).toBe(false);
    expect(d1KillSwitchVerdict.code).toBe('GEO_RESTRICTED_VN_KILLSWITCH');
    sqlite.close();
  });

  it('sets DEFAULT_LOCALE = "en" in middleware and src/app/page.tsx while keeping /vi supported', () => {
    expect(DEFAULT_LOCALE).toBe('en');
    expect(SUPPORTED_LOCALES).toContain('en');
    expect(SUPPORTED_LOCALES).toContain('vi');

    const homePageSource = fs.readFileSync(
      path.resolve(process.cwd(), 'src/app/page.tsx'),
      'utf8'
    );
    expect(homePageSource).toContain("redirect('/en')");
  });

  it('enforces Law 91/2025/QH15 KYC document minimization (410 KYC_DOCUMENT_COLLECTION_DISABLED by default)', async () => {
    delete process.env.ALLOW_LEGACY_KYC_SESSION_FOR_TESTS;

    // Unauthenticated -> 401
    (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValueOnce(null);
    const unauthRes = await kycInitiatePost(
      new NextRequest('http://localhost:3000/api/kyc/initiate', {
        method: 'POST',
      })
    );
    expect(unauthRes.status).toBe(401);

    // Authenticated -> 410 Gone
    (sessionHelper.getAuthenticatedUser as jest.Mock).mockResolvedValueOnce({
      id: 'usr_law91_check',
      email: 'trader@apexos.app',
    });
    const res410 = await kycInitiatePost(
      new NextRequest('http://localhost:3000/api/kyc/initiate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'sumsub' }),
      })
    );
    expect(res410.status).toBe(410);
    const payload = (await res410.json()) as {
      success: boolean;
      code: string;
      error: string;
    };
    expect(payload.success).toBe(false);
    expect(payload.code).toBe('KYC_DOCUMENT_COLLECTION_DISABLED');
    expect(payload.error).toContain('91/2025/QH15');
  });

  it('strips 100% of PII, CCCDs, IPs, phones, secrets, and unmasked wallets before Read-Only AI and enforces tool allowlist', () => {
    const rawEvm = '0x1234567890abcdef1234567890abcdef1234abcd';
    const rawStellar = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

    expect(maskWalletAddress(rawEvm)).toBe('0x1234...abcd');
    expect(maskWalletAddress(rawStellar)).toBe('GA5Z...KZVN');

    const rawInput = {
      userPrompt: `Check rebate for founder.nguyen@apexos.vn from IP 203.113.148.22 or 2001:db8:85a3::8a2e:370:7334, phone +84 912 345 678 / 0987654321, CCCD 079095012345, passport C8765432, EVM ${rawEvm}, Stellar ${rawStellar}, auth Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U and key sk_live_99887766554433221100`,
      email: 'ceo@client.vn',
      cccd_number: '001092004567',
      api_key: 're_super_secret_resend_key_123456',
      sessionToken: 'sess_raw_secret_token_99999',
      nested: {
        requested_ip: '118.69.12.44',
        metrics: { rebateBps: 3000, volumeUsd: 125000 },
      },
    };

    const result = redactPiiForReadOnlyAi(rawInput, {
      requestedTools: ['get_fee_analytics_summary', 'explain_settlement_timeline'],
    });

    const serialized = JSON.stringify(result.redacted);

    expect(result.readOnlyVerified).toBe(true);
    expect(result.redactionCount).toBeGreaterThanOrEqual(12);

    // Zero raw PII or secrets remain
    expect(serialized).not.toContain('founder.nguyen@apexos.vn');
    expect(serialized).not.toContain('ceo@client.vn');
    expect(serialized).not.toContain('203.113.148.22');
    expect(serialized).not.toContain('2001:db8:85a3::8a2e:370:7334');
    expect(serialized).not.toContain('118.69.12.44');
    expect(serialized).not.toContain('912 345 678');
    expect(serialized).not.toContain('0987654321');
    expect(serialized).not.toContain('079095012345');
    expect(serialized).not.toContain('001092004567');
    expect(serialized).not.toContain('C8765432');
    expect(serialized).not.toContain('sk_live_99887766554433221100');
    expect(serialized).not.toContain('re_super_secret_resend_key_123456');
    expect(serialized).not.toContain('sess_raw_secret_token_99999');
    expect(serialized).not.toContain(rawEvm);
    expect(serialized).not.toContain(rawStellar);

    // Masked wallet forms & clean metrics remain intact
    expect(serialized).toContain('0x1234...abcd');
    expect(serialized).toContain('GA5Z...KZVN');
    expect(result.redacted.nested.metrics.rebateBps).toBe(3000);

    // Forbidden write/payout/secret AI tools throw immediately
    expect(() => assertReadOnlyAiTools(['approve_payout_batch'])).toThrow();
    expect(() => assertReadOnlyAiTools(['write_ledger_posting'])).toThrow();
    expect(() => assertReadOnlyAiTools(['change_user_wallet'])).toThrow();
    expect(() => assertReadOnlyAiTools(['read_env_secrets'])).toThrow();
  });

  it('enforces Apple Guideline 3.1.5(v) read-only fee analytics & validates public/manifest.json', () => {
    const manifestRaw = fs.readFileSync(
      path.resolve(process.cwd(), 'public/manifest.json'),
      'utf8'
    );
    const manifest = JSON.parse(manifestRaw) as {
      name: string;
      description: string;
      lang: string;
    };

    expect(manifest.lang).toBe('en');
    expect(manifest.description.toLowerCase()).not.toContain('multi-tier commissions');

    // Valid PWA configuration passes
    const validVerdict = assertAppStorePolicyCompliance({
      platform: 'pwa',
      mode: 'read_only_fee_analytics',
      custodialWalletEnabled: false,
      inAppTokenTransfersEnabled: false,
      multiTierCommissionPromoted: false,
      rewardTasks: [
        { id: 't_rebate', kind: 'verified_trade_fee_rebate', enabled: true },
      ],
      manifest,
    });
    expect(validVerdict.compliant).toBe(true);

    // Incentivized app_install / social_share or custodial wallet on iOS is blocked
    const badVerdict = evaluateAppStorePolicyCompliance({
      platform: 'ios',
      mode: 'full_transactional',
      custodialWalletEnabled: true,
      inAppTokenTransfersEnabled: true,
      rewardTasks: [
        { id: 'r1', kind: 'app_install', enabled: true },
        { id: 'r2', kind: 'social_share', enabled: true },
      ],
    });
    expect(badVerdict.compliant).toBe(false);
    expect(badVerdict.violations.length).toBeGreaterThanOrEqual(4);
    expect(() =>
      assertAppStorePolicyCompliance({
        platform: 'ios',
        mode: 'read_only_fee_analytics',
        rewardTasks: [{ id: 'r1', kind: 'app_install', enabled: true }],
      })
    ).toThrow(/APPLE_REWARD_TASK_PROHIBITED/);
  });

  it('verifies package-lock.json contains zero AGPL-3.0 / GPL-3.0 / SSPL-1.0 / ELv2 production licenses', () => {
    const lockRaw = fs.readFileSync(
      path.resolve(process.cwd(), 'package-lock.json'),
      'utf8'
    );
    const lockJson = JSON.parse(lockRaw) as {
      packages?: Record<string, { dev?: boolean; license?: unknown }>;
    };

    const forbiddenSpdxRegex =
      /(?<![A-Z])(?:AGPL-3\.0|GPL-3\.0|SSPL-1\.0|ELv2)(?:-(?:only|or-later))?(?![A-Za-z0-9])/;

    // Sanity check regex catches every restricted license token while allowing LGPL dynamic library bindings
    expect(forbiddenSpdxRegex.test('AGPL-3.0-only')).toBe(true);
    expect(forbiddenSpdxRegex.test('GPL-3.0-or-later')).toBe(true);
    expect(forbiddenSpdxRegex.test('SSPL-1.0')).toBe(true);
    expect(forbiddenSpdxRegex.test('ELv2')).toBe(true);
    expect(forbiddenSpdxRegex.test('LGPL-3.0-or-later')).toBe(false);

    const violations: Array<{ pkg: string; license: string }> = [];
    for (const [pkgPath, meta] of Object.entries(lockJson.packages ?? {})) {
      if (!pkgPath || meta.dev === true) continue;
      const licenseStr = typeof meta.license === 'string' ? meta.license : '';
      if (licenseStr && forbiddenSpdxRegex.test(licenseStr)) {
        violations.push({ pkg: pkgPath, license: licenseStr });
      }
    }

    expect(violations).toEqual([]);
  });
});
