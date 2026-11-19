/**
 * 48-Hour Timelocked Payout Wallet API Route
 *
 * Endpoints:
 * - GET    /api/profile/wallet/timelock -> Owner-scoped timelock history & payout unlock state
 * - POST   /api/profile/wallet/timelock -> Propose Phase 1 wallet change (48h PENDING_TIMELOCK)
 * - PATCH  /api/profile/wallet/timelock -> Activate matured request or emergency cancel
 * - DELETE /api/profile/wallet/timelock -> Emergency cancel pending wallet change by owner
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { extractIpAddress } from '@/lib/ratelimit/rate-limiter';
import {
  proposeTimelockedWalletChange,
  activateMaturedWalletChange,
  cancelWalletChangeByOwner,
  isWalletUnlockedForPayout,
  listWalletChangeRequestsForOwner,
} from '@/lib/wallet/timelock-wallet-service';
import { sanitizeApiErrorResponse } from '@/lib/auth/passkey-step-up';
import {
  buildD1RateLimitResponse,
  enforcePersistentD1RateLimit,
} from '@/lib/security/d1-rate-limiter';
import {
  buildCsrfForbiddenResponse,
  verifyTrustedMutationOrigin,
} from '@/lib/security/http-hardening';

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
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const url = new URL(request.url);
    const requestedProfileId =
      url.searchParams.get('profile_id') ??
      url.searchParams.get('profileId') ??
      url.searchParams.get('user_id') ??
      url.searchParams.get('userId');

    const listResult = await listWalletChangeRequestsForOwner(
      db,
      user.id,
      requestedProfileId
    );

    if (!listResult.allowed) {
      return NextResponse.json(
        {
          success: false,
          code: 'IDOR_FORBIDDEN',
          error: 'Forbidden: Cross-account wallet access denied',
        },
        { status: 403 }
      );
    }

    const payoutStatus = await isWalletUnlockedForPayout(db, user.id);

    return NextResponse.json(
      {
        success: true,
        payoutStatus,
        requests: listResult.requests,
      },
      { status: 200 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfDecision = verifyTrustedMutationOrigin(request);
    if (!csrfDecision.allowed) {
      return buildCsrfForbiddenResponse(csrfDecision);
    }

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
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const rateCheck = await enforcePersistentD1RateLimit(db, {
      endpointType: 'wallet_timelock_post_user',
      identifier: user.id,
      maxRequests: 20,
      windowSeconds: 60,
    });
    if (!rateCheck.allowed) {
      return buildD1RateLimitResponse(rateCheck);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const targetProfileIdRaw =
      body.profile_id ?? body.profileId ?? body.user_id ?? body.userId;
    const targetProfileId =
      typeof targetProfileIdRaw === 'string' ? targetProfileIdRaw : undefined;

    const rawAddress =
      body.proposed_address ??
      body.proposedAddress ??
      body.wallet_address ??
      body.walletAddress ??
      body.address;
    const rawChain =
      body.proposed_chain ??
      body.proposedChain ??
      body.preferred_chain ??
      body.preferredChain ??
      body.chain;

    if (typeof rawAddress !== 'string' || typeof rawChain !== 'string') {
      return NextResponse.json(
        {
          success: false,
          code: 'INVALID_PAYLOAD',
          error: 'proposedAddress and proposedChain are required strings',
        },
        { status: 400 }
      );
    }

    const result = await proposeTimelockedWalletChange(db, {
      authenticatedUserId: user.id,
      targetProfileId,
      proposedAddress: rawAddress,
      proposedChain: rawChain,
      requestedIp: extractIpAddress(request.headers),
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          code: result.code,
          error: result.error,
        },
        { status: result.status }
      );
    }

    return NextResponse.json(
      {
        success: true,
        code: result.code,
        request: result.request,
      },
      { status: 201 }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfDecision = verifyTrustedMutationOrigin(request);
    if (!csrfDecision.allowed) {
      return buildCsrfForbiddenResponse(csrfDecision);
    }

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
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const rateCheck = await enforcePersistentD1RateLimit(db, {
      endpointType: 'wallet_timelock_patch_user',
      identifier: user.id,
      maxRequests: 20,
      windowSeconds: 60,
    });
    if (!rateCheck.allowed) {
      return buildD1RateLimitResponse(rateCheck);
    }

    let body: Record<string, unknown>;
    try {
      body = (await request.json()) as Record<string, unknown>;
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    const targetProfileIdRaw =
      body.profile_id ?? body.profileId ?? body.user_id ?? body.userId;
    if (typeof targetProfileIdRaw === 'string' && targetProfileIdRaw !== user.id) {
      return NextResponse.json(
        {
          success: false,
          code: 'IDOR_FORBIDDEN',
          error: 'Forbidden: Cross-account wallet mutation denied',
        },
        { status: 403 }
      );
    }

    const requestId =
      typeof body.requestId === 'string'
        ? body.requestId
        : typeof body.request_id === 'string'
          ? body.request_id
          : '';
    const action =
      typeof body.action === 'string' ? body.action.trim().toLowerCase() : 'activate';

    if (!requestId) {
      return NextResponse.json(
        { success: false, code: 'INVALID_PAYLOAD', error: 'requestId is required' },
        { status: 400 }
      );
    }

    if (action === 'cancel') {
      const cancelResult = await cancelWalletChangeByOwner(db, user.id, requestId);
      return NextResponse.json(
        {
          success: cancelResult.success,
          code: cancelResult.code,
          error: cancelResult.error,
          request: cancelResult.request,
        },
        { status: cancelResult.status }
      );
    }

    const activateResult = await activateMaturedWalletChange(
      db,
      requestId,
      undefined,
      user.id
    );
    return NextResponse.json(
      {
        success: activateResult.success,
        code: activateResult.code,
        error: activateResult.error,
        unlockAt: activateResult.unlockAt,
        request: activateResult.request,
      },
      { status: activateResult.status }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}

export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const csrfDecision = verifyTrustedMutationOrigin(request);
    if (!csrfDecision.allowed) {
      return buildCsrfForbiddenResponse(csrfDecision);
    }

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
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const rateCheck = await enforcePersistentD1RateLimit(db, {
      endpointType: 'wallet_timelock_delete_user',
      identifier: user.id,
      maxRequests: 20,
      windowSeconds: 60,
    });
    if (!rateCheck.allowed) {
      return buildD1RateLimitResponse(rateCheck);
    }

    const url = new URL(request.url);
    let requestId =
      url.searchParams.get('requestId') ?? url.searchParams.get('request_id') ?? '';

    if (!requestId) {
      try {
        const body = (await request.json()) as Record<string, unknown>;
        if (typeof body.requestId === 'string') {
          requestId = body.requestId;
        } else if (typeof body.request_id === 'string') {
          requestId = body.request_id;
        }
      } catch {
        // Query param was empty and body was absent
      }
    }

    if (!requestId) {
      return NextResponse.json(
        { success: false, code: 'INVALID_PAYLOAD', error: 'requestId is required' },
        { status: 400 }
      );
    }

    const cancelResult = await cancelWalletChangeByOwner(db, user.id, requestId);
    return NextResponse.json(
      {
        success: cancelResult.success,
        code: cancelResult.code,
        error: cancelResult.error,
        request: cancelResult.request,
      },
      { status: cancelResult.status }
    );
  } catch (err: unknown) {
    return sanitizeApiErrorResponse(err, 500);
  }
}
