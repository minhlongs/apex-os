/**
 * ApexOS Fraud Detection & Anomaly Engine Type Definitions
 * Location: src/types/fraud.ts
 *
 * Comprehensive contracts covering:
 * 1. Reason codes enum/union (BURST_CLICK, HIGH_CLICK_CONVERSION_RATIO, etc.)
 * 2. Review actions union (approve, reject, block_ip, bulk_resolve)
 * 3. Database record interfaces (BlockedIpRecord, FraudReviewRecord, DealClickFraudExtension)
 * 4. Rate limiter configuration and result types (RateLimitResult, RateLimitConfig)
 * 5. Velocity check input & result types (ClickVelocityInput, VelocityCheckResult)
 * 6. Admin API request & response types
 *
 * 100% strict TypeScript typing with zero 'any' types.
 */

import { z } from 'zod';
import type { DealClick } from './tracking';
import type { D1Database } from './d1';

// ============================================================================
// 1. REASON CODES ENUM & UNIONS
// ============================================================================

/**
 * Standardized reason codes for suspicious click and anomaly detection
 */
export enum FraudReasonCode {
  /** Rapid sequential clicks (<2s delta) from same IP/session/affiliate */
  BURST_CLICK = 'BURST_CLICK',
  /** Click flooding: ratio of clicks to conversions exceeds threshold (>10:1) */
  HIGH_CLICK_CONVERSION_RATIO = 'HIGH_CLICK_CONVERSION_RATIO',
  /** Conversion replay attack: ratio of conversions to clicks exceeds threshold (>10:1) */
  ABNORMAL_CONVERSION_RATIO = 'ABNORMAL_CONVERSION_RATIO',
  /** Request rate exceeded dual-window limits (100 clicks/hr or 1,000 clicks/day) */
  RATE_LIMIT_EXCEEDED = 'RATE_LIMIT_EXCEEDED',
  /** Backward-compatible alias for rate limit exceedance */
  IP_RATE_LIMIT_EXCEEDED = 'IP_RATE_LIMIT_EXCEEDED',
  /** Ingestion request originated from an actively blacklisted IP address */
  BLOCKED_IP = 'BLOCKED_IP',
  /** User agent matched known scrapers/bots or was anomalous/missing */
  SUSPICIOUS_USER_AGENT = 'SUSPICIOUS_USER_AGENT',
  /** Repetitive click activity originating from identical session cookie */
  RAPID_IDENTICAL_SESSION = 'RAPID_IDENTICAL_SESSION',
  /** IP address automatically blocked due to repeated rate limit violations */
  AUTO_BLOCKED_REPEAT_OFFENDER = 'AUTO_BLOCKED_REPEAT_OFFENDER',
  /** Flagged manually by platform administrator during audit review */
  MANUAL_FLAG = 'MANUAL_FLAG',
}

/**
 * Immutable const array of all valid fraud reason codes
 */
export const FRAUD_REASON_CODES = [
  'BURST_CLICK',
  'HIGH_CLICK_CONVERSION_RATIO',
  'ABNORMAL_CONVERSION_RATIO',
  'RATE_LIMIT_EXCEEDED',
  'IP_RATE_LIMIT_EXCEEDED',
  'BLOCKED_IP',
  'SUSPICIOUS_USER_AGENT',
  'RAPID_IDENTICAL_SESSION',
  'AUTO_BLOCKED_REPEAT_OFFENDER',
  'MANUAL_FLAG',
] as const;

/** String literal union representing valid fraud reason codes */
export type FraudReasonCodeUnion = (typeof FRAUD_REASON_CODES)[number];

/** Generalized reason code type accepting enum value or string literal */
export type ReasonCode = FraudReasonCode | FraudReasonCodeUnion;

/**
 * Type guard for ReasonCode
 */
export function isFraudReasonCode(value: unknown): value is ReasonCode {
  if (typeof value !== 'string') return false;
  return (FRAUD_REASON_CODES as readonly string[]).includes(value);
}

export type FraudSeverity = 'low' | 'medium' | 'high' | 'critical';

export interface FraudReasonMetadata {
  code: FraudReasonCodeUnion;
  label: string;
  description: string;
  severity: FraudSeverity;
  defaultScore: number;
}

export const FRAUD_REASON_METADATA: Readonly<Record<FraudReasonCodeUnion, FraudReasonMetadata>> = {
  BURST_CLICK: {
    code: 'BURST_CLICK',
    label: 'Rapid Multi-Click Burst',
    description: 'Multiple clicks received within <2 seconds from the same IP, session, or identity.',
    severity: 'high',
    defaultScore: 0.75,
  },
  HIGH_CLICK_CONVERSION_RATIO: {
    code: 'HIGH_CLICK_CONVERSION_RATIO',
    label: 'Abnormal Click Flooding',
    description: 'Click-to-conversion ratio exceeds 10:1, indicating attribution hijacking.',
    severity: 'high',
    defaultScore: 0.70,
  },
  ABNORMAL_CONVERSION_RATIO: {
    code: 'ABNORMAL_CONVERSION_RATIO',
    label: 'Conversion Replay Anomaly',
    description: 'Conversions-to-click ratio exceeds 10:1, indicating conversion stuffing or replay.',
    severity: 'critical',
    defaultScore: 0.90,
  },
  RATE_LIMIT_EXCEEDED: {
    code: 'RATE_LIMIT_EXCEEDED',
    label: 'Click Rate Limit Exceeded',
    description: 'Request exceeded maximum rate limits (100 clicks/hour or 1,000 clicks/day).',
    severity: 'medium',
    defaultScore: 0.60,
  },
  IP_RATE_LIMIT_EXCEEDED: {
    code: 'IP_RATE_LIMIT_EXCEEDED',
    label: 'IP Rate Limit Exceeded',
    description: 'IP address exceeded rate limit thresholds for click tracking.',
    severity: 'medium',
    defaultScore: 0.60,
  },
  BLOCKED_IP: {
    code: 'BLOCKED_IP',
    label: 'Blacklisted IP Traffic',
    description: 'Request originated from an IP address currently active in the blocked_ips table.',
    severity: 'critical',
    defaultScore: 1.00,
  },
  SUSPICIOUS_USER_AGENT: {
    code: 'SUSPICIOUS_USER_AGENT',
    label: 'Suspicious User Agent',
    description: 'User agent matched known crawler patterns, headless browsers, or was malformed.',
    severity: 'low',
    defaultScore: 0.35,
  },
  RAPID_IDENTICAL_SESSION: {
    code: 'RAPID_IDENTICAL_SESSION',
    label: 'Session Flood Anomaly',
    description: 'Rapid sequential clicks using the exact same session tracking token.',
    severity: 'medium',
    defaultScore: 0.65,
  },
  AUTO_BLOCKED_REPEAT_OFFENDER: {
    code: 'AUTO_BLOCKED_REPEAT_OFFENDER',
    label: 'Auto-Blocked Repeat Offender',
    description: 'IP automatically added to blacklist due to repeated consecutive violations.',
    severity: 'critical',
    defaultScore: 1.00,
  },
  MANUAL_FLAG: {
    code: 'MANUAL_FLAG',
    label: 'Administrator Manual Flag',
    description: 'Flagged manually by platform administrator during investigation or audit.',
    severity: 'medium',
    defaultScore: 0.50,
  },
};

// ============================================================================
// 2. REVIEW ACTIONS & WORKFLOW LIFECYCLE
// ============================================================================

export const FRAUD_REVIEW_ACTIONS = [
  'approve',
  'reject',
  'block_ip',
  'unblock_ip',
  'bulk_resolve',
  'bulk_approve',
  'bulk_reject',
  'dismiss',
] as const;

export type FraudReviewAction = (typeof FRAUD_REVIEW_ACTIONS)[number];

export function isFraudReviewAction(value: unknown): value is FraudReviewAction {
  if (typeof value !== 'string') return false;
  return (FRAUD_REVIEW_ACTIONS as readonly string[]).includes(value);
}

export const CLICK_REVIEW_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'ignored',
] as const;

export type ClickReviewStatus = (typeof CLICK_REVIEW_STATUSES)[number];

export function isClickReviewStatus(value: unknown): value is ClickReviewStatus {
  if (typeof value !== 'string') return false;
  return (CLICK_REVIEW_STATUSES as readonly string[]).includes(value);
}

// ============================================================================
// 3. DATABASE RECORD INTERFACES (CLOUDFLARE D1)
// ============================================================================

/**
 * Fraud detection extension columns added to deal_clicks table in migration 021
 */
export interface DealClickFraudExtension {
  /** 0 = clean, 1 = flagged suspicious */
  is_suspicious: number;
  /** Quantitative anomaly score between 0.0 and 1.0 */
  anomaly_score?: number | null;
  /** JSON array string e.g. '["BURST_CLICK"]' */
  flag_reasons: string | null;
  /** Review status: 'pending' | 'approved' | 'rejected' | 'ignored' */
  review_status?: ClickReviewStatus | string | null;
  /** Timestamp of review resolution */
  reviewed_at?: string | null;
  /** Profile ID of reviewer */
  reviewed_by?: string | null;
}

/**
 * Complete D1 database row for deal_clicks including tracking columns & fraud extensions
 */
export interface DealClickRow extends DealClickFraudExtension {
  id: string;
  deal_id: string;
  affiliate_code: string | null;
  affiliate_id: string | null;
  session_id: string;
  ip_address: string | null;
  user_agent: string | null;
  referrer_url: string | null;
  country_code: string | null;
  device_type: string | null;
  click_type: 'link' | 'banner' | 'email' | 'social' | 'qr' | string;
  is_unique: number;
  created_at: string;
}

/**
 * Raw Cloudflare D1 database record for the blocked_ips table
 */
export interface BlockedIpRecord {
  id: string;
  ip_address: string;
  reason: string;
  blocked_by: string;
  blocked_at?: string;
  created_at?: string;
  updated_at?: string;
  expires_at: string | null;
  is_active: number;
  metadata?: string | null;
}

/**
 * Parsed application-layer model for blocked IP
 */
export interface HydratedBlockedIp {
  id: string;
  ipAddress: string;
  reason: string;
  blockedBy: string;
  blockedAt: string;
  expiresAt: string | null;
  isActive: boolean;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/**
 * Raw Cloudflare D1 database record for the immutable fraud_reviews audit log
 */
export interface FraudReviewRecord {
  id: string;
  click_id: string | null;
  ip_address: string | null;
  reviewer_id?: string | null;
  reviewed_by?: string | null;
  reviewer_email?: string | null;
  action_type?: FraudReviewAction | string;
  action: FraudReviewAction | string;
  reason: string;
  previous_status?: ClickReviewStatus | string | null;
  new_status?: ClickReviewStatus | string | null;
  anomaly_score?: number | null;
  flag_reasons?: string | null;
  details?: string | null;
  metadata?: string | null;
  reviewed_at?: string | null;
  created_at: string;
}

/**
 * Parsed application-layer model for immutable audit review
 */
export interface HydratedFraudReview {
  id: string;
  clickId: string | null;
  ipAddress: string | null;
  reviewerId: string;
  reviewerEmail: string | null;
  action: FraudReviewAction;
  reason: string;
  previousStatus: ClickReviewStatus | null;
  newStatus: ClickReviewStatus | null;
  anomalyScore: number | null;
  flagReasons: ReasonCode[];
  metadata: Record<string, unknown>;
  createdAt: string;
}

// ============================================================================
// 4. RATE LIMITER CONFIGURATION & RESULT TYPES
// ============================================================================

export interface RateLimitConfig {
  endpointType: string;
  maxRequests: number;
  windowSeconds: number;
  appliesTo: 'ip' | 'user' | 'api_key' | 'combined';
  roleMultiplier: number;
  tierMultiplier: number;
  description?: string;
  isActive: boolean;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: Date;
  limit: number;
  retryAfter: number;
  identifierUsed: string;
  isNearLimit: boolean;
}

export interface DualWindowRateLimitConfig {
  endpointType: string;
  hourlyLimit: number;
  hourlyWindowSeconds: number;
  dailyLimit: number;
  dailyWindowSeconds: number;
  autoBlockThreshold: number;
  autoBlockDurationSeconds: number | null;
}

export interface DualWindowRateLimitResult {
  allowed: boolean;
  hourlyRemaining: number;
  dailyRemaining: number;
  hourlyLimit: number;
  dailyLimit: number;
  hourlyResetAt: number;
  dailyResetAt: number;
  retryAfter: number;
  exceededWindow: 'hourly' | 'daily' | null;
  isBlocked: boolean;
  autoBlocked: boolean;
  reason: string | null;
}

export interface RateLimitHeaders {
  'Retry-After'?: string;
  'X-RateLimit-Limit': string;
  'X-RateLimit-Remaining': string;
  'X-RateLimit-Reset': string;
  'X-RateLimit-Reset-After'?: string;
}

// ============================================================================
// 5. VELOCITY ANOMALY ENGINE TYPES
// ============================================================================

export interface ClickVelocityInput {
  dealId: string;
  affiliateCode: string | null;
  affiliateId: string | null;
  sessionId: string;
  ipAddress: string | null;
  userAgent?: string | null;
  referrerUrl?: string | null;
  countryCode?: string | null;
  deviceType?: string | null;
  timestamp?: number | Date | string;
}

export interface VelocityCheckThresholds {
  burstWindowMs: number;
  minClicksForRatioCheck: number;
  maxClickToConversionRatio: number;
  maxConversionToClickRatio: number;
  lookbackWindowSeconds: number;
}

export interface BurstDetectionDetails {
  previousClickId: string;
  previousClickTimestamp: string;
  deltaMs: number;
  matchedBy: 'ip' | 'session' | 'affiliate';
}

export interface RatioAnomalyDetails {
  affiliateCode: string | null;
  dealId: string;
  totalClicks: number;
  totalConversions: number;
  clickToConvRatio: number;
  convToClickRatio: number;
  lookbackWindowHours: number;
}

export interface VelocityCheckResult {
  isSuspicious: boolean;
  anomalyScore: number;
  flagReasons: ReasonCode[];
  burstDetected: boolean;
  burstDetails?: BurstDetectionDetails;
  ratioAnomalyDetected: boolean;
  ratioDetails?: RatioAnomalyDetails;
  rateLimitViolated: boolean;
  isIpBlocked: boolean;
}

// ============================================================================
// 6. ADMIN API CONTRACTS & PAYLOADS
// ============================================================================

export interface AdminFraudClicksQueryParams {
  page?: number;
  limit?: number;
  startDate?: string;
  endDate?: string;
  reason?: ReasonCode | string;
  affiliateCode?: string;
  dealId?: string;
  isSuspicious?: boolean | number;
  reviewStatus?: ClickReviewStatus | string;
  ipAddress?: string;
  sortBy?: 'created_at' | 'anomaly_score';
  sortOrder?: 'asc' | 'desc';
}

export interface FlaggedClickDetail {
  id: string;
  dealId: string;
  dealName?: string;
  affiliateCode: string | null;
  affiliateId: string | null;
  affiliateEmail?: string | null;
  sessionId: string;
  ipAddress: string | null;
  isIpBlocked: boolean;
  userAgent: string | null;
  referrerUrl: string | null;
  countryCode: string | null;
  deviceType: string | null;
  isSuspicious: boolean;
  anomalyScore: number;
  flagReasons: ReasonCode[];
  reviewStatus: ClickReviewStatus;
  reviewedAt: string | null;
  reviewedBy: string | null;
  createdAt: string;
}

export interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

export interface AdminFraudClicksResponse {
  success: boolean;
  data: FlaggedClickDetail[];
  pagination: PaginationMeta;
  error?: string;
}

export interface FraudStatsSummary {
  totalClicksEvaluated: number;
  totalFlaggedClicks: number;
  flaggedPercentage: number;
  totalBlockedIps: number;
  pendingReviews: number;
  approvedReviews: number;
  rejectedReviews: number;
  burstClicksCount: number;
  ratioAnomaliesCount: number;
  rateLimitViolationsCount: number;
  topFlaggedAffiliates: Array<{
    affiliateCode: string;
    flaggedCount: number;
  }>;
  topFlaggedIps: Array<{
    ipAddress: string;
    flaggedCount: number;
  }>;
}

export interface AdminFraudStatsResponse {
  success: boolean;
  data: FraudStatsSummary;
  error?: string;
}

// Discriminated Union for Admin Actions
export interface BaseActionPayload {
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface ApproveClickActionPayload extends BaseActionPayload {
  action: 'approve';
  clickId: string;
}

export interface RejectClickActionPayload extends BaseActionPayload {
  action: 'reject';
  clickId: string;
  blockIpAlso?: boolean;
}

export interface BlockIpActionPayload extends BaseActionPayload {
  action: 'block_ip';
  ipAddress: string;
  clickId?: string | null;
  expiresAt?: string | null;
}

export interface UnblockIpActionPayload extends BaseActionPayload {
  action: 'unblock_ip';
  ipAddress: string;
}

export interface BulkResolveActionPayload extends BaseActionPayload {
  action: 'bulk_resolve' | 'bulk_approve' | 'bulk_reject';
  clickIds: string[];
  resolution?: 'approve' | 'reject';
  blockIpAlso?: boolean;
}

export interface DismissClickActionPayload extends BaseActionPayload {
  action: 'dismiss';
  clickId: string;
}

export type AdminFraudActionRequest =
  | ApproveClickActionPayload
  | RejectClickActionPayload
  | BlockIpActionPayload
  | UnblockIpActionPayload
  | BulkResolveActionPayload
  | DismissClickActionPayload;

export interface AdminFraudActionResponse {
  success: boolean;
  affectedCount: number;
  auditIds: string[];
  message?: string;
  error?: string;
}

export interface GetBlockedIpsQueryParams {
  page?: number;
  limit?: number;
  activeOnly?: boolean;
  search?: string;
}

export interface BlockedIpDetailItem {
  id: string;
  ipAddress: string;
  reason: string;
  blockedBy: string;
  blockedAt: string;
  expiresAt: string | null;
  isActive: boolean;
  flaggedClicksCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AdminBlockedIpsListResponse {
  success: boolean;
  data: BlockedIpDetailItem[];
  pagination: PaginationMeta;
  error?: string;
}

export interface CreateBlockedIpRequest {
  ipAddress: string;
  reason: string;
  expiresAt?: string | null;
  metadata?: Record<string, unknown>;
}

export interface CreateBlockedIpResponse {
  success: boolean;
  data: HydratedBlockedIp;
  auditId: string;
  error?: string;
}

export interface DeleteBlockedIpRequest {
  ipAddress: string;
  reason: string;
}

export interface DeleteBlockedIpResponse {
  success: boolean;
  unblocked: boolean;
  auditId: string;
  error?: string;
}

// ============================================================================
// 7. ZOD VALIDATION SCHEMAS
// ============================================================================

export const FraudReasonCodeSchema = z.enum([
  'BURST_CLICK',
  'HIGH_CLICK_CONVERSION_RATIO',
  'ABNORMAL_CONVERSION_RATIO',
  'RATE_LIMIT_EXCEEDED',
  'IP_RATE_LIMIT_EXCEEDED',
  'BLOCKED_IP',
  'SUSPICIOUS_USER_AGENT',
  'RAPID_IDENTICAL_SESSION',
  'AUTO_BLOCKED_REPEAT_OFFENDER',
  'MANUAL_FLAG',
]);

export const FraudReviewActionSchema = z.enum([
  'approve',
  'reject',
  'block_ip',
  'unblock_ip',
  'bulk_resolve',
  'bulk_approve',
  'bulk_reject',
  'dismiss',
]);

export const ClickReviewStatusSchema = z.enum([
  'pending',
  'approved',
  'rejected',
  'ignored',
]);

export const AdminFraudActionSchema = z.object({
  action: FraudReviewActionSchema,
  clickId: z.string().min(1).optional(),
  clickIds: z.array(z.string().min(1)).optional(),
  ipAddress: z.string().min(1).optional(),
  resolution: z.enum(['approve', 'reject']).optional(),
  reason: z.string().min(3, 'Audit reason must contain at least 3 characters'),
  blockIpAlso: z.boolean().optional(),
  expiresAt: z.string().datetime().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const CreateBlockedIpSchema = z.object({
  ipAddress: z.string().min(1, 'IP address is required'),
  reason: z.string().min(3, 'Reason must contain at least 3 characters'),
  expiresAt: z.string().datetime().optional().nullable(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

// ============================================================================
// 8. JSON SERIALIZATION & DESERIALIZATION UTILITIES
// ============================================================================

export function serializeReasons(reasons: ReasonCode[]): string {
  return JSON.stringify(reasons);
}

export function parseReasons(raw: string | null | undefined): ReasonCode[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isFraudReasonCode);
  } catch {
    return [];
  }
}

export function serializeMetadata(meta: Record<string, unknown> | null | undefined): string {
  if (!meta) return '{}';
  return JSON.stringify(meta);
}

export function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    return parsed as Record<string, unknown>;
  } catch {
    return {};
  }
}

// ============================================================================
// 9. SERVICE FUNCTION CONTRACTS
// ============================================================================

export type CheckIpRateLimitFn = (
  db: D1Database,
  ip: string,
  options?: Partial<DualWindowRateLimitConfig>
) => Promise<DualWindowRateLimitResult>;

export type IsIpBlockedFn = (
  db: D1Database,
  ip: string
) => Promise<boolean>;

export type EvaluateClickVelocityFn = (
  db: D1Database,
  click: ClickVelocityInput,
  thresholds?: Partial<VelocityCheckThresholds>
) => Promise<VelocityCheckResult>;

export type RecordFraudDecisionFn = (
  db: D1Database,
  params: AdminFraudActionRequest,
  reviewer: { userId: string; email: string }
) => Promise<AdminFraudActionResponse>;
