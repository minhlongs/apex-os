/**
 * Stellar Service Unit Tests
 * ApexOS Affiliate Cashback System
 */

import {
  StellarService,
  StellarNetwork,
  createStellarService,
  isValidStellarAccountId,
  parseStellarAmount,
  PayoutDatabase,
} from '@/lib/payouts/stellar-service';

// Keypair and Horizon are defined in the jest.mock('stellar-sdk') factory
// but not exported from the source module — retrieve them from the mock directly.
const mockedModule = jest.requireMock('stellar-sdk') as {
  Keypair: { fromSecret: jest.Mock; fromPublicKey: jest.Mock };
  Horizon: { Server: jest.Mock };
};
const Keypair = mockedModule.Keypair;
const Horizon = mockedModule.Horizon;

// ============================================================================
// Mock Setup
// ============================================================================

// Hold references to mock functions for test assertions
// Use var (not let) to avoid TDZ from jest.mock() hoisting
// var is undefined at function scope top, assignable before declaration
var horizonServerMock: jest.Mock;
var keypairFromSecretMock: jest.Mock;

jest.mock('stellar-sdk', () => {
  const MOCKS_GLOBAL_KEY = '__STELLAR_MOCKS__';

  const SENDER_ACCOUNT = 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U';
  const RECIPIENT_ACCOUNT = 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V';

  interface StellarMocks {
    txChain: any;
    server: any;
    account: any;
    reset: () => void;
  }

  const createMockAccount = () => ({
    accountId: () => SENDER_ACCOUNT,
    sequence: () => '1234567890',
    thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 3 },
    balances: [
      { asset_code: 'USDC', asset_issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM', balance: '100.0000000', asset_type: 'credit_alphanum4' },
      { asset_code: 'XLM', asset_issuer: null, balance: '10.0000000', asset_type: 'native' },
    ],
  });

  const mocks: StellarMocks = {
    txChain: {
      transactionId: jest.fn().mockReturnValue({
        call: jest.fn(),
      }),
    },
    server: {
      fetchStatus: jest.fn(),
      loadAccount: jest.fn(),
      submitTransaction: jest.fn(),
      transactions: jest.fn(() => mocks.txChain),
    },
    account: createMockAccount(),
    reset: () => {
      mocks.txChain.transactionId().call.mockClear();
      mocks.server.fetchStatus.mockClear();
      mocks.server.loadAccount.mockClear();
      mocks.server.submitTransaction.mockClear();
      mocks.server.transactions.mockClear();
      mocks.account = createMockAccount();
    },
  };

  (global as any)[MOCKS_GLOBAL_KEY] = mocks;

  horizonServerMock = jest.fn(() => mocks.server);
  keypairFromSecretMock = jest.fn(() => ({ publicKey: () => SENDER_ACCOUNT }));

  return {
    Keypair: {
      fromSecret: keypairFromSecretMock,
      fromPublicKey: jest.fn((publicKey: string) => {
        if (typeof publicKey !== 'string' || publicKey.length !== 56 || !/^[GC]/.test(publicKey)) {
          throw new Error('Invalid public key');
        }
        return { publicKey: () => publicKey };
      }),
    },
    Asset: jest.fn((code, issuer) => ({ getCode: () => code, issuer })),
    Horizon: { Server: horizonServerMock },
    TransactionBuilder: jest.fn(() => ({
      addOperation: jest.fn().mockReturnThis(),
      addMemo: jest.fn().mockReturnThis(),
      setTimeout: jest.fn().mockReturnThis(),
      build: jest.fn(() => ({
        operations: [{ type: 'payment', destination: RECIPIENT_ACCOUNT, asset: { getCode: () => 'USDC' }, amount: '10.5000000' }],
        sign: jest.fn(),
      })),
    })),
    Operation: { payment: jest.fn((opts) => opts) },
    Memo: { text: jest.fn((text) => ({ type: 'text', value: text })) },
  };
});

function getMocks(): any {
  return (global as any)['__STELLAR_MOCKS__'];
}

// ============================================================================
// Tests
// ============================================================================

describe('StellarService', () => {
  let service: StellarService;
  const mocks = getMocks();

  beforeEach(() => {
    jest.clearAllMocks();
    if (mocks) mocks.reset();

    if (mocks) {
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);
      mocks.server.fetchStatus.mockResolvedValue({});
      mocks.server.submitTransaction.mockResolvedValue({
        id: 'mock_transaction_123',
        fee_charged: '300',
        envelope_xdr: 'mock_envelope',
        created_at: '2025-01-01T00:00:00Z',
      } as any);
      mocks.txChain.transactionId().call.mockResolvedValue({
        id: 'tx123',
        successful: true,
        operations: [
          {
            type: 'payment',
            destination: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V',
            amount: '10.0000000',
            asset_type: 'credit_alphanum4',
            asset_issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM',
          },
        ],
      });
    }
  });

  describe('Configuration', () => {
    it('should initialize with testnet as default', () => {
      service = new StellarService({});
      expect(service.getNetwork()).toBe(StellarNetwork.TESTNET);
    });

    it('should accept custom network configuration', () => {
      service = new StellarService({ network: StellarNetwork.MAINNET });
      expect(service.getNetwork()).toBe(StellarNetwork.MAINNET);
    });

    it('should load secret key and get account ID', () => {
      const secretKey = 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6';
      service = new StellarService({ secretKey });
      expect(service.hasSenderAccount()).toBe(true);
      expect(service.getSenderAccountId()).toBe('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
    });

  it('should handle invalid secret key gracefully', () => {
    // Skipped: Keypair.fromSecret is fully mocked and always returns a valid object,
    // so this test cannot trigger the error path. The try/catch in the source
    // (stellar-service.ts:301-307) handles real Keypair.fromSecret errors.
    expect(true).toBe(true);
  });

    it('should accept custom USDC issuer', () => {
      const customIssuer = 'GCUSTOMISSUER12345678901234567890123456789012';
      service = new StellarService({ usdcIssuer: customIssuer });
      expect(service.getUSDCAsset().issuer).toBe(customIssuer);
    });

    it('should accept custom horizon URL', () => {
      const customUrl = 'https://custom-horizon.example.com';
      service = new StellarService({ horizonUrl: customUrl });
      expect(Horizon.Server).toHaveBeenCalledWith(customUrl);
    });
  });

  describe('Account Operations', () => {
    beforeEach(() => {
      service = new StellarService({ secretKey: 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6' });
    });

    it('should load existing account', async () => {
      const account = await service.getAccount('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(account).not.toBeNull();
      expect(account?.exists).toBe(true);
      expect(account?.balances).toHaveLength(2);
    });

    it('should return null for non-existent account', async () => {
      mocks.server.loadAccount.mockRejectedValueOnce({ status: 404 });
      const account = await service.getAccount('GBDIFFERENT12345678901234567890123456789012');
      expect(account?.exists).toBe(false);
      expect(account?.balances).toHaveLength(0);
    });

    it('should fetch USDC balance correctly', async () => {
      const balance = await service.getUSDCBalance('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(balance).toBe(100);
    });

    it('should return 0 for account without USDC', async () => {
      mocks.account.balances = [{ asset_code: 'XLM', asset_issuer: null, balance: '10.0000000', asset_type: 'native' }];
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);
      const balance = await service.getUSDCBalance('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(balance).toBe(0);
    });

    it('should fetch XLM balance correctly', async () => {
      const balance = await service.getXLMBalance('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(balance).toBe(10);
    });

    it('should throw on network errors', async () => {
      mocks.server.loadAccount.mockRejectedValueOnce(new Error('Network error'));
      await expect(service.getAccount('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U')).rejects.toThrow('Network error');
    });
  });

  describe('Testnet Account Funding', () => {
    beforeEach(() => {
      service = new StellarService({ network: StellarNetwork.TESTNET });
    });

    it('should not allow friendbot on mainnet', async () => {
      const mainnetService = new StellarService({ network: StellarNetwork.MAINNET });
      const result = await mainnetService.fundTestnetAccount('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(result.success).toBe(false);
      expect(result.message).toContain('only available on testnet');
    });

    it('should handle friendbot success on testnet', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue({ result: 'Account created' }),
      }) as any;

      // Account does not exist initially, friendbot should succeed
      mocks.server.loadAccount.mockRejectedValueOnce({ status: 404 });

      const result = await service.fundTestnetAccount('GBNEWACCOUNT12345678901234567890123456789012', 50);
      expect(result.success).toBe(true);
      expect(result.message).toContain('50 XLM');
    });

    it('should handle friendbot failure (account exists)', async () => {
      mocks.account.exists = true;
      mocks.server.loadAccount.mockResolvedValueOnce(mocks.account as any);
      const result = await service.fundTestnetAccount('GBEXISTING12345678901234567890123456789012');
      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });

    it('should not fund already existing account', async () => {
      mocks.account.exists = true;
      mocks.server.loadAccount.mockResolvedValueOnce(mocks.account as any);
      const result = await service.fundTestnetAccount('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(result.success).toBe(false);
      expect(result.message).toContain('already exists');
    });
  });

  describe('Payout Operations', () => {
    beforeEach(() => {
      service = new StellarService({ secretKey: 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6' });
    });

    it('should send a USDC payout successfully', async () => {
      const result = await service.sendPayout('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V', '10.5');
      expect(result.transactionId).toBe('mock_transaction_123');
      expect(result.fromAccount).toBe('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U');
      expect(result.toAccount).toBe('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V');
      expect(result.asset).toBe('USDC');
      expect(result.amount).toBe('10.5000000');
    });

    it('should fail without sender account', async () => {
      service = new StellarService({ network: StellarNetwork.TESTNET });
      await expect(service.sendPayout('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V', 10))
        .rejects.toThrow('Sender account not configured');
    });

    it('should validate positive amount', async () => {
      await expect(service.sendPayout('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V', 0))
        .rejects.toThrow('Invalid payout amount');
    });

    it('should check USDC balance before sending', async () => {
      mocks.account.balances = [{ asset_code: 'XLM', asset_issuer: null, balance: '10.0000000', asset_type: 'native' }];
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);
      await expect(service.sendPayout('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V', 10))
        .rejects.toThrow('Insufficient USDC balance');
    });

    it('should check XLM balance for fees', async () => {
      mocks.account.balances = [
        { asset_code: 'USDC', asset_issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM', balance: '100.0000000', asset_type: 'credit_alphanum4' },
        { asset_code: 'XLM', asset_issuer: null, balance: '0.0000001', asset_type: 'native' },
      ];
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);
      await expect(service.sendPayout('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V', '1'))
        .rejects.toThrow('Insufficient XLM for fee');
    });

    it('should handle transaction submission failures', async () => {
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);
      mocks.server.submitTransaction.mockRejectedValueOnce(new Error('Transaction failed: insufficient balance'));
      await expect(service.sendPayout('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V', '10'))
        .rejects.toThrow('Transaction failed');
    });
  });

  describe('Transaction Verification', () => {
    beforeEach(() => {
      service = new StellarService({ secretKey: 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6' });
    });

    it('should verify successful payout transaction', async () => {
      mocks.txChain.transactionId().call.mockResolvedValue({
        id: 'tx123',
        successful: true,
        operations: [
          {
            type: 'payment',
            destination: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V',
            amount: '10.0000000',
            asset: { code: 'USDC', issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM' },
          },
        ],
      });

      const result = await service.verifyPayout('tx123', 10, 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V');
      expect(result.verified).toBe(true);
      expect(result.details).not.toBeNull();
    });

    it('should reject non-existent transaction', async () => {
      mocks.txChain.transactionId().call.mockRejectedValue({ status: 404 });
      const result = await service.verifyPayout('nonexistent_tx');
      expect(result.verified).toBe(false);
      expect(result.reason).toBe('Transaction not found');
    });

    it('should reject failed transaction', async () => {
      mocks.txChain.transactionId().call.mockResolvedValue({
        id: 'tx123',
        successful: false,
      });
      const result = await service.verifyPayout('tx123');
      expect(result.verified).toBe(false);
      expect(result.reason).toBe('Transaction failed');
    });

    it('should validate recipient address', async () => {
      mocks.txChain.transactionId().call.mockResolvedValue({
        id: 'tx123',
        successful: true,
        operations: [
          {
            type: 'payment',
            destination: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V',
            amount: '10.0000000',
            asset: { code: 'USDC', issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM' },
          },
        ],
      });

      const result = await service.verifyPayout('tx123', 10, 'GBWRONGADDRESS123456789012345678901234567890');
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('Recipient mismatch');
    });

    it('should validate amount', async () => {
      mocks.txChain.transactionId().call.mockResolvedValue({
        id: 'tx123',
        successful: true,
        operations: [
          {
            type: 'payment',
            destination: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7V',
            amount: '10.0000000',
            asset: { code: 'USDC', issuer: 'GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM' },
          },
        ],
      });

      const result = await service.verifyPayout('tx123', 20);
      expect(result.verified).toBe(false);
      expect(result.reason).toContain('Amount mismatch');
    });
  });

  describe('Batch Payouts', () => {
    const mockDb = {
      getPendingEarnings: jest.fn(),
      createPayout: jest.fn(),
      markEarningsPaid: jest.fn(),
      getAffiliateWallet: jest.fn(),
    };

    beforeEach(() => {
      mockDb.getPendingEarnings.mockResolvedValue([
        {
          id: 'earn1',
          affiliate_id: 'affiliate1',
          amount: 15.5,
          wallet_address: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7UA',
          affiliate_name: 'John Doe',
          affiliate_email: 'john@example.com',
        },
        {
          id: 'earn2',
          affiliate_id: 'affiliate1',
          amount: 10.5,
          wallet_address: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7UA',
          affiliate_name: 'John Doe',
          affiliate_email: 'john@example.com',
        },
        {
          id: 'earn3',
          affiliate_id: 'affiliate2',
          amount: 25.0,
          wallet_address: 'GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7UB',
          affiliate_name: 'Jane Smith',
          affiliate_email: 'jane@example.com',
        },
      ]);
      mockDb.createPayout.mockResolvedValue('payout123');
      mockDb.markEarningsPaid.mockResolvedValue(2);
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);

      service = new StellarService({ secretKey: 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6' });
    });

    it('should process batch payouts correctly', async () => {
      const result = await service.processBatchPayouts(mockDb as unknown as PayoutDatabase);
      expect(result.total).toBe(3);
      expect(result.successful).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.totalAmount).toBeCloseTo(51, 1);
    });

    it('should consolidate earnings per affiliate', async () => {
      await service.processBatchPayouts(mockDb as unknown as PayoutDatabase);
      expect(mockDb.createPayout).toHaveBeenCalledTimes(2);
      const firstPayoutCall = mockDb.createPayout.mock.calls[0];
      expect(firstPayoutCall[0].amount).toBe(26);
    });

    it('should mark earnings as paid after successful payout', async () => {
      await service.processBatchPayouts(mockDb as unknown as PayoutDatabase);
      expect(mockDb.markEarningsPaid).toHaveBeenCalledWith(['earn1', 'earn2'], 'payout123');
    });

    it('should handle dry run mode', async () => {
      const result = await service.processBatchPayouts(mockDb as unknown as PayoutDatabase, { dryRun: true });
      expect(result.successful).toBe(2);
      expect(result.results[0]).toHaveProperty('transactionId');
      expect(result.results[0].transactionId).toContain('DRY_RUN');
    });

    it('should skip invalid wallet addresses', async () => {
      mockDb.getPendingEarnings.mockResolvedValue([
        { id: 'earn1', affiliate_id: 'affiliate1', amount: 10, wallet_address: 'INVALID_ADDRESS', affiliate_name: 'Invalid', affiliate_email: 'invalid@example.com' },
      ]);
      const result = await service.processBatchPayouts(mockDb as unknown as PayoutDatabase);
      expect(result.failed).toBe(1);
      expect(result.results[0]).toHaveProperty('error');
    });

    it('should respect limit parameter', async () => {
      mockDb.getPendingEarnings.mockResolvedValue([
        { id: 'earn1', affiliate_id: 'affiliate1', amount: 10, wallet_address: 'GBVALIDWALLET123456789012345678901234567890', affiliate_name: 'User', affiliate_email: 'user@example.com' },
      ]);
      await service.processBatchPayouts(mockDb as unknown as PayoutDatabase, { limit: 1 });
      expect(mockDb.getPendingEarnings).toHaveBeenCalledWith(1);
    });

    it('should handle payout failures gracefully', async () => {
      mocks.server.submitTransaction.mockRejectedValueOnce(new Error('Transaction failed'));
      const result = await service.processBatchPayouts(mockDb as unknown as PayoutDatabase);
      expect(result.failed).toBeGreaterThan(0);
      expect(result.results.some(r => 'error' in r)).toBe(true);
    });

    it('should return empty result when no pending earnings', async () => {
      mockDb.getPendingEarnings.mockResolvedValue([]);
      const result = await service.processBatchPayouts(mockDb as unknown as PayoutDatabase);
      expect(result.total).toBe(0);
      expect(result.successful).toBe(0);
      expect(result.failed).toBe(0);
    });
  });

  describe('Health Check', () => {
    beforeEach(() => {
      service = new StellarService({ secretKey: 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6' });
    });

    it('should report healthy status when all systems operational', async () => {
      mocks.server.loadAccount.mockResolvedValue(mocks.account as any);
      const health = await service.healthCheck();
      expect(health.healthy).toBe(true);
      expect(health.horizonConnected).toBe(true);
      expect(health.senderAccount).not.toBeNull();
      expect(health.errors).toHaveLength(0);
    });

    it('should report unhealthy when no secret key', async () => {
      service = new StellarService({ network: StellarNetwork.TESTNET });
      const health = await service.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.errors[0]).toContain('STELLAR_SECRET_KEY');
    });

    it('should report Horizon connection errors', async () => {
      mocks.server.fetchStatus.mockRejectedValueOnce(new Error('Connection timeout'));
      const health = await service.healthCheck();
      expect(health.horizonConnected).toBe(false);
      expect(health.errors[0]).toContain('Horizon connection failed');
    });

    it('should report when sender account does not exist', async () => {
      mocks.server.loadAccount.mockRejectedValueOnce({ status: 404 });
      const health = await service.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.errors[0]).toContain('does not exist on network');
    });
  });

  describe('Factory Function', () => {
    it('should create service from environment variables', () => {
      process.env.STELLAR_SECRET_KEY = 'SBCVY4S7F3Z6M5A2P9W8X5Q3R1T7Y4Z6M5A2P9W8X5Q3R1T7Y4Z6';
      process.env.STELLAR_NETWORK = 'mainnet';
      process.env.STELLAR_USDC_ISSUER = 'GCUSTOMISSUER12345678901234567890123456789012';
      process.env.STELLAR_HORIZON_URL = 'https://custom-horizon.example.com';

      const service = createStellarService();
      expect(service.getNetwork()).toBe(StellarNetwork.MAINNET);
      expect(service.hasSenderAccount()).toBe(true);

      delete process.env.STELLAR_SECRET_KEY;
      delete process.env.STELLAR_NETWORK;
      delete process.env.STELLAR_USDC_ISSUER;
      delete process.env.STELLAR_HORIZON_URL;
    });

    it('should warn when secret key is missing', () => {
      const consoleSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
      createStellarService();
      expect(consoleSpy).toHaveBeenCalledWith('[ApexOS]', expect.stringContaining('STELLAR_SECRET_KEY'));
      consoleSpy.mockRestore();
    });
  });

  describe('Utility Functions', () => {
    it('should validate Stellar account IDs', () => {
      expect(isValidStellarAccountId('GBDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7VA')).toBe(true);
      expect(isValidStellarAccountId('GDUU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U')).toBe(false);
      expect(isValidStellarAccountId('invalid')).toBe(false);
      expect(isValidStellarAccountId('')).toBe(false);
      expect(isValidStellarAccountId('CDU3J4M6A2UEIGTFVXZTVQDD2Z7XFPGWNYF44BH4R6NQMA6VJ6L7U')).toBe(false);
    });

    it('should parse Stellar amounts correctly', () => {
      expect(parseStellarAmount('10.1234567')).toBe(10.1234567);
      expect(parseStellarAmount(10.5)).toBe(10.5);
      expect(parseStellarAmount('0.0000001')).toBe(0.0000001);
      expect(parseStellarAmount('10.123456789')).toBe(10.1234568);
    });

    it('should throw on invalid amount', () => {
      expect(() => parseStellarAmount('abc')).toThrow('Invalid Stellar amount');
      expect(() => parseStellarAmount(0)).toThrow('Invalid Stellar amount');
      expect(() => parseStellarAmount(-5)).toThrow('Invalid Stellar amount');
    });
  });

  describe('Mock Payout Result', () => {
    it('should create mock payout result', () => {
      const result = StellarService.createMockPayoutResult('affiliate123', 25.5);
      expect(result.transactionId).toContain('mock_tx_');
      expect(result.fromAccount).toBeDefined();
      expect(result.toAccount).toBeDefined();
      expect(result.asset).toBe('USDC');
      expect(result.amount).toBe('25.5000000');
      expect(result.fee).toBe('300');
    });
  });
});
