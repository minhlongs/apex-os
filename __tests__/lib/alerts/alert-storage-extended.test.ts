/**
 * Alert Storage Unit Tests (Extended)
 *
 * Additional tests for alert-storage.ts to improve coverage
 */

import { jest } from '@jest/globals';
const vi = jest;
import { AlertStorage } from '@/lib/alerts/alert-storage';
import type { D1Database } from '@/types/d1';

// In-memory database mock that simulates D1 behavior (fixed version)
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

  const countQuestionMarksBefore = (sql: string, position: number): number => {
    const before = sql.substring(0, position);
    return (before.match(/\?/g) || []).length;
  };

  const createStatement = (sql: string) => {
    let params: unknown[] = [];
    let results: unknown[] = [];
    let firstResult: Record<string, unknown> | undefined;
    let affectedChanges = 0;
    let upper = '';

    const execute = () => {
      const tableName = getTableName(sql);
      const table = tables.get(tableName) || new Map();
      upper = sql.trim().toUpperCase();
      const isSelect = upper.startsWith('SELECT');
      const isInsert = upper.startsWith('INSERT');
      const isUpdate = upper.startsWith('UPDATE');
      const isDelete = upper.startsWith('DELETE');

      if (isSelect) {
        results = [];
        const hasJoin = sql.toUpperCase().includes('JOIN');

        // Handle COUNT(*) queries
        const countStarMatch = sql.match(/SELECT\s+COUNT\(\*\)\s+as\s+count/i);
        if (countStarMatch) {
          firstResult = { count: tables.get(tableName)?.size || 0 } as Record<string, unknown>;
          results = [{ count: tables.get(tableName)?.size || 0 }];
          return;
        }

        // Parse WHERE clause for param mapping
        const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+ORDER|\s+LIMIT|\s+GROUP|\s*$)/is);
        const conditions: Array<{ column: string; paramIndex: number }> = [];

        if (whereMatch && params.length > 0) {
          const wherePos = sql.indexOf('WHERE');
          const paramOffset = countQuestionMarksBefore(sql, wherePos);
          const conditionList = whereMatch[1].split(/\s+AND\s+/i);
          let paramIdx = paramOffset;
          for (const condition of conditionList) {
            const columnMatch = condition.match(/([\w.]+)\s*=\s*\?/);
            if (columnMatch) {
              let colName = columnMatch[1];
              if (colName.includes('.')) {
                colName = colName.split('.').pop() || colName;
              }
              if (colName !== '1') {
                conditions.push({ column: colName, paramIndex: paramIdx });
              }
            }
            const questionMarks = (condition.match(/\?/g) || []).length;
            paramIdx += questionMarks;
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

        // Sort by triggered_at DESC for common queries
        if (sql.includes('ORDER BY')) {
          results.sort((a: any, b: any) => {
            const aTime = new Date(a.triggered_at || a.started_at || 0).getTime();
            const bTime = new Date(b.triggered_at || b.started_at || 0).getTime();
            return bTime - aTime;
          });
        }

        // Apply LIMIT and OFFSET from params if present
        if (sql.toUpperCase().includes('LIMIT') && params.length >= 2) {
          const limit = params[params.length - 2] as number;
          const offset = params[params.length - 1] as number;
          results = results.slice(offset, offset + limit);
        }

        firstResult = results.length > 0 ? (results[0] as Record<string, unknown>) : undefined;

        // Handle GROUP BY aggregation
        const groupByMatch = sql.match(/GROUP\s+BY\s+(\w+)/i);
        if (groupByMatch) {
          const groupCol = groupByMatch[1];
          const grouped = new Map<string, { count: number; [key: string]: unknown }>();
          for (const row of results) {
            const key = String(row[groupCol] || 'unknown');
            if (!grouped.has(key)) {
              grouped.set(key, { [groupCol]: row[groupCol], count: 0 });
            }
            const entry = grouped.get(key)!;
            entry.count++;
          }
          results = Array.from(grouped.values());
          firstResult = results.length > 0 ? (results[0] as Record<string, unknown>) : undefined;
        }
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
          }
          const id = newRow.id as string;
          if (id) { table.set(id, newRow); affectedChanges = 1; }
        }
 } else if (isUpdate) {
  const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+ORDER|\s*$)/is);
  if (whereMatch) {
    const conditions = whereMatch[1].split(/\s+AND\s+/i);
    let paramIdx = 0;
    const parsedConditions: Array<{ col: string; op: string; paramOffset: number; valueExpr: string }> = [];
    for (const condition of conditions) {
      const colMatch = condition.match(/([\w.]+)\s*(=|!=|>|<|>=|<=|IS)\s*(.+?)$/i);
      if (colMatch) {
        parsedConditions.push({
          col: colMatch[1], op: colMatch[2].toUpperCase(),
          paramOffset: paramIdx, valueExpr: colMatch[3].trim(),
        });
      }
      paramIdx += (condition.match(/\?/g) || []).length;
    }
    const setMatch = sql.match(/SET\s+(.*?)\s+WHERE/is);
    if (setMatch) {
      const assignments = setMatch[1].split(',').map(s => s.trim());
      const setValues: Array<{ col: string; value: unknown }> = [];
      let assignIdx = 0;
      for (const assignment of assignments) {
        const assignCol = assignment.split('=').map(s => s.trim())[0];
        const val = assignIdx < params.length ? params[assignIdx] : null;
        setValues.push({ col: assignCol, value: val });
        assignIdx++;
      }
      let updatedCount = 0;
      for (const [rowId, row] of table) {
        let matches = true;
        for (const cond of parsedConditions) {
      let evalParam: unknown;
      if (cond.valueExpr.includes('?')) {
        evalParam = params[cond.paramOffset];
      } else {
        evalParam = cond.valueExpr.replace(/^['"]|['"]$/g, '');
      }
          if (cond.valueExpr.includes('datetime')) {
            if (cond.valueExpr.includes("'-' || ? || ' days'")) {
              const days = Number(params[cond.paramOffset]) || 0;
              evalParam = new Date(Date.now() - days * 86400000).toISOString();
            } else if (cond.valueExpr.includes("'now'")) {
              evalParam = new Date().toISOString();
            }
          }
          const rowVal = (row as Record<string, unknown>)[cond.col];
          const isDateCompare = typeof rowVal === 'string' && /^\d{4}-\d{2}/.test(rowVal) && typeof evalParam === 'string' && /^\d{4}-\d{2}/.test(evalParam as string);
          if (cond.op === '=' && rowVal !== evalParam) matches = false;
          else if (cond.op === '!=' && rowVal === evalParam) matches = false;
          else if (cond.op === '>=' && isDateCompare && !(new Date(rowVal as string).getTime() >= new Date(evalParam as string).getTime())) matches = false;
          else if (cond.op === '<=' && isDateCompare && !(new Date(rowVal as string).getTime() <= new Date(evalParam as string).getTime())) matches = false;
          else if (cond.op === '>' && isDateCompare && !(new Date(rowVal as string).getTime() > new Date(evalParam as string).getTime())) matches = false;
          else if (cond.op === '<' && isDateCompare && !(new Date(rowVal as string).getTime() < new Date(evalParam as string).getTime())) matches = false;
          else if (!isDateCompare) {
            if (cond.op === '>=' && !(Number(rowVal) >= Number(evalParam))) matches = false;
            else if (cond.op === '<=' && !(Number(rowVal) <= Number(evalParam))) matches = false;
            else if (cond.op === '>' && !(Number(rowVal) > Number(evalParam))) matches = false;
            else if (cond.op === '<' && !(Number(rowVal) < Number(evalParam))) matches = false;
          }
          if (!matches) break;
        }
        if (matches) {
          for (const sv of setValues) {
            if (sv.col !== 'id') (row as Record<string, unknown>)[sv.col] = sv.value;
          }
          if (tableName === 'alerts') row.updated_at = new Date().toISOString();
          else if (tableName === 'circuit_breaker_state') row.updated_at = new Date().toISOString();
          updatedCount++;
        }
      }
      affectedChanges = updatedCount;
    }
}
}
 else if (isDelete) {
        const whereMatch = sql.match(/WHERE\s+(.*?)(?:\s+ORDER|\s*$)/is);
        if (whereMatch) {
          const conditions = whereMatch[1].split(/\s+AND\s+/i);
          let paramIdx = 0;
          const parsedConditions: Array<{ col: string; op: string; paramOffset: number; valueExpr: string }> = [];
          for (const condition of conditions) {
            const colMatch = condition.match(/([\w.]+)\s*(=|!=|>|<|>=|<=|IS)\s*(.+?)$/i);
            if (colMatch) {
              parsedConditions.push({
                col: colMatch[1], op: colMatch[2].toUpperCase(),
                paramOffset: paramIdx, valueExpr: colMatch[3].trim(),
              });
            }
            paramIdx += (condition.match(/\?/g) || []).length;
          }
          let deletedCount = 0;
          for (const [rowId, row] of table) {
            let matches = true;
            for (const cond of parsedConditions) {
              // Evaluate the value, handling SQLite functions
      let evalParam: unknown;
      if (cond.valueExpr.includes('?')) {
        evalParam = params[cond.paramOffset];
      } else {
        evalParam = cond.valueExpr.replace(/^['"]|['"]$/g, '');
      }
              if (cond.valueExpr.includes('datetime')) {
                if (cond.valueExpr.includes("'-' || ? || ' days'")) {
                  const days = Number(params[cond.paramOffset]) || 0;
                  evalParam = new Date(Date.now() - days * 86400000).toISOString();
                } else if (cond.valueExpr.includes("'now'")) {
                  evalParam = new Date().toISOString();
                }
              }
              const rowVal = (row as Record<string, unknown>)[cond.col];
              // Handle date string comparisons
              const isDateCompare = typeof rowVal === 'string' && /^\d{4}-\d{2}/.test(rowVal) && typeof evalParam === 'string' && /^\d{4}-\d{2}/.test(evalParam as string);
              if (cond.op === '=' && rowVal !== evalParam) matches = false;
              else if (cond.op === '!=' && rowVal === evalParam) matches = false;
              else if (cond.op === '>=' && isDateCompare && !(new Date(rowVal as string).getTime() >= new Date(evalParam as string).getTime())) matches = false;
              else if (cond.op === '<=' && isDateCompare && !(new Date(rowVal as string).getTime() <= new Date(evalParam as string).getTime())) matches = false;
              else if (cond.op === '>' && isDateCompare && !(new Date(rowVal as string).getTime() > new Date(evalParam as string).getTime())) matches = false;
              else if (cond.op === '<' && isDateCompare && !(new Date(rowVal as string).getTime() < new Date(evalParam as string).getTime())) matches = false;
              else if (!isDateCompare) {
                if (cond.op === '>=' && !(Number(rowVal) >= Number(evalParam))) matches = false;
                else if (cond.op === '<=' && !(Number(rowVal) <= Number(evalParam))) matches = false;
                else if (cond.op === '>' && !(Number(rowVal) > Number(evalParam))) matches = false;
                else if (cond.op === '<' && !(Number(rowVal) < Number(evalParam))) matches = false;
              }
              if (!matches) break;
            }
            if (matches) { table.delete(rowId); deletedCount++; }
          }
          affectedChanges = deletedCount;
        }
      }
    };

    const statement: any = {
      bind: (...values: unknown[]) => { params = values; return statement; },
      all: async <T = unknown>(): Promise<{ results: T[] }> => { execute(); return { results: results as T[] }; },
      first: async <T = unknown>(): Promise<T | undefined> => { execute(); return (firstResult as T) ?? undefined; },
      run: async (): Promise<{ success: boolean; meta: { changes: number } }> => {
        execute();
        return { success: affectedChanges > 0 || !upper.startsWith('SELECT'), meta: { changes: affectedChanges } };
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

describe('AlertStorage Extended', () => {
  let mockDB: ReturnType<typeof createMockDB>;
  let storage: AlertStorage;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new AlertStorage(mockDB as any);
    mockDB._clearTables?.();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('getStats', () => {
    it('should calculate stats correctly', async () => {
      const now = new Date();
      const alerts = [
        { id: 'a1', rule_id: 'rule-1', severity: 'critical', message: 'Test', triggered_at: now.toISOString(), resolved_at: null, snoozed_until: null, context: '{}', status: 'active', created_at: now.toISOString(), updated_at: now.toISOString() },
        { id: 'a2', rule_id: 'rule-1', severity: 'warning', message: 'Test', triggered_at: now.toISOString(), resolved_at: null, snoozed_until: null, context: '{}', status: 'active', created_at: now.toISOString(), updated_at: now.toISOString() },
        { id: 'a3', rule_id: 'rule-2', severity: 'info', message: 'Test', triggered_at: now.toISOString(), resolved_at: null, snoozed_until: null, context: '{}', status: 'snoozed', created_at: now.toISOString(), updated_at: now.toISOString() },
        { id: 'a4', rule_id: 'rule-2', severity: 'critical', message: 'Test', triggered_at: now.toISOString(), resolved_at: now.toISOString(), snoozed_until: null, context: '{}', status: 'resolved', created_at: now.toISOString(), updated_at: now.toISOString() },
      ];
      for (const a of alerts) {
        await mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(a.id, a.rule_id, a.severity, a.message, a.triggered_at, a.resolved_at, a.snoozed_until, a.context, a.status, a.created_at, a.updated_at).run();
      }

      const stats = await storage.getStats();

      expect(stats.total).toBe(4);
      expect(stats.bySeverity.critical).toBe(2);
      expect(stats.bySeverity.warning).toBe(1);
      expect(stats.bySeverity.info).toBe(1);
      expect(stats.byStatus.active).toBe(2);
      expect(stats.byStatus.snoozed).toBe(1);
      expect(stats.byStatus.resolved).toBe(1);
    });

    it('should return zero counts when no data', async () => {
      const stats = await storage.getStats();
      expect(stats.total).toBe(0);
      expect(Object.values(stats.bySeverity).every((c: any) => c === 0)).toBe(true);
      expect(Object.values(stats.byStatus).every((c: any) => c === 0)).toBe(true);
      expect(stats.avgResolutionTimeMinutes).toBeNull();
    });
  });

  describe('cleanupOldAlerts', () => {
    it('should delete old resolved alerts', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      const recentDate = new Date().toISOString();
      for (let i = 0; i < 5; i++) {
        mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(`old_${i}`, 'rule-1', 'critical', 'Old', oldDate, oldDate, null, '{}', 'resolved', oldDate, oldDate).run();
      }
      for (let i = 0; i < 3; i++) {
        mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(`recent_${i}`, 'rule-1', 'critical', 'Recent', recentDate, recentDate, null, '{}', 'resolved', recentDate, recentDate).run();
      }

      const deleted = await storage.cleanupOldAlerts(90);
      expect(deleted).toBe(5);
    });

    it('should use default retention of 90 days', async () => {
      const oldDate = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('old', 'rule-1', 'critical', 'Old', oldDate, oldDate, null, '{}', 'resolved', oldDate, oldDate).run();
      const deleted = await storage.cleanupOldAlerts();
      expect(typeof deleted).toBe('number');
    });
  });

  describe('cleanupExpiredSnoozes', () => {
    it('should clear expired snoozes', async () => {
      const pastDate = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const futureDate = new Date(Date.now() + 60 * 60 * 1000).toISOString();
      mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('expired', 'rule-1', 'critical', 'Expired', pastDate, null, pastDate, '{}', 'snoozed', pastDate, pastDate).run();
      mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('active', 'rule-1', 'critical', 'Active', futureDate, null, futureDate, '{}', 'snoozed', futureDate, futureDate).run();

      const cleared = await storage.cleanupExpiredSnoozes();
      expect(cleared).toBe(1);
    });
  });

  describe('getExpiredSnoozesForReminder', () => {
    it('should return alerts needing reminder', async () => {
      const pastSnooze = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const now = new Date().toISOString();
      mockDB.prepare('INSERT INTO alerts (id, rule_id, severity, message, triggered_at, resolved_at, snoozed_until, context, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind('alert-1', 'rule-1', 'critical', 'Test alert', now, null, pastSnooze, '{}', 'active', now, now).run();

      const expired = await storage.getExpiredSnoozesForReminder();
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('alert-1');
    });
  });

  describe('normalizeRow', () => {
    it('should parse valid JSON context', () => {
      const row = {
        id: 'test-id', rule_id: 'rule-1', severity: 'critical', message: 'Test',
        triggered_at: '2024-01-15T10:00:00Z', resolved_at: null, snoozed_until: null,
        context: JSON.stringify({ key: 'value', count: 42 }), status: 'active',
        created_at: '2024-01-15T10:00:00Z', updated_at: '2024-01-15T10:00:00Z',
      };

      const alert = storage['normalizeRow'](row);

      expect(alert.context).toEqual({ key: 'value', count: 42 });
    });

    it('should handle invalid JSON context', () => {
      const row = {
        id: 'test-id', rule_id: 'rule-1', severity: 'critical', message: 'Test',
        triggered_at: '2024-01-15T10:00:00Z', resolved_at: null, snoozed_until: null,
        context: 'invalid json', status: 'active',
        created_at: '2024-01-15T10:00:00Z', updated_at: '2024-01-15T10:00:00Z',
      };

      const alert = storage['normalizeRow'](row);

      expect(alert.context).toEqual({});
    });

    it('should handle null context', () => {
      const row = {
        id: 'test-id', rule_id: 'rule-1', severity: 'critical', message: 'Test',
        triggered_at: '2024-01-15T10:00:00Z', resolved_at: null, snoozed_until: null,
        context: null, status: 'active',
        created_at: '2024-01-15T10:00:00Z', updated_at: '2024-01-15T10:00:00Z',
      };

      const alert = storage['normalizeRow'](row);

      expect(alert.context).toEqual({});
    });
  });

  describe('Edge cases', () => {
    it('getActiveAlerts should handle empty DB', async () => {
      const alerts = await storage.getActiveAlerts();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts).toHaveLength(0);
    });

    it('getSnoozedAlerts should handle empty DB', async () => {
      const alerts = await storage.getSnoozedAlerts();
      expect(Array.isArray(alerts)).toBe(true);
      expect(alerts).toHaveLength(0);
    });

    it('getResolvedHistory should handle empty DB', async () => {
      const history = await storage.getResolvedHistory();
      expect(Array.isArray(history)).toBe(true);
      expect(history).toHaveLength(0);
    });

    it('delete should return false for non-existent alert', async () => {
      const deleted = await storage.delete('non-existent');
      expect(deleted).toBe(false);
    });
  });
});
