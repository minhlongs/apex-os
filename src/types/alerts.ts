/**
 * Alert Storage Layer Types
 *
 * Unified alert storage for all alert types (business, D1, custom).
 */

export type AlertSeverity = 'info' | 'warning' | 'critical';
export type AlertStatus = 'active' | 'resolved' | 'snoozed' | 'acknowledged';

export interface Alert {
  id: string;
  rule_id: string;
  severity: AlertSeverity;
  message: string;
  triggered_at: string; // ISO 8601 timestamp from database
  resolved_at: string | null;
  snoozed_until: string | null;
  context: Record<string, unknown>; // JSON object
  status: AlertStatus; // Generated column from DB
}

export interface AlertWithMetadata extends Alert {
  rule_name?: string;
  source?: 'business' | 'd1' | 'custom';
  metric_type?: string;
  minutes_active?: number;
  resolution_time_minutes?: number;
}

export interface AlertQueryOptions {
  status?: AlertStatus | 'all';
  severity?: AlertSeverity | 'all';
  rule_id?: string;
  limit?: number;
  offset?: number;
  since?: Date; // Filter by triggered_at >= since
  until?: Date; // Filter by triggered_at <= until
}

export interface AlertFilters {
  status?: AlertStatus | 'all';
  severity?: AlertSeverity | 'all';
  type?: string | 'all';
  isRead?: boolean;
  isSilenced?: boolean;
  startDate?: string;
  endDate?: string;
}

export interface AlertStats {
  rule_id: string;
  severity: AlertSeverity;
  total_triggered: number;
  active_count: number;
  snoozed_count: number;
  resolved_count: number;
  avg_resolution_time_minutes: number | null;
  first_triggered: string;
  last_triggered: string;
}

export interface AlertRule {
  id: string;
  name: string;
  source: 'business' | 'd1' | 'custom';
  metric_type?: string;
}

export interface CreateAlertInput {
  rule_id: string;
  severity: AlertSeverity;
  message: string;
  context?: Record<string, unknown>;
  triggered_at?: Date;
  snoozed_until?: Date;
}

export interface UpdateAlertInput {
  resolved_at?: Date;
  snoozed_until?: Date | null;
}

export interface AlertRetentionPolicy {
  retention_days: number;
  auto_cleanup_enabled: boolean;
  last_cleanup_at?: Date;
}

export const DEFAULT_RETENTION_POLICY: AlertRetentionPolicy = {
  retention_days: 90,
  auto_cleanup_enabled: true,
};

export interface AlertStorageConfig {
  retention_policy?: AlertRetentionPolicy;
}
