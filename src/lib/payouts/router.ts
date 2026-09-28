/**
 * src/lib/payouts/router.ts
 *
 * Multi-Chain Payout Router
 * Resolves user preferred chains, validates addresses, estimates network fees,
 * and routes payout dispatches to the appropriate chain adapter.
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
} from './types';
import { SUPPORTED_PAYOUT_CHAINS } from './types';
import { StellarAdapter } from './adapters/stellar-adapter';
import { EthereumAdapter } from './adapters/ethereum-adapter';
import { SolanaAdapter } from './adapters/solana-adapter';

export interface UserPayoutProfile {
  preferred_chain?: string | null;
  wallet_address?: string | null;
}

export class PayoutRouter {
  private adapters: Map<SupportedPayoutChain, PayoutChainAdapter>;

  constructor(adapters?: Partial<Record<SupportedPayoutChain, PayoutChainAdapter>>) {
    this.adapters = new Map<SupportedPayoutChain, PayoutChainAdapter>();

    // Register provided adapters or instantiate defaults
    this.adapters.set('stellar', adapters?.stellar ?? new StellarAdapter());
    this.adapters.set('ethereum', adapters?.ethereum ?? new EthereumAdapter());
    this.adapters.set('solana', adapters?.solana ?? new SolanaAdapter());
  }

  /**
   * Get registered adapter for a supported chain
   */
  getAdapter(chain: SupportedPayoutChain): PayoutChainAdapter {
    const adapter = this.adapters.get(chain);
    if (!adapter) {
      throw new Error(
        `Unsupported payout chain: '${chain}'. Supported chains: ${SUPPORTED_PAYOUT_CHAINS.join(', ')}`
      );
    }
    return adapter;
  }

  /**
   * Register or replace a chain adapter
   */
  registerAdapter(chain: SupportedPayoutChain, adapter: PayoutChainAdapter): void {
    this.adapters.set(chain, adapter);
  }

  /**
   * Resolve user payout chain and adapter based on profile and wallet address
   */
  resolveUserChain(userProfile: UserPayoutProfile): {
    chain: SupportedPayoutChain;
    adapter: PayoutChainAdapter;
  } {
    const rawChain = userProfile.preferred_chain?.toLowerCase().trim();

    // 1. Explicit preferred_chain matches supported chains
    if (rawChain && (rawChain === 'stellar' || rawChain === 'ethereum' || rawChain === 'solana')) {
      const targetChain = rawChain as SupportedPayoutChain;

      if (userProfile.wallet_address) {
        const validation = this.validateRecipient(targetChain, userProfile.wallet_address);
        if (!validation.valid) {
          throw new Error(
            `User wallet address does not match preferred chain '${targetChain}': ${validation.error}`
          );
        }
      }

      return {
        chain: targetChain,
        adapter: this.getAdapter(targetChain),
      };
    }

    // 2. Infer chain from wallet address pattern if preferred_chain is missing or unspecified
    if (userProfile.wallet_address) {
      const address = userProfile.wallet_address.trim();

      // Ethereum address check (starts with 0x)
      if (address.startsWith('0x') && this.getAdapter('ethereum').validateAddress(address)) {
        return { chain: 'ethereum', adapter: this.getAdapter('ethereum') };
      }

      // Stellar address check (starts with G)
      if (address.startsWith('G') && this.getAdapter('stellar').validateAddress(address)) {
        return { chain: 'stellar', adapter: this.getAdapter('stellar') };
      }

      // Solana address check (Base58 32-byte public key)
      if (this.getAdapter('solana').validateAddress(address)) {
        return { chain: 'solana', adapter: this.getAdapter('solana') };
      }
    }

    throw new Error(
      `Unable to resolve valid payout chain for user profile: preferred_chain='${userProfile.preferred_chain ?? ''}', wallet_address='${userProfile.wallet_address ?? ''}'`
    );
  }

  /**
   * Validate recipient address according to target chain rules
   */
  validateRecipient(
    chain: SupportedPayoutChain,
    address: string
  ): { valid: boolean; error?: string } {
    if (!address || typeof address !== 'string' || address.trim().length === 0) {
      return { valid: false, error: 'Recipient wallet address cannot be empty' };
    }

    const trimmedAddress = address.trim();

    if (!SUPPORTED_PAYOUT_CHAINS.includes(chain)) {
      return {
        valid: false,
        error: `Unsupported payout chain: '${chain}'. Supported: ${SUPPORTED_PAYOUT_CHAINS.join(', ')}`,
      };
    }

    const adapter = this.adapters.get(chain);
    if (!adapter) {
      return { valid: false, error: `No adapter registered for chain: '${chain}'` };
    }

    const isValid = adapter.validateAddress(trimmedAddress);

    if (!isValid) {
      switch (chain) {
        case 'stellar':
          return {
            valid: false,
            error: `Invalid Stellar address: '${trimmedAddress}'. Must be a 56-character base32 public key starting with 'G'.`,
          };
        case 'ethereum':
          return {
            valid: false,
            error: `Invalid Ethereum address: '${trimmedAddress}'. Must be a 42-character hexadecimal address starting with '0x'.`,
          };
        case 'solana':
          return {
            valid: false,
            error: `Invalid Solana address: '${trimmedAddress}'. Must be a valid 32-byte Base58-encoded public key.`,
          };
        default:
          return { valid: false, error: `Invalid address for chain '${chain}'` };
      }
    }

    return { valid: true };
  }

  /**
   * Estimate network fee for a payout on the designated chain
   */
  async estimateFee(
    chain: SupportedPayoutChain,
    params: FeeEstimateParams
  ): Promise<ChainFeeEstimate> {
    const adapter = this.getAdapter(chain);
    return adapter.estimateFee(params);
  }

  /**
   * Send a payout to a recipient via the designated chain adapter
   */
  async sendPayout(
    chain: SupportedPayoutChain,
    params: PayoutExecutionParams
  ): Promise<PayoutExecutionResult> {
    const adapter = this.getAdapter(chain);
    return adapter.sendPayout(params);
  }

  /**
   * Verify an on-chain transaction on the designated chain
   */
  async verifyTransaction(
    chain: SupportedPayoutChain,
    transactionId: string
  ): Promise<TransactionVerificationResult> {
    const adapter = this.getAdapter(chain);
    return adapter.verifyTransaction(transactionId);
  }

  /**
   * Query hot wallet treasury balance on the designated chain
   */
  async getTreasuryBalance(chain: SupportedPayoutChain): Promise<TreasuryBalanceResult> {
    const adapter = this.getAdapter(chain);
    return adapter.getTreasuryBalance();
  }
}

/**
 * Singleton instance of PayoutRouter
 */
export const payoutRouter = new PayoutRouter();
