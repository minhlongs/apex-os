/**
 * @jest-environment node
 *
 * Pre-Live Security Closure Regression Suite
 *
 * Independently verifies:
 * 1. EVM signature recovery parameter validation (v in {0, 1, 27, 28}) and
 *    secp256k1 signer address recovery on both initial signing and read-only
 *    activity lookup, with full financial-state assertions.
 * 2. D1 settlement_broadcasts INSERT/UPDATE finality trigger adversarial tests
 *    (12 negative cases + trust-boundary test + fresh and 001..036 upgrade).
 * 3. Raw Stellar secret-key signing path isolation (sendPayout, submitTransaction,
 *    processBatchPayouts, and StellarSettlementAdapter fail closed; read-only preserved).
 * 4. No-blind-retry guarantee across 8 Stellar broadcast fault-injection scenarios
 *    with zero duplicate payouts and exact accounting conservation:
 *    ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, recoverAddress, type Hex } from 'viem';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
const nodeMod = (
  process as unknown as {
    getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire };
  }
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
  TurnkeyHsmOutcomeError,
  TurnkeyServerHsmTransport,
  TurnkeySigner,
  type TurnkeyRawApiClient,
  type TurnkeyRawPayloadApiResponse,
} from '@/lib/payouts/turnkey-signer';
import {
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
  LegacyPayoutPathDisabledError,
  StellarNetwork,
  StellarService,
} from '@/lib/payouts/stellar-service';
import { StellarAdapter } from '@/lib/payouts/adapters/stellar-adapter';

// Deterministic Hardhat/Anvil test keypairs (never used on mainnet)
const AUTHORIZED_EVM_PRIVKEY =
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const AUTHORIZED_EVM_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const UNAUTHORIZED_EVM_PRIVKEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const EVM_RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';

const STELLAR_KEYPAIR = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 11));
const STELLAR_HOT_PUB = STELLAR_KEYPAIR.publicKey();
const STELLAR_RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

const MIGRATIONS_DIR = path.resolve(process.cwd(), 'src/database/migrations');

const BASE_MIGRATIONS_001_036 = [
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
];

function createMigratedDb(include037 = true): {
  sqlite: Database.Database;
  db: SqliteD1Adapter;
  legacyDb: LegacyD1Database;
} {
  const sqlite = new Database(':memory:');
  for (const filename of BASE_MIGRATIONS_001_036) {
    sqlite.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8'));
  }
  if (include037) {
    sqlite.exec(
      fs.readFileSync(path.join(MIGRATIONS_DIR, '037_hardening_trigger_and_exposure.sql'), 'utf8')
    );
  }
  const db = new SqliteD1Adapter(sqlite);
  return { sqlite, db, legacyDb: db as unknown as LegacyD1Database };
}

function signDigestWithKey(
  digestHex: Hex,
  privKeyHex: string
): { r: string; s: string; recovery: 0 | 1; vLegacyHex: string; vYParityHex: string } {
  const clean = digestHex.replace(/^0x/i, '');
  const sig = secp256k1.sign(Buffer.from(clean, 'hex'), Buffer.from(privKeyHex.slice(2), 'hex'), {
    lowS: true,
  });
  const recovery: 0 | 1 = sig.recovery === 1 ? 1 : 0;
  return {
    r: sig.r.toString(16).padStart(64, '0'),
    s: sig.s.toString(16).padStart(64, '0'),
    recovery,
    vLegacyHex: recovery === 1 ? '1c' : '1b',
    vYParityHex: recovery === 1 ? '01' : '00',
  };
}

function createHsmTransport(apiClientOverride: TurnkeyRawApiClient): TurnkeyServerHsmTransport {
  return new TurnkeyServerHsmTransport({
    organizationId: 'org-test-sec-closure',
    apiPublicKey: '03aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    apiPrivateKey: '1111111111111111111111111111111111111111111111111111111111111111',
    signTimeoutMs: 1000,
    apiClientOverride,
  });
}

async function seedFundedAffiliate(
  db: SqliteD1Adapter,
  sqlite: Database.Database,
  affiliateId: string,
  amountUsd: string
): Promise<{ lockBatchId: string; units: bigint; originalLiabilityUnits: bigint }> {
  const payoutId = `payout-${affiliateId}`;
  const ledger = new DoubleEntryLedgerService(db);
  const r2 = new InMemoryR2Bucket();
  const units = parseUsdToLedgerUnits(amountUsd);
  const grossSeed = units * BigInt(4);

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
    traderId: affiliateId,
    l1AffiliateId: null,
    reconciliationId: recon.id,
    evidenceId: partnerEv.id,
    grossCommissionUnits: grossSeed,
    createdAt: '2026-11-01T00:00:00.000Z',
    r2,
  });
  await ledger.releaseMaturedInflightBatch(batch.batch.id, '2026-11-10T00:00:00.000Z');

  const preLockRow = sqlite
    .prepare(
      `SELECT COALESCE(SUM(settled_balance_units + inflight_balance_units), 0) AS total
       FROM ledger_accounts
       WHERE owner_id = ?`
    )
    .get(affiliateId) as { total: number };
  const originalLiabilityUnits = BigInt(preLockRow.total);

  const lock = await ledger.lockSettledForWithdrawal({
    idempotencyKey: `lock-${payoutId}`,
    payoutId,
    ownerId: affiliateId,
    ownerType: 'trader',
    amountUnits: units,
  });

  return { lockBatchId: lock.batch.id, units, originalLiabilityUnits };
}

function createMockEvmRpc(): {
  transport: EvmJsonRpcTransport;
  broadcastCalls: number;
} {
  const state = { broadcastCalls: 0 };
  const transport: EvmJsonRpcTransport = {
    async call(method: string, params: unknown[]) {
      if (method === 'eth_chainId') return '0xa4b1';
      if (method === 'eth_getTransactionCount') return '0x0';
      if (method === 'eth_gasPrice') return '0x5f5e100';
      if (method === 'eth_maxPriorityFeePerGas') return '0x5f5e100';
      if (method === 'eth_getBlockByNumber') {
        return { baseFeePerGas: '0x5f5e100', number: '0x100' };
      }
      if (method === 'eth_estimateGas') return '0x15f90';
      if (method === 'eth_call') {
        const callObj = params[0] as { data?: string };
        if (callObj?.data?.startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR)) {
          return '0x' + '0'.repeat(64);
        }
        return '0x' + (1_000_000_000n).toString(16).padStart(64, '0');
      }
      if (method === 'eth_sendRawTransaction') {
        state.broadcastCalls += 1;
        return keccak256((params[0] as Hex) ?? '0x00');
      }
      if (method === 'eth_getTransactionReceipt') return null;
      if (method === 'eth_blockNumber') return '0x105';
      throw new Error(`Unexpected EVM RPC method: ${method}`);
    },
  };
  return {
    transport,
    get broadcastCalls() {
      return state.broadcastCalls;
    },
  };
}

function assertAccountingConservation(
  sqlite: Database.Database,
  affiliateId: string,
  originalLiabilityUnits: bigint
): {
  verifiedSettlement: bigint;
  remainingLiability: bigint;
  validReversals: bigint;
} {
  const acctRow = sqlite
    .prepare(
      `SELECT COALESCE(SUM(settled_balance_units), 0) AS settled,
              COALESCE(SUM(inflight_balance_units), 0) AS inflight
       FROM ledger_accounts
       WHERE owner_id = ?`
    )
    .get(affiliateId) as { settled: number; inflight: number };

  const payable = BigInt(acctRow.settled);
  const inflight = BigInt(acctRow.inflight);

  const finalizedRow = sqlite
    .prepare(
      `SELECT COALESCE(SUM(amount_units_1e8), 0) AS total
       FROM settlement_broadcasts
       WHERE affiliate_id = ?
         AND state = 'CONFIRMED'
         AND confirmation_lane IN ('HOT', 'COLD')`
    )
    .get(affiliateId) as { total: number };
  const verifiedSettlement = BigInt(finalizedRow.total);

  const lockedInflightRow = sqlite
    .prepare(
      `SELECT COALESCE(SUM(b.gross_commission_units), 0) AS total
       FROM ledger_journal_batches b
       WHERE b.journal_type = 'WITHDRAWAL_LOCK'
         AND b.status = 'INFLIGHT'
         AND NOT EXISTS (
           SELECT 1 FROM settlement_broadcasts sb
           WHERE sb.lock_batch_id = b.id
             AND sb.state = 'CONFIRMED'
             AND sb.confirmation_lane IN ('HOT', 'COLD')
         )
         AND EXISTS (
           SELECT 1 FROM ledger_postings p
           JOIN ledger_accounts a ON a.id = p.account_id
           WHERE p.batch_id = b.id AND a.owner_id = ?
         )`
    )
    .get(affiliateId) as { total: number };
  const lockedInflight = BigInt(lockedInflightRow.total);

  const revertedRow = sqlite
    .prepare(
      `SELECT COALESCE(SUM(b.gross_commission_units), 0) AS total
       FROM ledger_journal_batches b
       WHERE b.journal_type = 'WITHDRAWAL_REVERTED'
         AND EXISTS (
           SELECT 1 FROM ledger_postings p
           JOIN ledger_accounts a ON a.id = p.account_id
           WHERE p.batch_id = b.id AND a.owner_id = ?
         )`
    )
    .get(affiliateId) as { total: number };
  const validReversals = BigInt(revertedRow.total);

  // Remaining liability is whatever is still owed to the affiliate (settled payable + inflight + active withdrawal lock).
  const remainingLiability = payable + inflight + lockedInflight;
  expect(remainingLiability).toBeGreaterThanOrEqual(0n);
  expect(payable).toBeGreaterThanOrEqual(0n);
  expect(inflight).toBeGreaterThanOrEqual(0n);
  expect(validReversals).toBe(0n);
  expect(verifiedSettlement + remainingLiability + validReversals).toBe(originalLiabilityUnits);

  return { verifiedSettlement, remainingLiability, validReversals };
}

// ============================================================================
// SECTION 1: EVM Signature Recovery Parameter & Signer Verification
// ============================================================================

describe('EVM signature recovery parameter validation and signer recovery', () => {
  it('accepts strictly valid v in {0, 1, 27, 28} and verifies r/s encoding and recovered signer on both signEvmDigest and lookupSigningActivity', async () => {
    // Find two digests whose deterministic secp256k1 signatures have recovery=0 and recovery=1
    let digestRec0: Hex | null = null;
    let digestRec1: Hex | null = null;
    for (let i = 1; i < 200 && (!digestRec0 || !digestRec1); i++) {
      const candidate = keccak256(`0x${i.toString(16).padStart(64, '0')}` as Hex);
      const sig = signDigestWithKey(candidate, AUTHORIZED_EVM_PRIVKEY);
      if (sig.recovery === 0 && !digestRec0) digestRec0 = candidate;
      if (sig.recovery === 1 && !digestRec1) digestRec1 = candidate;
    }
    expect(digestRec0).not.toBeNull();
    expect(digestRec1).not.toBeNull();

    const validFixtures: Array<{ label: string; digest: Hex; vHex: string; expectedParity: 0 | 1 }> = [
      { label: 'v=0 (00)', digest: digestRec0!, vHex: '00', expectedParity: 0 },
      { label: 'v=27 (1b)', digest: digestRec0!, vHex: '1b', expectedParity: 0 },
      { label: 'v=1 (01)', digest: digestRec1!, vHex: '01', expectedParity: 1 },
      { label: 'v=28 (1c)', digest: digestRec1!, vHex: '1c', expectedParity: 1 },
    ];

    for (const fixture of validFixtures) {
      const sig = signDigestWithKey(fixture.digest, AUTHORIZED_EVM_PRIVKEY);
      const transport = createHsmTransport({
        async signRawPayload(): Promise<TurnkeyRawPayloadApiResponse> {
          return {
            activity: {
              id: `tk_valid_${fixture.vHex}`,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: {
                signRawPayloadResult: { r: sig.r, s: sig.s, v: fixture.vHex },
              },
            },
          };
        },
        async getActivity(): Promise<TurnkeyRawPayloadApiResponse> {
          return {
            activity: {
              id: `tk_valid_${fixture.vHex}`,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: {
                signRawPayloadResult: { r: sig.r, s: sig.s, v: fixture.vHex },
              },
            },
          };
        },
      });

      const signed = await transport.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: AUTHORIZED_EVM_ADDR,
        digestHex: fixture.digest,
        payoutId: `payout-valid-${fixture.vHex}`,
      });
      expect(signed.r).toBe(`0x${sig.r}`);
      expect(signed.s).toBe(`0x${sig.s}`);
      expect(signed.yParity).toBe(fixture.expectedParity);

      const vByte = signed.yParity === 0 ? '1b' : '1c';
      const recovered = await recoverAddress({
        hash: fixture.digest,
        signature: `0x${signed.r.slice(2)}${signed.s.slice(2)}${vByte}` as Hex,
      });
      expect(recovered.toLowerCase()).toBe(AUTHORIZED_EVM_ADDR.toLowerCase());

      const lookup = await transport.lookupSigningActivity({
        activityId: `tk_valid_${fixture.vHex}`,
        payoutId: `payout-valid-${fixture.vHex}`,
        chain: 'arbitrum',
        signerAddress: AUTHORIZED_EVM_ADDR,
        digestHex: fixture.digest,
      });
      expect(lookup.outcomeState).toBe('SIGNED_CONFIRMED');
      expect(lookup.requiresHumanReview).toBe(false);
      expect(lookup.evmSignature?.r).toBe(`0x${sig.r}`);
      expect(lookup.evmSignature?.s).toBe(`0x${sig.s}`);
      expect(lookup.evmSignature?.yParity).toBe(fixture.expectedParity);
    }
  });

  const INVALID_V_CASES: Array<{ label: string; v: string }> = [
    { label: 'v=2 (02)', v: '02' },
    { label: 'v=26 (1a)', v: '1a' },
    { label: 'v=29 (1d)', v: '1d' },
    { label: 'v=30 (1e)', v: '1e' },
    { label: 'v=35 (23)', v: '23' },
    { label: 'v=37 (25)', v: '25' },
    { label: 'v=255 (ff)', v: 'ff' },
    { label: 'malformed hex (zz)', v: 'zz' },
    { label: 'empty v', v: '' },
    { label: 'negative value (-1)', v: '-1' },
    { label: 'non-integer value (1.5)', v: '1.5' },
    { label: 'oversized value (10000)', v: '10000' },
  ];

  test.each(INVALID_V_CASES)(
    'rejects invalid EVM recovery parameter $label in both signEvmDigest and lookupSigningActivity as UNCERTAIN_OUTCOME',
    async ({ label, v }) => {
      const digest = keccak256('0x1111111111111111111111111111111111111111111111111111111111111111');
      const sig = signDigestWithKey(digest, AUTHORIZED_EVM_PRIVKEY);

      const transport = createHsmTransport({
        async signRawPayload(): Promise<TurnkeyRawPayloadApiResponse> {
          return {
            activity: {
              id: `tk_invalid_${label}`,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: {
                signRawPayloadResult: { r: sig.r, s: sig.s, v },
              },
            },
          };
        },
        async getActivity(): Promise<TurnkeyRawPayloadApiResponse> {
          return {
            activity: {
              id: `tk_invalid_${label}`,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: {
                signRawPayloadResult: { r: sig.r, s: sig.s, v },
              },
            },
          };
        },
      });

      await expect(
        transport.signEvmDigest({
          chain: 'base',
          signerAddress: AUTHORIZED_EVM_ADDR,
          digestHex: digest,
          payoutId: `payout-bad-v-${label}`,
        })
      ).rejects.toMatchObject({
        outcomeState: 'UNCERTAIN_OUTCOME',
        requiresHumanReview: true,
        retryAllowed: false,
      });

      const lookup = await transport.lookupSigningActivity({
        activityId: `tk_invalid_${label}`,
        payoutId: `payout-bad-v-${label}`,
        chain: 'base',
        signerAddress: AUTHORIZED_EVM_ADDR,
        digestHex: digest,
      });
      expect(lookup.outcomeState).toBe('UNCERTAIN_OUTCOME');
      expect(lookup.requiresHumanReview).toBe(true);
    }
  );

  it('rejects wrong recovery parity and unauthorized recovered signer in both signEvmDigest and lookupSigningActivity', async () => {
    const digest = keccak256('0x2222222222222222222222222222222222222222222222222222222222222222');
    const authSig = signDigestWithKey(digest, AUTHORIZED_EVM_PRIVKEY);
    const flippedParityV = authSig.recovery === 0 ? '1c' : '1b';
    const unauthSig = signDigestWithKey(digest, UNAUTHORIZED_EVM_PRIVKEY);

    const SECP256K1_N =
      0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const highSHex = (SECP256K1_N - BigInt(`0x${authSig.s}`)).toString(16).padStart(64, '0');

    const cases = [
      { name: 'wrong-parity', r: authSig.r, s: authSig.s, v: flippedParityV },
      { name: 'wrong-signer', r: unauthSig.r, s: unauthSig.s, v: unauthSig.vLegacyHex },
      { name: 'high-s-eip2-malleable', r: authSig.r, s: highSHex, v: flippedParityV },
    ];

    for (const c of cases) {
      const transport = createHsmTransport({
        async signRawPayload(): Promise<TurnkeyRawPayloadApiResponse> {
          return {
            activity: {
              id: `tk_${c.name}`,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: { signRawPayloadResult: { r: c.r, s: c.s, v: c.v } },
            },
          };
        },
        async getActivity(): Promise<TurnkeyRawPayloadApiResponse> {
          return {
            activity: {
              id: `tk_${c.name}`,
              status: 'ACTIVITY_STATUS_COMPLETED',
              result: { signRawPayloadResult: { r: c.r, s: c.s, v: c.v } },
            },
          };
        },
      });

      await expect(
        transport.signEvmDigest({
          chain: 'arbitrum',
          signerAddress: AUTHORIZED_EVM_ADDR,
          digestHex: digest,
          payoutId: `payout-${c.name}`,
        })
      ).rejects.toMatchObject({
        outcomeState: 'UNCERTAIN_OUTCOME',
        requiresHumanReview: true,
        retryAllowed: false,
      });

      const lookup = await transport.lookupSigningActivity({
        activityId: `tk_${c.name}`,
        payoutId: `payout-${c.name}`,
        chain: 'arbitrum',
        signerAddress: AUTHORIZED_EVM_ADDR,
        digestHex: digest,
      });
      expect(lookup.outcomeState).toBe('UNCERTAIN_OUTCOME');
      expect(lookup.requiresHumanReview).toBe(true);
    }

    // Missing digestHex during EVM lookupSigningActivity must also fail closed
    const transport = createHsmTransport({
      async signRawPayload() {
        throw new Error('should not be called');
      },
      async getActivity(): Promise<TurnkeyRawPayloadApiResponse> {
        return {
          activity: {
            id: 'tk_missing_digest',
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signRawPayloadResult: {
                r: authSig.r,
                s: authSig.s,
                v: authSig.vLegacyHex,
              },
            },
          },
        };
      },
    });
    const noDigestLookup = await transport.lookupSigningActivity({
      activityId: 'tk_missing_digest',
      payoutId: 'payout-missing-digest',
      chain: 'arbitrum',
      signerAddress: AUTHORIZED_EVM_ADDR,
    });
    expect(noDigestLookup.outcomeState).toBe('UNCERTAIN_OUTCOME');
    expect(noDigestLookup.requiresHumanReview).toBe(true);
  });

  it('asserts complete financial state on invalid v: lock preserved, no second signing activity, zero broadcasts, invariant preserved', async () => {
    const { sqlite, db, legacyDb } = createMigratedDb(true);
    const affiliateId = 'aff-evm-bad-v';
    const { lockBatchId, units, originalLiabilityUnits } = await seedFundedAffiliate(
      db,
      sqlite,
      affiliateId,
      '50.00'
    );

    let signCalls = 0;
    const hsmTransport = createHsmTransport({
      async signRawPayload(): Promise<TurnkeyRawPayloadApiResponse> {
        signCalls += 1;
        return {
          activity: {
            id: `tk_bad_v_attempt_${signCalls}`,
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signRawPayloadResult: {
                r: '11'.repeat(32),
                s: '22'.repeat(32),
                v: '23', // v = 35 (invalid EIP-155)
              },
            },
          },
        };
      },
    });

    const signer = new TurnkeySigner({
      db: legacyDb,
      transport: hsmTransport,
      evmHotWalletAddress: AUTHORIZED_EVM_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
      hotSinglePayoutMaxUsd: 250,
      hotRolling24hMaxUsd: 1500,
    });

    const rpc = createMockEvmRpc();
    const evmAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode: 'mainnet',
      hotWalletAddress: AUTHORIZED_EVM_ADDR,
      primaryRpc: rpc.transport,
      fallbackRpc: rpc.transport,
    });
    const machine = new BroadcastRecoveryMachine({
      db,
      turnkeySigner: signer,
      evmAdapters: { arbitrum: evmAdapter },
    });

    const payoutInput = {
      payoutId: `payout-${affiliateId}`,
      idempotencyKey: `idem-${affiliateId}`,
      lockBatchId,
      affiliateId,
      chain: 'arbitrum' as const,
      recipientAddress: EVM_RECIPIENT,
      amountUnits1e8: units,
    };

    // First attempt fails with invalid v -> UNCERTAIN_OUTCOME (thrown; state remains SIGNING)
    await expect(machine.executeSettlement(payoutInput)).rejects.toThrow(
      /invalid EVM recovery parameter|retained/i
    );
    expect(signCalls).toBe(1);
    expect(rpc.broadcastCalls).toBe(0);

    // Original withdrawal lock must remain INFLIGHT
    const lockRow = sqlite
      .prepare(`SELECT status FROM ledger_journal_batches WHERE id = ?`)
      .get(lockBatchId) as { status: string };
    expect(lockRow.status).toBe('INFLIGHT');

    // Broadcast record must persist turnkey_activity_id and error_reason in SIGNING state
    const broadcastRow = sqlite
      .prepare(
        `SELECT state, turnkey_activity_id, error_reason FROM settlement_broadcasts WHERE payout_id = ?`
      )
      .get(`payout-${affiliateId}`) as {
      state: string;
      turnkey_activity_id: string | null;
      error_reason: string | null;
    };
    expect(broadcastRow.state).toBe('SIGNING');
    expect(broadcastRow.turnkey_activity_id).toBe('tk_bad_v_attempt_1');
    expect(broadcastRow.error_reason).toContain('invalid EVM recovery parameter');

    // Second invocation MUST fail closed under the payout-effect fence (no second signing activity or broadcast)
    await expect(machine.executeSettlement(payoutInput)).rejects.toThrow(
      /workflow ownership|retained|Payout effect denied/i
    );
    expect(signCalls).toBe(1);
    expect(rpc.broadcastCalls).toBe(0);

    // Full accounting invariants hold
    const inv = await verifyLedgerInvariants(db);
    expect(inv.valid).toBe(true);
    assertAccountingConservation(sqlite, affiliateId, originalLiabilityUnits);

    sqlite.close();
  });
});

// ============================================================================
// SECTION 2: D1 INSERT/UPDATE Finality Trigger Adversarial & Trust-Boundary Tests
// ============================================================================

describe('D1 settlement_broadcasts INSERT/UPDATE finality trigger adversarial tests', () => {
  const nowSec = () => Math.floor(Date.now() / 1000);

  function insertBroadcast(
    sqlite: Database.Database,
    overrides: Partial<{
      payout_id: string;
      lock_batch_id: string;
      affiliate_id: string;
      chain: string;
      recipient_address: string;
      amount_units_1e8: number;
      state: string;
      tx_hash: string | null;
      confirmation_lane: string | null;
      confirmation_observed_at: number | null;
      safe_multisig_tx_hash: string | null;
    }> = {}
  ): void {
    const payoutId = overrides.payout_id ?? `payout-${Math.random().toString(36).slice(2, 10)}`;
    const amountUnits = overrides.amount_units_1e8 ?? 10_0000_0000;
    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts (
           payout_id, idempotency_key, lock_batch_id, affiliate_id, chain,
           recipient_address, amount_units_1e8, chain_token_units, chain_decimals,
           state, tx_hash, confirmation_lane, confirmation_observed_at, safe_multisig_tx_hash
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        payoutId,
        `idem-${payoutId}`,
        overrides.lock_batch_id ?? `lock-${payoutId}`,
        overrides.affiliate_id ?? 'aff-trigger-test',
        overrides.chain ?? 'arbitrum',
        overrides.recipient_address ?? EVM_RECIPIENT,
        amountUnits,
        String(Math.floor(amountUnits / 100)),
        6,
        overrides.state ?? 'CONFIRMED',
        'tx_hash' in overrides ? overrides.tx_hash : '0x' + 'ab'.repeat(32),
        'confirmation_lane' in overrides ? overrides.confirmation_lane : 'HOT',
        'confirmation_observed_at' in overrides ? overrides.confirmation_observed_at : nowSec(),
        'safe_multisig_tx_hash' in overrides ? overrides.safe_multisig_tx_hash : null
      );
  }

  it('rejects all 12 adversarial INSERT and UPDATE finality bypass cases on a fresh 001..037 database', async () => {
    const { sqlite } = createMigratedDb(true);
    const now = nowSec();

    // 1. HOT INSERT without tx_hash (NULL)
    expect(() =>
      insertBroadcast(sqlite, { confirmation_lane: 'HOT', state: 'CONFIRMED', tx_hash: null })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 2. HOT INSERT with empty/whitespace tx_hash
    expect(() =>
      insertBroadcast(sqlite, { confirmation_lane: 'HOT', state: 'CONFIRMED', tx_hash: '' })
    ).toThrow(/Direct INSERT into HOT\/COLD/);
    expect(() =>
      insertBroadcast(sqlite, { confirmation_lane: 'HOT', state: 'CONFIRMED', tx_hash: '   ' })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 3. HOT INSERT with missing confirmation timestamp
    expect(() =>
      insertBroadcast(sqlite, {
        confirmation_lane: 'HOT',
        state: 'CONFIRMED',
        confirmation_observed_at: null,
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 4. HOT INSERT with stale timestamp (>300s old)
    expect(() =>
      insertBroadcast(sqlite, {
        confirmation_lane: 'HOT',
        state: 'CONFIRMED',
        confirmation_observed_at: now - 305,
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 5. HOT INSERT with future timestamp
    expect(() =>
      insertBroadcast(sqlite, {
        confirmation_lane: 'HOT',
        state: 'CONFIRMED',
        confirmation_observed_at: now + 60,
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 6. HOT INSERT in an invalid state
    for (const badState of ['SIGNING', 'BROADCAST_PENDING', 'QUEUED_COLD_SAFE', 'FAILED_ABORTED']) {
      expect(() =>
        insertBroadcast(sqlite, {
          confirmation_lane: 'HOT',
          state: badState,
          confirmation_observed_at: now,
        })
      ).toThrow(/Direct INSERT into HOT\/COLD/);
    }

    // 7. HOT INSERT with unexpected Safe multisig field
    expect(() =>
      insertBroadcast(sqlite, {
        confirmation_lane: 'HOT',
        state: 'CONFIRMED',
        confirmation_observed_at: now,
        safe_multisig_tx_hash: '0x' + 'cd'.repeat(32),
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 8. COLD INSERT without Safe transaction identity
    expect(() =>
      insertBroadcast(sqlite, {
        confirmation_lane: 'COLD',
        state: 'CONFIRMED',
        safe_multisig_tx_hash: null,
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 9. COLD INSERT with empty/whitespace Safe transaction identity
    expect(() =>
      insertBroadcast(sqlite, {
        confirmation_lane: 'COLD',
        state: 'CONFIRMED',
        safe_multisig_tx_hash: '   ',
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    // 10. Concurrent forged HOT/COLD insertion attempts all fail; 0 forged rows persisted
    const forgedAttempts = await Promise.allSettled([
      Promise.resolve().then(() =>
        insertBroadcast(sqlite, {
          payout_id: 'forged-hot-1',
          confirmation_lane: 'HOT',
          state: 'CONFIRMED',
          tx_hash: null,
        })
      ),
      Promise.resolve().then(() =>
        insertBroadcast(sqlite, {
          payout_id: 'forged-hot-2',
          confirmation_lane: 'HOT',
          state: 'CONFIRMED',
          confirmation_observed_at: now - 500,
        })
      ),
      Promise.resolve().then(() =>
        insertBroadcast(sqlite, {
          payout_id: 'forged-cold-1',
          confirmation_lane: 'COLD',
          state: 'CONFIRMED',
          safe_multisig_tx_hash: '',
        })
      ),
    ]);
    expect(forgedAttempts.every((r) => r.status === 'rejected')).toBe(true);
    const countRow = sqlite.prepare(`SELECT COUNT(*) AS cnt FROM settlement_broadcasts`).get() as {
      cnt: number;
    };
    expect(countRow.cnt).toBe(0);

    // 11. UPDATE-based bypass attempts
    insertBroadcast(sqlite, {
      payout_id: 'payout-unverified-1',
      state: 'CONFIRMED',
      confirmation_lane: 'UNVERIFIED_HOT',
      confirmation_observed_at: null,
    });
    // Cannot promote UNVERIFIED_HOT -> HOT with stale timestamp
    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts
           SET confirmation_lane = 'HOT', confirmation_observed_at = ?
           WHERE payout_id = 'payout-unverified-1'`
        )
        .run(now - 600)
    ).toThrow(/UNVERIFIED_HOT to HOT promotion/);
    // Cannot bypass via UNVERIFIED_HOT -> NULL or UNVERIFIED_HOT -> COLD
    expect(() =>
      sqlite
        .prepare(`UPDATE settlement_broadcasts SET confirmation_lane = NULL WHERE payout_id = 'payout-unverified-1'`)
        .run()
    ).toThrow(/Confirmed settlement lineage/);
    expect(() =>
      sqlite
        .prepare(
          `UPDATE settlement_broadcasts
           SET confirmation_lane = 'COLD', safe_multisig_tx_hash = '0x1234'
           WHERE payout_id = 'payout-unverified-1'`
        )
        .run()
    ).toThrow(/Confirmed settlement lineage/);
    // Cannot DELETE a CONFIRMED row
    expect(() =>
      sqlite.prepare(`DELETE FROM settlement_broadcasts WHERE payout_id = 'payout-unverified-1'`).run()
    ).toThrow(/cannot be deleted/);

    // 12. INSERT -> UPDATE attempts to circumvent lineage checks
    insertBroadcast(sqlite, {
      payout_id: 'payout-lineage-1',
      lock_batch_id: 'lock-lineage-1',
      state: 'BROADCAST_PENDING',
      confirmation_lane: 'UNVERIFIED_HOT',
      confirmation_observed_at: null,
    });
    // Legitimate promotion to CONFIRMED + HOT with fresh timestamp succeeds
    sqlite
      .prepare(
        `UPDATE settlement_broadcasts
         SET state = 'CONFIRMED', confirmation_lane = 'HOT', confirmation_observed_at = ?
         WHERE payout_id = 'payout-lineage-1'`
      )
      .run(now);
    // Subsequent lineage tampering on confirmed row is blocked
    expect(() =>
      sqlite
        .prepare(`UPDATE settlement_broadcasts SET lock_batch_id = 'lock-other' WHERE payout_id = 'payout-lineage-1'`)
        .run()
    ).toThrow(/Confirmed settlement lineage/);
    expect(() =>
      sqlite
        .prepare(`UPDATE settlement_broadcasts SET amount_units_1e8 = 1 WHERE payout_id = 'payout-lineage-1'`)
        .run()
    ).toThrow(/Confirmed settlement lineage/);
    expect(() =>
      sqlite
        .prepare(`UPDATE settlement_broadcasts SET tx_hash = '0xdeadbeef' WHERE payout_id = 'payout-lineage-1'`)
        .run()
    ).toThrow(/Confirmed settlement lineage/);

    sqlite.close();
  });

  it('critical trust-boundary proof: SQL trigger accepts syntactically valid metadata (schema guard, NOT blockchain finality proof)', () => {
    const { sqlite } = createMigratedDb(true);
    const now = nowSec();

    // Syntactically valid HOT INSERT with an unrelated tx_hash and plausible current timestamp
    expect(() =>
      insertBroadcast(sqlite, {
        payout_id: 'payout-trust-hot',
        state: 'CONFIRMED',
        confirmation_lane: 'HOT',
        tx_hash: '0x' + '99'.repeat(32), // unrelated hash, never verified on-chain
        confirmation_observed_at: now,
        safe_multisig_tx_hash: null,
      })
    ).not.toThrow();

    // Syntactically valid COLD INSERT with a synthetic safe_multisig_tx_hash
    expect(() =>
      insertBroadcast(sqlite, {
        payout_id: 'payout-trust-cold',
        state: 'CONFIRMED',
        confirmation_lane: 'COLD',
        tx_hash: '0x' + '88'.repeat(32),
        confirmation_observed_at: now,
        safe_multisig_tx_hash: '0x' + '77'.repeat(32),
      })
    ).not.toThrow();

    // Proof: the SQL trigger enforces schema invariants only; on-chain receipt verification
    // and application-layer authorization remain mandatory controls.
    const rows = sqlite
      .prepare(`SELECT payout_id, state, confirmation_lane FROM settlement_broadcasts ORDER BY payout_id`)
      .all() as Array<{ payout_id: string; state: string; confirmation_lane: string }>;
    expect(rows).toEqual([
      { payout_id: 'payout-trust-cold', state: 'CONFIRMED', confirmation_lane: 'COLD' },
      { payout_id: 'payout-trust-hot', state: 'CONFIRMED', confirmation_lane: 'HOT' },
    ]);

    sqlite.close();
  });

  it('upgrades cleanly from 001..036 with historical pending and confirmed rows without blocking reconciliation, pending recovery, or cold settlement', () => {
    const { sqlite } = createMigratedDb(false);
    const historicalTs = nowSec() - 86400 * 7;

    // Seed pre-037 historical rows (pending + confirmed)
    insertBroadcast(sqlite, {
      payout_id: 'payout-hist-pending-1',
      state: 'BROADCAST_PENDING',
      tx_hash: '0x' + 'aa'.repeat(32),
      confirmation_lane: 'UNVERIFIED_HOT',
      confirmation_observed_at: null,
    });
    insertBroadcast(sqlite, {
      payout_id: 'payout-hist-confirmed-1',
      state: 'CONFIRMED',
      tx_hash: '0x' + 'bb'.repeat(32),
      confirmation_lane: 'HOT',
      confirmation_observed_at: historicalTs,
    });

    // Apply migration 037 on upgraded DB
    sqlite.exec(
      fs.readFileSync(path.join(MIGRATIONS_DIR, '037_hardening_trigger_and_exposure.sql'), 'utf8')
    );

    // 1. Historical confirmed row remains intact
    const histConfirmed = sqlite
      .prepare(`SELECT state, confirmation_lane, confirmation_observed_at FROM settlement_broadcasts WHERE payout_id = 'payout-hist-confirmed-1'`)
      .get() as { state: string; confirmation_lane: string; confirmation_observed_at: number };
    expect(histConfirmed).toEqual({
      state: 'CONFIRMED',
      confirmation_lane: 'HOT',
      confirmation_observed_at: historicalTs,
    });

    // 2. Legitimate pending recovery / reconciliation promotes payout-hist-pending-1 -> CONFIRMED HOT
    sqlite
      .prepare(
        `UPDATE settlement_broadcasts
         SET state = 'CONFIRMED', confirmation_lane = 'HOT', confirmation_observed_at = ?
         WHERE payout_id = 'payout-hist-pending-1'`
      )
      .run(nowSec());

    // 3. Legitimate COLD settlement insert with Safe multisig tx hash succeeds
    insertBroadcast(sqlite, {
      payout_id: 'payout-post037-cold-1',
      state: 'CONFIRMED',
      confirmation_lane: 'COLD',
      tx_hash: '0x' + 'cc'.repeat(32),
      confirmation_observed_at: nowSec(),
      safe_multisig_tx_hash: '0x' + 'dd'.repeat(32),
    });

    // 4. Direct forged HOT insert on upgraded DB is blocked
    expect(() =>
      insertBroadcast(sqlite, {
        payout_id: 'payout-post037-forged-hot',
        confirmation_lane: 'HOT',
        state: 'CONFIRMED',
        tx_hash: null,
      })
    ).toThrow(/Direct INSERT into HOT\/COLD/);

    sqlite.close();
  });
});

// ============================================================================
// SECTION 3: Stellar Raw Secret Signer Isolation (Strategy A)
// ============================================================================

describe('Stellar raw secret signer isolation (Strategy A fail-closed)', () => {
  it('hard-disables raw secretKey in constructor and disables sendPayout, submitTransaction, and processBatchPayouts', async () => {
    const rawKeypair = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 42));
    expect(
      () =>
        new StellarService({
          network: StellarNetwork.TESTNET,
          usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
          secretKey: rawKeypair.secret(),
        } as unknown as Parameters<typeof StellarService>[0])
    ).toThrow(LegacyPayoutPathDisabledError);

    const service = new StellarService({
      network: StellarNetwork.TESTNET,
      usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
      senderPublicKey: rawKeypair.publicKey(),
    });

    const mockTx = { sign: jest.fn(), operations: [] };

    await expect(
      service.sendPayout(STELLAR_RECIPIENT, '15.00')
    ).rejects.toThrow(LegacyPayoutPathDisabledError);

    await expect(
      service.submitTransaction(mockTx as never)
    ).rejects.toThrow(LegacyPayoutPathDisabledError);

    await expect(service.processBatchPayouts({} as never)).rejects.toThrow(
      LegacyPayoutPathDisabledError
    );

    expect(mockTx.sign).not.toHaveBeenCalled();
  });

  it('StellarAdapter wired to a real StellarService fails closed on sendPayout with zero signing or broadcast while preserving read-only methods', async () => {
    const rawKeypair = StellarSdk.Keypair.fromRawEd25519Seed(Buffer.alloc(32, 99));
    const service = new StellarService({
      network: StellarNetwork.TESTNET,
      usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
      senderPublicKey: rawKeypair.publicKey(),
    });
    // Stub read-only trustline check so we exercise the actual service.sendPayout call
    const trustlineSpy = jest.spyOn(service, 'hasUsdcTrustline').mockResolvedValue(true);

    const adapter = new StellarAdapter({
      network: StellarNetwork.TESTNET,
      stellarService: service,
    });

    const result = await adapter.sendPayout({
      recipientAddress: STELLAR_RECIPIENT,
      amount: '25.00',
      payoutId: 'payout-legacy-stellar-adapter',
    });

    expect(result.success).toBe(false);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('LEGACY_PAYOUT_PATH_DISABLED');
    expect(result.txHash).toBeUndefined();
    expect(trustlineSpy).not.toHaveBeenCalled();

    // Read-only helpers remain intact without any raw secret key
    const readOnlyService = new StellarService({
      network: StellarNetwork.TESTNET,
      usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
      senderPublicKey: STELLAR_HOT_PUB,
    });
    expect(readOnlyService.getSenderAccountId()).toBe(STELLAR_HOT_PUB);
    expect(readOnlyService.hasSenderAccount()).toBe(false);
    expect(readOnlyService.getNetwork()).toBe(StellarNetwork.TESTNET);
  });
});

// ============================================================================
// SECTION 4: No-Blind-Retry Guarantee (8 Fault-Injection Scenarios)
// ============================================================================

describe('Stellar Turnkey-only no-blind-retry guarantee across 8 fault-injection scenarios', () => {
  function createMockTurnkeyStellarClient(): {
    client: TurnkeyRawApiClient;
    signCalls: number;
  } {
    const state = { signCalls: 0 };
    const client: TurnkeyRawApiClient = {
      async signRawPayload(req): Promise<TurnkeyRawPayloadApiResponse> {
        state.signCalls += 1;
        const payloadBytes = Buffer.from(req.payload.replace(/^0x/i, ''), 'hex');
        const sig = STELLAR_KEYPAIR.sign(payloadBytes);
        const r = Buffer.from(sig.subarray(0, 32)).toString('hex');
        const s = Buffer.from(sig.subarray(32, 64)).toString('hex');
        return {
          activity: {
            id: `tk_stellar_act_${state.signCalls}`,
            status: 'ACTIVITY_STATUS_COMPLETED',
            result: {
              signRawPayloadResult: { r, s, v: '00' },
            },
          },
        };
      },
    };
    return {
      client,
      get signCalls() {
        return state.signCalls;
      },
    };
  }

  function createStellarHarness(params: {
    affiliateId: string;
    amountUsd?: string;
    onSubmit: (xdr: string, txHash: string) => Promise<{ txHash: string; confirmed: boolean }>;
    onLookup?: (txHash: string) => Promise<{
      found: boolean;
      successful: boolean;
      ledger?: number;
    }>;
  }) {
    const { sqlite, db, legacyDb } = createMigratedDb(true);
    const hsmMock = createMockTurnkeyStellarClient();
    const hsmTransport = createHsmTransport(hsmMock.client);

    const signer = new TurnkeySigner({
      db: legacyDb,
      transport: hsmTransport,
      evmHotWalletAddress: AUTHORIZED_EVM_ADDR,
      stellarHotWalletAddress: STELLAR_HOT_PUB,
      hotSinglePayoutMaxUsd: 250,
      hotRolling24hMaxUsd: 1500,
    });

    let submitAttempts = 0;
    const seenHashes = new Set<string>();

    const stellarTransport: StellarBroadcastTransport = {
      async hasUsdcTrustline() {
        return true;
      },
      async getAccountSequence() {
        return 1000n;
      },
      async buildUnsignedUsdcPayment(buildParams) {
        const account = new StellarSdk.Account(
          buildParams.fromAccount,
          (BigInt(buildParams.stellarSequence) - 1n).toString()
        );
        const usdc = new StellarSdk.Asset(
          'USDC',
          CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER
        );
        const tx = new StellarSdk.TransactionBuilder(account, {
          fee: '100',
          networkPassphrase: StellarSdk.Networks.TESTNET,
        })
          .addOperation(
            StellarSdk.Operation.payment({
              destination: buildParams.recipientAddress,
              asset: usdc,
              amount: buildParams.amountFormatted7,
            })
          )
          .setTimeout(180)
          .build();
        return {
          unsignedEnvelopeXdr: tx.toXDR(),
          txHashHex: Buffer.from(tx.hash()).toString('hex'),
          stellarSequence: buildParams.stellarSequence,
          timeboundsMaxUnix: buildParams.timeboundsMaxUnix,
        };
      },
      async submitSignedTransaction(submitParams) {
        submitAttempts += 1;
        seenHashes.add(submitParams.expectedTxHash);
        return params.onSubmit(submitParams.signedEnvelopeXdr, submitParams.expectedTxHash);
      },
      async lookupTransaction(txHash: string) {
        if (params.onLookup) return params.onLookup(txHash);
        return { found: false, successful: false };
      },
    };

    const machine = new BroadcastRecoveryMachine({
      db,
      turnkeySigner: signer,
      evmAdapters: {},
      stellarTransport,
    });

    return {
      sqlite,
      db,
      signer,
      stellarTransport,
      machine,
      get signCalls() {
        return hsmMock.signCalls;
      },
      get submitAttempts() {
        return submitAttempts;
      },
      get uniqueTxHashes() {
        return seenHashes.size;
      },
    };
  }

  const AMBIGUOUS_SUBMIT_SCENARIOS: Array<{ name: string; error: Error }> = [
    { name: '1. Submit accepted by Horizon, response lost', error: new Error('Response stream closed after socket write') },
    { name: '2. HTTP 504 Gateway Timeout after broadcast', error: new Error('Horizon HTTP 504 Gateway Timeout') },
    { name: '3. Connection reset (ECONNRESET) after broadcast', error: new Error('read ECONNRESET') },
    { name: '4. Horizon returns unknown status / malformed payload', error: new Error('Horizon HTTP 502 unknown status payload') },
  ];

  test.each(AMBIGUOUS_SUBMIT_SCENARIOS)(
    '$name — preserves lock, tx identity, pending exposure, and never re-signs or duplicates payout',
    async ({ error }) => {
      const affiliateId = `aff-fault-${Math.random().toString(36).slice(2, 8)}`;
      let acceptedHash: string | null = null;
      const harness = createStellarHarness({
        affiliateId,
        onSubmit: async (_xdr, txHash) => {
          acceptedHash = txHash;
          throw error;
        },
        onLookup: async () => ({ found: false, successful: false }),
      });

      const { lockBatchId, units, originalLiabilityUnits } = await seedFundedAffiliate(
        harness.db,
        harness.sqlite,
        affiliateId,
        '40.00'
      );
      const payoutInput = {
        payoutId: `payout-${affiliateId}`,
        idempotencyKey: `idem-${affiliateId}`,
        lockBatchId,
        affiliateId,
        chain: 'stellar' as const,
        recipientAddress: STELLAR_RECIPIENT,
        amountUnits1e8: units,
      };

      const res1 = await harness.machine.executeSettlement(payoutInput);
      expect(res1.state).toBe('BROADCAST_PENDING');
      expect(harness.signCalls).toBe(1);
      expect(harness.submitAttempts).toBe(1);
      expect(acceptedHash).toBeTruthy();

      // Withdrawal lock preserved INFLIGHT
      const lockRow = harness.sqlite
        .prepare(`SELECT status FROM ledger_journal_batches WHERE id = ?`)
        .get(lockBatchId) as { status: string };
      expect(lockRow.status).toBe('INFLIGHT');

      // Broadcast row preserves exact tx_hash identity and pending exposure (not released)
      const bRow = harness.sqlite
        .prepare(
          `SELECT state, tx_hash, amount_units_1e8, exposure_released_at FROM settlement_broadcasts WHERE payout_id = ?`
        )
        .get(`payout-${affiliateId}`) as {
        state: string;
        tx_hash: string;
        amount_units_1e8: number;
        exposure_released_at: string | null;
      };
      expect(bRow.state).toBe('BROADCAST_PENDING');
      expect(bRow.tx_hash).toBe(acceptedHash);
      expect(BigInt(bRow.amount_units_1e8)).toBe(units);
      expect(bRow.exposure_released_at).toBeNull();

      // Re-invoking worker MUST NOT re-sign, re-submit, or create a new tx hash
      const res2 = await harness.machine.executeSettlement(payoutInput);
      expect(res2.state).toBe('BROADCAST_PENDING');
      expect(harness.signCalls).toBe(1);
      expect(harness.submitAttempts).toBe(1);
      expect(harness.uniqueTxHashes).toBe(1);

      // Accounting conservation holds with zero duplicate payouts
      const inv = await verifyLedgerInvariants(harness.db);
      expect(inv.valid).toBe(true);
      assertAccountingConservation(harness.sqlite, affiliateId, originalLiabilityUnits);
      harness.sqlite.close();
    }
  );

  it('5. Repeated worker invocation reconciles existing tx to CONFIRMED with zero new signing or duplicate transfer', async () => {
    const affiliateId = 'aff-repeated-worker';
    let ledgerConfirmed = false;
    const harness = createStellarHarness({
      affiliateId,
      onSubmit: async () => {
        throw new Error('Horizon 504 after acceptance');
      },
      onLookup: async () =>
        ledgerConfirmed
          ? { found: true, successful: true, ledger: 550001 }
          : { found: false, successful: false },
    });

    const { lockBatchId, units, originalLiabilityUnits } = await seedFundedAffiliate(
      harness.db,
      harness.sqlite,
      affiliateId,
      '30.00'
    );
    const payoutInput = {
      payoutId: `payout-${affiliateId}`,
      idempotencyKey: `idem-${affiliateId}`,
      lockBatchId,
      affiliateId,
      chain: 'stellar' as const,
      recipientAddress: STELLAR_RECIPIENT,
      amountUnits1e8: units,
    };

    const first = await harness.machine.executeSettlement(payoutInput);
    expect(first.state).toBe('BROADCAST_PENDING');
    expect(harness.signCalls).toBe(1);

    // Second invocation while still pending: still zero new signing
    const second = await harness.machine.executeSettlement(payoutInput);
    expect(second.state).toBe('BROADCAST_PENDING');
    expect(harness.signCalls).toBe(1);

    // Transaction finalizes on Stellar Horizon -> recovery confirms cleanly with 0 new signing
    ledgerConfirmed = true;
    const recovered = await harness.machine.recoverUncertainBroadcast(payoutInput.payoutId);
    expect(recovered.state).toBe('CONFIRMED');
    expect(harness.signCalls).toBe(1);
    expect(harness.uniqueTxHashes).toBe(1);

    const inv = await verifyLedgerInvariants(harness.db);
    expect(inv.valid).toBe(true);
    const acct = assertAccountingConservation(harness.sqlite, affiliateId, originalLiabilityUnits);
    expect(acct.verifiedSettlement).toBe(units);
    expect(acct.remainingLiability).toBe(originalLiabilityUnits - units);
    harness.sqlite.close();
  });

  it('6. Concurrent retry (4 parallel workers racing on same payout) produces at most 1 signature and 0 duplicate payouts', async () => {
    const affiliateId = 'aff-concurrent-retry';
    const harness = createStellarHarness({
      affiliateId,
      onSubmit: async (_xdr, txHash) => {
        await new Promise((r) => setTimeout(r, 15));
        return { txHash, confirmed: false };
      },
      onLookup: async () => ({ found: true, successful: true, ledger: 550002 }),
    });

    const { lockBatchId, units, originalLiabilityUnits } = await seedFundedAffiliate(
      harness.db,
      harness.sqlite,
      affiliateId,
      '60.00'
    );
    const payoutInput = {
      payoutId: `payout-${affiliateId}`,
      idempotencyKey: `idem-${affiliateId}`,
      lockBatchId,
      affiliateId,
      chain: 'stellar' as const,
      recipientAddress: STELLAR_RECIPIENT,
      amountUnits1e8: units,
    };

    // 4 independent Worker isolates sharing only D1 (tests cross-isolate D1 fence, not just in-memory mutex)
    const workers = [0, 1, 2, 3].map(
      () =>
        new BroadcastRecoveryMachine({
          db: harness.db,
          turnkeySigner: harness.signer,
          evmAdapters: {},
          stellarTransport: harness.stellarTransport,
        })
    );

    const settled = await Promise.allSettled(workers.map((w) => w.executeSettlement(payoutInput)));

    expect(harness.signCalls).toBe(1);
    expect(harness.submitAttempts).toBe(1);
    expect(harness.uniqueTxHashes).toBe(1);

    const fulfilled = settled.filter(
      (r): r is PromiseFulfilledResult<Awaited<ReturnType<BroadcastRecoveryMachine['executeSettlement']>>> =>
        r.status === 'fulfilled'
    );
    const rejected = settled.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(fulfilled.length).toBeGreaterThanOrEqual(1);
    for (const r of fulfilled) {
      expect(['BROADCAST_PENDING', 'CONFIRMED']).toContain(r.value.state);
    }
    for (const r of rejected) {
      expect(String(r.reason)).toMatch(/workflow ownership|Payout effect denied|UNIQUE/i);
    }

    const rowCount = harness.sqlite
      .prepare(`SELECT COUNT(*) AS cnt FROM settlement_broadcasts WHERE payout_id = ?`)
      .get(`payout-${affiliateId}`) as { cnt: number };
    expect(rowCount.cnt).toBe(1);

    const inv = await verifyLedgerInvariants(harness.db);
    expect(inv.valid).toBe(true);
    assertAccountingConservation(harness.sqlite, affiliateId, originalLiabilityUnits);
    harness.sqlite.close();
  });

  it('7 & 8. Emergency pause activates during submission, blocks new signing, and previous tx still finalizes cleanly on read-only reconciliation', async () => {
    const affiliateId = 'aff-pause-during-submit';
    let confirmedOnChain = false;
    let pausedDuringSubmit = false;

    const harness = createStellarHarness({
      affiliateId,
      onSubmit: async () => {
        // Emergency pause activates mid-flight while Horizon accepted the tx
        harness.sqlite
          .prepare(
            `UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'EMERGENCY_PAUSE'`
          )
          .run();
        pausedDuringSubmit = true;
        throw new Error('504 Gateway Timeout during emergency pause');
      },
      onLookup: async () =>
        confirmedOnChain
          ? { found: true, successful: true, ledger: 550099 }
          : { found: false, successful: false },
    });

    const { lockBatchId, units, originalLiabilityUnits } = await seedFundedAffiliate(
      harness.db,
      harness.sqlite,
      affiliateId,
      '75.00'
    );
    const payoutInput = {
      payoutId: `payout-${affiliateId}`,
      idempotencyKey: `idem-${affiliateId}`,
      lockBatchId,
      affiliateId,
      chain: 'stellar' as const,
      recipientAddress: STELLAR_RECIPIENT,
      amountUnits1e8: units,
    };

    // Scenario 7: Emergency pause flips during submission
    const res1 = await harness.machine.executeSettlement(payoutInput);
    expect(pausedDuringSubmit).toBe(true);
    expect(res1.state).toBe('BROADCAST_PENDING');
    expect(harness.signCalls).toBe(1);

    // Any NEW payout while paused is blocked fail-closed (0 additional signatures)
    const {
      lockBatchId: lock2,
      units: units2,
      originalLiabilityUnits: originalLiability2,
    } = await seedFundedAffiliate(
      harness.db,
      harness.sqlite,
      'aff-blocked-by-pause',
      '20.00'
    );
    await expect(
      harness.machine.executeSettlement({
        payoutId: 'payout-aff-blocked-by-pause',
        idempotencyKey: 'idem-aff-blocked-by-pause',
        lockBatchId: lock2,
        affiliateId: 'aff-blocked-by-pause',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT,
        amountUnits1e8: units2,
      })
    ).rejects.toThrow(/paused|EMERGENCY_PAUSE|emergency controls/i);
    expect(harness.signCalls).toBe(1);

    // Scenario 8: Previous transaction finalizes on Horizon AFTER pause.
    // Read-only reconciliation settles the finalized tx without signing or broadcasting anything new.
    confirmedOnChain = true;
    const reconciled = await harness.machine.recoverUncertainBroadcast(payoutInput.payoutId);
    expect(reconciled.state).toBe('CONFIRMED');
    expect(harness.signCalls).toBe(1);
    expect(harness.submitAttempts).toBe(1);

    // Broadcast is promoted to CONFIRMED in HOT lane with a fresh confirmation timestamp
    const bRow = harness.sqlite
      .prepare(
        `SELECT state, confirmation_lane, confirmation_observed_at, tx_hash FROM settlement_broadcasts WHERE payout_id = ?`
      )
      .get(`payout-${affiliateId}`) as {
      state: string;
      confirmation_lane: string;
      confirmation_observed_at: number | null;
      tx_hash: string | null;
    };
    expect(bRow.state).toBe('CONFIRMED');
    expect(bRow.confirmation_lane).toBe('HOT');
    expect(bRow.confirmation_observed_at).toBeGreaterThan(0);
    expect(bRow.tx_hash).toBeTruthy();

    // Exact accounting conservation across BOTH affiliates
    const inv = await verifyLedgerInvariants(harness.db);
    expect(inv.valid).toBe(true);
    const acct1 = assertAccountingConservation(harness.sqlite, affiliateId, originalLiabilityUnits);
    expect(acct1.verifiedSettlement).toBe(units);
    expect(acct1.remainingLiability).toBe(originalLiabilityUnits - units);
    const acct2 = assertAccountingConservation(
      harness.sqlite,
      'aff-blocked-by-pause',
      originalLiability2
    );
    expect(acct2.verifiedSettlement).toBe(0n);
    expect(acct2.remainingLiability).toBe(originalLiability2);

    harness.sqlite.close();
  });
});
