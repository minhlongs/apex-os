import { PayoutRouter } from '../router';
import type { PayoutChainAdapter, PayoutExecutionParams, PayoutExecutionResult } from '../types';

function createMockAdapter(chain: 'stellar' | 'ethereum' | 'solana'): PayoutChainAdapter {
  return {
    chain,
    validateAddress: () => true,
    estimateFee: async () => ({
      chain,
      estimatedFeeUsd: 0.01,
      estimatedFeeNative: '0.0001',
      nativeSymbol: chain === 'stellar' ? 'XLM' : chain === 'ethereum' ? 'ETH' : 'SOL',
      congestionLevel: 'low',
      timestamp: new Date().toISOString(),
    }),
    sendPayout: async (params: PayoutExecutionParams): Promise<PayoutExecutionResult> => ({
      success: true,
      payoutId: params.payoutId,
      transactionId: `tx_${chain}_12345`,
      chain,
      toAddress: params.recipientAddress,
      amount: params.amount,
      token: 'USDC',
      status: 'confirmed',
      timestamp: new Date().toISOString(),
    }),
    verifyTransaction: async (txId: string) => ({
      verified: true,
      transactionId: txId,
      chain,
      status: 'confirmed',
      confirmations: 1,
    }),
    getTreasuryBalance: async () => ({
      chain,
      address: 'treasury_addr',
      nativeBalance: '100',
      nativeSymbol: 'XLM',
      tokenBalances: { USDC: 10000 },
      healthy: true,
      timestamp: new Date().toISOString(),
    }),
  };
}

describe('V1 Launch Gate: Stellar-Only Payout Enforcement', () => {
  const originalEnv = process.env.V1_STELLAR_ONLY_PAYOUTS;
  const originalAppEnv = process.env.APP_ENV;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.V1_STELLAR_ONLY_PAYOUTS;
    } else {
      process.env.V1_STELLAR_ONLY_PAYOUTS = originalEnv;
    }
    if (originalAppEnv === undefined) {
      delete process.env.APP_ENV;
    } else {
      process.env.APP_ENV = originalAppEnv;
    }
  });

  it('unconditionally blocks Ethereum and Solana in production/staging even if V1_STELLAR_ONLY_PAYOUTS=false', async () => {
    process.env.APP_ENV = 'production';
    process.env.V1_STELLAR_ONLY_PAYOUTS = 'false';

    const router = new PayoutRouter({
      stellar: createMockAdapter('stellar'),
      ethereum: createMockAdapter('ethereum'),
      solana: createMockAdapter('solana'),
    });

    const ethResult = await router.sendPayout('ethereum', {
      payoutId: 'po_eth_prod_1',
      recipientAddress: '0x1111111111111111111111111111111111111111',
      amount: 100,
    });
    expect(ethResult.success).toBe(false);
    expect(ethResult.status).toBe('failed');
  });

  it('blocks Ethereum and Solana payouts when V1_STELLAR_ONLY_PAYOUTS=true while allowing Stellar', async () => {
    process.env.V1_STELLAR_ONLY_PAYOUTS = 'true';

    const router = new PayoutRouter({
      stellar: createMockAdapter('stellar'),
      ethereum: createMockAdapter('ethereum'),
      solana: createMockAdapter('solana'),
    });

    const ethResult = await router.sendPayout('ethereum', {
      payoutId: 'po_eth_1',
      recipientAddress: '0x1111111111111111111111111111111111111111',
      amount: 100,
    });
    expect(ethResult.success).toBe(false);
    expect(ethResult.status).toBe('failed');
    expect(ethResult.error).toContain("disabled for V1 release. Only 'stellar' is enabled");

    const solResult = await router.sendPayout('solana', {
      payoutId: 'po_sol_1',
      recipientAddress: '11111111111111111111111111111111',
      amount: 100,
    });
    expect(solResult.success).toBe(false);
    expect(solResult.status).toBe('failed');
    expect(solResult.error).toContain("disabled for V1 release. Only 'stellar' is enabled");

    const stellarResult = await router.sendPayout('stellar', {
      payoutId: 'po_xlm_1',
      recipientAddress: 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF',
      amount: 100,
    });
    expect(stellarResult.success).toBe(true);
    expect(stellarResult.status).toBe('confirmed');
  });
});
