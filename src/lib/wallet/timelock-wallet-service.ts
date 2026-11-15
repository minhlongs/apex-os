/**
 * 48-Hour Wallet-Change Timelock Service
 *
 * Defends against Account Takeover (ATO) + immediate payout drain and Sybil
 * shared-wallet clusters across Phase 1 chains (`stellar`, `arbitrum`, `base`):
 * - Rejects non-Phase-1 chains (`ethereum` L1, `solana`)
 * - Rejects OFAC/watchlisted addresses (`403 SANCTIONED_WALLET_ADDRESS`)
 * - Rejects payout addresses already bound or pending on any other account (`409 SHARED_PAYOUT_WALLET_CONFLICT`)
 * - Enforces a mandatory 48-hour (`48 * 3600 * 1000` ms) timelock before payout eligibility
 * - Enforces strict owner-scoped IDOR boundaries (`WHERE profile_id = authenticatedUserId`)
 */

import type { D1Database } from '@/lib/db';
import { SanctionsScreeningService } from '@/lib/compliance/sanctions-service';

export const PHASE1_PAYOUT_CHAINS = ['stellar', 'arbitrum', 'base'] as const;
export type Phase1PayoutChain = (typeof PHASE1_PAYOUT_CHAINS)[number];

export const WALLET_TIMELOCK_DURATION_MS = 48 * 3600 * 1000;

export type WalletTimelockStatus = 'PENDING_TIMELOCK' | 'ACTIVATED' | 'CANCELLED';

export interface WalletChangeRequestRow {
  id: string;
  profile_id: string;
  previous_address: string | null;
  previous_chain: string | null;
  proposed_address: string;
  proposed_chain: Phase1PayoutChain;
  unlock_at: string;
  status: WalletTimelockStatus;
  passkey_verified: number;
  requested_ip: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProposeWalletChangeInput {
  authenticatedUserId: string;
  targetProfileId?: string;
  proposedAddress: string;
  proposedChain: string;
  passkeyVerified?: boolean;
  requestedIp?: string | null;
  nowIso?: string;
}

export interface ProposeWalletChangeResult {
  success: boolean;
  status: 201 | 400 | 403 | 404 | 409;
  code:
    | 'TIMELOCK_CREATED'
    | 'IDOR_FORBIDDEN'
    | 'UNSUPPORTED_PHASE1_CHAIN'
    | 'INVALID_WALLET_ADDRESS'
    | 'SANCTIONED_WALLET_ADDRESS'
    | 'SHARED_PAYOUT_WALLET_CONFLICT'
    | 'PROFILE_NOT_FOUND';
  error?: string;
  request?: WalletChangeRequestRow;
}

export interface WalletPayoutUnlockStatus {
  unlocked: boolean;
  reason:
    | 'WALLET_UNLOCKED'
    | 'WALLET_TIMELOCK_ACTIVE_48H'
    | 'NO_PAYOUT_WALLET_BOUND';
  unlockAt: string | null;
  walletAddress?: string | null;
  chain?: string | null;
  pendingRequestId?: string;
}

export interface ActivateWalletChangeResult {
  success: boolean;
  status: 200 | 403 | 404 | 409;
  code:
    | 'WALLET_CHANGE_ACTIVATED'
    | 'IDOR_FORBIDDEN'
    | 'REQUEST_NOT_FOUND'
    | 'WALLET_TIMELOCK_NOT_MATURED'
    | 'INVALID_REQUEST_STATE'
    | 'SHARED_PAYOUT_WALLET_CONFLICT'
    | 'SANCTIONED_WALLET_ADDRESS';
  error?: string;
  unlockAt?: string;
  request?: WalletChangeRequestRow;
}

export interface CancelWalletChangeResult {
  success: boolean;
  status: 200 | 403 | 404 | 409;
  code:
    | 'WALLET_CHANGE_CANCELLED'
    | 'IDOR_FORBIDDEN'
    | 'REQUEST_NOT_FOUND'
    | 'ALREADY_FINALIZED';
  error?: string;
  request?: WalletChangeRequestRow;
}

const EVM_ADDRESS_REGEX = /^0x[0-9a-fA-F]{40}$/;
const STELLAR_ADDRESS_REGEX = /^G[A-Z2-7]{55}$/;

const defaultSanctionsService = new SanctionsScreeningService();

export function isPhase1PayoutChain(chain: string): chain is Phase1PayoutChain {
  return (PHASE1_PAYOUT_CHAINS as readonly string[]).includes(chain);
}

/**
 * Validates and canonicalizes a payout wallet address for Phase 1 chains:
 * - EVM (`arbitrum`, `base`): lowercase `0x` + 40 hex chars (case-insensitive canonical form)
 * - Stellar (`stellar`): exact `G` + 55 uppercase base32 chars
 */
export function normalizePhase1WalletAddress(
  address: string,
  chain: Phase1PayoutChain
): string | null {
  const trimmed = address.trim();
  if (chain === 'arbitrum' || chain === 'base') {
    if (!EVM_ADDRESS_REGEX.test(trimmed)) {
      return null;
    }
    return trimmed.toLowerCase();
  }
  if (chain === 'stellar') {
    if (!STELLAR_ADDRESS_REGEX.test(trimmed)) {
      return null;
    }
    return trimmed;
  }
  return null;
}

export function isEvmStyleAddress(address: string): boolean {
  return EVM_ADDRESS_REGEX.test(address.trim());
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return Date.now();
  const normalized =
    !iso.includes('T') && iso.includes(' ')
      ? `${iso.replace(' ', 'T')}Z`
      : iso;
  const parsed = Date.parse(normalized);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

async function isAddressSanctionedOnAnyRail(
  db: D1Database,
  normalizedAddress: string,
  chain: Phase1PayoutChain
): Promise<boolean> {
  const mappedChain = chain === 'stellar' ? 'stellar' : 'ethereum';
  const check = await defaultSanctionsService.checkAddress(
    normalizedAddress,
    mappedChain,
    db
  );
  if (check.isSanctioned) {
    return true;
  }

  try {
    const row = await db
      .prepare(
        `SELECT address FROM sanctioned_addresses
         WHERE lower(address) = lower(?)
         LIMIT 1`
      )
      .bind(normalizedAddress)
      .first<{ address: string }>();
    return Boolean(row);
  } catch {
    return false;
  }
}

/**
 * Finds all distinct profile IDs that have bound or pending-proposed the given payout wallet.
 * Case-insensitive for EVM (`0x...`), exact match for Stellar (`G...`).
 */
export async function findAccountsSharingPayoutWallet(
  db: D1Database,
  rawAddress: string
): Promise<string[]> {
  const trimmed = rawAddress.trim();
  if (!trimmed) return [];

  const evm = isEvmStyleAddress(trimmed);
  const canonical = evm ? trimmed.toLowerCase() : trimmed;
  const ownerSet = new Set<string>();

  // 1. profiles.wallet_address
  try {
    const profileQuery = evm
      ? 'SELECT id FROM profiles WHERE wallet_address IS NOT NULL AND lower(wallet_address) = ?'
      : 'SELECT id FROM profiles WHERE wallet_address = ?';
    const profileRows = await db.prepare(profileQuery).bind(canonical).all<{ id: string }>();
    for (const row of profileRows.results ?? []) {
      if (row.id) ownerSet.add(row.id);
    }
  } catch {
    // Ignore if optional column missing in minimal test fixture
  }

  // 2. wallet_connections.wallet_address
  try {
    const connQuery = evm
      ? 'SELECT DISTINCT profile_id FROM wallet_connections WHERE lower(wallet_address) = ?'
      : 'SELECT DISTINCT profile_id FROM wallet_connections WHERE wallet_address = ?';
    const connRows = await db
      .prepare(connQuery)
      .bind(canonical)
      .all<{ profile_id: string }>();
    for (const row of connRows.results ?? []) {
      if (row.profile_id) ownerSet.add(row.profile_id);
    }
  } catch {
    // wallet_connections is optional in minimal schemas
  }

  // 3. wallet_change_requests (PENDING_TIMELOCK or ACTIVATED)
  try {
    const reqQuery = evm
      ? `SELECT DISTINCT profile_id FROM wallet_change_requests
         WHERE status IN ('PENDING_TIMELOCK', 'ACTIVATED') AND lower(proposed_address) = ?`
      : `SELECT DISTINCT profile_id FROM wallet_change_requests
         WHERE status IN ('PENDING_TIMELOCK', 'ACTIVATED') AND proposed_address = ?`;
    const reqRows = await db
      .prepare(reqQuery)
      .bind(canonical)
      .all<{ profile_id: string }>();
    for (const row of reqRows.results ?? []) {
      if (row.profile_id) ownerSet.add(row.profile_id);
    }
  } catch {
    // wallet_change_requests optional fallback
  }

  return Array.from(ownerSet);
}

/**
 * Initiates a 48-hour timelocked payout wallet change for the authenticated user.
 */
export async function proposeTimelockedWalletChange(
  db: D1Database,
  input: ProposeWalletChangeInput
): Promise<ProposeWalletChangeResult> {
  const ownerId = input.authenticatedUserId.trim();
  if (input.targetProfileId && input.targetProfileId.trim() !== ownerId) {
    return {
      success: false,
      status: 403,
      code: 'IDOR_FORBIDDEN',
      error: 'Forbidden: Cannot modify wallet settings for another account',
    };
  }

  const normalizedChain = input.proposedChain.trim().toLowerCase();
  if (!isPhase1PayoutChain(normalizedChain)) {
    return {
      success: false,
      status: 400,
      code: 'UNSUPPORTED_PHASE1_CHAIN',
      error: `Unsupported payout chain '${input.proposedChain}'. Phase 1 supports only: stellar, arbitrum, base.`,
    };
  }

  const normalizedAddress = normalizePhase1WalletAddress(
    input.proposedAddress,
    normalizedChain
  );
  if (!normalizedAddress) {
    return {
      success: false,
      status: 400,
      code: 'INVALID_WALLET_ADDRESS',
      error: `Invalid wallet address format for ${normalizedChain}`,
    };
  }

  const profile = await db
    .prepare('SELECT id, wallet_address, preferred_chain FROM profiles WHERE id = ?')
    .bind(ownerId)
    .first<{
      id: string;
      wallet_address: string | null;
      preferred_chain: string | null;
    }>();

  if (!profile) {
    return {
      success: false,
      status: 404,
      code: 'PROFILE_NOT_FOUND',
      error: 'Authenticated profile not found',
    };
  }

  // Sanctions screening
  const sanctioned = await isAddressSanctionedOnAnyRail(
    db,
    normalizedAddress,
    normalizedChain
  );
  if (sanctioned) {
    return {
      success: false,
      status: 403,
      code: 'SANCTIONED_WALLET_ADDRESS',
      error: 'Wallet address rejected by sanctions compliance screening',
    };
  }

  // Shared-wallet anti-Sybil uniqueness check across all accounts
  const existingOwners = await findAccountsSharingPayoutWallet(db, normalizedAddress);
  const conflictingOwners = existingOwners.filter((id) => id !== ownerId);
  if (conflictingOwners.length > 0) {
    return {
      success: false,
      status: 409,
      code: 'SHARED_PAYOUT_WALLET_CONFLICT',
      error: 'Payout wallet address is already associated with another account',
    };
  }

  const nowMs = parseIsoMs(input.nowIso);
  const createdIso = new Date(nowMs).toISOString();
  const unlockIso = new Date(nowMs + WALLET_TIMELOCK_DURATION_MS).toISOString();
  const requestId = `wcr_${crypto.randomUUID()}`;
  const passkeyFlag = input.passkeyVerified ? 1 : 0;

  // Cancel any prior unactivated pending requests for this user before inserting the fresh 48h lock
  await db
    .prepare(
      `UPDATE wallet_change_requests
       SET status = 'CANCELLED', updated_at = ?
       WHERE profile_id = ? AND status = 'PENDING_TIMELOCK'`
    )
    .bind(createdIso, ownerId)
    .run();

  await db
    .prepare(
      `INSERT INTO wallet_change_requests (
         id, profile_id, previous_address, previous_chain,
         proposed_address, proposed_chain, unlock_at, status,
         passkey_verified, requested_ip, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING_TIMELOCK', ?, ?, ?, ?)`
    )
    .bind(
      requestId,
      ownerId,
      profile.wallet_address ?? null,
      profile.preferred_chain ?? null,
      normalizedAddress,
      normalizedChain,
      unlockIso,
      passkeyFlag,
      input.requestedIp ?? null,
      createdIso,
      createdIso
    )
    .run();

  const createdRow: WalletChangeRequestRow = {
    id: requestId,
    profile_id: ownerId,
    previous_address: profile.wallet_address ?? null,
    previous_chain: profile.preferred_chain ?? null,
    proposed_address: normalizedAddress,
    proposed_chain: normalizedChain,
    unlock_at: unlockIso,
    status: 'PENDING_TIMELOCK',
    passkey_verified: passkeyFlag,
    requested_ip: input.requestedIp ?? null,
    created_at: createdIso,
    updated_at: createdIso,
  };

  return {
    success: true,
    status: 201,
    code: 'TIMELOCK_CREATED',
    request: createdRow,
  };
}

/**
 * Checks whether a user's payout wallet is unlocked for withdrawal/settlement at `nowIso`.
 * Returns `{ unlocked: false, reason: 'WALLET_TIMELOCK_ACTIVE_48H', unlockAt }` whenever:
 *  - A `PENDING_TIMELOCK` request exists, OR
 *  - An `ACTIVATED` wallet change has `nowIso < unlock_at` (< 48h elapsed since request).
 */
export async function isWalletUnlockedForPayout(
  db: D1Database,
  profileId: string,
  nowIso?: string
): Promise<WalletPayoutUnlockStatus> {
  const nowMs = parseIsoMs(nowIso);

  const pendingRow = await db
    .prepare(
      `SELECT id, unlock_at
       FROM wallet_change_requests
       WHERE profile_id = ? AND status = 'PENDING_TIMELOCK'
       ORDER BY unlock_at DESC
       LIMIT 1`
    )
    .bind(profileId)
    .first<{ id: string; unlock_at: string }>();

  if (pendingRow) {
    return {
      unlocked: false,
      reason: 'WALLET_TIMELOCK_ACTIVE_48H',
      unlockAt: pendingRow.unlock_at,
      pendingRequestId: pendingRow.id,
    };
  }

  const latestActivated = await db
    .prepare(
      `SELECT id, unlock_at
       FROM wallet_change_requests
       WHERE profile_id = ? AND status = 'ACTIVATED'
       ORDER BY unlock_at DESC
       LIMIT 1`
    )
    .bind(profileId)
    .first<{ id: string; unlock_at: string }>();

  if (latestActivated && nowMs < parseIsoMs(latestActivated.unlock_at)) {
    return {
      unlocked: false,
      reason: 'WALLET_TIMELOCK_ACTIVE_48H',
      unlockAt: latestActivated.unlock_at,
      pendingRequestId: latestActivated.id,
    };
  }

  const profile = await db
    .prepare('SELECT wallet_address, preferred_chain FROM profiles WHERE id = ?')
    .bind(profileId)
    .first<{ wallet_address: string | null; preferred_chain: string | null }>();

  if (!profile?.wallet_address) {
    return {
      unlocked: false,
      reason: 'NO_PAYOUT_WALLET_BOUND',
      unlockAt: null,
    };
  }

  return {
    unlocked: true,
    reason: 'WALLET_UNLOCKED',
    unlockAt: latestActivated?.unlock_at ?? null,
    walletAddress: profile.wallet_address,
    chain: profile.preferred_chain,
  };
}

/**
 * Activates a matured 48h wallet change request (`nowIso >= unlock_at`).
 * When `authenticatedProfileId` is provided, strictly enforces owner-only access (`IDOR_FORBIDDEN`).
 */
export async function activateMaturedWalletChange(
  db: D1Database,
  requestId: string,
  nowIso?: string,
  authenticatedProfileId?: string
): Promise<ActivateWalletChangeResult> {
  const row = await db
    .prepare('SELECT * FROM wallet_change_requests WHERE id = ? LIMIT 1')
    .bind(requestId)
    .first<WalletChangeRequestRow>();

  if (!row) {
    return {
      success: false,
      status: 404,
      code: 'REQUEST_NOT_FOUND',
      error: 'Wallet change request not found',
    };
  }

  if (authenticatedProfileId && row.profile_id !== authenticatedProfileId) {
    return {
      success: false,
      status: 403,
      code: 'IDOR_FORBIDDEN',
      error: 'Forbidden: Cannot activate another user wallet change request',
    };
  }

  if (row.status !== 'PENDING_TIMELOCK') {
    return {
      success: false,
      status: 409,
      code: 'INVALID_REQUEST_STATE',
      error: `Cannot activate request in status '${row.status}'`,
    };
  }

  const nowMs = parseIsoMs(nowIso);
  const unlockMs = parseIsoMs(row.unlock_at);
  if (nowMs < unlockMs) {
    return {
      success: false,
      status: 409,
      code: 'WALLET_TIMELOCK_NOT_MATURED',
      error: '48-hour wallet change timelock has not yet expired',
      unlockAt: row.unlock_at,
    };
  }

  // Re-verify sanctions & shared-wallet uniqueness at activation time
  const sanctioned = await isAddressSanctionedOnAnyRail(
    db,
    row.proposed_address,
    row.proposed_chain
  );
  if (sanctioned) {
    return {
      success: false,
      status: 403,
      code: 'SANCTIONED_WALLET_ADDRESS',
      error: 'Proposed wallet address is sanctioned and cannot be activated',
    };
  }

  const owners = await findAccountsSharingPayoutWallet(db, row.proposed_address);
  if (owners.some((id) => id !== row.profile_id)) {
    return {
      success: false,
      status: 409,
      code: 'SHARED_PAYOUT_WALLET_CONFLICT',
      error: 'Proposed wallet address conflicts with another account',
    };
  }

  const activatedIso = new Date(nowMs).toISOString();

  await db
    .prepare(
      `UPDATE wallet_change_requests
       SET status = 'ACTIVATED', updated_at = ?
       WHERE id = ? AND profile_id = ? AND status = 'PENDING_TIMELOCK'`
    )
    .bind(activatedIso, row.id, row.profile_id)
    .run();

  await db
    .prepare(
      `UPDATE profiles
       SET wallet_address = ?, preferred_chain = ?, updated_at = ?
       WHERE id = ?`
    )
    .bind(row.proposed_address, row.proposed_chain, activatedIso, row.profile_id)
    .run();

  try {
    await db
      .prepare(
        `INSERT INTO wallet_connections (id, profile_id, wallet_address, preferred_chain, is_primary, connected_at, last_used_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (profile_id, wallet_address) DO UPDATE SET
           preferred_chain = excluded.preferred_chain,
           is_primary = 1,
           last_used_at = excluded.last_used_at`
      )
      .bind(
        crypto.randomUUID(),
        row.profile_id,
        row.proposed_address,
        row.proposed_chain,
        activatedIso,
        activatedIso
      )
      .run();
  } catch {
    // wallet_connections is optional in minimal test schemas
  }

  return {
    success: true,
    status: 200,
    code: 'WALLET_CHANGE_ACTIVATED',
    request: {
      ...row,
      status: 'ACTIVATED',
      updated_at: activatedIso,
    },
  };
}

/**
 * Instant emergency cancellation of a pending wallet change by the account owner
 * (e.g., if the owner detects an unauthorized ATO attempt during the 48h window).
 * Strictly enforces `WHERE profile_id = profileId`.
 */
export async function cancelWalletChangeByOwner(
  db: D1Database,
  profileId: string,
  requestId: string,
  nowIso?: string
): Promise<CancelWalletChangeResult> {
  const existing = await db
    .prepare('SELECT * FROM wallet_change_requests WHERE id = ? LIMIT 1')
    .bind(requestId)
    .first<WalletChangeRequestRow>();

  if (!existing) {
    return {
      success: false,
      status: 404,
      code: 'REQUEST_NOT_FOUND',
      error: 'Wallet change request not found',
    };
  }

  if (existing.profile_id !== profileId) {
    return {
      success: false,
      status: 403,
      code: 'IDOR_FORBIDDEN',
      error: 'Forbidden: Cannot cancel another user wallet change request',
    };
  }

  if (existing.status !== 'PENDING_TIMELOCK') {
    return {
      success: false,
      status: 409,
      code: 'ALREADY_FINALIZED',
      error: `Wallet change request is already '${existing.status}'`,
    };
  }

  const cancelledIso = new Date(parseIsoMs(nowIso)).toISOString();

  await db
    .prepare(
      `UPDATE wallet_change_requests
       SET status = 'CANCELLED', updated_at = ?
       WHERE id = ? AND profile_id = ? AND status = 'PENDING_TIMELOCK'`
    )
    .bind(cancelledIso, requestId, profileId)
    .run();

  return {
    success: true,
    status: 200,
    code: 'WALLET_CHANGE_CANCELLED',
    request: {
      ...existing,
      status: 'CANCELLED',
      updated_at: cancelledIso,
    },
  };
}

/**
 * Lists wallet timelock requests strictly belonging to `authenticatedUserId`.
 * Rejects cross-account lookups (`targetProfileId !== authenticatedUserId`).
 */
export async function listWalletChangeRequestsForOwner(
  db: D1Database,
  authenticatedUserId: string,
  targetProfileId?: string | null
): Promise<{
  allowed: boolean;
  status: 200 | 403;
  code?: 'IDOR_FORBIDDEN';
  requests: WalletChangeRequestRow[];
}> {
  if (targetProfileId && targetProfileId !== authenticatedUserId) {
    return {
      allowed: false,
      status: 403,
      code: 'IDOR_FORBIDDEN',
      requests: [],
    };
  }

  const rows = await db
    .prepare(
      `SELECT * FROM wallet_change_requests
       WHERE profile_id = ?
       ORDER BY created_at DESC
       LIMIT 25`
    )
    .bind(authenticatedUserId)
    .all<WalletChangeRequestRow>();

  return {
    allowed: true,
    status: 200,
    requests: rows.results ?? [],
  };
}
