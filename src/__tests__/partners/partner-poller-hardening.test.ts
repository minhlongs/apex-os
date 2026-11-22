/**
 * @jest-environment node
 *
 * Partner Poller & Adapter Hardening Tests:
 * 1. Fail-closed wallet deposit normalization (terminal status, explicit USD asset, positive amount).
 * 2. Atomic `partner_reconciliation_deposits` claim enforcement across >50 runs and concurrent conflicts,
 *    plus graceful fallback when the table is absent.
 * 3. Multi-page cursor pagination + cycle guard in `poller-service.ts` and `GateioV4Adapter`.
 * 4. Fail-closed missing currency rejection in Bybit, OKX, and Bitget adapters.
 * 5. B2B agency fraud evaluation resolving the agency's own profile email rather than L1's email.
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import {
  InMemoryR2Bucket,
  SqliteD1Adapter,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  BitgetBrokerAdapter,
  BybitAffiliateAdapter,
  GateioV4Adapter,
  OkxAffiliateAdapter,
  PartnerPayloadValidationError,
  loadConsumedDepositIds,
  resolveWalletDepositCash,
  runSingleExchangePoll,
} from '@/lib/partners';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW_MS = 1_763_300_000_000;
const LOOKBACK_MS = 2 * HOUR_MS;
const WINDOW_START_MS = NOW_MS - LOOKBACK_MS;
const WINDOW_END_MS = NOW_MS;

const MIGRATION_FILES = [
  '001_initial_schema_d1.sql',
  '002_auth_tables.sql',
  '003_affiliate_schema.sql',
  '024_kyc_compliance_schema.sql',
  '028_ascendancy_audit_core.sql',
  '031_ascendancy_phase2_ui_and_poller.sql',
] as const;

function createMigratedDb(): { sqlite: Database.Database; db: SqliteD1Adapter } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const file of MIGRATION_FILES) {
    const sqlPath = path.join(process.cwd(), 'src', 'database', 'migrations', file);
    sqlite.exec(fs.readFileSync(sqlPath, 'utf8'));
  }
  return { sqlite, db: new SqliteD1Adapter(sqlite) };
}

function seedBaseProfilesAndBybitUid(
  sqlite: Database.Database,
  extraProfiles: string[] = []
): void {
  const rows = [
    `('trader_u1', 'trader1@proton.me', 'Trader One', 'shopper', 'TRD1', NULL)`,
    `('aff_l1', 'partner1@agency.io', 'Partner Desk', 'affiliate', 'AFF1', NULL)`,
    ...extraProfiles,
  ];
  sqlite
    .prepare(
      `INSERT INTO profiles (id, email, full_name, role, referral_code, referred_by)
       VALUES ${rows.join(', ')}`
    )
    .run();
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
       VALUES ('uid_byb_1', 'trader_u1', 'bybit', '88001122', 'BYBITLNK', 'PENDING_FIRST_TRADE')`
    )
    .run();
}

describe('Partner poller and adapter hardening', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;

  beforeEach(() => {
    ({ sqlite, db } = createMigratedDb());
    r2 = new InMemoryR2Bucket();
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('1. Fail-closed wallet deposit normalization', () => {
    it('rejects non-terminal, non-USD, missing-asset, and non-positive deposits across exchanges', async () => {
      // Bybit on-chain: only status === 3 with explicit USD stablecoin and > 0 amount is accepted
      const bybitResolved = await resolveWalletDepositCash({
        db,
        exchange: 'bybit',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        walletDeposits: [
          { txId: 'byb_pending', coin: 'USDT', status: 1, amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_processing', coin: 'USDT', status: 2, amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_failed', coin: 'USDT', status: 4, amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_no_status', coin: 'USDT', amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_btc', coin: 'BTC', status: 3, amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_no_asset', status: 3, amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_zero', coin: 'USDT', status: 3, amount: '0', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_neg', coin: 'USDT', status: 3, amount: '-12.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_valid', coin: 'USDC', status: 3, amount: '75.50', timestampMs: NOW_MS - 10 * MINUTE_MS },
        ],
      });
      expect(bybitResolved.consumedDepositIds).toEqual(['byb_valid']);
      expect(bybitResolved.walletCashCollectedUsd).toBe('75.50000000');

      // Bybit internal deposit endpoint requires status === 2 (rejects status === 3)
      const bybitInternal = await resolveWalletDepositCash({
        db,
        exchange: 'bybit',
        depositEndpointPath: '/v5/asset/deposit/query-internal-record',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        walletDeposits: [
          { txId: 'byb_int_failed', coin: 'USDT', status: 3, amount: '30.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          { txId: 'byb_int_ok', coin: 'USDT', status: 2, amount: '20.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
        ],
      });
      expect(bybitInternal.consumedDepositIds).toEqual(['byb_int_ok']);
      expect(bybitInternal.walletCashCollectedUsd).toBe('20.00000000');

      // OKX enforces `ccy` USD stablecoin + `state === '2'`
      const okxResolved = await resolveWalletDepositCash({
        db,
        exchange: 'okx',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        walletDeposits: [
          { depId: 'okx_waiting', ccy: 'USDT', state: '0', amt: '10.00', ts: String(NOW_MS - 10 * MINUTE_MS) },
          { depId: 'okx_unwithdrawable', ccy: 'USDT', state: '1', amt: '10.00', ts: String(NOW_MS - 10 * MINUTE_MS) },
          { depId: 'okx_eth', ccy: 'ETH', state: '2', amt: '10.00', ts: String(NOW_MS - 10 * MINUTE_MS) },
          { depId: 'okx_missing_ccy', state: '2', amt: '10.00', ts: String(NOW_MS - 10 * MINUTE_MS) },
          { depId: 'okx_ok', ccy: 'USDT', state: '2', amt: '33.25', ts: String(NOW_MS - 10 * MINUTE_MS) },
        ],
      });
      expect(okxResolved.consumedDepositIds).toEqual(['okx_ok']);
      expect(okxResolved.walletCashCollectedUsd).toBe('33.25000000');

      // Bitget (`status: 'success'`), KuCoin (`status: 'SUCCESS'`), Gate.io (`status: 'DONE'`)
      const bitgetResolved = await resolveWalletDepositCash({
        db,
        exchange: 'bitget',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        walletDeposits: [
          { id: 'bg_pend', coin: 'USDT', status: 'pending', size: '10.00', cTime: String(NOW_MS - 5 * MINUTE_MS) },
          { id: 'bg_ok', coin: 'USDT', status: 'success', size: '11.00', cTime: String(NOW_MS - 5 * MINUTE_MS) },
        ],
      });
      expect(bitgetResolved.consumedDepositIds).toEqual(['bg_ok']);

      const gateResolved = await resolveWalletDepositCash({
        db,
        exchange: 'gateio',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        walletDeposits: [
          { id: 'gt_pend', currency: 'USDT', status: 'PEND', amount: '10.00', timestamp: Math.floor((NOW_MS - 5 * MINUTE_MS) / 1000) },
          { id: 'gt_ok', currency: 'USDT', status: 'DONE', amount: '14.00', timestamp: Math.floor((NOW_MS - 5 * MINUTE_MS) / 1000) },
        ],
      });
      expect(gateResolved.consumedDepositIds).toEqual(['gt_ok']);
    });
  });

  describe('2. Atomic partner_reconciliation_deposits enforcement', () => {
    it('persists claimed deposits in partner_reconciliation_deposits and prevents double-counting beyond 50 runs', async () => {
      seedBaseProfilesAndBybitUid(sqlite);

      const firstRun = await runSingleExchangePoll({
        db,
        r2,
        envBag: {
          BYBIT_PARTNER_API_KEY: 'k',
          BYBIT_PARTNER_API_SECRET: 's',
        },
        triggerSource: 'admin_manual',
        exchange: 'bybit',
        override: {
          rawPartnerPayload: JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  userId: '88001122',
                  coin: 'USDT',
                  netCommission: '50.00',
                  tradeVol: '20000.00',
                  recordId: 'byb_claim_1',
                },
              ],
            },
          }),
          walletDeposits: [
            { txId: 'dep_atomic_1', coin: 'USDT', status: 3, amount: '50.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          ],
          startTimeMs: WINDOW_START_MS,
          endTimeMs: WINDOW_END_MS,
        },
        nowMs: NOW_MS,
        lookbackMs: LOOKBACK_MS,
      });

      expect(firstRun.status).toBe('SUCCESS');
      expect(firstRun.mintedBatches).toBe(1);

      const claimedRow = sqlite
        .prepare(
          `SELECT exchange, deposit_id, reconciliation_id FROM partner_reconciliation_deposits
           WHERE exchange = 'bybit' AND deposit_id = 'dep_atomic_1'`
        )
        .get() as { exchange: string; deposit_id: string; reconciliation_id: string } | undefined;
      expect(claimedRow).toEqual({
        exchange: 'bybit',
        deposit_id: 'dep_atomic_1',
        reconciliation_id: firstRun.reconciliationId,
      });

      // Insert 60 newer SUCCESS runs so the original run falls outside the 50-run scan window
      const insertRun = sqlite.prepare(
        `INSERT INTO partner_poller_runs (id, trigger_source, exchange, mode, status, details, started_at)
         VALUES (?, 'cron', 'bybit', 'ACTIVE', 'SUCCESS', '{}', ?)`
      );
      for (let i = 1; i <= 60; i += 1) {
        insertRun.run(`prun_newer_${i}`, new Date(NOW_MS + i * MINUTE_MS).toISOString());
      }

      const consumed = await loadConsumedDepositIds(db, 'bybit');
      expect(consumed.has('dep_atomic_1')).toBe(true);
    });

    it('halts with DISCREPANCY_HALTED and mints 0 batches on concurrent duplicate deposit claim conflict', async () => {
      seedBaseProfilesAndBybitUid(sqlite);

      // First run claims dep_race_1
      const firstRun = await runSingleExchangePoll({
        db,
        r2,
        envBag: {
          BYBIT_PARTNER_API_KEY: 'k',
          BYBIT_PARTNER_API_SECRET: 's',
        },
        triggerSource: 'admin_manual',
        exchange: 'bybit',
        override: {
          rawPartnerPayload: JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  userId: '88001122',
                  coin: 'USDT',
                  netCommission: '40.00',
                  tradeVol: '10000.00',
                  recordId: 'byb_race_1',
                },
              ],
            },
          }),
          walletDeposits: [
            { txId: 'dep_race_1', coin: 'USDT', status: 3, amount: '40.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
          ],
          startTimeMs: WINDOW_START_MS,
          endTimeMs: WINDOW_END_MS,
        },
        nowMs: NOW_MS,
        lookbackMs: LOOKBACK_MS,
      });
      expect(firstRun.status).toBe('SUCCESS');

      // Simulate a concurrent poll that already passed wallet resolution with the same deposit ID
      const racingRun = await runSingleExchangePoll({
        db,
        r2,
        envBag: {
          BYBIT_PARTNER_API_KEY: 'k',
          BYBIT_PARTNER_API_SECRET: 's',
        },
        triggerSource: 'admin_manual',
        exchange: 'bybit',
        override: {
          rawPartnerPayload: JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  userId: '88001122',
                  coin: 'USDT',
                  netCommission: '40.00',
                  tradeVol: '10000.00',
                  recordId: 'byb_race_2',
                },
              ],
            },
          }),
          walletStatement: {
            rawWalletStatementPayload: JSON.stringify({ deposits: [{ depositId: 'dep_race_1', amountUsd: '40.00' }] }),
            walletCashCollectedUsd: '40.00',
            consumedDepositIds: ['dep_race_1'],
          },
          startTimeMs: WINDOW_START_MS,
          endTimeMs: WINDOW_END_MS,
        },
        nowMs: NOW_MS,
        lookbackMs: LOOKBACK_MS,
      });

      expect(racingRun.status).toBe('DISCREPANCY_HALTED');
      expect(racingRun.mintedBatches).toBe(0);
      expect(racingRun.details).toContain('Duplicate deposit claim conflict');

      const batchCount = sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM ledger_journal_batches`)
        .get() as { cnt: number };
      expect(batchCount.cnt).toBe(1);
    });

    it('gracefully falls back to partner_poller_runs when partner_reconciliation_deposits table is missing', async () => {
      sqlite.exec('DROP TABLE partner_reconciliation_deposits');
      sqlite
        .prepare(
          `INSERT INTO partner_poller_runs (id, trigger_source, exchange, mode, status, reconciliation_id, details, started_at)
           VALUES ('prun_legacy', 'cron', 'bybit', 'ACTIVE', 'SUCCESS', 'recon_legacy', ?, ?)`
        )
        .run(
          JSON.stringify({ reconciliationStatus: 'MATCHED', consumedDepositIds: ['dep_legacy_1'] }),
          new Date(NOW_MS).toISOString()
        );

      const consumed = await loadConsumedDepositIds(db, 'bybit');
      expect(consumed.has('dep_legacy_1')).toBe(true);
    });
  });

  describe('3. Multi-page cursor pagination and cycle guard', () => {
    it('follows nextCursor across multiple Bybit pages and merges all rows without truncation', async () => {
      seedBaseProfilesAndBybitUid(sqlite);

      const cursorsSeen: Array<string | null> = [];
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(String(input));
        const cursor = url.searchParams.get('cursor');
        cursorsSeen.push(cursor);

        if (!cursor) {
          return new Response(
            JSON.stringify({
              retCode: 0,
              retMsg: 'OK',
              result: {
                nextPageCursor: 'page_2',
                list: [
                  { userId: '88001122', coin: 'USDT', netCommission: '10.00', tradeVol: '1000', recordId: 'p1_r1' },
                ],
              },
            }),
            { status: 200 }
          );
        }
        if (cursor === 'page_2') {
          return new Response(
            JSON.stringify({
              retCode: 0,
              retMsg: 'OK',
              result: {
                nextPageCursor: 'page_3',
                list: [
                  { userId: '88001122', coin: 'USDT', netCommission: '15.00', tradeVol: '2000', recordId: 'p2_r1' },
                ],
              },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              nextPageCursor: '',
              list: [
                { userId: '88001122', coin: 'USDT', netCommission: '25.00', tradeVol: '3000', recordId: 'p3_r1' },
              ],
            },
          }),
          { status: 200 }
        );
      };

      const summary = await runSingleExchangePoll({
        db,
        r2,
        envBag: {
          BYBIT_PARTNER_API_KEY: 'bybit_key',
          BYBIT_PARTNER_API_SECRET: 'bybit_secret',
        },
        triggerSource: 'admin_manual',
        exchange: 'bybit',
        override: {
          walletDeposits: [
            { txId: 'dep_multipage', coin: 'USDT', status: 3, amount: '50.00', timestampMs: NOW_MS - 5 * MINUTE_MS },
          ],
          startTimeMs: WINDOW_START_MS,
          endTimeMs: WINDOW_END_MS,
        },
        nowMs: NOW_MS,
        lookbackMs: LOOKBACK_MS,
        fetchImpl: mockFetch,
      });

      expect(cursorsSeen).toEqual([null, 'page_2', 'page_3']);
      expect(summary.status).toBe('SUCCESS');
      expect(summary.fetchedRows).toBe(3);
      expect(summary.mintedBatches).toBe(3);
      expect((await verifyLedgerInvariants(db)).valid).toBe(true);
    });

    it('breaks out of a repeated cursor cycle safely', async () => {
      seedBaseProfilesAndBybitUid(sqlite);

      let callCount = 0;
      const cyclingFetch: typeof fetch = async () => {
        callCount += 1;
        return new Response(
          JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              nextPageCursor: 'stuck_cursor',
              list: [
                { userId: '88001122', coin: 'USDT', netCommission: '10.00', tradeVol: '1000', recordId: 'cyc_r1' },
              ],
            },
          }),
          { status: 200 }
        );
      };

      const summary = await runSingleExchangePoll({
        db,
        r2,
        envBag: {
          BYBIT_PARTNER_API_KEY: 'bybit_key',
          BYBIT_PARTNER_API_SECRET: 'bybit_secret',
        },
        triggerSource: 'admin_manual',
        exchange: 'bybit',
        override: {
          walletDeposits: [
            { txId: 'dep_cycle', coin: 'USDT', status: 3, amount: '10.00', timestampMs: NOW_MS - 5 * MINUTE_MS },
          ],
          startTimeMs: WINDOW_START_MS,
          endTimeMs: WINDOW_END_MS,
        },
        nowMs: NOW_MS,
        lookbackMs: LOOKBACK_MS,
        fetchImpl: cyclingFetch,
      });

      // Page 1 returns 'stuck_cursor' -> Page 2 sends 'stuck_cursor' and gets 'stuck_cursor' again -> stops
      expect(callCount).toBe(2);
      expect(summary.status).toBe('SUCCESS');
      expect(summary.fetchedRows).toBe(1);
      expect(summary.mintedBatches).toBe(1);
    });

    it('GateioV4Adapter emits nextCursor when JSON array length reaches limit and stops on short final page', async () => {
      const adapter = new GateioV4Adapter();
      const offsetsSeen: Array<string | null> = [];
      const mockFetch: typeof fetch = async (input) => {
        const url = new URL(String(input));
        const offset = url.searchParams.get('offset');
        offsetsSeen.push(offset);

        if (!offset) {
          return new Response(
            JSON.stringify([
              { id: 'gt_1', user_id: 'u1', currency: 'USDT', commission: '5.00', commission_time: 1763200000 },
              { id: 'gt_2', user_id: 'u2', currency: 'USDT', commission: '6.00', commission_time: 1763200060 },
            ]),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify([
            { id: 'gt_3', user_id: 'u3', currency: 'USDT', commission: '7.00', commission_time: 1763200120 },
          ]),
          { status: 200 }
        );
      };

      const page1 = await adapter.pollCommissions({
        credentials: { apiKey: 'gt_key', apiSecret: 'gt_secret' },
        limit: 2,
        nowMs: NOW_MS,
        fetchImpl: mockFetch,
      });
      expect(page1.rows).toHaveLength(2);
      expect(page1.nextCursor).toBe('2');

      const page2 = await adapter.pollCommissions({
        credentials: { apiKey: 'gt_key', apiSecret: 'gt_secret' },
        limit: 2,
        cursor: page1.nextCursor!,
        nowMs: NOW_MS,
        fetchImpl: mockFetch,
      });
      expect(page2.rows).toHaveLength(1);
      expect(page2.nextCursor).toBeNull();
      expect(offsetsSeen).toEqual([null, '2']);
    });
  });

  describe('4. Fail-closed missing currency & B2B agency fraud email', () => {
    it('rejects commission rows missing currency on Bybit, OKX, and Bitget adapters', async () => {
      const bybit = new BybitAffiliateAdapter();
      await expect(
        bybit.parsePayload(
          JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: { list: [{ userId: '88001122', netCommission: '10.00', recordId: 'b1' }] },
          })
        )
      ).rejects.toThrow(PartnerPayloadValidationError);

      const okx = new OkxAffiliateAdapter();
      await expect(
        okx.parsePayload(
          JSON.stringify({
            code: '0',
            msg: '',
            data: [{ uid: '551001', rebate: '10.00', billId: 'o1', ts: '1763200000000' }],
          })
        )
      ).rejects.toThrow(PartnerPayloadValidationError);

      const bitget = new BitgetBrokerAdapter();
      await expect(
        bitget.parsePayload(
          JSON.stringify({
            code: '00000',
            msg: 'success',
            data: { list: [{ uid: '771001', commission: '10.00', id: 'bg1', cTime: '1763200000000' }] },
          })
        )
      ).rejects.toThrow(PartnerPayloadValidationError);
    });

    it('evaluates B2B agency fraud against the B2B agency email from profiles rather than L1 referrerEmail', async () => {
      // Trader email matches B2B agency email (Sybil), while L1 email is distinct.
      // Passing L1's email as B2B agency email would have missed the agency email collision.
      seedBaseProfilesAndBybitUid(sqlite, [
        `('agency_b2b', 'trader1+agency@proton.me', 'Sybil Agency', 'affiliate', 'AGY1', NULL)`,
      ]);
      sqlite
        .prepare(`UPDATE profiles SET referred_by = 'agency_b2b' WHERE id = 'aff_l1'`)
        .run();
      sqlite
        .prepare(
          `INSERT INTO b2b_agency_contracts
             (id, agency_profile_id, agency_name, clawback_reserve_bps, trader_cashback_bps, tier1_spread_bps, tier2_spread_bps, tier3_spread_bps, status)
           VALUES ('contract_sybil_1', 'agency_b2b', 'Sybil Agency', 500, 5000, 3000, 1000, 0, 'ACTIVE')`
        )
        .run();

      const summary = await runSingleExchangePoll({
        db,
        r2,
        envBag: {
          BYBIT_PARTNER_API_KEY: 'k',
          BYBIT_PARTNER_API_SECRET: 's',
        },
        triggerSource: 'admin_manual',
        exchange: 'bybit',
        override: {
          rawPartnerPayload: JSON.stringify({
            retCode: 0,
            retMsg: 'OK',
            result: {
              list: [
                {
                  userId: '88001122',
                  coin: 'USDT',
                  netCommission: '100.00',
                  tradeVol: '50000.00',
                  recordId: 'byb_b2b_email_fraud',
                },
              ],
            },
          }),
          walletDeposits: [
            { txId: 'dep_b2b_fraud', coin: 'USDT', status: 3, amount: '100.00', timestampMs: NOW_MS - 5 * MINUTE_MS },
          ],
          startTimeMs: WINDOW_START_MS,
          endTimeMs: WINDOW_END_MS,
        },
        nowMs: NOW_MS,
        lookbackMs: LOOKBACK_MS,
      });

      expect(summary.status).toBe('SUCCESS');
      expect(summary.mintedBatches).toBe(1);
      // L1 passes, B2B agency is blocked due to email collision with trader
      expect(summary.blockedByFraud).toBe(1);

      const postings = sqlite
        .prepare(`SELECT leg_role, amount_units FROM ledger_postings`)
        .all() as Array<{ leg_role: string; amount_units: number }>;
      const l1Leg = postings.find((p) => p.leg_role === 'L1_AFFILIATE_COMMISSION');
      const b2bLeg = postings.find((p) => p.leg_role === 'B2B_AGENCY_OVERRIDE');
      expect(l1Leg?.amount_units).toBe(1_425_000_000);
      expect(b2bLeg).toBeUndefined();
    });
  });
});
