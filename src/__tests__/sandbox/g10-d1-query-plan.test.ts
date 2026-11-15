/**
 * Gate G10: SQLite / Cloudflare D1 EXPLAIN QUERY PLAN & Latency Verification
 *
 * Verifies against real SQLite with migration `028_ascendancy_audit_core.sql` that:
 * 1. Every hot ledger lookup, trial balance, evidence, and reconciliation query uses
 *    an index (`SEARCH ... USING INDEX` / `USING COVERING INDEX`).
 * 2. Zero full table scans occur (`SCAN ledger_postings`, `SCAN ledger_journal_batches`,
 *    `SCAN partner_cash_reconciliations`, `SCAN ledger_accounts`, `SCAN r2_evidence_objects`).
 * 3. Average query execution latency is `< 8 ms` on a populated ledger dataset.
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
} from '@/lib/ledger';

function createMigratedSandboxDb(): {
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
  ]) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    sqlite.exec(sql);
  }
  return { sqlite, db: new SqliteD1Adapter(sqlite) };
}

interface HotQueryCase {
  name: string;
  sql: string;
  params: unknown[];
}

describe('Gate G10: D1 / SQLite EXPLAIN QUERY PLAN & <8ms Latency Budget', () => {
  it('executes every ledger, trial-balance, evidence, and reconciliation query via USING INDEX with 0 full table scans and < 8ms average latency', async () => {
    const { sqlite, db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ seeded: true }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-07T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ cash: '100000.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-07T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: parseUsdToLedgerUnits('100000.00'),
        walletCashCollectedUnits: parseUsdToLedgerUnits('100000.00'),
        r2,
      });

      let sampleBatchId = '';
      let sampleIdempotencyKey = '';
      for (let i = 0; i < 200; i++) {
        const idemKey = `g10-seed-${i}`;
        const res = await ledger.recordVerifiedCommissionInflight({
          idempotencyKey: idemKey,
          exchange: 'bybit',
          traderUid: `uid_g10_${i % 20}`,
          traderId: `trader_g10_${i % 20}`,
          l1AffiliateId: `aff_g10_${i % 10}`,
          reconciliationId: recon.id,
          evidenceId: uidEv.id,
          grossCommissionUnits: parseUsdToLedgerUnits('50.00'),
          createdAt: '2026-11-01T00:00:00.000Z',
        });
        if (i === 0) {
          sampleBatchId = res.batch.id;
          sampleIdempotencyKey = idemKey;
        }
      }

      const otherExchanges = ['okx', 'bitget', 'kucoin', 'gateio'] as const;
      for (let eIdx = 0; eIdx < 40; eIdx++) {
        const ex = otherExchanges[eIdx % otherExchanges.length];
        const otherUidEv = await storeEvidenceObject(db, r2, {
          exchange: ex,
          sourceKind: 'rest_poll',
          rawBytes: JSON.stringify({ seededIdx: eIdx }),
          statementPeriodStart: `2026-10-${String((eIdx % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
          statementPeriodEnd: `2026-10-${String((eIdx % 28) + 1).padStart(2, '0')}T23:59:59.000Z`,
        });
        const otherWalEv = await storeEvidenceObject(db, r2, {
          exchange: ex,
          sourceKind: 'wallet_statement',
          rawBytes: JSON.stringify({ cash: '100.00', eIdx }),
          statementPeriodStart: `2026-10-${String((eIdx % 28) + 1).padStart(2, '0')}T00:00:00.000Z`,
          statementPeriodEnd: `2026-10-${String((eIdx % 28) + 1).padStart(2, '0')}T23:59:59.000Z`,
        });
        await reconcilePartnerCashBatch(db, {
          exchange: ex,
          evidenceId: otherUidEv.id,
          walletEvidenceId: otherWalEv.id,
          uidAllocatedUnits: parseUsdToLedgerUnits('100.00'),
          walletCashCollectedUnits: parseUsdToLedgerUnits('100.00'),
        });
      }

      sqlite.exec('ANALYZE;');

      const sampleTraderAcct = await ledger.getAccountByOwner('trader', 'trader_g10_0');
      expect(sampleTraderAcct).not.toBeNull();

      const hotQueries: HotQueryCase[] = [
        {
          name: 'Runtime kill-switch lookup by PK',
          sql: `SELECT flag_value, reason FROM system_runtime_flags WHERE flag_key = ?`,
          params: ['EMERGENCY_LEDGER_FREEZE'],
        },
        {
          name: 'Evidence lookup by SHA-256 digest',
          sql: `SELECT id, r2_object_key FROM r2_evidence_objects WHERE payload_sha256 = ?`,
          params: [uidEv.payloadSha256],
        },
        {
          name: 'Evidence lookup by exchange & period window',
          sql: `SELECT id, payload_sha256
                FROM r2_evidence_objects
                WHERE exchange = ? AND statement_period_start >= ? AND statement_period_end <= ?`,
          params: ['bybit', '2026-11-01T00:00:00.000Z', '2026-11-08T00:00:00.000Z'],
        },
        {
          name: 'Reconciliation lookup by exchange + status + recency',
          sql: `SELECT id, uid_allocated_units, wallet_cash_collected_units, discrepancy_units
                FROM partner_cash_reconciliations
                WHERE exchange = ? AND status = ?
                ORDER BY reconciled_at DESC
                LIMIT ?`,
          params: ['bybit', 'MATCHED', 25],
        },
        {
          name: 'Reconciliation lookup by evidence_id',
          sql: `SELECT id, status FROM partner_cash_reconciliations WHERE evidence_id = ?`,
          params: [uidEv.id],
        },
        {
          name: 'Reconciliation cap minting sum via idx_ledger_batches_recon',
          sql: `SELECT COALESCE(SUM(gross_commission_units), 0) AS minted_units
                FROM ledger_journal_batches INDEXED BY idx_ledger_batches_recon
                WHERE reconciliation_id = ? AND journal_type = 'COMMISSION_INFLIGHT'`,
          params: [recon.id],
        },
        {
          name: 'Batch idempotency lookup via UNIQUE idempotency_key',
          sql: `SELECT id, payload_fingerprint, status
                FROM ledger_journal_batches
                WHERE idempotency_key = ?`,
          params: [sampleIdempotencyKey],
        },
        {
          name: 'Matured T+7 inflight batch scan via idx_ledger_batches_status_hold',
          sql: `SELECT id, hold_until
                FROM ledger_journal_batches
                WHERE status = 'INFLIGHT' AND hold_until <= ?
                ORDER BY hold_until ASC
                LIMIT ?`,
          params: ['2026-11-10T00:00:00.000Z', 100],
        },
        {
          name: 'Trader clawback candidate batches via idx_ledger_batches_exchange_uid',
          sql: `SELECT id, status, metadata
                FROM ledger_journal_batches
                WHERE exchange = ? AND trader_uid = ?
                ORDER BY created_at ASC`,
          params: ['bybit', 'uid_g10_0'],
        },
        {
          name: 'Account lookup by owner_type + owner_id',
          sql: `SELECT id, settled_balance_units, inflight_balance_units
                FROM ledger_accounts
                WHERE owner_type = ? AND owner_id = ?`,
          params: ['trader', 'trader_g10_0'],
        },
        {
          name: 'Account lookup by UNIQUE account_code',
          sql: `SELECT id, settled_balance_units, inflight_balance_units
                FROM ledger_accounts
                WHERE account_code = ?`,
          params: ['trader:trader_g10_0'],
        },
        {
          name: 'Postings lookup for batch via idx_ledger_postings_batch',
          sql: `SELECT id, account_id, direction, amount_units, leg_role
                FROM ledger_postings
                WHERE batch_id = ?`,
          params: [sampleBatchId],
        },
        {
          name: 'Affiliate Proof-of-Rebate recent postings via idx_ledger_postings_account_created',
          sql: `SELECT batch_id, amount_units
                FROM ledger_postings
                WHERE account_id = ?
                ORDER BY created_at DESC
                LIMIT ?`,
          params: [sampleTraderAcct!.id, 25],
        },
        {
          name: 'Trial balance account-posting join via idx_ledger_accounts_owner + idx_ledger_postings_account_created',
          sql: `SELECT
                  la.id,
                  la.account_code,
                  la.settled_balance_units,
                  la.inflight_balance_units,
                  COALESCE(SUM(CASE WHEN lp.direction = 'DEBIT' THEN lp.amount_units ELSE 0 END), 0) AS debit_sum,
                  COALESCE(SUM(CASE WHEN lp.direction = 'CREDIT' THEN lp.amount_units ELSE 0 END), 0) AS credit_sum
                FROM ledger_accounts la INDEXED BY idx_ledger_accounts_owner
                LEFT JOIN ledger_postings lp INDEXED BY idx_ledger_postings_account_created
                  ON lp.account_id = la.id
                WHERE la.owner_type IN ('system', 'trader', 'affiliate', 'agency', 'treasury', 'reserve')
                GROUP BY la.id`,
          params: [],
        },
        {
          name: 'Trial balance per-batch zero-sum check via idx_ledger_batches_status_hold + idx_ledger_postings_batch',
          sql: `SELECT b.id AS batch_id,
                       COALESCE(SUM(CASE WHEN lp.direction = 'DEBIT' THEN lp.amount_units ELSE 0 END), 0) AS debit_units,
                       COALESCE(SUM(CASE WHEN lp.direction = 'CREDIT' THEN lp.amount_units ELSE 0 END), 0) AS credit_units
                FROM ledger_journal_batches b INDEXED BY idx_ledger_batches_status_hold
                LEFT JOIN ledger_postings lp INDEXED BY idx_ledger_postings_batch
                  ON lp.batch_id = b.id
                WHERE b.status IN ('INFLIGHT', 'SETTLED', 'VOIDED')
                GROUP BY b.id
                HAVING debit_units != credit_units OR debit_units = 0`,
          params: [],
        },
        {
          name: 'Period equation journal totals via idx_ledger_batches_status_hold',
          sql: `SELECT journal_type, COALESCE(SUM(gross_commission_units), 0) AS total_units
                FROM ledger_journal_batches INDEXED BY idx_ledger_batches_status_hold
                WHERE status IN ('INFLIGHT', 'SETTLED', 'VOIDED')
                GROUP BY journal_type`,
          params: [],
        },
      ];

      const forbiddenFullScans = [
        'SCAN ledger_postings',
        'SCAN ledger_journal_batches',
        'SCAN partner_cash_reconciliations',
        'SCAN ledger_accounts',
        'SCAN r2_evidence_objects',
      ];

      for (const q of hotQueries) {
        const planRows = sqlite
          .prepare(`EXPLAIN QUERY PLAN ${q.sql}`)
          .all(...q.params) as Array<{ detail: string }>;

        const planDetails = planRows.map((r) => r.detail).join(' | ');

        // Assert at least one indexed SEARCH operation
        expect(`${q.name} => ${planDetails}`).toMatch(/SEARCH .+ USING (?:COVERING )?INDEX/);

        // Assert zero full table scans on any core ledger/reconciliation table
        for (const forbidden of forbiddenFullScans) {
          expect(planDetails).not.toContain(forbidden);
        }

        // Benchmark average execution over 25 runs (< 8 ms budget)
        const stmt = sqlite.prepare(q.sql);
        const iterations = 25;
        const startMs = performance.now();
        for (let iter = 0; iter < iterations; iter++) {
          stmt.all(...q.params);
        }
        const avgMs = (performance.now() - startMs) / iterations;
        expect(avgMs).toBeLessThan(8);
      }
    } finally {
      await db.close();
    }
  });
});
