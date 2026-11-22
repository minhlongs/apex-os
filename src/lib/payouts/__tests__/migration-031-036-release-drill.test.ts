/**
 * Migrations 031-036 Release Rehearsal Drill (Local Isolated SQLite / D1 Semantics)
 *
 * Tests:
 * 1. Fresh database application (028 baseline -> 031..036) + PRAGMA foreign_key_check.
 * 2. Snapshot-equivalent upgraded database with pre-existing pending withdrawals,
 *    confirmed settlements, ledger rows, and runtime flags.
 * 3. Duplicate cold settlement evidence claims rejected by PRIMARY KEY & UNIQUE constraints.
 * 4. Abnormal intermediate / partial migration failure behavior & backup/restore recovery.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import Database from 'better-sqlite3';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../../database/migrations');

const BASELINE_SQL = fs.readFileSync(
  path.join(MIGRATIONS_DIR, '028_ascendancy_audit_core.sql'),
  'utf8'
);

const RELEASE_MIGRATIONS = [
  '031_ascendancy_phase2_ui_and_poller.sql',
  '032_persistent_d1_rate_limits.sql',
  '033_cold_settlement_claims.sql',
  '034_withdrawal_freeze_at_write.sql',
  '035_payout_effect_grants.sql',
  '036_durable_hot_exposure.sql',
] as const;

function readMigration(filename: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

function sha256(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

describe('Migrations 031-036 release rehearsal drill', () => {
  it('computes deterministic SHA-256 checksums and applies cleanly to a fresh D1-compatible DB', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(BASELINE_SQL);

    const checksums: Record<string, string> = {};
    for (const file of RELEASE_MIGRATIONS) {
      const sql = readMigration(file);
      checksums[file] = sha256(sql);
      expect(checksums[file]).toMatch(/^[a-f0-9]{64}$/);
      db.exec(sql);
    }

    // Verify zero foreign key violations
    const fkErrors = db.pragma('foreign_key_check') as unknown[];
    expect(fkErrors).toHaveLength(0);

    // Verify expected core tables, views, and triggers exist
    const objects = db
      .prepare(
        `SELECT type, name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger')`
      )
      .all() as Array<{ type: string; name: string }>;

    const objectSet = new Set(objects.map((o) => `${o.type}:${o.name}`));
    expect(objectSet.has('table:trader_exchange_uids')).toBe(true);
    expect(objectSet.has('table:partner_shadow_reconciliations')).toBe(true);
    expect(objectSet.has('table:b2b_agency_contracts')).toBe(true);
    expect(objectSet.has('table:rate_limits')).toBe(true);
    expect(objectSet.has('table:cold_settlement_claims')).toBe(true);
    expect(objectSet.has('table:system_safety_epoch')).toBe(true);
    expect(objectSet.has('table:payout_effect_attempts')).toBe(true);
    expect(objectSet.has('table:payout_effect_grants')).toBe(true);
    expect(objectSet.has('view:settlement_verified_exposure_releases')).toBe(true);
    expect(objectSet.has('trigger:trg_withdrawal_journal_requires_unfrozen_ledger')).toBe(true);
    expect(objectSet.has('trigger:trg_payout_effect_publish_failed_receipt')).toBe(true);
    expect(objectSet.has('trigger:trg_withdrawal_require_terminal_proof')).toBe(true);

    db.close();
  });

  it('upgrades a snapshot-equivalent DB with historical rows while preserving fail-closed invariants', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(BASELINE_SQL);

    // Seed pre-existing runtime flags, ledger accounts, journal batches, and historical settlements
    db.exec(`
      INSERT OR REPLACE INTO system_runtime_flags (flag_key, flag_value, reason)
      VALUES ('EMERGENCY_LEDGER_FREEZE', 'false', 'pre-upgrade baseline');

      INSERT INTO ledger_accounts (id, owner_id, owner_type, account_code, currency, settled_balance_units, inflight_balance_units, allow_negative)
      VALUES
        ('acct-trader-1', 'trader-1', 'trader', 'TRADER:trader-1:USDC', 'USDC', 5000000000, 1500000000, 0),
        ('acct-treasury', 'treasury', 'treasury', 'TREASURY:HOT:USDC', 'USDC', 100000000000, 0, 1);

      INSERT INTO ledger_journal_batches (id, journal_type, idempotency_key, payload_fingerprint, gross_commission_units, payout_id, status, metadata)
      VALUES
        ('lock-legacy-pending', 'WITHDRAWAL_LOCK', 'idem-lock-pending', 'fp-pending', 0, 'payout-legacy-pending', 'INFLIGHT', '{}'),
        ('lock-legacy-confirmed', 'WITHDRAWAL_LOCK', 'idem-lock-confirmed', 'fp-confirmed', 0, 'payout-legacy-confirmed', 'SETTLED', '{}');

      INSERT INTO ledger_postings (id, batch_id, account_id, direction, amount_units, leg_role)
      VALUES
        ('post-1', 'lock-legacy-pending', 'acct-trader-1', 'DEBIT', 1500000000, 'WITHDRAWAL_LOCK_DEBIT'),
        ('post-2', 'lock-legacy-pending', 'acct-treasury', 'CREDIT', 1500000000, 'WITHDRAWAL_LOCK_CREDIT');

      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, lock_batch_id, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state, tx_hash, created_at, updated_at
      ) VALUES
        ('payout-legacy-pending', 'idem-sb-pending', 'lock-legacy-pending', 'trader-1', 'stellar', 'GLEGACY1', 1500000000, '150000000', 7, 'BROADCAST_PENDING', 'tx-legacy-pending', datetime('now', '-48 hours'), datetime('now', '-48 hours')),
        ('payout-legacy-confirmed', 'idem-sb-confirmed', 'lock-legacy-confirmed', 'trader-1', 'arbitrum', '0x1111111111111111111111111111111111111111', 2000000000, '20000000', 6, 'CONFIRMED', '0xlegacyconfirmed', datetime('now', '-72 hours'), datetime('now', '-72 hours'));
    `);

    // Take exact pre-upgrade snapshot backup
    const preUpgradeBackup = db.serialize();

    // Apply migrations 031-036 sequentially
    for (const file of RELEASE_MIGRATIONS) {
      db.exec(readMigration(file));
    }

    expect(db.pragma('foreign_key_check') as unknown[]).toHaveLength(0);

    // Verify historical rows are intact and unbackfilled (fail-closed: confirmation_lane IS NULL)
    const legacyRows = db
      .prepare(
        `SELECT payout_id, state, signing_lane, confirmation_lane, exposure_release_kind
         FROM settlement_broadcasts ORDER BY payout_id`
      )
      .all() as Array<{
      payout_id: string;
      state: string;
      signing_lane: string | null;
      confirmation_lane: string | null;
      exposure_release_kind: string | null;
    }>;

    expect(legacyRows).toEqual([
      {
        payout_id: 'payout-legacy-confirmed',
        state: 'CONFIRMED',
        signing_lane: null,
        confirmation_lane: null,
        exposure_release_kind: null,
      },
      {
        payout_id: 'payout-legacy-pending',
        state: 'BROADCAST_PENDING',
        signing_lane: null,
        confirmation_lane: null,
        exposure_release_kind: null,
      },
    ]);

    // Verify 036 trigger blocks unproven WITHDRAWAL_REVERTED on historical pending payout
    expect(() => {
      db.prepare(
        `INSERT INTO ledger_journal_batches (id, journal_type, idempotency_key, payload_fingerprint, gross_commission_units, payout_id, status, metadata)
         VALUES ('rev-unproven', 'WITHDRAWAL_REVERTED', 'idem-rev-1', 'fp-rev-1', 0, 'payout-legacy-pending', 'SETTLED', ?)`
      ).run(JSON.stringify({ lockBatchId: 'lock-legacy-pending' }));
    }).toThrow(/Withdrawal refund requires exact durable terminal proof/);

    // Verify 034 trigger blocks withdrawal lock when EMERGENCY_LEDGER_FREEZE is enabled
    db.prepare(
      `UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'`
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO ledger_journal_batches (id, journal_type, idempotency_key, payload_fingerprint, gross_commission_units, payout_id, status, metadata)
         VALUES ('lock-while-frozen', 'WITHDRAWAL_LOCK', 'idem-lock-frozen', 'fp-frozen', 0, 'payout-frozen', 'INFLIGHT', '{}')`
      ).run();
    }).toThrow(/Withdrawal ledger mutation denied by emergency freeze control/);

    // Verify 035 safety epoch incremented automatically on flag update
    const epochRow = db
      .prepare(`SELECT epoch FROM system_safety_epoch WHERE singleton = 1`)
      .get() as { epoch: number };
    expect(epochRow.epoch).toBeGreaterThanOrEqual(2);

    // Verify 033 cold_settlement_claims rejects duplicate (network, tx_hash, operation_id)
    db.prepare(
      `INSERT INTO cold_settlement_claims (
         network, tx_hash, operation_id, payout_id, lock_batch_id, chain,
         block_reference, source_address, recipient_address, asset, amount_token_units
       ) VALUES (
         'arbitrum-mainnet', '0xabc', 'log:7', 'payout-legacy-confirmed', 'lock-legacy-confirmed',
         'arbitrum', '123456', '0xSafe', '0x1111111111111111111111111111111111111111',
         '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '20000000'
       )`
    ).run();

    expect(() => {
      db.prepare(
        `INSERT INTO cold_settlement_claims (
           network, tx_hash, operation_id, payout_id, lock_batch_id, chain,
           block_reference, source_address, recipient_address, asset, amount_token_units
         ) VALUES (
           'arbitrum-mainnet', '0xabc', 'log:7', 'payout-legacy-pending', 'lock-legacy-pending',
           'arbitrum', '123456', '0xSafe', '0x1111111111111111111111111111111111111111',
           '0xaf88d065e77c8cC2239327C5EDb3A432268e5831', '15000000'
         )`
      ).run();
    }).toThrow(/UNIQUE constraint failed/);

    db.close();

    // Backup & Restore drill: restore pre-upgrade snapshot, verify pre-upgrade state, reapply cleanly
    const restored = new Database(preUpgradeBackup);
    restored.pragma('foreign_keys = ON');
    const restoredCount = restored
      .prepare(`SELECT COUNT(*) AS cnt FROM settlement_broadcasts`)
      .get() as { cnt: number };
    expect(restoredCount.cnt).toBe(2);

    for (const file of RELEASE_MIGRATIONS) {
      restored.exec(readMigration(file));
    }
    expect(restored.pragma('foreign_key_check') as unknown[]).toHaveLength(0);
    restored.close();
  });

  it('documents idempotency of 031-035 and fail-fast duplicate-column behavior on 036 re-application', () => {
    const db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    db.exec(BASELINE_SQL);

    // 031-035 are idempotent on re-run
    for (const file of RELEASE_MIGRATIONS.slice(0, 5)) {
      const sql = readMigration(file);
      db.exec(sql);
      db.exec(sql);
    }

    // 036 applies cleanly once; re-applying raw 036 fails fast on SQLite ALTER TABLE ADD COLUMN
    const sql036 = readMigration('036_durable_hot_exposure.sql');
    db.exec(sql036);
    expect(() => db.exec(sql036)).toThrow(/duplicate column name: signing_lane/);

    db.close();
  });
});
