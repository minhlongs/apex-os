/**
 * Gate G9: CASH_COLLECTED 0.01 USDC Discrepancy Halt, Pre/Post T+7 Clawbacks,
 * and Independent External Auditor Reconstruction of 100 Transactions from R2 + D1
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BI_ZERO,
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  RECONCILIATION_TOLERANCE_UNITS_1E8,
  SqliteD1Adapter,
  UnreconciledCashError,
  computeSafeSpreadWaterfall,
  computeSha256Hex,
  evaluateCashReconciliation,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  verifyEvidenceIntegrity,
  verifyLedgerInvariants,
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

describe('Gate G9: CASH_COLLECTED Discrepancy Halt, Clawbacks & 100-Tx Auditor Reconstruction', () => {
  it('immediately detects a 0.01 USDC (1,000,000 units) discrepancy and halts minting, while permitting sub-cent wallet surplus', async () => {
    const { db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      expect(RECONCILIATION_TOLERANCE_UNITS_1E8).toBe(BigInt('1000000'));

      // Exact boundary: wallet has $100.01, UID sum is $100.00 -> diff === 0.01 USDC -> DISCREPANCY_HALTED
      const evalExactCent = evaluateCashReconciliation(
        parseUsdToLedgerUnits('100.00'),
        parseUsdToLedgerUnits('100.01')
      );
      expect(evalExactCent.status).toBe('DISCREPANCY_HALTED');
      expect(evalExactCent.discrepancyUnits).toBe(BigInt('1000000'));

      // Sub-cent surplus ($0.00999999) where wallet >= UID -> MATCHED
      const evalSubCentSurplus = evaluateCashReconciliation(
        parseUsdToLedgerUnits('100.00000000'),
        parseUsdToLedgerUnits('100.00999999')
      );
      expect(evalSubCentSurplus.status).toBe('MATCHED');

      // Even 1 unit ($0.00000001) shortfall where UID > wallet -> DISCREPANCY_HALTED
      const evalOneUnitShortfall = evaluateCashReconciliation(
        parseUsdToLedgerUnits('100.00000001'),
        parseUsdToLedgerUnits('100.00000000')
      );
      expect(evalOneUnitShortfall.status).toBe('DISCREPANCY_HALTED');

      // Persist $0.01 discrepancy in SQLite and verify ledger refuses to mint
      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'gateio',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ uidTotal: '500.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'gateio',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ walletTotal: '499.99' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });

      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'gateio',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: parseUsdToLedgerUnits('500.00'),
        walletCashCollectedUnits: parseUsdToLedgerUnits('499.99'),
        r2,
      });

      expect(recon.status).toBe('DISCREPANCY_HALTED');
      expect(recon.discrepancyUnits).toBe(BigInt('1000000'));

      await expect(
        ledger.recordVerifiedCommissionInflight({
          idempotencyKey: 'g9-cent-halt',
          exchange: 'gateio',
          traderUid: 'gate_uid_1',
          traderId: 'trader_gate_1',
          reconciliationId: recon.id,
          evidenceId: uidEv.id,
          grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
          r2,
        })
      ).rejects.toThrow(UnreconciledCashError);
    } finally {
      await db.close();
    }
  });

  it('handles clawbacks both inside T+7 (< 7d inflight reversal) and after T+7 (>= 7d reserve-first absorption) without negative user balances', async () => {
    const { db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ batchTotal: '300.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ walletCredit: '300.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: parseUsdToLedgerUnits('300.00'),
        walletCashCollectedUnits: parseUsdToLedgerUnits('300.00'),
        r2,
      });

      // Case A: Clawback inside < 7 days (`INFLIGHT`)
      const batchA = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'g9-batch-a',
        exchange: 'bybit',
        traderUid: 'uid_claw_a',
        traderId: 'trader_claw_a',
        l1AffiliateId: 'aff_claw_a',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: '2026-11-01T00:00:00.000Z',
        r2,
      });

      // Day 3: 40% ($40.00) partial clawback during T+7 hold
      const clawInsideHold = await ledger.applyClawback({
        idempotencyKey: 'g9-claw-inside-hold',
        originalBatchId: batchA.batch.id,
        clawbackUnits: parseUsdToLedgerUnits('40.00'),
        reason: 'Bybit wash-trade partial fee adjustment (T+3)',
        nowIso: '2026-11-04T00:00:00.000Z',
      });
      expect(clawInsideHold.mode).toBe('INFLIGHT_VOID');

      const traderBeforeSettle = await ledger.getAccountByOwner('trader', 'trader_claw_a');
      expect(traderBeforeSettle?.settledBalanceUnits).toBe(BI_ZERO);
      // 60% of $47.50 = $28.50 remains inflight
      expect(traderBeforeSettle?.inflightBalanceUnits).toBe(parseUsdToLedgerUnits('28.50'));

      // Day 8: Settle remaining 60% ($60.00 gross)
      await ledger.releaseMaturedInflightBatch(
        batchA.batch.id,
        '2026-11-09T00:00:00.000Z'
      );
      const traderAfterSettleA = await ledger.getAccountByOwner('trader', 'trader_claw_a');
      expect(traderAfterSettleA?.inflightBalanceUnits).toBe(BI_ZERO);
      expect(traderAfterSettleA?.settledBalanceUnits).toBe(parseUsdToLedgerUnits('28.50'));

      // Case B: Clawback AFTER >= 7 days (`SETTLED`) after trader already withdrew settled funds!
      const batchB = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'g9-batch-b',
        exchange: 'bybit',
        traderUid: 'uid_claw_b',
        traderId: 'trader_claw_b',
        l1AffiliateId: 'aff_claw_b',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('200.00'),
        createdAt: '2026-11-01T00:00:00.000Z',
        r2,
      });

      await ledger.releaseMaturedInflightBatch(
        batchB.batch.id,
        '2026-11-09T00:00:00.000Z'
      );

      // Trader B withdraws all $95.00 settled cashback immediately on Day 8
      const wdLock = await ledger.lockSettledForWithdrawal({
        idempotencyKey: 'g9-trader-b-wd-lock',
        ownerType: 'trader',
        ownerId: 'trader_claw_b',
        amountUnits: parseUsdToLedgerUnits('95.00'),
        payoutId: 'po_trader_b_full',
        nowIso: '2026-11-09T01:00:00.000Z',
      });
      await ledger.finalizeWithdrawal({
        idempotencyKey: 'g9-trader-b-wd-fin',
        lockBatchId: wdLock.batch.id,
        txHash: '0xtraderbfullwithdrawal',
        nowIso: '2026-11-09T01:05:00.000Z',
      });

      const traderBPreClaw = await ledger.getAccountByOwner('trader', 'trader_claw_b');
      expect(traderBPreClaw?.settledBalanceUnits).toBe(BI_ZERO);

      // Day 12: Exchange issues late $50.00 clawback on settled Batch B.
      // Reserve pool currently holds $3.00 (from Batch A remaining) + $10.00 (from Batch B) = $13.00.
      // Reserve absorbs $13.00 first, platform revenue absorbs remaining $37.00, and Trader B stays >= 0!
      const clawPostSettle = await ledger.applyClawback({
        idempotencyKey: 'g9-claw-post-settle',
        originalBatchId: batchB.batch.id,
        clawbackUnits: parseUsdToLedgerUnits('50.00'),
        reason: 'Late institutional VIP tier retroactive rebate clawback (T+12)',
        nowIso: '2026-11-13T00:00:00.000Z',
      });

      expect(clawPostSettle.mode).toBe('POST_SETTLEMENT_RESERVE');
      expect(clawPostSettle.reserveDebitedUnits).toBe(parseUsdToLedgerUnits('13.00'));
      expect(clawPostSettle.platformAbsorbedUnits).toBe(parseUsdToLedgerUnits('37.00'));

      const traderBPostClaw = await ledger.getAccountByOwner('trader', 'trader_claw_b');
      expect(traderBPostClaw?.settledBalanceUnits).toBe(BI_ZERO);

      const reservePostClaw = await ledger.getAccountByCode('reserve:clawback_pool');
      expect(reservePostClaw?.settledBalanceUnits).toBe(BI_ZERO);

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
      expect(invariants.negativeUserAccountCodes).toHaveLength(0);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await db.close();
    }
  });

  it('enables an independent external auditor to reconstruct 100 transactions from R2 raw bytes + SQLite D1 to 0 discrepancy', async () => {
    const { sqlite, db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      interface PartnerStatementRow {
        txRef: string;
        traderUid: string;
        traderId: string;
        l1AffiliateId: string | null;
        commissionUsd: string;
      }

      const statementRows: PartnerStatementRow[] = [];
      let totalExpectedUnits = BI_ZERO;

      for (let i = 0; i < 100; i++) {
        // Deterministic varied amounts ($1.05 .. $250.99876543)
        const dollars = 1 + ((i * 17) % 250);
        const nanos = ((i * 9876543) % 100_000_000).toString().padStart(8, '0');
        const commissionUsd = `${dollars}.${nanos}`;
        totalExpectedUnits += parseUsdToLedgerUnits(commissionUsd);

        statementRows.push({
          txRef: `bybit_fill_${String(i).padStart(4, '0')}`,
          traderUid: `8800${String(i).padStart(4, '0')}`,
          traderId: `trader_audit_${i % 15}`,
          l1AffiliateId: i % 4 === 0 ? null : `aff_audit_${i % 6}`,
          commissionUsd,
        });
      }

      const rawPartnerJson = JSON.stringify({
        exchange: 'bybit',
        periodStart: '2026-11-01T00:00:00.000Z',
        periodEnd: '2026-11-07T23:59:59.000Z',
        rows: statementRows,
      });

      const rawWalletJson = JSON.stringify({
        exchange: 'bybit',
        walletTxId: 'bybit_broker_credit_20261107',
        totalCreditedUnits1e8: totalExpectedUnits.toString(),
      });

      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: rawPartnerJson,
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-07T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: rawWalletJson,
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-07T23:59:59.000Z',
      });

      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: totalExpectedUnits,
        walletCashCollectedUnits: totalExpectedUnits,
        r2,
      });
      expect(recon.status).toBe('MATCHED');
      expect(recon.discrepancyUnits).toBe(BI_ZERO);

      for (const row of statementRows) {
        const res = await ledger.recordVerifiedCommissionInflight({
          idempotencyKey: `audit-100-${row.txRef}`,
          exchange: 'bybit',
          traderUid: row.traderUid,
          traderId: row.traderId,
          l1AffiliateId: row.l1AffiliateId,
          reconciliationId: recon.id,
          evidenceId: uidEv.id,
          grossCommissionUnits: parseUsdToLedgerUnits(row.commissionUsd),
          createdAt: '2026-11-07T23:59:59.000Z',
        });
        await ledger.releaseMaturedInflightBatch(
          res.batch.id,
          '2026-11-15T00:00:00.000Z'
        );
      }

      // =====================================================================
      // Independent External Auditor Reconstruction from R2 + SQLite ONLY
      // =====================================================================
      const uidIntegrity = await verifyEvidenceIntegrity(db, r2, uidEv.id);
      const walletIntegrity = await verifyEvidenceIntegrity(db, r2, walletEv.id);
      expect(uidIntegrity.valid).toBe(true);
      expect(walletIntegrity.valid).toBe(true);

      const r2PartnerBody = await r2.get(uidEv.r2ObjectKey);
      const r2WalletBody = await r2.get(walletEv.r2ObjectKey);
      expect(r2PartnerBody).not.toBeNull();
      expect(r2WalletBody).not.toBeNull();

      const partnerBytes = new Uint8Array(await r2PartnerBody!.arrayBuffer());
      const walletBytes = new Uint8Array(await r2WalletBody!.arrayBuffer());

      // Auditor independently hashes bytes and matches D1 anchor
      expect(await computeSha256Hex(partnerBytes)).toBe(uidEv.payloadSha256);
      expect(await computeSha256Hex(walletBytes)).toBe(walletEv.payloadSha256);

      const parsedPartner = JSON.parse(new TextDecoder().decode(partnerBytes)) as {
        rows: PartnerStatementRow[];
      };
      const parsedWallet = JSON.parse(new TextDecoder().decode(walletBytes)) as {
        totalCreditedUnits1e8: string;
      };
      expect(parsedPartner.rows).toHaveLength(100);

      let auditorGrossSum = BI_ZERO;
      let auditorReserveSum = BI_ZERO;
      let auditorTraderSum = BI_ZERO;
      let auditorL1Sum = BI_ZERO;
      let auditorPlatformSum = BI_ZERO;

      for (const row of parsedPartner.rows) {
        const c = parseUsdToLedgerUnits(row.commissionUsd);
        const wf = computeSafeSpreadWaterfall(c, {
          hasL1Referrer: row.l1AffiliateId !== null,
        });
        auditorGrossSum += c;
        auditorReserveSum += wf.reserveUnits;
        auditorTraderSum += wf.traderCashbackUnits;
        auditorL1Sum += wf.l1CommissionUnits;
        auditorPlatformSum += wf.platformNetUnits;
      }

      expect(auditorGrossSum).toBe(BigInt(parsedWallet.totalCreditedUnits1e8));

      // Compare auditor totals against SQLite `ledger_accounts` settled balances
      const sumByOwnerType = (ownerType: string): bigint => {
        const row = sqlite
          .prepare(
            `SELECT COALESCE(SUM(settled_balance_units), 0) AS s
             FROM ledger_accounts
             WHERE owner_type = ?`
          )
          .get(ownerType) as { s: number };
        return BigInt(row.s);
      };

      const dbReserve = sumByOwnerType('reserve');
      const dbTraders = sumByOwnerType('trader');
      const dbAffiliates = sumByOwnerType('affiliate');
      const dbPlatformRow = sqlite
        .prepare(
          `SELECT settled_balance_units AS s
           FROM ledger_accounts
           WHERE account_code = 'system:platform_revenue'`
        )
        .get() as { s: number };
      const dbPlatform = BigInt(dbPlatformRow.s);

      expect(dbReserve - auditorReserveSum).toBe(BI_ZERO);
      expect(dbTraders - auditorTraderSum).toBe(BI_ZERO);
      expect(dbAffiliates - auditorL1Sum).toBe(BI_ZERO);
      expect(dbPlatform - auditorPlatformSum).toBe(BI_ZERO);

      const invariantReport = await verifyLedgerInvariants(db);
      expect(invariantReport.valid).toBe(true);
      expect(invariantReport.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await db.close();
    }
  });
});
