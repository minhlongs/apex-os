/**
 * src/components/admin/treasury/treasury-helpers.ts
 *
 * Pure formatting and badge styling helpers for the Admin Multi-Chain Treasury Dashboard.
 */

import type { SupportedPayoutChain, HealthStatusLevel } from '@/lib/payouts/types';

export function getHealthBadgeStyle(status: HealthStatusLevel): string {
  switch (status) {
    case 'HEALTHY':
      return 'bg-emerald-50 text-emerald-700 border-emerald-200';
    case 'LOW_RESERVE':
      return 'bg-amber-50 text-amber-700 border-amber-200';
    case 'CRITICAL':
      return 'bg-red-50 text-red-700 border-red-200';
  }
}

export function formatChainDisplayName(chain: SupportedPayoutChain): string {
  switch (chain) {
    case 'stellar':
      return 'Stellar (USDC)';
    case 'ethereum':
      return 'Ethereum (EIP-1559)';
    case 'solana':
      return 'Solana (SPL)';
  }
}
