/**
 * WebAuthn Passkey Step-Up Authentication & Authorization / Secret Boundary
 *
 * Implements FIDO2/WebAuthn hardware/platform Passkey registration & assertion
 * verification via `@simplewebauthn/server`, backed by `webauthn_credentials`
 * and `webauthn_challenges` in Cloudflare D1:
 * - Single-use challenge consumption (`consumed = 1`) with 5-minute TTL
 * - Short-lived HMAC-SHA256 signed step-up token (`x-passkey-stepup-token`) bound
 *   to `adminId` + `purpose` + `challengeId`
 * - `requireAdminWithPasskeyStepUp` enforcing BOTH `profiles.role === 'admin'` AND
 *   a verified Passkey step-up assertion
 * - `assertNoIdor` enforcing strict owner-scoped object authorization
 * - `sanitizeApiErrorResponse` preventing leakage of env secrets (`BETTER_AUTH_SECRET`,
 *   `TURNKEY_*`, `CRON_SECRET`, `STELLAR_SECRET_KEY`, etc.) in JSON payloads
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/server';
import type { D1Database } from '@/lib/db';
import { getAuthenticatedUser } from '@/lib/auth/session-helper';
import { redactPiiForReadOnlyAi } from '@/lib/compliance/pii-redactor';
import {
  verifyTrustedMutationOrigin,
  type CsrfRejectionCode,
} from '@/lib/security/http-hardening';

type PasskeyTransport = NonNullable<
  RegistrationResponseJSON['response']['transports']
>[number];

export const WEBAUTHN_CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_STEPUP_TOKEN_TTL_MS = 5 * 60 * 1000;
export const PASSKEY_STEPUP_HEADER = 'x-passkey-stepup-token';

export type WebAuthnChallengePurpose =
  | 'registration'
  | 'admin_step_up'
  | 'wallet_change';

export interface StoredWebAuthnCredential {
  credential_id: string;
  user_id: string;
  public_key_base64: string;
  counter: number;
  transports: string;
  device_name: string | null;
  created_at: string;
  last_used_at: string | null;
}

export interface StoredWebAuthnChallenge {
  challenge_id: string;
  user_id: string;
  challenge: string;
  purpose: WebAuthnChallengePurpose;
  expires_at: string;
  consumed: number;
  created_at: string;
}

export interface PasskeyStepUpClaims {
  sub: string;
  purpose: WebAuthnChallengePurpose;
  cid: string;
  credentialId?: string;
  iat: number;
  exp: number;
}

export interface AdminPasskeyAuthResult {
  authorized: boolean;
  status: 200 | 401 | 403;
  code:
    | 'AUTHORIZED'
    | 'UNAUTHENTICATED'
    | 'ADMIN_ROLE_REQUIRED'
    | 'PASSKEY_STEP_UP_REQUIRED'
    | 'PASSKEY_STEP_UP_INVALID'
    | CsrfRejectionCode;
  adminId?: string;
  email?: string;
  error?: string;
}

export interface RequireAdminStepUpOptions {
  purpose?: WebAuthnChallengePurpose;
  nowMs?: number;
  stepUpSecret?: string;
}

const SENSITIVE_ENV_KEY_PATTERNS: readonly RegExp[] = [
  /^BETTER_AUTH_SECRET$/i,
  /^TURNKEY_/i,
  /^CRON_SECRET$/i,
  /^STELLAR_SECRET_KEY$/i,
  /^SAFE_/i,
  /^KYC_WEBHOOK_SECRET$/i,
  /^BINANCE_WEBHOOK_SECRET$/i,
  /^BYBIT_WEBHOOK_SECRET$/i,
  /^RESEND_API_KEY$/i,
  /^CLOUDFLARE_API_TOKEN$/i,
  /SECRET/i,
  /PRIVATE_KEY/i,
  /API_KEY/i,
  /TOKEN/i,
  /PASSWORD/i,
];

function resolveStepUpSigningSecret(overrideSecret?: string): string {
  if (overrideSecret && overrideSecret.length >= 16) {
    return overrideSecret;
  }
  const envSecret =
    process.env.PASSKEY_STEP_UP_SECRET ??
    process.env.PASSKEY_STEPUP_SECRET ??
    process.env.BETTER_AUTH_SECRET;
  if (envSecret && envSecret.length >= 16) {
    return envSecret;
  }
  const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
  const nodeEnv = (process.env.NODE_ENV ?? '').trim().toLowerCase();
  const isStrictRuntime =
    nodeEnv === 'production' ||
    (nodeEnv !== 'test' && (appEnv === 'production' || appEnv === 'staging'));
  if (isStrictRuntime) {
    throw new Error('PASSKEY_STEP_UP_SECRET or BETTER_AUTH_SECRET is not configured');
  }
  return 'dev_only_passkey_stepup_hmac_key_32chars';
}

import { isQuarantinedThirdPartyHost } from '@/config/canonical-origin';

function resolveRpConfig(options?: { rpID?: string; rpName?: string; origin?: string }): {
  rpID: string;
  rpName: string;
  origin: string;
} {
  const appEnv = (process.env.APP_ENV ?? '').trim().toLowerCase();
  const isManagedDeployment =
    appEnv === 'production' || appEnv === 'staging' || process.env.NODE_ENV === 'production';

  const explicitRpId = (options?.rpID ?? process.env.WEBAUTHN_RP_ID ?? '').trim();
  const explicitOrigin = (options?.origin ?? process.env.WEBAUTHN_ORIGIN ?? '').trim();

  if (isManagedDeployment && (!explicitRpId || !explicitOrigin)) {
    throw new Error(
      'WEBAUTHN_RP_ID and WEBAUTHN_ORIGIN must be explicitly configured in staging/production'
    );
  }

  const rpID = explicitRpId || 'localhost';
  const rpName = options?.rpName ?? process.env.WEBAUTHN_RP_NAME ?? 'ApexOS';
  const origin = explicitOrigin || 'http://localhost:3000';

  if (isQuarantinedThirdPartyHost(rpID)) {
    throw new Error(`WEBAUTHN_RP_ID '${rpID}' references an unowned third-party domain`);
  }

  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new Error(`WEBAUTHN_ORIGIN '${origin}' is not a valid origin URL`);
  }

  if (isQuarantinedThirdPartyHost(parsedOrigin.hostname)) {
    throw new Error(
      `WEBAUTHN_ORIGIN '${origin}' references an unowned third-party domain`
    );
  }

  return { rpID, rpName, origin: parsedOrigin.origin };
}

function parseTransportsJson(raw: string | null | undefined): PasskeyTransport[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is PasskeyTransport => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseIsoMs(iso: string): number {
  const normalized =
    !iso.includes('T') && iso.includes(' ')
      ? `${iso.replace(' ', 'T')}Z`
      : iso;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Generates WebAuthn Passkey registration options and persists a 5-minute single-use challenge.
 */
export async function beginPasskeyRegistration(
  db: D1Database,
  params: {
    userId: string;
    userEmail: string;
    rpID?: string;
    rpName?: string;
    nowMs?: number;
  }
): Promise<{
  challengeId: string;
  options: PublicKeyCredentialCreationOptionsJSON;
  expiresAt: string;
}> {
  const { rpID, rpName } = resolveRpConfig(params);
  const nowMs = params.nowMs ?? Date.now();
  const createdIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + WEBAUTHN_CHALLENGE_TTL_MS).toISOString();

  const existingCreds = await db
    .prepare(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?'
    )
    .bind(params.userId)
    .all<{ credential_id: string; transports: string }>();

  const userIdBytes = new Uint8Array(Buffer.from(params.userId, 'utf8'));
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: userIdBytes,
    userName: params.userEmail,
    attestationType: 'none',
    supportedAlgorithmIDs: [-7],
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: (existingCreds.results ?? []).map((cred) => ({
      id: cred.credential_id,
      transports: parseTransportsJson(cred.transports),
    })),
  });

  const challengeId = `wac_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (
         challenge_id, user_id, challenge, purpose, expires_at, consumed, created_at
       ) VALUES (?, ?, ?, 'registration', ?, 0, ?)`
    )
    .bind(challengeId, params.userId, options.challenge, expiresIso, createdIso)
    .run();

  return {
    challengeId,
    options,
    expiresAt: expiresIso,
  };
}

/**
 * Verifies a WebAuthn registration response, consumes the single-use challenge atomically,
 * and stores the credential public key in `webauthn_credentials`.
 */
export async function finishPasskeyRegistration(
  db: D1Database,
  params: {
    userId: string;
    challengeId: string;
    response: RegistrationResponseJSON;
    deviceName?: string;
    rpID?: string;
    origin?: string;
    nowMs?: number;
  }
): Promise<{
  verified: boolean;
  credentialId?: string;
  code:
    | 'CREDENTIAL_REGISTERED'
    | 'CHALLENGE_NOT_FOUND'
    | 'CHALLENGE_ALREADY_CONSUMED'
    | 'CHALLENGE_EXPIRED'
    | 'ATTESTATION_INVALID';
  error?: string;
}> {
  const { rpID, origin } = resolveRpConfig(params);
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const row = await db
    .prepare(
      `SELECT * FROM webauthn_challenges
       WHERE challenge_id = ? AND user_id = ? AND purpose = 'registration'
       LIMIT 1`
    )
    .bind(params.challengeId, params.userId)
    .first<StoredWebAuthnChallenge>();

  if (!row) {
    return {
      verified: false,
      code: 'CHALLENGE_NOT_FOUND',
      error: 'Registration challenge not found for user',
    };
  }

  if (row.consumed === 1) {
    return {
      verified: false,
      code: 'CHALLENGE_ALREADY_CONSUMED',
      error: 'Registration challenge has already been consumed',
    };
  }

  if (nowMs > parseIsoMs(row.expires_at)) {
    return {
      verified: false,
      code: 'CHALLENGE_EXPIRED',
      error: 'Registration challenge expired (5-minute TTL exceeded)',
    };
  }

  // Consume single-use challenge BEFORE accepting response to defeat concurrent replay
  const consumeResult = await db
    .prepare(
      `UPDATE webauthn_challenges
       SET consumed = 1
       WHERE challenge_id = ? AND user_id = ? AND consumed = 0`
    )
    .bind(params.challengeId, params.userId)
    .run();

  const changes = Number(
    (consumeResult.meta as { changes?: number } | undefined)?.changes ?? 1
  );
  if (changes === 0) {
    return {
      verified: false,
      code: 'CHALLENGE_ALREADY_CONSUMED',
      error: 'Registration challenge replay detected',
    };
  }

  try {
    const verification = await verifyRegistrationResponse({
      response: params.response,
      expectedChallenge: row.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: true,
    });

    if (!verification.verified || !verification.registrationInfo) {
      return {
        verified: false,
        code: 'ATTESTATION_INVALID',
        error: 'WebAuthn registration verification failed',
      };
    }

    const { credential } = verification.registrationInfo;
    const publicKeyBase64 = Buffer.from(credential.publicKey).toString('base64');
    const transportsJson = JSON.stringify(
      credential.transports ?? params.response.response.transports ?? []
    );

    await db
      .prepare(
        `INSERT INTO webauthn_credentials (
           credential_id, user_id, public_key_base64, counter,
           transports, device_name, created_at, last_used_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        credential.id,
        params.userId,
        publicKeyBase64,
        credential.counter,
        transportsJson,
        params.deviceName ?? 'Admin Security Key',
        nowIso,
        nowIso
      )
      .run();

    return {
      verified: true,
      credentialId: credential.id,
      code: 'CREDENTIAL_REGISTERED',
    };
  } catch (err: unknown) {
    return {
      verified: false,
      code: 'ATTESTATION_INVALID',
      error: err instanceof Error ? err.message : 'Invalid WebAuthn attestation',
    };
  }
}

/**
 * Generates a single-use 5-minute WebAuthn authentication challenge for step-up (`admin_step_up` | `wallet_change`).
 */
export async function beginPasskeyStepUp(
  db: D1Database,
  params: {
    userId: string;
    purpose: Exclude<WebAuthnChallengePurpose, 'registration'>;
    rpID?: string;
    nowMs?: number;
  }
): Promise<{
  ok: boolean;
  code: 'CHALLENGE_ISSUED' | 'NO_PASSKEY_ENROLLED';
  challengeId?: string;
  options?: PublicKeyCredentialRequestOptionsJSON;
  expiresAt?: string;
  error?: string;
}> {
  const { rpID } = resolveRpConfig(params);
  const nowMs = params.nowMs ?? Date.now();
  const createdIso = new Date(nowMs).toISOString();
  const expiresIso = new Date(nowMs + WEBAUTHN_CHALLENGE_TTL_MS).toISOString();

  const creds = await db
    .prepare(
      'SELECT credential_id, transports FROM webauthn_credentials WHERE user_id = ?'
    )
    .bind(params.userId)
    .all<{ credential_id: string; transports: string }>();

  const enrolled = creds.results ?? [];
  if (enrolled.length === 0) {
    return {
      ok: false,
      code: 'NO_PASSKEY_ENROLLED',
      error: 'No WebAuthn passkey enrolled for this account',
    };
  }

  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'required',
    allowCredentials: enrolled.map((c) => ({
      id: c.credential_id,
      transports: parseTransportsJson(c.transports),
    })),
  });

  const challengeId = `wac_${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO webauthn_challenges (
         challenge_id, user_id, challenge, purpose, expires_at, consumed, created_at
       ) VALUES (?, ?, ?, ?, ?, 0, ?)`
    )
    .bind(
      challengeId,
      params.userId,
      options.challenge,
      params.purpose,
      expiresIso,
      createdIso
    )
    .run();

  return {
    ok: true,
    code: 'CHALLENGE_ISSUED',
    challengeId,
    options,
    expiresAt: expiresIso,
  };
}

/**
 * Signs a short-lived HMAC-SHA256 step-up token bound to `sub` (adminId), `purpose`, and `cid` (challengeId).
 */
export function issuePasskeyStepUpToken(
  claims: {
    userId: string;
    purpose: WebAuthnChallengePurpose;
    challengeId: string;
    credentialId?: string;
    nowMs?: number;
    ttlMs?: number;
  },
  secretOverride?: string
): string {
  const secret = resolveStepUpSigningSecret(secretOverride);
  const iat = claims.nowMs ?? Date.now();
  const exp = iat + (claims.ttlMs ?? PASSKEY_STEPUP_TOKEN_TTL_MS);

  const payloadObj: PasskeyStepUpClaims = {
    sub: claims.userId,
    purpose: claims.purpose,
    cid: claims.challengeId,
    ...(claims.credentialId ? { credentialId: claims.credentialId } : {}),
    iat,
    exp,
  };

  const payloadB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString(
    'base64url'
  );
  const sigB64 = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verifies an `x-passkey-stepup-token` HMAC signature, expiry, subject (`expectedUserId`), and `expectedPurpose`.
 */
export function verifyPasskeyStepUpToken(
  token: string,
  expected: {
    userId: string;
    purpose: WebAuthnChallengePurpose;
    nowMs?: number;
  },
  secretOverride?: string
): { valid: boolean; claims?: PasskeyStepUpClaims; reason?: string } {
  if (!token || typeof token !== 'string') {
    return { valid: false, reason: 'MISSING_TOKEN' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { valid: false, reason: 'MALFORMED_TOKEN' };
  }

  const secret = resolveStepUpSigningSecret(secretOverride);
  const expectedSigBuf = createHmac('sha256', secret).update(parts[0]).digest();

  let providedSigBuf: Buffer;
  try {
    providedSigBuf = Buffer.from(parts[1], 'base64url');
  } catch {
    return { valid: false, reason: 'INVALID_SIGNATURE_ENCODING' };
  }

  if (
    providedSigBuf.length !== expectedSigBuf.length ||
    !timingSafeEqual(providedSigBuf, expectedSigBuf)
  ) {
    return { valid: false, reason: 'INVALID_SIGNATURE' };
  }

  let claims: PasskeyStepUpClaims;
  try {
    claims = JSON.parse(
      Buffer.from(parts[0], 'base64url').toString('utf8')
    ) as PasskeyStepUpClaims;
  } catch {
    return { valid: false, reason: 'INVALID_CLAIMS_JSON' };
  }

  const nowMs = expected.nowMs ?? Date.now();
  if (typeof claims.exp !== 'number' || nowMs > claims.exp) {
    return { valid: false, reason: 'TOKEN_EXPIRED' };
  }

  if (claims.sub !== expected.userId) {
    return { valid: false, reason: 'SUBJECT_MISMATCH' };
  }

  if (claims.purpose !== expected.purpose) {
    return { valid: false, reason: 'PURPOSE_MISMATCH' };
  }

  return { valid: true, claims };
}

/**
 * Verifies a WebAuthn assertion response, consumes the single-use challenge (`consumed = 1`),
 * updates credential signature counter to prevent cloned authenticators, and returns a
 * short-lived signed `stepUpToken`.
 */
export async function finishPasskeyStepUp(
  db: D1Database,
  params: {
    userId: string;
    challengeId: string;
    purpose: Exclude<WebAuthnChallengePurpose, 'registration'>;
    response: AuthenticationResponseJSON;
    rpID?: string;
    origin?: string;
    nowMs?: number;
    stepUpSecret?: string;
  }
): Promise<{
  verified: boolean;
  code:
    | 'STEP_UP_VERIFIED'
    | 'CHALLENGE_NOT_FOUND'
    | 'CHALLENGE_ALREADY_CONSUMED'
    | 'CHALLENGE_EXPIRED'
    | 'CREDENTIAL_NOT_FOUND'
    | 'ASSERTION_INVALID';
  stepUpToken?: string;
  expiresAt?: string;
  error?: string;
}> {
  const { rpID, origin } = resolveRpConfig(params);
  const nowMs = params.nowMs ?? Date.now();
  const nowIso = new Date(nowMs).toISOString();

  const challengeRow = await db
    .prepare(
      `SELECT * FROM webauthn_challenges
       WHERE challenge_id = ? AND user_id = ? AND purpose = ?
       LIMIT 1`
    )
    .bind(params.challengeId, params.userId, params.purpose)
    .first<StoredWebAuthnChallenge>();

  if (!challengeRow) {
    return {
      verified: false,
      code: 'CHALLENGE_NOT_FOUND',
      error: 'WebAuthn challenge not found for user and purpose',
    };
  }

  if (challengeRow.consumed === 1) {
    return {
      verified: false,
      code: 'CHALLENGE_ALREADY_CONSUMED',
      error: 'WebAuthn challenge has already been consumed (replay blocked)',
    };
  }

  if (nowMs > parseIsoMs(challengeRow.expires_at)) {
    return {
      verified: false,
      code: 'CHALLENGE_EXPIRED',
      error: 'WebAuthn challenge expired (5-minute TTL exceeded)',
    };
  }

  // Consume single-use challenge atomically before signature check so a challenge can NEVER be retried
  const consumeRes = await db
    .prepare(
      `UPDATE webauthn_challenges
       SET consumed = 1
       WHERE challenge_id = ? AND user_id = ? AND consumed = 0`
    )
    .bind(params.challengeId, params.userId)
    .run();

  const changedRows = Number(
    (consumeRes.meta as { changes?: number } | undefined)?.changes ?? 1
  );
  if (changedRows === 0) {
    return {
      verified: false,
      code: 'CHALLENGE_ALREADY_CONSUMED',
      error: 'WebAuthn challenge replay blocked',
    };
  }

  const credRow = await db
    .prepare(
      `SELECT * FROM webauthn_credentials
       WHERE credential_id = ? AND user_id = ?
       LIMIT 1`
    )
    .bind(params.response.id, params.userId)
    .first<StoredWebAuthnCredential>();

  if (!credRow) {
    return {
      verified: false,
      code: 'CREDENTIAL_NOT_FOUND',
      error: 'Passkey credential is not registered to this user',
    };
  }

  try {
    const publicKeyBytes = new Uint8Array(
      Buffer.from(credRow.public_key_base64, 'base64')
    );

    const verification = await verifyAuthenticationResponse({
      response: params.response,
      expectedChallenge: challengeRow.challenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      credential: {
        id: credRow.credential_id,
        publicKey: publicKeyBytes,
        counter: Number(credRow.counter ?? 0),
        transports: parseTransportsJson(credRow.transports),
      },
      requireUserVerification: true,
    });

    if (!verification.verified) {
      return {
        verified: false,
        code: 'ASSERTION_INVALID',
        error: 'WebAuthn passkey assertion failed verification',
      };
    }

    await db
      .prepare(
        `UPDATE webauthn_credentials
         SET counter = ?, last_used_at = ?
         WHERE credential_id = ? AND user_id = ?`
      )
      .bind(
        verification.authenticationInfo.newCounter,
        nowIso,
        credRow.credential_id,
        params.userId
      )
      .run();

    const stepUpToken = issuePasskeyStepUpToken(
      {
        userId: params.userId,
        purpose: params.purpose,
        challengeId: params.challengeId,
        credentialId: credRow.credential_id,
        nowMs,
      },
      params.stepUpSecret
    );

    return {
      verified: true,
      code: 'STEP_UP_VERIFIED',
      stepUpToken,
      expiresAt: new Date(nowMs + PASSKEY_STEPUP_TOKEN_TTL_MS).toISOString(),
    };
  } catch (err: unknown) {
    return {
      verified: false,
      code: 'ASSERTION_INVALID',
      error: err instanceof Error ? err.message : 'Invalid WebAuthn assertion',
    };
  }
}

/**
 * Requires BOTH:
 *  1. Valid authenticated session whose `profiles.role === 'admin'`
 *  2. Valid `x-passkey-stepup-token` HMAC token issued after `verifyAuthenticationResponse`,
 *     bound to `adminId` + `purpose` (AND referencing a consumed challenge in `webauthn_challenges`).
 */
export async function requireAdminWithPasskeyStepUp(
  request: Request,
  db: D1Database,
  options?: RequireAdminStepUpOptions
): Promise<AdminPasskeyAuthResult> {
  const csrfDecision = verifyTrustedMutationOrigin(request);
  if (!csrfDecision.allowed) {
    return {
      authorized: false,
      status: 403,
      code: csrfDecision.code ?? 'CSRF_ORIGIN_MISMATCH',
      error:
        csrfDecision.error ??
        'Forbidden: Cross-site state-changing request rejected.',
    };
  }

  const user = await getAuthenticatedUser(request, db);
  if (!user?.id) {
    return {
      authorized: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      error: 'Authentication required',
    };
  }

  const profile = await db
    .prepare('SELECT id, email, role FROM profiles WHERE id = ? LIMIT 1')
    .bind(user.id)
    .first<{ id: string; email: string | null; role: string }>();

  if (!profile || profile.role !== 'admin') {
    return {
      authorized: false,
      status: 403,
      code: 'ADMIN_ROLE_REQUIRED',
      error: 'Forbidden: Administrator role required',
    };
  }

  const rawToken =
    request.headers.get(PASSKEY_STEPUP_HEADER) ??
    request.headers.get('X-Passkey-Stepup-Token');

  if (!rawToken) {
    return {
      authorized: false,
      status: 403,
      code: 'PASSKEY_STEP_UP_REQUIRED',
      error: 'WebAuthn Passkey step-up verification required for admin mutation',
    };
  }

  const purpose = options?.purpose ?? 'admin_step_up';
  const tokenCheck = verifyPasskeyStepUpToken(
    rawToken,
    {
      userId: profile.id,
      purpose,
      nowMs: options?.nowMs,
    },
    options?.stepUpSecret
  );

  if (!tokenCheck.valid || !tokenCheck.claims) {
    return {
      authorized: false,
      status: 403,
      code: 'PASSKEY_STEP_UP_INVALID',
      error: 'Invalid or expired WebAuthn Passkey step-up token',
    };
  }

  // Confirm the referenced challenge actually exists for this admin and was consumed
  const challengeRecord = await db
    .prepare(
      `SELECT challenge_id, consumed
       FROM webauthn_challenges
       WHERE challenge_id = ? AND user_id = ? AND purpose = ?
       LIMIT 1`
    )
    .bind(tokenCheck.claims.cid, profile.id, purpose)
    .first<{ challenge_id: string; consumed: number }>();

  if (!challengeRecord || challengeRecord.consumed !== 1) {
    return {
      authorized: false,
      status: 403,
      code: 'PASSKEY_STEP_UP_INVALID',
      error: 'Step-up token does not correspond to a verified WebAuthn challenge',
    };
  }

  // Confirm the passkey credential bound to the step-up token is still active (not revoked)
  if (tokenCheck.claims.credentialId) {
    const activeCredential = await db
      .prepare(
        `SELECT credential_id
         FROM webauthn_credentials
         WHERE credential_id = ? AND user_id = ?
         LIMIT 1`
      )
      .bind(tokenCheck.claims.credentialId, profile.id)
      .first<{ credential_id: string }>();

    if (!activeCredential) {
      return {
        authorized: false,
        status: 403,
        code: 'PASSKEY_STEP_UP_INVALID',
        error: 'Passkey credential used for step-up has been revoked',
      };
    }
  }

  return {
    authorized: true,
    status: 200,
    code: 'AUTHORIZED',
    adminId: profile.id,
    email: profile.email ?? user.email,
  };
}

/**
 * Enforces strict object-level authorization (anti-IDOR).
 * Allows access ONLY when `authenticatedUserId === resourceOwnerId` OR `isAdmin === true`.
 */
export function assertNoIdor(
  authenticatedUserId: string | null | undefined,
  resourceOwnerId: string | null | undefined,
  isAdmin = false
): { allowed: boolean; status: 200 | 401 | 403; code: 'OK' | 'UNAUTHENTICATED' | 'IDOR_FORBIDDEN' } {
  if (!authenticatedUserId) {
    return { allowed: false, status: 401, code: 'UNAUTHENTICATED' };
  }
  if (isAdmin) {
    return { allowed: true, status: 200, code: 'OK' };
  }
  if (!resourceOwnerId || authenticatedUserId !== resourceOwnerId) {
    return { allowed: false, status: 403, code: 'IDOR_FORBIDDEN' };
  }
  return { allowed: true, status: 200, code: 'OK' };
}

/**
 * Scrubs any live secret values from `process.env` (`BETTER_AUTH_SECRET`, `TURNKEY_*`,
 * `CRON_SECRET`, `STELLAR_SECRET_KEY`, API keys, tokens) out of an arbitrary string.
 */
export function scrubEnvSecretsFromText(rawMessage: string): string {
  let scrubbed = rawMessage;

  for (const [envName, envValue] of Object.entries(process.env)) {
    if (!envValue || envValue.length < 6) continue;
    const isSensitiveName = SENSITIVE_ENV_KEY_PATTERNS.some((pattern) =>
      pattern.test(envName)
    );
    if (!isSensitiveName) continue;

    if (scrubbed.includes(envValue)) {
      scrubbed = scrubbed.split(envValue).join('[REDACTED_ENV_SECRET]');
    }
  }

  // Also strip inline key=value secret leaks and stack traces
  scrubbed = scrubbed.replace(
    /\b(BETTER_AUTH_SECRET|TURNKEY_[A-Z0-9_]+|CRON_SECRET|STELLAR_SECRET_KEY|RESEND_API_KEY|KYC_WEBHOOK_SECRET|PASSKEY_STEPUP_SECRET)\s*[:=]\s*\S+/gi,
    '$1=[REDACTED]'
  );

  return scrubbed;
}

/**
 * Produces a safe JSON error response guaranteed never to expose environment secrets
 * (`BETTER_AUTH_SECRET`, `TURNKEY_*`, `CRON_SECRET`, etc.) or internal stack frames.
 */
export function sanitizeApiErrorResponse(
  error: unknown,
  status = 500,
  code = 'INTERNAL_ERROR'
): NextResponse {
  const rawDetail =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : 'Unexpected server error';

  const safeMessage =
    status >= 500
      ? 'Internal Server Error'
      : redactPiiForReadOnlyAi(scrubEnvSecretsFromText(rawDetail)).redacted;

  return NextResponse.json(
    {
      success: false,
      code,
      error: safeMessage,
    },
    { status }
  );
}

interface SlidingWindowBucketEntry {
  timestamps: number[];
  windowMs: number;
}

const slidingWindowBuckets = new Map<string, SlidingWindowBucketEntry>();
const MAX_SLIDING_WINDOW_BUCKETS = 10_000;
const PERIODIC_SWEEP_INTERVAL = 64;
let rateLimitCallCounter = 0;

function sweepExpiredSlidingWindowBuckets(nowMs: number): void {
  for (const [key, entry] of slidingWindowBuckets) {
    const entryCutoff = nowMs - entry.windowMs;
    const unexpired = entry.timestamps.filter((ts) => ts > entryCutoff);
    if (unexpired.length === 0) {
      slidingWindowBuckets.delete(key);
    } else if (unexpired.length !== entry.timestamps.length) {
      slidingWindowBuckets.set(key, {
        timestamps: unexpired,
        windowMs: entry.windowMs,
      });
    }
  }
}

export function resetEndpointRateLimits(): void {
  slidingWindowBuckets.clear();
  rateLimitCallCounter = 0;
}

/**
 * Deterministic sliding-window rate limiter returning HTTP 429 metadata when exceeded.
 *
 * The current consumers require synchronous decisions, so this limiter remains
 * instance-local. Expired buckets are removed opportunistically; active buckets
 * are never evicted because doing so would silently reset a caller's quota.
 */
export function checkSlidingWindowRateLimit(
  bucketKey: string,
  options?: { maxRequests?: number; windowMs?: number; nowMs?: number }
): { allowed: boolean; remaining: number; retryAfterSeconds: number } {
  const maxRequests = options?.maxRequests ?? 10;
  const windowMs = options?.windowMs ?? 60_000;
  const nowMs = options?.nowMs ?? Date.now();
  const existingEntry = slidingWindowBuckets.get(bucketKey);
  const effectiveWindowMs = existingEntry
    ? Math.max(windowMs, existingEntry.windowMs)
    : windowMs;
  const retentionCutoff = nowMs - effectiveWindowMs;
  const checkCutoff = nowMs - windowMs;

  if ((++rateLimitCallCounter % PERIODIC_SWEEP_INTERVAL) === 0) {
    sweepExpiredSlidingWindowBuckets(nowMs);
  }

  const retained = (existingEntry?.timestamps ?? []).filter((ts) => ts > retentionCutoff);
  const active = retained.filter((ts) => ts > checkCutoff);

  if (active.length >= maxRequests) {
    slidingWindowBuckets.set(bucketKey, {
      timestamps: retained,
      windowMs: effectiveWindowMs,
    });
    const oldest = active[0] ?? nowMs;
    const retryAfterSeconds = Math.max(1, Math.ceil((oldest + windowMs - nowMs) / 1000));
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds,
    };
  }

  if (retained.length === 0) {
    slidingWindowBuckets.delete(bucketKey);
  }
  if (!slidingWindowBuckets.has(bucketKey) && slidingWindowBuckets.size >= MAX_SLIDING_WINDOW_BUCKETS) {
    sweepExpiredSlidingWindowBuckets(nowMs);

    // Under a flood of distinct active keys, fail closed for new keys rather
    // than evicting an active bucket and resetting that key's request count.
    if (slidingWindowBuckets.size >= MAX_SLIDING_WINDOW_BUCKETS) {
      return { allowed: false, remaining: 0, retryAfterSeconds: Math.max(1, Math.ceil(windowMs / 1000)) };
    }
  }

  retained.push(nowMs);
  slidingWindowBuckets.set(bucketKey, {
    timestamps: retained,
    windowMs: effectiveWindowMs,
  });
  return {
    allowed: true,
    remaining: Math.max(0, maxRequests - (active.length + 1)),
    retryAfterSeconds: 0,
  };
}
