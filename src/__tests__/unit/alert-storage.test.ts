/**
 * Unit Tests: AlertStorage
 *
 * Tests the real AlertStorage class with a mock D1Database.
 */

import { AlertStorage } from '@/lib/alerts/alert-storage';
import type { D1Database } from '@/types/d1';

// Mock D1 Database
function createMockDB(): MockDB {
  let alerts: any[] = [];

  return {
    prepare: jest.fn().mockImplementation((sql: string) => {
      const trimmed = sql.trim();
      const stmt: MockStatement = {
        _params: [] as any[],
        bind: jest.fn().mockImplementation((...params: any[]) => {
          stmt._params = params;
          return stmt;
        }),
        run: jest.fn().mockImplementation(async () => {
          // Handle INSERT
          if (trimmed.startsWith('INSERT INTO alerts')) {
            const p = stmt._params;
            const alert: any = {
              id: p[0],
              rule_id: p[1],
              severity: p[2],
              message: p[3],
              triggered_at: p[4],
              resolved_at: p[5] || null,
              snoozed_until: p[6] || null,
              context: p[7] || '{}', // store raw JSON string from DB
              status: 'active', // default status
            };
            alerts.push(alert);
            return { success: true, meta: { changes: 1 } };
          }
          // Handle UPDATE resolved_at
          if (trimmed.startsWith('UPDATE alerts SET resolved_at')) {
            const id = stmt._params[stmt._params.length - 1];
            const alert = alerts.find(a => a.id === id);
            if (alert) {
              alert.resolved_at = stmt._params[0];
              alert.status = 'resolved';
              alert.updated_at = new Date().toISOString();
            }
            return { success: true, meta: { changes: 1 } };
          }
          // Handle UPDATE snoozed_until
          if (trimmed.startsWith('UPDATE alerts SET snoozed_until')) {
            const id = stmt._params[stmt._params.length - 1];
            const alert = alerts.find(a => a.id === id);
            if (alert) {
              alert.snoozed_until = stmt._params[0];
              alert.status = 'snoozed';
              alert.updated_at = new Date().toISOString();
            }
            return { success: true, meta: { changes: 1 } };
          }
          // Handle DELETE FROM alerts
          if (trimmed.startsWith('DELETE FROM alerts')) {
            if (trimmed.includes('WHERE')) {
              // Delete resolved alerts (simplified: delete all with resolved_at)
              let deleted = 0;
              for (let i = alerts.length - 1; i >= 0; i--) {
                if (alerts[i].resolved_at) {
                  alerts.splice(i, 1);
                  deleted++;
                }
              }
              return { success: true, meta: { changes: deleted } };
            } else {
              // Delete all alerts
              const count = alerts.length;
              alerts = [];
              return { success: true, meta: { changes: count } };
            }
          }
          return { success: true, meta: { changes: 0 } };
        }),
        first: jest.fn().mockImplementation(async () => {
          if (trimmed.includes('SELECT * FROM alerts WHERE id = ?')) {
            return alerts.find(a => a.id === stmt._params[0]) || null;
          }
          if (trimmed.includes('SELECT COUNT(*)')) {
            // For getStats
            return { count: alerts.length };
          }
          return null;
        }),
        all: jest.fn().mockImplementation(async () => {
          if (trimmed.includes('SELECT * FROM alerts') && !trimmed.includes('WHERE') && !trimmed.includes('JOIN')) {
            return { results: [...alerts] };
          }
          if (trimmed.includes('WHERE a.status =') && trimmed.includes('active')) {
            const active = alerts.filter(a => a.status === 'active');
            return { results: active };
          }
          if (trimmed.includes('SELECT severity, COUNT(*)')) {
            const bySeverity: Record<string, number> = {};
            alerts.forEach(a => {
              bySeverity[a.severity] = (bySeverity[a.severity] || 0) + 1;
            });
            return { results: Object.entries(bySeverity).map(([severity, count]) => ({ severity, count })) };
          }
          if (trimmed.includes('SELECT status, COUNT(*)')) {
            const byStatus: Record<string, number> = {};
            alerts.forEach(a => {
              byStatus[a.status] = (byStatus[a.status] || 0) + 1;
            });
            return { results: Object.entries(byStatus).map(([status, count]) => ({ status, count })) };
          }
          return { results: [] };
        }),
      };
      return stmt;
    }),
    // Helper for tests
    _getAlerts: () => alerts,
    _clear: () => { alerts = []; },
  };
}

type MockDB = D1Database & { _getAlerts: () => any[]; _clear: () => void };

describe('AlertStorage (Unit)', () => {
  let db: MockDB;
  let storage: AlertStorage;

  beforeEach(() => {
    db = createMockDB();
    storage = new AlertStorage(db as any);
  });

  describe('create()', () => {
    it('should create an alert and return it with generated ID', async () => {
      const input = {
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test alert',
        context: { foo: 'bar' },
        triggered_at: new Date(),
      };

      const alert = await storage.create(input);

      expect(alert).toBeDefined();
      expect(alert.id).toMatch(/^alert_/);
      expect(alert.rule_id).toBe(input.rule_id);
      expect(alert.severity).toBe(input.severity);
      expect(alert.message).toBe(input.message);
      expect(alert.status).toBe('active');
      expect(alert.resolved_at).toBeNull();
      expect(alert.snoozed_until).toBeNull();
      expect(alert.context).toEqual(input.context);
    });

    it('should persist the alert in the database', async () => {
      const input = {
        rule_id: 'test-rule',
        severity: 'critical',
        message: 'Persisted alert',
      };

      const created = await storage.create(input);
      const found = await storage.getById(created.id);

      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.message).toBe(input.message);
    });
  });

  describe('getById()', () => {
    it('should return alert by ID', async () => {
      const input = {
        rule_id: 'test-rule',
        severity: 'info',
        message: 'Find me',
      };
      const created = await storage.create(input);

      const found = await storage.getById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent ID', async () => {
      const found = await storage.getById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('resolve()', () => {
    it('should mark alert as resolved', async () => {
      const alert = await storage.create({
        rule_id: 'test',
        severity: 'critical',
        message: 'Resolve me',
      });

      await storage.resolve(alert.id);

      const updated = await storage.getById(alert.id);
      expect(updated?.resolved_at).not.toBeNull();
      expect(updated?.status).toBe('resolved');
    });
  });

  describe('snooze()', () => {
    it('should set snoozed_until and change status to snoozed', async () => {
      const alert = await storage.create({
        rule_id: 'test',
        severity: 'warning',
        message: 'Snooze me',
      });

      const until = new Date(Date.now() + 3600000);
      await storage.snooze(alert.id, until);

      const updated = await storage.getById(alert.id);
      expect(updated?.snoozed_until).toBe(until.toISOString());
      expect(updated?.status).toBe('snoozed');
    });
  });

  describe('getActiveAlerts()', () => {
    it('should return only active alerts', async () => {
      const a1 = await storage.create({ rule_id: 'a1', severity: 'warning', message: 'A1' });
      const a2 = await storage.create({ rule_id: 'a2', severity: 'critical', message: 'A2' });

      await storage.resolve(a2.id);

      const active = await storage.getActiveAlerts();
      expect(active.length).toBe(1);
      expect(active[0].id).toBe(a1.id);
    });
  });

  describe('cleanupOldAlerts()', () => {
    it('should delete resolved alerts older than cutoff', async () => {
      const alert = await storage.create({
        rule_id: 'old',
        severity: 'info',
        message: 'Old alert',
      });

      // Manually mark as resolved with old date via direct DB manipulation
      const dbAlerts = db._getAlerts();
      const toUpdate = dbAlerts.find(a => a.id === alert.id);
      if (toUpdate) {
        toUpdate.resolved_at = new Date(Date.now() - 100 * 24 * 60 * 60 * 1000).toISOString();
      }

      const deleted = await storage.cleanupOldAlerts(90);
      expect(deleted).toBeGreaterThanOrEqual(1);
    });

    it('should not delete active alerts', async () => {
      await storage.create({
        rule_id: 'active',
        severity: 'critical',
        message: 'Active',
      });

      const deleted = await storage.cleanupOldAlerts(90);
      expect(deleted).toBe(0);
    });
  });
});
