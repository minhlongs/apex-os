/**
 * Stellar Payout Service
 * ApexOS Affiliate Cashback System
 *
 * Handles USDC payouts on Stellar network (testnet/mainnet)
 * using @stellar/stellar-sdk v17 (Stellar Protocol 30 "Bell").
 */

import type * as StellarSdkTypes from '@stellar/stellar-sdk';
import Decimal from 'decimal.js';
import { error as logError, warn as logWarn } from '@/lib/logger';
import { track } from '@/lib/analytics-http';

function resolveStellarSdkModule(): typeof StellarSdkTypes {
  try {
    // Bundler / Worker / Jest mock path
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('@stellar/stellar-sdk') as typeof StellarSdkTypes;
  } catch (err) {
    // Jest 29 CJS VM (`jsdom` realm) rejects transitive ESM `uint8array-extras` when unmocked;
    // delegate to Node 26 native CJS->ESM loader in test runtime.
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

const StellarSdk = resolveStellarSdkModule();

/**
 * Stellar USDC precision constants (7 decimals = 10^7 stroops per USDC)
 */
export const STELLAR_USDC_DECIMALS = 7;
export const STELLAR_STROOPS_PER_USDC = BigInt(10000000);
export const STELLAR_TIMEBOUNDS_SECONDS = 180;

/**
 * Canonical Circle Mainnet Stellar USDC Issuer
 */
export const CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER =
  'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';

export const CANONICAL_STELLAR_TESTNET_USDC_ISSUER =
  'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM';

const STROOPS_SCALE_DECIMAL = new Decimal(10).pow(STELLAR_USDC_DECIMALS);

/**
 * Stellar network configuration
 */
export enum StellarNetwork {
  TESTNET = 'testnet',
  MAINNET = 'mainnet',
}

/**
 * Horizon server URLs for each network
 */
const HORIZON_URLS: Record<StellarNetwork, string> = {
  [StellarNetwork.TESTNET]: 'https://horizon-testnet.stellar.org',
  [StellarNetwork.MAINNET]: 'https://horizon.stellar.org',
};

/**
 * Friendbot URL for testnet account funding (testnet only)
 */
const FRIENDBOT_URL = 'https://friendbot.stellar.org';

/**
 * USDC asset configuration
 *
 * USDC Issuer addresses:
 * - Testnet: GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM
 * - Mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN (Canonical Circle Mainnet Issuer)
 */
export const USDC_CONFIG: Record<StellarNetwork, { issuer: string; code: string }> = {
  [StellarNetwork.TESTNET]: {
    issuer: CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
    code: 'USDC',
  },
  [StellarNetwork.MAINNET]: {
    issuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
    code: 'USDC',
  },
};

/**
 * Stellar account information
 */
export interface StellarAccount {
  /** Account ID (public key) */
  accountId: string;
  /** Account sequence number */
  sequence: string;
  /** Account balances */
  balances: StellarBalance[];
  /** Account threshold levels */
  thresholds: {
    low_threshold: number;
    med_threshold: number;
    high_threshold: number;
  };
  /** Whether account exists on network */
  exists: boolean;
}

/**
 * Balance information for an asset
 */
export interface StellarBalance {
  /** Asset code (e.g., 'USDC', 'XLM') */
  asset_code: string;
  /** Asset issuer (for non-native assets) */
  asset_issuer: string | null;
  /** Balance amount as string */
  balance: string;
  /** Whether this is the native asset (XLM) */
  is_native: boolean;
  /** Whether trustline is authorized by issuer (undefined or true means authorized) */
  is_authorized?: boolean;
}

/**
 * Payout transaction result
 */
export interface PayoutResult {
  /** Transaction hash */
  transactionId: string;
  /** Stellar account that sent the payout */
  fromAccount: string;
  /** Recipient account ID */
  toAccount: string;
  /** Asset code */
  asset: string;
  /** Amount sent */
  amount: string;
  /** Network fee paid (in stroops) */
  fee: string;
  /** Transaction envelope in base64 */
  envelope?: string;
  /** Ledger timestamp */
  ledgerTimestamp?: string;
}

/**
 * Batch payout result
 */
export interface BatchPayoutResult {
  /** Job identifier */
  jobId: string;
  /** Total payouts attempted */
  total: number;
  /** Successful payouts */
  successful: number;
  /** Failed payouts */
  failed: number;
  /** Individual results */
  results: (PayoutResult | { error: string; affiliateId: string; amount: number })[];
  /** Total amount sent */
  totalAmount: number;
  /** Total fees paid */
  totalFees: number;
  /** Network used */
  network: StellarNetwork;
}

/**
 * Payout batch job status
 */
export interface PayoutJobStatus {
  jobId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  startedAt: string;
  completedAt?: string;
  progress: {
    processed: number;
    total: number;
  };
  result?: BatchPayoutResult;
  error?: string;
}

/**
 * Stellar service configuration
 */
export interface StellarServiceConfig {
  /** Network: testnet or mainnet */
  network: StellarNetwork;
  /** Secret key for the sending account (legacy local signing only; Turnkey HSM uses senderPublicKey) */
  secretKey?: string;
  /** Read-only Stellar sender public key (e.g. TURNKEY_STELLAR_HOT_WALLET_ADDRESS) for Horizon balance/health checks without private keys */
  senderPublicKey?: string;
  /** USDC issuer address (optional, uses default if not provided) */
  usdcIssuer?: string;
  /** Horizon server URL (optional, uses default for network) */
  horizonUrl?: string;
  /** Minimum balance reserve (XLM) to keep in sending account */
  minReserveXlm: number;
  /** Maximum batch size for batch payouts */
  maxBatchSize: number;
}

/**
 * Database interface for payout operations
 */
export interface PayoutDatabase {
  /** Get pending earnings ready for payout */
  getPendingEarnings(limit?: number, offset?: number): Promise<PendingEarning[]>;
  /** Get total pending amount for an affiliate */
  getPendingEarningsTotal(affiliateId: string): Promise<number>;
  /** Mark earnings as paid */
  markEarningsPaid(earningIds: string[], payoutId: string): Promise<number>;
  /** Create a payout record */
  createPayout(payout: Omit<PayoutRecord, 'id' | 'created_at' | 'updated_at'>): Promise<string>;
  /** Get affiliate wallet address */
  getAffiliateWallet(affiliateId: string): Promise<string | null>;
  /** Get affiliate by ID */
  getAffiliate(affiliateId: string): Promise<AffiliateInfo | null>;
  /** Transaction support */
  transaction<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Pending earning to be paid out
 */
export interface PendingEarning {
  id: string;
  affiliate_id: string;
  amount: number;
  wallet_address: string;
  affiliate_name: string;
  affiliate_email: string;
}

/**
 * Affiliate information for payouts
 */
export interface AffiliateInfo {
  id: string;
  email: string;
  full_name: string | null;
  wallet_address: string | null;
  preferred_chain: string;
}

/**
 * Payout record (matches database schema)
 */
export interface PayoutRecord {
  id: string;
  affiliate_id: string;
  payout_method: 'bank_transfer' | 'crypto' | 'paypal' | 'stripe' | 'momo' | 'sepay' | 'vnpay';
  payout_method_details: Record<string, unknown>;
  amount: number;
  currency: string;
  fee: number;
  net_amount: number;
  status: 'pending' | 'processing' | 'completed' | 'failed' | 'cancelled';
  scheduled_at: string | null;
  paid_at: string | null;
  transaction_id: string | null;
  notes: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

/**
 * Structural shapes for Horizon responses to preserve strict type safety across SDK versions and mocks
 */
interface RawHorizonBalanceLine {
  asset_type: string;
  asset_code?: string;
  asset_issuer?: string;
  balance: string;
  is_authorized?: boolean;
}

interface RawSubmitTransactionResponse {
  id?: string;
  hash?: string;
  fee_charged?: string | number;
  envelope_xdr?: string;
  created_at?: string;
}

export interface HorizonTransactionOperationRecord {
  type: string;
  destination?: string;
  amount?: string;
  asset?: {
    code?: string;
    issuer?: string;
  };
  asset_code?: string;
  asset_issuer?: string;
  asset_type?: string;
}

export interface HorizonTransactionDetails {
  id: string;
  hash?: string;
  successful: boolean;
  fee_charged?: string | number;
  created_at?: string;
  operations?: HorizonTransactionOperationRecord[];
}

interface HorizonTransactionQueryBuilder {
  transaction(txId: string): { call(): Promise<HorizonTransactionDetails> };
  transactionId?(txId: string): { call(): Promise<HorizonTransactionDetails> };
}

interface HorizonServerStatusProbe {
  fetchStatus?: () => Promise<unknown>;
  ledgers?: () => { limit(count: number): { call(): Promise<unknown> } };
}

/**
 * Convert a decimal USDC amount to exact 7-decimal Stellar integer stroops using ROUND_DOWN.
 */
export function toStellarStroops(amount: string | number | Decimal): bigint {
  let dec: Decimal;
  try {
    dec = new Decimal(amount);
  } catch {
    throw new Error(`Invalid Stellar amount: ${String(amount)}`);
  }

  if (!dec.isFinite() || dec.lte(0)) {
    throw new Error(`Invalid Stellar amount: ${String(amount)}`);
  }

  const stroopsDec = dec.mul(STROOPS_SCALE_DECIMAL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  if (stroopsDec.lte(0)) {
    throw new Error(`Invalid Stellar amount: ${String(amount)}`);
  }

  return BigInt(stroopsDec.toFixed(0));
}

/**
 * Convert exact integer stroops (10^-7) to a 7-decimal Stellar amount string.
 */
export function fromStellarStroops(stroops: bigint): string {
  if (stroops < BigInt(0)) {
    throw new Error(`Invalid negative stroops: ${stroops.toString()}`);
  }
  return new Decimal(stroops.toString())
    .div(STROOPS_SCALE_DECIMAL)
    .toFixed(STELLAR_USDC_DECIMALS, Decimal.ROUND_DOWN);
}

/**
 * Format a USDC amount into an exact 7-decimal Stellar payment string using ROUND_DOWN.
 */
export function formatStellarUsdcAmount(amount: string | number | Decimal): string {
  const stroops = toStellarStroops(amount);
  return fromStellarStroops(stroops);
}

/**
 * Convert ledger minor units (10^-8 USD) to Stellar stroops (10^-7 USDC) using floor division.
 */
export function ledgerUnits1e8ToStellarStroops(amountUnits1e8: bigint): bigint {
  if (amountUnits1e8 <= BigInt(0)) {
    throw new Error(`Invalid ledger 1e8 amount: ${amountUnits1e8.toString()}`);
  }
  return amountUnits1e8 / BigInt(10);
}

function parseNonNegativeStroops(balanceStr: string): bigint {
  try {
    const dec = new Decimal(balanceStr);
    if (!dec.isFinite() || dec.lte(0)) {
      return BigInt(0);
    }
    return BigInt(dec.mul(STROOPS_SCALE_DECIMAL).toDecimalPlaces(0, Decimal.ROUND_DOWN).toFixed(0));
  } catch {
    return BigInt(0);
  }
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: Partial<StellarServiceConfig> = {
  network: StellarNetwork.TESTNET,
  minReserveXlm: 1.0,
  maxBatchSize: 100,
};

/**
 * StellarService - Handles all Stellar blockchain operations
 */
export class StellarService {
  private config: Required<StellarServiceConfig>;
  private server: StellarSdkTypes.Horizon.Server;
  private usdcAsset: StellarSdkTypes.Asset;
  private senderKeypair?: StellarSdkTypes.Keypair;
  private senderPublicKey?: string;

  constructor(config: Partial<StellarServiceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config } as Required<StellarServiceConfig>;

    // Validate network
    if (!Object.values(StellarNetwork).includes(this.config.network)) {
      throw new Error(`Invalid network: ${this.config.network}. Use 'testnet' or 'mainnet'`);
    }

    // Initialize Horizon server
    this.server = new StellarSdk.Horizon.Server(
      this.config.horizonUrl || HORIZON_URLS[this.config.network]
    );

    // Initialize USDC asset
    const usdcConfig = this.config.usdcIssuer
      ? { issuer: this.config.usdcIssuer, code: 'USDC' }
      : USDC_CONFIG[this.config.network];

    this.usdcAsset = new StellarSdk.Asset(
      usdcConfig.code,
      usdcConfig.issuer
    );

    // Load sender keypair if secret key provided; otherwise accept read-only Turnkey public key
    if (this.config.secretKey) {
      try {
        this.senderKeypair = StellarSdk.Keypair.fromSecret(this.config.secretKey);
      } catch (error) {
        logError(
          'Failed to parse Stellar secret key:',
          error instanceof Error ? error.name : 'InvalidSecretKey'
        );
        this.senderKeypair = undefined;
      }
    } else if (this.config.senderPublicKey?.trim()) {
      const candidate = this.config.senderPublicKey.trim();
      if (isValidStellarAccountId(candidate)) {
        this.senderPublicKey = candidate;
      } else {
        logError(
          'Invalid Stellar senderPublicKey configured (expected G... Ed25519 StrKey; value redacted)'
        );
      }
    }
  }

  /**
   * Get the configured network
   */
  getNetwork(): StellarNetwork {
    return this.config.network;
  }

  /**
   * Get Stellar network passphrase for Protocol 30 transaction signing
   */
  getNetworkPassphrase(): string {
    if (this.config.network === StellarNetwork.MAINNET) {
      return StellarSdk.Networks?.PUBLIC ?? 'Public Global Stellar Network ; September 2015';
    }
    return StellarSdk.Networks?.TESTNET ?? 'Test SDF Network ; September 2015';
  }

  /**
   * Get the USDC asset configuration
   */
  getUSDCAsset(): StellarSdkTypes.Asset {
    return this.usdcAsset;
  }

  /**
   * Get the sender account ID (from local secret key or read-only Turnkey public key)
   */
  getSenderAccountId(): string | null {
    return this.senderKeypair?.publicKey() || this.senderPublicKey || null;
  }

  /**
   * Check if the sender account is configured
   */
  hasSenderAccount(): boolean {
    return this.senderKeypair !== undefined;
  }

  /**
   * Load account information from the network
   *
   * @param accountId - Stellar account public key
   * @returns Account information or null if not found
   */
  async getAccount(accountId: string): Promise<StellarAccount | null> {
    try {
      const account = await this.server.loadAccount(accountId);
      const rawBalances = account.balances as unknown as RawHorizonBalanceLine[];

      const balances: StellarBalance[] = rawBalances.map((b: RawHorizonBalanceLine) => {
        const isNative = b.asset_type === 'native';
        return {
          asset_code: isNative ? 'XLM' : (b.asset_code ?? ''),
          asset_issuer: isNative ? null : (b.asset_issuer ?? null),
          balance: b.balance,
          is_native: isNative,
          is_authorized: b.is_authorized,
        };
      });

      const rawSequence = (account as unknown as { sequence: string | (() => string) }).sequence;
      const sequenceStr = typeof rawSequence === 'function' ? rawSequence.call(account) : String(rawSequence);

      return {
        accountId: account.accountId(),
        sequence: sequenceStr,
        balances,
        thresholds: {
          low_threshold: account.thresholds.low_threshold,
          med_threshold: account.thresholds.med_threshold,
          high_threshold: account.thresholds.high_threshold,
        },
        exists: true,
      };
    } catch (error: unknown) {
      const err = error as { status?: number; response?: { status?: number } };
      if (err.status === 404 || err.response?.status === 404) {
        return {
          accountId,
          sequence: '0',
          balances: [],
          thresholds: { low_threshold: 0, med_threshold: 0, high_threshold: 0 },
          exists: false,
        };
      }
      throw error;
    }
  }

  /**
   * Verify recipient account exists AND already holds an authorized USDC trustline
   * for the configured Circle USDC issuer.
   *
   * NEVER sponsors or creates trustlines (createAccount / changeTrust) for unknown wallets.
   */
  async hasUsdcTrustline(accountId: string): Promise<boolean> {
    if (!isValidStellarAccountId(accountId)) {
      return false;
    }

    const account = await this.getAccount(accountId);
    if (!account || !account.exists) {
      return false;
    }

    const expectedIssuer = this.usdcAsset.issuer;
    const trustline = account.balances.find(
      (b) => !b.is_native && b.asset_code === 'USDC' && b.asset_issuer === expectedIssuer
    );

    if (!trustline) {
      return false;
    }

    return trustline.is_authorized !== false;
  }

  /**
   * Get USDC balance in exact stroops (10^-7) for an account
   */
  async getUSDCBalanceStroops(accountId: string): Promise<bigint> {
    const account = await this.getAccount(accountId);
    if (!account || !account.exists) return BigInt(0);

    const usdcBalance = account.balances.find(
      (b) => b.asset_code === 'USDC' && b.asset_issuer === this.usdcAsset.issuer
    );

    return usdcBalance ? parseNonNegativeStroops(usdcBalance.balance) : BigInt(0);
  }

  /**
   * Get USDC balance for an account
   *
   * @param accountId - Stellar account public key
   * @returns USDC balance as number, or 0 if no balance
   */
  async getUSDCBalance(accountId: string): Promise<number> {
    const stroops = await this.getUSDCBalanceStroops(accountId);
    return new Decimal(stroops.toString()).div(STROOPS_SCALE_DECIMAL).toNumber();
  }

  /**
   * Get XLM balance in exact stroops (10^-7) for an account
   */
  async getXLMBalanceStroops(accountId: string): Promise<bigint> {
    const account = await this.getAccount(accountId);
    if (!account || !account.exists) return BigInt(0);

    const xlmBalance = account.balances.find((b) => b.is_native);
    return xlmBalance ? parseNonNegativeStroops(xlmBalance.balance) : BigInt(0);
  }

  /**
   * Get XLM balance for an account
   *
   * @param accountId - Stellar account public key
   * @returns XLM balance as number
   */
  async getXLMBalance(accountId: string): Promise<number> {
    const stroops = await this.getXLMBalanceStroops(accountId);
    return new Decimal(stroops.toString()).div(STROOPS_SCALE_DECIMAL).toNumber();
  }

  /**
   * Fund a testnet account using Friendbot (testnet only)
   */
  async fundTestnetAccount(
    accountId: string,
    amountXlm: number = 100
  ): Promise<{ success: boolean; message: string }> {
    if (this.config.network !== StellarNetwork.TESTNET) {
      return {
        success: false,
        message: 'Friendbot is only available on testnet. Please use mainnet with existing funds.',
      };
    }

    try {
      const existing = await this.getAccount(accountId);
      if (existing?.exists) {
        return {
          success: false,
          message: `Account ${accountId} already exists with balance: ${await this.getXLMBalance(accountId)} XLM`,
        };
      }

      const response = await fetch(
        `${FRIENDBOT_URL}?addr=${accountId}&amount=${amountXlm}`
      );

      if (!response.ok) {
        const errorText = await response.text();
        return {
          success: false,
          message: `Friendbot failed: ${response.status} - ${errorText}`,
        };
      }

      const result: unknown = await response.json();

      await new Promise((resolve) => setTimeout(resolve, 2000));

      return {
        success: true,
        message: `Account funded with ${amountXlm} XLM. Result: ${JSON.stringify(result)}`,
      };
    } catch (error) {
      return {
        success: false,
        message: `Friendbot error: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  /**
   * Build a USDC transfer transaction without submitting.
   * Uses exact 7-decimal stroops formatting and explicit 180-second TimeBounds.
   */
  buildUSDCTransfer(
    fromAccount: ConstructorParameters<typeof StellarSdkTypes.TransactionBuilder>[0],
    toAccountId: string,
    amount: string,
    memo?: string
  ): StellarSdkTypes.Transaction {
    const formattedAmount = formatStellarUsdcAmount(amount);

    let builder = new StellarSdk.TransactionBuilder(fromAccount, {
      fee: String(this.calculateFee()),
      networkPassphrase: this.getNetworkPassphrase(),
    });

    builder = builder.addOperation(
      StellarSdk.Operation.payment({
        destination: toAccountId,
        asset: this.usdcAsset,
        amount: formattedAmount,
      })
    );

    if (memo) {
      builder = builder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
    }

    builder = builder.setTimeout(STELLAR_TIMEBOUNDS_SECONDS);

    return builder.build();
  }

  /**
   * Calculate transaction fee (base fee in stroops for simple transaction)
   */
  calculateFee(): number {
    return 100 * 3; // 300 stroops = 0.00003 XLM
  }

  /**
   * Sign and submit a transaction to the network
   */
  async submitTransaction(transaction: StellarSdkTypes.Transaction): Promise<PayoutResult> {
    if (!this.senderKeypair) {
      throw new Error('No secret key configured. Cannot sign transaction.');
    }

    transaction.sign(this.senderKeypair);

    const senderAccountId = this.senderKeypair.publicKey();

    const destinationOp = transaction.operations[0];
    if (!destinationOp || destinationOp.type !== 'payment') {
      throw new Error('Invalid transaction: expected payment operation');
    }

    const paymentOp = destinationOp as StellarSdkTypes.Operation.Payment;
    const destAccountId = paymentOp.destination;
    if (!destAccountId) {
      throw new Error('Invalid transaction: missing destination');
    }

    const amount = paymentOp.amount;
    const asset = paymentOp.asset;

    try {
      const result = (await this.server.submitTransaction(
        transaction
      )) as unknown as RawSubmitTransactionResponse;

      return {
        transactionId: result.id || result.hash || '',
        fromAccount: senderAccountId,
        toAccount: destAccountId,
        asset: asset.getCode(),
        amount,
        fee: String(result.fee_charged ?? this.calculateFee()),
        envelope: result.envelope_xdr,
        ledgerTimestamp: result.created_at,
      };
    } catch (error: unknown) {
      const err = error as { message?: string; status?: number; extras?: Record<string, unknown> };
      throw new Error(
        `Transaction failed: ${err.message || 'Unknown error'} (status: ${err.status || 'unknown'})`
      );
    }
  }

  /**
   * Send a USDC payout to a single recipient using 7-decimal stroops integer math
   */
  async sendPayout(
    toAccountId: string,
    amount: number | string,
    options: { memo?: string } = {}
  ): Promise<PayoutResult> {
    let requiredStroops: bigint;
    try {
      requiredStroops = toStellarStroops(amount);
    } catch {
      throw new Error('Invalid payout amount: must be greater than 0');
    }

    const amountStr = fromStellarStroops(requiredStroops);

    if (!this.senderKeypair) {
      throw new Error('Sender account not configured. Set STELLAR_SECRET_KEY.');
    }

    const senderAccountId = this.senderKeypair.publicKey();
    const usdcBalanceStroops = await this.getUSDCBalanceStroops(senderAccountId);
    const xlmBalanceStroops = await this.getXLMBalanceStroops(senderAccountId);

    if (usdcBalanceStroops < requiredStroops) {
      const availableStr = new Decimal(usdcBalanceStroops.toString())
        .div(STROOPS_SCALE_DECIMAL)
        .toFixed(2, Decimal.ROUND_DOWN);
      throw new Error(
        `Insufficient USDC balance. Available: ${availableStr} USDC, Required: ${amountStr} USDC`
      );
    }

    const feeStroops = BigInt(this.calculateFee());
    const minReserveStroops = parseNonNegativeStroops(String(this.config.minReserveXlm));
    const requiredXlmStroops = feeStroops + minReserveStroops;

    if (xlmBalanceStroops < requiredXlmStroops) {
      const availableXlm = new Decimal(xlmBalanceStroops.toString())
        .div(STROOPS_SCALE_DECIMAL)
        .toFixed(4, Decimal.ROUND_DOWN);
      const requiredXlm = new Decimal(requiredXlmStroops.toString())
        .div(STROOPS_SCALE_DECIMAL)
        .toFixed(4, Decimal.ROUND_DOWN);
      throw new Error(
        `Insufficient XLM for fee. Available: ${availableXlm} XLM, Required: ${requiredXlm} XLM`
      );
    }

    const senderAccount = await this.server.loadAccount(senderAccountId);

    const transaction = this.buildUSDCTransfer(
      senderAccount,
      toAccountId,
      amountStr,
      options.memo
    );

    return this.submitTransaction(transaction);
  }

  /**
   * Get transaction status from the network
   */
  async getTransaction(transactionId: string): Promise<HorizonTransactionDetails | null> {
    try {
      const txBuilder = this.server.transactions() as unknown as HorizonTransactionQueryBuilder;
      if (typeof txBuilder.transaction === 'function') {
        return await txBuilder.transaction(transactionId).call();
      }
      if (typeof txBuilder.transactionId === 'function') {
        return await txBuilder.transactionId(transactionId).call();
      }
      throw new Error('Horizon transaction query builder does not expose transaction lookup');
    } catch (error: unknown) {
      const err = error as { status?: number; response?: { status?: number } };
      if (err.status === 404 || err.response?.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Verify a payout transaction on the network using exact stroops integer comparison
   */
  async verifyPayout(
    transactionId: string,
    expectedAmount?: number,
    expectedRecipient?: string
  ): Promise<{
    verified: boolean;
    details: HorizonTransactionDetails | null;
    reason?: string;
  }> {
    const tx = await this.getTransaction(transactionId);

    if (!tx) {
      return { verified: false, details: null, reason: 'Transaction not found' };
    }

    if (tx.successful !== true) {
      return { verified: false, details: tx, reason: 'Transaction failed' };
    }

    const payment = tx.operations?.find((op) => op.type === 'payment');
    if (!payment) {
      return { verified: false, details: tx, reason: 'No payment operation found' };
    }

    if (expectedRecipient && payment.destination !== expectedRecipient) {
      return {
        verified: false,
        details: tx,
        reason: `Recipient mismatch. Expected: ${expectedRecipient}, Got: ${payment.destination}`,
      };
    }

    if (expectedAmount !== undefined) {
      const expectedStroops = toStellarStroops(expectedAmount);
      const actualStroops = payment.amount ? parseNonNegativeStroops(payment.amount) : BigInt(0);
      if (actualStroops !== expectedStroops) {
        return {
          verified: false,
          details: tx,
          reason: `Amount mismatch. Expected: ${expectedAmount}, Got: ${payment.amount}`,
        };
      }
    }

    const assetCode = payment.asset?.code ?? payment.asset_code;
    const assetIssuer = payment.asset?.issuer ?? payment.asset_issuer;

    if (!assetCode || assetCode !== 'USDC') {
      return {
        verified: false,
        details: tx,
        reason: `Expected USDC asset, got ${assetCode || 'native (XLM)'}`,
      };
    }

    if (assetIssuer !== this.usdcAsset.issuer) {
      return {
        verified: false,
        details: tx,
        reason: `USDC issuer mismatch. Expected: ${this.usdcAsset.issuer}, Got: ${assetIssuer}`,
      };
    }

    return { verified: true, details: tx };
  }

  /**
   * Process batch payouts from pending earnings
   */
  async processBatchPayouts(
    db: PayoutDatabase,
    options: {
      limit?: number;
      dryRun?: boolean;
      memoPrefix?: string;
    } = {}
  ): Promise<BatchPayoutResult> {
    const jobId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const { limit, dryRun, memoPrefix } = {
      limit: this.config.maxBatchSize,
      dryRun: false,
      memoPrefix: 'ApexOS Payout',
      ...options,
    };

    const results: BatchPayoutResult['results'] = [];
    let successful = 0;
    let failed = 0;
    let totalAmountDec = new Decimal(0);
    let totalFeeStroops = BigInt(0);

    try {
      const pendingEarnings = await db.getPendingEarnings(limit);

      if (pendingEarnings.length === 0) {
        return {
          jobId,
          total: 0,
          successful: 0,
          failed: 0,
          results: [],
          totalAmount: 0,
          totalFees: 0,
          network: this.config.network,
        };
      }

      const affiliateGroups = new Map<string, PendingEarning[]>();
      for (const earning of pendingEarnings) {
        const group = affiliateGroups.get(earning.affiliate_id) || [];
        group.push(earning);
        affiliateGroups.set(earning.affiliate_id, group);
      }

      for (const [affiliateId, earnings] of affiliateGroups) {
        const totalEarningDec = earnings.reduce(
          (sum, e) => sum.plus(new Decimal(e.amount)),
          new Decimal(0)
        );
        const totalEarning = totalEarningDec.toNumber();
        const walletAddress = earnings[0].wallet_address;

        let isWalletValid = false;
        if (walletAddress) {
          try {
            StellarSdk.Keypair.fromPublicKey(walletAddress);
            isWalletValid = true;
          } catch {
            isWalletValid = false;
          }
        }

        if (!isWalletValid) {
          results.push({
            error: `Invalid wallet address for affiliate ${affiliateId}: ${walletAddress}`,
            affiliateId,
            amount: totalEarning,
          });
          failed++;
          continue;
        }

        const formattedTotalEarning = formatStellarUsdcAmount(totalEarningDec);

        const payoutId = await db.createPayout({
          affiliate_id: affiliateId,
          payout_method: 'crypto',
          payout_method_details: { network: this.config.network, wallet_address: walletAddress },
          amount: totalEarning,
          currency: 'USDC',
          fee: 0,
          net_amount: totalEarning,
          status: dryRun ? 'completed' : 'processing',
          scheduled_at: new Date().toISOString(),
          paid_at: null,
          transaction_id: null,
          notes: `Batch payout ${jobId} - ${earnings.length} earnings`,
          metadata: { job_id: jobId, earnings_count: earnings.length },
        });

        if (dryRun) {
          results.push({
            transactionId: `DRY_RUN_${payoutId}`,
            fromAccount: this.senderKeypair?.publicKey() || 'unknown',
            toAccount: walletAddress,
            asset: 'USDC',
            amount: formattedTotalEarning,
            fee: '0',
          });
          successful++;
          totalAmountDec = totalAmountDec.plus(totalEarningDec);
          continue;
        }

        try {
          const result = await this.sendPayout(walletAddress, formattedTotalEarning, {
            memo: `${memoPrefix} - ${affiliateId.slice(0, 10)}`,
          });

          track('payout', affiliateId, {
            payout_id: payoutId,
            amount: totalEarning,
            currency: 'USDC',
            wallet_address: walletAddress,
            transaction_id: result.transactionId,
            network: this.config.network,
            earnings_count: earnings.length,
          }).catch(() => {});

          const earningIds = earnings.map((e) => e.id);
          await db.markEarningsPaid(earningIds, payoutId);

          results.push(result);
          successful++;
          totalAmountDec = totalAmountDec.plus(totalEarningDec);
          totalFeeStroops += BigInt(result.fee || '0');
        } catch (error) {
          results.push({
            error: `Payout failed: ${error instanceof Error ? error.message : String(error)}`,
            affiliateId,
            amount: totalEarning,
          });
          failed++;
        }
      }

      return {
        jobId,
        total: pendingEarnings.length,
        successful,
        failed,
        results,
        totalAmount: totalAmountDec.toNumber(),
        totalFees: new Decimal(totalFeeStroops.toString()).div(STROOPS_SCALE_DECIMAL).toNumber(),
        network: this.config.network,
      };
    } catch {
      return {
        jobId,
        total: 0,
        successful,
        failed,
        results,
        totalAmount: totalAmountDec.toNumber(),
        totalFees: 0,
        network: this.config.network,
      };
    }
  }

  /**
   * Get service health status
   */
  async healthCheck(): Promise<{
    healthy: boolean;
    network: StellarNetwork;
    senderAccount: string | null;
    senderBalanceUSDC: number;
    senderBalanceXLM: number;
    horizonConnected: boolean;
    errors: string[];
  }> {
    const errors: string[] = [];

    let senderBalanceUSDC = 0;
    let senderBalanceXLM = 0;
    let horizonConnected = false;

    try {
      const statusProbe = this.server as unknown as HorizonServerStatusProbe;
      if (typeof statusProbe.fetchStatus === 'function') {
        await statusProbe.fetchStatus();
      } else if (typeof statusProbe.ledgers === 'function') {
        await statusProbe.ledgers().limit(1).call();
      }
      horizonConnected = true;
    } catch (error) {
      errors.push(
        `Horizon connection failed: ${error instanceof Error ? error.message : String(error)}`
      );
    }

    const senderAccountId = this.getSenderAccountId();
    if (senderAccountId && horizonConnected) {
      try {
        const account = await this.getAccount(senderAccountId);
        if (account?.exists) {
          senderBalanceUSDC = await this.getUSDCBalance(senderAccountId);
          senderBalanceXLM = await this.getXLMBalance(senderAccountId);
        } else {
          errors.push(`Sender account ${senderAccountId} does not exist on network`);
        }
      } catch (error) {
        errors.push(
          `Failed to load sender account: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    } else if (!senderAccountId) {
      errors.push(
        'No sender account configured (set TURNKEY_STELLAR_HOT_WALLET_ADDRESS for read-only Horizon telemetry & Turnkey HSM signing)'
      );
    }

    return {
      healthy: errors.length === 0 && horizonConnected && senderAccountId !== null,
      network: this.config.network,
      senderAccount: senderAccountId,
      senderBalanceUSDC,
      senderBalanceXLM,
      horizonConnected,
      errors,
    };
  }

  /**
   * Create a mock payout record (for testing)
   */
  static createMockPayoutResult(affiliateId: string, amount: number): PayoutResult {
    return {
      transactionId: `mock_tx_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`,
      fromAccount: 'GDU5SMSLS3TH7XK6G2X5Z6W6WXJ5M4GZ5S6W6WXJ5M4GZ5S6W6WXJ',
      toAccount: `G${affiliateId.slice(0, 55).padEnd(55, '0')}`,
      asset: 'USDC',
      amount: formatStellarUsdcAmount(amount),
      fee: '300',
    };
  }
}

/**
 * Resolve Stellar network from an explicit parameter or process.env.STELLAR_NETWORK.
 * Fails closed in production if STELLAR_NETWORK is unset or invalid.
 */
export function resolveStellarNetwork(
  explicitNetwork?: StellarNetwork | string
): StellarNetwork {
  const raw = explicitNetwork ?? process.env.STELLAR_NETWORK;
  const isProd =
    process.env.NODE_ENV === 'production' ||
    process.env.APP_ENV === 'production';

  if (!raw || raw.trim() === '') {
    if (isProd) {
      throw new Error(
        'STELLAR_NETWORK must be explicitly set in production (refusing implicit testnet fallback)'
      );
    }
    return StellarNetwork.TESTNET;
  }

  const normalized = raw.trim().toLowerCase();
  if (normalized === StellarNetwork.TESTNET) {
    return StellarNetwork.TESTNET;
  }
  if (normalized === StellarNetwork.MAINNET) {
    return StellarNetwork.MAINNET;
  }

  throw new Error(`Invalid STELLAR_NETWORK: ${raw}`);
}

/**
 * Factory function to create a Stellar service from environment variables
 */
export function createStellarService(): StellarService {
  const senderPublicKey = process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS?.trim();
  const secretKey = senderPublicKey ? undefined : process.env.STELLAR_SECRET_KEY;
  const network = resolveStellarNetwork();
  const usdcIssuer = process.env.STELLAR_USDC_ISSUER;
  const horizonUrl = process.env.STELLAR_HORIZON_URL;

  if (!senderPublicKey && !secretKey) {
    logWarn(
      'Neither TURNKEY_STELLAR_HOT_WALLET_ADDRESS nor STELLAR_SECRET_KEY is set. Sender health checks and local signing will be unavailable.'
    );
  }

  return new StellarService({
    network,
    secretKey,
    senderPublicKey,
    usdcIssuer,
    horizonUrl,
  });
}

/**
 * Utility: Validate a Stellar account ID (public key)
 */
export function isValidStellarAccountId(accountId: string): boolean {
  try {
    if (typeof accountId !== 'string' || !/^G[A-Z2-7]{55}$/.test(accountId)) {
      return false;
    }
    const keypair = StellarSdk.Keypair.fromPublicKey(accountId);
    return keypair.publicKey() === accountId;
  } catch {
    return false;
  }
}

/**
 * Utility: Parse amount string or number using exact 7-decimal stroops ROUND_DOWN math
 */
export function parseStellarAmount(amount: string | number): number {
  const stroops = toStellarStroops(amount);
  return new Decimal(stroops.toString()).div(STROOPS_SCALE_DECIMAL).toNumber();
}

/**
 * Redact any Stellar Ed25519 secret seed (`S` followed by uppercase alphanumeric chars)
 * or secret-bearing token from diagnostic strings before returning or logging.
 */
export function sanitizeStellarDiagnosticError(message: string): string {
  return message
    .replace(/\bS[A-Z0-9]{48,64}\b/g, '[REDACTED_STELLAR_SECRET]')
    .replace(/(STELLAR_SECRET_KEY\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}
