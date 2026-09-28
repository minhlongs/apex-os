/**
 * src/lib/payouts/adapters/adapter-interface.ts
 *
 * Pluggable Multi-Chain Payout Adapter Interface & Types
 * Re-exports and refines contracts from types.ts for chain adapters
 */

import type {
  SupportedPayoutChain,
  FeeEstimateParams,
  ChainFeeEstimate,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
  PayoutChainAdapter,
} from '../types';

export type {
  SupportedPayoutChain,
  FeeEstimateParams,
  ChainFeeEstimate,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
  PayoutChainAdapter,
};

/**
 * Abstract Base Class for Payout Chain Adapters
 * Provides shared structure and error wrapping for concrete chain adapters
 */
export abstract class BasePayoutChainAdapter implements PayoutChainAdapter {
  abstract readonly chain: SupportedPayoutChain;

  abstract validateAddress(address: string): boolean;

  abstract estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate>;

  abstract sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult>;

  abstract verifyTransaction(transactionId: string): Promise<TransactionVerificationResult>;

  abstract getTreasuryBalance(): Promise<TreasuryBalanceResult>;

  /**
   * Helper to construct a standard failed PayoutExecutionResult
   */
  protected createFailedResult(
    params: PayoutExecutionParams,
    errorMessage: string,
    gasFeeNative = 0,
    gasFeeUsd = 0,
    nativeFeeSymbol = ''
  ): PayoutExecutionResult {
    return {
      success: false,
      payoutId: params.payoutId,
      chain: this.chain,
      toAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token ?? 'USDC',
      gasFeeNative,
      gasFeeUsd,
      nativeFeeSymbol,
      status: 'failed',
      error: errorMessage,
      timestamp: new Date().toISOString(),
    };
  }
}
