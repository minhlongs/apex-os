/**
 * Structured Webhook Error Responses
 * Provides consistent error response format with proper HTTP status codes
 */

import { WebhookErrorCode } from './types';

export interface ErrorResponse {
  success: false;
  error: WebhookErrorCode;
  message: string;
  details?: string;
  timestamp: string;
  requestId?: string;
}

/**
 * Generate a unique request ID for tracking
 */
export function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`;
}

/**
 * Create standardized error response
 */
export function createErrorResponse(
  code: WebhookErrorCode,
  message: string,
  details?: string,
  requestId?: string
): ErrorResponse {
  return {
    success: false,
    error: code,
    message,
    details,
    timestamp: new Date().toISOString(),
    requestId: requestId ?? generateRequestId(),
  };
}

/**
 * Error response factory with HTTP status code mapping
 */
export const WebhookErrorResponses = {
  // Authentication errors (401)
  missingSignature: (requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.MISSING_SIGNATURE,
      'Webhook signature is required',
      'The request is missing the required signature header. Ensure your webhook sender includes the HMAC signature.',
      requestId
    ),

  invalidSignature: (details?: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.INVALID_SIGNATURE,
      'Invalid webhook signature',
      details,
      requestId
    ),

  signatureVerificationError: (error: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.SIGNATURE_VERIFICATION_ERROR,
      'Signature verification failed',
      error,
      requestId
    ),

  // Validation errors (400)
  missingTimestamp: (requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.MISSING_TIMESTAMP,
      'Webhook timestamp is required',
      'The request is missing a valid timestamp header or payload field.',
      requestId
    ),

  timestampOutsideWindow: (ageMs: number, windowMs: number, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.TIMESTAMP_OUTSIDE_WINDOW,
      'Webhook timestamp outside acceptable window',
      `Webhook is ${(ageMs / 1000).toFixed(1)}s old. Acceptable window: ${(windowMs / 1000).toFixed(1)} seconds. This may be a replayed webhook.`,
      requestId
    ),

  invalidTimestampFormat: (details?: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.INVALID_TIMESTAMP_FORMAT,
      'Invalid timestamp format',
      details,
      requestId
    ),

  unsupportedExchange: (exchange: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.UNSUPPORTED_EXCHANGE,
      `Unsupported exchange: ${exchange}`,
      'The webhook payload could not be matched to a supported exchange.',
      requestId
    ),

  exchangeNotConfigured: (exchange: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.EXCHANGE_NOT_CONFIGURED,
      `Exchange webhook secret not configured: ${exchange}`,
      `The ${exchange} webhook secret is not set in environment variables.`,
      requestId
    ),

  invalidPayload: (details?: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.INVALID_PAYLOAD,
      'Invalid webhook payload',
      details ?? 'The webhook payload could not be parsed or is missing required fields.',
      requestId
    ),

  unsupportedEventType: (eventType: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.UNSUPPORTED_EVENT_TYPE,
      `Unsupported event type: ${eventType}`,
      `The webhook event type "${eventType}" is not processed by this endpoint.`,
      requestId
    ),

  // Replay protection errors (409)
  potentialReplayAttack: (requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.POTENTIAL_REPLAY_ATTACK,
      'Potential replay attack detected',
      'This webhook signature has already been processed. The request has been rejected to prevent duplicate processing or replay attacks.',
      requestId
    ),

  duplicateWebhook: (orderId: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.DUPLICATE_WEBHOOK,
      'Duplicate webhook',
      `A conversion for order ${orderId} already exists in the system.`,
      requestId
    ),

  // System errors (500)
  databaseError: (error: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.DATABASE_ERROR,
      'Database operation failed',
      error,
      requestId
    ),

  processingError: (error: string, requestId?: string) =>
    createErrorResponse(
      WebhookErrorCode.PROCESSING_ERROR,
      'Webhook processing failed',
      error,
      requestId
    ),
};

/**
 * Map error codes to HTTP status codes
 */
export const ERROR_STATUS_MAP: Record<WebhookErrorCode, number> = {
  [WebhookErrorCode.MISSING_SIGNATURE]: 401,
  [WebhookErrorCode.INVALID_SIGNATURE]: 401,
  [WebhookErrorCode.SIGNATURE_VERIFICATION_ERROR]: 401,
  [WebhookErrorCode.MISSING_TIMESTAMP]: 400,
  [WebhookErrorCode.TIMESTAMP_OUTSIDE_WINDOW]: 400,
  [WebhookErrorCode.INVALID_TIMESTAMP_FORMAT]: 400,
  [WebhookErrorCode.UNSUPPORTED_EXCHANGE]: 400,
  [WebhookErrorCode.EXCHANGE_NOT_CONFIGURED]: 400,
  [WebhookErrorCode.INVALID_PAYLOAD]: 400,
  [WebhookErrorCode.UNSUPPORTED_EVENT_TYPE]: 400,
  [WebhookErrorCode.POTENTIAL_REPLAY_ATTACK]: 409,
  [WebhookErrorCode.DUPLICATE_WEBHOOK]: 409,
  [WebhookErrorCode.DATABASE_ERROR]: 500,
  [WebhookErrorCode.PROCESSING_ERROR]: 500,
};

/**
 * Get HTTP status code for error code
 */
export function getHttpStatusCode(errorCode: WebhookErrorCode): number {
  return ERROR_STATUS_MAP[errorCode] ?? 500;
}
