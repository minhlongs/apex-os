/**
 * Stellar Payout Service
 * ApexOS Affiliate Cashback System
 *
 * Handles USDC payouts on Stellar network (testnet/mainnet)
 * using stellar-sdk for transaction building and submission.
 */

import * as StellarSdk from 'stellar-sdk';
import { track } from '@/lib/analytics-http';

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
 * - Mainnet: GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3
 *
 * Note: Verify issuer address before production use on mainnet.
 */
export const USDC_CONFIG: Record<StellarNetwork, { issuer: string; code: string }> = {
  [StellarNetwork.TESTNET]: {
    issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM',
    code: 'USDC',
  },
  [StellarNetwork.MAINNET]: {
    issuer: 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3',
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
  /** Network fee paid (in XLM) */
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
  /** Secret key for the sending account (required for sending) */
  secretKey?: string;
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
 * Default configuration
 */
const DEFAULT_CONFIG: Partial<StellarServiceConfig> = {
  network: StellarNetwork.TESTNET,
  minReserveXlm: 1.0,
  maxBatchSize: 100,
};

/**
 * StellarService - Handles all Stellar blockchain operations
 *
 * Features:
 * - Network switching (testnet/mainnet)
 * - Account balance queries
 * - Account creation/funding (testnet friendbot)
 * - USDC transfer transactions
 * - Batch payout processing
 * - Transaction status tracking
 *
 * Usage:
 * ```typescript
 * const service = new StellarService({
 *   network: StellarNetwork.TESTNET,
 *   secretKey: process.env.STELLAR_SECRET_KEY,
 * });
 *
 * // Check balance
 * const balance = await service.getUSDCBalance('G...');
 *
 * // Send payout
 * const result = await service.sendPayout({
 *   to: 'G...',
 *   amount: '10.00',
 *   memo: 'Commission payout',
 * });
 *
 * // Batch payout
 * const batch = await service.processBatchPayouts(pendingEarnings, db);
 * ```
 */
export class StellarService {
  private config: Required<StellarServiceConfig>;
  private server: StellarSdk.Horizon.Server;
  private usdcAsset: StellarSdk.Asset;
  private senderKeypair?: StellarSdk.Keypair;

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

    // Load sender keypair if secret key provided
    if (this.config.secretKey) {
      try {
        this.senderKeypair = StellarSdk.Keypair.fromSecret(this.config.secretKey);
      } catch (error) {
        console.error('Failed to parse Stellar secret key:', error);
        this.senderKeypair = undefined;
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
   * Get the USDC asset configuration
   */
  getUSDCAsset(): StellarSdk.Asset {
    return this.usdcAsset;
  }

  /**
   * Get the sender account ID (from secret key)
   */
  getSenderAccountId(): string | null {
    return this.senderKeypair?.publicKey() || null;
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

      const balances: StellarBalance[] = account.balances.map(b => ({
        asset_code: b.asset_type === 'native' ? 'XLM' : (b as any).asset_code,
        asset_issuer: b.asset_type === 'native' ? null : (b as any).asset_issuer,
        balance: b.balance,
        is_native: b.asset_type === 'native',
      }));

      return {
        accountId: account.accountId(),
        sequence: account.sequence,
        balances,
        thresholds: {
          low_threshold: account.thresholds.low_threshold,
          med_threshold: account.thresholds.med_threshold,
          high_threshold: account.thresholds.high_threshold,
        },
        exists: true,
      };
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err.status === 404) {
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
   * Get USDC balance for an account
   *
   * @param accountId - Stellar account public key
   * @returns USDC balance as number, or 0 if no balance
   */
  async getUSDCBalance(accountId: string): Promise<number> {
    const account = await this.getAccount(accountId);
    if (!account) return 0;

    const usdcBalance = account.balances.find(
      b => b.asset_code === 'USDC' && b.asset_issuer === this.usdcAsset.issuer
    );

    return usdcBalance ? parseFloat(usdcBalance.balance) : 0;
  }

  /**
   * Get XLM balance for an account
   *
   * @param accountId - Stellar account public key
   * @returns XLM balance as number
   */
  async getXLMBalance(accountId: string): Promise<number> {
    const account = await this.getAccount(accountId);
    if (!account) return 0;

    const xlmBalance = account.balances.find(b => b.is_native);
    return xlmBalance ? parseFloat(xlmBalance.balance) : 0;
  }

  /**
   * Fund a testnet account using Friendbot (testnet only)
   *
   * @param accountId - Stellar account public key to fund
   * @param amountXlm - Amount of XLM to fund (default: 100)
   * @returns Result of funding operation
   */
  async fundTestnetAccount(accountId: string, amountXlm: number = 100): Promise<{ success: boolean; message: string }> {
    if (this.config.network !== StellarNetwork.TESTNET) {
      return {
        success: false,
        message: 'Friendbot is only available on testnet. Please use mainnet with existing funds.',
      };
    }

    try {
      // Check if account already exists
      const existing = await this.getAccount(accountId);
      if (existing?.exists) {
        return {
          success: false,
          message: `Account ${accountId} already exists with balance: ${await this.getXLMBalance(accountId)} XLM`,
        };
      }

      // Call friendbot
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

      const result = await response.json();

      // Wait a moment for the account to be created
      await new Promise(resolve => setTimeout(resolve, 2000));

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
   * Build a USDC transfer transaction without submitting
   *
   * @param fromAccount - Sender account (must be loaded with sequence)
   * @param toAccountId - Recipient account public key
   * @param amount - Amount in USDC (as string)
   * @param memo - Optional memo text (max 28 bytes)
   * @returns Transaction envelope ready to sign and submit
   */
  buildUSDCTransfer(
    fromAccount: StellarSdk.Account,
    toAccountId: string,
    amount: string,
    memo?: string
  ): StellarSdk.Transaction {
    let builder = new StellarSdk.TransactionBuilder(fromAccount, {
      fee: String(this.calculateFee()),
      timebounds: { minTime: 0, maxTime: 0 },
    });

    builder = builder.addOperation(
      StellarSdk.Operation.payment({
        destination: toAccountId,
        asset: this.usdcAsset,
        amount,
      })
    );

    if (memo) {
      builder = builder.addMemo(StellarSdk.Memo.text(memo.slice(0, 28)));
    }

    builder = builder.setTimeout(30 * 60); // 30 minute timeout

    return builder.build();
  }

  /**
   * Calculate transaction fee (base fee for simple transaction)
   */
  calculateFee(): number {
    // Base fee: 100 stroops (0.001 XLM) per operation
    // For a simple payment: 1 operation
    return 100 * 3; // 300 stroops = 0.003 XLM
  }

  /**
   * Sign and submit a transaction to the network
   *
   * @param transaction - Transaction to submit
   * @returns Transaction result
   */
  async submitTransaction(transaction: StellarSdk.Transaction): Promise<PayoutResult> {
    if (!this.senderKeypair) {
      throw new Error('No secret key configured. Cannot sign transaction.');
    }

    // Sign the transaction
    transaction.sign(this.senderKeypair);

    // Get sender account ID
    const senderAccountId = this.senderKeypair.publicKey();

    // Get destination
    const destinationOp = transaction.operations[0];
    if (!destinationOp || destinationOp.type !== 'payment') {
      throw new Error('Invalid transaction: expected payment operation');
    }

    const destAccountId = (destinationOp as StellarSdk.Operation.Payment).destination;
    if (!destAccountId) {
      throw new Error('Invalid transaction: missing destination');
    }

    // Extract amount
    const amount = (destinationOp as StellarSdk.Operation.Payment).amount;
    const asset = (destinationOp as StellarSdk.Operation.Payment).asset;

    // Submit to network
    try {
      const result: any = await this.server.submitTransaction(transaction);

      return {
        transactionId: result.id || result.hash,
        fromAccount: senderAccountId,
        toAccount: destAccountId,
        asset: asset.getCode(),
        amount: amount,
        fee: result.fee_charged,
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
   * Send a USDC payout to a single recipient
   *
   * @param toAccountId - Recipient Stellar account public key
   * @param amount - Amount in USDC
   * @param options - Additional options (memo, fee)
   * @returns Transaction result
   */
  async sendPayout(
    toAccountId: string,
    amount: number | string,
    options: { memo?: string } = {}
  ): Promise<PayoutResult> {
  // Validate amount first (before config checks)
  const amountStr = typeof amount === 'number' ? amount.toFixed(7) : amount;
  if (parseFloat(amountStr) <= 0) {
    throw new Error('Invalid payout amount: must be greater than 0');
  }

  if (!this.senderKeypair) {
    throw new Error('Sender account not configured. Set STELLAR_SECRET_KEY.');
  }

    // Check sender balance
    const senderAccountId = this.senderKeypair.publicKey();
    const usdcBalance = await this.getUSDCBalance(senderAccountId);
    const xlmBalance = await this.getXLMBalance(senderAccountId);

    if (usdcBalance < parseFloat(amountStr)) {
      throw new Error(
        `Insufficient USDC balance. Available: ${usdcBalance.toFixed(2)} USDC, Required: ${amountStr} USDC`
      );
    }

    // Check XLM balance for fee
    const feeXlm = this.calculateFee() / 10000000; // Convert stroops to XLM
    if (xlmBalance < feeXlm + this.config.minReserveXlm) {
      throw new Error(
        `Insufficient XLM for fee. Available: ${xlmBalance.toFixed(4)} XLM, Required: ${(feeXlm + this.config.minReserveXlm).toFixed(4)} XLM`
      );
    }

    // Load sender account for sequence
    const senderAccount = await this.server.loadAccount(senderAccountId);

    // Build transaction
    const transaction = this.buildUSDCTransfer(
      senderAccount,
      toAccountId,
      amountStr,
      options.memo
    );

    // Submit
    return this.submitTransaction(transaction);
  }

  /**
   * Get transaction status from the network
   *
   * @param transactionId - Stellar transaction hash
   * @returns Transaction details or null if not found
   */
  async getTransaction(transactionId: string): Promise<any | null> {
    try {
      return await (this.server.transactions() as any).transactionId(transactionId).call();
    } catch (error: unknown) {
      const err = error as { status?: number };
      if (err.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Verify a payout transaction on the network
   *
   * @param transactionId - Transaction hash to verify
   * @param expectedAmount - Expected amount (optional)
   * @param expectedRecipient - Expected recipient (optional)
   * @returns Verification result
   */
  async verifyPayout(
    transactionId: string,
    expectedAmount?: number,
    expectedRecipient?: string
  ): Promise<{
    verified: boolean;
    details: any | null;
    reason?: string;
  }> {
    const tx = await this.getTransaction(transactionId);

    if (!tx) {
      return { verified: false, details: null, reason: 'Transaction not found' };
    }

    // Check status
    if (tx.successful !== true) {
      return { verified: false, details: tx, reason: 'Transaction failed' };
    }

    // Check operations
    const paymentOp = tx.operations?.find((op: any) => op.type === 'payment');
    if (!paymentOp) {
      return { verified: false, details: tx, reason: 'No payment operation found' };
    }

    const payment = paymentOp as any;

    // Verify recipient
    if (expectedRecipient && payment.destination !== expectedRecipient) {
      return {
        verified: false,
        details: tx,
        reason: `Recipient mismatch. Expected: ${expectedRecipient}, Got: ${payment.destination}`,
      };
    }

    // Verify amount
    if (expectedAmount && parseFloat(payment.amount) !== expectedAmount) {
      return {
        verified: false,
        details: tx,
        reason: `Amount mismatch. Expected: ${expectedAmount}, Got: ${payment.amount}`,
      };
    }

    // Verify asset is USDC (not native XLM)
    const asset = payment.asset;
    if (!asset || asset.code !== 'USDC') {
      return {
        verified: false,
        details: tx,
        reason: `Expected USDC asset, got ${asset?.code || 'native (XLM)'}`,
      };
    }

    if (asset.issuer !== this.usdcAsset.issuer) {
      return {
        verified: false,
        details: tx,
        reason: `USDC issuer mismatch. Expected: ${this.usdcAsset.issuer}, Got: ${asset.issuer}`,
      };
    }

    return { verified: true, details: tx };
  }

  /**
   * Process batch payouts from pending earnings
   *
   * This method:
   * 1. Fetches pending earnings from database
   * 2. Groups by affiliate (consolidating multiple earnings)
   * 3. Sends USDC to each affiliate's wallet
   * 4. Creates payout records and marks earnings as paid
   *
   * @param db - Database interface
   * @param options - Batch options
   * @returns Batch payout result
   */
  async processBatchPayouts(
    db: PayoutDatabase,
    options: {
      limit?: number;
      dryRun?: boolean;
      memoPrefix?: string;
    } = {}
  ): Promise<BatchPayoutResult> {
    const jobId = `batch_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const { limit, dryRun, memoPrefix } = {
      limit: this.config.maxBatchSize,
      dryRun: false,
      memoPrefix: 'ApexOS Payout',
      ...options,
    };

    const results: BatchPayoutResult['results'] = [];
    let successful = 0;
    let failed = 0;
    let totalAmount = 0;
    let totalFees = 0;

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

      // Group by affiliate
      const affiliateGroups = new Map<string, PendingEarning[]>();
      for (const earning of pendingEarnings) {
        const group = affiliateGroups.get(earning.affiliate_id) || [];
        group.push(earning);
        affiliateGroups.set(earning.affiliate_id, group);
      }

      // Process each affiliate
      for (const [affiliateId, earnings] of affiliateGroups) {
        const totalEarning = earnings.reduce((sum, e) => sum + e.amount, 0);
        const walletAddress = earnings[0].wallet_address;

        // Validate wallet address (catch invalid keys that throw)
        let isWalletValid = false;
        if (walletAddress) {
          try {
            StellarSdk.Keypair.fromPublicKey(walletAddress);
            isWalletValid = true;
          } catch (e) {
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

        // Create payout record first
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
            amount: totalEarning.toFixed(7),
            fee: '0',
          });
          successful++;
          totalAmount += totalEarning;
          continue;
        }

        try {
          // Send the payout
          const result = await this.sendPayout(walletAddress, totalEarning.toFixed(7), {
            memo: `${memoPrefix} - ${affiliateId.slice(0, 10)}`,
          });

          // Track analytics (fire-and-forget)
          track('payout', affiliateId, {
            payout_id: payoutId,
            amount: totalEarning,
            currency: 'USDC',
            wallet_address: walletAddress,
            transaction_id: result.transactionId,
            network: this.config.network,
            earnings_count: earnings.length,
          }).catch(() => {});

          // Mark earnings as paid
          const earningIds = earnings.map(e => e.id);
          await db.markEarningsPaid(earningIds, payoutId);

          // Update payout record with transaction details
          // Note: In a real implementation, you would update the payout record here
          results.push(result);
          successful++;
          totalAmount += totalEarning;
          totalFees += parseFloat(result.fee) / 10000000; // Convert stroops to XLM
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
        totalAmount,
        totalFees,
        network: this.config.network,
      };
    } catch (error) {
      return {
        jobId,
        total: 0,
        successful,
        failed,
        results,
        totalAmount,
        totalFees: 0,
        network: this.config.network,
      };
    }
  }

  /**
   * Get service health status
   *
   * @returns Health check result
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

    // Test Horizon connection
    try {
      await (this.server as any).fetchStatus();
      horizonConnected = true;
    } catch (error) {
      errors.push(`Horizon connection failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Check sender account if configured
    const senderAccountId = this.senderKeypair?.publicKey() || null;
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
        errors.push(`Failed to load sender account: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (!senderAccountId) {
      errors.push('No sender account configured (missing STELLAR_SECRET_KEY)');
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
   *
   * @param affiliateId - Affiliate ID
   * @param amount - Amount in USDC
   * @returns Mock payout result
   */
  static createMockPayoutResult(
    affiliateId: string,
    amount: number
  ): PayoutResult {
    return {
      transactionId: `mock_tx_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      fromAccount: 'GDU5SMSLS3TH7XK6G2X5Z6W6WXJ5M4GZ5S6W6WXJ5M4GZ5S6W6WXJ',
      toAccount: `G${affiliateId.slice(0, 55).padEnd(55, '0')}`,
      asset: 'USDC',
      amount: amount.toFixed(7),
      fee: '300',
    };
  }
}

/**
 * Factory function to create a Stellar service from environment variables
 *
 * @returns Configured StellarService instance
 * @throws Error if required environment variables are missing
 */
export function createStellarService(): StellarService {
  const secretKey = process.env.STELLAR_SECRET_KEY;
  const network = (process.env.STELLAR_NETWORK as StellarNetwork) || StellarNetwork.TESTNET;
  const usdcIssuer = process.env.STELLAR_USDC_ISSUER;
  const horizonUrl = process.env.STELLAR_HORIZON_URL;

  if (!secretKey) {
    console.warn('STELLAR_SECRET_KEY not set. Payout operations requiring signing will fail.');
  }

  return new StellarService({
    network,
    secretKey,
    usdcIssuer,
    horizonUrl,
  });
}

/**
 * Utility: Validate a Stellar account ID (public key)
 */
export function isValidStellarAccountId(accountId: string): boolean {
  try {
    // Stellar keys are base32 and start with G for mainnet/testnet
    const keypair = StellarSdk.Keypair.fromPublicKey(accountId);
    return keypair.publicKey() === accountId;
  } catch {
    return false;
  }
}

/**
 * Utility: Parse amount string to number, ensuring valid format
 */
export function parseStellarAmount(amount: string | number): number {
  const parsed = typeof amount === 'string' ? parseFloat(amount) : amount;
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(`Invalid Stellar amount: ${amount}`);
  }
  // Stellar supports up to 7 decimal places
  return Math.round(parsed * 10000000) / 10000000;
}
