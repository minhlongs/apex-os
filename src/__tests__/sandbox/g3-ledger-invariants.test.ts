/**
 * Gate G3: Atomic Double-Entry Ledger Invariants, T+7 Hold, Chain Decimals,
 * EMERGENCY_LEDGER_FREEZE Circuit Breaker & 10,000-Tx Deterministic PRNG Fuzz Suite
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BI_ZERO,
  DoubleEntryLedgerService,
  HoldPeriodNotMaturedError,
  InMemoryR2Bucket,
  InsufficientSettledBalanceError,
  LedgerFrozenError,
  LedgerOverflowError,
  SqliteD1Adapter,
  isLedgerFrozen,
  ledgerUnitsToChainUnits,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  toSafeSqlInteger,
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

/** Deterministic Mulberry32 PRNG for reproducible 10,000-tx fuzz testing. */
function createMulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Gate G3: Double-Entry Ledger Invariants & 10,000-Tx Deterministic Fuzz', () => {
  it('converts 10^-8 USD ledger units to Stellar (7d) & Arbitrum/Base (6d) with zero float drift and guards safe SQLite integers', () => {
    const units = parseUsdToLedgerUnits('123.45678912');
    expect(units).toBe(BigInt('12345678912'));

    const stellar = ledgerUnitsToChainUnits(units, 'stellar');
    expect(stellar.decimals).toBe(7);
    expect(stellar.chainUnits).toBe(BigInt('1234567891'));
    expect(stellar.formatted).toBe('123.4567891');
    expect(stellar.residualDust1e8).toBe(BigInt(2));

    const arbitrum = ledgerUnitsToChainUnits(units, 'arbitrum');
    expect(arbitrum.decimals).toBe(6);
    expect(arbitrum.chainUnits).toBe(BigInt('123456789'));
    expect(arbitrum.formatted).toBe('123.456789');
    expect(arbitrum.residualDust1e8).toBe(BigInt(12));

    const base = ledgerUnitsToChainUnits(units, 'base');
    expect(base.decimals).toBe(6);
    expect(base.chainUnits).toBe(BigInt('123456789'));
    expect(base.residualDust1e8).toBe(BigInt(12));

    expect(() =>
      toSafeSqlInteger(BigInt(Number.MAX_SAFE_INTEGER) + BigInt(1))
    ).toThrow(LedgerOverflowError);
  });

  it('enforces T+7 hold maturation, prevents negative settled balances, and handles withdrawal revert cleanly', async () => {
    const { db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ total: '100.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ cash: '100.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: parseUsdToLedgerUnits('100.00'),
        walletCashCollectedUnits: parseUsdToLedgerUnits('100.00'),
        r2,
      });

      const recorded = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'g3-hold-1',
        exchange: 'bybit',
        traderUid: 'uid_hold_1',
        traderId: 'trader_hold_1',
        l1AffiliateId: 'aff_hold_1',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: '2026-11-01T12:00:00.000Z',
        r2,
      });

      // Attempting withdrawal while still INFLIGHT fails because settled_balance_units === 0
      await expect(
        ledger.lockSettledForWithdrawal({
          idempotencyKey: 'g3-premature-wd',
          ownerType: 'trader',
          ownerId: 'trader_hold_1',
          amountUnits: parseUsdToLedgerUnits('10.00'),
          payoutId: 'po_premature',
        })
      ).rejects.toThrow(InsufficientSettledBalanceError);

      // Attempting release 1 second before T+7 fails with HoldPeriodNotMaturedError
      await expect(
        ledger.releaseMaturedInflightBatch(
          recorded.batch.id,
          '2026-11-08T11:59:59.000Z'
        )
      ).rejects.toThrow(HoldPeriodNotMaturedError);

      // Exact T+7 timestamp settles cleanly
      const settled = await ledger.releaseMaturedInflightBatch(
        recorded.batch.id,
        '2026-11-08T12:00:00.000Z'
      );
      expect(settled.batch.status).toBe('SETTLED');

      const traderAcct = await ledger.getAccountByOwner('trader', 'trader_hold_1');
      expect(traderAcct?.inflightBalanceUnits).toBe(BI_ZERO);
      expect(traderAcct?.settledBalanceUnits).toBe(parseUsdToLedgerUnits('47.50'));

      // Over-withdrawal beyond $47.50 fails
      await expect(
        ledger.lockSettledForWithdrawal({
          idempotencyKey: 'g3-over-wd',
          ownerType: 'trader',
          ownerId: 'trader_hold_1',
          amountUnits: parseUsdToLedgerUnits('47.51'),
          payoutId: 'po_over',
        })
      ).rejects.toThrow(InsufficientSettledBalanceError);

      // Lock $20.00 -> revert -> full $47.50 restored
      const lock = await ledger.lockSettledForWithdrawal({
        idempotencyKey: 'g3-valid-lock',
        ownerType: 'trader',
        ownerId: 'trader_hold_1',
        amountUnits: parseUsdToLedgerUnits('20.00'),
        payoutId: 'po_valid',
      });
      await ledger.revertWithdrawal({
        idempotencyKey: 'g3-revert-lock',
        lockBatchId: lock.batch.id,
        reason: 'Stellar timebounds expired before inclusion',
      });

      const restoredTrader = await ledger.getAccountByOwner('trader', 'trader_hold_1');
      expect(restoredTrader?.settledBalanceUnits).toBe(parseUsdToLedgerUnits('47.50'));

      const report = await verifyLedgerInvariants(db);
      expect(report.valid).toBe(true);
      expect(report.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await db.close();
    }
  });

  it('auto-triggers EMERGENCY_LEDGER_FREEZE when verifyLedgerInvariants detects drift and blocks subsequent mutations', async () => {
    const { sqlite, db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);

    try {
      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'okx',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({ total: '50.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'okx',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ cash: '50.00' }),
        statementPeriodStart: '2026-11-01T00:00:00.000Z',
        statementPeriodEnd: '2026-11-01T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'okx',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: parseUsdToLedgerUnits('50.00'),
        walletCashCollectedUnits: parseUsdToLedgerUnits('50.00'),
        r2,
      });

      await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'g3-freeze-seed',
        exchange: 'okx',
        traderUid: 'uid_okx_9',
        traderId: 'trader_okx_9',
        reconciliationId: recon.id,
        evidenceId: uidEv.id,
        grossCommissionUnits: parseUsdToLedgerUnits('25.00'),
        r2,
      });

      // Simulate out-of-band DB corruption (+1 minor unit on trader account without posting)
      sqlite
        .prepare(
          `UPDATE ledger_accounts
           SET inflight_balance_units = inflight_balance_units + 1
           WHERE account_code = 'trader:trader_okx_9'`
        )
        .run();

      const report = await verifyLedgerInvariants(db);
      expect(report.valid).toBe(false);
      expect(report.emergencyFreezeTriggered).toBe(true);
      expect(report.accountPostingDriftCodes).toContain('trader:trader_okx_9');

      const freezeState = await isLedgerFrozen(db);
      expect(freezeState.frozen).toBe(true);

      await expect(
        ledger.recordVerifiedCommissionInflight({
          idempotencyKey: 'g3-blocked-after-freeze',
          exchange: 'okx',
          traderUid: 'uid_okx_9',
          traderId: 'trader_okx_9',
          reconciliationId: recon.id,
          evidenceId: uidEv.id,
          grossCommissionUnits: parseUsdToLedgerUnits('10.00'),
          r2,
        })
      ).rejects.toThrow(LedgerFrozenError);
    } finally {
      await db.close();
    }
  });

  it('executes 10,000 deterministic PRNG fuzz transactions (commissions, replays, T+7 releases, up to 100% clawbacks, withdrawals) with 0 unit (10^-8 USD) drift', async () => {
    const { db } = createMigratedSandboxDb();
    const r2 = new InMemoryR2Bucket();
    const ledger = new DoubleEntryLedgerService(db);
    const rng = createMulberry32(0x20261114);

    try {
      // Pre-anchor a large reconciled partner liquidity pool ($50,000,000.00 USDC)
      const poolCap = parseUsdToLedgerUnits('50000000.00');
      const uidEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'csv_statement',
        rawBytes: 'uid,commission_usdc\nbulk_fuzz_pool,50000000.00\n',
        statementPeriodStart: '2026-01-01T00:00:00.000Z',
        statementPeriodEnd: '2026-12-31T23:59:59.000Z',
      });
      const walletEv = await storeEvidenceObject(db, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ walletCashCollected: '50000000.00' }),
        statementPeriodStart: '2026-01-01T00:00:00.000Z',
        statementPeriodEnd: '2026-12-31T23:59:59.000Z',
      });
      const recon = await reconcilePartnerCashBatch(db, {
        exchange: 'bybit',
        evidenceId: uidEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: poolCap,
        walletCashCollectedUnits: poolCap,
        r2,
      });

      interface TrackedCommission {
        batchId: string;
        input: Parameters<DoubleEntryLedgerService['recordVerifiedCommissionInflight']>[0];
        remainingClawbackable: bigint;
        status: 'INFLIGHT' | 'SETTLED' | 'VOIDED';
      }

      const inflightPool: TrackedCommission[] = [];
      const settledPool: TrackedCommission[] = [];
      const allRecorded: TrackedCommission[] = [];
      const pendingLocks: string[] = [];

      const traders = Array.from({ length: 25 }, (_, idx) => `fuzz_trader_${idx}`);
      const affiliates = Array.from({ length: 10 }, (_, idx) => `fuzz_aff_${idx}`);

      let expectedVerified = BI_ZERO;
      let expectedReversals = BI_ZERO;
      let expectedSettledWithdrawals = BI_ZERO;
      let replayCount = 0;
      let clawback100PctCount = 0;

      const baseEpochMs = Date.parse('2026-06-01T00:00:00.000Z');
      const matureIso = new Date(baseEpochMs + 10 * 24 * 60 * 60 * 1000).toISOString();
      const createdIso = new Date(baseEpochMs).toISOString();

      const TOTAL_FUZZ_TX = 10_000;

      for (let step = 0; step < TOTAL_FUZZ_TX; step++) {
        const roll = rng();

        if (roll < 0.50 || allRecorded.length === 0) {
          // 1) Record new verified commission inflight ($0.01 .. $500.00 with odd 1e-8 dust)
          const randomUnits = BigInt(Math.floor(rng() * 50_000_000_000) + 1_000_000);
          const traderId = traders[Math.floor(rng() * traders.length)];
          const hasL1 = rng() < 0.85;
          const l1AffiliateId = hasL1
            ? affiliates[Math.floor(rng() * affiliates.length)]
            : null;

          // Omit r2 re-hash on hot fuzz iterations after initial reconciliation check
          // so 10,000 SQLite double-entry transactions complete rapidly
          const commInput = {
            idempotencyKey: `fuzz-comm-${step}`,
            exchange: 'bybit' as const,
            traderUid: `uid_${traderId}`,
            traderId,
            l1AffiliateId,
            reconciliationId: recon.id,
            evidenceId: uidEv.id,
            grossCommissionUnits: randomUnits,
            createdAt: createdIso,
          };

          const res = await ledger.recordVerifiedCommissionInflight(commInput);
          expect(res.isReplay).toBe(false);
          expectedVerified += randomUnits;

          const tracked: TrackedCommission = {
            batchId: res.batch.id,
            input: commInput,
            remainingClawbackable: randomUnits,
            status: 'INFLIGHT',
          };
          inflightPool.push(tracked);
          allRecorded.push(tracked);
        } else if (roll < 0.60 && allRecorded.length > 0) {
          // 2) Duplicate event replay (idempotent no-op)
          const pick = allRecorded[Math.floor(rng() * allRecorded.length)];
          const replayRes = await ledger.recordVerifiedCommissionInflight(pick.input);
          expect(replayRes.isReplay).toBe(true);
          replayCount++;
        } else if (roll < 0.78 && inflightPool.length > 0) {
          // 3) Release matured T+7 inflight batch
          const idx = Math.floor(rng() * inflightPool.length);
          const target = inflightPool.splice(idx, 1)[0];
          const rel = await ledger.releaseMaturedInflightBatch(target.batchId, matureIso);
          expect(rel.isReplay).toBe(false);
          target.status = 'SETTLED';
          if (target.remainingClawbackable > BI_ZERO) {
            settledPool.push(target);
          }
        } else if (roll < 0.90 && (inflightPool.length > 0 || settledPool.length > 0)) {
          // 4) Random clawback (including partial and 100% full clawbacks, pre- and post-T+7)
          const useInflight =
            inflightPool.length > 0 && (settledPool.length === 0 || rng() < 0.65);
          const pool = useInflight ? inflightPool : settledPool;
          const idx = Math.floor(rng() * pool.length);
          const target = pool[idx];

          const isFullClawback = rng() < 0.35;
          let clawUnits: bigint;
          if (isFullClawback || target.remainingClawbackable <= BigInt(10)) {
            clawUnits = target.remainingClawbackable;
            clawback100PctCount++;
          } else {
            const pctBps = BigInt(Math.floor(rng() * 9500) + 100);
            clawUnits = (target.remainingClawbackable * pctBps) / BigInt(10000);
            if (clawUnits <= BI_ZERO) {
              clawUnits = BigInt(1);
            }
          }

          const clawRes = await ledger.applyClawback({
            idempotencyKey: `fuzz-claw-${step}`,
            originalBatchId: target.batchId,
            clawbackUnits: clawUnits,
            reason: 'Fuzz chargeback / fee reversal',
            nowIso: matureIso,
            recoverFromFutureInflight: !useInflight && rng() < 0.4,
          });
          expect(clawRes.isReplay).toBe(false);
          expectedReversals += clawUnits;
          target.remainingClawbackable -= clawUnits;

          // Sync any secondary inflight batches touched if recoverFromFutureInflight triggered
          if (clawRes.futureInflightRecoveredUnits > BI_ZERO) {
            for (let j = inflightPool.length - 1; j >= 0; j--) {
              const refreshed = await ledger.getBatchById(inflightPool[j].batchId);
              if (!refreshed || refreshed.status === 'VOIDED') {
                inflightPool.splice(j, 1);
              } else {
                const remLegs = refreshed.metadata.remainingLegs as { grossUnits: string };
                inflightPool[j].remainingClawbackable = BigInt(remLegs.grossUnits);
              }
            }
          }

          if (target.remainingClawbackable === BI_ZERO) {
            pool.splice(idx, 1);
            target.status = useInflight ? 'VOIDED' : 'SETTLED';
          }
        } else {
          // 5) Withdrawal lock / finalize / revert
          if (pendingLocks.length > 0 && rng() < 0.65) {
            const lockId = pendingLocks.shift()!;
            if (rng() < 0.75) {
              const fin = await ledger.finalizeWithdrawal({
                idempotencyKey: `fuzz-wdfin-${step}`,
                lockBatchId: lockId,
                txHash: `0xfuzztx_${step}`,
                nowIso: matureIso,
              });
              expectedSettledWithdrawals += fin.batch.grossCommissionUnits;
            } else {
              await ledger.revertWithdrawal({
                idempotencyKey: `fuzz-wdrev-${step}`,
                lockBatchId: lockId,
                reason: 'Fuzz simulated nonce timeout',
                nowIso: matureIso,
              });
            }
          } else {
            const traderId = traders[Math.floor(rng() * traders.length)];
            const acct = await ledger.getAccountByOwner('trader', traderId);
            const minWd = parseUsdToLedgerUnits('10.00');
            if (acct && acct.settledBalanceUnits >= minWd) {
              const fracBps = BigInt(Math.floor(rng() * 5000) + 2500);
              let wdUnits = (acct.settledBalanceUnits * fracBps) / BigInt(10000);
              if (wdUnits < minWd) {
                wdUnits = minWd;
              }
              const lockRes = await ledger.lockSettledForWithdrawal({
                idempotencyKey: `fuzz-wdlock-${step}`,
                ownerType: 'trader',
                ownerId: traderId,
                amountUnits: wdUnits,
                payoutId: `fuzz_po_${step}`,
                nowIso: matureIso,
              });
              pendingLocks.push(lockRes.batch.id);
            }
          }
        }
      }

      expect(replayCount).toBeGreaterThan(100);
      expect(clawback100PctCount).toBeGreaterThan(50);

      const report = await verifyLedgerInvariants(db, BI_ZERO);
      expect(report.valid).toBe(true);
      expect(report.emergencyFreezeTriggered).toBe(false);
      expect(report.totalDebitUnits).toBe(report.totalCreditUnits);
      expect(report.unbalancedBatchIds).toHaveLength(0);
      expect(report.negativeUserAccountCodes).toHaveLength(0);
      expect(report.accountPostingDriftCodes).toHaveLength(0);

      // Verify exact Opening + Verified - Reversals - Settled === Closing with 0 unit error
      expect(report.periodEquation.verifiedUnits).toBe(expectedVerified);
      expect(report.periodEquation.reversalUnits).toBe(expectedReversals);
      expect(report.periodEquation.settledWithdrawalUnits).toBe(expectedSettledWithdrawals);
      expect(report.periodEquation.driftUnits).toBe(BI_ZERO);
      expect(report.periodEquation.actualClosingUnits).toBe(
        expectedVerified - expectedReversals - expectedSettledWithdrawals
      );
    } finally {
      await db.close();
    }
  }, 60_000);
});
