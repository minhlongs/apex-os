import * as Sentry from '@sentry/nextjs';
import { info as logInfo } from '@/lib/logger';

/**
 * Sentry Configuration
 *
 * This module provides centralized Sentry configuration and utilities
 * for capturing errors, exceptions, and performance metrics.
 */

// Initialize Sentry only if DSN is configured
export function initializeSentry() {
  const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;
  const enabled = process.env.NEXT_PUBLIC_SENTRY_ENABLED !== 'false';
  const environment = process.env.SENTRY_ENVIRONMENT || 'development';

  if (!dsn || !enabled) {
    logInfo('[Sentry] Disabled: DSN not configured or disabled');
    return null;
  }

  // Initialize Sentry
  Sentry.init({
    dsn: dsn,
    environment: environment,
    enabled: environment !== 'development' || process.env.NODE_ENV === 'development',

    // Performance Monitoring
    tracesSampleRate: 1.0, // Capture 100% of transactions for now, adjust in production

    // Session Replay (optional - uncomment to enable)
    // replaysSessionSampleRate: 0.1, // 10% of sessions
    // replaysOnErrorSampleRate: 1.0, // 100% of sessions with errors

    // Integration-specific settings
    integrations: [
      Sentry.browserTracingIntegration(),
      Sentry.replayIntegration({
        // Additional config for replay
        maskAllText: false,
        blockAllMedia: false,
      }),
    ],

    // Filter out common development/noise errors
    beforeSend(event, hint) {
      // Skip certain errors in production
      if (event.exception?.values?.[0]?.type === 'UnhandledRejection') {
        // Optional: filter specific unhandled rejections
      }

      // Add custom tags for better filtering
      event.tags = {
        ...event.tags,
        framework: 'nextjs',
        deployment: environment,
        app: 'apex-os',
      };

      return event;
    },

    // Error filtering
    beforeBreadcrumb(breadcrumb) {
      // Skip breadcrumbs for static assets
      if (breadcrumb.category === 'console' && /\.(js|css|png|jpg|svg)/.test(breadcrumb.message || '')) {
        return null;
      }
      return breadcrumb;
    },

    // Debug mode (set to false in production)
    debug: environment === 'development',
  });

  return Sentry;
}

/**
 * Capture manual exceptions with context
 */
export function captureException(error: Error, context?: Record<string, any>) {
  if (process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'false') return;

  Sentry.captureException(error, {
    extra: context,
  });
}

/**
 * Capture custom messages
 */
export function captureMessage(message: string, level: Sentry.SeverityLevel = 'info') {
  if (process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'false') return;

  Sentry.captureMessage(message, { level });
}

/**
 * Add breadcrumb for debugging
 */
export function addBreadcrumb(category: string, message: string, data?: Record<string, any>) {
  if (process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'false') return;

  Sentry.addBreadcrumb({
    category,
    message,
    data,
    level: 'info',
  });
}

/**
 * Set user context for error tracking
 */
export function setUserContext(user: { id: string; email?: string; walletAddress?: string }) {
  if (process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'false') return;

  Sentry.setUser({
    id: user.id,
    email: user.email,
    // Custom fields
    walletAddress: user.walletAddress,
  });
}

/**
 * Clear user context (on logout)
 */
export function clearUserContext() {
  Sentry.setUser(null);
}

/**
 * Start a performance span for API calls
 */
export function startSpan<T>(
  name: string,
  operation: string,
  callback: (span: Sentry.Span) => T
): T {
  if (process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'false') {
    return callback({} as Sentry.Span);
  }

  return Sentry.startSpan({ name, op: operation }, callback);
}

// Initialize on import
const sentry = initializeSentry();

// Export default Sentry instance
export default sentry;
