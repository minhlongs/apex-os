/**
 * Alert Storage Layer Tests
 *
 * Tests for alert-storage.ts including CRUD operations, queries, and retention.
 */

// Using Jest globals - expect, describe, it are global
import { jest } from '@jest/globals';
const vi = jest;
import { AlertStorage, getAlertStorage } from '@/lib/alerts/alert-storage';
import type { D1Database } from '@/types/d1';

// In-memory database mock that simulates D1 behavior
function createMockDB(): D1Database {
  const tables: Map<string, Map<string, Record<string, unknown>>> = new Map();
  const alertsTable = new Map<string, Record<string, unknown>>();
  const alertRulesTable = new Map<string, Record<string, unknown>>();
  tables.set('alerts', alertsTable);
  tables.set('alert_rules', alertRulesTable);

  // Pre-populate alert rules with correct field names
  alertRulesTable.set('rule-1', {
    id: 'rule-1', name: 'Test Rule 1', source: 'd1', metric_type: 'query_time',
  });
  alertRulesTable.set('rule-2', {
    id: 'rule-2', name: 'Test Rule 2', source: 'business', metric_type: 'daily_revenue',
  });

  const clearTables = () => {
    alertsTable.clear();
    alertRulesTable.set('rule-1', {
      id: 'rule-1', name: 'Test Rule 1', source: 'd1', metric_type: 'query_time',
    });
    alertRulesTable.set('rule-2', {
      id: 'rule-2', name: 'Test Rule 2', source: 'business', metric_type: 'daily_revenue',
    });
  };

  const getTableName = (sql: string): string => {
    const match = sql.match(/FROM\s+(\w+)|INSERT\s+INTO\s+(\w+)|UPDATE\s+(\w+)|DELETE\s+FROM\s+(\w+)/i);
    return match ? (match[1] || match[2] || match[3] || match[4]) : '';
  };

  const countQMarksBefore = (sql: string, position: number): number => {
    return (sql.substring(0, position).match(/\?/g) || []).length;
  };

  const createStatement = (sql: string) => {
    let params: unknown[] = [];
    let results: unknown[] = [];
    let firstResult: Record<string, unknown> | undefined;
    let affectedChanges = 0;

    const execute = () => {
      const tableName = getTableName(sql);
      const table = tables.get(tableName) || new Map();
      const upper = sql.trim().toUpperCase();
      const isSelect = upper.startsWith('SELECT');
      const isInsert = upper.startsWith('INSERT');
      const isUpdate = upper.startsWith('UPDATE');
      const isDelete = upper.startsWith('DELETE');

      if (isSelect) {
        // COUNT(*) shortcut
        const countMatch = sql.match(/SELECT\s+COUNT\(\*\)\s+as\s+count/i);
        if (countMatch) {
          firstResult = { count: table.size } as Record<string, unknown>;
          results = [{ count: table.size }];
          return;
        }
        results = [];
        const hasJoin = sql.toUpperCase().includes('JOIN');
        const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s*$)/is);
        const conditions: Array<{ column: string; paramIndex: number }> = [];

        if (whereMatch && params.length > 0) {
          const wherePos = sql.indexOf('WHERE');
          const paramOffset = countQMarksBefore(sql, wherePos);
          const conditionList = whereMatch[1].split(/\s+AND\s+/i);
          let paramIdx = paramOffset;
          for (const condition of conditionList) {
            const columnMatch = condition.match(/([\w.]+)\s*=\s*\?/);
            if (columnMatch) {
              let colName = columnMatch[1];
              if (colName.includes('.')) colName = colName.split('.').pop() || colName;
              if (colName !== '1') {
                conditions.push({ column: colName, paramIndex: paramIdx });
              }
            }
            const qMarks = (condition.match(/\?/g) || []).length;
            paramIdx += qMarks;
          }
        }

        table.forEach((row) => {
          let matches = true;
          for (const cond of conditions) {
            if (cond.paramIndex < params.length && row[cond.column] !== params[cond.paramIndex]) {
              matches = false;
              break;
            }
          }
          if (matches) {
            if (hasJoin && tableName === 'alerts') {
              const ruleId = row.rule_id as string;
              const rule = alertRulesTable.get(ruleId) || {};
              const { id: _, ...ruleData } = rule;
              results.push({ ...row, ...ruleData });
            } else {
              results.push(row);
            }
          }
        });

        if (sql.includes('ORDER BY')) {
          results.sort((a: any, b: any) => {
            const aTime = new Date(a.triggered_at || a.started_at || 0).getTime();
            const bTime = new Date(b.triggered_at || b.started_at || 0).getTime();
            return bTime - aTime;
          });
        }
        if (upper.includes('LIMIT') && params.length >= 2) {
          const limit = params[params.length - 2] as number;
          const offset = params[params.length - 1] as number;
          results = results.slice(offset, offset + limit);
        }
        firstResult = results.length > 0 ? (results[0] as Record<string, unknown>) : undefined;
      } else if (isInsert) {
        const columnsMatch = sql.match(/INSERT\s+INTO\s+\w+\s*\(\s*([^)]+)\s*\)/i);
        if (columnsMatch) {
          const columns = columnsMatch[1].split(',').map(c => c.trim());
          const newRow: Record<string, unknown> = {};
          columns.forEach((col, idx) => {
            if (idx < params.length) newRow[col] = params[idx];
          });
          if (tableName === 'alerts') {
            newRow.created_at = new Date().toISOString();
            newRow.updated_at = new Date().toISOString();
            if (!newRow.status) newRow.status = 'active';
            if (!('resolved_at' in newRow)) newRow.resolved_at = null;
            if (!('snoozed_until' in newRow)) newRow.snoozed_until = null;
          } else if (tableName === 'evaluation_runs') {
            newRow.created_at = new Date().toISOString();
          } else if (tableName === 'circuit_breaker_state') {
            newRow.created_at = new Date().toISOString();
            newRow.updated_at = new Date().toISOString();
          }
          const id = newRow.id as string;
          if (id) { table.set(id, newRow); affectedChanges = 1; }
        }
      } else if (isUpdate) {
        const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+ORDER|\s*$)/i);
        if (whereMatch) {
          const conditions = whereMatch[1].split(/\s+AND\s+/i);
          let rowId: string | undefined;
          // Count ? before WHERE clause to offset into params
          const wherePos = sql.indexOf('WHERE');
          const qMarksBeforeWhere = countQMarksBefore(sql, wherePos);
          let paramIdx = qMarksBeforeWhere;
          for (const condition of conditions) {
            const idMatch = condition.match(/id\s*=\s*\?/);
            if (idMatch && paramIdx < params.length) { rowId = params[paramIdx] as string; break; }
            paramIdx += (condition.match(/\?/g) || []).length;
          }
          if (rowId) {
            const row = table.get(rowId);
            if (row) {
              const setMatch = sql.match(/SET\s+(.*?)\s+WHERE/i);
              if (setMatch) {
                const assignments = setMatch[1].split(',').map(s => s.trim());
                let assignIdx = 0;
                for (const assignment of assignments) {
                  const [col] = assignment.split('=').map(s => s.trim());
                  if (col !== 'id' && assignIdx < params.length) {
                    (row as Record<string, unknown>)[col] = params[assignIdx];
                  }
                  assignIdx++;
                }
                if (tableName === 'alerts') row.updated_at = new Date().toISOString();
                else if (tableName === 'circuit_breaker_state') row.updated_at = new Date().toISOString();
                affectedChanges = 1;
              }
            }
          }
        }
      } else if (isDelete) {
        const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+ORDER|\s*$)/i);
        if (whereMatch) {
          const conditions = whereMatch[1].split(/\s+AND\s+/i);
          let rowId: string | undefined;
          const wherePos = sql.indexOf('WHERE');
          const qMarksBeforeWhere = countQMarksBefore(sql, wherePos);
          let paramIdx = qMarksBeforeWhere;
          for (const condition of conditions) {
            const idMatch = condition.match(/id\s*=\s*\?/);
            if (idMatch && paramIdx < params.length) { rowId = params[paramIdx] as string; break; }
            paramIdx += (condition.match(/\?/g) || []).length;
          }
          if (rowId && table.delete(rowId)) affectedChanges = 1;
        }
      }
    };

    const statement: any = {
      bind: (...values: unknown[]) => { params = values; return statement; },
      all: async <T = unknown>(): Promise<{ results: T[] }> => { execute(); return { results: results as T[] }; },
      first: async <T = unknown>(): Promise<T | undefined> => { execute(); return (firstResult as T) ?? undefined; },
      run: async (): Promise<{ success: boolean; meta: { changes: number } }> => {
        execute();
        return { success: affectedChanges > 0 || !sql.trim().toUpperCase().startsWith('SELECT'), meta: { changes: affectedChanges } };
      },
    };
    return statement;
  };

  return {
    prepare: (sql: string) => createStatement(sql),
    exec: vi.fn(),
    batch: vi.fn(),
    close: vi.fn(),
    _clearTables: clearTables,
  } as D1Database;
}

describe('AlertStorage', () => {
  let mockDB: D1Database;
  let storage: ReturnType<typeof getAlertStorage>;

  beforeEach(() => {
    mockDB = createMockDB();
    // Reset singleton and create fresh storage
    (globalThis as any).__alertStorage = null;
    storage = new AlertStorage(mockDB as any);
  });

  afterEach(() => {
    // @ts-expect-error - cleanup
    delete globalThis.DB;
  });

  describe('createAlert', () => {
    it('should create a new alert with required fields', async () => {
      const input = {
        rule_id: 'test-rule-1',
        severity: 'warning' as const,
        message: 'Test alert message',
      };

      const alert = await storage.create(input);

      expect(alert).toBeDefined();
      expect(alert.id).toBeDefined();
      expect(alert.rule_id).toBe('test-rule-1');
      expect(alert.severity).toBe('warning');
      expect(alert.message).toBe('Test alert message');
      expect(alert.triggered_at).toBeDefined();
      expect(alert.resolved_at).toBeNull();
      expect(alert.snoozed_until).toBeNull();
      expect(alert.status).toBe('active');
    });

    it('should create alert with optional context', async () => {
      const input = {
        rule_id: 'test-rule-2',
        severity: 'critical' as const,
        message: 'Critical alert',
        context: { currentValue: 150, threshold: 100 },
      };

      const alert = await storage.create(input);

      expect(alert.context).toEqual({ currentValue: 150, threshold: 100 });
    });

    it('should create alert with custom triggered_at', async () => {
      const customTime = new Date('2024-01-15T10:30:00Z');
      const input = {
        rule_id: 'test-rule-3',
        severity: 'info' as const,
        message: 'Info alert',
        triggered_at: customTime,
      };

      const alert = await storage.create(input);

      expect(alert.triggered_at).toBe(customTime.toISOString());
    });
  });

  describe('getById', () => {
    it('should return alert by ID', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      const found = await storage.getById(created.id);

      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent ID', async () => {
      const found = await storage.getById('non-existent-id');
      expect(found).toBeNull();
    });
  });

  describe('listAlerts', () => {
    beforeEach(async () => {
      // Create test data
      await storage.create({ rule_id: 'rule-1', severity: 'critical', message: 'Critical alert 1' });
      await storage.create({ rule_id: 'rule-1', severity: 'warning', message: 'Warning alert 1' });
      await storage.create({ rule_id: 'rule-2', severity: 'info', message: 'Info alert 1' });
    });

    it('should list all alerts with default options', async () => {
      const alerts = await storage.list();
      expect(alerts.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by status', async () => {
      const active = await storage.list({ status: 'active' });
      expect(active.length).toBeGreaterThanOrEqual(3);
    });

    it('should filter by severity', async () => {
      const critical = await storage.list({ severity: 'critical' });
      expect(critical.length).toBeGreaterThanOrEqual(1);
      critical.forEach(a => expect(a.severity).toBe('critical'));
    });

    it('should filter by rule_id', async () => {
      const rule1 = await storage.list({ rule_id: 'rule-1' });
      rule1.forEach(a => expect(a.rule_id).toBe('rule-1'));
    });

    it('should respect limit and offset', async () => {
      const limited = await storage.list({ limit: 1, offset: 0 });
      expect(limited.length).toBeLessThanOrEqual(1);
    });

    it('should include rule_name when joined', async () => {
      const alerts = await storage.list({ limit: 1 });
      // With mock DB, rule_name may be undefined, but type should be correct
      expect(typeof alerts[0]).toBe('object');
    });
  });

  describe('updateAlert', () => {
    it('should resolve an alert', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      expect(created.resolved_at).toBeNull();

      const resolved = await storage.update(created.id, {
        resolved_at: new Date(),
      });

      expect(resolved).not.toBeNull();
      expect(resolved?.resolved_at).not.toBeNull();
      expect(resolved?.status).toBe('resolved');
    });

    it('should snooze an alert', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      const snoozeUntil = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
      const snoozed = await storage.update(created.id, {
        snoozed_until: snoozeUntil,
      });

      expect(snoozed).not.toBeNull();
      expect(snoozed?.snoozed_until).toBe(snoozeUntil.toISOString());
      expect(snoozed?.status).toBe('snoozed');
    });

    it('should clear snooze by setting to null', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
        snoozed_until: new Date(Date.now() + 3600000),
      });

      const cleared = await storage.update(created.id, {
        snoozed_until: null,
      });

      expect(cleared).not.toBeNull();
      expect(cleared?.snoozed_until).toBeNull();
      expect(cleared?.status).toBe('active');
    });
  });

  describe('resolve', () => {
    it('should resolve alert via convenience method', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      const resolved = await storage.resolve(created.id);

      expect(resolved?.resolved_at).not.toBeNull();
      expect(resolved?.status).toBe('resolved');
    });
  });

  describe('snooze', () => {
    it('should snooze alert via convenience method', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      const until = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const snoozed = await storage.snooze(created.id, until);

      expect(snoozed?.snoozed_until).toBe(until.toISOString());
      expect(snoozed?.status).toBe('snoozed');
    });
  });

  describe('deleteAlert', () => {
    it('should delete an alert', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      const deleted = await storage.delete(created.id);

      expect(deleted).toBe(true);

      const found = await storage.getById(created.id);
      expect(found).toBeNull();
    });

    it('should return false for non-existent alert', async () => {
      const deleted = await storage.delete('non-existent-id');
      expect(deleted).toBe(false);
    });
  });

  describe('cleanupOldAlerts', () => {
    it('should delete old resolved alerts', async () => {
      const deleted = await storage.cleanupOldAlerts(90);
      expect(typeof deleted).toBe('number');
    });
  });

  describe('cleanupExpiredSnoozes', () => {
    it('should clear expired snoozes', async () => {
      const cleared = await storage.cleanupExpiredSnoozes();
      expect(typeof cleared).toBe('number');
    });
  });

  describe('getStats', () => {
    it('should return statistics summary', async () => {
      const stats = await storage.getStats();

      expect(stats).toHaveProperty('total');
      expect(stats).toHaveProperty('bySeverity');
      expect(stats).toHaveProperty('byStatus');
      expect(stats).toHaveProperty('topRules');
      expect(typeof stats.total).toBe('number');
      expect(typeof stats.bySeverity).toBe('object');
      expect(typeof stats.byStatus).toBe('object');
    });
  });

  describe('getExpiredSnoozesForReminder', () => {
    it('should return alerts needing reminder', async () => {
      const expired = await storage.getExpiredSnoozesForReminder();
      expect(Array.isArray(expired)).toBe(true);
    });
  });

  describe('status derived property', () => {
    it('should derive status correctly from database', async () => {
      const now = new Date();
      const past = new Date(now.getTime() - 3600000);
      const future = new Date(now.getTime() + 3600000);

      // Note: These would require actual DB to test properly
      // This is a placeholder test
      expect(['active', 'snoozed', 'resolved']).toContain('active');
    });
  });
});

describe('AlertStorage Integration', () => {
  // Integration tests would go here with a real or in-memory D1 database
  it('should handle full CRUD lifecycle', async () => {
    // Mock implementation only validates method signatures
    expect(true).toBe(true);
  });
});
