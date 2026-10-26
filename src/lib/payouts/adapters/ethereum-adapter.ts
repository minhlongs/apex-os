/**
 * src/lib/payouts/adapters/ethereum-adapter.ts
 *
 * Ethereum Payout Chain Adapter
 * Implements PayoutChainAdapter for EVM ERC-20 transfers (USDC / USDT)
 * Edge-compatible, uses JsonRpcClient without native C++ Web3 libraries
 */

import { JsonRpcClient } from '../rpc/json-rpc-client';
import {
  keccak256,
  toChecksumAddress,
  isValidChecksumAddress,
  isValidEthereumAddress,
} from '../crypto/keccak';
import { createSecp256k1Signer } from '../crypto/secp256k1-signer';
import { encodeRlp } from '../crypto/rlp';
import type {
  FeeEstimateParams,
  ChainFeeEstimate,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
} from '../types';
import { BasePayoutChainAdapter } from './adapter-interface';

export interface EthereumAdapterConfig {
  rpcUrl?: string;
  jsonRpcClient?: JsonRpcClient;
  hotWalletAddress?: string;
  privateKey?: string;
  usdcContractAddress?: string;
  usdtContractAddress?: string;
  ethPriceUsd?: number;
  chainId?: number;
}

export const ETHEREUM_DEFAULTS = {
  RPC_URL: 'https://cloudflare-eth.com',
  HOT_WALLET: '0x0000000000000000000000000000000000000000',
  USDC_CONTRACT: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', // Mainnet USDC
  USDT_CONTRACT: '0xdAC17F958D2ee523a2206206994597C13D831ec7', // Mainnet USDT
  ETH_PRICE_USD: 2800,
  CHAIN_ID: 1,
  ERC20_DECIMALS: 6, // Both USDC and USDT on Ethereum use 6 decimals
};

const DEFAULT_GAS_LIMIT = BigInt(65000);
const DEFAULT_BASE_FEE_WEI = BigInt('20000000000'); // 20 Gwei
const DEFAULT_PRIORITY_FEE_WEI = BigInt('2000000000'); // 2 Gwei
const CONGESTION_THRESHOLD_WEI = BigInt('50000000000'); // 50 Gwei

/**
 * Encodes ERC-20 transfer(address to, uint256 amount) calldata
 * Selector: 0xa9059cbb (4 bytes) + 32-byte address + 32-byte amount
 */
export function encodeERC20Transfer(recipientAddress: string, amountUnits: bigint): string {
  if (!isValidEthereumAddress(recipientAddress)) {
    throw new Error(`Invalid recipient Ethereum address: ${recipientAddress}`);
  }
  const cleanAddr = recipientAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  const hexAmount = amountUnits.toString(16).padStart(64, '0');
  return `0xa9059cbb${cleanAddr}${hexAmount}`;
}

/**
 * Encodes ERC-20 balanceOf(address account) calldata
 * Selector: 0x70a08231 (4 bytes) + 32-byte address
 */
export function encodeERC20BalanceOf(accountAddress: string): string {
  if (!isValidEthereumAddress(accountAddress)) {
    throw new Error(`Invalid account Ethereum address: ${accountAddress}`);
  }
  const cleanAddr = accountAddress.replace(/^0x/, '').toLowerCase().padStart(64, '0');
  return `0x70a08231${cleanAddr}`;
}

export class EthereumAdapter extends BasePayoutChainAdapter {
  readonly chain = 'ethereum' as const;
  private rpc: JsonRpcClient;
  private hotWalletAddress: string;
  private privateKey?: string;
  private usdcContractAddress: string;
  private usdtContractAddress: string;
  private ethPriceUsd: number;
  private chainId: number;

  constructor(config?: EthereumAdapterConfig) {
    super();
    const rpcUrl =
      config?.rpcUrl ??
      process.env.ETHEREUM_RPC_URL ??
      ETHEREUM_DEFAULTS.RPC_URL;

    this.rpc = config?.jsonRpcClient ?? new JsonRpcClient(rpcUrl);
    this.hotWalletAddress =
      config?.hotWalletAddress ??
      process.env.ETHEREUM_HOT_WALLET ??
      ETHEREUM_DEFAULTS.HOT_WALLET;
    this.privateKey = config?.privateKey ?? process.env.ETHEREUM_PRIVATE_KEY;
    this.usdcContractAddress =
      config?.usdcContractAddress ??
      process.env.ETHEREUM_USDC_CONTRACT ??
      ETHEREUM_DEFAULTS.USDC_CONTRACT;
    this.usdtContractAddress =
      config?.usdtContractAddress ??
      process.env.ETHEREUM_USDT_CONTRACT ??
      ETHEREUM_DEFAULTS.USDT_CONTRACT;
    this.ethPriceUsd =
      config?.ethPriceUsd ??
      (process.env.ETH_PRICE_USD ? parseFloat(process.env.ETH_PRICE_USD) : ETHEREUM_DEFAULTS.ETH_PRICE_USD);
    this.chainId =
      config?.chainId ??
      (process.env.ETHEREUM_CHAIN_ID ? parseInt(process.env.ETHEREUM_CHAIN_ID, 10) : ETHEREUM_DEFAULTS.CHAIN_ID);
  }

  /**
   * Validate recipient address format and EIP-55 checksum if mixed-case
   */
  validateAddress(address: string): boolean {
    return isValidEthereumAddress(address, false);
  }

  /**
   * Check if address matches strict EIP-55 checksum
   */
  isValidChecksum(address: string): boolean {
    return isValidChecksumAddress(address);
  }

  /**
   * Format address to EIP-55 checksum
   */
  toChecksum(address: string): string {
    return toChecksumAddress(address);
  }

  /**
   * Estimate EIP-1559 gas fees for ERC-20 transfer
   */
  async estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate> {
    const tokenContract =
      params.token === 'USDT' ? this.usdtContractAddress : this.usdcContractAddress;
    const amountUnits = BigInt(Math.round(params.amount * 10 ** ETHEREUM_DEFAULTS.ERC20_DECIMALS));

    let calldata = '';
    try {
      calldata = encodeERC20Transfer(params.recipientAddress, amountUnits);
    } catch {
      calldata = '0xa9059cbb' + '0'.repeat(128);
    }

    // 1. Gas Units Estimation (eth_estimateGas)
    let gasLimit = DEFAULT_GAS_LIMIT;
    try {
      const gasHex = await this.rpc.call<string>('eth_estimateGas', [
        {
          from: this.hotWalletAddress,
          to: tokenContract,
          data: calldata,
        },
      ]);
      gasLimit = BigInt(gasHex);
    } catch {
      gasLimit = DEFAULT_GAS_LIMIT; // Standard safe ERC-20 transfer gas limit
    }

    // 2. EIP-1559 Base Fee & Priority Fee Estimation
    let baseFeePerGas = DEFAULT_BASE_FEE_WEI;
    let maxPriorityFeePerGas = DEFAULT_PRIORITY_FEE_WEI;

    try {
      const feeHistory = await this.rpc.call<{
        baseFeePerGas?: string[];
      }>('eth_feeHistory', ['0x2', 'latest', [50]]);

      if (feeHistory?.baseFeePerGas && feeHistory.baseFeePerGas.length > 0) {
        const latestBaseFeeHex =
          feeHistory.baseFeePerGas[feeHistory.baseFeePerGas.length - 1];
        baseFeePerGas = BigInt(latestBaseFeeHex);
      }
    } catch {
      // Fallback: try eth_gasPrice
      try {
        const gasPriceHex = await this.rpc.call<string>('eth_gasPrice', []);
        baseFeePerGas = BigInt(gasPriceHex);
      } catch {
        // keep defaults
      }
    }

    try {
      const suggestedTipHex = await this.rpc.call<string>('eth_maxPriorityFeePerGas', []);
      maxPriorityFeePerGas = BigInt(suggestedTipHex);
    } catch {
      // keep 2 Gwei default
    }

    const effectiveFeePerGas = baseFeePerGas + maxPriorityFeePerGas;
    const totalGasCostWei = gasLimit * effectiveFeePerGas;
    const nativeFeeAmount = Number(totalGasCostWei) / 1e18; // In ETH
    const feeUsd = Number((nativeFeeAmount * this.ethPriceUsd).toFixed(4));
    const gweiPrice = (Number(effectiveFeePerGas) / 1e9).toFixed(2);
    const isCongested = effectiveFeePerGas > CONGESTION_THRESHOLD_WEI;

    return {
      chain: 'ethereum',
      nativeFeeAmount,
      nativeFeeSymbol: 'ETH',
      feeUsd,
      gasUnitsOrLimit: Number(gasLimit),
      pricePerUnit: `${gweiPrice} Gwei`,
      isCongested,
      estimatedAt: new Date().toISOString(),
    };
  }

  /**
   * Simulate transfer and broadcast payout transaction
   */
  async sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult> {
    if (!this.validateAddress(params.recipientAddress)) {
      return this.createFailedResult(
        params,
        `Invalid Ethereum recipient address: ${params.recipientAddress}`
      );
    }

    const tokenContract =
      params.token === 'USDT' ? this.usdtContractAddress : this.usdcContractAddress;
    const amountUnits = BigInt(Math.round(params.amount * 10 ** ETHEREUM_DEFAULTS.ERC20_DECIMALS));
    const calldata = encodeERC20Transfer(params.recipientAddress, amountUnits);

    // 1. Simulation via eth_call
    try {
      const simResult = await this.rpc.call<string>('eth_call', [
        {
          from: this.hotWalletAddress,
          to: tokenContract,
          data: calldata,
        },
        'latest',
      ]);

      // If call returned empty or false (0x0...0)
      if (simResult && simResult.replace(/^0x/, '') === '0'.repeat(64)) {
        return this.createFailedResult(
          params,
          'Transfer simulation failed: token transfer returned false'
        );
      }
    } catch (simError: unknown) {
      const msg = simError instanceof Error ? simError.message : String(simError);
      // If simulation explicitly reverted (e.g. insufficient balance or locked token)
      if (msg.toLowerCase().includes('revert') || msg.toLowerCase().includes('execution reverted')) {
        return this.createFailedResult(params, `Transfer simulation reverted: ${msg}`);
      }
    }

    // 2. Broadcast Transaction
    let transactionHash: string;
    let senderAddress = this.hotWalletAddress;

    if (this.privateKey) {
      try {
        const signer = createSecp256k1Signer(this.privateKey);
        senderAddress = signer.address;

        // Fetch nonce (eth_getTransactionCount)
        const nonceHex = await this.rpc.call<string>('eth_getTransactionCount', [
          senderAddress,
          'pending',
        ]);
        const nonce = BigInt(nonceHex || '0x0');

        // Estimate current gas fee parameters
        const feeEst = await this.estimateFee({
          chain: 'ethereum',
          recipientAddress: params.recipientAddress,
          amount: params.amount,
          token: params.token,
        });

        const chainId = BigInt(this.chainId);
        const maxPriorityFeePerGas = DEFAULT_PRIORITY_FEE_WEI;
        const maxFeePerGas = DEFAULT_BASE_FEE_WEI + maxPriorityFeePerGas;
        const gasLimit = BigInt(feeEst.gasUnitsOrLimit || 65000);

        // EIP-1559 payload: [chainId, nonce, maxPriorityFeePerGas, maxFeePerGas, gasLimit, to, value, data, accessList]
        const unsignedTx = [
          chainId,
          nonce,
          maxPriorityFeePerGas,
          maxFeePerGas,
          gasLimit,
          tokenContract,
          BigInt(0),
          calldata,
          [],
        ];

        const rlpUnsigned = encodeRlp(unsignedTx);
        // EIP-2718 Type 2: 0x02 || rlp(unsignedTx)
        const type2Payload = new Uint8Array(1 + rlpUnsigned.length);
        type2Payload[0] = 0x02;
        type2Payload.set(rlpUnsigned, 1);

        const txHashHex = keccak256(type2Payload);
        const txHashBytes = Buffer.from(txHashHex.slice(2), 'hex');

        const signature = signer.signHash(txHashBytes);

        // Signed EIP-1559 payload: [chainId, nonce, maxPriorityFee, maxFee, gasLimit, to, value, data, accessList, yParity, r, s]
        const signedTx = [
          chainId,
          nonce,
          maxPriorityFeePerGas,
          maxFeePerGas,
          gasLimit,
          tokenContract,
          BigInt(0),
          calldata,
          [],
          signature.recoveryParam,
          '0x' + signature.r,
          '0x' + signature.s,
        ];

        const rlpSigned = encodeRlp(signedTx);
        const rawSignedTx = new Uint8Array(1 + rlpSigned.length);
        rawSignedTx[0] = 0x02;
        rawSignedTx.set(rlpSigned, 1);

        const rawTxHex = '0x' + Buffer.from(rawSignedTx).toString('hex');
        const computedHash = keccak256(rawSignedTx);

        const broadcastRes = await this.rpc.call<string>('eth_sendRawTransaction', [rawTxHex]);
        transactionHash = broadcastRes || computedHash;
      } catch (signError: unknown) {
        const msg = signError instanceof Error ? signError.message : String(signError);
        return this.createFailedResult(
          params,
          `Ethereum signing/broadcast failed: ${msg}`
        );
      }
    } else {
      try {
        const broadcastRes = await this.rpc.call<string>('eth_sendTransaction', [
          {
            from: this.hotWalletAddress,
            to: tokenContract,
            data: calldata,
            gas: '0x186a0', // 100,000 gas units
          },
        ]);

        if (!broadcastRes || typeof broadcastRes !== 'string') {
          return this.createFailedResult(
            params,
            'Ethereum broadcast returned no transaction hash'
          );
        }

        transactionHash = broadcastRes;
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        return this.createFailedResult(
          params,
          `Ethereum broadcast failed (no signing key available for this node): ${msg}`
        );
      }
    }

    const feeEst = await this.estimateFee({
      chain: 'ethereum',
      recipientAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token,
    });

    return {
      success: true,
      payoutId: params.payoutId,
      chain: 'ethereum',
      transactionId: transactionHash,
      fromAddress: senderAddress,
      toAddress: params.recipientAddress,
      amount: params.amount,
      token: params.token ?? 'USDC',
      gasFeeNative: feeEst.nativeFeeAmount,
      gasFeeUsd: feeEst.feeUsd,
      nativeFeeSymbol: 'ETH',
      status: 'submitted',
      explorerUrl: this.getExplorerUrl(transactionHash),
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Verify transaction status by polling eth_getTransactionReceipt
   */
  async verifyTransaction(transactionId: string): Promise<TransactionVerificationResult> {
    try {
      const receipt = await this.rpc.call<{
        status?: string;
        blockNumber?: string;
        gasUsed?: string;
        effectiveGasPrice?: string;
      } | null>('eth_getTransactionReceipt', [transactionId]);

      if (!receipt) {
        return {
          verified: false,
          status: 'pending',
          transactionId,
          timestamp: new Date().toISOString(),
        };
      }

      const isSuccess = receipt.status === '0x1' || receipt.status === '1';
      const blockNumber = receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : undefined;

      let feePaidNative: number | undefined;
      let feePaidUsd: number | undefined;

      if (receipt.gasUsed && receipt.effectiveGasPrice) {
        const gasUsed = BigInt(receipt.gasUsed);
        const gasPrice = BigInt(receipt.effectiveGasPrice);
        const feeWei = gasUsed * gasPrice;
        feePaidNative = Number(feeWei) / 1e18;
        feePaidUsd = Number((feePaidNative * this.ethPriceUsd).toFixed(4));
      }

      return {
        verified: isSuccess,
        status: isSuccess ? 'confirmed' : 'failed',
        transactionId,
        blockNumberOrSlot: blockNumber,
        feePaidNative,
        feePaidUsd,
        reason: isSuccess ? undefined : 'Transaction execution reverted on-chain (status 0x0)',
        timestamp: new Date().toISOString(),
      };
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        verified: false,
        status: 'failed',
        transactionId,
        reason: `Failed to query receipt: ${message}`,
        timestamp: new Date().toISOString(),
      };
    }
  }

  /**
   * Query hot wallet ETH balance and ERC-20 token balances
   */
  async getTreasuryBalance(): Promise<TreasuryBalanceResult> {
    let nativeBalance = 0;
    const tokenBalances: Record<string, number> = {
      USDC: 0,
      USDT: 0,
    };

    // 1. Query Native ETH Balance (eth_getBalance)
    try {
      const ethBalHex = await this.rpc.call<string>('eth_getBalance', [
        this.hotWalletAddress,
        'latest',
      ]);
      nativeBalance = Number(BigInt(ethBalHex)) / 1e18;
    } catch {
      nativeBalance = 0;
    }

    // 2. Query USDC Balance (eth_call -> balanceOf)
    try {
      const usdcBalHex = await this.rpc.call<string>('eth_call', [
        {
          to: this.usdcContractAddress,
          data: encodeERC20BalanceOf(this.hotWalletAddress),
        },
        'latest',
      ]);
      tokenBalances.USDC = Number(BigInt(usdcBalHex)) / 1e6;
    } catch {
      tokenBalances.USDC = 0;
    }

    // 3. Query USDT Balance (eth_call -> balanceOf)
    try {
      const usdtBalHex = await this.rpc.call<string>('eth_call', [
        {
          to: this.usdtContractAddress,
          data: encodeERC20BalanceOf(this.hotWalletAddress),
        },
        'latest',
      ]);
      tokenBalances.USDT = Number(BigInt(usdtBalHex)) / 1e6;
    } catch {
      tokenBalances.USDT = 0;
    }

    const nativeBalanceUsd = Number((nativeBalance * this.ethPriceUsd).toFixed(2));
    const totalUsdValue = Number(
      (nativeBalanceUsd + tokenBalances.USDC + tokenBalances.USDT).toFixed(2)
    );

    return {
      chain: 'ethereum',
      hotWalletAddress: this.hotWalletAddress,
      nativeBalance,
      nativeSymbol: 'ETH',
      nativeBalanceUsd,
      tokenBalances,
      totalUsdValue,
      lastUpdated: new Date().toISOString(),
    };
  }

  private getExplorerUrl(txHash: string): string {
    const isSepolia = this.chainId === 11155111;
    return isSepolia
      ? `https://sepolia.etherscan.io/tx/${txHash}`
      : `https://etherscan.io/tx/${txHash}`;
  }
}
