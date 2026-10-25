import { confirmOnChain, isSettled } from '../settlement-gate';
import type { PayoutRouter } from '../router';
import type { TransactionVerificationResult } from '../types';

describe('Settlement Gate Tests', () => {
  it('returns kind: "failed" when transactionId is null or empty', async () => {
    const mockRouter: Pick<PayoutRouter, 'verifyTransaction'> = {
      verifyTransaction: jest.fn(),
    };

    const v1 = await confirmOnChain({
      chain: 'stellar',
      transactionId: null,
      router: mockRouter,
    });
    expect(v1.kind).toBe('failed');
    expect(isSettled(v1)).toBe(false);

    const v2 = await confirmOnChain({
      chain: 'stellar',
      transactionId: '   ',
      router: mockRouter,
    });
    expect(v2.kind).toBe('failed');
    expect(mockRouter.verifyTransaction).not.toHaveBeenCalled();
  });

  it('returns kind: "paid" when on-chain status is confirmed and verified: true', async () => {
    const mockRouter: Pick<PayoutRouter, 'verifyTransaction'> = {
      verifyTransaction: jest.fn(async (): Promise<TransactionVerificationResult> => ({
        transactionId: 'tx_verified_123',
        verified: true,
        status: 'confirmed',
        confirmations: 3,
        timestamp: new Date().toISOString(),
      })),
    };

    const verdict = await confirmOnChain({
      chain: 'stellar',
      transactionId: 'tx_verified_123',
      router: mockRouter,
    });

    expect(verdict.kind).toBe('paid');
    expect(isSettled(verdict)).toBe(true);
  });

  it('returns kind: "pending" when on-chain status is pending or not verified', async () => {
    const mockRouter: Pick<PayoutRouter, 'verifyTransaction'> = {
      verifyTransaction: jest.fn(async (): Promise<TransactionVerificationResult> => ({
        transactionId: 'tx_pending_123',
        verified: false,
        status: 'pending',
        confirmations: 0,
        timestamp: new Date().toISOString(),
      })),
    };

    const verdict = await confirmOnChain({
      chain: 'stellar',
      transactionId: 'tx_pending_123',
      router: mockRouter,
    });

    expect(verdict.kind).toBe('pending');
    expect(isSettled(verdict)).toBe(false);
  });

  it('returns kind: "pending" (leave earnings unpaid to retry) when verifyTransaction throws', async () => {
    const mockRouter: Pick<PayoutRouter, 'verifyTransaction'> = {
      verifyTransaction: jest.fn(async () => {
        throw new Error('RPC endpoint unavailable');
      }),
    };

    const verdict = await confirmOnChain({
      chain: 'stellar',
      transactionId: 'tx_failed_123',
      router: mockRouter,
    });

    expect(verdict.kind).toBe('pending');
    expect(isSettled(verdict)).toBe(false);
  });
});
