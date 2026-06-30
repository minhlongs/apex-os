/**
 * Payouts Module
 * ApexOS Affiliate Cashback System
 *
 * Exports all payout-related functionality including
 * Stellar service, database service, types, and utilities.
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

// Type exports
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
