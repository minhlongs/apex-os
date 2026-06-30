'use client';

import { useState, useEffect, useCallback, useRef, useSyncExternalStore } from 'react';

interface UnreadAlertsResponse {
  success: boolean;
  summary?: {
    unreadAlerts: number;
  };
}

const BASE_POLLING_INTERVAL_MS = 30_000; // 30 seconds
const MAX_BACKOFF_MS = 5 * 60_000; // 5 minutes
const ERROR_BACKOFF_MULTIPLIER = 2;
const VISIBILITY_CHECK_INTERVAL_MS = 1_000; // Check visibility state every second

// Visibility state tracking using the Page Visibility API
function usePageVisibility() {
  return useSyncExternalStore(
    (callback) => {
      const handleVisibilityChange = () => callback();
      document.addEventListener('visibilitychange', handleVisibilityChange);
      return () => document.removeEventListener('visibilitychange', handleVisibilityChange);
    },
    () => document.visibilityState === 'visible',
    () => true // Default to visible for SSR
  );
}

export function useUnreadAlertsCount() {
  const [count, setCount] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | null>(null);
  const [isPollingActive, setIsPollingActive] = useState(true);

  const intervalRef = useRef<NodeJS.Timeout | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const backoffExpirationRef = useRef<number>(0);
  const currentIntervalRef = useRef<number>(BASE_POLLING_INTERVAL_MS);
  const consecutiveErrorsRef = useRef<number>(0);
  const isMountedRef = useRef<boolean>(true);

  const isPageVisible = usePageVisibility();

  const fetchUnreadCount = useCallback(async (): Promise<boolean> => {
    // Don't fetch if there's an active abort signal
    if (abortControllerRef.current?.signal.aborted) {
      return false;
    }

    try {
      // Add cache-busting parameter to avoid stale responses
      const cacheBuster = Date.now();
      const response = await fetch(`/api/admin/alerts?cacheBuster=${cacheBuster}`, {
        method: 'GET',
        headers: {
          'Content-Type': 'application/json',
          'Cache-Control': 'no-cache',
        },
        signal: abortControllerRef.current?.signal,
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          // Not authorized - likely not admin, stop polling
          setError(new Error('Unauthorized'));
          return false;
        }
        throw new Error(`Failed to fetch unread count: ${response.statusText}`);
      }

      const data: UnreadAlertsResponse = await response.json();

      if (data.success && data.summary !== undefined) {
        // Only update count if it changed (avoids unnecessary re-renders)
        setCount(prevCount => {
          if (prevCount !== data.summary!.unreadAlerts) {
            return data.summary!.unreadAlerts;
          }
          return prevCount;
        });
        setError(null);
        consecutiveErrorsRef.current = 0;
        currentIntervalRef.current = BASE_POLLING_INTERVAL_MS;
        backoffExpirationRef.current = 0;
        return true;
      }

      return false;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // Request was cancelled, don't set error
        return false;
      }
      console.error('Failed to fetch unread alerts count:', err);
      setError(err instanceof Error ? err : new Error('Unknown error'));

      // Increment backoff on error
      consecutiveErrorsRef.current += 1;
      const backoffMultiplier = Math.pow(ERROR_BACKOFF_MULTIPLIER, Math.min(consecutiveErrorsRef.current - 1, 3));
      currentIntervalRef.current = Math.min(BASE_POLLING_INTERVAL_MS * backoffMultiplier, MAX_BACKOFF_MS);
      backoffExpirationRef.current = Date.now() + currentIntervalRef.current;

      return false;
    }
  }, []);

  const refresh = useCallback(async () => {
    // Reset backoff on manual refresh
    consecutiveErrorsRef.current = 0;
    currentIntervalRef.current = BASE_POLLING_INTERVAL_MS;
    await fetchUnreadCount();
  }, [fetchUnreadCount]);

  const stopPolling = useCallback(() => {
    setIsPollingActive(false);
    if (intervalRef.current) {
      clearTimeout(intervalRef.current);
      intervalRef.current = null;
    }
    abortControllerRef.current?.abort();
  }, []);

  const startPolling = useCallback(() => {
    setIsPollingActive(true);
  }, []);

  // Main polling loop
  useEffect(() => {
    isMountedRef.current = true;

    const poll = async () => {
      if (!isMountedRef.current) return;

      // Only poll when page is visible
      if (!isPageVisible) {
        // Check again later
        intervalRef.current = setTimeout(poll, VISIBILITY_CHECK_INTERVAL_MS);
        return;
      }

      setLoading(true);
      await fetchUnreadCount();
      setLoading(false);

      if (!isMountedRef.current) return;

      // Schedule next poll
      const nextInterval = currentIntervalRef.current;
      intervalRef.current = setTimeout(poll, nextInterval);
    };

    // Start polling
    poll();

    // Cleanup - capture the current abort controller to avoid race condition
    const abortController = abortControllerRef.current;
    return () => {
      isMountedRef.current = false;
      if (intervalRef.current) {
        clearTimeout(intervalRef.current);
      }
      abortController?.abort();
    };
  }, [fetchUnreadCount, isPageVisible]);

  return {
    count,
    loading,
    error,
    refresh,
    stopPolling,
    startPolling,
    isPollingActive,
    isPageVisible,
  };
}
