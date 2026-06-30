/**
 * Alerts Module Exports
 *
 * Provides alert storage, types, and utilities for the ApexOS alert system.
 */

export { AlertStorage, getAlertStorage } from './alert-storage';
export type {
  Alert,
  AlertWithMetadata,
  AlertQueryOptions,
  AlertStats,
  AlertSeverity,
  AlertStatus,
  AlertRule,
  CreateAlertInput,
  UpdateAlertInput,
  AlertRetentionPolicy,
  AlertStorageConfig,
} from '@/types/alerts';
export type { AlertStatsSummary } from './alert-storage';
