/**
 * @jest-environment node
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  splitChainSettlementAndDust,
  toSafeNonNegativeSqlInteger,
  LedgerOverflowError,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
const nodeMod = (
  process as unknown as {
    getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire };
  }
).getBuiltinModule('node:module');
const StellarSdk = nodeMod.createRequire(__filename)('@stellar/stellar-sdk') as typeof StellarSdkTypes;
import {
  TurnkeySigner,
  TurnkeyHsmOutcomeError,
  TurnkeyServerHsmTransport,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import {
  BroadcastRecoveryMachine,
  type StellarBroadcastTransport,
} from '@/lib/payouts/broadcast-recovery-machine';
import {
  StellarService,
  LegacyPayoutPathDisabledError,
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
} from '@/lib/payouts/stellar-service';
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
        meta: { changes: info.changes, last_row_id: Number(info.lastInsertRowid) },
      };
    },
    all: async <T = unknown>() => ({
      success: true,
      results: sqlite.prepare(sql).all(...bound) as T[],
    }),
    raw: async <T = unknown>() => sqlite.prepare(sql).raw().all(...bound) as T[],
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
const ALL_TREASURY_MIGRATIONS = [
  '028_ascendancy_audit_core.sql',
  '031_ascendancy_phase2_ui_and_poller.sql',
  '032_persistent_d1_rate_limits.sql',
  '033_cold_settlement_claims.sql',
  '034_withdrawal_freeze_at_write.sql',
  '035_payout_effect_grants.sql',
  '036_durable_hot_exposure.sql',
  '037_hardening_trigger_and_exposure.sql',
];

function createHardenedDb(): { sqlite: Database.Database; db: D1Database } {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  for (const file of ALL_TREASURY_MIGRATIONS) {
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
  }
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO system_runtime_flags (flag_key, flag_value, updated_by, updated_at)
       VALUES ('EMERGENCY_LEDGER_FREEZE', 'false', 'test', datetime('now')),
              ('EMERGENCY_PAUSE', 'false', 'test', datetime('now'))`
    )
    .run();
  return { sqlite, db: createBetterSqliteD1(sqlite) };
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

// Deterministic Mulberry32 PRNG for reproducible chaos testing
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('Adversarial Treasury Verification Suite (Groups A-F)', () => {
  it('Group A: Turnkey HSM timeout classifies UNCERTAIN_OUTCOME with zero blind retries', async () => {
    const hotPub = StellarSdk.Keypair.random().publicKey();
    const destPub = StellarSdk.Keypair.random().publicKey();
    const account = new StellarSdk.Account(hotPub, '100');
    const tx = new StellarSdk.TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: StellarSdk.Networks.TESTNET,
    })
      .addOperation(
        StellarSdk.Operation.payment({
          destination: destPub,
          asset: StellarSdk.Asset.native(),
          amount: '10.0000000',
        })
      )
      .setTimeout(180)
      .build();

    let signCalls = 0;
    const transport = new TurnkeyServerHsmTransport({
      organizationId: 'org_test',
      apiPublicKey: '03' + 'a'.repeat(64),
      apiPrivateKey: 'b'.repeat(64),
      signTimeoutMs: 25,
      apiClientOverride: {
        async signRawPayload() {
          signCalls += 1;
          return new Promise(() => {
            // Never resolves — triggers bounded timeout
          });
        },
      },
    });

    let caught: unknown;
    try {
      await transport.signStellarEnvelope({
        payoutId: 'chaos_hsm_1',
        signerAddress: hotPub,
        unsignedEnvelopeXdr: tx.toXDR(),
        txHashHex: Buffer.from(tx.hash()).toString('hex'),
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(TurnkeyHsmOutcomeError);
    expect((caught as TurnkeyHsmOutcomeError).outcomeState).toBe('UNCERTAIN_OUTCOME');
    expect((caught as TurnkeyHsmOutcomeError).retryAllowed).toBe(false);
    expect(signCalls).toBe(1);
  });

  it('Group B: Legacy StellarService.processBatchPayouts hard-disabled (LEGACY_PAYOUT_EXECUTION = 0)', async () => {
    const mockDb = { prepare: jest.fn(), batch: jest.fn(), exec: jest.fn() } as unknown as D1Database;
    const svc = new StellarService({
      secretKey: 'S' + 'A'.repeat(55),
      network: 'testnet',
      usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
      usdcCode: 'USDC',
    });

    await expect(svc.processBatchPayouts(mockDb, 10)).rejects.toBeInstanceOf(
      LegacyPayoutPathDisabledError
    );
    expect(mockDb.prepare).not.toHaveBeenCalled();
    expect(mockDb.batch).not.toHaveBeenCalled();
  });

  it('Group C: BigInt overflow & dust conservation boundaries fail closed', () => {
    expect(() => toSafeNonNegativeSqlInteger(BigInt(Number.MAX_SAFE_INTEGER) + 1n, 'overflow')).toThrow(
      LedgerOverflowError
    );
    const split = splitChainSettlementAndDust(1_000_000_077n, 'arbitrum');
    expect(split.disbursableUnits1e8).toBe(1_000_000_000n);
    expect(split.residualDust1e8).toBe(77n);
    expect(split.disbursableUnits1e8 + split.residualDust1e8).toBe(1_000_000_077n);
  });

  it('Group D: Migration 037 rejects cross-payout reversal spoof and backdated finality promotion', async () => {
    const { sqlite, db } = createHardenedDb();
    const ledger = new DoubleEntryLedgerService(db);
    await seedTraderBalance(db, ledger, 'adv_d', 5_000_000_000n);
    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'lock_adv_d',
      ownerType: 'trader',
      ownerId: 'adv_d',
      amountUnits: 1_500_000_000n,
      payoutId: 'payout_adv_d',
    });
    const staleTs = Math.floor(Date.now() / 1000) - 90_000;
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts
         (payout_id, idempotency_key, affiliate_id, lock_batch_id, chain, recipient_address,
          amount_units_1e8, chain_token_units, chain_decimals, state, tx_hash, confirmation_lane, confirmation_observed_at)
         VALUES ('payout_adv_d', 'ik_adv_d', 'adv_d', ?, 'stellar', 'GABC',
                 1500000000, '150000000', 7, 'CONFIRMED', 'tx_adv_d', 'UNVERIFIED_HOT', ?)`
      )
      .run(lock.batch.id, staleTs);

    // Backdated promotion must abort
    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts SET confirmation_lane = 'HOT', confirmation_observed_at = ?
           WHERE payout_id = 'payout_adv_d'`
        )
        .run(staleTs)
    ).toThrow(/UNVERIFIED_HOT to HOT promotion requires fresh verified finality timestamp/);

    // Reversal on confirmed payout must abort
    await expect(
      ledger.revertWithdrawal({
        idempotencyKey: 'rev_adv_d',
        lockBatchId: lock.batch.id,
        reason: 'spoofed_revert',
      })
    ).rejects.toThrow(/Withdrawal refund requires exact bound lock and durable terminal proof/);

    sqlite.close();
  });

  it('Group E: Emergency ledger freeze blocks new withdrawal locks at SQL trigger boundary', async () => {
    const { sqlite, db } = createHardenedDb();
    const ledger = new DoubleEntryLedgerService(db);
    await seedTraderBalance(db, ledger, 'adv_e', 5_000_000_000n);

    sqlite
      .prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'")
      .run();

    await expect(
      ledger.lockSettledForWithdrawal({
        idempotencyKey: 'lock_adv_e',
        ownerType: 'trader',
        ownerId: 'adv_e',
        amountUnits: 1_000_000_000n,
        payoutId: 'payout_adv_e',
      })
    ).rejects.toThrow(/frozen|freeze/i);

    sqlite.close();
  });

  it('Group F (R11): 50-case deterministic concurrent payout chaos test with 30% RPC failure injection', async () => {
    const { sqlite, db } = createHardenedDb();
    const ledger = new DoubleEntryLedgerService(db);
    const rng = mulberry32(0xa9e52026);

    const TOTAL_CASES = 50;
    const settledPerUser = 5_000_000_000n; // $50 each -> total $2,500 across 50 users
    let totalInitialLiability = 0n;

    for (let i = 0; i < TOTAL_CASES; i++) {
      const credited = await seedTraderBalance(db, ledger, `chaos_user_${i}`, settledPerUser);
      totalInitialLiability += credited;
    }

    const hotKeypair = StellarSdk.Keypair.random();
    const destPub = StellarSdk.Keypair.random().publicKey();
    const hotPub = hotKeypair.publicKey();

    // Track actual on-chain broadcasts (by payoutId) to prove zero duplicate settlement
    const onChainSubmitted = new Map<string, { txHash: string; count: number }>();
    let rpcFailureCount = 0;
    let sequenceCounter = 1000n;

    const fakeHsm: TurnkeySigningTransport = {
      signEvmDigest: async () => {
        throw new Error('EVM disabled in Stellar-only chaos test');
      },
      signStellarEnvelope: async (req) => ({
        signedEnvelopeXdr: `XDR_${req.payoutId}`,
        signatureBase64: Buffer.from(req.payoutId).toString('base64'),
        txHash: `hash_${req.payoutId}`,
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
        txHashHex: 'd'.repeat(64),
        timeboundsMaxUnix,
      }),
      submitSignedTransaction: async (params) => {
        const payoutId = params.payoutId;
        const roll = rng();
        if (roll < 0.30) {
          // 30% deterministic RPC failure injection (network drop / 504 after possible submission)
          rpcFailureCount += 1;
          throw new Error('504 Gateway Timeout (simulated deterministic RPC failure)');
        }
        const txHash = params.expectedTxHash || `hash_${payoutId}`;
        const prev = onChainSubmitted.get(payoutId);
        onChainSubmitted.set(payoutId, {
          txHash,
          count: (prev?.count ?? 0) + 1,
        });
        return { txHash, successful: true, ledger: 600_000 + onChainSubmitted.size };
      },
      lookupTransaction: async (txHash) => {
        for (const [, sub] of onChainSubmitted.entries()) {
          if (sub.txHash === txHash) {
            return { found: true, successful: true, ledger: 600_999 };
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

    // Dispatch 50 payouts concurrently ($20 each; total $1,000 <= $1,500 hot cap)
    const payoutAmount = 2_000_000_000n;
    const tasks = Array.from({ length: TOTAL_CASES }, async (_, i) => {
      const ownerId = `chaos_user_${i}`;
      const payoutId = `chaos_payout_${i}`;
      const lock = await ledger.lockSettledForWithdrawal({
        idempotencyKey: `lock_${payoutId}`,
        ownerType: 'trader',
        ownerId,
        amountUnits: payoutAmount,
        payoutId,
      });

      try {
        const res = await machine.executeSettlement({
          payoutId,
          idempotencyKey: `disp_${payoutId}`,
          affiliateId: ownerId,
          lockBatchId: lock.batch.id,
          chain: 'stellar',
          recipientAddress: destPub,
          amountUnits1e8: payoutAmount,
        });
        if (res.state === 'BROADCAST_PENDING') {
          const recovered = await machine.recoverUncertainBroadcast(payoutId, { passiveOnly: true });
          if (recovered.state === 'CONFIRMED' && recovered.txHash) {
            await ledger.finalizeWithdrawal({
              idempotencyKey: `fin_${payoutId}`,
              lockBatchId: lock.batch.id,
              txHash: recovered.txHash,
            });
          }
          return { payoutId, outcome: recovered.state };
        }
        return { payoutId, outcome: res.state };
      } catch (err) {
        return { payoutId, outcome: 'ERROR', error: String(err) };
      }
    });

    const results = await Promise.all(tasks);
    expect(results.filter((r) => r.outcome === 'ERROR')).toEqual([]);

    // 1. Verify ~30% RPC failures actually fired deterministically
    expect(rpcFailureCount).toBeGreaterThanOrEqual(8);
    expect(rpcFailureCount).toBeLessThanOrEqual(25);

    // 2. Zero duplicate on-chain submissions for any payoutId
    for (const [, sub] of onChainSubmitted.entries()) {
      expect(sub.count).toBe(1);
    }

    // 3. Reconcile exact ledger conservation across all 50 accounts + escrow + finalized payouts
    let totalRemainingSettled = 0n;
    let totalFinalized = 0n;
    let totalInflightLocks = 0n;

    for (let i = 0; i < TOTAL_CASES; i++) {
      const acct = await ledger.getAccountByOwner('trader', `chaos_user_${i}`);
      const bal = acct?.settledBalanceUnits ?? 0n;
      expect(bal).toBeGreaterThanOrEqual(0n); // Zero negative balances
      totalRemainingSettled += bal;
    }

    const finalizedRows = sqlite
      .prepare(
        `SELECT COALESCE(SUM(gross_commission_units), 0) AS total
         FROM ledger_journal_batches
         WHERE journal_type = 'WITHDRAWAL_FINALIZED' AND status = 'SETTLED'`
      )
      .get() as { total: number };
    totalFinalized = BigInt(finalizedRows.total);

    const inflightRows = sqlite
      .prepare(
        `SELECT COALESCE(SUM(gross_commission_units), 0) AS total
         FROM ledger_journal_batches
         WHERE journal_type = 'WITHDRAWAL_LOCK' AND status = 'INFLIGHT'`
      )
      .get() as { total: number };
    totalInflightLocks = BigInt(inflightRows.total);

    // Every single 10^-8 unit is conserved: initial === finalized + remaining + inflight_escrow
    expect(totalFinalized + totalRemainingSettled + totalInflightLocks).toBe(totalInitialLiability);

    // 4. Every RPC-failed payout must remain locked (INFLIGHT) and BROADCAST_PENDING (never auto-refunded)
    const pendingBroadcasts = sqlite
      .prepare("SELECT COUNT(*) AS c FROM settlement_broadcasts WHERE state = 'BROADCAST_PENDING'")
      .get() as { c: number };
    expect(pendingBroadcasts.c).toBe(rpcFailureCount);

    // 5. Double-entry ledger invariants pass globally
    const inv = await verifyLedgerInvariants(db);
    expect(inv.valid).toBe(true);
    expect(inv.unbalancedBatchIds).toEqual([]);
    expect(inv.negativeUserAccountCodes).toEqual([]);
    expect(inv.accountPostingDriftCodes).toEqual([]);
    expect(inv.periodEquation.driftUnits).toBe(0n);
    expect(results.length).toBe(TOTAL_CASES);

    sqlite.close();
  });
});
