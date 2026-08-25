import { getDB, initializeDB, resetDBForTests } from '@/lib/db';

export function initializeTestDB(rows: Record<string, unknown> = {}): ReturnType<typeof initializeDB> {
  return initializeDB({ database: rows as never });
}

export function resetTestDB(): void {
  resetDBForTests();
}

export function setDbUnavailable(): void {
  resetTestDB();
}
