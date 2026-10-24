/**
 * Payouts Module
 * ApexOS Affiliate Cashback System
 *
 * Exports all payout-related functionality including
 * Stellar service, database service, multi-chain batch settlement, types, and utilities.
 */

export * from './payouts-service';
// Export specific members from stellar-service, avoiding conflict with PayoutRecord (from payouts-service)

// Value exports
export {
  USDC_CONFIG,
  createStellarService,
  isValidStellarAccountId,
  parseStellarAmount,
} from './stellar-service';

// Multi-Chain Batch Settlement Service (Milestone 4)
export {
  BatchSettlementService,
  batchSettlementService,
  toCents,
  fromCents,
  generateBatchNumber,
  generatePayoutIdempotencyKey,
  generateRetryIdempotencyKey,
} from './batch-settlement-service';
export type { BatchSettlementServiceDependencies } from './batch-settlement-service';

// Multi-Chain Routing, Treasury, and Audit Services
export { PayoutRouter, payoutRouter } from './router';
export { confirmOnChain, isSettled, CONFIRMED_STATUSES } from './settlement-gate';
export type { SettlementVerdict, ConfirmOnChainParams } from './settlement-gate';
export {
  TreasuryHealthService,
  treasuryHealthService,
} from './treasury-health-service';
export type { CanSettleResult } from './treasury-health-service';
export { PayoutAuditService, createAuditStatement, payoutAuditService } from './audit-service';

// Multi-Chain Types
export type {
  SupportedPayoutChain,
  PayoutStatus,
  BatchStatus,
  AuditAction,
  HealthStatusLevel,
  PayoutChainAdapter,
  FeeEstimateParams,
  ChainFeeEstimate,
  PayoutExecutionParams,
  PayoutExecutionResult,
  TransactionVerificationResult,
  TreasuryBalanceResult,
  BatchSettlementOptions,
  BatchPreviewOptions,
  BatchExecutionOptions,
  BatchPreviewItem,
  BatchPreviewResult,
  BatchExecutionResult,
  RetryOptions,
  ChainTreasuryHealth,
  TreasuryHealthReport,
  PayoutBatchRecord,
  PayoutAuditLogRecord,
  PayoutAuditLogInput,
  PayoutAuditLogFilter,
  PaginatedAuditLogs,
} from './types';

// Type exports from stellar-service
export type {
  StellarAccount,
  StellarBalance,
  PayoutResult,
  BatchPayoutResult,
  PayoutJobStatus,
  StellarServiceConfig,
  PayoutDatabase,
  PendingEarning,
  AffiliateInfo,
  StellarService,
} from './stellar-service';
