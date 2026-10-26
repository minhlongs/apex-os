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
import { error as logError, warn as logWarn } from '@/lib/logger';

export type SupportedChain = 'ethereum' | 'solana' | 'stellar';

export const SUPPORTED_CHAINS: readonly SupportedChain[] = ['ethereum', 'solana', 'stellar'] as const;

export const CHAIN_ADDRESS_REGEX: Record<SupportedChain, RegExp> = {
  ethereum: /^0x[0-9a-fA-F]{40}$/,
  solana: /^[1-9A-HJ-NP-Za-km-z]{32,44}$/,
  stellar: /^G[A-Z2-7]{55}$/,
};

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
 * Validates wallet address against the specified chain standard
 */
export function validateWalletAddress(address: string, chain: SupportedChain): boolean {
  const regex = CHAIN_ADDRESS_REGEX[chain];
  if (!regex) return false;
  return regex.test(address);
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

    const normalizedChain = rawChain.trim().toLowerCase() as SupportedChain;
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

    // 3. Acquire database
    const db = getDatabase();
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
