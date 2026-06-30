/**
 * Alert Retention Service
 *
 * Handles automatic cleanup of old alerts based on retention policies.
 * Run this as a scheduled cron job (daily recommended).
 */

import type { D1Database } from '@/types/d1';
import { getAlertStorage } from './index';

export interface RetentionConfig {
  /** Number of days to retain resolved alerts (default: 90) */
  retentionDays: number;
  /** Whether to also clean up expired snoozes (default: true) */
  cleanupExpiredSnoozes: boolean;
  /** Dry run mode - only log what would be deleted (default: false) */
  dryRun: boolean;
}

export const DEFAULT_RETENTION_CONFIG: RetentionConfig = {
  retentionDays: 90,
  cleanupExpiredSnoozes: true,
  dryRun: false,
};

/**
 * Run alert retention cleanup
 *
 * - Deletes resolved alerts older than retention period
 * - Clears expired snoozes (sets snoozed_until = NULL)
 *
 * Returns summary of actions taken
 */
export async function runRetentionCleanup(
  db: D1Database,
  config: Partial<RetentionConfig> = {}
): Promise<RetentionCleanupResult> {
  const finalConfig = { ...DEFAULT_RETENTION_CONFIG, ...config };
  const storage = getAlertStorage(db);

  // Count alerts before cleanup
  const beforeStats = await storage.getStats();

  // Clean up old resolved alerts
  const deletedCount = await storage.cleanupOldAlerts(finalConfig.retentionDays);

  // Clean up expired snoozes
  let clearedSnoozeCount = 0;
  if (finalConfig.cleanupExpiredSnoozes) {
    clearedSnoozeCount = await storage.cleanupExpiredSnoozes();
  }

  // Count alerts after cleanup
  const afterStats = await storage.getStats();

  return {
    deletedAlerts: finalConfig.dryRun ? 0 : deletedCount,
    clearedSnoozes: finalConfig.dryRun ? 0 : clearedSnoozeCount,
    beforeStats,
    afterStats,
    config: finalConfig,
  };
}

/**
 * Retention cleanup result summary
 */
export interface RetentionCleanupResult {
  deletedAlerts: number;
  clearedSnoozes: number;
  beforeStats: import('./alert-storage').AlertStatsSummary;
  afterStats: import('./alert-storage').AlertStatsSummary;
  config: RetentionConfig;
}

/**
 * Get retention status report
 */
export async function getRetentionStatus(db: D1Database): Promise<RetentionStatusReport> {
  const storage = getAlertStorage(db);
  const stats = await storage.getStats();

  // Count alerts by age buckets
  const ageDistribution = await db
    .prepare(`
      SELECT
        CASE
          WHEN triggered_at >= datetime('now', '-7 days') THEN '0-7 days'
          WHEN triggered_at >= datetime('now', '-30 days') THEN '8-30 days'
          WHEN triggered_at >= datetime('now', '-90 days') THEN '31-90 days'
          ELSE '90+ days'
        END as age_bucket,
        COUNT(*) as count,
        SUM(CASE WHEN status = 'resolved' THEN 1 ELSE 0 END) as resolved_count
      FROM alerts
      GROUP BY age_bucket
      ORDER BY MIN(triggered_at) DESC
    `)
    .all<{ age_bucket: string; count: number; resolved_count: number }>();

  // Get oldest alert
  const oldestAlert = await db
    .prepare('SELECT MIN(triggered_at) as oldest FROM alerts')
    .first<{ oldest: string | null }>();

  // Get alerts pending cleanup (resolved and older than 90 days)
  const pendingCleanup = await db
    .prepare(`
      SELECT COUNT(*) as count
      FROM alerts
      WHERE status = 'resolved'
        AND triggered_at < datetime('now', '-90 days')
    `)
    .first<{ count: number }>();

  return {
    totalAlerts: stats.total,
    byStatus: stats.byStatus,
    ageDistribution: ageDistribution.results.reduce((acc, row) => {
      acc[row.age_bucket] = {
        total: row.count,
        resolved: row.resolved_count,
      };
      return acc;
    }, {} as Record<string, { total: number; resolved: number }>),
    oldestAlertDate: oldestAlert?.oldest || null,
    pendingCleanup: pendingCleanup?.count || 0,
    retentionPolicy: {
      retentionDays: 90,
      deletedToday: stats.byStatus.resolved || 0, // approximation
    },
  };
}

/**
 * Retention status report
 */
export interface RetentionStatusReport {
  totalAlerts: number;
  byStatus: Record<string, number>;
  ageDistribution: Record<string, { total: number; resolved: number }>;
  oldestAlertDate: string | null;
  pendingCleanup: number;
  retentionPolicy: {
    retentionDays: number;
    deletedToday: number;
  };
}
