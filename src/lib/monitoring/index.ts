/**
 * Monitoring Module - Unified exports for D1 monitoring and alert engine
 */

export {
  // D1 Monitor core functions
  collectStorageMetrics,
  runMonitoringCycle,
  executeMonitoredQuery,
  saveMetricsSnapshot,
  saveSlowQueries,
  evaluateAlerts,
  sendAlertNotifications,
  // Snooze management
  isAlertSnoozed,
  getActiveSnoozes,
  createSnooze,
  deleteSnooze,
  cleanupExpiredSnoozes,
  getSnoozeForConfig,
  getSnoozeHistory,
  // D1 Monitor utilities
  getStoragePercentage,
  getRecentMetrics,
  getActiveAlerts,
  // D1 Monitor types
  DEFAULT_ALERT_CONFIGS,
  queryMetricsCollector,
} from './d1-monitor';

export {
  // Alert Engine
  AlertEngine,
  runAlertEngine,
  getAlertEngine,
  getAlertRules,
  DEFAULT_BUSINESS_ALERT_RULES,
  DEFAULT_D1_ALERT_RULES,
  ALL_DEFAULT_RULES,
} from './alert-engine';

export {
  // Circuit Breaker
  getCircuitBreaker,
  resetCircuitBreaker,
  resetAllCircuitBreakers,
  initializeAllCircuitBreakers,
} from './circuit-breaker';

export {
  // Evaluation State Storage
  getEvaluationStateStorage,
} from './evaluation-state-storage';

// Types from d1-monitor
export type {
  D1StorageMetrics,
  D1QueryMetrics,
  D1MetricsSnapshot,
  AlertConfig,
  Alert as D1MonitorAlert,
  AlertSnooze,
  CreateSnoozeInput,
} from './d1-monitor';

export type {
  AlertRule,
  AlertChannel,
  AlertSeverity,
  AlertFilters as EngineAlertFilters,
  AlertContext,
  AlertResult,
  AlertEngineConfig,
  MetricSource,
} from './alert-engine';

// Types from evaluation-state
export type {
  EvaluationRun,
  RuleEvaluationHistory,
  EvaluationError,
  CircuitBreakerEntry,
  AlertEngineMetrics,
  EvaluationStats,
  RuleStats,
  ErrorCategory,
  EvaluationConfig,
} from '@/types/evaluation-state';

export type {
  CircuitBreaker,
} from './circuit-breaker';

export type {
  CircuitBreakerOptions,
  CircuitBreakerState,
} from '@/types/evaluation-state';
