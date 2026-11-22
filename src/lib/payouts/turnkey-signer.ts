/**
 * src/lib/payouts/turnkey-signer.ts
 *
 * Turnkey HSM Enclave Signer Isolation & Safe{Wallet} 2-of-3 Cold Queue
 *
 * Architectural Guarantees:
 * 1. Worker memory NEVER holds raw `STELLAR_SECRET_KEY` (S...) or raw EVM secp256k1 private keys.
 *    All hot-wallet cryptographic signatures execute inside Turnkey's remote HSM enclave via
 *    `@turnkey/sdk-server` (`Turnkey` / injectable `TurnkeySigningTransport`).
 * 2. Hard Hot-Wallet Policy Caps enforced in BOTH TypeScript and D1 (`settlement_broadcasts`):
 *    - Single payout cap: <= $250.00 USDC (`25_000_000_000` units at 10^-8)
 *    - Rolling 24-hour hot wallet cap: <= $1,500.00 USDC (`150_000_000_000` units at 10^-8)
 * 3. Safe{Wallet} 2-of-3 Cold Queue & Reserve Distribution Invariant:
 *    - >= 80% of total treasury reserves must reside in Safe{Wallet} 2-of-3 cold multisig.
 *    - Any single payout > $250.00 USDC OR pushing rolling 24h hot volume > $1,500.00 USDC is
 *      NEVER signed by the hot wallet and transitions deterministically to `QUEUED_COLD_SAFE`.
 */

import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import Decimal from 'decimal.js';
import { Turnkey } from '@turnkey/sdk-server';
import { keccak256, type Hex } from 'viem';
import type { D1Database } from '../db';
import {
  LEDGER_UNITS_PER_USD,
  type EvmPhase1SettlementChain,
  type Phase1SettlementChain,
} from './adapters/arbitrum-base-usdc-adapter';
import { withPayoutEffect, withPayoutWorkflow, type PayoutEffectKind, type PayoutWorkflow } from './payout-effect-fence';
import { StellarNetwork, resolveStellarNetwork } from './stellar-service';

function resolveStellarSdkForSigner(): typeof StellarSdkTypes {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@stellar/stellar-sdk') as typeof StellarSdkTypes;
  } catch (err) {
    const isEsmSyntaxError =
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: string }).name === 'SyntaxError';
    if (isEsmSyntaxError && typeof process !== 'undefined' && process.versions?.node) {
      const getBuiltin = (
        process as unknown as { getBuiltinModule?: (id: string) => unknown }
      ).getBuiltinModule;
      if (typeof getBuiltin === 'function') {
        const nodeMod = getBuiltin('node:module') as {
          createRequire: (origin: string) => NodeRequire;
        };
        return nodeMod.createRequire(__filename)('@stellar/stellar-sdk') as typeof StellarSdkTypes;
      }
    }
    throw err;
  }
}

// ============================================================================
// Policy Constants (Exact Integer Units at 10^-8 USD)
// ============================================================================

export const HOT_WALLET_SINGLE_TX_CAP_USD = '250.00' as const;
export const HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8 = BigInt('25000000000');

export const HOT_WALLET_ROLLING_24H_CAP_USD = '1500.00' as const;
export const HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8 = BigInt('150000000000');

export const COLD_SAFE_MIN_RESERVE_BPS = 8000; // 80.00%
export const SAFE_MULTISIG_REQUIRED_OWNERS = 3;
export const SAFE_MULTISIG_REQUIRED_THRESHOLD = 2;

/** Exact attempt-bound proof, shared by admission and passive refunds. */
export const VERIFIED_EXPOSURE_RELEASE_SQL = `EXISTS (
  SELECT 1 FROM settlement_verified_exposure_releases proof
  WHERE proof.payout_id = settlement_broadcasts.payout_id
)`;

// Unknown states, lanes, invalid/future times and historical terminal labels stay counted.
const HOT_EXPOSURE_SQL = `(
  (state = 'QUEUED_COLD_SAFE' AND signing_lane = 'COLD')
  OR (${VERIFIED_EXPOSURE_RELEASE_SQL})
  OR (state = 'CONFIRMED' AND (
    typeof(confirmation_observed_at) = 'integer' AND confirmation_observed_at > 0
    AND confirmation_observed_at <= unixepoch('now')
    AND (confirmation_lane = 'COLD'
      OR (confirmation_lane = 'HOT' AND confirmation_observed_at < unixepoch('now') - 86400))))
) IS NOT TRUE`;

// SUM deliberately stays SQLite INTEGER: overflow throws rather than creating headroom.
const HOT_EXPOSURE_TOTAL_SQL = `(SELECT CASE
  WHEN COUNT(*) = 0 THEN 0
  WHEN SUM(CASE WHEN typeof(amount_units_1e8) != 'integer' OR amount_units_1e8 <= 0 THEN 1 ELSE 0 END) > 0
    THEN NULL ELSE SUM(amount_units_1e8) END
  FROM settlement_broadcasts WHERE ${HOT_EXPOSURE_SQL} AND payout_id != ?)`;

const LEDGER_SCALE_DECIMAL = new Decimal(LEDGER_UNITS_PER_USD.toString());

// ============================================================================
// Transport & Policy Types
// ============================================================================

export interface EvmDigestSignature {
  r: Hex;
  s: Hex;
  yParity: 0 | 1;
  activityId: string;
}

export interface StellarEnvelopeSignature {
  signedEnvelopeXdr: string;
  txHash: string;
  signatureBase64: string;
  activityId: string;
}

/**
 * Abstract transport boundary to Turnkey's remote HSM enclave.
 * Implementations never expose or accept raw blockchain signing keys in Worker memory.
 */
export interface TurnkeySigningTransport {
  signEvmDigest(params: {
    chain: EvmPhase1SettlementChain;
    signerAddress: string;
    digestHex: Hex;
    payoutId: string;
  }): Promise<EvmDigestSignature>;

  signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature>;
}

export interface TurnkeyServerSdkCredentials {
  apiBaseUrl?: string;
  apiPublicKey: string;
  apiPrivateKey: string;
  organizationId: string;
}

export interface TurnkeySignerConfig {
  transport?: TurnkeySigningTransport;
  turnkeyCredentials?: TurnkeyServerSdkCredentials;
  /**
   * Optional so Stellar-only V1 deployments (where `V1_STELLAR_ONLY_PAYOUTS === 'true'`
   * and `TURNKEY_EVM_HOT_WALLET_ADDRESS` has not been provisioned) can still construct
   * the signer and settle on Stellar. Any EVM call path fails closed with a descriptive
   * error instead of blocking Stellar payouts on an unconfigured address.
   */
  evmHotWalletAddress?: string;
  stellarHotWalletAddress: string;
  safeColdMultisigAddresses?: Partial<Record<Phase1SettlementChain, string>>;
}

export interface HotWalletPolicyDecision {
  allowedHotSign: boolean;
  targetState: 'SIGNING' | 'QUEUED_COLD_SAFE';
  amountUnits1e8: bigint;
  rolling24hBeforeUnits1e8: bigint;
  rolling24hProjectedUnits1e8: bigint;
  reason?: string;
  violationCode?: 'SINGLE_TX_CAP_EXCEEDED' | 'ROLLING_24H_CAP_EXCEEDED';
}

export interface TreasuryReserveDistributionReport {
  compliant: boolean;
  hotWalletUnits1e8: bigint;
  coldSafeUnits1e8: bigint;
  totalUnits1e8: bigint;
  coldShareBps: number;
  coldSharePercentage: string;
  hotSharePercentage: string;
  requiredColdShareBps: number;
  multisigPolicy: '2-of-3';
  reason?: string;
}

export interface ColdSafeQueueProposal {
  payoutId: string;
  idempotencyKey: string;
  affiliateId: string;
  chain: Phase1SettlementChain;
  recipientAddress: string;
  amountUnits1e8: bigint;
  chainTokenUnits: string;
  chainDecimals: 6 | 7;
  lockBatchId?: string | null;
  reason: string;
  /**
   * Set to `true` only when transitioning a row that THIS caller currently owns in `SIGNING`
   * (e.g., Turnkey HSM policy rejection mid-sign). Defaults to `false` so a cross-isolate
   * cold-queue fallback can never clobber another isolate's active `SIGNING` claim.
   */
  preSubmissionWorkflow?: PayoutWorkflow;
}

export interface ColdSafeQueueResult {
  payoutId: string;
  state: 'QUEUED_COLD_SAFE';
  safeMultisigTxHash: string;
  multisigThreshold: '2-of-3';
  reason: string;
}

export interface ClaimHotWalletSigningSlotParams {
  payoutId: string;
  idempotencyKey: string;
  affiliateId: string;
  chain: Phase1SettlementChain;
  recipientAddress: string;
  amountUnits1e8: bigint;
  chainTokenUnits: string;
  chainDecimals: 6 | 7;
  lockBatchId?: string | null;
}

export type ClaimHotWalletSigningSlotResult =
  | {
      claimed: true;
      signerAddress: string;
    }
  | {
      claimed: false;
      violationCode:
        | 'SINGLE_TX_CAP_EXCEEDED'
        | 'ROLLING_24H_CAP_EXCEEDED'
        | 'CONCURRENT_PAYOUT_ACTIVE'
        | 'WITHDRAWAL_LOCK_NOT_INFLIGHT';
      reason: string;
    };

async function inspectResolvedWithdrawalLock(
  db: D1Database,
  payoutId: string,
  lockBatchId?: string | null
): Promise<{ resolved: boolean; status?: string }> {
  try {
    if (lockBatchId) {
      const boundRow = await db
        .prepare(
          `SELECT status
           FROM ledger_journal_batches
           WHERE id = ? AND journal_type = 'WITHDRAWAL_LOCK'
           LIMIT 1`
        )
        .bind(lockBatchId)
        .first<{ status: string }>();
      if (boundRow) {
        return boundRow.status === 'INFLIGHT'
          ? { resolved: false }
          : { resolved: true, status: boundRow.status };
      }
    }

    const byPayout = await db
      .prepare(
        `SELECT status
         FROM ledger_journal_batches
         WHERE journal_type = 'WITHDRAWAL_LOCK' AND payout_id = ?
         ORDER BY CASE WHEN status = 'INFLIGHT' THEN 0 ELSE 1 END, created_at DESC
         LIMIT 1`
      )
      .bind(payoutId)
      .first<{ status: string }>();
    if (!byPayout || byPayout.status === 'INFLIGHT') {
      return { resolved: false };
    }
    return { resolved: true, status: byPayout.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/no such table/i.test(message)) {
      return { resolved: false };
    }
    throw err;
  }
}

// ============================================================================
// Turnkey Remote HSM SDK Transport (`@turnkey/sdk-server`)
// ============================================================================

interface TurnkeyRawPayloadApiResponse {
  activity?: {
    id?: string;
    result?: {
      signRawPayloadResult?: {
        r?: string;
        s?: string;
        v?: string;
      };
    };
  };
  r?: string;
  s?: string;
  v?: string;
}

function extractTurnkeySignatureComponents(
  response: TurnkeyRawPayloadApiResponse,
  payoutId: string
): { rHex: string; sHex: string; vHex: string; activityId: string } {
  const nested = response.activity?.result?.signRawPayloadResult;
  const rCandidate = (response.r ?? nested?.r ?? '').replace(/^0x/i, '').trim();
  const sCandidate = (response.s ?? nested?.s ?? '').replace(/^0x/i, '').trim();
  const vCandidate = (response.v ?? nested?.v ?? '').replace(/^0x/i, '').trim();

  if (
    !/^[0-9a-fA-F]{1,64}$/.test(rCandidate) ||
    !/^[0-9a-fA-F]{1,64}$/.test(sCandidate) ||
    BigInt(`0x${rCandidate}`) === BigInt(0) ||
    BigInt(`0x${sCandidate}`) === BigInt(0)
  ) {
    throw new Error(
      `Turnkey HSM returned invalid or empty signature components (r/s) for payout ${payoutId}`
    );
  }

  return {
    rHex: rCandidate.padStart(64, '0').toLowerCase(),
    sHex: sCandidate.padStart(64, '0').toLowerCase(),
    vHex: vCandidate,
    activityId: response.activity?.id ?? `tk_act_${payoutId}`,
  };
}

/**
 * Attaches a raw 64-byte Ed25519 signature (`r || s`) as a Stellar `xdr.DecoratedSignature`
 * onto an unsigned Stellar XDR envelope using the 4-byte signature hint of `signerAddress`.
 */
export function attachEd25519SignatureToStellarEnvelopeXdr(params: {
  signerAddress: string;
  unsignedEnvelopeXdr: string;
  sigBytes: Buffer;
  networkPassphrase?: string;
  verifySignature?: boolean;
}): string {
  if (params.sigBytes.length !== 64) {
    throw new Error(
      `Stellar Ed25519 signature must be exactly 64 bytes (received ${params.sigBytes.length})`
    );
  }
  const StellarSdk = resolveStellarSdkForSigner();
  const rawPubKey = StellarSdk.StrKey.decodeEd25519PublicKey(params.signerAddress);
  const signatureHint = Buffer.from(rawPubKey.subarray(rawPubKey.length - 4));
  const decoratedSig = new StellarSdk.xdr.DecoratedSignature({
    hint: signatureHint,
    signature: params.sigBytes,
  });

  const passphrase =
    params.networkPassphrase ??
    (resolveStellarNetwork() === StellarNetwork.MAINNET
      ? StellarSdk.Networks.PUBLIC
      : StellarSdk.Networks.TESTNET);

  const parsedTx = StellarSdk.TransactionBuilder.fromXDR(
    params.unsignedEnvelopeXdr,
    passphrase
  );

  if (params.verifySignature ?? true) {
    const txHashBytes = Buffer.from(parsedTx.hash());
    const signerKeypair = StellarSdk.Keypair.fromPublicKey(params.signerAddress);
    if (!signerKeypair.verify(txHashBytes, params.sigBytes)) {
      throw new Error(
        `Turnkey HSM Ed25519 signature failed verification against Stellar tx hash for signer ${params.signerAddress}`
      );
    }
  }

  parsedTx.signatures.push(decoratedSig);
  return parsedTx.toXDR();
}

/**
 * Production HSM transport backed by `@turnkey/sdk-server` `Turnkey` client.
 * Authenticates via Turnkey API stamper keys; blockchain private keys remain sealed in AWS Nitro Enclaves.
 */
export class TurnkeyServerHsmTransport implements TurnkeySigningTransport {
  private readonly turnkey: Turnkey;

  constructor(credentials: TurnkeyServerSdkCredentials) {
    if (
      credentials.apiPrivateKey.startsWith('S') &&
      credentials.apiPrivateKey.length === 56
    ) {
      throw new Error(
        'Refusing raw Stellar secret seed (S...) in TurnkeyServerHsmTransport; provide Turnkey P-256 stamper API key'
      );
    }

    this.turnkey = new Turnkey({
      apiBaseUrl: credentials.apiBaseUrl ?? 'https://api.turnkey.com',
      apiPublicKey: credentials.apiPublicKey,
      apiPrivateKey: credentials.apiPrivateKey,
      defaultOrganizationId: credentials.organizationId,
    });
  }

  async signEvmDigest(params: {
    chain: EvmPhase1SettlementChain;
    signerAddress: string;
    digestHex: Hex;
    payoutId: string;
  }): Promise<EvmDigestSignature> {
    const apiClient = this.turnkey.apiClient();
    const cleanPayload = params.digestHex.replace(/^0x/, '');

    const response = (await apiClient.signRawPayload({
      signWith: params.signerAddress,
      payload: cleanPayload,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NO_OP',
    })) as unknown as TurnkeyRawPayloadApiResponse;

    const { rHex, sHex, vHex, activityId } = extractTurnkeySignatureComponents(
      response,
      params.payoutId
    );
    if (!/^[0-9a-fA-F]{1,4}$/.test(vHex)) {
      throw new Error(
        `Turnkey HSM returned invalid EVM recovery parameter (v) for payout ${params.payoutId}`
      );
    }
    const vNum = parseInt(vHex, 16);
    const yParity: 0 | 1 = vNum === 27 || vNum === 0 ? 0 : vNum === 28 || vNum === 1 ? 1 : (vNum % 2 === 1 ? 1 : 0);

    return {
      r: `0x${rHex}`,
      s: `0x${sHex}`,
      yParity,
      activityId,
    };
  }

  async signStellarEnvelope(params: {
    signerAddress: string;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    payoutId: string;
  }): Promise<StellarEnvelopeSignature> {
    const apiClient = this.turnkey.apiClient();
    const cleanHash = params.txHashHex.replace(/^0x/, '');

    const response = (await apiClient.signRawPayload({
      signWith: params.signerAddress,
      payload: cleanHash,
      encoding: 'PAYLOAD_ENCODING_HEXADECIMAL',
      hashFunction: 'HASH_FUNCTION_NOT_APPLICABLE',
    })) as unknown as TurnkeyRawPayloadApiResponse;

    const { rHex, sHex, activityId } = extractTurnkeySignatureComponents(
      response,
      params.payoutId
    );
    const sigBytes = Buffer.from(`${rHex}${sHex}`, 'hex');
    const signatureBase64 = sigBytes.toString('base64');
    const signedEnvelopeXdr = attachEd25519SignatureToStellarEnvelopeXdr({
      signerAddress: params.signerAddress,
      unsignedEnvelopeXdr: params.unsignedEnvelopeXdr,
      sigBytes,
    });

    return {
      signedEnvelopeXdr,
      txHash: cleanHash,
      signatureBase64,
      activityId,
    };
  }
}

// ============================================================================
// Reserve Distribution Verification Helper
// ============================================================================

/**
 * Verify that >= 80% of total treasury USDC reserves reside in the Safe{Wallet} 2-of-3 cold multisig.
 */
export function verifyTreasuryReserveDistribution(params: {
  hotWalletUnits1e8: bigint;
  coldSafeUnits1e8: bigint;
}): TreasuryReserveDistributionReport {
  if (params.hotWalletUnits1e8 < BigInt(0) || params.coldSafeUnits1e8 < BigInt(0)) {
    throw new Error('Treasury reserve balances cannot be negative');
  }

  const totalUnits1e8 = params.hotWalletUnits1e8 + params.coldSafeUnits1e8;
  if (totalUnits1e8 === BigInt(0)) {
    return {
      compliant: false,
      hotWalletUnits1e8: BigInt(0),
      coldSafeUnits1e8: BigInt(0),
      totalUnits1e8: BigInt(0),
      coldShareBps: 0,
      coldSharePercentage: '0.00%',
      hotSharePercentage: '0.00%',
      requiredColdShareBps: COLD_SAFE_MIN_RESERVE_BPS,
      multisigPolicy: '2-of-3',
      reason: 'Total treasury reserves are zero; Safe{Wallet} 2-of-3 cold reserve must be funded first',
    };
  }

  const coldShareBpsBig = (params.coldSafeUnits1e8 * BigInt(10000)) / totalUnits1e8;
  const coldShareBps = Number(coldShareBpsBig);
  const compliant =
    params.coldSafeUnits1e8 * BigInt(10000) >=
    totalUnits1e8 * BigInt(COLD_SAFE_MIN_RESERVE_BPS);

  const coldPctDec = new Decimal(params.coldSafeUnits1e8.toString())
    .mul(100)
    .div(new Decimal(totalUnits1e8.toString()));
  const hotPctDec = new Decimal(100).minus(coldPctDec);

  return {
    compliant,
    hotWalletUnits1e8: params.hotWalletUnits1e8,
    coldSafeUnits1e8: params.coldSafeUnits1e8,
    totalUnits1e8,
    coldShareBps,
    coldSharePercentage: `${coldPctDec.toFixed(2, Decimal.ROUND_DOWN)}%`,
    hotSharePercentage: `${hotPctDec.toFixed(2, Decimal.ROUND_UP)}%`,
    requiredColdShareBps: COLD_SAFE_MIN_RESERVE_BPS,
    multisigPolicy: '2-of-3',
    reason: compliant
      ? undefined
      : `Cold Safe{Wallet} 2-of-3 reserve share (${coldPctDec.toFixed(2)}%) is below required 80.00% floor`,
  };
}

// ============================================================================
// Turnkey Isolated Signer & Safe Cold Queue Service
// ============================================================================

const TEST_ONLY_SAFE_COLD_DEFAULTS: Record<Phase1SettlementChain, string> = {
  arbitrum: '0x2222222222222222222222222222222222222222',
  base: '0x3333333333333333333333333333333333333333',
  stellar: 'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
};

const SAFE_COLD_ENV_VAR_NAMES: Record<Phase1SettlementChain, string> = {
  arbitrum: 'SAFE_COLD_ARBITRUM_ADDRESS',
  base: 'SAFE_COLD_BASE_ADDRESS',
  stellar: 'SAFE_COLD_STELLAR_ADDRESS',
};

function isStrictColdSafeRuntime(): boolean {
  const nodeEnv = process.env.NODE_ENV?.trim().toLowerCase();
  const appEnv = process.env.APP_ENV?.trim().toLowerCase();
  const envTier = process.env.ENVIRONMENT?.trim().toLowerCase();
  return (
    nodeEnv === 'production' ||
    appEnv === 'production' ||
    appEnv === 'staging' ||
    envTier === 'production' ||
    envTier === 'staging'
  );
}

export class TurnkeySigner {
  private readonly transport: TurnkeySigningTransport;
  private readonly evmHotWalletAddress: string;
  private readonly stellarHotWalletAddress: string;
  private readonly evmHotWalletConfigured: boolean;
  private readonly safeColdMultisigAddresses: Record<Phase1SettlementChain, string>;
  private readonly safeColdMultisigConfigured: Record<Phase1SettlementChain, boolean>;

  constructor(config: TurnkeySignerConfig) {
    // Reject accidental injection of raw blockchain secrets
    if (
      config.evmHotWalletAddress?.startsWith('0x') &&
      config.evmHotWalletAddress.length === 66
    ) {
      throw new Error(
        'Security violation: 32-byte raw private key passed as evmHotWalletAddress'
      );
    }
    if (
      config.stellarHotWalletAddress.startsWith('S') &&
      config.stellarHotWalletAddress.length === 56
    ) {
      throw new Error(
        'Security violation: raw Stellar secret seed (S...) passed as stellarHotWalletAddress'
      );
    }

    if (config.transport) {
      this.transport = config.transport;
    } else if (config.turnkeyCredentials) {
      this.transport = new TurnkeyServerHsmTransport(config.turnkeyCredentials);
    } else {
      throw new Error(
        'TurnkeySigner requires either an explicit TurnkeySigningTransport or TurnkeyServerSdkCredentials'
      );
    }

    this.evmHotWalletAddress = config.evmHotWalletAddress ?? '';
    this.evmHotWalletConfigured = Boolean(config.evmHotWalletAddress);
    this.stellarHotWalletAddress = config.stellarHotWalletAddress;

    const strictRuntime = isStrictColdSafeRuntime();
    const resolveColdSafe = (
      chain: Phase1SettlementChain
    ): { address: string; configured: boolean } => {
      const explicit = config.safeColdMultisigAddresses?.[chain]?.trim();
      const fromEnv = process.env[SAFE_COLD_ENV_VAR_NAMES[chain]]?.trim();
      const resolved = explicit || fromEnv || '';
      if (resolved) {
        return { address: resolved, configured: true };
      }
      if (strictRuntime) {
        return { address: '', configured: false };
      }
      return { address: TEST_ONLY_SAFE_COLD_DEFAULTS[chain], configured: false };
    };

    const arbCold = resolveColdSafe('arbitrum');
    const baseCold = resolveColdSafe('base');
    const stellarCold = resolveColdSafe('stellar');

    this.safeColdMultisigAddresses = {
      arbitrum: arbCold.address,
      base: baseCold.address,
      stellar: stellarCold.address,
    };
    this.safeColdMultisigConfigured = {
      arbitrum: arbCold.configured,
      base: baseCold.configured,
      stellar: stellarCold.configured,
    };
  }

  /**
   * Cryptographic memory isolation invariant check:
   * Verifies that zero raw Stellar secret seeds (`S[A-Z2-7]{55}`) or raw 32-byte EVM private keys
   * are stored in this signer's object graph.
   */
  hasRawPrivateKeyInMemory(): boolean {
    const valuesToInspect: string[] = [
      this.evmHotWalletAddress,
      this.stellarHotWalletAddress,
      ...Object.values(this.safeColdMultisigAddresses),
    ];

    for (const val of valuesToInspect) {
      if (/^S[A-Z2-7]{55}$/.test(val)) {
        return true;
      }
      if (/^0x[0-9a-fA-F]{64}$/.test(val)) {
        return true;
      }
    }

    const transportRecord = this.transport as unknown as Record<string, unknown>;
    for (const [key, value] of Object.entries(transportRecord)) {
      const lowerKey = key.toLowerCase();
      if (
        (lowerKey.includes('stellarsecret') ||
          lowerKey.includes('rawprivatekey') ||
          lowerKey.includes('ethereumprivatekey')) &&
        Boolean(value)
      ) {
        return true;
      }
    }

    return false;
  }

  getHotWalletAddress(chain: Phase1SettlementChain): string {
    if (chain === 'stellar') {
      return this.stellarHotWalletAddress;
    }
    if (!this.evmHotWalletConfigured) {
      throw new Error(
        `EVM hot wallet is not configured (TURNKEY_EVM_HOT_WALLET_ADDRESS is unset); refusing ${chain} settlement`
      );
    }
    return this.evmHotWalletAddress;
  }

  getSafeColdMultisigAddress(chain: Phase1SettlementChain): string {
    const addr = this.safeColdMultisigAddresses[chain]?.trim();
    if (!addr || (isStrictColdSafeRuntime() && !this.safeColdMultisigConfigured[chain])) {
      throw new Error(
        `Safe{Wallet} 2-of-3 cold multisig address is not configured for ${chain} (${SAFE_COLD_ENV_VAR_NAMES[chain]} is unset); refusing to use a placeholder address in production/staging`
      );
    }
    return addr;
  }

  /** Outstanding obligations never age out; only verified confirmations have a window. */
  async getRolling24hHotVolumeUnits1e8(
    db: D1Database,
    excludePayoutId?: string
  ): Promise<bigint> {
    const row = await db.prepare(`SELECT CAST(SUM(
      CASE WHEN typeof(amount_units_1e8) = 'integer' AND amount_units_1e8 > 0
        THEN amount_units_1e8 ELSE NULL END) AS TEXT) AS total_units,
      COUNT(*) AS exposure_count,
      SUM(CASE WHEN typeof(amount_units_1e8) != 'integer' OR amount_units_1e8 <= 0
        THEN 1 ELSE 0 END) AS invalid_count
      FROM settlement_broadcasts WHERE ${HOT_EXPOSURE_SQL}
      AND (? IS NULL OR payout_id != ?)`)
      .bind(excludePayoutId ?? null, excludePayoutId ?? null)
      .first<{ total_units: unknown; exposure_count: unknown; invalid_count: unknown }>();
    if (!row || !Number.isSafeInteger(row.exposure_count) || Number(row.exposure_count) < 0 ||
        (row.invalid_count !== 0 && !(row.exposure_count === 0 && row.invalid_count === null))) {
      throw new Error('Invalid global hot-wallet exposure accounting');
    }
    if (row.exposure_count === 0 && row.total_units === null) return BigInt(0);
    if (typeof row.total_units !== 'string' || !/^[1-9][0-9]*$/.test(row.total_units)) {
      throw new Error('Invalid exact global hot-wallet exposure total');
    }
    return BigInt(row.total_units);
  }

  /**
   * Evaluate Turnkey hot-wallet hard policy caps:
   * - Single tx <= $250.00 USDC (25_000_000_000 units)
   * - Rolling 24h hot volume <= $1,500.00 USDC (150_000_000_000 units)
   */
  async evaluateHotWalletPolicy(
    db: D1Database,
    amountUnits1e8: bigint,
    excludePayoutId?: string
  ): Promise<HotWalletPolicyDecision> {
    if (amountUnits1e8 <= BigInt(0)) {
      throw new Error(`Invalid settlement amount units: ${amountUnits1e8.toString()}`);
    }

    const rolling24hBefore = await this.getRolling24hHotVolumeUnits1e8(
      db,
      excludePayoutId
    );
    const projected = rolling24hBefore + amountUnits1e8;

    if (amountUnits1e8 > HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8) {
      const amountUsd = new Decimal(amountUnits1e8.toString())
        .div(LEDGER_SCALE_DECIMAL)
        .toFixed(2, Decimal.ROUND_DOWN);
      return {
        allowedHotSign: false,
        targetState: 'QUEUED_COLD_SAFE',
        amountUnits1e8,
        rolling24hBeforeUnits1e8: rolling24hBefore,
        rolling24hProjectedUnits1e8: projected,
        violationCode: 'SINGLE_TX_CAP_EXCEEDED',
        reason: `Single payout $${amountUsd} USDC exceeds Turnkey hot-wallet cap ($${HOT_WALLET_SINGLE_TX_CAP_USD} USDC); routed to Safe{Wallet} 2-of-3 cold multisig`,
      };
    }

    if (projected > HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8) {
      const projectedUsd = new Decimal(projected.toString())
        .div(LEDGER_SCALE_DECIMAL)
        .toFixed(2, Decimal.ROUND_DOWN);
      return {
        allowedHotSign: false,
        targetState: 'QUEUED_COLD_SAFE',
        amountUnits1e8,
        rolling24hBeforeUnits1e8: rolling24hBefore,
        rolling24hProjectedUnits1e8: projected,
        violationCode: 'ROLLING_24H_CAP_EXCEEDED',
        reason: `Projected 24h hot-wallet volume $${projectedUsd} USDC exceeds rolling 24h cap ($${HOT_WALLET_ROLLING_24H_CAP_USD} USDC); routed to Safe{Wallet} 2-of-3 cold multisig`,
      };
    }

    return {
      allowedHotSign: true,
      targetState: 'SIGNING',
      amountUnits1e8,
      rolling24hBeforeUnits1e8: rolling24hBefore,
      rolling24hProjectedUnits1e8: projected,
    };
  }

  /**
   * Atomically claim a hot-wallet `SIGNING` slot in `settlement_broadcasts` BEFORE
   * reserving any EVM nonce / Stellar sequence or calling Turnkey HSM.
   *
   * Eliminates cross-isolate TOCTOU races on the `$1,500.00/24h` (`150_000_000_000` units)
   * rolling hot-wallet cap by folding the `SUM(amount_units_1e8)` guard directly into the
   * conditional `INSERT ... SELECT ... WHERE` / `UPDATE ... WHERE` SQLite/D1 write statement.
   */
  async claimHotWalletSigningSlot(
    db: D1Database,
    params: ClaimHotWalletSigningSlotParams
  ): Promise<ClaimHotWalletSigningSlotResult> {
    if (params.amountUnits1e8 <= BigInt(0)) {
      throw new Error(`Invalid settlement amount units: ${params.amountUnits1e8.toString()}`);
    }

    // Double-spend fence: a payout whose paired `WITHDRAWAL_LOCK` was already finalized
    // (`SETTLED`) or refunded (`VOIDED`) must never be signed again, even when the broadcast
    // row still reads `EXPIRED_RECOVERED` / `FAILED_ABORTED` because a passive reconciler
    // resolved the ledger lock before an interactive re-execution arrived.
    const withdrawalLock = await inspectResolvedWithdrawalLock(
      db,
      params.payoutId,
      params.lockBatchId
    );
    if (withdrawalLock.resolved) {
      return {
        claimed: false,
        violationCode: 'WITHDRAWAL_LOCK_NOT_INFLIGHT',
        reason: `Payout ${params.payoutId} withdrawal lock is already ${withdrawalLock.status}; refusing to sign or re-queue a settlement whose ledger funds were resolved`,
      };
    }

    if (params.amountUnits1e8 > HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8) {
      const amountUsd = new Decimal(params.amountUnits1e8.toString())
        .div(LEDGER_SCALE_DECIMAL)
        .toFixed(2, Decimal.ROUND_DOWN);
      return {
        claimed: false,
        violationCode: 'SINGLE_TX_CAP_EXCEEDED',
        reason: `Single payout $${amountUsd} USDC exceeds Turnkey hot-wallet cap ($${HOT_WALLET_SINGLE_TX_CAP_USD} USDC); routed to Safe{Wallet} 2-of-3 cold multisig`,
      };
    }

    const signerAddress = this.getHotWalletAddress(params.chain);
    const amountUnitsNum = Number(params.amountUnits1e8);
    const capUnitsNum = Number(HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8);

    const tryConditionalUpdate = async (): Promise<boolean> => {
      const updRes = await db
        .prepare(
          `UPDATE settlement_broadcasts
           SET state = 'SIGNING',
               signing_lane = 'HOT', confirmation_lane = NULL, confirmation_observed_at = NULL,
               exposure_release_kind = NULL, exposure_released_at = NULL, exposure_release_attempt_id = NULL,
               signer_address = ?,
               amount_units_1e8 = ?,
               chain_token_units = ?,
               chain_decimals = ?,
               assigned_nonce = NULL,
               stellar_sequence = NULL,
               timebounds_max_unix = NULL,
               tx_hash = NULL,
               signed_raw_tx = NULL,
               rbf_candidate_tx_hash = NULL,
               candidate_tx_hashes = '[]',
               lock_batch_id = COALESCE(settlement_broadcasts.lock_batch_id, ?),
               turnkey_activity_id = NULL,
               error_reason = NULL,
               created_at = datetime('now'),
               updated_at = datetime('now')
           WHERE payout_id = ? AND chain = ? AND recipient_address = ? AND affiliate_id = ?
             AND idempotency_key = ? AND lock_batch_id IS ?
             AND ${VERIFIED_EXPOSURE_RELEASE_SQL}
             AND EXISTS (SELECT 1 FROM ledger_journal_batches l
               WHERE l.id = settlement_broadcasts.lock_batch_id
                 AND l.payout_id = settlement_broadcasts.payout_id
                 AND l.journal_type = 'WITHDRAWAL_LOCK' AND l.status = 'INFLIGHT')
             AND ${HOT_EXPOSURE_TOTAL_SQL} <= ? - ?`
        )
        .bind(
          signerAddress,
          amountUnitsNum,
          params.chainTokenUnits,
          params.chainDecimals,
          params.lockBatchId ?? null,
          params.payoutId,
          params.chain,
          params.recipientAddress,
          params.affiliateId,
          params.idempotencyKey,
          params.lockBatchId ?? null,
          params.payoutId,
          capUnitsNum,
          amountUnitsNum
        )
        .run();

      if (updRes.success !== true || ![0, 1].includes(updRes.meta?.changes)) {
        throw new Error('Hot-wallet claim ownership unconfirmed');
      }
      return updRes.meta.changes === 1;
    };

    const existingRow = await db
      .prepare('SELECT state FROM settlement_broadcasts WHERE payout_id = ?')
      .bind(params.payoutId)
      .first<{ state: string }>();

    let slotClaimed = false;
    if (existingRow) {
      slotClaimed = await tryConditionalUpdate();
    } else {
      try {
        const insRes = await db
          .prepare(
            `INSERT INTO settlement_broadcasts (
               payout_id, idempotency_key, affiliate_id, chain, recipient_address,
               amount_units_1e8, chain_token_units, chain_decimals, state, signing_lane,
               signer_address, assigned_nonce, stellar_sequence, timebounds_max_unix,
               tx_hash, signed_raw_tx, rbf_candidate_tx_hash, candidate_tx_hashes, lock_batch_id,
               turnkey_activity_id, error_reason, created_at, updated_at
             )
             SELECT
               ?, ?, ?, ?, ?,
               ?, ?, ?, 'SIGNING', 'HOT',
               ?, NULL, NULL, NULL,
               NULL, NULL, NULL, '[]', ?,
               NULL, NULL, datetime('now'), datetime('now')
             WHERE ${HOT_EXPOSURE_TOTAL_SQL} <= ? - ?`
          )
          .bind(
            params.payoutId,
            params.idempotencyKey,
            params.affiliateId,
            params.chain,
            params.recipientAddress,
            amountUnitsNum,
            params.chainTokenUnits,
            params.chainDecimals,
            signerAddress,
            params.lockBatchId ?? null,
            params.payoutId,
            capUnitsNum,
            amountUnitsNum
          )
          .run();

        if (insRes.success !== true || ![0, 1].includes(insRes.meta?.changes)) {
          throw new Error('Hot-wallet claim ownership unconfirmed');
        }
        slotClaimed = insRes.meta.changes === 1;
      } catch (insErr: unknown) {
        const msg = insErr instanceof Error ? insErr.message : String(insErr);
        if (/unique|constraint/i.test(msg)) {
          slotClaimed = await tryConditionalUpdate();
        } else {
          throw insErr;
        }
      }
    }

    if (slotClaimed) {
      return {
        claimed: true,
        signerAddress,
      };
    }

    const latestRow = await db
      .prepare('SELECT state FROM settlement_broadcasts WHERE payout_id = ?')
      .bind(params.payoutId)
      .first<{ state: string }>();
    if (latestRow && !(await db.prepare(`SELECT payout_id FROM settlement_broadcasts
      WHERE payout_id = ? AND ${VERIFIED_EXPOSURE_RELEASE_SQL}`).bind(params.payoutId).first())) {
      return {
        claimed: false,
        violationCode: 'CONCURRENT_PAYOUT_ACTIVE',
        reason: `Payout ${params.payoutId} is already active or finalized in state ${latestRow.state}`,
      };
    }

    const policy = await this.evaluateHotWalletPolicy(
      db,
      params.amountUnits1e8,
      params.payoutId
    );
    const projectedForReason =
      policy.rolling24hProjectedUnits1e8 > HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8
        ? policy.rolling24hProjectedUnits1e8
        : HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8 + params.amountUnits1e8;
    const projectedUsd = new Decimal(projectedForReason.toString())
      .div(LEDGER_SCALE_DECIMAL)
      .toFixed(2, Decimal.ROUND_DOWN);

    return {
      claimed: false,
      violationCode: 'ROLLING_24H_CAP_EXCEEDED',
      reason:
        policy.reason ??
        `Projected 24h hot-wallet volume $${projectedUsd} USDC exceeds rolling 24h cap ($${HOT_WALLET_ROLLING_24H_CAP_USD} USDC); routed to Safe{Wallet} 2-of-3 cold multisig`,
    };
  }

  /**
   * Compute deterministic Safe{Wallet} 2-of-3 multisig transaction proposal hash
   * and persist `state = 'QUEUED_COLD_SAFE'` in `settlement_broadcasts` without touching hot keys.
   */
  async enqueueColdSafeMultisig(
    db: D1Database,
    proposal: ColdSafeQueueProposal
  ): Promise<ColdSafeQueueResult> {
    const withdrawalLock = await inspectResolvedWithdrawalLock(
      db,
      proposal.payoutId,
      proposal.lockBatchId
    );
    if (withdrawalLock.resolved) {
      throw new Error(
        `Payout ${proposal.payoutId} withdrawal lock is already ${withdrawalLock.status}; refusing to enqueue Safe{Wallet} cold multisig proposal`
      );
    }

    const safeAddress = this.getSafeColdMultisigAddress(proposal.chain);
    const canonicalPayload = [
      'SAFE_2OF3_PROPOSAL_V1',
      proposal.chain,
      safeAddress,
      proposal.payoutId,
      proposal.idempotencyKey,
      proposal.recipientAddress,
      proposal.chainTokenUnits,
    ].join('|');

    const digestHex = keccak256(
      `0x${Buffer.from(canonicalPayload, 'utf8').toString('hex')}`
    );
    const safeMultisigTxHash = `safe_2of3_${digestHex.slice(2, 50)}`;

    const updatableStatesClause = proposal.preSubmissionWorkflow
      ? `('SIGNING', 'EXPIRED_RECOVERED', 'FAILED_ABORTED', 'QUEUED_COLD_SAFE')`
      : `('EXPIRED_RECOVERED', 'FAILED_ABORTED', 'QUEUED_COLD_SAFE')`;

    const enqueueRes = await db
      .prepare(
        `INSERT INTO settlement_broadcasts (
           payout_id,
           idempotency_key,
           affiliate_id,
           chain,
           recipient_address,
           amount_units_1e8,
           chain_token_units,
           chain_decimals,
           state,
           signer_address,
           lock_batch_id,
           safe_multisig_tx_hash,
           signing_lane,
           error_reason,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED_COLD_SAFE', ?, ?, ?, 'COLD', ?, datetime('now'), datetime('now'))
         ON CONFLICT(payout_id) DO UPDATE SET
           state = 'QUEUED_COLD_SAFE',
           signing_lane = 'COLD',
           signer_address = excluded.signer_address,
           assigned_nonce = NULL,
           stellar_sequence = NULL,
           timebounds_max_unix = NULL,
           lock_batch_id = COALESCE(settlement_broadcasts.lock_batch_id, excluded.lock_batch_id),
           safe_multisig_tx_hash = excluded.safe_multisig_tx_hash,
           error_reason = excluded.error_reason,
           updated_at = datetime('now')
         WHERE settlement_broadcasts.state IN ${updatableStatesClause}
           AND (state = 'QUEUED_COLD_SAFE' AND signing_lane = 'COLD'
             OR ${VERIFIED_EXPOSURE_RELEASE_SQL}
             OR (state = 'SIGNING' AND signing_lane = 'HOT'
               AND EXISTS (SELECT 1 FROM payout_effect_attempts a WHERE a.payout_id = settlement_broadcasts.payout_id
                 AND a.attempt_id = ? AND a.active = 1 AND a.owner_id = settlement_broadcasts.affiliate_id
                 AND a.lock_batch_id IS settlement_broadcasts.lock_batch_id
                 AND NOT EXISTS (SELECT 1 FROM payout_effect_grants g WHERE g.attempt_id = a.attempt_id))))`
      )
      .bind(
        proposal.payoutId,
        proposal.idempotencyKey,
        proposal.affiliateId,
        proposal.chain,
        proposal.recipientAddress,
        Number(proposal.amountUnits1e8),
        proposal.chainTokenUnits,
        proposal.chainDecimals,
        safeAddress,
        proposal.lockBatchId ?? null,
        safeMultisigTxHash,
        proposal.reason,
        proposal.preSubmissionWorkflow?.attemptId ?? null
      )
      .run();

    if (!enqueueRes.success || Number(enqueueRes.meta?.changes ?? 0) !== 1) {
      throw new Error(
        `Cold Safe enqueue rejected for payout ${proposal.payoutId}: existing broadcast state retains unresolved hot exposure`
      );
    }

    return {
      payoutId: proposal.payoutId,
      state: 'QUEUED_COLD_SAFE',
      safeMultisigTxHash,
      multisigThreshold: '2-of-3',
      reason: proposal.reason,
    };
  }

  /**
   * Sign an EVM EIP-1559 transaction digest via Turnkey HSM after re-asserting hard single-tx cap.
   */
  async signEvmDigestEnforced(params: {
    db: D1Database;
    payoutId: string;
    chain: EvmPhase1SettlementChain;
    amountUnits1e8: bigint;
    digestHex: Hex;
    assignedNonce?: number;
    effect?: Extract<PayoutEffectKind, 'TURNKEY_SIGN' | 'EVM_RBF_SIGN'>;
    workflow?: PayoutWorkflow;
  }): Promise<EvmDigestSignature> {
    if (!params.workflow) {
      return withPayoutWorkflow(params.db, params.payoutId, (workflow) =>
        this.signEvmDigestEnforced({ ...params, workflow }));
    }
    if (params.amountUnits1e8 > HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8) {
      throw new Error(
        `Turnkey policy hard-block: refusing to hot-sign EVM payout ${params.payoutId} exceeding $${HOT_WALLET_SINGLE_TX_CAP_USD} USDC`
      );
    }

    const rolling = await this.getRolling24hHotVolumeUnits1e8(
      params.db,
      params.payoutId
    );
    if (rolling + params.amountUnits1e8 > HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8) {
      throw new Error(
        `Turnkey policy hard-block: refusing to hot-sign EVM payout ${params.payoutId} exceeding $${HOT_WALLET_ROLLING_24H_CAP_USD}/24h cap`
      );
    }

    return withPayoutEffect({
      workflow: params.workflow,
      db: params.db,
      payoutId: params.payoutId,
      effect: params.effect ?? 'TURNKEY_SIGN',
      payload: params.digestHex,
      chain: params.chain, signerAddress: this.evmHotWalletAddress,
      assignedNonce: params.assignedNonce, amountUnits1e8: params.amountUnits1e8,
    }, () => this.transport.signEvmDigest({
      chain: params.chain,
      signerAddress: this.evmHotWalletAddress,
      digestHex: params.digestHex,
      payoutId: params.payoutId,
    }));
  }

  /**
   * Sign a Stellar transaction envelope via Turnkey HSM after re-asserting hard single-tx & 24h caps.
   */
  async signStellarEnvelopeEnforced(params: {
    db: D1Database;
    payoutId: string;
    amountUnits1e8: bigint;
    unsignedEnvelopeXdr: string;
    txHashHex: string;
    stellarSequence?: string;
    effect?: 'STELLAR_SIGN';
    workflow?: PayoutWorkflow;
  }): Promise<StellarEnvelopeSignature> {
    if (!params.workflow) {
      return withPayoutWorkflow(params.db, params.payoutId, (workflow) =>
        this.signStellarEnvelopeEnforced({ ...params, workflow }));
    }
    if (params.amountUnits1e8 > HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8) {
      throw new Error(
        `Turnkey policy hard-block: refusing to hot-sign Stellar payout ${params.payoutId} exceeding $${HOT_WALLET_SINGLE_TX_CAP_USD} USDC`
      );
    }

    const rolling = await this.getRolling24hHotVolumeUnits1e8(
      params.db,
      params.payoutId
    );
    if (rolling + params.amountUnits1e8 > HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8) {
      throw new Error(
        `Turnkey policy hard-block: refusing to hot-sign Stellar payout ${params.payoutId} exceeding $${HOT_WALLET_ROLLING_24H_CAP_USD}/24h cap`
      );
    }

    return withPayoutEffect({
      workflow: params.workflow,
      db: params.db,
      payoutId: params.payoutId,
      effect: params.effect ?? 'STELLAR_SIGN',
      payload: params.unsignedEnvelopeXdr,
      chain: 'stellar', signerAddress: this.stellarHotWalletAddress,
      stellarSequence: params.stellarSequence, amountUnits1e8: params.amountUnits1e8,
    }, () => this.transport.signStellarEnvelope({
      signerAddress: this.stellarHotWalletAddress,
      unsignedEnvelopeXdr: params.unsignedEnvelopeXdr,
      txHashHex: params.txHashHex,
      payoutId: params.payoutId,
    }));
  }
}
