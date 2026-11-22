/**
 * @jest-environment node
 *
 * Turnkey HSM Bounded Timeout, Explicit Outcome Classification & Durable Recovery Tests
 *
 * Covers all 12 mandatory negative scenarios with deterministic fake transports
 * (zero real Turnkey API calls, zero real network traffic):
 * 1.  Timeout / abort before any request is transmitted
 * 2.  Timeout after request transmission
 * 3.  Timeout after remote acceptance before response (+ read-only recovery)
 * 4.  Duplicate request identifier
 * 5.  Response received twice
 * 6.  Concurrent workers retrying the same withdrawal
 * 7.  HSM returns explicit denial (POLICY_DENIED)
 * 8.  HSM returns a malformed signature
 * 9.  Emergency pause activates while signing request is pending
 * 10. Ledger freeze activates during recovery
 * 11. Network disconnect after signing but before broadcast
 * 12. Restart and recovery from persisted uncertain state
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, type Hex } from 'viem';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
const nodeMod = (
  process as unknown as { getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire } }
).getBuiltinModule('node:module');
const StellarSdk = nodeMod.createRequire(__filename)('@stellar/stellar-sdk') as typeof StellarSdkTypes;
import type { D1Database as LegacyD1Database } from '@/lib/db';
import {
  DoubleEntryLedgerService,
  InMemoryR2Bucket,
  SqliteD1Adapter,
  parseUsdToLedgerUnits,
  reconcilePartnerCashBatch,
  storeEvidenceObject,
  verifyLedgerInvariants,
} from '@/lib/ledger';
import {
  ArbitrumBaseUsdcAdapter,
  BroadcastRecoveryMachine,
  CIRCLE_IS_BLACKLISTED_SELECTOR,
  type EvmJsonRpcTransport,
  type StellarBroadcastTransport,
} from '@/lib/payouts';
import {
  DEFAULT_TURNKEY_SIGN_TIMEOUT_MS,
  MAX_TURNKEY_SIGN_TIMEOUT_MS,
  TurnkeyHsmOutcomeError,
  TurnkeyServerHsmTransport,
  TurnkeySigner,
  isTurnkeyHsmOutcomeError,
  type TurnkeyRawApiClient,
  type TurnkeyRawPayloadApiResponse,
} from '@/lib/payouts/turnkey-signer';

const EVM_TEST_PRIVKEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const EVM_HOT_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EVM_RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const STELLAR_KEYPAIR = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 7));
const STELLAR_HOT_PUB = STELLAR_KEYPAIR.publicKey();
const STELLAR_RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const CORE_MIGRATIONS = [
  '001_initial_schema_d1.sql',
  '002_auth_tables.sql',
  '003_affiliate_schema.sql',
  '028_ascendancy_audit_core.sql',
  '031_ascendancy_phase2_ui_and_poller.sql',
  '033_cold_settlement_claims.sql',
  '034_withdrawal_freeze_at_write.sql',
  '035_payout_effect_grants.sql',
  '036_durable_hot_exposure.sql',
];

function createTestDb(): { sqlite: Database.Database; db: SqliteD1Adapter; legacyDb: LegacyD1Database } {
  const sqlite = new Database(':memory:');
  const migrationsDir = path.resolve(process.cwd(), 'src/database/migrations');
  for (const filename of CORE_MIGRATIONS) {
    sqlite.exec(fs.readFileSync(path.join(migrationsDir, filename), 'utf8'));
  }
  const db = new SqliteD1Adapter(sqlite);
  return { sqlite, db, legacyDb: db as unknown as LegacyD1Database };
}

function signEvmDigestDeterministically(digestHex: string): { r: string; s: string; v: string } {
  const clean = digestHex.replace(/^0x/, '');
  const privBytes = Buffer.from(EVM_TEST_PRIVKEY.slice(2), 'hex');
  const sig = secp256k1.sign(Buffer.from(clean, 'hex'), privBytes, { lowS: true });
  return {
    r: sig.r.toString(16).padStart(64, '0'),
    s: sig.s.toString(16).padStart(64, '0'),
    v: sig.recovery === 1 ? '1c' : '1b',
  };
}

function buildValidUnsignedStellarTx(): { xdr: string; hashHex: string } {
  const account = new StellarSdk.Account(STELLAR_HOT_PUB, '100');
  const tx = new StellarSdk.TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: StellarSdk.Networks.TESTNET,
  })
    .addOperation(
      StellarSdk.Operation.payment({
        destination: STELLAR_RECIPIENT,
        asset: StellarSdk.Asset.native(),
        amount: '10.0000000',
      })
    )
    .setTimeout(180)
    .build();
  return {
    xdr: tx.toXDR(),
    hashHex: Buffer.from(tx.hash()).toString('hex'),
  };
}

function makeEvmAdapter(overrides?: {
  onSendRawTransaction?: (rawTx: Hex) => Promise<Hex>;
  onGetReceipt?: (txHash: Hex) => Promise<unknown>;
  onGetNonce?: () => Promise<number>;
}): ArbitrumBaseUsdcAdapter {
  const rpc = makeEvmRpcTransport(overrides);
  return new ArbitrumBaseUsdcAdapter({
    chain: 'arbitrum',
    networkMode: 'mainnet',
    hotWalletAddress: EVM_HOT_ADDR,
    primaryRpc: rpc,
    fallbackRpc: rpc,
  });
}

function makeEvmRpcTransport(overrides?: {
  onSendRawTransaction?: (rawTx: Hex) => Promise<Hex>;
  onGetReceipt?: (txHash: Hex) => Promise<unknown>;
  onGetNonce?: () => Promise<number>;
}): EvmJsonRpcTransport {
  const submitted = new Map<string, Hex>();
  return {
    async call<T = unknown>(method: string, params: unknown[] = []): Promise<T> {
      switch (method) {
        case 'eth_chainId':
          return '0xa4b1' as T;
        case 'eth_getTransactionCount':
          return `0x${((await overrides?.onGetNonce?.()) ?? 5).toString(16)}` as T;
        case 'eth_feeHistory':
          return {
            oldestBlock: '0x100',
            baseFeePerGas: ['0x5f5e100', '0x5f5e100'],
            gasUsedRatio: [0.5],
            reward: [['0x3b9aca00']],
          } as T;
        case 'eth_maxPriorityFeePerGas':
        case 'eth_gasPrice':
          return '0x3b9aca00' as T;
        case 'eth_getBlockByNumber':
          return { number: '0x100', baseFeePerGas: '0x5f5e100' } as T;
        case 'eth_blockNumber':
          return '0x120' as T;
        case 'eth_estimateGas':
          return '0x15f90' as T;
        case 'eth_call': {
          const callObj = params[0] as { data?: string };
          if (callObj?.data?.startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR)) {
            return ('0x' + '0'.repeat(64)) as T;
          }
          // ERC20 transfer simulation returns true (0x...01); balanceOf returns 10,000 USDC
          return ('0x' + BigInt('10000000000').toString(16).padStart(64, '0')) as T;
        }
        case 'eth_sendRawTransaction': {
          const raw = params[0] as Hex;
          const hash = overrides?.onSendRawTransaction
            ? await overrides.onSendRawTransaction(raw)
            : keccak256(raw);
          submitted.set(hash.toLowerCase(), raw);
          return hash as T;
        }
        case 'eth_getTransactionReceipt': {
          const txHash = params[0] as Hex;
          if (overrides?.onGetReceipt) {
            return (await overrides.onGetReceipt(txHash)) as T;
          }
          if (!submitted.has(txHash.toLowerCase())) return null as T;
          return {
            transactionHash: txHash,
            blockNumber: '0x105',
            status: '0x1',
            effectiveGasPrice: '0x5f5e100',
            gasUsed: '0xc350',
          } as T;
        }
        default:
          return null as T;
      }
    },
  };
}

async function seedFundedWithdrawalLock(
  db: SqliteD1Adapter,
  payoutId: string,
  amountUsd: string,
  ownerId = 'aff-hsm-1'
): Promise<{ lockBatchId: string; amountUnits: bigint }> {
  const ledger = new DoubleEntryLedgerService(db);
  const r2 = new InMemoryR2Bucket();
  const amountUnits = parseUsdToLedgerUnits(amountUsd);
  const grossSeed = amountUnits * BigInt(4);

  const partnerEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'rest_poll',
    rawBytes: JSON.stringify({ payoutId, settledUsd: amountUsd }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const walletEv = await storeEvidenceObject(db, r2, {
    exchange: 'bybit',
    sourceKind: 'wallet_statement',
    rawBytes: JSON.stringify({ payoutId, wallet: true }),
    statementPeriodStart: '2026-11-01T00:00:00Z',
    statementPeriodEnd: '2026-11-01T23:59:59Z',
  });
  const recon = await reconcilePartnerCashBatch(db, {
    exchange: 'bybit',
    evidenceId: partnerEv.id,
    walletEvidenceId: walletEv.id,
    uidAllocatedUnits: grossSeed,
    walletCashCollectedUnits: grossSeed,
    r2,
  });
  const batch = await ledger.recordVerifiedCommissionInflight({
    idempotencyKey: `seed-${payoutId}`,
    exchange: 'bybit',
    traderUid: `uid-${payoutId}`,
    traderId: ownerId,
    l1AffiliateId: null,
    reconciliationId: recon.id,
    evidenceId: partnerEv.id,
    grossCommissionUnits: grossSeed,
    createdAt: '2026-11-01T00:00:00.000Z',
    r2,
  });
  await ledger.releaseMaturedInflightBatch(batch.batch.id, '2026-11-10T00:00:00.000Z');

  const lock = await ledger.lockSettledForWithdrawal({
    idempotencyKey: `lock-${payoutId}`,
    payoutId,
    ownerId,
    ownerType: 'trader',
    amountUnits,
  });

  return { lockBatchId: lock.batch.id, amountUnits };
}

function createTransport(
  apiClientOverride: TurnkeyRawApiClient,
  signTimeoutMs = 40
): TurnkeyServerHsmTransport {
  return new TurnkeyServerHsmTransport({
    organizationId: 'org-test-hsm',
    apiPublicKey: '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    apiPrivateKey: '1111111111111111111111111111111111111111111111111111111111111111',
    signTimeoutMs,
    apiClientOverride,
  });
}

describe('TurnkeyServerHsmTransport & Durable Recovery — Unknown Outcome Hardening', () => {
  it('enforces bounded timeout defaults (10–15s) and rejects invalid configuration with CONFIGURATION_ERROR', () => {
    expect(DEFAULT_TURNKEY_SIGN_TIMEOUT_MS).toBeGreaterThanOrEqual(10_000);
    expect(DEFAULT_TURNKEY_SIGN_TIMEOUT_MS).toBeLessThanOrEqual(15_000);
    expect(MAX_TURNKEY_SIGN_TIMEOUT_MS).toBe(15_000);

    try {
      new TurnkeyServerHsmTransport({
        organizationId: 'org-test',
        apiPublicKey: '03aa',
        apiPrivateKey: '11'.repeat(32),
        signTimeoutMs: 60_000,
      });
      throw new Error('Expected CONFIGURATION_ERROR');
    } catch (err) {
      expect(isTurnkeyHsmOutcomeError(err)).toBe(true);
      expect((err as TurnkeyHsmOutcomeError).outcomeState).toBe('CONFIGURATION_ERROR');
      expect((err as TurnkeyHsmOutcomeError).retryAllowed).toBe(false);
    }
  });

  it('1. Timeout / abort before any request is transmitted classifies DEFINITE_REJECTED with 0 HSM calls', async () => {
    const signCalls: unknown[] = [];
    const transport = createTransport({
      async signRawPayload(params) {
        signCalls.push(params);
        throw new Error('should never be invoked');
      },
    });

    const controller = new AbortController();
    controller.abort();

    await expect(
      transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex: ('0x' + 'ab'.repeat(32)) as Hex,
        payoutId: 'payout-pre-abort-1',
        signal: controller.signal,
      })
    ).rejects.toMatchObject({
      outcomeState: 'DEFINITE_REJECTED',
      requestDispatched: false,
      retryAllowed: false,
      requiresHumanReview: false,
    });
    expect(signCalls).toHaveLength(0);
  });

  it('2. Timeout after request transmission classifies UNCERTAIN_OUTCOME, preserves withdrawal lock, and never reclaims nonce', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-timeout-post-dispatch';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '25.00');

    let signInvocations = 0;
    const hsmTransport = createTransport(
      {
        async signRawPayload(_params, options) {
          signInvocations += 1;
          return new Promise<TurnkeyRawPayloadApiResponse>((_resolve, reject) => {
            options?.signal?.addEventListener('abort', () => {
              reject(new Error('AbortError: socket timed out waiting for Turnkey'));
            });
          });
        },
      },
      30
    );

    const signer = new TurnkeySigner({
      transport: hsmTransport,
      evmHotWalletAddress: EVM_HOT_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
    });
    const evmAdapter = makeEvmAdapter();
    const machine = new BroadcastRecoveryMachine({
      db: legacyDb,
      turnkeySigner: signer,
      evmAdapters: { arbitrum: evmAdapter },
    });

    await expect(
      machine.executeSettlement({
        payoutId,
        idempotencyKey: `idem-${payoutId}`,
        affiliateId: 'aff-hsm-1',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT,
        amountUnits1e8: amountUnits,
        lockBatchId,
      })
    ).rejects.toThrow(/provider outcome uncertain; reconcile retained owner/i);

    // Direct transport invocation also exposes explicit UNCERTAIN_OUTCOME classification
    await expect(
      hsmTransport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex: ('0x' + 'aa'.repeat(32)) as Hex,
        payoutId: 'payout-direct-timeout',
      })
    ).rejects.toMatchObject({
      outcomeState: 'UNCERTAIN_OUTCOME',
      requestDispatched: true,
      retryAllowed: false,
      requiresHumanReview: true,
    });

    // Zero blind retries: 1 call from executeSettlement + 1 direct call
    expect(signInvocations).toBe(2);

    // Broadcast record stays locked in SIGNING (never FAILED_ABORTED, nonce not reclaimed)
    const broadcast = await machine.getSettlementRecord(payoutId);
    expect(broadcast?.state).toBe('SIGNING');
    expect(broadcast?.assigned_nonce).toBe(5);

    // Withdrawal lock remains INFLIGHT (funds preserved in escrow)
    const lockRow = await db
      .prepare(`SELECT status FROM ledger_journal_batches WHERE id = ?`)
      .bind(lockBatchId)
      .first<{ status: string }>();
    expect(lockRow?.status).toBe('INFLIGHT');
  });

  it('3. Timeout after remote acceptance before response recovers via read-only lookup with zero new signing', async () => {
    const digestHex = ('0x' + 'cd'.repeat(32)) as Hex;
    const expectedSig = signEvmDigestDeterministically(digestHex);
    let signCalls = 0;
    let getActivityCalls = 0;
    let remoteCompleted = false;

    const transport = createTransport(
      {
        async signRawPayload() {
          signCalls += 1;
          // Remote accepts and finishes after client timeout
          setTimeout(() => {
            remoteCompleted = true;
          }, 15);
          return new Promise<TurnkeyRawPayloadApiResponse>(() => {
            // Never delivers HTTP response to client
          });
        },
        async getActivity({ activityId }) {
          getActivityCalls += 1;
          if (!remoteCompleted) {
            return { activity: { id: activityId, status: 'ACTIVITY_STATUS_PENDING' } };
          }
          return {
            activity: {
              id: activityId,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: {
                signRawPayloadResult: expectedSig,
              },
            },
          };
        },
      },
      25
    );

    await expect(
      transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex,
        payoutId: 'payout-remote-accepted',
      })
    ).rejects.toMatchObject({
      outcomeState: 'UNCERTAIN_OUTCOME',
      retryAllowed: false,
      requiresHumanReview: true,
    });

    await new Promise((r) => setTimeout(r, 25));

    const recovered = await transport.lookupSigningActivity({
      activityId: 'tk_act_remote_accepted',
      payoutId: 'payout-remote-accepted',
      chain: 'arbitrum',
      signerAddress: EVM_HOT_ADDR,
    });
    expect(recovered.outcomeState).toBe('SIGNED_CONFIRMED');
    expect(recovered.requiresHumanReview).toBe(false);
    expect(recovered.evmSignature?.r).toBe(`0x${expectedSig.r}`);
    expect(recovered.evmSignature?.s).toBe(`0x${expectedSig.s}`);
    expect(signCalls).toBe(1);
    expect(getActivityCalls).toBe(1);
  });

  it('4. Duplicate request identifier deduplicates to a single HSM signing call', async () => {
    const digestHex = ('0x' + '12'.repeat(32)) as Hex;
    const expectedSig = signEvmDigestDeterministically(digestHex);
    let signCalls = 0;

    const transport = createTransport({
      async signRawPayload() {
        signCalls += 1;
        return {
          activity: {
            id: 'tk_act_dup_1',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: { signRawPayloadResult: expectedSig },
          },
        };
      },
    });

    const first = await transport.signEvmDigest({
      chain: 'arbitrum',
      signerAddress: EVM_HOT_ADDR,
      digestHex,
      payoutId: 'payout-dup-id',
      operationIdentity: { signingRequestId: 'req-dup-001', nonceOrSequence: 9 },
    });
    const second = await transport.signEvmDigest({
      chain: 'arbitrum',
      signerAddress: EVM_HOT_ADDR,
      digestHex,
      payoutId: 'payout-dup-id',
      operationIdentity: { signingRequestId: 'req-dup-001', nonceOrSequence: 9 },
    });

    expect(signCalls).toBe(1);
    expect(first.outcomeState).toBe('SIGNED_CONFIRMED');
    expect(second).toEqual(first);
  });

  it('5. Response received twice (concurrent identical request) coalesces cleanly without double signing', async () => {
    const digestHex = ('0x' + '34'.repeat(32)) as Hex;
    const expectedSig = signEvmDigestDeterministically(digestHex);
    let signCalls = 0;

    const transport = createTransport({
      async signRawPayload() {
        signCalls += 1;
        await new Promise((r) => setTimeout(r, 15));
        return {
          activity: {
            id: 'tk_act_twice_1',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: { signRawPayloadResult: expectedSig },
          },
        };
      },
    });

    const [a, b] = await Promise.all([
      transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex,
        payoutId: 'payout-twice',
        operationIdentity: { signingRequestId: 'req-twice-1' },
      }),
      transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex,
        payoutId: 'payout-twice',
        operationIdentity: { signingRequestId: 'req-twice-1' },
      }),
    ]);

    expect(signCalls).toBe(1);
    expect(a.activityId).toBe('tk_act_twice_1');
    expect(b).toEqual(a);
  });

  it('6. Concurrent workers retrying the same withdrawal produce at most one HSM signature and zero double settlement', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-concurrent-workers';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '30.00');

    let signCalls = 0;
    const makeWorkerMachine = () => {
      const hsmTransport = createTransport(
        {
          async signRawPayload(params) {
            signCalls += 1;
            await new Promise((r) => setTimeout(r, 15));
            const sig = signEvmDigestDeterministically(params.payload);
            return {
              activity: {
                id: `tk_act_worker_${signCalls}`,
                status: 'ACTIVITY_STATUS_COMPLETED',
                result: { signRawPayloadResult: sig },
              },
            };
          },
        },
        1000
      );
      const signer = new TurnkeySigner({
        transport: hsmTransport,
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });
      const evmAdapter = makeEvmAdapter();
      return new BroadcastRecoveryMachine({
        db: legacyDb,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: evmAdapter },
      });
    };

    const worker1 = makeWorkerMachine();
    const worker2 = makeWorkerMachine();
    const req = {
      payoutId,
      idempotencyKey: `idem-${payoutId}`,
      affiliateId: 'aff-hsm-1',
      chain: 'arbitrum' as const,
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: amountUnits,
      lockBatchId,
    };

    const settled = await Promise.allSettled([
      worker1.executeSettlement(req),
      worker2.executeSettlement(req),
    ]);

    // Exactly one worker signs; the other either reuses idempotent state or fails closed on workflow ownership
    expect(signCalls).toBe(1);
    const fulfilled = settled.filter((s) => s.status === 'fulfilled');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    const row = await worker1.getSettlementRecord(payoutId);
    expect(row?.state).toBe('CONFIRMED');
  });

  it('7. HSM returns explicit denial classifies POLICY_DENIED with zero retry', async () => {
    let signCalls = 0;
    const transport = createTransport({
      async signRawPayload() {
        signCalls += 1;
        const err = Object.assign(new Error('Turnkey policy denied: consensus needed'), {
          status: 403,
          code: 'POLICY_DENIED',
        });
        throw err;
      },
    });

    await expect(
      transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex: ('0x' + 'ef'.repeat(32)) as Hex,
        payoutId: 'payout-policy-denied',
      })
    ).rejects.toMatchObject({
      outcomeState: 'POLICY_DENIED',
      requestDispatched: true,
      retryAllowed: false,
    });
    expect(signCalls).toBe(1);
  });

  it('8. HSM returns a malformed signature classifies UNCERTAIN_OUTCOME and refuses assembly', async () => {
    const unsigned = buildValidUnsignedStellarTx();
    const transport = createTransport({
      async signRawPayload() {
        // Valid hex lengths but garbage Ed25519 signature bytes that fail verification
        return {
          activity: {
            id: 'tk_act_malformed_sig',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signRawPayloadResult: {
                r: '11'.repeat(32),
                s: '22'.repeat(32),
              },
            },
          },
        };
      },
    });

    await expect(
      transport.signStellarEnvelope({
        signerAddress: STELLAR_HOT_PUB,
        unsignedEnvelopeXdr: unsigned.xdr,
        txHashHex: unsigned.hashHex,
        payoutId: 'payout-malformed-stellar',
      })
    ).rejects.toMatchObject({
      outcomeState: 'UNCERTAIN_OUTCOME',
      activityId: 'tk_act_malformed_sig',
      retryAllowed: false,
      requiresHumanReview: true,
    });
  });

  it('9. Emergency pause activating while signing request is pending blocks further signing/broadcast fail-closed', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-pause-midflight';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '20.00');

    let signCalls = 0;
    let broadcastCalls = 0;
    const hsmTransport = createTransport(
      {
        async signRawPayload(params) {
          signCalls += 1;
          // Activate EMERGENCY_PAUSE while Turnkey signing is in flight
          await db
            .prepare(`UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'`)
            .run();
          await db
            .prepare(`UPDATE system_safety_epoch SET epoch = epoch + 1 WHERE singleton = 1`)
            .run();
          const sig = signEvmDigestDeterministically(params.payload);
          return {
            activity: {
              id: 'tk_act_pause_mid',
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: { signRawPayloadResult: sig },
            },
          };
        },
      },
      1000
    );

    const signer = new TurnkeySigner({
      transport: hsmTransport,
      evmHotWalletAddress: EVM_HOT_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
    });
    const evmAdapter = makeEvmAdapter({
        async onSendRawTransaction(raw) {
          broadcastCalls += 1;
          return keccak256(raw);
        },
      });
    const machine = new BroadcastRecoveryMachine({
      db: legacyDb,
      turnkeySigner: signer,
      evmAdapters: { arbitrum: evmAdapter },
    });

    const pauseResult = await machine.executeSettlement({
      payoutId,
      idempotencyKey: `idem-${payoutId}`,
      affiliateId: 'aff-hsm-1',
      chain: 'arbitrum',
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: amountUnits,
      lockBatchId,
    });

    expect(pauseResult.state).toBe('BROADCAST_PENDING');
    expect(pauseResult.reason).toMatch(/Payout effect denied/i);
    expect(signCalls).toBe(1);
    expect(broadcastCalls).toBe(0);
    // Signed tx was persisted before broadcast fence blocked; lock remains intact
    const lockRow = await db
      .prepare(`SELECT status FROM ledger_journal_batches WHERE id = ?`)
      .bind(lockBatchId)
      .first<{ status: string }>();
    expect(lockRow?.status).toBe('INFLIGHT');
  });

  it('10. Ledger freeze activating during recovery blocks active re-signing and preserves locked liabilities', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-freeze-recovery';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '22.00');

    // Simulate a stuck BROADCAST_PENDING record before freeze activates
    const hsmTransport = createTransport(
      {
        async signRawPayload(params) {
          const sig = signEvmDigestDeterministically(params.payload);
          return {
            activity: {
              id: 'tk_act_freeze_1',
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: { signRawPayloadResult: sig },
            },
          };
        },
      },
      1000
    );
    const signer = new TurnkeySigner({
      transport: hsmTransport,
      evmHotWalletAddress: EVM_HOT_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
    });
    const evmAdapter = makeEvmAdapter({
        async onSendRawTransaction() {
          throw new Error('504 Gateway Timeout during broadcast');
        },
        async onGetReceipt() {
          return null;
        },
      });
    const machine = new BroadcastRecoveryMachine({
      db: legacyDb,
      turnkeySigner: signer,
      evmAdapters: { arbitrum: evmAdapter },
    });

    const initial = await machine.executeSettlement({
      payoutId,
      idempotencyKey: `idem-${payoutId}`,
      affiliateId: 'aff-hsm-1',
      chain: 'arbitrum',
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: amountUnits,
      lockBatchId,
    });
    expect(initial.state).toBe('BROADCAST_PENDING');

    // Activate EMERGENCY_LEDGER_FREEZE
    await db
      .prepare(`UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_LEDGER_FREEZE'`)
      .run();
    await db
      .prepare(`UPDATE system_safety_epoch SET epoch = epoch + 1 WHERE singleton = 1`)
      .run();

    // Active recovery attempting rebroadcast/RBF must fail closed under freeze (zero RBF signing)
    const blockedRecovery = await machine.recoverUncertainBroadcast(payoutId, { forceRbfBump: true });
    expect(blockedRecovery.state).toBe('BROADCAST_PENDING');
    expect(blockedRecovery.action).toBe('STILL_BROADCAST_PENDING');
    expect(blockedRecovery.reason).toMatch(/Payout effect denied/i);

    // Passive read-only check still works without mutating or releasing the lock
    const passive = await machine.recoverUncertainBroadcast(payoutId, { passiveOnly: true });
    expect(passive.state).toBe('BROADCAST_PENDING');

    const lockRow = await db
      .prepare(`SELECT status FROM ledger_journal_batches WHERE id = ?`)
      .bind(lockBatchId)
      .first<{ status: string }>();
    expect(lockRow?.status).toBe('INFLIGHT');
  });

  it('11. Network disconnect after signing but before broadcast recovers exact signed tx with zero re-signing', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-disconnect-post-sign';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '18.00');

    let signCalls = 0;
    let sendCalls = 0;
    let allowSend = false;
    let broadcastTxHash: Hex | null = null;

    const hsmTransport = createTransport(
      {
        async signRawPayload(params) {
          signCalls += 1;
          const sig = signEvmDigestDeterministically(params.payload);
          return {
            activity: {
              id: 'tk_act_net_drop',
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: { signRawPayloadResult: sig },
            },
          };
        },
      },
      1000
    );
    const signer = new TurnkeySigner({
      transport: hsmTransport,
      evmHotWalletAddress: EVM_HOT_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
    });
    const evmAdapter = makeEvmAdapter({
        async onSendRawTransaction(raw) {
          sendCalls += 1;
          if (!allowSend) {
            throw new Error('ECONNRESET: network disconnect before broadcast');
          }
          broadcastTxHash = keccak256(raw);
          return broadcastTxHash;
        },
        onGetReceipt: async (txHash) =>
          broadcastTxHash && txHash.toLowerCase() === broadcastTxHash.toLowerCase()
            ? {
                transactionHash: txHash,
                blockNumber: '0x105',
                status: '0x1',
                effectiveGasPrice: '0x5f5e100',
                gasUsed: '0xc350',
              }
            : null,
      });
    const machine = new BroadcastRecoveryMachine({
      db: legacyDb,
      turnkeySigner: signer,
      evmAdapters: { arbitrum: evmAdapter },
    });

    const first = await machine.executeSettlement({
      payoutId,
      idempotencyKey: `idem-${payoutId}`,
      affiliateId: 'aff-hsm-1',
      chain: 'arbitrum',
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: amountUnits,
      lockBatchId,
    });
    expect(first.state).toBe('BROADCAST_PENDING');
    expect(signCalls).toBe(1);
    expect(sendCalls).toBe(1);

    // Persisted signed_raw_tx is durably stored in D1 for safe recovery without re-signing
    const persisted = await db
      .prepare('SELECT state, tx_hash, signed_raw_tx FROM settlement_broadcasts WHERE payout_id = ?')
      .bind(payoutId)
      .first<{ state: string; tx_hash: string; signed_raw_tx: string | null }>();
    expect(persisted?.state).toBe('BROADCAST_PENDING');
    expect(persisted?.signed_raw_tx).toBeTruthy();

    // While the disconnected broadcast grant is still unresolved and no receipt is observed,
    // recovery stays fail-closed in BROADCAST_PENDING with zero re-signing.
    const pendingCheck = await machine.recoverUncertainBroadcast(payoutId);
    expect(pendingCheck.state).toBe('BROADCAST_PENDING');
    expect(signCalls).toBe(1);

    // Once the exact persisted signed tx is broadcast/observed on-chain, read-only recovery
    // reconciles to CONFIRMED with zero re-signing and exact same txHash.
    allowSend = true;
    broadcastTxHash = first.txHash as Hex;
    const confirmed = await machine.recoverUncertainBroadcast(payoutId);
    expect(confirmed.state).toBe('CONFIRMED');
    expect(confirmed.action).toBe('RECONCILED_ON_CHAIN');
    expect(signCalls).toBe(1);
    expect(confirmed.txHash).toBe(first.txHash);
  });

  it('12. Restart and recovery from persisted uncertain state completes without double settlement and preserves ledger invariants', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-restart-recovery';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '40.00');

    let signCalls = 0;
    let confirmedTxHash: Hex | null = null;

    const buildMachine = (networkUp: boolean) => {
      const hsmTransport = createTransport(
        {
          async signRawPayload(params) {
            signCalls += 1;
            const sig = signEvmDigestDeterministically(params.payload);
            return {
              activity: {
                id: 'tk_act_restart_1',
                status: 'ACTIVITY_STATUS_COMPLETED',
                result: { signRawPayloadResult: sig },
              },
            };
          },
        },
        1000
      );
      const signer = new TurnkeySigner({
        transport: hsmTransport,
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });
      const evmAdapter = makeEvmAdapter({
          async onSendRawTransaction(raw) {
            const hash = keccak256(raw);
            confirmedTxHash = hash;
            if (!networkUp) {
              throw new Error('504 Gateway Timeout after mempool acceptance');
            }
            return hash;
          },
          async onGetReceipt(txHash) {
            if (!networkUp || txHash !== confirmedTxHash) return null;
            return {
              transactionHash: txHash,
              blockNumber: '0x105',
              status: '0x1',
              effectiveGasPrice: '0x5f5e100',
              gasUsed: '0xc350',
            };
          },
        });
      return new BroadcastRecoveryMachine({
        db: legacyDb,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: evmAdapter },
      });
    };

    // Process 1 crashes/times out after broadcast
    const process1 = buildMachine(false);
    const res1 = await process1.executeSettlement({
      payoutId,
      idempotencyKey: `idem-${payoutId}`,
      affiliateId: 'aff-hsm-1',
      chain: 'arbitrum',
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: amountUnits,
      lockBatchId,
    });
    expect(res1.state).toBe('BROADCAST_PENDING');
    expect(signCalls).toBe(1);

    // Process 2 starts fresh after restart and recovers from persisted D1 state
    const process2 = buildMachine(true);
    const res2 = await process2.recoverUncertainBroadcast(payoutId);
    expect(res2.state).toBe('CONFIRMED');
    expect(res2.txHash).toBe(res1.txHash);
    expect(signCalls).toBe(1);

    // Verify ledger invariants remain 100% sound
    const ledger = new DoubleEntryLedgerService(db);
    await ledger.finalizeWithdrawal({
      idempotencyKey: `finalize-${payoutId}`,
      lockBatchId,
      payoutId,
      txHash: res2.txHash!,
      chain: 'arbitrum',
    });
    const inv = await verifyLedgerInvariants(db);
    expect(inv.valid).toBe(true);
  });

  it('classifies read-only lookup network failure as TRANSIENT_READ_ERROR (safe to re-poll, never re-sign)', async () => {
    const transport = createTransport({
      async signRawPayload() {
        throw new Error('should not be called');
      },
      async getActivity() {
        throw new Error('ECONNRESET reading activity status');
      },
    });

    const res = await transport.lookupSigningActivity({
      activityId: 'tk_act_read_err',
      payoutId: 'payout-read-err',
      chain: 'arbitrum',
      signerAddress: EVM_HOT_ADDR,
    });
    expect(res.outcomeState).toBe('TRANSIENT_READ_ERROR');
    expect(res.requiresHumanReview).toBe(false);
  });

  it('classifies HTTP 500 with validation-like text as UNCERTAIN_OUTCOME (server-side failure after acceptance)', async () => {
    const transport = createTransport({
      async signRawPayload() {
        const err = new Error('invalid argument from upstream proxy') as Error & { status?: number };
        err.status = 500;
        throw err;
      },
    });

    await expect(
      transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex: ('0x' + 'aa'.repeat(32)) as Hex,
        payoutId: 'payout-500-ambiguous',
      })
    ).rejects.toMatchObject({
      outcomeState: 'UNCERTAIN_OUTCOME',
      retryAllowed: false,
      requiresHumanReview: true,
    });
  });

  it('classifies malformed completed activity signature and invalid EVM vHex as UNCERTAIN_OUTCOME requiring human review', async () => {
    const transport = createTransport({
      async signRawPayload() {
        throw new Error('should not be called');
      },
      async getActivity({ activityId }) {
        return {
          activity: {
            id: activityId,
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signRawPayloadResult: {
                r: 'ab'.repeat(32),
                s: 'cd'.repeat(32),
                v: 'not-hex',
              },
            },
          },
        };
      },
    });

    const res = await transport.lookupSigningActivity({
      activityId: 'tk_act_bad_vhex',
      payoutId: 'payout-bad-vhex',
      chain: 'arbitrum',
      signerAddress: EVM_HOT_ADDR,
    });
    expect(res.outcomeState).toBe('UNCERTAIN_OUTCOME');
    expect(res.requiresHumanReview).toBe(true);
    expect(res.activityId).toBe('tk_act_bad_vhex');
  });

  it('persists turnkey_activity_id on settlement_broadcasts even when withPayoutEffect wraps TurnkeyHsmOutcomeError', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-persist-activity-id';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '15.00');

    const hsmTransport = createTransport({
      async signRawPayload() {
        return {
          activity: {
            id: 'tk_act_pending_persist_999',
            status: 'ACTIVITY_STATUS_PENDING',
          },
        };
      },
    });
    const signer = new TurnkeySigner({
      transport: hsmTransport,
      evmHotWalletAddress: EVM_HOT_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
    });
    const evmAdapter = makeEvmAdapter();
    const machine = new BroadcastRecoveryMachine({
      db: legacyDb,
      turnkeySigner: signer,
      evmAdapters: { arbitrum: evmAdapter },
    });

    await expect(
      machine.executeSettlement({
        payoutId,
        idempotencyKey: `idem-${payoutId}`,
        affiliateId: 'aff-hsm-1',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT,
        amountUnits1e8: amountUnits,
        lockBatchId,
      })
    ).rejects.toThrow(/provider outcome uncertain/i);

    const row = await db
      .prepare('SELECT state, turnkey_activity_id, error_reason FROM settlement_broadcasts WHERE payout_id = ?')
      .bind(payoutId)
      .first<{ state: string; turnkey_activity_id: string | null; error_reason: string | null }>();
    expect(row?.state).toBe('SIGNING');
    expect(row?.turnkey_activity_id).toBe('tk_act_pending_persist_999');
    expect(row?.error_reason).toContain('ACTIVITY_STATUS_PENDING');
  });

  it('persists turnkey_activity_id and error_reason on Stellar settlement_broadcasts when withPayoutEffect wraps TurnkeyHsmOutcomeError', async () => {
    const { db, legacyDb } = createTestDb();
    const payoutId = 'payout-persist-stellar-activity-id';
    const { lockBatchId, amountUnits } = await seedFundedWithdrawalLock(db, payoutId, '15.00');
    const stellarDest = StellarSdk.Keypair.random().publicKey();

    const hsmTransport = createTransport({
      async signRawPayload() {
        return {
          activity: {
            id: 'tk_act_stellar_pending_777',
            status: 'ACTIVITY_STATUS_PENDING',
          },
        };
      },
    });
    const signer = new TurnkeySigner({
      transport: hsmTransport,
      evmHotWalletAddress: EVM_HOT_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
    });
    const unsignedStellar = buildValidUnsignedStellarTx();
    const stellarTransport: StellarBroadcastTransport = {
      async hasUsdcTrustline() {
        return true;
      },
      async getAccountSequence() {
        return 100n;
      },
      async buildUnsignedUsdcPayment() {
        return {
          unsignedEnvelopeXdr: unsignedStellar.xdr,
          txHashHex: unsignedStellar.hashHex,
          timeboundsMaxUnix: Math.floor(Date.now() / 1000) + 180,
        };
      },
      async getTransactionStatus() {
        return 'not_found';
      },
      async submitSignedTransaction() {
        throw new Error('must not broadcast when HSM signing is uncertain');
      },
    };
    const machine = new BroadcastRecoveryMachine({
      db: legacyDb,
      turnkeySigner: signer,
      stellarTransport,
    });

    await expect(
      machine.executeSettlement({
        payoutId,
        idempotencyKey: `idem-${payoutId}`,
        affiliateId: 'aff-hsm-1',
        chain: 'stellar',
        recipientAddress: stellarDest,
        amountUnits1e8: amountUnits,
        lockBatchId,
      })
    ).rejects.toThrow(/provider outcome uncertain/i);

    const row = await db
      .prepare('SELECT state, turnkey_activity_id, error_reason FROM settlement_broadcasts WHERE payout_id = ?')
      .bind(payoutId)
      .first<{ state: string; turnkey_activity_id: string | null; error_reason: string | null }>();
    expect(row?.state).toBe('SIGNING');
    expect(row?.turnkey_activity_id).toBe('tk_act_stellar_pending_777');
    expect(row?.error_reason).toContain('ACTIVITY_STATUS_PENDING');
  });
});
