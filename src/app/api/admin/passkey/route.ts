/**
 * Admin WebAuthn Passkey Enrollment, Step-Up Verification & Gated Admin Mutation Route
 *
 * Endpoints:
 * - GET  /api/admin/passkey -> List enrolled passkeys (metadata only, zero raw public key/secret exposure)
 * - POST /api/admin/passkey -> Dispatches by `action`:
 *     1. `register_options`   -> Issue 5-min single-use registration challenge
 *     2. `register_verify`    -> Verify attestation & enroll admin passkey
 *     3. `step_up_options`    -> Issue 5-min single-use step-up challenge (`admin_step_up`)
 *     4. `step_up_verify`     -> Verify assertion, consume challenge, issue `x-passkey-stepup-token`
 *     5. `set_runtime_flag`   -> High-risk admin mutation requiring BOTH admin session + Passkey step-up
 */

import { NextRequest, NextResponse } from 'next/server';
import type {
  RegistrationResponseJSON,
  AuthenticationResponseJSON,
} from '@simplewebauthn/server';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { extractIpAddress } from '@/lib/ratelimit/rate-limiter';
import {
  beginPasskeyRegistration,
  finishPasskeyRegistration,
  beginPasskeyStepUp,
  finishPasskeyStepUp,
  requireAdminWithPasskeyStepUp,
  sanitizeApiErrorResponse,
  checkSlidingWindowRateLimit,
} from '@/lib/auth/passkey-step-up';

const ALLOWED_RUNTIME_FLAGS = new Set<string>([
  'EMERGENCY_LEDGER_FREEZE',
  'EMERGENCY_PAUSE',
  'BLOCK_VN_SIGNUPS',
]);

export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database unavailable' },
        { status: 503 }
      );
    }

    const user = await getAuthenticatedUser(request, db);
    if (!user?.id) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHENTICATED', error: 'Authentication required' },
        { status: 401 }
      );
    }

    const profile = await db
      .prepare('SELECT id, role FROM profiles WHERE id = ? LIMIT 1')
      .bind(user.id)
      .first<{ id: string; role: string }>();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json(
        { success: false, code: 'ADMIN_ROLE_REQUIRED', error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }

    const creds = await db
      .prepare(
        `SELECT credential_id, device_name, counter, created_at, last_used_at
         FROM webauthn_credentials
         WHERE user_id = ?
         ORDER BY created_at DESC`
      )
      .bind(profile.id)
      .all<{
        credential_id: string;
        device_name: string | null;
        counter: number;
        created_at: string;
        last_used_at: string | null;
      }>();

    return NextResponse.json(
      {
        success: true,
        credentials: creds.results ?? [],
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const db = resolveDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database unavailable' },
        { status: 503 }
      );
    }

    // Rate-limit admin passkey & mutation endpoints (10 req / 60s per IP)
    const ip = extractIpAddress(request.headers);
    const rateCheck = checkSlidingWindowRateLimit(`admin-passkey:${ip}`, {
      maxRequests: 10,
      windowMs: 60_000,
    });
    if (!rateCheck.allowed) {
      return NextResponse.json(
        {
          success: false,
          code: 'RATE_LIMIT_EXCEEDED',
          error: 'Too Many Requests',
          retryAfter: rateCheck.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, code: 'INVALID_JSON', error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const action = typeof body.action === 'string' ? body.action.trim() : '';

    // High-privilege admin mutation gated by BOTH admin session + Passkey step-up
    if (action === 'set_runtime_flag') {
      const stepUpGuard = await requireAdminWithPasskeyStepUp(request, db, {
        purpose: 'admin_step_up',
      });
      if (!stepUpGuard.authorized) {
        return NextResponse.json(
          {
            success: false,
            code: stepUpGuard.code,
            error: stepUpGuard.error,
          },
          { status: stepUpGuard.status }
        );
      }

      const flagKey = typeof body.flagKey === 'string' ? body.flagKey.trim() : '';
      const flagValue = typeof body.flagValue === 'string' ? body.flagValue.trim() : '';
      const reason =
        typeof body.reason === 'string' ? body.reason.trim() : 'Admin Passkey mutation';

      if (!ALLOWED_RUNTIME_FLAGS.has(flagKey) || (flagValue !== 'true' && flagValue !== 'false')) {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_RUNTIME_FLAG',
            error: 'Unsupported runtime flag key or non-boolean value',
          },
          { status: 400 }
        );
      }

      await db
        .prepare(
          `INSERT INTO system_runtime_flags (flag_key, flag_value, reason, updated_by, updated_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT(flag_key) DO UPDATE SET
             flag_value = excluded.flag_value,
             reason = excluded.reason,
             updated_by = excluded.updated_by,
             updated_at = datetime('now')`
        )
        .bind(flagKey, flagValue, reason, stepUpGuard.adminId ?? 'admin')
        .run();

      return NextResponse.json(
        {
          success: true,
          code: 'RUNTIME_FLAG_UPDATED',
          flagKey,
          flagValue,
          updatedBy: stepUpGuard.adminId,
        },
        { status: 200 }
      );
    }

    // All enrollment & step-up ceremony endpoints require an authenticated admin session
    const user = await getAuthenticatedUser(request, db);
    if (!user?.id) {
      return NextResponse.json(
        { success: false, code: 'UNAUTHENTICATED', error: 'Authentication required' },
        { status: 401 }
      );
    }

    const profile = await db
      .prepare('SELECT id, email, role FROM profiles WHERE id = ? LIMIT 1')
      .bind(user.id)
      .first<{ id: string; email: string | null; role: string }>();

    if (!profile || profile.role !== 'admin') {
      return NextResponse.json(
        { success: false, code: 'ADMIN_ROLE_REQUIRED', error: 'Forbidden: Admin access required' },
        { status: 403 }
      );
    }

    if (action === 'register_options') {
      const reg = await beginPasskeyRegistration(db, {
        userId: profile.id,
        userEmail: profile.email ?? user.email ?? 'admin@apexos.app',
      });
      return NextResponse.json(
        {
          success: true,
          challengeId: reg.challengeId,
          options: reg.options,
          expiresAt: reg.expiresAt,
        },
        { status: 200 }
      );
    }

    if (action === 'register_verify') {
      const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
      const deviceName =
        typeof body.deviceName === 'string' ? body.deviceName : undefined;
      const responsePayload = body.response as RegistrationResponseJSON | undefined;

      if (!challengeId || !responsePayload || typeof responsePayload !== 'object') {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_PAYLOAD',
            error: 'challengeId and WebAuthn registration response are required',
          },
          { status: 400 }
        );
      }

      const verified = await finishPasskeyRegistration(db, {
        userId: profile.id,
        challengeId,
        response: responsePayload,
        deviceName,
      });

      return NextResponse.json(
        {
          success: verified.verified,
          code: verified.code,
          credentialId: verified.credentialId,
          error: verified.error,
        },
        { status: verified.verified ? 201 : 403 }
      );
    }

    if (action === 'step_up_options') {
      const stepUp = await beginPasskeyStepUp(db, {
        userId: profile.id,
        purpose: 'admin_step_up',
      });

      if (!stepUp.ok) {
        return NextResponse.json(
          {
            success: false,
            code: stepUp.code,
            error: stepUp.error,
          },
          { status: 403 }
        );
      }

      return NextResponse.json(
        {
          success: true,
          challengeId: stepUp.challengeId,
          options: stepUp.options,
          expiresAt: stepUp.expiresAt,
        },
        { status: 200 }
      );
    }

    if (action === 'step_up_verify') {
      const challengeId = typeof body.challengeId === 'string' ? body.challengeId : '';
      const responsePayload = body.response as AuthenticationResponseJSON | undefined;

      if (!challengeId || !responsePayload || typeof responsePayload !== 'object') {
        return NextResponse.json(
          {
            success: false,
            code: 'INVALID_PAYLOAD',
            error: 'challengeId and WebAuthn authentication response are required',
          },
          { status: 400 }
        );
      }

      const verified = await finishPasskeyStepUp(db, {
        userId: profile.id,
        challengeId,
        purpose: 'admin_step_up',
        response: responsePayload,
      });

      return NextResponse.json(
        {
          success: verified.verified,
          code: verified.code,
          stepUpToken: verified.stepUpToken,
          expiresAt: verified.expiresAt,
          error: verified.error,
        },
        { status: verified.verified ? 200 : 403 }
      );
    }

    return NextResponse.json(
      {
        success: false,
        code: 'UNKNOWN_ACTION',
        error: `Unsupported passkey action '${action}'`,
      },
      { status: 400 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
