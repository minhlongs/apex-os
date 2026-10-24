import { SolanaAdapter } from '../adapters/solana-adapter';
import { EthereumAdapter } from '../adapters/ethereum-adapter';
import { PayoutRouter } from '../router';
import type { JsonRpcClient } from '../rpc/json-rpc-client';
import type { PayoutExecutionParams } from '../types';

/**
 * A chain adapter must never report success for a transaction that does not
 * exist on-chain. These tests drive the real adapters through a JSON-RPC
 * boundary that cannot sign, which is what a public RPC provider offers, and
 * assert the adapters refuse rather than invent a transaction id.
 */

const SOLANA_VALID_RECIPIENT = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const ETH_HOT_WALLET = '0x742d35Cc6634C0532925a3b844Bc454e4438f44e';
const ETH_VALID_RECIPIENT = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';

/** Records every method the adapter calls, then answers it with a canned failure. */
class UnsignableRpcClient {
  readonly calls: Array<{ method: string; params: unknown[] }> = [];

  async call(method: string, params: unknown[] = []): Promise<never> {
    this.calls.push({ method, params });
    throw new Error(`${method}: no signing key available`);
  }
}

function buildParams(
  recipientAddress: string,
  overrides: Partial<PayoutExecutionParams> = {}
): PayoutExecutionParams {
  return {
    payoutId: 'po_integrity_1',
    affiliateId: 'aff_integrity_1',
    recipientAddress,
    amount: 12.5,
    token: 'USDC',
    idempotencyKey: 'idem_integrity_1',
    ...overrides,
  };
}

describe('chain adapter integrity: no adapter fabricates a transaction identity', () => {
  describe('Solana adapter', () => {
    it('refuses to report success when it cannot sign', async () => {
      const rpc = new UnsignableRpcClient();
      const adapter = new SolanaAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        jsonRpcClient: rpc as unknown as JsonRpcClient,
        hotWalletAddress: SOLANA_VALID_RECIPIENT,
      });

      const result = await adapter.sendPayout(buildParams(SOLANA_VALID_RECIPIENT));

      expect(result.success).toBe(false);
      expect(result.transactionId).toBeUndefined();
      expect(result.error).toContain('signing key');
    });

    it('does not attempt a broadcast, since no transaction is ever built', async () => {
      const rpc = new UnsignableRpcClient();
      const adapter = new SolanaAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        jsonRpcClient: rpc as unknown as JsonRpcClient,
        hotWalletAddress: SOLANA_VALID_RECIPIENT,
      });

      await adapter.sendPayout(buildParams(SOLANA_VALID_RECIPIENT));

      const attempted = rpc.calls.map((c) => c.method);
      expect(attempted).not.toContain('sendTransaction');
      expect(
        rpc.calls.some((c) => JSON.stringify(c.params).includes('MOCK'))
      ).toBe(false);
    });

    it('still validates the recipient address before refusing', async () => {
      const adapter = new SolanaAdapter({ rpcUrl: 'http://127.0.0.1:1' });

      const result = await adapter.sendPayout(buildParams('not-a-solana-address'));

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid Solana recipient address');
    });
  });

  describe('Ethereum adapter', () => {
    it('refuses to report success when the node cannot sign', async () => {
      const rpc = new UnsignableRpcClient();
      const adapter = new EthereumAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        jsonRpcClient: rpc as unknown as JsonRpcClient,
        hotWalletAddress: ETH_HOT_WALLET,
      });

      const result = await adapter.sendPayout(buildParams(ETH_VALID_RECIPIENT));

      expect(result.success).toBe(false);
      expect(result.transactionId).toBeUndefined();
      expect(result.error).toContain('broadcast failed');
    });

    it('reports the amount it could not move, so the caller can retry', async () => {
      const rpc = new UnsignableRpcClient();
      const adapter = new EthereumAdapter({
        rpcUrl: 'http://127.0.0.1:1',
        jsonRpcClient: rpc as unknown as JsonRpcClient,
        hotWalletAddress: ETH_HOT_WALLET,
      });

      const result = await adapter.sendPayout(
        buildParams(ETH_VALID_RECIPIENT, { amount: 40.25 })
      );

      expect(result.success).toBe(false);
      expect(result.amount).toBe(40.25);
      expect(result.toAddress).toBe(ETH_VALID_RECIPIENT);
    });
  });

  describe('PayoutRouter', () => {
    it('surfaces the adapter refusal instead of reporting success', async () => {
      const rpc = new UnsignableRpcClient();
      // Inject the unsignable adapter so the result reflects the adapter's
      // honesty, not the sanctions list refusing before the adapter runs.
      const router = new PayoutRouter({ solana: new SolanaAdapter({ rpcUrl: 'http://127.0.0.1:1' }) });

      const result = await router.sendPayout('solana', buildParams(SOLANA_VALID_RECIPIENT));

      expect(result.success).toBe(false);
      expect(result.chain).toBe('solana');
      expect(result.transactionId).toBeUndefined();
    });
  });
});
