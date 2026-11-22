/**
 * D1 Fraud Telemetry Hydration Service
 *
 * Hydrates deterministic Sybil, device/IP collision, signup-window, and automated
 * velocity-burst telemetry from Cloudflare D1 (`profiles`, `sessions`,
 * `wallet_change_requests`, `referral_clicks` / `deal_clicks`, `audit_logs` /
 * `payout_audit_logs`, `referral_tree`, and `ledger_accounts`) for
 * `M2SybilGraphEngine.evaluate(...)`.
 *
 * Every optional table query is isolated behind defensive `try/catch` guards so
 * minimal sandbox or migration subsets degrade cleanly without throwing.
 */

export interface FraudTelemetryPreparedStatementLike {
  bind(...values: unknown[]): FraudTelemetryPreparedStatementLike;
  first<T = unknown>(): Promise<T | null | undefined>;
  all<T = unknown>(): Promise<{ results?: T[] }>;
}

export interface FraudTelemetryD1Like {
  prepare(query: string): FraudTelemetryPreparedStatementLike;
}

export interface LoadAttributionFraudTelemetryParams {
  traderId: string;
  referrerId: string;
  traderEmail?: string | null;
  referrerEmail?: string | null;
  requestIp?: string | null;
  cache?: FraudTelemetryBatchCache;
}

export interface HydratedAttributionFraudTelemetry {
  traderEmail: string | null;
  referrerEmail: string | null;
  traderIpHash: string | null;
  referrerIpHash: string | null;
  traderDeviceHash: string | null;
  referrerDeviceHash: string | null;
  signupDeltaMinutes?: number;
  sameDeviceRecentSignups10m: number;
  subSecondClickBurstCount: number;
}

export interface LoadWithdrawalFraudTelemetryParams {
  traderId: string;
  requestIp?: string | null;
  userAgent?: string | null;
}

export interface HydratedWithdrawalFraudTelemetry {
  traderEmail: string | null;
  referrerId: string | null;
  referrerEmail: string | null;
  traderIpHash: string | null;
  referrerIpHash: string | null;
  traderDeviceHash: string | null;
  referrerDeviceHash: string | null;
  signupDeltaMinutes?: number;
  sameDeviceRecentSignups10m: number;
  subSecondClickBurstCount: number;
}

export interface ResolvedB2bAgencyOverride {
  b2bAgencyId: string;
  defaultTier2ShareOfSpread: string;
}

interface RawProfileTelemetryRow {
  id?: string;
  email?: string | null;
  role?: string | null;
  referred_by?: string | null;
  referral_code?: string | null;
  created_at?: string | null;
}

interface ActorRawTelemetry {
  rawIp: string | null;
  rawDevice: string | null;
}

/** Opaque per-batch memoization handle for repeated attribution hydration. */
export type FraudTelemetryBatchCache = object;

interface FraudTelemetryBatchState {
  profileRows: Map<string, Promise<RawProfileTelemetryRow | null>>;
  actorTelemetry: Map<string, Promise<ActorRawTelemetry>>;
  referrerClickTimestamps: Map<string, Promise<number[]>>;
  agencyOverrides: Map<string, Promise<ResolvedB2bAgencyOverride | null>>;
  attributionSnapshots: Map<string, Promise<HydratedAttributionFraudTelemetry>>;
}

const batchStates = new WeakMap<object, WeakMap<object, FraudTelemetryBatchState>>();
const deadSqlProbes = new WeakMap<object, Set<string>>();

/** Creates an isolated memoization cache for one reconciliation batch. */
export function createFraudTelemetryBatchCache(): FraudTelemetryBatchCache {
  return {};
}

function getBatchState(
  cache: FraudTelemetryBatchCache | undefined,
  db: FraudTelemetryD1Like
): FraudTelemetryBatchState | null {
  if (!cache) return null;
  let databases = batchStates.get(cache);
  if (!databases) {
    databases = new WeakMap<object, FraudTelemetryBatchState>();
    batchStates.set(cache, databases);
  }
  let state = databases.get(db);
  if (!state) {
    state = {
      profileRows: new Map(),
      actorTelemetry: new Map(),
      referrerClickTimestamps: new Map(),
      agencyOverrides: new Map(),
      attributionSnapshots: new Map(),
    };
    databases.set(db, state);
  }
  return state;
}

async function memoizePromise<T>(
  values: Map<string, Promise<T>>,
  key: string,
  load: () => Promise<T>
): Promise<T> {
  const existing = values.get(key);
  if (existing) return existing;
  const pending = load();
  values.set(key, pending);
  try {
    return await pending;
  } catch (err) {
    values.delete(key);
    throw err;
  }
}

function isMissingSchemaError(err: unknown): boolean {
  const message = (err instanceof Error ? err.message : String(err)).toLowerCase();
  return message.includes('no such table') || message.includes('no such column');
}

function deadProbeSet(db: FraudTelemetryD1Like): Set<string> {
  let probes = deadSqlProbes.get(db);
  if (!probes) {
    probes = new Set();
    deadSqlProbes.set(db, probes);
  }
  return probes;
}

const TEN_MINUTES_MS = 10 * 60 * 1000;
const SUB_SECOND_BURST_THRESHOLD_MS = 1000;

function nonEmptyTrimmed(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseTimestampMs(raw: unknown): number | null {
  const str = nonEmptyTrimmed(raw);
  if (!str) return null;
  const normalized =
    !str.includes('T') && str.includes(' ') ? `${str.replace(' ', 'T')}Z` : str;
  const ms = Date.parse(normalized);
  return Number.isFinite(ms) ? ms : null;
}

async function sha256HexOrNull(raw: string | null | undefined): Promise<string | null> {
  const normalized = nonEmptyTrimmed(raw);
  if (!normalized) return null;
  if (!globalThis.crypto?.subtle) {
    return normalized;
  }
  const bytes = new TextEncoder().encode(normalized);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  const view = new Uint8Array(digest);
  let hex = '';
  for (let i = 0; i < view.length; i += 1) {
    hex += view[i].toString(16).padStart(2, '0');
  }
  return hex;
}

async function loadProfileRow(
  db: FraudTelemetryD1Like,
  profileId: string | null | undefined,
  cache?: FraudTelemetryBatchCache
): Promise<RawProfileTelemetryRow | null> {
  const id = nonEmptyTrimmed(profileId);
  if (!id) return null;
  const state = getBatchState(cache, db);
  const load = async (): Promise<RawProfileTelemetryRow | null> => {
    try {
      const row = await db
        .prepare('SELECT * FROM profiles WHERE id = ? LIMIT 1')
        .bind(id)
        .first<RawProfileTelemetryRow>();
      return row ?? null;
    } catch {
      return null;
    }
  };
  return state
    ? memoizePromise(state.profileRows, id, load)
    : load();
}

async function resolveCanonicalReferrerId(
  db: FraudTelemetryD1Like,
  profileId: string,
  rawReferredBy: string | null | undefined
): Promise<string | null> {
  const candidate = nonEmptyTrimmed(rawReferredBy);
  if (candidate) {
    try {
      const resolved = await db
        .prepare(
          'SELECT id FROM profiles WHERE id = ? OR referral_code = ? LIMIT 1'
        )
        .bind(candidate, candidate)
        .first<{ id?: string }>();
      if (resolved?.id) {
        return resolved.id;
      }
    } catch {
      // Fallback to raw candidate if profiles table lacks referral_code
    }
    return candidate;
  }

  try {
    const treeParent = await db
      .prepare(
        `SELECT rt_parent.affiliate_id AS parent_affiliate_id
         FROM referral_tree rt_child
         JOIN referral_tree rt_parent ON rt_child.parent_id = rt_parent.id
         WHERE rt_child.affiliate_id = ? AND COALESCE(rt_child.is_active, 1) = 1
         LIMIT 1`
      )
      .bind(profileId)
      .first<{ parent_affiliate_id?: string | null }>();
    const parentId = nonEmptyTrimmed(treeParent?.parent_affiliate_id);
    if (parentId) {
      return parentId;
    }
  } catch {
    // Optional referral_tree table
  }

  return null;
}

async function queryFirstRowSafe(
  db: FraudTelemetryD1Like,
  sqlCandidates: readonly string[],
  paramValue: string
): Promise<Record<string, unknown> | null> {
  const deadProbes = deadProbeSet(db);
  for (const sql of sqlCandidates) {
    if (deadProbes.has(sql)) continue;
    try {
      const row = await db
        .prepare(sql)
        .bind(paramValue)
        .first<Record<string, unknown>>();
      if (row) {
        return row;
      }
    } catch (err) {
      if (isMissingSchemaError(err)) deadProbes.add(sql);
      // Try next schema variant
    }
  }
  return null;
}

async function queryRowsSafe<T>(
  db: FraudTelemetryD1Like,
  sql: string,
  paramValue: string
): Promise<T[]> {
  const deadProbes = deadProbeSet(db);
  if (deadProbes.has(sql)) return [];
  try {
    const result = await db.prepare(sql).bind(paramValue).all<T>();
    return result.results ?? [];
  } catch (err) {
    if (isMissingSchemaError(err)) deadProbes.add(sql);
    return [];
  }
}

async function resolveActorRawTelemetry(
  db: FraudTelemetryD1Like,
  profileId: string | null | undefined,
  options?: { referrerClickFallbackId?: string | null },
  cache?: FraudTelemetryBatchCache
): Promise<ActorRawTelemetry> {
  const id = nonEmptyTrimmed(profileId);
  if (!id) {
    return { rawIp: null, rawDevice: null };
  }
  const fallback = nonEmptyTrimmed(options?.referrerClickFallbackId) ?? '';
  const state = getBatchState(cache, db);
  if (state) {
    return memoizePromise(state.actorTelemetry, `${id}\u0000${fallback}`, () =>
      resolveActorRawTelemetryUncached(db, id, options)
    );
  }
  return resolveActorRawTelemetryUncached(db, id, options);
}

async function resolveActorRawTelemetryUncached(
  db: FraudTelemetryD1Like,
  id: string,
  options?: { referrerClickFallbackId?: string | null }
): Promise<ActorRawTelemetry> {
  let rawIp: string | null = null;
  let rawDevice: string | null = null;

  const absorb = (row: Record<string, unknown> | null): void => {
    if (!row) return;
    if (!rawIp) {
      rawIp =
        nonEmptyTrimmed(row.ip_address) ??
        nonEmptyTrimmed(row.requested_ip) ??
        nonEmptyTrimmed(row.ip);
    }
    if (!rawDevice) {
      rawDevice =
        nonEmptyTrimmed(row.device_fingerprint) ??
        nonEmptyTrimmed(row.device_hash) ??
        nonEmptyTrimmed(row.user_agent);
    }
  };

  // 1. sessions (Better Auth)
  const sessionRow = await queryFirstRowSafe(
    db,
    [
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      'SELECT * FROM sessions WHERE user_id = ? ORDER BY rowid DESC LIMIT 1',
    ],
    id
  );
  absorb(sessionRow);

  // 2. audit_logs / payout_audit_logs
  if (!rawIp || !rawDevice) {
    const auditRow = await queryFirstRowSafe(
      db,
      [
        'SELECT * FROM audit_logs WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
        'SELECT * FROM audit_logs WHERE actor_id = ? ORDER BY created_at DESC LIMIT 1',
        'SELECT * FROM audit_logs WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1',
      ],
      id
    );
    absorb(auditRow);
  }

  if (!rawIp) {
    const payoutAuditRow = await queryFirstRowSafe(
      db,
      [
        'SELECT ip_address FROM payout_audit_logs WHERE admin_id = ? AND ip_address IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      ],
      id
    );
    absorb(payoutAuditRow);
  }

  // 3. wallet_change_requests.requested_ip
  if (!rawIp) {
    const wcrRow = await queryFirstRowSafe(
      db,
      [
        'SELECT requested_ip FROM wallet_change_requests WHERE profile_id = ? AND requested_ip IS NOT NULL ORDER BY created_at DESC LIMIT 1',
      ],
      id
    );
    absorb(wcrRow);
  }

  // 4. Actor-owned click rows in referral_clicks
  if (!rawIp || !rawDevice) {
    const ownClickRow = await queryFirstRowSafe(
      db,
      [
        'SELECT * FROM referral_clicks WHERE trader_id = ? ORDER BY clicked_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE trader_id = ? ORDER BY created_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE referred_user_id = ? ORDER BY clicked_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE referred_user_id = ? ORDER BY created_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE user_id = ? ORDER BY clicked_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE user_id = ? ORDER BY created_at DESC LIMIT 1',
      ],
      id
    );
    absorb(ownClickRow);
  }

  // 5. Trader-only fallback: click recorded against referrerId's link when referral_clicks / deal_clicks
  //    does not carry a dedicated trader_id column. Never used to populate referrer's own device/IP.
  const refFallback = nonEmptyTrimmed(options?.referrerClickFallbackId);
  if ((!rawIp || !rawDevice) && refFallback && refFallback !== id) {
    const refLinkClickRow = await queryFirstRowSafe(
      db,
      [
        'SELECT * FROM referral_clicks WHERE referrer_id = ? ORDER BY clicked_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 1',
        'SELECT * FROM referral_clicks WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 1',
        'SELECT * FROM deal_clicks WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 1',
      ],
      refFallback
    );
    absorb(refLinkClickRow);
  }

  return { rawIp, rawDevice };
}

async function loadReferrerClickTimestampsMs(
  db: FraudTelemetryD1Like,
  referrerId: string | null | undefined,
  cache?: FraudTelemetryBatchCache
): Promise<number[]> {
  const id = nonEmptyTrimmed(referrerId);
  if (!id) return [];
  const state = getBatchState(cache, db);
  if (state) {
    return memoizePromise(state.referrerClickTimestamps, id, () =>
      loadReferrerClickTimestampsMsUncached(db, id)
    );
  }
  return loadReferrerClickTimestampsMsUncached(db, id);
}

async function loadReferrerClickTimestampsMsUncached(
  db: FraudTelemetryD1Like,
  id: string
): Promise<number[]> {
  const queryVariants = [
    'SELECT clicked_at AS ts FROM referral_clicks WHERE referrer_id = ? ORDER BY clicked_at DESC LIMIT 200',
    'SELECT created_at AS ts FROM referral_clicks WHERE referrer_id = ? ORDER BY created_at DESC LIMIT 200',
    'SELECT clicked_at AS ts FROM referral_clicks WHERE affiliate_id = ? ORDER BY clicked_at DESC LIMIT 200',
    'SELECT created_at AS ts FROM referral_clicks WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 200',
    'SELECT created_at AS ts FROM deal_clicks WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 200',
    'SELECT created_at AS ts FROM affiliate_clicks WHERE affiliate_id = ? ORDER BY created_at DESC LIMIT 200',
  ];

  const collected: number[] = [];
  for (const sql of queryVariants) {
    const rows = await queryRowsSafe<{ ts?: string | null }>(
      db,
      sql,
      id
    );
    if (rows.length > 0) {
      for (const r of rows) {
        const parsed = parseTimestampMs(r.ts);
        if (parsed !== null) {
          collected.push(parsed);
        }
      }
      if (collected.length > 0) {
        break;
      }
    }
  }

  return collected;
}

function computeSubSecondClickBurstCount(timestampsMs: readonly number[]): number {
  if (timestampsMs.length < 2) return 0;
  const sorted = [...timestampsMs].sort((a, b) => a - b);
  let burstPairs = 0;
  for (let i = 1; i < sorted.length; i += 1) {
    const delta = sorted[i] - sorted[i - 1];
    if (delta >= 0 && delta < SUB_SECOND_BURST_THRESHOLD_MS) {
      burstPairs += 1;
    }
  }
  return burstPairs;
}

function computeSignupDeltaMinutes(
  traderCreatedMs: number | null,
  clickTimestampsMs: readonly number[]
): number | undefined {
  if (traderCreatedMs === null || clickTimestampsMs.length === 0) {
    return undefined;
  }
  let latestPriorClickMs: number | null = null;
  for (const ts of clickTimestampsMs) {
    if (ts <= traderCreatedMs && (latestPriorClickMs === null || ts > latestPriorClickMs)) {
      latestPriorClickMs = ts;
    }
  }
  if (latestPriorClickMs === null) {
    return undefined;
  }
  const deltaMinutes = (traderCreatedMs - latestPriorClickMs) / 60_000;
  return deltaMinutes >= 0 ? deltaMinutes : undefined;
}

async function countSameDeviceRecentSignups10m(
  db: FraudTelemetryD1Like,
  traderCreatedMs: number | null,
  actorTelemetry: ActorRawTelemetry
): Promise<number> {
  if (traderCreatedMs === null) {
    return 0;
  }
  const hasDevice = Boolean(actorTelemetry.rawDevice);
  const hasIp = Boolean(actorTelemetry.rawIp);
  if (!hasDevice && !hasIp) {
    return 0;
  }

  const matchedProfileIds = new Set<string>();

  const withinWindow = (createdAtRaw: unknown): boolean => {
    const ms = parseTimestampMs(createdAtRaw);
    if (ms === null) return false;
    return Math.abs(ms - traderCreatedMs) <= TEN_MINUTES_MS;
  };

  // 1. Check sessions joined to profiles.created_at
  if (hasDevice && actorTelemetry.rawDevice) {
    const rows = await queryRowsSafe<{ profile_id?: string; created_at?: string | null }>(
      db,
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM sessions s
       JOIN profiles p ON p.id = s.user_id
       WHERE s.user_agent = ?`,
      actorTelemetry.rawDevice
    );
    for (const r of rows) {
      if (r.profile_id && withinWindow(r.created_at)) {
        matchedProfileIds.add(r.profile_id);
      }
    }
  } else if (hasIp && actorTelemetry.rawIp) {
    // Only fall back to IP-only velocity counting when no device/UA string is present,
    // preserving 0% false positives for corporate Wi-Fi NATs with distinct devices.
    const rows = await queryRowsSafe<{ profile_id?: string; created_at?: string | null }>(
      db,
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM sessions s
       JOIN profiles p ON p.id = s.user_id
       WHERE s.ip_address = ? AND (s.user_agent IS NULL OR trim(s.user_agent) = '')`,
      actorTelemetry.rawIp
    );
    for (const r of rows) {
      if (r.profile_id && withinWindow(r.created_at)) {
        matchedProfileIds.add(r.profile_id);
      }
    }
  }

  // 2. Check referral_clicks joined to profiles.created_at across common column variants
  if (hasDevice && actorTelemetry.rawDevice) {
    const clickJoinQueries = [
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM referral_clicks rc
       JOIN profiles p ON p.id = rc.trader_id
       WHERE rc.device_fingerprint = ?`,
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM referral_clicks rc
       JOIN profiles p ON p.id = rc.trader_id
       WHERE rc.user_agent = ?`,
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM referral_clicks rc
       JOIN profiles p ON p.id = rc.user_id
       WHERE rc.device_fingerprint = ?`,
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM referral_clicks rc
       JOIN profiles p ON p.id = rc.user_id
       WHERE rc.user_agent = ?`,
    ];
    for (const sql of clickJoinQueries) {
      const rows = await queryRowsSafe<{ profile_id?: string; created_at?: string | null }>(
        db,
        sql,
        actorTelemetry.rawDevice
      );
      for (const r of rows) {
        if (r.profile_id && withinWindow(r.created_at)) {
          matchedProfileIds.add(r.profile_id);
        }
      }
    }
  } else if (hasIp && actorTelemetry.rawIp) {
    const clickIpQueries = [
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM referral_clicks rc
       JOIN profiles p ON p.id = rc.trader_id
       WHERE rc.ip_address = ?`,
      `SELECT DISTINCT p.id AS profile_id, p.created_at AS created_at
       FROM referral_clicks rc
       JOIN profiles p ON p.id = rc.user_id
       WHERE rc.ip_address = ?`,
    ];
    for (const sql of clickIpQueries) {
      const rows = await queryRowsSafe<{ profile_id?: string; created_at?: string | null }>(
        db,
        sql,
        actorTelemetry.rawIp
      );
      for (const r of rows) {
        if (r.profile_id && withinWindow(r.created_at)) {
          matchedProfileIds.add(r.profile_id);
        }
      }
    }
  }

  return matchedProfileIds.size;
}

/**
 * Hydrates attribution fraud telemetry from D1 for `(traderId, referrerId)`.
 */
export async function loadAttributionFraudTelemetry(
  db: FraudTelemetryD1Like,
  params: LoadAttributionFraudTelemetryParams,
  cache: FraudTelemetryBatchCache | undefined = params.cache
): Promise<HydratedAttributionFraudTelemetry> {
  const state = getBatchState(cache, db);
  const snapshotKey = `${params.traderId.trim()}\u0000${params.referrerId.trim()}`;
  if (state) {
    return memoizePromise(state.attributionSnapshots, snapshotKey, () =>
      loadAttributionFraudTelemetryUncached(db, params, cache)
    );
  }
  return loadAttributionFraudTelemetryUncached(db, params, cache);
}

async function loadAttributionFraudTelemetryUncached(
  db: FraudTelemetryD1Like,
  params: LoadAttributionFraudTelemetryParams,
  cache?: FraudTelemetryBatchCache
): Promise<HydratedAttributionFraudTelemetry> {
  const [traderProfile, referrerProfile] = await Promise.all([
    loadProfileRow(db, params.traderId, cache),
    loadProfileRow(db, params.referrerId, cache),
  ]);

  const traderEmail =
    nonEmptyTrimmed(params.traderEmail) ?? nonEmptyTrimmed(traderProfile?.email);
  const referrerEmail =
    nonEmptyTrimmed(params.referrerEmail) ?? nonEmptyTrimmed(referrerProfile?.email);

  const [traderActor, referrerActor, clickTimestampsMs] = await Promise.all([
    resolveActorRawTelemetry(
      db,
      params.traderId,
      { referrerClickFallbackId: params.referrerId },
      cache
    ),
    resolveActorRawTelemetry(db, params.referrerId, undefined, cache),
    loadReferrerClickTimestampsMs(db, params.referrerId, cache),
  ]);

  const effectiveTraderRawIp =
    traderActor.rawIp ?? nonEmptyTrimmed(params.requestIp);

  const [traderIpHash, referrerIpHash, traderDeviceHash, referrerDeviceHash] =
    await Promise.all([
      sha256HexOrNull(effectiveTraderRawIp),
      sha256HexOrNull(referrerActor.rawIp),
      sha256HexOrNull(traderActor.rawDevice),
      sha256HexOrNull(referrerActor.rawDevice),
    ]);

  const traderCreatedMs = parseTimestampMs(traderProfile?.created_at);
  const signupDeltaMinutes = computeSignupDeltaMinutes(
    traderCreatedMs,
    clickTimestampsMs
  );
  const sameDeviceRecentSignups10m = await countSameDeviceRecentSignups10m(
    db,
    traderCreatedMs,
    { rawIp: effectiveTraderRawIp, rawDevice: traderActor.rawDevice }
  );
  const subSecondClickBurstCount = computeSubSecondClickBurstCount(clickTimestampsMs);

  return {
    traderEmail,
    referrerEmail,
    traderIpHash,
    referrerIpHash,
    traderDeviceHash,
    referrerDeviceHash,
    signupDeltaMinutes,
    sameDeviceRecentSignups10m,
    subSecondClickBurstCount,
  };
}

/**
 * Hydrates payout/withdrawal fraud telemetry from D1 for `traderId` (including
 * upline `referrerId` from `profiles.referred_by` / `referral_tree` when present).
 */
export async function loadWithdrawalFraudTelemetry(
  db: FraudTelemetryD1Like,
  params: LoadWithdrawalFraudTelemetryParams
): Promise<HydratedWithdrawalFraudTelemetry> {
  const traderProfile = await loadProfileRow(db, params.traderId);
  const referrerId = await resolveCanonicalReferrerId(
    db,
    params.traderId,
    traderProfile?.referred_by
  );

  const [referrerProfile, traderActor, referrerActor, clickTimestampsMs] =
    await Promise.all([
      referrerId ? loadProfileRow(db, referrerId) : Promise.resolve(null),
      resolveActorRawTelemetry(db, params.traderId, {
        referrerClickFallbackId: referrerId,
      }),
      referrerId
        ? resolveActorRawTelemetry(db, referrerId)
        : Promise.resolve<ActorRawTelemetry>({ rawIp: null, rawDevice: null }),
      referrerId ? loadReferrerClickTimestampsMs(db, referrerId) : Promise.resolve([]),
    ]);

  const effectiveTraderRawIp =
    traderActor.rawIp ?? nonEmptyTrimmed(params.requestIp);
  const effectiveTraderRawDevice =
    traderActor.rawDevice ?? nonEmptyTrimmed(params.userAgent);

  const [traderIpHash, referrerIpHash, traderDeviceHash, referrerDeviceHash] =
    await Promise.all([
      sha256HexOrNull(effectiveTraderRawIp),
      sha256HexOrNull(referrerActor.rawIp),
      sha256HexOrNull(effectiveTraderRawDevice),
      sha256HexOrNull(referrerActor.rawDevice),
    ]);

  const traderCreatedMs = parseTimestampMs(traderProfile?.created_at);
  const signupDeltaMinutes = computeSignupDeltaMinutes(
    traderCreatedMs,
    clickTimestampsMs
  );
  const sameDeviceRecentSignups10m = await countSameDeviceRecentSignups10m(
    db,
    traderCreatedMs,
    { rawIp: effectiveTraderRawIp, rawDevice: effectiveTraderRawDevice }
  );
  const subSecondClickBurstCount = computeSubSecondClickBurstCount(clickTimestampsMs);

  return {
    traderEmail: nonEmptyTrimmed(traderProfile?.email),
    referrerId,
    referrerEmail: nonEmptyTrimmed(referrerProfile?.email),
    traderIpHash,
    referrerIpHash,
    traderDeviceHash,
    referrerDeviceHash,
    signupDeltaMinutes,
    sameDeviceRecentSignups10m,
    subSecondClickBurstCount,
  };
}

/**
 * Resolves a provisioned upline B2B agency override partner for `l1AffiliateId`
 * from D1 (`referral_tree` / `profiles.referred_by` + `ledger_accounts`
 * `owner_type = 'agency'` or `profiles.role = 'agency'`).
 */
export async function resolveUplineB2bAgencyOverride(
  db: FraudTelemetryD1Like,
  l1AffiliateId: string | null | undefined,
  cache?: FraudTelemetryBatchCache
): Promise<ResolvedB2bAgencyOverride | null> {
  const l1Id = nonEmptyTrimmed(l1AffiliateId);
  if (!l1Id) return null;
  const state = getBatchState(cache, db);
  if (state) {
    return memoizePromise(state.agencyOverrides, l1Id, () =>
      resolveUplineB2bAgencyOverrideUncached(db, l1Id, cache)
    );
  }
  return resolveUplineB2bAgencyOverrideUncached(db, l1Id, cache);
}

async function resolveUplineB2bAgencyOverrideUncached(
  db: FraudTelemetryD1Like,
  l1Id: string,
  cache?: FraudTelemetryBatchCache
): Promise<ResolvedB2bAgencyOverride | null> {
  const l1Profile = await loadProfileRow(db, l1Id, cache);
  const candidateAgencyId = await resolveCanonicalReferrerId(
    db,
    l1Id,
    l1Profile?.referred_by
  );
  if (!candidateAgencyId || candidateAgencyId === l1Id) {
    return null;
  }

  let isProvisionedAgency = false;

  try {
    const agencyAcct = await db
      .prepare(
        "SELECT id FROM ledger_accounts WHERE owner_type = 'agency' AND owner_id = ? LIMIT 1"
      )
      .bind(candidateAgencyId)
      .first<{ id?: string }>();
    if (agencyAcct?.id) {
      isProvisionedAgency = true;
    }
  } catch {
    // Optional ledger_accounts table
  }

  if (!isProvisionedAgency) {
    const agencyProfile = await loadProfileRow(db, candidateAgencyId, cache);
    if (nonEmptyTrimmed(agencyProfile?.role)?.toLowerCase() === 'agency') {
      isProvisionedAgency = true;
    }
  }

  if (!isProvisionedAgency) {
    return null;
  }

  return {
    b2bAgencyId: candidateAgencyId,
    defaultTier2ShareOfSpread: '0.10',
  };
}
