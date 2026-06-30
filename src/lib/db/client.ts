/**
 * D1 Database Client Type Definition
 * Re-export D1Database interface for BYOK store
 */

// Import type từ d1-adapter sử dụng relative path
import type {
  D1Database,
  D1PreparedStatement,
  D1QueryResult,
  D1ExecResult,
} from '../auth/adapters/d1-adapter';

/** DB type alias - D1Database interface */
export type DB = D1Database;

/** Re-export D1 types for consumers (query-monitor, etc.) */
export type {
  D1PreparedStatement,
  D1QueryResult,
  D1ExecResult,
};
