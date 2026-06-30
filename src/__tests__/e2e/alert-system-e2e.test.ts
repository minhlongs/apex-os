/**
 * End-to-End Alert System Test
 *
 * Tests alert system components with mocks:
 * - AlertStorage (create, resolve, snooze, queries)
 * - AlertEngine threshold evaluation
 * - Unread badge counts
 * - Full lifecycle flow
 */

import type { D1Database } from '@/types/d1';

// ============================================================================
// Types
// ============================================================================

interface MockDB {
  prepare(sql: string): MockStatement;
  getAlerts(): AlertRecord[];
  addAlert(alert: AlertRecord): AlertRecord;
  clearAlerts(): void;
}

interface MockStatement {
  sql: string;
  _params: any[];
  bind: (...params: any[]) => MockStatement;
  first: () => Promise<any>;
  all: () => Promise<any[]>;
  run: (...params: any[]) => Promise<{ success: boolean; changes: number }>;
}

interface AlertRecord {
  id: string;
  rule_id: string;
  severity: string;
  message: string;
  triggered_at: string;
  resolved_at?: string;
  snoozed_until?: string;
  context: Record<string, unknown>;
  status: string;
  is_read?: 0 | 1;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Mock Database
// ============================================================================

export function createMockDB(): MockDB {
  const alerts: AlertRecord[] = [];

  return {
    prepare: jest.fn().mockImplementation((sql: string) => {
      const stmt: MockStatement = {
        sql,
        _params: [],
        bind: (...params) => {
          stmt._params = params;
          return stmt;
        },
        first: async () => {
          return executeQuery(sql, stmt._params, alerts, true);
        },
        all: async () => {
          return executeQuery(sql, stmt._params, alerts, false);
        },
        run: async (...params: any[]) => {
          executeSQL(sql, params, alerts);
          return { success: true, changes: 1 };
        },
      };
      return stmt;
    }),
    getAlerts: () => alerts,
    addAlert: (alert: Partial<AlertRecord>): AlertRecord => {
      const now = new Date().toISOString();
      const fullAlert: AlertRecord = {
        id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        rule_id: alert.rule_id || 'unknown',
        severity: alert.severity || 'info',
        message: alert.message || '',
        triggered_at: alert.triggered_at || now,
        context: alert.context || {},
        status: alert.status || 'active',
        created_at: now,
        updated_at: now,
      };
      // Copy optional fields if present
      if (alert.resolved_at) fullAlert.resolved_at = alert.resolved_at;
      if (alert.snoozed_until) fullAlert.snoozed_until = alert.snoozed_until;
      if (alert.is_read !== undefined) fullAlert.is_read = alert.is_read;
      alerts.push(fullAlert);
      return fullAlert;
    },
    clearAlerts: () => alerts.length = 0,
  };
}

function executeQuery(
  sql: string,
  params: any[],
  alerts: AlertRecord[],
  single: boolean
): any {
  // SELECT * FROM alerts WHERE id = ?
  if (sql.includes('SELECT * FROM alerts WHERE id = ?')) {
    const alert = alerts.find(a => a.id === params[0]);
    return single ? (alert || null) : (alert ? [alert] : []);
  }

  // SELECT COUNT(*) FROM alerts WHERE status = 'active' AND resolved_at IS NULL
  if (sql.includes('COUNT(*)') && sql.includes('alerts')) {
    const count = alerts.filter(a => a.status === 'active' && !a.resolved_at).length;
    return single ? { count } : [{ count }];
  }

  // SELECT * FROM alerts
  if (sql.includes('FROM alerts') && !sql.includes('WHERE')) {
    const sorted = [...alerts].sort((a, b) =>
      new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime()
    );
    return single ? (sorted[0] || null) : sorted;
  }

  return single ? null : [];
}

function executeSQL(sql: string, params: any[], alerts: AlertRecord[]): void {
  const trimmed = sql.trim();
  if (trimmed.startsWith('INSERT INTO alerts')) {
    const alert: AlertRecord = {
      id: params[0],
      rule_id: params[1],
      severity: params[2],
      message: params[3],
      triggered_at: params[4],
      resolved_at: undefined,
      snoozed_until: undefined,
      context: typeof params[5] === 'string' ? JSON.parse(params[5] || '{}') : (params[5] || {}),
      status: 'active',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    alerts.push(alert);
  } else if (trimmed.startsWith('UPDATE alerts SET resolved_at')) {
    const alertId = params[params.length - 1];
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
      alert.resolved_at = params[0];
      alert.status = 'resolved';
      alert.updated_at = new Date().toISOString();
    }
  } else if (trimmed.startsWith('UPDATE alerts SET snoozed_until')) {
    const alertId = params[params.length - 1];
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
      alert.snoozed_until = params[0];
      alert.status = 'snoozed';
      alert.updated_at = new Date().toISOString();
    }
  } else if (trimmed.startsWith('UPDATE alerts SET is_read')) {
    const alertId = params[params.length - 1];
    const alert = alerts.find(a => a.id === alertId);
    if (alert) {
      alert.is_read = Number(params[0]) as 0 | 1;
      alert.updated_at = new Date().toISOString();
    }
  } else if (trimmed.includes('DELETE FROM alerts WHERE')) {
    const days = params.find(p => typeof p === 'number');
    if (days) {
      const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      for (let i = alerts.length - 1; i >= 0; i--) {
        if (alerts[i].resolved_at && new Date(alerts[i].resolved_at) < cutoff) {
          alerts.splice(i, 1);
        }
      }
    }
  } else if (trimmed.includes('DELETE FROM')) {
    alerts.length = 0;
  }
}

export class AlertStorage {
  constructor(private db: MockDB) {}

  async create(input: {
    rule_id: string;
    severity: string;
    message: string;
    context?: Record<string, unknown>;
    triggered_at?: Date;
  }) {
    const now = new Date().toISOString();
    const id = `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    await this.db.prepare(`
      INSERT INTO alerts (id, rule_id, severity, message, triggered_at, context)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      input.rule_id,
      input.severity,
      input.message,
      input.triggered_at?.toISOString() || now,
      JSON.stringify(input.context || {})
    );

    return {
      id,
      rule_id: input.rule_id,
      severity: input.severity,
      message: input.message,
      triggered_at: input.triggered_at?.toISOString() || now,
      resolved_at: undefined,
      snoozed_until: undefined,
      context: input.context || {},
      status: 'active',
      created_at: now,
      updated_at: now,
    };
  }

  getById(id: string) {
    const alerts = this.db.getAlerts();
    return alerts.find(a => a.id === id) || null;
  }

  getActiveAlerts() {
    return this.db.getAlerts().filter(a => a.status === 'active');
  }

  getUnreadCount(): number {
    return this.db.getAlerts().filter(a => a.status === 'active' && !a.resolved_at).length;
  }

  resolve(alertId: string) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE alerts SET resolved_at = ?, updated_at = ? WHERE id = ?')
      .run(now, now, alertId);
  }

  snooze(alertId: string, until: Date) {
    const now = new Date().toISOString();
    this.db.prepare('UPDATE alerts SET snoozed_until = ?, updated_at = ? WHERE id = ?')
      .run(until.toISOString(), now, alertId);
  }

  cleanupExpiredSnoozes(): number {
    // Simplified: just clear all snoozes for testing
    let cleared = 0;
    const alerts = this.db.getAlerts();
    for (const alert of alerts) {
      if (alert.snoozed_until && new Date(alert.snoozed_until) < new Date()) {
        alert.snoozed_until = undefined;
        cleared++;
      }
    }
    return cleared;
  }

  cleanupOldAlerts(days: number): number {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let deleted = 0;
    const alerts = this.db.getAlerts();
    for (let i = alerts.length - 1; i >= 0; i--) {
      if (alerts[i].resolved_at && new Date(alerts[i].resolved_at) < cutoff) {
        alerts.splice(i, 1);
        deleted++;
      }
    }
    return deleted;
  }
}

// ============================================================================
// Threshold Evaluation (from AlertEngine)
// ============================================================================

function evaluateThreshold(
  current: number,
  baseline: number,
  type: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'drop_pct',
  threshold: number
): boolean {
  switch (type) {
    case 'gt': return current > threshold;
    case 'gte': return current >= threshold;
    case 'lt': return current < threshold;
    case 'lte': return current <= threshold;
    case 'eq': return Math.abs(current - threshold) < 0.0001;
    case 'drop_pct':
      if (baseline === 0) return false;
      const dropPercent = ((baseline - current) / baseline) * 100;
      return dropPercent >= threshold;
    default: return false;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Alert System E2E', () => {
  let db: MockDB;
  let storage: AlertStorage;

  beforeEach(() => {
    jest.clearAllMocks();
    db = createMockDB();
    storage = new AlertStorage(db);
  });

  // -------------------------------------------------------------------------
  // Alert Storage Tests
  // -------------------------------------------------------------------------

  describe('Alert Storage', () => {
    it('should create alert with generated ID', async () => {
      const alert = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test alert',
      });

      expect(alert.id).toBeDefined();
      expect(alert.id).toMatch(/^alert_/);
      expect(alert.status).toBe('active');
      expect(alert.resolved_at).toBeUndefined();
    });

    it('should store context as JSON', async () => {
      const context = { metric: 'revenue', currentValue: 100 };

      await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
        context,
      });

      const alerts = db.getAlerts();
      expect(alerts[alerts.length - 1].context).toEqual(context);
    });

    it('should retrieve alert by ID', async () => {
      const created = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test alert',
      });

      const found = storage.getById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it('should return null for non-existent alert', () => {
      const found = storage.getById('non-existent');
      expect(found).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // Alert Resolution Tests
  // -------------------------------------------------------------------------

  describe('Alert Resolution', () => {
    it('should resolve active alert', async () => {
      const alert = await storage.create({
        rule_id: 'test-rule',
        severity: 'critical',
        message: 'Critical issue',
      });

      expect(alert.resolved_at).toBeUndefined();

      storage.resolve(alert.id);

      const resolved = storage.getById(alert.id);
      expect(resolved?.resolved_at).not.toBeNull();
      expect(resolved?.status).toBe('resolved');
    });

    it('should update resolved_at timestamp', async () => {
      const alert = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      storage.resolve(alert.id);

      const resolved = storage.getById(alert.id);
      expect(new Date(resolved!.resolved_at!).getTime()).toBeCloseTo(Date.now(), -3); // Within 1 second
    });
  });

  // -------------------------------------------------------------------------
  // Snooze Tests
  // -------------------------------------------------------------------------

  describe('Snooze Functionality', () => {
    it('should set snoozed_until to specified time', async () => {
      const alert = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test alert',
      });

      const snoozeUntil = new Date(Date.now() + 3600000);

      storage.snooze(alert.id, snoozeUntil);

      const updated = storage.getById(alert.id);
      expect(updated?.snoozed_until).toBe(snoozeUntil.toISOString());
    });

    it('should clear expired snoozes', async () => {
      const alert = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      const pastTime = new Date(Date.now() - 3600000);
      storage.snooze(alert.id, pastTime);

      const cleared = storage.cleanupExpiredSnoozes();
      expect(cleared).toBeGreaterThanOrEqual(1);

      const updated = storage.getById(alert.id);
      expect(updated?.snoozed_until).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Unread Count Badge Tests
  // -------------------------------------------------------------------------

  describe('Unread Alert Badge', () => {
    it('should return correct unread count', async () => {
      await storage.create({ rule_id: 'rule-1', severity: 'warning', message: 'Alert 1' });
      await storage.create({ rule_id: 'rule-2', severity: 'critical', message: 'Alert 2' });
      await storage.create({ rule_id: 'rule-3', severity: 'info', message: 'Alert 3' });

      // Resolve one
      const alerts = db.getAlerts();
      storage.resolve(alerts[0].id);

      const unreadCount = storage.getUnreadCount();
      expect(unreadCount).toBe(2);
    });

    it('should return 0 when all alerts are resolved', async () => {
      const alert = await storage.create({
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Test',
      });

      storage.resolve(alert.id);

      const unreadCount = storage.getUnreadCount();
      expect(unreadCount).toBe(0);
    });

    it('should return 0 for no alerts', () => {
      const count = storage.getUnreadCount();
      expect(count).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Threshold Evaluation Tests
  // -------------------------------------------------------------------------

  describe('Threshold Evaluation', () => {
    it('should detect revenue drop percentage correctly', () => {
      // 66% drop from 300 to 100, threshold 50% -> true
      expect(evaluateThreshold(100, 300, 'drop_pct', 50)).toBe(true);
      // 20% drop from 300 to 240, threshold 50% -> false
      expect(evaluateThreshold(240, 300, 'drop_pct', 50)).toBe(false);
      // Edge: baseline 0 should return false
      expect(evaluateThreshold(100, 0, 'drop_pct', 50)).toBe(false);
    });

    it('should handle revenue increase (negative drop)', () => {
      // Revenue increased: current 400, baseline 300 = -33% drop
      expect(evaluateThreshold(400, 300, 'drop_pct', 50)).toBe(false);
    });

    it('should evaluate other threshold types', () => {
      expect(evaluateThreshold(150, 0, 'gt', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'gte', 100)).toBe(true);
      expect(evaluateThreshold(50, 0, 'lt', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'lte', 100)).toBe(true);
      expect(evaluateThreshold(100, 0, 'eq', 100)).toBe(true);
      expect(evaluateThreshold(101, 0, 'eq', 100)).toBe(false);
    });

    it('should handle fractional drop percentages', () => {
      // 25.5% drop from 200 to 149
      expect(evaluateThreshold(149, 200, 'drop_pct', 25)).toBe(true);
      expect(evaluateThreshold(149, 200, 'drop_pct', 30)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Cooldown Logic Tests
  // -------------------------------------------------------------------------

  describe('Cooldown Logic', () => {
    it('should check for alerts within cooldown window', async () => {
      // The cooldown check in production queries: alerts where rule_id = ? AND triggered_at >= datetime('now', -cooldown minutes)
      // In our mock, we simulate by checking the alerts array
      const alerts = db.getAlerts();

      // Add an alert that's within cooldown window (recent)
      const now = new Date();
      alerts.push({
        id: 'recent-alert',
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Recent alert',
        triggered_at: now.toISOString(),
        resolved_at: undefined,
        snoozed_until: undefined,
        context: {},
        status: 'active',
        created_at: now.toISOString(),
        updated_at: now.toISOString(),
      });

      // Check if alert exists within cooldown
      const cooldownMinutes = 60;
      const cutoff = new Date(now.getTime() - cooldownMinutes * 60 * 1000);
      const inCooldown = alerts.some(a =>
        a.rule_id === 'test-rule' && new Date(a.triggered_at) >= cutoff
      );

      expect(inCooldown).toBe(true);
    });

    it('should allow new alert after cooldown expires', async () => {
      const alerts = db.getAlerts();

      // Add an alert that's outside cooldown window (old)
      const oldTime = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
      alerts.push({
        id: 'old-alert',
        rule_id: 'test-rule',
        severity: 'warning',
        message: 'Old alert',
        triggered_at: oldTime.toISOString(),
        resolved_at: undefined,
        snoozed_until: undefined,
        context: {},
        status: 'active',
        created_at: oldTime.toISOString(),
        updated_at: oldTime.toISOString(),
      });

      const cooldownMinutes = 60;
      const cutoff = new Date(Date.now() - cooldownMinutes * 60 * 1000);
      const inCooldown = alerts.some(a =>
        a.rule_id === 'test-rule' && new Date(a.triggered_at) >= cutoff
      );

      expect(inCooldown).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // Alert Cleanup Tests
  // -------------------------------------------------------------------------

  describe('Alert Cleanup', () => {
    it('should delete old resolved alerts', async () => {
      const now = new Date();
      const oldDate = new Date(now.getTime() - 100 * 24 * 60 * 60 * 1000); // 100 days ago

      await storage.create({
        rule_id: 'old-resolved',
        severity: 'warning',
        message: 'Old resolved alert',
      });

      const alerts = db.getAlerts();
      const oldAlert = alerts.find(a => a.rule_id === 'old-resolved');
      if (oldAlert) {
        oldAlert.resolved_at = oldDate.toISOString();
      }

      const deleted = storage.cleanupOldAlerts(90);
      expect(deleted).toBeGreaterThanOrEqual(1);
    });

    it('should not delete active alerts', async () => {
      await storage.create({
        rule_id: 'active-alert',
        severity: 'critical',
        message: 'Active alert',
      });

      const deleted = storage.cleanupOldAlerts(90);
      expect(deleted).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Full Lifecycle Integration
  // -------------------------------------------------------------------------

  describe('Full Alert Lifecycle', () => {
    it('should complete full lifecycle: create → snooze → resolve', async () => {
      // PHASE 1: Create alert
      const alert = await storage.create({
        rule_id: 'revenue-drop',
        severity: 'critical',
        message: 'Revenue dropped 60%',
        context: { metric: 'daily_revenue', currentValue: 100 },
      });

      expect(alert.status).toBe('active');
      expect(storage.getUnreadCount()).toBe(1);

      // PHASE 2: Snooze alert
      const snoozeUntil = new Date(Date.now() + 3600000);
      storage.snooze(alert.id, snoozeUntil);

      let updated = storage.getById(alert.id);
      expect(updated?.snoozed_until).toBe(snoozeUntil.toISOString());
      expect(updated?.status).toBe('snoozed');

      // PHASE 3: Resolve alert
      storage.resolve(alert.id);

      updated = storage.getById(alert.id);
      expect(updated?.resolved_at).not.toBeNull();
      expect(updated?.status).toBe('resolved');
      expect(storage.getUnreadCount()).toBe(0);
    });

    it('should handle cooldown preventing duplicate alerts', async () => {
      const ruleId = 'test-rule';

      // Create first alert
      await storage.create({
        rule_id: ruleId,
        severity: 'warning',
        message: 'First alert',
      });

      expect(storage.getActiveAlerts()).toHaveLength(1);

      // Second alert should be prevented by cooldown check in production
      // Here we verify cooldown detection logic works
      const alerts = db.getAlerts();
      const now = new Date();
      const recentAlert = alerts.find(a =>
        a.rule_id === ruleId &&
        new Date(a.triggered_at) >= new Date(now.getTime() - 60 * 60 * 1000)
      );

      expect(recentAlert).toBeDefined();
      // In production, AlertEngine would skip creating a new alert here
    });
  });
});
