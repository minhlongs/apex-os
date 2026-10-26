/**
 * Database Module - Centralized D1 Database Access with Query Monitoring
 *
 * This module provides:
 * - Wrapped D1 database with automatic query cost monitoring
 * - getDB() helper for accessing the wrapped database
 * - initializeDB() for application startup
 *
 * Types extend d1-adapter.ts with additional methods like close().
 */

import {
  QueryMonitor,
  initializeQueryMonitor,
  wrapDatabase,
  getGlobalMonitor,
  resetGlobalMonitor,
} from './query-monitor';
import type { D1Database as D1DatabaseBase } from '@/lib/auth/adapters/d1-adapter';
import { warn as logWarn, info as logInfo } from '@/lib/logger';

/**
 * Extended D1 Database interface with close() method
 * Extends the base d1-adapter interface
 */
export interface D1Database extends D1DatabaseBase {
  close(): Promise<void>;
}

export type { D1PreparedStatement, D1Result } from '@/lib/auth/adapters/d1-adapter';
export type { QueryMetrics, QueryMonitorStats } from './query-monitor';

// ============================================================================
// Global State
// ============================================================================

let wrappedDb: D1Database | null = null;
let isInitialized = false;

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the database module with query monitoring.
 *
 * Call this once at application startup (e.g., in middleware or root layout).
 * This wraps the global Cloudflare D1 binding with monitoring.
 *
 * @param config - Query monitor configuration options
 * @returns The wrapped database instance
 */
export function initializeDB(config?: {
  slowQueryThresholdMs?: number;
  highRowScanThreshold?: number;
  enableConsoleLog?: boolean;
}): D1Database {
  if (isInitialized && wrappedDb) {
    logWarn('[db] Already initialized, returning existing instance');
    return wrappedDb;
  }

  // Get the original D1 database from Cloudflare Workers global scope
  const originalDb = (globalThis as unknown as { DB: D1Database }).DB;

  if (!originalDb) {
    throw new Error(
      '[db] D1 database not found in globalThis.DB. ' +
      'Ensure this code runs in a Cloudflare Workers environment with D1 binding.'
    );
  }

  const slowThreshold = config?.slowQueryThresholdMs ?? 100;
  const highScanThreshold = config?.highRowScanThreshold ?? 10000;

  // Initialize the query monitor with persistence to the same DB
  const monitor = initializeQueryMonitor({
    slowQueryThresholdMs: slowThreshold,
    highRowScanThreshold: highScanThreshold,
    enableConsoleLog: config?.enableConsoleLog ?? true,
    persistenceDb: originalDb,
  });

  // Wrap the database with monitoring
  wrappedDb = wrapDatabase(originalDb);

  isInitialized = true;

  logInfo('[db] Database initialized with query monitoring', {
    slowQueryThresholdMs: slowThreshold,
    highRowScanThreshold: highScanThreshold,
  });

  return wrappedDb;
}

/**
 * Get the wrapped database instance.
 *
 * Throws if initializeDB() hasn't been called yet.
 *
 * @returns The wrapped D1Database instance
 */
export function getDB(): D1Database {
  if (!wrappedDb) {
    // Try to auto-initialize from globalThis.DB
    const originalDb = (globalThis as unknown as { DB: D1Database }).DB;
    if (originalDb) {
      logInfo('[db] Auto-initializing database with default monitoring config');
      return initializeDB();
    }

    throw new Error(
      '[db] Database not initialized. Call initializeDB() first, ' +
      'or ensure this is running in a Cloudflare Workers environment.'
    );
  }

  return wrappedDb;
}

/**
 * Get the query monitor instance for stats and debugging.
 */
export function getQueryMonitor(): QueryMonitor | null {
  return getGlobalMonitor();
}

/**
 * Check if the database has been initialized.
 */
export function isDBInitialized(): boolean {
  return isInitialized && wrappedDb !== null;
}

/**
 * Reset the database module (useful for testing).
 */
export function resetDB(): void {
  wrappedDb = null;
  isInitialized = false;
  resetGlobalMonitor();
}
