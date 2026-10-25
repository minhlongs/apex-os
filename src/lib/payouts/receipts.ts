/**
 * src/lib/payouts/receipts.ts
 *
 * Payout receipts for affiliates whose transfers the settlement cycle
 * confirmed. A receipt asserts that USDC arrived, so it is queued only for
 * payouts the cycle settled on-chain — never for a broadcast that was merely
 * submitted. Callers schedule payouts; this module reports what landed.
 */

import { error as logError } from '@/lib/logger';
import { enqueueTransactional } from '@/lib/emails/executor';
import { payoutCompletedTemplate } from '@/lib/emails/templates';

export interface SettledPayout {
  affiliateId: string;
  affiliateEmail: string;
  affiliateName: string | null;
  amount: number;
  payoutId: string;
  transactionId?: string | null;
}

/**
 * Queue one receipt per settled payout, without blocking the caller. A failure
 * to enqueue is logged and swallowed: the transfer already happened and the
 * email is not worth failing the settlement cycle over.
 */
export function queuePayoutReceipts(payouts: SettledPayout[]): void {
  for (const payout of payouts) {
    try {
      if (!payout.affiliateEmail) continue;

      const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'https://apex-os.com';
      const explorerUrl = payout.transactionId
        ? `https://stellar.expert/explorer/testnet/tx/${payout.transactionId}`
        : `${baseUrl}/dashboard/payouts`;

      const html = payoutCompletedTemplate({
        userName: payout.affiliateName || payout.affiliateEmail,
        userEmail: payout.affiliateEmail,
        locale: 'en',
        baseUrl,
        amount: payout.amount,
        transactionHash: payout.transactionId || payout.payoutId,
        walletAddress: '',
        network: 'testnet',
        payoutDate: new Date().toISOString(),
        explorerUrl,
      });

      enqueueTransactional({
        userId: payout.affiliateId,
        email: payout.affiliateEmail,
        type: 'payout-completed',
        subject: `Payout Sent: ${payout.amount.toFixed(2)} USDC to your wallet`,
        html,
        priority: 1,
        metadata: { payoutId: payout.payoutId, amount: payout.amount },
      });
    } catch (receiptError) {
      logError(
        `[Payouts] receipt enqueue failed for ${payout.affiliateId}:`,
        receiptError
      );
    }
  }
}
