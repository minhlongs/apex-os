/**
 * @jest-environment node
 *
 * Phase 2 WS-C & Gate G1/G2 Verification Suite:
 * - White-Label B2B Agency Split Contracts (`b2b_agency_contracts` + `/api/admin/b2b-contracts`)
 * - Solvency cap enforcement (`tier1SpreadBps + tier2SpreadBps <= 4500`, `tier2SpreadBps <= 1000`, `clawbackReserveBps >= 500`)
 * - Vietnam Decree 40/2018/ND-CP hard-lock (`tier3SpreadBps === 0`)
 * - Automated Partner Poller integration with provisioned `b2b_agency_contracts` schedules
 * - Canonical Origin Guard (`G2`): quarantines unowned `apexos.app`, `apex-os.pages.dev`, `apex-os.com`, `apexos.io`, `long-tran624.workers.dev`
 */

let activeTestDb: AuthD1Database | null = null;
let mockAuthenticatedUser: { id: string; email?: string } | null = null;
let mockPasskeyStepUpAuthorized = false;

jest.mock('@/lib/auth/session-helper', () => ({
  resolveDatabase: () => activeTestDb,
  getAuthenticatedUser: async () => mockAuthenticatedUser,
}));

jest.mock('@/lib/auth/passkey-step-up', () => {
  const actual = jest.requireActual('@/lib/auth/passkey-step-up');
  return {
    ...actual,
    requireAdminWithPasskeyStepUp: async () => {
      if (!mockAuthenticatedUser) {
        return {
          authorized: false,
          status: 401,
          code: 'UNAUTHENTICATED',
          error: 'Authentication required',
        };
      }
      if (!mockPasskeyStepUpAuthorized) {
        return {
          authorized: false,
          status: 403,
          code: 'PASSKEY_STEPUP_REQUIRED',
          error: 'WebAuthn Passkey step-up required',
        };
      }
      return {
        authorized: true,
        status: 200,
        adminId: mockAuthenticatedUser.id,
      };
    },
  };
});

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import type { D1Database as AuthD1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  CANONICAL_PRODUCTION_ORIGIN,
  CANONICAL_STAGING_ORIGIN,
  isQuarantinedThirdPartyHost,
  resolveCanonicalAppOrigin,
} from '@/config/canonical-origin';
import {
  computeSafeSpreadWaterfall,
  getB2bAgencyContractByProfileId,
  InvalidWaterfallConfigError,
  listB2bAgencyContracts,
  parseUsdToLedgerUnits,
  upsertB2bAgencyContract,
} from '@/lib/ledger';
import { GET as getB2bContracts, POST as postB2bContracts } from '@/app/api/admin/b2b-contracts/route';

function createSqliteD1(): { sqlite: Database.Database; d1: AuthD1Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(`
    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      email TEXT,
      role TEXT NOT NULL DEFAULT 'user',
      referral_code TEXT
    );
  `);
  const mig028 = readFileSync(
    join(process.cwd(), 'src/database/migrations/028_ascendancy_audit_core.sql'),
    'utf8'
  );
  const mig031 = readFileSync(
    join(process.cwd(), 'src/database/migrations/031_ascendancy_phase2_ui_and_poller.sql'),
    'utf8'
  );
  sqlite.exec(mig028);
  sqlite.exec(mig031);

  const makeStmt = (sql: string, bound: unknown[] = []) => ({
    bind: (...args: unknown[]) => makeStmt(sql, args),
    first: async <T = Record<string, unknown>>(col?: string): Promise<T | null> => {
      const row = sqlite.prepare(sql).get(...bound) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (col) return (row[col] as T) ?? null;
      return row as T;
    },
    all: async <T = Record<string, unknown>>() => {
      const rows = sqlite.prepare(sql).all(...bound) as T[];
      return { success: true, results: rows };
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...bound);
      return {
        success: true,
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      };
    },
  });

  const d1: AuthD1Database = {
    prepare: (sql: string) => makeStmt(sql),
    batch: async (stmts) => {
      const out = [];
      for (const s of stmts) {
        out.push(await s.run());
      }
      return out;
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
  };

  return { sqlite, d1 };
}

describe('Gate G1 & WS-C: White-Label B2B Agency Split Contracts', () => {
  beforeEach(() => {
    mockAuthenticatedUser = null;
    mockPasskeyStepUpAuthorized = false;
    activeTestDb = null;
  });

  it('provisions a compliant B2B split schedule and conserves 100% of 10^-8 USD gross commission with L3 = 0', async () => {
    const { d1 } = createSqliteD1();
    await d1
      .prepare('INSERT INTO profiles (id, email, role) VALUES (?, ?, ?), (?, ?, ?)')
      .bind('admin_1', 'admin@apex-os.local', 'admin', 'agency_quant_1', 'desk@quant.local', 'affiliate')
      .run();

    const contract = await upsertB2bAgencyContract(d1, {
      agencyProfileId: 'agency_quant_1',
      agencyName: 'Mekong Quant Syndicate',
      clawbackReserveBps: 500, // 5%
      traderCashbackBps: 5000, // 50% of D -> 47.50% gross
      tier1SpreadBps: 3000, // 30% of S -> 14.25% gross
      tier2SpreadBps: 1000, // 10% of S -> 4.75% gross
      tier3SpreadBps: 0,
      actorAdminId: 'admin_1',
    });

    expect(contract.tier3SpreadBps).toBe(0);
    expect(contract.effectiveGrossSharesPct).toEqual({
      clawbackReservePct: '5.00',
      traderCashbackPct: '47.50',
      l1AffiliatePct: '14.25',
      b2bAgencyL2Pct: '4.75',
      l3CapPct: '0.00',
      platformNetPct: '28.50',
    });

    const gross = parseUsdToLedgerUnits('100.00000001');
    const alloc = computeSafeSpreadWaterfall(gross, {
      config: contract.waterfallConfig,
      hasL1Referrer: true,
      hasB2bAgencyPartner: true,
    });

    const sum =
      alloc.reserveUnits +
      alloc.traderCashbackUnits +
      alloc.l1CommissionUnits +
      alloc.l2CommissionUnits +
      alloc.l3CommissionUnits +
      alloc.platformNetUnits;
    expect(alloc.l3CommissionUnits).toBe(BigInt(0));
    expect(sum).toBe(gross);

    const fetched = await getB2bAgencyContractByProfileId(d1, 'agency_quant_1');
    expect(fetched?.agencyName).toBe('Mekong Quant Syndicate');
    const all = await listB2bAgencyContracts(d1);
    expect(all).toHaveLength(1);
  });

  it('hard-blocks L3 > 0 (Decree 40/2018/ND-CP) and combined partner spread > 4500 bps (Solvency Cap G1)', async () => {
    const { d1 } = createSqliteD1();
    await d1
      .prepare('INSERT INTO profiles (id, email, role) VALUES (?, ?, ?), (?, ?, ?)')
      .bind('admin_1', 'admin@apex-os.local', 'admin', 'agency_bad', 'bad@quant.local', 'affiliate')
      .run();

    await expect(
      upsertB2bAgencyContract(d1, {
        agencyProfileId: 'agency_bad',
        agencyName: 'Illegal MLM Desk',
        tier3SpreadBps: 100,
        actorAdminId: 'admin_1',
      })
    ).rejects.toThrow(InvalidWaterfallConfigError);

    await expect(
      upsertB2bAgencyContract(d1, {
        agencyProfileId: 'agency_bad',
        agencyName: 'Insolvent Split Desk',
        tier1SpreadBps: 3800,
        tier2SpreadBps: 900,
        actorAdminId: 'admin_1',
      })
    ).rejects.toThrow(/Solvency cap violation/);

    await expect(
      upsertB2bAgencyContract(d1, {
        agencyProfileId: 'agency_bad',
        agencyName: 'Under-Reserved Desk',
        clawbackReserveBps: 400,
        actorAdminId: 'admin_1',
      })
    ).rejects.toThrow(/clawbackReserveBps/);
  });

  it('enforces Admin + WebAuthn Passkey step-up on POST /api/admin/b2b-contracts', async () => {
    const { d1 } = createSqliteD1();
    activeTestDb = d1;
    await d1
      .prepare('INSERT INTO profiles (id, email, role) VALUES (?, ?, ?), (?, ?, ?)')
      .bind('admin_1', 'admin@apex-os.local', 'admin', 'agency_2', 'desk2@quant.local', 'affiliate')
      .run();

    const unauthRes = await getB2bContracts(
      new NextRequest('http://localhost:3000/api/admin/b2b-contracts')
    );
    expect(unauthRes.status).toBe(401);

    mockAuthenticatedUser = { id: 'admin_1', email: 'admin@apex-os.local' };
    mockPasskeyStepUpAuthorized = false;
    const noStepUpRes = await postB2bContracts(
      new NextRequest('http://localhost:3000/api/admin/b2b-contracts', {
        method: 'POST',
        body: JSON.stringify({
          agencyProfileId: 'agency_2',
          agencyName: 'Desk Two',
          tier1SpreadBps: 3000,
          tier2SpreadBps: 800,
        }),
      })
    );
    expect(noStepUpRes.status).toBe(403);

    mockPasskeyStepUpAuthorized = true;
    const okRes = await postB2bContracts(
      new NextRequest('http://localhost:3000/api/admin/b2b-contracts', {
        method: 'POST',
        body: JSON.stringify({
          agencyProfileId: 'agency_2',
          agencyName: 'Desk Two',
          tier1SpreadBps: 3000,
          tier2SpreadBps: 800,
        }),
      })
    );
    expect(okRes.status).toBe(200);
    const okJson = (await okRes.json()) as {
      success: boolean;
      contract: { tier2SpreadBps: number; tier3SpreadBps: number };
    };
    expect(okJson.success).toBe(true);
    expect(okJson.contract.tier2SpreadBps).toBe(800);
    expect(okJson.contract.tier3SpreadBps).toBe(0);
  });
});

describe('Gate G2: Canonical Origin & Third-Party Domain Quarantine', () => {
  it('quarantines unowned third-party and NXDOMAIN hostnames', () => {
    expect(isQuarantinedThirdPartyHost('apexos.app')).toBe(true);
    expect(isQuarantinedThirdPartyHost('www.apexos.app')).toBe(true);
    expect(isQuarantinedThirdPartyHost('apex-os.pages.dev')).toBe(true);
    expect(isQuarantinedThirdPartyHost('apex-os.com')).toBe(true);
    expect(isQuarantinedThirdPartyHost('apexos.io')).toBe(true);
    expect(isQuarantinedThirdPartyHost('apex-os-staging.long-tran624.workers.dev')).toBe(true);

    expect(isQuarantinedThirdPartyHost('apex-os.agencyos-openclaw.workers.dev')).toBe(false);
    expect(isQuarantinedThirdPartyHost('apex-os-staging.agencyos-openclaw.workers.dev')).toBe(false);
  });

  it('rejects quarantined env URLs and falls back to verified Worker origins', () => {
    expect(
      resolveCanonicalAppOrigin({
        appUrl: 'https://apexos.app',
        siteUrl: 'https://apex-os.pages.dev',
        baseUrl: 'https://apex-os.com',
        appEnv: 'production',
      })
    ).toBe(CANONICAL_PRODUCTION_ORIGIN);

    expect(
      resolveCanonicalAppOrigin({
        appUrl: 'https://apexos.io',
        appEnv: 'staging',
      })
    ).toBe(CANONICAL_STAGING_ORIGIN);

    expect(
      resolveCanonicalAppOrigin({
        appUrl: 'https://rebate.agencyos.network',
        appEnv: 'production',
      })
    ).toBe('https://rebate.agencyos.network');
  });
});
