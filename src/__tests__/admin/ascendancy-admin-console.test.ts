/**
 * @jest-environment node
 *
 * Ascendancy Admin Console Verification Suite:
 * 1. Zero-dependency browser WebAuthn helper (`webauthn-browser.ts`) Base64URL <-> ArrayBuffer
 *    round-trips, `PublicKeyCredentialCreationOptions` / `PublicKeyCredentialRequestOptions`
 *    mapping (`ES256` alg `-7`), and simulated `navigator.credentials.create` + `.get`
 *    cryptographically verified against `@simplewebauthn/server` (`finishPasskeyRegistration`
 *    & `finishPasskeyStepUp`).
 * 2. `/api/admin/runtime-flags` `GET` and `POST`:
 *    - `401` unauthenticated, `403` non-admin
 *    - `403 PASSKEY_STEP_UP_REQUIRED` when missing `x-passkey-stepup-token`
 *    - `400 REASON_REQUIRED` when audit reason < 5 characters
 *    - `200` on all 5 allowed flags (`EMERGENCY_LEDGER_FREEZE`, `EMERGENCY_PAUSE`,
 *      `BLOCK_VN_SIGNUPS`, `PARTNER_KUCOIN_LIVE`, `PARTNER_GATEIO_LIVE`)
 *    - `GET` returns `flags`, `recentReconciliations` (with R2 `payload_sha256`),
 *      `recentShadowReconciliations`, and `recentBroadcasts`.
 * 3. `/api/admin/passkey` `set_runtime_flag` supports `PARTNER_KUCOIN_LIVE` & `PARTNER_GATEIO_LIVE`.
 */

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => null),
    },
  })),
}));

import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { NextRequest } from 'next/server';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import * as dbModule from '@/lib/db';
import {
  PASSKEY_STEPUP_HEADER,
  beginPasskeyRegistration,
  beginPasskeyStepUp,
  finishPasskeyRegistration,
  finishPasskeyStepUp,
  issuePasskeyStepUpToken,
  resetEndpointRateLimits,
} from '@/lib/auth/passkey-step-up';
import {
  arrayBufferToBase64Url,
  base64UrlToUint8Array,
  createBrowserPasskeyCredential,
  enrollAdminPasskey,
  getBrowserPasskeyAssertion,
  obtainAdminStepUpToken,
  toPublicKeyCreationOptions,
  toPublicKeyRequestOptions,
} from '@/lib/auth/webauthn-browser';
import {
  GET as runtimeFlagsGet,
  POST as runtimeFlagsPost,
} from '@/app/api/admin/runtime-flags/route';
import { ALLOWED_ASCENDANCY_RUNTIME_FLAGS } from '@/app/api/admin/runtime-flags/constants';
import { POST as adminPasskeyPost } from '@/app/api/admin/passkey/route';
import { POST as pollerAdminPost } from '@/app/api/admin/reconciliation/poller/route';
import {
  parseUtcTimestampMs,
  validateShadowPromotionGate,
} from '@/lib/partners';

interface InternalStatement extends D1PreparedStatement {
  _runSync: () => D1Result<unknown>;
}

function createSqliteD1(sqlite: Database.Database): D1Database {
  return {
    prepare(sql: string): D1PreparedStatement {
      let params: unknown[] = [];
      const stmt = sqlite.prepare(sql);

      const wrapped: InternalStatement = {
        bind(...values: unknown[]) {
          params = values;
          return wrapped;
        },
        _runSync(): D1Result<unknown> {
          const info = stmt.run(...params);
          return {
            results: [],
            success: true,
            meta: {
              duration: 0,
              changes: info.changes,
              last_row_id: Number(info.lastInsertRowid),
              served_by: 'sqlite-admin-console-test',
            },
          };
        },
        async first<T = unknown>(colName?: string): Promise<T | null> {
          const row = stmt.get(...params) as Record<string, unknown> | undefined;
          if (!row) return null;
          if (colName) return (row[colName] as T) ?? null;
          return row as T;
        },
        async run<T = unknown>(): Promise<D1Result<T>> {
          return wrapped._runSync() as D1Result<T>;
        },
        async all<T = unknown>(): Promise<D1Result<T>> {
          const rows = stmt.all(...params) as T[];
          return {
            results: rows,
            success: true,
            meta: {
              duration: 0,
              changes: 0,
              last_row_id: 0,
              served_by: 'sqlite-admin-console-test',
            },
          };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return stmt.raw().all(...params) as T[];
        },
      };

      return wrapped;
    },
    async batch<T = unknown>(
      statements: D1PreparedStatement[]
    ): Promise<D1Result<T>[]> {
      const tx = sqlite.transaction(() =>
        statements.map((s) => (s as InternalStatement)._runSync() as D1Result<T>)
      );
      return tx();
    },
    async exec(sql: string): Promise<{ count: number; duration: number }> {
      sqlite.exec(sql);
      return { count: 1, duration: 0 };
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async close(): Promise<void> {
      sqlite.close();
    },
  };
}

function buildCosePublicKeyFromEcJwk(jwk: crypto.JsonWebKey): Buffer {
  const x = Buffer.from(jwk.x ?? '', 'base64url');
  const y = Buffer.from(jwk.y ?? '', 'base64url');
  return Buffer.concat([
    Buffer.from([0xa5, 0x01, 0x02, 0x03, 0x26, 0x20, 0x01, 0x21, 0x58, 0x20]),
    x,
    Buffer.from([0x22, 0x58, 0x20]),
    y,
  ]);
}

function toExactArrayBuffer(buf: Buffer): ArrayBuffer {
  const ab = new ArrayBuffer(buf.byteLength);
  new Uint8Array(ab).set(buf);
  return ab;
}

function buildRawAttestationCredential(params: {
  rpID: string;
  origin: string;
  challengeBytes: Uint8Array;
  credIdBytes: Buffer;
  cosePublicKey: Buffer;
}): PublicKeyCredential {
  const rpIdHash = crypto.createHash('sha256').update(params.rpID).digest();
  const flags = Buffer.from([0x45]); // UP=1 | UV=1 | AT=1
  const counter = Buffer.alloc(4, 0);
  const aaguid = Buffer.alloc(16, 0);
  const credLen = Buffer.alloc(2);
  credLen.writeUInt16BE(params.credIdBytes.length, 0);

  const authData = Buffer.concat([
    rpIdHash,
    flags,
    counter,
    aaguid,
    credLen,
    params.credIdBytes,
    params.cosePublicKey,
  ]);

  const lenHeader =
    authData.length < 256
      ? Buffer.from([0x58, authData.length])
      : Buffer.from([
          0x59,
          (authData.length >> 8) & 0xff,
          authData.length & 0xff,
        ]);

  const attestationObject = Buffer.concat([
    Buffer.from([0xa3]),
    Buffer.from([0x63]),
    Buffer.from('fmt'),
    Buffer.from([0x64]),
    Buffer.from('none'),
    Buffer.from([0x67]),
    Buffer.from('attStmt'),
    Buffer.from([0xa0]),
    Buffer.from([0x68]),
    Buffer.from('authData'),
    lenHeader,
    authData,
  ]);

  const challengeB64 = Buffer.from(params.challengeBytes).toString('base64url');
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: challengeB64,
      origin: params.origin,
      crossOrigin: false,
    })
  );

  const credIdB64 = params.credIdBytes.toString('base64url');
  return {
    id: credIdB64,
    rawId: toExactArrayBuffer(params.credIdBytes),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: toExactArrayBuffer(clientDataJSON),
      attestationObject: toExactArrayBuffer(attestationObject),
      getTransports: () => ['internal'],
      getAuthenticatorData: () => toExactArrayBuffer(authData),
      getPublicKey: () => null,
      getPublicKeyAlgorithm: () => -7,
    } as unknown as AuthenticatorAttestationResponse,
    toJSON: () => ({}),
  } as unknown as PublicKeyCredential;
}

function buildRawAssertionCredential(params: {
  rpID: string;
  origin: string;
  challengeBytes: Uint8Array;
  credIdBytes: Buffer;
  privateKey: crypto.KeyObject;
  signCounter: number;
}): PublicKeyCredential {
  const rpIdHash = crypto.createHash('sha256').update(params.rpID).digest();
  const flags = Buffer.from([0x05]); // UP=1 | UV=1
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(params.signCounter, 0);
  const authenticatorData = Buffer.concat([rpIdHash, flags, counterBuf]);

  const challengeB64 = Buffer.from(params.challengeBytes).toString('base64url');
  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: challengeB64,
      origin: params.origin,
      crossOrigin: false,
    })
  );

  const clientDataHash = crypto
    .createHash('sha256')
    .update(clientDataJSON)
    .digest();
  const signature = crypto.sign(
    'sha256',
    Buffer.concat([authenticatorData, clientDataHash]),
    params.privateKey
  );

  const credIdB64 = params.credIdBytes.toString('base64url');
  return {
    id: credIdB64,
    rawId: toExactArrayBuffer(params.credIdBytes),
    type: 'public-key',
    authenticatorAttachment: 'platform',
    getClientExtensionResults: () => ({}),
    response: {
      clientDataJSON: toExactArrayBuffer(clientDataJSON),
      authenticatorData: toExactArrayBuffer(authenticatorData),
      signature: toExactArrayBuffer(signature),
      userHandle: null,
    } as unknown as AuthenticatorAssertionResponse,
    toJSON: () => ({}),
  } as unknown as PublicKeyCredential;
}

function initializeAdminConsoleDb(sqlite: Database.Database): void {
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'affiliate',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      token TEXT UNIQUE NOT NULL,
      expires_at TEXT NOT NULL
    );

    CREATE TABLE deals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      url TEXT NOT NULL
    );
  `);

  const migration028Path = path.join(
    process.cwd(),
    'src/database/migrations/028_ascendancy_audit_core.sql'
  );
  const migration031Path = path.join(
    process.cwd(),
    'src/database/migrations/031_ascendancy_phase2_ui_and_poller.sql'
  );

  sqlite.exec(fs.readFileSync(migration028Path, 'utf8'));
  sqlite.exec(fs.readFileSync(migration031Path, 'utf8'));

  sqlite
    .prepare(
      `INSERT INTO profiles (id, email, full_name, role) VALUES
       ('admin_root', 'admin@apexrebate.com', 'Root Admin', 'admin'),
       ('user_trader', 'trader@apexrebate.com', 'Normal Trader', 'affiliate')`
    )
    .run();

  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at) VALUES
       ('sess_admin', 'admin_root', 'tok_admin_console_valid', '2099-01-01T00:00:00Z'),
       ('sess_trader', 'user_trader', 'tok_trader_console_valid', '2099-01-01T00:00:00Z')`
    )
    .run();
}

describe('Ascendancy Admin Console — WebAuthn Browser Bridge & Runtime Flags API', () => {
  let sqlite: Database.Database;
  let db: D1Database;
  const originalNavigator = globalThis.navigator;
  const originalFetch = globalThis.fetch;
  const STEP_UP_SECRET = 'test_step_up_hmac_secret_32bytes_min_ascendancy';

  beforeEach(() => {
    resetEndpointRateLimits();
    sqlite = new Database(':memory:');
    initializeAdminConsoleDb(sqlite);
    db = createSqliteD1(sqlite);
    (globalThis as unknown as { DB?: D1Database }).DB = db;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(db);

    process.env.WEBAUTHN_RP_ID = 'localhost';
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000';
    process.env.PASSKEY_STEPUP_HMAC_SECRET = STEP_UP_SECRET;
  });

  afterEach(() => {
    sqlite.close();
    delete (globalThis as unknown as { DB?: D1Database }).DB;
    jest.restoreAllMocks();
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true,
      writable: true,
    });
    globalThis.fetch = originalFetch;
  });

  it('round-trips Base64URL <-> Uint8Array and verifies simulated navigator.credentials ES256 ceremony against @simplewebauthn/server', async () => {
    // 1. Deterministic Base64URL <-> ArrayBuffer round-trip (including 0xff, 0xfe, 0x3e, 0x3f bytes)
    const sampleBytes = crypto.randomBytes(47);
    const encoded = arrayBufferToBase64Url(sampleBytes);
    expect(encoded).not.toMatch(/[+/=]/);
    const decoded = base64UrlToUint8Array(encoded);
    expect(Buffer.from(decoded).equals(sampleBytes)).toBe(true);
    expect(base64UrlToUint8Array('').byteLength).toBe(0);
    expect(arrayBufferToBase64Url(new ArrayBuffer(0))).toBe('');

    // 2. Generate real P-256 (ES256) keypair and mock navigator.credentials
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const cosePublicKey = buildCosePublicKeyFromEcJwk(
      publicKey.export({ format: 'jwk' })
    );
    const credIdBytes = crypto.randomBytes(32);

    const createMock = jest.fn(
      async (opts?: CredentialCreationOptions): Promise<Credential | null> => {
        const pk = opts?.publicKey;
        expect(pk).toBeDefined();
        expect(pk?.pubKeyCredParams.some((p) => p.alg === -7)).toBe(true);
        const challengeBytes = new Uint8Array(pk!.challenge as ArrayBuffer);
        return buildRawAttestationCredential({
          rpID: 'localhost',
          origin: 'http://localhost:3000',
          challengeBytes,
          credIdBytes,
          cosePublicKey,
        });
      }
    );

    let signCounter = 1;
    const getMock = jest.fn(
      async (opts?: CredentialRequestOptions): Promise<Credential | null> => {
        const pk = opts?.publicKey;
        expect(pk).toBeDefined();
        expect(pk?.allowCredentials?.length).toBeGreaterThan(0);
        const challengeBytes = new Uint8Array(pk!.challenge as ArrayBuffer);
        const currentCounter = signCounter;
        signCounter += 1;
        return buildRawAssertionCredential({
          rpID: 'localhost',
          origin: 'http://localhost:3000',
          challengeBytes,
          credIdBytes,
          privateKey,
          signCounter: currentCounter,
        });
      }
    );

    Object.defineProperty(globalThis, 'navigator', {
      value: {
        credentials: {
          create: createMock,
          get: getMock,
        },
      },
      configurable: true,
      writable: true,
    });

    // 3. Direct startPasskeyRegistration -> createBrowserPasskeyCredential -> finishPasskeyRegistration
    const regStart = await beginPasskeyRegistration(db, {
      userId: 'admin_root',
      userEmail: 'admin@apexrebate.com',
      rpID: 'localhost',
    });
    const mappedCreateOpts = toPublicKeyCreationOptions(regStart.options);
    expect(mappedCreateOpts.user.id).toBeInstanceOf(Uint8Array);
    expect(mappedCreateOpts.challenge).toBeInstanceOf(Uint8Array);

    const browserAttestation = await createBrowserPasskeyCredential(
      regStart.options
    );
    const regFinish = await finishPasskeyRegistration(db, {
      userId: 'admin_root',
      challengeId: regStart.challengeId,
      deviceName: 'YubiKey 5C ES256',
      response: browserAttestation,
      rpID: 'localhost',
      origin: 'http://localhost:3000',
    });
    expect(regFinish.verified).toBe(true);
    expect(regFinish.credentialId).toBe(credIdBytes.toString('base64url'));

    // 4. Direct startPasskeyStepUp -> getBrowserPasskeyAssertion -> finishPasskeyStepUp
    const stepStart = await beginPasskeyStepUp(db, {
      userId: 'admin_root',
      purpose: 'admin_step_up',
      rpID: 'localhost',
    });
    expect(stepStart.ok).toBe(true);
    if (!stepStart.ok) {
      throw new Error('Expected stepStart.ok === true');
    }

    const mappedReqOpts = toPublicKeyRequestOptions(stepStart.options);
    expect(mappedReqOpts.challenge).toBeInstanceOf(Uint8Array);
    expect(mappedReqOpts.allowCredentials?.[0]?.id).toBeInstanceOf(Uint8Array);

    const browserAssertion = await getBrowserPasskeyAssertion(stepStart.options);
    const stepFinish = await finishPasskeyStepUp(db, {
      userId: 'admin_root',
      challengeId: stepStart.challengeId,
      purpose: 'admin_step_up',
      response: browserAssertion,
      rpID: 'localhost',
      origin: 'http://localhost:3000',
    });
    expect(stepFinish.verified).toBe(true);
    expect(stepFinish.stepUpToken).toBeDefined();

    // 5. High-level fetch bridge (`enrollAdminPasskey` + `obtainAdminStepUpToken`) wired to `/api/admin/passkey`
    const credIdBytes2 = crypto.randomBytes(32);
    createMock.mockImplementationOnce(async (opts?: CredentialCreationOptions) => {
      const challengeBytes = new Uint8Array(
        opts!.publicKey!.challenge as ArrayBuffer
      );
      return buildRawAttestationCredential({
        rpID: 'localhost',
        origin: 'http://localhost:3000',
        challengeBytes,
        credIdBytes: credIdBytes2,
        cosePublicKey,
      });
    });

    globalThis.fetch = jest.fn(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const urlStr = typeof input === 'string' ? input : input.toString();
        const nextReq = new NextRequest(`http://localhost:3000${urlStr}`, {
          method: init?.method ?? 'GET',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            'cf-connecting-ip': '203.0.113.44',
          },
          body: init?.body as BodyInit | null | undefined,
        });
        return adminPasskeyPost(nextReq);
      }
    );

    const enrolledViaApi = await enrollAdminPasskey('MacBook Touch ID');
    expect(enrolledViaApi.credentialId).toBe(credIdBytes2.toString('base64url'));

    const stepUpViaApi = await obtainAdminStepUpToken();
    expect(stepUpViaApi.stepUpToken.split('.').length).toBe(2);
    expect(Date.parse(stepUpViaApi.expiresAt)).toBeGreaterThan(Date.now());
  });

  it('enforces auth + Passkey step-up + reason >= 5 chars on /api/admin/runtime-flags and returns reconciliation + broadcast telemetry', async () => {
    // Seed R2 evidence, live reconciliation, shadow reconciliation, and settlement broadcast rows
    sqlite
      .prepare(
        `INSERT INTO r2_evidence_objects (
           id, exchange, source_kind, r2_object_key, payload_sha256, byte_length,
           statement_period_start, statement_period_end, retention_until
         ) VALUES
           ('ev_live_1', 'bybit', 'csv_statement', 'bybit/2026-11/stmt.json', 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2', 512,
            '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z', '2031-11-15T00:00:00Z'),
           ('ev_shadow_1', 'kucoin', 'csv_statement', 'kucoin/2026-11/shadow.json', 'f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5d4c3b2a1f6e5', 768,
            '2026-11-01T00:00:00Z', '2026-11-15T00:00:00Z', '2031-11-15T00:00:00Z')`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO partner_cash_reconciliations (
           id, exchange, evidence_id, uid_allocated_units, wallet_cash_collected_units,
           clawback_offset_units, minted_gross_units, discrepancy_units, status
         ) VALUES (
           'rec_bybit_01', 'bybit', 'ev_live_1', 2500000000, 2500000000, 0, 2500000000, 0, 'MATCHED'
         )`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO partner_shadow_reconciliations (
           id, exchange, evidence_id, row_count, mapped_uid_count, unmapped_uid_count,
           simulated_gross_units, wallet_cash_collected_units, discrepancy_units, status, notes
         ) VALUES (
           'sh_kucoin_01', 'kucoin', 'ev_shadow_1', 12, 11, 1, 1800000000, 1800000000, 0, 'SHADOW_LOGGED', 'Day 14 shadow check'
         )`
      )
      .run();

    sqlite
      .prepare(
        `INSERT INTO settlement_broadcasts (
           payout_id, idempotency_key, affiliate_id, chain, recipient_address,
           amount_units_1e8, chain_token_units, chain_decimals, state, safe_multisig_tx_hash
         ) VALUES (
           'pay_safe_01', 'idem_safe_01', 'user_trader', 'arbitrum',
           '0x1234567890abcdef1234567890abcdef12345678',
           30000000000, '300000000', 6, 'QUEUED_COLD_SAFE', '0xsafeprop001'
         )`
      )
      .run();

    // 1. Unauthenticated GET -> 401
    const unauthGet = await runtimeFlagsGet(
      new NextRequest('http://localhost:3000/api/admin/runtime-flags')
    );
    expect(unauthGet.status).toBe(401);

    // 2. Non-admin GET -> 403
    const nonAdminGet = await runtimeFlagsGet(
      new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
        headers: { Authorization: 'Bearer tok_trader_console_valid' },
      })
    );
    expect(nonAdminGet.status).toBe(403);

    // 3. Admin GET -> 200 with flags + live + shadow + broadcasts
    const adminGet = await runtimeFlagsGet(
      new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
        headers: { Authorization: 'Bearer tok_admin_console_valid' },
      })
    );
    expect(adminGet.status).toBe(200);
    const getBody = (await adminGet.json()) as {
      success: boolean;
      flags: Array<{ flag_key: string; flag_value: string }>;
      recentReconciliations: Array<{ id: string; payload_sha256: string }>;
      recentShadowReconciliations: Array<{ id: string; payload_sha256: string }>;
      recentBroadcasts: Array<{ payout_id: string; state: string }>;
    };
    expect(getBody.success).toBe(true);
    expect(getBody.flags.map((f) => f.flag_key)).toEqual(
      expect.arrayContaining([...ALLOWED_ASCENDANCY_RUNTIME_FLAGS])
    );
    expect(getBody.recentReconciliations[0]?.id).toBe('rec_bybit_01');
    expect(getBody.recentReconciliations[0]?.payload_sha256).toBe(
      'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2'
    );
    expect(getBody.recentShadowReconciliations[0]?.id).toBe('sh_kucoin_01');
    expect(getBody.recentBroadcasts[0]?.payout_id).toBe('pay_safe_01');

    // 4. POST without x-passkey-stepup-token -> 403 PASSKEY_STEP_UP_REQUIRED
    const missingStepUpPost = await runtimeFlagsPost(
      new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_console_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          flagKey: 'PARTNER_KUCOIN_LIVE',
          flagValue: 'true',
          reason: 'Promote KuCoin after 30-day shadow audit',
        }),
      })
    );
    expect(missingStepUpPost.status).toBe(403);
    const missingBody = (await missingStepUpPost.json()) as { code: string };
    expect(missingBody.code).toBe('PASSKEY_STEP_UP_REQUIRED');

    // Seed a consumed WebAuthn challenge + issue a matching Passkey step-up token for admin_root
    sqlite
      .prepare(
        `INSERT INTO webauthn_challenges (
           challenge_id, user_id, challenge, purpose, expires_at, consumed
         ) VALUES (
           'wac_test_runtime_flags', 'admin_root', 'seeded_challenge', 'admin_step_up',
           '2099-01-01T00:00:00Z', 1
         )`
      )
      .run();

    const stepUpToken = issuePasskeyStepUpToken({
      userId: 'admin_root',
      purpose: 'admin_step_up',
      challengeId: 'wac_test_runtime_flags',
    });

    // 5. POST with short reason (< 5 chars) -> 400 REASON_REQUIRED
    const shortReasonPost = await runtimeFlagsPost(
      new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_console_valid',
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
        },
        body: JSON.stringify({
          flagKey: 'PARTNER_KUCOIN_LIVE',
          flagValue: 'true',
          reason: 'ok',
        }),
      })
    );
    expect(shortReasonPost.status).toBe(400);
    const shortReasonBody = (await shortReasonPost.json()) as { code: string };
    expect(shortReasonBody.code).toBe('REASON_REQUIRED');

    // 6. POST with unsupported flag -> 400 INVALID_RUNTIME_FLAG
    const invalidFlagPost = await runtimeFlagsPost(
      new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_console_valid',
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
        },
        body: JSON.stringify({
          flagKey: 'ARBITRARY_UNSAFE_FLAG',
          flagValue: 'true',
          reason: 'Attempted unauthorized flag injection',
        }),
      })
    );
    expect(invalidFlagPost.status).toBe(400);

    // 7. POST valid updates across the three non-promotion runtime flags -> 200.
    //    The two partner promotion flags are gated by the mandatory 30-day
    //    shadow window and are exercised in steps 8-10 instead.
    const promotionFlags = ['PARTNER_KUCOIN_LIVE', 'PARTNER_GATEIO_LIVE'] as const;
    const nonPromotionFlags = ALLOWED_ASCENDANCY_RUNTIME_FLAGS.filter(
      (flagKey) => !(promotionFlags as readonly string[]).includes(flagKey)
    );
    for (const flagKey of nonPromotionFlags) {
      const okRes = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey,
            flagValue: 'true',
            reason: `Passkey-verified audit toggle for ${flagKey}`,
          }),
        })
      );
      expect(okRes.status).toBe(200);
      const okJson = (await okRes.json()) as {
        success: boolean;
        flagKey: string;
        flagValue: string;
        updatedBy: string;
      };
      expect(okJson.success).toBe(true);
      expect(okJson.flagKey).toBe(flagKey);
      expect(okJson.flagValue).toBe('true');
      expect(okJson.updatedBy).toBe('admin_root');
    }

    // 8. Promotion without shadow history must be refused on BOTH mutation
    //    routes. The kucoin shadow row seeded for the GET telemetry has only just
    //    been created, so it cannot stand in for a completed window; clear the
    //    promotion exchanges so the gate reports the missing-history case
    //    exactly rather than a short-window one.
    sqlite
      .prepare(
        `DELETE FROM partner_shadow_reconciliations
         WHERE exchange IN ('kucoin', 'gateio')`
      )
      .run();

    for (const promoFlag of promotionFlags) {
      const viaRuntimeFlags = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey: promoFlag,
            flagValue: 'true',
            reason: 'Attempt promotion before the shadow window completes',
          }),
        })
      );
      expect(viaRuntimeFlags.status).toBe(422);
      expect(((await viaRuntimeFlags.json()) as { code: string }).code).toBe(
        'SHADOW_HISTORY_MISSING'
      );

      const viaPasskey = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'cf-connecting-ip': '203.0.113.55',
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: promoFlag,
            flagValue: 'true',
            reason: 'Attempt promotion before the shadow window completes',
          }),
        })
      );
      expect(viaPasskey.status).toBe(422);
      expect(((await viaPasskey.json()) as { code: string }).code).toBe(
        'SHADOW_HISTORY_MISSING'
      );
    }

    // 9. Demotion to shadow mode only reduces exposure, so it must succeed on
    //    both routes even with no history at all.
    for (const promoFlag of promotionFlags) {
      const demoteViaRuntimeFlags = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey: promoFlag,
            flagValue: 'false',
            reason: 'Revert to shadow mode after verification test',
          }),
        })
      );
      expect(demoteViaRuntimeFlags.status).toBe(200);

      const demoteViaPasskey = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'cf-connecting-ip': '203.0.113.55',
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: promoFlag,
            flagValue: 'false',
            reason: 'Revert to shadow mode after verification test',
          }),
        })
      );
      expect(demoteViaPasskey.status).toBe(200);
    }

    // 10. Seed a completed, discrepancy-free 31-day shadow window for both
    //     promotion exchanges and assert promotion now succeeds on both routes.
    const shadowWindowStart = new Date(
      Date.now() - 31 * 24 * 60 * 60 * 1000
    ).toISOString();

    sqlite
      .prepare(
        `INSERT INTO r2_evidence_objects (
           id, exchange, source_kind, r2_object_key, payload_sha256, byte_length,
           statement_period_start, statement_period_end, retention_until
         ) VALUES (?, ?, 'csv_statement', ?, ?, 1024, ?, ?, '2031-11-15T00:00:00Z')`
      )
      .run(
        'ev_shadow_kucoin_window',
        'kucoin',
        'kucoin/2026-10/promoted-window.json',
        'c'.repeat(64),
        shadowWindowStart,
        shadowWindowStart
      );
    sqlite
      .prepare(
        `INSERT INTO r2_evidence_objects (
           id, exchange, source_kind, r2_object_key, payload_sha256, byte_length,
           statement_period_start, statement_period_end, retention_until
         ) VALUES (?, ?, 'csv_statement', ?, ?, 1024, ?, ?, '2031-11-15T00:00:00Z')`
      )
      .run(
        'ev_shadow_gateio_window',
        'gateio',
        'gateio/2026-10/promoted-window.json',
        'd'.repeat(64),
        shadowWindowStart,
        shadowWindowStart
      );

    sqlite
      .prepare(
        `INSERT INTO partner_shadow_reconciliations (
           id, exchange, evidence_id, row_count, mapped_uid_count, unmapped_uid_count,
           simulated_gross_units, wallet_cash_collected_units, discrepancy_units,
           status, notes, created_at
         ) VALUES
           ('sh_kucoin_promoted', 'kucoin', 'ev_shadow_kucoin_window', 30, 30, 0,
            5400000000, 5400000000, 0, 'PROMOTED_READY', '31-day clean window', ?),
           ('sh_gateio_promoted', 'gateio', 'ev_shadow_gateio_window', 30, 30, 0,
            5400000000, 5400000000, 0, 'PROMOTED_READY', '31-day clean window', ?)`
      )
      .run(shadowWindowStart, shadowWindowStart);

    for (const promoFlag of promotionFlags) {
      const promoteViaRuntimeFlags = await runtimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey: promoFlag,
            flagValue: 'true',
            reason: 'Promote after the 31-day shadow window completed cleanly',
          }),
        })
      );
      expect(promoteViaRuntimeFlags.status).toBe(200);

      const promoteViaPasskey = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
            'cf-connecting-ip': '203.0.113.55',
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: promoFlag,
            flagValue: 'true',
            reason: 'Promote after the 31-day shadow window completed cleanly',
          }),
        })
      );
      expect(promoteViaPasskey.status).toBe(200);

      const persisted = sqlite
        .prepare('SELECT flag_value FROM system_runtime_flags WHERE flag_key = ?')
        .get(promoFlag) as { flag_value: string } | undefined;
      expect(persisted?.flag_value).toBe('true');
    }
  });

  it('parses bare SQLite UTC timestamps strictly as UTC and orders mixed ISO + SQLite shadow history monotonically', async () => {
    expect(parseUtcTimestampMs('2026-10-01 12:30:45')).toBe(
      Date.parse('2026-10-01T12:30:45Z')
    );
    expect(parseUtcTimestampMs('2026-10-01 12:30:45.250')).toBe(
      Date.parse('2026-10-01T12:30:45.250Z')
    );

    sqlite
      .prepare(
        `INSERT INTO r2_evidence_objects (
           id, exchange, source_kind, r2_object_key, payload_sha256, byte_length,
           statement_period_start, statement_period_end, retention_until
         ) VALUES
           ('ev_utc_kucoin', 'kucoin', 'rest_poll', 'kucoin/2026-10/utc.json', ?, 512,
            '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', '2031-10-01T00:00:00Z'),
           ('ev_utc_gateio_1', 'gateio', 'rest_poll', 'gateio/2026-10/utc-1.json', ?, 512,
            '2026-10-01T00:00:00Z', '2026-10-01T01:00:00Z', '2031-10-01T00:00:00Z'),
           ('ev_utc_gateio_2', 'gateio', 'rest_poll', 'gateio/2026-10/utc-2.json', ?, 512,
            '2026-10-01T01:00:00Z', '2026-10-01T02:00:00Z', '2031-10-01T00:00:00Z')`
      )
      .run('a'.repeat(64), 'b'.repeat(64), 'e'.repeat(64));

    sqlite
      .prepare(
        `INSERT INTO partner_shadow_reconciliations (
           id, exchange, evidence_id, row_count, mapped_uid_count, unmapped_uid_count,
           simulated_gross_units, wallet_cash_collected_units, discrepancy_units,
           status, notes, created_at
         ) VALUES (
           'sh_utc_kucoin_bare', 'kucoin', 'ev_utc_kucoin', 5, 5, 0,
           1000000000, 1000000000, 0, 'PROMOTED_READY', 'Bare SQLite UTC timestamp',
           '2026-10-01 00:00:00'
         )`
      )
      .run();

    const exact30DaysUtcMs = Date.parse('2026-10-31T00:00:00.000Z');
    const oneSecondEarly = await validateShadowPromotionGate(
      db,
      'kucoin',
      exact30DaysUtcMs - 1000
    );
    expect(oneSecondEarly.allowed).toBe(false);
    if (!oneSecondEarly.allowed) {
      expect(oneSecondEarly.code).toBe('SHADOW_WINDOW_UNDER_30_DAYS');
    }

    const onExactBoundary = await validateShadowPromotionGate(
      db,
      'kucoin',
      exact30DaysUtcMs
    );
    expect(onExactBoundary).toEqual({
      allowed: true,
      totalBatches: 1,
      earliestAt: '2026-10-01 00:00:00',
    });

    // Insert an older ISO-8601 timestamp ('2026-10-01T18:00:00.000Z') alongside a newer
    // bare SQLite timestamp ('2026-10-01 23:00:00'). Lexicographically ' ' < 'T' would
    // pick the 23:00:00 row by mistake; `MIN(datetime(created_at))` picks 18:00:00 UTC.
    sqlite
      .prepare(
        `INSERT INTO partner_shadow_reconciliations (
           id, exchange, evidence_id, row_count, mapped_uid_count, unmapped_uid_count,
           simulated_gross_units, wallet_cash_collected_units, discrepancy_units,
           status, notes, created_at
         ) VALUES
           ('sh_gate_iso_older', 'gateio', 'ev_utc_gateio_1', 4, 4, 0,
            800000000, 800000000, 0, 'PROMOTED_READY', 'Older ISO row', '2026-10-01T18:00:00.000Z'),
           ('sh_gate_sql_newer', 'gateio', 'ev_utc_gateio_2', 4, 4, 0,
            800000000, 800000000, 0, 'PROMOTED_READY', 'Newer SQLite row', '2026-10-01 23:00:00')`
      )
      .run();

    const mixedEval = await validateShadowPromotionGate(
      db,
      'gateio',
      Date.parse('2026-10-31T20:00:00.000Z')
    );
    expect(mixedEval).toEqual({
      allowed: true,
      totalBatches: 2,
      earliestAt: '2026-10-01 18:00:00',
    });
  });

  it('rejects manual poller overrides in production runtime with 403 OVERRIDES_FORBIDDEN_IN_PRODUCTION', async () => {
    sqlite
      .prepare(
        `INSERT INTO webauthn_challenges (
           challenge_id, user_id, challenge, purpose, expires_at, consumed
         ) VALUES (
           'wac_test_poller_prod_guard', 'admin_root', 'seeded_challenge', 'admin_step_up',
           '2099-01-01T00:00:00Z', 1
         )`
      )
      .run();

    const stepUpToken = issuePasskeyStepUpToken({
      userId: 'admin_root',
      purpose: 'admin_step_up',
      challengeId: 'wac_test_poller_prod_guard',
    });

    const previousAppEnv = process.env.APP_ENV;
    try {
      process.env.APP_ENV = 'production';

      const payloadOverrideRes = await pollerAdminPost(
        new NextRequest('http://localhost:3000/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'run',
            exchanges: ['bybit'],
            forceShadow: true,
            overrides: {
              bybit: {
                rawPartnerPayload: JSON.stringify({ retCode: 0, result: { list: [] } }),
              },
            },
          }),
        })
      );
      expect(payloadOverrideRes.status).toBe(403);
      const payloadOverrideBody = (await payloadOverrideRes.json()) as {
        success: boolean;
        code: string;
      };
      expect(payloadOverrideBody.success).toBe(false);
      expect(payloadOverrideBody.code).toBe('OVERRIDES_FORBIDDEN_IN_PRODUCTION');

      const endpointOverrideRes = await pollerAdminPost(
        new NextRequest('http://localhost:3000/api/admin/reconciliation/poller', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_console_valid',
            'Content-Type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'run',
            exchanges: ['bybit'],
            forceShadow: true,
            overrides: {
              bybit: {
                depositEndpointPath: '/v5/asset/deposit/query-record',
              },
            },
          }),
        })
      );
      expect(endpointOverrideRes.status).toBe(403);
      expect(((await endpointOverrideRes.json()) as { code: string }).code).toBe(
        'OVERRIDES_FORBIDDEN_IN_PRODUCTION'
      );
    } finally {
      if (previousAppEnv === undefined) {
        delete process.env.APP_ENV;
      } else {
        process.env.APP_ENV = previousAppEnv;
      }
    }
  });
});
