import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import type {
  D1Database,
  D1ExecResult,
  D1PreparedStatement,
  D1QueryResult,
  D1Result,
} from '@/lib/auth/adapters/d1-adapter';
import {
  computeStrictWebhookSignature,
  STRICT_WEBHOOK_REPLAY_WINDOW_MS,
  verifyAndGuardWebhook,
} from '@/lib/webhooks/strict-webhook-guard';

function createSqliteD1Adapter(
  sqlite: Database.Database,
  artificialDelayMs: number = 0
): D1Database {
  const maybeDelay = async (): Promise<void> => {
    if (artificialDelayMs > 0) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, artificialDelayMs);
      });
    }
  };

  const makeStatement = (sql: string, boundValues: unknown[] = []): D1PreparedStatement => ({
    bind(...values: unknown[]): D1PreparedStatement {
      return makeStatement(sql, values);
    },
    async first<T = unknown>(): Promise<T | undefined> {
      await maybeDelay();
      const stmt = sqlite.prepare(sql);
      return stmt.get(...boundValues) as T | undefined;
    },
    async all<T = unknown>(): Promise<D1QueryResult<T>> {
      await maybeDelay();
      const stmt = sqlite.prepare(sql);
      const results = stmt.all(...boundValues) as T[];
      return {
        results,
        meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0 },
      };
    },
    async run(): Promise<D1ExecResult> {
      await maybeDelay();
      const stmt = sqlite.prepare(sql);
      const info = stmt.run(...boundValues);
      return {
        success: true,
        meta: {
          last_row_id: Number(info.lastInsertRowid ?? 0),
          rows_written: info.changes,
          changes: info.changes,
          duration: 0,
        },
      };
    },
    async *raw<T = unknown>(): AsyncIterable<T> {
      const stmt = sqlite.prepare(sql).raw(true);
      const rows = stmt.all(...boundValues) as T[];
      for (const row of rows) {
        yield row;
      }
    },
  });

  return {
    prepare(query: string): D1PreparedStatement {
      return makeStatement(query);
    },
    async exec(sql: string): Promise<D1ExecResult> {
      sqlite.exec(sql);
      return {
        success: true,
        meta: { last_row_id: 0, rows_written: 0, changes: 0, duration: 0 },
      };
    },
    async batch(statements: D1PreparedStatement[]): Promise<D1Result[]> {
      const out: D1Result[] = [];
      for (const stmt of statements) {
        const res = await stmt.run();
        out.push({ success: res.success, meta: res.meta, changes: res.meta.changes });
      }
      return out;
    },
    async dump(): Promise<string> {
      return '';
    },
  };
}

describe('Gate G4: Strict Webhook HMAC, 300s Replay Window, Atomic Concurrency & Sequence Watermarks', () => {
  const SECRET = 'whsec_ascendancy_audit_g4_secret_key_2026';
  const FIXED_NOW_MS = 1794691200000;
  const migration028Path = path.resolve(
    process.cwd(),
    'src/database/migrations/028_ascendancy_audit_core.sql'
  );
  const migration001Path = path.resolve(
    process.cwd(),
    'src/database/migrations/001_initial_schema_d1.sql'
  );
  const migration003Path = path.resolve(
    process.cwd(),
    'src/database/migrations/003_affiliate_schema.sql'
  );
  const migration007Path = path.resolve(
    process.cwd(),
    'src/database/migrations/007_webhook_nonces.sql'
  );

  let sqlite: Database.Database;
  let db: D1Database;

  beforeEach(() => {
    sqlite = new Database(':memory:');
    sqlite.pragma('foreign_keys = ON');
    sqlite.exec(fs.readFileSync(migration001Path, 'utf8'));
    sqlite.exec(fs.readFileSync(migration003Path, 'utf8'));
    sqlite.exec(fs.readFileSync(migration028Path, 'utf8'));
    db = createSqliteD1Adapter(sqlite);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('1. HMAC-SHA256 Constant-Time Signature & Payload Integrity', () => {
    it('accepts valid HMAC-SHA256 (hex, base64, Svix v1, and Bybit/OKX canonical) and enforces ENQUEUED_FOR_RECONCILIATION_ONLY', async () => {
      expect(STRICT_WEBHOOK_REPLAY_WINDOW_MS).toBe(300_000);

      const rawBody = JSON.stringify({ uid: '88192011', commission: '12.50', ccy: 'USDT' });
      const tsStr = String(FIXED_NOW_MS);

      // 1. Standard hex signature
      const hexSig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: tsStr,
        eventId: 'evt_hex_1',
        rawBody,
        encoding: 'hex',
      });
      const resHex = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_hex_1',
        timestamp: tsStr,
        signature: hexSig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resHex).toMatchObject({
        verified: true,
        statusCode: 202,
        action: 'ENQUEUED_FOR_RECONCILIATION_ONLY',
        autoPayoutTriggered: false,
        source: 'bybit',
        eventId: 'evt_hex_1',
      });

      // 2. Svix v1,<base64> rotated multi-signature header
      const oldWrongSig = await computeStrictWebhookSignature({
        secret: 'rotated_old_secret',
        timestamp: tsStr,
        eventId: 'evt_svix_1',
        rawBody,
        encoding: 'svix',
      });
      const activeSvixSig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: tsStr,
        eventId: 'evt_svix_1',
        rawBody,
        encoding: 'svix',
      });
      const resSvix = await verifyAndGuardWebhook({
        db,
        source: 'svix',
        eventId: 'evt_svix_1',
        timestamp: tsStr,
        signature: `${oldWrongSig} ${activeSvixSig}`,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resSvix.verified).toBe(true);
      expect(resSvix.autoPayoutTriggered).toBe(false);

      // 3. Exchange-specific canonical string (OKX ISO8601 + base64)
      const isoTs = new Date(FIXED_NOW_MS).toISOString();
      const okxSig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: isoTs,
        eventId: 'evt_okx_1',
        rawBody,
        encoding: 'base64',
        canonicalFormat: 'okx',
        method: 'POST',
        requestPath: '/api/webhooks/exchange/okx',
      });
      const resOkx = await verifyAndGuardWebhook({
        db,
        source: 'okx',
        eventId: 'evt_okx_1',
        timestamp: isoTs,
        signature: okxSig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
        signatureEncoding: 'base64',
        canonicalFormat: 'okx',
        method: 'POST',
        requestPath: '/api/webhooks/exchange/okx',
      });
      expect(resOkx.verified).toBe(true);
      expect(resOkx.autoPayoutTriggered).toBe(false);
    });

    it('rejects 100% of missing signatures, malformed hex/base64, tampered bodies, and wrong secrets', async () => {
      const rawBody = '{"uid":"1001","amount":"25.00"}';
      const tsStr = String(FIXED_NOW_MS);
      const validSig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: tsStr,
        eventId: 'evt_tamper_1',
        rawBody,
      });

      // Missing signature
      const missingSig = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_missing_sig',
        timestamp: tsStr,
        signature: '',
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(missingSig).toMatchObject({
        verified: false,
        statusCode: 401,
        errorCode: 'MISSING_SIGNATURE',
        autoPayoutTriggered: false,
      });

      // Invalid hex/base64 format
      const badFormat = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_bad_fmt',
        timestamp: tsStr,
        signature: 'not-valid-hex-or-base64!!!',
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(badFormat).toMatchObject({
        verified: false,
        statusCode: 401,
        errorCode: 'INVALID_SIGNATURE_FORMAT',
        autoPayoutTriggered: false,
      });

      // Tampered body (single character changed)
      const tamperedBody = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_tamper_1',
        timestamp: tsStr,
        signature: validSig,
        rawBody: '{"uid":"1001","amount":"2500.00"}',
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(tamperedBody).toMatchObject({
        verified: false,
        statusCode: 401,
        errorCode: 'INVALID_SIGNATURE',
        autoPayoutTriggered: false,
      });

      // Wrong secret
      const wrongSecret = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_tamper_1',
        timestamp: tsStr,
        signature: validSig,
        rawBody,
        secret: 'wrong_webhook_secret',
        nowMs: FIXED_NOW_MS,
      });
      expect(wrongSecret).toMatchObject({
        verified: false,
        statusCode: 401,
        errorCode: 'INVALID_SIGNATURE',
        autoPayoutTriggered: false,
      });
    });
  });

  describe('2. Strict 300-Second Replay Window Enforcement', () => {
    it('rejects missing timestamp, NaN timestamp, 301s past drift, and 301s future skew while allowing 299s boundary', async () => {
      const rawBody = '{"event":"rebate.created"}';

      // Missing timestamp
      const resMissingTs = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_ts_missing',
        timestamp: null,
        signature: 'a'.repeat(64),
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resMissingTs).toMatchObject({
        verified: false,
        statusCode: 400,
        errorCode: 'MISSING_TIMESTAMP',
      });

      // NaN / garbage timestamp
      const resNanTs = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_ts_nan',
        timestamp: 'NaN_not_a_number',
        signature: 'a'.repeat(64),
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resNanTs).toMatchObject({
        verified: false,
        statusCode: 400,
        errorCode: 'INVALID_TIMESTAMP',
      });

      // 301s in the past -> REJECTED
      const past301Ts = String(FIXED_NOW_MS - 301_000);
      const past301Sig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: past301Ts,
        eventId: 'evt_past_301',
        rawBody,
      });
      const resPast301 = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_past_301',
        timestamp: past301Ts,
        signature: past301Sig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resPast301).toMatchObject({
        verified: false,
        statusCode: 401,
        errorCode: 'TIMESTAMP_EXPIRED',
        autoPayoutTriggered: false,
      });

      // 301s in the future -> REJECTED
      const future301Ts = String(FIXED_NOW_MS + 301_000);
      const future301Sig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: future301Ts,
        eventId: 'evt_future_301',
        rawBody,
      });
      const resFuture301 = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_future_301',
        timestamp: future301Ts,
        signature: future301Sig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resFuture301).toMatchObject({
        verified: false,
        statusCode: 401,
        errorCode: 'TIMESTAMP_FUTURE_SKEW',
        autoPayoutTriggered: false,
      });

      // 299s past & 299s future -> ACCEPTED
      const past299Ts = String(FIXED_NOW_MS - 299_000);
      const past299Sig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: past299Ts,
        eventId: 'evt_past_299',
        rawBody,
      });
      const resPast299 = await verifyAndGuardWebhook({
        db,
        source: 'bybit',
        eventId: 'evt_past_299',
        timestamp: past299Ts,
        signature: past299Sig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(resPast299.verified).toBe(true);
    });
  });

  describe('3. Sequential & Concurrent Promise.all Replay Protection', () => {
    it('blocks sequential replay of the same event_id with 409 REPLAY_DUPLICATE_EVENT_ID', async () => {
      const rawBody = '{"id":"seq_replay_1","commission":"9.99"}';
      const tsStr = String(FIXED_NOW_MS);
      const sig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: tsStr,
        eventId: 'evt_seq_dup_1',
        rawBody,
      });

      const first = await verifyAndGuardWebhook({
        db,
        source: 'bitget',
        eventId: 'evt_seq_dup_1',
        timestamp: tsStr,
        signature: sig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(first.verified).toBe(true);

      const second = await verifyAndGuardWebhook({
        db,
        source: 'bitget',
        eventId: 'evt_seq_dup_1',
        timestamp: tsStr,
        signature: sig,
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS + 1000,
      });
      expect(second).toMatchObject({
        verified: false,
        statusCode: 409,
        errorCode: 'REPLAY_DUPLICATE_EVENT_ID',
        autoPayoutTriggered: false,
      });

      const countRow = sqlite
        .prepare('SELECT COUNT(*) as cnt FROM webhook_nonces WHERE source = ? AND event_id = ?')
        .get('bitget', 'evt_seq_dup_1') as { cnt: number };
      expect(countRow.cnt).toBe(1);
    });

    it('guarantees exactly 1 accepted and 0 duplicate records under 25 concurrent Promise.all arrivals', async () => {
      const slowSqlite = new Database(':memory:');
      slowSqlite.pragma('foreign_keys = ON');
      slowSqlite.exec(fs.readFileSync(migration007Path, 'utf8'));
      const slowDb = createSqliteD1Adapter(slowSqlite, 5);

      try {
        const rawBody = '{"id":"parallel_storm_1","commission":"100.00"}';
        const tsStr = String(FIXED_NOW_MS);
        const sig = await computeStrictWebhookSignature({
          secret: SECRET,
          timestamp: tsStr,
          eventId: 'evt_parallel_storm_1',
          rawBody,
        });

        const concurrency = 25;
        const outcomes = await Promise.all(
          Array.from({ length: concurrency }, () =>
            verifyAndGuardWebhook({
              db: slowDb,
              source: 'okx',
              eventId: 'evt_parallel_storm_1',
              timestamp: tsStr,
              signature: sig,
              rawBody,
              secret: SECRET,
              nowMs: FIXED_NOW_MS,
            })
          )
        );

        const accepted = outcomes.filter((o) => o.verified);
        const rejected = outcomes.filter((o) => !o.verified);

        expect(accepted).toHaveLength(1);
        expect(rejected).toHaveLength(concurrency - 1);
        expect(accepted[0].autoPayoutTriggered).toBe(false);
        expect(accepted[0].action).toBe('ENQUEUED_FOR_RECONCILIATION_ONLY');

        for (const r of rejected) {
          if (!r.verified) {
            expect(r.statusCode).toBe(409);
            expect(['REPLAY_CONCURRENT_INFLIGHT', 'REPLAY_DUPLICATE_EVENT_ID']).toContain(
              r.errorCode
            );
            expect(r.autoPayoutTriggered).toBe(false);
          }
        }

        const countRow = slowSqlite
          .prepare('SELECT COUNT(*) as cnt FROM webhook_nonces WHERE source = ? AND event_id = ?')
          .get('okx', 'evt_parallel_storm_1') as { cnt: number };
        expect(countRow.cnt).toBe(1);
      } finally {
        slowSqlite.close();
      }
    });
  });

  describe('4. Out-of-Order Sequence Watermark Protection', () => {
    it('accepts strictly increasing sequences per entity and rejects out-of-order stale state events', async () => {
      const tsStr = String(FIXED_NOW_MS);

      const sendSeq = async (eventId: string, sequence: number) => {
        const rawBody = JSON.stringify({ traderUid: 'u_999', sequence });
        const sig = await computeStrictWebhookSignature({
          secret: SECRET,
          timestamp: tsStr,
          eventId,
          rawBody,
        });
        return verifyAndGuardWebhook({
          db,
          source: 'bybit',
          eventId,
          timestamp: tsStr,
          signature: sig,
          rawBody,
          secret: SECRET,
          nowMs: FIXED_NOW_MS,
          entityKey: 'trader:u_999',
          sequence,
        });
      };

      const seq10 = await sendSeq('evt_seq_10', 10);
      expect(seq10.verified).toBe(true);

      const seq15 = await sendSeq('evt_seq_15', 15);
      expect(seq15.verified).toBe(true);

      // Stale out-of-order arrival (sequence 12 < watermark 15) -> REJECTED
      const stale12 = await sendSeq('evt_seq_12', 12);
      expect(stale12).toMatchObject({
        verified: false,
        statusCode: 409,
        errorCode: 'OUT_OF_ORDER_SEQUENCE',
        autoPayoutTriggered: false,
      });

      // Equal sequence arrival (sequence 15 === watermark 15) -> REJECTED
      const equal15 = await sendSeq('evt_seq_15_dup_num', 15);
      expect(equal15).toMatchObject({
        verified: false,
        statusCode: 409,
        errorCode: 'OUT_OF_ORDER_SEQUENCE',
        autoPayoutTriggered: false,
      });

      // Newer sequence 16 -> ACCEPTED
      const seq16 = await sendSeq('evt_seq_16', 16);
      expect(seq16.verified).toBe(true);

      const wmRow = sqlite
        .prepare(
          'SELECT last_sequence FROM webhook_sequence_watermarks WHERE source = ? AND entity_key = ?'
        )
        .get('bybit', 'trader:u_999') as { last_sequence: number };
      expect(wmRow.last_sequence).toBe(16);
    });

    it('blocks exchange canonicalFormat replay even when attacker rotates eventId under the same valid signature', async () => {
      const tsStr = String(FIXED_NOW_MS);
      const rawBody = JSON.stringify({ instId: 'BTC-USDT', ordId: '9911' });
      const sig = await computeStrictWebhookSignature({
        secret: SECRET,
        timestamp: tsStr,
        eventId: 'okx_evt_orig',
        rawBody,
        canonicalFormat: 'okx',
        encoding: 'base64',
        method: 'POST',
        requestPath: '/api/webhooks/exchange/okx',
      });

      const first = await verifyAndGuardWebhook({
        db,
        source: 'okx',
        eventId: 'okx_evt_orig',
        timestamp: tsStr,
        signature: sig,
        signatureEncoding: 'base64',
        canonicalFormat: 'okx',
        method: 'POST',
        requestPath: '/api/webhooks/exchange/okx',
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(first.verified).toBe(true);

      const rotatedEventIdReplay = await verifyAndGuardWebhook({
        db,
        source: 'okx',
        eventId: 'okx_evt_forged_new_id',
        timestamp: tsStr,
        signature: sig,
        signatureEncoding: 'base64',
        canonicalFormat: 'okx',
        method: 'POST',
        requestPath: '/api/webhooks/exchange/okx',
        rawBody,
        secret: SECRET,
        nowMs: FIXED_NOW_MS,
      });
      expect(rotatedEventIdReplay).toMatchObject({
        verified: false,
        statusCode: 409,
        errorCode: 'REPLAY_DUPLICATE_EVENT_ID',
        autoPayoutTriggered: false,
      });
    });
  });
});
