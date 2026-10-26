/**
 * src/lib/payouts/__tests__/solana-priority-and-treasury.test.ts
 *
 * Unit tests for:
 * 1. Solana ComputeBudget priority fee instructions (SetComputeUnitLimit & SetComputeUnitPrice)
 * 2. Solana SPL TransferChecked (instruction 12) wire message serialization
 * 3. Admin Treasury Dashboard formatting & health badge helpers
 */

import {
  SolanaAdapter,
  buildSPLTransferCheckedData,
  buildSetComputeUnitLimitData,
  buildSetComputeUnitPriceData,
} from '../adapters/solana-adapter';
import { encodeBase58 } from '../crypto/base58';
import { createEd25519Signer } from '../crypto/ed25519-signer';
import type { JsonRpcClient } from '../rpc/json-rpc-client';
import {
  getHealthBadgeStyle,
  formatChainDisplayName,
} from '@/components/admin/treasury/treasury-helpers';

describe('Solana Priority Fees, TransferChecked & Admin Treasury Helpers', () => {
  describe('Solana ComputeBudget & TransferChecked Wire Serialization', () => {
    it('encodes SetComputeUnitLimit, SetComputeUnitPrice, and TransferChecked instruction buffers accurately', () => {
      const cuLimitBuf = buildSetComputeUnitLimitData(150_000);
      expect(cuLimitBuf[0]).toBe(2);
      expect(new DataView(cuLimitBuf.buffer).getUint32(1, true)).toBe(150_000);

      const cuPriceBuf = buildSetComputeUnitPriceData(BigInt(75_000));
      expect(cuPriceBuf[0]).toBe(3);
      expect(new DataView(cuPriceBuf.buffer).getBigUint64(1, true)).toBe(BigInt(75_000));

      const transferCheckedBuf = buildSPLTransferCheckedData(BigInt(25_000_000), 6);
      expect(transferCheckedBuf[0]).toBe(12);
      expect(new DataView(transferCheckedBuf.buffer).getBigUint64(1, true)).toBe(
        BigInt(25_000_000)
      );
      expect(transferCheckedBuf[9]).toBe(6);
    });

    it('builds and signs Solana transaction with ComputeBudget priority fee and TransferChecked enabled', async () => {
      const seed = new Uint8Array(32);
      seed.fill(19);
      const seedBase58 = encodeBase58(seed);
      const signer = await createEd25519Signer(seedBase58);

      let capturedWireBase64 = '';
      const mockRpc: JsonRpcClient = {
        call: async <T>(method: string, params: unknown[] = []): Promise<T> => {
          if (method === 'getLatestBlockhash') {
            return {
              value: {
                blockhash: 'EkSnNWEM2jfWXPzpduPFQPGxKvdnvvRYGtve3aUwnUr5',
                lastValidBlockHeight: 999999,
              },
            } as T;
          }
          if (method === 'sendTransaction') {
            capturedWireBase64 = String(params[0] || '');
            return '4TxPriorityCheckedSig1111111111111111111111111111111111111111111111111111111111111111111' as T;
          }
          return null as T;
        },
      } as unknown as JsonRpcClient;

      const adapter = new SolanaAdapter({
        rpcUrl: 'http://127.0.0.1:8899',
        jsonRpcClient: mockRpc,
        privateKey: seedBase58,
        hotWalletAddress: signer.publicKeyBase58,
        includePriorityFee: true,
        useTransferChecked: true,
        computeUnitLimit: 120_000,
        computeUnitPriceMicroLamports: BigInt(60_000),
      });

      const recipient = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
      const result = await adapter.sendPayout({
        payoutId: 'po_sol_priority_1',
        affiliateId: 'aff_sol_1',
        recipientAddress: recipient,
        amount: 100.0,
        token: 'USDC',
        idempotencyKey: 'idem_sol_priority_1',
      });

      expect(result.success).toBe(true);
      expect(result.status).toBe('submitted');
      expect(capturedWireBase64.length).toBeGreaterThan(100);

      // Decode wire transaction: [1 (numSigs), 64-byte sig, message...]
      const rawWire = Buffer.from(capturedWireBase64, 'base64');
      expect(rawWire[0]).toBe(1); // 1 signature
      const msgOffset = 65;
      // Header: [numRequiredSignatures=1, numReadonlySigned=0, numReadonlyUnsigned=3 (mint, tokenProgram, computeBudget)]
      expect(rawWire[msgOffset]).toBe(1);
      expect(rawWire[msgOffset + 1]).toBe(0);
      expect(rawWire[msgOffset + 2]).toBe(3);
    });
  });

  describe('Admin Treasury UI Helper Functions', () => {
    it('maps health status levels to badge styles', () => {
      expect(getHealthBadgeStyle('HEALTHY')).toContain('emerald');
      expect(getHealthBadgeStyle('LOW_RESERVE')).toContain('amber');
      expect(getHealthBadgeStyle('CRITICAL')).toContain('red');
    });

    it('formats chain display names clearly', () => {
      expect(formatChainDisplayName('stellar')).toBe('Stellar (USDC)');
      expect(formatChainDisplayName('ethereum')).toBe('Ethereum (EIP-1559)');
      expect(formatChainDisplayName('solana')).toBe('Solana (SPL)');
    });
  });
});
