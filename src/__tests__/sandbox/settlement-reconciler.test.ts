/**
 * @jest-environment node
 *
 * Passive Settlement Broadcast Reconciler Suite (Audit Finding G7):
 * - Automatically reconciles uncertain `BROADCAST_PENDING` settlement rows via
 *   on-chain receipt lookup (`reexecuteExpired: false` — never autonomously re-broadcasting).
 * - Finalizes the matching `WITHDRAWAL_LOCK` via `DoubleEntryLedgerService.finalizeWithdrawal`
 *   when Horizon / EVM RPC confirms the transaction.
 * - Reverts the matching `WITHDRAWAL_LOCK` via `DoubleEntryLedgerService.revertWithdrawal`
 *   when an expired Stellar timebound or reverted EVM receipt proves the broadcast dropped/failed,
 *   while refusing to re-sign or re-broadcast autonomously.
 * - Leaves `BROADCAST_PENDING` rows and `WITHDRAWAL_LOCK` batches untouched while still within
 *   in-flight indexing / Stellar `timebounds_max_unix` bounds.
 */

import { withPayoutEffect } from '@/lib/payouts/payout-effect-fence';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, parseTransaction, type Hex } from 'viem';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  setEmergencyLedgerFreeze,
  storeEvidenceObject,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  ArbitrumBaseUsdcAdapter,
  BroadcastRecoveryMachine,
  CIRCLE_IS_BLACKLISTED_SELECTOR,
  HorizonStellarBroadcastTransport,
  TurnkeySigner,
  attachEd25519SignatureToStellarEnvelopeXdr,
  reconcilePendingSettlementBroadcasts,
  type EvmJsonRpcTransport,
  type StellarBroadcastTransport,
  type StellarEnvelopeSignature,
  type StellarHorizonTxLookupResult,
  type TurnkeySigningTransport,
} from '@/lib/payouts';
import { StellarNetwork, type StellarService } from '@/lib/payouts/stellar-service';

const nativeNodeModule = (
  process as unknown as { getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire } }
).getBuiltinModule('module');
const StellarSdk = nativeNodeModule.createRequire(__filename)(
  '@stellar/stellar-sdk'
) as typeof StellarSdkTypes;

const STELLAR_KEYPAIR = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 0x33));
const STELLAR_HOT_ADDR = STELLAR_KEYPAIR.publicKey();
const STELLAR_RECIPIENT_ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const EVM_HOT_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EVM_RECIPIENT_ADDR = '0x0000000000000000000000000000000000001001';

class CountingMultiChainSigningTransport implements TurnkeySigningTransport {
  public evmSignCount = 0;
  public stellarSignCount = 0;
  private readonly evmKeyHex = '22'.repeat(32);

  async signEvmDigest(params: {
    chain: 'arbitrum' | 'base';
    signerAddress: string;
    digestHex: Hex;
    payoutId: string;
  }) {
    this.evmSignCount += 1;
    const sig = secp256k1.sign(params.digestHex.slice(2), this.evmKeyHex);
    return {
      r: `0x${sig.r.toString(16).padStart(64, '0')}` as Hex,
      s: `0x${sig.s.toString(16).padStart(64, '0')}` as Hex,
      yParity: (sig.recovery === 1 ? 1 : 0) as 0 | 1,
      activityId: `tk_evm_${params.payoutId}_${this.evmSignCount}`,
    };
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    this.stellarSignCount += 1;
    const txHashBytes = Buffer.from(params.txHashHex.replace(/^0x/i, ''), 'hex');
    const sigBytes = Buffer.from(STELLAR_KEYPAIR.sign(txHashBytes));
    const signedEnvelopeXdr = attachEd25519SignatureToStellarEnvelopeXdr({
      signerAddress: params.signerAddress,
      unsignedEnvelopeXdr: params.unsignedEnvelopeXdr,
      sigBytes,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });
    return {
      signedEnvelopeXdr,
      signatureBase64: sigBytes.toString('base64'),
      txHash: params.txHashHex.replace(/^0x/, ''),
      activityId: `tk_xlm_${params.payoutId}_${this.stellarSignCount}`,
    };
  }
}

class AuditingPassiveEvmRpc implements EvmJsonRpcTransport {
  public sendRawTxCount = 0;
  public readonly receiptByHash = new Map<
    string,
    { status: '0x1' | '0x0'; blockNumber: string }
  >();
  private nextNonce = 0;

  async call<T>(method: string, params: unknown[] = []): Promise<T> {
    if (method === 'eth_call') {
      const txObj = (params[0] ?? {}) as { data?: string };
      const data = (txObj.data ?? '').toLowerCase();
      if (data.startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR)) {
        return (`0x${'0'.repeat(64)}` as unknown) as T;
      }
      return (`0x${'0'.repeat(63)}1` as unknown) as T;
    }
    if (method === 'eth_estimateGas') {
      return ('0xfde8' as unknown) as T;
    }
    if (method === 'eth_gasPrice') {
      return ('0x5f5e100' as unknown) as T;
    }
    if (method === 'eth_maxPriorityFeePerGas') {
      return ('0x989680' as unknown) as T;
    }
    if (method === 'eth_getTransactionCount') {
      return (`0x${this.nextNonce.toString(16)}` as unknown) as T;
    }
    if (method === 'eth_sendRawTransaction') {
      this.sendRawTxCount += 1;
      const rawTxHex = String(params[0]) as Hex;
      const parsed = parseTransaction(rawTxHex);
      this.nextNonce = Math.max(this.nextNonce, Number(parsed.nonce ?? 0) + 1);
      throw new Error('504 Gateway Timeout: Arbitrum sequencer timeout after submit');
    }
    if (method === 'eth_getTransactionReceipt') {
      const hash = String(params[0] ?? '').toLowerCase();
      const found = this.receiptByHash.get(hash);
      if (!found) {
        return (null as unknown) as T;
      }
      return ({
        status: found.status,
        blockNumber: found.blockNumber,
        gasUsed: '0xc350',
        effectiveGasPrice: '0x5f5e100',
      } as unknown) as T;
    }
    throw new Error(`Unsupported RPC method in passive EVM test: ${method}`);
  }
}

class CountingStellarSigningTransport implements TurnkeySigningTransport {
  public signCount = 0;

  async signEvmDigest(): Promise<never> {
    throw new Error('EVM signing not expected in Stellar reconciler suite');
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    this.signCount += 1;
    const txHashBytes = Buffer.from(params.txHashHex.replace(/^0x/i, ''), 'hex');
    const sigBytes = Buffer.from(STELLAR_KEYPAIR.sign(txHashBytes));
    const signedEnvelopeXdr = attachEd25519SignatureToStellarEnvelopeXdr({
      signerAddress: params.signerAddress,
      unsignedEnvelopeXdr: params.unsignedEnvelopeXdr,
      sigBytes,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });
    return {
      signedEnvelopeXdr,
      signatureBase64: sigBytes.toString('base64'),
      txHash: params.txHashHex.replace(/^0x/, ''),
      activityId: `tk_xlm_${params.payoutId}_${this.signCount}`,
    };
  }
}

describe('Passive Settlement Broadcast Reconciler (G7)', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;

  beforeEach(async () => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    const migDir = path.resolve(process.cwd(), 'src/database/migrations');
    for (const file of [
      '001_initial_schema_d1.sql',
      '002_auth_tables.sql',
      '003_affiliate_schema.sql',
      '009_tracking_optimization.sql',
      '020_billing_mobile_enhancements.sql',
      '024_kyc_compliance_schema.sql',
      '028_ascendancy_audit_core.sql',
      '031_ascendancy_phase2_ui_and_poller.sql',
      '033_cold_settlement_claims.sql',
      '034_withdrawal_freeze_at_write.sql',
      '035_payout_effect_grants.sql', '036_durable_hot_exposure.sql',
    ]) {
      sqlite.exec(fs.readFileSync(path.join(migDir, file), 'utf8'));
    }

    sqlite
      .prepare(
        `INSERT INTO profiles (id, email, full_name, role, referral_code, wallet_address, preferred_chain)
         VALUES
           ('trader_u1', 'trader1@proton.me', 'Trader One', 'shopper', 'TRD1', NULL, NULL),
           ('aff_l1', 'partner1@agency.io', 'Partner Desk', 'affiliate', 'AFF1', ?, 'stellar')`
      )
      .run(STELLAR_RECIPIENT_ADDR);

    db = new SqliteD1Adapter(sqlite);
    r2 = new InMemoryR2Bucket();

    const ledger = new DoubleEntryLedgerService(db);
    const partnerEv = await storeEvidenceObject(db, r2, {
      exchange: 'bybit',
      sourceKind: 'rest_poll',
      rawBytes: '{"seed":true}',
      statementPeriodStart: '2026-11-01T00:00:00Z',
      statementPeriodEnd: '2026-11-01T23:59:59Z',
    });
    const walletEv = await storeEvidenceObject(db, r2, {
      exchange: 'bybit',
      sourceKind: 'wallet_statement',
      rawBytes: '{"wallet":true}',
      statementPeriodStart: '2026-11-01T00:00:00Z',
      statementPeriodEnd: '2026-11-01T23:59:59Z',
    });
    const grossSeed = parseUsdToLedgerUnits('2000.00');
    const recon = await reconcilePartnerCashBatch(db, {
      exchange: 'bybit',
      evidenceId: partnerEv.id,
      walletEvidenceId: walletEv.id,
      uidAllocatedUnits: grossSeed,
      walletCashCollectedUnits: grossSeed,
      r2,
    });
    const b1 = await ledger.recordVerifiedCommissionInflight({
      idempotencyKey: 'seed_reconciler_1',
      exchange: 'bybit',
      traderUid: 'uid_seed_1',
      traderId: 'trader_u1',
      l1AffiliateId: 'aff_l1',
      reconciliationId: recon.id,
      evidenceId: partnerEv.id,
      grossCommissionUnits: grossSeed, // L1 settled = $285.00
      createdAt: '2026-11-01T00:00:00.000Z',
      r2,
    });
    await ledger.releaseMaturedInflightBatch(b1.batch.id, '2026-11-10T00:00:00.000Z');
  });

  afterEach(async () => {
    delete (globalThis as unknown as { SETTLEMENT_MACHINE?: unknown }).SETTLEMENT_MACHINE;
    if (db) {
      await db.close();
    }
  });

  function createStellarHarness(): {
    machine: BroadcastRecoveryMachine;
    signerTransport: CountingStellarSigningTransport;
    txStatuses: Map<string, StellarHorizonTxLookupResult>;
    clock: { nowUnix: number };
  } {
    const txStatuses = new Map<string, StellarHorizonTxLookupResult>();
    const signerTransport = new CountingStellarSigningTransport();
    const clock = { nowUnix: 1_795_000_000 };

    const mockStellarService = {
      hasUsdcTrustline: async () => true,
      getAccount: async () => ({
        accountId: STELLAR_HOT_ADDR,
        sequence: '5000',
        balances: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        exists: true,
      }),
      getTransaction: async () => null,
    } as unknown as StellarService;

    const realTransport = new HorizonStellarBroadcastTransport({
      network: StellarNetwork.TESTNET,
      stellarService: mockStellarService,
    });

    const stellarTransport: StellarBroadcastTransport = {
      hasUsdcTrustline: (addr) => realTransport.hasUsdcTrustline(addr),
      getAccountSequence: (addr) => realTransport.getAccountSequence(addr),
      buildUnsignedUsdcPayment: (p) => realTransport.buildUnsignedUsdcPayment(p),
      async submitSignedTransaction({ db, payoutId, workflow, effect, signedEnvelopeXdr, expectedTxHash }) {
        return withPayoutEffect({ db, payoutId, workflow, effect, payload: signedEnvelopeXdr, expectedHash: expectedTxHash }, async () => {
          throw new Error('Horizon 504 Gateway Timeout after submit');
        });
      },
      async lookupTransaction(txHash: string) {
        return txStatuses.get(txHash) ?? { found: false, successful: false };
      },
    };

    const machine = new BroadcastRecoveryMachine({
      db: db as unknown as LegacyD1Database,
      turnkeySigner: new TurnkeySigner({
        transport: signerTransport,
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_ADDR,
      }),
      evmAdapters: {},
      stellarTransport,
      nowUnixProvider: () => clock.nowUnix,
    });

    return { machine, signerTransport, txStatuses, clock };
  }

  it('passively finalizes CONFIRMED broadcasts, retains expired broadcasts without re-signing, and preserves still-pending rows', async () => {
    const ledger = new DoubleEntryLedgerService(db);
    const signerTransport = new CountingStellarSigningTransport();

    const txStatuses = new Map<string, StellarHorizonTxLookupResult>();
    const mockStellarService = {
      hasUsdcTrustline: async () => true,
      getAccount: async () => ({
        accountId: STELLAR_HOT_ADDR,
        sequence: '5000',
        balances: [],
        thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
        exists: true,
      }),
      getTransaction: async () => null,
    } as unknown as StellarService;

    const realTransport = new HorizonStellarBroadcastTransport({
      network: StellarNetwork.TESTNET,
      stellarService: mockStellarService,
    });

    const stellarTransport: StellarBroadcastTransport = {
      hasUsdcTrustline: (addr) => realTransport.hasUsdcTrustline(addr),
      getAccountSequence: (addr) => realTransport.getAccountSequence(addr),
      buildUnsignedUsdcPayment: (p) => realTransport.buildUnsignedUsdcPayment(p),
      async submitSignedTransaction({ db, payoutId, workflow, effect, signedEnvelopeXdr, expectedTxHash }) {
        return withPayoutEffect({ db, payoutId, workflow, effect, payload: signedEnvelopeXdr, expectedHash: expectedTxHash }, async () => {
          throw new Error('Horizon 504 Gateway Timeout after submit');
        });
      },
      async lookupTransaction(txHash: string) {
        return (
          txStatuses.get(txHash) ?? {
            found: false,
            successful: false,
          }
        );
      },
    };

    let simulatedNowUnix = 1_795_000_000;
    const machine = new BroadcastRecoveryMachine({
      db: db as unknown as LegacyD1Database,
      turnkeySigner: new TurnkeySigner({
        transport: signerTransport,
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_ADDR,
      }),
      evmAdapters: {},
      stellarTransport,
      nowUnixProvider: () => simulatedNowUnix,
    });

    // Create 3 withdrawal locks + 3 timed-out Stellar broadcasts (`BROADCAST_PENDING`)
    const lockConfirmed = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_conf_1',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('50.00'),
      payoutId: 'po_conf_1',
    });
    const bcastConfirmed = await machine.executeSettlement({
      payoutId: 'po_conf_1',
      idempotencyKey: 'wd_lock_conf_1',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('50.00'),
      lockBatchId: lockConfirmed.batch.id,
      nowUnix: simulatedNowUnix,
    });
    expect(bcastConfirmed.state).toBe('BROADCAST_PENDING');

    const lockDropped = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_drop_1',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('60.00'),
      payoutId: 'po_drop_1',
    });
    const bcastDropped = await machine.executeSettlement({
      payoutId: 'po_drop_1',
      idempotencyKey: 'wd_lock_drop_1',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('60.00'),
      lockBatchId: lockDropped.batch.id,
      nowUnix: simulatedNowUnix,
    });
    expect(bcastDropped.state).toBe('BROADCAST_PENDING');

    const lockPending = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_pend_1',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('40.00'),
      payoutId: 'po_pend_1',
    });
    const bcastPending = await machine.executeSettlement({
      payoutId: 'po_pend_1',
      idempotencyKey: 'wd_lock_pend_1',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('40.00'),
      lockBatchId: lockPending.batch.id,
      nowUnix: simulatedNowUnix,
    });
    expect(bcastPending.state).toBe('BROADCAST_PENDING');

    const signCountBeforeReconcile = signerTransport.signCount;
    expect(signCountBeforeReconcile).toBe(3);

    // Tick #1 (+30s, still inside Stellar 180s timebound):
    // - bcastConfirmed is now indexed & successful on Horizon -> CONFIRMED + finalize withdrawal lock
    // - bcastDropped & bcastPending are not on Horizon yet and within timebounds -> stay BROADCAST_PENDING
    txStatuses.set(bcastConfirmed.txHash!, {
      found: true,
      successful: true,
      ledger: 912345,
    });
    simulatedNowUnix += 30;

    const tick1 = await reconcilePendingSettlementBroadcasts(db, {
      machine,
      nowUnix: simulatedNowUnix,
    });
    expect(tick1.scanned).toBe(3);
    expect(tick1.confirmed).toBe(1);
    expect(tick1.reverted).toBe(0);
    expect(tick1.stillPending).toBe(2);
    expect(tick1.errors).toEqual([]);
    expect(signerTransport.signCount).toBe(signCountBeforeReconcile);

    const confLockAfterTick1 = await ledger.getBatchById(lockConfirmed.batch.id);
    expect(confLockAfterTick1?.status).toBe('SETTLED');
    expect(confLockAfterTick1?.settledTxHash).toBe(bcastConfirmed.txHash);

    // Extend po_pend_1's timebound so when we advance clock +300s, po_drop_1 expires while po_pend_1 stays active.
    sqlite
      .prepare(`UPDATE settlement_broadcasts SET timebounds_max_unix = ? WHERE payout_id = 'po_pend_1'`)
      .run(simulatedNowUnix + 900);
    simulatedNowUnix += 300;

    const tick2 = await reconcilePendingSettlementBroadcasts(db, {
      machine,
      nowUnix: simulatedNowUnix,
    });
    expect(tick2.scanned).toBe(2);
    expect(tick2.confirmed).toBe(0);
    expect(tick2.reverted).toBe(0);
    expect(tick2.stillPending).toBe(2);
    expect(tick2.errors).toEqual([]);
    // Crucial safety invariant: passive reconciler NEVER re-signs or re-broadcasts!
    expect(signerTransport.signCount).toBe(signCountBeforeReconcile);

    const droppedLockBatch = await ledger.getBatchById(lockDropped.batch.id);
    expect(droppedLockBatch?.status).toBe('INFLIGHT');

    const pendingLockBatch = await ledger.getBatchById(lockPending.batch.id);
    expect(pendingLockBatch?.status).toBe('INFLIGHT');

    // Settled balance check: started at $285.00
    // - $50.00 confirmed paid
    // - $60.00 retained in escrow
    // - $40.00 still locked in `WITHDRAWAL_ESCROW`
    // => settledBalanceUnits = $285.00 - $50.00 - $40.00 = $135.00
    const affAccount = await ledger.getAccountByOwner('affiliate', 'aff_l1');
    expect(affAccount?.settledBalanceUnits.toString()).toBe(
      parseUsdToLedgerUnits('135.00').toString()
    );
    const escrowAccount = await ledger.getAccountByOwner('treasury', 'withdrawal_escrow');
    expect(escrowAccount?.settledBalanceUnits.toString()).toBe(
      parseUsdToLedgerUnits('100.00').toString()
    );

    const invariants = await verifyLedgerInvariants(db);
    expect(invariants.valid).toBe(true);
  });

  it('retries terminal broadcasts whose withdrawal locks were stranded by EMERGENCY_LEDGER_FREEZE, without requiring a signing machine', async () => {
    const ledger = new DoubleEntryLedgerService(db);
    const { machine, signerTransport, txStatuses, clock } = createStellarHarness();

    const lockPaid = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_frozen_paid',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('25.00'),
      payoutId: 'po_frozen_paid',
    });
    const bcastPaid = await machine.executeSettlement({
      payoutId: 'po_frozen_paid',
      idempotencyKey: 'wd_lock_frozen_paid',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('25.00'),
      lockBatchId: lockPaid.batch.id,
      nowUnix: clock.nowUnix,
    });
    expect(bcastPaid.state).toBe('BROADCAST_PENDING');

    const lockFailed = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_frozen_failed',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('15.00'),
      payoutId: 'po_frozen_failed',
    });
    const bcastFailed = await machine.executeSettlement({
      payoutId: 'po_frozen_failed',
      idempotencyKey: 'wd_lock_frozen_failed',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('15.00'),
      lockBatchId: lockFailed.batch.id,
      nowUnix: clock.nowUnix,
    });
    expect(bcastFailed.state).toBe('BROADCAST_PENDING');

    const signCountAfterDispatch = signerTransport.signCount;
    expect(signCountAfterDispatch).toBe(2);

    // The on-chain outcome becomes visible while the operator freezes the ledger:
    // one payout landed, the other failed on-chain.
    txStatuses.set(bcastPaid.txHash!, { found: true, successful: true, ledger: 920001 });
    txStatuses.set(bcastFailed.txHash!, { found: true, successful: false, ledger: 920002 });
    await setEmergencyLedgerFreeze(db, true, 'drift drill');
    clock.nowUnix += 30;

    const frozenTick = await reconcilePendingSettlementBroadcasts(db, {
      machine,
      nowUnix: clock.nowUnix,
    });
    expect(frozenTick.scanned).toBe(2);
    expect(frozenTick.confirmed).toBe(0);
    expect(frozenTick.reverted).toBe(0);
    expect(frozenTick.errors).toHaveLength(2);
    expect(frozenTick.errors.map((e) => e.payoutId).sort()).toEqual([
      'po_frozen_failed',
      'po_frozen_paid',
    ]);

    // The broadcast rows are terminal but the paired locks stayed INFLIGHT.
    const frozenPaidRow = sqlite
      .prepare('SELECT state FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_frozen_paid') as { state: string };
    expect(frozenPaidRow.state).toBe('CONFIRMED');
    const frozenFailedRow = sqlite
      .prepare('SELECT state FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_frozen_failed') as { state: string };
    expect(frozenFailedRow.state).toBe('FAILED_ABORTED');
    expect((await ledger.getBatchById(lockPaid.batch.id))?.status).toBe('INFLIGHT');
    expect((await ledger.getBatchById(lockFailed.batch.id))?.status).toBe('INFLIGHT');

    await setEmergencyLedgerFreeze(db, false, 'drift cleared');

    // Second tick passes `machine: null`: terminal rows only need ledger resolution.
    const recoveredTick = await reconcilePendingSettlementBroadcasts(db, {
      machine: null,
      nowUnix: clock.nowUnix,
    });
    expect(recoveredTick.scanned).toBe(2);
    expect(recoveredTick.confirmed).toBe(1);
    expect(recoveredTick.reverted).toBe(1);
    expect(recoveredTick.stillPending).toBe(0);
    expect(recoveredTick.skippedNoMachine).toBe(false);
    expect(recoveredTick.errors).toEqual([]);

    const paidLockAfter = await ledger.getBatchById(lockPaid.batch.id);
    expect(paidLockAfter?.status).toBe('SETTLED');
    expect(paidLockAfter?.settledTxHash).toBe(bcastPaid.txHash);

    const failedLockAfter = await ledger.getBatchById(lockFailed.batch.id);
    expect(failedLockAfter?.status).toBe('VOIDED');

    // No re-signing happened anywhere in terminal-lock recovery.
    expect(signerTransport.signCount).toBe(signCountAfterDispatch);

    const invariants = await verifyLedgerInvariants(db);
    expect(invariants.valid).toBe(true);
  });

  it('reports a CONFIRMED broadcast with no tx_hash as an error and never reverts its still-locked withdrawal', async () => {
    const ledger = new DoubleEntryLedgerService(db);
    const { machine, signerTransport, clock } = createStellarHarness();

    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_no_hash',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('20.00'),
      payoutId: 'po_no_hash',
    });
    const bcast = await machine.executeSettlement({
      payoutId: 'po_no_hash',
      idempotencyKey: 'wd_lock_no_hash',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('20.00'),
      lockBatchId: lock.batch.id,
      nowUnix: clock.nowUnix,
    });
    expect(bcast.state).toBe('BROADCAST_PENDING');

    sqlite
      .prepare(
        `UPDATE settlement_broadcasts
         SET state = 'CONFIRMED', tx_hash = NULL, signed_raw_tx = NULL
         WHERE payout_id = 'po_no_hash'`
      )
      .run();

    const tick = await reconcilePendingSettlementBroadcasts(db, { machine: null });
    expect(tick.scanned).toBe(1);
    expect(tick.confirmed).toBe(0);
    expect(tick.reverted).toBe(0);
    expect(tick.errors).toHaveLength(1);
    expect(tick.errors[0].payoutId).toBe('po_no_hash');
    expect(tick.errors[0].error).toMatch(/missing tx_hash/i);

    expect((await ledger.getBatchById(lock.batch.id))?.status).toBe('INFLIGHT');
    expect(signerTransport.signCount).toBe(1);
  });

  it('passively reconciles EVM BROADCAST_PENDING rows without ever signing or broadcasting, then finalizes mined receipts', async () => {
    const ledger = new DoubleEntryLedgerService(db);
    const rpc = new AuditingPassiveEvmRpc();
    const signerTransport = new CountingMultiChainSigningTransport();
    const adapter = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode: 'testnet',
      hotWalletAddress: EVM_HOT_ADDR,
      primaryRpc: rpc,
    });
    const machine = new BroadcastRecoveryMachine({
      db: db as unknown as LegacyD1Database,
      turnkeySigner: new TurnkeySigner({
        transport: signerTransport,
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_ADDR,
      }),
      evmAdapters: { arbitrum: adapter },
      nowUnixProvider: () => 1_795_000_000,
    });

    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_evm_passive',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('30.00'),
      payoutId: 'po_evm_passive',
    });
    const bcast = await machine.executeSettlement({
      payoutId: 'po_evm_passive',
      idempotencyKey: 'wd_lock_evm_passive',
      affiliateId: 'aff_l1',
      chain: 'arbitrum',
      recipientAddress: EVM_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('30.00'),
      lockBatchId: lock.batch.id,
      nowUnix: 1_795_000_000,
    });
    expect(bcast.state).toBe('BROADCAST_PENDING');
    expect(rpc.sendRawTxCount).toBe(1);
    expect(signerTransport.evmSignCount).toBe(1);

    // Tick 1: no receipt yet. Passive mode must hold the lock without re-signing or re-broadcasting.
    const tick1 = await reconcilePendingSettlementBroadcasts(db, { machine });
    expect(tick1.scanned).toBe(1);
    expect(tick1.stillPending).toBe(1);
    expect(tick1.confirmed).toBe(0);
    expect(tick1.reverted).toBe(0);
    expect(tick1.errors).toEqual([]);
    expect(rpc.sendRawTxCount).toBe(1);
    expect(signerTransport.evmSignCount).toBe(1);
    expect((await ledger.getBatchById(lock.batch.id))?.status).toBe('INFLIGHT');

    // The originally broadcast transaction mines after a 504-style timeout was reported.
    rpc.receiptByHash.set(bcast.txHash!.toLowerCase(), {
      status: '0x1',
      blockNumber: '0x2710',
    });

    const tick2 = await reconcilePendingSettlementBroadcasts(db, { machine });
    expect(tick2.scanned).toBe(1);
    expect(tick2.confirmed).toBe(1);
    expect(tick2.errors).toEqual([]);
    expect(rpc.sendRawTxCount).toBe(1);
    expect(signerTransport.evmSignCount).toBe(1);

    const settledLock = await ledger.getBatchById(lock.batch.id);
    expect(settledLock?.status).toBe('SETTLED');
    expect(settledLock?.settledTxHash).toBe(bcast.txHash);

    const invariants = await verifyLedgerInvariants(db);
    expect(invariants.valid).toBe(true);
  });

  it('refuses to re-sign or re-queue a payout whose withdrawal lock was already resolved by passive reconciliation', async () => {
    const ledger = new DoubleEntryLedgerService(db);
    const { machine, signerTransport, clock, txStatuses } = createStellarHarness();

    const lock = await ledger.lockSettledForWithdrawal({
      idempotencyKey: 'wd_lock:po_revoked',
      ownerType: 'affiliate',
      ownerId: 'aff_l1',
      amountUnits: parseUsdToLedgerUnits('45.00'),
      payoutId: 'po_revoked',
    });
    const request = {
      payoutId: 'po_revoked',
      idempotencyKey: 'wd_lock_revoked',
      affiliateId: 'aff_l1',
      chain: 'stellar' as const,
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('45.00'),
      lockBatchId: lock.batch.id,
      nowUnix: clock.nowUnix,
    };
    const bcast = await machine.executeSettlement(request);
    expect(bcast.state).toBe('BROADCAST_PENDING');
    expect(signerTransport.signCount).toBe(1);

    txStatuses.set(bcast.txHash!, { found: true, successful: false, ledger: 920001 });
    clock.nowUnix += 400;
    const expireTick = await reconcilePendingSettlementBroadcasts(db, {
      machine,
      nowUnix: clock.nowUnix,
    });
    expect(expireTick.reverted).toBe(1);
    expect(expireTick.errors).toEqual([]);
    expect(signerTransport.signCount).toBe(1);

    const revokedLock = await ledger.getBatchById(lock.batch.id);
    expect(revokedLock?.status).toBe('VOIDED');

    await expect(
      machine.recoverUncertainBroadcast('po_revoked', {
        nowUnix: clock.nowUnix,
        reexecuteExpired: true,
      })
    ).resolves.toMatchObject({ state: 'FAILED_ABORTED', action: 'NO_RECOVERY_NEEDED' });

    await expect(
      machine.executeSettlement({ ...request, nowUnix: clock.nowUnix })
    ).rejects.toThrow(/withdrawal lock is already|workflow ownership unconfirmed/i);

    // Cold-safe multisig queueing (> $250/tx cap) is also fenced when the lock was voided.
    await expect(
      machine.executeSettlement({
        ...request,
        amountUnits1e8: parseUsdToLedgerUnits('300.00'),
        nowUnix: clock.nowUnix,
      })
    ).rejects.toThrow(/withdrawal lock is already|workflow ownership unconfirmed/i);

    // Passive recovery on an already-FAILED_ABORTED row remains a clean no-op.
    const passiveAfterRevert = await machine.recoverUncertainBroadcast('po_revoked', {
      nowUnix: clock.nowUnix,
      reexecuteExpired: true,
      passiveOnly: true,
    });
    expect(passiveAfterRevert.state).toBe('FAILED_ABORTED');
    expect(passiveAfterRevert.action).toBe('NO_RECOVERY_NEEDED');

    // None of the paths ever reached the signing enclave again.
    expect(signerTransport.signCount).toBe(1);

    const revokedRow = sqlite
      .prepare('SELECT state FROM settlement_broadcasts WHERE payout_id = ?')
      .get('po_revoked') as { state: string };
    expect(revokedRow.state).toBe('FAILED_ABORTED');

    const invariants = await verifyLedgerInvariants(db);
    expect(invariants.valid).toBe(true);
  });
});
