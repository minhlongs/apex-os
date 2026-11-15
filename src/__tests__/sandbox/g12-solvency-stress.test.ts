/**
 * Gate G12: Safe-Spread Waterfall I4 Solvency Stress & Decree 40/2018/ND-CP Compliance
 *
 * Simulates Safe-Spread Waterfall I4 across:
 * - All exchange partner commission tiers (`0%`, `10%`, `20%`, `30%`, `40%`, `50%`)
 * - Realized clawback rates (`0%` through `10%` in 1% increments)
 * - VIP zero-commission / market-maker negative-maker-fee trades (`C === 0`)
 * - `$10.00 USDC` (`1,000,000,000` units) minimum withdrawal threshold
 * - Decree `40/2018/ND-CP` hard ban on L3 (`tier3ShareOfSpread !== '0'`) and
 *   solvency cap (`tier1 + tier2 <= 0.45`, `tier2 <= 0.10`)
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BI_ZERO,
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  InvalidWaterfallConfigError,
  LEDGER_SCALE,
  LedgerUnitValidationError,
  MIN_WITHDRAWAL_UNITS_1E8,
  SqliteD1Adapter,
  computeSafeSpreadWaterfall,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  validateWaterfallConfig,
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

describe('Gate G12: Safe-Spread Waterfall I4 Solvency Stress & Regulatory Compliance', () => {
  it('computes canonical $100.00 split ($5.00 reserve, $47.50 trader, $14.25 L1, $33.25 platform net) and zero liability on VIP 0% trades', () => {
    const wf100 = computeSafeSpreadWaterfall(parseUsdToLedgerUnits('100.00'), {
      hasL1Referrer: true,
    });

    expect(wf100.reserveUnits).toBe(parseUsdToLedgerUnits('5.00'));
    expect(wf100.distributableUnits).toBe(parseUsdToLedgerUnits('95.00'));
    expect(wf100.traderCashbackUnits).toBe(parseUsdToLedgerUnits('47.50'));
    expect(wf100.spreadUnits).toBe(parseUsdToLedgerUnits('47.50'));
    expect(wf100.l1CommissionUnits).toBe(parseUsdToLedgerUnits('14.25'));
    expect(wf100.l2CommissionUnits).toBe(BI_ZERO);
    expect(wf100.l3CommissionUnits).toBe(BI_ZERO);
    expect(wf100.platformNetUnits).toBe(parseUsdToLedgerUnits('33.25'));

    // VIP zero-commission trade (exchange pays $0.00) -> 0 liability across all legs
    const wfVipZero = computeSafeSpreadWaterfall(BI_ZERO, { hasL1Referrer: true });
    expect(wfVipZero.reserveUnits).toBe(BI_ZERO);
    expect(wfVipZero.distributableUnits).toBe(BI_ZERO);
    expect(wfVipZero.traderCashbackUnits).toBe(BI_ZERO);
    expect(wfVipZero.l1CommissionUnits).toBe(BI_ZERO);
    expect(wfVipZero.l2CommissionUnits).toBe(BI_ZERO);
    expect(wfVipZero.l3CommissionUnits).toBe(BI_ZERO);
    expect(wfVipZero.platformNetUnits).toBe(BI_ZERO);
  });

  it('hard-rejects any non-zero L3 share (Decree 40/2018/ND-CP) and any tier1+tier2 > 0.45 or tier2 > 0.10', () => {
    expect(() =>
      computeSafeSpreadWaterfall(parseUsdToLedgerUnits('100.00'), {
        config: { tier3ShareOfSpread: '0.05' },
      })
    ).toThrow(InvalidWaterfallConfigError);

    expect(() =>
      computeSafeSpreadWaterfall(BI_ZERO, {
        config: { tier3ShareOfSpread: '0.000001' },
      })
    ).toThrow(InvalidWaterfallConfigError);

    expect(() =>
      validateWaterfallConfig({
        tier3ShareOfSpread: '0.00', // non-canonical string also rejected
      })
    ).toThrow(InvalidWaterfallConfigError);

    expect(() =>
      computeSafeSpreadWaterfall(parseUsdToLedgerUnits('100.00'), {
        config: { tier1ShareOfSpread: '0.40', tier2ShareOfSpread: '0.06' },
      })
    ).toThrow(InvalidWaterfallConfigError);

    expect(() =>
      computeSafeSpreadWaterfall(parseUsdToLedgerUnits('100.00'), {
        config: { tier1ShareOfSpread: '0.30', tier2ShareOfSpread: '0.11' },
      })
    ).toThrow(InvalidWaterfallConfigError);

    // Valid B2B agency override (tier1=0.30, tier2=0.10 -> sum=0.40 <= 0.45) succeeds
    const validB2b = computeSafeSpreadWaterfall(parseUsdToLedgerUnits('100.00'), {
      config: { tier1ShareOfSpread: '0.30', tier2ShareOfSpread: '0.10' },
      hasL1Referrer: true,
      hasB2bAgencyPartner: true,
    });
    expect(validB2b.l2CommissionUnits).toBe(parseUsdToLedgerUnits('4.75'));
    expect(validB2b.platformNetUnits).toBe(parseUsdToLedgerUnits('28.50'));
  });

  it('proves positive contribution profit across all partner tiers (0%..50%) and clawback rates (0%..10%)', () => {
    const partnerCommissionTiers = [0, 0.10, 0.20, 0.30, 0.40, 0.50];
    const tradeFeeBaseUsd = 100; // $100 exchange trading fee on $100,000 notional @ 10 bps
    const clawbackRatesPct = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    for (const partnerTier of partnerCommissionTiers) {
      const grossCommissionUsd = (tradeFeeBaseUsd * partnerTier).toFixed(2);
      const cUnits = parseUsdToLedgerUnits(grossCommissionUsd);

      for (const hasB2bOverride of [false, true]) {
        const wf = computeSafeSpreadWaterfall(cUnits, {
          config: {
            clawbackReserveRate: '0.05',
            traderCashbackShareOfDistributable: '0.50',
            tier1ShareOfSpread: '0.30',
            tier2ShareOfSpread: hasB2bOverride ? '0.10' : '0',
            tier3ShareOfSpread: '0',
          },
          hasL1Referrer: true,
          hasB2bAgencyPartner: hasB2bOverride,
        });

        // Exact conservation
        expect(
          wf.reserveUnits +
            wf.traderCashbackUnits +
            wf.l1CommissionUnits +
            wf.l2CommissionUnits +
            wf.l3CommissionUnits +
            wf.platformNetUnits
        ).toBe(cUnits);

        if (partnerTier === 0) {
          const totalLiability =
            wf.traderCashbackUnits + wf.l1CommissionUnits + wf.l2CommissionUnits;
          expect(totalLiability).toBe(BI_ZERO);
          expect(wf.platformNetUnits).toBe(BI_ZERO);
          continue;
        }

        // Whenever exchange commission > 0, gross platform contribution is strictly > 0
        expect(wf.platformNetUnits).toBeGreaterThan(BI_ZERO);

        // Stress test post-settlement unrecovered clawback across 0%..10% clawback rates:
        // Total loss absorbed by reserve + platform is `clawbackLoss = cUnits * clawPct / 100`.
        // Net contribution after clawback = `(wf.reserveUnits + wf.platformNetUnits) - clawbackLoss`.
        for (const clawPct of clawbackRatesPct) {
          const clawbackLossUnits = (cUnits * BigInt(clawPct)) / BigInt(100);
          const netContributionAfterClawback =
            wf.reserveUnits + wf.platformNetUnits - clawbackLossUnits;

          // Even at 10% worst-case post-settlement clawback AND maximum 10% B2B override:
          // reserve (5%) + platformNet (28.5%..33.25%) = 33.5%..38.25% >> 10% clawback!
          expect(netContributionAfterClawback).toBeGreaterThan(BI_ZERO);
        }
      }
    }
  });

  it('enforces the $10.00 USDC minimum withdrawal threshold so gas/network fees never erode unit economics', async () => {
    const { db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      expect(MIN_WITHDRAWAL_UNITS_1E8).toBe(BigInt(10) * LEDGER_SCALE);

      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ total: '50.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ wallet: '50.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: parseUsdToLedgerUnits('50.00'),
        walletCashCollectedUnits: parseUsdToLedgerUnits('50.00'),
        r2,
      });

      const recorded = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'g12-min-wd-seed',
        exchange: 'bybit',
        traderUid: 'uid_g12_min',
        traderId: 'trader_g12_min',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('50.00'),
        createdAt: '2026-11-01T00:00:00.000Z',
        r2,
      });

      await ledger.releaseMaturedInflightBatch(
        recorded.batch.id,
        '2026-11-09T00:00:00.000Z'
      );

      // Sub-$10 withdrawal ($9.99999999) is rejected
      await expect(
        ledger.lockSettledForWithdrawal({
          idempotencyKey: 'g12-sub-10-wd',
          ownerType: 'trader',
          ownerId: 'trader_g12_min',
          amountUnits: parseUsdToLedgerUnits('9.99999999'),
          payoutId: 'po_sub_10',
        })
      ).rejects.toThrow(LedgerUnitValidationError);

      // Exact $10.00 USDC withdrawal succeeds
      const validLock = await ledger.lockSettledForWithdrawal({
        idempotencyKey: 'g12-exact-10-wd',
        ownerType: 'trader',
        ownerId: 'trader_g12_min',
        amountUnits: parseUsdToLedgerUnits('10.00'),
        payoutId: 'po_exact_10',
      });
      expect(validLock.batch.status).toBe('INFLIGHT');
    } finally {
      await db.close();
    }
  });
});
