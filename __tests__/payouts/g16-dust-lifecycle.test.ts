/** @jest-environment node */

import { withPayoutEffect } from '@/lib/payouts/payout-effect-fence';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { secp256k1 } from '@noble/curves/secp256k1';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { keccak256, parseTransaction, type Hex } from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { POST as dispatchPost } from '@/app/api/admin/settlement/dispatch/route';
import { issuePasskeyStepUpToken, PASSKEY_STEPUP_HEADER } from '@/lib/auth/passkey-step-up';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import {
  DoubleEntryLedgerService,
  formatLedgerUnitsToUsd,
  InMemoryR2Bucket,
  reconcilePartnerCashBatch,
  setEmergencyLedgerFreeze,
  SqliteD1Adapter,
  storeEvidenceObject,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  ArbitrumBaseUsdcAdapter,
  BroadcastRecoveryMachine,
  CIRCLE_IS_BLACKLISTED_SELECTOR,
  reconcilePendingSettlementBroadcasts,
  TurnkeySigner,
  type EvmJsonRpcTransport,
  type Phase1SettlementChain,
  type StellarBroadcastTransport,
} from '@/lib/payouts';
import type { EvmDigestSignature, TurnkeySigningTransport } from '@/lib/payouts/turnkey-signer';

// Use the real SQLite bearer-token lookup; this fixture never needs cookie auth.
jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: () => { throw new Error('Cookie auth is not used by this fixture'); },
}));

const STELLAR_HOT = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const EVM_RECIPIENT = '0x70997970c51812dc3a010c7d01b50e0d17dc79c8';
const MIN = BigInt(1_000_000_000);
const ZERO = BigInt(0);
const ONE = BigInt(1);
const NOW = 1_794_000_000;

// Gross commissions chosen so the standard reserve and waterfall credit the
// trader exactly 3 * MIN + quantum - 1, or MIN + quantum - 1, respectively.
const cases = [
  { chain: 'stellar', quantum: BigInt(10), gross: BigInt(6_315_789_493), pendingGross: BigInt(2_105_263_177) },
  { chain: 'base', quantum: BigInt(100), gross: BigInt(6_315_789_683), pendingGross: BigInt(2_105_263_367) },
  { chain: 'arbitrum', quantum: BigInt(100), gross: BigInt(6_315_789_683), pendingGross: BigInt(2_105_263_367) },
] satisfies Array<{ chain: Phase1SettlementChain; quantum: bigint; gross: bigint; pendingGross: bigint }>;

type ChainStatus = 'confirmed' | 'pending' | 'failed';

function signal() {
  let release!: () => void;
  const reached = new Promise<void>((resolve) => { release = resolve; });
  return { reached, release };
}

function simulatedRail(chain: Phase1SettlementChain, db: LegacyD1Database) {
  const key = generatePrivateKey();
  const evmHot = privateKeyToAccount(key).address;
  const signed: string[] = [];
  const submitted: Array<{ hash: string; units: bigint }> = [];
  const statuses = new Map<string, ChainStatus>();
  const built = new Map<string, bigint>();
  let submitStatus: ChainStatus = 'confirmed';
  let afterSubmit: (() => Promise<void>) | undefined;

  async function submit(hash: string, units: bigint): Promise<void> {
    submitted.push({ hash, units });
    statuses.set(hash, submitStatus);
    await afterSubmit?.();
  }

  const signing: TurnkeySigningTransport = {
    async signEvmDigest({ digestHex, payoutId }): Promise<EvmDigestSignature> {
      signed.push(payoutId);
      const sig = secp256k1.sign(digestHex.slice(2), key.slice(2), { lowS: true });
      return {
        r: `0x${sig.r.toString(16).padStart(64, '0')}`,
        s: `0x${sig.s.toString(16).padStart(64, '0')}`,
        yParity: sig.recovery === 1 ? 1 : 0,
        activityId: `fixture-${payoutId}`,
      };
    },
    async signStellarEnvelope({ unsignedEnvelopeXdr, txHashHex, payoutId }) {
      signed.push(payoutId);
      return {
        signedEnvelopeXdr: `signed:${unsignedEnvelopeXdr}`,
        signatureBase64: Buffer.alloc(64, 9).toString('base64'),
        txHash: txHashHex.slice(2),
        activityId: `fixture-${payoutId}`,
      };
    },
  };

  const stellar: StellarBroadcastTransport = {
    async hasUsdcTrustline() { return true; },
    async getAccountSequence() { return BigInt(1_000); },
    async buildUnsignedUsdcPayment(params) {
      const txHashHex = keccak256(Buffer.from(
        `${params.recipientAddress}:${params.stellarSequence}:${params.amountStroops}`
      ));
      built.set(txHashHex.slice(2), params.amountStroops);
      return { ...params, txHashHex, unsignedEnvelopeXdr: `fixture:${txHashHex}` };
    },
    async submitSignedTransaction({ expectedTxHash, db, payoutId, effect, workflow, signedEnvelopeXdr }) {
      const units = built.get(expectedTxHash);
      if (units === undefined) throw new Error('Unknown simulated Stellar transaction');
      return withPayoutEffect({ db, payoutId, effect, workflow, expectedHash: expectedTxHash, payload: signedEnvelopeXdr }, async () => {
        await submit(expectedTxHash, units);
        return { txHash: expectedTxHash, confirmed: statuses.get(expectedTxHash) === 'confirmed' };
      });
    },
    async lookupTransaction(hash) {
      const status = statuses.get(hash);
      return {
        found: status === 'confirmed' || status === 'failed',
        successful: status === 'confirmed',
        ledger: status === 'confirmed' || status === 'failed' ? 424_242 : undefined,
      };
    },
  };

  const evm: EvmJsonRpcTransport = {
    async call<T>(method: string, params: unknown[] = []): Promise<T> {
      switch (method) {
        case 'eth_call': {
          const { data } = params[0] as { data: string };
          return `0x${(data.startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR) ? '0' : '1').padStart(64, '0')}` as T;
        }
        case 'eth_getTransactionCount': return '0x0' as T;
        case 'eth_estimateGas': return '0xfde8' as T;
        case 'eth_gasPrice':
        case 'eth_maxPriorityFeePerGas': return '0x5f5e100' as T;
        case 'eth_sendRawTransaction': {
          const raw = params[0] as Hex;
          const { data } = parseTransaction(raw);
          // ERC-20 transfer(address,uint256): the final word is the actual amount sent.
          if (!data?.startsWith('0xa9059cbb') || data.length !== 138) {
            throw new Error('Expected a simulated USDC transfer');
          }
          const hash = keccak256(raw);
          await submit(hash, BigInt(`0x${data.slice(-64)}`));
          return hash as T;
        }
        case 'eth_chainId': return (chain === 'base' ? '0x14a34' : '0x66eee') as T;
        case 'eth_getBlockByNumber': return { hash: `0x${'12'.repeat(32)}`, number: '0x10' } as T;
        case 'eth_getTransactionReceipt': {
          const transactionHash = String(params[0]);
          const status = statuses.get(transactionHash);
          return (status === 'confirmed' || status === 'failed'
            ? { transactionHash, status: status === 'confirmed' ? '0x1' : '0x0', blockNumber: '0x10', blockHash: `0x${'12'.repeat(32)}` }
            : null) as T;
        }
        default: throw new Error(`Unexpected simulated RPC method: ${method}`);
      }
    },
  };

  const newMachine = () => new BroadcastRecoveryMachine({
    db,
    nowUnixProvider: () => NOW,
    turnkeySigner: new TurnkeySigner({
      transport: signing,
      evmHotWalletAddress: evmHot,
      stellarHotWalletAddress: STELLAR_HOT,
    }),
    stellarTransport: chain === 'stellar' ? stellar : undefined,
    evmAdapters: chain === 'stellar' ? {} : {
      [chain]: new ArbitrumBaseUsdcAdapter({
        chain, networkMode: 'testnet', hotWalletAddress: evmHot, primaryRpc: evm,
      }),
    },
  });
  return {
    machine: newMachine(), newMachine, signed, submitted, statuses,
    setSubmitStatus(status: ChainStatus) { submitStatus = status; },
    loseSubmissionResponse() {
      afterSubmit = async () => { throw new Error('Fixture timeout after send'); };
    },
    holdSubmissionResponse() {
      const submitted = signal();
      const response = signal();
      afterSubmit = () => {
        submitted.release();
        return response.reached;
      };
      return { submitted: submitted.reached, release: response.release };
    },
  };
}

function migrate(sqlite: Database.Database): void {
  const apply = (filename: string) => sqlite.exec(readFileSync(
    resolve(process.cwd(), 'src/database/migrations', filename), 'utf8'
  ));
  for (const filename of [
    '001_initial_schema_d1.sql',
    '002_auth_tables.sql',
    '003_affiliate_schema.sql',
    '009_tracking_optimization.sql',
    '020_billing_mobile_enhancements.sql',
    '024_kyc_compliance_schema.sql',
    '028_ascendancy_audit_core.sql',
    '031_ascendancy_phase2_ui_and_poller.sql',
  ]) apply(filename);
  const beforeRemediation = new Database(sqlite.serialize());
  try {
    apply('033_cold_settlement_claims.sql');
    apply('034_withdrawal_freeze_at_write.sql');
    apply('035_payout_effect_grants.sql');
    apply('036_durable_hot_exposure.sql');
  } finally {
    beforeRemediation.close();
  }
}

function createFixture(sqlite: Database.Database, chain: Phase1SettlementChain) {
  const recipientAddress = chain === 'stellar' ? STELLAR_RECIPIENT : EVM_RECIPIENT;
  const bearer = randomUUID();
  const expires = new Date(Date.now() + 3_600_000).toISOString();
  sqlite.prepare(`INSERT INTO profiles
    (id, email, full_name, role, referral_code, wallet_address, preferred_chain) VALUES
    ('admin-1', 'admin@example.test', 'Admin', 'admin', 'ADMIN1', NULL, 'stellar'),
    ('trader-1', 'trader@example.test', 'Trader', 'shopper', 'TRADER1', ?, ?)`
  ).run(recipientAddress, chain);
  sqlite.prepare(`INSERT INTO sessions (id, user_id, token, expires_at)
    VALUES ('session-1', 'admin-1', ?, ?)`
  ).run(bearer, expires);
  sqlite.prepare(`INSERT INTO webauthn_challenges
    (challenge_id, user_id, challenge, purpose, expires_at, consumed)
    VALUES ('challenge-1', 'admin-1', 'fixture', 'admin_step_up', ?, 1)`
  ).run(expires);

  const db = new SqliteD1Adapter(sqlite);
  const ledger = new DoubleEntryLedgerService(db);
  const rail = simulatedRail(chain, db as unknown as LegacyD1Database);
  const r2 = new InMemoryR2Bucket();

  async function credit(id: string, gross: bigint): Promise<void> {
    const evidence = {
      exchange: 'bybit' as const,
      statementPeriodStart: '2026-10-01T00:00:00.000Z',
      statementPeriodEnd: '2026-10-01T23:59:59.000Z',
    };
    const partner = await storeEvidenceObject(db, r2, {
      ...evidence, sourceKind: 'rest_poll', rawBytes: JSON.stringify({ id, commission: gross.toString() }),
    });
    const wallet = await storeEvidenceObject(db, r2, {
      ...evidence, sourceKind: 'wallet_statement', rawBytes: JSON.stringify({ id, collected: gross.toString() }),
    });
    const reconciliation = await reconcilePartnerCashBatch(db, {
      exchange: 'bybit', evidenceId: partner.id, walletEvidenceId: wallet.id,
      uidAllocatedUnits: gross, walletCashCollectedUnits: gross, r2,
    });
    const input = {
      exchange: 'bybit' as const, traderUid: 'fixture-uid', traderId: 'trader-1',
      l1AffiliateId: null, idempotencyKey: `credit-${id}`, reconciliationId: reconciliation.id,
      evidenceId: partner.id, grossCommissionUnits: gross, createdAt: '2026-10-01T00:00:00.000Z', r2,
    };
    const first = await ledger.recordVerifiedCommissionInflight(input);
    expect(first.isReplay).toBe(false);
    expect(await ledger.recordVerifiedCommissionInflight(input)).toMatchObject({
      isReplay: true, batch: { id: first.batch.id },
    });
    const matureAt = '2026-10-09T00:00:00.000Z';
    expect((await ledger.releaseMaturedInflightBatch(first.batch.id, matureAt)).isReplay).toBe(false);
    expect((await ledger.releaseMaturedInflightBatch(first.batch.id, matureAt)).isReplay).toBe(true);
  }

  async function dispatch(payoutId: string, requested: bigint) {
    const response = await dispatchPost(new NextRequest('http://localhost/api/admin/settlement/dispatch', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bearer}`,
        'content-type': 'application/json',
        [PASSKEY_STEPUP_HEADER]: issuePasskeyStepUpToken({
          userId: 'admin-1', purpose: 'admin_step_up', challengeId: 'challenge-1',
        }),
      },
      body: JSON.stringify({
        action: 'dispatch', payoutId, idempotencyKey: payoutId, affiliateId: 'trader-1',
        ownerType: 'trader', chain, recipientAddress, amountUsd: formatLedgerUnitsToUsd(requested),
        usdcReferencePriceUsd: '1.0000',
      }),
    }));
    return {
      status: response.status,
      body: await response.json() as {
        success: boolean;
        code?: string;
        error?: string;
        isReplay?: boolean;
        lockBatchId?: string;
        disbursableUnits1e8?: string;
        residualDustUnits1e8?: string;
        settlement?: { state: string; txHash: string };
      },
    };
  }

  async function expectBalances(credited: bigint, available: bigint, locked: bigint, settled: bigint) {
    const trader = await ledger.getAccountByOwner('trader', 'trader-1');
    const escrow = await ledger.getAccountByCode('treasury:withdrawal_escrow');
    const external = await ledger.getAccountByCode('treasury:external_settlement');
    const observed = [trader?.settledBalanceUnits, escrow?.settledBalanceUnits ?? ZERO,
      external?.settledBalanceUnits ?? ZERO] as const;
    expect(trader?.inflightBalanceUnits).toBe(ZERO);
    expect(observed).toEqual([available, locked, settled]);
    expect(observed.reduce<bigint>((sum, units) => sum + (units ?? ZERO), ZERO)).toBe(credited);
    expect((await verifyLedgerInvariants(db)).valid).toBe(true);
  }

  function expectJournal(locks: number, finalized: number, reverted: number) {
    const count = (type: string) => sqlite.prepare(
      'SELECT count(*) AS count FROM ledger_journal_batches WHERE journal_type = ?'
    ).get(type);
    expect(count('WITHDRAWAL_LOCK')).toEqual({ count: locks });
    expect(count('WITHDRAWAL_FINALIZED')).toEqual({ count: finalized });
    expect(count('WITHDRAWAL_REVERTED')).toEqual({ count: reverted });
  }

  return { db, ledger, rail, credit, dispatch, expectBalances, expectJournal };
}

type Fixture = ReturnType<typeof createFixture>;

async function withFixture(chain: Phase1SettlementChain, check: (fixture: Fixture) => Promise<void>) {
  const sqlite = new Database(':memory:');
  const globals = globalThis as Record<string, unknown>;
  const previousBindings = [globals.DB, globals.SETTLEMENT_MACHINE] as const;
  const env = jest.replaceProperty(process, 'env', { ...process.env, PASSKEY_STEP_UP_SECRET: randomUUID() });
  const fetch = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Network disabled in this fixture'));
  try {
    migrate(sqlite);
    const beforeScenario = new Database(sqlite.serialize());
    try {
      const fixture = createFixture(sqlite, chain);
      globals.DB = fixture.db;
      globals.SETTLEMENT_MACHINE = fixture.rail.machine;
      await check(fixture);
      expect(fetch).not.toHaveBeenCalled();
    } finally {
      beforeScenario.close();
    }
  } finally {
    fetch.mockRestore();
    env.restore();
    for (const [index, name] of ['DB', 'SETTLEMENT_MACHINE'].entries()) {
      if (previousBindings[index] === undefined) delete globals[name];
      else globals[name] = previousBindings[index];
    }
    sqlite.close();
  }
}

async function expectLock(fixture: Fixture, payoutId: string, amount: bigint, status: string) {
  const lock = await fixture.ledger.getBatchByIdempotencyKey(`wd_lock:${payoutId}`);
  expect(lock).toMatchObject({ status, grossCommissionUnits: amount, metadata: { payoutId } });
  return lock?.id;
}

describe.each(cases)('G16.4 dust lifecycle on $chain', ({ chain, quantum, gross, pendingGross }) => {
  const dust = quantum - ONE;

  it('conserves exact units at the minimum and only spends accumulated dust through a new lock', async () => {
    await withFixture(chain, async (fixture) => {
      const { credit, dispatch, rail, expectBalances, expectJournal } = fixture;
      let credited = BigInt(3) * MIN + dust;
      await credit('opening', gross);
      await expectBalances(credited, credited, ZERO, ZERO);

      expect(await dispatch('under-minimum', MIN - ONE)).toMatchObject({
        status: 422,
        body: {
          success: false, code: 'BELOW_MIN_WITHDRAWAL_FLOOR',
          disbursableUnits1e8: String(MIN - quantum), residualDustUnits1e8: String(dust),
        },
      });
      expect(await rail.machine.getSettlementRecord('under-minimum')).toBeNull();
      expectJournal(0, 0, 0);
      expect(rail.signed).toEqual([]);
      expect(rail.submitted).toEqual([]);
      await expectBalances(credited, credited, ZERO, ZERO);

      const boundaryCases = [
        { payoutId: 'exact-minimum', requested: MIN, payable: MIN, remainder: ZERO },
        { payoutId: 'one-ledger-unit', requested: MIN + ONE, payable: MIN, remainder: ONE },
        { payoutId: 'one-below-quantum', requested: MIN + dust, payable: MIN, remainder: dust },
        { payoutId: 'one-chain-quantum', requested: MIN + quantum, payable: MIN + quantum, remainder: ZERO },
      ];
      let paid = ZERO;
      for (const [index, { payoutId, requested, payable, remainder }] of boundaryCases.entries()) {
        if (payoutId === 'one-chain-quantum') {
          await expectBalances(credited, dust, ZERO, paid);
          // This gross commission credits exactly $10.00000001, taking dust to one quantum.
          await credit('top-up', BigInt(2_105_263_160));
          credited += MIN + ONE;
          await expectBalances(credited, MIN + quantum, ZERO, paid);
          const replay = await dispatch('one-below-quantum', MIN + dust);
          expect(replay).toMatchObject({ status: 200, body: { success: true, isReplay: true } });
          expectJournal(index, index, 0);
          expect(rail.signed).toHaveLength(index);
          expect(rail.submitted).toHaveLength(index);
          await expectBalances(credited, MIN + quantum, ZERO, paid);
        }

        const result = await dispatch(payoutId, requested);
        expect(result).toMatchObject({ status: 200, body: {
          success: true, disbursableUnits1e8: String(payable), residualDustUnits1e8: String(remainder),
          settlement: { state: 'CONFIRMED' },
        } });
        const lockId = await expectLock(fixture, payoutId, payable, 'SETTLED');
        expect(result.body.lockBatchId).toBe(lockId);
        expect(await rail.machine.getSettlementRecord(payoutId)).toMatchObject({
          amount_units_1e8: Number(payable), chain_token_units: String(payable / quantum),
          state: 'CONFIRMED', lock_batch_id: lockId,
        });
        expect(rail.submitted[index]).toEqual({ hash: result.body.settlement?.txHash, units: payable / quantum });
        paid += payable;
        expectJournal(index + 1, index + 1, 0);
        await expectBalances(credited, credited - paid, ZERO, paid);
      }
      expect(paid).toBe(credited);
      expect(rail.signed).toEqual(boundaryCases.map(({ payoutId }) => payoutId));
      expect(rail.submitted).toHaveLength(boundaryCases.length);
      expect(new Set(rail.submitted.map(({ hash }) => hash)).size).toBe(boundaryCases.length);
    });
  });

  it('reconciles the same lock while dispatch is awaiting the submission response', async () => {
    await withFixture(chain, async (fixture) => {
      const { credit, db, dispatch, rail, expectBalances, expectJournal } = fixture;
      const credited = MIN + dust;
      const payoutId = 'overlapping-dust';
      await credit('opening-overlap', pendingGross);
      await expectBalances(credited, credited, ZERO, ZERO);
      rail.setSubmitStatus('pending');
      const hold = rail.holdSubmissionResponse();
      const inFlight = dispatch(payoutId, credited);
      // The report of submission is blocked, not the chain lookup. A second
      // machine models the reconciler in another isolate with its own queue.
      const reconciler = rail.newMachine();
      const tick = () => reconcilePendingSettlementBroadcasts(db, { machine: reconciler, nowUnix: NOW + 30 });
      try {
        await Promise.race([
          hold.submitted,
          inFlight.then(({ status }) => { throw new Error(`Dispatch returned ${status} before submitting`); }),
        ]);
        const submission = rail.submitted[0];
        if (!submission) throw new Error('Expected a submitted transaction');
        const { hash } = submission;
        const lockId = await expectLock(fixture, payoutId, MIN, 'INFLIGHT');
        expect(await reconciler.getSettlementRecord(payoutId)).toMatchObject({
          state: 'BROADCAST_PENDING', tx_hash: hash, lock_batch_id: lockId,
        });
        await expectBalances(credited, dust, MIN, ZERO);
        expectJournal(1, 0, 0);
        expect(rail.signed).toEqual([payoutId]);
        expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);

        rail.statuses.set(hash, 'confirmed');
        expect(await tick()).toMatchObject({ scanned: 1, confirmed: 1, reverted: 0, errors: [] });
        expect(await expectLock(fixture, payoutId, MIN, 'SETTLED')).toBe(lockId);
        await expectBalances(credited, dust, ZERO, MIN);
        expectJournal(1, 1, 0);
        hold.release();
        expect(await inFlight).toMatchObject({ status: 200, body: {
          success: true, lockBatchId: lockId, settlement: { state: 'CONFIRMED', txHash: hash },
        } });
        expect(await reconciler.getSettlementRecord(payoutId)).toMatchObject({
          state: 'CONFIRMED', tx_hash: hash, lock_batch_id: lockId,
        });
        expect(await tick()).toMatchObject({ scanned: 0, confirmed: 0, reverted: 0, errors: [] });
        await expectBalances(credited, dust, ZERO, MIN);
        expectJournal(1, 1, 0);
        expect(rail.signed).toEqual([payoutId]);
        expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);
      } finally {
        hold.release();
        await Promise.allSettled([inFlight]);
      }
    });
  });

  it('resumes the durable pending lock with a new settlement machine', async () => {
    await withFixture(chain, async (fixture) => {
      const { credit, db, dispatch, rail, expectBalances, expectJournal } = fixture;
      const credited = MIN + dust;
      const payoutId = 'restart-dust';
      await credit('opening-restart', pendingGross);
      rail.setSubmitStatus('pending');
      const pending = await dispatch(payoutId, credited);
      const hash = pending.body.settlement?.txHash;
      if (!hash) throw new Error('Expected a pending transaction hash');
      const lockId = await expectLock(fixture, payoutId, MIN, 'INFLIGHT');
      expect(pending).toMatchObject({ status: 200, body: {
        success: true, lockBatchId: lockId, settlement: { state: 'BROADCAST_PENDING', txHash: hash },
      } });
      await expectBalances(credited, dust, MIN, ZERO);
      expectJournal(1, 0, 0);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);

      const restarted = rail.newMachine();
      expect(restarted).not.toBe(rail.machine);
      (globalThis as Record<string, unknown>).SETTLEMENT_MACHINE = restarted;
      const tick = () => reconcilePendingSettlementBroadcasts(db, { machine: restarted, nowUnix: NOW + 30 });
      expect(await restarted.getSettlementRecord(payoutId)).toMatchObject({
        state: 'BROADCAST_PENDING', tx_hash: hash, lock_batch_id: lockId,
      });
      expect(await tick()).toMatchObject({ scanned: 1, confirmed: 0, reverted: 0, stillPending: 1, errors: [] });
      expect(await expectLock(fixture, payoutId, MIN, 'INFLIGHT')).toBe(lockId);
      await expectBalances(credited, dust, MIN, ZERO);
      expectJournal(1, 0, 0);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);

      rail.statuses.set(hash, 'confirmed');
      expect(await tick()).toMatchObject({ scanned: 1, confirmed: 1, reverted: 0, errors: [] });
      expect(await restarted.getSettlementRecord(payoutId)).toMatchObject({
        state: 'CONFIRMED', tx_hash: hash, lock_batch_id: lockId,
      });
      expect(await expectLock(fixture, payoutId, MIN, 'SETTLED')).toBe(lockId);
      expect(await dispatch(payoutId, credited)).toMatchObject({ status: 200, body: {
        success: true, isReplay: true, lockBatchId: lockId,
      } });
      expect(await tick()).toMatchObject({ scanned: 0, confirmed: 0, reverted: 0, errors: [] });
      await expectBalances(credited, dust, ZERO, MIN);
      expectJournal(1, 1, 0);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);
    });
  });

  it('resumes the same lock when the committed ledger write loses its response', async () => {
    await withFixture(chain, async (fixture) => {
      const { credit, db, dispatch, ledger, rail, expectBalances, expectJournal } = fixture;
      const credited = MIN + dust;
      const payoutId = 'lost-lock-response-dust';
      const lostResponse = 'Fixture lost response after withdrawal lock commit';
      await credit('opening-lost-response', pendingGross);
      await expectBalances(credited, credited, ZERO, ZERO);
      expectJournal(0, 0, 0);

      const batch = db.batch.bind(db);
      let committedLockId: string | undefined;
      const fault = jest.spyOn(db, 'batch').mockImplementation(async (statements) => {
        const result = await batch(statements);
        // The real SQLite transaction must have returned before losing its response.
        const lock = await ledger.getBatchByIdempotencyKey(`wd_lock:${payoutId}`);
        if (lock && committedLockId === undefined) {
          committedLockId = lock.id;
          throw new Error(lostResponse);
        }
        return result;
      });
      try {
        expect(await dispatch(payoutId, credited)).toMatchObject({ status: 400, body: {
          success: false, error: expect.stringContaining(lostResponse),
        } });
      } finally {
        fault.mockRestore();
      }
      expect(committedLockId).toEqual(expect.any(String));
      expect(await expectLock(fixture, payoutId, MIN, 'INFLIGHT')).toBe(committedLockId);
      expect(await rail.machine.getSettlementRecord(payoutId)).toBeNull();
      await expectBalances(credited, dust, MIN, ZERO);
      expectJournal(1, 0, 0);
      expect(rail.signed).toEqual([]);
      expect(rail.submitted).toEqual([]);

      rail.setSubmitStatus('pending');
      const pending = await dispatch(payoutId, credited);
      const hash = pending.body.settlement?.txHash;
      if (!hash) throw new Error('Expected a pending transaction hash after retry');
      expect(pending).toMatchObject({ status: 200, body: {
        success: true, lockBatchId: committedLockId, settlement: { state: 'BROADCAST_PENDING', txHash: hash },
      } });
      expect(await expectLock(fixture, payoutId, MIN, 'INFLIGHT')).toBe(committedLockId);
      await expectBalances(credited, dust, MIN, ZERO);
      expectJournal(1, 0, 0);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);

      const tick = () => reconcilePendingSettlementBroadcasts(db, { machine: rail.machine, nowUnix: NOW + 30 });
      rail.statuses.set(hash, 'confirmed');
      expect(await tick()).toMatchObject({ scanned: 1, confirmed: 1, reverted: 0, errors: [] });
      expect(await expectLock(fixture, payoutId, MIN, 'SETTLED')).toBe(committedLockId);
      expect(await dispatch(payoutId, credited)).toMatchObject({ status: 200, body: {
        success: true, isReplay: true, lockBatchId: committedLockId,
      } });
      expect(await tick()).toMatchObject({ scanned: 0, confirmed: 0, reverted: 0, errors: [] });
      await expectBalances(credited, dust, ZERO, MIN);
      expectJournal(1, 1, 0);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);
    });
  });

  it.each([
    { scenario: 'confirmation', terminal: 'confirmed', freeze: false, lostResponse: false },
    { scenario: 'confirmation during freeze', terminal: 'confirmed', freeze: true, lostResponse: false },
    { scenario: 'verified on-chain failure', terminal: 'failed', freeze: false, lostResponse: false },
    { scenario: 'verified on-chain failure during freeze', terminal: 'failed', freeze: true, lostResponse: false },
    { scenario: 'verified failure after a lost submission response', terminal: 'failed', freeze: false, lostResponse: true },
    { scenario: 'verified failure after a lost submission response during freeze', terminal: 'failed', freeze: true, lostResponse: true },
  ] as const)('reconciles $scenario without duplicate effects', async ({ terminal, freeze, lostResponse }) => {
    await withFixture(chain, async (fixture) => {
      const { credit, db, dispatch, rail, expectBalances, expectJournal } = fixture;
      const credited = MIN + dust;
      const payoutId = 'pending-dust';
      const tick = () => reconcilePendingSettlementBroadcasts(db, { machine: rail.machine, nowUnix: NOW + 30 });
      await credit('opening-pending', pendingGross);
      await expectBalances(credited, credited, ZERO, ZERO);
      rail.setSubmitStatus('pending');
      if (lostResponse) rail.loseSubmissionResponse();

      const pending = await dispatch(payoutId, credited);
      expect(pending).toMatchObject({ status: 200, body: {
        success: true, disbursableUnits1e8: String(MIN), residualDustUnits1e8: String(dust),
        settlement: { state: 'BROADCAST_PENDING', txHash: expect.any(String) },
      } });
      const hash = pending.body.settlement?.txHash;
      if (!hash) throw new Error('Expected a pending transaction hash');
      const lockId = await expectLock(fixture, payoutId, MIN, 'INFLIGHT');
      expect(pending.body.lockBatchId).toBe(lockId);
      await expectBalances(credited, dust, MIN, ZERO);

      expect(await dispatch(payoutId, credited)).toMatchObject(lostResponse
        ? { status: 400, body: { success: false } }
        : { status: 200, body: { success: true, lockBatchId: lockId, settlement: { state: 'BROADCAST_PENDING', txHash: hash } } });
      expect(await tick()).toMatchObject({ scanned: 1, confirmed: 0, reverted: 0, stillPending: 1, errors: [] });
      expectJournal(1, 0, 0);
      await expectLock(fixture, payoutId, MIN, 'INFLIGHT');
      await expectBalances(credited, dust, MIN, ZERO);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);

      if (freeze) await setEmergencyLedgerFreeze(db, true, 'dust lifecycle fixture');
      // Terminal evidence is attached only to the exact submitted hash.
      rail.statuses.set(hash, terminal);
      if (freeze) {
        const frozen = await tick();
        expect(frozen).toMatchObject({ scanned: 1, confirmed: 0, reverted: 0 });
        expect(frozen.errors).toEqual([{ payoutId, error: expect.stringContaining('EMERGENCY_LEDGER_FREEZE') }]);
        expect(await rail.machine.getSettlementRecord(payoutId)).toMatchObject({
          state: terminal === 'confirmed' ? 'CONFIRMED' : 'FAILED_ABORTED', tx_hash: hash, lock_batch_id: lockId,
        });
        if (terminal === 'failed') {
          expect(await tick()).toMatchObject({ scanned: 1, confirmed: 0, reverted: 0, errors: frozen.errors });
        }
        expectJournal(1, 0, 0);
        await expectLock(fixture, payoutId, MIN, 'INFLIGHT');
        await expectBalances(credited, dust, MIN, ZERO);
        expect(rail.signed).toEqual([payoutId]);
        expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);
        await setEmergencyLedgerFreeze(db, false, 'dust lifecycle fixture thawed');
      }

      const confirmed = terminal === 'confirmed';
      expect(await tick()).toMatchObject({
        scanned: 1, confirmed: confirmed ? 1 : 0, reverted: confirmed ? 0 : 1, stillPending: 0, errors: [],
      });
      expect(await rail.machine.getSettlementRecord(payoutId)).toMatchObject({
        state: confirmed ? 'CONFIRMED' : 'FAILED_ABORTED', tx_hash: hash,
      });
      await expectLock(fixture, payoutId, MIN, confirmed ? 'SETTLED' : 'VOIDED');
      await expectBalances(credited, confirmed ? dust : credited, ZERO, confirmed ? MIN : ZERO);
      expectJournal(1, confirmed ? 1 : 0, confirmed ? 0 : 1);

      const replay = await dispatch(payoutId, credited);
      expect(replay).toMatchObject(confirmed
        ? { status: 200, body: { success: true, isReplay: true, lockBatchId: lockId } }
        : { status: 409, body: { success: false, code: 'IDEMPOTENCY_KEY_PREVIOUSLY_VOIDED', lockBatchId: lockId } });
      expect(await tick()).toMatchObject({ scanned: 0, confirmed: 0, reverted: 0, errors: [] });
      expectJournal(1, confirmed ? 1 : 0, confirmed ? 0 : 1);
      await expectBalances(credited, confirmed ? dust : credited, ZERO, confirmed ? MIN : ZERO);
      expect(rail.signed).toEqual([payoutId]);
      expect(rail.submitted).toEqual([{ hash, units: MIN / quantum }]);
    });
  });
});
