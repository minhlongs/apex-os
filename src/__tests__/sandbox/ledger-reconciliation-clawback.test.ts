/**
 * @jest-environment node
 *
 * Cumulative Clawback Cap & Atomic Concurrency Guard
 *
 * Verifies `DoubleEntryLedgerService.applyClawback`:
 *  - accepts sequential partial clawbacks whose running total is <= original gross
 *  - transitions the original batch to `VOIDED` when the cumulative total reaches 100%
 *    on both the `INFLIGHT` and `SETTLED` paths
 *  - rejects a clawback that would push the cumulative total past the original gross
 *    WITHOUT writing any journal entries or mutating the original batch
 *  - commits at most ONE of two concurrent clawbacks submitted against the same batch
 *    with an identical `nowIso` (so `updated_at` alone cannot arbitrate the race)
 */

import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  BI_ZERO,
  DoubleEntryLedgerService,
  IdempotencyConflictError,
  InMemoryR2Bucket,
  LedgerStateTransitionError,
  LedgerUnitValidationError,
  SqliteD1Adapter,
  computeSafeSpreadWaterfall,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  verifyLedgerInvariants,
  type CommissionBatchMetadata,
} from '@/lib/ledger';

const PERIOD_START = '2026-11-01T00:00:00.000Z';
const PERIOD_END = '2026-11-07T23:59:59.000Z';
const MINT_CREATED_AT = '2026-11-01T00:00:00.000Z';
const SETTLE_ISO = '2026-11-09T00:00:00.000Z';

interface LedgerSandbox {
  db: SqliteD1Adapter;
  sqlite: Database.Database;
  r2: InMemoryR2Bucket;
  ledger: DoubleEntryLedgerService;
  reconciliationId: string;
  evidenceId: string;
}

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

/**
 * Boots a MATCHED partner reconciliation sized to `allocatedUsd`, so any minted
 * batch draws down a real CASH_COLLECTED cap rather than a bypass path.
 */
async function openLedgerSandbox(allocatedUsd: string): Promise<LedgerSandbox> {
  const { sqlite, db } = createMigratedSandboxDb();
  const r2 = new InMemoryR2Bucket();
  const ledger = new DoubleEntryLedgerService(db);

  const uidEvidence = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'rest_poll',
    rawBytes: JSON.stringify({ uidTotal: allocatedUsd }),
    statementPeriodStart: PERIOD_START,
    statementPeriodEnd: PERIOD_END,
  });
  const walletEvidence = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'wallet_statement',
    rawBytes: JSON.stringify({ walletTotal: allocatedUsd }),
    statementPeriodStart: PERIOD_START,
    statementPeriodEnd: PERIOD_END,
  });

  const reconciliation = await reconcilePartnerCashBatch(db, {
    exchange: 'bybit',
    evidenceId: uidEvidence.id,
    walletEvidenceId: walletEvidence.id,
    uidAllocatedUnits: parseUsdToLedgerUnits(allocatedUsd),
    walletCashCollectedUnits: parseUsdToLedgerUnits(allocatedUsd),
    r2,
  });
  expect(reconciliation.status).toBe('MATCHED');

  return {
    db,
    sqlite,
    r2,
    ledger,
    reconciliationId: reconciliation.id,
    evidenceId: uidEvidence.id,
  };
}

async function countClawbackBatches(
  sandbox: LedgerSandbox,
  originalBatchId: string
): Promise<number> {
  const res = await sandbox.db
    .prepare(
      `SELECT id
       FROM ledger_journal_batches
       WHERE journal_type IN ('COMMISSION_VOID_CLAWBACK', 'POST_SETTLEMENT_CLAWBACK')
         AND json_extract(metadata, '$.originalBatchId') = ?`
    )
    .bind(originalBatchId)
    .all<{ id: string }>();
  return (res.results ?? []).length;
}

async function readBatchMetadata(
  sandbox: LedgerSandbox,
  batchId: string
): Promise<CommissionBatchMetadata> {
  const batch = await sandbox.ledger.getBatchById(batchId);
  expect(batch).not.toBeNull();
  return batch!.metadata as unknown as CommissionBatchMetadata;
}

describe('Cumulative clawback cap and atomic concurrency guard', () => {
  it('accepts sequential partial clawbacks up to 100% and voids the batch only at exactly 100%', async () => {
    const sandbox = await openLedgerSandbox('100.00');
    const { ledger } = sandbox;

    try {
      const minted = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'seq-mint-a',
        exchange: 'bybit',
        traderUid: 'uid_seq_a',
        traderId: 'trader_seq_a',
        l1AffiliateId: 'aff_seq_a',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      const batchId = minted.batch.id;

      const first = await ledger.applyClawback({
        idempotencyKey: 'seq-claw-25',
        originalBatchId: batchId,
        clawbackUnits: parseUsdToLedgerUnits('25.00'),
        reason: 'Partial wash-trade adjustment',
        nowIso: '2026-11-03T00:00:00.000Z',
      });
      expect(first.mode).toBe('INFLIGHT_VOID');
      expect(first.isReplay).toBe(false);

      const afterFirst = await ledger.getBatchById(batchId);
      expect(afterFirst?.status).toBe('INFLIGHT');
      const firstMeta = await readBatchMetadata(sandbox, batchId);
      expect(firstMeta.remainingLegs.grossUnits).toBe(
        parseUsdToLedgerUnits('75.00').toString()
      );
      expect(firstMeta.clawedBackUnits).toBe(parseUsdToLedgerUnits('25.00').toString());

      const second = await ledger.applyClawback({
        idempotencyKey: 'seq-claw-75',
        originalBatchId: batchId,
        clawbackUnits: parseUsdToLedgerUnits('75.00'),
        reason: 'Remaining balance adjustment',
        nowIso: '2026-11-04T00:00:00.000Z',
      });
      expect(second.mode).toBe('INFLIGHT_VOID');

      const afterSecond = await ledger.getBatchById(batchId);
      expect(afterSecond?.status).toBe('VOIDED');
      const secondMeta = await readBatchMetadata(sandbox, batchId);
      expect(secondMeta.remainingLegs.grossUnits).toBe(BI_ZERO.toString());
      expect(secondMeta.clawedBackUnits).toBe(
        parseUsdToLedgerUnits('100.00').toString()
      );

      // A third clawback on an already fully-clawed batch must be refused outright
      await expect(
        ledger.applyClawback({
          idempotencyKey: 'seq-claw-overflow',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('1.00'),
          reason: 'Should never be accepted',
          nowIso: '2026-11-05T00:00:00.000Z',
        })
      ).rejects.toBeInstanceOf(LedgerStateTransitionError);

      expect(await countClawbackBatches(sandbox, batchId)).toBe(2);

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.negativeUserAccountCodes).toHaveLength(0);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await sandbox.db.close();
    }
  });

  it('rejects a cumulative over-clawback (60% then 50%) without writing any journal entries', async () => {
    const sandbox = await openLedgerSandbox('100.00');
    const { ledger } = sandbox;

    try {
      const minted = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'cum-mint-a',
        exchange: 'bybit',
        traderUid: 'uid_cum_a',
        traderId: 'trader_cum_a',
        l1AffiliateId: 'aff_cum_a',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      const batchId = minted.batch.id;

      const first = await ledger.applyClawback({
        idempotencyKey: 'cum-claw-60',
        originalBatchId: batchId,
        clawbackUnits: parseUsdToLedgerUnits('60.00'),
        reason: 'First partial adjustment',
        nowIso: '2026-11-03T00:00:00.000Z',
      });
      expect(first.mode).toBe('INFLIGHT_VOID');

      const postingsBefore = await sandbox.db
        .prepare('SELECT id FROM ledger_postings WHERE batch_id = ?')
        .bind(first.clawbackBatch.id)
        .all<{ id: string }>();
      const postingCountBefore = (postingsBefore.results ?? []).length;
      const clawbackCountBefore = await countClawbackBatches(sandbox, batchId);
      expect(clawbackCountBefore).toBe(1);

      // 60% + 50% = 110% of gross -> cumulative cap rejection
      await expect(
        ledger.applyClawback({
          idempotencyKey: 'cum-claw-50',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('50.00'),
          reason: 'Second partial adjustment exceeding gross',
          nowIso: '2026-11-04T00:00:00.000Z',
        })
      ).rejects.toBeInstanceOf(LedgerUnitValidationError);

      // Zero extra journal entries, zero extra postings, original batch untouched
      expect(await countClawbackBatches(sandbox, batchId)).toBe(clawbackCountBefore);

      const postingsAfter = await sandbox.db
        .prepare('SELECT id FROM ledger_postings WHERE batch_id = ?')
        .bind(first.clawbackBatch.id)
        .all<{ id: string }>();
      expect((postingsAfter.results ?? []).length).toBe(postingCountBefore);

      const originalAfter = await ledger.getBatchById(batchId);
      expect(originalAfter?.status).toBe('INFLIGHT');
      const metaAfter = await readBatchMetadata(sandbox, batchId);
      expect(metaAfter.clawedBackUnits).toBe(parseUsdToLedgerUnits('60.00').toString());
      expect(metaAfter.remainingLegs.grossUnits).toBe(
        parseUsdToLedgerUnits('40.00').toString()
      );

      // The remaining 40% is still clawbackable and lands exactly on the cap
      const final = await ledger.applyClawback({
        idempotencyKey: 'cum-claw-40',
        originalBatchId: batchId,
        clawbackUnits: parseUsdToLedgerUnits('40.00'),
        reason: 'Remaining partial adjustment',
        nowIso: '2026-11-05T00:00:00.000Z',
      });
      expect(final.mode).toBe('INFLIGHT_VOID');

      const settledOriginal = await ledger.getBatchById(batchId);
      expect(settledOriginal?.status).toBe('VOIDED');
      expect(await countClawbackBatches(sandbox, batchId)).toBe(2);

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await sandbox.db.close();
    }
  });

  it('voids the original batch at 100% cumulative clawback on the post-settlement path', async () => {
    const sandbox = await openLedgerSandbox('100.00');
    const { ledger } = sandbox;

    try {
      const minted = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'settled-mint-a',
        exchange: 'bybit',
        traderUid: 'uid_settled_a',
        traderId: 'trader_settled_a',
        l1AffiliateId: 'aff_settled_a',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      const batchId = minted.batch.id;

      await ledger.releaseMaturedInflightBatch(batchId, SETTLE_ISO);
      expect((await ledger.getBatchById(batchId))?.status).toBe('SETTLED');

      const clawback = await ledger.applyClawback({
        idempotencyKey: 'settled-claw-full',
        originalBatchId: batchId,
        clawbackUnits: parseUsdToLedgerUnits('100.00'),
        reason: 'Full post-settlement reversal',
        nowIso: '2026-11-13T00:00:00.000Z',
      });
      expect(clawback.mode).toBe('POST_SETTLEMENT_RESERVE');

      const after = await ledger.getBatchById(batchId);
      expect(after?.status).toBe('VOIDED');
      const meta = await readBatchMetadata(sandbox, batchId);
      expect(meta.remainingLegs.grossUnits).toBe(BI_ZERO.toString());
      expect(meta.clawedBackUnits).toBe(parseUsdToLedgerUnits('100.00').toString());

      // No further clawback may be layered onto a voided batch
      await expect(
        ledger.applyClawback({
          idempotencyKey: 'settled-claw-again',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('1.00'),
          reason: 'Should never be accepted',
          nowIso: '2026-11-14T00:00:00.000Z',
        })
      ).rejects.toBeInstanceOf(LedgerStateTransitionError);

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.negativeUserAccountCodes).toHaveLength(0);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await sandbox.db.close();
    }
  });

  it('commits at most one of two concurrent full clawbacks sharing the same nowIso', async () => {
    const sandbox = await openLedgerSandbox('100.00');
    const { ledger } = sandbox;

    try {
      const minted = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'race-mint-a',
        exchange: 'bybit',
        traderUid: 'uid_race_a',
        traderId: 'trader_race_a',
        l1AffiliateId: 'aff_race_a',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      const batchId = minted.batch.id;

      // Identical `nowIso` for both writers: `updated_at` cannot arbitrate the race,
      // so only the metadata + cumulative-sum guard inside the batch may decide it.
      const sharedNowIso = '2026-11-03T00:00:00.000Z';
      const raceOutcomes = await Promise.allSettled([
        ledger.applyClawback({
          idempotencyKey: 'race-claw-alpha',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('100.00'),
          reason: 'Concurrent full clawback alpha',
          nowIso: sharedNowIso,
        }),
        ledger.applyClawback({
          idempotencyKey: 'race-claw-beta',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('100.00'),
          reason: 'Concurrent full clawback beta',
          nowIso: sharedNowIso,
        }),
      ]);

      const fulfilled = raceOutcomes.filter((o) => o.status === 'fulfilled');
      const rejected = raceOutcomes.filter((o) => o.status === 'rejected');
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const rejection = rejected[0] as PromiseRejectedResult;
      expect(rejection.reason).toBeInstanceOf(LedgerStateTransitionError);

      // Exactly one clawback journal entry exists for the batch
      expect(await countClawbackBatches(sandbox, batchId)).toBe(1);

      const original = await ledger.getBatchById(batchId);
      expect(original?.status).toBe('VOIDED');
      const meta = await readBatchMetadata(sandbox, batchId);
      expect(meta.clawedBackUnits).toBe(parseUsdToLedgerUnits('100.00').toString());
      expect(meta.remainingLegs.grossUnits).toBe(BI_ZERO.toString());

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.negativeUserAccountCodes).toHaveLength(0);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await sandbox.db.close();
    }
  });

  it('keeps the batch clawbackable after a rejected concurrent pair (full + partial)', async () => {
    const sandbox = await openLedgerSandbox('100.00');
    const { ledger } = sandbox;

    try {
      const minted = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'race2-mint-a',
        exchange: 'bybit',
        traderUid: 'uid_race2_a',
        traderId: 'trader_race2_a',
        l1AffiliateId: 'aff_race2_a',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: parseUsdToLedgerUnits('100.00'),
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      const batchId = minted.batch.id;

      const sharedNowIso = '2026-11-03T00:00:00.000Z';
      const raceOutcomes = await Promise.allSettled([
        ledger.applyClawback({
          idempotencyKey: 'race2-claw-full',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('100.00'),
          reason: 'Concurrent full clawback',
          nowIso: sharedNowIso,
        }),
        ledger.applyClawback({
          idempotencyKey: 'race2-claw-partial',
          originalBatchId: batchId,
          clawbackUnits: parseUsdToLedgerUnits('40.00'),
          reason: 'Concurrent partial clawback',
          nowIso: sharedNowIso,
        }),
      ]);

      const fulfilled = raceOutcomes.filter((o) => o.status === 'fulfilled');
      expect(fulfilled).toHaveLength(1);
      expect(await countClawbackBatches(sandbox, batchId)).toBe(1);

      const meta = await readBatchMetadata(sandbox, batchId);
      const clawedBack = BigInt(meta.clawedBackUnits);
      expect(clawedBack).toBeLessThanOrEqual(parseUsdToLedgerUnits('100.00'));
      expect(BigInt(meta.remainingLegs.grossUnits)).toBe(
        parseUsdToLedgerUnits('100.00') - clawedBack
      );

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await sandbox.db.close();
    }
  });

  it('preserves the waterfall split of a partial clawback so no user balance goes negative', async () => {
    const sandbox = await openLedgerSandbox('200.00');
    const { ledger } = sandbox;

    try {
      const grossUnits = parseUsdToLedgerUnits('120.00');
      const waterfall = computeSafeSpreadWaterfall(grossUnits, { hasL1Referrer: true });

      const minted = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'split-mint-a',
        exchange: 'bybit',
        traderUid: 'uid_split_a',
        traderId: 'trader_split_a',
        l1AffiliateId: 'aff_split_a',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: grossUnits,
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      const batchId = minted.batch.id;

      const traderBefore = await ledger.getAccountByOwner('trader', 'trader_split_a');
      expect(traderBefore?.inflightBalanceUnits).toBe(waterfall.traderCashbackUnits);

      const clawbackUnits = parseUsdToLedgerUnits('37.50');
      const result = await ledger.applyClawback({
        idempotencyKey: 'split-claw-partial',
        originalBatchId: batchId,
        clawbackUnits,
        reason: 'Proportional partial clawback',
        nowIso: '2026-11-04T00:00:00.000Z',
      });
      expect(result.mode).toBe('INFLIGHT_VOID');

      // Every leg only shrinks; the reduced legs still sum to the remaining gross
      const meta = await readBatchMetadata(sandbox, batchId);
      const rem = meta.remainingLegs;
      const legSum =
        BigInt(rem.reserveUnits) +
        BigInt(rem.traderCashbackUnits) +
        BigInt(rem.l1CommissionUnits) +
        BigInt(rem.l2CommissionUnits) +
        BigInt(rem.platformNetUnits);
      expect(legSum).toBe(BigInt(rem.grossUnits));
      expect(BigInt(rem.grossUnits)).toBe(grossUnits - clawbackUnits);

      const traderAfter = await ledger.getAccountByOwner('trader', 'trader_split_a');
      expect(traderAfter).not.toBeNull();
      expect(traderAfter!.inflightBalanceUnits).toBe(BigInt(rem.traderCashbackUnits));
      expect(traderAfter!.inflightBalanceUnits < waterfall.traderCashbackUnits).toBe(true);
      expect(traderAfter!.inflightBalanceUnits >= BI_ZERO).toBe(true);

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.negativeUserAccountCodes).toHaveLength(0);
    } finally {
      await sandbox.db.close();
    }
  });

  it('treats commission inflight replay with a new reconciliationId and evidenceId as idempotent while rejecting grossCommissionUnits mutations', async () => {
    const sandbox = await openLedgerSandbox('100.00');
    const { ledger } = sandbox;

    try {
      const grossUnits = parseUsdToLedgerUnits('50.00');
      const initialMint = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'ingest:bybit:overlap_trade_1',
        exchange: 'bybit',
        traderUid: 'uid_overlap_1',
        traderId: 'trader_overlap_1',
        l1AffiliateId: 'aff_overlap_1',
        reconciliationId: sandbox.reconciliationId,
        evidenceId: sandbox.evidenceId,
        grossCommissionUnits: grossUnits,
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      expect(initialMint.isReplay).toBe(false);

      const secondEvidence = await storeEvidenceObject(sandbox.db, sandbox.r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: JSON.stringify({
          window: 'day2-overlap',
          trades: ['overlap_trade_1', 'overlap_trade_2'],
        }),
        statementPeriodStart: PERIOD_START,
        statementPeriodEnd: PERIOD_END,
      });
      const secondWalletEvidence = await storeEvidenceObject(sandbox.db, sandbox.r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: JSON.stringify({ exchange: 'bybit', walletCashUsd: '50.00' }),
        statementPeriodStart: PERIOD_START,
        statementPeriodEnd: PERIOD_END,
      });
      const secondRecon = await reconcilePartnerCashBatch(sandbox.db, {
        exchange: 'bybit',
        evidenceId: secondEvidence.id,
        walletEvidenceId: secondWalletEvidence.id,
        uidAllocatedUnits: grossUnits,
        walletCashCollectedUnits: grossUnits,
        r2: sandbox.r2,
      });
      expect(secondRecon.status).toBe('MATCHED');

      const replayMint = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'ingest:bybit:overlap_trade_1',
        exchange: 'bybit',
        traderUid: 'uid_overlap_1',
        traderId: 'trader_overlap_1',
        l1AffiliateId: 'aff_overlap_1',
        reconciliationId: secondRecon.id,
        evidenceId: secondEvidence.id,
        grossCommissionUnits: grossUnits,
        createdAt: MINT_CREATED_AT,
        r2: sandbox.r2,
      });
      expect(replayMint.isReplay).toBe(true);
      expect(replayMint.batch.id).toBe(initialMint.batch.id);

      await expect(
        ledger.recordVerifiedCommissionInflight({
          idempotencyKey: 'ingest:bybit:overlap_trade_1',
          exchange: 'bybit',
          traderUid: 'uid_overlap_1',
          traderId: 'trader_overlap_1',
          l1AffiliateId: 'aff_overlap_1',
          reconciliationId: secondRecon.id,
          evidenceId: secondEvidence.id,
          grossCommissionUnits: parseUsdToLedgerUnits('55.00'),
          createdAt: MINT_CREATED_AT,
          r2: sandbox.r2,
        })
      ).rejects.toBeInstanceOf(IdempotencyConflictError);

      const invariants = await verifyLedgerInvariants(sandbox.db);
      expect(invariants.valid).toBe(true);
      expect(invariants.periodEquation.driftUnits).toBe(BI_ZERO);
    } finally {
      await sandbox.db.close();
    }
  });
});
