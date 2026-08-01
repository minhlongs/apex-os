/**
 * Earnings Calculator with Batch Job Support
 * ApexOS Affiliate Cashback System
 *
 * This module calculates earnings from conversions based on multi-level
 * referral trees. It supports batch processing for large datasets and
 * provides progress tracking for long-running jobs.
 */

import { info as logInfo } from '@/lib/logger';
import {
  DEFAULT_TIER_RATES,
} from './types';
import type {
  Conversion,
  ReferralNode,
  AffiliateProfile,
  TierRates,
  BatchOptions,
  BatchJobProgress,
  BatchError,
  BatchJobResult,
  CalculatedEarning,
  AffiliateEarningsSummary,
  EarningsLevelBreakdown,
  ReferralLookup,
  EarningsRecord,
  EarningsDatabase,
} from './types';

/**
 * Batch job status codes
 */
export enum BatchJobStatusCode {
  PENDING = 'pending',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
}

/**
 * Configuration for the earnings calculator
 */
export interface CalculatorConfig {
  /** Tier commission rates (default: 30%, 10%, 5%) */
  tierRates: TierRates;
  /** Maximum recursion depth for referral tree traversal */
  maxReferralDepth: number;
  /** Enable detailed logging */
  verbose: boolean;
}

/**
 * In-memory batch job registry for tracking progress
 */
class BatchJobRegistry {
  private jobs: Map<string, BatchJobProgress> = new Map();

  createJob(_options?: Partial<BatchOptions>): BatchJobProgress {
    const job_id = this.generateJobId();
    const now = new Date().toISOString();

    const progress: BatchJobProgress = {
      job_id,
      total_conversions: 0,
      processed_conversions: 0,
      total_earnings_generated: 0,
      earnings_count: 0,
      errors: [],
      started_at: now,
      completed_at: null,
      status: BatchJobStatusCode.PENDING,
    };

    this.jobs.set(job_id, progress);
    return progress;
  }

  getJob(job_id: string): BatchJobProgress | undefined {
    return this.jobs.get(job_id);
  }

  updateJob(job_id: string, updates: Partial<BatchJobProgress>): void {
    const job = this.jobs.get(job_id);
    if (job) {
      Object.assign(job, updates);
    }
  }

  completeJob(job_id: string, result: BatchJobResult): void {
    const job = this.jobs.get(job_id);
    if (job) {
      job.status = BatchJobStatusCode.COMPLETED;
      job.completed_at = result.completed_at;
      job.total_conversions = result.conversions_processed;
      job.earnings_count = result.earnings_created;
      job.total_earnings_generated = result.total_amount;
    }
  }

  failJob(job_id: string, error: BatchError): void {
    const job = this.jobs.get(job_id);
    if (job) {
      job.status = BatchJobStatusCode.FAILED;
      job.completed_at = new Date().toISOString();
      job.errors.push(error);
    }
  }

  listJobs(): BatchJobProgress[] {
    return Array.from(this.jobs.values());
  }

  private generateJobId(): string {
    return `job_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }
}

/**
 * Earnings Calculator - computes commissions from conversions
 *
 * Features:
 * - Multi-level referral tree traversal (3 levels max)
 * - Batch processing with configurable batch size
 * - Progress tracking for long-running jobs
 * - Support for pending earnings periods
 * - Summary statistics generation
 */
export class EarningsCalculator {
  private config: Required<CalculatorConfig>;
  private jobRegistry: BatchJobRegistry;

  constructor(config: Partial<CalculatorConfig> = {}) {
    this.config = {
      tierRates: config.tierRates ?? DEFAULT_TIER_RATES,
      maxReferralDepth: config.maxReferralDepth ?? 3,
      verbose: config.verbose ?? false,
    };
    this.jobRegistry = new BatchJobRegistry();
  }

  /**
   * Get current configuration
   */
  getConfig(): Required<CalculatorConfig> {
    return { ...this.config };
  }

  /**
   * Update tier rates configuration
   */
  setTierRates(rates: TierRates): void {
    this.config.tierRates = rates;
  }

  /**
   * Start a new batch job to calculate earnings for pending conversions
   *
   * @param db - Database abstraction layer implementing EarningsDatabase
   * @param options - Batch processing options
   * @returns Job progress tracker
   */
  async startBatchJob(
    db: EarningsDatabase,
    options: Partial<BatchOptions> = {}
  ): Promise<BatchJobProgress> {
    const job = this.jobRegistry.createJob(options);
    job.status = BatchJobStatusCode.RUNNING;

    this.log(`Starting batch job ${job.job_id}`, job);

    try {
      // Prepare batch options with defaults
      const batchOptions: BatchOptions = {
        batch_size: options.batch_size ?? 100,
        start_date: options.start_date ?? null,
        end_date: options.end_date ?? null,
        min_commission_amount: options.min_commission_amount ?? 0,
        skip_existing: options.skip_existing ?? true,
      };

      // Fetch all pending approved conversions
      this.log('Fetching pending approved conversions...', job);
      const conversions = await db.getPendingApprovedConversions(batchOptions);
      job.total_conversions = conversions.length;
      this.log(`Found ${conversions.length} conversions to process`, job);

      if (conversions.length === 0) {
        const result = this.createJobResult(job, 0, 0, 0, []);
        this.completeJob(job, result);
        return job;
      }

      // Build lookup maps for efficient processing
      this.log('Building lookup maps...', job);
      const affiliateIds = new Set<string>();
      for (const conv of conversions) {
        affiliateIds.add(conv.affiliate_id);
      }

      // Fetch all referral tree nodes for these affiliates
      this.log('Fetching referral trees...', job);
      const referralTreePromises = Array.from(affiliateIds).map(id => db.getReferralTree(id));
      const referralTreeArrays = await Promise.all(referralTreePromises);
      const allReferralNodes = referralTreeArrays.flat();
      const referralTreeMap = this.buildReferralTreeMap(allReferralNodes);

      // Fetch profiles for validation
      this.log('Fetching affiliate profiles...', job);
      const profilesPromises = Array.from(affiliateIds).map(id => db.getProfile(id));
      const profileResults = await Promise.all(profilesPromises);
      const validProfiles = profileResults.filter(p => p !== null) as AffiliateProfile[];
      const profilesMap = this.buildProfilesMap(validProfiles);

      // Build existing earnings lookup if skipping existing
      let existingEarnings = new Set<string>();
      if (batchOptions.skip_existing) {
        this.log('Building existing earnings lookup...', job);
        const existingEarningsPromises = conversions.map(conv =>
          db.getExistingEarning(conv.id, conv.affiliate_id)
        );
        const existing = await Promise.all(existingEarningsPromises);
        const validExisting = existing.filter(e => e !== null) as EarningsRecord[];
        existingEarnings = this.buildExistingEarningsLookup(validExisting);
      }

      // Process in batches
      const batchSize = batchOptions.batch_size;
      let processedCount = 0;
      let totalEarnings = 0;
      let earningsCreated = 0;

      this.log(`Processing ${conversions.length} conversions in batches of ${batchSize}...`, job);

      for (let i = 0; i < conversions.length; i += batchSize) {
        const batch = conversions.slice(i, i + batchSize);
        this.log(`Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(conversions.length / batchSize)}`, job);

        try {
          const batchEarningsCount = await db.transaction(async () => {
            const records: EarningsRecord[] = [];

            for (const conversion of batch) {
              // Skip if not eligible
              if (!this.isConversionEligible(conversion, batchOptions)) {
                this.log(`Skipping ineligible conversion ${conversion.id}`, job);
                processedCount++;
                continue;
              }

              // Calculate earnings for this conversion
              const earningRecords = this.processConversion(
                conversion,
                referralTreeMap,
                profilesMap,
                existingEarnings
              );

              if (earningRecords.length === 0) {
                this.log(`No earnings generated for conversion ${conversion.id}`, job);
                processedCount++;
                continue;
              }

              records.push(...earningRecords);
              processedCount++;
            }

            // Batch insert earnings records
            if (records.length > 0) {
              const createdIds = await db.createEarningsBatch(records);
              return createdIds.length;
            }
            return 0;
          });

          earningsCreated += batchEarningsCount;
          job.processed_conversions = processedCount;
          job.earnings_count = earningsCreated;

          // Update total earnings estimate
          totalEarnings = earningsCreated * (conversions[0]?.commission_amount ?? 0) * this.config.tierRates.tier1_rate;

          this.log(`Batch complete: ${batchEarningsCount} earnings created`, job);

        } catch (error) {
          const batchError: BatchError = {
            conversion_id: '',
            affiliate_id: '',
            message: `Batch ${Math.floor(i / batchSize) + 1} failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
          };
          job.errors.push(batchError);
          this.log(`Batch error: ${batchError.message}`, job);
        }
      }

      const result = this.createJobResult(job, processedCount, earningsCreated, totalEarnings, job.errors);
      this.completeJob(job, result);

      return job;
    } catch (error) {
      this.jobRegistry.failJob(job.job_id, {
        conversion_id: '',
        affiliate_id: '',
        message: error instanceof Error ? error.message : 'Batch job failed',
      });
      throw error;
    }
  }

  /**
   * Calculate earnings for a single conversion
   *
   * @param conversion - The conversion to calculate earnings for
   * @param referralTree - Map of affiliate_id to ReferralNode for the entire tree
   * @param getAncestors - Function to get ancestor nodes for an affiliate
   * @returns Array of calculated earnings for all applicable tiers
   */
  calculateConversionEarnings(
    conversion: Conversion,
    referralTree: Map<string, ReferralNode>,
    getAncestors: (affiliateId: string, maxLevels: number) => ReferralNode[]
  ): CalculatedEarning[] {
    const earnings: CalculatedEarning[] = [];
    const affiliateId = conversion.affiliate_id;

    // Check if this affiliate is in the referral tree
    const affiliateNode = referralTree.get(affiliateId);
    if (!affiliateNode) {
      this.log(`Warning: Affiliate ${affiliateId} not found in referral tree`);
      return earnings;
    }

    // Calculate earnings based on the affiliate's position in the tree
    // Level 1 gets full commission amount (tier1 rate)
    // Levels 2 and 3 get their respective tier rates

    const commissionAmount = conversion.commission_amount;
    const rates = this.config.tierRates;

    // Direct earner (the affiliate this conversion is attributed to)
    const level1Amount = commissionAmount * rates.tier1_rate;
    earnings.push({
      conversion_id: conversion.id,
      affiliate_id: affiliateId,
      amount: level1Amount,
      level: 1,
      referral_tree_id: affiliateNode.id,
      commission_rate: rates.tier1_rate,
    });

    // Get ancestors for tier 2 and tier 3
    const ancestors = getAncestors(affiliateId, 2);

    // Parent (tier 2)
    if (ancestors.length >= 1) {
      const parent = ancestors[0];
      const level2Amount = commissionAmount * rates.tier2_rate;
      earnings.push({
        conversion_id: conversion.id,
        affiliate_id: parent.affiliate_id,
        amount: level2Amount,
        level: 2,
        referral_tree_id: parent.id,
        commission_rate: rates.tier2_rate,
      });
    }

    // Grandparent (tier 3)
    if (ancestors.length >= 2) {
      const grandparent = ancestors[1];
      const level3Amount = commissionAmount * rates.tier3_rate;
      earnings.push({
        conversion_id: conversion.id,
        affiliate_id: grandparent.affiliate_id,
        amount: level3Amount,
        level: 3,
        referral_tree_id: grandparent.id,
        commission_rate: rates.tier3_rate,
      });
    }

    return earnings;
  }

  /**
   * Process a single conversion and calculate all tiered earnings
   *
   * @param conversion - The conversion to process
   * @param referralTree - Referral tree lookup
   * @param profiles - Map of affiliate profiles for validation
   * @param existingEarnings - Set of already processed conversion/affiliate pairs
   * @returns Array of earnings records ready for database insertion
   */
  processConversion(
    conversion: Conversion,
    referralTree: Map<string, ReferralNode>,
    profiles: Map<string, AffiliateProfile>,
    existingEarnings: Set<string>
  ): EarningsRecord[] {
    const calculated = this.calculateConversionEarnings(
      conversion,
      referralTree,
      (affiliateId, maxLevels) => this.lookupAncestors(affiliateId, referralTree, maxLevels)
    );

    const now = new Date().toISOString();
    const records: EarningsRecord[] = [];

    for (const earning of calculated) {
      // Check if already processed
      const key = `${earning.conversion_id}:${earning.affiliate_id}`;
      if (existingEarnings.has(key)) {
        this.log(`Skipping existing earning for conversion ${conversion.id}, affiliate ${earning.affiliate_id}`);
        continue;
      }

      // Validate affiliate exists in profile map
      const profile = profiles.get(earning.affiliate_id);
      if (!profile) {
        this.log(`Warning: Profile not found for affiliate ${earning.affiliate_id}, skipping`);
        continue;
      }

      // Build earnings record
      records.push({
        id: this.generateId(),
        conversion_id: earning.conversion_id,
        affiliate_id: earning.affiliate_id,
        referral_tree_id: earning.referral_tree_id,
        amount: earning.amount,
        commission_type: conversion.commission_type,
        commission_rate: earning.commission_rate,
        level: earning.level,
        parent_earnings_id: null,
        earnings_period_start: null,
        earnings_period_end: null,
        is_paid: 0,
        paid_at: null,
        payout_id: null,
        created_at: now,
        updated_at: now,
      });
    }

    return records;
  }

  /**
   * Get ancestors for an affiliate from the referral tree
   *
   * @param affiliateId - The affiliate to find ancestors for
   * @param referralTree - Complete referral tree map
   * @param maxLevels - Maximum number of ancestors to return
   * @returns Array of ancestor nodes, ordered nearest first
   */
  private lookupAncestors(
    affiliateId: string,
    referralTree: Map<string, ReferralNode>,
    maxLevels: number
  ): ReferralNode[] {
    const ancestors: ReferralNode[] = [];
    let currentId = affiliateId;

    for (let i = 0; i < maxLevels; i++) {
      const node = referralTree.get(currentId);
      if (!node || !node.parent_id) break;

      const parent = referralTree.get(node.parent_id);
      if (!parent) break;

      ancestors.push(parent);
      currentId = parent.affiliate_id;
    }

    return ancestors;
  }

  /**
   * Build referral tree lookup map from database records
   *
   * @param nodes - Referral tree nodes from database
   * @returns Map keyed by affiliate_id for fast lookup
   */
  buildReferralTreeMap(nodes: ReferralNode[]): Map<string, ReferralNode> {
    const map = new Map<string, ReferralNode>();
    for (const node of nodes) {
      map.set(node.affiliate_id, node);
    }
    return map;
  }

  /**
   * Build profiles lookup map
   *
   * @param profiles - Affiliate profile records
   * @returns Map keyed by profile ID
   */
  buildProfilesMap(profiles: AffiliateProfile[]): Map<string, AffiliateProfile> {
    const map = new Map<string, AffiliateProfile>();
    for (const profile of profiles) {
      map.set(profile.id, profile);
    }
    return map;
  }

  /**
   * Generate a unique ID
   */
  private generateId(): string {
    return `earn_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Log message if verbose mode is enabled
   */
  private log(message: string, job?: BatchJobProgress): void {
    if (this.config.verbose) {
      const prefix = job ? `[${job.job_id}] ` : '';
      logInfo(`${prefix}${message}`);
    }
  }

  /**
   * Create batch job result summary
   */
  private createJobResult(
    job: BatchJobProgress,
    conversionsProcessed: number,
    earningsCreated: number,
    totalAmount: number,
    errors: BatchError[]
  ): BatchJobResult {
    const completedAt = new Date().toISOString();
    const duration = Date.parse(completedAt) - Date.parse(job.started_at);

    return {
      job_id: job.job_id,
      success: errors.length === 0,
      conversions_processed: conversionsProcessed,
      earnings_created: earningsCreated,
      total_amount: totalAmount,
      errors,
      started_at: job.started_at,
      completed_at: completedAt,
      duration_ms: duration,
    };
  }

  /**
   * Complete a batch job with results
   */
  private completeJob(job: BatchJobProgress, result: BatchJobResult): void {
    job.status = BatchJobStatusCode.COMPLETED;
    job.completed_at = result.completed_at;
    job.total_conversions = result.conversions_processed;
    job.earnings_count = result.earnings_created;
    job.total_earnings_generated = result.total_amount;
    this.log(`Batch job ${job.job_id} completed: ${result.earnings_created} earnings created`, job);
  }

  /**
   * Get batch job progress
   */
  getJobProgress(job_id: string): BatchJobProgress | undefined {
    return this.jobRegistry.getJob(job_id);
  }

  /**
   * List all batch jobs
   */
  listJobs(): BatchJobProgress[] {
    return this.jobRegistry.listJobs();
  }

  /**
   * Calculate earnings summary for an affiliate
   *
   * @param earnings - All earnings records for the affiliate
   * @param conversions - Associated conversions for context
   * @returns Summary with totals and breakdown by level
   */
  calculateAffiliateSummary(
    earnings: EarningsRecord[],
    conversions: Conversion[]
  ): AffiliateEarningsSummary {
    const totalEarnings = earnings.reduce((sum, e) => sum + e.amount, 0);
    const pendingEarnings = earnings.filter(e => e.is_paid === 0).reduce((sum, e) => sum + e.amount, 0);
    const paidEarnings = earnings.filter(e => e.is_paid === 1).reduce((sum, e) => sum + e.amount, 0);

    // Breakdown by level
    const breakdownMap = new Map<number, { count: number; total: number }>();
    for (const earning of earnings) {
      const existing = breakdownMap.get(earning.level) || { count: 0, total: 0 };
      breakdownMap.set(earning.level, {
        count: existing.count + 1,
        total: existing.total + earning.amount,
      });
    }

    const breakdown: EarningsLevelBreakdown[] = Array.from(breakdownMap.entries())
      .map(([level, data]) => ({
        level,
        count: data.count,
        total_amount: data.total,
        avg_amount: data.count > 0 ? data.total / data.count : 0,
      }))
      .sort((a, b) => a.level - b.level);

    return {
      affiliate_id: '',
      affiliate_name: '',
      affiliate_email: '',
      total_earnings: totalEarnings,
      pending_earnings: pendingEarnings,
      paid_earnings: paidEarnings,
      conversions_count: conversions.length,
      breakdown,
      last_earnings_at: earnings.length > 0
        ? earnings.reduce((max, e) => e.created_at > max ? e.created_at : max, earnings[0].created_at)
        : null,
    };
  }

  /**
   * Filter conversions by date range
   */
  filterConversionsByDate(
    conversions: Conversion[],
    startDate: string | null,
    endDate: string | null
  ): Conversion[] {
    return conversions.filter(conv => {
      const convDate = new Date(conv.converted_at);
      if (startDate && convDate < new Date(startDate)) return false;
      if (endDate && convDate > new Date(endDate)) return false;
      return true;
    });
  }

  /**
   * Filter conversions by minimum commission amount
   */
  filterConversionsByMinCommission(
    conversions: Conversion[],
    minAmount: number
  ): Conversion[] {
    return conversions.filter(conv => conv.commission_amount >= minAmount);
  }

  /**
   * Build existing earnings lookup set for deduplication
   *
   * Takes a map of existing earnings and returns a Set of
   * "conversion_id:affiliate_id" keys for fast lookup.
   */
  buildExistingEarningsLookup(existingEarnings: EarningsRecord[]): Set<string> {
    const set = new Set<string>();
    for (const earning of existingEarnings) {
      set.add(`${earning.conversion_id}:${earning.affiliate_id}`);
    }
    return set;
  }

  /**
   * Build existing earnings lookup set for deduplication (alias for backward compatibility)
   */
  buildExistingEarningsLookback(existingEarnings: EarningsRecord[]): Set<string> {
    return this.buildExistingEarningsLookup(existingEarnings);
  }

  /**
   * Validate that a conversion is eligible for earnings calculation
   */
  isConversionEligible(conversion: Conversion, options: BatchOptions): boolean {
    // Check status
    if (conversion.status !== 'approved') {
      return false;
    }

    // Check commission amount
    if (conversion.commission_amount < options.min_commission_amount) {
      return false;
    }

    // Check date range
    if (options.start_date && conversion.converted_at < options.start_date) {
      return false;
    }
    if (options.end_date && conversion.converted_at > options.end_date) {
      return false;
    }

    return true;
  }

  /**
   * Create batch job progress tracker for external use
   */
  createProgressTracker(): {
    startJob: (options: BatchOptions) => BatchJobProgress;
    getJob: (job_id: string) => BatchJobProgress | undefined;
    listJobs: () => BatchJobProgress[];
  } {
    return {
      startJob: (options: BatchOptions) => this.jobRegistry.createJob(options),
      getJob: (job_id: string) => this.jobRegistry.getJob(job_id),
      listJobs: () => this.jobRegistry.listJobs(),
    };
  }
}

/**
 * Factory function to create a new earnings calculator
 *
 * @param config - Optional configuration
 * @returns Configured calculator instance
 */
export function createEarningsCalculator(config?: Partial<CalculatorConfig>): EarningsCalculator {
  return new EarningsCalculator(config);
}

/**
 * Default calculator singleton for simple use cases
 */
export const defaultCalculator = new EarningsCalculator();

// Re-export types for convenience
export type {
  Conversion,
  ReferralNode,
  AffiliateProfile,
  TierRates,
  BatchOptions,
  BatchJobProgress,
  BatchError,
  BatchJobResult,
  CalculatedEarning,
  AffiliateEarningsSummary,
  EarningsLevelBreakdown,
  ReferralLookup,
  EarningsRecord,
  EarningsDatabase,
};
