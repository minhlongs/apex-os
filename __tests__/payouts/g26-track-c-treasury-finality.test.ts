/**
 * @jest-environment node
 *
 * G26 Track C — Treasury Finality & Secret Boundary Verification Suite
 *
 * Covers:
 * 1. Full 001–038 fresh install AND full 001–037 -> 038 upgrade with historical rows
 *    (including batched multi-op cold settlements sharing a tx_hash), SQLite backup/restore,
 *    idempotency, and trigger rollback verification on invalid writes.
 * 2. Comprehensive HOT/COLD/UNVERIFIED_HOT finality parity (INSERT & UPDATE), whitespace/tab/
 *    newline bypass blocking, NULL signing_lane blocking, pre-038 non-CONFIRMED COLD promotion,
 *    legitimate HOT->COLD escalation vs illegal lane switching, confirmed-row immutability,
 *    DELETE protection, and scoped unique evidence constraints.
 * 3. Stellar secret boundary: raw secretKey rejection with valid 56-char Ed25519 seed,
 *    STELLAR_SECRET_KEY env isolation, read-only Horizon operations, and fail-closed legacy
 *    path denial (before trustline RPC).
 * 4. Financial conservation, 10^-8 / 7-dec / 6-dec dust math, cold proof uniqueness,
 *    safety epoch invalidation, single/rolling caps, real end-to-end TurnkeyPolicyHardBlockError
 *    escalation & multi-op batched resolveColdSafeBroadcast under 038, and real 50-case
 *    concurrent BroadcastRecoveryMachine + DoubleEntryLedgerService recovery with 30% RPC failure.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
const nodeMod = (
  process as unknown as {
    getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire };
  }
).getBuiltinModule('node:module');
const StellarSdk = nodeMod.createRequire(__filename)('@stellar/stellar-sdk') as typeof StellarSdkTypes;

import {
  StellarService,
  StellarNetwork,
  createStellarService,
} from '@/lib/payouts/stellar-service';
import { StellarAdapter } from '@/lib/payouts/adapters/stellar-adapter';
import { LegacyPayoutPathDisabledError } from '@/lib/payouts/settlement-gate';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  reconcilePartnerCashBatch,
  splitChainSettlementAndDust,
  storeEvidenceObject,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8,
  HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8,
  TurnkeySigner,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import {
  BroadcastRecoveryMachine,
  type StellarBroadcastTransport,
} from '@/lib/payouts/broadcast-recovery-machine';
import type { D1Database } from '@/lib/auth/types';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src/database/migrations');

const FULL_MIGRATIONS_001_037 = [
  '001_initial_schema_d1.sql',
  '002_auth_tables.sql',
  '003_affiliate_schema.sql',
  '028_ascendancy_audit_core.sql',
  '031_ascendancy_phase2_ui_and_poller.sql',
  '032_persistent_d1_rate_limits.sql',
  '033_cold_settlement_claims.sql',
  '034_withdrawal_freeze_at_write.sql',
  '035_payout_effect_grants.sql',
  '036_durable_hot_exposure.sql',
  '037_hardening_trigger_and_exposure.sql',
];

function readMigration(filename: string): string {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8');
}

function createFullSchemaUpTo037(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  for (const filename of FULL_MIGRATIONS_001_037) {
    db.exec(readMigration(filename));
  }
  return db;
}

function createFullSchemaUpTo038(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = createFullSchemaUpTo037();
  sqlite.exec(readMigration('038_cold_finality_parity.sql'));
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO system_runtime_flags (flag_key, flag_value, updated_by, updated_at)
       VALUES ('EMERGENCY_LEDGER_FREEZE', 'false', 'test', datetime('now')),
              ('EMERGENCY_PAUSE', 'false', 'test', datetime('now'))`
    )
    .run();
  const db = new SqliteD1Adapter(sqlite) as unknown as D1Database;
  return { sqlite, db };
}

function nowUnix(): number {
  return Math.floor(Date.now() / 1000);
}

async function seedTraderBalance(
  db: D1Database,
  ledger: DoubleEntryLedgerService,
  traderId: string,
  targetSettledUnits: bigint
): Promise<bigint> {
  const r2 = new InMemoryR2Bucket();
  const grossUnits = (targetSettledUnits * 5n) / 2n; // 40% trader share
  const partnerEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'rest_poll',
    rawBytes: JSON.stringify({ traderId, grossUnits: grossUnits.toString() }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const walletEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'wallet_statement',
    rawBytes: JSON.stringify({ traderId, wallet: true }),
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
  const batch = await ledger.recordVerifiedCommissionInflight({
    idempotencyKey: `comm_${traderId}`,
    exchange: 'bybit',
    traderUid: `uid_${traderId}`,
    traderId,
    l1AffiliateId: null,
    reconciliationId: recon.id,
    evidenceId: partnerEv.id,
    grossCommissionUnits: grossUnits,
    createdAt: '2026-11-01T00:00:00.000Z',
  });
  await ledger.releaseMaturedInflightBatch(batch.batch.id, '2026-11-15T00:00:00.000Z');
  const acct = await ledger.getAccountByOwner('trader', traderId);
  return acct?.settledBalanceUnits ?? 0n;
}

describe('G26.C2 — Migration 038 Cold Finality Parity & Rehearsal', () => {
  it('installs cleanly on a fresh empty database through 001–038', () => {
    const { sqlite } = createFullSchemaUpTo038();

    const triggers = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='settlement_broadcasts'")
      .all() as Array<{ name: string }>;
    const indexes = sqlite
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='settlement_broadcasts'")
      .all() as Array<{ name: string }>;

    expect(triggers.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        'trg_settlement_enforce_hot_finality_promotion',
        'trg_settlement_preserve_confirmed_finality',
        'trg_settlement_enforce_insert_finality',
        'trg_settlement_prevent_confirmed_delete',
      ])
    );
    expect(indexes.map((i) => i.name)).toEqual(
      expect.arrayContaining([
        'idx_settlement_broadcasts_unique_tx_hash',
        'idx_settlement_broadcasts_unique_safe_tx_hash',
      ])
    );

    sqlite.close();
  });

  it('rehearses 001–037 -> 038 upgrade with historical rows (including batched multi-op cold rows), idempotency, and SQLite backup/restore', async () => {
    const db = createFullSchemaUpTo037();
    const ts = nowUnix();
    const sharedColdTxHash = 'c'.repeat(64);

    // Seed historical pre-038 rows: BROADCAST_PENDING, CONFIRMED HOT,
    // two batched multi-op CONFIRMED COLD rows sharing one tx_hash, and legacy NULL-lane row
    db.prepare(`
      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state,
        signing_lane, confirmation_lane, confirmation_observed_at, tx_hash,
        safe_multisig_tx_hash, lock_batch_id
      ) VALUES
        ('hist-pending', 'idem-hist-pending', 'aff-1', 'stellar', 'G_RECIP_1', 2000000000, '200000000', 7, 'BROADCAST_PENDING', 'HOT', NULL, NULL, NULL, NULL, 'lock-hist-1'),
        ('hist-hot', 'idem-hist-hot', 'aff-2', 'arbitrum', '0x1111111111111111111111111111111111111111', 5000000000, '50000000', 6, 'CONFIRMED', 'HOT', 'HOT', ?, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', NULL, 'lock-hist-2'),
        ('hist-cold-op1', 'idem-hist-cold-1', 'aff-3', 'stellar', 'G_RECIP_3', 50000000000, '5000000000', 7, 'CONFIRMED', 'COLD', 'COLD', ?, ?, 'safe_2of3_hist_op1', 'lock-hist-3'),
        ('hist-cold-op2', 'idem-hist-cold-2', 'aff-4', 'stellar', 'G_RECIP_4', 40000000000, '4000000000', 7, 'CONFIRMED', 'COLD', 'COLD', ?, ?, 'safe_2of3_hist_op2', 'lock-hist-4'),
        ('hist-legacy-null', 'idem-hist-null', 'aff-5', 'stellar', 'G_RECIP_5', 1500000000, '150000000', 7, 'QUEUED_COLD_SAFE', NULL, NULL, NULL, NULL, NULL, NULL)
    `).run(ts - 10, ts - 10, sharedColdTxHash, ts - 10, sharedColdTxHash);

    // Apply migration 038 (must succeed even with batched multi-op cold rows sharing tx_hash)
    const sql038 = readMigration('038_cold_finality_parity.sql');
    db.exec(sql038);

    // Re-applying migration 038 must be completely idempotent
    expect(() => db.exec(sql038)).not.toThrow();

    // Historical rows remain intact
    const count = db.prepare('SELECT COUNT(*) AS c FROM settlement_broadcasts').get() as { c: number };
    expect(count.c).toBe(5);

    // Backup & restore verification
    const tmpFile = path.join(os.tmpdir(), `apex-os-mig038-rehearsal-${Date.now()}.sqlite`);
    try {
      await db.backup(tmpFile);
      const restored = new Database(tmpFile, { readonly: true });
      const restoredCount = restored.prepare('SELECT COUNT(*) AS c FROM settlement_broadcasts').get() as { c: number };
      const triggers = restored
        .prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND tbl_name='settlement_broadcasts'")
        .all() as Array<{ name: string }>;
      expect(restoredCount.c).toBe(5);
      expect(triggers.map((t) => t.name)).toEqual(
        expect.arrayContaining([
          'trg_settlement_enforce_hot_finality_promotion',
          'trg_settlement_preserve_confirmed_finality',
          'trg_settlement_enforce_insert_finality',
          'trg_settlement_prevent_confirmed_delete',
        ])
      );
      restored.close();
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }

    db.close();
  });

  it('allows legitimate transitions under 038: HOT->COLD escalation, exposure_released_at update, and multi-op batched COLD settlements', () => {
    const { sqlite: db } = createFullSchemaUpTo038();
    const ts = nowUnix();

    // 1. Legitimate pre-broadcast HOT -> COLD escalation (SIGNING/HOT -> QUEUED_COLD_SAFE/COLD)
    db.prepare(`
      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state,
        signing_lane, lock_batch_id
      ) VALUES (
        'esc-1', 'idem-esc-1', 'aff-esc', 'arbitrum', '0x3333333333333333333333333333333333333333',
        30000000000, '300000000', 6, 'SIGNING',
        'HOT', 'lock-esc-1'
      )
    `).run();

    expect(() =>
      db.prepare(`
        UPDATE settlement_broadcasts
        SET state = 'QUEUED_COLD_SAFE',
            signing_lane = 'COLD',
            safe_multisig_tx_hash = 'safe_2of3_esc_1'
        WHERE payout_id = 'esc-1'
      `).run()
    ).not.toThrow();

    // Promote esc-1 to CONFIRMED COLD
    const sharedBatchTx = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
    db.prepare(`
      UPDATE settlement_broadcasts
      SET state = 'CONFIRMED',
          confirmation_lane = 'COLD',
          confirmation_observed_at = ?,
          tx_hash = ?
      WHERE payout_id = 'esc-1'
    `).run(ts, sharedBatchTx);

    // 2. exposure_released_at update on CONFIRMED row must be allowed
    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET exposure_released_at = datetime('now') WHERE payout_id = 'esc-1'`).run()
    ).not.toThrow();

    // 3. Multi-op batched COLD settlements sharing one tx_hash with distinct safe_multisig_tx_hash
    //    and distinct operation_id in cold_settlement_claims must succeed
    db.prepare(`
      INSERT INTO ledger_journal_batches (id, idempotency_key, payload_fingerprint, journal_type, status, payout_id, gross_commission_units)
      VALUES ('lock-esc-1', 'idem-l-esc-1', 'fp-l-1', 'WITHDRAWAL_LOCK', 'INFLIGHT', 'esc-1', 30000000000),
             ('lock-esc-2', 'idem-l-esc-2', 'fp-l-2', 'WITHDRAWAL_LOCK', 'INFLIGHT', 'esc-2', 30000000000)
    `).run();

    db.prepare(`
      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state,
        signing_lane, confirmation_lane, confirmation_observed_at,
        tx_hash, safe_multisig_tx_hash, lock_batch_id
      ) VALUES (
        'esc-2', 'idem-esc-2', 'aff-esc-2', 'arbitrum', '0x4444444444444444444444444444444444444444',
        30000000000, '300000000', 6, 'CONFIRMED',
        'COLD', 'COLD', ?, ?, 'safe_2of3_esc_2', 'lock-esc-2'
      )
    `).run(ts, sharedBatchTx);

    const insertClaim = db.prepare(`
      INSERT INTO cold_settlement_claims (
        network, tx_hash, operation_id, payout_id, lock_batch_id, chain,
        block_reference, source_address, recipient_address, asset, amount_token_units
      ) VALUES ('arbitrum-one', ?, ?, ?, ?, 'arbitrum', '100', '0xtreasury', '0x3333333333333333333333333333333333333333', 'USDC', '300000000')
    `);
    expect(() => insertClaim.run(sharedBatchTx, '0', 'esc-1', 'lock-esc-1')).not.toThrow();
    expect(() => insertClaim.run(sharedBatchTx, '1', 'esc-2', 'lock-esc-2')).not.toThrow();

    db.close();
  });

  it('blocks comprehensive adversarial COLD/HOT/UNVERIFIED_HOT INSERTs, UPDATEs, whitespace bypasses, lane switching, mutations, DELETE, and duplicate HOT tx_hash', () => {
    const db = createFullSchemaUpTo037();
    const ts = nowUnix();

    // Seed a pre-038 anomalous row with confirmation_lane = 'COLD' and state != 'CONFIRMED' BEFORE applying 038
    db.prepare(`
      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state,
        signing_lane, confirmation_lane, safe_multisig_tx_hash, lock_batch_id
      ) VALUES (
        'pre038-cold-anom', 'idem-pre038-anom', 'aff-anom', 'arbitrum', '0x4444444444444444444444444444444444444444',
        30000000000, '300000000', 6, 'QUEUED_COLD_SAFE',
        'COLD', 'COLD', 'safe_pre038_anom', 'lock-pre038-anom'
      )
    `).run();

    db.exec(readMigration('038_cold_finality_parity.sql'));

    // Pre-038 non-CONFIRMED row with confirmation_lane = 'COLD' promoted to CONFIRMED with missing evidence must be blocked
    expect(() =>
      db.prepare(`
        UPDATE settlement_broadcasts
        SET state = 'CONFIRMED', confirmation_observed_at = ?
        WHERE payout_id = 'pre038-cold-anom'
      `).run(ts)
    ).toThrow(/Settlement finality promotion requires/);

    const insertRow = db.prepare(`
      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state,
        signing_lane, confirmation_lane, confirmation_observed_at,
        tx_hash, safe_multisig_tx_hash, lock_batch_id
      ) VALUES (?, ?, 'aff-adv', 'arbitrum', '0x4444444444444444444444444444444444444444',
        30000000000, '300000000', 6, ?, ?, ?, ?, ?, ?, ?)
    `);

    // --- Forged COLD INSERTs ---
    expect(() => insertRow.run('adv-1', 'idem-adv-1', 'CONFIRMED', 'COLD', 'COLD', ts, null, '0xsafe1', 'lock-1')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-2', 'idem-adv-2', 'CONFIRMED', 'COLD', 'COLD', ts, '0xtx2', null, 'lock-2')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-3', 'idem-adv-3', 'CONFIRMED', 'COLD', 'COLD', ts, '0xsamehash', '0xSAMEHASH', 'lock-3')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-3b', 'idem-adv-3b', 'CONFIRMED', 'COLD', 'COLD', ts, '\t0xsamehash\n', '0xSAMEHASH', 'lock-3b')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-4', 'idem-adv-4', 'CONFIRMED', 'COLD', 'COLD', ts, '0xtx4', '0xsafe4', null)).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-4b', 'idem-adv-4b', 'CONFIRMED', 'COLD', 'COLD', ts, '0xtx4b', '0xsafe4b', '\t\n ')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-4c', 'idem-adv-4c', 'CONFIRMED', 'COLD', 'COLD', ts, '0xtx 4c', '0xsafe4c', 'lock-4c')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-5', 'idem-adv-5', 'CONFIRMED', 'COLD', 'COLD', ts - 3600, '0xtx5', '0xsafe5', 'lock-5')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-6', 'idem-adv-6', 'CONFIRMED', 'COLD', 'COLD', ts + 600, '0xtx6', '0xsafe6', 'lock-6')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-7', 'idem-adv-7', 'CONFIRMED', 'COLD', null, ts, '0xtx7', '0xsafe7', 'lock-7')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-8', 'idem-adv-8', 'QUEUED_COLD_SAFE', 'COLD', 'COLD', ts, '0xtx8', '0xsafe8', 'lock-8')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-9', 'idem-adv-9', 'CONFIRMED', null, 'COLD', ts, '0xtx9', '0xsafe9', 'lock-9')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('adv-10', 'idem-adv-10', 'CONFIRMED', 'HOT', 'COLD', ts, '0xtx10', '0xsafe10', 'lock-10')).toThrow(/Direct INSERT/);

    // --- Forged HOT INSERTs ---
    expect(() => insertRow.run('hot-1', 'idem-hot-1', 'CONFIRMED', 'HOT', 'HOT', ts, '0xtxh1', '0xsafeh1', 'lock-h1')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('hot-2', 'idem-hot-2', 'CONFIRMED', 'COLD', 'HOT', ts, '0xtxh2', null, 'lock-h2')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('hot-3', 'idem-hot-3', 'CONFIRMED', null, 'HOT', ts, '0xtxh3', null, 'lock-h3')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('hot-4', 'idem-hot-4', 'CONFIRMED', 'HOT', 'HOT', ts, '\t\n', null, 'lock-h4')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('hot-5', 'idem-hot-5', 'CONFIRMED', 'HOT', 'HOT', ts - 600, '0xtxh5', null, 'lock-h5')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('hot-6', 'idem-hot-6', 'CONFIRMED', 'HOT', 'HOT', ts + 600, '0xtxh6', null, 'lock-h6')).toThrow(/Direct INSERT/);

    // --- Forged UNVERIFIED_HOT INSERTs ---
    expect(() => insertRow.run('uhot-1', 'idem-uhot-1', 'CONFIRMED', 'HOT', 'UNVERIFIED_HOT', null, null, null, 'lock-u1')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('uhot-2', 'idem-uhot-2', 'CONFIRMED', 'COLD', 'UNVERIFIED_HOT', null, '0xtxu2', null, 'lock-u2')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('uhot-3', 'idem-uhot-3', 'BROADCAST_PENDING', 'HOT', 'UNVERIFIED_HOT', null, '0xtxu3', null, 'lock-u3')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('uhot-4', 'idem-uhot-4', 'CONFIRMED', 'HOT', 'UNVERIFIED_HOT', null, '0xtxu4', '0xsafeu4', 'lock-u4')).toThrow(/Direct INSERT/);

    // --- Unknown lane values ---
    expect(() => insertRow.run('unk-1', 'idem-unk-1', 'SIGNING', 'WARM', null, null, null, null, 'lock-unk1')).toThrow(/Direct INSERT/);
    expect(() => insertRow.run('unk-2', 'idem-unk-2', 'CONFIRMED', 'HOT', 'WARM', ts, '0xtxunk', null, 'lock-unk2')).toThrow(/Direct INSERT/);

    // --- Pending HOT row: illegal HOT->COLD on BROADCAST_PENDING and forged UPDATEs ---
    insertRow.run('pend-hot', 'idem-pend-hot', 'BROADCAST_PENDING', 'HOT', null, null, '0xtx-hot-pending', null, 'lock-pend-hot');

    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET signing_lane = 'COLD', state = 'QUEUED_COLD_SAFE' WHERE payout_id = 'pend-hot'`).run()
    ).toThrow(/Settlement finality promotion requires/);

    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET state = 'CONFIRMED', confirmation_lane = 'UNVERIFIED_HOT', tx_hash = NULL WHERE payout_id = 'pend-hot'`).run()
    ).toThrow(/Settlement finality promotion requires/);

    // Promote pend-hot legitimately
    db.prepare(`
      UPDATE settlement_broadcasts
      SET state = 'CONFIRMED', confirmation_lane = 'HOT', confirmation_observed_at = ?
      WHERE payout_id = 'pend-hot'
    `).run(ts);

    // Duplicate HOT tx_hash blocked on both INSERT and UPDATE
    expect(() =>
      insertRow.run('dup-hot-ins', 'idem-dup-hot-ins', 'CONFIRMED', 'HOT', 'HOT', ts, '0xTX-HOT-PENDING', null, 'lock-dup-h1')
    ).toThrow(/UNIQUE constraint failed/);

    insertRow.run('dup-hot-upd', 'idem-dup-hot-upd', 'BROADCAST_PENDING', 'HOT', null, null, null, null, 'lock-dup-h2');
    expect(() =>
      db.prepare(`
        UPDATE settlement_broadcasts
        SET state = 'CONFIRMED', confirmation_lane = 'HOT', confirmation_observed_at = ?, tx_hash = '0xTX-HOT-PENDING'
        WHERE payout_id = 'dup-hot-upd'
      `).run(ts)
    ).toThrow(/UNIQUE constraint failed/);

    // --- Pending COLD row: forged UPDATEs, COLD->HOT, and confirmed-row immutability + DELETE ---
    insertRow.run('pend-cold', 'idem-pend-cold', 'QUEUED_COLD_SAFE', 'COLD', null, null, null, '0xsafe-pend', 'lock-pend');

    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET state = 'CONFIRMED', confirmation_lane = 'COLD', confirmation_observed_at = ? WHERE payout_id = 'pend-cold'`).run(ts)
    ).toThrow(/Settlement finality promotion requires/);

    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET state = 'CONFIRMED', confirmation_lane = 'COLD', confirmation_observed_at = ?, tx_hash = '0xSAFE-PEND' WHERE payout_id = 'pend-cold'`).run(ts)
    ).toThrow(/Settlement finality promotion requires/);

    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET signing_lane = 'HOT' WHERE payout_id = 'pend-cold'`).run()
    ).toThrow(/Settlement finality promotion requires/);

    expect(() =>
      db.prepare(`UPDATE settlement_broadcasts SET state = 'CONFIRMED', tx_hash = '0xtx-null-bypass' WHERE payout_id = 'pend-cold'`).run()
    ).toThrow(/Settlement finality promotion requires/);

    // Promote pend-cold legitimately
    db.prepare(`
      UPDATE settlement_broadcasts
      SET state = 'CONFIRMED', confirmation_lane = 'COLD', confirmation_observed_at = ?, tx_hash = '0xtx-legit-cold', signer_address = '0xsafe-signer'
      WHERE payout_id = 'pend-cold'
    `).run(ts);

    const beforeRow = db.prepare(`SELECT * FROM settlement_broadcasts WHERE payout_id = 'pend-cold'`).get();

    // Confirmed-row immutability across ALL protected columns
    const forbiddenUpdates = [
      `UPDATE settlement_broadcasts SET recipient_address = '0x9999999999999999999999999999999999999999' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET amount_units_1e8 = 1000000000 WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET state = 'FAILED_ABORTED' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET signing_lane = 'HOT' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET confirmation_lane = 'HOT' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET confirmation_observed_at = ${ts - 5} WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET tx_hash = '0xother' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET safe_multisig_tx_hash = '0xsafe-other' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET lock_batch_id = 'lock-other' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET chain_token_units = '999' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET chain_decimals = 7 WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET signer_address = '0xevil' WHERE payout_id = 'pend-cold'`,
      `UPDATE settlement_broadcasts SET idempotency_key = 'idem-evil' WHERE payout_id = 'pend-cold'`,
    ];

    for (const sql of forbiddenUpdates) {
      expect(() => db.prepare(sql).run()).toThrow(/Confirmed settlement lineage|Settlement finality promotion/);
    }

    // DELETE on CONFIRMED row must be blocked
    expect(() =>
      db.prepare(`DELETE FROM settlement_broadcasts WHERE payout_id = 'pend-cold'`).run()
    ).toThrow(/Confirmed settlement broadcast rows cannot be deleted/);

    // Post-throw rollback verification: row is completely unchanged
    const afterRow = db.prepare(`SELECT * FROM settlement_broadcasts WHERE payout_id = 'pend-cold'`).get();
    expect(afterRow).toEqual(beforeRow);

    // Duplicate safe_multisig_tx_hash across payouts must be blocked
    expect(() =>
      insertRow.run('dup-safe', 'idem-dup-safe', 'QUEUED_COLD_SAFE', 'COLD', null, null, null, '0xSAFE-PEND', 'lock-dup-2')
    ).toThrow(/UNIQUE constraint failed/);

    db.close();
  });
});

describe('G26.C3 — Stellar Secret Boundary & Read-Only Enforcement', () => {
  const validKeypair = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
  const validPub = validKeypair.publicKey();
  const validIssuer = validPub;
  const validSecret = validKeypair.secret(); // Real 56-char Ed25519 StrKey seed

  it('rejects raw secretKey injection in constructor with LegacyPayoutPathDisabledError', () => {
    expect(validSecret).toMatch(/^S[A-Z2-7]{55}$/);
    expect(
      () =>
        new StellarService({
          network: StellarNetwork.TESTNET,
          usdcIssuer: validIssuer,
          secretKey: validSecret,
        } as unknown as Parameters<typeof StellarService>[0])
    ).toThrow(LegacyPayoutPathDisabledError);
  });

  it('rejects invalid senderPublicKey and accepts valid Ed25519 public key or empty sender', () => {
    expect(
      () =>
        new StellarService({
          network: StellarNetwork.TESTNET,
          usdcIssuer: validIssuer,
          senderPublicKey: 'NOT_A_VALID_STELLAR_KEY',
        })
    ).toThrow(/Invalid Stellar senderPublicKey/);

    const noSender = new StellarService({
      network: StellarNetwork.TESTNET,
      usdcIssuer: validIssuer,
    });
    expect(noSender.getSenderAccountId()).toBeNull();
    expect(noSender.hasSenderAccount()).toBe(false);

    const readOnly = new StellarService({
      network: StellarNetwork.TESTNET,
      usdcIssuer: validIssuer,
      senderPublicKey: validPub,
    });
    expect(readOnly.getSenderAccountId()).toBe(validPub);
    expect(readOnly.hasSenderAccount()).toBe(false);
  });

  it('createStellarService never reads STELLAR_SECRET_KEY even when a valid 56-char seed is present in process.env', () => {
    const prevSecret = process.env.STELLAR_SECRET_KEY;
    const prevPub = process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS;
    const prevIssuer = process.env.STELLAR_USDC_ISSUER;
    try {
      process.env.STELLAR_SECRET_KEY = validSecret;
      process.env.STELLAR_USDC_ISSUER = validIssuer;
      delete process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS;

      const svc = createStellarService();
      expect(svc.getSenderAccountId()).toBeNull();
      expect(svc.hasSenderAccount()).toBe(false);
    } finally {
      if (prevSecret === undefined) delete process.env.STELLAR_SECRET_KEY;
      else process.env.STELLAR_SECRET_KEY = prevSecret;
      if (prevPub === undefined) delete process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS;
      else process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS = prevPub;
      if (prevIssuer === undefined) delete process.env.STELLAR_USDC_ISSUER;
      else process.env.STELLAR_USDC_ISSUER = prevIssuer;
    }
  });

  it('hard-disables submitTransaction, sendPayout, processBatchPayouts, and StellarAdapter.sendPayout without calling hasUsdcTrustline', async () => {
    const svc = new StellarService({
      network: StellarNetwork.TESTNET,
      usdcIssuer: validIssuer,
      senderPublicKey: validPub,
    });

    await expect(svc.submitTransaction({} as never)).rejects.toThrow(LegacyPayoutPathDisabledError);
    await expect(svc.sendPayout(validPub, '10.00')).rejects.toThrow(LegacyPayoutPathDisabledError);
    await expect(svc.processBatchPayouts({} as never)).rejects.toThrow(LegacyPayoutPathDisabledError);

    const trustlineSpy = jest.spyOn(svc, 'hasUsdcTrustline').mockResolvedValue(true);
    const adapter = new StellarAdapter({ network: StellarNetwork.TESTNET, stellarService: svc });
    const res = await adapter.sendPayout({
      recipientAddress: validPub,
      amount: '10.00',
      payoutId: 'payout-g26-c3',
    });
    expect(res.success).toBe(false);
    expect(res.error).toContain('LEGACY_PAYOUT_PATH_DISABLED');
    expect(trustlineSpy).not.toHaveBeenCalled();
  });
});

describe('G26.C4 — Financial Conservation, Caps, Epoch, E2E Cold Escalation & 50 Concurrent Recovery Cases', () => {
  it('enforces exact 10^-8 USD precision, 7-dec Stellar, 6-dec EVM dust conservation, and hot caps', () => {
    const evmSplit = splitChainSettlementAndDust(1_234_567_899n, 'arbitrum');
    expect(evmSplit.disbursableUnits1e8 + evmSplit.residualDust1e8).toBe(1_234_567_899n);
    expect(evmSplit.residualDust1e8).toBe(99n);
    expect(evmSplit.decimals).toBe(6);

    const stellarSplit = splitChainSettlementAndDust(1_234_567_899n, 'stellar');
    expect(stellarSplit.disbursableUnits1e8 + stellarSplit.residualDust1e8).toBe(1_234_567_899n);
    expect(stellarSplit.residualDust1e8).toBe(9n);
    expect(stellarSplit.decimals).toBe(7);

    expect(HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8).toBe(25_000_000_000n);
    expect(HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8).toBe(150_000_000_000n);
  });

  it('increments system_safety_epoch on emergency freeze/pause and enforces cold_settlement_claims uniqueness', () => {
    const { sqlite: db } = createFullSchemaUpTo038();

    const beforeEpoch = (db.prepare('SELECT epoch FROM system_safety_epoch WHERE singleton = 1').get() as { epoch: number }).epoch;
    db.prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'").run();
    const afterEpoch = (db.prepare('SELECT epoch FROM system_safety_epoch WHERE singleton = 1').get() as { epoch: number }).epoch;
    expect(afterEpoch).toBe(beforeEpoch + 1);

    db.prepare("UPDATE system_runtime_flags SET flag_value = 'false' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'").run();
    db.prepare(`
      INSERT INTO ledger_journal_batches (id, idempotency_key, payload_fingerprint, journal_type, status, payout_id, gross_commission_units)
      VALUES ('lock-claim-1', 'idem-lock-1', 'fp-lock-1', 'WITHDRAWAL_LOCK', 'INFLIGHT', 'payout-claim-1', 30000000000),
             ('lock-claim-2', 'idem-lock-2', 'fp-lock-2', 'WITHDRAWAL_LOCK', 'INFLIGHT', 'payout-claim-2', 30000000000)
    `).run();
    db.prepare(`
      INSERT INTO settlement_broadcasts (
        payout_id, idempotency_key, affiliate_id, chain, recipient_address,
        amount_units_1e8, chain_token_units, chain_decimals, state, signing_lane, lock_batch_id
      ) VALUES
        ('payout-claim-1', 'idem-b-1', 'aff-1', 'arbitrum', '0x5555555555555555555555555555555555555555', 30000000000, '300000000', 6, 'QUEUED_COLD_SAFE', 'COLD', 'lock-claim-1'),
        ('payout-claim-2', 'idem-b-2', 'aff-2', 'arbitrum', '0x6666666666666666666666666666666666666666', 30000000000, '300000000', 6, 'QUEUED_COLD_SAFE', 'COLD', 'lock-claim-2')
    `).run();

    const insertClaim = db.prepare(`
      INSERT INTO cold_settlement_claims (
        network, tx_hash, operation_id, payout_id, lock_batch_id, chain,
        block_reference, source_address, recipient_address, asset, amount_token_units
      ) VALUES ('arbitrum-one', '0xclaimtx1', '0', ?, ?, 'arbitrum', '100', '0xtreasury', '0x5555555555555555555555555555555555555555', 'USDC', '300000000')
    `);
    insertClaim.run('payout-claim-1', 'lock-claim-1');
    expect(() => insertClaim.run('payout-claim-2', 'lock-claim-2')).toThrow(/UNIQUE constraint failed/);

    db.close();
  });

  it('executes real TurnkeyPolicyHardBlockError HOT->COLD escalation and multi-op batched resolveColdSafeBroadcast under 038', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    const ledger = new DoubleEntryLedgerService(db);

    const coldSafePub = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 31)).publicKey();
    const hotPub = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 32)).publicKey();
    const recip1 = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 33)).publicKey();
    const recip2 = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 34)).publicKey();
    const sharedBatchTxHash = 'f'.repeat(64);

    // Seed two traders with $100 each
    await seedTraderBalance(db, ledger, 'cold_trader_1', 10_000_000_000n);
    await seedTraderBalance(db, ledger, 'cold_trader_2', 10_000_000_000n);

    const lock1 = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_cold_batch_1',
      ownerType: 'trader',
      ownerId: 'cold_trader_1',
      amountUnits: 5_000_000_000n, // $50
      payoutId: 'cold_batch_p1',
    });
    const lock2 = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_cold_batch_2',
      ownerType: 'trader',
      ownerId: 'cold_trader_2',
      amountUnits: 5_000_000_000n, // $50
      payoutId: 'cold_batch_p2',
    });

    // Pre-broadcast Turnkey policy hard-block escalates SIGNING/HOT -> QUEUED_COLD_SAFE/COLD
    const policyBlockedHsm: TurnkeySigningTransport = {
      signEvmDigest: async () => {
        throw new Error('unused');
      },
      signStellarEnvelope: async () => {
        throw new Error('should not reach HSM signing when policy hard-blocks');
      },
    };

    const stellarTransport: StellarBroadcastTransport = {
      hasUsdcTrustline: async () => true,
      getAccountSequence: async () => 500n,
      buildUnsignedUsdcPayment: async () => {
        throw new Error('Turnkey policy hard-block: hot signing denied; escalate to cold Safe');
      },
      submitSignedTransaction: async () => {
        throw new Error('should not broadcast when HSM policy blocks');
      },
      lookupTransaction: async () => ({ found: false }),
      coldPaymentNetwork: 'stellar-mainnet',
      coldPaymentAsset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
      getColdPaymentEvidence: async (txHash) => {
        if (txHash !== sharedBatchTxHash) {
          return {
            found: false,
            finalized: false,
            successful: false,
            network: 'stellar-mainnet',
            txHash,
            blockReference: '',
            transfers: [],
          };
        }
        return {
          found: true,
          finalized: true,
          successful: true,
          network: 'stellar-mainnet',
          txHash: sharedBatchTxHash,
          blockReference: '700123',
          transfers: [
            {
              operationId: '101',
              source: coldSafePub,
              recipient: recip1,
              asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
              amountUnits: 500_000_000n,
            },
            {
              operationId: '102',
              source: coldSafePub,
              recipient: recip2,
              asset: 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN',
              amountUnits: 500_000_000n,
            },
          ],
        };
      },
    };

    const signer = new TurnkeySigner({
      transport: policyBlockedHsm,
      evmHotWalletAddress: '0x1111111111111111111111111111111111111111',
      stellarHotWalletAddress: hotPub,
      safeColdMultisigAddresses: {
        stellar: coldSafePub,
      },
    });
    const machine = new BroadcastRecoveryMachine({
      db,
      turnkeySigner: signer,
      evmAdapters: {},
      stellarTransport,
    });

    // Both payouts escalate from SIGNING/HOT -> QUEUED_COLD_SAFE/COLD under migration 038
    const esc1 = await machine.executeSettlement({
      payoutId: 'cold_batch_p1',
      idempotencyKey: 'disp_cold_batch_1',
      affiliateId: 'cold_trader_1',
      lockBatchId: lock1.batch.id,
      chain: 'stellar',
      recipientAddress: recip1,
      amountUnits1e8: 5_000_000_000n,
    });
    const esc2 = await machine.executeSettlement({
      payoutId: 'cold_batch_p2',
      idempotencyKey: 'disp_cold_batch_2',
      affiliateId: 'cold_trader_2',
      lockBatchId: lock2.batch.id,
      chain: 'stellar',
      recipientAddress: recip2,
      amountUnits1e8: 5_000_000_000n,
    });

    expect(esc1.state).toBe('QUEUED_COLD_SAFE');
    expect(esc2.state).toBe('QUEUED_COLD_SAFE');

    // Resolve both payouts from the same batched Stellar tx_hash with distinct operationId
    const res1 = await machine.resolveColdSafeBroadcast({
      payoutId: 'cold_batch_p1',
      resolution: 'CONFIRMED',
      txHash: sharedBatchTxHash,
      operationId: '101',
    });
    const res2 = await machine.resolveColdSafeBroadcast({
      payoutId: 'cold_batch_p2',
      resolution: 'CONFIRMED',
      txHash: sharedBatchTxHash,
      operationId: '102',
    });

    expect(res1.state).toBe('CONFIRMED');
    expect(res1.tx_hash).toBe(sharedBatchTxHash);
    expect(res2.state).toBe('CONFIRMED');
    expect(res2.tx_hash).toBe(sharedBatchTxHash);

    const inv = await verifyLedgerInvariants(db);
    expect(inv.valid).toBe(true);
    expect(inv.unbalancedBatchIds).toEqual([]);
    expect(inv.negativeUserAccountCodes).toEqual([]);
    expect(inv.accountPostingDriftCodes).toEqual([]);
    expect(inv.periodEquation.driftUnits).toBe(0n);

    sqlite.close();
  });

  it('conserves liability across 50 real concurrent BroadcastRecoveryMachine + DoubleEntryLedgerService cases with 30% RPC failure under 038', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    const ledger = new DoubleEntryLedgerService(db);

    const TOTAL_CASES = 50;
    const PAYOUT_EACH = 2_000_000_000n; // $20 each; total $1,000 <= $1,500 hot cap
    const ORIGINAL_LIABILITY = BigInt(TOTAL_CASES) * PAYOUT_EACH;

    for (let i = 0; i < TOTAL_CASES; i++) {
      await seedTraderBalance(db, ledger, `g26_user_${i}`, PAYOUT_EACH);
    }

    const hotPub = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 41)).publicKey();
    const destPub = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42)).publicKey();

    const onChainSubmitted = new Map<string, { txHash: string; count: number }>();
    let sequenceCounter = 2000n;

    const fakeHsm: TurnkeySigningTransport = {
      signEvmDigest: async () => {
        throw new Error('unused');
      },
      signStellarEnvelope: async (req) => ({
        signedEnvelopeXdr: `XDR_${req.payoutId}`,
        signatureBase64: Buffer.from(req.payoutId).toString('base64'),
        txHash: req.txHashHex,
        turnkeyActivityId: `act_${req.payoutId}`,
      }),
    };

    const stellarTransport: StellarBroadcastTransport = {
      hasUsdcTrustline: async () => true,
      getAccountSequence: async () => {
        sequenceCounter += 1n;
        return sequenceCounter;
      },
      buildUnsignedUsdcPayment: async ({ amountStroops, stellarSequence, timeboundsMaxUnix }) => ({
        unsignedEnvelopeXdr: `UNSIGNED_${stellarSequence}_${amountStroops.toString()}`,
        txHashHex: stellarSequence.toString(16).padStart(64, '0'),
        timeboundsMaxUnix,
      }),
      submitSignedTransaction: async (params) => {
        const idx = Number(params.payoutId.replace('g26_payout_', ''));
        if (idx % 10 < 3) {
          // Exact 30% deterministic RPC failure (15/50)
          throw new Error('504 Gateway Timeout (deterministic 30% RPC failure)');
        }
        const txHash = params.expectedTxHash;
        const prev = onChainSubmitted.get(params.payoutId);
        onChainSubmitted.set(params.payoutId, { txHash, count: (prev?.count ?? 0) + 1 });
        return { txHash, successful: true, ledger: 700_000 + onChainSubmitted.size };
      },
      lookupTransaction: async (txHash) => {
        for (const [, sub] of onChainSubmitted.entries()) {
          if (sub.txHash === txHash) {
            return { found: true, successful: true, ledger: 700_999 };
          }
        }
        return { found: false };
      },
    };

    const signer = new TurnkeySigner({
      transport: fakeHsm,
      evmHotWalletAddress: '0x1111111111111111111111111111111111111111',
      stellarHotWalletAddress: hotPub,
    });
    const machine = new BroadcastRecoveryMachine({
      db,
      turnkeySigner: signer,
      evmAdapters: {},
      stellarTransport,
    });

    await Promise.all(
      Array.from({ length: TOTAL_CASES }, async (_, i) => {
        const ownerId = `g26_user_${i}`;
        const payoutId = `g26_payout_${i}`;
        const lock = await ledger.lockSettledForWithdrawal({
          idempotencyKey: `lock_${payoutId}`,
          ownerType: 'trader',
          ownerId,
          amountUnits: PAYOUT_EACH,
          payoutId,
        });

        const res = await machine.executeSettlement({
          payoutId,
          idempotencyKey: `disp_${payoutId}`,
          affiliateId: ownerId,
          lockBatchId: lock.batch.id,
          chain: 'stellar',
          recipientAddress: destPub,
          amountUnits1e8: PAYOUT_EACH,
        });

        if (res.state === 'CONFIRMED' && res.txHash) {
          await ledger.finalizeWithdrawal({
            idempotencyKey: `fin_${payoutId}`,
            lockBatchId: lock.batch.id,
            txHash: res.txHash,
          });
        } else if (res.state === 'BROADCAST_PENDING') {
          await machine.recoverUncertainBroadcast(payoutId, { passiveOnly: true });
        }
      })
    );

    // Zero double settlement on-chain
    for (const [, sub] of onChainSubmitted.entries()) {
      expect(sub.count).toBe(1);
    }
    expect(onChainSubmitted.size).toBe(35);

    const rows = sqlite
      .prepare('SELECT state, amount_units_1e8 FROM settlement_broadcasts')
      .all() as Array<{ state: string; amount_units_1e8: number }>;

    let verifiedSettlement = 0n;
    let remainingLiability = 0n;
    let validReversals = 0n;

    for (const row of rows) {
      const amt = BigInt(row.amount_units_1e8);
      if (row.state === 'CONFIRMED') verifiedSettlement += amt;
      else if (row.state === 'BROADCAST_PENDING') remainingLiability += amt;
      else if (row.state === 'FAILED_ABORTED' || row.state === 'EXPIRED_RECOVERED') validReversals += amt;
    }

    expect(verifiedSettlement + remainingLiability + validReversals).toBe(ORIGINAL_LIABILITY);
    expect(verifiedSettlement).toBe(35n * PAYOUT_EACH);
    expect(remainingLiability).toBe(15n * PAYOUT_EACH);
    expect(validReversals).toBe(0n);

    // Full double-entry ledger invariant verification
    const inv = await verifyLedgerInvariants(db);
    expect(inv.valid).toBe(true);
    expect(inv.unbalancedBatchIds).toEqual([]);
    expect(inv.negativeUserAccountCodes).toEqual([]);
    expect(inv.accountPostingDriftCodes).toEqual([]);
    expect(inv.periodEquation.driftUnits).toBe(0n);

    sqlite.close();
  });
});
