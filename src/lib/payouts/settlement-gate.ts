/**
 * Settlement gate — the single place where a payout may be marked paid.
 *
 * A chain adapter returning `success: true` means only that a transaction was
 * *submitted*. It is not evidence that USDC arrived. Previously both payout
 * paths treated "submitted" as "confirmed": `executeBatch` flipped
 * `is_paid = 1` on `execRes.success` alone, and the weekly cron flipped it on
 * a plain database write with no chain interaction at all. Users were marked
 * paid for transfers that may never have happened.
 *
 * This module is the shared enforcement point. Both the admin batch path and
 * the weekly cron must call `confirmOnChain` before any `is_paid = 1` write,
 * so the invariant has one implementation rather than two that can drift.
 */

import type { PayoutRouter } from './router';
import type { SupportedPayoutChain } from './types';

/** On-chain states that genuinely mean the recipient received the funds. */
export const CONFIRMED_STATUSES = ['confirmed'] as const;

export type SettlementVerdict =
  | { kind: 'paid'; transactionId: string; confirmations: number }
  | { kind: 'pending'; transactionId: string; reason: string }
  | { kind: 'failed'; transactionId: string | null; reason: string };

export interface ConfirmOnChainParams {
  /** Chain the payout was broadcast on. */
  chain: SupportedPayoutChain;
  /** Transaction id returned by the adapter. */
  transactionId: string | null | undefined;
  /** Router used to ask the adapter for on-chain state. */
  router: Pick<PayoutRouter, 'verifyTransaction'>;
}

/**
 * A transaction id must be a real value returned by the adapter. An absent id
 * means nothing was broadcast, so there is nothing to verify and nothing to
 * pay. This deliberately does not pattern-match on id shape: encoding test
 * fixture conventions into production logic would couple the two and silently
 * misjudge a legitimate transfer. Identity is validated at the adapter.
 */
function isUnusableTransactionId(transactionId: string | null | undefined): boolean {
  if (typeof transactionId !== 'string') return true;
  return transactionId.trim().length === 0;
}

/**
 * Resolve whether a broadcast payout is actually confirmed on-chain.
 *
 * Returns `pending` rather than throwing when verification is inconclusive, so
 * the caller can leave earnings unpaid and retry on the next cycle instead of
 * either double-paying or marking a failed transfer as settled.
 */
export async function confirmOnChain(params: ConfirmOnChainParams): Promise<SettlementVerdict> {
  const { chain, transactionId, router } = params;

  if (isUnusableTransactionId(transactionId)) {
    return {
      kind: 'failed',
      transactionId: transactionId ?? null,
      reason: 'Adapter returned no usable transaction id; transfer cannot be verified',
    };
  }

  let verification: Awaited<ReturnType<PayoutRouter['verifyTransaction']>>;
  try {
    verification = await router.verifyTransaction(chain, transactionId as string);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: 'pending',
      transactionId: transactionId as string,
      reason: `Verification unavailable, treat as unsettled: ${message}`,
    };
  }

  if (verification.verified && CONFIRMED_STATUSES.includes(verification.status as never)) {
    return {
      kind: 'paid',
      transactionId: transactionId as string,
      confirmations: verification.confirmations ?? 0,
    };
  }

  return {
    kind: 'pending',
    transactionId: transactionId as string,
    reason: `Transaction not yet confirmed (status: ${verification.status})`,
  };
}

/**
 * Report whether a submission may be retired as paid.
 *
 * Deliberately returns false for anything except a confirmed verdict, so a
 * caller cannot accidentally treat a throwaway or a pending state as settled.
 */
export function isSettled(verdict: SettlementVerdict): verdict is Extract<SettlementVerdict, { kind: 'paid' }> {
  return verdict.kind === 'paid';
}
