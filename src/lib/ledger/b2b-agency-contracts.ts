/**
 * White-Label B2B Agency Split Contracts Service (Safe-Spread Waterfall I4)
 *
 * Manages institutional / quant-community B2B agency split schedules stored in
 * `b2b_agency_contracts` (basis points `0..10000`) and validates every contract
 * through `validateWaterfallConfig` from `src/lib/ledger/waterfall.ts`:
 * - `clawbackReserveBps` in `[500, 2500]` (`5.00%` – `25.00%` of gross `C`)
 * - `traderCashbackBps` in `[0, 8000]` (`0.00%` – `80.00%` of distributable `D = C - R`)
 * - `tier1SpreadBps` in `[0, 4500]` (`0.00%` – `45.00%` of spread `S = D - T`)
 * - `tier2SpreadBps` in `[0, 1000]` (`0.00%` – `10.00%` of spread `S`)
 * - `tier3SpreadBps === 0` hard-locked (Vietnam Decree 40/2018/ND-CP anti-MLM)
 * - Solvency cap: `tier1SpreadBps + tier2SpreadBps <= 4500` (`<= 45.00%` of spread `S`)
 */

import Decimal from 'decimal.js';
import type { D1Database } from '@/lib/auth/adapters/d1-adapter';
import {
  DEFAULT_WATERFALL_CONFIG,
  InvalidWaterfallConfigError,
  validateWaterfallConfig,
  type WaterfallConfig,
} from './waterfall';

export type B2bAgencyContractStatus = 'ACTIVE' | 'PAUSED' | 'TERMINATED';

export interface B2bAgencyContractRow {
  id: string;
  agency_profile_id: string;
  agency_name: string;
  clawback_reserve_bps: number;
  trader_cashback_bps: number;
  tier1_spread_bps: number;
  tier2_spread_bps: number;
  tier3_spread_bps: number;
  status: B2bAgencyContractStatus;
  notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface B2bAgencyContractRecord {
  id: string;
  agencyProfileId: string;
  agencyName: string;
  clawbackReserveBps: number;
  traderCashbackBps: number;
  tier1SpreadBps: number;
  tier2SpreadBps: number;
  tier3SpreadBps: 0;
  status: B2bAgencyContractStatus;
  notes: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
  waterfallConfig: WaterfallConfig;
  effectiveGrossSharesPct: {
    clawbackReservePct: string;
    traderCashbackPct: string;
    l1AffiliatePct: string;
    b2bAgencyL2Pct: string;
    l3CapPct: '0.00';
    platformNetPct: string;
  };
}

export interface UpsertB2bAgencyContractInput {
  agencyProfileId: string;
  agencyName: string;
  clawbackReserveBps?: number;
  traderCashbackBps?: number;
  tier1SpreadBps?: number;
  tier2SpreadBps?: number;
  tier3SpreadBps?: number;
  status?: B2bAgencyContractStatus;
  notes?: string | null;
  actorAdminId: string;
}

const VALID_STATUSES = new Set<B2bAgencyContractStatus>(['ACTIVE', 'PAUSED', 'TERMINATED']);
const SAFE_ID_REGEX = /^[a-zA-Z0-9_.:-]{1,128}$/;

export function bpsToDecimalRateString(bps: number, fieldName: string): string {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10000) {
    throw new InvalidWaterfallConfigError(
      `${fieldName} must be an integer basis-point value in [0, 10000] (got ${String(bps)})`
    );
  }
  return new Decimal(bps).div(10000).toFixed();
}

export function computeEffectiveGrossSharesPct(config: WaterfallConfig): {
  clawbackReservePct: string;
  traderCashbackPct: string;
  l1AffiliatePct: string;
  b2bAgencyL2Pct: string;
  l3CapPct: '0.00';
  platformNetPct: string;
} {
  const validated = validateWaterfallConfig(config);
  const reserve = new Decimal(validated.clawbackReserveRate);
  const distributable = new Decimal(1).minus(reserve);
  const trader = distributable.mul(validated.traderCashbackShareOfDistributable);
  const spread = distributable.minus(trader);
  const l1 = spread.mul(validated.tier1ShareOfSpread);
  const l2 = spread.mul(validated.tier2ShareOfSpread);
  const platform = spread.minus(l1).minus(l2);

  return {
    clawbackReservePct: reserve.mul(100).toFixed(2),
    traderCashbackPct: trader.mul(100).toFixed(2),
    l1AffiliatePct: l1.mul(100).toFixed(2),
    b2bAgencyL2Pct: l2.mul(100).toFixed(2),
    l3CapPct: '0.00',
    platformNetPct: platform.mul(100).toFixed(2),
  };
}

export function buildValidatedContractWaterfallConfig(params: {
  clawbackReserveBps: number;
  traderCashbackBps: number;
  tier1SpreadBps: number;
  tier2SpreadBps: number;
  tier3SpreadBps: number;
}): WaterfallConfig {
  if (!Number.isInteger(params.tier3SpreadBps) || params.tier3SpreadBps !== 0) {
    throw new InvalidWaterfallConfigError(
      'tier3SpreadBps must be hard-locked to 0 (Vietnam Decree 40/2018/ND-CP 2-tier limit)'
    );
  }
  if (
    !Number.isInteger(params.clawbackReserveBps) ||
    params.clawbackReserveBps < 500 ||
    params.clawbackReserveBps > 2500
  ) {
    throw new InvalidWaterfallConfigError(
      'clawbackReserveBps must be between 500 bps (5.00%) and 2500 bps (25.00%)'
    );
  }
  const candidate: Partial<WaterfallConfig> = {
    clawbackReserveRate: bpsToDecimalRateString(
      params.clawbackReserveBps,
      'clawbackReserveBps'
    ),
    traderCashbackShareOfDistributable: bpsToDecimalRateString(
      params.traderCashbackBps,
      'traderCashbackBps'
    ),
    tier1ShareOfSpread: bpsToDecimalRateString(params.tier1SpreadBps, 'tier1SpreadBps'),
    tier2ShareOfSpread: bpsToDecimalRateString(params.tier2SpreadBps, 'tier2SpreadBps'),
    tier3ShareOfSpread: '0',
  };
  return validateWaterfallConfig(candidate);
}

function mapContractRow(row: B2bAgencyContractRow): B2bAgencyContractRecord {
  const waterfallConfig = buildValidatedContractWaterfallConfig({
    clawbackReserveBps: Number(row.clawback_reserve_bps),
    traderCashbackBps: Number(row.trader_cashback_bps),
    tier1SpreadBps: Number(row.tier1_spread_bps),
    tier2SpreadBps: Number(row.tier2_spread_bps),
    tier3SpreadBps: Number(row.tier3_spread_bps),
  });

  return {
    id: row.id,
    agencyProfileId: row.agency_profile_id,
    agencyName: row.agency_name,
    clawbackReserveBps: Number(row.clawback_reserve_bps),
    traderCashbackBps: Number(row.trader_cashback_bps),
    tier1SpreadBps: Number(row.tier1_spread_bps),
    tier2SpreadBps: Number(row.tier2_spread_bps),
    tier3SpreadBps: 0,
    status: row.status,
    notes: row.notes ?? null,
    createdBy: row.created_by ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    waterfallConfig,
    effectiveGrossSharesPct: computeEffectiveGrossSharesPct(waterfallConfig),
  };
}

export async function listB2bAgencyContracts(
  db: D1Database,
  limit = 50
): Promise<B2bAgencyContractRecord[]> {
  const safeLimit = Math.min(Math.max(1, Math.trunc(limit)), 200);
  const res = await db
    .prepare(
      `SELECT id, agency_profile_id, agency_name, clawback_reserve_bps, trader_cashback_bps,
              tier1_spread_bps, tier2_spread_bps, tier3_spread_bps, status, notes,
              created_by, created_at, updated_at
       FROM b2b_agency_contracts
       ORDER BY updated_at DESC
       LIMIT ?`
    )
    .bind(safeLimit)
    .all<B2bAgencyContractRow>();

  return (res.results ?? []).map(mapContractRow);
}

export async function getB2bAgencyContractByProfileId(
  db: D1Database,
  agencyProfileId: string
): Promise<B2bAgencyContractRecord | null> {
  const trimmed = agencyProfileId.trim();
  if (!trimmed) {
    return null;
  }
  const row = await db
    .prepare(
      `SELECT id, agency_profile_id, agency_name, clawback_reserve_bps, trader_cashback_bps,
              tier1_spread_bps, tier2_spread_bps, tier3_spread_bps, status, notes,
              created_by, created_at, updated_at
       FROM b2b_agency_contracts
       WHERE agency_profile_id = ?
       LIMIT 1`
    )
    .bind(trimmed)
    .first<B2bAgencyContractRow>();

  return row ? mapContractRow(row) : null;
}

export async function upsertB2bAgencyContract(
  db: D1Database,
  input: UpsertB2bAgencyContractInput
): Promise<B2bAgencyContractRecord> {
  const agencyProfileId = input.agencyProfileId.trim();
  if (!SAFE_ID_REGEX.test(agencyProfileId)) {
    throw new InvalidWaterfallConfigError('agencyProfileId must be a valid profile identifier');
  }

  const agencyName = input.agencyName.trim();
  if (agencyName.length < 2 || agencyName.length > 120) {
    throw new InvalidWaterfallConfigError('agencyName must be between 2 and 120 characters');
  }

  const status: B2bAgencyContractStatus = input.status ?? 'ACTIVE';
  if (!VALID_STATUSES.has(status)) {
    throw new InvalidWaterfallConfigError(
      `status must be ACTIVE, PAUSED, or TERMINATED (got ${String(status)})`
    );
  }

  const clawbackReserveBps = input.clawbackReserveBps ?? 500;
  const traderCashbackBps = input.traderCashbackBps ?? 5000;
  const tier1SpreadBps = input.tier1SpreadBps ?? 3000;
  const tier2SpreadBps = input.tier2SpreadBps ?? 1000;
  const tier3SpreadBps = input.tier3SpreadBps ?? 0;

  // Validate against canonical Safe-Spread Waterfall I4 constraints BEFORE touching D1
  buildValidatedContractWaterfallConfig({
    clawbackReserveBps,
    traderCashbackBps,
    tier1SpreadBps,
    tier2SpreadBps,
    tier3SpreadBps,
  });

  const profileRow = await db
    .prepare(`SELECT id FROM profiles WHERE id = ? LIMIT 1`)
    .bind(agencyProfileId)
    .first<{ id: string }>();
  if (!profileRow?.id) {
    throw new InvalidWaterfallConfigError(
      `Profile '${agencyProfileId}' does not exist in profiles`
    );
  }

  const existing = await db
    .prepare(`SELECT id FROM b2b_agency_contracts WHERE agency_profile_id = ? LIMIT 1`)
    .bind(agencyProfileId)
    .first<{ id: string }>();

  const contractId = existing?.id ?? `b2b_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
  const notes =
    typeof input.notes === 'string' && input.notes.trim().length > 0
      ? input.notes.trim().slice(0, 500)
      : null;

  await db
    .prepare(
      `INSERT INTO b2b_agency_contracts (
         id, agency_profile_id, agency_name, clawback_reserve_bps, trader_cashback_bps,
         tier1_spread_bps, tier2_spread_bps, tier3_spread_bps, status, notes,
         created_by, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT(agency_profile_id) DO UPDATE SET
         agency_name = excluded.agency_name,
         clawback_reserve_bps = excluded.clawback_reserve_bps,
         trader_cashback_bps = excluded.trader_cashback_bps,
         tier1_spread_bps = excluded.tier1_spread_bps,
         tier2_spread_bps = excluded.tier2_spread_bps,
         tier3_spread_bps = 0,
         status = excluded.status,
         notes = excluded.notes,
         updated_at = datetime('now')`
    )
    .bind(
      contractId,
      agencyProfileId,
      agencyName,
      clawbackReserveBps,
      traderCashbackBps,
      tier1SpreadBps,
      tier2SpreadBps,
      status,
      notes,
      input.actorAdminId
    )
    .run();

  const saved = await getB2bAgencyContractByProfileId(db, agencyProfileId);
  if (!saved) {
    throw new Error('Failed to read back upserted B2B agency contract');
  }
  return saved;
}

export const DEFAULT_B2B_WATERFALL_PREVIEW = {
  defaultRetailConfig: DEFAULT_WATERFALL_CONFIG,
  defaultRetailEffectiveGrossPct: computeEffectiveGrossSharesPct(DEFAULT_WATERFALL_CONFIG),
  maxB2bEffectiveGrossPct: computeEffectiveGrossSharesPct({
    ...DEFAULT_WATERFALL_CONFIG,
    tier2ShareOfSpread: '0.10',
  }),
};
