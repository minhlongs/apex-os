/**
 * src/lib/payouts/types.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Core Domain Types, Enums, and Interfaces
 */

// ============================================================================
// Core Enums & Const Arrays
// ============================================================================

export type SupportedPayoutChain = 'stellar' | 'ethereum' | 'solana';
export const SUPPORTED_PAYOUT_CHAINS: readonly SupportedPayoutChain[] = [
  'stellar',
  'ethereum',
  'solana',
] as const;

// Alias for cross-module compatibility
export type SupportedChain = SupportedPayoutChain;

export type PayoutStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'kyc_required'
  | 'compliance_blocked';

export const PAYOUT_STATUSES: readonly PayoutStatus[] = [
  'pending',
  'processing',
  'completed',
  'failed',
  'cancelled',
  'kyc_required',
  'compliance_blocked',
] as const;

export type BatchStatus =
  | 'pending'
  | 'processing'
  | 'completed'
  | 'partially_failed'
  | 'failed'
  | 'cancelled';

export const BATCH_STATUSES: readonly BatchStatus[] = [
  'pending',
  'processing',
  'completed',
  'partially_failed',
  'failed',
  'cancelled',
] as const;

export type AuditAction =
  | 'batch_execution'
  | 'approval'
  | 'override'
  | 'cancellation'
  | 'retry'
  | 'circuit_breaker_pause'
  | 'circuit_breaker_resume';

export const AUDIT_ACTIONS: readonly AuditAction[] = [
  'batch_execution',
  'approval',
  'override',
  'cancellation',
  'retry',
  'circuit_breaker_pause',
  'circuit_breaker_resume',
] as const;

export type HealthStatusLevel = 'HEALTHY' | 'LOW_RESERVE' | 'CRITICAL';
export const HEALTH_STATUS_LEVELS: readonly HealthStatusLevel[] = [
  'HEALTHY',
  'LOW_RESERVE',
  'CRITICAL',
] as const;

export type PayoutSupportedToken = 'USDC' | 'USDT';

// ============================================================================
// Database Record Entities
// ============================================================================

export interface PayoutRecord {
  id: string;
  affiliate_id: string;
  batch_id?: string | null;
  chain?: SupportedPayoutChain;
  payout_method: string;
  payout_method_details: string;
  amount: number;
  currency: string;
  fee: number;
  net_amount: number;
  status: PayoutStatus;
  scheduled_at: string | null;
  paid_at: string | null;
  transaction_id: string | null;
  idempotency_key?: string | null;
  gas_fee_native?: number;
  gas_fee_usd?: number;
  error_message?: string | null;
  retry_count?: number;
  last_retried_at?: string | null;
  compliance_status?: 'clean' | 'pending_review' | 'kyc_required' | 'compliance_blocked' | 'approved' | 'rejected';
  compliance_reason?: string | null;
  notes: string | null;
  metadata: string | null;
  created_at: string;
  updated_at: string;
}

export interface PayoutBatchRecord {
  id: string;
  batch_number: string;
  status: BatchStatus;
  chain: SupportedPayoutChain | null;
  total_payouts: number;
  successful_payouts: number;
  failed_payouts: number;
  total_amount: number;
  total_fee: number;
  total_gas_fee_usd: number;
  executed_by: string | null;
  dry_run: number;
  scheduled_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  metadata: string;
  created_at: string;
  updated_at: string;
}

export interface PayoutAuditLogRecord {
  id: string;
  batch_id: string | null;
  payout_id: string | null;
  action: AuditAction;
  admin_id: string | null;
  admin_email: string | null;
  chain: SupportedPayoutChain | null;
  details: string;
  ip_address: string | null;
  created_at: string;
}

export interface PayoutAuditLogInput {
  id?: string;
  batch_id?: string | null;
  payout_id?: string | null;
  action: AuditAction;
  admin_id?: string | null;
  admin_email?: string | null;
  chain?: SupportedPayoutChain | null;
  details?: Record<string, unknown> | string;
  ip_address?: string | null;
  created_at?: string;
}

export interface PayoutAuditLogFilter {
  batch_id?: string;
  payout_id?: string;
  action?: AuditAction;
  chain?: SupportedPayoutChain;
  admin_id?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedAuditLogs {
  data: PayoutAuditLogRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// Fee Estimation & Execution Parameters
// ============================================================================

export interface FeeEstimateParams {
  chain: SupportedPayoutChain;
  recipientAddress: string;
  amount: number;
  token?: PayoutSupportedToken;
}

export interface ChainFeeEstimate {
  chain: SupportedPayoutChain;
  nativeFeeAmount: number;     // in ETH, SOL, or XLM
  nativeFeeSymbol: string;     // 'ETH', 'SOL', 'XLM'
  feeUsd: number;              // Estimated USD value
  gasUnitsOrLimit: number;     // Gas limit (EVM), CU (Solana), stroops (Stellar)
  pricePerUnit: string;        // Gwei, micro-lamports, stroops
  isCongested?: boolean;
  estimatedAt?: string;
}

export interface PayoutExecutionParams {
  payoutId: string;
  batchId?: string | null;
  affiliateId: string;
  recipientAddress: string;
  amount: number;
  token?: PayoutSupportedToken;
  idempotencyKey: string;
  memo?: string;
}

export interface PayoutExecutionResult {
  success: boolean;
  payoutId: string;
  chain: SupportedPayoutChain;
  transactionId?: string | null;
  fromAddress?: string;
  toAddress: string;
  amount: number;
  token: string;
  gasFeeNative?: number;
  gasFeeUsd?: number;
  nativeFeeSymbol?: string;
  status: 'submitted' | 'confirmed' | 'failed';
  blockNumberOrSlot?: number;
  explorerUrl?: string;
  error?: string | null;
  timestamp?: string;
}

export interface TransactionVerificationResult {
  verified: boolean;
  status: 'confirmed' | 'failed' | 'pending' | 'not_found';
  transactionId: string;
  confirmations?: number;
  blockNumberOrSlot?: number;
  feePaidNative?: number;
  feePaidUsd?: number;
  reason?: string;
  timestamp?: string;
}

export interface TreasuryBalanceResult {
  chain: SupportedPayoutChain;
  hotWalletAddress: string;
  nativeBalance: number;       // ETH, SOL, or XLM
  nativeSymbol: string;        // 'ETH', 'SOL', or 'XLM'
  nativeBalanceUsd?: number;
  tokenBalances: Record<string, number>; // e.g. { USDC: 1500.5, USDT: 250.0 }
  totalUsdValue?: number;
  lastUpdated: string;
}

// ============================================================================
// Treasury Health Monitoring
// ============================================================================

export interface ChainTreasuryHealth {
  chain: SupportedPayoutChain;
  status: HealthStatusLevel;
  hotWalletAddress: string;
  nativeGasBalance: number;
  nativeGasSymbol: string;
  nativeGasFloor: number;
  stablecoinBalance: number;
  stablecoinReserveFloor: number;
  rpcHealthy: boolean;
  message?: string;
}

export interface TreasuryHealthReport {
  globalStatus: HealthStatusLevel;
  chains: Record<SupportedPayoutChain, ChainTreasuryHealth>;
  canSettle: boolean;
  checkedAt: string;
  warnings: string[];
  errors: string[];
}

export interface TreasuryHealthService {
  checkHealth(chain?: SupportedPayoutChain): Promise<TreasuryHealthReport>;
  canSettle(amountUsd: number, chain: SupportedPayoutChain): Promise<{ allowed: boolean; reason?: string }>;
}

// ============================================================================
// Chain Adapter Interface
// ============================================================================

export interface PayoutChainAdapter {
  readonly chain: SupportedPayoutChain;
  validateAddress(address: string): boolean;
  estimateFee(params: FeeEstimateParams): Promise<ChainFeeEstimate>;
  sendPayout(params: PayoutExecutionParams): Promise<PayoutExecutionResult>;
  verifyTransaction(transactionId: string): Promise<TransactionVerificationResult>;
  getTreasuryBalance(): Promise<TreasuryBalanceResult>;
}

// ============================================================================
// Batch Settlement & Retry Options
// ============================================================================

export interface BatchSettlementOptions {
  chain?: SupportedPayoutChain | 'all';
  minThreshold?: number;
  dryRun?: boolean;
  adminId?: string | null;
  adminEmail?: string | null;
  ipAddress?: string | null;
  scheduledAt?: string | null;
  limit?: number;
}

export type BatchPreviewOptions = BatchSettlementOptions;
export type BatchExecutionOptions = BatchSettlementOptions;

export interface BatchPreviewItem {
  affiliateId: string;
  recipientAddress: string;
  chain: SupportedPayoutChain;
  earningIds: string[];
  earningsCount: number;
  grossAmount: number;
  fee: number;
  netAmount: number;
  estimatedGasFeeUsd: number;
  complianceStatus?: 'clean' | 'pending_review' | 'kyc_required' | 'compliance_blocked' | 'approved' | 'rejected';
  complianceReason?: string;
  kycTier?: string;
  cumulative30dVolume?: number;
}

export interface BatchPreviewResult {
  batchNumber: string;
  chain?: SupportedPayoutChain | 'all';
  eligibleAffiliatesCount: number;
  totalEarningsCount: number;
  totalAmountUsd: number;
  totalFeeUsd: number;
  totalNetAmountUsd: number;
  totalEstimatedGasFeeUsd: number;
  byChain: Record<
    SupportedPayoutChain,
    {
      affiliateCount: number;
      totalAmount: number;
      estimatedGasFeeUsd: number;
    }
  >;
  treasuryHealth: TreasuryHealthReport;
  canExecute: boolean;
  blockingReasons?: string[];
  payoutsPreview: BatchPreviewItem[];
}

export interface BatchExecutionResult {
  batchId: string;
  batchNumber: string;
  status: BatchStatus;
  chain?: SupportedPayoutChain | null;
  totalPayouts: number;
  successfulPayouts: number;
  failedPayouts: number;
  totalAmount: number;
  totalFee: number;
  totalGasFeeUsd: number;
  dryRun: boolean;
  startedAt: string;
  completedAt?: string | null;
  payouts: PayoutExecutionResult[];
  errors?: string[];
}

export interface RetryOptions {
  refreshFee?: boolean;
  adminId?: string | null;
  adminEmail?: string | null;
  ipAddress?: string | null;
  reason?: string;
  force?: boolean;
}

export interface BatchSettlementService {
  previewBatch(options?: BatchPreviewOptions): Promise<BatchPreviewResult>;
  executeBatch(options?: BatchExecutionOptions): Promise<BatchExecutionResult>;
  retryPayout(payoutId: string, options?: RetryOptions): Promise<PayoutExecutionResult>;
}
