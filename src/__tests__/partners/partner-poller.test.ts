/**
 * @jest-environment node
 *
 * Partner Poller Attribution & Cash Reconciliation Guards
 *
 * Verifies four behaviors that protect live commission minting:
 *   C1 — Only an explicitly provisioned upstream B2B agency receives the tier-2
 *        `B2B_AGENCY_OVERRIDE` leg; a retail second-level parent receives nothing.
 *   C2 — A clawback whose original batch cannot be located, or whose amount
 *        exceeds that batch, is rejected before any evidence object or
 *        `partner_cash_reconciliations` row is written.
 *   C3 — Identical session IP/device telemetry between trader and L1 affiliate
 *        blocks the attribution instead of paying it.
 *   M1 — The deposit query window tolerates settlement lag, and deposit IDs
 *        already consumed by a prior MATCHED run are excluded so wallet cash is
 *        never counted twice.
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
  PartnerIntegrationError,
  computeWalletDepositQueryWindow,
  findExistingLedgerIdempotencyKeys,
  listPartnerPollerStatus,
  loadConsumedDepositIds,
  resolveB2bAgencyOverrideForL1,
  resolveWalletDepositCash,
  runSingleExchangePoll,
} from '@/lib/partners';

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;
const NOW_MS = 1_763_200_000_000;
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

interface PostingRow {
  leg_role: string;
  account_id: string;
  direction: string;
  amount_units: number;
}

interface PollerRunRow {
  id: string;
  status: string;
  details: string | null;
  reconciliation_id: string | null;
}

function seedProfiles(sqlite: Database.Database, extraProfiles: string[] = []): void {
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
}

function seedBybitUidBinding(sqlite: Database.Database): void {
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
       VALUES ('uid_bybit_1', 'trader_u1', 'bybit', '88001122', 'BYBITLNK', 'PENDING_FIRST_TRADE')`
    )
    .run();
}

function bybitPayload(params: {
  recordId: string;
  userId?: string;
  netCommission: string;
}): string {
  return JSON.stringify({
    retCode: 0,
    retMsg: 'OK',
    result: {
      list: [
        {
          userId: params.userId ?? '88001122',
          coin: 'USDT',
          netCommission: params.netCommission,
          tradeVol: '100000.00',
          recordId: params.recordId,
        },
      ],
    },
  });
}

function readPostings(sqlite: Database.Database): PostingRow[] {
  return sqlite
    .prepare(`SELECT leg_role, account_id, direction, amount_units FROM ledger_postings`)
    .all() as PostingRow[];
}

function postingAmount(rows: PostingRow[], legRole: string): number | null {
  const row = rows.find((r) => r.leg_role === legRole);
  return row ? row.amount_units : null;
}

function countReconciliations(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS cnt FROM partner_cash_reconciliations`)
    .get() as { cnt: number };
  return row.cnt;
}

function countEvidenceObjects(sqlite: Database.Database): number {
  const row = sqlite
    .prepare(`SELECT COUNT(*) AS cnt FROM r2_evidence_objects`)
    .get() as { cnt: number };
  return row.cnt;
}

function readBatchMetadata(sqlite: Database.Database): {
  l1AffiliateId: string | null;
  b2bAgencyId: string | null;
} {
  const row = sqlite
    .prepare(`SELECT metadata FROM ledger_journal_batches ORDER BY created_at DESC LIMIT 1`)
    .get() as { metadata: string } | undefined;
  if (!row) {
    throw new Error('Expected one minted ledger batch');
  }
  const parsed = JSON.parse(row.metadata) as {
    l1AffiliateId?: string | null;
    b2bAgencyId?: string | null;
  };
  return {
    l1AffiliateId: parsed.l1AffiliateId ?? null,
    b2bAgencyId: parsed.b2bAgencyId ?? null,
  };
}

describe('Partner poller attribution, clawback, and deposit guards', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migrationDir = path.resolve(process.cwd(), 'src/database/migrations');
    for (const file of MIGRATION_FILES) {
      sqlite.exec(fs.readFileSync(path.join(migrationDir, file), 'utf8'));
    }
    db = new SqliteD1Adapter(sqlite);
    r2 = new InMemoryR2Bucket();
  });

  afterEach(async () => {
    await db.close();
  });

  async function pollBybit(params: {
    payload: string;
    walletStatementUsd?: string;
    walletDeposits?: ReadonlyArray<Record<string, unknown>>;
  }) {
    const envBag: Record<string, string | undefined> = {};
    if (params.walletStatementUsd !== undefined) {
      envBag.BYBIT_WALLET_STATEMENT_PAYLOAD = JSON.stringify({
        exchange: 'bybit',
        creditedUsd: params.walletStatementUsd,
      });
      envBag.BYBIT_WALLET_CASH_COLLECTED_USD = params.walletStatementUsd;
    }
    return runSingleExchangePoll({
      db,
      r2,
      envBag,
      triggerSource: 'admin_manual',
      exchange: 'bybit',
      override: {
        rawPartnerPayload: params.payload,
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        walletDeposits: params.walletDeposits,
      },
      nowMs: NOW_MS,
      lookbackMs: LOOKBACK_MS,
    });
  }

  describe('C1 — Decree 40/2018/ND-CP B2B agency override resolution', () => {
    it('rejects a retail second-level parent, and honours both an explicit share flag and a provisioned agency account', async () => {
      seedProfiles(sqlite, [
        `('retail_parent', 'retail@example.com', 'Retail Parent', 'affiliate', 'RET1', NULL)`,
        `('agency_x', 'agency@b2b.vn', 'Agency X', 'affiliate', 'AGX1', NULL)`,
        `('agency_flagged', 'flagged@b2b.vn', 'Agency Flagged', 'affiliate', 'AGF1', NULL)`,
      ]);
      sqlite
        .prepare(
          `UPDATE profiles SET referred_by = 'agency_x' WHERE id = 'aff_l1'`
        )
        .run();

      // A plain retail parent is never treated as an agency.
      sqlite
        .prepare(`UPDATE profiles SET referred_by = 'retail_parent' WHERE id = 'aff_l1'`)
        .run();
      await expect(resolveB2bAgencyOverrideForL1(db, 'aff_l1', 'trader_u1')).resolves.toBeNull();

      // A provisioned agency account (owner_type='agency') qualifies at 0.10.
      sqlite
        .prepare(
          `INSERT INTO ledger_accounts (id, owner_type, owner_id, account_code)
           VALUES ('acct_agency_agency_x', 'agency', 'agency_x', 'agency:agency_x')`
        )
        .run();
      sqlite
        .prepare(`UPDATE profiles SET referred_by = 'agency_x' WHERE id = 'aff_l1'`)
        .run();
      await expect(resolveB2bAgencyOverrideForL1(db, 'aff_l1', 'trader_u1')).resolves.toEqual({
        b2bAgencyId: 'agency_x',
        tier2ShareOfSpread: '0.10',
      });

      // A runtime share flag qualifies on its own; an out-of-range share does not.
      sqlite
        .prepare(`UPDATE profiles SET referred_by = 'agency_flagged' WHERE id = 'aff_l1'`)
        .run();
      sqlite
        .prepare(
          `INSERT INTO system_runtime_flags (flag_key, flag_value, reason)
           VALUES ('B2B_AGENCY_OVERRIDE_SHARE_agency_flagged', '0.08', 'test')`
        )
        .run();
      await expect(resolveB2bAgencyOverrideForL1(db, 'aff_l1', 'trader_u1')).resolves.toEqual({
        b2bAgencyId: 'agency_flagged',
        tier2ShareOfSpread: '0.08',
      });

      sqlite
        .prepare(
          `UPDATE system_runtime_flags
           SET flag_value = '0.25'
           WHERE flag_key = 'B2B_AGENCY_OVERRIDE_SHARE_agency_flagged'`
        )
        .run();
      await expect(resolveB2bAgencyOverrideForL1(db, 'aff_l1', 'trader_u1')).resolves.toBeNull();
    });

    it('mints a B2B_AGENCY_OVERRIDE leg at 0.10 of spread for a provisioned agency', async () => {
      seedProfiles(sqlite, [
        `('agency_x', 'agency@b2b.vn', 'Agency X', 'affiliate', 'AGX1', NULL)`,
      ]);
      seedBybitUidBinding(sqlite);
      sqlite
        .prepare(
          `INSERT INTO ledger_accounts (id, owner_type, owner_id, account_code)
           VALUES ('acct_agency_agency_x', 'agency', 'agency_x', 'agency:agency_x')`
        )
        .run();
      sqlite.prepare(`UPDATE profiles SET referred_by = 'agency_x' WHERE id = 'aff_l1'`).run();

      // 100 USDC gross => reserve 5.00, cashback 47.50, spread 47.50,
      // L1 14.25, B2B agency 4.75 (0.10 of spread), platform 28.50.
      const agencyRun = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_c1_agency', netCommission: '100.00' }),
        walletStatementUsd: '100.00',
      });

      expect(agencyRun.status).toBe('SUCCESS');
      expect(agencyRun.mintedBatches).toBe(1);
      expect(agencyRun.blockedByFraud).toBe(0);

      const agencyPostings = readPostings(sqlite);
      expect(postingAmount(agencyPostings, 'B2B_AGENCY_OVERRIDE')).toBe(475_000_000);
      expect(postingAmount(agencyPostings, 'L1_AFFILIATE_COMMISSION')).toBe(1_425_000_000);
      expect(postingAmount(agencyPostings, 'PLATFORM_NET_REVENUE')).toBe(2_850_000_000);
      expect(
        agencyPostings.find((p) => p.leg_role === 'B2B_AGENCY_OVERRIDE')?.account_id
      ).toBe('acct_agency_agency_x');
      expect(readBatchMetadata(sqlite).b2bAgencyId).toBe('agency_x');

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    });

    it('mints no agency leg for a retail second-level parent, leaving the tier-2 share with the platform', async () => {
      seedProfiles(sqlite, [
        `('retail_parent', 'retail@example.com', 'Retail Parent', 'affiliate', 'RET1', NULL)`,
      ]);
      seedBybitUidBinding(sqlite);
      sqlite
        .prepare(`UPDATE profiles SET referred_by = 'retail_parent' WHERE id = 'aff_l1'`)
        .run();

      const retailRun = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_c1_retail', netCommission: '100.00' }),
        walletStatementUsd: '100.00',
      });

      expect(retailRun.status).toBe('SUCCESS');
      expect(retailRun.mintedBatches).toBe(1);

      const retailPostings = readPostings(sqlite);
      expect(postingAmount(retailPostings, 'B2B_AGENCY_OVERRIDE')).toBeNull();
      expect(postingAmount(retailPostings, 'L1_AFFILIATE_COMMISSION')).toBe(1_425_000_000);
      expect(postingAmount(retailPostings, 'PLATFORM_NET_REVENUE')).toBe(3_325_000_000);
      expect(readBatchMetadata(sqlite).b2bAgencyId).toBeNull();

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    });
  });

  describe('C2 — Pre-reconciliation clawback target validation', () => {
    it('rejects a clawback with no resolvable original batch before storing evidence or a reconciliation row', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);

      let caught: unknown;
      try {
        await pollBybit({
          payload: bybitPayload({
            recordId: 'bybit_c2_orphan_clawback',
            userId: '88999999',
            netCommission: '-10.00',
          }),
          walletStatementUsd: '10.00',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PartnerIntegrationError);
      expect((caught as PartnerIntegrationError).code).toBe(
        'CLAWBACK_TARGET_BATCH_NOT_FOUND'
      );
      expect(countReconciliations(sqlite)).toBe(0);
      expect(countEvidenceObjects(sqlite)).toBe(0);
    });

    it('rejects a clawback larger than the original batch gross without burning a reconciliation', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);

      const seedRun = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_c2_original', netCommission: '100.00' }),
        walletStatementUsd: '100.00',
      });
      expect(seedRun.status).toBe('SUCCESS');
      expect(countReconciliations(sqlite)).toBe(1);

      const evidenceBefore = countEvidenceObjects(sqlite);
      const batchesBefore = sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM ledger_journal_batches`)
        .get() as { cnt: number };

      let caught: unknown;
      try {
        await pollBybit({
          payload: bybitPayload({
            recordId: 'bybit_c2_oversized_clawback',
            netCommission: '-150.00',
          }),
          walletStatementUsd: '150.00',
        });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(PartnerIntegrationError);
      expect((caught as PartnerIntegrationError).code).toBe(
        'CLAWBACK_EXCEEDS_ORIGINAL_BATCH'
      );

      // The seeding run's reconciliation is untouched and no second row appeared.
      expect(countReconciliations(sqlite)).toBe(1);
      expect(countEvidenceObjects(sqlite)).toBe(evidenceBefore);
      const batchesAfter = sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM ledger_journal_batches`)
        .get() as { cnt: number };
      expect(batchesAfter.cnt).toBe(batchesBefore.cnt);
    });
  });

  describe('C3 — Attribution fraud telemetry gate', () => {
    it('blocks L1 attribution when trader and referrer share the same session IP and device', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);
      const expiresAt = new Date(NOW_MS + HOUR_MS).toISOString();
      sqlite
        .prepare(
          `INSERT INTO sessions (id, user_id, token, expires_at, ip_address, user_agent)
           VALUES
             ('sess_trader_sybil', 'trader_u1', 'tok_trader_sybil', ?, '203.0.113.7', 'Mozilla/5.0 SybilBrowser/1.0'),
             ('sess_aff_sybil', 'aff_l1', 'tok_aff_sybil', ?, '203.0.113.7', 'Mozilla/5.0 SybilBrowser/1.0')`
        )
        .run(expiresAt, expiresAt);

      const run = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_c3_self_referral', netCommission: '100.00' }),
        walletStatementUsd: '100.00',
      });

      expect(run.status).toBe('SUCCESS');
      expect(run.blockedByFraud).toBe(1);
      expect(run.mintedBatches).toBe(1);

      const postings = readPostings(sqlite);
      expect(postingAmount(postings, 'L1_AFFILIATE_COMMISSION')).toBeNull();
      expect(postingAmount(postings, 'B2B_AGENCY_OVERRIDE')).toBeNull();
      expect(postingAmount(postings, 'TRADER_CASHBACK')).toBe(4_750_000_000);
      expect(postingAmount(postings, 'PLATFORM_NET_REVENUE')).toBe(4_750_000_000);

      const metadata = readBatchMetadata(sqlite);
      expect(metadata.l1AffiliateId).toBeNull();
      expect(metadata.b2bAgencyId).toBeNull();

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    });

    it('keeps paying the L1 leg when trader and referrer have distinct sessions', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);
      const expiresAt = new Date(NOW_MS + HOUR_MS).toISOString();
      sqlite
        .prepare(
          `INSERT INTO sessions (id, user_id, token, expires_at, ip_address, user_agent)
           VALUES
             ('sess_trader_ok', 'trader_u1', 'tok_trader_ok', ?, '198.51.100.24', 'Mozilla/5.0 Safari/17.0'),
             ('sess_aff_ok', 'aff_l1', 'tok_aff_ok', ?, '203.0.113.90', 'Mozilla/5.0 Firefox/128.0')`
        )
        .run(expiresAt, expiresAt);

      const run = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_c3_clean', netCommission: '100.00' }),
        walletStatementUsd: '100.00',
      });

      expect(run.status).toBe('SUCCESS');
      expect(run.blockedByFraud).toBe(0);
      expect(postingAmount(readPostings(sqlite), 'L1_AFFILIATE_COMMISSION')).toBe(1_425_000_000);
    });
  });

  describe('M1 — Settlement-lag tolerant deposit window and double-count protection', () => {
    it('widens the query window by 36h behind and up to 12h ahead while preferring the narrow window', () => {
      const start = 1_763_000_000_000;
      const end = start + HOUR_MS;

      const farFuture = computeWalletDepositQueryWindow(start, end, end + 48 * HOUR_MS);
      expect(farFuture.queryStartTimeMs).toBe(start - 36 * HOUR_MS);
      expect(farFuture.queryEndTimeMs).toBe(end + 12 * HOUR_MS);
      expect(farFuture.preferredStartTimeMs).toBe(start - 5 * MINUTE_MS);
      expect(farFuture.preferredEndTimeMs).toBe(end + 12 * HOUR_MS);

      const justAfter = computeWalletDepositQueryWindow(start, end, end + HOUR_MS);
      expect(justAfter.queryEndTimeMs).toBe(end + HOUR_MS);
      expect(justAfter.preferredEndTimeMs).toBe(end + HOUR_MS);
      expect(justAfter.queryStartTimeMs).toBeLessThan(justAfter.preferredStartTimeMs);
    });

    it('excludes deposit IDs consumed by a prior MATCHED run so wallet cash never double-counts', async () => {
      seedProfiles(sqlite);
      sqlite
        .prepare(
          `INSERT INTO partner_poller_runs (id, trigger_source, exchange, mode, status, reconciliation_id, details, started_at)
           VALUES ('prun_prior_matched', 'cron', 'bybit', 'ACTIVE', 'SUCCESS', 'recon_prior',
                   ?, ?)`
        )
        .run(
          JSON.stringify({
            reconciliationStatus: 'MATCHED',
            consumedDepositIds: ['dep_shared'],
            excludedDepositIds: [],
          }),
          new Date(NOW_MS - 3 * HOUR_MS).toISOString()
        );

      await expect(loadConsumedDepositIds(db, 'bybit')).resolves.toEqual(
        new Set(['dep_shared'])
      );

      const resolved = await resolveWalletDepositCash({
        db,
        exchange: 'bybit',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        walletDeposits: [
          {
            txId: 'dep_shared',
            coin: 'USDT',
            status: 3,
            amountUsd: '60.00',
            timestampMs: NOW_MS - 30 * MINUTE_MS,
          },
          {
            txId: 'dep_new',
            coin: 'USDT',
            status: 3,
            amountUsd: '40.00',
            timestampMs: NOW_MS - 45 * MINUTE_MS,
          },
        ],
      });

      expect(resolved.excludedDepositIds).toEqual(['dep_shared']);
      expect(resolved.consumedDepositIds).toEqual(['dep_new']);
      expect(resolved.walletCashCollectedUsd).toBe('40.00000000');
      expect(resolved.queryWindow.queryStartTimeMs).toBe(WINDOW_START_MS - 36 * HOUR_MS);
      expect(resolved.queryWindow.queryEndTimeMs).toBe(NOW_MS);
    });

    it('persists consumed deposit IDs on a MATCHED cycle so a re-poll cannot count the same cash again', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);

      const deposits = [
        { txId: 'dep_a', coin: 'USDT', status: 3, amountUsd: '60.00', timestampMs: NOW_MS - 30 * MINUTE_MS },
        { txId: 'dep_b', coin: 'USDT', status: 3, amountUsd: '40.00', timestampMs: NOW_MS - 40 * MINUTE_MS },
      ];

      const firstRun = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_m1_cycle', netCommission: '100.00' }),
        walletDeposits: deposits,
      });

      expect(firstRun.status).toBe('SUCCESS');
      expect(firstRun.mintedBatches).toBe(1);

      const persisted = sqlite
        .prepare(
          `SELECT status, details, reconciliation_id FROM partner_poller_runs
           WHERE id = ? LIMIT 1`
        )
        .get(firstRun.runId) as PollerRunRow;
      expect(persisted.status).toBe('SUCCESS');
      expect(persisted.reconciliation_id).toBeTruthy();
      const details = JSON.parse(String(persisted.details)) as {
        reconciliationStatus: string;
        consumedDepositIds: string[];
      };
      expect(details.reconciliationStatus).toBe('MATCHED');
      expect([...details.consumedDepositIds].sort()).toEqual(['dep_a', 'dep_b']);

      // Re-polling identical deposits must exclude them, so the cash-backed gate
      // halts instead of minting a second batch against the same money.
      const secondRun = await pollBybit({
        payload: bybitPayload({ recordId: 'bybit_m1_cycle_replay', netCommission: '100.00' }),
        walletDeposits: deposits,
      });

      expect(secondRun.status).toBe('DISCREPANCY_HALTED');
      expect(secondRun.mintedBatches).toBe(0);
      expect(secondRun.errorCode).toBe('RECONCILIATION_DISCREPANCY_HALTED');

      const batchCount = sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM ledger_journal_batches`)
        .get() as { cnt: number };
      expect(batchCount.cnt).toBe(1);
    });
  });

  describe('Overlapping lookback window replay and status telemetry', () => {
    function bybitMultiRowPayload(
      rows: ReadonlyArray<{ recordId: string; userId?: string; netCommission: string }>
    ): string {
      return JSON.stringify({
        retCode: 0,
        retMsg: 'OK',
        result: {
          list: rows.map((row) => ({
            userId: row.userId ?? '88001122',
            coin: 'USDT',
            netCommission: row.netCommission,
            tradeVol: '100000.00',
            recordId: row.recordId,
          })),
        },
      });
    }

    it('reconciles only newly unminted rows across overlapping 2-day polls and preserves readable run details', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);

      const firstPoll = await pollBybit({
        payload: bybitMultiRowPayload([
          { recordId: 'bybit_overlap_trade_a', netCommission: '10.00' },
        ]),
        walletDeposits: [
          { txId: 'dep_d1', coin: 'USDT', status: 3, amountUsd: '10.00', timestampMs: NOW_MS - 40 * MINUTE_MS },
        ],
      });
      expect(firstPoll.status).toBe('SUCCESS');
      expect(firstPoll.mintedBatches).toBe(1);

      const secondPoll = await pollBybit({
        payload: bybitMultiRowPayload([
          { recordId: 'bybit_overlap_trade_a', netCommission: '10.00' },
          { recordId: 'bybit_overlap_trade_b', netCommission: '15.00' },
        ]),
        walletDeposits: [
          { txId: 'dep_d1', coin: 'USDT', status: 3, amountUsd: '10.00', timestampMs: NOW_MS - 40 * MINUTE_MS },
          { txId: 'dep_d2', coin: 'USDT', status: 3, amountUsd: '15.00', timestampMs: NOW_MS - 20 * MINUTE_MS },
        ],
      });
      expect(secondPoll.status).toBe('SUCCESS');
      expect(secondPoll.fetchedRows).toBe(2);
      expect(secondPoll.mintedBatches).toBe(1);

      const thirdPoll = await pollBybit({
        payload: bybitMultiRowPayload([
          { recordId: 'bybit_overlap_trade_a', netCommission: '10.00' },
          { recordId: 'bybit_overlap_trade_b', netCommission: '15.00' },
        ]),
        walletDeposits: [
          { txId: 'dep_d1', coin: 'USDT', status: 3, amountUsd: '10.00', timestampMs: NOW_MS - 40 * MINUTE_MS },
          { txId: 'dep_d2', coin: 'USDT', status: 3, amountUsd: '15.00', timestampMs: NOW_MS - 20 * MINUTE_MS },
        ],
      });
      expect(thirdPoll.status).toBe('SUCCESS');
      expect(thirdPoll.mintedBatches).toBe(0);

      const batchCount = sqlite
        .prepare(`SELECT COUNT(*) AS cnt FROM ledger_journal_batches`)
        .get() as { cnt: number };
      expect(batchCount.cnt).toBe(2);

      await expect(loadConsumedDepositIds(db, 'bybit')).resolves.toEqual(
        new Set(['dep_d1', 'dep_d2'])
      );

      const statusPayload = await listPartnerPollerStatus(db, {});
      const matchedRuns = statusPayload.recentRuns.filter(
        (run) => run.reconciliationId !== null
      );
      expect(matchedRuns).toHaveLength(2);
      for (const matchedRun of matchedRuns) {
        expect(matchedRun.details).toContain('Reconciled MATCHED batch');
        expect(matchedRun.details).not.toContain('consumedDepositIds');
      }

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    });

    it('chunks findExistingLedgerIdempotencyKeys into <= 80 bind parameters per D1 query', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);

      await pollBybit({
        payload: bybitMultiRowPayload([
          { recordId: 'bybit_chunk_seeded_1', netCommission: '10.00' },
          { recordId: 'bybit_chunk_seeded_2', netCommission: '20.00' },
        ]),
        walletStatementUsd: '30.00',
      });

      const candidateKeys = Array.from({ length: 175 }, (_, idx) => `ingest:bybit:synthetic_${idx}`);
      candidateKeys[5] = 'ingest:bybit:bybit_chunk_seeded_1';
      candidateKeys[170] = 'ingest:bybit:bybit_chunk_seeded_2';

      const prepareSpy = jest.spyOn(db, 'prepare');
      const existing = await findExistingLedgerIdempotencyKeys(db, candidateKeys);

      expect(existing).toEqual(
        new Set([
          'ingest:bybit:bybit_chunk_seeded_1',
          'ingest:bybit:bybit_chunk_seeded_2',
        ])
      );

      const inQueries = prepareSpy.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) => sql.includes('SELECT idempotency_key FROM ledger_journal_batches'));
      // 175 unique keys / 80 per chunk => 3 chunked queries, each <= 80 placeholders
      expect(inQueries).toHaveLength(3);
      for (const sql of inQueries) {
        const placeholderCount = (sql.match(/\?/g) ?? []).length;
        expect(placeholderCount).toBeLessThanOrEqual(80);
      }
    });
  });

  describe('Partner deposit endpoint path validation and allowlist', () => {
    it('rejects non-allowlisted and traversal depositEndpointPath values before making any outbound HTTP call', async () => {
      const fetchSpy = jest.fn(async () => new Response('{}', { status: 200 }));
      const credentials = {
        apiKey: 'bybit_key_test',
        apiSecret: 'bybit_secret_test',
      };

      for (const forbiddenPath of [
        '/v5/account/wallet-balance',
        '../secret',
        '/../v5/asset/deposit/query-record',
        '//evil.example/v5/asset/deposit/query-record',
        '/v5/asset/deposit/query-record ',
      ]) {
        await expect(
          resolveWalletDepositCash({
            db,
            exchange: 'bybit',
            startTimeMs: WINDOW_START_MS,
            endTimeMs: WINDOW_END_MS,
            nowMs: NOW_MS,
            credentials,
            depositEndpointPath: forbiddenPath,
            fetchImpl: fetchSpy as unknown as typeof fetch,
          })
        ).rejects.toMatchObject({
          name: 'PartnerIntegrationError',
          code: 'POLLER_INTEGRATION_ERROR',
        });
      }
      expect(fetchSpy).not.toHaveBeenCalled();

      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);
      let caughtRunError: unknown;
      try {
        await runSingleExchangePoll({
          db,
          r2,
          envBag: {
            BYBIT_PARTNER_API_KEY: 'bybit_key_test',
            BYBIT_PARTNER_API_SECRET: 'bybit_secret_test',
          },
          triggerSource: 'admin_manual',
          exchange: 'bybit',
          override: {
            rawPartnerPayload: bybitPayload({
              recordId: 'bybit_bad_deposit_endpoint',
              netCommission: '25.00',
            }),
            depositEndpointPath: '/v5/account/wallet-balance',
            startTimeMs: WINDOW_START_MS,
            endTimeMs: WINDOW_END_MS,
          },
          nowMs: NOW_MS,
          lookbackMs: LOOKBACK_MS,
          fetchImpl: fetchSpy as unknown as typeof fetch,
        });
      } catch (err) {
        caughtRunError = err;
      }
      expect(caughtRunError).toBeInstanceOf(PartnerIntegrationError);
      expect((caughtRunError as PartnerIntegrationError).code).toBe(
        'POLLER_INTEGRATION_ERROR'
      );
      expect(fetchSpy).not.toHaveBeenCalled();

      // Verify nested exchange deposit envelopes (Bybit result.rows and KuCoin data.items) parse accurately
      const bybitNestedFetch = jest.fn(async () =>
        new Response(
          JSON.stringify({
            retCode: 0,
            result: {
              rows: [
                {
                  txID: 'dep_nested_bybit_1',
                  coin: 'USDT',
                  status: 3,
                  amount: '25.00',
                  successAt: String(NOW_MS - 15 * MINUTE_MS),
                },
              ],
            },
          }),
          { status: 200 }
        )
      );
      const bybitResolved = await resolveWalletDepositCash({
        db,
        exchange: 'bybit',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        credentials,
        depositEndpointPath: '/v5/asset/deposit/query-record',
        fetchImpl: bybitNestedFetch as unknown as typeof fetch,
      });
      expect(bybitResolved.walletCashCollectedUsd).toBe('25.00000000');
      expect(bybitResolved.consumedDepositIds).toEqual(['dep_nested_bybit_1']);

      const kucoinNestedFetch = jest.fn(async () =>
        new Response(
          JSON.stringify({
            code: '200000',
            data: {
              currentPage: 1,
              items: [
                {
                  walletTxId: 'dep_nested_kucoin_1',
                  currency: 'USDT',
                  status: 'SUCCESS',
                  amount: '42.50',
                  createdAt: NOW_MS - 10 * MINUTE_MS,
                },
              ],
            },
          }),
          { status: 200 }
        )
      );
      const kucoinResolved = await resolveWalletDepositCash({
        db,
        exchange: 'kucoin',
        startTimeMs: WINDOW_START_MS,
        endTimeMs: WINDOW_END_MS,
        nowMs: NOW_MS,
        credentials: {
          apiKey: 'kc_key',
          apiSecret: 'kc_secret',
          passphrase: 'kc_passphrase',
          partnerId: 'kc_partner',
        },
        depositEndpointPath: '/api/v1/deposits',
        fetchImpl: kucoinNestedFetch as unknown as typeof fetch,
      });
      expect(kucoinResolved.walletCashCollectedUsd).toBe('42.50000000');
      expect(kucoinResolved.consumedDepositIds).toEqual(['dep_nested_kucoin_1']);
    });
  });

  describe('Batch fraud telemetry memoization and negative schema probe cache', () => {
    it('evaluates 50 trades for the same (traderId, l1AffiliateId) pair with O(1) fraud telemetry queries and caches missing optional tables', async () => {
      seedProfiles(sqlite);
      seedBybitUidBinding(sqlite);
      const expiresAt = new Date(NOW_MS + HOUR_MS).toISOString();
      sqlite
        .prepare(
          `INSERT INTO sessions (id, user_id, token, expires_at, ip_address, user_agent)
           VALUES
             ('sess_trader_memo', 'trader_u1', 'tok_trader_memo', ?, '198.51.100.24', 'Mozilla/5.0 Safari/17.0'),
             ('sess_aff_memo', 'aff_l1', 'tok_aff_memo', ?, '203.0.113.90', 'Mozilla/5.0 Firefox/128.0')`
        )
        .run(expiresAt, expiresAt);

      const fiftyTrades = Array.from({ length: 50 }, (_, idx) => ({
        userId: '88001122',
        coin: 'USDT',
        netCommission: '2.00',
        tradeVol: '5000.00',
        recordId: `bybit_memo_trade_${idx}`,
      }));

      const prepareSpy = jest.spyOn(db, 'prepare');
      const firstRun = await pollBybit({
        payload: JSON.stringify({
          retCode: 0,
          retMsg: 'OK',
          result: { list: fiftyTrades },
        }),
        walletDeposits: [
          { txId: 'dep_memo_100', coin: 'USDT', status: 3, amountUsd: '100.00', timestampMs: NOW_MS - 15 * MINUTE_MS },
        ],
      });

      expect(firstRun.status).toBe('SUCCESS');
      expect(firstRun.mintedBatches).toBe(50);
      expect(firstRun.blockedByFraud).toBe(0);

      const fraudTelemetrySqlCalls = prepareSpy.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) =>
          /\b(sessions|user_sessions|auth_sessions|deal_clicks|click_events|clicks|fraud_events)\b/i.test(
            sql
          )
        );
      // Without per-batch memoization, 50 trades x ~10 telemetry/fraud queries would exceed 450 SQL calls.
      expect(fraudTelemetrySqlCalls.length).toBeLessThan(25);

      prepareSpy.mockClear();

      const secondBatchRun = await pollBybit({
        payload: bybitPayload({
          recordId: 'bybit_memo_second_batch',
          netCommission: '5.00',
        }),
        walletDeposits: [
          { txId: 'dep_memo_100', coin: 'USDT', status: 3, amountUsd: '100.00', timestampMs: NOW_MS - 15 * MINUTE_MS },
          { txId: 'dep_memo_5', coin: 'USDT', status: 3, amountUsd: '5.00', timestampMs: NOW_MS - 10 * MINUTE_MS },
        ],
      });
      expect(secondBatchRun.status).toBe('SUCCESS');
      expect(secondBatchRun.mintedBatches).toBe(1);

      const deadTableProbesOnSecondBatch = prepareSpy.mock.calls
        .map(([sql]) => String(sql))
        .filter((sql) =>
          /\b(user_sessions|auth_sessions|click_events)\b/i.test(sql)
        );
      expect(deadTableProbesOnSecondBatch).toHaveLength(0);
    });
  });
});
