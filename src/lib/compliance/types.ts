/**
 * src/lib/compliance/types.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Core Domain Types, Enums, Interfaces, and Tier Limit Rules
 */

import type { SupportedPayoutChain } from '../payouts/types';
import type { D1Database, D1PreparedStatement } from '../db';

// ============================================================================
// KYC Tiers & Statuses
// ============================================================================

export type KycTier = 'tier0_unverified' | 'tier1_basic' | 'tier2_enhanced';

export const KYC_TIERS: readonly KycTier[] = [
  'tier0_unverified',
  'tier1_basic',
  'tier2_enhanced',
] as const;

export type KycStatus =
  | 'unverified'
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'requires_action';

export const KYC_STATUSES: readonly KycStatus[] = [
  'unverified',
  'pending',
  'approved',
  'rejected',
  'requires_action',
] as const;

export type ComplianceStatus =
  | 'clean'
  | 'pending_review'
  | 'kyc_required'
  | 'compliance_blocked'
  | 'approved'
  | 'rejected';

export const COMPLIANCE_STATUSES: readonly ComplianceStatus[] = [
  'clean',
  'pending_review',
  'kyc_required',
  'compliance_blocked',
  'approved',
  'rejected',
] as const;

// ============================================================================
// Tier Limits (Rolling 30-Day USD Ceilings)
// ============================================================================

export const KYC_TIER_LIMITS: Record<KycTier, number> = {
  tier0_unverified: 500.0,    // $500.00 USD per rolling 30 days
  tier1_basic: 2500.0,        // $2,500.00 USD per rolling 30 days
  tier2_enhanced: 50000.0,    // $50,000.00 USD per rolling 30 days
};

/**
 * Resolve 30-day cumulative payout ceiling for a given KYC tier
 */
export function getKycTierLimit(tier?: KycTier | string | null): number {
  if (!tier) return KYC_TIER_LIMITS.tier0_unverified;
  if (tier in KYC_TIER_LIMITS) {
    return KYC_TIER_LIMITS[tier as KycTier];
  }
  // Fallbacks for alternative naming conventions
  if (tier === 'tier0' || tier === 'unverified') return KYC_TIER_LIMITS.tier0_unverified;
  if (tier === 'tier1' || tier === 'basic') return KYC_TIER_LIMITS.tier1_basic;
  if (tier === 'tier2' || tier === 'enhanced') return KYC_TIER_LIMITS.tier2_enhanced;
  return KYC_TIER_LIMITS.tier0_unverified;
}

/**
 * Check whether a pending payout would breach the 30-day rolling ceiling
 */
export function isTierLimitExceeded(
  cumulative30d: number,
  pendingAmount: number,
  tier?: KycTier | string | null
): boolean {
  const limit = getKycTierLimit(tier);
  // Calculate total in cents to prevent floating point inaccuracies
  const totalCents = Math.round(cumulative30d * 100) + Math.round(pendingAmount * 100);
  const limitCents = Math.round(limit * 100);
  return totalCents > limitCents;
}

// ============================================================================
// Compliance Audit Logging
// ============================================================================

export type ComplianceAuditAction =
  | 'kyc_tier_hold'
  | 'sanctions_block'
  | 'admin_override'
  | 'admin_reject'
  | 'admin_flag_address'
  | 'kyc_auto_release'
  | 'kyc_initiated';

export const COMPLIANCE_AUDIT_ACTIONS: readonly ComplianceAuditAction[] = [
  'kyc_tier_hold',
  'sanctions_block',
  'admin_override',
  'admin_reject',
  'admin_flag_address',
  'kyc_auto_release',
  'kyc_initiated',
] as const;

export type ComplianceAuditSeverity = 'low' | 'medium' | 'high' | 'critical';

export const COMPLIANCE_AUDIT_SEVERITIES: readonly ComplianceAuditSeverity[] = [
  'low',
  'medium',
  'high',
  'critical',
] as const;

export interface ComplianceAuditEntry {
  action: ComplianceAuditAction;
  severity: ComplianceAuditSeverity;
  actorId?: string | null;
  targetId?: string | null;
  details: Record<string, unknown> | string;
}

export interface ComplianceAuditLogRecord {
  id: string;
  action: ComplianceAuditAction;
  severity: ComplianceAuditSeverity;
  actor_id: string | null;
  target_id: string | null;
  details: string;
  created_at: string;
}

export interface ComplianceAuditLogFilter {
  action?: ComplianceAuditAction;
  severity?: ComplianceAuditSeverity;
  targetId?: string;
  actorId?: string;
  startDate?: string;
  endDate?: string;
  page?: number;
  limit?: number;
}

export interface PaginatedComplianceAuditLogs {
  data: ComplianceAuditLogRecord[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

// ============================================================================
// Sanctions & Watchlist Screening
// ============================================================================

export interface SanctionsCheckResult {
  isSanctioned: boolean;
  reason?: string;
  source?: string;
  riskScore?: number;
  matchedAddress?: string;
}

export interface SanctionedAddressRecord {
  address: string;
  chain: SupportedPayoutChain;
  source: string | null;
  risk_score: number;
  added_at: string;
}

// ============================================================================
// Compliance Verification & Evaluation
// ============================================================================

export interface ComplianceCheckResult {
  allowed: boolean;
  held: boolean;
  complianceStatus: ComplianceStatus;
  reason?: string;
  cumulative30d: number;
  pendingAmount: number;
  tierLimit: number;
  currentTier: KycTier;
}

// ============================================================================
// Service Interfaces
// ============================================================================

export interface IComplianceAuditService {
  log(db: D1Database, entry: ComplianceAuditEntry): Promise<void>;
  createAuditStatement(db: D1Database, entry: ComplianceAuditEntry): D1PreparedStatement;
  getAuditLogs(
    db: D1Database,
    filter?: ComplianceAuditLogFilter
  ): Promise<PaginatedComplianceAuditLogs>;
}

export interface ISanctionsScreeningService {
  checkAddress(
    address: string,
    chain: SupportedPayoutChain,
    db?: D1Database
  ): Promise<SanctionsCheckResult>;
  normalizeAddress(address: string, chain: SupportedPayoutChain): string;
  addSanctionedAddress(
    db: D1Database,
    entry: {
      address: string;
      chain: SupportedPayoutChain;
      source?: string;
      riskScore?: number;
    }
  ): Promise<void>;
}
