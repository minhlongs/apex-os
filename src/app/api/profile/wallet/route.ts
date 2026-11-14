/**
 * src/app/api/profile/wallet/route.ts
 *
 * Feature F7: Wallet Address Validation & Association
 * Milestone M4: Mobile Wallet, Push, & Analytics
 *
 * Endpoints:
 * - POST /api/profile/wallet: Validate & bind wallet address to user profile
 * - GET /api/profile/wallet: Fetch user's current bound wallet & chain
 * - DELETE /api/profile/wallet: Disconnect/unbind wallet from user profile
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDB, type D1Database } from '@/lib/db';
import { getAuthenticatedUser, resolveDatabase } from '@/lib/auth/session-helper';
import { isAscendancyGuardActive } from '@/lib/compliance/legacy-route-guards';
import { error as logError, warn as logWarn } from '@/lib/logger';
import {
  isPhase1PayoutChain,
  proposeTimelockedWalletChange,
} from '@/lib/wallet/timelock-wallet-service';
import {
  SUPPORTED_CHAINS,
  validateWalletAddress,
  type SupportedChain,
} from '@/lib/wallet/address-validation';

export type { SupportedChain };

function getDatabase(): D1Database | null {
  try {
    const db = resolveDatabase();
    if (db) return db;
  } catch {
    // Fallback below
  }
  try {
    return getDB();
  } catch {
    const globalDb = (globalThis as unknown as { DB?: D1Database }).DB;
    return globalDb || null;
  }
}

/**
 * POST /api/profile/wallet
 * Associates a cryptocurrency wallet with the authenticated user profile.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    // 1. Authenticate user
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // 2. Parse request body
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: 'Invalid JSON request body' },
        { status: 400 }
      );
    }

    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { success: false, error: 'Missing request body' },
        { status: 400 }
      );
    }

    const rawAddress = body.wallet_address ?? body.walletAddress;
    const rawChain = body.preferred_chain ?? body.preferredChain ?? body.chain;

    if (!rawChain || typeof rawChain !== 'string') {
      return NextResponse.json(
        { success: false, error: 'Unsupported blockchain network: preferred_chain is required' },
        { status: 400 }
      );
    }

    const normalizedInputChain = rawChain.trim().toLowerCase();

    // 3. Acquire database early so Phase 1 48h Timelock & Chain Gate can run before legacy checks
    const db = getDatabase();
    if (await isAscendancyGuardActive(db, 'wallet_change_requests')) {
      if (!db) {
        return NextResponse.json(
          { success: false, error: 'Database service unavailable' },
          { status: 503 }
        );
      }
      if (!isPhase1PayoutChain(normalizedInputChain)) {
        return NextResponse.json(
          {
            success: false,
            code: 'PHASE1_CHAIN_DISABLED',
            error: `Unsupported payout network '${rawChain}'. Phase 1 supports only: stellar, arbitrum, base.`,
          },
          { status: 400 }
        );
      }
      if (!rawAddress || typeof rawAddress !== 'string' || rawAddress.trim().length === 0) {
        return NextResponse.json(
          { success: false, code: 'INVALID_WALLET_ADDRESS', error: 'Invalid wallet address format for network' },
          { status: 400 }
        );
      }
      const timelockProposal = await proposeTimelockedWalletChange(db, {
        authenticatedUserId: user.id,
        proposedAddress: rawAddress.trim(),
        proposedChain: normalizedInputChain,
        requestedIp:
          request.headers.get('cf-connecting-ip') ??
          request.headers.get('x-forwarded-for') ??
          null,
      });
      if (!timelockProposal.success) {
        return NextResponse.json(
          {
            success: false,
            code: timelockProposal.code,
            error: timelockProposal.error,
          },
          { status: timelockProposal.status }
        );
      }
      return NextResponse.json(
        {
          success: true,
          timelocked: true,
          code: timelockProposal.code,
          unlockAt: timelockProposal.request?.unlock_at ?? null,
          request: timelockProposal.request,
        },
        { status: 202 }
      );
    }

    const normalizedChain = normalizedInputChain as SupportedChain;
    if (!SUPPORTED_CHAINS.includes(normalizedChain)) {
      return NextResponse.json(
        { success: false, error: `Unsupported blockchain network: '${rawChain}'` },
        { status: 400 }
      );
    }

    if (!rawAddress || typeof rawAddress !== 'string' || rawAddress.trim().length === 0) {
      return NextResponse.json(
        { success: false, error: 'Invalid wallet address format for network' },
        { status: 400 }
      );
    }

    const cleanAddress = rawAddress.trim();
    if (!validateWalletAddress(cleanAddress, normalizedChain)) {
      return NextResponse.json(
        { success: false, error: `Invalid wallet address format for ${normalizedChain} network` },
        { status: 400 }
      );
    }

    if (!db) {
      logError('[Profile:Wallet] Database service unavailable');
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    // 4. Update user profile (matches billing-test-harness positional parameters: [wallet, chain, userId])
    await db
      .prepare(
        "UPDATE profiles SET wallet_address = ?, preferred_chain = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(cleanAddress, normalizedChain, user.id)
      .run();

    // 5. Record primary connection in wallet_connections
    try {
      await db
        .prepare(
          `INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain, is_primary, connected_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
           ON CONFLICT (profile_id, wallet_address) DO UPDATE SET
             preferred_chain = excluded.preferred_chain,
             is_primary = excluded.is_primary,
             last_used_at = datetime('now')`
        )
        .bind(crypto.randomUUID(), user.id, cleanAddress, normalizedChain, 1)
        .run();
    } catch {
      try {
        await db
          .prepare(
            'INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain, is_primary) VALUES (?, ?, ?, ?, 1)'
          )
          .bind(crypto.randomUUID(), user.id, cleanAddress, normalizedChain)
          .run();
      } catch (wcErr) {
        logWarn('[Profile:Wallet] Optional wallet_connections upsert notice:', wcErr);
      }
    }

    return NextResponse.json(
      {
        success: true,
        data: {
          wallet_address: cleanAddress,
          preferred_chain: normalizedChain,
          walletAddress: cleanAddress,
          preferredChain: normalizedChain,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:Wallet] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/profile/wallet
 * Returns the currently associated wallet for the authenticated user.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const db = getDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    const profile = await db
      .prepare('SELECT wallet_address, preferred_chain FROM profiles WHERE id = ?')
      .bind(user.id)
      .first<{ wallet_address?: string | null; preferred_chain?: string | null }>();

    return NextResponse.json(
      {
        success: true,
        data: {
          wallet_address: profile?.wallet_address ?? null,
          preferred_chain: profile?.preferred_chain ?? null,
        },
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:Wallet:GET] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}

/**
 * DELETE /api/profile/wallet
 * Disconnects the wallet address from the authenticated user profile.
 */
export async function DELETE(request: NextRequest): Promise<NextResponse> {
  try {
    const user = await getAuthenticatedUser(request);
    if (!user || !user.id) {
      return NextResponse.json(
        { success: false, error: 'Unauthorized' },
        { status: 401 }
      );
    }

    const db = getDatabase();
    if (!db) {
      return NextResponse.json(
        { success: false, error: 'Database service unavailable' },
        { status: 503 }
      );
    }

    if (await isAscendancyGuardActive(db, 'wallet_change_requests')) {
      return NextResponse.json(
        {
          success: false,
          code: 'USE_WALLET_TIMELOCK_ENDPOINT',
          error:
            'Direct payout wallet unbinding is disabled to prevent 48-hour timelock bypass; manage pending wallet changes via /api/profile/wallet/timelock',
        },
        { status: 409 }
      );
    }

    // Positional parameters match billing-test-harness: [wallet, chain, userId]
    await db
      .prepare(
        "UPDATE profiles SET wallet_address = ?, preferred_chain = ?, updated_at = datetime('now') WHERE id = ?"
      )
      .bind(null, null, user.id)
      .run();

    try {
      await db
        .prepare('DELETE FROM wallet_connections WHERE profile_id = ?')
        .bind(user.id)
        .run();
    } catch (wcErr) {
      logWarn('[Profile:Wallet:DELETE] Optional wallet_connections deletion notice:', wcErr);
    }

    return NextResponse.json(
      {
        success: true,
        disconnected: true,
        message: 'Wallet disconnected successfully',
      },
      { status: 200 }
    );
  } catch (error) {
    logError('[Profile:Wallet:DELETE] Unexpected error:', error);
    return NextResponse.json(
      { success: false, error: error instanceof Error ? error.message : 'Internal Server Error' },
      { status: 500 }
    );
  }
}
