import { NextRequest, NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';

type ErrorTrackingOptions = Record<string, boolean>;

/**
 * API Error Tracking Middleware
 *
 * Wrap API route handlers with this to automatically capture
 * exceptions, add performance tracing, and log errors.
 *
 * Usage:
 *   export const GET = withErrorTracking(async (req: NextRequest) => {
 *     // Your handler logic
 *   });
 */

export function withErrorTracking<T extends (...args: any[]) => any>(
  handler: T,
  options?: {
    captureErrors?: boolean;
    addPerformanceTrace?: boolean;
    breadcrumbs?: boolean;
  }
) {
  const {
    captureErrors = true,
    addPerformanceTrace = true,
    breadcrumbs = true,
  } = options || {};

  return async (...args: Parameters<T>): Promise<ReturnType<T>> => {
    const [req] = args;
    const route = req.nextUrl.pathname;

    // Start performance span if enabled
    const span = addPerformanceTrace
      ? (Sentry as any).startSpan({
          name: `API: ${req.method} ${route}`,
          op: 'http.server',
        })
      : null;

    try {
      // Add request breadcrumb
      if (breadcrumbs && captureErrors) {
        Sentry.addBreadcrumb({
          category: 'http',
          message: `${req.method} ${route}`,
          data: {
            url: req.nextUrl.toString(),
            method: req.method,
            headers: {
              'user-agent': req.headers.get('user-agent'),
              'content-type': req.headers.get('content-type'),
            },
          },
        });
      }

      // Execute the handler
      const result = await handler(...args);

      // Record successful response
      if (span) {
        span.setHttpStatus(200);
        span.setTag('http.status_code', '200');
        span.finish();
      }

      return result;
    } catch (error) {
      // Capture error in Sentry
      if (captureErrors && process.env.NEXT_PUBLIC_SENTRY_ENABLED !== 'false') {
        Sentry.captureException(error, {
          tags: {
            route,
            method: req.method,
          },
          extra: {
            url: req.nextUrl.toString(),
            headers: {
              'user-agent': req.headers.get('user-agent'),
            },
            // Don't log sensitive body data
            body: req.headers.get('content-type')?.includes('application/json')
              ? '[JSON body - omitted for security]'
              : undefined,
          },
        });

        // Set HTTP status for span
        if (span) {
          span.setHttpStatus(500);
          span.setTag('http.status_code', '500');
          span.setStatus('internal_error');
          span.finish();
        }
      }

      // Re-throw to let Next.js handle error response
      throw error;
    }
  };
}

/**
 * Error response helper for API routes
 */
export function createErrorResponse(
  message: string,
  status: number = 500,
  details?: Record<string, any>
): NextResponse {
  return NextResponse.json(
    {
      error: message,
      ...(details && { details }),
      requestId: (Sentry.getCurrentScope() as any)?.span?.spanId(),
    },
    { status }
  );
}

/**
 * Log and capture validation errors (4xx) - these are typically not bugs
 */
export function captureValidationError(message: string, data?: Record<string, any>) {
  if (process.env.NEXT_PUBLIC_SENTRY_ENABLED === 'false') return;

  Sentry.captureMessage(`Validation Error: ${message}`, {
    level: 'warning',
    extra: data,
    tags: { error_type: 'validation' },
  });
}
