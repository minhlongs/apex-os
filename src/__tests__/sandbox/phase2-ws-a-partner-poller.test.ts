/**
 * @jest-environment node
 *
 * Phase 2 Workstream A Verification Suite:
 * 5-Exchange Partner HTTP Poller, KuCoin UTA v2 + Gate.io v4 Shadow Adapters,
 * 30-Day Shadow Promotion Gate, Admin Poller API, and Daily 02:00 UTC Cron Route.
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import * as nodeCrypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import {
  PASSKEY_STEPUP_HEADER,
  issuePasskeyStepUpToken,
} from '@/lib/auth/passkey-step-up';
import {
  InMemoryR2Bucket,
  SqliteD1Adapter,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  buildGateioPartnerSignedHeaders,
  buildKucoinPartnerSignedHeaders,
  ForbiddenPartnerEndpointError,
  GateioV4Adapter,
  getPartnerAdapter,
  inspectPartnerCredentialPresence,
  isKucoinLv4OrPrimeExcluded,
  KucoinUtaV2Adapter,
  listActivePartnerAdapters,
  listAllPartnerAdapters,
  listPollablePartnerAdapters,
  listShadowPartnerAdapters,
  PartnerHttpPollerService,
  PartnerIntegrationBlockedError,
  PartnerPayloadValidationError,
  POLLABLE_PARTNER_EXCHANGES,
} from '@/lib/partners';
import {
  GET as pollerAdminGet,
  POST as pollerAdminPost,
} from '@/app/api/admin/reconciliation/poller/route';
import { GET as cronRouteGet } from '@/app/api/cron/route';

describe('Phase 2 Workstream A: 5-Exchange HTTP Poller + KuCoin/Gate.io Shadow Adapters', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;
  const originalCronSecret = process.env.CRON_SECRET;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migDir = path.resolve(process.cwd(), 'src/database/migrations');
    for (const file of [
      '001_initial_schema_d1.sql',
      '002_auth_tables.sql',
      '003_affiliate_schema.sql',
      '024_kyc_compliance_schema.sql',
      '028_ascendancy_audit_core.sql',
      '031_ascendancy_phase2_ui_and_poller.sql',
    ]) {
      sqlite.exec(fs.readFileSync(path.join(migDir, file), 'utf8'));
    }

    const futureExp = new Date(Date.now() + 3600_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO profiles (id, email, full_name, role, referral_code)
         VALUES
           ('admin_root', 'admin@apexos.app', 'Root Admin', 'admin', 'ADM1'),
           ('trader_u1', 'trader1@proton.me', 'Trader One', 'shopper', 'TRD1'),
           ('trader_kc1', 'kctrader@proton.me', 'KuCoin Trader', 'shopper', 'TRDKC'),
           ('aff_l1', 'partner1@agency.io', 'Partner Desk', 'affiliate', 'AFF1')`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token, expires_at)
         VALUES ('sess_adm_1', 'admin_root', 'adm_bearer_tok_ws_a', ?)`
      )
      .run(futureExp);

    sqlite
      .prepare(
        `INSERT INTO webauthn_challenges (challenge_id, user_id, challenge, purpose, expires_at, consumed)
         VALUES ('chal_adm_ws_a', 'admin_root', 'chal_bytes', 'admin_step_up', ?, 1)`
      )
      .run(futureExp);

    // Seed short_links + trader_exchange_uids for Bybit, KuCoin, and Gate.io
    sqlite
      .prepare(
        `INSERT INTO short_links (code, affiliate_id, exchange, destination_url, is_active)
         VALUES ('BYBITLNK', 'aff_l1', 'bybit', 'https://partner.bybit.com/b/APEX', 1)`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO trader_exchange_uids
           (id, profile_id, exchange, exchange_uid, linked_short_code, verification_status)
         VALUES
           ('uid_bybit_1', 'trader_u1', 'bybit', '88001122', 'BYBITLNK', 'PENDING_FIRST_TRADE'),
           ('uid_kucoin_1', 'trader_kc1', 'kucoin', 'kc_9001', NULL, 'PENDING_FIRST_TRADE'),
           ('uid_gateio_1', 'trader_u1', 'gateio', 'gt_7701', NULL, 'PENDING_FIRST_TRADE')`
      )
      .run();

    db = new SqliteD1Adapter(sqlite);
    r2 = new InMemoryR2Bucket();
    (globalThis as unknown as { DB?: unknown }).DB = db;
    (globalThis as unknown as { STORAGE?: unknown }).STORAGE = r2;
  });

  afterEach(async () => {
    if (originalCronSecret === undefined) {
      delete process.env.CRON_SECRET;
    } else {
      process.env.CRON_SECRET = originalCronSecret;
    }
    delete (globalThis as unknown as { DB?: unknown }).DB;
    delete (globalThis as unknown as { STORAGE?: unknown }).STORAGE;
    delete (globalThis as unknown as { env?: unknown }).env;
    await db.close();
  });

  describe('KuCoin Partner UTA v2 Adapter (`SHADOW_ONLY` + LV4/Prime Exclusion)', () => {
    it('computes deterministic KC-API-SIGN v2, KC-API-PASSPHRASE v2, and KC-API-PARTNER-SIGN headers', async () => {
      const headers = await buildKucoinPartnerSignedHeaders({
        apiKey: 'kc_key_live_01',
        apiSecret: 'kc_secret_live_99',
        passphrase: 'kc_passphrase_secret',
        partnerId: 'APEXPARTNER',
        timestampMs: 1763200000000,
        method: 'GET',
        endpointPath: '/api/v2/affiliate/inviter/statistics',
        queryString: 'begin=1763100000000&end=1763200000000',
      });

      const expectedSign = nodeCrypto
        .createHmac('sha256', 'kc_secret_live_99')
        .update('1763200000000GET/api/v2/affiliate/inviter/statistics?begin=1763100000000&end=1763200000000', 'utf8')
        .digest('base64');
      const expectedPassphrase = nodeCrypto
        .createHmac('sha256', 'kc_secret_live_99')
        .update('kc_passphrase_secret', 'utf8')
        .digest('base64');
      const expectedPartnerSign = nodeCrypto
        .createHmac('sha256', 'kc_secret_live_99')
        .update('1763200000000APEXPARTNERkc_key_live_01', 'utf8')
        .digest('base64');

      expect(headers['KC-API-KEY']).toBe('kc_key_live_01');
      expect(headers['KC-API-KEY-VERSION']).toBe('2');
      expect(headers['KC-API-SIGN']).toBe(expectedSign);
      expect(headers['KC-API-PASSPHRASE']).toBe(expectedPassphrase);
      expect(headers['KC-API-PARTNER']).toBe('APEXPARTNER');
      expect(headers['KC-API-PARTNER-SIGN']).toBe(expectedPartnerSign);
    });

    it('filters out LV4+, VIP, and Prime institutional accounts while normalizing retail LV0-LV3 rows', async () => {
      const adapter = new KucoinUtaV2Adapter();
      expect(adapter.status).toBe('SHADOW_ONLY');
      expect(isKucoinLv4OrPrimeExcluded({ vipLevel: 3 })).toBe(false);
      expect(isKucoinLv4OrPrimeExcluded({ vipLevel: 4 })).toBe(true);
      expect(isKucoinLv4OrPrimeExcluded({ userLevel: 'LV6' })).toBe(true);
      expect(isKucoinLv4OrPrimeExcluded({ tier: 'Prime-Institutional' })).toBe(true);

      const rawPayload = JSON.stringify({
        code: '200000',
        data: {
          items: [
            {
              uid: 'kc_9001',
              vipLevel: 2,
              currency: 'USDT',
              rebate: '42.50',
              tradeVolume: '85000.00',
              recordId: 'kc_rec_1',
              tradeTime: 1763190000000,
            },
            {
              uid: 'kc_vip_whale',
              vipLevel: 5,
              currency: 'USDT',
              rebate: '999.00',
              tradeVolume: '5000000.00',
              recordId: 'kc_rec_vip_excluded',
              tradeTime: 1763190000000,
            },
            {
              uid: 'kc_prime_desk',
              userLevel: 'Prime',
              currency: 'USDC',
              rebate: '250.00',
              recordId: 'kc_rec_prime_excluded',
              tradeTime: 1763190000000,
            },
          ],
          currentPage: 1,
          totalPage: 1,
        },
      });

      const batch = await adapter.parsePayload(rawPayload);
      expect(batch.rows).toHaveLength(1);
      expect(batch.rows[0]?.traderUid).toBe('kc_9001');
      expect(batch.rows[0]?.netCommissionDecimal).toBe('42.5');
      expect(batch.rows[0]?.commissionAsset).toBe('USDT');
    });

    it('blocks trade/withdrawal endpoints and untrusted SSRF hosts', async () => {
      const adapter = new KucoinUtaV2Adapter();
      await expect(
        adapter.pollCommissions({
          credentials: { apiKey: 'k', apiSecret: 's', passphrase: 'p' },
          endpointPath: '/api/v1/orders',
        })
      ).rejects.toBeInstanceOf(ForbiddenPartnerEndpointError);

      await expect(
        adapter.pollCommissions({
          credentials: {
            apiKey: 'k',
            apiSecret: 's',
            passphrase: 'p',
            baseUrl: 'https://evil-attacker.example.com',
          },
        })
      ).rejects.toBeInstanceOf(PartnerPayloadValidationError);
    });
  });

  describe('Gate.io Partner v4 Adapter (`SHADOW_ONLY` + HMAC-SHA512)', () => {
    it('computes deterministic Gate.io v4 SHA-512 body hash and HMAC-SHA512 SIGN header', async () => {
      const headers = await buildGateioPartnerSignedHeaders({
        apiKey: 'gt_key_01',
        apiSecret: 'gt_secret_99',
        timestampSeconds: 1763200000,
        method: 'GET',
        endpointPath: '/api/v4/rebate/agency/commission_history',
        queryString: 'from=1763100000&to=1763200000',
      });

      const emptyBodySha512 =
        'cf83e1357eefb8bdf1542850d66d8007d620e4050b5715dc83f4a921d36ce9ce47d0d13c5d85f2b0ff8318d2877eec2f63b931bd47417a81a538327af927da3e';
      const prehash = [
        'GET',
        '/api/v4/rebate/agency/commission_history',
        'from=1763100000&to=1763200000',
        emptyBodySha512,
        '1763200000',
      ].join('\n');
      const expectedSign = nodeCrypto
        .createHmac('sha512', 'gt_secret_99')
        .update(prehash, 'utf8')
        .digest('hex');

      expect(headers.KEY).toBe('gt_key_01');
      expect(headers.Timestamp).toBe('1763200000');
      expect(headers.SIGN).toBe(expectedSign);
    });

    it('parses Gate.io v4 agency commission history, clawbacks, and rejects non-USD assets', async () => {
      const adapter = new GateioV4Adapter();
      expect(adapter.status).toBe('SHADOW_ONLY');

      const okBatch = await adapter.parsePayload(
        JSON.stringify({
          total: 2,
          list: [
            {
              id: 'gt_tx_1',
              user_id: 'gt_7701',
              currency: 'USDT',
              commission: '18.75',
              vol: '45000',
              commission_time: 1763195000,
            },
            {
              id: 'gt_tx_2_clawback',
              user_id: 'gt_7701',
              currency: 'USDT',
              commission: '-3.25',
              vol: '0',
              commission_time: 1763196000,
            },
          ],
        })
      );

      expect(okBatch.rows).toHaveLength(2);
      expect(okBatch.rows[0]?.isClawbackOrAdjustment).toBe(false);
      expect(okBatch.rows[1]?.isClawbackOrAdjustment).toBe(true);
      expect(okBatch.rows[1]?.signedUnits1e8).toBe(-325000000n);

      await expect(
        adapter.parsePayload(
          JSON.stringify([{ id: 'gt_bad', user_id: 'gt_7701', currency: 'BTC', commission: '0.01' }])
        )
      ).rejects.toBeInstanceOf(PartnerPayloadValidationError);
    });
  });

  describe('5-Exchange Registry + PartnerHttpPollerService Execution Modes', () => {
    it('registers 3 ACTIVE, 2 SHADOW_ONLY, and 1 BLOCKED (Binance) adapter while keeping Phase 1 G1 contract intact', async () => {
      expect(POLLABLE_PARTNER_EXCHANGES).toEqual(['bybit', 'okx', 'bitget', 'kucoin', 'gateio']);
      expect(listActivePartnerAdapters().map((a) => a.exchange)).toEqual(['bybit', 'okx', 'bitget']);
      expect(listShadowPartnerAdapters().map((a) => a.exchange)).toEqual(['kucoin', 'gateio']);
      expect(listPollablePartnerAdapters()).toHaveLength(5);
      // Default listAllPartnerAdapters preserves Phase 1 Gate G1 4-adapter view
      expect(listAllPartnerAdapters()).toHaveLength(4);
      expect(listAllPartnerAdapters({ includeShadow: true })).toHaveLength(6);

      await expect(getPartnerAdapter('binance').parsePayload('')).rejects.toBeInstanceOf(
        PartnerIntegrationBlockedError
      );
    });

    it('gracefully records SKIPPED_MISSING_CREDENTIALS across all 5 exchanges when secrets are absent', async () => {
      const poller = new PartnerHttpPollerService({
        db,
        r2,
        envBag: {},
      });

      expect(poller.inspectCredentialPresence()).toEqual({
        bybit: false,
        okx: false,
        bitget: false,
        kucoin: false,
        gateio: false,
      });

      const cycle = await poller.runCycle({ triggerSource: 'cron' });
      expect(cycle.runs).toHaveLength(5);
      for (const run of cycle.runs) {
        expect(run.mode).toBe('SKIPPED_MISSING_CREDENTIALS');
        expect(run.status).toBe('SKIPPED_MISSING_CREDENTIALS');
        expect(run.mintedBatches).toBe(0);
      }

      const persistedCount = sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM partner_poller_runs WHERE status = 'SKIPPED_MISSING_CREDENTIALS'`)
        .get() as { cnt: number };
      expect(persistedCount.cnt).toBe(5);
    });

    it('mints T+7 ledger batches for ACTIVE Bybit while keeping KuCoin & Gate.io strictly SHADOW_ONLY (0 ledger batches)', async () => {
      const bybitHttpBody = JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: [
            {
              userId: '88001122',
              coin: 'USDT',
              commissions: '50.00',
              takerVol: '100000.00',
              execTime: '1763190000000',
              tradeId: 'bybit_poll_tx_1',
            },
          ],
        },
      });

      const kucoinHttpBody = JSON.stringify({
        code: '200000',
        data: {
          items: [
            {
              uid: 'kc_9001',
              vipLevel: 1,
              currency: 'USDT',
              rebate: '30.00',
              tradeVolume: '60000.00',
              recordId: 'kc_poll_tx_1',
              tradeTime: 1763190000000,
            },
          ],
        },
      });

      const gateioHttpBody = JSON.stringify({
        list: [
          {
            id: 'gt_poll_tx_1',
            user_id: 'gt_7701',
            currency: 'USDT',
            commission: '20.00',
            vol: '40000.00',
            commission_time: 1763190000,
          },
        ],
      });

      const mockFetch = jest.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        if (url.includes('api.bybit.com')) {
          return new Response(bybitHttpBody, { status: 200 });
        }
        if (url.includes('api.kucoin.com')) {
          return new Response(kucoinHttpBody, { status: 200 });
        }
        if (url.includes('api.gateio.ws')) {
          return new Response(gateioHttpBody, { status: 200 });
        }
        return new Response('Not Found', { status: 404 });
      }) as unknown as typeof fetch;

      const envBag: Record<string, string | undefined> = {
        BYBIT_PARTNER_API_KEY: 'byb_k',
        BYBIT_PARTNER_API_SECRET: 'byb_s',
        BYBIT_WALLET_STATEMENT_PAYLOAD: JSON.stringify({ exchange: 'bybit', creditedUsd: '50.00' }),
        BYBIT_WALLET_CASH_COLLECTED_USD: '50.00',
        KUCOIN_PARTNER_API_KEY: 'kc_k',
        KUCOIN_PARTNER_API_SECRET: 'kc_s',
        KUCOIN_PARTNER_PASSPHRASE: 'kc_p',
        KUCOIN_WALLET_STATEMENT_PAYLOAD: JSON.stringify({ exchange: 'kucoin', creditedUsd: '30.00' }),
        KUCOIN_WALLET_CASH_COLLECTED_USD: '30.00',
        GATEIO_PARTNER_API_KEY: 'gt_k',
        GATEIO_PARTNER_API_SECRET: 'gt_s',
        GATEIO_WALLET_STATEMENT_PAYLOAD: JSON.stringify({ exchange: 'gateio', creditedUsd: '20.00' }),
        GATEIO_WALLET_CASH_COLLECTED_USD: '20.00',
      };

      const poller = new PartnerHttpPollerService({
        db,
        r2,
        envBag,
        fetchImpl: mockFetch,
      });

      expect(poller.inspectCredentialPresence()).toEqual({
        bybit: true,
        okx: false,
        bitget: false,
        kucoin: true,
        gateio: true,
      });

      const cycle = await poller.runCycle({
        triggerSource: 'cron',
        nowMs: 1763200000000,
      });

      const byExchange = Object.fromEntries(cycle.runs.map((r) => [r.exchange, r]));
      expect(byExchange.bybit?.mode).toBe('ACTIVE');
      expect(byExchange.bybit?.status).toBe('SUCCESS');
      expect(byExchange.bybit?.mintedBatches).toBe(1);

      expect(byExchange.kucoin?.mode).toBe('SHADOW_ONLY');
      expect(byExchange.kucoin?.status).toBe('SUCCESS');
      expect(byExchange.kucoin?.mintedBatches).toBe(0);

      expect(byExchange.gateio?.mode).toBe('SHADOW_ONLY');
      expect(byExchange.gateio?.status).toBe('SUCCESS');
      expect(byExchange.gateio?.mintedBatches).toBe(0);

      expect(byExchange.okx?.status).toBe('SKIPPED_MISSING_CREDENTIALS');
      expect(byExchange.bitget?.status).toBe('SKIPPED_MISSING_CREDENTIALS');

      // Verify ONLY 1 ledger batch minted (Bybit), 0 for KuCoin & Gate.io!
      const batchRows = sqlite
        .prepare(`SELECT id, exchange, status FROM ledger_journal_batches`)
        .all() as Array<{ id: string; exchange: string; status: string }>;
      expect(batchRows).toHaveLength(1);
      expect(batchRows[0]?.exchange).toBe('bybit');
      expect(batchRows[0]?.status).toBe('INFLIGHT');

      // Verify Bybit UID was promoted to VERIFIED_BY_PARTNER while shadow UIDs stayed PENDING_FIRST_TRADE
      const uidStatuses = sqlite
        .prepare(`SELECT exchange, verification_status FROM trader_exchange_uids`)
        .all() as Array<{ exchange: string; verification_status: string }>;
      const statusMap = Object.fromEntries(uidStatuses.map((u) => [u.exchange, u.verification_status]));
      expect(statusMap.bybit).toBe('VERIFIED_BY_PARTNER');
      expect(statusMap.kucoin).toBe('PENDING_FIRST_TRADE');
      expect(statusMap.gateio).toBe('PENDING_FIRST_TRADE');

      // Verify 2 shadow rows anchored in partner_shadow_reconciliations
      const shadowRows = sqlite
        .prepare(`SELECT exchange, status, simulated_gross_units FROM partner_shadow_reconciliations ORDER BY exchange`)
        .all() as Array<{ exchange: string; status: string; simulated_gross_units: number }>;
      expect(shadowRows).toEqual([
        { exchange: 'gateio', status: 'PROMOTED_READY', simulated_gross_units: 20_00000000 },
        { exchange: 'kucoin', status: 'PROMOTED_READY', simulated_gross_units: 30_00000000 },
      ]);

      // Verify double-entry invariants I1-I4 hold strictly
      const inv = await verifyLedgerInvariants(db);
      expect(inv.valid).toBe(true);
    });
  });

  describe('Admin Poller Route (`/api/admin/reconciliation/poller`) & Cron Route (`/api/cron`)', () => {
    it('enforces Passkey step-up, blocks premature <30d shadow promotion, allows >=30d clean promotion, and runs daily cron', async () => {
      (globalThis as unknown as { env?: Record<string, string> }).env = {
        BYBIT_PARTNER_API_KEY: 'byb_key_secret_do_not_leak',
        BYBIT_PARTNER_API_SECRET: 'byb_sec_secret_do_not_leak',
      };

      // 1. GET /api/admin/reconciliation/poller returns boolean credentialPresence with zero secret leakage
      const statusRes = await pollerAdminGet(
        new NextRequest('https://apexos.app/api/admin/reconciliation/poller', {
          method: 'GET',
          headers: { Authorization: 'Bearer adm_bearer_tok_ws_a' },
        })
      );
      expect(statusRes.status).toBe(200);
      const statusText = await statusRes.text();
      expect(statusText).not.toContain('byb_key_secret_do_not_leak');
      expect(statusText).not.toContain('byb_sec_secret_do_not_leak');
      const statusJson = JSON.parse(statusText);
      expect(statusJson.credentialPresence).toEqual({
        bybit: true,
        okx: false,
        bitget: false,
        kucoin: false,
        gateio: false,
      });

      // 2. POST without Passkey step-up -> 403 PASSKEY_STEP_UP_REQUIRED
      const noPasskeyRes = await pollerAdminPost(
        new NextRequest('https://apexos.app/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer adm_bearer_tok_ws_a',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ action: 'run', exchanges: ['kucoin'] }),
        })
      );
      expect(noPasskeyRes.status).toBe(403);

      const stepUpToken = issuePasskeyStepUpToken({
        userId: 'admin_root',
        purpose: 'admin_step_up',
        challengeId: 'chal_adm_ws_a',
      });

      // 3. Seed a recent (< 30 days) KuCoin shadow batch -> promotion rejected with 409 SHADOW_WINDOW_INCOMPLETE
      sqlite
        .prepare(
          `INSERT INTO r2_evidence_objects
             (id, exchange, source_kind, r2_object_key, payload_sha256, byte_length, statement_period_start, statement_period_end, retention_until)
           VALUES
             ('ev_kc_recent', 'kucoin', 'rest_poll', 'evidence/kucoin/recent.json', 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', 64, '2026-11-10T00:00:00.000Z', '2026-11-10T23:59:59.000Z', '2031-11-15T00:00:00.000Z')`
        )
        .run();
      sqlite
        .prepare(
          `INSERT INTO partner_shadow_reconciliations
             (id, exchange, evidence_id, wallet_evidence_id, row_count, mapped_uid_count,
              unmapped_uid_count, simulated_gross_units, wallet_cash_collected_units, discrepancy_units,
              status, created_at)
           VALUES
             ('sh_kc_recent', 'kucoin', 'ev_kc_recent', NULL, 1, 1,
              0, 1000000000, 1000000000, 0,
              'PROMOTED_READY', ?)`
        )
        .run(new Date(Date.now() - 5 * 24 * 3600_000).toISOString());

      const prematurePromoteRes = await pollerAdminPost(
        new NextRequest('https://apexos.app/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer adm_bearer_tok_ws_a',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'promote_shadow',
            exchange: 'kucoin',
            liveEnabled: true,
          }),
        })
      );
      expect(prematurePromoteRes.status).toBe(422);
      const prematureJson = await prematurePromoteRes.json();
      expect(prematureJson.code).toBe('SHADOW_WINDOW_UNDER_30_DAYS');

      // 4. Backdate earliest clean shadow batch to 31 days ago -> promotion succeeds!
      sqlite
        .prepare(`UPDATE partner_shadow_reconciliations SET created_at = ? WHERE id = 'sh_kc_recent'`)
        .run(new Date(Date.now() - 31 * 24 * 3600_000).toISOString());

      const okPromoteRes = await pollerAdminPost(
        new NextRequest('https://apexos.app/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer adm_bearer_tok_ws_a',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            action: 'promote_shadow',
            exchange: 'kucoin',
            liveEnabled: true,
            reason: '31 days zero-discrepancy shadow audit passed',
          }),
        })
      );
      expect(okPromoteRes.status).toBe(200);
      const okPromoteJson = await okPromoteRes.json();
      expect(okPromoteJson.liveEnabled).toBe(true);
      expect(okPromoteJson.updatedBy).toBe('admin_root');

      // 5. Cron endpoint `/api/cron?job=partner_reconciliation` enforces CRON_SECRET and executes 5-exchange cycle
      delete (globalThis as unknown as { env?: unknown }).env;
      process.env.CRON_SECRET = 'cron_sec_ws_a_test';

      const unauthCronRes = await cronRouteGet(
        new NextRequest('https://apexos.app/api/cron?job=partner_reconciliation', {
          method: 'GET',
        })
      );
      expect(unauthCronRes.status).toBe(401);

      const authCronRes = await cronRouteGet(
        new NextRequest('https://apexos.app/api/cron?job=partner_reconciliation', {
          method: 'GET',
          headers: { Authorization: 'Bearer cron_sec_ws_a_test' },
        })
      );
      expect(authCronRes.status).toBe(200);
      const authCronJson = await authCronRes.json();
      expect(authCronJson.success).toBe(true);
      expect(authCronJson.results).toHaveLength(1);
      expect(authCronJson.results[0].job).toBe('partner_reconciliation');
      expect(authCronJson.results[0].success).toBe(true);

      // Helper export check
      expect(inspectPartnerCredentialPresence({})).toEqual({
        bybit: false,
        okx: false,
        bitget: false,
        kucoin: false,
        gateio: false,
      });
    });
  });
});
