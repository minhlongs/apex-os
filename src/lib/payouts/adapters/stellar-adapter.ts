/**
 * src/lib/payouts/adapters/stellar-adapter.ts
 *
 * Stellar Payout Chain Adapter
 * Implements PayoutChainAdapter for the Stellar network using StellarService
 */

import Decimal from 'decimal.js';
import {
  StellarService,
  createStellarService,
  isValidStellarAccountId,
  StellarNetwork,
  resolveStellarNetwork,
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
  STELLAR_STROOPS_PER_USDC,
  LegacyPayoutPathDisabledError,
} from '../stellar-service';
import type {
  FeeEstimateParams,
  ChainFeeEstimate,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
} from '../types';
import { BasePayoutChainAdapter } from './adapter-interface';

export const STELLAR_OFFICIAL_USDC_ISSUER =
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER;

const STROOPS_PER_XLM_DECIMAL = new Decimal(STELLAR_STROOPS_PER_USDC.toString());

export interface StellarAdapterOptions {
  stellarService?: StellarService;
  xlmPriceUsd?: number;
  network?: StellarNetwork;
}

export class StellarAdapter extends BasePayoutChainAdapter {
  readonly chain = 'stellar' as const;
  private stellarService?: StellarService;
  private xlmPriceUsd: number;
  private network: StellarNetwork;

  constructor(options?: StellarAdapterOptions) {
    super();
    this.network = resolveStellarNetwork(options?.network);
    this.xlmPriceUsd = options?.xlmPriceUsd ?? 0.12;
    if (options?.stellarService) {
      this.stellarService = options.stellarService;
    }
  }

  /**
   * Lazily resolves or instantiates the underlying StellarService
   */
  private getService(): StellarService {
    if (!this.stellarService) {
      const resolvedNetwork = resolveStellarNetwork(this.network);
      try {
        this.stellarService = createStellarService();
      } catch (err) {
        if (
          err instanceof LegacyPayoutPathDisabledError ||
          (err instanceof Error &&
            (/STELLAR_NETWORK/i.test(err.message) ||
              /Invalid Stellar senderPublicKey/i.test(err.message)))
        ) {
          throw err;
        }
        this.stellarService = new StellarService({
          network: resolvedNetwork,
          usdcIssuer: process.env.STELLAR_USDC_ISSUER || STELLAR_OFFICIAL_USDC_ISSUER,
        });
      }
    }
    return this.stellarService;
  }

  /**
   * Validate Stellar public key format (G[A-Z2-7]{55})
   */
  validateAddress(address: string): boolean {
    if (typeof address !== 'string') {
      return false;
    }
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
      return false;
    }
    return isValidStellarAccountId(address);
  }

  /**
   * Verify recipient holds an existing authorized USDC trustline (never sponsors reserves)
   */
  async hasUsdcTrustline(address: string): Promise<boolean> {
    if (!this.validateAddress(address)) {
      return false;
    }
    return this.getService().hasUsdcTrustline(address);
  }

  /**
   * Estimate fee for Stellar USDC transfer (stroops converted to XLM and USD)
   */
  async estimateFee(_params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    const feeStroops = 300;
    const nativeFeeDec = new Decimal(feeStroops).div(STROOPS_PER_XLM_DECIMAL);
    const nativeFeeAmount = nativeFeeDec.toNumber();
    const feeUsd = nativeFeeDec
      .mul(this.xlmPriceUsd)
      .toDecimalPlaces(6, Decimal.ROUND_DOWN)
      .toNumber();

    return {
      chain: 'stellar',
      nativeFeeAmount,
      nativeFeeSymbol: 'XLM',
      feeUsd,
      gasUnitsOrLimit: feeStroops,
      pricePerUnit: `${feeStroops} stroops`,
      isCongested: false,
      estimatedAt: new Date().toISOString(),
    };
  }

  /**
   * Send USDC payout via Stellar payment operation after verifying USDC trustline
   */
  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (!this.validateAddress(params.recipientAddress)) {
      return this.createFailedResult(
        params,
        `Invalid Stellar recipient address: ${params.recipientAddress}`
      );
    }

    const disabledErr = new LegacyPayoutPathDisabledError(
      'StellarAdapter.sendPayout',
      'Use BroadcastRecoveryMachine with DoubleEntryLedgerService withdrawal locks and TurnkeySigner.'
    );
    return this.createFailedResult(params, `Stellar payout failed: ${disabledErr.message}`);
  }

  /**
   * Verify Stellar transaction status via Horizon
   */
  async verifyTransaction(transactionId: string): Promise<TransactionVerificationResult> {
    try {
      const service = this.getService();
      const result = await service.verifyPayout(transactionId);

      if (result.verified) {
        return {
          verified: true,
          status: 'confirmed',
          transactionId,
          feePaidNative: 0.00003,
          feePaidUsd: 0.000004,
          timestamp: new Date().toISOString(),
        };
      }

      if (result.reason === 'Transaction not found') {
        return {
          verified: false,
          status: 'not_found',
          transactionId,
          reason: result.reason,
          timestamp: new Date().toISOString(),
        };
      }

      return {
        verified: false,
        status: 'failed',
        transactionId,
        reason: result.reason ?? 'Verification failed',
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        status: 'failed',
        transactionId,
        reason: message,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Query hot wallet USDC and XLM balance
   */
  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    const service = this.getService();
    const health = await service.healthCheck();
    const hotWallet = health.senderAccount || 'UNCONFIGURED';
    const nativeBalance = health.senderBalanceXLM || 0;
    const usdcBalance = health.senderBalanceUSDC || 0;
    const nativeBalanceUsd = new Decimal(nativeBalance)
      .mul(this.xlmPriceUsd)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN)
      .toNumber();
    const totalUsdValue = new Decimal(usdcBalance)
      .plus(nativeBalanceUsd)
      .toDecimalPlaces(2, Decimal.ROUND_DOWN)
      .toNumber();

    return {
      chain: 'stellar',
      hotWalletAddress: hotWallet,
      nativeBalance,
      nativeSymbol: 'XLM',
      nativeBalanceUsd,
      tokenBalances: {
        USDC: usdcBalance,
      },
      totalUsdValue,
      lastUpdated: new Date().toISOString(),
    };
  }

  private getExplorerUrl(txHash: string): string {
    const isTestnet = this.network === StellarNetwork.TESTNET;
    return isTestnet
      ? `https://stellar.expert/explorer/testnet/tx/${txHash}`
      : `https://stellar.expert/explorer/public/tx/${txHash}`;
  }
}
