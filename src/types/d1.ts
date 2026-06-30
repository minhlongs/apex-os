/**
 * D1 Database Type Definitions
 * Provides TypeScript types for Cloudflare D1 database bindings
 */

export interface D1Database {
  prepare(sql: string): D1Statement;
  exec(sql: string): Promise<D1ExecResult>;
  batch<T>(statements: D1BatchStatement<T>[]): Promise<D1BatchResult<T>>;
  close(): Promise<void>;
}

export interface D1Statement {
  bind(...values: unknown[]): D1PreparedStatement;
  first<T = unknown>(): Promise<T | undefined>;
  all<T = unknown>(): Promise<D1QueryResult<T>>;
  run(): Promise<D1ExecResult>;
}

export interface D1PreparedStatement {
  run(): Promise<D1ExecResult>;
  all<T = unknown>(): Promise<D1QueryResult<T>>;
  first<T = unknown>(): Promise<T | undefined>;
}

export interface D1ExecResult {
  meta: D1Meta;
  success: boolean;
}

export interface D1QueryResult<T> {
  results: T[];
  meta: D1Meta;
}

export interface D1Meta {
  last_row_id: number;
  rows_written: number;
  changes: number;
  duration: number;
}

export interface D1BatchStatement<T> {
  sql: string;
  params?: unknown[];
  namedParams?: Record<string, unknown>;
}

export interface D1BatchResult<T> {
  results: T[];
  success: boolean;
}

// Row types for monitoring tables
export interface D1MetricsHistoryRow {
  id: string;
  timestamp: string;
  storage_bytes: number;
  page_count: number;
  page_size: number;
  avg_query_duration_ms: number;
  max_query_duration_ms: number;
  slow_query_count: number;
  total_queries: number;
  total_rows_scanned: number;
  cache_hit_ratio: number | null;
  wal_size_bytes: number;
  collected_at: string;
}

export interface D1SlowQueryRow {
  id: string;
  logged_at: string;
  query_text: string;
  duration_ms: number;
  rows_scanned: number;
  rows_returned: number;
  endpoint_path: string | null;
  user_id: string | null;
  context: string;
}

export interface D1AlertConfigRow {
  id: string;
  name: string;
  description: string | null;
  metric_type: string;
  threshold_type: string;
  threshold_value: number;
  evaluation_window_minutes: number;
  severity: string;
  alert_channels: string;
  cooldown_minutes: number;
  is_enabled: number;
  created_at: string;
  updated_at: string;
}

export interface D1AlertHistoryRow {
  id: string;
  alert_config_id: string;
  triggered_at: string;
  resolved_at: string | null;
  current_value: number;
  threshold_value: number;
  details: string;
  status: string;
  metadata: string;
}

export interface D1AlertWithConfigRow extends D1AlertHistoryRow {
  config_name: string;
  severity: string;
  metric_type: string;
}

export interface D1AlertSnoozeRow {
  id: string;
  alert_config_id: string;
  snoozed_by: string | null;
  duration_minutes: number;
  created_at: string;
  expires_at: string;
  reason: string | null;
  metadata: string;
}

/**
 * Dead Letter Queue entry for failed notifications
 */
export interface DeadLetterQueueRow {
  id: string;
  job_id: string;
  alert_id: string | null;
  channel: 'email' | 'slack' | 'telegram' | 'webhook' | 'console';
  payload: string; // JSON string
  error: string;
  attempts: number;
  max_attempts: number;
  created_at: string;
  failed_at: string;
  next_retry_at: string | null;
  dead_letter_reason: string | null;
  admin_notes: string | null;
}

/**
 * Notification Retry History entry
 */
export interface NotificationRetryHistoryRow {
  id: string;
  dead_letter_id: string | null;
  job_id: string;
  attempt_number: number;
  error: string | null;
  attempted_at: string;
  success: number; // 0 or 1
}

/**
 * Dispatcher Statistics aggregated record
 */
export interface DispatcherStatsRow {
  id: string;
  period_start: string;
  period_end: string;
  total_jobs_processed: number;
  successful_jobs: number;
  failed_jobs: number;
  dead_letters_created: number;
  batches_processed: number;
  avg_processing_time_ms: number | null;
  max_processing_time_ms: number | null;
  min_processing_time_ms: number | null;
  channel_breakdown: string; // JSON string
  recorded_at: string;
}


