/**
 * 30-Day Shadow Reconciliation Promotion Gate
 *
 * `PARTNER_KUCOIN_LIVE` and `PARTNER_GATEIO_LIVE` are the only runtime flags that
 * switch a partner integration from shadow-only to live ledger minting. Every
 * route that can mutate a runtime flag must enforce the same window, otherwise a
 * caller can promote an exchange through the route with the weakest check.
 *
 * The gate requires three conditions on `partner_shadow_reconciliations`:
 *   1. at least one shadow batch exists (no history means no evidence of safety),
 *   2. zero `SHADOW_DISCREPANCY` batches (an unresolved discrepancy blocks promotion),
 *   3. the earliest shadow batch is at least 30 days old.
 *
 * Demotion (`flagValue === 'false'`) never calls this gate: an operator must
 * always be able to fall back to shadow mode immediately.
 */

export type ShadowPromotionExchange = 'kucoin' | 'gateio';

export type ShadowPromotionGateErrorCode =
  | 'SHADOW_HISTORY_MISSING'
  | 'SHADOW_DISCREPANCY_PRESENT'
  | 'SHADOW_WINDOW_UNDER_30_DAYS';

export const SHADOW_PROMOTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export const SHADOW_PROMOTION_FLAG_KEYS: Readonly<
  Record<ShadowPromotionExchange, string>
> = Object.freeze({
  kucoin: 'PARTNER_KUCOIN_LIVE',
  gateio: 'PARTNER_GATEIO_LIVE',
});

/**
 * Structural D1 surface the gate needs. Declaring it here keeps the helper usable
 * from both the legacy `@/lib/db` binding and the auth adapter binding without a
 * cast at every call site.
 */
export interface ShadowPromotionGateDatabase {
  prepare(sql: string): {
    bind(...values: unknown[]): {
      first<T = unknown>(): Promise<T | null | undefined>;
    };
  };
}

export type ShadowPromotionGateResult =
  | { allowed: true; totalBatches?: number; earliestAt?: string | null }
  | {
      allowed: false;
      status: 422;
      code: ShadowPromotionGateErrorCode;
      error: string;
    };

const FLAG_KEY_TO_EXCHANGE: Readonly<Record<string, ShadowPromotionExchange>> =
  Object.freeze({
    PARTNER_KUCOIN_LIVE: 'kucoin',
    PARTNER_GATEIO_LIVE: 'gateio',
    kucoin: 'kucoin',
    gateio: 'gateio',
  });

/** Normalizes a runtime flag key or exchange id to the shadow-gated exchange. */
export function resolveShadowPromotionExchange(
  flagKeyOrExchange: string
): ShadowPromotionExchange | null {
  if (typeof flagKeyOrExchange !== 'string') {
    return null;
  }
  return FLAG_KEY_TO_EXCHANGE[flagKeyOrExchange.trim()] ?? null;
}

interface ShadowStatsRow {
  total_batches: number | null;
  discrepancy_batches: number | null;
  earliest_at: string | null;
}

/**
 * SQLite's own `DATETIME`/`CURRENT_TIMESTAMP` format is `YYYY-MM-DD HH:MM:SS`
 * with no timezone marker, yet the value is always UTC. `Date.parse` reads that
 * shape as local time, so an operator in UTC+7 would see the gate open seven
 * hours late (or, west of UTC, up to twelve hours early). Normalizing the
 * separator and pinning the zone keeps the 30-day window absolute.
 */
const SQLITE_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/;

/** Parses an ISO-8601 or SQLite UTC timestamp to epoch milliseconds. */
export function parseUtcTimestampMs(raw: string): number {
  const trimmed = raw.trim();
  const normalized = SQLITE_UTC_TIMESTAMP_PATTERN.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}Z`
    : trimmed;
  return Date.parse(normalized);
}

/**
 * Validates the mandatory 30-day clean shadow window before live promotion.
 *
 * Any flag key that is not a shadow-gated partner flag is allowed without a query,
 * because the gate only governs the two shadow-to-live transitions.
 */
export async function validateShadowPromotionGate(
  db: ShadowPromotionGateDatabase,
  flagKeyOrExchange: string,
  evalNowMs: number = Date.now()
): Promise<ShadowPromotionGateResult> {
  const exchange = resolveShadowPromotionExchange(flagKeyOrExchange);
  if (!exchange) {
    return { allowed: true };
  }

  let stats: ShadowStatsRow | null | undefined;
  try {
    stats = await db
      .prepare(
        `SELECT
           COUNT(*) AS total_batches,
           SUM(CASE WHEN status = 'SHADOW_DISCREPANCY' THEN 1 ELSE 0 END) AS discrepancy_batches,
           MIN(datetime(created_at)) AS earliest_at
         FROM partner_shadow_reconciliations
         WHERE exchange = ?`
      )
      .bind(exchange)
      .first<ShadowStatsRow>();
  } catch {
    // Fail closed: an unreadable audit table cannot prove a clean shadow history.
    stats = null;
  }

  const totalBatches = Number(stats?.total_batches ?? 0);
  const discrepancyBatches = Number(stats?.discrepancy_batches ?? 0);
  const earliestAt = stats?.earliest_at ?? null;

  if (totalBatches === 0 || !earliestAt) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_HISTORY_MISSING',
      error: `Cannot promote ${exchange} to live without verified shadow reconciliation history`,
    };
  }

  if (discrepancyBatches > 0) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_DISCREPANCY_PRESENT',
      error: `Cannot promote ${exchange} to live while ${discrepancyBatches} shadow discrepancy batch(es) exist`,
    };
  }

  const earliestMs = parseUtcTimestampMs(earliestAt);
  if (
    !Number.isFinite(earliestMs) ||
    evalNowMs - earliestMs < SHADOW_PROMOTION_WINDOW_MS
  ) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_WINDOW_UNDER_30_DAYS',
      error: `Cannot promote ${exchange} before completing the mandatory 30-day shadow reconciliation window (earliest=${earliestAt})`,
    };
  }

  return { allowed: true, totalBatches, earliestAt };
}
