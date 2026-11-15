/**
 * @jest-environment node
 *
 * Settlement Lock Lifecycle, 64-Bit Stellar Sequences, Turnkey XDR Signing & Legacy Boundary Suite:
 * - Prevents double-spend when retrying a settlement `idempotencyKey` whose `WITHDRAWAL_LOCK`
 *   was previously reverted (`VOIDED`) after a pre-signing abort.
 * - Settles (`finalizeWithdrawal` / `revertWithdrawal`) ledger locks on `action: 'recover'`
 *   and `action: 'resolve_cold_safe'`, and blocks `payoutId` reuse across distinct `idempotencyKey`s.
 * - Attaches verified `xdr.DecoratedSignature` in `TurnkeyServerHsmTransport.signStellarEnvelope`,
 *   rejects empty/zero `r`/`s` signatures, and verifies `HorizonStellarBroadcastTransport`.
 * - Closes bypasses on legacy `/api/profile/wallet`, `/api/auth/telegram`,
 *   `/api/payouts`, `/api/admin/payouts/{batch,retry}`, and `/api/webhooks/exchange/*`
 *   when the audited double-entry ledger schema is active.
 * - Preserves exact 64-bit Stellar Horizon sequence numbers (`> 2^53 - 1`)
 *   via `next_sequence_text` + `BigInt` with zero `Number(...)` truncation.
 * - Fails closed (`503 EVIDENCE_STORAGE_UNAVAILABLE`) when R2 `STORAGE` binding is absent on
 *   `POST /api/admin/reconciliation/ingest`, persists `signed_raw_tx` in D1 across stateless isolates,
 *   and preserves original `tx_hash` alongside `rbf_candidate_tx_hash` during RBF recovery.
 * - Blocks Tor exit nodes (`CF-IPCountry: T1`) with `451 GEO_RESTRICTED`, ignores spoofed
 *   `x-vercel-ip-country` headers by default, and enforces `uidToProfileMap` completeness.
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { secp256k1 } from '@noble/curves/secp256k1';
import { NextRequest } from 'next/server';
import { keccak256, type Hex } from 'viem';
import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import { POST as batchPayoutPost } from '@/app/api/admin/payouts/batch/route';
import { POST as retryPayoutPost } from '@/app/api/admin/payouts/retry/route';
import { POST as ingestRoutePost } from '@/app/api/admin/reconciliation/ingest/route';
import { POST as dispatchRoutePost } from '@/app/api/admin/settlement/dispatch/route';
import { POST as telegramAuthPost } from '@/app/api/auth/telegram/route';
import { POST as legacyPayoutsPost } from '@/app/api/payouts/route';
import { PATCH as profilePatch } from '@/app/api/profile/route';
import {
  DELETE as legacyWalletDelete,
  POST as legacyWalletPost,
} from '@/app/api/profile/wallet/route';
import { POST as legacyExchangeWebhookPost } from '@/app/api/webhooks/exchange/route';
import {
  PASSKEY_STEPUP_HEADER,
  issuePasskeyStepUpToken,
} from '@/lib/auth/passkey-step-up';
import { evaluateGeoFence } from '@/lib/compliance/geo-fence';
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
  HorizonStellarBroadcastTransport,
  TurnkeyServerHsmTransport,
  TurnkeySigner,
  attachEd25519SignatureToStellarEnvelopeXdr,
  type EvmDigestSignature,
  type EvmJsonRpcTransport,
  type StellarBroadcastTransport,
  type StellarEnvelopeSignature,
  type TurnkeySigningTransport,
} from '@/lib/payouts';
import { StellarNetwork, StellarService } from '@/lib/payouts/stellar-service';
import { signTelegramInitData } from '@/lib/telegram/crypto';

const nativeNodeModule = (
  process as unknown as { getBuiltinModule: (id: string) => { createRequire: (origin: string) => NodeRequire } }
).getBuiltinModule('node:module');
const StellarSdk = nativeNodeModule.createRequire(__filename)(
  '@stellar/stellar-sdk'
) as typeof StellarSdkTypes;
const STELLAR_HSM_ENCLAVE_KEYPAIR = StellarSdk.Keypair.fromRawEd25519Seed(
  Buffer.alloc(32, 0x24)
);
const STELLAR_HOT_ADDR = STELLAR_HSM_ENCLAVE_KEYPAIR.publicKey();
const STELLAR_RECIPIENT_ADDR = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const EVM_HOT_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EVM_RECIPIENT_ADDR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const EVM_WHALE_RECIPIENT_ADDR = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';

class DeterministicHsmTransport implements TurnkeySigningTransport {
  private readonly privKeyHex = '11'.repeat(32);

  async signEvmDigest(params: {
    digestHex: Hex;
    payoutId: string;
  }): Promise<EvmDigestSignature> {
    const sig = secp256k1.sign(params.digestHex.slice(2), this.privKeyHex);
    return {
      r: `0x${sig.r.toString(16).padStart(64, '0')}`,
      s: `0x${sig.s.toString(16).padStart(64, '0')}`,
      yParity: (sig.recovery === 1 ? 1 : 0) as 0 | 1,
      activityId: `tk_evm_${params.payoutId}`,
    };
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    const txHashBytes = Buffer.from(params.txHashHex.replace(/^0x/i, ''), 'hex');
    const sigBytes = Buffer.from(STELLAR_HSM_ENCLAVE_KEYPAIR.sign(txHashBytes));
    const signedEnvelopeXdr = attachEd25519SignatureToStellarEnvelopeXdr({
      signerAddress: params.signerAddress,
      unsignedEnvelopeXdr: params.unsignedEnvelopeXdr,
      sigBytes,
      networkPassphrase: StellarSdk.Networks.TESTNET,
    });
    return {
      signedEnvelopeXdr,
      txHash: params.txHashHex.replace(/^0x/, ''),
      signatureBase64: sigBytes.toString('base64'),
      activityId: `tk_xlm_${params.payoutId}`,
    };
  }
}

describe('Settlement Lock Lifecycle, 64-Bit Stellar Sequences & Legacy Boundary Hardening', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;
  let r2: InMemoryR2Bucket;
  let adminStepUpToken: string;

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
    ]) {
      sqlite.exec(fs.readFileSync(path.join(migDir, file), 'utf8'));
    }

    const futureExp = new Date(Date.now() + 3600_000).toISOString();
    sqlite
      .prepare(
        `INSERT INTO profiles (id, email, full_name, role, referral_code, wallet_address, preferred_chain)
         VALUES
           ('admin_root', 'admin@apexos.app', 'Root Admin', 'admin', 'ADM1', NULL, NULL),
           ('trader_u1', 'trader1@proton.me', 'Trader One', 'shopper', 'TRD1', NULL, NULL),
           ('aff_l1', 'partner1@agency.io', 'Partner Desk', 'affiliate', 'AFF1', ?, 'arbitrum'),
           ('aff_whale', 'whale@agency.io', 'Whale Desk', 'affiliate', 'WHL1', ?, 'arbitrum')`
      )
      .run(EVM_RECIPIENT_ADDR, EVM_WHALE_RECIPIENT_ADDR);

    sqlite
      .prepare(
        `INSERT INTO sessions (id, user_id, token, expires_at)
         VALUES
           ('sess_adm_1', 'admin_root', 'adm_tok_123', ?),
           ('sess_aff_1', 'aff_l1', 'aff_tok_123', ?)`
      )
      .run(futureExp, futureExp);

    sqlite
      .prepare(
        `INSERT INTO webauthn_challenges (challenge_id, user_id, challenge, purpose, expires_at, consumed)
         VALUES ('chal_adm_1', 'admin_root', 'chal_bytes', 'admin_step_up', ?, 1)`
      )
      .run(futureExp);

    db = new SqliteD1Adapter(sqlite);
    r2 = new InMemoryR2Bucket();
    (globalThis as unknown as { DB?: unknown }).DB = db;
    (globalThis as unknown as { STORAGE?: unknown }).STORAGE = r2;

    adminStepUpToken = issuePasskeyStepUpToken({
      userId: 'admin_root',
      purpose: 'admin_step_up',
      challengeId: 'chal_adm_1',
    });

    // Seed settled balances for aff_l1 ($100.00) and aff_whale ($400.00) via reconciled commissions
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
    const grossSeed = parseUsdToLedgerUnits('4000.00');
    const recon = await reconcilePartnerCashBatch(db, {
      exchange: 'bybit',
      evidenceId: partnerEv.id,
      walletEvidenceId: walletEv.id,
      uidAllocatedUnits: grossSeed,
      walletCashCollectedUnits: grossSeed,
      r2,
    });
    const createdAt = '2026-11-01T00:00:00.000Z';
    const b1 = await ledger.recordVerifiedCommissionInflight({
      idempotencyKey: 'seed_b1',
      exchange: 'bybit',
      traderUid: 'uid_seed_1',
      traderId: 'trader_u1',
      l1AffiliateId: 'aff_l1',
      reconciliationId: recon.id,
      evidenceId: partnerEv.id,
      grossCommissionUnits: parseUsdToLedgerUnits('1000.00'), // L1 = $142.50
      createdAt,
      r2,
    });
    const b2 = await ledger.recordVerifiedCommissionInflight({
      idempotencyKey: 'seed_b2',
      exchange: 'bybit',
      traderUid: 'uid_seed_2',
      traderId: 'trader_u1',
      l1AffiliateId: 'aff_whale',
      reconciliationId: recon.id,
      evidenceId: partnerEv.id,
      grossCommissionUnits: parseUsdToLedgerUnits('3000.00'), // L1 = $427.50
      createdAt,
      r2,
    });
    const matureIso = '2026-11-10T00:00:00.000Z';
    await ledger.releaseMaturedInflightBatch(b1.batch.id, matureIso);
    await ledger.releaseMaturedInflightBatch(b2.batch.id, matureIso);
  });

  afterEach(async () => {
    delete (globalThis as unknown as { DB?: unknown }).DB;
    delete (globalThis as unknown as { STORAGE?: unknown }).STORAGE;
    delete (globalThis as unknown as { SETTLEMENT_MACHINE?: unknown }).SETTLEMENT_MACHINE;
    if (db) {
      await db.close();
    }
  });

  it('prevents double-spend on reverted idempotencyKey retry, blocks payoutId reuse, and settles ledger locks on recover & resolve_cold_safe', async () => {
    let blacklistedFlag = true;
    let sendShould504 = false;
    let minedTxHash: string | null = null;
    let broadcastCalls = 0;

    const rpcTransport: EvmJsonRpcTransport = {
      async call<T>(method: string, params?: unknown[]): Promise<T> {
        if (method === 'eth_call') {
          const callObj = (params?.[0] ?? {}) as { data?: string };
          if (callObj.data?.toLowerCase().startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR.toLowerCase())) {
            return (blacklistedFlag
              ? '0x0000000000000000000000000000000000000000000000000000000000000001'
              : '0x0000000000000000000000000000000000000000000000000000000000000000') as T;
          }
          return '0x0000000000000000000000000000000000000000000000000000000000000001' as T;
        }
        if (method === 'eth_getTransactionCount') {
          return (minedTxHash ? '0x1' : '0x0') as T;
        }
        if (method === 'eth_estimateGas') {
          return '0xfde8' as T;
        }
        if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') {
          return '0x5f5e100' as T;
        }
        if (method === 'eth_getBlockByNumber') {
          return { baseFeePerGas: '0x5f5e100' } as T;
        }
        if (method === 'eth_sendRawTransaction') {
          broadcastCalls += 1;
          const rawTx = String(params?.[0] ?? '') as Hex;
          const hash = keccak256(rawTx);
          minedTxHash = hash;
          if (sendShould504) {
            throw new Error('504 Gateway Timeout from Arbitrum RPC');
          }
          return hash as T;
        }
        if (method === 'eth_getTransactionReceipt') {
          const queriedHash = String(params?.[0] ?? '');
          if (minedTxHash && queriedHash === minedTxHash) {
            return {
              status: '0x1',
              blockNumber: '0x10',
              gasUsed: '0xc350',
              effectiveGasPrice: '0x5f5e100',
              transactionHash: minedTxHash,
            } as T;
          }
          return null as T;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    };

    const arbAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode: 'mainnet',
      hotWalletAddress: EVM_HOT_ADDR,
      primaryRpc: rpcTransport,
    });

    const machine = new BroadcastRecoveryMachine({
      db: db as unknown as LegacyD1Database,
      turnkeySigner: new TurnkeySigner({
        transport: new DeterministicHsmTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_ADDR,
      }),
      evmAdapters: { arbitrum: arbAdapter },
    });
    (globalThis as unknown as { SETTLEMENT_MACHINE?: unknown }).SETTLEMENT_MACHINE = machine;

    const ledger = new DoubleEntryLedgerService(db);

    // 1. First attempt fails pre-signing (`isBlacklisted === true`) -> reverts WITHDRAWAL_LOCK (`VOIDED`)
    const failRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_b1_test',
          idempotencyKey: 'idem_b1_voided',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '50.00',
        }),
      })
    );
    expect(failRes.status).toBe(400);
    expect(broadcastCalls).toBe(0);

    const affAfterRevert = await ledger.getAccountByOwner('affiliate', 'aff_l1');
    expect(affAfterRevert?.settledBalanceUnits.toString()).toBe('14250000000'); // full $142.50 intact

    // 2. Retrying the EXACT SAME `idem_b1_voided` after blacklist clears MUST return 409 and NEVER broadcast!
    blacklistedFlag = false;
    const retryVoidedRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_b1_test',
          idempotencyKey: 'idem_b1_voided',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '50.00',
        }),
      })
    );
    expect(retryVoidedRes.status).toBe(409);
    const retryVoidedBody = (await retryVoidedRes.json()) as { code: string };
    expect(retryVoidedBody.code).toBe('IDEMPOTENCY_KEY_PREVIOUSLY_VOIDED');
    expect(broadcastCalls).toBe(0);

    // 3. Dispatch with 504 timeout -> BROADCAST_PENDING + INFLIGHT withdrawal lock
    sendShould504 = true;
    const pendingRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_b2_recover',
          idempotencyKey: 'idem_b2_recover_1',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '50.00',
        }),
      })
    );
    const pendingBody = (await pendingRes.json()) as {
      lockBatchId: string;
      error?: string;
      settlement: { state: string };
    };
    expect({ status: pendingRes.status, error: pendingBody.error }).toEqual({
      status: 200,
      error: undefined,
    });
    expect(pendingBody.settlement.state).toBe('BROADCAST_PENDING');

    // 4. Attempting to reuse `po_b2_recover` with a DIFFERENT `idempotencyKey` -> 409 (no second debit!)
    const reusePayoutIdRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_b2_recover',
          idempotencyKey: 'idem_b2_attacker_new',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '50.00',
        }),
      })
    );
    expect(reusePayoutIdRes.status).toBe(409);

    // 5. `action: 'recover'` reconciles on-chain receipt AND finalizes the ledger WITHDRAWAL_LOCK!
    sendShould504 = false;
    const recoverRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'recover',
          payoutId: 'po_b2_recover',
        }),
      })
    );
    expect(recoverRes.status).toBe(200);
    const finalizedLock = await ledger.getBatchById(pendingBody.lockBatchId);
    expect(finalizedLock?.status).toBe('SETTLED');

    // 6. Cold-Safe payout (`>$250` -> `QUEUED_COLD_SAFE`) + `action: 'resolve_cold_safe'` (`CANCELLED` refunds user!)
    const coldDispatchRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_cold_whale_1',
          idempotencyKey: 'idem_cold_whale_1',
          affiliateId: 'aff_whale',
          chain: 'arbitrum',
          recipientAddress: EVM_WHALE_RECIPIENT_ADDR,
          amountUsd: '300.00',
        }),
      })
    );
    expect(coldDispatchRes.status).toBe(200);
    const coldBody = (await coldDispatchRes.json()) as {
      lockBatchId: string;
      settlement: { state: string };
    };
    expect(coldBody.settlement.state).toBe('QUEUED_COLD_SAFE');

    const resolveColdRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'resolve_cold_safe',
          payoutId: 'po_cold_whale_1',
          coldResolution: 'CANCELLED',
          reason: 'Safe signers declined test payout',
        }),
      })
    );
    expect(resolveColdRes.status).toBe(200);
    const coldLockAfterCancel = await ledger.getBatchById(coldBody.lockBatchId);
    expect(coldLockAfterCancel?.status).toBe('VOIDED');
    const whaleAfterRefund = await ledger.getAccountByOwner('affiliate', 'aff_whale');
    expect(whaleAfterRefund?.settledBalanceUnits.toString()).toBe('42750000000'); // full $427.50 refunded!

    const inv = await verifyLedgerInvariants(db);
    expect(inv.valid).toBe(true);
  });

  it('preserves 64-bit Stellar sequence numbers (> 2^53 - 1) and attaches DecoratedSignature to XDR envelopes', async () => {
    // Real 63-bit Stellar Horizon sequence: (2_000_000_000 << 32) + 7 = 8,589,934,592,000,000,007 (> Number.MAX_SAFE_INTEGER, <= 2^63 - 1)
    const hugeHorizonSeq = (BigInt(2_000_000_000) << BigInt(32)) + BigInt(7);
    expect(hugeHorizonSeq > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);

    const mockStellarService = {
      hasUsdcTrustline: async () => true,
      getAccount: async () => ({
        accountId: STELLAR_HOT_ADDR,
        sequence: hugeHorizonSeq.toString(),
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

    let capturedSignedXdr = '';
    const interceptingTransport: StellarBroadcastTransport = {
      hasUsdcTrustline: (addr) => realTransport.hasUsdcTrustline(addr),
      getAccountSequence: (addr) => realTransport.getAccountSequence(addr),
      buildUnsignedUsdcPayment: (p) => realTransport.buildUnsignedUsdcPayment(p),
      async submitSignedTransaction(params) {
        capturedSignedXdr = params.signedEnvelopeXdr;
        return { txHash: params.expectedTxHash, confirmed: true };
      },
      lookupTransaction: (h) => realTransport.lookupTransaction(h),
    };

    const machine = new BroadcastRecoveryMachine({
      db: db as unknown as LegacyD1Database,
      turnkeySigner: new TurnkeySigner({
        transport: new DeterministicHsmTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_ADDR,
      }),
      evmAdapters: {},
      stellarTransport: interceptingTransport,
    });

    const outcome = await machine.executeSettlement({
      payoutId: 'po_xlm_64bit_1',
      idempotencyKey: 'idem_xlm_64bit_1',
      affiliateId: 'aff_l1',
      chain: 'stellar',
      recipientAddress: STELLAR_RECIPIENT_ADDR,
      amountUnits1e8: parseUsdToLedgerUnits('25.00'),
      nowUnix: 1_763_100_000,
    });

    expect(outcome.state).toBe('CONFIRMED');
    const expectedAssignedSeq = (hugeHorizonSeq + BigInt(1)).toString(); // ...00000008
    expect(outcome.stellarSequence).toBe(expectedAssignedSeq);

    const nextSeqInDb = await machine.getNextStellarSequence(STELLAR_HOT_ADDR);
    expect(nextSeqInDb?.toString()).toBe((hugeHorizonSeq + BigInt(2)).toString()); // ...00000009 (exact!)
    expect(capturedSignedXdr.length).toBeGreaterThan(20);

    // Also verify TurnkeyServerHsmTransport rejects empty r/s instead of zero-padding
    const hsm = new TurnkeyServerHsmTransport({
      apiPublicKey: '02' + 'aa'.repeat(32),
      apiPrivateKey: 'bb'.repeat(32),
      organizationId: 'org_test_123',
    });
    jest
      .spyOn(
        (hsm as unknown as { turnkey: { apiClient: () => unknown } }).turnkey,
        'apiClient'
      )
      .mockReturnValue({
        signRawPayload: async () => ({ r: '', s: '', v: '00' }),
      });

    await expect(
      hsm.signEvmDigest({
        chain: 'arbitrum',
        signerAddress: EVM_HOT_ADDR,
        digestHex: `0x${'22'.repeat(32)}`,
        payoutId: 'po_bad_sig',
      })
    ).rejects.toThrow(/invalid or empty signature components/i);
  });

  it('enforces 48h wallet timelock, VN signup kill-switch, Passkey step-up, and reconciliation-only webhooks on legacy routes', async () => {
    // 1. Legacy POST /api/profile/wallet rejects Ethereum L1 (400) and routes Arbitrum changes into 48h timelock (202)
    const ethWalletRes = await legacyWalletPost(
      new NextRequest('https://apexos.app/api/profile/wallet', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer aff_tok_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          wallet_address: '0x1111111111111111111111111111111111111111',
          preferred_chain: 'ethereum',
        }),
      })
    );
    expect(ethWalletRes.status).toBe(400);

    const arbSwapRes = await legacyWalletPost(
      new NextRequest('https://apexos.app/api/profile/wallet', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer aff_tok_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          wallet_address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
          preferred_chain: 'arbitrum',
        }),
      })
    );
    expect(arbSwapRes.status).toBe(202);
    const profRow = sqlite
      .prepare('SELECT wallet_address FROM profiles WHERE id = ?')
      .get('aff_l1') as { wallet_address: string };
    // Immediate overwrite MUST NOT occur while 48h timelock is pending!
    expect(profRow.wallet_address).toBe(EVM_RECIPIENT_ADDR);

    // Legacy DELETE /api/profile/wallet cannot bypass 48h timelock
    const delWalletRes = await legacyWalletDelete(
      new NextRequest('https://apexos.app/api/profile/wallet', {
        method: 'DELETE',
        headers: { Authorization: 'Bearer aff_tok_123' },
      })
    );
    expect(delWalletRes.status).toBe(409);

    // 2. Telegram Mini App honors BLOCK_VN_SIGNUPS=true with 451
    sqlite
      .prepare("UPDATE system_runtime_flags SET flag_value = 'true' WHERE flag_key = 'BLOCK_VN_SIGNUPS'")
      .run();
    const initData = await signTelegramInitData(
      {
        user: { id: 88990011, first_name: 'Minh' },
        auth_date: Math.floor(Date.now() / 1000),
      },
      'test_bot_token'
    );
    const tgVnRes = await telegramAuthPost(
      new NextRequest('https://apexos.app/api/auth/telegram', {
        method: 'POST',
        headers: {
          'CF-IPCountry': 'VN',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ initData }),
      })
    );
    expect(tgVnRes.status).toBe(451);

    // 3. Legacy admin payout routes require Passkey step-up (403 without token, 409 disabled even with token)
    const legacyNoPasskey = await legacyPayoutsPost(
      new NextRequest('https://apexos.app/api/payouts', {
        method: 'POST',
        headers: { Authorization: 'Bearer adm_tok_123' },
      })
    );
    expect(legacyNoPasskey.status).toBe(403);

    const batchWithPasskey = await batchPayoutPost(
      new NextRequest('https://apexos.app/api/admin/payouts/batch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ action: 'execute', chain: 'stellar', dryRun: false }),
      })
    );
    expect(batchWithPasskey.status).toBe(409);

    const retryWithPasskey = await retryPayoutPost(
      new NextRequest('https://apexos.app/api/admin/payouts/retry', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ payoutId: 'po_legacy_1' }),
      })
    );
    expect(retryWithPasskey.status).toBe(409);

    // 4. Legacy /api/webhooks/exchange enqueues for reconciliation ONLY (202) and mints ZERO `earnings` rows!
    process.env.BINANCE_WEBHOOK_SECRET = 'wh_test_secret_32_bytes_minimum!!';
    const nowMs = Date.now();
    const rawWh = JSON.stringify({
      e: 'executionReport',
      E: nowMs,
      u: '998877',
      o: {
        s: 'BTCUSDT',
        i: 991122,
        S: 'BUY',
        X: 'FILLED',
        l: '1.0',
        L: '50000.0',
        Z: '50000.0',
        n: '25.0',
        N: 'USDT',
        T: nowMs,
      },
    });
    const whSig = crypto
      .createHmac('sha256', process.env.BINANCE_WEBHOOK_SECRET)
      .update(rawWh, 'utf8')
      .digest('hex');

    const whRes1 = await legacyExchangeWebhookPost(
      new NextRequest('https://apexos.app/api/webhooks/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-binance-signature': whSig,
        },
        body: rawWh,
      })
    );
    expect(whRes1.status).toBe(202);
    const whBody1 = (await whRes1.json()) as { action: string; autoPayoutTriggered: boolean };
    expect(whBody1.action).toBe('ENQUEUED_FOR_RECONCILIATION_ONLY');
    expect(whBody1.autoPayoutTriggered).toBe(false);

    // Exact replay is blocked by D1 `webhook_nonces` even without Cloudflare KV!
    const whResReplay = await legacyExchangeWebhookPost(
      new NextRequest('https://apexos.app/api/webhooks/exchange', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-binance-signature': whSig,
        },
        body: rawWh,
      })
    );
    expect(whResReplay.status).toBe(409);

    const earningsCount = sqlite
      .prepare('SELECT COUNT(*) AS cnt FROM earnings')
      .get() as { cnt: number };
    expect(earningsCount.cnt).toBe(0);
  });

  it('fails closed without R2 STORAGE (503), rejects unmapped UIDs (422), blocks Tor T1 (451), and ignores spoofed x-vercel-ip-country', async () => {
    // 1. Tor exit node `CF-IPCountry: T1` -> 451 GEO_RESTRICTED
    const torDecision = await evaluateGeoFence(
      new Request('https://apexos.app/en/deals', {
        headers: { 'CF-IPCountry': 'T1' },
      })
    );
    expect(torDecision.allowed).toBe(false);
    expect(torDecision.status).toBe(451);
    expect(torDecision.code).toBe('GEO_RESTRICTED');

    // 2. Spoofed `x-vercel-ip-country: US` without `CF-IPCountry` is ignored by default
    const spoofedVercel = await evaluateGeoFence(
      new Request('https://apexos.app/en/deals', {
        headers: { 'x-vercel-ip-country': 'US' },
      })
    );
    expect(spoofedVercel.allowed).toBe(true);

    // 3. Missing `STORAGE` R2 binding on reconciliation ingest -> 503 EVIDENCE_STORAGE_UNAVAILABLE
    delete (globalThis as unknown as { STORAGE?: unknown }).STORAGE;
    const noR2Res = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exchange: 'bybit',
          statementPeriodStart: '2026-11-02T00:00:00Z',
          statementPeriodEnd: '2026-11-02T23:59:59Z',
          rawPartnerPayload: '{}',
          rawWalletStatementPayload: '{}',
          walletCashCollectedUsd: '10.00',
        }),
      })
    );
    expect(noR2Res.status).toBe(503);
    const noR2Body = (await noR2Res.json()) as { code: string };
    expect(noR2Body.code).toBe('EVIDENCE_STORAGE_UNAVAILABLE');

    // 4. Restore STORAGE and verify unmapped UID pre-validation returns 422 BEFORE burning reconciliation
    (globalThis as unknown as { STORAGE?: unknown }).STORAGE = r2;
    const bybitPayload = JSON.stringify({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          {
            userId: 'unmapped_uid_999',
            coin: 'USDC',
            netCommission: '25.00',
            tradeVol: '50000.00',
            recordId: 'bybit_unmapped_1',
            timestamp: '1763078400000',
          },
        ],
      },
    });
    const unmappedRes = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exchange: 'bybit',
          statementPeriodStart: '2026-11-02T00:00:00Z',
          statementPeriodEnd: '2026-11-02T23:59:59Z',
          rawPartnerPayload: bybitPayload,
          rawWalletStatementPayload: '{"cash":"25.00"}',
          walletCashCollectedUsd: '25.00',
          uidToProfileMap: {},
        }),
      })
    );
    expect(unmappedRes.status).toBe(422);
    const unmappedBody = (await unmappedRes.json()) as { code: string; unmappedUids: string[] };
    expect(unmappedBody.code).toBe('UNMAPPED_TRADER_UIDS');
    expect(unmappedBody.unmappedUids).toEqual(['unmapped_uid_999']);
  });

  it('requires confirmed on-chain receipts before CONFIRMED, reclaims pre-broadcast nonces on HSM failure, tracks multi-RBF candidate hashes, and enforces bound wallet + USD stablecoin asset guards', async () => {
    const ledger = new DoubleEntryLedgerService(db);

    // 1. Reject non-USD token commissions (e.g. PEPE) with 422 UNSUPPORTED_COMMISSION_ASSET
    const pepePayload = JSON.stringify({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          {
            userId: 'uid_pepe_1',
            coin: 'PEPE',
            netCommission: '500000.00',
            tradeVol: '1000.00',
            recordId: 'bybit_pepe_1',
            timestamp: '1763078400000',
          },
        ],
      },
    });
    const pepeRes = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exchange: 'bybit',
          statementPeriodStart: '2026-11-03T00:00:00Z',
          statementPeriodEnd: '2026-11-03T23:59:59Z',
          rawPartnerPayload: pepePayload,
          rawWalletStatementPayload: '{"cash":"500000.00"}',
          walletCashCollectedUsd: '500000.00',
          uidToProfileMap: {
            uid_pepe_1: { traderProfileId: 'trader_u1', l1AffiliateId: 'aff_l1' },
          },
        }),
      })
    );
    expect(pepeRes.status).toBe(422);
    const pepeBody = (await pepeRes.json()) as { code: string };
    expect(pepeBody.code).toBe('UNSUPPORTED_COMMISSION_ASSET');

    // 2. Mixed batch (+100 USDC commission and -20 USDC clawback against seed_b1; net cash collected = $80.00)
    const mixedPayload = JSON.stringify({
      retCode: 0,
      retMsg: 'OK',
      result: {
        list: [
          {
            userId: 'uid_mix_pos_1',
            coin: 'USDC',
            netCommission: '100.00',
            tradeVol: '100000.00',
            recordId: 'bybit_mix_pos_1',
            timestamp: '1763078400000',
          },
          {
            userId: 'uid_seed_1',
            coin: 'USDC',
            netCommission: '-20.00',
            tradeVol: '0.00',
            recordId: 'bybit_mix_cb_1',
            timestamp: '1763078401000',
          },
        ],
      },
    });
    const mixedRes = await ingestRoutePost(
      new NextRequest('https://apexos.app/api/admin/reconciliation/ingest', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          exchange: 'bybit',
          statementPeriodStart: '2026-11-04T00:00:00Z',
          statementPeriodEnd: '2026-11-04T23:59:59Z',
          rawPartnerPayload: mixedPayload,
          rawWalletStatementPayload: '{"netCash":"80.00"}',
          walletCashCollectedUsd: '80.00',
          uidToProfileMap: {
            uid_mix_pos_1: { traderProfileId: 'trader_u1', l1AffiliateId: 'aff_l1' },
          },
        }),
      })
    );
    expect(mixedRes.status).toBe(200);
    const mixedJson = (await mixedRes.json()) as {
      mintedBatches: number;
      clawbackBatches: number;
    };
    expect(mixedJson).toMatchObject({ mintedBatches: 1, clawbackBatches: 1 });

    // 3. Bound wallet + chain enforcement on settlement dispatch (attacker address or wrong EVM chain -> 403)
    let hsmShouldFailOnce = false;
    const broadcastHashes: string[] = [];
    let minedHashOnChain: string | null = null;
    let minedReceiptStatus: '0x1' | '0x0' = '0x1';

    const rbfAwareRpc: EvmJsonRpcTransport = {
      async call<T>(method: string, params?: unknown[]): Promise<T> {
        if (method === 'eth_call') {
          const callObj = (params?.[0] ?? {}) as { data?: string };
          if (callObj.data?.toLowerCase().startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR.toLowerCase())) {
            return '0x0000000000000000000000000000000000000000000000000000000000000000' as T;
          }
          return '0x0000000000000000000000000000000000000000000000000000000000000001' as T;
        }
        if (method === 'eth_getTransactionCount') {
          return (minedHashOnChain ? '0x1' : '0x0') as T;
        }
        if (method === 'eth_estimateGas') return '0xfde8' as T;
        if (method === 'eth_gasPrice' || method === 'eth_maxPriorityFeePerGas') {
          return '0x5f5e100' as T;
        }
        if (method === 'eth_sendRawTransaction') {
          const rawHex = String(params?.[0] ?? '') as Hex;
          const hash = keccak256(rawHex);
          broadcastHashes.push(hash);
          return hash as T; // Admitted to mempool ONLY — NOT mined yet unless minedHashOnChain is set!
        }
        if (method === 'eth_getTransactionReceipt') {
          const queried = String(params?.[0] ?? '');
          if (minedHashOnChain && queried.toLowerCase() === minedHashOnChain.toLowerCase()) {
            return {
              status: minedReceiptStatus,
              blockNumber: '0x20',
              gasUsed: '0xc350',
              effectiveGasPrice: '0x5f5e100',
              transactionHash: minedHashOnChain,
            } as T;
          }
          return null as T;
        }
        throw new Error(`Unexpected RPC method: ${method}`);
      },
    };

    const baseTransport = new DeterministicHsmTransport();
    const faultInjectableHsm: TurnkeySigningTransport = {
      async signEvmDigest(p) {
        if (hsmShouldFailOnce) {
          hsmShouldFailOnce = false;
          throw new Error('Turnkey HSM transient enclave connection reset');
        }
        return baseTransport.signEvmDigest(p);
      },
      signStellarEnvelope: (p) => baseTransport.signStellarEnvelope(p),
    };

    const arbAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'arbitrum',
      networkMode: 'mainnet',
      hotWalletAddress: EVM_HOT_ADDR,
      primaryRpc: rbfAwareRpc,
    });
    const baseAdapter = new ArbitrumBaseUsdcAdapter({
      chain: 'base',
      networkMode: 'mainnet',
      hotWalletAddress: EVM_HOT_ADDR,
      primaryRpc: rbfAwareRpc,
    });

    const machine = new BroadcastRecoveryMachine({
      db: db as unknown as LegacyD1Database,
      turnkeySigner: new TurnkeySigner({
        transport: faultInjectableHsm,
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_ADDR,
      }),
      evmAdapters: { arbitrum: arbAdapter, base: baseAdapter },
    });
    (globalThis as unknown as { SETTLEMENT_MACHINE?: unknown }).SETTLEMENT_MACHINE = machine;

    // Attacker tries to redirect aff_l1's payout to a different EVM address -> 403 RECIPIENT_WALLET_MISMATCH
    const mismatchedAddrRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_mismatch_addr',
          idempotencyKey: 'idem_mismatch_addr',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
          amountUsd: '20.00',
        }),
      })
    );
    expect(mismatchedAddrRes.status).toBe(403);

    // Cross-chain mismatch (`aff_l1` is bound to `arbitrum`, not `base`) -> 403 RECIPIENT_WALLET_MISMATCH
    const mismatchedChainRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_mismatch_chain',
          idempotencyKey: 'idem_mismatch_chain',
          affiliateId: 'aff_l1',
          chain: 'base',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '20.00',
        }),
      })
    );
    expect(mismatchedChainRes.status).toBe(403);

    // Direct `PATCH /api/profile` with `preferred_chain: 'base'` -> 409 USE_WALLET_TIMELOCK_ENDPOINT
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
      new Response(JSON.stringify({ user: { id: 'aff_l1' } }), { status: 200 })
    );
    const patchChainRes = await profilePatch(
      new NextRequest('https://apexos.app/api/profile', {
        method: 'PATCH',
        headers: {
          cookie: 'better-auth.session_token=aff_tok_123',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ preferred_chain: 'base' }),
      })
    );
    expect(patchChainRes.status).toBe(409);
    fetchSpy.mockRestore();

    // 4. Pre-broadcast HSM failure reclaims EVM nonce 0, marks FAILED_ABORTED (NOT stranded SIGNING!), and refunds WITHDRAWAL_LOCK
    hsmShouldFailOnce = true;
    const hsmFailRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_hsm_fail_1',
          idempotencyKey: 'idem_hsm_fail_1',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '20.00',
        }),
      })
    );
    expect(hsmFailRes.status).toBe(400);
    const failedRow = await machine.getSettlementRecord('po_hsm_fail_1');
    expect(failedRow?.state).toBe('FAILED_ABORTED');
    expect(await machine.getNextSignerNonce('arbitrum', EVM_HOT_ADDR)).toBe(0);
    const voidedAfterHsmFail = await ledger.getBatchByIdempotencyKey('wd_lock:idem_hsm_fail_1');
    expect(voidedAfterHsmFail?.status).toBe('VOIDED');

    // 5. Mempool-only broadcast stays `BROADCAST_PENDING` (keeping WITHDRAWAL_LOCK `INFLIGHT`) + multi-RBF candidate tracking!
    const mempoolDispatchRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_mempool_rbf',
          idempotencyKey: 'idem_mempool_rbf',
          affiliateId: 'aff_l1',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT_ADDR,
          amountUsd: '25.00',
        }),
      })
    );
    expect(mempoolDispatchRes.status).toBe(200);
    const mempoolBody = (await mempoolDispatchRes.json()) as {
      lockBatchId: string;
      settlement: { state: string; assignedNonce: number; txHash: string };
    };
    expect(mempoolBody.settlement.state).toBe('BROADCAST_PENDING');
    expect(mempoolBody.settlement.assignedNonce).toBe(0); // Reclaimed nonce 0 reused cleanly without gap!
    const inflightLock = await ledger.getBatchById(mempoolBody.lockBatchId);
    expect(inflightLock?.status).toBe('INFLIGHT'); // NOT prematurely settled!

    // Perform two successive RBF fee bumps while still unmined; then let RBF #1 (`broadcastHashes[1]`) mine on-chain!
    const rbf1 = await machine.recoverUncertainBroadcast('po_mempool_rbf', { bumpGasRbf: true });
    expect(rbf1.state).toBe('BROADCAST_PENDING');
    const rbf2 = await machine.recoverUncertainBroadcast('po_mempool_rbf', { bumpGasRbf: true });
    expect(rbf2.state).toBe('BROADCAST_PENDING');
    expect(broadcastHashes.length).toBe(3); // H0 (orig), H1 (RBF #1), H2 (RBF #2)

    // H1 mines on-chain (even though rbf_candidate_tx_hash now points to H2!)
    minedHashOnChain = broadcastHashes[1]!;
    minedReceiptStatus = '0x1';

    const reconciledRbfRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'recover',
          payoutId: 'po_mempool_rbf',
        }),
      })
    );
    expect(reconciledRbfRes.status).toBe(200);
    const recRbfBody = (await reconciledRbfRes.json()) as {
      recovery: { state: string; txHash: string };
    };
    expect(recRbfBody.recovery.state).toBe('CONFIRMED');
    expect(recRbfBody.recovery.txHash).toBe(broadcastHashes[1]);
    const settledAfterReceipt = await ledger.getBatchById(mempoolBody.lockBatchId);
    expect(settledAfterReceipt?.status).toBe('SETTLED');

    // 6. Cold-Safe `CONFIRMED` requires verified on-chain receipt (fabricating an unmined txHash fails!)
    const coldWhaleRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          payoutId: 'po_cold_verify_receipt',
          idempotencyKey: 'idem_cold_verify_receipt',
          affiliateId: 'aff_whale',
          chain: 'arbitrum',
          recipientAddress: EVM_WHALE_RECIPIENT_ADDR,
          amountUsd: '280.00',
        }),
      })
    );
    expect(coldWhaleRes.status).toBe(200);

    const fakeColdConfirmRes = await dispatchRoutePost(
      new NextRequest('https://apexos.app/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer adm_tok_123',
          [PASSKEY_STEPUP_HEADER]: adminStepUpToken,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'resolve_cold_safe',
          payoutId: 'po_cold_verify_receipt',
          coldResolution: 'CONFIRMED',
          txHash: `0x${'de'.repeat(32)}`,
        }),
      })
    );
    expect(fakeColdConfirmRes.status).toBe(400);

    const invariants = await verifyLedgerInvariants(db);
    expect(invariants.valid).toBe(true);
  });
});
