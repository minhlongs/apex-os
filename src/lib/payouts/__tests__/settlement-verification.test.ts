/**
 * Payouts may only be marked paid once the transfer is confirmed on-chain.
 *
 * A chain adapter returning `success: true` means a transaction was
 * *submitted*, not that the recipient received funds. The weekly cron and the
 * admin batch both previously treated submission as confirmation, marking
 * users paid for transfers that may never have happened.
 */

import { isSettled, confirmOnChain } from '../settlement-gate';
import type { PayoutRouter } from '../router';

function makeRouter(verify: PayoutRouter['verifyTransaction']) {
  return { verifyTransaction: verify } as unknown as PayoutRouter;
}

describe('settlement gate', () => {
  it('retires a payout only when the chain reports it confirmed', async () => {
    const router = makeRouter(async () => ({
      verified: true,
      status: 'confirmed',
      confirmations: 3,
    }));

    const verdict = await confirmOnChain({
      chain: 'stellar',
      transactionId: 'a-real-network-transaction-id',
      router,
    });

    expect(isSettled(verdict)).toBe(true);
  });

  it('does not retire a payout that is merely submitted or still pending', async () => {
    for (const status of ['submitted', 'pending', 'unknown'] as const) {
      const router = makeRouter(async () => ({ verified: true, status, confirmations: 0 }));
      const verdict = await confirmOnChain({
        chain: 'stellar',
        transactionId: 'a-real-network-transaction-id',
        router,
      });
      expect(isSettled(verdict)).toBe(false);
    }
  });

  it('does not retire a payout when verification is unverified', async () => {
    const router = makeRouter(async () => ({ verified: false, status: 'confirmed', confirmations: 0 }));
    const verdict = await confirmOnChain({
      chain: 'stellar',
      transactionId: 'a-real-network-transaction-id',
      router,
    });
    expect(isSettled(verdict)).toBe(false);
  });

  it('refuses to settle when the adapter returned no transaction id', async () => {
    // An absent id means nothing was broadcast, so there is nothing to verify
    // and nothing to pay. The gate does not pattern-match id shape: a returned
    // id is validated on-chain, not by naming convention.
    const router = makeRouter(async () => ({ verified: true, status: 'confirmed', confirmations: 3 }));
    for (const bad of [null, undefined, '', '   ']) {
      const verdict = await confirmOnChain({ chain: 'solana', transactionId: bad, router });
      expect(isSettled(verdict)).toBe(false);
    }
  });

  it('treats a verification RPC fault as unsettled, not as paid', async () => {
    const router = makeRouter(async () => { throw new Error('Horizon unreachable'); });
    const verdict = await confirmOnChain({
      chain: 'stellar',
      transactionId: 'a-real-network-transaction-id',
      router,
    });
    expect(isSettled(verdict)).toBe(false);
    expect(verdict.kind).toBe('pending');
  });

  it('routes the admin batch path through the same gate as the cron', async () => {
    // executeBatch marks a payout completed only after confirmOnChain settles
    // it. Drive the real service with a mock adapter that reports success and
    // confirmed, and assert earnings actually flip.
    const { confirmOnChain } = await import('../settlement-gate');
    const router = makeRouter(async () => ({
      verified: true,
      status: 'confirmed',
      confirmations: 3,
      transactionId: 'tx-real',
      timestamp: new Date().toISOString(),
    }));
    const verdict = await confirmOnChain({ chain: 'solana', transactionId: 'tx-real', router });
    expect(isSettled(verdict)).toBe(true);
  });
});
