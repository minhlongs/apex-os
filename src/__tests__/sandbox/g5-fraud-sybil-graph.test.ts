/**
 * @jest-environment node
 *
 * Gate G5 Sandbox Verification: Deterministic M2 Anti-Fraud Engine + D1 Sybil Graph
 * & 48-Hour Wallet-Change Timelock
 *
 * Executes:
 *  - 100 adversarial fraud & ATO attack cases (target: 100% blocked)
 *  - 200 legitimate trader & B2B community behavior cases (target: <= 1.5% false positive rate)
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import { getAddress } from 'viem';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import {
  M2SybilGraphEngine,
  canonicalizeEmailRoot,
  type M2FraudEvaluationInput,
} from '@/lib/fraud/m2-sybil-graph-engine';
import {
  proposeTimelockedWalletChange,
  activateMaturedWalletChange,
  cancelWalletChangeByOwner,
  isWalletUnlockedForPayout,
  normalizePhase1WalletAddress,
  WALLET_TIMELOCK_DURATION_MS,
} from '@/lib/wallet/timelock-wallet-service';

const nativeNodeModule = (
  process as unknown as {
    getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire };
  }
).getBuiltinModule('node:module');
const { StrKey } = nativeNodeModule.createRequire(__filename)(
  '@stellar/stellar-sdk'
) as typeof StellarSdkTypes;

interface InternalStatement extends D1PreparedStatement {
  _runSync: () => D1Result<unknown>;
}

function createSqliteD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let params: unknown[] = [];
      const stmt = sqlite.prepare(sql);

      const wrapped: InternalStatement = {
        bind(...values: unknown[]) {
          params = values;
          return wrapped;
        },
        _runSync(): D1Result<unknown> {
          const info = stmt.run(...params);
          return {
            results: [],
            success: true,
            meta: {
              duration: 0,
              changes: info.changes,
              last_row_id: Number(info.lastInsertRowid),
              served_by: 'sqlite-g5',
            },
          };
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const row = stmt.get(...params) as Record<string, unknown> | undefined;
          if (!row) return null;
          if (colName) return (row[colName] as T) ?? null;
          return row as T;
        },
        async run<T = unknown>(): Promise<D1Result<T>> {
          return wrapped._runSync() as D1Result<T>;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const rows = stmt.all(...params) as T[];
          return {
            results: rows,
            success: true,
            meta: {
              duration: 0,
              changes: 0,
              last_row_id: 0,
              served_by: 'sqlite-g5',
            },
          };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return stmt.raw().all(...params) as T[];
        },
      };

      return wrapped;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      const tx = sqlite.transaction(() =>
        statements.map((s) => (s as InternalStatement)._runSync() as D1Result<T>)
      );
      return tx();
    },
    async exec(sql: string): Promise<{ count: number; duration: number }> {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async close(): Promise<void> {
      sqlite.close();
    },
  };
}

function makeEvmAddress(index: number): string {
  return `0x${index.toString(16).padStart(40, 'a')}`;
}

/**
 * Deterministic, checksum-valid Stellar Ed25519 public key (`G...`, 56 chars,
 * CRC16-XModem check bytes) so the address passes production StrKey validation.
 */
function makeStellarAddress(index: number): string {
  const seed = createHash('sha256').update(`stellar_test_pk_${index}`).digest();
  return StrKey.encodeEd25519PublicKey(seed);
}

function bootstrapSchema(sqlite: Database.Database): void {
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'affiliate',
      referral_code TEXT UNIQUE,
      referred_by TEXT,
      wallet_address TEXT,
      preferred_chain TEXT,
      kyc_status TEXT DEFAULT 'unverified',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE deals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL
    );

    CREATE TABLE referral_tree (
      id TEXT PRIMARY KEY,
      affiliate_id TEXT NOT NULL UNIQUE REFERENCES profiles(id) ON DELETE CASCADE,
      parent_id TEXT REFERENCES referral_tree(id) ON DELETE SET NULL,
      root_id TEXT REFERENCES referral_tree(id) ON DELETE SET NULL,
      level INTEGER DEFAULT 1,
      path TEXT,
      is_active INTEGER DEFAULT 1
    );

    CREATE TABLE wallet_connections (
      id TEXT PRIMARY KEY,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      wallet_address TEXT NOT NULL,
      preferred_chain TEXT DEFAULT 'arbitrum',
      is_primary INTEGER DEFAULT 1,
      connected_at TEXT DEFAULT (datetime('now')),
      last_used_at TEXT,
      UNIQUE(profile_id, wallet_address)
    );

    CREATE TABLE sanctioned_addresses (
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      source TEXT,
      risk_score REAL DEFAULT 1.0,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chain, address)
    );
  `);

  const migration028Path = path.resolve(
    process.cwd(),
    'src/database/migrations/028_ascendancy_audit_core.sql'
  );
  const migration028Sql = fs.readFileSync(migration028Path, 'utf8');
  sqlite.exec(migration028Sql);
}

describe('Gate G5: Deterministic M2 Anti-Fraud Engine, D1 Sybil Graph & 48h Wallet Timelock', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  let engine: M2SybilGraphEngine;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    bootstrapSchema(sqlite);
    db = createSqliteD1(sqlite);
    engine = new M2SybilGraphEngine();
  });

  afterEach(() => {
    sqlite.close();
  });

  it('canonicalizes Gmail +tag and dot-alias emails deterministically', () => {
    expect(canonicalizeEmailRoot('Alice.Trader+sybil99@Gmail.com')).toBe(
      'alicetrader@gmail.com'
    );
    expect(canonicalizeEmailRoot('alicetrader@googlemail.com')).toBe(
      'alicetrader@gmail.com'
    );
    expect(canonicalizeEmailRoot('desk.ops+vip@corp-rebate.io')).toBe(
      'desk.ops@corp-rebate.io'
    );
  });

  it('enforces Phase 1 chain allowlist, OFAC sanctions block, shared-wallet 409, and owner emergency cancel', async () => {
    sqlite
      .prepare(
        `INSERT INTO profiles (id, email, wallet_address, preferred_chain)
         VALUES ('u_owner', 'owner@apexos.app', ?, 'arbitrum'),
                ('u_other', 'other@apexos.app', ?, 'base')`
      )
      .run(makeEvmAddress(10), makeEvmAddress(20));

    // Reject Ethereum L1 & Solana
    const ethRes = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_owner',
      proposedAddress: makeEvmAddress(30),
      proposedChain: 'ethereum',
    });
    expect(ethRes.success).toBe(false);
    expect(ethRes.status).toBe(400);
    expect(ethRes.code).toBe('UNSUPPORTED_PHASE1_CHAIN');

    const solRes = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_owner',
      proposedAddress: '4uQeVj5tqViQh7yWWGStvkEG1Zmhx6uasJtWCJziofM',
      proposedChain: 'solana',
    });
    expect(solRes.success).toBe(false);
    expect(solRes.status).toBe(400);
    expect(solRes.code).toBe('UNSUPPORTED_PHASE1_CHAIN');

    // Reject OFAC Tornado Cash address on Arbitrum
    const sanctionedRes = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_owner',
      proposedAddress: '0xd90e2f925da726b50c4ed8d0fb90ad053324f31b',
      proposedChain: 'arbitrum',
    });
    expect(sanctionedRes.success).toBe(false);
    expect(sanctionedRes.status).toBe(403);
    expect(sanctionedRes.code).toBe('SANCTIONED_WALLET_ADDRESS');

    // Reject shared wallet already bound to u_other (even in uppercase hex)
    const sharedRes = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_owner',
      proposedAddress: makeEvmAddress(20).toUpperCase().replace('0X', '0x'),
      proposedChain: 'arbitrum',
    });
    expect(sharedRes.success).toBe(false);
    expect(sharedRes.status).toBe(409);
    expect(sharedRes.code).toBe('SHARED_PAYOUT_WALLET_CONFLICT');

    // Create valid 48h timelock and immediately cancel via emergency ATO cancel
    const t0 = '2026-11-14T00:00:00.000Z';
    const created = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_owner',
      proposedAddress: makeEvmAddress(99),
      proposedChain: 'base',
      nowIso: t0,
    });
    expect(created.success).toBe(true);
    expect(created.status).toBe(201);
    expect(created.request?.status).toBe('PENDING_TIMELOCK');

    const lockedCheck = await isWalletUnlockedForPayout(db, 'u_owner', t0);
    expect(lockedCheck.unlocked).toBe(false);
    expect(lockedCheck.reason).toBe('WALLET_TIMELOCK_ACTIVE_48H');

    // Owner spots ATO attempt and cancels immediately -> original wallet unlocked again
    const cancelled = await cancelWalletChangeByOwner(
      db,
      'u_owner',
      created.request!.id,
      '2026-11-14T01:00:00.000Z'
    );
    expect(cancelled.success).toBe(true);
    expect(cancelled.code).toBe('WALLET_CHANGE_CANCELLED');

    const restoredCheck = await isWalletUnlockedForPayout(
      db,
      'u_owner',
      '2026-11-14T01:05:00.000Z'
    );
    expect(restoredCheck.unlocked).toBe(true);
    expect(restoredCheck.walletAddress).toBe(makeEvmAddress(10));
  });

  it('enforces EIP-55 mixed-case checksum and Stellar StrKey CRC16 validation before binding a payout wallet', async () => {
    sqlite
      .prepare(
        `INSERT INTO profiles (id, email, wallet_address, preferred_chain)
         VALUES ('u_checksum_evm', 'checksum_evm@apexos.app', ?, 'arbitrum'),
                ('u_checksum_xlm', 'checksum_xlm@apexos.app', ?, 'stellar')`
      )
      .run(makeEvmAddress(40), makeStellarAddress(40));

    // 1. Valid mixed-case EIP-55 address is accepted and canonicalized to lowercase
    const validMixedEvm = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8');
    expect(validMixedEvm).not.toBe(validMixedEvm.toLowerCase());
    expect(normalizePhase1WalletAddress(validMixedEvm, 'arbitrum')).toBe(
      validMixedEvm.toLowerCase()
    );

    const acceptedEvm = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_checksum_evm',
      proposedAddress: validMixedEvm,
      proposedChain: 'arbitrum',
      nowIso: '2026-11-14T00:00:00.000Z',
    });
    expect(acceptedEvm.success).toBe(true);
    expect(acceptedEvm.status).toBe(201);
    expect(acceptedEvm.request?.proposed_address).toBe(validMixedEvm.toLowerCase());

    await cancelWalletChangeByOwner(
      db,
      'u_checksum_evm',
      acceptedEvm.request!.id,
      '2026-11-14T00:05:00.000Z'
    );

    // 2. Case-corrupted mixed-case EIP-55 address is rejected with 400 INVALID_WALLET_ADDRESS
    const firstAlphaIndex = validMixedEvm
      .slice(2)
      .split('')
      .findIndex((ch) => /[a-fA-F]/.test(ch));
    expect(firstAlphaIndex).toBeGreaterThanOrEqual(0);
    const pos = 2 + firstAlphaIndex;
    const origChar = validMixedEvm[pos];
    const flippedChar =
      origChar === origChar.toUpperCase() ? origChar.toLowerCase() : origChar.toUpperCase();
    const corruptedEvm = `${validMixedEvm.slice(0, pos)}${flippedChar}${validMixedEvm.slice(pos + 1)}`;
    // Ensure the corrupted string is still mixed-case so EIP-55 applies
    const corruptedHex = corruptedEvm.slice(2);
    expect(corruptedHex).not.toBe(corruptedHex.toLowerCase());
    expect(corruptedHex).not.toBe(corruptedHex.toUpperCase());
    expect(normalizePhase1WalletAddress(corruptedEvm, 'base')).toBeNull();

    const rejectedEvm = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_checksum_evm',
      proposedAddress: corruptedEvm,
      proposedChain: 'base',
      nowIso: '2026-11-14T00:10:00.000Z',
    });
    expect(rejectedEvm.success).toBe(false);
    expect(rejectedEvm.status).toBe(400);
    expect(rejectedEvm.code).toBe('INVALID_WALLET_ADDRESS');

    // 3. Valid CRC16-XModem Stellar Ed25519 StrKey is accepted verbatim
    const validStellar = makeStellarAddress(41);
    expect(StrKey.isValidEd25519PublicKey(validStellar)).toBe(true);
    expect(normalizePhase1WalletAddress(validStellar, 'stellar')).toBe(validStellar);

    const acceptedStellar = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_checksum_xlm',
      proposedAddress: validStellar,
      proposedChain: 'stellar',
      nowIso: '2026-11-14T00:00:00.000Z',
    });
    expect(acceptedStellar.success).toBe(true);
    expect(acceptedStellar.status).toBe(201);
    expect(acceptedStellar.request?.proposed_address).toBe(validStellar);

    await cancelWalletChangeByOwner(
      db,
      'u_checksum_xlm',
      acceptedStellar.request!.id,
      '2026-11-14T00:05:00.000Z'
    );

    // 4. One-character base32 mutation breaks the CRC16 checksum -> 400 INVALID_WALLET_ADDRESS
    const base32Alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
    const mutateIdx = 10;
    const origBase32 = validStellar[mutateIdx];
    const altBase32 = base32Alphabet[(base32Alphabet.indexOf(origBase32) + 1) % 32];
    const corruptedStellar = `${validStellar.slice(0, mutateIdx)}${altBase32}${validStellar.slice(mutateIdx + 1)}`;
    expect(corruptedStellar).toMatch(/^G[A-Z2-7]{55}$/);
    expect(StrKey.isValidEd25519PublicKey(corruptedStellar)).toBe(false);
    expect(normalizePhase1WalletAddress(corruptedStellar, 'stellar')).toBeNull();

    const rejectedStellar = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: 'u_checksum_xlm',
      proposedAddress: corruptedStellar,
      proposedChain: 'stellar',
      nowIso: '2026-11-14T00:10:00.000Z',
    });
    expect(rejectedStellar.success).toBe(false);
    expect(rejectedStellar.status).toBe(400);
    expect(rejectedStellar.code).toBe('INVALID_WALLET_ADDRESS');
  });

  it('blocks 100/100 adversarial attacks (100%) and achieves <= 1.5% false positives across 200 legitimate cases', async () => {
    const baseNowMs = Date.parse('2026-11-14T12:00:00.000Z');
    const insertProfile = sqlite.prepare(
      `INSERT INTO profiles (id, email, role, referral_code, referred_by, wallet_address, preferred_chain)
       VALUES (?, ?, 'affiliate', ?, ?, ?, ?)`
    );
    const insertTreeNode = sqlite.prepare(
      `INSERT INTO referral_tree (id, affiliate_id, parent_id, level)
       VALUES (?, ?, ?, ?)`
    );

    const attackInputs: M2FraudEvaluationInput[] = [];

    // -------------------------------------------------------------------------
    // Attack Group 1 (20 cases): Self-Referral (7 direct + 8 Gmail alias + 5 device/IP collision)
    // -------------------------------------------------------------------------
    for (let i = 0; i < 7; i += 1) {
      const uid = `atk_self_direct_${i}`;
      insertProfile.run(
        uid,
        `self_direct_${i}@trader.io`,
        `REF_${uid}`,
        null,
        makeEvmAddress(1000 + i),
        'arbitrum'
      );
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: uid,
        referrerId: uid,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    for (let i = 0; i < 8; i += 1) {
      const refId = `atk_alias_ref_${i}`;
      const trdId = `atk_alias_trd_${i}`;
      insertProfile.run(
        refId,
        `sybil.master.${i}@gmail.com`,
        `REF_${refId}`,
        null,
        makeEvmAddress(1100 + i),
        'arbitrum'
      );
      insertProfile.run(
        trdId,
        `sybilmaster${i}+alt${i}@googlemail.com`,
        `REF_${trdId}`,
        refId,
        makeEvmAddress(1200 + i),
        'arbitrum'
      );
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: trdId,
        referrerId: refId,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    for (let i = 0; i < 5; i += 1) {
      const refId = `atk_dev_ref_${i}`;
      const trdId = `atk_dev_trd_${i}`;
      insertProfile.run(
        refId,
        `dev_ref_${i}@alpha.io`,
        `REF_${refId}`,
        null,
        makeEvmAddress(1300 + i),
        'base'
      );
      insertProfile.run(
        trdId,
        `dev_trd_${i}@beta.io`,
        `REF_${trdId}`,
        refId,
        makeEvmAddress(1400 + i),
        'base'
      );
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: trdId,
        referrerId: refId,
        traderDeviceHash: `fp_same_device_${i}`,
        referrerDeviceHash: `fp_same_device_${i}`,
        traderIpHash: `ip_same_${i}`,
        referrerIpHash: `ip_same_${i}`,
        signupDeltaMinutes: 4,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    // -------------------------------------------------------------------------
    // Attack Group 2 (25 cases): Sybil Referral Rings (10 2-node, 10 3-node, 5 5-node)
    // -------------------------------------------------------------------------
    for (let i = 0; i < 10; i += 1) {
      const a = `atk_ring2_a_${i}`;
      const b = `atk_ring2_b_${i}`;
      insertProfile.run(a, `${a}@ring.io`, `RC_${a}`, null, makeEvmAddress(2000 + i), 'arbitrum');
      insertProfile.run(b, `${b}@ring.io`, `RC_${b}`, a, makeEvmAddress(2100 + i), 'arbitrum');
      insertTreeNode.run(`rt_${a}`, a, null, 1);
      insertTreeNode.run(`rt_${b}`, b, `rt_${a}`, 2);
      // Attempting to link A under B closes 2-node cycle A -> B -> A
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: a,
        referrerId: b,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    for (let i = 0; i < 10; i += 1) {
      const a = `atk_ring3_a_${i}`;
      const b = `atk_ring3_b_${i}`;
      const c = `atk_ring3_c_${i}`;
      insertProfile.run(a, `${a}@ring3.io`, `RC_${a}`, null, makeEvmAddress(2200 + i), 'base');
      insertProfile.run(b, `${b}@ring3.io`, `RC_${b}`, a, makeEvmAddress(2300 + i), 'base');
      insertProfile.run(c, `${c}@ring3.io`, `RC_${c}`, b, makeEvmAddress(2400 + i), 'base');
      insertTreeNode.run(`rt_${a}`, a, null, 1);
      insertTreeNode.run(`rt_${b}`, b, `rt_${a}`, 2);
      insertTreeNode.run(`rt_${c}`, c, `rt_${b}`, 3);
      // Attempting to link A under C closes 3-node cycle A -> C -> B -> A
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: a,
        referrerId: c,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    for (let i = 0; i < 5; i += 1) {
      const nodes = [0, 1, 2, 3, 4].map((n) => `atk_ring5_${i}_n${n}`);
      for (let n = 0; n < nodes.length; n += 1) {
        const parentProfile = n === 0 ? null : nodes[n - 1];
        insertProfile.run(
          nodes[n],
          `${nodes[n]}@ring5.io`,
          `RC_${nodes[n]}`,
          parentProfile,
          makeEvmAddress(2500 + i * 10 + n),
          'arbitrum'
        );
        insertTreeNode.run(
          `rt_${nodes[n]}`,
          nodes[n],
          n === 0 ? null : `rt_${nodes[n - 1]}`,
          n + 1
        );
      }
      // Link root n0 under n4 -> closes 5-node ring!
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: nodes[0],
        referrerId: nodes[4],
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    // -------------------------------------------------------------------------
    // Attack Group 3 (25 cases): Shared Payout Wallet Clusters (15 EVM mixed-case + 10 Stellar)
    // -------------------------------------------------------------------------
    for (let i = 0; i < 15; i += 1) {
      const sharedEvm = makeEvmAddress(3000 + i);
      const owner1 = `atk_wshare_evm1_${i}`;
      const sybil2 = `atk_wshare_evm2_${i}`;
      insertProfile.run(owner1, `${owner1}@cluster.io`, `RC_${owner1}`, null, sharedEvm, 'arbitrum');
      insertProfile.run(
        sybil2,
        `${sybil2}@cluster.io`,
        `RC_${sybil2}`,
        null,
        sharedEvm.toUpperCase().replace('0X', '0x'),
        'base'
      );
      attackInputs.push({
        eventType: 'payout_withdrawal',
        traderId: sybil2,
        payoutWalletAddress: sharedEvm.toUpperCase().replace('0X', '0x'),
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    for (let i = 0; i < 10; i += 1) {
      const sharedStellar = makeStellarAddress(4000 + i);
      const owner1 = `atk_wshare_xlm1_${i}`;
      const sybil2 = `atk_wshare_xlm2_${i}`;
      insertProfile.run(
        owner1,
        `${owner1}@xlmcluster.io`,
        `RC_${owner1}`,
        null,
        sharedStellar,
        'stellar'
      );
      insertProfile.run(
        sybil2,
        `${sybil2}@xlmcluster.io`,
        `RC_${sybil2}`,
        null,
        null,
        'stellar'
      );
      sqlite
        .prepare(
          'INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain) VALUES (?, ?, ?, ?)'
        )
        .run(`wc_xlm_${i}`, sybil2, sharedStellar, 'stellar');
      attackInputs.push({
        eventType: 'payout_withdrawal',
        traderId: sybil2,
        payoutWalletAddress: sharedStellar,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    // -------------------------------------------------------------------------
    // Attack Group 4 (20 cases): ATO Wallet Swap + Immediate Withdrawal (< 48h timelock)
    // -------------------------------------------------------------------------
    for (let i = 0; i < 20; i += 1) {
      const victimId = `atk_ato_victim_${i}`;
      insertProfile.run(
        victimId,
        `${victimId}@victim.io`,
        `RC_${victimId}`,
        null,
        makeEvmAddress(5000 + i),
        'arbitrum'
      );
      const swapProposal = await proposeTimelockedWalletChange(db, {
        authenticatedUserId: victimId,
        proposedAddress: makeEvmAddress(5500 + i),
        proposedChain: 'arbitrum',
        nowIso: new Date(baseNowMs).toISOString(),
      });
      expect(swapProposal.success).toBe(true);

      // Premature activation before 48h must also fail
      const elapsedHours = (i * 2.3) % 47.9;
      const attemptIso = new Date(
        baseNowMs + Math.floor(elapsedHours * 3600 * 1000)
      ).toISOString();

      const prematureActivate = await activateMaturedWalletChange(
        db,
        swapProposal.request!.id,
        attemptIso,
        victimId
      );
      expect(prematureActivate.success).toBe(false);
      expect(prematureActivate.code).toBe('WALLET_TIMELOCK_NOT_MATURED');

      attackInputs.push({
        eventType: 'payout_withdrawal',
        traderId: victimId,
        nowIso: attemptIso,
      });
    }

    // -------------------------------------------------------------------------
    // Attack Group 5 (10 cases): 5 Idempotency Replays + 5 Automated Device Bursts
    // -------------------------------------------------------------------------
    for (let i = 0; i < 5; i += 1) {
      const replayUserId = `atk_replay_user_${i}`;
      const idemKey = `idem_payout_seed_${i}`;
      insertProfile.run(
        replayUserId,
        `${replayUserId}@replay.io`,
        `RC_${replayUserId}`,
        null,
        makeEvmAddress(6000 + i),
        'base'
      );
      // Prime first execution key
      const initial = await engine.evaluate(db, {
        eventType: 'payout_withdrawal',
        idempotencyKey: idemKey,
        traderId: replayUserId,
        nowIso: new Date(baseNowMs).toISOString(),
      });
      expect(initial.allowed).toBe(true);

      // Replay with identical idempotencyKey
      attackInputs.push({
        eventType: 'payout_withdrawal',
        idempotencyKey: idemKey,
        traderId: replayUserId,
        nowIso: new Date(baseNowMs + 1000).toISOString(),
      });
    }

    for (let i = 0; i < 5; i += 1) {
      const farmBotId = `atk_farm_bot_${i}`;
      insertProfile.run(
        farmBotId,
        `${farmBotId}@farm.io`,
        `RC_${farmBotId}`,
        null,
        makeEvmAddress(6200 + i),
        'arbitrum'
      );
      attackInputs.push({
        eventType: 'referral_attribution',
        traderId: farmBotId,
        sameDeviceRecentSignups10m: 7 + i,
        subSecondClickBurstCount: 12 + i,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    expect(attackInputs).toHaveLength(100);

    let blockedAttacks = 0;
    for (const attack of attackInputs) {
      const verdict = await engine.evaluate(db, attack);
      if (verdict.blocked) {
        blockedAttacks += 1;
      }
    }

    expect(blockedAttacks).toBe(100);

    // =========================================================================
    // 200 Legitimate User Behavior Cases (Target: <= 1.5% False Positives)
    // =========================================================================
    const legitimateInputs: M2FraudEvaluationInput[] = [];

    // 1. 80 High-volume individual traders on distinct Arbitrum/Base/Stellar wallets
    const legitSponsor = 'legit_institutional_desk';
    insertProfile.run(
      legitSponsor,
      'sponsor@quantdesk.io',
      'RC_QUANT_DESK',
      null,
      makeEvmAddress(7000),
      'arbitrum'
    );
    insertTreeNode.run('rt_legit_sponsor', legitSponsor, null, 1);

    for (let i = 0; i < 80; i += 1) {
      const uid = `legit_hv_trader_${i}`;
      const chain = i % 3 === 0 ? 'stellar' : i % 2 === 0 ? 'arbitrum' : 'base';
      const wallet =
        chain === 'stellar' ? makeStellarAddress(7100 + i) : makeEvmAddress(7100 + i);
      insertProfile.run(uid, `hv_trader_${i}@protrade.io`, `RC_${uid}`, legitSponsor, wallet, chain);
      insertTreeNode.run(`rt_${uid}`, uid, 'rt_legit_sponsor', 2);

      legitimateInputs.push({
        eventType: 'payout_withdrawal',
        idempotencyKey: `legit_hv_payout_${i}`,
        traderId: uid,
        referrerId: legitSponsor,
        payoutWalletAddress: wallet,
        traderDeviceHash: `fp_hv_unique_${i}`,
        referrerDeviceHash: 'fp_quant_desk_hq',
        traderIpHash: `ip_hv_unique_${i}`,
        referrerIpHash: 'ip_quant_desk_hq',
        signupDeltaMinutes: 180 + i,
        sameDeviceRecentSignups10m: 1,
        subSecondClickBurstCount: 0,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    // 2. B2B Community Leader with 40 legitimate referrals on distinct wallets & devices
    const b2bLeader = 'legit_b2b_leader_1';
    insertProfile.run(
      b2bLeader,
      'community@tradingguild.org',
      'RC_B2B_GUILD',
      null,
      makeEvmAddress(8000),
      'base'
    );
    insertTreeNode.run('rt_b2b_leader', b2bLeader, null, 1);

    for (let i = 0; i < 40; i += 1) {
      const memberId = `legit_b2b_member_${i}`;
      const wallet = makeEvmAddress(8100 + i);
      insertProfile.run(
        memberId,
        `member_${i}@guild-traders.org`,
        `RC_${memberId}`,
        b2bLeader,
        wallet,
        'base'
      );
      insertTreeNode.run(`rt_${memberId}`, memberId, 'rt_b2b_leader', 2);

      legitimateInputs.push({
        eventType: 'referral_attribution',
        idempotencyKey: `legit_b2b_attr_${i}`,
        traderId: memberId,
        referrerId: b2bLeader,
        payoutWalletAddress: wallet,
        traderDeviceHash: `fp_guild_member_${i}`,
        referrerDeviceHash: 'fp_guild_leader_main',
        signupDeltaMinutes: i * 3 + 10,
        sameDeviceRecentSignups10m: 1,
        subSecondClickBurstCount: 0,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    // 3. 40 Organic acyclic chains (A -> B -> C with zero cycles, distinct corporate emails on same domain)
    for (let i = 0; i < 40; i += 1) {
      const parentId = `legit_chain_p_${i}`;
      const childId = `legit_chain_c_${i}`;
      insertProfile.run(
        parentId,
        `partner.${i}@propfirm.com`,
        `RC_${parentId}`,
        null,
        makeEvmAddress(8500 + i),
        'arbitrum'
      );
      insertProfile.run(
        childId,
        `associate.${i}@propfirm.com`,
        `RC_${childId}`,
        parentId,
        makeEvmAddress(8700 + i),
        'arbitrum'
      );
      insertTreeNode.run(`rt_${parentId}`, parentId, null, 1);
      insertTreeNode.run(`rt_${childId}`, childId, `rt_${parentId}`, 2);

      // Even on shared corporate Wi-Fi IP, distinct device hashes & distinct corporate mailboxes must NOT false-positive!
      legitimateInputs.push({
        eventType: 'referral_attribution',
        idempotencyKey: `legit_corp_attr_${i}`,
        traderId: childId,
        referrerId: parentId,
        traderIpHash: 'ip_shared_office_nat',
        referrerIpHash: 'ip_shared_office_nat',
        traderDeviceHash: `fp_laptop_child_${i}`,
        referrerDeviceHash: `fp_laptop_parent_${i}`,
        signupDeltaMinutes: 15,
        sameDeviceRecentSignups10m: 1,
        nowIso: new Date(baseNowMs).toISOString(),
      });
    }

    // 4. 40 Matured Wallet Changes (>= 48 hours elapsed) activated cleanly and withdrawing
    for (let i = 0; i < 40; i += 1) {
      const rotatedUser = `legit_wallet_rot_${i}`;
      const oldWallet = makeEvmAddress(9000 + i);
      const newWallet =
        i % 2 === 0 ? makeEvmAddress(9200 + i) : makeStellarAddress(9200 + i);
      const newChain = i % 2 === 0 ? 'arbitrum' : 'stellar';

      insertProfile.run(
        rotatedUser,
        `rotated_${i}@vaultuser.io`,
        `RC_${rotatedUser}`,
        null,
        oldWallet,
        'arbitrum'
      );

      const proposal = await proposeTimelockedWalletChange(db, {
        authenticatedUserId: rotatedUser,
        proposedAddress: newWallet,
        proposedChain: newChain,
        nowIso: new Date(baseNowMs).toISOString(),
      });
      expect(proposal.success).toBe(true);

      const maturedIso = new Date(
        baseNowMs + WALLET_TIMELOCK_DURATION_MS + (i + 1) * 60_000
      ).toISOString();

      const activation = await activateMaturedWalletChange(
        db,
        proposal.request!.id,
        maturedIso,
        rotatedUser
      );
      expect(activation.success).toBe(true);
      expect(activation.code).toBe('WALLET_CHANGE_ACTIVATED');

      legitimateInputs.push({
        eventType: 'payout_withdrawal',
        idempotencyKey: `legit_matured_withdraw_${i}`,
        traderId: rotatedUser,
        payoutWalletAddress: newWallet,
        nowIso: maturedIso,
      });
    }

    expect(legitimateInputs).toHaveLength(200);

    let falsePositives = 0;
    for (const legit of legitimateInputs) {
      const verdict = await engine.evaluate(db, legit);
      if (verdict.blocked) {
        falsePositives += 1;
      }
    }

    const falsePositiveRate = falsePositives / legitimateInputs.length;
    expect(falsePositives).toBe(0);
    expect(falsePositiveRate).toBeLessThanOrEqual(0.015);
  });
});
