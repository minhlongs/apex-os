/**
 * @jest-environment node
 *
 * Gate G6 Sandbox Verification: WebAuthn Passkey Step-Up, Anti-IDOR Authorization,
 * Rate-Limiting & Zero Secret Leakage Boundary
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
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import type { D1Database, D1PreparedStatement, D1Result } from '@/lib/db';
import * as dbModule from '@/lib/db';
import {
  PASSKEY_STEPUP_HEADER,
  assertNoIdor,
  issuePasskeyStepUpToken,
  resetEndpointRateLimits,
  sanitizeApiErrorResponse,
} from '@/lib/auth/passkey-step-up';
import {
  GET as adminPasskeyGet,
  POST as adminPasskeyPost,
} from '@/app/api/admin/passkey/route';
import {
  GET as walletTimelockGet,
  POST as walletTimelockPost,
  PATCH as walletTimelockPatch,
  DELETE as walletTimelockDelete,
} from '@/app/api/profile/wallet/timelock/route';

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
              served_by: 'sqlite-g6',
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
              served_by: 'sqlite-g6',
            },
          };
        },
        async raw<T = unknown>(): Promise<T[]> {
          return stmt.raw().all(...params) as T[];
        },
      };

      return wrapped;
    },
    async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
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

function buildAttestationResponse(params: {
  rpID: string;
  origin: string;
  challenge: string;
  credIdBytes: Buffer;
  cosePublicKey: Buffer;
}): RegistrationResponseJSON {
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
      : Buffer.from([0x59, (authData.length >> 8) & 0xff, authData.length & 0xff]);

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

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.create',
      challenge: params.challenge,
      origin: params.origin,
      crossOrigin: false,
    })
  );

  const credIdB64 = params.credIdBytes.toString('base64url');
  return {
    id: credIdB64,
    rawId: credIdB64,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      attestationObject: attestationObject.toString('base64url'),
      clientDataJSON: clientDataJSON.toString('base64url'),
      transports: ['internal'],
    },
  };
}

function buildAssertionResponse(params: {
  rpID: string;
  origin: string;
  challenge: string;
  credIdB64: string;
  privateKey: crypto.KeyObject;
  signCounter: number;
}): AuthenticationResponseJSON {
  const rpIdHash = crypto.createHash('sha256').update(params.rpID).digest();
  const flags = Buffer.from([0x05]); // UP=1 | UV=1
  const counterBuf = Buffer.alloc(4);
  counterBuf.writeUInt32BE(params.signCounter, 0);
  const authenticatorData = Buffer.concat([rpIdHash, flags, counterBuf]);

  const clientDataJSON = Buffer.from(
    JSON.stringify({
      type: 'webauthn.get',
      challenge: params.challenge,
      origin: params.origin,
      crossOrigin: false,
    })
  );

  const clientDataHash = crypto.createHash('sha256').update(clientDataJSON).digest();
  const signature = crypto.sign(
    'sha256',
    Buffer.concat([authenticatorData, clientDataHash]),
    params.privateKey
  );

  return {
    id: params.credIdB64,
    rawId: params.credIdB64,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      authenticatorData: authenticatorData.toString('base64url'),
      clientDataJSON: clientDataJSON.toString('base64url'),
      signature: signature.toString('base64url'),
    },
  };
}

function initializeG6Database(sqlite: Database.Database): void {
  sqlite.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE profiles (
      id TEXT PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      full_name TEXT,
      role TEXT DEFAULT 'affiliate',
      wallet_address TEXT,
      preferred_chain TEXT,
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

    CREATE TABLE sanctioned_addresses (
      address TEXT NOT NULL,
      chain TEXT NOT NULL,
      source TEXT,
      risk_score REAL DEFAULT 1.0,
      added_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (chain, address)
    );

    CREATE TABLE compliance_audit_logs (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      severity TEXT NOT NULL,
      actor_id TEXT,
      target_id TEXT,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  const migration028 = fs.readFileSync(
    path.resolve(process.cwd(), 'src/database/migrations/028_ascendancy_audit_core.sql'),
    'utf8'
  );
  sqlite.exec(migration028);

  const futureExpiry = new Date(Date.now() + 24 * 3600 * 1000).toISOString();
  sqlite
    .prepare(
      `INSERT INTO profiles (id, email, role, wallet_address, preferred_chain)
       VALUES
         ('admin_root', 'admin@apexos.app', 'admin', '0x1111111111111111111111111111111111111111', 'arbitrum'),
         ('admin_two', 'admin2@apexos.app', 'admin', '0x2222222222222222222222222222222222222222', 'arbitrum'),
         ('user_alice', 'alice@apexos.app', 'affiliate', '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'arbitrum'),
         ('user_bob', 'bob@apexos.app', 'affiliate', '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'base')`
    )
    .run();

  sqlite
    .prepare(
      `INSERT INTO sessions (id, user_id, token, expires_at)
       VALUES
         ('sess_admin_1', 'admin_root', 'tok_admin_root_valid', ?),
         ('sess_admin_2', 'admin_two', 'tok_admin_two_valid', ?),
         ('sess_alice', 'user_alice', 'tok_alice_valid', ?),
         ('sess_bob', 'user_bob', 'tok_bob_valid', ?)`
    )
    .run(futureExpiry, futureExpiry, futureExpiry, futureExpiry);
}

describe('Gate G6: AuthZ, WebAuthn Passkey Step-Up, IDOR & Secret Boundary', () => {
  let sqlite: Database.Database;
  let db: D1Database;

  const CANARY_SECRETS: Readonly<Record<string, string>> = {
    BETTER_AUTH_SECRET: 'canary_better_auth_secret_9988776655443322',
    TURNKEY_API_PRIVATE_KEY: 'canary_turnkey_priv_key_deadbeefcafebabe',
    CRON_SECRET: 'canary_cron_secret_5544332211ffeedd',
    STELLAR_SECRET_KEY: 'SCANARYSTELLARSECRETKEY2233445566778899AABBCCDDEEFFGG2233',
    PASSKEY_STEPUP_SECRET: 'canary_passkey_stepup_hmac_secret_key_2026',
  };

  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(() => {
    resetEndpointRateLimits();
    sqlite = new Database(':memory:');
    initializeG6Database(sqlite);
    db = createSqliteD1(sqlite);
    (globalThis as unknown as { DB?: D1Database }).DB = db;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(db);

    for (const [k, v] of Object.entries(CANARY_SECRETS)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    process.env.WEBAUTHN_RP_ID = 'localhost';
    process.env.WEBAUTHN_ORIGIN = 'http://localhost:3000';
  });

  afterEach(() => {
    sqlite.close();
    delete (globalThis as unknown as { DB?: D1Database }).DB;
    jest.restoreAllMocks();
    for (const [k, prev] of Object.entries(savedEnv)) {
      if (prev === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = prev;
      }
    }
  });

  it('requires BOTH admin session AND verified WebAuthn Passkey step-up for admin mutations and blocks challenge replay', async () => {
    // 1. Unauthenticated mutation -> 401
    const unauthRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.10',
        },
        body: JSON.stringify({
          action: 'set_runtime_flag',
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
        }),
      })
    );
    expect(unauthRes.status).toBe(401);

    // 2. Non-admin session (Alice) -> 403 ADMIN_ROLE_REQUIRED
    const nonAdminRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_alice_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.11',
        },
        body: JSON.stringify({
          action: 'set_runtime_flag',
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
        }),
      })
    );
    expect(nonAdminRes.status).toBe(403);
    expect((await nonAdminRes.json()).code).toBe('ADMIN_ROLE_REQUIRED');

    // 3. Admin session ALONE without Passkey step-up -> 403 PASSKEY_STEP_UP_REQUIRED
    const sessionOnlyRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.12',
        },
        body: JSON.stringify({
          action: 'set_runtime_flag',
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
        }),
      })
    );
    expect(sessionOnlyRes.status).toBe(403);
    expect((await sessionOnlyRes.json()).code).toBe('PASSKEY_STEP_UP_REQUIRED');

    // 4. Full genuine ES256 WebAuthn Passkey enrollment for admin_root
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    const cosePub = buildCosePublicKeyFromEcJwk(
      publicKey.export({ format: 'jwk' })
    );
    const credIdBytes = Buffer.from('yubikey_admin_root_cred_01');

    const regOptRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.13',
        },
        body: JSON.stringify({ action: 'register_options' }),
      })
    );
    expect(regOptRes.status).toBe(200);
    const regOptJson = (await regOptRes.json()) as {
      challengeId: string;
      options: { challenge: string };
    };

    const attestationPayload = buildAttestationResponse({
      rpID: 'localhost',
      origin: 'http://localhost:3000',
      challenge: regOptJson.options.challenge,
      credIdBytes,
      cosePublicKey: cosePub,
    });

    const regVerifyRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.13',
        },
        body: JSON.stringify({
          action: 'register_verify',
          challengeId: regOptJson.challengeId,
          deviceName: 'YubiKey 5C Nano',
          response: attestationPayload,
        }),
      })
    );
    expect(regVerifyRes.status).toBe(201);

    // 5. Request step-up challenge & sign ES256 assertion
    const stepUpOptRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.14',
        },
        body: JSON.stringify({ action: 'step_up_options' }),
      })
    );
    expect(stepUpOptRes.status).toBe(200);
    const stepUpOptJson = (await stepUpOptRes.json()) as {
      challengeId: string;
      options: { challenge: string };
    };

    const assertionPayload = buildAssertionResponse({
      rpID: 'localhost',
      origin: 'http://localhost:3000',
      challenge: stepUpOptJson.options.challenge,
      credIdB64: credIdBytes.toString('base64url'),
      privateKey,
      signCounter: 1,
    });

    const stepUpVerifyRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.14',
        },
        body: JSON.stringify({
          action: 'step_up_verify',
          challengeId: stepUpOptJson.challengeId,
          response: assertionPayload,
        }),
      })
    );
    expect(stepUpVerifyRes.status).toBe(200);
    const stepUpVerifyJson = (await stepUpVerifyRes.json()) as {
      stepUpToken: string;
    };
    expect(typeof stepUpVerifyJson.stepUpToken).toBe('string');

    // 6. REPLAY ATTACK: Replaying the exact same WebAuthn challenge + assertion MUST be rejected!
    const replayRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.15',
        },
        body: JSON.stringify({
          action: 'step_up_verify',
          challengeId: stepUpOptJson.challengeId,
          response: assertionPayload,
        }),
      })
    );
    expect(replayRes.status).toBe(403);
    expect((await replayRes.json()).code).toBe('CHALLENGE_ALREADY_CONSUMED');

    // 7. Cross-admin token reuse (admin_two trying to use admin_root's stepUpToken) -> 403 PASSKEY_STEP_UP_INVALID
    const crossAdminRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_two_valid',
          [PASSKEY_STEPUP_HEADER]: stepUpVerifyJson.stepUpToken,
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.16',
        },
        body: JSON.stringify({
          action: 'set_runtime_flag',
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
        }),
      })
    );
    expect(crossAdminRes.status).toBe(403);
    expect((await crossAdminRes.json()).code).toBe('PASSKEY_STEP_UP_INVALID');

    // 8. Forged token referencing unconsumed/non-existent challengeId -> 403 PASSKEY_STEP_UP_INVALID
    const unbackedToken = issuePasskeyStepUpToken({
      userId: 'admin_root',
      purpose: 'admin_step_up',
      challengeId: 'wac_nonexistent_forged',
    });
    const unbackedRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          [PASSKEY_STEPUP_HEADER]: unbackedToken,
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.17',
        },
        body: JSON.stringify({
          action: 'set_runtime_flag',
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
        }),
      })
    );
    expect(unbackedRes.status).toBe(403);
    expect((await unbackedRes.json()).code).toBe('PASSKEY_STEP_UP_INVALID');

    // 9. Valid admin_root session + verified stepUpToken -> 200 RUNTIME_FLAG_UPDATED
    const validMutationRes = await adminPasskeyPost(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_admin_root_valid',
          [PASSKEY_STEPUP_HEADER]: stepUpVerifyJson.stepUpToken,
          'Content-Type': 'application/json',
          'cf-connecting-ip': '198.51.100.18',
        },
        body: JSON.stringify({
          action: 'set_runtime_flag',
          flagKey: 'EMERGENCY_PAUSE',
          flagValue: 'true',
          reason: 'Scheduled custody audit drill',
        }),
      })
    );
    expect(validMutationRes.status).toBe(200);
    expect((await validMutationRes.json()).code).toBe('RUNTIME_FLAG_UPDATED');

    const flagRow = sqlite
      .prepare("SELECT flag_value, updated_by FROM system_runtime_flags WHERE flag_key = 'EMERGENCY_PAUSE'")
      .get() as { flag_value: string; updated_by: string };
    expect(flagRow.flag_value).toBe('true');
    expect(flagRow.updated_by).toBe('admin_root');
  });

  it('enforces strict anti-IDOR isolation: User A cannot read, propose, activate, or cancel User B wallet/withdrawal requests', async () => {
    expect(assertNoIdor('user_alice', 'user_bob', false)).toEqual({
      allowed: false,
      status: 403,
      code: 'IDOR_FORBIDDEN',
    });
    expect(assertNoIdor('user_alice', 'user_alice', false).allowed).toBe(true);
    expect(assertNoIdor('admin_root', 'user_bob', true).allowed).toBe(true);

    // Bob creates a legitimate 48h timelocked wallet change request
    const bobPostRes = await walletTimelockPost(
      new NextRequest('http://localhost:3000/api/profile/wallet/timelock', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_bob_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          proposedAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
          proposedChain: 'base',
        }),
      })
    );
    expect(bobPostRes.status).toBe(201);
    const bobCreated = (await bobPostRes.json()) as {
      request: { id: string };
    };
    const bobRequestId = bobCreated.request.id;

    // 1. Alice attempts GET with ?profile_id=user_bob -> 403 IDOR_FORBIDDEN
    const aliceSpyGet = await walletTimelockGet(
      new NextRequest(
        'http://localhost:3000/api/profile/wallet/timelock?profile_id=user_bob',
        {
          method: 'GET',
          headers: { Authorization: 'Bearer tok_alice_valid' },
        }
      )
    );
    expect(aliceSpyGet.status).toBe(403);
    expect((await aliceSpyGet.json()).code).toBe('IDOR_FORBIDDEN');

    // 2. Alice attempts POST specifying profile_id: 'user_bob' -> 403 IDOR_FORBIDDEN
    const aliceHijackPost = await walletTimelockPost(
      new NextRequest('http://localhost:3000/api/profile/wallet/timelock', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer tok_alice_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          profile_id: 'user_bob',
          proposedAddress: '0xdddddddddddddddddddddddddddddddddddddddd',
          proposedChain: 'arbitrum',
        }),
      })
    );
    expect(aliceHijackPost.status).toBe(403);
    expect((await aliceHijackPost.json()).code).toBe('IDOR_FORBIDDEN');

    // 3. Alice attempts PATCH activate on Bob's requestId -> 403 IDOR_FORBIDDEN
    const aliceHijackActivate = await walletTimelockPatch(
      new NextRequest('http://localhost:3000/api/profile/wallet/timelock', {
        method: 'PATCH',
        headers: {
          Authorization: 'Bearer tok_alice_valid',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'activate',
          requestId: bobRequestId,
        }),
      })
    );
    expect(aliceHijackActivate.status).toBe(403);
    expect((await aliceHijackActivate.json()).code).toBe('IDOR_FORBIDDEN');

    // 4. Alice attempts DELETE cancel on Bob's requestId -> 403 IDOR_FORBIDDEN
    const aliceHijackDelete = await walletTimelockDelete(
      new NextRequest(
        `http://localhost:3000/api/profile/wallet/timelock?requestId=${encodeURIComponent(bobRequestId)}`,
        {
          method: 'DELETE',
          headers: { Authorization: 'Bearer tok_alice_valid' },
        }
      )
    );
    expect(aliceHijackDelete.status).toBe(403);
    expect((await aliceHijackDelete.json()).code).toBe('IDOR_FORBIDDEN');

    // Confirm Bob's request remains untouched in PENDING_TIMELOCK
    const bobRow = sqlite
      .prepare('SELECT status, profile_id FROM wallet_change_requests WHERE id = ?')
      .get(bobRequestId) as { status: string; profile_id: string };
    expect(bobRow.status).toBe('PENDING_TIMELOCK');
    expect(bobRow.profile_id).toBe('user_bob');
  });

  it('enforces 429 rate-limiting on burst admin passkey requests', async () => {
    const attackerIp = '203.0.113.77';
    let saw429 = false;

    for (let i = 0; i < 12; i += 1) {
      const res = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            Authorization: 'Bearer tok_admin_root_valid',
            'Content-Type': 'application/json',
            'cf-connecting-ip': attackerIp,
          },
          body: JSON.stringify({ action: 'step_up_options' }),
        })
      );
      if (res.status === 429) {
        saw429 = true;
        const payload = (await res.json()) as { code: string; retryAfter: number };
        expect(payload.code).toBe('RATE_LIMIT_EXCEEDED');
        expect(payload.retryAfter).toBeGreaterThanOrEqual(1);
      }
    }

    expect(saw429).toBe(true);
  });

  it('guarantees zero environment secret leakage across API responses and error boundaries', async () => {
    // 1. Simulate a 500 error whose internal message embeds every canary secret
    const poisonedError = new Error(
      `Signer failure with ${CANARY_SECRETS.TURNKEY_API_PRIVATE_KEY} and BETTER_AUTH_SECRET=${CANARY_SECRETS.BETTER_AUTH_SECRET} and ${CANARY_SECRETS.CRON_SECRET} and ${CANARY_SECRETS.STELLAR_SECRET_KEY}`
    );
    const resp500 = sanitizeApiErrorResponse(poisonedError, 500);
    const resp400 = sanitizeApiErrorResponse(poisonedError, 400, 'BAD_SIGNER_INPUT');
    const getCredsResp = await adminPasskeyGet(
      new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'GET',
        headers: { Authorization: 'Bearer tok_admin_root_valid' },
      })
    );

    const serializedPayloads = [
      JSON.stringify(await resp500.json()),
      JSON.stringify(await resp400.json()),
      JSON.stringify(await getCredsResp.json()),
    ];

    for (const payload of serializedPayloads) {
      for (const secretVal of Object.values(CANARY_SECRETS)) {
        expect(payload).not.toContain(secretVal);
      }
    }
  });
});
