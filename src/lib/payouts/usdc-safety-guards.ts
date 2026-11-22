/**
 * src/lib/payouts/usdc-safety-guards.ts
 *
 * USDC Peg Circuit Breaker & Pre-Signing Settlement Safety Guards
 *
 * Enforces before ANY Turnkey HSM signing call:
 * 1. Phase 1 chain gate ('stellar' | 'arbitrum' | 'base' ENABLED; 'ethereum' L1 & 'solana' DISABLED_PHASE1)
 * 2. D1 `system_runtime_flags` emergency flags (`EMERGENCY_PAUSE`, `EMERGENCY_LEDGER_FREEZE`)
 * 3. USDC/USD peg circuit breaker strictly within [$0.985, $1.015] via decimal.js
 *    — automatically flips `EMERGENCY_PAUSE = 'true'` in `system_runtime_flags` on depeg!
 * 4. $10.00 USDC minimum withdrawal floor (`>= 1_000_000_000` units at 10^-8)
 * 5. OFAC/AML sanctions screening (`SanctionsScreeningService`)
 * 6. Chain-native asset freeze / reserve checks:
 *    - Arbitrum One / Base: Circle `isBlacklisted(address)` (0xfe575a87) + `eth_call` transfer simulation
 *    - Stellar: Recipient account exists AND already holds an authorized Circle USDC trustline
 *      (NEVER sponsors XLM base reserves or trustlines)
 */

import Decimal from 'decimal.js';
import type { D1Database } from '../db';
import {
  SanctionsScreeningService,
  sanctionsScreeningService as defaultSanctionsService,
} from '../compliance/sanctions-service';
import type { SupportedPayoutChain } from './types';
import { isValidStellarAccountId } from './stellar-service';
import {
  assertMinimumWithdrawalFloor,
  assertPhase1ChainEnabled,
  ledgerUnits1e8ToEvmUsdcUnits,
  type ArbitrumBaseUsdcAdapter,
  type EvmPhase1SettlementChain,
  type Phase1SettlementChain,
} from './adapters/arbitrum-base-usdc-adapter';

export const USDC_PEG_MIN_BOUND_STR = '0.985' as const;
export const USDC_PEG_MAX_BOUND_STR = '1.015' as const;

const USDC_PEG_MIN_DECIMAL = new Decimal(USDC_PEG_MIN_BOUND_STR);
const USDC_PEG_MAX_DECIMAL = new Decimal(USDC_PEG_MAX_BOUND_STR);

export interface StellarTrustlineVerifier {
  hasUsdcTrustline(accountId: string): Promise<boolean>;
}

export interface UsdcPegEvaluation {
  withinBand: boolean;
  priceFormatted: string;
  minBound: string;
  maxBound: string;
  reason?: string;
}

export interface UsdcPegCircuitBreakerResult {
  allowed: boolean;
  emergencyPaused: boolean;
  priceFormatted: string;
  reason?: string;
}

export class UsdcSafetyGuardError extends Error {
  readonly code:
    | 'EMERGENCY_PAUSED'
    | 'USDC_DEPEG_CIRCUIT_BREAKER'
    | 'PHASE1_CHAIN_DISABLED'
    | 'BELOW_MIN_WITHDRAWAL_FLOOR'
    | 'SANCTIONED_RECIPIENT'
    | 'CIRCLE_USDC_BLACKLISTED'
    | 'EVM_SIMULATION_FAILED'
    | 'MISSING_STELLAR_USDC_TRUSTLINE'
    | 'INVALID_RECIPIENT_ADDRESS';

  constructor(
    code: UsdcSafetyGuardError['code'],
    message: string
  ) {
    super(message);
    this.name = 'UsdcSafetyGuardError';
    this.code = code;
  }
}

/**
 * Pure evaluation of USDC/USD reference price against [$0.985, $1.015] using decimal.js.
 */
export function evaluateUsdcPegBand(
  referencePriceUsd: string | number | Decimal
): UsdcPegEvaluation {
  let priceDec: Decimal;
  try {
    priceDec = new Decimal(referencePriceUsd);
  } catch {
    return {
      withinBand: false,
      priceFormatted: 'NaN',
      minBound: USDC_PEG_MIN_BOUND_STR,
      maxBound: USDC_PEG_MAX_BOUND_STR,
      reason: `Invalid USDC/USD oracle reference price: ${String(referencePriceUsd)}`,
    };
  }

  if (!priceDec.isFinite() || priceDec.lte(0)) {
    return {
      withinBand: false,
      priceFormatted: priceDec.toString(),
      minBound: USDC_PEG_MIN_BOUND_STR,
      maxBound: USDC_PEG_MAX_BOUND_STR,
      reason: `Non-positive or non-finite USDC/USD oracle reference price: ${priceDec.toString()}`,
    };
  }

  const formatted = priceDec.toFixed(6, Decimal.ROUND_HALF_UP);

  if (priceDec.lt(USDC_PEG_MIN_DECIMAL) || priceDec.gt(USDC_PEG_MAX_DECIMAL)) {
    return {
      withinBand: false,
      priceFormatted: formatted,
      minBound: USDC_PEG_MIN_BOUND_STR,
      maxBound: USDC_PEG_MAX_BOUND_STR,
      reason: `USDC/USD reference price $${formatted} breached peg safety band [$${USDC_PEG_MIN_BOUND_STR}, $${USDC_PEG_MAX_BOUND_STR}]`,
    };
  }

  return {
    withinBand: true,
    priceFormatted: formatted,
    minBound: USDC_PEG_MIN_BOUND_STR,
    maxBound: USDC_PEG_MAX_BOUND_STR,
  };
}

/**
 * Read whether settlement is currently paused in `system_runtime_flags`.
 */
const EMERGENCY_SETTLEMENT_FLAGS = ['EMERGENCY_PAUSE', 'EMERGENCY_LEDGER_FREEZE'] as const;

export async function isEmergencySettlementPaused(
  db: D1Database
): Promise<{ paused: boolean; flagKey?: string; reason?: string }> {
  const { results } = await db
    .prepare(
      `SELECT flag_key, flag_value, reason
       FROM system_runtime_flags
       WHERE flag_key IN (?, ?)`
    )
    .bind(...EMERGENCY_SETTLEMENT_FLAGS)
    .all<{ flag_key: string; flag_value: string; reason: string | null }>();

  for (const flagKey of EMERGENCY_SETTLEMENT_FLAGS) {
    const rows = results.filter((row) => row.flag_key === flagKey);
    const row = rows[0];
    if (rows.length !== 1 || !row || (row.flag_value !== 'true' && row.flag_value !== 'false')) {
      return { paused: true, flagKey, reason: 'Mandatory emergency control is missing or invalid' };
    }
    if (row.flag_value === 'true') {
      return { paused: true, flagKey, reason: row.reason ?? `${flagKey} active` };
    }
  }

  return { paused: false };
}

/**
 * Flip `EMERGENCY_PAUSE = 'true'` in `system_runtime_flags` on D1.
 */
export async function triggerEmergencyPauseFlag(
  db: D1Database,
  reason: string,
  updatedBy = 'usdc-peg-circuit-breaker'
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO system_runtime_flags (flag_key, flag_value, reason, updated_by, updated_at)
       VALUES ('EMERGENCY_PAUSE', 'true', ?, ?, datetime('now'))
       ON CONFLICT(flag_key) DO UPDATE SET
         flag_value = 'true',
         reason = excluded.reason,
         updated_by = excluded.updated_by,
         updated_at = datetime('now')`
    )
    .bind(reason, updatedBy)
    .run();
}

/**
 * Enforce USDC peg circuit breaker against [$0.985, $1.015].
 * If outside band, flips `EMERGENCY_PAUSE = 'true'` in `system_runtime_flags` and halts settlement.
 */
export async function enforceUsdcPegCircuitBreaker(
  db: D1Database,
  referencePriceUsd: string | number | Decimal,
  updatedBy = 'usdc-peg-circuit-breaker'
): Promise<UsdcPegCircuitBreakerResult> {
  const evalResult = evaluateUsdcPegBand(referencePriceUsd);

  if (!evalResult.withinBand) {
    const pauseReason =
      evalResult.reason ??
      `USDC/USD peg circuit breaker tripped at $${evalResult.priceFormatted}`;
    await triggerEmergencyPauseFlag(db, pauseReason, updatedBy);
    return {
      allowed: false,
      emergencyPaused: true,
      priceFormatted: evalResult.priceFormatted,
      reason: pauseReason,
    };
  }

  const flagState = await isEmergencySettlementPaused(db);
  if (flagState.paused) {
    return {
      allowed: false,
      emergencyPaused: true,
      priceFormatted: evalResult.priceFormatted,
      reason: `Settlement halted by runtime flag ${flagState.flagKey}: ${flagState.reason}`,
    };
  }

  return {
    allowed: true,
    emergencyPaused: false,
    priceFormatted: evalResult.priceFormatted,
  };
}

export interface PreSigningSafetyGuardInput {
  db: D1Database;
  chain: string;
  recipientAddress: string;
  amountUnits1e8: bigint;
  usdcReferencePriceUsd: string | number | Decimal;
  sanctionsService?: SanctionsScreeningService;
  evmAdapters?: Partial<Record<EvmPhase1SettlementChain, ArbitrumBaseUsdcAdapter>>;
  stellarTrustlineVerifier?: StellarTrustlineVerifier;
}

export interface PreSigningSafetyGuardVerdict {
  chain: Phase1SettlementChain;
  recipientAddress: string;
  amountUnits1e8: bigint;
  usdcPriceFormatted: string;
}

/**
 * Run all pre-signing treasury safety guards in deterministic fail-closed order.
 * Throws `UsdcSafetyGuardError` (or `Phase1ChainDisabledError` / `MinimumWithdrawalFloorError`
 * mapped cleanly) before ANY HSM signing call can execute.
 */
export async function assertPreSigningSafetyGuards(
  input: PreSigningSafetyGuardInput
): Promise<PreSigningSafetyGuardVerdict> {
  // 1. Phase 1 chain gate ('ethereum' L1 & 'solana' rejected before touching signing)
  try {
    assertPhase1ChainEnabled(input.chain);
  } catch (err) {
    throw new UsdcSafetyGuardError(
      'PHASE1_CHAIN_DISABLED',
      err instanceof Error ? err.message : String(err)
    );
  }
  const chain: Phase1SettlementChain = input.chain;

  // 2. Check existing emergency flags first
  const existingPause = await isEmergencySettlementPaused(input.db);
  if (existingPause.paused) {
    throw new UsdcSafetyGuardError(
      'EMERGENCY_PAUSED',
      `Settlement halted by ${existingPause.flagKey}: ${existingPause.reason}`
    );
  }

  // 3. Enforce USDC/USD peg circuit breaker [$0.985, $1.015]
  const pegResult = await enforceUsdcPegCircuitBreaker(
    input.db,
    input.usdcReferencePriceUsd
  );
  if (!pegResult.allowed) {
    throw new UsdcSafetyGuardError(
      'USDC_DEPEG_CIRCUIT_BREAKER',
      pegResult.reason ?? 'USDC peg circuit breaker tripped'
    );
  }

  // 4. Enforce $10.00 USDC minimum withdrawal floor
  try {
    assertMinimumWithdrawalFloor(input.amountUnits1e8);
  } catch (err) {
    throw new UsdcSafetyGuardError(
      'BELOW_MIN_WITHDRAWAL_FLOOR',
      err instanceof Error ? err.message : String(err)
    );
  }

  // 5. OFAC / Sanctions screening
  const sanctions = input.sanctionsService ?? defaultSanctionsService;
  const sanctionsChain: SupportedPayoutChain =
    chain === 'stellar' ? 'stellar' : 'ethereum';
  const screening = await sanctions.checkAddress(
    input.recipientAddress,
    sanctionsChain,
    input.db
  );
  if (screening.isSanctioned) {
    throw new UsdcSafetyGuardError(
      'SANCTIONED_RECIPIENT',
      `OFAC/AML sanctions block for ${chain} address ${input.recipientAddress}: ${screening.reason ?? 'Sanctioned address'}`
    );
  }

  // Also check D1 sanctioned_addresses directly for 'arbitrum' / 'base' chain tag if table exists
  if (chain === 'arbitrum' || chain === 'base') {
    try {
      const chainSpecificRow = await input.db
        .prepare(
          `SELECT source FROM sanctioned_addresses
           WHERE chain = ? AND lower(address) = lower(?)
           LIMIT 1`
        )
        .bind(chain, input.recipientAddress.trim())
        .first<{ source: string | null }>();
      if (chainSpecificRow) {
        throw new UsdcSafetyGuardError(
          'SANCTIONED_RECIPIENT',
          `OFAC/AML sanctions block for ${chain} address ${input.recipientAddress}: ${chainSpecificRow.source ?? 'Sanctioned address'}`
        );
      }
    } catch (err) {
      if (err instanceof UsdcSafetyGuardError) {
        throw err;
      }
      // Ignore missing sanctioned_addresses table when running minimal schema
    }
  }

  // 6. Chain-specific pre-signing checks (Circle blacklist + eth_call OR Stellar USDC trustline)
  if (chain === 'arbitrum' || chain === 'base') {
    const adapter = input.evmAdapters?.[chain];
    if (!adapter) {
      throw new UsdcSafetyGuardError(
        'EVM_SIMULATION_FAILED',
        `Missing configured ArbitrumBaseUsdcAdapter for chain '${chain}'`
      );
    }

    if (!adapter.validateAddress(input.recipientAddress)) {
      throw new UsdcSafetyGuardError(
        'INVALID_RECIPIENT_ADDRESS',
        `Invalid ${chain} EVM recipient address: ${input.recipientAddress}`
      );
    }

    const amountUnits6 = ledgerUnits1e8ToEvmUsdcUnits(input.amountUnits1e8);
    const simResult = await adapter.simulateTransferBeforeSigning({
      recipientAddress: input.recipientAddress,
      amountUnits6,
    });

    if (!simResult.ok) {
      const reason = simResult.reason ?? `Pre-signing simulation failed on ${chain}`;
      const code = reason.includes('CIRCLE_USDC_BLACKLISTED')
        ? 'CIRCLE_USDC_BLACKLISTED'
        : 'EVM_SIMULATION_FAILED';
      throw new UsdcSafetyGuardError(code, reason);
    }
  } else {
    // chain === 'stellar'
    if (!isValidStellarAccountId(input.recipientAddress)) {
      throw new UsdcSafetyGuardError(
        'INVALID_RECIPIENT_ADDRESS',
        `Invalid Stellar recipient public key: ${input.recipientAddress}`
      );
    }

    if (!input.stellarTrustlineVerifier) {
      throw new UsdcSafetyGuardError(
        'MISSING_STELLAR_USDC_TRUSTLINE',
        'Missing StellarTrustlineVerifier: refusing to sign Stellar transfer without trustline verification'
      );
    }

    const hasTrustline = await input.stellarTrustlineVerifier.hasUsdcTrustline(
      input.recipientAddress
    );
    if (!hasTrustline) {
      throw new UsdcSafetyGuardError(
        'MISSING_STELLAR_USDC_TRUSTLINE',
        `Recipient ${input.recipientAddress} does not hold an existing authorized Circle USDC trustline (trustline/account sponsorship prohibited)`
      );
    }
  }

  return {
    chain,
    recipientAddress: input.recipientAddress.trim(),
    amountUnits1e8: input.amountUnits1e8,
    usdcPriceFormatted: pegResult.priceFormatted,
  };
}
