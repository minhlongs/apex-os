/** @jest-environment node */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { D1Database } from '@/lib/db';
import { isEmergencySettlementPaused } from '@/lib/payouts/usdc-safety-guards';

type FlagRow = { flag_key: string; flag_value: string; reason: string | null };
const openFlags: FlagRow[] = [
  { flag_key: 'EMERGENCY_PAUSE', flag_value: 'false', reason: null },
  { flag_key: 'EMERGENCY_LEDGER_FREEZE', flag_value: 'false', reason: null },
];

function flagDatabase(rows: FlagRow[], failure?: Error): D1Database {
  const statement = {
    bind: jest.fn().mockReturnThis(),
    all: failure
      ? jest.fn().mockRejectedValue(failure)
      : jest.fn().mockResolvedValue({ results: rows, success: true }),
  };
  // Only the mandatory read contract is used; no network or production binding.
  return { prepare: jest.fn().mockReturnValue(statement) } as unknown as D1Database;
}

describe('Mandatory emergency control reads', () => {
  it('opens only when both mandatory controls are explicitly false', async () => {
    await expect(isEmergencySettlementPaused(flagDatabase(openFlags))).resolves.toEqual({ paused: false });
  });

  it.each(['EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE'])('denies active %s', async (flagKey) => {
    const rows = openFlags.map((row) => row.flag_key === flagKey ? { ...row, flag_value: 'true' } : row);
    await expect(isEmergencySettlementPaused(flagDatabase(rows))).resolves.toMatchObject({ paused: true, flagKey });
  });

  it.each(['EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE'])('denies missing %s', async (flagKey) => {
    await expect(isEmergencySettlementPaused(flagDatabase(openFlags.filter((row) => row.flag_key !== flagKey))))
      .resolves.toMatchObject({ paused: true, flagKey });
  });

  it.each(['', 'FALSE', '0', 'malformed'])('denies invalid control value %j', async (value) => {
    const rows = openFlags.map((row) => ({ ...row, flag_value: value }));
    await expect(isEmergencySettlementPaused(flagDatabase(rows))).resolves.toMatchObject({ paused: true });
  });

  it('denies duplicate controls even when their values are false', async () => {
    await expect(isEmergencySettlementPaused(flagDatabase([...openFlags, openFlags[0]])))
      .resolves.toMatchObject({ paused: true });
  });

  it('propagates a failed mandatory read instead of allowing settlement', async () => {
    await expect(isEmergencySettlementPaused(flagDatabase([], new Error('policy read timed out'))))
      .rejects.toThrow('policy read timed out');
  });
});

describe('Withdrawal journal freeze transaction boundary', () => {
  let sqlite: Database.Database;
  let backup: Database.Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    backup = new Database(sqlite.serialize());
    sqlite.exec(`
      CREATE TABLE system_runtime_flags (flag_key TEXT PRIMARY KEY, flag_value TEXT);
      CREATE TABLE ledger_journal_batches (id TEXT PRIMARY KEY, journal_type TEXT NOT NULL);
      CREATE TABLE transaction_markers (id TEXT PRIMARY KEY);
      INSERT INTO system_runtime_flags VALUES ('EMERGENCY_LEDGER_FREEZE', 'false');
    `);
    const migration = fs.readFileSync('src/database/migrations/034_withdrawal_freeze_at_write.sql', 'utf8');
    sqlite.exec(migration);
    sqlite.exec(migration);
  });

  afterEach(() => { sqlite.close(); backup.close(); });

  it.each(['WITHDRAWAL_LOCK', 'WITHDRAWAL_FINALIZED', 'WITHDRAWAL_REVERTED'])
   ('permits %s only while the mandatory freeze control is false', (journalType) => {
      sqlite.prepare('INSERT INTO ledger_journal_batches VALUES (?, ?)').run('open', journalType);
      sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true'").run();
      const write = sqlite.transaction(() => {
        sqlite.prepare('INSERT INTO transaction_markers VALUES (?)').run('must-rollback');
        sqlite.prepare('INSERT INTO ledger_journal_batches VALUES (?, ?)').run('blocked', journalType);
      });
      expect(write).toThrow('Withdrawal ledger mutation denied');
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM transaction_markers').get()).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM ledger_journal_batches').get()).toEqual({ n: 1 });
    });

  it.each(['missing', 'malformed'])('denies withdrawal writes with a %s freeze control', (mode) => {
    if (mode === 'missing') sqlite.prepare('DELETE FROM system_runtime_flags').run();
    else sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'malformed'").run();
    expect(() => sqlite.prepare('INSERT INTO ledger_journal_batches VALUES (?, ?)').run('blocked', 'WITHDRAWAL_LOCK'))
      .toThrow('Withdrawal ledger mutation denied');
  });

  it('does not block unrelated journal types', () => {
    sqlite.prepare("UPDATE system_runtime_flags SET flag_value = 'true'").run();
    expect(() => sqlite.prepare('INSERT INTO ledger_journal_batches VALUES (?, ?)').run('other', 'OTHER'))
      .not.toThrow();
  });
});
