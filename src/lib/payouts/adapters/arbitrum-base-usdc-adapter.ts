/**
 * src/lib/payouts/adapters/arbitrum-base-usdc-adapter.ts
 *
 * Phase 1 Arbitrum One & Base Native Circle USDC Adapter (6 Decimals)
 *
 * Enforces:
 * - Canonical Circle Native USDC contracts only (rejects bridged USDC.e / USDbC)
 * - Exact 6-decimal integer scaling via decimal.js (ROUND_DOWN)
 * - Phase 1 chain gate: 'stellar' | 'arbitrum' | 'base' ENABLED; 'ethereum' L1 & 'solana' DISABLED_PHASE1
 * - $10.00 USDC minimum withdrawal floor
 * - Pre-signing Circle `isBlacklisted(address)` (0xfe575a87) check + `eth_call` transfer simulation
 *   with primary/fallback RPC resilience
 */

import Decimal from 'decimal.js';
import {
  encodeFunctionData,
  getAddress,
  isAddress,
  keccak256,
  parseAbi,
  serializeTransaction,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { JsonRpcClient, JsonRpcError } from '../rpc/json-rpc-client';

// ============================================================================
// Phase 1 Chain Governance & Precision Constants
// ============================================================================

export type Phase1SettlementChain = 'stellar' | 'arbitrum' | 'base';
export type EvmPhase1SettlementChain = 'arbitrum' | 'base';
export type LegacyDisabledSettlementChain = 'ethereum' | 'solana';
export type AnySettlementChain = Phase1SettlementChain | LegacyDisabledSettlementChain;

export const PHASE1_ENABLED_CHAINS: readonly Phase1SettlementChain[] = [
  'stellar',
  'arbitrum',
  'base',
] as const;

export const PHASE1_DISABLED_CHAINS: readonly LegacyDisabledSettlementChain[] = [
  'ethereum',
  'solana',
] as const;

export const EVM_USDC_DECIMALS = 6;
export const EVM_USDC_UNITS_PER_TOKEN = BigInt(1000000);

export const LEDGER_USD_DECIMALS = 8;
export const LEDGER_UNITS_PER_USD = BigInt(100000000);

export const MIN_WITHDRAWAL_USD = '10.00';
export const MIN_WITHDRAWAL_UNITS_1E8 = BigInt(1000000000);
export const MIN_WITHDRAWAL_EVM_USDC_UNITS = BigInt(10000000);
export const MIN_WITHDRAWAL_STELLAR_STROOPS = BigInt(100000000);

// Canonical Mainnet Chain IDs & Circle Native USDC Contracts
export const ARBITRUM_ONE_CHAIN_ID = 42161;
export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;
export const BASE_MAINNET_CHAIN_ID = 8453;
export const BASE_SEPOLIA_CHAIN_ID = 84532;

export const CANONICAL_ARBITRUM_NATIVE_USDC =
  '0xaf88d065e77c8cC2239327C5EDb3A432268e5831' as const;
export const CANONICAL_BASE_NATIVE_USDC =
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913' as const;

// Canonical Testnet Circle USDC Contracts (for sandbox simulation only when networkMode === 'testnet')
export const CANONICAL_ARBITRUM_SEPOLIA_USDC =
  '0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d' as const;
export const CANONICAL_BASE_SEPOLIA_USDC =
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e' as const;

// Explicitly forbidden bridged USDC tokens
export const REJECTED_ARBITRUM_BRIDGED_USDC_E =
  '0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8' as const;
export const REJECTED_BASE_BRIDGED_USDBC =
  '0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA' as const;

export const CIRCLE_IS_BLACKLISTED_SELECTOR = '0xfe575a87' as const;

const CIRCLE_USDC_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function isBlacklisted(address _account) view returns (bool)',
]);

const EVM_SCALE_DECIMAL = new Decimal(10).pow(EVM_USDC_DECIMALS);
const LEDGER_SCALE_DECIMAL = new Decimal(10).pow(LEDGER_USD_DECIMALS);

const DEFAULT_EVM_GAS_LIMIT = BigInt(65000);
const DEFAULT_L2_BASE_FEE_WEI = BigInt(100000000); // 0.1 Gwei
const DEFAULT_L2_PRIORITY_FEE_WEI = BigInt(10000000); // 0.01 Gwei

// ============================================================================
// Domain Errors
// ============================================================================

export class Phase1ChainDisabledError extends Error {
  readonly chain: string;
  readonly status = 'DISABLED_PHASE1' as const;

  constructor(chain: string, reason: string) {
    super(reason);
    this.name = 'Phase1ChainDisabledError';
    this.chain = chain;
  }
}

export class MinimumWithdrawalFloorError extends Error {
  readonly amountUnits1e8: bigint;
  readonly minimumUnits1e8: bigint = MIN_WITHDRAWAL_UNITS_1E8;

  constructor(amountUnits1e8: bigint) {
    const formatted = new Decimal(amountUnits1e8.toString())
      .div(LEDGER_SCALE_DECIMAL)
      .toFixed(2, Decimal.ROUND_DOWN);
    super(
      `Withdrawal amount $${formatted} USDC (${amountUnits1e8.toString()} units) is below Phase 1 minimum floor of $${MIN_WITHDRAWAL_USD} USDC`
    );
    this.name = 'MinimumWithdrawalFloorError';
    this.amountUnits1e8 = amountUnits1e8;
  }
}

export class NonCanonicalUsdcContractError extends Error {
  readonly chain: EvmPhase1SettlementChain;
  readonly providedContract: string;

  constructor(chain: EvmPhase1SettlementChain, providedContract: string, detail: string) {
    super(`Rejected non-canonical USDC contract '${providedContract}' on ${chain}: ${detail}`);
    this.name = 'NonCanonicalUsdcContractError';
    this.chain = chain;
    this.providedContract = providedContract;
  }
}

// ============================================================================
// Phase 1 Gate & Scaling Utilities
// ============================================================================

export interface Phase1ChainGateStatus {
  enabled: boolean;
  status: 'ENABLED' | 'DISABLED_PHASE1' | 'UNSUPPORTED';
  reason?: string;
}

export function checkPhase1ChainGate(chain: string): Phase1ChainGateStatus {
  const normalized = chain.trim().toLowerCase();
  if (normalized === 'stellar' || normalized === 'arbitrum' || normalized === 'base') {
    return { enabled: true, status: 'ENABLED' };
  }
  if (normalized === 'ethereum') {
    return {
      enabled: false,
      status: 'DISABLED_PHASE1',
      reason:
        "Chain 'ethereum' L1 is DISABLED_PHASE1: Ethereum Mainnet gas expenditure is prohibited in Phase 1; use Arbitrum One, Base, or Stellar",
    };
  }
  if (normalized === 'solana') {
    return {
      enabled: false,
      status: 'DISABLED_PHASE1',
      reason:
        "Chain 'solana' is DISABLED_PHASE1: Solana 0.002039 SOL ATA rent sponsorship is prohibited in Phase 1; use Arbitrum One, Base, or Stellar",
    };
  }
  return {
    enabled: false,
    status: 'UNSUPPORTED',
    reason: `Unsupported settlement chain '${chain}'`,
  };
}

export function assertPhase1ChainEnabled(
  chain: string
): asserts chain is Phase1SettlementChain {
  const gate = checkPhase1ChainGate(chain);
  if (!gate.enabled) {
    throw new Phase1ChainDisabledError(chain, gate.reason ?? `Chain '${chain}' is disabled`);
  }
}

/**
 * Convert USD amount into exact integer 10^-8 ledger units using ROUND_DOWN.
 */
export function toLedgerUnits1e8(amountUsd: string | number | Decimal): bigint {
  let dec: Decimal;
  try {
    dec = new Decimal(amountUsd);
  } catch {
    throw new Error(`Invalid USD amount: ${String(amountUsd)}`);
  }
  if (!dec.isFinite() || dec.lte(0)) {
    throw new Error(`Invalid USD amount: ${String(amountUsd)}`);
  }
  const scaled = dec.mul(LEDGER_SCALE_DECIMAL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  return BigInt(scaled.toFixed(0));
}

/**
 * Convert USD amount into exact 6-decimal EVM USDC integer units using ROUND_DOWN.
 * Example: '12.3456789' -> 12345678n
 */
export function toEvmUsdcUnits(amountUsd: string | number | Decimal): bigint {
  let dec: Decimal;
  try {
    dec = new Decimal(amountUsd);
  } catch {
    throw new Error(`Invalid EVM USDC amount: ${String(amountUsd)}`);
  }
  if (!dec.isFinite() || dec.lte(0)) {
    throw new Error(`Invalid EVM USDC amount: ${String(amountUsd)}`);
  }
  const scaled = dec.mul(EVM_SCALE_DECIMAL).toDecimalPlaces(0, Decimal.ROUND_DOWN);
  if (scaled.lte(0)) {
    throw new Error(`Invalid EVM USDC amount: ${String(amountUsd)}`);
  }
  return BigInt(scaled.toFixed(0));
}

/**
 * Convert 10^-8 ledger units into exact 6-decimal EVM USDC units via integer floor division.
 */
export function ledgerUnits1e8ToEvmUsdcUnits(amountUnits1e8: bigint): bigint {
  if (amountUnits1e8 <= BigInt(0)) {
    throw new Error(`Invalid non-positive ledger 1e8 amount: ${amountUnits1e8.toString()}`);
  }
  return amountUnits1e8 / BigInt(100);
}

/**
 * Format 6-decimal EVM USDC units back to a fixed 6-decimal string.
 */
export function fromEvmUsdcUnits(units: bigint): string {
  if (units < BigInt(0)) {
    throw new Error(`Invalid negative EVM USDC units: ${units.toString()}`);
  }
  return new Decimal(units.toString())
    .div(EVM_SCALE_DECIMAL)
    .toFixed(EVM_USDC_DECIMALS, Decimal.ROUND_DOWN);
}

/**
 * Enforce $10.00 USDC minimum withdrawal floor on 10^-8 ledger units.
 */
export function assertMinimumWithdrawalFloor(amountUnits1e8: bigint): void {
  if (amountUnits1e8 < MIN_WITHDRAWAL_UNITS_1E8) {
    throw new MinimumWithdrawalFloorError(amountUnits1e8);
  }
}

/**
 * Validate and normalize an EVM address to EIP-55 checksum format using viem.
 */
export function normalizeEvmAddress(address: string): Hex {
  if (typeof address !== 'string') {
    throw new Error('EVM address must be a string');
  }
  const trimmed = address.trim();
  if (!isAddress(trimmed)) {
    throw new Error(`Invalid EVM address (failed format or EIP-55 checksum): ${trimmed}`);
  }
  return getAddress(trimmed);
}

/**
 * Encode Circle Native USDC ERC-20 `transfer(address,uint256)` calldata via viem.
 */
export function encodeUsdcTransferCalldata(recipientAddress: string, amountUnits6: bigint): Hex {
  const checksumRecipient = normalizeEvmAddress(recipientAddress);
  if (amountUnits6 <= BigInt(0)) {
    throw new Error(`Transfer amount units must be positive: ${amountUnits6.toString()}`);
  }
  return encodeFunctionData({
    abi: CIRCLE_USDC_ABI,
    functionName: 'transfer',
    args: [checksumRecipient, amountUnits6],
  });
}

/**
 * Encode Circle FiatTokenV2_2 `isBlacklisted(address)` calldata (0xfe575a87) via viem.
 */
export function encodeIsBlacklistedCalldata(accountAddress: string): Hex {
  const checksumAccount = normalizeEvmAddress(accountAddress);
  const encoded = encodeFunctionData({
    abi: CIRCLE_USDC_ABI,
    functionName: 'isBlacklisted',
    args: [checksumAccount],
  });
  if (!encoded.toLowerCase().startsWith(CIRCLE_IS_BLACKLISTED_SELECTOR)) {
    throw new Error(`Unexpected selector for isBlacklisted: ${encoded.slice(0, 10)}`);
  }
  return encoded;
}

/**
 * Encode ERC-20 `balanceOf(address)` calldata via viem.
 */
export function encodeUsdcBalanceOfCalldata(accountAddress: string): Hex {
  const checksumAccount = normalizeEvmAddress(accountAddress);
  return encodeFunctionData({
    abi: CIRCLE_USDC_ABI,
    functionName: 'balanceOf',
    args: [checksumAccount],
  });
}

/**
 * Validate that a configured USDC contract matches Circle's canonical Native USDC contract
 * and explicitly reject bridged USDC.e / USDbC contracts.
 */
export function validateCanonicalUsdcContract(
  chain: EvmPhase1SettlementChain,
  contractAddress: string,
  networkMode: 'mainnet' | 'testnet' = 'mainnet'
): Hex {
  const checksummed = normalizeEvmAddress(contractAddress);
  const lower = checksummed.toLowerCase();

  if (lower === REJECTED_ARBITRUM_BRIDGED_USDC_E.toLowerCase()) {
    throw new NonCanonicalUsdcContractError(
      chain,
      checksummed,
      'Bridged Arbitrum USDC.e (0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8) is strictly prohibited; use Circle Native USDC (0xaf88d065e77c8cC2239327C5EDb3A432268e5831)'
    );
  }

  if (lower === REJECTED_BASE_BRIDGED_USDBC.toLowerCase()) {
    throw new NonCanonicalUsdcContractError(
      chain,
      checksummed,
      'Bridged Base USDbC (0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA) is strictly prohibited; use Circle Native USDC (0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913)'
    );
  }

  const expected =
    chain === 'arbitrum'
      ? networkMode === 'mainnet'
        ? CANONICAL_ARBITRUM_NATIVE_USDC
        : CANONICAL_ARBITRUM_SEPOLIA_USDC
      : networkMode === 'mainnet'
      ? CANONICAL_BASE_NATIVE_USDC
      : CANONICAL_BASE_SEPOLIA_USDC;

  if (lower !== expected.toLowerCase()) {
    throw new NonCanonicalUsdcContractError(
      chain,
      checksummed,
      `Expected canonical Circle Native USDC ${expected} for ${chain} (${networkMode})`
    );
  }

  return checksummed;
}

// ============================================================================
// Transport & Adapter Interfaces
// ============================================================================

export interface EvmJsonRpcTransport {
  call<T>(method: string, params?: unknown[]): Promise<T>;
}

export interface ArbitrumBaseUsdcAdapterConfig {
  chain: EvmPhase1SettlementChain;
  networkMode?: 'mainnet' | 'testnet';
  chainId?: number;
  usdcContractAddress?: string;
  hotWalletAddress: string;
  primaryRpcUrl?: string;
  fallbackRpcUrl?: string;
  primaryRpc?: EvmJsonRpcTransport;
  fallbackRpc?: EvmJsonRpcTransport;
  ethPriceUsd?: number;
}

export interface EvmUnsignedTransferEnvelope {
  chain: EvmPhase1SettlementChain;
  chainId: number;
  usdcContract: Hex;
  from: Hex;
  recipient: Hex;
  amountUnits6: bigint;
  assignedNonce: number;
  gasLimit: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
  calldata: Hex;
  unsignedSerializedHex: Hex;
  signingDigestHex: Hex;
  serializableTx: TransactionSerializableEIP1559;
}

export interface EvmReceiptResult {
  found: boolean;
  confirmed: boolean;
  reverted: boolean;
  blockNumber?: number;
  gasUsed?: bigint;
  effectiveGasPrice?: bigint;
  transactionHash: string;
}

const DEFAULT_RPC_URLS: Record<
  EvmPhase1SettlementChain,
  Record<'mainnet' | 'testnet', string>
> = {
  arbitrum: {
    mainnet: 'https://arb1.arbitrum.io/rpc',
    testnet: 'https://sepolia-rollup.arbitrum.io/rpc',
  },
  base: {
    mainnet: 'https://mainnet.base.org',
    testnet: 'https://sepolia.base.org',
  },
};

// ============================================================================
// Arbitrum One & Base Native Circle USDC Adapter
// ============================================================================

export class ArbitrumBaseUsdcAdapter {
  readonly chain: EvmPhase1SettlementChain;
  readonly networkMode: 'mainnet' | 'testnet';
  readonly chainId: number;
  readonly usdcContractAddress: Hex;
  readonly hotWalletAddress: Hex;
  readonly decimals = EVM_USDC_DECIMALS;

  private readonly primaryRpc: EvmJsonRpcTransport;
  private readonly fallbackRpc?: EvmJsonRpcTransport;
  private readonly ethPriceUsd: number;

  constructor(config: ArbitrumBaseUsdcAdapterConfig) {
    assertPhase1ChainEnabled(config.chain);
    if (config.chain !== 'arbitrum' && config.chain !== 'base') {
      throw new Error(`ArbitrumBaseUsdcAdapter only supports 'arbitrum' or 'base', got '${config.chain}'`);
    }

    this.chain = config.chain;
    this.networkMode = config.networkMode ?? 'mainnet';
    this.hotWalletAddress = normalizeEvmAddress(config.hotWalletAddress);

    const expectedChainId =
      this.chain === 'arbitrum'
        ? this.networkMode === 'mainnet'
          ? ARBITRUM_ONE_CHAIN_ID
          : ARBITRUM_SEPOLIA_CHAIN_ID
        : this.networkMode === 'mainnet'
        ? BASE_MAINNET_CHAIN_ID
        : BASE_SEPOLIA_CHAIN_ID;

    if (config.chainId !== undefined && config.chainId !== expectedChainId) {
      throw new Error(
        `Invalid chainId ${config.chainId} for ${this.chain} (${this.networkMode}); expected ${expectedChainId}`
      );
    }
    this.chainId = expectedChainId;

    const defaultContract =
      this.chain === 'arbitrum'
        ? this.networkMode === 'mainnet'
          ? CANONICAL_ARBITRUM_NATIVE_USDC
          : CANONICAL_ARBITRUM_SEPOLIA_USDC
        : this.networkMode === 'mainnet'
        ? CANONICAL_BASE_NATIVE_USDC
        : CANONICAL_BASE_SEPOLIA_USDC;

    this.usdcContractAddress = validateCanonicalUsdcContract(
      this.chain,
      config.usdcContractAddress ?? defaultContract,
      this.networkMode
    );

    const primaryUrl =
      config.primaryRpcUrl ?? DEFAULT_RPC_URLS[this.chain][this.networkMode];
    this.primaryRpc = config.primaryRpc ?? new JsonRpcClient(primaryUrl, { retryCount: 1 });

    if (config.fallbackRpc) {
      this.fallbackRpc = config.fallbackRpc;
    } else if (config.fallbackRpcUrl) {
      this.fallbackRpc = new JsonRpcClient(config.fallbackRpcUrl, { retryCount: 1 });
    }

    this.ethPriceUsd = config.ethPriceUsd ?? 2800;
  }

  validateAddress(address: string): boolean {
    if (typeof address !== 'string') return false;
    return isAddress(address.trim());
  }

  /**
   * Execute a read RPC call against primary RPC, failing over to fallback RPC on transport errors.
   * Deterministic EVM execution reverts (JsonRpcError) are surfaced immediately without masking.
   */
  async callReadWithFallback<T>(method: string, params: unknown[] = []): Promise<T> {
    try {
      return await this.primaryRpc.call<T>(method, params);
    } catch (primaryErr: unknown) {
      if (primaryErr instanceof JsonRpcError) {
        const lowerMsg = primaryErr.message.toLowerCase();
        if (lowerMsg.includes('revert') || primaryErr.code === 3 || primaryErr.code === -32000) {
          throw primaryErr;
        }
      }
      if (!this.fallbackRpc) {
        throw primaryErr;
      }
      return await this.fallbackRpc.call<T>(method, params);
    }
  }

  /**
   * On-chain Circle `isBlacklisted(address)` read check using selector 0xfe575a87.
   */
  async checkCircleBlacklist(
    accountAddress: string
  ): Promise<{ blacklisted: boolean; rawResult: string }> {
    const calldata = encodeIsBlacklistedCalldata(accountAddress);
    const rawHex = await this.callReadWithFallback<string>('eth_call', [
      {
        to: this.usdcContractAddress,
        data: calldata,
      },
      'latest',
    ]);

    if (!rawHex || typeof rawHex !== 'string' || rawHex === '0x') {
      throw new Error(
        `Circle isBlacklisted(${accountAddress}) returned empty response on ${this.chain}`
      );
    }

    const parsedValue = BigInt(rawHex);
    return {
      blacklisted: parsedValue !== BigInt(0),
      rawResult: rawHex,
    };
  }

  /**
   * Pre-signing simulation:
   * 1. Verifies $10.00 USDC floor (`>= 10_000_000` 6-decimal units)
   * 2. Verifies neither sender nor recipient is blacklisted on Circle USDC (`0xfe575a87`)
   * 3. Executes `eth_call` transfer simulation across primary/fallback RPC
   */
  async simulateTransferBeforeSigning(params: {
    recipientAddress: string;
    amountUnits6: bigint;
    fromAddress?: string;
  }): Promise<{ ok: boolean; reason?: string; calldata?: Hex }> {
    if (params.amountUnits6 < MIN_WITHDRAWAL_EVM_USDC_UNITS) {
      return {
        ok: false,
        reason: `Payout amount ${params.amountUnits6.toString()} units is below $10.00 USDC floor (${MIN_WITHDRAWAL_EVM_USDC_UNITS.toString()} units)`,
      };
    }

    let sender: Hex;
    let recipient: Hex;
    try {
      sender = normalizeEvmAddress(params.fromAddress ?? this.hotWalletAddress);
      recipient = normalizeEvmAddress(params.recipientAddress);
    } catch (err) {
      return {
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
      };
    }

    const recipientBl = await this.checkCircleBlacklist(recipient);
    if (recipientBl.blacklisted) {
      return {
        ok: false,
        reason: `CIRCLE_USDC_BLACKLISTED: Recipient ${recipient} is blacklisted on ${this.chain} Circle USDC`,
      };
    }

    const senderBl = await this.checkCircleBlacklist(sender);
    if (senderBl.blacklisted) {
      return {
        ok: false,
        reason: `CIRCLE_USDC_BLACKLISTED: Hot wallet ${sender} is blacklisted on ${this.chain} Circle USDC`,
      };
    }

    const calldata = encodeUsdcTransferCalldata(recipient, params.amountUnits6);

    try {
      const simHex = await this.callReadWithFallback<string>('eth_call', [
        {
          from: sender,
          to: this.usdcContractAddress,
          data: calldata,
        },
        'latest',
      ]);

      if (!simHex || simHex === '0x' || BigInt(simHex) === BigInt(0)) {
        return {
          ok: false,
          reason: `USDC transfer eth_call simulation returned false on ${this.chain}`,
        };
      }

      return { ok: true, calldata };
    } catch (simErr: unknown) {
      const msg = simErr instanceof Error ? simErr.message : String(simErr);
      return {
        ok: false,
        reason: `USDC transfer eth_call simulation reverted on ${this.chain}: ${msg}`,
      };
    }
  }

  /**
   * Query EIP-1559 fee parameters from L2 RPC with safe fallbacks.
   */
  async estimateGasParameters(calldata: Hex): Promise<{
    gasLimit: bigint;
    maxFeePerGas: bigint;
    maxPriorityFeePerGas: bigint;
    estimatedFeeUsd: number;
  }> {
    let gasLimit = DEFAULT_EVM_GAS_LIMIT;
    try {
      const gasHex = await this.callReadWithFallback<string>('eth_estimateGas', [
        {
          from: this.hotWalletAddress,
          to: this.usdcContractAddress,
          data: calldata,
        },
      ]);
      if (gasHex && gasHex !== '0x') {
        gasLimit = BigInt(gasHex);
      }
    } catch {
      gasLimit = DEFAULT_EVM_GAS_LIMIT;
    }

    let baseFee = DEFAULT_L2_BASE_FEE_WEI;
    let priorityFee = DEFAULT_L2_PRIORITY_FEE_WEI;

    try {
      const gasPriceHex = await this.callReadWithFallback<string>('eth_gasPrice', []);
      if (gasPriceHex && gasPriceHex !== '0x') {
        baseFee = BigInt(gasPriceHex);
      }
    } catch {
      baseFee = DEFAULT_L2_BASE_FEE_WEI;
    }

    try {
      const tipHex = await this.callReadWithFallback<string>('eth_maxPriorityFeePerGas', []);
      if (tipHex && tipHex !== '0x') {
        priorityFee = BigInt(tipHex);
      }
    } catch {
      priorityFee = DEFAULT_L2_PRIORITY_FEE_WEI;
    }

    const maxFeePerGas = baseFee * BigInt(2) + priorityFee;
    const feeWei = gasLimit * maxFeePerGas;
    const feeEthDec = new Decimal(feeWei.toString()).div(new Decimal(10).pow(18));
    const estimatedFeeUsd = feeEthDec
      .mul(this.ethPriceUsd)
      .toDecimalPlaces(6, Decimal.ROUND_DOWN)
      .toNumber();

    return {
      gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas: priorityFee,
      estimatedFeeUsd,
    };
  }

  /**
   * Build a deterministic EIP-1559 unsigned transfer transaction with an explicit assignedNonce.
   */
  async buildUnsignedTransfer(params: {
    recipientAddress: string;
    amountUnits1e8: bigint;
    assignedNonce: number;
    feeBumpBasisPoints?: number;
  }): Promise<EvmUnsignedTransferEnvelope> {
    assertMinimumWithdrawalFloor(params.amountUnits1e8);
    if (!Number.isInteger(params.assignedNonce) || params.assignedNonce < 0) {
      throw new Error(`Invalid assignedNonce: ${params.assignedNonce}`);
    }

    const amountUnits6 = ledgerUnits1e8ToEvmUsdcUnits(params.amountUnits1e8);
    const recipient = normalizeEvmAddress(params.recipientAddress);
    const calldata = encodeUsdcTransferCalldata(recipient, amountUnits6);
    const gasParams = await this.estimateGasParameters(calldata);

    const bumpBps = BigInt(params.feeBumpBasisPoints ?? 0);
    const multiplier = BigInt(10000) + bumpBps;
    const maxFeePerGas = (gasParams.maxFeePerGas * multiplier) / BigInt(10000);
    const maxPriorityFeePerGas = (gasParams.maxPriorityFeePerGas * multiplier) / BigInt(10000);

    const serializableTx: TransactionSerializableEIP1559 = {
      type: 'eip1559',
      chainId: this.chainId,
      nonce: params.assignedNonce,
      to: this.usdcContractAddress,
      value: BigInt(0),
      data: calldata,
      gas: gasParams.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };

    const unsignedSerializedHex = serializeTransaction(serializableTx);
    const signingDigestHex = keccak256(unsignedSerializedHex);

    return {
      chain: this.chain,
      chainId: this.chainId,
      usdcContract: this.usdcContractAddress,
      from: this.hotWalletAddress,
      recipient,
      amountUnits6,
      assignedNonce: params.assignedNonce,
      gasLimit: gasParams.gasLimit,
      maxFeePerGas,
      maxPriorityFeePerGas,
      calldata,
      unsignedSerializedHex,
      signingDigestHex,
      serializableTx,
    };
  }

  /**
   * Assemble signed EIP-1559 raw transaction hex and compute deterministic transaction hash.
   */
  assembleSignedTransaction(
    envelope: EvmUnsignedTransferEnvelope,
    signature: { r: Hex; s: Hex; yParity: 0 | 1 }
  ): { signedRawTxHex: Hex; txHash: Hex } {
    const signedRawTxHex = serializeTransaction(envelope.serializableTx, {
      r: signature.r,
      s: signature.s,
      yParity: signature.yParity,
    });
    const txHash = keccak256(signedRawTxHex);
    return { signedRawTxHex, txHash };
  }

  /**
   * Broadcast a signed raw EIP-1559 transaction via primary RPC (NOTE: does NOT blindly auto-retry
   * uncertain 504 timeouts across endpoints without going through BroadcastRecoveryMachine).
   */
  async broadcastSignedTransaction(signedRawTxHex: Hex): Promise<Hex> {
    const txHash = await this.primaryRpc.call<string>('eth_sendRawTransaction', [signedRawTxHex]);
    if (!txHash || typeof txHash !== 'string' || !txHash.startsWith('0x')) {
      throw new Error(`Invalid transaction hash returned from ${this.chain} RPC: ${String(txHash)}`);
    }
    return txHash as Hex;
  }

  /**
   * Query transaction receipt on-chain via primary/fallback RPC.
   */
  async getTransactionReceipt(txHash: string): Promise<EvmReceiptResult> {
    const receipt = await this.callReadWithFallback<{
      status?: string;
      blockNumber?: string;
      gasUsed?: string;
      effectiveGasPrice?: string;
    } | null>('eth_getTransactionReceipt', [txHash]);

    if (!receipt) {
      return {
        found: false,
        confirmed: false,
        reverted: false,
        transactionHash: txHash,
      };
    }

    const confirmed = receipt.status === '0x1' || receipt.status === '1';
    const reverted = receipt.status === '0x0' || receipt.status === '0';

    return {
      found: true,
      confirmed,
      reverted,
      blockNumber: receipt.blockNumber ? parseInt(receipt.blockNumber, 16) : undefined,
      gasUsed: receipt.gasUsed ? BigInt(receipt.gasUsed) : undefined,
      effectiveGasPrice: receipt.effectiveGasPrice ? BigInt(receipt.effectiveGasPrice) : undefined,
      transactionHash: txHash,
    };
  }

  /**
   * Query account transaction count (nonce) at 'latest' or 'pending'.
   */
  async getTransactionCount(
    address?: string,
    blockTag: 'latest' | 'pending' = 'latest'
  ): Promise<number> {
    const target = normalizeEvmAddress(address ?? this.hotWalletAddress);
    const hexCount = await this.callReadWithFallback<string>('eth_getTransactionCount', [
      target,
      blockTag,
    ]);
    return parseInt(hexCount || '0x0', 16);
  }

  /**
   * Query hot wallet USDC balance in exact 6-decimal integer units.
   */
  async getHotWalletUsdcBalanceUnits6(): Promise<bigint> {
    const hexBal = await this.callReadWithFallback<string>('eth_call', [
      {
        to: this.usdcContractAddress,
        data: encodeUsdcBalanceOfCalldata(this.hotWalletAddress),
      },
      'latest',
    ]);
    if (!hexBal || hexBal === '0x') {
      return BigInt(0);
    }
    return BigInt(hexBal);
  }
}
