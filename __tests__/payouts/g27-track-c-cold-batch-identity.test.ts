/**
 * @jest-environment node
 *
 * G27.C1 — Cold Batch Identity Model Validation Suite (Case A Invariant)
 *
 * Validates under full migrations 001–038:
 * 1. Two payouts sharing on-chain tx_hash with distinct operation_ids (Stellar multi-op & EVM ERC-20 multi-log Transfer)
 * 2. Two payouts attempting to share both tx_hash AND safe_multisig_tx_hash (fail-closed via Case A unique index)
 * 3. Same operation (network, tx_hash, operation_id) reused across different liabilities (payout_id)
 * 4. Duplicate evidence claims -> exact 1 cold_settlement_claims row and 1 WITHDRAWAL_FINALIZED batch
 * 5. Incorrect recipient or amount -> rejected without confirming broadcast or finalizing ledger
 * 6. Parallel confirmation across two isolates racing on the same cold payout / same operation claim
 * 7. Failed migration 038 with historical duplicate safe_multisig_tx_hash rows vs clean upgrade of valid batched rows
 * 8. Idempotent reconciliation via resolveColdSafeBroadcast and reconcilePendingSettlementBroadcasts
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  TurnkeySigner,
  type TurnkeySigningTransport,
} from '@/lib/payouts/turnkey-signer';
import {
  BroadcastRecoveryMachine,
  type StellarBroadcastTransport,
} from '@/lib/payouts/broadcast-recovery-machine';
import type { ArbitrumBaseUsdcAdapter } from '@/lib/payouts/adapters/arbitrum-base-usdc-adapter';
import type { ColdPaymentEvidence } from '@/lib/payouts/cold-payment-evidence';
import { reconcilePendingSettlementBroadcasts } from '@/lib/payouts/settlement-reconciler';
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

const STELLAR_COLD_SAFE = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const STELLAR_HOT_WALLET = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_USDC_ASSET = 'USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_NETWORK = 'stellar:public';
const STELLAR_RECIPIENT_A = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
const STELLAR_RECIPIENT_B = 'GBVFTZL5HIPT4PFQVTZVIWR77V7LWYCXU4CLYWWHHOEXB64XPG5LDMTU';

const EVM_COLD_SAFE_ARB = '0x2222222222222222222222222222222222222222';
const EVM_HOT_WALLET = '0x1111111111111111111111111111111111111111';
const ARB_USDC_CONTRACT = '0xaf88d065e77c8cc2239327c5edb3a432268e5831';
const EVM_RECIPIENT_A = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const EVM_RECIPIENT_B = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

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

async function seedTraderBalance(
  db: D1Database,
  ledger: DoubleEntryLedgerService,
  traderId: string,
  targetSettledUnits: bigint
): Promise<void> {
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
    idempotencyKey: `comm_${traderId}_${targetSettledUnits.toString()}`,
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
}

function createNoopTurnkeyTransport(): TurnkeySigningTransport {
  return {
    async signEvmDigest() {
      throw new Error('Hot EVM signing must not be called in cold batch tests');
    },
    async signStellarEnvelope() {
      throw new Error('Hot Stellar signing must not be called in cold batch tests');
    },
  };
}

function createTestSigner(): TurnkeySigner {
  return new TurnkeySigner({
    transport: createNoopTurnkeyTransport(),
    evmHotWalletAddress: EVM_HOT_WALLET,
    stellarHotWalletAddress: STELLAR_HOT_WALLET,
    safeColdMultisigAddresses: {
      stellar: STELLAR_COLD_SAFE,
      arbitrum: EVM_COLD_SAFE_ARB,
    },
  });
}

function createStellarColdTransport(
  evidenceByTxHash: Record<string, ColdPaymentEvidence>
): StellarBroadcastTransport {
  return {
    coldPaymentNetwork: STELLAR_NETWORK,
    coldPaymentAsset: STELLAR_USDC_ASSET,
    async getAccountSequence() {
      return '100';
    },
    async submitTransactionXdr() {
      throw new Error('Hot Stellar broadcast must not be called in cold batch tests');
    },
    async getTransactionStatus() {
      return { status: 'NOT_FOUND' };
    },
    async getColdPaymentEvidence(txHash: string): Promise<ColdPaymentEvidence> {
      const ev = evidenceByTxHash[txHash.toLowerCase()];
      if (!ev) throw new Error(`No Stellar cold evidence for ${txHash}`);
      return ev;
    },
  };
}

function createArbColdAdapter(
  evidenceByTxHash: Record<string, ColdPaymentEvidence>
): ArbitrumBaseUsdcAdapter {
  return {
    chain: 'arbitrum',
    chainId: 42161,
    usdcContractAddress: ARB_USDC_CONTRACT,
    async getColdPaymentEvidence(txHash: string): Promise<ColdPaymentEvidence> {
      const ev = evidenceByTxHash[txHash.toLowerCase()];
      if (!ev) throw new Error(`No Arbitrum cold evidence for ${txHash}`);
      return ev;
    },
  } as unknown as ArbitrumBaseUsdcAdapter;
}

async function lockAndEnqueueColdPayout(params: {
  db: D1Database;
  ledger: DoubleEntryLedgerService;
  signer: TurnkeySigner;
  payoutId: string;
  traderId: string;
  chain: 'stellar' | 'arbitrum';
  recipientAddress: string;
  amountUnits1e8: bigint;
}): Promise<{ lockBatchId: string; safeMultisigTxHash: string }> {
  const lock = await params.ledger.lockSettledForWithdrawal({
    idempotencyKey: `wd_lock_${params.payoutId}`,
    ownerType: 'trader',
    ownerId: params.traderId,
    amountUnits: params.amountUnits1e8,
    payoutId: params.payoutId,
    chain: params.chain,
  });

  const chainDecimals: 6 | 7 = params.chain === 'stellar' ? 7 : 6;
  const divisor = params.chain === 'stellar' ? 10n : 100n;
  const chainTokenUnits = (params.amountUnits1e8 / divisor).toString();

  const queued = await params.signer.enqueueColdSafeMultisig(params.db, {
    payoutId: params.payoutId,
    idempotencyKey: `idem_${params.payoutId}`,
    affiliateId: params.traderId,
    chain: params.chain,
    recipientAddress: params.recipientAddress,
    amountUnits1e8: params.amountUnits1e8,
    chainTokenUnits,
    chainDecimals,
    lockBatchId: lock.batch.id,
    reason: 'Exceeds single-tx hot wallet cap',
  });

  return {
    lockBatchId: lock.batch.id,
    safeMultisigTxHash: queued.safeMultisigTxHash,
  };
}

describe('G27.C1: Cold Batch Identity Model (Case A Validation)', () => {
  // --------------------------------------------------------------------------
  // 1. Two payouts sharing on-chain tx_hash with distinct operation_ids
  //    (both Stellar multi-op and EVM ERC-20 multi-log Transfer)
  // --------------------------------------------------------------------------
  it('1. settles two payouts sharing on-chain tx_hash with distinct operation_ids on both Stellar and EVM', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    try {
      const ledger = new DoubleEntryLedgerService(db);
      const signer = createTestSigner();

      // --- Stellar multi-op batch ---
      await seedTraderBalance(db, ledger, 'trader_s1', 50_000_000_000n); // $500
      await seedTraderBalance(db, ledger, 'trader_s2', 60_000_000_000n); // $600

      const s1 = await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_stellar_1',
        traderId: 'trader_s1',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT_A,
        amountUnits1e8: 50_000_000_000n,
      });
      const s2 = await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_stellar_2',
        traderId: 'trader_s2',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT_B,
        amountUnits1e8: 60_000_000_000n,
      });

      expect(s1.safeMultisigTxHash).not.toBe(s2.safeMultisigTxHash);

      const sharedStellarTxHash = 'a'.repeat(64);
      const stellarEvidence: ColdPaymentEvidence = {
        network: STELLAR_NETWORK,
        txHash: sharedStellarTxHash,
        blockReference: 'ledger:55000001',
        transfers: [
          {
            operationId: '1001',
            source: STELLAR_COLD_SAFE,
            recipient: STELLAR_RECIPIENT_A,
            asset: STELLAR_USDC_ASSET,
            amountUnits: 5_000_000_000n, // $500 at 7 decimals
          },
          {
            operationId: '1002',
            source: STELLAR_COLD_SAFE,
            recipient: STELLAR_RECIPIENT_B,
            asset: STELLAR_USDC_ASSET,
            amountUnits: 6_000_000_000n, // $600 at 7 decimals
          },
        ],
      };

      // --- EVM ERC-20 multi-log Transfer batch (Arbitrum) ---
      await seedTraderBalance(db, ledger, 'trader_e1', 40_000_000_000n); // $400
      await seedTraderBalance(db, ledger, 'trader_e2', 70_000_000_000n); // $700

      const e1 = await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_arb_1',
        traderId: 'trader_e1',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT_A,
        amountUnits1e8: 40_000_000_000n,
      });
      const e2 = await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_arb_2',
        traderId: 'trader_e2',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT_B,
        amountUnits1e8: 70_000_000_000n,
      });

      expect(e1.safeMultisigTxHash).not.toBe(e2.safeMultisigTxHash);

      const sharedEvmTxHash = `0x${'b'.repeat(64)}`;
      const arbEvidence: ColdPaymentEvidence = {
        network: 'eip155:42161',
        txHash: sharedEvmTxHash,
        blockReference: 'block:250000100',
        transfers: [
          {
            operationId: '12', // ERC-20 Transfer logIndex 12
            source: EVM_COLD_SAFE_ARB,
            recipient: EVM_RECIPIENT_A,
            asset: ARB_USDC_CONTRACT,
            amountUnits: 400_000_000n, // $400 at 6 decimals
          },
          {
            operationId: '15', // ERC-20 Transfer logIndex 15
            source: EVM_COLD_SAFE_ARB,
            recipient: EVM_RECIPIENT_B,
            asset: ARB_USDC_CONTRACT,
            amountUnits: 700_000_000n, // $700 at 6 decimals
          },
        ],
      };

      const machine = new BroadcastRecoveryMachine({
        db,
        turnkeySigner: signer,
        stellarTransport: createStellarColdTransport({ [sharedStellarTxHash]: stellarEvidence }),
        evmAdapters: {
          arbitrum: createArbColdAdapter({ [sharedEvmTxHash]: arbEvidence }),
        },
      });

      const resS1 = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_stellar_1',
        resolution: 'CONFIRMED',
        txHash: sharedStellarTxHash,
        operationId: '1001',
      });
      const resS2 = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_stellar_2',
        resolution: 'CONFIRMED',
        txHash: sharedStellarTxHash,
        operationId: '1002',
      });
      const resE1 = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_arb_1',
        resolution: 'CONFIRMED',
        txHash: sharedEvmTxHash,
        operationId: '12',
      });
      const resE2 = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_arb_2',
        resolution: 'CONFIRMED',
        txHash: sharedEvmTxHash,
        operationId: '15',
      });

      for (const r of [resS1, resS2, resE1, resE2]) {
        expect(r.state).toBe('CONFIRMED');
        expect(r.confirmation_lane).toBe('COLD');
      }
      expect(resS1.tx_hash).toBe(sharedStellarTxHash);
      expect(resS2.tx_hash).toBe(sharedStellarTxHash);
      expect(resE1.tx_hash).toBe(sharedEvmTxHash);
      expect(resE2.tx_hash).toBe(sharedEvmTxHash);

      const claims = sqlite
        .prepare('SELECT network, tx_hash, operation_id, payout_id FROM cold_settlement_claims ORDER BY payout_id')
        .all() as Array<{ network: string; tx_hash: string; operation_id: string; payout_id: string }>;
      expect(claims).toHaveLength(4);
      expect(claims).toEqual([
        { network: 'eip155:42161', tx_hash: sharedEvmTxHash, operation_id: '12', payout_id: 'cold_arb_1' },
        { network: 'eip155:42161', tx_hash: sharedEvmTxHash, operation_id: '15', payout_id: 'cold_arb_2' },
        { network: STELLAR_NETWORK, tx_hash: sharedStellarTxHash, operation_id: '1001', payout_id: 'cold_stellar_1' },
        { network: STELLAR_NETWORK, tx_hash: sharedStellarTxHash, operation_id: '1002', payout_id: 'cold_stellar_2' },
      ]);

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  // --------------------------------------------------------------------------
  // 2. Two payouts attempting to share both tx_hash AND safe_multisig_tx_hash
  // --------------------------------------------------------------------------
  it('2. rejects two payouts attempting to share safe_multisig_tx_hash (Case A fail-closed invariant)', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    try {
      const ledger = new DoubleEntryLedgerService(db);
      const signer = createTestSigner();
      await seedTraderBalance(db, ledger, 'trader_c1', 50_000_000_000n);
      await seedTraderBalance(db, ledger, 'trader_c2', 50_000_000_000n);

      const p1 = await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_case_a_1',
        traderId: 'trader_c1',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT_A,
        amountUnits1e8: 50_000_000_000n,
      });

      const lock2 = await ledger.lockSettledForWithdrawal({
        idempotencyKey: 'wd_lock_cold_case_a_2',
        ownerType: 'trader',
        ownerId: 'trader_c2',
        amountUnits: 50_000_000_000n,
        payoutId: 'cold_case_a_2',
        chain: 'arbitrum',
      });

      const sharedTxHash = `0x${'c'.repeat(64)}`;

      // Attempting to insert a second payout with the same safe_multisig_tx_hash (e.g. Safe MultiSend)
      // MUST fail closed on idx_settlement_broadcasts_unique_safe_tx_hash.
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO settlement_broadcasts (
               payout_id, idempotency_key, affiliate_id, chain, recipient_address,
               amount_units_1e8, chain_token_units, chain_decimals, state,
               signer_address, lock_batch_id, safe_multisig_tx_hash, signing_lane, tx_hash
             ) VALUES (?, ?, ?, 'arbitrum', ?, ?, '500000000', 6, 'QUEUED_COLD_SAFE', ?, ?, ?, 'COLD', ?)`
          )
          .run(
            'cold_case_a_2',
            'idem_cold_case_a_2',
            'trader_c2',
            EVM_RECIPIENT_B,
            50_000_000_000,
            EVM_COLD_SAFE_ARB,
            lock2.batch.id,
            p1.safeMultisigTxHash,
            sharedTxHash
          )
      ).toThrow(/UNIQUE constraint failed/i);

      // Case-insensitive / whitespace-padded variant must also be rejected
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO settlement_broadcasts (
               payout_id, idempotency_key, affiliate_id, chain, recipient_address,
               amount_units_1e8, chain_token_units, chain_decimals, state,
               signer_address, lock_batch_id, safe_multisig_tx_hash, signing_lane, tx_hash
             ) VALUES (?, ?, ?, 'arbitrum', ?, ?, '500000000', 6, 'QUEUED_COLD_SAFE', ?, ?, ?, 'COLD', ?)`
          )
          .run(
            'cold_case_a_2',
            'idem_cold_case_a_2',
            'trader_c2',
            EVM_RECIPIENT_B,
            50_000_000_000,
            EVM_COLD_SAFE_ARB,
            lock2.batch.id,
            `  ${p1.safeMultisigTxHash.toUpperCase()}  `,
            sharedTxHash
          )
      ).toThrow(/UNIQUE constraint failed/i);
    } finally {
      sqlite.close();
    }
  });

  // --------------------------------------------------------------------------
  // 3. Same operation (network, tx_hash, operation_id) reused across different liabilities
  // --------------------------------------------------------------------------
  it('3. rejects reusing the same (network, tx_hash, operation_id) across different payouts', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    try {
      const ledger = new DoubleEntryLedgerService(db);
      const signer = createTestSigner();
      await seedTraderBalance(db, ledger, 'trader_r1', 30_000_000_000n);
      await seedTraderBalance(db, ledger, 'trader_r2', 30_000_000_000n);

      await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_reuse_1',
        traderId: 'trader_r1',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT_A,
        amountUnits1e8: 30_000_000_000n,
      });
      await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_reuse_2',
        traderId: 'trader_r2',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT_A, // same recipient & amount
        amountUnits1e8: 30_000_000_000n,
      });

      const txHash = 'd'.repeat(64);
      const evidence: ColdPaymentEvidence = {
        network: STELLAR_NETWORK,
        txHash,
        blockReference: 'ledger:55000002',
        transfers: [
          {
            operationId: '2001',
            source: STELLAR_COLD_SAFE,
            recipient: STELLAR_RECIPIENT_A,
            asset: STELLAR_USDC_ASSET,
            amountUnits: 3_000_000_000n,
          },
        ],
      };

      const machine = new BroadcastRecoveryMachine({
        db,
        turnkeySigner: signer,
        stellarTransport: createStellarColdTransport({ [txHash]: evidence }),
      });

      const first = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_reuse_1',
        resolution: 'CONFIRMED',
        txHash,
        operationId: '2001',
      });
      expect(first.state).toBe('CONFIRMED');

      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'cold_reuse_2',
          resolution: 'CONFIRMED',
          txHash,
          operationId: '2001',
        })
      ).rejects.toThrow(/already used by another payout/i);

      const secondRow = sqlite
        .prepare('SELECT state, tx_hash, confirmation_lane FROM settlement_broadcasts WHERE payout_id = ?')
        .get('cold_reuse_2') as { state: string; tx_hash: string | null; confirmation_lane: string | null };
      expect(secondRow.state).toBe('QUEUED_COLD_SAFE');
      expect(secondRow.tx_hash).toBeNull();
      expect(secondRow.confirmation_lane).toBeNull();

      const finalizedCount = (
        sqlite
          .prepare("SELECT COUNT(*) AS cnt FROM ledger_journal_batches WHERE journal_type = 'WITHDRAWAL_FINALIZED'")
          .get() as { cnt: number }
      ).cnt;
      expect(finalizedCount).toBe(1);

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  // --------------------------------------------------------------------------
  // 4. Duplicate evidence claims -> exact 1 claim row and 1 WITHDRAWAL_FINALIZED batch
  // --------------------------------------------------------------------------
  it('4. blocks duplicate evidence claims with exact 1 cold_settlement_claims row and 1 WITHDRAWAL_FINALIZED batch', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    try {
      const ledger = new DoubleEntryLedgerService(db);
      const signer = createTestSigner();
      await seedTraderBalance(db, ledger, 'trader_dup', 35_000_000_000n);

      await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_dup_1',
        traderId: 'trader_dup',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT_A,
        amountUnits1e8: 35_000_000_000n,
      });

      const txHash1 = `0x${'e'.repeat(64)}`;
      const txHash2 = `0x${'f'.repeat(64)}`;
      const adapter = createArbColdAdapter({
        [txHash1]: {
          network: 'eip155:42161',
          txHash: txHash1,
          blockReference: 'block:250000200',
          transfers: [
            {
              operationId: '7',
              source: EVM_COLD_SAFE_ARB,
              recipient: EVM_RECIPIENT_A,
              asset: ARB_USDC_CONTRACT,
              amountUnits: 350_000_000n,
            },
          ],
        },
        [txHash2]: {
          network: 'eip155:42161',
          txHash: txHash2,
          blockReference: 'block:250000201',
          transfers: [
            {
              operationId: '8',
              source: EVM_COLD_SAFE_ARB,
              recipient: EVM_RECIPIENT_A,
              asset: ARB_USDC_CONTRACT,
              amountUnits: 350_000_000n,
            },
          ],
        },
      });

      const machine = new BroadcastRecoveryMachine({
        db,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: adapter },
      });

      const res = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_dup_1',
        resolution: 'CONFIRMED',
        txHash: txHash1,
        operationId: '7',
      });
      expect(res.state).toBe('CONFIRMED');

      // Attempting to attach a different txHash / operationId to the same payout must fail closed
      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'cold_dup_1',
          resolution: 'CONFIRMED',
          txHash: txHash2,
          operationId: '8',
        })
      ).rejects.toThrow(/already has a claim for a different transaction or operationId/i);

      const claimCount = (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM cold_settlement_claims').get() as { cnt: number }
      ).cnt;
      const finalizedCount = (
        sqlite
          .prepare("SELECT COUNT(*) AS cnt FROM ledger_journal_batches WHERE journal_type = 'WITHDRAWAL_FINALIZED'")
          .get() as { cnt: number }
      ).cnt;
      expect(claimCount).toBe(1);
      expect(finalizedCount).toBe(1);

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  // --------------------------------------------------------------------------
  // 5. Incorrect recipient or amount -> rejected without confirming or finalizing
  // --------------------------------------------------------------------------
  it('5. rejects incorrect recipient or incorrect amount without confirming broadcast or finalizing ledger', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    try {
      const ledger = new DoubleEntryLedgerService(db);
      const signer = createTestSigner();
      await seedTraderBalance(db, ledger, 'trader_bad', 45_000_000_000n);

      await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_bad_1',
        traderId: 'trader_bad',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT_A,
        amountUnits1e8: 45_000_000_000n, // $450 -> 450_000_000 at 6 dec
      });

      const wrongRecipientTx = `0x${'1'.repeat(64)}`;
      const wrongAmountTx = `0x${'2'.repeat(64)}`;
      const adapter = createArbColdAdapter({
        [wrongRecipientTx]: {
          network: 'eip155:42161',
          txHash: wrongRecipientTx,
          blockReference: 'block:250000300',
          transfers: [
            {
              operationId: '1',
              source: EVM_COLD_SAFE_ARB,
              recipient: EVM_RECIPIENT_B, // wrong recipient
              asset: ARB_USDC_CONTRACT,
              amountUnits: 450_000_000n,
            },
          ],
        },
        [wrongAmountTx]: {
          network: 'eip155:42161',
          txHash: wrongAmountTx,
          blockReference: 'block:250000301',
          transfers: [
            {
              operationId: '2',
              source: EVM_COLD_SAFE_ARB,
              recipient: EVM_RECIPIENT_A,
              asset: ARB_USDC_CONTRACT,
              amountUnits: 449_000_000n, // wrong amount ($449 instead of $450)
            },
          ],
        },
      });

      const machine = new BroadcastRecoveryMachine({
        db,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: adapter },
      });

      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'cold_bad_1',
          resolution: 'CONFIRMED',
          txHash: wrongRecipientTx,
          operationId: '1',
        })
      ).rejects.toThrow(/recipient does not match/i);

      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'cold_bad_1',
          resolution: 'CONFIRMED',
          txHash: wrongAmountTx,
          operationId: '2',
        })
      ).rejects.toThrow(/does not match expected chain token units/i);

      const row = sqlite
        .prepare('SELECT state, tx_hash, confirmation_lane FROM settlement_broadcasts WHERE payout_id = ?')
        .get('cold_bad_1') as { state: string; tx_hash: string | null; confirmation_lane: string | null };
      expect(row.state).toBe('QUEUED_COLD_SAFE');
      expect(row.tx_hash).toBeNull();
      expect(row.confirmation_lane).toBeNull();

      const claimCount = (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM cold_settlement_claims').get() as { cnt: number }
      ).cnt;
      const finalizedCount = (
        sqlite
          .prepare("SELECT COUNT(*) AS cnt FROM ledger_journal_batches WHERE journal_type = 'WITHDRAWAL_FINALIZED'")
          .get() as { cnt: number }
      ).cnt;
      expect(claimCount).toBe(0);
      expect(finalizedCount).toBe(0);

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  // --------------------------------------------------------------------------
  // 6. Parallel confirmation across two isolates racing on same payout / claim
  // --------------------------------------------------------------------------
  it('6. handles parallel confirmation across two isolates with zero double-finalization', async () => {
    const { sqlite, db: dbA } = createFullSchemaUpTo038();
    try {
      const dbB = new SqliteD1Adapter(sqlite) as unknown as D1Database;
      const ledger = new DoubleEntryLedgerService(dbA);
      const signer = createTestSigner();
      await seedTraderBalance(dbA, ledger, 'trader_race', 55_000_000_000n);

      await lockAndEnqueueColdPayout({
        db: dbA,
        ledger,
        signer,
        payoutId: 'cold_race_1',
        traderId: 'trader_race',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT_A,
        amountUnits1e8: 55_000_000_000n,
      });

      const txHash = '3'.repeat(64);
      const evidence: ColdPaymentEvidence = {
        network: STELLAR_NETWORK,
        txHash,
        blockReference: 'ledger:55000010',
        transfers: [
          {
            operationId: '9001',
            source: STELLAR_COLD_SAFE,
            recipient: STELLAR_RECIPIENT_A,
            asset: STELLAR_USDC_ASSET,
            amountUnits: 5_500_000_000n,
          },
        ],
      };

      const machineA = new BroadcastRecoveryMachine({
        db: dbA,
        turnkeySigner: signer,
        stellarTransport: createStellarColdTransport({ [txHash]: evidence }),
      });
      const machineB = new BroadcastRecoveryMachine({
        db: dbB,
        turnkeySigner: signer,
        stellarTransport: createStellarColdTransport({ [txHash]: evidence }),
      });

      const results = await Promise.allSettled([
        machineA.resolveColdSafeBroadcast({
          payoutId: 'cold_race_1',
          resolution: 'CONFIRMED',
          txHash,
          operationId: '9001',
        }),
        machineB.resolveColdSafeBroadcast({
          payoutId: 'cold_race_1',
          resolution: 'CONFIRMED',
          txHash,
          operationId: '9001',
        }),
      ]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled.length).toBeGreaterThanOrEqual(1);

      const claimCount = (
        sqlite.prepare('SELECT COUNT(*) AS cnt FROM cold_settlement_claims').get() as { cnt: number }
      ).cnt;
      const finalizedCount = (
        sqlite
          .prepare("SELECT COUNT(*) AS cnt FROM ledger_journal_batches WHERE journal_type = 'WITHDRAWAL_FINALIZED'")
          .get() as { cnt: number }
      ).cnt;
      expect(claimCount).toBe(1);
      expect(finalizedCount).toBe(1);

      const row = sqlite
        .prepare('SELECT state, tx_hash, confirmation_lane FROM settlement_broadcasts WHERE payout_id = ?')
        .get('cold_race_1') as { state: string; tx_hash: string; confirmation_lane: string };
      expect(row.state).toBe('CONFIRMED');
      expect(row.tx_hash).toBe(txHash);
      expect(row.confirmation_lane).toBe('COLD');

      const invariants = await verifyLedgerInvariants(dbA);
      expect(invariants.valid).toBe(true);
    } finally {
      sqlite.close();
    }
  });

  // --------------------------------------------------------------------------
  // 7. Failed migration with historical duplicate safe_multisig_tx_hash rows
  //    AND clean upgrade of valid historical batched cold rows
  // --------------------------------------------------------------------------
  it('7. fails migration 038 loudly on duplicate historical safe_multisig_tx_hash and upgrades valid batched cold rows cleanly', () => {
    // 7a: Pre-038 DB with duplicate non-empty safe_multisig_tx_hash MUST fail loudly on 038
    const badDb = createFullSchemaUpTo037();
    try {
      const sharedSafeHash = 'safe_2of3_duplicate_historical_proposal_000001';
      badDb
        .prepare(
          `INSERT INTO settlement_broadcasts (
             payout_id, idempotency_key, affiliate_id, chain, recipient_address,
             amount_units_1e8, chain_token_units, chain_decimals, state,
             signer_address, safe_multisig_tx_hash, signing_lane
           ) VALUES
             ('hist_dup_1', 'idem_hd1', 'aff_1', 'arbitrum', ?, 30000000000, '300000000', 6, 'QUEUED_COLD_SAFE', ?, ?, 'COLD'),
             ('hist_dup_2', 'idem_hd2', 'aff_2', 'arbitrum', ?, 40000000000, '400000000', 6, 'QUEUED_COLD_SAFE', ?, ?, 'COLD')`
        )
        .run(
          EVM_RECIPIENT_A,
          EVM_COLD_SAFE_ARB,
          sharedSafeHash,
          EVM_RECIPIENT_B,
          EVM_COLD_SAFE_ARB,
          sharedSafeHash
        );

      expect(() => badDb.exec(readMigration('038_cold_finality_parity.sql'))).toThrow(
        /UNIQUE constraint failed/i
      );
    } finally {
      badDb.close();
    }

    // 7b: Pre-038 DB with valid historical batched cold rows (shared tx_hash, distinct safe_multisig_tx_hash)
    // MUST upgrade cleanly under 038.
    const goodDb = createFullSchemaUpTo037();
    try {
      const sharedTxHash = `0x${'9'.repeat(64)}`;
      const observedAt = Math.floor(Date.now() / 1000) - 60;
      goodDb
        .prepare(
          `INSERT INTO settlement_broadcasts (
             payout_id, idempotency_key, affiliate_id, chain, recipient_address,
             amount_units_1e8, chain_token_units, chain_decimals, state,
             signer_address, safe_multisig_tx_hash, signing_lane, tx_hash,
             confirmation_lane, confirmation_observed_at
           ) VALUES
             ('hist_batch_1', 'idem_hb1', 'aff_1', 'arbitrum', ?, 30000000000, '300000000', 6, 'CONFIRMED', ?, 'safe_2of3_distinct_001', 'COLD', ?, 'COLD', ?),
             ('hist_batch_2', 'idem_hb2', 'aff_2', 'arbitrum', ?, 40000000000, '400000000', 6, 'CONFIRMED', ?, 'safe_2of3_distinct_002', 'COLD', ?, 'COLD', ?)`
        )
        .run(
          EVM_RECIPIENT_A,
          EVM_COLD_SAFE_ARB,
          sharedTxHash,
          observedAt,
          EVM_RECIPIENT_B,
          EVM_COLD_SAFE_ARB,
          sharedTxHash,
          observedAt
        );

      expect(() => goodDb.exec(readMigration('038_cold_finality_parity.sql'))).not.toThrow();

      const rows = goodDb
        .prepare('SELECT payout_id, tx_hash, safe_multisig_tx_hash, state FROM settlement_broadcasts ORDER BY payout_id')
        .all() as Array<{ payout_id: string; tx_hash: string; safe_multisig_tx_hash: string; state: string }>;
      expect(rows).toHaveLength(2);
      expect(rows[0].tx_hash).toBe(sharedTxHash);
      expect(rows[1].tx_hash).toBe(sharedTxHash);
      expect(rows[0].safe_multisig_tx_hash).not.toBe(rows[1].safe_multisig_tx_hash);
    } finally {
      goodDb.close();
    }
  });

  // --------------------------------------------------------------------------
  // 8. Idempotent reconciliation -> safe no-op with zero duplicate ledger batches
  // --------------------------------------------------------------------------
  it('8. re-running resolveColdSafeBroadcast and reconcilePendingSettlementBroadcasts on confirmed cold payouts is a safe no-op', async () => {
    const { sqlite, db } = createFullSchemaUpTo038();
    try {
      const ledger = new DoubleEntryLedgerService(db);
      const signer = createTestSigner();
      await seedTraderBalance(db, ledger, 'trader_idem', 65_000_000_000n);

      await lockAndEnqueueColdPayout({
        db,
        ledger,
        signer,
        payoutId: 'cold_idem_1',
        traderId: 'trader_idem',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT_A,
        amountUnits1e8: 65_000_000_000n,
      });

      const txHash = '7'.repeat(64);
      const evidence: ColdPaymentEvidence = {
        network: STELLAR_NETWORK,
        txHash,
        blockReference: 'ledger:55000020',
        transfers: [
          {
            operationId: '7001',
            source: STELLAR_COLD_SAFE,
            recipient: STELLAR_RECIPIENT_A,
            asset: STELLAR_USDC_ASSET,
            amountUnits: 6_500_000_000n,
          },
        ],
      };

      const machine = new BroadcastRecoveryMachine({
        db,
        turnkeySigner: signer,
        stellarTransport: createStellarColdTransport({ [txHash]: evidence }),
      });

      const first = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_idem_1',
        resolution: 'CONFIRMED',
        txHash,
        operationId: '7001',
      });
      expect(first.state).toBe('CONFIRMED');

      // Re-run resolveColdSafeBroadcast -> safe no-op, zero trigger errors
      const second = await machine.resolveColdSafeBroadcast({
        payoutId: 'cold_idem_1',
        resolution: 'CONFIRMED',
        txHash,
        operationId: '7001',
      });
      expect(second.state).toBe('CONFIRMED');
      expect(second.tx_hash).toBe(txHash);
      expect(second.confirmation_observed_at).toBe(first.confirmation_observed_at);

      // Re-run reconcilePendingSettlementBroadcasts -> safe no-op
      const summary = await reconcilePendingSettlementBroadcasts(db, { machine });
      expect(summary.errors).toEqual([]);
      expect(summary.confirmed).toBe(0);
      expect(summary.reverted).toBe(0);

      const finalizedCount = (
        sqlite
          .prepare("SELECT COUNT(*) AS cnt FROM ledger_journal_batches WHERE journal_type = 'WITHDRAWAL_FINALIZED'")
          .get() as { cnt: number }
      ).cnt;
      expect(finalizedCount).toBe(1);

      const invariants = await verifyLedgerInvariants(db);
      expect(invariants.valid).toBe(true);
    } finally {
      sqlite.close();
    }
  });
});
