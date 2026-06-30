/**
 * D1 Database Type Definitions
 * Shared types for D1 database access
 */
export type DB = {
  prepare(sql: string): {
    bind(...params: unknown[]): {
      first<T = unknown>(): T | null;
      all<T = unknown>(): { results: T[] };
      run(): { success: boolean; changes: number };
    };
    exec(): { success: boolean };
  };
  batch<T = unknown>(sqls: string[]): { success: boolean; changes: number[] };
};

export type MigrationResult = {
  success: boolean;
  changes: number;
  results?: unknown[];
};
