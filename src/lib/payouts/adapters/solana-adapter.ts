/**
 * src/lib/payouts/adapters/solana-adapter.ts
 *
 * Solana Payout Chain Adapter
 * Implements PayoutChainAdapter for SPL USDC transfers
 * Edge-compatible, pure TypeScript using JsonRpcClient and zero heavy npm dependencies
 * Compatible with ES2017 target (using BigInt() constructors).
 */

import { JsonRpcClient } from '../rpc/json-rpc-client';
import { decodeBase58, encodeBase58, isValidSolanaAddress } from '../crypto/base58';
import {
  createEd25519Signer,
  serializeSolanaMessage,
  serializeSolanaTransaction,
} from '../crypto/ed25519-signer';
import type {
  FeeEstimateParams,
  ChainFeeEstimate,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
} from '../types';
import { BasePayoutChainAdapter } from './adapter-interface';

export interface SolanaAdapterConfig {
  rpcUrl?: string;
  jsonRpcClient?: JsonRpcClient;
  hotWalletAddress?: string;
  hotWalletTokenAccount?: string;
  privateKey?: string;
  usdcMintAddress?: string;
  solPriceUsd?: number;
  computeUnitLimit?: number;
  computeUnitPriceMicroLamports?: bigint;
  cluster?: 'mainnet-beta' | 'devnet';
}

const DEFAULT_MICRO_LAMPORTS_BIGINT = BigInt(50000);
const ONE_MILLION_BIGINT = BigInt(1000000);

export const SOLANA_DEFAULTS = {
  RPC_URL: 'https://api.mainnet-beta.solana.com',
  HOT_WALLET: '11111111111111111111111111111111',
  USDC_MINT_MAINNET: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  USDC_MINT_DEVNET: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  TOKEN_PROGRAM_ID: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ASSOCIATED_TOKEN_PROGRAM_ID: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  COMPUTE_BUDGET_PROGRAM_ID: 'ComputeBudget111111111111111111111111111111',
  SOL_PRICE_USD: 150,
  BASE_SIGNATURE_FEE_LAMPORTS: 5_000,
  DEFAULT_COMPUTE_UNITS: 100_000,
  DEFAULT_MICRO_LAMPORTS: DEFAULT_MICRO_LAMPORTS_BIGINT,
  USDC_DECIMALS: 6,
};

/**
 * Builds SPL Token instruction 12 (TransferChecked) data
 * Layout: [12: u8, amount: u64 LE, decimals: u8]
 */
export function buildSPLTransferCheckedData(
  amountUnits: bigint,
  decimals: number = SOLANA_DEFAULTS.USDC_DECIMALS
): Uint8Array {
  const data = new Uint8Array(10);
  data[0] = 12; // TransferChecked instruction
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amountUnits, true);
  data[9] = decimals;
  return data;
}

/**
 * Builds SPL Token instruction 3 (Transfer) data
 * Layout: [3: u8, amount: u64 LE]
 */
export function buildSPLTransferData(amountUnits: bigint): Uint8Array {
  const data = new Uint8Array(9);
  data[0] = 3; // Transfer instruction
  const view = new DataView(data.buffer);
  view.setBigUint64(1, amountUnits, true);
  return data;
}

/**
 * Builds ComputeBudget SetComputeUnitLimit instruction data
 * Layout: [2: u8, units: u32 LE]
 */
export function buildSetComputeUnitLimitData(units: number = 100_000): Uint8Array {
  const data = new Uint8Array(5);
  data[0] = 2; // SetComputeUnitLimit
  new DataView(data.buffer).setUint32(1, units, true);
  return data;
}

/**
 * Builds ComputeBudget SetComputeUnitPrice instruction data
 * Layout: [3: u8, microLamports: u64 LE]
 */
export function buildSetComputeUnitPriceData(
  microLamports: bigint = DEFAULT_MICRO_LAMPORTS_BIGINT
): Uint8Array {
  const data = new Uint8Array(9);
  data[0] = 3; // SetComputeUnitPrice
  new DataView(data.buffer).setBigUint64(1, microLamports, true);
  return data;
}

export class SolanaAdapter extends BasePayoutChainAdapter {
  readonly chain = 'solana' as const;
  private rpc: JsonRpcClient;
  private hotWalletAddress: string;
  private hotWalletTokenAccount?: string;
  private privateKey?: string;
  private usdcMintAddress: string;
  private solPriceUsd: number;
  private computeUnitLimit: number;
  private computeUnitPriceMicroLamports: bigint;
  private cluster: 'mainnet-beta' | 'devnet';

  constructor(config?: SolanaAdapterConfig) {
    super();
    const rpcUrl =
      config?.rpcUrl ??
      process.env.SOLANA_RPC_URL ??
      SOLANA_DEFAULTS.RPC_URL;

    this.rpc = config?.jsonRpcClient ?? new JsonRpcClient(rpcUrl);
    this.hotWalletAddress =
      config?.hotWalletAddress ??
      process.env.SOLANA_HOT_WALLET ??
      SOLANA_DEFAULTS.HOT_WALLET;
    this.hotWalletTokenAccount =
      config?.hotWalletTokenAccount ?? process.env.SOLANA_HOT_WALLET_USDC_ACCOUNT;
    this.privateKey = config?.privateKey ?? process.env.SOLANA_PRIVATE_KEY;
    this.cluster =
      config?.cluster ??
      ((process.env.SOLANA_CLUSTER as 'mainnet-beta' | 'devnet') || 'mainnet-beta');
    this.usdcMintAddress =
      config?.usdcMintAddress ??
      (process.env.SOLANA_USDC_MINT ||
        (this.cluster === 'devnet'
          ? SOLANA_DEFAULTS.USDC_MINT_DEVNET
          : SOLANA_DEFAULTS.USDC_MINT_MAINNET));
    this.solPriceUsd =
      config?.solPriceUsd ??
      (process.env.SOL_PRICE_USD ? parseFloat(process.env.SOL_PRICE_USD) : SOLANA_DEFAULTS.SOL_PRICE_USD);
    this.computeUnitLimit =
      config?.computeUnitLimit ?? SOLANA_DEFAULTS.DEFAULT_COMPUTE_UNITS;
    this.computeUnitPriceMicroLamports =
      config?.computeUnitPriceMicroLamports ?? DEFAULT_MICRO_LAMPORTS_BIGINT;
  }

  /**
   * Validate recipient Solana public key address (Base58 decoding to 32 bytes)
   */
  validateAddress(address: string): boolean {
    return isValidSolanaAddress(address);
  }

  /**
   * Estimate Solana network fee (base signature fee + compute unit priority fee)
   */
  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    const baseFeeLamports = SOLANA_DEFAULTS.BASE_SIGNATURE_FEE_LAMPORTS;
    // Priority fee: (CU Limit * MicroLamports) / 1,000,000
    const priorityFeeLamports = Number(
      (BigInt(this.computeUnitLimit) * this.computeUnitPriceMicroLamports) / ONE_MILLION_BIGINT
    );
    const totalLamports = baseFeeLamports + priorityFeeLamports;
    const nativeFeeAmount = totalLamports / 1e9; // In SOL
    const feeUsd = Number((nativeFeeAmount * this.solPriceUsd).toFixed(6));
    const isCongested = priorityFeeLamports > 50_000;

    return {
      chain: 'solana',
      nativeFeeAmount,
      nativeFeeSymbol: 'SOL',
      feeUsd,
      gasUnitsOrLimit: this.computeUnitLimit,
      pricePerUnit: `${this.computeUnitPriceMicroLamports.toString()} micro-lamports`,
      isCongested,
      estimatedAt: new Date().toISOString(),
    };
  }

  /**
   * Send SPL USDC payout transaction
   */
  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (!this.validateAddress(params.recipientAddress)) {
      return this.createFailedResult(
        params,
        `Invalid Solana recipient address: ${params.recipientAddress}`
      );
    }

    if (!this.privateKey) {
      return this.createFailedResult(
        params,
        'Solana payouts are not enabled: no Ed25519 signing key is configured, ' +
          'so this chain cannot broadcast a transfer.',
        0,
        0,
        'SOL'
      );
    }

    try {
      const signer = await createEd25519Signer(this.privateKey);
      const payerPubkeyBytes = signer.publicKeyBytes;

      // 1. Fetch recent blockhash
      const blockhashRes = await this.rpc.call<{
        value: { blockhash: string };
      }>('getLatestBlockhash', [{ commitment: 'finalized' }]);

      if (!blockhashRes?.value?.blockhash) {
        return this.createFailedResult(params, 'Failed to retrieve recent blockhash from Solana RPC');
      }

      const recentBlockhashBytes = decodeBase58(blockhashRes.value.blockhash);
      const sourceTokenAccountBytes = this.hotWalletTokenAccount
        ? decodeBase58(this.hotWalletTokenAccount)
        : payerPubkeyBytes;
      const recipientTokenAccountBytes = decodeBase58(params.recipientAddress);
      const tokenProgramBytes = decodeBase58(SOLANA_DEFAULTS.TOKEN_PROGRAM_ID);

      const amountUnits = BigInt(Math.round(params.amount * 10 ** SOLANA_DEFAULTS.USDC_DECIMALS));
      const transferIxData = buildSPLTransferData(amountUnits);

      // SPL Token Transfer instruction accounts:
      // 0: ownerWallet (signer, writable fee payer)
      // 1: sourceTokenAccount (writable)
      // 2: destinationTokenAccount (writable)
      // 3: tokenProgram (readonly unsigned)
      const isDistinctSourceTokenAccount =
        this.hotWalletTokenAccount && this.hotWalletTokenAccount !== signer.publicKeyBase58;

      const accountKeys = isDistinctSourceTokenAccount
        ? [payerPubkeyBytes, sourceTokenAccountBytes, recipientTokenAccountBytes, tokenProgramBytes]
        : [payerPubkeyBytes, recipientTokenAccountBytes, tokenProgramBytes];

      const programIdIndex = isDistinctSourceTokenAccount ? 3 : 2;
      const accountIndices = isDistinctSourceTokenAccount ? [1, 2, 0] : [0, 1, 0];

      const serializedMsg = serializeSolanaMessage({
        numRequiredSignatures: 1,
        numReadonlySignedAccounts: 0,
        numReadonlyUnsignedAccounts: 1,
        accountKeys,
        recentBlockhash: recentBlockhashBytes,
        instructions: [
          {
            programIdIndex,
            accountIndices,
            data: transferIxData,
          },
        ],
      });

      const signatureBytes = await signer.sign(serializedMsg);
      const rawWireTx = serializeSolanaTransaction([signatureBytes], serializedMsg);
      const wireBase64 = Buffer.from(rawWireTx).toString('base64');

      const broadcastSignature = await this.rpc.call<string>('sendTransaction', [
        wireBase64,
        { encoding: 'base64', preflightCommitment: 'confirmed' },
      ]);

      if (!broadcastSignature || typeof broadcastSignature !== 'string') {
        return this.createFailedResult(params, 'Solana broadcast returned no signature');
      }

      const feeEst = await this.estimateFee({
        chain: 'solana',
        recipientAddress: params.recipientAddress,
        amount: params.amount,
        token: params.token,
      });

      return {
        success: true,
        payoutId: params.payoutId,
        chain: 'solana',
        transactionId: broadcastSignature,
        fromAddress: signer.publicKeyBase58,
        toAddress: params.recipientAddress,
        amount: params.amount,
        token: params.token ?? 'USDC',
        gasFeeNative: feeEst.nativeFeeAmount,
        gasFeeUsd: feeEst.feeUsd,
        nativeFeeSymbol: 'SOL',
        status: 'submitted',
        explorerUrl: this.getExplorerUrl(broadcastSignature),
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return this.createFailedResult(params, `Solana transaction failed: ${msg}`);
    }
  }

  /**
   * Verify Solana transaction signature status
   */
  async verifyTransaction(transactionId: string): Promise<TransactionVerificationResult> {
    try {
      const response = await this.rpc.call<{
        value: Array<{
          slot: number;
          confirmations: number | null;
          err: unknown;
          confirmationStatus: 'processed' | 'confirmed' | 'finalized' | null;
        } | null>;
      }>('getSignatureStatuses', [
        [transactionId],
        { searchTransactionHistory: true },
      ]);

      const status = response?.value?.[0];

      if (!status) {
        return {
          verified: false,
          status: 'not_found',
          transactionId,
          timestamp: new Date().toISOString(),
        };
      }

      if (status.err) {
        return {
          verified: false,
          status: 'failed',
          transactionId,
          blockNumberOrSlot: status.slot,
          reason: `Solana transaction failed: ${JSON.stringify(status.err)}`,
          timestamp: new Date().toISOString(),
        };
      }

      const isConfirmed =
        status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized';

      return {
        verified: isConfirmed,
        status: isConfirmed ? 'confirmed' : 'pending',
        transactionId,
        blockNumberOrSlot: status.slot,
        confirmations: status.confirmations ?? undefined,
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        status: 'failed',
        transactionId,
        reason: `Failed to query signature status: ${message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Query hot wallet native SOL balance and SPL USDC token balance
   */
  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    let nativeBalance = 0;
    let usdcBalance = 0;

    // 1. Query SOL Balance (getBalance)
    try {
      const solRes = await this.rpc.call<{ value: number }>('getBalance', [
        this.hotWalletAddress,
        { commitment: 'confirmed' },
      ]);
      nativeBalance = (solRes?.value ?? 0) / 1e9;
    } catch {
      nativeBalance = 0;
    }

    // 2. Query SPL USDC Token Account Balance
    try {
      if (this.hotWalletTokenAccount) {
        const balRes = await this.rpc.call<{
          value: {
            uiAmount: number;
            amount: string;
            decimals: number;
          };
        }>('getTokenAccountBalance', [
          this.hotWalletTokenAccount,
          { commitment: 'confirmed' },
        ]);
        usdcBalance = balRes?.value?.uiAmount ?? 0;
      } else {
        // Query by owner and mint
        const accountsRes = await this.rpc.call<{
          value: Array<{
            account: {
              data: {
                parsed: {
                  info: {
                    tokenAmount: {
                      uiAmount: number;
                    };
                  };
                };
              };
            };
          }>;
        }>('getTokenAccountsByOwner', [
          this.hotWalletAddress,
          { mint: this.usdcMintAddress },
          { encoding: 'jsonParsed' },
        ]);

        if (accountsRes?.value && accountsRes.value.length > 0) {
          usdcBalance =
            accountsRes.value[0]?.account?.data?.parsed?.info?.tokenAmount?.uiAmount ?? 0;
        }
      }
    } catch {
      usdcBalance = 0;
    }

    const nativeBalanceUsd = Number((nativeBalance * this.solPriceUsd).toFixed(2));
    const totalUsdValue = Number((nativeBalanceUsd + usdcBalance).toFixed(2));

    return {
      chain: 'solana',
      hotWalletAddress: this.hotWalletAddress,
      nativeBalance,
      nativeSymbol: 'SOL',
      nativeBalanceUsd,
      tokenBalances: {
        USDC: usdcBalance,
      },
      totalUsdValue,
      lastUpdated: new Date().toISOString(),
    };
  }

  private getExplorerUrl(signature: string): string {
    const clusterQuery = this.cluster === 'devnet' ? '?cluster=devnet' : '';
    return `https://solscan.io/tx/${signature}${clusterQuery}`;
  }
}
