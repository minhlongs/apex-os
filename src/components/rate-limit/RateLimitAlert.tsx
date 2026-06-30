/**
 * Rate Limit Alert Component
 *
 * Displays a user-friendly message when rate limiting occurs.
 * Shows countdown until retry is available.
 */

'use client';

import React from 'react';
import { AlertTriangle, Clock, RefreshCw } from 'lucide-react';
import { useRateLimitCountdown } from '@/lib/api/hooks';

interface RateLimitAlertProps {
  /** Retry-after seconds from 429 response */
  retryAfter: number;
  /** Optional message to show */
  message?: string;
  /** Callback when user wants to retry */
  onRetry?: () => void;
  /** Whether to show countdown */
  showCountdown?: boolean;
  /** Additional CSS classes */
  className?: string;
}

/**
 * Displays rate limit exceeded message with countdown
 */
export function RateLimitAlert({
  retryAfter,
  message = 'You\'ve made too many requests. Please wait before trying again.',
  onRetry,
  showCountdown = true,
  className = ''
}: RateLimitAlertProps) {
  const { countdown, isExpired } = useRateLimitCountdown(retryAfter);

  if (isExpired && onRetry) {
    // Rate limit period has passed, allow retry
    return (
      <div className={`bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 ${className}`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <RefreshCw className="w-5 h-5 text-yellow-600 dark:text-yellow-400" />
            <p className="text-yellow-800 dark:text-yellow-200">
              Rate limit period has passed. You can try again now.
            </p>
          </div>
          <button
            onClick={onRetry}
            className="px-4 py-2 bg-yellow-600 text-white rounded-lg hover:bg-yellow-700 transition-colors text-sm font-medium"
          >
            Retry Now
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className={`bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg p-4 ${className}`}>
      <div className="flex items-start gap-3">
        <AlertTriangle className="w-5 h-5 text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" />
        <div className="flex-1">
          <h4 className="font-medium text-yellow-800 dark:text-yellow-200 mb-1">
            Rate Limit Exceeded
          </h4>
          <p className="text-sm text-yellow-700 dark:text-yellow-300 mb-3">
            {message}
          </p>
          {showCountdown && countdown > 0 && (
            <div className="flex items-center gap-2 text-sm text-yellow-600 dark:text-yellow-400">
              <Clock className="w-4 h-4" />
              <span>
                Please wait <strong>{countdown}s</strong> before trying again.
              </span>
            </div>
          )}
        </div>
        {onRetry && countdown > 0 && (
          <button
            onClick={onRetry}
            disabled
            className="px-4 py-2 bg-yellow-100 dark:bg-yellow-800 text-yellow-700 dark:text-yellow-300 rounded-lg text-sm font-medium cursor-not-allowed opacity-50"
          >
            Wait {countdown}s
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Inline rate limit indicator (small badge)
 */
interface RateLimitBadgeProps {
  remaining: number;
  limit: number;
  className?: string;
}

export function RateLimitBadge({ remaining, limit, className = '' }: RateLimitBadgeProps) {
  const percentage = (remaining / limit) * 100;

  const getColor = () => {
    if (percentage <= 10) return 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400';
    if (percentage <= 30) return 'bg-yellow-100 text-yellow-700 dark:bg-yellow-900/30 dark:text-yellow-400';
    return 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400';
  };

  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${getColor()} ${className}`}>
      {remaining}/{limit} requests
    </span>
  );
}

/**
 * Rate limit progress bar
 */
interface RateLimitProgressProps {
  remaining: number;
  limit: number;
  showLabel?: boolean;
  className?: string;
}

export function RateLimitProgress({ remaining, limit, showLabel = true, className = '' }: RateLimitProgressProps) {
  const percentage = Math.max(0, Math.min(100, (remaining / limit) * 100));

  const getBarColor = () => {
    if (percentage <= 10) return 'bg-red-500';
    if (percentage <= 30) return 'bg-yellow-500';
    return 'bg-green-500';
  };

  return (
    <div className={className}>
      {showLabel && (
        <div className="flex justify-between text-xs text-gray-600 dark:text-gray-400 mb-1">
          <span>Rate Limit</span>
          <span>{remaining} / {limit}</span>
        </div>
      )}
      <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
        <div
          className={`h-full ${getBarColor()} transition-all duration-300`}
          style={{ width: `${percentage}%` }}
        />
      </div>
    </div>
  );
}
