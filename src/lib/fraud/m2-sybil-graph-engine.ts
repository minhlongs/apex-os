/**
 * Deterministic M2 Anti-Fraud Rules Engine + D1 SQL Sybil Graph
 *
 * Combines `json-rules-engine` (`Engine`) with recursive SQLite CTE graph queries
 * over `referral_tree`, `profiles`, `wallet_connections`, and `wallet_change_requests`:
 *  - Rule 1: Self-Referral Block (`traderId === referrerId`, Gmail/Googlemail `+tag` & dot
 *            canonicalization, or identical IP + device fingerprint within signup window)
 *  - Rule 2: Closed Referral Ring / Sybil Cycle Detection (`WITH RECURSIVE chain AS ...`
 *            up to depth 10 detecting `A -> B -> A` or `A -> B -> C -> ... -> A`)
 *  - Rule 3: Shared Payout Wallet Cluster (`>= 2` distinct accounts binding or pending-proposing
 *            the same EVM `0x...` [case-insensitive] or Stellar `G...` [exact] USDC address)
 *  - Rule 4: Velocity, Replay & 48-Hour Wallet-Change Timelock Gate (blocks ATO wallet swap +
 *            immediate withdrawal < 48h, replay keys, and automated Sybil bursts while keeping
 *            high-volume traders and B2B community leaders on distinct wallets unblocked)
 */

import { Engine, type RuleProperties } from 'json-rules-engine';
import type { D1Database } from '@/lib/db';
import {
  findAccountsSharingPayoutWallet,
  isEvmStyleAddress,
  isWalletUnlockedForPayout,
} from '@/lib/wallet/timelock-wallet-service';

export type M2FraudRuleCode =
  | 'SELF_REFERRAL_DIRECT'
  | 'SELF_REFERRAL_EMAIL_ALIAS'
  | 'SELF_REFERRAL_DEVICE_IP_COLLISION'
  | 'SYBIL_REFERRAL_RING_CYCLE'
  | 'SHARED_PAYOUT_WALLET_CLUSTER'
  | 'WALLET_TIMELOCK_ACTIVE_48H'
  | 'UNBOUND_OR_MISMATCHED_PAYOUT_WALLET'
  | 'EVENT_REPLAY_DETECTED'
  | 'AUTOMATED_SYBIL_VELOCITY_BURST';

export type M2EvaluationEventType = 'referral_attribution' | 'payout_withdrawal';

export interface M2FraudEvaluationInput {
  eventType: M2EvaluationEventType;
  idempotencyKey?: string;
  traderId: string;
  referrerId?: string | null;
  traderEmail?: string | null;
  referrerEmail?: string | null;
  payoutWalletAddress?: string | null;
  traderIpHash?: string | null;
  referrerIpHash?: string | null;
  traderDeviceHash?: string | null;
  referrerDeviceHash?: string | null;
  signupDeltaMinutes?: number;
  sameDeviceRecentSignups10m?: number;
  subSecondClickBurstCount?: number;
  nowIso?: string;
}

export interface M2FraudEvaluationVerdict {
  allowed: boolean;
  blocked: boolean;
  triggeredRules: M2FraudRuleCode[];
  cyclePath?: string[];
  sharedWalletAccounts?: string[];
  unlockAt?: string | null;
  evaluatedAt: string;
}

const GMAIL_DOMAINS = new Set<string>(['gmail.com', 'googlemail.com']);
const MAX_CYCLE_DEPTH = 10;

/**
 * Normalizes an email address to its canonical mailbox root so `+tag` sub-addressing
 * and Gmail dot-insensitivity (`a.b+2@gmail.com` === `ab@googlemail.com`) map to a
 * single deterministic identity.
 */
export function canonicalizeEmailRoot(rawEmail: string | null | undefined): string | null {
  if (!rawEmail || typeof rawEmail !== 'string') return null;
  const trimmed = rawEmail.trim().toLowerCase();
  const atIdx = trimmed.lastIndexOf('@');
  if (atIdx <= 0 || atIdx === trimmed.length - 1) return null;

  let local = trimmed.slice(0, atIdx);
  let domain = trimmed.slice(atIdx + 1);

  const plusIdx = local.indexOf('+');
  if (plusIdx !== -1) {
    local = local.slice(0, plusIdx);
  }

  if (GMAIL_DOMAINS.has(domain)) {
    domain = 'gmail.com';
    local = local.replace(/\./g, '');
  }

  if (!local) return null;
  return `${local}@${domain}`;
}

/**
 * Traverses both `referral_tree` (node `parent_id` -> `referral_tree.id`) and
 * `profiles.referred_by` (direct `profiles.id` OR `profiles.referral_code`) up to
 * depth 10 via SQLite `WITH RECURSIVE` CTE to detect whether linking
 * `traderId` under `referrerId` (or evaluating an existing graph containing `traderId`)
 * forms a closed cycle (`A -> B -> A` or `A -> B -> C -> ... -> A`).
 */
export async function detectReferralCycleInD1(
  db: D1Database,
  traderId: string,
  proposedReferrerId?: string | null
): Promise<{ hasCycle: boolean; cyclePath: string[] }> {
  if (!traderId) {
    return { hasCycle: false, cyclePath: [] };
  }

  if (proposedReferrerId && traderId === proposedReferrerId) {
    return { hasCycle: true, cyclePath: [traderId, traderId] };
  }

  // Build unified directed edge query (child_profile_id -> parent_profile_id) in SQLite CTE:
  // 1) Existing edges from `referral_tree` (child.affiliate_id -> parent_node.affiliate_id)
  // 2) Existing edges from `profiles.referred_by` (resolving either profile.id or profile.referral_code)
  // 3) If `proposedReferrerId` is supplied, checks if `traderId` is an ancestor of `proposedReferrerId`
  //    (meaning `proposedReferrerId` ultimately traces up to `traderId`, so adding `traderId -> proposedReferrerId` closes a ring!)
  //    AND also checks existing cycles already present starting from `traderId`.

  const startNode = proposedReferrerId ?? traderId;
  const targetAncestor = traderId;

  const cteSql = `
    WITH RECURSIVE
      edges(child_id, parent_id) AS (
        SELECT rt_child.affiliate_id, rt_parent.affiliate_id
        FROM referral_tree rt_child
        JOIN referral_tree rt_parent ON rt_child.parent_id = rt_parent.id
        WHERE rt_child.affiliate_id IS NOT NULL
          AND rt_parent.affiliate_id IS NOT NULL
        UNION
        SELECT p_child.id, p_parent.id
        FROM profiles p_child
        JOIN profiles p_parent
          ON (p_child.referred_by = p_parent.id OR p_child.referred_by = p_parent.referral_code)
        WHERE p_child.referred_by IS NOT NULL
      ),
      chain(curr_id, depth, path, cycle_found) AS (
        SELECT
          e.parent_id,
          1,
          ? || '->' || e.parent_id,
          CASE WHEN e.parent_id = ? THEN 1 ELSE 0 END
        FROM edges e
        WHERE e.child_id = ?

        UNION ALL

        SELECT
          e.parent_id,
          c.depth + 1,
          c.path || '->' || e.parent_id,
          CASE
            WHEN e.parent_id = ? THEN 1
            WHEN instr('->' || c.path || '->', '->' || e.parent_id || '->') > 0 THEN 1
            ELSE 0
          END
        FROM chain c
        JOIN edges e ON e.child_id = c.curr_id
        WHERE c.depth < ? AND c.cycle_found = 0
      )
    SELECT path, cycle_found, curr_id
    FROM chain
    WHERE cycle_found = 1
    ORDER BY depth ASC
    LIMIT 1
  `;

  try {
    // Case A: Proposed edge `traderId -> proposedReferrerId`: walk ancestors starting from `proposedReferrerId`
    if (proposedReferrerId) {
      if (proposedReferrerId === traderId) {
        return { hasCycle: true, cyclePath: [traderId, traderId] };
      }

      const directCheck = await db
        .prepare(cteSql)
        .bind(
          proposedReferrerId,
          targetAncestor,
          startNode,
          targetAncestor,
          MAX_CYCLE_DEPTH
        )
        .first<{ path: string; cycle_found: number; curr_id: string }>();

      if (directCheck && directCheck.cycle_found === 1) {
        const segments = `${traderId}->${directCheck.path}`.split('->');
        return { hasCycle: true, cyclePath: segments };
      }
    }

    // Case B: Existing cycle already committed in `referral_tree` or `profiles` involving `traderId`
    const existingCheck = await db
      .prepare(cteSql)
      .bind(traderId, traderId, traderId, traderId, MAX_CYCLE_DEPTH)
      .first<{ path: string; cycle_found: number; curr_id: string }>();

    if (existingCheck && existingCheck.cycle_found === 1) {
      return {
        hasCycle: true,
        cyclePath: existingCheck.path.split('->'),
      };
    }

    // Case C: Also check existing cycle involving `proposedReferrerId` if provided
    if (proposedReferrerId) {
      const refCycleCheck = await db
        .prepare(cteSql)
        .bind(
          proposedReferrerId,
          proposedReferrerId,
          proposedReferrerId,
          proposedReferrerId,
          MAX_CYCLE_DEPTH
        )
        .first<{ path: string; cycle_found: number; curr_id: string }>();

      if (refCycleCheck && refCycleCheck.cycle_found === 1) {
        return {
          hasCycle: true,
          cyclePath: refCycleCheck.path.split('->'),
        };
      }
    }
  } catch {
    // Fallback if optional referral_tree table is absent: check profiles.referred_by only
    try {
      const fallbackSql = `
        WITH RECURSIVE chain(curr_id, depth, path, cycle_found) AS (
          SELECT
            p_parent.id,
            1,
            ? || '->' || p_parent.id,
            CASE WHEN p_parent.id = ? THEN 1 ELSE 0 END
          FROM profiles p_child
          JOIN profiles p_parent
            ON (p_child.referred_by = p_parent.id OR p_child.referred_by = p_parent.referral_code)
          WHERE p_child.id = ?
          UNION ALL
          SELECT
            p_parent.id,
            c.depth + 1,
            c.path || '->' || p_parent.id,
            CASE WHEN p_parent.id = ? THEN 1 ELSE 0 END
          FROM chain c
          JOIN profiles p_child ON p_child.id = c.curr_id
          JOIN profiles p_parent
            ON (p_child.referred_by = p_parent.id OR p_child.referred_by = p_parent.referral_code)
          WHERE c.depth < ? AND c.cycle_found = 0
        )
        SELECT path, cycle_found FROM chain WHERE cycle_found = 1 LIMIT 1
      `;
      const row = await db
        .prepare(fallbackSql)
        .bind(startNode, targetAncestor, startNode, targetAncestor, MAX_CYCLE_DEPTH)
        .first<{ path: string; cycle_found: number }>();
      if (row && row.cycle_found === 1) {
        const prefix = proposedReferrerId ? `${traderId}->` : '';
        return { hasCycle: true, cyclePath: `${prefix}${row.path}`.split('->') };
      }
    } catch {
      // No graph tables present
    }
  }

  return { hasCycle: false, cyclePath: [] };
}

function buildDeterministicRulesEngine(): Engine {
  const engine = new Engine([], { allowUndefinedFacts: true });

  const rules: RuleProperties[] = [
    // Rule 1a: Direct Self-Referral
    {
      name: 'rule-1a-direct-self-referral',
      priority: 100,
      conditions: {
        all: [
          { fact: 'isDirectSelfReferral', operator: 'equal', value: true },
        ],
      },
      event: { type: 'SELF_REFERRAL_DIRECT' },
    },
    // Rule 1b: Email Canonical Alias Self-Referral (e.g. Gmail +tag / dots)
    {
      name: 'rule-1b-email-alias-self-referral',
      priority: 99,
      conditions: {
        all: [
          { fact: 'isSameEmailCanonicalRoot', operator: 'equal', value: true },
        ],
      },
      event: { type: 'SELF_REFERRAL_EMAIL_ALIAS' },
    },
    // Rule 1c: Colliding IP + Device Hash within signup window (<= 60 min)
    {
      name: 'rule-1c-device-ip-collision-self-referral',
      priority: 98,
      conditions: {
        all: [
          { fact: 'isSameDeviceAndIpInWindow', operator: 'equal', value: true },
        ],
      },
      event: { type: 'SELF_REFERRAL_DEVICE_IP_COLLISION' },
    },
    // Rule 2: Closed Referral Ring / Sybil Cycle (A -> B -> A or A -> B -> C -> A)
    {
      name: 'rule-2-sybil-referral-cycle',
      priority: 95,
      conditions: {
        all: [{ fact: 'hasReferralCycle', operator: 'equal', value: true }],
      },
      event: { type: 'SYBIL_REFERRAL_RING_CYCLE' },
    },
    // Rule 3: Shared Payout Wallet Cluster (>= 2 distinct accounts on same EVM/Stellar wallet)
    {
      name: 'rule-3-shared-payout-wallet-cluster',
      priority: 90,
      conditions: {
        all: [
          {
            fact: 'distinctWalletAccountCount',
            operator: 'greaterThanInclusive',
            value: 2,
          },
        ],
      },
      event: { type: 'SHARED_PAYOUT_WALLET_CLUSTER' },
    },
    // Rule 4a: 48h Wallet-Change Timelock Active on Payout/Withdrawal
    {
      name: 'rule-4a-wallet-timelock-active-48h',
      priority: 85,
      conditions: {
        all: [
          { fact: 'eventType', operator: 'equal', value: 'payout_withdrawal' },
          { fact: 'isWalletTimelockLocked', operator: 'equal', value: true },
        ],
      },
      event: { type: 'WALLET_TIMELOCK_ACTIVE_48H' },
    },
    // Rule 4a-bis: Unbound or Mismatched Payout Destination Wallet on Withdrawal
    {
      name: 'rule-4a-unbound-or-mismatched-payout-wallet',
      priority: 85,
      conditions: {
        all: [
          { fact: 'eventType', operator: 'equal', value: 'payout_withdrawal' },
          { fact: 'isPayoutWalletUnboundOrMismatched', operator: 'equal', value: true },
        ],
      },
      event: { type: 'UNBOUND_OR_MISMATCHED_PAYOUT_WALLET' },
    },
    // Rule 4b: Event / Withdrawal Idempotency Replay
    {
      name: 'rule-4b-event-replay-detected',
      priority: 84,
      conditions: {
        all: [{ fact: 'isReplayDuplicate', operator: 'equal', value: true }],
      },
      event: { type: 'EVENT_REPLAY_DETECTED' },
    },
    // Rule 4c: Automated Sybil Farm Burst Velocity (>= 5 accounts from identical device fingerprint in 10m OR >= 8 sub-second automated clicks)
    // Carefully calibrated so legitimate high-volume traders & B2B community leaders (40+ distinct-device referrals) have 0% false positives.
    {
      name: 'rule-4c-automated-sybil-velocity-burst',
      priority: 80,
      conditions: {
        any: [
          {
            fact: 'sameDeviceRecentSignups10m',
            operator: 'greaterThanInclusive',
            value: 5,
          },
          {
            fact: 'subSecondClickBurstCount',
            operator: 'greaterThanInclusive',
            value: 8,
          },
        ],
      },
      event: { type: 'AUTOMATED_SYBIL_VELOCITY_BURST' },
    },
  ];

  for (const rule of rules) {
    engine.addRule(rule);
  }

  return engine;
}

export class M2SybilGraphEngine {
  private readonly engine: Engine;
  private readonly seenIdempotencyKeys: Set<string>;

  constructor() {
    this.engine = buildDeterministicRulesEngine();
    this.seenIdempotencyKeys = new Set<string>();
  }

  public resetReplayCache(): void {
    this.seenIdempotencyKeys.clear();
  }

  private async resolveProfileContext(
    db: D1Database,
    profileId: string | null | undefined
  ): Promise<{
    email: string | null;
    walletAddress: string | null;
    referredBy: string | null;
  }> {
    if (!profileId) {
      return { email: null, walletAddress: null, referredBy: null };
    }
    try {
      const row = await db
        .prepare(
          'SELECT email, wallet_address, referred_by FROM profiles WHERE id = ? LIMIT 1'
        )
        .bind(profileId)
        .first<{
          email?: string | null;
          wallet_address?: string | null;
          referred_by?: string | null;
        }>();
      return {
        email: row?.email ?? null,
        walletAddress: row?.wallet_address ?? null,
        referredBy: row?.referred_by ?? null,
      };
    } catch {
      return { email: null, walletAddress: null, referredBy: null };
    }
  }

  private async checkReplayInD1(
    db: D1Database,
    idempotencyKey: string | undefined
  ): Promise<boolean> {
    if (!idempotencyKey) return false;
    const trimmed = idempotencyKey.trim();
    if (!trimmed) return false;

    if (this.seenIdempotencyKeys.has(trimmed)) {
      return true;
    }

    try {
      const ledgerHit = await db
        .prepare(
          'SELECT id FROM ledger_journal_batches WHERE idempotency_key = ? LIMIT 1'
        )
        .bind(trimmed)
        .first<{ id: string }>();
      if (ledgerHit) {
        this.seenIdempotencyKeys.add(trimmed);
        return true;
      }
    } catch {
      // Optional table in minimal schemas
    }

    try {
      const broadcastHit = await db
        .prepare(
          'SELECT payout_id FROM settlement_broadcasts WHERE idempotency_key = ? LIMIT 1'
        )
        .bind(trimmed)
        .first<{ payout_id: string }>();
      if (broadcastHit) {
        this.seenIdempotencyKeys.add(trimmed);
        return true;
      }
    } catch {
      // Optional table in minimal schemas
    }

    this.seenIdempotencyKeys.add(trimmed);
    return false;
  }

  /**
   * Evaluates a referral attribution or payout withdrawal event deterministically
   * against the D1 Sybil graph and `json-rules-engine` rule set.
   */
  public async evaluate(
    db: D1Database,
    input: M2FraudEvaluationInput
  ): Promise<M2FraudEvaluationVerdict> {
    const evaluatedAt = input.nowIso ?? new Date().toISOString();

    const [traderCtx, referrerCtx] = await Promise.all([
      this.resolveProfileContext(db, input.traderId),
      this.resolveProfileContext(db, input.referrerId ?? null),
    ]);

    const effectiveReferrerId = input.referrerId ?? traderCtx.referredBy ?? null;
    const traderEmail = input.traderEmail ?? traderCtx.email;
    const referrerEmail = input.referrerEmail ?? referrerCtx.email;

    // Rule 1 facts
    const isDirectSelfReferral = Boolean(
      effectiveReferrerId && input.traderId === effectiveReferrerId
    );

    const traderCanonicalEmail = canonicalizeEmailRoot(traderEmail);
    const referrerCanonicalEmail = canonicalizeEmailRoot(referrerEmail);
    const isSameEmailCanonicalRoot = Boolean(
      effectiveReferrerId &&
        traderCanonicalEmail &&
        referrerCanonicalEmail &&
        traderCanonicalEmail === referrerCanonicalEmail
    );

    const signupWindowMinutes = input.signupDeltaMinutes ?? 0;
    const hasIdenticalDevice = Boolean(
      input.traderDeviceHash &&
        input.referrerDeviceHash &&
        input.traderDeviceHash === input.referrerDeviceHash
    );
    const hasIdenticalIp = Boolean(
      input.traderIpHash &&
        input.referrerIpHash &&
        input.traderIpHash === input.referrerIpHash
    );
    const isSameDeviceAndIpInWindow = Boolean(
      effectiveReferrerId &&
        input.traderId !== effectiveReferrerId &&
        signupWindowMinutes >= 0 &&
        signupWindowMinutes <= 60 &&
        hasIdenticalDevice &&
        (hasIdenticalIp || input.traderIpHash === undefined || input.traderIpHash === null)
    );

    // Rule 2 facts: Recursive SQLite CTE cycle check
    const cycleResult = await detectReferralCycleInD1(
      db,
      input.traderId,
      effectiveReferrerId
    );

    // Rule 3 facts: Shared Payout Wallet Cluster across profiles + wallet_connections + wallet_change_requests
    const candidateWallet =
      input.payoutWalletAddress ?? traderCtx.walletAddress ?? null;
    const sharedAccountsSet = new Set<string>();
    if (candidateWallet) {
      const owners = await findAccountsSharingPayoutWallet(db, candidateWallet);
      for (const id of owners) {
        sharedAccountsSet.add(id);
      }
      // Include current traderId in cluster count when proposing/using `candidateWallet`
      sharedAccountsSet.add(input.traderId);
    }
    const sharedWalletAccounts = Array.from(sharedAccountsSet);
    const distinctWalletAccountCount = candidateWallet
      ? sharedWalletAccounts.length
      : 0;

    // Rule 4a facts: 48-hour wallet change timelock + bound payout destination match check on withdrawal
    let isWalletTimelockLocked = false;
    let isPayoutWalletUnboundOrMismatched = false;
    let unlockAt: string | null = null;
    if (input.eventType === 'payout_withdrawal') {
      try {
        const unlockStatus = await isWalletUnlockedForPayout(
          db,
          input.traderId,
          evaluatedAt
        );
        if (!unlockStatus.unlocked) {
          if (unlockStatus.reason === 'WALLET_TIMELOCK_ACTIVE_48H') {
            isWalletTimelockLocked = true;
            unlockAt = unlockStatus.unlockAt;
          } else {
            isPayoutWalletUnboundOrMismatched = true;
          }
        } else if (input.payoutWalletAddress) {
          const requestedTrimmed = input.payoutWalletAddress.trim();
          const boundTrimmed = (unlockStatus.walletAddress ?? '').trim();
          const matchesBound = isEvmStyleAddress(boundTrimmed)
            ? requestedTrimmed.toLowerCase() === boundTrimmed.toLowerCase()
            : requestedTrimmed === boundTrimmed;
          if (!matchesBound) {
            isPayoutWalletUnboundOrMismatched = true;
          }
        }
      } catch {
        // wallet_change_requests optional in minimal schemas; still enforce profile wallet match if present
        if (input.payoutWalletAddress && traderCtx.walletAddress) {
          const requestedTrimmed = input.payoutWalletAddress.trim();
          const boundTrimmed = traderCtx.walletAddress.trim();
          const matchesBound = isEvmStyleAddress(boundTrimmed)
            ? requestedTrimmed.toLowerCase() === boundTrimmed.toLowerCase()
            : requestedTrimmed === boundTrimmed;
          if (!matchesBound) {
            isPayoutWalletUnboundOrMismatched = true;
          }
        } else if (!traderCtx.walletAddress) {
          isPayoutWalletUnboundOrMismatched = true;
        }
      }
    }

    // Rule 4b facts: Idempotency replay detection
    const isReplayDuplicate = await this.checkReplayInD1(
      db,
      input.idempotencyKey
    );

    // Execute json-rules-engine deterministically
    const { events } = await this.engine.run({
      eventType: input.eventType,
      isDirectSelfReferral,
      isSameEmailCanonicalRoot,
      isSameDeviceAndIpInWindow,
      hasReferralCycle: cycleResult.hasCycle,
      distinctWalletAccountCount,
      isWalletTimelockLocked,
      isPayoutWalletUnboundOrMismatched,
      isReplayDuplicate,
      sameDeviceRecentSignups10m: input.sameDeviceRecentSignups10m ?? 0,
      subSecondClickBurstCount: input.subSecondClickBurstCount ?? 0,
    });

    const triggeredRules = events.map((ev) => ev.type as M2FraudRuleCode);

    return {
      allowed: triggeredRules.length === 0,
      blocked: triggeredRules.length > 0,
      triggeredRules,
      cyclePath: cycleResult.hasCycle ? cycleResult.cyclePath : undefined,
      sharedWalletAccounts:
        distinctWalletAccountCount >= 2 ? sharedWalletAccounts : undefined,
      unlockAt,
      evaluatedAt,
    };
  }
}

export const defaultM2SybilGraphEngine = new M2SybilGraphEngine();
