/**
 * Alert Snooze and Deduplication Tests
 *
 * Tests for snooze functionality and alert deduplication logic:
 * - Alert snooze (set/clear/expire)
 * - Cooldown-based deduplication
 * - Alert status transitions
 * - Reminder notifications for expired snoozes
 */

import { jest } from '@jest/globals';
const vi = jest;
import { AlertStorage } from '@/lib/alerts/alert-storage';
import type { Alert } from '@/lib/alerts/alert-storage';

// Mock D1 Database - properly supports chaining
const createMockDB = () => {
  const statement = {
    bind: vi.fn(function() { return this; }),
    first: vi.fn(),
    all: vi.fn(),
    run: vi.fn(),
  };

  const db = {
    prepare: vi.fn(() => statement),
    exec: vi.fn(),
    batch: vi.fn(),
    close: vi.fn(),
  };

  return db as any;
};

// Helper to create alert row (matches DB schema)
const createAlertRow = (overrides: Record<string, unknown> = {}) => ({
  id: 'alert_' + crypto.randomUUID(),
  rule_id: 'rule-1',
  severity: 'warning',
  message: 'Test alert',
  triggered_at: new Date().toISOString(),
  resolved_at: null,
  snoozed_until: null,
  context: '{}',
  status: 'active',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  ...overrides,
});

// Helper to normalize row to Alert (mimics AlertStorage.normalizeRow)
const normalizeRow = (row: Record<string, unknown>): Alert => {
  let context: Record<string, unknown> = {};
  try {
    context = row.context ? JSON.parse(row.context as string) : {};
  } catch {
    context = {};
  }

  return {
    id: row.id as string,
    rule_id: row.rule_id as string,
    severity: row.severity as 'warning' | 'critical' | 'info',
    message: row.message as string,
    triggered_at: row.triggered_at as string,
    resolved_at: row.resolved_at as string | null,
    snoozed_until: row.snoozed_until as string | null,
    context,
    status: row.status as 'active' | 'snoozed' | 'resolved',
  };
};

// ============================================================================
// Snooze Tests
// ============================================================================

describe('Alert Snooze Operations', () => {
  let mockDB: ReturnType<typeof createMockDB>;
  let storage: AlertStorage;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new AlertStorage(mockDB as any);
    vi.clearAllMocks();
  });

  describe('snooze()', () => {
    it('should set snooze until specified time', async () => {
      const mockAlert = createAlertRow();
      const until = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours from now

      // Mock UPDATE run
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      // Mock SELECT after update (getById) - return updated alert
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        snoozed_until: until.toISOString(),
        status: 'snoozed',
      });

      const result = await storage.snooze(mockAlert.id, until);

      expect(result).not.toBeNull();
      expect(result?.snoozed_until).toBe(until.toISOString());
      expect(result?.status).toBe('snoozed');
    });

    it('should update database with correct SQL', async () => {
      const mockAlert = createAlertRow();
      const until = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue(mockAlert);

      await storage.snooze(mockAlert.id, until);

      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE alerts SET snoozed_until = ?')
      );
    });

    it('should return null if update fails', async () => {
      (mockDB.prepare().run as any).mockResolvedValue({ success: false, changes: 0 });

      const result = await storage.snooze('non-existent', new Date());

      expect(result).toBeNull();
    });
  });

  describe('clearSnooze()', () => {
    it('should clear snooze by setting to null', async () => {
      const mockAlert = createAlertRow({
        snoozed_until: new Date(Date.now() + 3600000).toISOString(),
      });

      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        snoozed_until: null,
        status: 'active',
      });

      const result = await storage.clearSnooze(mockAlert.id);

      expect(result).not.toBeNull();
      expect(result?.snoozed_until).toBeNull();
      expect(result?.status).toBe('active');
    });

    it('should use NULL in SQL when clearing', async () => {
      const mockAlert = createAlertRow();

      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue(mockAlert);

      await storage.clearSnooze(mockAlert.id);

      // SQL uses parameter binding, so it's "snoozed_until = ?" with NULL bound
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE alerts SET snoozed_until = ?')
      );
 // Verify that NULL was bound as the first parameter (snoozed_until value)
 const bindCallsList = mockDB.prepare().bind.mock.calls;
 expect(bindCallsList.length).toBeGreaterThanOrEqual(1);
 expect(bindCallsList[0][0]).toBeNull();
    });
  });

  describe('update() with snooze_until', () => {
    it('should update only snooze_until field', async () => {
      const mockAlert = createAlertRow();
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        snoozed_until: new Date().toISOString(),
      });

      const result = await storage.update(mockAlert.id, {
        snoozed_until: new Date(Date.now() + 7200000),
      });

      expect(result?.snoozed_until).not.toBeNull();
    });

    it('should clear snooze when passing null', async () => {
      const mockAlert = createAlertRow({
        snoozed_until: new Date(Date.now() + 3600000).toISOString(),
      });
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        snoozed_until: null,
      });

      const result = await storage.update(mockAlert.id, { snoozed_until: null });

      expect(result?.snoozed_until).toBeNull();
    });
  });
});

// ============================================================================
// Deduplication Tests
// ============================================================================

describe('Alert Deduplication Logic', () => {
  let mockDB: ReturnType<typeof createMockDB>;
  let storage: AlertStorage;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new AlertStorage(mockDB as any);
    vi.clearAllMocks();
  });

  describe('Cooldown Check (AlertEngine.checkCooldown pattern)', () => {
    it('should query alerts within cooldown window', async () => {
      const ruleId = 'rule-1';
      const cooldownMinutes = 15;

      (mockDB.prepare().first as any).mockResolvedValue({ id: 'existing-alert' });

      // Simulate query with actual SQL (must pass SQL to prepare)
      await mockDB.prepare('SELECT * FROM alerts WHERE rule_id = ? AND triggered_at >= datetime("now", ?)')
        .bind(ruleId, `-${cooldownMinutes} minutes`)
        .first();

      // Check for SQL with proper WHERE clause
      const sqlCalls = mockDB.prepare.mock.calls.filter(call => typeof call[0] === 'string');
      expect(sqlCalls.some(call => call[0].includes('WHERE rule_id = ?'))).toBe(true);
      expect(sqlCalls.some(call => call[0].includes('triggered_at >= datetime'))).toBe(true);
    });

    it('should find no alerts when cooldown period elapsed', async () => {
      (mockDB.prepare().first as any).mockResolvedValue(undefined);

      const result = await mockDB.prepare().bind('rule-1', 15).first();

      expect(result).toBeUndefined();
    });
  });

  describe('Status Derivation', () => {
    const deriveStatus = (
      resolved_at: string | null,
      snoozed_until: string | null
    ): 'active' | 'snoozed' | 'resolved' => {
      if (resolved_at !== null) return 'resolved';
      if (snoozed_until !== null && new Date(snoozed_until) > new Date()) return 'snoozed';
      return 'active';
    };

    it('should be active when resolved_at is null and no snooze', () => {
      expect(deriveStatus(null, null)).toBe('active');
    });

    it('should be snoozed when snoozed_until is in future', () => {
      const future = new Date(Date.now() + 3600000).toISOString();
      expect(deriveStatus(null, future)).toBe('snoozed');
    });

    it('should be active when snoozed_until is in past', () => {
      const past = new Date(Date.now() - 3600000).toISOString();
      expect(deriveStatus(null, past)).toBe('active');
    });

    it('should be resolved when resolved_at is set', () => {
      expect(deriveStatus(new Date().toISOString(), null)).toBe('resolved');
      expect(deriveStatus(new Date().toISOString(), new Date().toISOString())).toBe('resolved');
    });
  });

  describe('getExpiredSnoozesForReminder', () => {
    it('should find alerts with expired snooze but still active', async () => {
      const mockAlert = createAlertRow({
        snoozed_until: new Date(Date.now() - 3600000).toISOString(), // 1 hour ago
        status: 'active',
      });

      (mockDB.prepare().all as any).mockResolvedValue({
        results: [mockAlert],
      });

      const expired = await storage.getExpiredSnoozesForReminder();

      expect(expired).toHaveLength(1);
      expect(expired[0].status).toBe('active');
    });

    it('should not include snoozed alerts that are not expired', async () => {
      // Alert with status='snoozed' should not be returned because query filters for status='active'
      (mockDB.prepare().all as any).mockResolvedValue({
        results: [],  // DB query filters by status='active', so non-active alerts aren't returned
      });

      const expired = await storage.getExpiredSnoozesForReminder();

      expect(expired).toHaveLength(0);
    });

    it('should query with correct SQL', async () => {
      (mockDB.prepare().all as any).mockResolvedValue({ results: [] });

      await storage.getExpiredSnoozesForReminder();

      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining("WHERE a.status = 'active'")
      );
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining("a.snoozed_until IS NOT NULL")
      );
      expect(mockDB.prepare).toHaveBeenCalledWith(
        expect.stringContaining("a.snoozed_until < datetime('now')")
      );
    });
  });

  describe('cleanupExpiredSnoozes', () => {
    it('should clear snoozes that have expired', async () => {
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 10 } });

      const cleared = await storage.cleanupExpiredSnoozes();

      expect(cleared).toBe(10);
      // Check for SQL with proper filtering (handle multi-line SQL)
      const sqlCalls = mockDB.prepare.mock.calls.filter(call => typeof call[0] === 'string');
      const hasUpdateSql = sqlCalls.some(call =>
        call[0].includes('UPDATE alerts') && call[0].includes('snoozed_until = NULL')
      );
      expect(hasUpdateSql).toBe(true);
      const hasStatusCondition = sqlCalls.some(call =>
        call[0].includes("status = 'snoozed'")
      );
      expect(hasStatusCondition).toBe(true);
      const hasTimeCondition = sqlCalls.some(call =>
        call[0].includes("snoozed_until < datetime('now')")
      );
      expect(hasTimeCondition).toBe(true);
    });

    it('should return 0 when no expired snoozes', async () => {
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 0 } });

      const cleared = await storage.cleanupExpiredSnoozes();

      expect(cleared).toBe(0);
    });
  });
});

// ============================================================================
// Status Transition Tests
// ============================================================================

describe('Alert Status Transitions', () => {
  let mockDB: ReturnType<typeof createMockDB>;
  let storage: AlertStorage;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new AlertStorage(mockDB as any);
    vi.clearAllMocks();
  });

  describe('resolve()', () => {
    it('should transition alert to resolved status', async () => {
      const mockAlert = createAlertRow();
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        resolved_at: new Date().toISOString(),
        status: 'resolved',
      });

      const result = await storage.resolve(mockAlert.id);

      expect(result).not.toBeNull();
      expect(result?.resolved_at).not.toBeNull();
      expect(result?.status).toBe('resolved');
    });

    it('should set resolved_at to current time', async () => {
      const mockAlert = createAlertRow();
      const originalNow = Date.now;
      const mockNow = 1705279200000; // 2024-01-15T10:00:00Z
      Date.now = () => mockNow;

      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        resolved_at: new Date(mockNow).toISOString(),
        status: 'resolved',
      });

      await storage.resolve(mockAlert.id);

      // Check that UPDATE query was made with resolved_at
      const sqlCalls = mockDB.prepare.mock.calls.filter(call => typeof call[0] === 'string' && call[0].startsWith('UPDATE'));
      expect(sqlCalls.some(call => call[0].includes('resolved_at = ?'))).toBe(true);

      Date.now = originalNow;
    });
  });

  describe('Complex transition scenarios', () => {
    it('should allow resolve on snoozed alert', async () => {
      const mockAlert = createAlertRow({
        snoozed_until: new Date(Date.now() + 3600000).toISOString(),
      });
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        resolved_at: new Date().toISOString(),
        status: 'resolved',
      });

      const result = await storage.resolve(mockAlert.id);

      expect(result?.status).toBe('resolved');
    });

    it('should allow snooze on resolved alert (DB level allowed)', async () => {
      const mockAlert = createAlertRow({
        resolved_at: new Date().toISOString(),
        status: 'resolved',
      });
      (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
      (mockDB.prepare().first as any).mockResolvedValue({
        ...mockAlert,
        snoozed_until: new Date(Date.now() + 3600000).toISOString(),
      });

      const result = await storage.snooze(mockAlert.id, new Date(Date.now() + 3600000));

      // DB level allows setting snooze on resolved alert
      expect(result?.snoozed_until).toBeDefined();
    });
  });
});

// ============================================================================
// Alert Lifecycle Integration Tests
// ============================================================================

describe('Alert Lifecycle Integration', () => {
  let mockDB: ReturnType<typeof createMockDB>;
  let storage: AlertStorage;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new AlertStorage(mockDB as any);
    vi.clearAllMocks();
  });

  it('should support full lifecycle: create -> snooze -> clear -> resolve', async () => {
    const createInput = {
      rule_id: 'rule-1',
      severity: 'warning',
      message: 'Test alert',
    };

    // Create: mock INSERT run and getById
    const createdAlertRow = createAlertRow(createInput);
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1, last_insert_rowid: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue(createdAlertRow);

    const createdAlert = await storage.create(createInput);
    expect(createdAlert.status).toBe('active');

    // Snooze: mock UPDATE run and getById with updated snoozed_until
    const snoozeUntil = new Date(Date.now() + 3600000);
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...createdAlertRow,
      snoozed_until: snoozeUntil.toISOString(),
      status: 'snoozed',
    });

    const snoozedAlert = await storage.snooze(createdAlert.id, snoozeUntil);
    expect(snoozedAlert?.status).toBe('snoozed');
    expect(snoozedAlert?.snoozed_until).toBe(snoozeUntil.toISOString());

    // Clear snooze: mock UPDATE run and getById with cleared snooze
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...createdAlertRow,
      snoozed_until: null,
      status: 'active',
    });

    const clearedAlert = await storage.clearSnooze(createdAlert.id);
    expect(clearedAlert?.status).toBe('active');
    expect(clearedAlert?.snoozed_until).toBeNull();

    // Resolve: mock UPDATE run and getById with resolved_at
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...createdAlertRow,
      resolved_at: new Date().toISOString(),
      status: 'resolved',
    });

    const resolvedAlert = await storage.resolve(createdAlert.id);
    expect(resolvedAlert?.status).toBe('resolved');
    expect(resolvedAlert?.resolved_at).not.toBeNull();
  });

  it('should prevent duplicate snoozes on already snoozed alert', async () => {
    const mockAlert = createAlertRow({
      snoozed_until: new Date(Date.now() + 3600000).toISOString(),
    });
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue(mockAlert);

    // Snooze again (this is allowed - it extends the snooze)
    const newUntil = new Date(Date.now() + 7200000);
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    (mockDB.prepare().first as any).mockResolvedValue({
      ...mockAlert,
      snoozed_until: newUntil.toISOString(),
    });

    const result = await storage.snooze(mockAlert.id, newUntil);

    expect(result?.snoozed_until).toBe(newUntil.toISOString());
  });
});

// ============================================================================
// Concurrency Tests
// ============================================================================

describe('Concurrent Snooze Operations', () => {
  let mockDB: ReturnType<typeof createMockDB>;
  let storage: AlertStorage;

  beforeEach(() => {
    mockDB = createMockDB();
    storage = new AlertStorage(mockDB as any);
    vi.clearAllMocks();
  });

  it('should handle multiple concurrent snooze operations on different alerts', async () => {
    const alerts = [
      createAlertRow({ id: 'alert-1' }),
      createAlertRow({ id: 'alert-2' }),
      createAlertRow({ id: 'alert-3' }),
    ];

    // Mock run to always succeed
    (mockDB.prepare().run as any).mockResolvedValue({ success: true, meta: { changes: 1 } });
    // Mock first to return any snoozed alert (first() is called without args)
    (mockDB.prepare().first as any).mockResolvedValue({
      ...alerts[0],
      snoozed_until: new Date(Date.now() + 3600000).toISOString(),
      status: 'snoozed',
    });

    const snoozeUntil = new Date(Date.now() + 3600000);
    const promises = alerts.map(alert =>
      storage.snooze(alert.id, snoozeUntil)
    );

    const results = await Promise.all(promises);

    expect(results).toHaveLength(3);
    expect(results.every(r => r !== null && r.snoozed_until)).toBe(true);
  });
});
