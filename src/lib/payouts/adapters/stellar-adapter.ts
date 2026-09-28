/**
 * src/lib/payouts/adapters/stellar-adapter.ts
 *
 * Stellar Payout Chain Adapter
 * Implements PayoutChainAdapter for the Stellar network using StellarService
 */

import {
  StellarService,
  createStellarService,
  isValidStellarAccountId,
  StellarNetwork,
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
  'GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5';

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
    this.network =
      options?.network ??
      ((process.env.STELLAR_NETWORK as StellarNetwork) || StellarNetwork.TESTNET);
    this.xlmPriceUsd = options?.xlmPriceUsd ?? 0.12; // Configurable XLM/USD estimate
    if (options?.stellarService) {
      this.stellarService = options.stellarService;
    }
  }

  /**
   * Lazily resolves or instantiates the underlying StellarService
   */
  private getService(): StellarService {
    if (!this.stellarService) {
      try {
        this.stellarService = createStellarService();
      } catch {
        // Fallback to valid official USDC issuer if unconfigured in environment
        this.stellarService = new StellarService({
          network: this.network,
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
    // G-prefixed base32 string of length 56
    if (!/^G[A-Z2-7]{55}$/.test(address)) {
      return false;
    }
    return isValidStellarAccountId(address);
  }

  /**
   * Estimate fee for Stellar USDC transfer (stroops converted to XLM and USD)
   */
  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    const feeStroops = 300; // Standard operation fee (3x base fee of 100 stroops)
    const nativeFeeAmount = feeStroops / 10_000_000; // 0.00003 XLM
    const feeUsd = Number((nativeFeeAmount * this.xlmPriceUsd).toFixed(6));

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
   * Send USDC payout via Stellar payment operation
   */
  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (!this.validateAddress(params.recipientAddress)) {
      return this.createFailedResult(
        params,
        `Invalid Stellar recipient address: ${params.recipientAddress}`
      );
    }

    try {
      const service = this.getService();
      const result = await service.sendPayout(
        params.recipientAddress,
        params.amount,
        { memo: params.memo }
      );

      const feeStroops = parseInt(result.fee, 10) || 300;
      const gasFeeNative = feeStroops / 10_000_000;
      const gasFeeUsd = Number((gasFeeNative * this.xlmPriceUsd).toFixed(6));

      return {
        success: true,
        payoutId: params.payoutId,
        chain: 'stellar',
        transactionId: result.transactionId,
        fromAddress: result.fromAccount,
        toAddress: result.toAccount,
        amount: params.amount,
        token: 'USDC',
        gasFeeNative,
        gasFeeUsd,
        nativeFeeSymbol: 'XLM',
        status: 'submitted',
        explorerUrl: this.getExplorerUrl(result.transactionId),
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return this.createFailedResult(params, `Stellar payout failed: ${message}`);
    }
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
    const nativeBalanceUsd = Number((nativeBalance * this.xlmPriceUsd).toFixed(2));
    const totalUsdValue = Number((usdcBalance + nativeBalanceUsd).toFixed(2));

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
