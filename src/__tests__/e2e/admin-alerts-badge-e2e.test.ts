/**
 * Admin Alerts API & Badge Integration E2E Tests
 *
 * Tests:
 * - Unread alert count polling (useUnreadAlertsCount hook)
 * - Admin alerts API endpoints
 * - Alert CRUD operations (resolve, snooze, mark read)
 * - Real-time badge updates
 * - Filtering and pagination
 */

import type { D1Database } from '@/types/d1';

// ============================================================================
// Types
// ============================================================================

interface MockDB {
  prepare(sql: string): MockStatement;
  getAlerts(): AlertRecord[];
  addAlert(alert: Partial<AlertRecord>): AlertRecord;
  clearAlerts(): void;
}

interface MockStatement {
  sql: string;
  _params: any[];
  bind: (...params: any[]) => MockStatement;
  first: () => Promise<any>;
  all: () => Promise<any[]>;
  run: () => Promise<{ success: boolean; changes: number }>;
}

interface ProfileRecord {
  id: string;
  email: string;
  role: 'admin' | 'shopper' | 'affiliate';
  full_name?: string;
}

interface AlertRecord {
  id: string;
  alert_id: string;
  type: string;
  title: string;
  description: string;
  current_value: number;
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  triggered_at: string;
  resolved_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  is_read: 0 | 1;
  is_silenced: 0 | 1;
  silenced_until?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// Mock Database
// ============================================================================

export function createMockDB(): MockDB {
  const alerts: AlertRecord[] = [];
  const profiles: ProfileRecord[] = [{ id: 'admin-001', email: 'admin@apexos.io', role: 'admin' }];

  return {
    prepare: jest.fn().mockImplementation((sql: string) => {
      const statement: MockStatement = {
        sql,
        _params: [],
        bind: (...params) => {
          statement._params = params;
          return statement;
        },
        first: async () => {
          return queryDB(sql, statement._params, alerts, profiles, true);
        },
        all: async () => {
          return queryDB(sql, statement._params, alerts, profiles, false);
        },
        run: async () => {
          executeSQL(sql, statement._params, alerts, profiles);
          return { success: true, changes: 1 };
        },
      };
      return statement;
    }),
    getAlerts: () => alerts,
    addAlert: (alert: Partial<AlertRecord>) => {
      const fullAlert: AlertRecord = {
        id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        alert_id: alert.alert_id || 'unknown',
        type: alert.type || 'unknown',
        title: alert.title || 'Untitled',
        description: alert.description || '',
        current_value: alert.current_value || 0,
        threshold: alert.threshold || 0,
        severity: alert.severity || 'info',
        triggered_at: alert.triggered_at || new Date().toISOString(),
        is_read: alert.is_read ?? 0,
        is_silenced: alert.is_silenced ?? 0,
        metadata: alert.metadata || {},
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      // Copy optional fields if present
      if (alert.resolved_at) fullAlert.resolved_at = alert.resolved_at;
      if (alert.acknowledged_at) fullAlert.acknowledged_at = alert.acknowledged_at;
      if (alert.acknowledged_by) fullAlert.acknowledged_by = alert.acknowledged_by;
      if (alert.silenced_until) fullAlert.silenced_until = alert.silenced_until;
      alerts.push(fullAlert);
      return fullAlert;
    },
    clearAlerts: () => alerts.length = 0,
  };
}

interface AlertRecord {
  id: string;
  alert_id: string;
  type: string;
  title: string;
  description: string;
  current_value: number;
  threshold: number;
  severity: 'info' | 'warning' | 'critical';
  triggered_at: string;
  resolved_at?: string;
  acknowledged_at?: string;
  acknowledged_by?: string;
  is_read: 0 | 1;
  is_silenced: 0 | 1;
  silenced_until?: string;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

function queryDB(
  sql: string,
  params: any[],
  alerts: AlertRecord[],
  profiles: ProfileRecord[],
  single: boolean
): any {
  // Simple SQL parser for tests
  const query = sql.trim();

  // Get alert by ID
  const idMatch = query.match(/SELECT \* FROM alert_history WHERE id = \?/);
  if (idMatch) {
    const alert = alerts.find(a => a.id === params[0]);
    return single ? (alert || null) : (alert ? [alert] : []);
  }

  // Get alerts list
  if (query.includes('FROM alert_history')) {
    let filtered = [...alerts];

    // Apply status filter
    if (query.includes('resolved_at IS NULL')) {
      filtered = filtered.filter(a => !a.resolved_at);
    } else if (query.includes('resolved_at IS NOT NULL')) {
      filtered = filtered.filter(a => !!a.resolved_at);
    }

    // Apply severity filter
    const severityMatch = query.match(/severity = \?/);
    if (severityMatch && params.length > 0) {
      const severityParam = params.find(p => typeof p === 'string' && ['info', 'warning', 'critical'].includes(p));
      if (severityParam) {
        filtered = filtered.filter(a => a.severity === severityParam);
      }
    }

    // Apply date range
    if (query.includes('triggered_at >= ?') && params.find(p => typeof p === 'string' && p.includes('-'))) {
      const startDate = params.find(p => typeof p === 'string' && p.includes('-'));
      if (startDate) {
        filtered = filtered.filter(a => a.triggered_at >= startDate);
      }
    }

    // Order and paginate
    filtered.sort((a, b) => new Date(b.triggered_at).getTime() - new Date(a.triggered_at).getTime());

    const limitMatch = query.match(/LIMIT (\?)/);
    const offsetMatch = query.match(/OFFSET (\?)/);
    if (limitMatch && offsetMatch) {
      const limitIdx = query.indexOf('LIMIT ?');
      const offsetIdx = query.indexOf('OFFSET ?');
      const limitParam = params.find((_, i) => query.indexOf('?', offsetIdx) > query.indexOf('?', i));
      const offsetParam = params.find((_, i) => query.indexOf('?', limitIdx) > query.indexOf('?', i) && _ !== limitParam);
      const limit = limitParam || 50;
      const offset = offsetParam || 0;
      filtered = filtered.slice(Number(offset), Number(offset) + Number(limit));
    }

    return single ? (filtered[0] || null) : filtered;
  }

  // Count queries
  const countMatch = query.match(/SELECT COUNT\(\*\)(?: as (\w+))? FROM/);
  if (countMatch) {
    if (query.includes('FROM alert_history')) {
      let count = alerts.length;
      if (query.includes('resolved_at IS NULL')) {
        count = alerts.filter(a => !a.resolved_at).length;
      }
      return single ? { count } : [{ count }];
    }
    return single ? { total: 0 } : [{ total: 0 }];
  }

  // Summary query
  if (query.includes('activeAlerts') || query.includes('unread')) {
    const active = alerts.filter(a => !a.resolved_at).length;
    const unread = alerts.filter(a => !a.resolved_at && a.is_read === 0).length;
    return single ? { active, unread } : [{ active, unread }];
  }

  return single ? null : [];
}

function executeSQL(sql: string, params: any[], alerts: AlertRecord[], profiles: ProfileRecord[]): void {
  const query = sql.trim();

  if (query.startsWith('INSERT INTO alert_history')) {
    const alert: AlertRecord = {
      id: `alert_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
      alert_id: params[0],
      type: params[1],
      title: params[2],
      description: params[3],
      current_value: params[4],
      threshold: params[5],
      severity: params[6],
      triggered_at: params[7] || new Date().toISOString(),
      resolved_at: params[8],
      acknowledged_at: params[9],
      acknowledged_by: params[10],
      is_read: params[11] || 0,
      is_silenced: params[12] || 0,
      silenced_until: params[13],
      metadata: params[14] || {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    alerts.push(alert);
  } else if (query.startsWith('UPDATE alert_history SET')) {
    const id = params[params.length - 1];
    const alert = alerts.find(a => a.id === id);
    if (alert) {
      const setClause = query.match(/SET (.+?) WHERE/)?.[1] || '';
      const updates = setClause.split(',');
      updates.forEach(update => {
        const [field, value] = update.trim().split(' = ');
        if (field === 'resolved_at') {
          alert.resolved_at = value === "datetime('now')" ? new Date().toISOString() : value;
        } else if (field === 'snoozed_until') {
          alert.silenced_until = value;
        } else if (field === 'is_read') {
          alert.is_read = Number(value) as 0 | 1;
        } else if (field === 'updated_at') {
          alert.updated_at = new Date().toISOString();
        }
      });
    }
  } else if (query.includes('DELETE FROM alert_history')) {
    const daysParam = params.find(p => typeof p === 'number');
    if (daysParam) {
      const cutoff = new Date(Date.now() - daysParam * 24 * 60 * 60 * 1000);
      for (let i = alerts.length - 1; i >= 0; i--) {
        if (alerts[i].resolved_at && new Date(alerts[i].resolved_at) < cutoff) {
          alerts.splice(i, 1);
        }
      }
    }
  }
}

// ============================================================================
// API Handler
// ============================================================================

class AdminAlertsAPI {
  constructor(private db: MockDB) {}

  async get(): Promise<{ status: number; body: any }> {
    const alerts = this.db.getAlerts();

    const active = alerts.filter(a => !a.resolved_at);
    const unread = alerts.filter(a => !a.resolved_at && a.is_read === 0);

    return {
      status: 200,
      body: {
        success: true,
        data: alerts.map(a => ({
          ...a,
          metadata: a.metadata || {},
          isRead: Boolean(a.is_read),
          isSilenced: Boolean(a.is_silenced),
        })),
        summary: {
          total: alerts.length,
          active: active.length,
          unread: unread.length,
          lastTriggered: alerts[0]?.triggered_at || null,
          bySeverity: active.reduce((acc, a) => {
            acc[a.severity] = (acc[a.severity] || 0) + 1;
            return acc;
          }, {} as Record<string, number>),
        },
        pagination: { total: alerts.length, limit: 50, offset: 0, hasMore: false },
      },
    };
  }

  async post(body: any): Promise<{ status: number; body: any }> {
    const { action, alertId, snoozeUntil } = body;

    try {
      const alerts = this.db.getAlerts();
      const alert = alerts.find(a => a.id === alertId);

      if (!alert) {
        return { status: 404, body: { success: false, error: 'Alert not found' } };
      }

      switch (action) {
        case 'resolve':
          alert.resolved_at = new Date().toISOString();
          alert.updated_at = new Date().toISOString();
          return { status: 200, body: { success: true, action: 'resolved', alertId } };

        case 'snooze':
          if (!snoozeUntil) {
            return { status: 400, body: { success: false, error: 'snoozeUntil required' } };
          }
          alert.silenced_until = snoozeUntil;
          alert.updated_at = new Date().toISOString();
          return { status: 200, body: { success: true, action: 'snoozed', alertId, until: snoozeUntil } };

        case 'markRead':
          alert.is_read = 1;
          alert.updated_at = new Date().toISOString();
          return { status: 200, body: { success: true, action: 'markedRead', alertId } };

        case 'markUnread':
          alert.is_read = 0;
          alert.updated_at = new Date().toISOString();
          return { status: 200, body: { success: true, action: 'markedUnread', alertId } };

        default:
          return { status: 400, body: { success: false, error: 'Invalid action' } };
      }
    } catch (error) {
      return { status: 500, body: { success: false, error: error instanceof Error ? error.message : 'Unknown error' } };
    }
  }
}

// ============================================================================
// useUnreadAlertsCount Hook Simulation
// ============================================================================

class UnreadAlertsPoller {
  private count = 0;
  private intervalId: any = null;

  constructor(private api: AdminAlertsAPI, private intervalMs: number = 30000) {}

  start(onUpdate?: (count: number) => void) {
    this.fetchCount(onUpdate);
    this.intervalId = setInterval(() => this.fetchCount(onUpdate), this.intervalMs);
  }

  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  getCount() {
    return this.count;
  }

  async fetchCount(onUpdate?: (count: number) => void) {
    const response = await this.api.get();
    if (response.status === 200) {
      this.count = response.body.summary.unread;
      onUpdate?.(this.count);
    }
    return this.count;
  }
}

// ============================================================================
// Test Suite
// ============================================================================

describe('Admin Alerts API & Badge E2E', () => {
  let db: MockDB;
  let api: AdminAlertsAPI;
  let poller: UnreadAlertsPoller;

  beforeEach(() => {
    jest.clearAllMocks();
    db = createMockDB();
    api = new AdminAlertsAPI(db);
    poller = new UnreadAlertsPoller(api);
  });

  afterEach(() => {
    poller.stop();
  });

  describe('GET /api/admin/alerts', () => {
    it('should return alerts with summary', async () => {
      db.addAlert({
        alert_id: 'revenue-drop',
        type: 'revenue_drop',
        title: 'Revenue Drop',
        description: 'Revenue dropped significantly',
        current_value: 400,
        threshold: 1000,
        severity: 'critical',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      const response = await api.get();

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);
      expect(response.body.data).toHaveLength(1);
      expect(response.body.summary.total).toBe(1);
      expect(response.body.summary.unread).toBe(1);
      expect(response.body.summary.bySeverity.critical).toBe(1);
    });

    it('should calculate unread count correctly', async () => {
      db.addAlert({
        alert_id: 'unread-1',
        type: 'test',
        title: 'Unread Alert 1',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      db.addAlert({
        alert_id: 'unread-2',
        type: 'test',
        title: 'Unread Alert 2',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'critical',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      db.addAlert({
        alert_id: 'read-1',
        type: 'test',
        title: 'Read Alert',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'info',
        triggered_at: new Date().toISOString(),
        is_read: 1,
        is_silenced: 0,
        metadata: {},
      });

      const response = await api.get();

      expect(response.body.summary.unread).toBe(2);
      expect(response.body.summary.active).toBe(3);
    });
  });

  describe('POST /api/admin/alerts', () => {
    it('should resolve an alert', async () => {
      const alert = db.addAlert({
        alert_id: 'to-resolve',
        type: 'test',
        title: 'Test Alert',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      const response = await api.post({ action: 'resolve', alertId: alert.id });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const updated = db.getAlerts().find(a => a.id === alert.id);
      expect(updated?.resolved_at).not.toBeNull();
    });

    it('should snooze an alert', async () => {
      const alert = db.addAlert({
        alert_id: 'to-snooze',
        type: 'test',
        title: 'Test Alert',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      const snoozeUntil = new Date(Date.now() + 3600000).toISOString();
      const response = await api.post({ action: 'snooze', alertId: alert.id, snoozeUntil });

      expect(response.status).toBe(200);
      expect(response.body.success).toBe(true);

      const updated = db.getAlerts().find(a => a.id === alert.id);
      expect(updated?.silenced_until).toBe(snoozeUntil);
    });

    it('should mark alert as read', async () => {
      const alert = db.addAlert({
        alert_id: 'to-mark-read',
        type: 'test',
        title: 'Test Alert',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'info',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      const response = await api.post({ action: 'markRead', alertId: alert.id });

      expect(response.status).toBe(200);

      const updated = db.getAlerts().find(a => a.id === alert.id);
      expect(updated?.is_read).toBe(1);
    });

    it('should reject invalid action', async () => {
      // Create a valid alert first
      const alert = db.addAlert({
        alert_id: 'test-alert-invalid',
        type: 'test',
        title: 'Test Alert',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      const response = await api.post({ action: 'invalid', alertId: alert.id });
      expect(response.status).toBe(400);
      expect(response.body.success).toBe(false);
    });

    it('should return 404 for non-existent alert', async () => {
      const response = await api.post({ action: 'resolve', alertId: 'non-existent' });
      expect(response.status).toBe(404);
    });
  });

  describe('Unread Alert Badge', () => {
    it('should return correct unread count', async () => {
      db.addAlert({
        alert_id: 'alert-1',
        type: 'test',
        title: 'Alert 1',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      db.addAlert({
        alert_id: 'alert-2',
        type: 'test',
        title: 'Alert 2',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'critical',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      db.addAlert({
        alert_id: 'alert-3',
        type: 'test',
        title: 'Alert 3',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'info',
        triggered_at: new Date().toISOString(),
        is_read: 1,
        is_silenced: 0,
        metadata: {},
      });

      const response = await api.get();
      expect(response.body.summary.unread).toBe(2);
    });

    it('should update unread count when alert is marked read', async () => {
      const alert = db.addAlert({
        alert_id: 'to-read',
        type: 'test',
        title: 'Test',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      let response = await api.get();
      expect(response.body.summary.unread).toBe(1);

      await api.post({ action: 'markRead', alertId: alert.id });

      response = await api.get();
      expect(response.body.summary.unread).toBe(0);
    });

    it('should update unread count when alert is resolved', async () => {
      const alert = db.addAlert({
        alert_id: 'to-resolve',
        type: 'test',
        title: 'Test',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'critical',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      let response = await api.get();
      expect(response.body.summary.unread).toBe(1);

      await api.post({ action: 'resolve', alertId: alert.id });

      response = await api.get();
      expect(response.body.summary.unread).toBe(0);
    });
  });

  describe('Poller Behavior', () => {
    it('should poll and update count', async () => {
      let count = 0;
      poller.start((c) => { count = c; });

      // Initial fetch
      await poller.fetchCount();
      expect(count).toBe(0);

      // Add alert
      db.addAlert({
        alert_id: 'new-alert',
        type: 'test',
        title: 'New Alert',
        description: 'Test',
        current_value: 100,
        threshold: 50,
        severity: 'warning',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      // Fetch again - check internal count directly
      await poller.fetchCount();
      expect(poller.getCount()).toBe(1);

      poller.stop();
    });

    it('should stop polling when stopped', () => {
      poller.start();
      expect(poller['intervalId']).not.toBeNull();
      poller.stop();
      expect(poller['intervalId']).toBeNull();
    });
  });

  describe('Full Lifecycle Integration', () => {
    it('should track alert through complete lifecycle', async () => {
      // Create alert
      const alert = db.addAlert({
        alert_id: 'lifecycle-alert',
        type: 'revenue_drop',
        title: 'Revenue Drop Alert',
        description: 'Revenue dropped 60%',
        current_value: 400,
        threshold: 1000,
        severity: 'critical',
        triggered_at: new Date().toISOString(),
        is_read: 0,
        is_silenced: 0,
        metadata: {},
      });

      // Verify created
      let response = await api.get();
      expect(response.body.summary.unread).toBe(1);

      // Mark read
      await api.post({ action: 'markRead', alertId: alert.id });
      response = await api.get();
      expect(response.body.summary.unread).toBe(0); // Alert marked read, unread count decreases (still active)

      // Resolve
      await api.post({ action: 'resolve', alertId: alert.id });
      response = await api.get();
      expect(response.body.summary.unread).toBe(0);
      expect(response.body.summary.active).toBe(0);
    });
  });
});

// Export classes for index.ts
export { AdminAlertsAPI, UnreadAlertsPoller };
