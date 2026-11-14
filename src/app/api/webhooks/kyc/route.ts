/**
 * src/app/api/webhooks/kyc/route.ts
 *
 * ApexOS KYC & Regulatory Compliance Engine
 * Edge-Compatible KYC Webhook Ingestion Route
 *
 * Receives provider webhooks (Sumsub / Persona / Mock), verifies HMAC-SHA256 signatures,
 * deduplicates idempotently, applies profile KYC tier transitions, and invokes the
 * Auto-Release Service for held payouts on approval with immutable audit logs.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import {
  SumsubAdapter,
  PersonaAdapter,
  MockKycAdapter,
  KycProviderAdapter,
} from '@/lib/compliance/provider';
import { releaseHeldPayouts } from '@/lib/compliance/auto-release-service';
import { complianceAuditService } from '@/lib/compliance/audit-service';
import * as logger from '@/lib/logger';

function resolveDatabase(request?: Request): D1Database | null {
  try {
    const reqDb = (request as any)?.env?.DB;
    if (reqDb) return reqDb;
    const db = getDB();
    if (db) return db;
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    if (globalDb) return globalDb;
  }
  return null;
}

/**
 * Detects the appropriate provider adapter from request headers or query params
 */
function resolveAdapter(request: NextRequest): KycProviderAdapter {
  const isTestEnv = process.env.NODE_ENV === 'test';
  const url = new URL(request.url);
  const providerParam = url.searchParams.get('provider')?.toLowerCase();

  // 1. Query parameter resolution (mock is strictly disallowed outside of test environment)
  if (providerParam === 'sumsub') return new SumsubAdapter();
  if (providerParam === 'persona') return new PersonaAdapter();
  if (providerParam === 'mock' && isTestEnv) {
    return new MockKycAdapter();
  }

  // 2. Header detection for production webhook providers
  if (
    request.headers.has('x-payload-digest') ||
    request.headers.has('x-payload-digest-alg')
  ) {
    return new SumsubAdapter();
  }

  if (
    request.headers.has('persona-signature') ||
    request.headers.has('x-persona-signature')
  ) {
    return new PersonaAdapter();
  }

  // 3. Server-side configured KYC_PROVIDER environment variable
  const envProvider =
    typeof process !== 'undefined' && process.env?.KYC_PROVIDER
      ? process.env.KYC_PROVIDER.toLowerCase()
      : '';

  if (envProvider === 'sumsub') return new SumsubAdapter();
  if (envProvider === 'persona') return new PersonaAdapter();
  if (envProvider === 'mock' && isTestEnv) {
    return new MockKycAdapter();
  }

  // 4. Default fallback: only allow Mock adapter in test environment; default to Sumsub in production / non-test
  if (isTestEnv) {
    return new MockKycAdapter();
  }
  return new SumsubAdapter();
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const db = resolveDatabase(request);
  if (!db) {
    return NextResponse.json(
      { success: false, error: 'Database unavailable' },
      { status: 503 }
    );
  }

  // 1. Resolve webhook secret & enforce production security guard
  const isProduction = process.env.NODE_ENV === 'production';
  const configuredSecret =
    process.env.KYC_WEBHOOK_SECRET ||
    (request as any)?.env?.KYC_WEBHOOK_SECRET;

  if (
    isProduction &&
    (!configuredSecret || configuredSecret === 'test_kyc_webhook_secret')
  ) {
    logger.error('[KYC Webhook] Insecure or missing webhook secret in production');
    return NextResponse.json(
      { error: 'Webhook secret is not configured' },
      { status: 500 }
    );
  }

  const secret = configuredSecret || (isProduction ? '' : 'test_kyc_webhook_secret');
  if (!secret) {
    logger.error('[KYC Webhook] Webhook secret is not configured');
    return NextResponse.json(
      { error: 'Webhook secret is not configured' },
      { status: 500 }
    );
  }

  // 2. Read raw request payload
  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch (err: any) {
    logger.error(`[KYC Webhook] Failed to read body: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Failed to read request body' },
      { status: 400 }
    );
  }

  if (!rawBody || rawBody.trim() === '') {
    return NextResponse.json(
      { success: false, error: 'Empty payload' },
      { status: 400 }
    );
  }

  // 3. Resolve adapter and verify HMAC signature
  const adapter = resolveAdapter(request);
  const isValidSignature = await adapter.verifySignature(
    rawBody,
    request.headers,
    secret
  );

  if (!isValidSignature) {
    logger.warn(`[KYC Webhook] Rejected invalid signature from ${adapter.providerName}`);
    return NextResponse.json(
      { success: false, error: 'Unauthorized: Invalid webhook signature' },
      { status: 401 }
    );
  }

  // 3b. Enforce Law 91/2025/QH15 data-minimization policy before mutating profiles or releasing payouts
  let kycDisabledByMigration = false;
  try {
    const sentinel = await db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'system_runtime_flags' LIMIT 1"
      )
      .first<{ name?: string }>();
    kycDisabledByMigration = sentinel?.name === 'system_runtime_flags';
  } catch {
    kycDisabledByMigration = false;
  }

  const isProdOrEnforced =
    isProduction ||
    process.env.APP_ENV === 'production' ||
    process.env.ENFORCE_ASCENDANCY_GUARDS === 'true' ||
    kycDisabledByMigration;

  if (isProdOrEnforced && process.env.ALLOW_LEGACY_KYC_SESSION_FOR_TESTS !== 'true') {
    return NextResponse.json(
      {
        success: false,
        code: 'KYC_DOCUMENT_COLLECTION_DISABLED',
        error:
          'Identity document KYC webhooks are disabled under Law 91/2025/QH15 data-minimization policy.',
      },
      { status: 410 }
    );
  }

  // 4. Parse standardized event
  let event: any;
  try {
    event = await adapter.parseWebhook(rawBody, request.headers);
  } catch (err: any) {
    logger.error(`[KYC Webhook] Payload parsing failed: ${err?.message || String(err)}`);
    return NextResponse.json(
      { success: false, error: 'Malformed webhook payload' },
      { status: 400 }
    );
  }

  if (!event.userId) {
    logger.error('[KYC Webhook] Missing userId in standardized event');
    return NextResponse.json(
      { success: false, error: 'Missing userId in payload' },
      { status: 400 }
    );
  }

  try {
    // 5. Query user profile for existence and idempotency check
    const existingProfile = await db
      .prepare('SELECT id, kyc_status, kyc_tier FROM profiles WHERE id = ?')
      .bind(event.userId)
      .first<{ id: string; kyc_status: string; kyc_tier: string }>();

    // Requirement 5: Profile Existence Validation
    if (!existingProfile) {
      logger.warn(`[KYC Webhook] User profile not found for userId: ${event.userId}`);
      return NextResponse.json(
        { error: 'User profile not found' },
        { status: 404 }
      );
    }

    // Requirement 4: Full Idempotency for ALL Webhook Statuses
    if (existingProfile.kyc_status === event.status) {
      logger.info(
        `[KYC Webhook] Idempotent deduplication for user ${event.userId} (status: ${event.status})`
      );
      return NextResponse.json(
        { success: true, status: event.status, deduped: true },
        { status: 200 }
      );
    }

    // 6. Handle verification event lifecycle
    if (event.status === 'approved') {
      // Update profile to approved tier2_enhanced
      await db
        .prepare(`
          UPDATE profiles
          SET kyc_status = 'approved',
              kyc_tier = 'tier2_enhanced',
              kyc_verified_at = datetime('now'),
              updated_at = datetime('now')
          WHERE id = ?
        `)
        .bind(event.userId)
        .run();

      // Automatically unhold all payouts on KYC compliance hold
      const releaseResult = await releaseHeldPayouts(db, event.userId);

      // Record compliance audit log
      await complianceAuditService.log(db, {
        action: 'kyc_auto_release',
        severity: 'low',
        actorId: adapter.providerName,
        targetId: event.userId,
        details: {
          event: 'approved',
          provider: adapter.providerName,
          tier: 'tier2_enhanced',
          releasedPayoutsCount: releaseResult.releasedPayoutsCount,
          releasedPayoutIds: releaseResult.releasedPayoutIds,
          totalAmount: releaseResult.totalAmount,
        },
      });

      logger.info(
        `[KYC Webhook] Successfully verified user ${event.userId}, released ${releaseResult.releasedPayoutsCount} payouts`
      );
    } else if (event.status === 'rejected') {
      // Update profile to rejected
      await db
        .prepare(`
          UPDATE profiles
          SET kyc_status = 'rejected',
              updated_at = datetime('now')
          WHERE id = ?
        `)
        .bind(event.userId)
        .run();

      // Audit log
      await complianceAuditService.log(db, {
        action: 'admin_reject',
        severity: 'high',
        actorId: adapter.providerName,
        targetId: event.userId,
        details: {
          event: 'rejected',
          provider: adapter.providerName,
          rawPayload: event.rawPayload,
        },
      });

      logger.warn(`[KYC Webhook] Verification rejected for user ${event.userId}`);
    } else {
      // requires_action
      await db
        .prepare(`
          UPDATE profiles
          SET kyc_status = 'requires_action',
              updated_at = datetime('now')
          WHERE id = ?
        `)
        .bind(event.userId)
        .run();

      await complianceAuditService.log(db, {
        action: 'kyc_tier_hold',
        severity: 'medium',
        actorId: adapter.providerName,
        targetId: event.userId,
        details: {
          event: 'requires_action',
          provider: adapter.providerName,
          rawPayload: event.rawPayload,
        },
      });

      logger.info(`[KYC Webhook] Verification requires action for user ${event.userId}`);
    }

    return NextResponse.json(
      { success: true, status: event.status },
      { status: 200 }
    );
  } catch (err: any) {
    logger.error(
      `[KYC Webhook] Error processing event for ${event.userId}: ${err?.message || String(err)}`
    );
    return NextResponse.json(
      { success: false, error: 'Internal Server Error' },
      { status: 500 }
    );
  }
}
