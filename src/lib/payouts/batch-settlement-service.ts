/**
 * src/lib/payouts/batch-settlement-service.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Milestone 4: Automated Batch Settlement & Ledger Reconciliation
 *
 * Responsibilities:
 * - Query and aggregate unpaid affiliate earnings (is_paid = 0 AND payout_id IS NULL)
 * - Enforce minimum payout threshold ($50.00 default)
 * - Resolve multi-chain destinations (Stellar, Ethereum, Solana) and validate wallet addresses
 * - Pre-flight & in-flight circuit breaker integration via TreasuryHealthService.canSettle()
 * - Atomic two-phase D1 reservation using db.batch([...]) preventing race conditions
 * - Strict double-entry ledger reconciliation with deterministic idempotency keys
 * - Failed payout retry mechanism with fee re-estimation and on-chain pre-flight verification
 */

import { getDB, type D1Database, type D1PreparedStatement } from '../db';
import type {
  BatchSettlementService as IBatchSettlementService,
  BatchPreviewOptions,
  BatchPreviewResult,
  BatchExecutionOptions,
  BatchExecutionResult,
  BatchPreviewItem,
  RetryOptions,
  PayoutExecutionResult,
  SupportedPayoutChain,
  BatchStatus,
  PayoutRecord,
  TreasuryHealthReport,
} from './types';
import { SUPPORTED_PAYOUT_CHAINS } from './types';
import { PayoutRouter, payoutRouter } from './router';
import { confirmOnChain, isSettled } from './settlement-gate';
import { queuePayoutReceipts, type SettledPayout } from './receipts';
import { TreasuryHealthService, treasuryHealthService } from './treasury-health-service';
import { PayoutAuditService, createAuditStatement } from './audit-service';
import { keccak256 } from './crypto/keccak';
import {
  ComplianceAuditService,
  complianceAuditService as defaultComplianceAuditService,
} from '../compliance/audit-service';
import {
  SanctionsScreeningService,
  sanctionsScreeningService as defaultSanctionsScreeningService,
} from '../compliance/sanctions-service';
import {
  getKycTierLimit,
  isTierLimitExceeded,
  type KycTier,
  type KycStatus,
  type ComplianceStatus,
} from '../compliance/types';

// ============================================================================
// Math & Precision Helpers (Floating Point Safety)
// ============================================================================

/**
 * Convert USD dollar amount to integer cents (e.g. 50.25 -> 5025)
 * Prevents IEEE 754 precision drift in accounting operations
 */
export function toCents(amountUsd: number): number {
  return Math.round(amountUsd * 100);
}

/**
 * Convert integer cents back to rounded 2-decimal USD (e.g. 5025 -> 50.25)
 */
export function fromCents(cents: number): number {
  return Number((cents / 100).toFixed(2));
}

/**
 * Generate a human-readable batch number (e.g. BATCH-1727509692-AB12)
 */
export function generateBatchNumber(): string {
  const timestamp = Date.now();
  const randomSuffix = crypto.randomUUID().replace(/-/g, '').slice(0, 4).toUpperCase();
  return `BATCH-${timestamp}-${randomSuffix}`;
}

/**
 * Generate a 32-character hexadecimal UUID
 */
export function generateId(): string {
  return crypto.randomUUID().replace(/-/g, '').slice(0, 32);
}

/**
 * Compute deterministic idempotency key for a payout item:
 * idem_payout_${affiliateId}_${earningsDigest}
 *
 * NOTE: Does NOT include batchId so that concurrent batch runs attempting
 * to disburse the same affiliate earnings will collide on the UNIQUE index
 * `idx_payouts_idempotency_key`, rolling back the duplicate batch.
 */
export function generatePayoutIdempotencyKey(
  affiliateId: string,
  earningIds: string[]
): string;
export function generatePayoutIdempotencyKey(
  batchId: string,
  affiliateId: string,
  earningIds: string[]
): string;
export function generatePayoutIdempotencyKey(
  arg1: string,
  arg2: string | string[],
  arg3?: string[]
): string {
  let affiliateId: string;
  let earningIds: string[];

  if (Array.isArray(arg2)) {
    affiliateId = arg1;
    earningIds = arg2;
  } else {
    affiliateId = arg2;
    earningIds = arg3 ?? [];
  }

  const sortedIds = [...earningIds].sort();
  const digest = keccak256(sortedIds.join(',')).replace(/^0x/, '').slice(0, 12);
  return `idem_payout_${affiliateId}_${digest}`;
}

/**
 * Compute deterministic retry idempotency key:
 * idem_retry_${payoutId}_att_${retryCount + 1}
 */
export function generateRetryIdempotencyKey(payoutId: string, retryCount: number): string {
  return `idem_retry_${payoutId}_att_${retryCount + 1}`;
}

// ============================================================================
// Service Dependencies & Types
// ============================================================================

export interface BatchSettlementServiceDependencies {
  db?: D1Database;
  router?: PayoutRouter;
  healthService?: TreasuryHealthService;
  auditService?: PayoutAuditService;
  complianceAuditService?: ComplianceAuditService;
  sanctionsService?: SanctionsScreeningService;
}

interface RawUnpaidEarningRow {
  earning_id: string;
  affiliate_id: string;
  amount: number;
  affiliate_name: string | null;
  affiliate_email: string | null;
  wallet_address: string | null;
  preferred_chain: string | null;
}

interface AffiliateAggregation {
  affiliateId: string;
  affiliateName: string | null;
  affiliateEmail: string | null;
  walletAddress: string | null;
  preferredChain: string | null;
  earningIds: string[];
  totalCents: number;
}

// ============================================================================
// BatchSettlementService Implementation
// ============================================================================

export class BatchSettlementService implements IBatchSettlementService {
  private readonly dbOverride?: D1Database;
  private readonly routerOverride?: PayoutRouter;
  private readonly healthServiceOverride?: TreasuryHealthService;
  private readonly auditServiceOverride?: PayoutAuditService;
  private readonly complianceAuditServiceOverride?: ComplianceAuditService;
  private readonly sanctionsServiceOverride?: SanctionsScreeningService;

  public static readonly DEFAULT_MIN_THRESHOLD = 50.0;
  public static readonly DEFAULT_BATCH_LIMIT = 50;

  constructor(deps?: BatchSettlementServiceDependencies) {
    this.dbOverride = deps?.db;
    this.routerOverride = deps?.router;
    this.healthServiceOverride = deps?.healthService;
    this.auditServiceOverride = deps?.auditService;
    this.complianceAuditServiceOverride = deps?.complianceAuditService;
    this.sanctionsServiceOverride = deps?.sanctionsService;
  }

  /**
   * Resolve D1 database instance
   */
  public getDb(): D1Database {
    if (this.dbOverride) return this.dbOverride;
    return getDB();
  }

  /**
   * Resolve PayoutRouter instance
   */
  public getRouter(): PayoutRouter {
    return this.routerOverride ?? payoutRouter;
  }

  /**
   * Resolve TreasuryHealthService instance
   */
  public getHealthService(): TreasuryHealthService {
    return this.healthServiceOverride ?? treasuryHealthService;
  }

  /**
   * Resolve PayoutAuditService instance
   */
  public getAuditService(): PayoutAuditService {
    if (this.auditServiceOverride) return this.auditServiceOverride;
    return new PayoutAuditService(this.getDb());
  }

  /**
   * Resolve ComplianceAuditService instance
   */
  public getComplianceAuditService(): ComplianceAuditService {
    if (this.complianceAuditServiceOverride) return this.complianceAuditServiceOverride;
    return defaultComplianceAuditService;
  }

  /**
   * Resolve SanctionsScreeningService instance
   */
  public getSanctionsService(): SanctionsScreeningService {
    if (this.sanctionsServiceOverride) return this.sanctionsServiceOverride;
    return defaultSanctionsScreeningService;
  }

  /**
   * Introspect table capabilities to support both legacy and migration 024 schemas
   */
  public async checkPayoutsTableCapabilities(db: D1Database): Promise<{
    hasComplianceColumns: boolean;
    supportsKycRequiredStatus: boolean;
    supportsBlockedStatus: boolean;
    hasComplianceAuditLogs: boolean;
  }> {
    try {
      const payoutsSchemaRow = await db
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='payouts'")
        .first<{ sql: string }>();
      const sql = payoutsSchemaRow?.sql ?? '';

      const auditRow = await db
        .prepare("SELECT count(*) as count FROM sqlite_master WHERE type='table' AND name='compliance_audit_logs'")
        .first<{ count: number }>();
      const hasComplianceAuditLogs = Number(auditRow?.count ?? 0) > 0;

      return {
        hasComplianceColumns: sql.includes('compliance_status'),
        supportsKycRequiredStatus: sql.includes('kyc_required'),
        supportsBlockedStatus: sql.includes('compliance_blocked'),
        hasComplianceAuditLogs,
      };
    } catch {
      return {
        hasComplianceColumns: false,
        supportsKycRequiredStatus: false,
        supportsBlockedStatus: false,
        hasComplianceAuditLogs: false,
      };
    }
  }

  /**
   * Query rolling 30-day cumulative volume for an affiliate
   * Excludes optional excludePayoutId (e.g. current in-flight payout)
   */
  public async get30DayCumulativeVolume(
    db: D1Database,
    affiliateId: string,
    excludePayoutId?: string
  ): Promise<number> {
    try {
      const query = excludePayoutId
        ? `SELECT COALESCE(SUM(amount), 0) as total
           FROM payouts
           WHERE affiliate_id = ?
             AND status IN ('completed', 'processing', 'pending')
             AND created_at >= datetime('now', '-30 days')
             AND id != ?`
        : `SELECT COALESCE(SUM(amount), 0) as total
           FROM payouts
           WHERE affiliate_id = ?
             AND status IN ('completed', 'processing', 'pending')
             AND created_at >= datetime('now', '-30 days')`;

      const stmt = excludePayoutId
        ? db.prepare(query).bind(affiliateId, excludePayoutId)
        : db.prepare(query).bind(affiliateId);

      const row = await stmt.first<{ total: number }>();
      return Number(row?.total ?? 0);
    } catch {
      return 0;
    }
  }

  /**
   * Query user profile for KYC verification tier and status
   */
  public async getUserKycProfile(
    db: D1Database,
    affiliateId: string
  ): Promise<{ kycTier: KycTier; kycStatus: KycStatus }> {
    try {
      const row = await db
        .prepare('SELECT kyc_tier, kyc_status FROM profiles WHERE id = ?')
        .bind(affiliateId)
        .first<{ kyc_tier?: string; kyc_status?: string }>();

      const kycTier = (row?.kyc_tier as KycTier) || 'tier0_unverified';
      const kycStatus = (row?.kyc_status as KycStatus) || 'unverified';
      return { kycTier, kycStatus };
    } catch {
      return { kycTier: 'tier0_unverified', kycStatus: 'unverified' };
    }
  }

  // ==========================================================================
  // 1. Preview Batch
  // ==========================================================================

  /**
   * Preview a potential batch settlement without modifying database records.
   * Aggregates unpaid earnings, applies threshold filtering, validates addresses,
   * estimates network fees, and evaluates treasury health circuit breaker status.
   */
  async previewBatch(options?: BatchPreviewOptions): Promise<BatchPreviewResult> {
    const minThreshold = options?.minThreshold ?? BatchSettlementService.DEFAULT_MIN_THRESHOLD;
    const targetChainFilter = options?.chain ?? 'all';
    const limit = options?.limit ?? BatchSettlementService.DEFAULT_BATCH_LIMIT;
    const batchNumber = generateBatchNumber();

    const db = this.getDb();
    const router = this.getRouter();
    const healthService = this.getHealthService();

    // 1. Query unpaid earnings from D1 with fallback resilience
    const rows = await this.queryUnpaidEarnings(db);

    // 2. Group by affiliate and aggregate amounts in integer cents
    const affiliateMap = new Map<string, AffiliateAggregation>();

    for (const row of rows) {
      if (!row.amount || row.amount <= 0) continue;

      let agg = affiliateMap.get(row.affiliate_id);
      if (!agg) {
        agg = {
          affiliateId: row.affiliate_id,
          affiliateName: row.affiliate_name,
          affiliateEmail: row.affiliate_email,
          walletAddress: row.wallet_address,
          preferredChain: row.preferred_chain,
          earningIds: [],
          totalCents: 0,
        };
        affiliateMap.set(row.affiliate_id, agg);
      }

      agg.earningIds.push(row.earning_id);
      agg.totalCents += toCents(row.amount);
      if (!agg.walletAddress && row.wallet_address) agg.walletAddress = row.wallet_address;
      if (!agg.preferredChain && row.preferred_chain) agg.preferredChain = row.preferred_chain;
    }

    // 3. Filter by threshold ($50.00 default) and resolve payout routes
    const payoutsPreview: BatchPreviewItem[] = [];
    const blockingReasons: string[] = [];
    const minThresholdCents = toCents(minThreshold);

    for (const agg of affiliateMap.values()) {
      // Check threshold: < $50 excluded, >= $50 included
      if (agg.totalCents < minThresholdCents) {
        continue;
      }

      // Check wallet configuration
      if (!agg.walletAddress || agg.walletAddress.trim() === '') {
        blockingReasons.push(
          `Affiliate ${agg.affiliateId} (${agg.affiliateName || agg.affiliateEmail || 'unknown'}) has no wallet address configured`
        );
        continue;
      }

      // Resolve chain & validate address
      let resolvedChain: SupportedPayoutChain;
      try {
        const resolved = router.resolveUserChain({
          preferred_chain: agg.preferredChain,
          wallet_address: agg.walletAddress,
        });
        resolvedChain = resolved.chain;
      } catch (err: any) {
        blockingReasons.push(
          `Affiliate ${agg.affiliateId} wallet validation failed: ${err?.message || String(err)}`
        );
        continue;
      }

      // Apply chain filter if specified
      if (targetChainFilter !== 'all' && resolvedChain !== targetChainFilter) {
        continue;
      }

      // Validate address strictly
      const validation = router.validateRecipient(resolvedChain, agg.walletAddress);
      if (!validation.valid) {
        blockingReasons.push(
          `Affiliate ${agg.affiliateId} address validation failed for ${resolvedChain}: ${validation.error}`
        );
        continue;
      }

      // Check limit
      if (payoutsPreview.length >= limit) {
        break;
      }

      const grossAmount = fromCents(agg.totalCents);
      const fee = 0.0;
      const netAmount = fromCents(agg.totalCents - toCents(fee));

      // Estimate network gas fee
      let estimatedGasFeeUsd = 0.0;
      try {
        const feeEst = await router.estimateFee(resolvedChain, {
          chain: resolvedChain,
          recipientAddress: agg.walletAddress,
          amount: netAmount,
          token: 'USDC',
        });
        estimatedGasFeeUsd = feeEst.feeUsd;
      } catch {
        // Fallback default fee estimates if RPC simulation fails
        if (resolvedChain === 'ethereum') estimatedGasFeeUsd = 2.5;
        else if (resolvedChain === 'solana') estimatedGasFeeUsd = 0.005;
        else estimatedGasFeeUsd = 0.001;
      }

      // Pre-flight compliance evaluation: Sanctions & KYC 30-day cumulative volume
      const sanctionsService = this.getSanctionsService();
      const sanctionsScreening = await sanctionsService.checkAddress(
        agg.walletAddress,
        resolvedChain,
        db
      );

      const cumulative30d = await this.get30DayCumulativeVolume(db, agg.affiliateId);
      const { kycTier } = await this.getUserKycProfile(db, agg.affiliateId);
      const tierLimit = getKycTierLimit(kycTier);
      const isLimitExceeded = isTierLimitExceeded(cumulative30d, netAmount, kycTier);

      let complianceStatus: ComplianceStatus = 'clean';
      let complianceReason: string | undefined = undefined;

      if (sanctionsScreening.isSanctioned) {
        complianceStatus = 'compliance_blocked';
        complianceReason = 'SANCTIONED_ADDRESS';
      } else if (isLimitExceeded) {
        complianceStatus = 'kyc_required';
        complianceReason = 'KYC_TIER_LIMIT_EXCEEDED';
      }

      payoutsPreview.push({
        affiliateId: agg.affiliateId,
        affiliateName: agg.affiliateName,
        affiliateEmail: agg.affiliateEmail,
        recipientAddress: agg.walletAddress,
        chain: resolvedChain,
        earningIds: agg.earningIds,
        earningsCount: agg.earningIds.length,
        grossAmount,
        fee,
        netAmount,
        estimatedGasFeeUsd,
        complianceStatus,
        complianceReason,
        kycTier,
        cumulative30dVolume: cumulative30d,
      });
    }

    // 4. Summarize batch metrics
    let totalCents = 0;
    let totalFeeCents = 0;
    let totalNetCents = 0;
    let totalGasCents = 0;
    let totalEarningsCount = 0;

    const byChain: Record<
      SupportedPayoutChain,
      { affiliateCount: number; totalAmount: number; estimatedGasFeeUsd: number }
    > = {
      stellar: { affiliateCount: 0, totalAmount: 0, estimatedGasFeeUsd: 0 },
      ethereum: { affiliateCount: 0, totalAmount: 0, estimatedGasFeeUsd: 0 },
      solana: { affiliateCount: 0, totalAmount: 0, estimatedGasFeeUsd: 0 },
    };

    for (const item of payoutsPreview) {
      totalCents += toCents(item.grossAmount);
      totalFeeCents += toCents(item.fee);
      totalNetCents += toCents(item.netAmount);
      totalGasCents += toCents(item.estimatedGasFeeUsd);
      totalEarningsCount += item.earningsCount;

      const chainSummary = byChain[item.chain];
      chainSummary.affiliateCount += 1;
      chainSummary.totalAmount = fromCents(toCents(chainSummary.totalAmount) + toCents(item.grossAmount));
      chainSummary.estimatedGasFeeUsd = fromCents(
        toCents(chainSummary.estimatedGasFeeUsd) + toCents(item.estimatedGasFeeUsd)
      );
    }

    // 5. Evaluate Treasury Health & Circuit Breaker Status
    const treasuryHealth = await healthService.checkHealth(
      targetChainFilter === 'all' ? undefined : targetChainFilter
    );

    let canExecute = true;

    // Check circuit breaker status per active chain
    for (const chain of SUPPORTED_PAYOUT_CHAINS) {
      const summary = byChain[chain];
      if (summary.affiliateCount > 0) {
        const check = await healthService.canSettle(
          summary.totalAmount,
          chain,
          summary.estimatedGasFeeUsd
        );
        if (!check.allowed) {
          canExecute = false;
          blockingReasons.push(check.reason || `Circuit breaker active for ${chain}`);
        }
      }
    }

    // Also mark canExecute false if there are no eligible payouts
    if (payoutsPreview.length === 0) {
      canExecute = false;
    }

    return {
      batchNumber,
      chain: targetChainFilter,
      eligibleAffiliatesCount: payoutsPreview.length,
      totalEarningsCount,
      totalAmountUsd: fromCents(totalCents),
      totalFeeUsd: fromCents(totalFeeCents),
      totalNetAmountUsd: fromCents(totalNetCents),
      totalEstimatedGasFeeUsd: fromCents(totalGasCents),
      byChain,
      treasuryHealth,
      canExecute,
      blockingReasons: blockingReasons.length > 0 ? blockingReasons : undefined,
      payoutsPreview,
    };
  }

  // ==========================================================================
  // 2. Execute Batch
  // ==========================================================================

  /**
   * Atomically reserve earnings and execute batch payout dispatches.
   * Handles dryRun, two-phase atomic D1 reservation, in-flight circuit breakers,
   * and double-entry ledger reconciliation.
   */
  async executeBatch(options?: BatchExecutionOptions): Promise<BatchExecutionResult> {
    const dryRun = options?.dryRun ?? false;
    const startedAt = new Date().toISOString();

    // 1. Run preview first to validate threshold, routes, and pre-flight treasury health
    const preview = await this.previewBatch(options);

    // Dry Run mode
    if (dryRun) {
      const simulatedPayouts: PayoutExecutionResult[] = preview.payoutsPreview.map(item => ({
        success: true,
        payoutId: `dry_payout_${generateId().slice(0, 8)}`,
        chain: item.chain,
        toAddress: item.recipientAddress,
        amount: item.netAmount,
        token: 'USDC',
        transactionId: `DRY_RUN_TX_${item.chain.toUpperCase()}_${Date.now()}`,
        gasFeeNative: 0,
        gasFeeUsd: item.estimatedGasFeeUsd,
        status: 'confirmed',
        timestamp: startedAt,
      }));

      return {
        batchId: `dry_run_${generateId()}`,
        batchNumber: preview.batchNumber,
        status: 'completed',
        chain: options?.chain === 'all' ? null : (options?.chain ?? null),
        totalPayouts: preview.eligibleAffiliatesCount,
        successfulPayouts: preview.eligibleAffiliatesCount,
        failedPayouts: 0,
        totalAmount: preview.totalAmountUsd,
        totalFee: preview.totalFeeUsd,
        totalGasFeeUsd: preview.totalEstimatedGasFeeUsd,
        dryRun: true,
        startedAt,
        completedAt: new Date().toISOString(),
        payouts: simulatedPayouts,
        errors: preview.blockingReasons,
      };
    }

    // If 0 eligible affiliates, return clean empty result
    if (preview.eligibleAffiliatesCount === 0) {
      return {
        batchId: generateId(),
        batchNumber: preview.batchNumber,
        status: 'completed',
        chain: options?.chain === 'all' ? null : (options?.chain ?? null),
        totalPayouts: 0,
        successfulPayouts: 0,
        failedPayouts: 0,
        totalAmount: 0,
        totalFee: 0,
        totalGasFeeUsd: 0,
        dryRun: false,
        startedAt,
        completedAt: new Date().toISOString(),
        payouts: [],
        errors: preview.blockingReasons,
      };
    }

    const db = this.getDb();
    const router = this.getRouter();
    const healthService = this.getHealthService();
    const auditService = this.getAuditService();

    // If pre-flight circuit breaker tripped, log audit event and halt
    if (!preview.canExecute) {
      await auditService.log({
        action: 'circuit_breaker_pause',
        chain: options?.chain === 'all' ? null : options?.chain,
        admin_id: options?.adminId ?? null,
        admin_email: options?.adminEmail ?? null,
        ip_address: options?.ipAddress ?? null,
        details: {
          reason: 'Pre-flight circuit breaker halted batch execution',
          blockingReasons: preview.blockingReasons,
          treasuryHealth: preview.treasuryHealth,
        },
      });

      return {
        batchId: generateId(),
        batchNumber: preview.batchNumber,
        status: 'failed',
        chain: options?.chain === 'all' ? null : (options?.chain ?? null),
        totalPayouts: preview.eligibleAffiliatesCount,
        successfulPayouts: 0,
        failedPayouts: preview.eligibleAffiliatesCount,
        totalAmount: preview.totalAmountUsd,
        totalFee: preview.totalFeeUsd,
        totalGasFeeUsd: 0,
        dryRun: false,
        startedAt,
        completedAt: new Date().toISOString(),
        payouts: [],
        errors: preview.blockingReasons,
      };
    }

    // 2. Phase 1: Atomic D1 Reservation via db.batch([...])
    const capabilities = await this.checkPayoutsTableCapabilities(db);
    const batchId = generateId();
    const reservationItems: Array<{
      payoutId: string;
      idempotencyKey: string;
      previewItem: BatchPreviewItem;
    }> = [];

    const reservationStatements: D1PreparedStatement[] = [];

    // Statement 1: Insert into payout_batches
    reservationStatements.push(
      db.prepare(`
        INSERT INTO payout_batches (
          id, batch_number, status, chain, total_payouts, successful_payouts, failed_payouts,
          total_amount, total_fee, total_gas_fee_usd, executed_by, dry_run, scheduled_at,
          started_at, metadata, created_at, updated_at
        ) VALUES (?, ?, 'processing', ?, ?, 0, 0, ?, ?, ?, ?, 0, ?, datetime('now'), ?, datetime('now'), datetime('now'))
      `).bind(
        batchId,
        preview.batchNumber,
        options?.chain === 'all' ? null : (options?.chain ?? null),
        preview.eligibleAffiliatesCount,
        preview.totalAmountUsd,
        preview.totalFeeUsd,
        preview.totalEstimatedGasFeeUsd,
        options?.adminId ?? null,
        options?.scheduledAt ?? null,
        JSON.stringify({ options, previewSummary: preview.byChain })
      )
    );

    // Statements 2+: Insert into payouts and assign payout_id on earnings
    for (const item of preview.payoutsPreview) {
      const payoutId = generateId();
      const idempotencyKey = generatePayoutIdempotencyKey(item.affiliateId, item.earningIds);

      reservationItems.push({ payoutId, idempotencyKey, previewItem: item });

      const methodDetails = JSON.stringify({
        address: item.recipientAddress,
        chain: item.chain,
        token: 'USDC',
      });

      // Insert payout row
      if (capabilities.hasComplianceColumns) {
        let initialStatus = 'pending';
        if (item.complianceStatus === 'kyc_required' && capabilities.supportsKycRequiredStatus) {
          initialStatus = 'kyc_required';
        } else if (item.complianceStatus === 'compliance_blocked' && capabilities.supportsBlockedStatus) {
          initialStatus = 'compliance_blocked';
        }

        reservationStatements.push(
          db.prepare(`
            INSERT INTO payouts (
              id, affiliate_id, batch_id, chain, payout_method, payout_method_details,
              amount, currency, fee, net_amount, status, compliance_status, compliance_reason,
              idempotency_key, gas_fee_native, gas_fee_usd,
              scheduled_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'crypto', ?, ?, 'USD', ?, ?, ?, ?, ?, ?, 0.0, ?, ?, datetime('now'), datetime('now'))
          `).bind(
            payoutId,
            item.affiliateId,
            batchId,
            item.chain,
            methodDetails,
            item.grossAmount,
            item.fee,
            item.netAmount,
            initialStatus,
            item.complianceStatus ?? 'clean',
            item.complianceReason ?? null,
            idempotencyKey,
            item.estimatedGasFeeUsd,
            options?.scheduledAt ?? null
          )
        );
      } else {
        reservationStatements.push(
          db.prepare(`
            INSERT INTO payouts (
              id, affiliate_id, batch_id, chain, payout_method, payout_method_details,
              amount, currency, fee, net_amount, status, idempotency_key, gas_fee_native, gas_fee_usd,
              scheduled_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'crypto', ?, ?, 'USD', ?, ?, 'pending', ?, 0.0, ?, ?, datetime('now'), datetime('now'))
          `).bind(
            payoutId,
            item.affiliateId,
            batchId,
            item.chain,
            methodDetails,
            item.grossAmount,
            item.fee,
            item.netAmount,
            idempotencyKey,
            item.estimatedGasFeeUsd,
            options?.scheduledAt ?? null
          )
        );
      }

      // Lock earnings to this payout_id (is_paid remains 0 until confirmed)
      for (const earningId of item.earningIds) {
        reservationStatements.push(
          db.prepare(`
            UPDATE earnings
            SET payout_id = ?, updated_at = datetime('now')
            WHERE id = ? AND is_paid = 0 AND payout_id IS NULL
          `).bind(payoutId, earningId)
        );
      }
    }

    // Audit log statement for batch reservation
    reservationStatements.push(
      createAuditStatement(db, {
        batch_id: batchId,
        action: 'batch_execution',
        admin_id: options?.adminId ?? null,
        admin_email: options?.adminEmail ?? null,
        ip_address: options?.ipAddress ?? null,
        chain: options?.chain === 'all' ? null : options?.chain,
        details: {
          event: 'batch_reserved',
          batchNumber: preview.batchNumber,
          totalPayouts: preview.eligibleAffiliatesCount,
          totalAmount: preview.totalAmountUsd,
        },
      })
    );

    // Atomically execute reservation
    try {
      await db.batch(reservationStatements);
    } catch (err: any) {
      const errMsg = err?.message || String(err);
      if (
        errMsg.includes('UNIQUE constraint failed') ||
        errMsg.includes('constraint') ||
        errMsg.includes('idx_payouts_idempotency_key')
      ) {
        // Concurrent batch execution conflict: Another batch has already claimed these payouts.
        // Return a clean failed result with 0 successful payouts, safely rolling back.
        return {
          batchId,
          batchNumber: preview.batchNumber,
          status: 'failed',
          chain: options?.chain === 'all' ? null : (options?.chain ?? null),
          totalPayouts: preview.eligibleAffiliatesCount,
          successfulPayouts: 0,
          failedPayouts: preview.eligibleAffiliatesCount,
          totalAmount: preview.totalAmountUsd,
          totalFee: preview.totalFeeUsd,
          totalGasFeeUsd: 0,
          dryRun: false,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          payouts: [],
          errors: [`Concurrent batch execution conflict: ${errMsg}`],
        };
      }
      throw err;
    }

    // 3. Phase 2: Per-affiliate on-chain execution with in-flight circuit breaker
    let successfulPayouts = 0;
    let failedPayouts = 0;
    let totalGasUsdCents = 0;
    const executionResults: PayoutExecutionResult[] = [];
    const executionErrors: string[] = [];
    const settledReceipts: SettledPayout[] = [];

    const sanctionsService = this.getSanctionsService();
    const complianceAuditService = this.getComplianceAuditService();
    const runningAffiliateVolume = new Map<string, number>();

    for (const reserved of reservationItems) {
      const { payoutId, idempotencyKey, previewItem: item } = reserved;

      // Post-Reservation Verification:
      // Verify for each payout item that all expected earnings were actually locked to it.
      // If count !== item.earningIds.length, do NOT dispatch on-chain!
      const countRow = await db
        .prepare('SELECT count(*) as count FROM earnings WHERE payout_id = ?')
        .bind(payoutId)
        .first<{ count: number }>();

      const lockedCount = Number(countRow?.count ?? 0);
      if (lockedCount !== item.earningIds.length) {
        const errorReason = 'Earnings reserved by concurrent transaction';

        // Release any partially locked earnings so they remain eligible for future batches
        await db.batch([
          db.prepare(`
            UPDATE payouts
            SET status = 'failed',
                error_message = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(errorReason, payoutId),
          db.prepare(`
            UPDATE earnings
            SET payout_id = NULL,
                updated_at = datetime('now')
            WHERE payout_id = ? AND is_paid = 0
          `).bind(payoutId),
          createAuditStatement(db, {
            batch_id: batchId,
            payout_id: payoutId,
            action: 'batch_execution',
            chain: item.chain,
            admin_id: options?.adminId ?? null,
            admin_email: options?.adminEmail ?? null,
            ip_address: options?.ipAddress ?? null,
            details: {
              event: 'reservation_verification_failed',
              reason: errorReason,
              expectedEarningsCount: item.earningIds.length,
              actualLockedCount: lockedCount,
            },
          }),
        ]);

        failedPayouts++;
        executionErrors.push(errorReason);
        executionResults.push({
          success: false,
          payoutId,
          chain: item.chain,
          toAddress: item.recipientAddress,
          amount: item.netAmount,
          token: 'USDC',
          error: errorReason,
          status: 'failed',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Pre-flight Sanctions Check
      const sanctionsScreening = await sanctionsService.checkAddress(
        item.recipientAddress,
        item.chain,
        db
      );

      if (sanctionsScreening.isSanctioned || item.complianceStatus === 'compliance_blocked') {
        const errorReason = `SANCTIONED_ADDRESS: Recipient address '${item.recipientAddress}' on chain '${item.chain}' is flagged on sanctions watchlist (${sanctionsScreening.reason || 'OFAC SDN / AML Flag'})`;

        const blockedStatus = capabilities.supportsBlockedStatus ? 'compliance_blocked' : 'failed';
        const batchStmts: D1PreparedStatement[] = [];

        if (capabilities.hasComplianceColumns) {
          batchStmts.push(
            db.prepare(`
              UPDATE payouts
              SET status = ?,
                  compliance_status = 'compliance_blocked',
                  compliance_reason = 'SANCTIONED_ADDRESS',
                  error_message = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(blockedStatus, errorReason, payoutId)
          );
        } else {
          batchStmts.push(
            db.prepare(`
              UPDATE payouts
              SET status = 'failed',
                  error_message = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(errorReason, payoutId)
          );
        }

        if (capabilities.hasComplianceAuditLogs) {
          batchStmts.push(
            complianceAuditService.createAuditStatement(db, {
              action: 'sanctions_block',
              severity: 'critical',
              targetId: payoutId,
              details: {
                batchId,
                affiliateId: item.affiliateId,
                address: item.recipientAddress,
                chain: item.chain,
                amount: item.netAmount,
                reason: sanctionsScreening.reason,
                source: sanctionsScreening.source,
                riskScore: sanctionsScreening.riskScore,
              },
            })
          );
        }

        await db.batch(batchStmts);

        failedPayouts++;
        executionErrors.push(errorReason);
        executionResults.push({
          success: false,
          payoutId,
          chain: item.chain,
          toAddress: item.recipientAddress,
          amount: item.netAmount,
          token: 'USDC',
          error: errorReason,
          status: 'failed',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Pre-flight KYC Tier & 30-Day Cumulative Volume Limit Check
      const priorCumulative30d = await this.get30DayCumulativeVolume(db, item.affiliateId, payoutId);
      const runningAffiliateBatchVol = runningAffiliateVolume.get(item.affiliateId) ?? 0;
      const totalCumulativeVolume = priorCumulative30d + runningAffiliateBatchVol;

      const { kycTier } = await this.getUserKycProfile(db, item.affiliateId);
      const tierLimit = getKycTierLimit(kycTier);
      const isLimitExceeded = isTierLimitExceeded(totalCumulativeVolume, item.netAmount, kycTier);

      if (isLimitExceeded || item.complianceStatus === 'kyc_required') {
        const errorReason = `KYC_TIER_LIMIT_EXCEEDED: Cumulative 30-day payout volume ($${(totalCumulativeVolume + item.netAmount).toFixed(2)}) exceeds KYC tier limit for ${kycTier} ($${tierLimit.toFixed(2)}). Verification required.`;

        const kycStatusValue = capabilities.supportsKycRequiredStatus ? 'kyc_required' : 'pending';
        const batchStmts: D1PreparedStatement[] = [];

        if (capabilities.hasComplianceColumns) {
          batchStmts.push(
            db.prepare(`
              UPDATE payouts
              SET status = ?,
                  compliance_status = 'kyc_required',
                  compliance_reason = 'KYC_TIER_LIMIT_EXCEEDED',
                  error_message = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(kycStatusValue, errorReason, payoutId)
          );
        } else {
          batchStmts.push(
            db.prepare(`
              UPDATE payouts
              SET error_message = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(errorReason, payoutId)
          );
        }

        if (capabilities.hasComplianceAuditLogs) {
          batchStmts.push(
            complianceAuditService.createAuditStatement(db, {
              action: 'kyc_tier_hold',
              severity: 'medium',
              targetId: payoutId,
              details: {
                batchId,
                affiliateId: item.affiliateId,
                amount: item.netAmount,
                cumulative30d: totalCumulativeVolume,
                tierLimit,
                kycTier,
                reason: 'KYC_TIER_LIMIT_EXCEEDED',
              },
            })
          );
        }

        await db.batch(batchStmts);

        failedPayouts++;
        executionErrors.push(errorReason);
        executionResults.push({
          success: false,
          payoutId,
          chain: item.chain,
          toAddress: item.recipientAddress,
          amount: item.netAmount,
          token: 'USDC',
          error: errorReason,
          status: 'failed',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Track running volume for this affiliate in this batch
      runningAffiliateVolume.set(
        item.affiliateId,
        runningAffiliateBatchVol + item.netAmount
      );

      // In-flight circuit breaker evaluation before dispatching
      const inFlightCheck = await healthService.canSettle(
        item.netAmount,
        item.chain,
        item.estimatedGasFeeUsd
      );

      if (!inFlightCheck.allowed) {
        const errorReason = `In-flight circuit breaker tripped: ${
          inFlightCheck.reason || 'Insufficient reserves or critical health'
        }`;

        await db.batch([
          db.prepare(`
            UPDATE payouts
            SET status = 'failed',
                error_message = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(errorReason, payoutId),
          createAuditStatement(db, {
            batch_id: batchId,
            payout_id: payoutId,
            action: 'circuit_breaker_pause',
            chain: item.chain,
            admin_id: options?.adminId ?? null,
            admin_email: options?.adminEmail ?? null,
            ip_address: options?.ipAddress ?? null,
            details: { reason: errorReason, health: inFlightCheck.report },
          }),
        ]);

        failedPayouts++;
        executionErrors.push(errorReason);
        executionResults.push({
          success: false,
          payoutId,
          chain: item.chain,
          toAddress: item.recipientAddress,
          amount: item.netAmount,
          token: 'USDC',
          error: errorReason,
          status: 'failed',
          timestamp: new Date().toISOString(),
        });
        continue;
      }

      // Transition to processing
      await db.prepare(`
        UPDATE payouts
        SET status = 'processing', updated_at = datetime('now')
        WHERE id = ?
      `).bind(payoutId).run();

      // Dispatch payout via router
      let execRes: PayoutExecutionResult;
      try {
        execRes = await router.sendPayout(item.chain, {
          payoutId,
          batchId,
          affiliateId: item.affiliateId,
          recipientAddress: item.recipientAddress,
          amount: item.netAmount,
          token: 'USDC',
          idempotencyKey,
          memo: idempotencyKey.slice(0, 28),
        });
      } catch (err: any) {
        execRes = {
          success: false,
          payoutId,
          chain: item.chain,
          toAddress: item.recipientAddress,
          amount: item.netAmount,
          token: 'USDC',
          error: err?.message || 'On-chain transfer threw exception',
          status: 'failed',
          timestamp: new Date().toISOString(),
        };
      }

      // Double-entry ledger reconciliation based on transfer outcome.
      // The adapters report the transfer, not whose earnings it retires. Carry
      // the affiliate through every result so callers can report per-affiliate
      // outcomes without re-deriving them from the payout row.
      execRes.affiliateId = item.affiliateId;

      // `execRes.success` only means the adapter *submitted* a transaction; it
      // is not evidence that funds arrived. Confirm on-chain before retiring
      // the payout and flipping earnings to paid.
      if (execRes.success) {
        const verdict = await confirmOnChain({
          chain: item.chain,
          transactionId: execRes.transactionId,
          router,
        });

        if (!isSettled(verdict)) {
          // Leave earnings unpaid so the next cycle retries rather than
          // marking a transfer settled that may never have happened.
          await db.batch([
            db.prepare(`
              UPDATE payouts
              SET status = 'pending',
                  error_message = ?,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(verdict.reason, payoutId),
            createAuditStatement(db, {
              batch_id: batchId,
              payout_id: payoutId,
              action: 'batch_execution',
              chain: item.chain,
              admin_id: options?.adminId ?? null,
              admin_email: options?.adminEmail ?? null,
              ip_address: options?.ipAddress ?? null,
              details: {
                submittedTransactionId: execRes.transactionId ?? null,
                reason: verdict.reason,
              },
            }),
          ]);

          const pendingResult: PayoutExecutionResult = {
            ...execRes,
            status: 'submitted',
            error: verdict.reason,
          };
          executionResults.push(pendingResult);
          continue;
        }

        const gasUsd = execRes.gasFeeUsd ?? item.estimatedGasFeeUsd;
        const gasNative = execRes.gasFeeNative ?? 0;

        await db.batch([
          db.prepare(`
            UPDATE payouts
            SET status = 'completed',
                transaction_id = ?,
                paid_at = datetime('now'),
                gas_fee_native = ?,
                gas_fee_usd = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(execRes.transactionId ?? null, gasNative, gasUsd, payoutId),
          db.prepare(`
            UPDATE earnings
            SET is_paid = 1,
                paid_at = datetime('now'),
                updated_at = datetime('now')
            WHERE payout_id = ?
          `).bind(payoutId),
          createAuditStatement(db, {
            batch_id: batchId,
            payout_id: payoutId,
            action: 'batch_execution',
            chain: item.chain,
            admin_id: options?.adminId ?? null,
            admin_email: options?.adminEmail ?? null,
            ip_address: options?.ipAddress ?? null,
            details: {
              status: 'completed',
              transactionId: execRes.transactionId,
              gasFeeUsd: gasUsd,
            },
          }),
        ]);

        successfulPayouts++;
        totalGasUsdCents += toCents(gasUsd);
        settledReceipts.push({
          affiliateId: item.affiliateId,
          affiliateEmail: item.affiliateEmail ?? '',
          affiliateName: item.affiliateName ?? null,
          amount: item.netAmount,
          payoutId,
          transactionId: execRes.transactionId ?? null,
        });
        executionResults.push(execRes);
      } else {
        const errorMsg = execRes.error || 'On-chain payout transfer failed';

        // Keep payout_id on earnings so they remain reserved for retry, but keep is_paid = 0
        await db.batch([
          db.prepare(`
            UPDATE payouts
            SET status = 'failed',
                error_message = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(errorMsg, payoutId),
          createAuditStatement(db, {
            batch_id: batchId,
            payout_id: payoutId,
            action: 'batch_execution',
            chain: item.chain,
            admin_id: options?.adminId ?? null,
            admin_email: options?.adminEmail ?? null,
            ip_address: options?.ipAddress ?? null,
            details: { status: 'failed', error: errorMsg },
          }),
        ]);

        failedPayouts++;
        executionErrors.push(`Payout ${payoutId} failed: ${errorMsg}`);
        executionResults.push(execRes);
      }
    }

    // 4. Finalize batch status in D1
    let finalBatchStatus: BatchStatus = 'completed';
    if (failedPayouts > 0 && successfulPayouts > 0) {
      finalBatchStatus = 'partially_failed';
    } else if (failedPayouts > 0 && successfulPayouts === 0) {
      finalBatchStatus = 'failed';
    }

    const totalGasFeeUsd = fromCents(totalGasUsdCents);
    const completedAt = new Date().toISOString();

    await db.prepare(`
      UPDATE payout_batches
      SET status = ?,
          successful_payouts = ?,
          failed_payouts = ?,
          total_gas_fee_usd = ?,
          completed_at = datetime('now'),
          updated_at = datetime('now')
      WHERE id = ?
    `).bind(finalBatchStatus, successfulPayouts, failedPayouts, totalGasFeeUsd, batchId).run();

    // The ledger is committed: receipts assert money that actually arrived.
    // Queuing is best-effort and never fails the batch.
    queuePayoutReceipts(settledReceipts);

    return {
      batchId,
      batchNumber: preview.batchNumber,
      status: finalBatchStatus,
      chain: options?.chain === 'all' ? null : (options?.chain ?? null),
      totalPayouts: preview.eligibleAffiliatesCount,
      successfulPayouts,
      failedPayouts,
      totalAmount: preview.totalAmountUsd,
      totalFee: preview.totalFeeUsd,
      totalGasFeeUsd,
      dryRun: false,
      startedAt,
      completedAt,
      payouts: executionResults,
      errors: executionErrors.length > 0 ? executionErrors : undefined,
    };
  }

  // ==========================================================================
  // 3. Retry Payout
  // ==========================================================================

  /**
   * Retry a failed payout with fee re-estimation, on-chain pre-flight verification,
   * in-flight circuit breaker check, and atomic ledger reconciliation.
   */
  async retryPayout(payoutId: string, options?: RetryOptions): Promise<PayoutExecutionResult> {
    const db = this.getDb();
    const router = this.getRouter();
    const healthService = this.getHealthService();

    // 1. Locate payout record in D1
    const payout = await db
      .prepare(`SELECT * FROM payouts WHERE id = ?`)
      .bind(payoutId)
      .first<PayoutRecord>();

    if (!payout) {
      return {
        success: false,
        payoutId,
        chain: 'stellar',
        toAddress: '',
        amount: 0,
        token: 'USDC',
        error: `Payout record not found: ${payoutId}`,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    const chain = (payout.chain || 'stellar') as SupportedPayoutChain;

    // Resolve recipient address from details or profile
    let recipientAddress = '';
    try {
      if (payout.payout_method_details) {
        const parsed = JSON.parse(payout.payout_method_details);
        recipientAddress = parsed.address || '';
      }
    } catch {
      recipientAddress = '';
    }

    if (!recipientAddress) {
      const profile = await db
        .prepare(`SELECT wallet_address FROM profiles WHERE id = ?`)
        .bind(payout.affiliate_id)
        .first<{ wallet_address: string | null }>();
      recipientAddress = profile?.wallet_address ?? '';
    }

    // 2. Validate payout status
    if (payout.status === 'completed') {
      return {
        success: true,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        transactionId: payout.transaction_id ?? undefined,
        gasFeeNative: payout.gas_fee_native,
        gasFeeUsd: payout.gas_fee_usd,
        status: 'confirmed',
        timestamp: payout.paid_at ?? new Date().toISOString(),
      };
    }

    if (payout.status !== 'failed' && !options?.force) {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: `Payout is in '${payout.status}' status. Only 'failed' payouts can be retried (or provide force: true)`,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    // Pre-flight compliance check: Sanctions & KYC tier limits
    if ((payout as any).compliance_status === 'compliance_blocked') {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: 'Retry rejected: payout is compliance blocked due to sanctions screening',
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    const sanctionsService = this.getSanctionsService();
    const sanctionsCheck = await sanctionsService.checkAddress(recipientAddress, chain, db);
    if (sanctionsCheck.isSanctioned) {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: `Retry rejected: recipient address '${recipientAddress}' is flagged on sanctions watchlist (${sanctionsCheck.reason})`,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    const { kycTier } = await this.getUserKycProfile(db, payout.affiliate_id);
    const cumulative30d = await this.get30DayCumulativeVolume(db, payout.affiliate_id, payoutId);
    const tierLimit = getKycTierLimit(kycTier);
    if (isTierLimitExceeded(cumulative30d, payout.net_amount, kycTier)) {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: `Retry rejected: cumulative 30-day payout volume ($${(cumulative30d + payout.net_amount).toFixed(2)}) exceeds KYC limit for ${kycTier} ($${tierLimit.toFixed(2)})`,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    // 3. Pre-flight verification: If transaction_id exists, check on-chain state first!
    if (payout.transaction_id) {
      try {
        const verifyRes = await router.verifyTransaction(chain, payout.transaction_id);
        if (verifyRes.verified && verifyRes.status === 'confirmed') {
          // Transaction was confirmed on-chain! Reconcile without re-broadcasting
          await db.batch([
            db.prepare(`
              UPDATE payouts
              SET status = 'completed',
                  paid_at = datetime('now'),
                  error_message = NULL,
                  updated_at = datetime('now')
              WHERE id = ?
            `).bind(payoutId),
            db.prepare(`
              UPDATE earnings
              SET is_paid = 1,
                  paid_at = datetime('now'),
                  updated_at = datetime('now')
              WHERE payout_id = ?
            `).bind(payoutId),
            createAuditStatement(db, {
              batch_id: payout.batch_id ?? null,
              payout_id: payoutId,
              action: 'retry',
              chain,
              admin_id: options?.adminId ?? null,
              admin_email: options?.adminEmail ?? null,
              ip_address: options?.ipAddress ?? null,
              details: {
                event: 'preflight_verification_confirmed',
                transactionId: payout.transaction_id,
                reason: options?.reason,
              },
            }),
          ]);

          return {
            success: true,
            payoutId,
            chain,
            toAddress: recipientAddress,
            amount: payout.net_amount,
            token: 'USDC',
            transactionId: payout.transaction_id,
            gasFeeNative: payout.gas_fee_native,
            gasFeeUsd: payout.gas_fee_usd,
            status: 'confirmed',
            timestamp: new Date().toISOString(),
          };
        }
      } catch {
        // Verification failed or transaction not found on-chain; proceed to re-execution
      }
    }

    if (!recipientAddress) {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: '',
        amount: payout.net_amount,
        token: 'USDC',
        error: `Cannot retry payout: recipient address cannot be resolved for affiliate ${payout.affiliate_id}`,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    // 5. Re-estimate network fee & check circuit breaker
    let gasFeeUsd = payout.gas_fee_usd || 0.0;
    if (options?.refreshFee !== false) {
      try {
        const feeEst = await router.estimateFee(chain, {
          chain,
          recipientAddress,
          amount: payout.net_amount,
          token: 'USDC',
        });
        gasFeeUsd = feeEst.feeUsd;
      } catch {
        // Keep previous or default
      }
    }

    const canSettleCheck = await healthService.canSettle(payout.net_amount, chain, gasFeeUsd);
    if (!canSettleCheck.allowed) {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: `Retry halted by circuit breaker: ${canSettleCheck.reason}`,
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    // 6. Generate deterministic retry idempotency key
    const currentRetryCount = payout.retry_count ?? 0;
    const retryIdempotencyKey = generateRetryIdempotencyKey(payoutId, currentRetryCount);

    // Atomic Compare-And-Swap (CAS):
    // Atomically transition status from 'failed' to 'processing'.
    // If changes === 0, another concurrent retry call has already claimed this payout.
    const casQuery = options?.force
      ? `UPDATE payouts
         SET status = 'processing',
             retry_count = retry_count + 1,
             last_retried_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ? AND status != 'processing'`
      : `UPDATE payouts
         SET status = 'processing',
             retry_count = retry_count + 1,
             last_retried_at = datetime('now'),
             updated_at = datetime('now')
         WHERE id = ? AND status = 'failed'`;

    const updateRes = await db.prepare(casQuery).bind(payoutId).run();
    const changes = updateRes?.meta?.changes ?? (updateRes as any)?.changes ?? 0;

    if (changes === 0) {
      return {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: 'Payout is already processing or has already been retried',
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    // 7. Dispatch on-chain payout
    let execRes: PayoutExecutionResult;
    try {
      execRes = await router.sendPayout(chain, {
        payoutId,
        batchId: payout.batch_id ?? undefined,
        affiliateId: payout.affiliate_id,
        recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        idempotencyKey: retryIdempotencyKey,
        memo: retryIdempotencyKey.slice(0, 28),
      });
    } catch (err: any) {
      execRes = {
        success: false,
        payoutId,
        chain,
        toAddress: recipientAddress,
        amount: payout.net_amount,
        token: 'USDC',
        error: err?.message || 'Retry transfer threw exception',
        status: 'failed',
        timestamp: new Date().toISOString(),
      };
    }

    // 8. Reconcile only once the chain confirms the transfer landed.
    //
    // `execRes.success` means the adapter submitted a transaction, not that
    // USDC arrived, so it cannot retire the earnings on its own. Confirm
    // on-chain first and leave them unpaid for the next attempt otherwise.
    if (execRes.success) {
      const verdict = await confirmOnChain({
        chain,
        transactionId: execRes.transactionId,
        router,
      });

      if (!isSettled(verdict)) {
        await db.batch([
          db.prepare(`
            UPDATE payouts
            SET status = 'pending',
                transaction_id = ?,
                error_message = ?,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(execRes.transactionId ?? null, verdict.reason, payoutId),
          createAuditStatement(db, {
            batch_id: payout.batch_id ?? null,
            payout_id: payoutId,
            action: 'retry',
            chain,
            admin_id: options?.adminId ?? null,
            admin_email: options?.adminEmail ?? null,
            ip_address: options?.ipAddress ?? null,
            details: {
              event: 'submitted_awaiting_confirmation',
              transactionId: execRes.transactionId ?? null,
              reason: verdict.reason,
            },
          }),
        ]);

        return {
          success: false,
          payoutId,
          chain,
          toAddress: recipientAddress,
          amount: payout.net_amount,
          token: 'USDC',
          transactionId: execRes.transactionId ?? null,
          error: verdict.reason,
          status: 'submitted',
          timestamp: new Date().toISOString(),
        };
      }

      const finalGasUsd = execRes.gasFeeUsd ?? gasFeeUsd;
      const finalGasNative = execRes.gasFeeNative ?? 0;

      const reconcileStatements: D1PreparedStatement[] = [
        db.prepare(`
          UPDATE payouts
          SET status = 'completed',
              transaction_id = ?,
              paid_at = datetime('now'),
              gas_fee_native = ?,
              gas_fee_usd = ?,
              error_message = NULL,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(execRes.transactionId ?? null, finalGasNative, finalGasUsd, payoutId),
        db.prepare(`
          UPDATE earnings
          SET is_paid = 1,
              paid_at = datetime('now'),
              updated_at = datetime('now')
          WHERE payout_id = ?
        `).bind(payoutId),
        createAuditStatement(db, {
          batch_id: payout.batch_id ?? null,
          payout_id: payoutId,
          action: 'retry',
          chain,
          admin_id: options?.adminId ?? null,
          admin_email: options?.adminEmail ?? null,
          ip_address: options?.ipAddress ?? null,
          details: {
            status: 'completed',
            retryCount: currentRetryCount + 1,
            transactionId: execRes.transactionId,
            reason: options?.reason,
          },
        }),
      ];

      // If linked to a batch, adjust parent batch counters
      if (payout.batch_id) {
        reconcileStatements.push(
          db.prepare(`
            UPDATE payout_batches
            SET successful_payouts = successful_payouts + 1,
                failed_payouts = MAX(0, failed_payouts - 1),
                status = CASE WHEN (failed_payouts - 1) <= 0 THEN 'completed' ELSE 'partially_failed' END,
                updated_at = datetime('now')
            WHERE id = ?
          `).bind(payout.batch_id)
        );
      }

      await db.batch(reconcileStatements);
      return execRes;
    } else {
      const errMsg = execRes.error || 'Retry on-chain transfer failed';

      await db.batch([
        db.prepare(`
          UPDATE payouts
          SET status = 'failed',
              error_message = ?,
              updated_at = datetime('now')
          WHERE id = ?
        `).bind(errMsg, payoutId),
        createAuditStatement(db, {
          batch_id: payout.batch_id ?? null,
          payout_id: payoutId,
          action: 'retry',
          chain,
          admin_id: options?.adminId ?? null,
          admin_email: options?.adminEmail ?? null,
          ip_address: options?.ipAddress ?? null,
          details: {
            status: 'failed',
            retryCount: currentRetryCount + 1,
            error: errMsg,
            reason: options?.reason,
          },
        }),
      ]);

      return execRes;
    }
  }

  // ==========================================================================
  // Private Query Helpers
  // ==========================================================================

  /**
   * Query unpaid earnings with backward-compatible fallback for wallet_connections
   */
  private async queryUnpaidEarnings(db: D1Database): Promise<RawUnpaidEarningRow[]> {
    try {
      const queryWithWalletConnections = `
        SELECT
          e.id AS earning_id,
          e.affiliate_id,
          e.amount,
          p.full_name AS affiliate_name,
          p.email AS affiliate_email,
          COALESCE(p.wallet_address, wc.wallet_address) AS wallet_address,
          LOWER(COALESCE(p.preferred_chain, wc.preferred_chain, 'stellar')) AS preferred_chain
        FROM earnings e
        JOIN profiles p ON e.affiliate_id = p.id
        LEFT JOIN wallet_connections wc ON p.id = wc.profile_id AND wc.is_primary = 1
        WHERE e.is_paid = 0
          AND e.payout_id IS NULL
          AND e.amount > 0
        ORDER BY e.created_at ASC
      `;
      const res = await db.prepare(queryWithWalletConnections).all<RawUnpaidEarningRow>();
      return Array.isArray(res) ? res : (res?.results || []);
    } catch (err: any) {
      if (err?.message?.includes('no such table: wallet_connections')) {
        const fallbackQuery = `
          SELECT
            e.id AS earning_id,
            e.affiliate_id,
            e.amount,
            p.full_name AS affiliate_name,
            p.email AS affiliate_email,
            p.wallet_address AS wallet_address,
            LOWER(COALESCE(p.preferred_chain, 'stellar')) AS preferred_chain
          FROM earnings e
          JOIN profiles p ON e.affiliate_id = p.id
          WHERE e.is_paid = 0
            AND e.payout_id IS NULL
            AND e.amount > 0
          ORDER BY e.created_at ASC
        `;
        const res = await db.prepare(fallbackQuery).all<RawUnpaidEarningRow>();
        return Array.isArray(res) ? res : (res?.results || []);
      }
      throw err;
    }
  }
}

/**
 * Singleton instance of BatchSettlementService
 */
export const batchSettlementService = new BatchSettlementService();
