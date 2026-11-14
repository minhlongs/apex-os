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
  evmHotWalletAddress: string;
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
}

export interface ColdSafeQueueResult {
  payoutId: string;
  state: 'QUEUED_COLD_SAFE';
  safeMultisigTxHash: string;
  multisigThreshold: '2-of-3';
  reason: string;
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

export class TurnkeySigner {
  private readonly transport: TurnkeySigningTransport;
  private readonly evmHotWalletAddress: string;
  private readonly stellarHotWalletAddress: string;
  private readonly safeColdMultisigAddresses: Record<Phase1SettlementChain, string>;

  constructor(config: TurnkeySignerConfig) {
    // Reject accidental injection of raw blockchain secrets
    if (
      config.evmHotWalletAddress.startsWith('0x') &&
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

    this.evmHotWalletAddress = config.evmHotWalletAddress;
    this.stellarHotWalletAddress = config.stellarHotWalletAddress;
    this.safeColdMultisigAddresses = {
      arbitrum:
        config.safeColdMultisigAddresses?.arbitrum ??
        '0x2222222222222222222222222222222222222222',
      base:
        config.safeColdMultisigAddresses?.base ??
        '0x3333333333333333333333333333333333333333',
      stellar:
        config.safeColdMultisigAddresses?.stellar ??
        'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5',
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
    return chain === 'stellar'
      ? this.stellarHotWalletAddress
      : this.evmHotWalletAddress;
  }

  getSafeColdMultisigAddress(chain: Phase1SettlementChain): string {
    return this.safeColdMultisigAddresses[chain];
  }

  /**
   * Query D1 `settlement_broadcasts` for the rolling 24-hour hot-wallet volume in 10^-8 units.
   * Counts all hot-wallet committed/in-flight states (`SIGNING`, `BROADCAST_PENDING`, `CONFIRMED`)
   * created in the past 24 hours so concurrent payouts cannot race past $1,500.00/24h.
   */
  async getRolling24hHotVolumeUnits1e8(
    db: D1Database,
    excludePayoutId?: string
  ): Promise<bigint> {
    const query = excludePayoutId
      ? `SELECT COALESCE(SUM(amount_units_1e8), 0) AS total_units
         FROM settlement_broadcasts
         WHERE state IN ('SIGNING', 'BROADCAST_PENDING', 'CONFIRMED')
           AND created_at >= datetime('now', '-24 hours')
           AND payout_id != ?`
      : `SELECT COALESCE(SUM(amount_units_1e8), 0) AS total_units
         FROM settlement_broadcasts
         WHERE state IN ('SIGNING', 'BROADCAST_PENDING', 'CONFIRMED')
           AND created_at >= datetime('now', '-24 hours')`;

    const stmt = excludePayoutId
      ? db.prepare(query).bind(excludePayoutId)
      : db.prepare(query);

    const row = await stmt.first<{ total_units: number | string | null }>();
    const raw = row?.total_units ?? 0;
    return BigInt(String(Math.trunc(Number(raw))));
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
   * Compute deterministic Safe{Wallet} 2-of-3 multisig transaction proposal hash
   * and persist `state = 'QUEUED_COLD_SAFE'` in `settlement_broadcasts` without touching hot keys.
   */
  async enqueueColdSafeMultisig(
    db: D1Database,
    proposal: ColdSafeQueueProposal
  ): Promise<ColdSafeQueueResult> {
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

    await db
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
           error_reason,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'QUEUED_COLD_SAFE', ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(payout_id) DO UPDATE SET
           state = 'QUEUED_COLD_SAFE',
           signer_address = excluded.signer_address,
           assigned_nonce = NULL,
           stellar_sequence = NULL,
           timebounds_max_unix = NULL,
           lock_batch_id = COALESCE(settlement_broadcasts.lock_batch_id, excluded.lock_batch_id),
           safe_multisig_tx_hash = excluded.safe_multisig_tx_hash,
           error_reason = excluded.error_reason,
           updated_at = datetime('now')`
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
        proposal.reason
      )
      .run();

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
  }): Promise<EvmDigestSignature> {
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

    return this.transport.signEvmDigest({
      chain: params.chain,
      signerAddress: this.evmHotWalletAddress,
      digestHex: params.digestHex,
      payoutId: params.payoutId,
    });
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
  }): Promise<StellarEnvelopeSignature> {
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

    return this.transport.signStellarEnvelope({
      signerAddress: this.stellarHotWalletAddress,
      unsignedEnvelopeXdr: params.unsignedEnvelopeXdr,
      txHashHex: params.txHashHex,
      payoutId: params.payoutId,
    });
  }
}
