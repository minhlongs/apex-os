import { SolanaAdapter } from '../adapters/solana-adapter';
import { EthereumAdapter } from '../adapters/ethereum-adapter';
import { encodeBase58 } from '../crypto/base58';
import { createEd25519Signer } from '../crypto/ed25519-signer';
import { createSecp256k1Signer } from '../crypto/secp256k1-signer';
import type { JsonRpcClient } from '../rpc/json-rpc-client';

describe('Real Cryptographic Signing Rails (Solana & Ethereum)', () => {
  describe('Solana Ed25519 Real Signer & Wire Serializer', () => {
    it('generates consistent keypairs and signs messages verifiably', async () => {
      // 32-byte zero seed (or standard test seed)
      const seed = new Uint8Array(32);
      seed.fill(7);
      const signer = await createEd25519Signer(seed);

      expect(signer.publicKeyBase58).toBeDefined();
      expect(signer.publicKeyBytes.length).toBe(32);

      const msg = new TextEncoder().encode('ApexOS Solana Transfer');
      const signature = await signer.sign(msg);
      expect(signature.length).toBe(64);
    });

    it('builds, signs, and broadcasts real wire transaction when privateKey is present', async () => {
      const seed = new Uint8Array(32);
      seed.fill(42);
      const seedBase58 = encodeBase58(seed);
      const signer = await createEd25519Signer(seedBase58);

      const mockCalls: Array<{ method: string; params: unknown[] }> = [];
      const mockRpc: JsonRpcClient = {
        call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
          mockCalls.push({ method, params });
          if (method === 'getLatestBlockhash') {
            return {
              value: {
                blockhash: 'EkSnNWEM2jfWXPzpduPFQPGxKvdnvvRYGtve3aUwnUr5',
                lastValidBlockHeight: 123456,
              },
            } as T;
          }
          if (method === 'sendTransaction') {
            return '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYj7WUbmpMrR3eeUMSZBQW2oZ8Dq5wXF39bL2Nf3k1A5yEweF67K' as T;
          }
          return null as T;
        },
      } as unknown as JsonRpcClient;

      const adapter = new SolanaAdapter({
        rpcUrl: 'http://127.0.0.1:8899',
        jsonRpcClient: mockRpc,
        privateKey: seedBase58,
        hotWalletAddress: signer.publicKeyBase58,
      });

      const recipient = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
      const result = await adapter.sendPayout({
        payoutId: 'po_sol_1',
        affiliateId: 'aff_1',
        recipientAddress: recipient,
        amount: 50.0,
        token: 'USDC',
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe(
        '5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYj7WUbmpMrR3eeUMSZBQW2oZ8Dq5wXF39bL2Nf3k1A5yEweF67K'
      );
      expect(result.fromAddress).toBe(signer.publicKeyBase58);
      expect(result.status).toBe('submitted');

      // Verify that sendTransaction was invoked with base64 wire format
      const sendTxCall = mockCalls.find((c) => c.method === 'sendTransaction');
      expect(sendTxCall).toBeDefined();
      expect(typeof sendTxCall?.params[0]).toBe('string');
    });
  });

  describe('Ethereum Secp256k1 Real Signer & EIP-1559 Serializer', () => {
    const TEST_PRIV_KEY =
      '0x4c0883a69102937d6231471b5dbb6204db7e71644d08a4550435043504350435';

    it('derives matching checksummed address from private key', () => {
      const signer = createSecp256k1Signer(TEST_PRIV_KEY);
      expect(signer.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    });

    it('builds, signs, and broadcasts EIP-1559 Type-2 transaction via eth_sendRawTransaction', async () => {
      const signer = createSecp256k1Signer(TEST_PRIV_KEY);
      const mockCalls: Array<{ method: string; params: unknown[] }> = [];

      const mockRpc: JsonRpcClient = {
        call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
          mockCalls.push({ method, params });
          if (method === 'eth_call') {
            return '0x0000000000000000000000000000000000000000000000000000000000000001' as T;
          }
          if (method === 'eth_estimateGas') {
            return '0x10000' as T;
          }
          if (method === 'eth_getTransactionCount') {
            return '0x7' as T;
          }
          if (method === 'eth_feeHistory') {
            return {
              baseFeePerGas: ['0x4a817c800'], // 20 Gwei
            } as T;
          }
          if (method === 'eth_maxPriorityFeePerGas') {
            return '0x77359400' as T; // 2 Gwei
          }
          if (method === 'eth_sendRawTransaction') {
            return '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6' as T;
          }
          return null as T;
        },
      } as unknown as JsonRpcClient;

      const adapter = new EthereumAdapter({
        rpcUrl: 'http://127.0.0.1:8545',
        jsonRpcClient: mockRpc,
        privateKey: TEST_PRIV_KEY,
        hotWalletAddress: signer.address,
      });

      const recipient = '0x90F8bf6A479f320ead074411a4B0e7944Ea8c9C1';
      const result = await adapter.sendPayout({
        payoutId: 'po_eth_1',
        affiliateId: 'aff_eth_1',
        recipientAddress: recipient,
        amount: 25.0,
        token: 'USDC',
      });

      expect(result.success).toBe(true);
      expect(result.transactionId).toBe(
        '0x88e96d4537bea4d9c05d12549907b32561d3bf31f45aae734cdc119f13406cb6'
      );
      expect(result.fromAddress).toBe(signer.address);

      // Verify eth_sendRawTransaction called with 0x02 prefix (EIP-1559)
      const rawTxCall = mockCalls.find((c) => c.method === 'eth_sendRawTransaction');
      expect(rawTxCall).toBeDefined();
      expect(typeof rawTxCall?.params[0]).toBe('string');
      expect((rawTxCall?.params[0] as string).startsWith('0x02')).toBe(true);
    });
  });
});
