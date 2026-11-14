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
export {
  classifyHistoricalPayoutRow,
  reconcileHistoricalPayouts,
} from './reconcile-historical-payouts';
export type {
  HistoricalPayoutAnomalyReason,
  HistoricalPayoutRow,
  FlaggedHistoricalPayout,
  OrphanedPaidEarningRow,
  HistoricalPayoutReconciliationReport,
} from './reconcile-historical-payouts';

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

// Phase 1 Audited Multichain Settlement, Turnkey HSM Isolation & Broadcast Recovery
export {
  ArbitrumBaseUsdcAdapter,
  CANONICAL_ARBITRUM_NATIVE_USDC,
  CANONICAL_BASE_NATIVE_USDC,
  CIRCLE_IS_BLACKLISTED_SELECTOR,
  EVM_USDC_DECIMALS,
  MIN_WITHDRAWAL_UNITS_1E8,
  assertPhase1ChainEnabled,
  ledgerUnits1e8ToEvmUsdcUnits,
} from './adapters/arbitrum-base-usdc-adapter';
export type {
  Phase1SettlementChain,
  EvmPhase1SettlementChain,
  LegacyDisabledSettlementChain,
  EvmJsonRpcTransport,
} from './adapters/arbitrum-base-usdc-adapter';
export {
  TurnkeySigner,
  TurnkeyServerHsmTransport,
  attachEd25519SignatureToStellarEnvelopeXdr,
  HOT_WALLET_SINGLE_TX_CAP_UNITS_1E8,
  HOT_WALLET_ROLLING_24H_CAP_UNITS_1E8,
  COLD_SAFE_MIN_RESERVE_BPS,
} from './turnkey-signer';
export { HorizonStellarBroadcastTransport } from './stellar-horizon-transport';
export { BroadcastRecoveryMachine } from './broadcast-recovery-machine';
export type {
  SettlementBroadcastState,
  SettlementBroadcastRow,
  StellarBroadcastTransport,
} from './broadcast-recovery-machine';
export {
  evaluateUsdcPegBand,
  enforceUsdcPegCircuitBreaker,
  assertPreSigningSafetyGuards,
  USDC_PEG_MIN_BOUND_STR,
  USDC_PEG_MAX_BOUND_STR,
} from './usdc-safety-guards';
