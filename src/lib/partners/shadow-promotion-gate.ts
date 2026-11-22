/**
 * 30-Day Shadow Reconciliation Promotion Gate
 *
 * `PARTNER_KUCOIN_LIVE` and `PARTNER_GATEIO_LIVE` are the only runtime flags that
 * switch a partner integration from shadow-only to live ledger minting. Every
 * route that can mutate a runtime flag must enforce the same completeness check,
 * otherwise a caller can promote an exchange through the route with the weakest check.
 *
 * The gate fails closed on `partner_shadow_reconciliations` joined with
 * `r2_evidence_objects`, requiring:
 *   1. Non-empty shadow reconciliation history for the exchange.
 *   2. Zero `SHADOW_DISCREPANCY` / unknown-status rows, zero non-zero `discrepancy_units`,
 *      and zero `unmapped_uid_count`.
 *   3. Complete evidence provenance (`r2_evidence_objects` row exists, matches exchange,
 *      and has a valid 64-hex SHA-256 digest) and valid non-future UTC timestamps.
 *   4. Full 30-day elapsed observation window (`evalNowMs - earliestMs >= 30 days`).
 *   5. Freshness: latest verified shadow batch is within 48 hours of `evalNowMs`.
 *   6. Continuous coverage & cadence: at least 30 distinct UTC days covered in the
 *      trailing 30-day window and no silent gap exceeding 48 hours between consecutive runs.
 *   7. Non-trivial reconciled volume (`SUM(row_count) > 0` and `SUM(mapped_uid_count) > 0`).
 *
 * Demotion (`flagValue === 'false'`) never calls this gate: an operator must
 * always be able to fall back to shadow mode immediately.
 */

export type ShadowPromotionExchange = 'kucoin' | 'gateio';

export type ShadowPromotionGateErrorCode =
  | 'SHADOW_HISTORY_MISSING'
  | 'SHADOW_DISCREPANCY_PRESENT'
  | 'SHADOW_PROVENANCE_INCOMPLETE'
  | 'SHADOW_FUTURE_TIMESTAMP'
  | 'SHADOW_WINDOW_UNDER_30_DAYS'
  | 'SHADOW_EVIDENCE_STALE'
  | 'SHADOW_COVERAGE_INCOMPLETE'
  | 'SHADOW_INSUFFICIENT_VOLUME';

export const SHADOW_PROMOTION_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const SHADOW_MAX_STALENESS_MS = 48 * 60 * 60 * 1000;
export const SHADOW_MAX_GAP_MS = 48 * 60 * 60 * 1000;
export const SHADOW_MIN_DISTINCT_DAYS = 30;

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
      all<T = unknown>(): Promise<{ results?: T[] }>;
    };
  };
}

export type ShadowPromotionGateResult =
  | {
      allowed: true;
      totalBatches?: number;
      earliestAt?: string | null;
      latestAt?: string | null;
      distinctDays?: number;
      totalReconciledRows?: number;
    }
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

const ALLOWED_CLEAN_STATUSES = new Set(['SHADOW_LOGGED', 'PROMOTED_READY']);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/i;

/** Normalizes a runtime flag key or exchange id to the shadow-gated exchange. */
export function resolveShadowPromotionExchange(
  flagKeyOrExchange: string
): ShadowPromotionExchange | null {
  if (typeof flagKeyOrExchange !== 'string') {
    return null;
  }
  return FLAG_KEY_TO_EXCHANGE[flagKeyOrExchange.trim()] ?? null;
}

interface ShadowBatchRow {
  id: string;
  evidence_id: string | null;
  row_count: number | null;
  mapped_uid_count: number | null;
  unmapped_uid_count: number | null;
  discrepancy_units: number | null;
  status: string | null;
  normalized_created_at: string | null;
  evidence_exchange: string | null;
  evidence_sha256: string | null;
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

function utcDayKey(epochMs: number): string {
  return new Date(epochMs).toISOString().slice(0, 10);
}

/**
 * Validates the mandatory 30-day continuous, provenance-verified clean shadow
 * reconciliation window before live promotion.
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

  if (!Number.isFinite(evalNowMs) || evalNowMs <= 0) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_FUTURE_TIMESTAMP',
      error: `Cannot promote ${exchange}: invalid evaluation timestamp`,
    };
  }

  let rows: ShadowBatchRow[] | null = null;
  try {
    const queryResult = await db
      .prepare(
        `SELECT
           s.id,
           s.evidence_id,
           s.row_count,
           s.mapped_uid_count,
           s.unmapped_uid_count,
           s.discrepancy_units,
           s.status,
           datetime(s.created_at) AS normalized_created_at,
           e.exchange AS evidence_exchange,
           e.payload_sha256 AS evidence_sha256
         FROM partner_shadow_reconciliations s
         LEFT JOIN r2_evidence_objects e ON e.id = s.evidence_id
         WHERE s.exchange = ?
         ORDER BY datetime(s.created_at) ASC`
      )
      .bind(exchange)
      .all<ShadowBatchRow>();
    rows = Array.isArray(queryResult?.results) ? queryResult.results : [];
  } catch {
    // Fail closed: an unreadable audit table cannot prove a clean shadow history.
    rows = null;
  }

  if (!rows || rows.length === 0) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_HISTORY_MISSING',
      error: `Cannot promote ${exchange} to live without verified shadow reconciliation history`,
    };
  }

  let discrepancyCount = 0;

  const parsedBatches: Array<{
    tsMs: number;
    normalizedAt: string;
    rowCount: number;
    mappedUids: number;
  }> = [];

  for (const row of rows) {
    const status = typeof row.status === 'string' ? row.status : '';
    const discrepancyUnits = Number(row.discrepancy_units ?? 0);
    const unmappedUids = Number(row.unmapped_uid_count ?? 0);
    const rowCount = Number(row.row_count ?? 0);
    const mappedUids = Number(row.mapped_uid_count ?? 0);

    if (
      !ALLOWED_CLEAN_STATUSES.has(status) ||
      !Number.isFinite(discrepancyUnits) ||
      discrepancyUnits !== 0 ||
      !Number.isFinite(unmappedUids) ||
      unmappedUids > 0
    ) {
      discrepancyCount += 1;
      continue;
    }

    const evidenceId = typeof row.evidence_id === 'string' ? row.evidence_id.trim() : '';
    const evidenceSha =
      typeof row.evidence_sha256 === 'string' ? row.evidence_sha256.trim() : '';
    const evidenceExchange =
      typeof row.evidence_exchange === 'string' ? row.evidence_exchange.trim() : '';

    if (
      !evidenceId ||
      evidenceExchange !== exchange ||
      !SHA256_HEX_PATTERN.test(evidenceSha) ||
      !Number.isFinite(rowCount) ||
      rowCount < 0 ||
      !Number.isFinite(mappedUids) ||
      mappedUids < 0 ||
      mappedUids > rowCount
    ) {
      return {
        allowed: false,
        status: 422,
        code: 'SHADOW_PROVENANCE_INCOMPLETE',
        error: `Cannot promote ${exchange}: shadow batch ${row.id} lacks verified R2 evidence provenance or has malformed counts`,
      };
    }

    const normalizedAt = row.normalized_created_at ?? '';
    const tsMs = normalizedAt ? parseUtcTimestampMs(normalizedAt) : Number.NaN;
    if (!Number.isFinite(tsMs)) {
      return {
        allowed: false,
        status: 422,
        code: 'SHADOW_PROVENANCE_INCOMPLETE',
        error: `Cannot promote ${exchange}: shadow batch ${row.id} has an invalid timestamp`,
      };
    }

    if (tsMs > evalNowMs) {
      return {
        allowed: false,
        status: 422,
        code: 'SHADOW_FUTURE_TIMESTAMP',
        error: `Cannot promote ${exchange}: shadow batch ${row.id} has a future timestamp (${normalizedAt})`,
      };
    }

    parsedBatches.push({ tsMs, normalizedAt, rowCount, mappedUids });
  }

  if (discrepancyCount > 0) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_DISCREPANCY_PRESENT',
      error: `Cannot promote ${exchange} to live while ${discrepancyCount} shadow discrepancy or unmapped batch(es) exist`,
    };
  }

  parsedBatches.sort((a, b) => a.tsMs - b.tsMs);

  const earliest = parsedBatches[0];
  const latest = parsedBatches[parsedBatches.length - 1];

  if (!earliest || !latest || evalNowMs - earliest.tsMs < SHADOW_PROMOTION_WINDOW_MS) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_WINDOW_UNDER_30_DAYS',
      error: `Cannot promote ${exchange} before completing the mandatory 30-day shadow reconciliation window (earliest=${earliest?.normalizedAt ?? 'none'})`,
    };
  }

  if (evalNowMs - latest.tsMs > SHADOW_MAX_STALENESS_MS) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_EVIDENCE_STALE',
      error: `Cannot promote ${exchange}: latest shadow reconciliation (${latest.normalizedAt}) is older than 48 hours`,
    };
  }

  const windowStartMs = evalNowMs - SHADOW_PROMOTION_WINDOW_MS;
  const distinctDays = new Set<string>();
  const windowBatches: number[] = [];
  let windowReconciledRows = 0;
  let windowMappedUids = 0;

  for (const batch of parsedBatches) {
    if (batch.tsMs >= windowStartMs) {
      distinctDays.add(utcDayKey(batch.tsMs));
      windowBatches.push(batch.tsMs);
      windowReconciledRows += batch.rowCount;
      windowMappedUids += batch.mappedUids;
    }
  }

  if (distinctDays.size < SHADOW_MIN_DISTINCT_DAYS) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_COVERAGE_INCOMPLETE',
      error: `Cannot promote ${exchange}: only ${distinctDays.size}/${SHADOW_MIN_DISTINCT_DAYS} distinct UTC days covered in the trailing 30-day shadow window`,
    };
  }

  for (let i = 1; i < windowBatches.length; i++) {
    const gapMs = windowBatches[i] - windowBatches[i - 1];
    if (gapMs > SHADOW_MAX_GAP_MS) {
      return {
        allowed: false,
        status: 422,
        code: 'SHADOW_COVERAGE_INCOMPLETE',
        error: `Cannot promote ${exchange}: shadow reconciliation cadence has a gap exceeding 48 hours`,
      };
    }
  }

  if (windowReconciledRows <= 0 || windowMappedUids <= 0) {
    return {
      allowed: false,
      status: 422,
      code: 'SHADOW_INSUFFICIENT_VOLUME',
      error: `Cannot promote ${exchange}: trailing 30-day shadow window contains zero reconciled rows or zero mapped UIDs`,
    };
  }

  return {
    allowed: true,
    totalBatches: parsedBatches.length,
    earliestAt: earliest.normalizedAt,
    latestAt: latest.normalizedAt,
    distinctDays: distinctDays.size,
    totalReconciledRows: windowReconciledRows,
  };
}
