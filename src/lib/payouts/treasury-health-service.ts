/**
 * src/lib/payouts/treasury-health-service.ts
 *
 * ApexOS Multi-Chain Automated Payout Rails & Settlement Engine
 * Treasury Health Service & Automated Circuit Breaker / Pause Gate
 *
 * Monitors native gas tokens and stablecoin reserves across supported chains
 * (Stellar, Ethereum, Solana), evaluates balances against configurable safety floors,
 * assigns health status levels (HEALTHY, LOW_RESERVE, CRITICAL), and enforces
 * circuit-breaker gates to pause automated batch settlements when reserves are depleted.
 */

import type {
  SupportedPayoutChain,
  HealthStatusLevel,
  ChainTreasuryHealth,
  TreasuryHealthReport,
  TreasuryHealthService as ITreasuryHealthService,
} from './types';
import { SUPPORTED_PAYOUT_CHAINS } from './types';
import { PayoutRouter, payoutRouter } from './router';

/**
 * Safety floor threshold configuration for a single chain
 */
export interface SafetyFloorConfig {
  nativeGasFloor: number;
  stablecoinReserveFloor: number;
}

/**
 * Default safety floors across supported payout chains
 */
export const DEFAULT_SAFETY_FLOORS: Record<SupportedPayoutChain, SafetyFloorConfig> = {
  stellar: {
    nativeGasFloor: 5,            // 5 XLM
    stablecoinReserveFloor: 100,  // $100 USDC
  },
  ethereum: {
    nativeGasFloor: 0.05,         // 0.05 ETH
    stablecoinReserveFloor: 500,  // $500 USDC
  },
  solana: {
    nativeGasFloor: 0.2,          // 0.2 SOL
    stablecoinReserveFloor: 500,  // $500 USDC
  },
};

/**
 * Result returned by canSettle circuit breaker evaluation
 */
export interface CanSettleResult {
  allowed: boolean;
  reason?: string;
  report: TreasuryHealthReport;
}

/**
 * Helper to capitalize chain name for human-readable audit messages
 */
function capitalizeChain(chain: string): string {
  if (!chain) return '';
  return chain.charAt(0).toUpperCase() + chain.slice(1);
}

/**
 * Treasury Health Service
 * Provides multi-chain balance monitoring, safety floor enforcement,
 * and automated settlement circuit breaker gating.
 */
export class TreasuryHealthService implements ITreasuryHealthService {
  private router: PayoutRouter;
  private safetyFloors: Record<SupportedPayoutChain, SafetyFloorConfig>;
  private lastKnownChainHealth: Map<SupportedPayoutChain, ChainTreasuryHealth>;
  private lastReport: TreasuryHealthReport | null = null;

  constructor(
    router?: PayoutRouter,
    customFloors?: Partial<Record<SupportedPayoutChain, Partial<SafetyFloorConfig>>>
  ) {
    this.router = router ?? payoutRouter;
    this.lastKnownChainHealth = new Map<SupportedPayoutChain, ChainTreasuryHealth>();

    // Deep merge default safety floors with any custom overrides
    this.safetyFloors = {
      stellar: {
        ...DEFAULT_SAFETY_FLOORS.stellar,
        ...(customFloors?.stellar ?? {}),
      },
      ethereum: {
        ...DEFAULT_SAFETY_FLOORS.ethereum,
        ...(customFloors?.ethereum ?? {}),
      },
      solana: {
        ...DEFAULT_SAFETY_FLOORS.solana,
        ...(customFloors?.solana ?? {}),
      },
    };
  }

  /**
   * Return the PayoutRouter instance used by this service
   */
  getRouter(): PayoutRouter {
    return this.router;
  }

  /**
   * Get the active safety floors for a specific chain
   */
  getSafetyFloors(chain: SupportedPayoutChain): SafetyFloorConfig {
    this.assertSupportedChain(chain);
    return { ...this.safetyFloors[chain] };
  }

  /**
   * Get all active safety floors across all supported chains
   */
  getAllSafetyFloors(): Record<SupportedPayoutChain, SafetyFloorConfig> {
    return {
      stellar: { ...this.safetyFloors.stellar },
      ethereum: { ...this.safetyFloors.ethereum },
      solana: { ...this.safetyFloors.solana },
    };
  }

  /**
   * Update safety floor thresholds for a specific chain
   */
  updateSafetyFloors(
    chain: SupportedPayoutChain,
    floors: Partial<SafetyFloorConfig>
  ): SafetyFloorConfig {
    this.assertSupportedChain(chain);

    if (floors.nativeGasFloor !== undefined) {
      if (
        typeof floors.nativeGasFloor !== 'number' ||
        !Number.isFinite(floors.nativeGasFloor) ||
        floors.nativeGasFloor < 0
      ) {
        throw new Error(
          `Invalid nativeGasFloor: must be a non-negative finite number (received: ${floors.nativeGasFloor})`
        );
      }
    }

    if (floors.stablecoinReserveFloor !== undefined) {
      if (
        typeof floors.stablecoinReserveFloor !== 'number' ||
        !Number.isFinite(floors.stablecoinReserveFloor) ||
        floors.stablecoinReserveFloor < 0
      ) {
        throw new Error(
          `Invalid stablecoinReserveFloor: must be a non-negative finite number (received: ${floors.stablecoinReserveFloor})`
        );
      }
    }

    this.safetyFloors[chain] = {
      ...this.safetyFloors[chain],
      ...floors,
    };

    return { ...this.safetyFloors[chain] };
  }

  /**
   * Reset safety floors to default thresholds
   */
  resetSafetyFloors(chain?: SupportedPayoutChain): void {
    if (chain) {
      this.assertSupportedChain(chain);
      this.safetyFloors[chain] = { ...DEFAULT_SAFETY_FLOORS[chain] };
    } else {
      this.safetyFloors = {
        stellar: { ...DEFAULT_SAFETY_FLOORS.stellar },
        ethereum: { ...DEFAULT_SAFETY_FLOORS.ethereum },
        solana: { ...DEFAULT_SAFETY_FLOORS.solana },
      };
    }
  }

  /**
   * Query hot wallet balances across requested chain(s), evaluate against safety floors,
   * and compute health status levels (HEALTHY, LOW_RESERVE, CRITICAL).
   *
   * @param chain Optional single chain to inspect. If omitted, all supported chains are checked.
   * @returns TreasuryHealthReport
   */
  async checkHealth(chain?: SupportedPayoutChain): Promise<TreasuryHealthReport> {
    if (chain) {
      this.assertSupportedChain(chain);
    }

    const monitoredChains: SupportedPayoutChain[] = chain ? [chain] : [...SUPPORTED_PAYOUT_CHAINS];

    // Query hot wallet balances and evaluate health in parallel across requested chain(s)
    const evaluatedResults = await Promise.all(
      monitoredChains.map((c) => this.evaluateChain(c))
    );

    // Update in-memory cache of last-known health for monitored chains
    for (const health of evaluatedResults) {
      this.lastKnownChainHealth.set(health.chain, health);
    }

    // Build the full chains map for the report
    const chainsRecord: Record<SupportedPayoutChain, ChainTreasuryHealth> = {
      stellar: this.getChainReportEntry('stellar'),
      ethereum: this.getChainReportEntry('ethereum'),
      solana: this.getChainReportEntry('solana'),
    };

    // Calculate globalStatus, warnings, and errors across monitored chain(s)
    const warnings: string[] = [];
    const errors: string[] = [];
    let hasCritical = false;
    let hasLowReserve = false;

    for (const c of monitoredChains) {
      const health = chainsRecord[c];
      if (health.status === 'CRITICAL') {
        hasCritical = true;
        errors.push(health.message || `${capitalizeChain(c)} treasury is in CRITICAL state`);
      } else if (health.status === 'LOW_RESERVE') {
        hasLowReserve = true;
        warnings.push(health.message || `${capitalizeChain(c)} treasury has LOW_RESERVE`);
      }
    }

    let globalStatus: HealthStatusLevel = 'HEALTHY';
    if (hasCritical) {
      globalStatus = 'CRITICAL';
    } else if (hasLowReserve) {
      globalStatus = 'LOW_RESERVE';
    } else {
      globalStatus = 'HEALTHY';
    }

    const report: TreasuryHealthReport = {
      globalStatus,
      chains: chainsRecord,
      canSettle: globalStatus !== 'CRITICAL',
      checkedAt: new Date().toISOString(),
      warnings,
      errors,
    };

    this.lastReport = report;
    return report;
  }

  /**
   * Automated Circuit Breaker / Pause Gate:
   * Validates settlement parameters, queries fresh treasury health on the target chain,
   * halts execution if the chain is CRITICAL or if available reserves are insufficient
   * to cover the payout plus estimated gas fees.
   *
   * @param amountUsd Settlement gross or net amount in USD
   * @param chain Target payout chain
   * @param estimatedGasUsd Optional estimated network fee in USD
   * @returns CanSettleResult indicating whether settlement is allowed, reason if blocked, and fresh report
   */
  async canSettle(
    amountUsd: number,
    chain: SupportedPayoutChain,
    estimatedGasUsd?: number
  ): Promise<CanSettleResult> {
    this.assertSupportedChain(chain);

    // 1. Validate that settlement amount is positive and finite
    if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd) || amountUsd <= 0) {
      const report = await this.checkHealth(chain);
      return {
        allowed: false,
        reason: `Invalid settlement amount: amount must be a positive finite number (received: ${amountUsd})`,
        report,
      };
    }

    // 2. Validate estimatedGasUsd if provided
    if (
      estimatedGasUsd !== undefined &&
      (typeof estimatedGasUsd !== 'number' || !Number.isFinite(estimatedGasUsd) || estimatedGasUsd < 0)
    ) {
      const report = await this.checkHealth(chain);
      return {
        allowed: false,
        reason: `Invalid estimated gas amount: gas fee must be a non-negative finite number (received: ${estimatedGasUsd})`,
        report,
      };
    }

    const gasUsd = estimatedGasUsd ?? 0;
    const totalRequiredUsd = amountUsd + gasUsd;

    // 3. Query fresh treasury health for the target chain
    const report = await this.checkHealth(chain);
    const chainHealth = report.chains[chain];
    const chainName = capitalizeChain(chain);

    // 4. Circuit Breaker Trip: If chain health is CRITICAL, halt automated settlement
    if (chainHealth.status === 'CRITICAL') {
      let circuitBreakerReason = `Automated settlement halted: ${chainName} treasury in CRITICAL state`;

      if (!chainHealth.rpcHealthy) {
        circuitBreakerReason += ` due to RPC connection failure`;
      } else if (
        chainHealth.nativeGasBalance < chainHealth.nativeGasFloor &&
        chainHealth.stablecoinBalance < chainHealth.stablecoinReserveFloor
      ) {
        circuitBreakerReason += ` due to low ${chainHealth.nativeGasSymbol} gas balance and low stablecoin reserve`;
      } else if (chainHealth.nativeGasBalance < chainHealth.nativeGasFloor) {
        circuitBreakerReason += ` due to low ${chainHealth.nativeGasSymbol} gas balance`;
      } else if (chainHealth.stablecoinBalance < chainHealth.stablecoinReserveFloor) {
        circuitBreakerReason += ` due to low stablecoin reserve`;
      } else if (chainHealth.message) {
        circuitBreakerReason += ` due to ${chainHealth.message}`;
      }

      return {
        allowed: false,
        reason: circuitBreakerReason,
        report,
      };
    }

    // 5. Reserve Coverage Check: Token balance must cover payout amount plus estimated gas
    if (chainHealth.stablecoinBalance < totalRequiredUsd) {
      return {
        allowed: false,
        reason: `Insufficient treasury reserves on ${chainName}: available $${chainHealth.stablecoinBalance.toFixed(
          2
        )} is less than required $${totalRequiredUsd.toFixed(2)} (payout: $${amountUsd.toFixed(
          2
        )}, estimated gas: $${gasUsd.toFixed(2)})`,
        report,
      };
    }

    // 6. Settle Allowed
    return {
      allowed: true,
      report,
    };
  }

  /**
   * Return the most recent TreasuryHealthReport generated by this service
   */
  getLastReport(): TreasuryHealthReport | null {
    return this.lastReport;
  }

  /**
   * Helper to retrieve or construct a ChainTreasuryHealth entry for report generation
   */
  private getChainReportEntry(chain: SupportedPayoutChain): ChainTreasuryHealth {
    const cached = this.lastKnownChainHealth.get(chain);
    if (cached) {
      return { ...cached };
    }

    // Standby baseline for chains not yet evaluated in a targeted single-chain check
    const floors = this.safetyFloors[chain];
    return {
      chain,
      status: 'HEALTHY',
      hotWalletAddress: 'UNINSPECTED',
      nativeGasBalance: 0,
      nativeGasSymbol: this.getNativeGasSymbol(chain),
      nativeGasFloor: floors.nativeGasFloor,
      stablecoinBalance: 0,
      stablecoinReserveFloor: floors.stablecoinReserveFloor,
      rpcHealthy: true,
      message: `Chain not evaluated in targeted single-chain health check`,
    };
  }

  /**
   * Internal evaluation of a single chain against its safety floors
   */
  private async evaluateChain(chain: SupportedPayoutChain): Promise<ChainTreasuryHealth> {
    const floors = this.safetyFloors[chain];
    const nativeGasSymbol = this.getNativeGasSymbol(chain);
    const chainName = capitalizeChain(chain);

    try {
      const adapter = this.router.getAdapter(chain);
      const balanceResult = await adapter.getTreasuryBalance();

      const hotWalletAddress = balanceResult.hotWalletAddress || 'UNKNOWN';
      const isUnconfigured =
        !balanceResult.hotWalletAddress || balanceResult.hotWalletAddress === 'UNCONFIGURED';
      const rpcHealthy = !isUnconfigured;

      const nativeGasBalance =
        typeof balanceResult.nativeBalance === 'number' &&
        Number.isFinite(balanceResult.nativeBalance)
          ? balanceResult.nativeBalance
          : 0;

      // Extract stablecoin balances (USDC and USDT)
      let stablecoinBalance = 0;
      if (balanceResult.tokenBalances && typeof balanceResult.tokenBalances === 'object') {
        for (const [token, amount] of Object.entries(balanceResult.tokenBalances)) {
          const upperToken = token.toUpperCase();
          if (
            (upperToken === 'USDC' || upperToken === 'USDT') &&
            typeof amount === 'number' &&
            Number.isFinite(amount)
          ) {
            stablecoinBalance += amount;
          }
        }
      }

      // If adapter reported unconfigured address or RPC unhealthy
      if (!rpcHealthy) {
        return {
          chain,
          status: 'CRITICAL',
          hotWalletAddress,
          nativeGasBalance,
          nativeGasSymbol,
          nativeGasFloor: floors.nativeGasFloor,
          stablecoinBalance,
          stablecoinReserveFloor: floors.stablecoinReserveFloor,
          rpcHealthy: false,
          message: `${chainName} RPC connection failure or unconfigured hot wallet`,
        };
      }

      // 1. Evaluate CRITICAL: Native gas < safety floor, OR token balance < safety floor
      const isGasCritical = nativeGasBalance < floors.nativeGasFloor;
      const isTokenCritical = stablecoinBalance < floors.stablecoinReserveFloor;

      if (isGasCritical || isTokenCritical) {
        const criticalReasons: string[] = [];
        if (isGasCritical) {
          criticalReasons.push(
            `low ${nativeGasSymbol} gas balance (${nativeGasBalance} < floor ${floors.nativeGasFloor})`
          );
        }
        if (isTokenCritical) {
          criticalReasons.push(
            `low stablecoin reserve ($${stablecoinBalance.toFixed(
              2
            )} < floor $${floors.stablecoinReserveFloor.toFixed(2)})`
          );
        }

        return {
          chain,
          status: 'CRITICAL',
          hotWalletAddress,
          nativeGasBalance,
          nativeGasSymbol,
          nativeGasFloor: floors.nativeGasFloor,
          stablecoinBalance,
          stablecoinReserveFloor: floors.stablecoinReserveFloor,
          rpcHealthy: true,
          message: `${chainName} treasury is in CRITICAL state due to ${criticalReasons.join(
            ' and '
          )}`,
        };
      }

      // 2. Evaluate LOW_RESERVE: Native gas < 2x safety floor OR token balance < 2x safety floor
      const isGasLow = nativeGasBalance < 2 * floors.nativeGasFloor;
      const isTokenLow = stablecoinBalance < 2 * floors.stablecoinReserveFloor;

      if (isGasLow || isTokenLow) {
        const lowWarnings: string[] = [];
        if (isGasLow) {
          lowWarnings.push(
            `native ${nativeGasSymbol} gas (${nativeGasBalance} < 2x floor ${2 * floors.nativeGasFloor})`
          );
        }
        if (isTokenLow) {
          lowWarnings.push(
            `stablecoin reserve ($${stablecoinBalance.toFixed(2)} < 2x floor $${(
              2 * floors.stablecoinReserveFloor
            ).toFixed(2)})`
          );
        }

        return {
          chain,
          status: 'LOW_RESERVE',
          hotWalletAddress,
          nativeGasBalance,
          nativeGasSymbol,
          nativeGasFloor: floors.nativeGasFloor,
          stablecoinBalance,
          stablecoinReserveFloor: floors.stablecoinReserveFloor,
          rpcHealthy: true,
          message: `${chainName} treasury has LOW_RESERVE: ${lowWarnings.join(', ')}`,
        };
      }

      // 3. HEALTHY: Native gas and token balances >= 2x safety floor with RPC healthy
      return {
        chain,
        status: 'HEALTHY',
        hotWalletAddress,
        nativeGasBalance,
        nativeGasSymbol,
        nativeGasFloor: floors.nativeGasFloor,
        stablecoinBalance,
        stablecoinReserveFloor: floors.stablecoinReserveFloor,
        rpcHealthy: true,
        message: `${chainName} treasury is healthy`,
      };
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      return {
        chain,
        status: 'CRITICAL',
        hotWalletAddress: 'UNKNOWN',
        nativeGasBalance: 0,
        nativeGasSymbol,
        nativeGasFloor: floors.nativeGasFloor,
        stablecoinBalance: 0,
        stablecoinReserveFloor: floors.stablecoinReserveFloor,
        rpcHealthy: false,
        message: `${chainName} adapter connection failure: ${errorMsg}`,
      };
    }
  }

  /**
   * Return the native gas symbol for a given chain
   */
  private getNativeGasSymbol(chain: SupportedPayoutChain): string {
    switch (chain) {
      case 'stellar':
        return 'XLM';
      case 'ethereum':
        return 'ETH';
      case 'solana':
        return 'SOL';
      default:
        return 'GAS';
    }
  }

  /**
   * Validate that a given string is a supported payout chain
   */
  private assertSupportedChain(chain: string): asserts chain is SupportedPayoutChain {
    if (!SUPPORTED_PAYOUT_CHAINS.includes(chain as SupportedPayoutChain)) {
      throw new Error(
        `Unsupported payout chain: '${chain}'. Supported chains: ${SUPPORTED_PAYOUT_CHAINS.join(
          ', '
        )}`
      );
    }
  }
}

/**
 * Singleton instance of TreasuryHealthService with default PayoutRouter
 */
export const treasuryHealthService = new TreasuryHealthService();
