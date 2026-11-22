import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
} from '@/lib/ledger';
import { BroadcastRecoveryMachine } from '@/lib/payouts/broadcast-recovery-machine';
import type { D1Database } from '@/lib/auth/types';

function createBetterSqliteD1(sqlite: Database.Database): D1Database {
  const wrap = (sql: string, bound: unknown[] = []) => ({
    bind: (...params: unknown[]) => wrap(sql, params),
    first: async <T = unknown>(colName?: string): Promise<T | null> => {
      const row = sqlite.prepare(sql).get(...bound) as Record<string, unknown> | undefined;
      if (!row) return null;
      if (colName) return (row[colName] as T) ?? null;
      return row as T;
    },
    run: async () => {
      const info = sqlite.prepare(sql).run(...bound);
      return {
        success: true,
        meta: {
          changes: info.changes,
          last_row_id: Number(info.lastInsertRowid),
        },
      };
    },
    all: async <T = unknown>() => {
      const rows = sqlite.prepare(sql).all(...bound) as T[];
      return { success: true, results: rows };
    },
    raw: async <T = unknown>() => {
      const rows = sqlite.prepare(sql).raw().all(...bound) as T[];
      return rows;
    },
    __sql: sql,
    __bound: bound,
  });

  return {
    prepare: (sql: string) => wrap(sql),
    batch: async (stmts: Array<{ __sql?: string; __bound?: unknown[] }>) => {
      try {
        const tx = sqlite.transaction(() =>
          stmts.map((s) => {
            const info = sqlite.prepare(s.__sql!).run(...(s.__bound ?? []));
            return {
              success: true,
              results: [],
              meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
            };
          })
        );
        return tx();
      } catch (err) {
        // Normalize native better-sqlite3 cross-realm Error into current Jest VM Error
        throw new Error(err instanceof Error || (typeof err === 'object' && err !== null && 'message' in err)
          ? String((err as { message: unknown }).message)
          : String(err));
      }
    },
    exec: async (sql: string) => {
      sqlite.exec(sql);
      return { count: 1, duration: 1 };
    },
  } as unknown as D1Database;
}

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src/database/migrations');

const BASE_TREASURY_MIGRATIONS = [
  '028_ascendancy_audit_core.sql',
  '031_ascendancy_phase2_ui_and_poller.sql',
  '032_persistent_d1_rate_limits.sql',
  '033_cold_settlement_claims.sql',
  '034_withdrawal_freeze_at_write.sql',
  '035_payout_effect_grants.sql',
  '036_durable_hot_exposure.sql',
];

function applyMigrations(sqlite: Database.Database, files: string[]): void {
  sqlite.pragma('foreign_keys = ON');
  for (const file of files) {
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    sqlite.exec(sql);
  }
}

function seedRuntimeFlags(sqlite: Database.Database): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO system_runtime_flags (flag_key, flag_value, updated_by, updated_at)
       VALUES ('EMERGENCY_LEDGER_FREEZE', 'false', 'test', datetime('now')),
              ('EMERGENCY_PAUSE', 'false', 'test', datetime('now'))`
    )
    .run();
}

async function seedUserWithSettledBalance(
  db: D1Database,
  ownerId: string,
  amountUnits: bigint
): Promise<DoubleEntryLedgerService> {
  const ledger = new DoubleEntryLedgerService(db);
  const r2 = new InMemoryR2Bucket();
  const grossUnits = (amountUnits * 5n) / 2n;
  const partnerEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'rest_poll',
    rawBytes: JSON.stringify({ ownerId, grossUnits: grossUnits.toString() }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const walletEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'wallet_statement',
    rawBytes: JSON.stringify({ ownerId, wallet: true }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const recon = await reconcilePartnerCashBatch(db, {
    exchange: 'bybit',
    evidenceId: partnerEv.id,
    walletEvidenceId: walletEv.id,
    uidAllocatedUnits: grossUnits,
    walletCashCollectedUnits: grossUnits,
    r2,
  });
  const inflight = await ledger.recordVerifiedCommissionInflight({
    idempotencyKey: `inf_${ownerId}`,
    exchange: 'bybit',
    traderUid: `uid_${ownerId}`,
    traderId: ownerId,
    l1AffiliateId: null,
    reconciliationId: recon.id,
    evidenceId: partnerEv.id,
    grossCommissionUnits: grossUnits,
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  await ledger.releaseMaturedInflightBatch(inflight.batch.id, '2026-11-15T00:00:00.000Z');
  return ledger;
}

describe('Migration 037 local drill: trigger identity & finality timestamp hardening', () => {
  it('1. Fresh database applies 028..037 cleanly and 037 is idempotent on re-run', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, [...BASE_TREASURY_MIGRATIONS, '037_hardening_trigger_and_exposure.sql']);
    // Re-applying 037 must succeed without error
    applyMigrations(sqlite, ['037_hardening_trigger_and_exposure.sql']);

    const triggers = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = triggers.map((t) => t.name);
    expect(names).toContain('trg_payout_effect_retain_withdrawal');
    expect(names).toContain('trg_withdrawal_require_terminal_proof');
    expect(names).toContain('trg_settlement_enforce_hot_finality_promotion');
    expect(names).toContain('trg_settlement_preserve_confirmed_finality');
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    sqlite.close();
  });

  it('2-6. Existing 001..036 database with pending, confirmed, unknown terminal, and historical NULL rows upgrades to 037 without altering historical rows', async () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, BASE_TREASURY_MIGRATIONS);
    seedRuntimeFlags(sqlite);
    const db = createBetterSqliteD1(sqlite);

    const ledger = await seedUserWithSettledBalance(db, 'trader_mig', 20_000_000_000n); // $200 gross -> $140 settled
    const lockPending = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_pending',
      ownerType: 'trader',
      ownerId: 'trader_mig',
      amountUnits: 2_000_000_000n,
      payoutId: 'payout_pending',
    });
    const lockUnknown = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_unknown',
      ownerType: 'trader',
      ownerId: 'trader_mig',
      amountUnits: 2_000_000_000n,
      payoutId: 'payout_unknown',
    });
    const lockLegacyNull = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_legacy_null',
      ownerType: 'trader',
      ownerId: 'trader_mig',
      amountUnits: 2_000_000_000n,
      payoutId: 'payout_legacy_null',
    });

    // Seed pre-037 historical rows:
    // (a) Pending broadcast
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state, tx_hash, signing_lane)
         VALUES ('payout_pending', 'ik_pending', 'trader_mig', ?, 'stellar', 'GABC', 2000000000, '200000000', 7, 'BROADCAST_PENDING', 'tx_pending', 'HOT')`
      )
      .run(lockPending.batch.id);

    // (b) Confirmed UNVERIFIED_HOT with stale/backdated timestamp (>48h old)
    const staleTs = Math.floor(Date.now() / 1000) - 200_000;
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state, tx_hash, signing_lane, confirmation_lane, confirmation_observed_at)
         VALUES ('payout_confirmed_unverified', 'ik_conf_unv', 'trader_mig', NULL, 'stellar', 'GABC', 1500000000, '150000000', 7, 'CONFIRMED', 'tx_conf_1', 'HOT', 'UNVERIFIED_HOT', ?)`
      )
      .run(staleTs);

    // (c) Unknown terminal state (FAILED_ABORTED without verified exposure release proof)
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state, tx_hash)
         VALUES ('payout_unknown', 'ik_unknown', 'trader_mig', ?, 'stellar', 'GABC', 2000000000, '200000000', 7, 'FAILED_ABORTED', 'tx_unknown')`
      )
      .run(lockUnknown.batch.id);

    // (d) Historical NULL fields (signing_lane, confirmation_lane, confirmation_observed_at, lock_batch_id all NULL)
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state)
         VALUES ('payout_legacy_null', 'ik_legacy_null', 'trader_mig', NULL, 'stellar', 'GABC', 2000000000, '200000000', 7, 'BROADCAST_PENDING')`
      )
      .run();

    const beforeRows = sqlite
      .prepare('SELECT payout_id, state, signing_lane, confirmation_lane, confirmation_observed_at FROM settlement_broadcasts ORDER BY payout_id')
      .all();

    // Apply Migration 037 on populated DB
    applyMigrations(sqlite, ['037_hardening_trigger_and_exposure.sql']);

    // Historical rows must be 100% untouched
    const afterRows = sqlite
      .prepare('SELECT payout_id, state, signing_lane, confirmation_lane, confirmation_observed_at FROM settlement_broadcasts ORDER BY payout_id')
      .all();
    expect(afterRows).toEqual(beforeRows);

    // Pending transaction reversal MUST be blocked
    await expect(
      ledger.revertWithdrawal({
        idempotencyKey: 'rev_pending',
        lockBatchId: lockPending.batch.id,
        reason: 'attempt_revert_pending',
      })
    ).rejects.toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Unknown terminal state reversal MUST be blocked
    await expect(
      ledger.revertWithdrawal({
        idempotencyKey: 'rev_unknown',
        lockBatchId: lockUnknown.batch.id,
        reason: 'attempt_revert_unknown',
      })
    ).rejects.toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Historical NULL lock_batch_id matched via payout_id MUST also be blocked
    await expect(
      ledger.revertWithdrawal({
        idempotencyKey: 'rev_legacy_null',
        lockBatchId: lockLegacyNull.batch.id,
        reason: 'attempt_revert_legacy_null',
      })
    ).rejects.toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Direct SQL attempt to promote UNVERIFIED_HOT -> HOT with stale timestamp MUST abort
    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts
           SET confirmation_lane = 'HOT', confirmation_observed_at = ?
           WHERE payout_id = 'payout_confirmed_unverified'`
        )
        .run(staleTs)
    ).toThrow(/UNVERIFIED_HOT to HOT promotion requires fresh verified finality timestamp/);

    // Direct SQL attempt to promote UNVERIFIED_HOT -> HOT with future timestamp MUST abort
    const futureTs = Math.floor(Date.now() / 1000) + 3600;
    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts
           SET confirmation_lane = 'HOT', confirmation_observed_at = ?
           WHERE payout_id = 'payout_confirmed_unverified'`
        )
        .run(futureTs)
    ).toThrow(/UNVERIFIED_HOT to HOT promotion requires fresh verified finality timestamp/);

    // BroadcastRecoveryMachine.promoteUnverifiedHotConfirmation stamps fresh unixepoch('now')
    const machine = new BroadcastRecoveryMachine({
      db,
      turnkeySigner: {} as never,
      evmAdapters: {},
      stellarTransport: {
        lookupTransaction: async () => ({ found: true, successful: true, ledger: 500000 }),
        submitSignedTransaction: async () => {
          throw new Error('not used');
        },
        buildUnsignedUsdcPayment: async () => {
          throw new Error('not used');
        },
        getAccountSequence: async () => 1n,
        verifyTrustline: async () => true,
      },
    });
    const promoted = await machine.promoteUnverifiedHotConfirmation('payout_confirmed_unverified');
    expect(promoted).toBe(true);

    const promotedRow = sqlite
      .prepare('SELECT confirmation_lane, confirmation_observed_at FROM settlement_broadcasts WHERE payout_id = ?')
      .get('payout_confirmed_unverified') as { confirmation_lane: string; confirmation_observed_at: number };
    expect(promotedRow.confirmation_lane).toBe('HOT');
    const nowEpoch = Math.floor(Date.now() / 1000);
    expect(promotedRow.confirmation_observed_at).toBeGreaterThanOrEqual(nowEpoch - 10);
    expect(promotedRow.confirmation_observed_at).toBeLessThanOrEqual(nowEpoch + 1);

    // After HOT promotion, confirmed lineage and timestamp are immutable
    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts
           SET confirmation_observed_at = ?
           WHERE payout_id = 'payout_confirmed_unverified'`
        )
        .run(staleTs)
    ).toThrow(/Confirmed settlement lineage and finalized HOT timestamp are immutable/);

    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts
           SET tx_hash = 'tampered_hash'
           WHERE payout_id = 'payout_confirmed_unverified'`
        )
        .run()
    ).toThrow(/Confirmed settlement lineage and finalized HOT timestamp are immutable/);

    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    sqlite.close();
  });

  it('7. Cross-payout identity binding: terminal proof for payout A cannot release payout B or mismatched amount', async () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, [...BASE_TREASURY_MIGRATIONS, '037_hardening_trigger_and_exposure.sql']);
    seedRuntimeFlags(sqlite);
    const db = createBetterSqliteD1(sqlite);

    const ledger = await seedUserWithSettledBalance(db, 'trader_cross', 20_000_000_000n);
    const lockA = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_A',
      ownerType: 'trader',
      ownerId: 'trader_cross',
      amountUnits: 2_000_000_000n,
      payoutId: 'payout_A',
    });
    const lockB = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_B',
      ownerType: 'trader',
      ownerId: 'trader_cross',
      amountUnits: 2_000_000_000n,
      payoutId: 'payout_B',
    });

    // Payout A has valid verified PRE_SUBMISSION_ABORT proof (no grants)
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state,
          exposure_release_kind, exposure_released_at, exposure_release_attempt_id)
         VALUES ('payout_A', 'ik_A', 'trader_cross', ?, 'stellar', 'GABC', 2000000000, '200000000', 7, 'FAILED_ABORTED',
                 'PRE_SUBMISSION_ABORT', unixepoch('now'), 'att_A')`
      )
      .run(lockA.batch.id);
    sqlite
      .prepare(
        `INSERT INTO payout_effect_attempts
         (attempt_id, payout_id, safety_epoch, active, lock_batch_id, owner_id, owner_type, chain)
         VALUES ('att_A', 'payout_A', 1, 0, ?, 'trader_cross', 'trader', 'stellar')`
      )
      .run(lockA.batch.id);

    // Payout B is still BROADCAST_PENDING (no terminal proof)
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state, tx_hash)
         VALUES ('payout_B', 'ik_B', 'trader_cross', ?, 'stellar', 'GABC', 2000000000, '200000000', 7, 'BROADCAST_PENDING', 'tx_B')`
      )
      .run(lockB.batch.id);

    // Forged WITHDRAWAL_REVERTED referencing lock B but claiming payout_A MUST abort
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO ledger_journal_batches
           (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, payout_id, metadata)
           VALUES ('forged_1', 'ik_forged_1', 'fp1', 'WITHDRAWAL_REVERTED', 'SETTLED', 2000000000, 'payout_A', ?)`
        )
        .run(JSON.stringify({ lockBatchId: lockB.batch.id, reason: 'cross_payout_attack' }))
    ).toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Forged WITHDRAWAL_REVERTED referencing lock A with wrong amount MUST abort
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO ledger_journal_batches
           (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, payout_id, metadata)
           VALUES ('forged_2', 'ik_forged_2', 'fp2', 'WITHDRAWAL_REVERTED', 'SETTLED', 1999999999, 'payout_A', ?)`
        )
        .run(JSON.stringify({ lockBatchId: lockA.batch.id, reason: 'wrong_amount' }))
    ).toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Forged WITHDRAWAL_REVERTED referencing lock A with payout_B MUST abort
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO ledger_journal_batches
           (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, payout_id, metadata)
           VALUES ('forged_3', 'ik_forged_3', 'fp3', 'WITHDRAWAL_REVERTED', 'SETTLED', 2000000000, 'payout_B', ?)`
        )
        .run(JSON.stringify({ lockBatchId: lockA.batch.id, reason: 'wrong_payout_id' }))
    ).toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Forged WITHDRAWAL_REVERTED omitting payout_id (NULL) when lock A has payout_id='payout_A' MUST abort
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO ledger_journal_batches
           (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, payout_id, metadata)
           VALUES ('forged_null_pid', 'ik_forged_null_pid', 'fp_null', 'WITHDRAWAL_REVERTED', 'SETTLED', 2000000000, NULL, ?)`
        )
        .run(JSON.stringify({ lockBatchId: lockA.batch.id, reason: 'null_payout_id_spoof' }))
    ).toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    // Direct SQL duplicate WITHDRAWAL_REVERTED against still-INFLIGHT lock A MUST abort at trigger boundary
    sqlite
      .prepare(
        `INSERT INTO ledger_journal_batches
         (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, payout_id, metadata)
         VALUES ('direct_rev_1', 'ik_direct_rev_1', 'fp_dr1', 'WITHDRAWAL_REVERTED', 'SETTLED', 2000000000, 'payout_A', ?)`
      )
      .run(JSON.stringify({ lockBatchId: lockA.batch.id, reason: 'first_direct_rev' }));
    expect(() =>
      sqlite
        .prepare(
          `INSERT INTO ledger_journal_batches
           (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, payout_id, metadata)
           VALUES ('direct_rev_2', 'ik_direct_rev_2', 'fp_dr2', 'WITHDRAWAL_REVERTED', 'SETTLED', 2000000000, 'payout_A', ?)`
        )
        .run(JSON.stringify({ lockBatchId: lockA.batch.id, reason: 'duplicate_direct_rev' }))
    ).toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);
    // Clean up direct test row so normal ledger.revertWithdrawal can be verified below
    sqlite.prepare("DELETE FROM ledger_journal_batches WHERE id = 'direct_rev_1'").run();

    // Legitimate reversal of lock A (bound to payout_A with verified proof) SUCCEEDS
    const revA = await ledger.revertWithdrawal({
      idempotencyKey: 'rev_A_valid',
      lockBatchId: lockA.batch.id,
      reason: 'verified_pre_submission_abort',
    });
    expect(revA.batch.payoutId).toBe('payout_A');
    expect(revA.batch.grossCommissionUnits).toBe(2_000_000_000n);

    // Duplicate reversal of lock A (now VOIDED) MUST fail
    await expect(
      ledger.revertWithdrawal({
        idempotencyKey: 'rev_A_dup',
        lockBatchId: lockA.batch.id,
        reason: 'duplicate_revert',
      })
    ).rejects.toThrow(/already resolved/);

    // Payout B remains untouched and locked
    const lockBState = sqlite
      .prepare('SELECT status FROM ledger_journal_batches WHERE id = ?')
      .get(lockB.batch.id) as { status: string };
    expect(lockBState.status).toBe('INFLIGHT');

    sqlite.close();
  });

  it('11. Blocks SQLite NULL three-valued logic bypasses, UNVERIFIED_HOT->COLD fake release, and confirmed DELETE', () => {
    const sqlite = new Database(':memory:');
    applyMigrations(sqlite, [
      ...BASE_TREASURY_MIGRATIONS,
      '037_hardening_trigger_and_exposure.sql',
    ]);
    const now = Math.floor(Date.now() / 1000);

    // Seed CONFIRMED HOT row
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, chain, recipient_address, amount_units_1e8,
          chain_token_units, chain_decimals, state, tx_hash, confirmation_lane, confirmation_observed_at)
         VALUES ('p_hot_null', 'ik_hn', 'u1', 'stellar', 'GDEST', 25000000000, '2500000000', 7, 'CONFIRMED', 'tx_hn', 'HOT', ?)`
      )
      .run(now);

    // Attempt 1: HOT -> NULL bypass MUST abort (IS NOT 'HOT')
    expect(() =>
      sqlite
        .prepare("UPDATE settlement_broadcasts SET confirmation_lane = NULL WHERE payout_id = 'p_hot_null'")
        .run()
    ).toThrow(/Confirmed settlement lineage and finalized HOT timestamp are immutable/);

    // Attempt 2: DELETE confirmed row MUST abort
    expect(() =>
      sqlite.prepare("DELETE FROM settlement_broadcasts WHERE payout_id = 'p_hot_null'").run()
    ).toThrow(/Confirmed settlement broadcast rows cannot be deleted/);

    // Seed CONFIRMED UNVERIFIED_HOT row (no safe_multisig_tx_hash)
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, chain, recipient_address, amount_units_1e8,
          chain_token_units, chain_decimals, state, tx_hash, confirmation_lane, confirmation_observed_at)
         VALUES ('p_unv_bypass', 'ik_ub', 'u1', 'stellar', 'GDEST', 25000000000, '2500000000', 7, 'CONFIRMED', 'tx_ub', 'UNVERIFIED_HOT', ?)`
      )
      .run(now - 90_000);

    // Attempt 3: UNVERIFIED_HOT -> NULL MUST abort
    expect(() =>
      sqlite
        .prepare("UPDATE settlement_broadcasts SET confirmation_lane = NULL WHERE payout_id = 'p_unv_bypass'")
        .run()
    ).toThrow(/Confirmed settlement lineage and finalized HOT timestamp are immutable/);

    // Attempt 4: UNVERIFIED_HOT -> COLD without Safe multisig proof MUST abort
    expect(() =>
      sqlite
        .prepare("UPDATE settlement_broadcasts SET confirmation_lane = 'COLD' WHERE payout_id = 'p_unv_bypass'")
        .run()
    ).toThrow();

    sqlite.close();
  });

  it('8-10. Foreign keys, atomic rollback on trigger failure, and file-based backup/restore rehearsal', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-mig-037-'));
    const dbPath = path.join(tmpDir, 'test.sqlite');
    const backupPath = path.join(tmpDir, 'test.pre037.bak');

    try {
      const sqlite = new Database(dbPath);
      applyMigrations(sqlite, BASE_TREASURY_MIGRATIONS);
      seedRuntimeFlags(sqlite);

      sqlite
        .prepare(
          `INSERT INTO settlement_broadcasts
           (payout_id, idempotency_key, affiliate_id, chain, recipient_address, amount_units_1e8, chain_token_units, chain_decimals, state)
           VALUES ('p_snap', 'ik_snap', 'u1', 'stellar', 'GABC', 1000000000, '100000000', 7, 'BROADCAST_PENDING')`
        )
        .run();

      // Snapshot before applying 037
      sqlite.close();
      fs.copyFileSync(dbPath, backupPath);

      // Apply 037
      const migrated = new Database(dbPath);
      applyMigrations(migrated, ['037_hardening_trigger_and_exposure.sql']);

      // FK violation check: grant referencing nonexistent payout_id must fail
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO payout_effect_grants
             (grant_id, payout_id, attempt_id, effect_kind, payload_sha256, safety_epoch)
             VALUES ('g1', 'nonexistent_payout', 'nonexistent_attempt', 'STELLAR_SUBMIT', ?, 1)`
          )
          .run('a'.repeat(64))
      ).toThrow(/FOREIGN KEY constraint failed/);

      // Trigger failure inside explicit transaction rolls back cleanly
      expect(() => {
        migrated.transaction(() => {
          migrated
            .prepare(
              `INSERT INTO ledger_journal_batches
               (id, idempotency_key, payload_fingerprint, journal_type, status, gross_commission_units, metadata)
               VALUES ('bad_rev', 'ik_bad_rev', 'fp', 'WITHDRAWAL_REVERTED', 'SETTLED', 1000, '{}')`
            )
            .run();
        })();
      }).toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

      const countBad = migrated
        .prepare("SELECT COUNT(*) AS c FROM ledger_journal_batches WHERE id = 'bad_rev'")
        .get() as { c: number };
      expect(countBad.c).toBe(0);
      expect(migrated.pragma('foreign_key_check')).toEqual([]);
      migrated.close();

      // Restore pre-037 snapshot and verify original trigger state + row preservation
      fs.copyFileSync(backupPath, dbPath);
      const restored = new Database(dbPath);
      const has037Trigger = restored
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='trg_settlement_enforce_hot_finality_promotion'")
        .get();
      expect(has037Trigger).toBeUndefined();
      const row = restored
        .prepare("SELECT payout_id, state FROM settlement_broadcasts WHERE payout_id = 'p_snap'")
        .get() as { payout_id: string; state: string };
      expect(row).toEqual({ payout_id: 'p_snap', state: 'BROADCAST_PENDING' });

      // Re-apply 037 cleanly after restore
      applyMigrations(restored, ['037_hardening_trigger_and_exposure.sql']);
      expect(restored.pragma('foreign_key_check')).toEqual([]);
      restored.close();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
