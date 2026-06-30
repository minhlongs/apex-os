/**
 * E2E Tests Index
 *
 * Aggregates all end-to-end test suites for the alert system.
 */

export { createMockDB, AdminAlertsAPI, UnreadAlertsPoller } from './admin-alerts-badge-e2e.test';
export { createMockDB as createAlertSystemMockDB, AlertStorage } from './alert-system-e2e.test';
export { createMockResendAPI, createMockWebhook, NotificationService } from './notification-channels-e2e.test';
