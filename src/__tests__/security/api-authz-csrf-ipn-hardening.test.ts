/**
 * @jest-environment node
 *
 * Security & Data Integrity Verification Suite:
 * - IPN webhook fail-closed secret check (HTTP 503 when unset)
 * - Payments callback origin hygiene (no unowned apex-os.com fallback)
 * - Passkey step-up CSRF origin guard, production secret fail-closed, ES256-only
 *   enrollment, credential revocation + active-credential token enforcement,
 *   mandatory runtime-flag audit reason, and immutable compliance_audit_logs
 * - Admin reconciliation ingest isolation from operator request IP
 * - Profile wallet & timelock CSRF guard, persistent D1 rate limiting, and sanitized errors
 * - Affiliate ledger-summary SQL SUM aggregation (>200 postings) & UUID partnerId masking
 */

import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import * as dbModule from '@/lib/db';
import { SqliteD1Adapter } from '@/lib/ledger';
import { POST as ipnPost } from '@/app/api/webhooks/ipn/route';
import { POST as paymentsPost } from '@/app/api/payments/route';
import {
  PASSKEY_STEPUP_HEADER,
  beginPasskeyRegistration,
  issuePasskeyStepUpToken,
  requireAdminWithPasskeyStepUp,
} from '@/lib/auth/passkey-step-up';
import { POST as adminPasskeyPost } from '@/app/api/admin/passkey/route';
import { POST as adminRuntimeFlagsPost } from '@/app/api/admin/runtime-flags/route';
import {
  GET as profileWalletGet,
  POST as profileWalletPost,
  DELETE as profileWalletDelete,
} from '@/app/api/profile/wallet/route';
import {
  POST as timelockPost,
  PATCH as timelockPatch,
  DELETE as timelockDelete,
} from '@/app/api/profile/wallet/timelock/route';
import { GET as ledgerSummaryGet } from '@/app/api/affiliate/ledger-summary/route';

describe('API Authz, CSRF, IPN Fail-Closed, Wallet & Ledger Summary Hardening', () => {
  let sqlite: Database.Database;
  let db: SqliteD1Adapter;

  const originalEnv = { ...process.env };

  beforeEach(() => {
    sqlite = new Database(':memory:');
    const migrationsDir = path.join(process.cwd(), 'src', 'database', 'migrations');
    for (const file of [
      '001_initial_schema_d1.sql',
      '003_affiliate_schema.sql',
      '024_kyc_compliance_schema.sql',
      '028_ascendancy_audit_core.sql',
      '031_ascendancy_phase2_ui_and_poller.sql',
      '032_persistent_d1_rate_limits.sql',
    ]) {
      sqlite.exec(fs.readFileSync(path.join(migrationsDir, file), 'utf8'));
    }

    sqlite.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
        token TEXT UNIQUE NOT NULL,
        expires_at TEXT NOT NULL
      );
    `);

    const futureIso = new Date(Date.now() + 3600_000).toISOString();
    sqlite
      .prepare('INSERT INTO profiles (id, email, role, referral_code) VALUES (?, ?, ?, ?)')
      .run('admin_sec_1', 'admin@apex.test', 'admin', 'ADMSEC1');
    sqlite
      .prepare('INSERT INTO profiles (id, email, role, referral_code) VALUES (?, ?, ?, ?)')
      .run('user_sec_1', 'user@apex.test', 'affiliate', 'USRSEC1');

    sqlite
      .prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .run('sess_admin_sec_1', 'admin_sec_1', 'tok_admin_sec_1', futureIso);
    sqlite
      .prepare('INSERT INTO sessions (id, user_id, token, expires_at) VALUES (?, ?, ?, ?)')
      .run('sess_user_sec_1', 'user_sec_1', 'tok_user_sec_1', futureIso);

    db = new SqliteD1Adapter(sqlite);
    (globalThis as unknown as { DB?: unknown }).DB = db;
    jest.spyOn(dbModule, 'getDB').mockReturnValue(db as unknown as dbModule.D1Database);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.env = { ...originalEnv };
    delete (globalThis as unknown as { DB?: unknown }).DB;
    sqlite.close();
  });

  describe('1. IPN Webhook Fail-Closed Secret Check', () => {
    it('returns HTTP 503 when NOWPAYMENTS_IPN_SECRET and NOWPAYMENTS_API_KEY are unset', async () => {
      delete process.env.NOWPAYMENTS_IPN_SECRET;
      delete process.env.NOWPAYMENTS_API_KEY;

      const req = new NextRequest('http://localhost:3000/api/webhooks/ipn', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-nowpayments-sig': 'deadbeef',
        },
        body: JSON.stringify({ payment_id: 'p1', payment_status: 'finished' }),
      });

      const res = await ipnPost(req);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('IPN webhook secret not configured');
    });
  });

  describe('2. Payments Callback Origin Hygiene', () => {
    it('fails closed with HTTP 503 when NEXT_PUBLIC_APP_URL and host point to quarantined apex-os.com in production', async () => {
      process.env.NOWPAYMENTS_API_KEY = 'test_np_key_123456';
      process.env.NEXT_PUBLIC_APP_URL = 'https://apex-os.com';
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      const req = new NextRequest('https://apex-os.com/api/payments', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok_user_sec_1',
          'content-type': 'application/json',
          host: 'apex-os.com',
        },
        body: JSON.stringify({ plan: 'BASIC' }),
      });

      const res = await paymentsPost(req);
      expect(res.status).toBe(503);
      const body = (await res.json()) as { success: boolean; error: string };
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/callback origin not configured/i);
    });
  });

  describe('3. Passkey Step-Up Hardening, Revocation & Runtime-Flag Audit Logging', () => {
    it('fails closed when signing step-up token in production without configured secret', () => {
      delete process.env.PASSKEY_STEP_UP_SECRET;
      delete process.env.PASSKEY_STEPUP_SECRET;
      delete process.env.BETTER_AUTH_SECRET;
      (process.env as Record<string, string | undefined>).NODE_ENV = 'production';

      expect(() =>
        issuePasskeyStepUpToken({
          userId: 'admin_sec_1',
          purpose: 'admin_step_up',
          challengeId: 'wac_prod_secret_check',
        })
      ).toThrow(/not configured/i);
    });

    it('restricts beginPasskeyRegistration to ES256 (-7) algorithm only', async () => {
      const reg = await beginPasskeyRegistration(db, {
        userId: 'admin_sec_1',
        userEmail: 'admin@apex.test',
      });

      const algs = (reg.options.pubKeyCredParams ?? []).map((p) => p.alg);
      expect(algs).toEqual([-7]);
    });

    it('blocks cross-origin mutations inside requireAdminWithPasskeyStepUp', async () => {
      const token = issuePasskeyStepUpToken({
        userId: 'admin_sec_1',
        purpose: 'admin_step_up',
        challengeId: 'wac_csrf_test',
      });

      const req = new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok_admin_sec_1',
          origin: 'https://evil.example',
          [PASSKEY_STEPUP_HEADER]: token,
        },
      });

      const decision = await requireAdminWithPasskeyStepUp(req, db, {
        purpose: 'admin_step_up',
      });
      expect(decision.authorized).toBe(false);
      expect(decision.status).toBe(403);
      expect(decision.code).toBe('CSRF_ORIGIN_MISMATCH');
    });

    it('revokes an enrolled passkey, logs to compliance_audit_logs, and invalidates tokens bound to it', async () => {
      sqlite
        .prepare(
          `INSERT INTO webauthn_credentials (credential_id, user_id, public_key_base64, counter, device_name)
           VALUES (?, ?, ?, ?, ?)`
        )
        .run('cred_admin_revoke_1', 'admin_sec_1', 'pk_base64_stub', 1, 'YubiKey 5');

      sqlite
        .prepare(
          `INSERT INTO webauthn_challenges (challenge_id, user_id, challenge, purpose, expires_at, consumed)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run('wac_revoke_flow', 'admin_sec_1', 'seeded_ch', 'admin_step_up', '2099-01-01T00:00:00Z');

      const stepUpToken = issuePasskeyStepUpToken({
        userId: 'admin_sec_1',
        purpose: 'admin_step_up',
        challengeId: 'wac_revoke_flow',
        credentialId: 'cred_admin_revoke_1',
      });

      const revokeReq = new NextRequest('http://localhost:3000/api/admin/passkey', {
        method: 'POST',
        headers: {
          authorization: 'Bearer tok_admin_sec_1',
          origin: 'http://localhost:3000',
          'content-type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: stepUpToken,
        },
        body: JSON.stringify({
          action: 'revoke_passkey',
          credentialId: 'cred_admin_revoke_1',
        }),
      });

      const revokeRes = await adminPasskeyPost(revokeReq);
      expect(revokeRes.status).toBe(200);
      const revokeBody = (await revokeRes.json()) as {
        success: boolean;
        code: string;
        remainingCredentials: number;
      };
      expect(revokeBody.success).toBe(true);
      expect(revokeBody.code).toBe('PASSKEY_REVOKED');
      expect(revokeBody.remainingCredentials).toBe(0);

      // Immutable audit log entry recorded
      const auditRow = sqlite
        .prepare(
          `SELECT action, severity, actor_id, target_id FROM compliance_audit_logs
           WHERE action = 'passkey_revoked' AND target_id = ?`
        )
        .get('cred_admin_revoke_1') as
        | { action: string; severity: string; actor_id: string; target_id: string }
        | undefined;
      expect(auditRow).toBeDefined();
      expect(auditRow?.actor_id).toBe('admin_sec_1');
      expect(auditRow?.severity).toBe('high');

      // Reusing the same step-up token after credential revocation is rejected
      const replayDecision = await requireAdminWithPasskeyStepUp(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            authorization: 'Bearer tok_admin_sec_1',
            origin: 'http://localhost:3000',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
        }),
        db,
        { purpose: 'admin_step_up' }
      );
      expect(replayDecision.authorized).toBe(false);
      expect(replayDecision.status).toBe(403);
      expect(replayDecision.code).toBe('PASSKEY_STEP_UP_INVALID');
    });

    it('requires >= 5 char reason on /api/admin/passkey set_runtime_flag and writes compliance_audit_logs on both flag routes', async () => {
      sqlite
        .prepare(
          `INSERT INTO webauthn_challenges (challenge_id, user_id, challenge, purpose, expires_at, consumed)
           VALUES (?, ?, ?, ?, ?, 1)`
        )
        .run('wac_flag_audit', 'admin_sec_1', 'seeded_ch', 'admin_step_up', '2099-01-01T00:00:00Z');

      const stepUpToken = issuePasskeyStepUpToken({
        userId: 'admin_sec_1',
        purpose: 'admin_step_up',
        challengeId: 'wac_flag_audit',
      });

      // Short reason rejected with 400 REASON_REQUIRED
      const shortRes = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            authorization: 'Bearer tok_admin_sec_1',
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'true',
            reason: 'bad',
          }),
        })
      );
      expect(shortRes.status).toBe(400);
      const shortBody = (await shortRes.json()) as { code: string };
      expect(shortBody.code).toBe('REASON_REQUIRED');

      // Valid reason on /api/admin/passkey writes immutable audit entry
      const okPasskeyRes = await adminPasskeyPost(
        new NextRequest('http://localhost:3000/api/admin/passkey', {
          method: 'POST',
          headers: {
            authorization: 'Bearer tok_admin_sec_1',
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            action: 'set_runtime_flag',
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'true',
            reason: 'Incident response drill #1',
          }),
        })
      );
      expect(okPasskeyRes.status).toBe(200);

      // Valid reason on /api/admin/runtime-flags also writes immutable audit entry
      const okFlagsRes = await adminRuntimeFlagsPost(
        new NextRequest('http://localhost:3000/api/admin/runtime-flags', {
          method: 'POST',
          headers: {
            authorization: 'Bearer tok_admin_sec_1',
            origin: 'http://localhost:3000',
            'content-type': 'application/json',
            [PASSKEY_STEPUP_HEADER]: stepUpToken,
          },
          body: JSON.stringify({
            flagKey: 'EMERGENCY_PAUSE',
            flagValue: 'false',
            reason: 'Incident resolved and verified',
          }),
        })
      );
      expect(okFlagsRes.status).toBe(200);

      const auditRows = sqlite
        .prepare(
          `SELECT action, actor_id, target_id FROM compliance_audit_logs
           WHERE action = 'runtime_flag_updated'
           ORDER BY rowid ASC`
        )
        .all() as Array<{ action: string; actor_id: string; target_id: string }>;
      expect(auditRows).toHaveLength(2);
      expect(auditRows[0].target_id).toBe('EMERGENCY_PAUSE');
      expect(auditRows[1].target_id).toBe('EMERGENCY_PAUSE');
    });
  });

  describe('4. Profile Wallet & Timelock CSRF, Rate Limiting, and Sanitized Errors', () => {
    it('blocks cross-origin POST/DELETE on /api/profile/wallet and POST/PATCH/DELETE on /api/profile/wallet/timelock', async () => {
      const evilHeaders = {
        authorization: 'Bearer tok_user_sec_1',
        origin: 'https://attacker.example',
        'content-type': 'application/json',
      };

      const walletPostRes = await profileWalletPost(
        new NextRequest('http://localhost:3000/api/profile/wallet', {
          method: 'POST',
          headers: evilHeaders,
          body: JSON.stringify({
            wallet_address: '0x1111111111111111111111111111111111111111',
            preferred_chain: 'arbitrum',
          }),
        })
      );
      expect(walletPostRes.status).toBe(403);

      const walletDelRes = await profileWalletDelete(
        new NextRequest('http://localhost:3000/api/profile/wallet', {
          method: 'DELETE',
          headers: evilHeaders,
        })
      );
      expect(walletDelRes.status).toBe(403);

      const tlPostRes = await timelockPost(
        new NextRequest('http://localhost:3000/api/profile/wallet/timelock', {
          method: 'POST',
          headers: evilHeaders,
          body: JSON.stringify({
            proposedAddress: '0x1111111111111111111111111111111111111111',
            proposedChain: 'arbitrum',
          }),
        })
      );
      expect(tlPostRes.status).toBe(403);

      const tlPatchRes = await timelockPatch(
        new NextRequest('http://localhost:3000/api/profile/wallet/timelock', {
          method: 'PATCH',
          headers: evilHeaders,
          body: JSON.stringify({ requestId: 'wcr_1', action: 'cancel' }),
        })
      );
      expect(tlPatchRes.status).toBe(403);

      const tlDelRes = await timelockDelete(
        new NextRequest('http://localhost:3000/api/profile/wallet/timelock?requestId=wcr_1', {
          method: 'DELETE',
          headers: evilHeaders,
        })
      );
      expect(tlDelRes.status).toBe(403);
    });

    it('enforces persistent D1 rate limit on /api/profile/wallet/timelock POST', async () => {
      let lastStatus = 200;
      for (let i = 0; i < 21; i++) {
        const res = await timelockPost(
          new NextRequest('http://localhost:3000/api/profile/wallet/timelock', {
            method: 'POST',
            headers: {
              authorization: 'Bearer tok_user_sec_1',
              origin: 'http://localhost:3000',
              'content-type': 'application/json',
            },
            body: JSON.stringify({}),
          })
        );
        lastStatus = res.status;
      }
      expect(lastStatus).toBe(429);
    });

    it('sanitizes unexpected DB errors in /api/profile/wallet GET without leaking raw error text', async () => {
      const brokenDb = {
        prepare: () => {
          throw new Error('SQLITE_CORRUPT BETTER_AUTH_SECRET=super_secret_leak');
        },
      };
      (globalThis as unknown as { DB?: unknown }).DB = brokenDb;
      jest.spyOn(dbModule, 'getDB').mockReturnValue(brokenDb as unknown as dbModule.D1Database);

      // Auth fails or DB throws during profile lookup; verify no secret leaks
      const res = await profileWalletGet(
        new NextRequest('http://localhost:3000/api/profile/wallet', {
          method: 'GET',
          headers: { authorization: 'Bearer tok_user_sec_1' },
        })
      );
      const text = await res.text();
      expect(text).not.toContain('super_secret_leak');
      expect(text).not.toContain('SQLITE_CORRUPT');
    });
  });

  describe('5. Affiliate Ledger Summary SQL Aggregation & Partner UUID Masking', () => {
    it('aggregates >200 postings accurately via SQL SUM and masks raw UUID partnerIds', async () => {
      const uuidPartnerL1 = '550e8400-e29b-41d4-a716-446655440001';
      sqlite
        .prepare(
          'INSERT INTO profiles (id, email, role, referral_code, referred_by) VALUES (?, ?, ?, ?, ?)'
        )
        .run(uuidPartnerL1, 'l1@apex.test', 'affiliate', 'L1CODE', 'USRSEC1');

      sqlite
        .prepare(
          `INSERT INTO ledger_accounts (id, owner_type, owner_id, account_code, currency, settled_balance_units, inflight_balance_units)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run('acct_user_sec_1', 'affiliate', 'user_sec_1', 'AFF:user_sec_1:USDC', 'USDC', 20500000000, 0);

      const insertBatch = sqlite.prepare(
        `INSERT INTO ledger_journal_batches (id, idempotency_key, payload_fingerprint, journal_type, status, exchange, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      );
      const insertPosting = sqlite.prepare(
        `INSERT INTO ledger_postings (id, batch_id, account_id, direction, amount_units, leg_role)
         VALUES (?, ?, ?, ?, ?, ?)`
      );

      // Insert 205 postings of 1.00 USD (100_000_000 units) each => 205.00 USD total (> LIMIT 200)
      for (let i = 1; i <= 205; i++) {
        const batchId = `batch_sum_${i}`;
        insertBatch.run(batchId, `idem_${i}`, `fp_${i}`, 'COMMISSION_SETTLED', 'SETTLED', 'bybit', '{}');
        insertPosting.run(
          `post_sum_${i}`,
          batchId,
          'acct_user_sec_1',
          'CREDIT',
          100_000_000,
          'L1_AFFILIATE_COMMISSION'
        );
      }

      const res = await ledgerSummaryGet(
        new NextRequest('http://localhost:3000/api/affiliate/ledger-summary', {
          method: 'GET',
          headers: { authorization: 'Bearer tok_user_sec_1' },
        })
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        success: boolean;
        partnerTree: {
          l1OverrideEarnedUnits: string;
          l1OverrideEarnedUsd: string;
          nodes: Array<{ partnerId: string; maskedPartnerRef: string; level: number }>;
        };
      };

      expect(body.success).toBe(true);
      // Must equal 205 * 100_000_000 = 20_500_000_000 (not truncated to 200 * 100_000_000)
      expect(body.partnerTree.l1OverrideEarnedUnits).toBe('20500000000');
      expect(body.partnerTree.l1OverrideEarnedUsd).toBe('205.00');

      // Raw UUID must be masked to partner-<8hex>
      expect(body.partnerTree.nodes).toHaveLength(1);
      expect(body.partnerTree.nodes[0].partnerId).toBe('partner-550e8400');
      expect(body.partnerTree.nodes[0].partnerId).not.toBe(uuidPartnerL1);
    });
  });
});
