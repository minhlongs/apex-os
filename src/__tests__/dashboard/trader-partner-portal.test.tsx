import React from 'react';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { NextRequest } from 'next/server';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

jest.mock('@/lib/auth/webauthn-browser', () => ({
  obtainAdminStepUpToken: jest.fn(async () => ({
    stepUpToken: 'stepup_token_manual_dispatch',
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
  })),
}));

jest.mock('@/lib/ledger', () => {
  const actual = jest.requireActual<typeof import('@/lib/ledger')>('@/lib/ledger');
  return {
    ...actual,
    listProofsOfRebateByAffiliateId: jest.fn(actual.listProofsOfRebateByAffiliateId),
  };
});

import * as dbModule from '@/lib/db';
import { GET as b2bProofGet } from '@/app/api/b2b/proof-of-rebate/route';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  listProofsOfRebateByAffiliateId,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
} from '@/lib/ledger';
import {
  checkSlidingWindowRateLimit,
  resetEndpointRateLimits,
} from '@/lib/auth/passkey-step-up';
import {
  GET as uidsGet,
  POST as uidsPost,
  DELETE as uidsDelete,
} from '@/app/api/affiliate/uids/route';
import {
  GET as shortLinksGet,
  POST as shortLinksPost,
  PATCH as shortLinksPatch,
} from '@/app/api/affiliate/short-links/route';
import { GET as ledgerSummaryGet } from '@/app/api/affiliate/ledger-summary/route';
import NonCustodialUidPanel from '@/components/dashboard/non-custodial-uid-panel';
import ShortLinksGeneratorPanel from '@/components/dashboard/short-links-generator-panel';
import RebateLedgerWaterfallPanel from '@/components/dashboard/rebate-ledger-waterfall-panel';
import PayoutWalletTimelockPanel from '@/components/dashboard/payout-wallet-timelock-panel';
import { AscendancyOpsPanel } from '@/components/admin/treasury/ascendancy-ops-panel';

function createPortalTestDb(): {
  sqlite: Database.Database;
  db: SqliteD1Adapter;
} {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  const migrationsDir = path.resolve(process.cwd(), 'src/database/migrations');
  for (const file of [
    '001_initial_schema_d1.sql',
    '003_affiliate_schema.sql',
    '028_ascendancy_audit_core.sql',
    '031_ascendancy_phase2_ui_and_poller.sql',
  ]) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
  }

  sqlite.exec(`
    ALTER TABLE profiles ADD COLUMN wallet_address TEXT;
    ALTER TABLE profiles ADD COLUMN preferred_chain TEXT;

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL
    );
  `);

  const futureIso = new Date(Date.now() + 24 * 3600 * 1000).toISOString();

  sqlite
    .prepare(
      `INSERT INTO profiles (id, email, role, referral_code, referred_by, wallet_address, preferred_chain)
       VALUES
         ('user_alice', 'alice@apexos.example', 'affiliate', 'ALICE_CODE', NULL, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'arbitrum'),
         ('user_bob', 'bob@apexos.example', 'affiliate', 'BOB_CODE', 'ALICE_CODE', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'base'),
         ('user_carol_l2', 'carol@apexos.example', 'affiliate', 'CAROL_CODE', 'BOB_CODE', NULL, NULL),
         ('user_dave_l3', 'dave@apexos.example', 'master_trader', 'DAVE_CODE', 'CAROL_CODE', NULL, NULL)`
    )
    .run();

  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at)
       VALUES
         ('sess_alice', 'user_alice', 'tok_alice_valid', ?),
         ('sess_bob', 'user_bob', 'tok_bob_valid', ?)`
    )
    .run(futureIso, futureIso);

  // Seed referral_tree with L1, L2, and L3 (to prove L3 is strictly excluded)
  sqlite
    .prepare(
      `INSERT INTO referral_tree (id, affiliate_id, parent_id, level)
       VALUES
         ('rt_alice', 'user_alice', NULL, 1),
         ('rt_bob_l1', 'user_bob', 'rt_alice', 2),
         ('rt_carol_l2', 'user_carol_l2', 'rt_bob_l1', 3),
         ('rt_dave_l3', 'user_dave_l3', 'rt_carol_l2', 4)`
    )
    .run();

  return { sqlite, db: new SqliteD1Adapter(sqlite) };
}

function makeAuthRequest(
  url: string,
  options: {
    method?: string;
    token?: string;
    body?: Record<string, unknown>;
    headers?: Record<string, string>;
  } = {}
): NextRequest {
  const headers: Record<string, string> = {
    host: 'portal.apexos.app',
    'x-forwarded-proto': 'https',
    ...options.headers,
  };
  if (options.token) {
    headers.cookie = `session_token=${options.token}`;
  }
  if (options.body) {
    headers['content-type'] = 'application/json';
  }
  return new NextRequest(url, {
    method: options.method ?? 'GET',
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Workstream B: Ascendancy Phase 2 Trader & B2B Partner Portal APIs', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;

  beforeEach(() => {
    resetEndpointRateLimits();
    const built = createPortalTestDb();
    sqlite = built.sqlite;
    db = built.db;
    r2 = new InMemoryR2Bucket();
    (globalThis as unknown as { DB?: unknown; STORAGE?: unknown }).DB = db;
    (globalThis as unknown as { STORAGE?: unknown }).STORAGE = r2;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(db);
  });

  afterEach(async () => {
    resetEndpointRateLimits();
    delete (globalThis as unknown as { DB?: unknown }).DB;
    delete (globalThis as unknown as { STORAGE?: unknown }).STORAGE;
    jest.restoreAllMocks();
    await db.close();
  });

  describe('/api/affiliate/uids (GET / POST / DELETE)', () => {
    it('rejects unauthenticated requests (401) and cross-account IDOR queries (403)', async () => {
      const unauth = await uidsGet(makeAuthRequest('https://portal.apexos.app/api/affiliate/uids'));
      expect(unauth.status).toBe(401);

      const idorGet = await uidsGet(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids?profile_id=user_bob', {
          token: 'tok_alice_valid',
        })
      );
      expect(idorGet.status).toBe(403);
      const idorBody = await idorGet.json();
      expect(idorBody.code).toBe('IDOR_FORBIDDEN');

      const idorPost = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: {
            profileId: 'user_bob',
            exchange: 'bybit',
            exchangeUid: '99887766',
          },
        })
      );
      expect(idorPost.status).toBe(403);
    });

    it('rejects API secrets (400), rejects Binance Standard Referral Pro (422), binds approved 5-exchange UIDs, rejects duplicates (409), and enforces immutable VERIFIED_BY_PARTNER lock', async () => {
      // 0. Reject any payload containing API key / API secret (strict non-custodial invariant)
      const secretRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: {
            exchange: 'bybit',
            exchangeUid: '12345678',
            apiSecret: 'NEVER_SEND_API_SECRETS',
          },
        })
      );
      expect(secretRes.status).toBe(400);
      expect((await secretRes.json()).code).toBe('NON_CUSTODIAL_UID_ONLY');

      // 1. Reject Binance Standard Referral Pro (422 BINANCE_UID_ATTRIBUTION_UNSUPPORTED)
      const binanceRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: { exchange: 'binance', exchangeUid: '12345678' },
        })
      );
      expect(binanceRes.status).toBe(422);
      const binanceJson = await binanceRes.json();
      expect(binanceJson.code).toBe('BINANCE_UID_ATTRIBUTION_UNSUPPORTED');

      // 2. Bind Bybit (LIVE) and KuCoin (SHADOW_30D)
      const bybitRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: { exchange: 'bybit', exchangeUid: 'BYBIT_UID_9001' },
        })
      );
      expect(bybitRes.status).toBe(201);
      const bybitJson = await bybitRes.json();
      expect(bybitJson.uid.exchange).toBe('bybit');
      expect(bybitJson.uid.exchangeMode).toBe('LIVE');
      expect(bybitJson.uid.verificationStatus).toBe('PENDING_FIRST_TRADE');

      const kucoinRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: { exchange: 'kucoin', exchangeUid: 'KC_UID_7700' },
        })
      );
      expect(kucoinRes.status).toBe(201);
      const kucoinJson = await kucoinRes.json();
      expect(kucoinJson.uid.exchangeMode).toBe('SHADOW_30D');

      // 3. Reject duplicate (exchange, exchange_uid) even from another account
      const dupRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_bob_valid',
          body: { exchange: 'bybit', exchangeUid: 'BYBIT_UID_9001' },
        })
      );
      expect(dupRes.status).toBe(409);
      expect((await dupRes.json()).code).toBe('EXCHANGE_UID_ALREADY_BOUND');

      // 4. Cross-account DELETE attempt by Bob on Alice's UID -> 403 IDOR_FORBIDDEN
      const bobDeleteAlice = await uidsDelete(
        makeAuthRequest(
          `https://portal.apexos.app/api/affiliate/uids?id=${encodeURIComponent(bybitJson.uid.id)}`,
          { method: 'DELETE', token: 'tok_bob_valid' }
        )
      );
      expect(bobDeleteAlice.status).toBe(403);

      // 5. Alice deletes unverified KuCoin UID -> 200
      const deletePending = await uidsDelete(
        makeAuthRequest(
          `https://portal.apexos.app/api/affiliate/uids?id=${encodeURIComponent(kucoinJson.uid.id)}`,
          { method: 'DELETE', token: 'tok_alice_valid' }
        )
      );
      expect(deletePending.status).toBe(200);

      // 6. Promote Bybit UID to VERIFIED_BY_PARTNER and verify DELETE is rejected (409)
      sqlite
        .prepare(
          `UPDATE trader_exchange_uids
           SET verification_status = 'VERIFIED_BY_PARTNER'
           WHERE id = ?`
        )
        .run(bybitJson.uid.id);

      const deleteVerified = await uidsDelete(
        makeAuthRequest(
          `https://portal.apexos.app/api/affiliate/uids?id=${encodeURIComponent(bybitJson.uid.id)}`,
          { method: 'DELETE', token: 'tok_alice_valid' }
        )
      );
      expect(deleteVerified.status).toBe(409);
      expect((await deleteVerified.json()).code).toBe('VERIFIED_UID_IMMUTABLE');
    });

    it('rejects malformed and API-key-shaped exchange UIDs with 400 INVALID_EXCHANGE_UID while accepting real partner UIDs', async () => {
      const invalidUids = [
        '----',
        '____',
        'johndoe',
        'ab_12',
        'api_key_51QaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab',
      ];

      for (const exchangeUid of invalidUids) {
        const res = await uidsPost(
          makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
            method: 'POST',
            token: 'tok_alice_valid',
            body: { exchange: 'bybit', exchangeUid },
          })
        );
        expect(res.status).toBe(400);
        expect((await res.json()).code).toBe('INVALID_EXCHANGE_UID');
      }

      // Sanity check: the 48-character API-key-shaped string really is in the rejected range
      expect(
        'api_key_51QaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab'.length
      ).toBeGreaterThan(32);

      const validRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: { exchange: 'bybit', exchangeUid: '104928371' },
        })
      );
      expect(validRes.status).toBe(201);
      expect((await validRes.json()).uid.exchangeUid).toBe('104928371');
    });

    it('rate-limits exchange UID binding enumeration with 429 RATE_LIMITED and Retry-After after 10 rapid POSTs', async () => {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        const res = await uidsPost(
          makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
            method: 'POST',
            token: 'tok_alice_valid',
            body: { exchange: 'bybit', exchangeUid: `1000000${attempt}` },
          })
        );
        expect(res.status).toBe(201);
      }

      const limitedRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: { exchange: 'bybit', exchangeUid: '1000000999' },
        })
      );
      expect(limitedRes.status).toBe(429);
      const limitedJson = await limitedRes.json();
      expect(limitedJson.code).toBe('RATE_LIMITED');
      expect(limitedRes.headers.get('Retry-After')).toBeTruthy();

      // A different account behind the same IP is still under the per-IP ceiling (20/min).
      const otherUserRes = await uidsPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids', {
          method: 'POST',
          token: 'tok_bob_valid',
          body: { exchange: 'okx', exchangeUid: '2000000123' },
        })
      );
      expect(otherUserRes.status).toBe(201);

      // DELETE rate limit: after 15 rapid DELETE requests from the same user, the 16th returns 429 RATE_LIMITED + Retry-After.
      for (let delAttempt = 0; delAttempt < 15; delAttempt += 1) {
        const delRes = await uidsDelete(
          makeAuthRequest(
            `https://portal.apexos.app/api/affiliate/uids?id=nonexistent_${delAttempt}`,
            { method: 'DELETE', token: 'tok_alice_valid' }
          )
        );
        expect(delRes.status).toBe(404);
      }

      const deleteLimited = await uidsDelete(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/uids?id=nonexistent_16', {
          method: 'DELETE',
          token: 'tok_alice_valid',
        })
      );
      expect(deleteLimited.status).toBe(429);
      expect((await deleteLimited.json()).code).toBe('RATE_LIMITED');
      expect(deleteLimited.headers.get('Retry-After')).toBeTruthy();
    });
  });

  describe('/api/affiliate/short-links (GET / POST / PATCH)', () => {
    it('validates allowlisted HTTPS partner URLs, creates /r/:code links, isolates owners, and toggles active state', async () => {
      // 1. Reject open redirect / untrusted domain
      const evilRes = await shortLinksPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: {
            exchange: 'bybit',
            destinationUrl: 'https://phishing-bybit.evil.org/invite',
          },
        })
      );
      expect(evilRes.status).toBe(400);
      expect((await evilRes.json()).code).toBe('UNTRUSTED_DESTINATION_URL');

      // 2. Reject HTTP (non-HTTPS) destination
      const httpRes = await shortLinksPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: {
            exchange: 'okx',
            destinationUrl: 'http://www.okx.com/join/ALICE',
          },
        })
      );
      expect(httpRes.status).toBe(400);

      // 3. Reject exchange/domain mismatch
      const mismatchRes = await shortLinksPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: {
            exchange: 'bybit',
            destinationUrl: 'https://www.okx.com/join/ALICE',
          },
        })
      );
      expect(mismatchRes.status).toBe(400);
      expect((await mismatchRes.json()).code).toBe('DESTINATION_EXCHANGE_MISMATCH');

      // 4. Create valid short link with custom code
      const createRes = await shortLinksPost(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          method: 'POST',
          token: 'tok_alice_valid',
          body: {
            exchange: 'okx',
            destinationUrl: 'https://www.okx.com/join/ALICE99',
            campaignTag: 'vip-desk-q4',
            customCode: 'alice_okx1',
          },
        })
      );
      expect(createRes.status).toBe(201);
      const createdJson = await createRes.json();
      expect(createdJson.shortLink.code).toBe('alice_okx1');
      expect(createdJson.shortLink.shortUrl).toBe('https://portal.apexos.app/r/alice_okx1');
      expect(createdJson.shortLink.isActive).toBe(true);

      // 5. Bob cannot see Alice's short links nor toggle Alice's link
      const bobListRes = await shortLinksGet(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          token: 'tok_bob_valid',
        })
      );
      const bobListJson = await bobListRes.json();
      expect(bobListJson.shortLinks).toHaveLength(0);

      const bobToggleRes = await shortLinksPatch(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          method: 'PATCH',
          token: 'tok_bob_valid',
          body: { code: 'alice_okx1', isActive: false },
        })
      );
      expect(bobToggleRes.status).toBe(403);
      expect((await bobToggleRes.json()).code).toBe('IDOR_FORBIDDEN');

      // 6. Alice pauses her own link
      const aliceToggleRes = await shortLinksPatch(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/short-links', {
          method: 'PATCH',
          token: 'tok_alice_valid',
          body: { code: 'alice_okx1', isActive: false },
        })
      );
      expect(aliceToggleRes.status).toBe(200);
      const aliceToggleJson = await aliceToggleRes.json();
      expect(aliceToggleJson.shortLink.isActive).toBe(false);
    });
  });

  describe('/api/affiliate/ledger-summary (GET)', () => {
    it('formats exact 10^-8 integer unit balances via BigInt without float drift, redacts UIDs to ***1234 with zero PII, and strictly caps partner tree at L2', async () => {
      const ledger = new DoubleEntryLedgerService(db);

      // Seed verified R2 evidence + reconciled partner cash batch ($100.12345678 gross commission)
      const grossUnits = parseUsdToLedgerUnits('100.12345678');
      const uidEvidence = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ traderUid: 'SECRET_TRADER_9876', gross: '100.12345678' }),
        statementPeriodStart: '2026-11-10T00:00:00.000Z',
        statementPeriodEnd: '2026-11-10T23:59:59.000Z',
      });
      const walletEvidence = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ walletDeposit: '100.12345678' }),
        statementPeriodStart: '2026-11-10T00:00:00.000Z',
        statementPeriodEnd: '2026-11-10T23:59:59.000Z',
      });

      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEvidence.id,
        walletEvidenceId: walletEvidence.id,
        uidAllocatedUnits: grossUnits,
        walletCashCollectedUnits: grossUnits,
        r2,
      });

      // Alice is L1 affiliate for trader Bob (raw exchange UID: SECRET_TRADER_9876)
      await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'wsb-summary-comm-1',
        exchange: 'bybit',
        traderUid: 'SECRET_TRADER_9876',
        traderId: 'user_bob',
        l1AffiliateId: 'user_alice',
        reconciliationId: recon.id,
        evidenceId: uidEvidence.id,
        grossCommissionUnits: grossUnits,
        r2,
      });

      const res = await ledgerSummaryGet(
        makeAuthRequest('https://portal.apexos.app/api/affiliate/ledger-summary', {
          token: 'tok_alice_valid',
        })
      );
      expect(res.status).toBe(200);
      const rawText = JSON.stringify(await res.json());

      // Zero PII leakage invariants: no raw trader UID, no email '@' anywhere in response
      expect(rawText).not.toContain('SECRET_TRADER_9876');
      expect(rawText).not.toContain('@');

      const summary = JSON.parse(rawText);
      expect(summary.success).toBe(true);

      // Exact BigInt 10^-8 USD units on Alice's L1 affiliate commission.
      // C = 10,012,345,678 -> R = ceil(5%) = 500,617,284 -> D = 9,511,728,394
      // -> trader cashback = floor(50% of D) = 4,755,864,197
      // -> spread S = 4,755,864,197 -> L1 = floor(30% of S) = 1,426,759,259
      expect(summary.balances.inflightUnits).toBe('1426759259');
      expect(summary.balances.inflightUsdExact).toBe('14.26759259');
      expect(summary.balances.inflightUsd).toBe('14.26');
      expect(summary.balances.minimumWithdrawalUnits).toBe('1000000000');
      expect(summary.balances.minimumWithdrawalUsd).toBe('10.00');

      // Proof-of-Rebate record present with masked ***9876 UID and 64-hex SHA-256 digests
      expect(summary.proofsOfRebate).toHaveLength(1);
      expect(summary.proofsOfRebate[0].maskedTraderUid).toBe('***9876');
      expect(summary.proofsOfRebate[0].proofDigestSha256).toMatch(/^[a-f0-9]{64}$/);
      expect(summary.proofsOfRebate[0].evidence.payloadSha256).toBe(uidEvidence.payloadSha256);
      expect(summary.proofsOfRebate[0].evidence.r2IntegrityVerified).toBe(true);

      // Strictly 2-Level Partner Tree: Bob (L1) + Carol (L2) included, Dave (L3) strictly excluded
      expect(summary.partnerTree.maxAllowedDepth).toBe(2);
      expect(summary.partnerTree.l1DirectCount).toBe(1);
      expect(summary.partnerTree.l2SubAffiliateCount).toBe(1);
      const partnerIds = summary.partnerTree.nodes.map((n: { partnerId: string }) => n.partnerId);
      expect(partnerIds).toContain('user_bob');
      expect(partnerIds).toContain('user_carol_l2');
      expect(partnerIds).not.toContain('user_dave_l3');
    });
  });

  describe('/api/b2b/proof-of-rebate (GET)', () => {
    const originalB2bKey = process.env.B2B_PROOF_API_KEY;

    afterEach(() => {
      if (originalB2bKey === undefined) {
        delete process.env.B2B_PROOF_API_KEY;
      } else {
        process.env.B2B_PROOF_API_KEY = originalB2bKey;
      }
    });

    it('authenticates x-b2b-api-key via SHA-256 digest equality and rejects mismatched-length and same-length wrong keys with 401', async () => {
      process.env.B2B_PROOF_API_KEY = 'b2b-secret-key-0123456789abcdef';

      const ledger = new DoubleEntryLedgerService(db);
      const grossUnits = parseUsdToLedgerUnits('50.00000000');
      const uidEvidence = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ traderUid: 'TRADER_4321', gross: '50.00000000' }),
        statementPeriodStart: '2026-11-11T00:00:00.000Z',
        statementPeriodEnd: '2026-11-11T23:59:59.000Z',
      });
      const walletEvidence = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ walletDeposit: '50.00000000' }),
        statementPeriodStart: '2026-11-11T00:00:00.000Z',
        statementPeriodEnd: '2026-11-11T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEvidence.id,
        walletEvidenceId: walletEvidence.id,
        uidAllocatedUnits: grossUnits,
        walletCashCollectedUnits: grossUnits,
        r2,
      });
      const recorded = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'wsb-b2b-auth-1',
        exchange: 'bybit',
        traderUid: 'TRADER_4321',
        traderId: 'user_bob',
        l1AffiliateId: 'user_alice',
        reconciliationId: recon.id,
        evidenceId: uidEvidence.id,
        grossCommissionUnits: grossUnits,
        r2,
      });

      const batchUrl = `https://portal.apexos.app/api/b2b/proof-of-rebate?batchId=${recorded.batch.id}&verifyR2=true`;

      // Shorter and longer keys must fail closed with 401 (no session fallback).
      const shorterRes = await b2bProofGet(
        makeAuthRequest(batchUrl, { headers: { 'x-b2b-api-key': 'short' } })
      );
      expect(shorterRes.status).toBe(401);

      const longerRes = await b2bProofGet(
        makeAuthRequest(batchUrl, {
          headers: { 'x-b2b-api-key': 'b2b-secret-key-0123456789abcdef-extra-bytes' },
        })
      );
      expect(longerRes.status).toBe(401);

      // Same-length wrong key (31 bytes, last byte flipped) must also reject with 401.
      const sameLengthWrongRes = await b2bProofGet(
        makeAuthRequest(batchUrl, {
          headers: { 'x-b2b-api-key': 'b2b-secret-key-0123456789abcdee' },
        })
      );
      expect(sameLengthWrongRes.status).toBe(401);

      // Exact configured key succeeds and verifies R2 evidence from globalThis.STORAGE.
      const validRes = await b2bProofGet(
        makeAuthRequest(batchUrl, {
          headers: { 'x-b2b-api-key': 'b2b-secret-key-0123456789abcdef' },
        })
      );
      expect(validRes.status).toBe(200);
      const validJson = await validRes.json();
      expect(validJson.success).toBe(true);
      expect(validJson.proof.maskedTraderUid).toBe('***4321');
      expect(validJson.proof.evidence.r2IntegrityVerified).toBe(true);
    });

    it('caps limit to 25 when verifyR2=true while allowing higher limits when verifyR2 is omitted', async () => {
      process.env.B2B_PROOF_API_KEY = 'b2b-cap-test-key';
      const mockedListProofs = listProofsOfRebateByAffiliateId as jest.MockedFunction<
        typeof listProofsOfRebateByAffiliateId
      >;
      mockedListProofs.mockClear();

      const cappedRes = await b2bProofGet(
        makeAuthRequest(
          'https://portal.apexos.app/api/b2b/proof-of-rebate?affiliateId=user_alice&limit=100&verifyR2=true',
          { headers: { 'x-b2b-api-key': 'b2b-cap-test-key' } }
        )
      );
      expect(cappedRes.status).toBe(200);
      expect(mockedListProofs.mock.calls.at(-1)?.[2]?.limit).toBe(25);
      expect(mockedListProofs.mock.calls.at(-1)?.[2]?.r2).toBe(r2);

      const uncappedRes = await b2bProofGet(
        makeAuthRequest(
          'https://portal.apexos.app/api/b2b/proof-of-rebate?affiliateId=user_alice&limit=80',
          { headers: { 'x-b2b-api-key': 'b2b-cap-test-key' } }
        )
      );
      expect(uncappedRes.status).toBe(200);
      expect(mockedListProofs.mock.calls.at(-1)?.[2]?.limit).toBe(80);
      expect(mockedListProofs.mock.calls.at(-1)?.[2]?.r2).toBeUndefined();
      expect(mockedListProofs).toHaveBeenCalledTimes(2);
    });

    it('enforces a 60 req/min sliding-window rate limit per caller+IP and returns 429 with Retry-After', async () => {
      process.env.B2B_PROOF_API_KEY = 'b2b-ratelimit-test-key';
      const url = 'https://portal.apexos.app/api/b2b/proof-of-rebate?affiliateId=user_alice';
      const reqHeaders = {
        'x-b2b-api-key': 'b2b-ratelimit-test-key',
        'cf-connecting-ip': '203.0.113.44',
      };

      for (let i = 0; i < 60; i += 1) {
        const okRes = await b2bProofGet(makeAuthRequest(url, { headers: reqHeaders }));
        expect(okRes.status).toBe(200);
      }

      const throttledRes = await b2bProofGet(makeAuthRequest(url, { headers: reqHeaders }));
      expect(throttledRes.status).toBe(429);
      expect(Number(throttledRes.headers.get('Retry-After'))).toBeGreaterThanOrEqual(1);
      const throttledBody = await throttledRes.json();
      expect(throttledBody.error).toBe('RATE_LIMITED');
    });
  });

  describe('checkSlidingWindowRateLimit bounded in-memory bucket maintenance', () => {
    it('sweeps expired buckets at capacity and fails closed rather than evicting live quotas when saturated', () => {
      resetEndpointRateLimits();
      const t0 = 1_000_000;

      // Fill the 10,000-bucket ceiling at t0.
      for (let i = 0; i < 10_000; i += 1) {
        const res = checkSlidingWindowRateLimit(`cap-key:${i}`, {
          maxRequests: 2,
          windowMs: 60_000,
          nowMs: t0,
        });
        expect(res.allowed).toBe(true);
      }

      // While all 10,000 buckets are still active, a brand-new 10,001st key fails closed
      // without evicting cap-key:0's active quota.
      const overflowActive = checkSlidingWindowRateLimit('cap-key:overflow', {
        maxRequests: 2,
        windowMs: 60_000,
        nowMs: t0 + 1_000,
      });
      expect(overflowActive.allowed).toBe(false);
      expect(overflowActive.retryAfterSeconds).toBeGreaterThanOrEqual(1);

      // cap-key:0 must still have its prior hit recorded (second hit leaves remaining = 0, third blocks).
      const secondHitKey0 = checkSlidingWindowRateLimit('cap-key:0', {
        maxRequests: 2,
        windowMs: 60_000,
        nowMs: t0 + 2_000,
      });
      expect(secondHitKey0.allowed).toBe(true);
      expect(secondHitKey0.remaining).toBe(0);

      const thirdHitKey0 = checkSlidingWindowRateLimit('cap-key:0', {
        maxRequests: 2,
        windowMs: 60_000,
        nowMs: t0 + 3_000,
      });
      expect(thirdHitKey0.allowed).toBe(false);

      // Once the window elapses, expired buckets are swept and new keys are admitted again.
      const afterExpiry = checkSlidingWindowRateLimit('cap-key:after-sweep', {
        maxRequests: 2,
        windowMs: 60_000,
        nowMs: t0 + 65_000,
      });
      expect(afterExpiry.allowed).toBe(true);
    });

    it('preserves timestamps across variable windowMs checks and sweeps expired keys periodically', () => {
      resetEndpointRateLimits();
      const t0 = 5_000_000;

      // Record a hit under a 5-minute window at t0.
      const firstLongWindow = checkSlidingWindowRateLimit('mixed-window-key', {
        maxRequests: 2,
        windowMs: 300_000,
        nowMs: t0,
      });
      expect(firstLongWindow.allowed).toBe(true);

      // At t0 + 120s, a 1-minute check sees 0 hits in the last 60s, but must not drop the t0 hit
      // that is still active for the 5-minute window.
      const shortWindowCheck = checkSlidingWindowRateLimit('mixed-window-key', {
        maxRequests: 2,
        windowMs: 60_000,
        nowMs: t0 + 120_000,
      });
      expect(shortWindowCheck.allowed).toBe(true);

      // Trigger periodic sweeps across > 64 unrelated calls at t0 + 130s; mixed-window-key must
      // still retain both hits inside its 300s retention horizon.
      for (let i = 0; i < 70; i += 1) {
        checkSlidingWindowRateLimit(`ephemeral:${i}`, {
          maxRequests: 5,
          windowMs: 10_000,
          nowMs: t0 + 130_000,
        });
      }

      const thirdLongWindow = checkSlidingWindowRateLimit('mixed-window-key', {
        maxRequests: 2,
        windowMs: 300_000,
        nowMs: t0 + 140_000,
      });
      expect(thirdLongWindow.allowed).toBe(false);
    });
  });
});

describe('Workstream B: Ascendancy Phase 2 Portal UI Panels', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('renders NonCustodialUidPanel with non-custodial security banner, Binance exclusion callout, and locks verified UIDs', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        uids: [
          {
            id: 'uid_verified_1',
            exchange: 'bybit',
            exchangeMode: 'LIVE',
            exchangeUid: '104928371',
            verificationStatus: 'VERIFIED_BY_PARTNER',
            linkedShortCode: 'desk1',
            createdAt: '2026-11-15T00:00:00.000Z',
            updatedAt: '2026-11-15T00:00:00.000Z',
          },
        ],
      }),
    });

    render(<NonCustodialUidPanel locale="en" />);

    expect(screen.getByTestId('non-custodial-security-banner')).toHaveTextContent(
      /ApexOS Never Requests API Keys, Passphrases, or Custody/i
    );
    expect(screen.getByTestId('binance-exclusion-callout')).toHaveTextContent(
      /Why Binance Standard Referral Pro is Excluded/i
    );

    await waitFor(() => {
      expect(screen.getByText('104928371')).toBeInTheDocument();
      expect(screen.getByText('Audit Locked')).toBeInTheDocument();
    });
  });

  it('rejects malformed exchange UIDs client-side in NonCustodialUidPanel without calling the bind API', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ success: true, uids: [] }),
    });

    render(<NonCustodialUidPanel locale="en" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/Account Exchange UID/i)).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/Account Exchange UID/i), {
      target: { value: '----' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Bind UID/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Exchange UID must be 5-32 characters/i
      );
    });

    // Only the initial GET /api/affiliate/uids fetch — the invalid bind never reached the network.
    expect(global.fetch).toHaveBeenCalledTimes(1);

    fireEvent.change(screen.getByLabelText(/Account Exchange UID/i), {
      target: { value: 'api_key_51QaBcDeFgHiJkLmNoPqRsTuVwXyZ0123456789ab' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Bind UID/i }));

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        /Exchange UID must be 5-32 characters/i
      );
    });
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('renders ShortLinksGeneratorPanel and RebateLedgerWaterfallPanel with 4 exact integer balance cards and Proof-of-Rebate drawer', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          shortLinks: [
            {
              code: 'vip_bybit',
              shortUrl: 'https://portal.apexos.app/r/vip_bybit',
              exchange: 'bybit',
              exchangeMode: 'LIVE',
              destinationUrl: 'https://www.bybit.com/invite',
              campaignTag: 'q4',
              isActive: true,
              clickCount: 42,
              createdAt: '2026-11-15T00:00:00.000Z',
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          balances: {
            inflightUnits: '2500000000',
            inflightUsd: '25.00',
            inflightUsdExact: '25.00000000',
            availableUnits: '14050000000',
            availableUsd: '140.50',
            availableUsdExact: '140.50000000',
            lockedWithdrawalUnits: '1000000000',
            lockedWithdrawalUsd: '10.00',
            lockedWithdrawalUsdExact: '10.00000000',
            settledUnits: '50000000000',
            settledUsd: '500.00',
            settledUsdExact: '500.00000000',
            clawedBackUnits: '0',
            clawedBackUsd: '0.00',
            clawedBackUsdExact: '0.00000000',
            minimumWithdrawalUnits: '1000000000',
            minimumWithdrawalUsd: '10.00',
            canWithdraw: true,
          },
          recentBatches: [
            {
              batchId: 'batch_por_1',
              journalType: 'COMMISSION_INFLIGHT',
              status: 'INFLIGHT',
              stateBucket: 'INFLIGHT',
              exchange: 'okx',
              maskedTraderUid: '***4321',
              userAmountUnits: '2500000000',
              userAmountUsd: '25.00',
              userAmountUsdExact: '25.00000000',
              direction: 'CREDIT',
              legRoles: ['L1_AFFILIATE_COMMISSION'],
              holdUntil: '2026-11-22T00:00:00.000Z',
              settledTxHash: null,
              clawedBackUnits: '0',
              clawedBackUsd: '0.00',
              createdAt: '2026-11-15T00:00:00.000Z',
            },
          ],
          proofsOfRebate: [
            {
              batchId: 'batch_por_1',
              journalType: 'COMMISSION_INFLIGHT',
              status: 'INFLIGHT',
              exchange: 'okx',
              maskedTraderUid: '***4321',
              grossCommissionUnits: '10000000000',
              grossCommissionUsd: '100.00',
              waterfallUnits: {
                traderCashbackUnits: '5000000000',
                l1AffiliateCommissionUnits: '1500000000',
                b2bAgencyOverrideUnits: '500000000',
                clawbackReserveUnits: '1000000000',
                netTreasuryRevenueUnits: '2000000000',
              },
              clawbackState: { isVoided: false, clawedBackUnits: '0' },
              evidence: {
                evidenceId: 'ev_1',
                r2ObjectKey: 'evidence/okx/ev_1.json',
                payloadSha256: 'a'.repeat(64),
                sourceKind: 'rest_poll',
                verifiedInR2: true,
              },
              reconciliation: {
                reconciliationId: 'rec_1',
                status: 'RECONCILED',
                walletEvidenceId: 'wev_1',
                walletPayloadSha256: 'b'.repeat(64),
                discrepancyUnits: '0',
              },
              settlement: { holdUntil: '2026-11-22T00:00:00.000Z', settledTxHash: null },
              createdAt: '2026-11-15T00:00:00.000Z',
              proofDigestSha256: 'c'.repeat(64),
            },
          ],
          partnerTree: {
            maxAllowedDepth: 2,
            l1DirectCount: 3,
            l2SubAffiliateCount: 5,
            l1OverrideEarnedUnits: '7500000000',
            l1OverrideEarnedUsd: '75.00',
            l2B2bOverrideEarnedUnits: '2500000000',
            l2B2bOverrideEarnedUsd: '25.00',
            nodes: [],
          },
        }),
      });

    render(
      <>
        <ShortLinksGeneratorPanel locale="en" />
        <RebateLedgerWaterfallPanel locale="en" />
      </>
    );

    await waitFor(() => {
      expect(screen.getByText('/r/vip_bybit')).toBeInTheDocument();
      expect(screen.getByTestId('ledger-card-inflight')).toHaveTextContent('$25.00');
      expect(screen.getByTestId('ledger-card-available')).toHaveTextContent('$140.50');
      expect(screen.getByTestId('ledger-card-locked')).toHaveTextContent('$10.00');
      expect(screen.getByTestId('ledger-card-settled')).toHaveTextContent('$500.00');
      expect(screen.getByTestId('partner-tier-l1')).toHaveTextContent('3');
      expect(screen.getByTestId('partner-tier-l2')).toHaveTextContent('5');
    });

    // Expand cryptographic Proof-of-Rebate drawer
    fireEvent.click(screen.getByText(/UID \*\*\*4321/i));
    expect(screen.getByTestId('proof-drawer-batch_por_1')).toHaveTextContent('a'.repeat(64));
  });

  it('renders PayoutWalletTimelockPanel 48h countdown and executes emergency ATO cancellation', async () => {
    const futureUnlock = new Date(Date.now() + 36 * 3600 * 1000).toISOString();

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          payoutStatus: {
            unlocked: false,
            reason: 'WALLET_TIMELOCK_ACTIVE_48H',
            unlockAt: futureUnlock,
            walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            chain: 'arbitrum',
          },
          requests: [
            {
              id: 'wcr_pending_1',
              profile_id: 'user_alice',
              previous_address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              previous_chain: 'arbitrum',
              proposed_address: '0xcccccccccccccccccccccccccccccccccccccccc',
              proposed_chain: 'base',
              status: 'PENDING_TIMELOCK',
              requested_at: '2026-11-15T00:00:00.000Z',
              unlock_at: futureUnlock,
              activated_at: null,
              cancelled_at: null,
              requested_ip: null,
            },
          ],
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          code: 'CANCELLED_BY_OWNER',
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          payoutStatus: {
            unlocked: true,
            reason: 'WALLET_UNLOCKED',
            unlockAt: null,
            walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
            chain: 'arbitrum',
          },
          requests: [],
        }),
      });

    render(<PayoutWalletTimelockPanel locale="en" />);

    await waitFor(() => {
      expect(screen.getByTestId('pending-timelock-card')).toHaveTextContent(
        /0xcccccccccccccccccccccccccccccccccccccccc/i
      );
    });

    fireEvent.click(screen.getByRole('button', { name: /Emergency Cancel Request/i }));

    await waitFor(() => {
      expect(screen.getByTestId('wallet-unlock-pill')).toHaveTextContent('Payouts Unlocked');
    });
  });

  it('submits the AscendancyOpsPanel Manual Phase 1 Settlement Dispatch form with action: dispatch and a Passkey step-up header', async () => {
    const dispatchBodies: Array<Record<string, unknown>> = [];
    const dispatchHeaders: Array<Record<string, string>> = [];

    (global.fetch as jest.Mock).mockImplementation(
      async (input: string, init?: { method?: string; body?: string; headers?: Record<string, string> }) => {
        if (input === '/api/admin/runtime-flags') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              flags: [],
              recentReconciliations: [],
              recentShadowReconciliations: [],
              recentBroadcasts: [],
            }),
          };
        }
        if (input === '/api/admin/reconciliation/poller') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ success: true, runs: [] }),
          };
        }
        if (input === '/api/admin/settlement/dispatch') {
          dispatchBodies.push(JSON.parse(init?.body ?? '{}'));
          dispatchHeaders.push(init?.headers ?? {});
          return {
            ok: true,
            status: 200,
            json: async () => ({
              success: true,
              lockBatchId: 'lock_batch_phase1_1',
              settlement: {
                payoutId: 'payout_phase1_test',
                chain: 'arbitrum',
                state: 'BROADCAST_PENDING',
                txHash: '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
              },
            }),
          };
        }
        throw new Error(`Unexpected fetch URL in AscendancyOpsPanel test: ${input}`);
      }
    );

    render(<AscendancyOpsPanel activeStepUp={null} onStepUpChange={jest.fn()} />);

    await waitFor(() => {
      expect(
        screen.getByText(/Runtime Circuit Breakers & Exchange Promotion Gates/i)
      ).toBeInTheDocument();
    });

    fireEvent.change(screen.getByLabelText(/^Payout ID$/i), {
      target: { value: 'payout_phase1_test' },
    });
    fireEvent.change(screen.getByLabelText(/^Idempotency Key$/i), {
      target: { value: 'idem_phase1_test' },
    });
    fireEvent.change(screen.getByLabelText(/Target Profile \/ Affiliate ID/i), {
      target: { value: 'user_alice' },
    });
    fireEvent.change(screen.getByLabelText(/^Recipient Address$/i), {
      target: { value: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    fireEvent.change(screen.getByLabelText(/^Amount USD \(min \$10\)$/i), {
      target: { value: '25.50' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Dispatch Settlement/i }));

    await waitFor(() => {
      expect(dispatchBodies).toHaveLength(1);
    });

    expect(dispatchBodies[0]).toEqual({
      action: 'dispatch',
      payoutId: 'payout_phase1_test',
      idempotencyKey: 'idem_phase1_test',
      affiliateId: 'user_alice',
      ownerType: 'affiliate',
      chain: 'arbitrum',
      recipientAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      amountUsd: '25.50',
    });
    expect(dispatchHeaders[0]['x-passkey-stepup-token']).toBe(
      'stepup_token_manual_dispatch'
    );

    await waitFor(() => {
      expect(
        screen.getByText(/Dispatched payout_phase1_test on arbitrum -> BROADCAST_PENDING/i)
      ).toBeInTheDocument();
    });
  });

  it('supports Generate IDs, blocks sub-$10 manual dispatches, and clears expired Passkey step-up sessions on PASSKEY_STEP_UP_INVALID', async () => {
    const onStepUpChange = jest.fn();
    let dispatchCalls = 0;

    (global.fetch as jest.Mock).mockImplementation(async (input: string) => {
      if (input === '/api/admin/runtime-flags') {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            flags: [],
            recentReconciliations: [],
            recentShadowReconciliations: [],
            recentBroadcasts: [],
          }),
        };
      }
      if (input === '/api/admin/reconciliation/poller') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ success: true, runs: [] }),
        };
      }
      if (input === '/api/admin/settlement/dispatch') {
        dispatchCalls += 1;
        return {
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            code: 'PASSKEY_STEP_UP_INVALID',
            error: 'Passkey step-up token expired or invalid',
          }),
        };
      }
      throw new Error(`Unexpected fetch URL: ${input}`);
    });

    render(
      <AscendancyOpsPanel
        activeStepUp={{
          stepUpToken: 'existing_step_up_token',
          expiresAt: new Date(Date.now() + 120_000).toISOString(),
        }}
        onStepUpChange={onStepUpChange}
      />
    );

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Generate IDs/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Generate IDs/i }));
    const payoutInput = screen.getByLabelText(/^Payout ID$/i) as HTMLInputElement;
    const idemInput = screen.getByLabelText(/^Idempotency Key$/i) as HTMLInputElement;
    expect(payoutInput.value).toMatch(/^payout_phase1_/);
    expect(idemInput.value).toMatch(/^idem_phase1_/);

    fireEvent.change(screen.getByLabelText(/Target Profile \/ Affiliate ID/i), {
      target: { value: 'user_alice' },
    });
    fireEvent.change(screen.getByLabelText(/^Recipient Address$/i), {
      target: { value: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    fireEvent.change(screen.getByLabelText(/^Amount USD \(min \$10\)$/i), {
      target: { value: '9.99' },
    });

    fireEvent.click(screen.getByRole('button', { name: /Dispatch Settlement/i }));

    await waitFor(() => {
      expect(screen.getByText(/at least \$10\.00/i)).toBeInTheDocument();
    });
    expect(dispatchCalls).toBe(0);

    fireEvent.change(screen.getByLabelText(/^Amount USD \(min \$10\)$/i), {
      target: { value: '10.00' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Dispatch Settlement/i }));

    await waitFor(() => {
      expect(onStepUpChange).toHaveBeenCalledWith(null);
      expect(
        screen.getByText(/Passkey step-up token expired or invalid/i)
      ).toBeInTheDocument();
    });
  });
});
