/**
 * src/lib/payouts/__tests__/receipts.test.ts
 *
 * A payout receipt asserts that USDC arrived. It is therefore only queueable
 * for a payout the settlement cycle confirmed, and an invalid or unknown
 * destination must not silently enqueue into a void.
 */

import { queuePayoutReceipts } from '../receipts';
import { payoutCompletedTemplate } from '@/lib/emails/templates';

const enqueued: Array<Record<string, any>> = [];
let enqueueThrows = false;

jest.mock('@/lib/emails/executor', () => ({
  enqueueTransactional: jest.fn((input: Record<string, any>) => {
    if (enqueueThrows) throw new Error('queue unavailable');
    enqueued.push(input);
    return input;
  }),
}));

jest.mock('@/lib/emails/templates', () => ({
  payoutCompletedTemplate: jest.fn(() => '<html>receipt</html>'),
}));

function settled(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    affiliateId: 'aff_1',
    affiliateEmail: 'user@example.com',
    affiliateName: 'User One',
    amount: 250,
    payoutId: 'payout_1',
    transactionId: 'tx_abc',
    ...overrides,
  } as never;
}

beforeEach(() => {
  enqueued.length = 0;
  enqueueThrows = false;
});

describe('queuePayoutReceipts', () => {
  it('queues a receipt carrying the amount and confirmed transaction', () => {
    queuePayoutReceipts([settled()]);

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toMatchObject({
      userId: 'aff_1',
      email: 'user@example.com',
      type: 'payout-completed',
    });
    expect(enqueued[0].subject).toContain('250.00');
  });

  it('skips a payout the caller could not attribute to a user', () => {
    queuePayoutReceipts([settled({ affiliateEmail: '' })]);

    expect(enqueued).toHaveLength(0);
  });

  it('continues queuing the remaining receipts when one fails', () => {
    enqueueThrows = true;

    expect(() => queuePayoutReceipts([settled()])).not.toThrow();
  });

  it('does nothing when there are no settled payouts', () => {
    queuePayoutReceipts([]);

    expect(enqueued).toHaveLength(0);
  });

  it('uses public explorer URL and mainnet network when STELLAR_NETWORK=mainnet', () => {
    const prevNetwork = process.env.STELLAR_NETWORK;
    process.env.STELLAR_NETWORK = 'mainnet';
    try {
      queuePayoutReceipts([settled({ transactionId: 'tx_mainnet_999' })]);
      expect(payoutCompletedTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          network: 'mainnet',
          explorerUrl: 'https://stellar.expert/explorer/public/tx/tx_mainnet_999',
        })
      );
    } finally {
      if (prevNetwork === undefined) delete process.env.STELLAR_NETWORK;
      else process.env.STELLAR_NETWORK = prevNetwork;
    }
  });

  it('uses testnet explorer URL when STELLAR_NETWORK=testnet', () => {
    const prevNetwork = process.env.STELLAR_NETWORK;
    process.env.STELLAR_NETWORK = 'testnet';
    try {
      queuePayoutReceipts([settled({ transactionId: 'tx_testnet_999' })]);
      expect(payoutCompletedTemplate).toHaveBeenLastCalledWith(
        expect.objectContaining({
          network: 'testnet',
          explorerUrl: 'https://stellar.expert/explorer/testnet/tx/tx_testnet_999',
        })
      );
    } finally {
      if (prevNetwork === undefined) delete process.env.STELLAR_NETWORK;
      else process.env.STELLAR_NETWORK = prevNetwork;
    }
  });
});
