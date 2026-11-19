/**
 * @jest-environment node
 *
 * Turnkey HSM & Multichain Money Precision Hardening Tests:
 * 1. GET /api/admin/payouts/treasury blocks legacy raw-key probes with HTTP 410
 *    when settlement_broadcasts is active or TURNKEY_STELLAR_HOT_WALLET_ADDRESS is set.
 * 2. Residual dust preservation in POST /api/admin/settlement/dispatch and
 *    BroadcastRecoveryMachine (Stellar 7dp & Arbitrum/Base 6dp) leaves sub-chain dust
 *    untouched in the user's settled balance and enforces the $10.00 disbursable floor.
 * 3. TurnkeySigner Cold Safe address resolution fails closed in production/staging
 *    when SAFE_COLD_*_ADDRESS env vars are unset while preserving test-mode defaults.
 * 4. BroadcastRecoveryMachine verifies on-chain transfer details (recipient, asset,
 *    amountUnits) on cold-safe confirmation and sanitizes secrets in broadcast/submit errors.
 * 5. updateStellarConfig enforces an HTTPS Horizon host allowlist (SSRF guard) and
 *    sanitizes diagnostic error messages.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { secp256k1 } from '@noble/curves/secp256k1';
import { keccak256, type Hex } from 'viem';

const mockGetSession = jest.fn<Promise<{ user: { id: string } } | null>, []>(
  async () => ({ user: { id: 'admin-1' } })
);

jest.mock('next/headers', () => ({
  headers: jest.fn(async () => ({
    forEach: (cb: (value: string, key: string) => void) => {
      cb('better-auth.session_token=admin_tok', 'cookie');
    },
  })),
  cookies: jest.fn(async () => ({
    getAll: () => [{ name: 'better-auth.session_token', value: 'admin_tok' }],
  })),
}));

jest.mock('next/cache', () => ({
  revalidatePath: jest.fn(),
}));

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: mockGetSession,
    },
  })),
}));

import { GET as treasuryGet } from '@/app/api/admin/payouts/treasury/route';
import { POST as settlementDispatchPost } from '@/app/api/admin/settlement/dispatch/route';
import { updateStellarConfig } from '@/lib/admin/stellar-actions';
import {
  PASSKEY_STEPUP_HEADER,
  issuePasskeyStepUpToken,
} from '@/lib/auth/passkey-step-up';
import type { D1Database as LegacyD1Database } from '@/lib/db';
import { resetDB } from '@/lib/db';
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
  TurnkeySigner,
  type EvmDigestSignature,
  type EvmJsonRpcTransport,
  type StellarBroadcastTransport,
  type StellarEnvelopeSignature,
  type TurnkeySigningTransport,
} from '@/lib/payouts';
import { treasuryHealthService } from '@/lib/payouts/treasury-health-service';

const STELLAR_HOT_PUB = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const STELLAR_RECIPIENT = 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';
const EVM_HOT_ADDR = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const EVM_RECIPIENT = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const LEAK_STELLAR_SECRET = 'SBCVY4S7F3Z6M5A2P7W6X5Q3R2T7Y4Z6M5A2P7W6X5Q3R2T7Y4Z6M5A2';
const LEAK_TURNKEY_KEY = 'tk_live_super_secret_private_key_value_999';
const EVM_TEST_PRIVKEY = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

function applyMigrations(sqlite: Database.Database, filenames: string[]): void {
  const migrationsDir = path.resolve(process.cwd(), 'src/database/migrations');
  for (const filename of filenames) {
    const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
    sqlite.exec(sql);
  }
}

function createSettlementTestDb(): {
  sqlite: Database.Database;
  d1: SqliteD1Adapter;
  legacyD1: LegacyD1Database;
} {
  const sqlite = new Database(':memory:');
  applyMigrations(sqlite, [
    '001_initial_schema_d1.sql',
    '002_auth_tables.sql',
    '003_affiliate_schema.sql',
    '009_tracking_optimization.sql',
    '020_billing_mobile_enhancements.sql',
    '024_kyc_compliance_schema.sql',
    '028_ascendancy_audit_core.sql',
    '031_ascendancy_phase2_ui_and_poller.sql',
  ]);

  const futureExp = new Date(Date.now() + 3_600_000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO profiles (id, email, full_name, role, referral_code, wallet_address, preferred_chain)
       VALUES
         ('admin-1', 'admin@apex-os.io', 'Root Admin', 'admin', 'ADM1', NULL, 'arbitrum'),
         ('trader-1', 'trader@apex-os.io', 'Trader One', 'shopper', 'TRD1', ?, 'arbitrum')`
    )
    .run(EVM_RECIPIENT);

  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at)
       VALUES ('sess-admin-1', 'admin-1', 'admin_tok', ?)`
    )
    .run(futureExp);

  sqlite
    .prepare(
      `INSERT INTO webauthn_challenges (challenge_id, user_id, challenge, purpose, expires_at, consumed)
       VALUES
         ('chg-dust-1', 'admin-1', 'chal_bytes', 'admin_step_up', ?, 1),
         ('chg-floor-1', 'admin-1', 'chal_bytes', 'admin_step_up', ?, 1)`
    )
    .run(futureExp, futureExp);

  const d1 = new SqliteD1Adapter(sqlite);
  const legacyD1 = d1 as unknown as LegacyD1Database;
  resetDB();
  (globalThis as Record<string, unknown>).DB = d1;
  return {
    sqlite,
    d1,
    legacyD1,
  };
}

function createSignedTurnkeyTransport(): TurnkeySigningTransport {
  const privBytes = Buffer.from(EVM_TEST_PRIVKEY.slice(2), 'hex');
  return {
    async signEvmDigest(params): Promise<EvmDigestSignature> {
      const digestBytes = Buffer.from(params.digestHex.slice(2), 'hex');
      const sig = secp256k1.sign(digestBytes, privBytes, { lowS: true });
      return {
        r: `0x${sig.r.toString(16).padStart(64, '0')}` as Hex,
        s: `0x${sig.s.toString(16).padStart(64, '0')}` as Hex,
        yParity: (sig.recovery === 1 ? 1 : 0) as 0 | 1,
        activityId: `tk_evm_${params.payoutId}`,
      };
    },
    async signStellarEnvelope(params): Promise<StellarEnvelopeSignature> {
      const txHash = params.txHashHex.replace(/^0x/, '');
      return {
        signedEnvelopeXdr: `SIGNED_XDR:${params.unsignedEnvelopeXdr}`,
        signatureBase64: Buffer.from(`sig_${params.payoutId}`).toString('base64'),
        txHash,
        activityId: `tk_xlm_${params.payoutId}`,
      };
    },
  };
}

function createMockEvmAdapter(
  chain: 'arbitrum' | 'base',
  options?: {
    receiptOverride?: Record<string, unknown>;
    broadcastError?: Error;
  }
): ArbitrumBaseUsdcAdapter {
  const rpcTransport: EvmJsonRpcTransport = {
    async call<T = unknown>(method: string, params?: unknown[]): Promise<T> {
      if (method === 'eth_call') {
        const callObj = (params?.[0] as { data?: string }) ?? {};
        if (callObj.data?.toLowerCase().startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR.toLowerCase())) {
          return ('0x' + '0'.repeat(64)) as T;
        }
        return ('0x' + '0'.repeat(63) + '1') as T;
      }
      if (method === 'eth_getTransactionCount') {
        return '0x0' as T;
      }
      if (method === 'eth_getBlockByNumber') {
        return { baseFeePerGas: '0x5f5e100' } as T;
      }
      if (method === 'eth_feeHistory') {
        return {
          baseFeePerGas: ['0x3b9aca00'],
          reward: [['0x59682f00']],
        } as T;
      }
      if (method === 'eth_maxPriorityFeePerGas' || method === 'eth_gasPrice') {
        return '0x5f5e100' as T;
      }
      if (method === 'eth_estimateGas') {
        return '0xfde8' as T;
      }
      if (method === 'eth_sendRawTransaction') {
        if (options?.broadcastError) {
          throw options.broadcastError;
        }
        const rawTx = String(params?.[0] ?? '0x00') as Hex;
        return keccak256(rawTx) as T;
      }
      if (method === 'eth_getTransactionReceipt') {
        if (options?.receiptOverride) {
          return options.receiptOverride as T;
        }
        return {
          status: '0x1',
          blockNumber: '0x10',
          gasUsed: '0xc350',
          effectiveGasPrice: '0x3b9aca00',
        } as T;
      }
      throw new Error(`Unexpected RPC method: ${method}`);
    },
  };

  return new ArbitrumBaseUsdcAdapter({
    chain,
    networkMode: 'mainnet',
    hotWalletAddress: EVM_HOT_ADDR,
    primaryRpc: rpcTransport,
    fallbackRpc: rpcTransport,
  });
}

function createMockStellarTransport(options?: {
  submitError?: Error;
  lookupResult?: {
    found: boolean;
    successful: boolean;
    ledger?: number;
    recipient?: string;
    asset?: string;
    assetCode?: string;
    assetIssuer?: string;
    amountUnits?: string | bigint;
    amountStroops?: string | bigint;
  };
}): StellarBroadcastTransport {
  let seq = BigInt(1000);
  return {
    async hasUsdcTrustline() {
      return true;
    },
    async getAccountSequence() {
      seq += BigInt(1);
      return seq.toString();
    },
    async buildUnsignedUsdcPayment(params) {
      const txHashHex = keccak256(
        Buffer.from(`${params.recipientAddress}:${params.stellarSequence}:${params.amountStroops.toString()}`)
      );
      return {
        unsignedEnvelopeXdr: `UNSIGNED_${params.stellarSequence}`,
        txHashHex,
      };
    },
    async submitSignedTransaction(params) {
      if (options?.submitError) {
        throw options.submitError;
      }
      return {
        txHash: params.expectedTxHash,
        confirmed: true,
        ledger: 424242,
      };
    },
    async lookupTransaction() {
      return (
        options?.lookupResult ?? {
          found: true,
          successful: true,
          ledger: 424242,
        }
      );
    },
  };
}

describe('Phase 2 Track A Hardening (G8 Turnkey HSM & G9 Multichain Money Precision)', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    resetDB();
    delete (globalThis as Record<string, unknown>).DB;
    delete (globalThis as Record<string, unknown>).KV;
    delete (globalThis as Record<string, unknown>).SETTLEMENT_MACHINE;
    jest.restoreAllMocks();
  });

  // ==========================================================================
  // Task 1: [P0 G8] GET /api/admin/payouts/treasury legacy guard
  // ==========================================================================
  describe('Task 1: GET /api/admin/payouts/treasury Turnkey/Ascendancy guard', () => {
    it('returns HTTP 410 and never calls TreasuryHealthService when TURNKEY_STELLAR_HOT_WALLET_ADDRESS is set', async () => {
      const sqlite = new Database(':memory:');
      const futureExp = new Date(Date.now() + 3_600_000).toISOString();
      sqlite.exec(`
        CREATE TABLE profiles (id TEXT PRIMARY KEY, email TEXT, role TEXT NOT NULL);
        CREATE TABLE sessions (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, token TEXT NOT NULL, expires_at TEXT NOT NULL);
        INSERT INTO profiles (id, email, role) VALUES ('admin-1', 'admin@apex-os.io', 'admin');
        INSERT INTO sessions (id, user_id, token, expires_at) VALUES ('s1', 'admin-1', 'admin_tok', '${futureExp}');
      `);
      const d1 = new SqliteD1Adapter(sqlite);
      resetDB();
      (globalThis as Record<string, unknown>).DB = d1;
      process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS = STELLAR_HOT_PUB;

      const healthSpy = jest.spyOn(treasuryHealthService, 'checkHealth');

      const req = new NextRequest('http://localhost/api/admin/payouts/treasury', {
        method: 'GET',
        headers: {
          cookie: 'better-auth.session_token=admin_tok',
        },
      });
      const res = await treasuryGet(req);
      const body = (await res.json()) as {
        success: boolean;
        code?: string;
        redirectTo?: string;
      };

      expect(res.status).toBe(410);
      expect(body.success).toBe(false);
      expect(body.code).toBe('LEGACY_TREASURY_ROUTE_DISABLED');
      expect(body.redirectTo).toBe('/api/admin/settings/stellar/health');
      expect(healthSpy).not.toHaveBeenCalled();

      sqlite.close();
    });

    it('returns HTTP 410 and never calls TreasuryHealthService when settlement_broadcasts table is active', async () => {
      const { sqlite, d1 } = createSettlementTestDb();
      (globalThis as Record<string, unknown>).DB = d1;
      delete process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS;

      const healthSpy = jest.spyOn(treasuryHealthService, 'checkHealth');

      const req = new NextRequest('http://localhost/api/admin/payouts/treasury', {
        method: 'GET',
        headers: {
          cookie: 'better-auth.session_token=admin_tok',
        },
      });
      const res = await treasuryGet(req);
      const body = (await res.json()) as {
        success: boolean;
        code?: string;
        redirectTo?: string;
      };

      expect(res.status).toBe(410);
      expect(body.code).toBe('LEGACY_TREASURY_ROUTE_DISABLED');
      expect(body.redirectTo).toBe('/api/admin/settings/stellar/health');
      expect(healthSpy).not.toHaveBeenCalled();

      sqlite.close();
    });
  });

  // ==========================================================================
  // Task 2: [High G9] Residual dust preservation
  // ==========================================================================
  describe('Task 2: Residual dust preservation in dispatch route & BroadcastRecoveryMachine', () => {
    it('preserves Arbitrum 6dp residual dust in settled balance and locks/disburses exact aligned units', async () => {
      const { sqlite, d1, legacyD1 } = createSettlementTestDb();
      process.env.BETTER_AUTH_SECRET = 'test-passkey-secret-32-chars-min!!';

      const r2 = new InMemoryR2Bucket();
      const ledger = new DoubleEntryLedgerService(d1);
      const partnerEv = await storeEvidenceObject(d1, r2, {
        exchange: 'bybit',
        sourceKind: 'rest_poll',
        rawBytes: '{"seed":true}',
        statementPeriodStart: '2026-11-01T00:00:00Z',
        statementPeriodEnd: '2026-11-01T23:59:59Z',
      });
      const walletEv = await storeEvidenceObject(d1, r2, {
        exchange: 'bybit',
        sourceKind: 'wallet_statement',
        rawBytes: '{"wallet":true}',
        statementPeriodStart: '2026-11-01T00:00:00Z',
        statementPeriodEnd: '2026-11-01T23:59:59Z',
      });
      const grossSeed = parseUsdToLedgerUnits('100.00');
      const recon = await reconcilePartnerCashBatch(d1, {
        exchange: 'bybit',
        evidenceId: partnerEv.id,
        walletEvidenceId: walletEv.id,
        uidAllocatedUnits: grossSeed,
        walletCashCollectedUnits: grossSeed,
        r2,
      });
      const batch = await ledger.recordVerifiedCommissionInflight({
        idempotencyKey: 'seed-arb-dust-1',
        exchange: 'bybit',
        traderUid: 'uid-arb-dust-1',
        traderId: 'trader-1',
        l1AffiliateId: null,
        reconciliationId: recon.id,
        evidenceId: partnerEv.id,
        grossCommissionUnits: grossSeed, // 47.5% -> $47.50 trader rebate
        createdAt: '2026-11-01T00:00:00.000Z',
        r2,
      });
      await ledger.releaseMaturedInflightBatch(batch.batch.id, '2026-11-10T00:00:00.000Z');

      const requestedUnits = parseUsdToLedgerUnits('12.34567891'); // 1_234_567_891n -> dust 91n
      const beforeAccount = await ledger.getAccountByOwner('trader', 'trader-1');
      expect(beforeAccount).not.toBeNull();
      const beforeSettledUnits = beforeAccount!.settledBalanceUnits;
      expect(beforeSettledUnits).toBeGreaterThanOrEqual(requestedUnits);

      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });
      const machine = new BroadcastRecoveryMachine({
        db: legacyD1,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: createMockEvmAdapter('arbitrum') },
      });
      (globalThis as Record<string, unknown>).SETTLEMENT_MACHINE = machine;

      try {
        const stepUpToken = issuePasskeyStepUpToken({
          userId: 'admin-1',
          purpose: 'admin_step_up',
          challengeId: 'chg-dust-1',
        });

        const req = new NextRequest('http://localhost/api/admin/settlement/dispatch', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: 'better-auth.session_token=admin_tok',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'dispatch',
            payoutId: 'payout-arb-dust-1',
            idempotencyKey: 'idem-arb-dust-1',
            affiliateId: 'trader-1',
            ownerType: 'trader',
            chain: 'arbitrum',
            recipientAddress: EVM_RECIPIENT,
            amountUsd: '12.34567891',
            usdcReferencePriceUsd: '1.0000',
          }),
        });

        const res = await settlementDispatchPost(req);
        const payload = (await res.json()) as {
          success: boolean;
          disbursableUnits1e8?: string;
          residualDustUnits1e8?: string;
          outcome?: { state: string; residualDustUnits1e8?: string };
        };

        expect(res.status).toBe(200);
        expect(payload.success).toBe(true);
        expect(payload.disbursableUnits1e8).toBe('1234567800');
        expect(payload.residualDustUnits1e8).toBe('91');

        const afterAccount = await ledger.getAccountByOwner('trader', 'trader-1');
        // Exact disbursable amount (1_234_567_800n) moved out; residual 91n dust remained in settled!
        expect(beforeSettledUnits - afterAccount!.settledBalanceUnits).toBe(BigInt(1_234_567_800));
        expect(afterAccount!.inflightBalanceUnits).toBe(BigInt(0));

        const broadcastRow = sqlite
          .prepare(
            `SELECT amount_units_1e8, chain_token_units FROM settlement_broadcasts WHERE payout_id = ?`
          )
          .get('payout-arb-dust-1') as {
          amount_units_1e8: number | string;
          chain_token_units: string;
        };
        expect(String(broadcastRow.amount_units_1e8)).toBe('1234567800');
        expect(broadcastRow.chain_token_units).toBe('12345678');

        const invariants = await verifyLedgerInvariants(d1);
        expect(invariants.valid).toBe(true);
      } finally {
        sqlite.close();
      }
    });

    it('rejects dispatch with HTTP 422 when disbursableUnits1e8 falls below $10.00 floor', async () => {
      const { sqlite, legacyD1 } = createSettlementTestDb();
      process.env.BETTER_AUTH_SECRET = 'test-passkey-secret-32-chars-min!!';

      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });
      const machine = new BroadcastRecoveryMachine({
        db: legacyD1,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: createMockEvmAdapter('arbitrum') },
      });
      (globalThis as Record<string, unknown>).SETTLEMENT_MACHINE = machine;

      const stepUpToken = issuePasskeyStepUpToken({
        userId: 'admin-1',
        purpose: 'admin_step_up',
        challengeId: 'chg-floor-1',
      });

      const req = new NextRequest('http://localhost/api/admin/settlement/dispatch', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: 'better-auth.session_token=admin_tok',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
        },
        body: JSON.stringify({
          action: 'dispatch',
          payoutId: 'payout-below-floor-1',
          idempotencyKey: 'idem-below-floor-1',
          affiliateId: 'trader-1',
          ownerType: 'trader',
          chain: 'arbitrum',
          recipientAddress: EVM_RECIPIENT,
          amountUsd: '9.99999999',
        }),
      });

      const res = await settlementDispatchPost(req);
      const payload = (await res.json()) as { success: boolean; code?: string };

      expect(res.status).toBe(422);
      expect(payload.success).toBe(false);
      expect(payload.code).toBe('BELOW_MIN_WITHDRAWAL_FLOOR');

      sqlite.close();
    });

    it('aligns Stellar 7dp units directly in BroadcastRecoveryMachine and reports residualDustUnits1e8', async () => {
      const { sqlite, legacyD1 } = createSettlementTestDb();
      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });
      const machine = new BroadcastRecoveryMachine({
        db: legacyD1,
        turnkeySigner: signer,
        stellarTransport: createMockStellarTransport(),
      });

      const outcome = await machine.executeSettlement({
        payoutId: 'payout-xlm-dust-1',
        idempotencyKey: 'idem-xlm-dust-1',
        affiliateId: 'trader-1',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT,
        amountUnits1e8: BigInt(1_234_567_895), // 12.34567895 -> 5n dust on 7dp Stellar
        nowUnix: 1_700_000_000,
      });

      expect(outcome.state).toBe('CONFIRMED');
      expect(outcome.residualDustUnits1e8).toBe('5');

      const row = sqlite
        .prepare(
          `SELECT amount_units_1e8, chain_token_units FROM settlement_broadcasts WHERE payout_id = ?`
        )
        .get('payout-xlm-dust-1') as {
        amount_units_1e8: number | string;
        chain_token_units: string;
      };
      expect(String(row.amount_units_1e8)).toBe('1234567890');
      expect(row.chain_token_units).toBe('123456789');

      sqlite.close();
    });
  });

  // ==========================================================================
  // Task 3: [High G8] TurnkeySigner Cold Safe fail-closed
  // ==========================================================================
  describe('Task 3: TurnkeySigner Cold Safe fail-closed in production/staging', () => {
    it('throws explicit configuration error in production when SAFE_COLD_*_ADDRESS env vars are unset', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';
      delete process.env.SAFE_COLD_ARBITRUM_ADDRESS;
      delete process.env.SAFE_COLD_BASE_ADDRESS;
      delete process.env.SAFE_COLD_STELLAR_ADDRESS;

      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });

      expect(() => signer.getSafeColdMultisigAddress('arbitrum')).toThrow(
        /SAFE_COLD_ARBITRUM_ADDRESS/
      );
      expect(() => signer.getSafeColdMultisigAddress('base')).toThrow(
        /SAFE_COLD_BASE_ADDRESS/
      );
      expect(() => signer.getSafeColdMultisigAddress('stellar')).toThrow(
        /SAFE_COLD_STELLAR_ADDRESS/
      );
    });

    it('throws in APP_ENV=staging for unconfigured chains while allowing configured chains', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'development';
      process.env.APP_ENV = 'staging';
      process.env.SAFE_COLD_ARBITRUM_ADDRESS = '0x1111111111111111111111111111111111111111';
      delete process.env.SAFE_COLD_BASE_ADDRESS;

      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });

      expect(signer.getSafeColdMultisigAddress('arbitrum')).toBe(
        '0x1111111111111111111111111111111111111111'
      );
      expect(() => signer.getSafeColdMultisigAddress('base')).toThrow(
        /SAFE_COLD_BASE_ADDRESS/
      );
    });

    it('preserves default cold safe addresses in NODE_ENV=test', () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = 'test';
      delete process.env.APP_ENV;
      delete process.env.SAFE_COLD_ARBITRUM_ADDRESS;
      delete process.env.SAFE_COLD_BASE_ADDRESS;
      delete process.env.SAFE_COLD_STELLAR_ADDRESS;

      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });

      expect(signer.getSafeColdMultisigAddress('arbitrum')).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(signer.getSafeColdMultisigAddress('base')).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(signer.getSafeColdMultisigAddress('stellar')).toMatch(/^G[A-Z2-7]{55}$/);
    });
  });

  // ==========================================================================
  // Task 4: [High G8] Cold-safe transfer verification & error sanitization
  // ==========================================================================
  describe('Task 4: BroadcastRecoveryMachine cold-safe verification & secret redaction', () => {
    it('rejects cold-safe EVM confirmation when receipt recipient, tokenContract, or amountUnits mismatches', async () => {
      const { sqlite, legacyD1 } = createSettlementTestDb();
      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });

      const baseAdapter = createMockEvmAdapter('arbitrum');
      const machine = new BroadcastRecoveryMachine({
        db: legacyD1,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: baseAdapter },
      });

      // $300 > $250 hot wallet cap -> queued to QUEUED_COLD_SAFE
      const queued = await machine.executeSettlement({
        payoutId: 'payout-cold-verify-1',
        idempotencyKey: 'idem-cold-verify-1',
        affiliateId: 'trader-1',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT,
        amountUnits1e8: BigInt(30_000_000_000), // $300 -> 300_000_000 chain units
        nowUnix: 1_700_000_000,
      });
      expect(queued.state).toBe('QUEUED_COLD_SAFE');

      const receiptSpy = jest.spyOn(baseAdapter, 'getTransactionReceipt');

      // Mismatched recipient
      receiptSpy.mockResolvedValueOnce({
        found: true,
        confirmed: true,
        reverted: false,
        transactionHash: '0x' + 'a'.repeat(64),
        recipient: '0x000000000000000000000000000000000000dEaD',
        tokenContract: baseAdapter.usdcContractAddress,
        amountUnits: '300000000',
      } as Awaited<ReturnType<ArbitrumBaseUsdcAdapter['getTransactionReceipt']>>);

      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'payout-cold-verify-1',
          resolution: 'CONFIRMED',
          txHash: '0x' + 'a'.repeat(64),
        })
      ).rejects.toThrow(/recipient/i);

      // Mismatched tokenContract
      receiptSpy.mockResolvedValueOnce({
        found: true,
        confirmed: true,
        reverted: false,
        transactionHash: '0x' + 'b'.repeat(64),
        recipient: EVM_RECIPIENT,
        tokenContract: '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8',
        amountUnits: '300000000',
      } as Awaited<ReturnType<ArbitrumBaseUsdcAdapter['getTransactionReceipt']>>);

      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'payout-cold-verify-1',
          resolution: 'CONFIRMED',
          txHash: '0x' + 'b'.repeat(64),
        })
      ).rejects.toThrow(/asset/i);

      // Mismatched amountUnits
      receiptSpy.mockResolvedValueOnce({
        found: true,
        confirmed: true,
        reverted: false,
        transactionHash: '0x' + 'c'.repeat(64),
        recipient: EVM_RECIPIENT,
        tokenContract: baseAdapter.usdcContractAddress,
        amountUnits: '299000000',
      } as Awaited<ReturnType<ArbitrumBaseUsdcAdapter['getTransactionReceipt']>>);

      await expect(
        machine.resolveColdSafeBroadcast({
          payoutId: 'payout-cold-verify-1',
          resolution: 'CONFIRMED',
          txHash: '0x' + 'c'.repeat(64),
        })
      ).rejects.toThrow(/amount/i);

      // Exact match succeeds
      receiptSpy.mockResolvedValueOnce({
        found: true,
        confirmed: true,
        reverted: false,
        transactionHash: '0x' + 'd'.repeat(64),
        recipient: EVM_RECIPIENT,
        tokenContract: baseAdapter.usdcContractAddress,
        amountUnits: '300000000',
      } as Awaited<ReturnType<ArbitrumBaseUsdcAdapter['getTransactionReceipt']>>);

      const confirmed = await machine.resolveColdSafeBroadcast({
        payoutId: 'payout-cold-verify-1',
        resolution: 'CONFIRMED',
        txHash: '0x' + 'd'.repeat(64),
      });
      expect(confirmed.state).toBe('CONFIRMED');
      expect(confirmed.tx_hash).toBe('0x' + 'd'.repeat(64));

      sqlite.close();
    });

    it('sanitizes Stellar secrets and API credentials from broadcastErr / submitErr before persisting error_reason', async () => {
      const { sqlite, legacyD1 } = createSettlementTestDb();
      const signer = new TurnkeySigner({
        transport: createSignedTurnkeyTransport(),
        evmHotWalletAddress: EVM_HOT_ADDR,
        stellarHotWalletAddress: STELLAR_HOT_PUB,
      });

      const failingEvmAdapter = createMockEvmAdapter('arbitrum', {
        broadcastError: new Error(
          `RPC 504 at https://rpc.example.com?apiKey=secret_rpc_123 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload TURNKEY_API_PRIVATE_KEY=${LEAK_TURNKEY_KEY}`
        ),
      });
      const failingStellarTransport = createMockStellarTransport({
        submitError: new Error(
          `Horizon 504 with STELLAR_SECRET_KEY=${LEAK_STELLAR_SECRET} seed ${LEAK_STELLAR_SECRET}`
        ),
      });

      const machine = new BroadcastRecoveryMachine({
        db: legacyD1,
        turnkeySigner: signer,
        evmAdapters: { arbitrum: failingEvmAdapter },
        stellarTransport: failingStellarTransport,
      });

      const evmOutcome = await machine.executeSettlement({
        payoutId: 'payout-err-sanitize-evm',
        idempotencyKey: 'idem-err-sanitize-evm',
        affiliateId: 'trader-1',
        chain: 'arbitrum',
        recipientAddress: EVM_RECIPIENT,
        amountUnits1e8: BigInt(2_500_000_000),
        nowUnix: 1_700_000_000,
      });
      expect(evmOutcome.state).toBe('BROADCAST_PENDING');
      expect(evmOutcome.reason).not.toContain('secret_rpc_123');
      expect(evmOutcome.reason).not.toContain('eyJhbGciOiJIUzI1NiJ9');
      expect(evmOutcome.reason).not.toContain(LEAK_TURNKEY_KEY);

      const evmRow = sqlite
        .prepare(`SELECT error_reason FROM settlement_broadcasts WHERE payout_id = ?`)
        .get('payout-err-sanitize-evm') as { error_reason: string };
      expect(evmRow.error_reason).not.toContain('secret_rpc_123');
      expect(evmRow.error_reason).not.toContain(LEAK_TURNKEY_KEY);

      const xlmOutcome = await machine.executeSettlement({
        payoutId: 'payout-err-sanitize-xlm',
        idempotencyKey: 'idem-err-sanitize-xlm',
        affiliateId: 'trader-1',
        chain: 'stellar',
        recipientAddress: STELLAR_RECIPIENT,
        amountUnits1e8: BigInt(2_500_000_000),
        nowUnix: 1_700_000_000,
      });
      expect(xlmOutcome.state).toBe('BROADCAST_PENDING');
      expect(xlmOutcome.reason).not.toContain(LEAK_STELLAR_SECRET);

      const xlmRow = sqlite
        .prepare(`SELECT error_reason FROM settlement_broadcasts WHERE payout_id = ?`)
        .get('payout-err-sanitize-xlm') as { error_reason: string };
      expect(xlmRow.error_reason).not.toContain(LEAK_STELLAR_SECRET);

      sqlite.close();
    });
  });

  // ==========================================================================
  // Task 5: [Medium G8] updateStellarConfig SSRF allowlist & error sanitization
  // ==========================================================================
  describe('Task 5: updateStellarConfig Horizon URL allowlist & error sanitization', () => {
    function installMockAdminAndKv(kvOverrides?: { put?: () => Promise<void> }) {
      const sqlite = new Database(':memory:');
      sqlite.exec(`
        CREATE TABLE profiles (id TEXT PRIMARY KEY, role TEXT NOT NULL);
        INSERT INTO profiles (id, role) VALUES ('admin-1', 'admin');
      `);
      (globalThis as Record<string, unknown>).DB = new SqliteD1Adapter(sqlite);

      const store = new Map<string, string>();
      (globalThis as Record<string, unknown>).KV = {
        get: async (key: string) => store.get(key) ?? null,
        put:
          kvOverrides?.put ??
          (async (key: string, value: string) => {
            store.set(key, value);
          }),
        delete: async (key: string) => {
          store.delete(key);
        },
      };

      return { sqlite, store };
    }

    it('accepts canonical Horizon HTTPS URLs and explicitly allowlisted hosts', async () => {
      const { sqlite, store } = installMockAdminAndKv();

      const r1 = await updateStellarConfig({ horizonUrl: 'https://horizon.stellar.org' });
      expect(r1.success).toBe(true);

      const r2 = await updateStellarConfig({ horizonUrl: 'https://horizon-testnet.stellar.org/' });
      expect(r2.success).toBe(true);
      expect(JSON.parse(store.get('stellar_config') ?? '{}').horizonUrl).toBe(
        'https://horizon-testnet.stellar.org'
      );

      process.env.STELLAR_ALLOWED_HORIZON_HOSTS = 'horizon.apex-node.example';
      const r3 = await updateStellarConfig({ horizonUrl: 'https://horizon.apex-node.example' });
      expect(r3.success).toBe(true);

      sqlite.close();
    });

    it('rejects non-HTTPS, localhost, private/link-local IPs, credentials, and non-allowlisted hosts', async () => {
      const { sqlite } = installMockAdminAndKv();

      const blockedUrls = [
        'http://horizon.stellar.org',
        'https://localhost/accounts',
        'https://127.0.0.1:8000',
        'https://169.254.169.254/latest/meta-data',
        'https://10.0.0.5',
        'https://[::1]/',
        'https://user:pass@horizon.stellar.org',
        'https://evil.attacker.example',
      ];

      for (const badUrl of blockedUrls) {
        const res = await updateStellarConfig({ horizonUrl: badUrl });
        expect(res.success).toBe(false);
        expect(res.error).toBeTruthy();
      }

      sqlite.close();
    });

    it('sanitizes raw Stellar secret seeds if KV persistence throws an error', async () => {
      const { sqlite } = installMockAdminAndKv({
        put: async () => {
          throw new Error(
            `KV write failed while storing config with STELLAR_SECRET_KEY=${LEAK_STELLAR_SECRET}`
          );
        },
      });

      const res = await updateStellarConfig({ horizonUrl: 'https://horizon.stellar.org' });
      expect(res.success).toBe(false);
      expect(res.error).toBeDefined();
      expect(res.error).not.toContain(LEAK_STELLAR_SECRET);

      sqlite.close();
    });
  });
});
