/**
 * Stellar Read-Only Health Boundary Tests (Gate G8)
 *
 * Verifies:
 * 1. Read-only Horizon health checks (/api/admin/settings/stellar/health,
 *    getStellarSettings, testStellarConnection, StellarService.healthCheck)
 *    use TURNKEY_STELLAR_HOT_WALLET_ADDRESS public account ID only and NEVER
 *    load or leak STELLAR_SECRET_KEY.
 * 2. Horizon reachability, sender existence, XLM balance, and USDC balance
 *    are accurately reported from read-only Horizon responses.
 * 3. Misconfigured secret seeds (`S...`) or secret-bearing error messages are
 *    rejected/redacted without exposing raw secret material in responses or logs.
 */

import { NextRequest } from 'next/server';
import {
  StellarService,
  StellarNetwork,
  CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
  sanitizeStellarDiagnosticError,
} from '@/lib/payouts/stellar-service';
import {
  getStellarSettings,
  testStellarConnection,
} from '@/lib/admin/stellar-actions';
import { GET as getStellarHealthRoute } from '@/app/api/admin/settings/stellar/health/route';

const VALID_TURNKEY_PUB = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN';
const LEAK_CANARY_SECRET = 'SBCVY4S7F3Z6M5A2P7W6X5Q3R2T7Y4Z6M5A2P7W6X5Q3R2T7Y4Z6M5A2';

jest.mock('next/headers', () => ({
  headers: jest.fn(async () => ({
    forEach: (cb: (value: string, key: string) => void) => {
      cb('better-auth.session_token=admin_tok', 'cookie');
    },
  })),
  cookies: jest.fn(async () => ({
    getAll: () => [{ name: 'better-auth.session_token', value: 'admin_tok' }],
  })),
}));

jest.mock('@/lib/auth/auth-factory', () => ({
  createAuth: jest.fn(() => ({
    api: {
      getSession: jest.fn(async () => ({ user: { id: 'admin-1' } })),
    },
  })),
}));

jest.mock('@stellar/stellar-sdk', () => {
  const MOCK_STATE = {
    fetchStatus: jest.fn(),
    loadAccount: jest.fn(),
    fromSecretCalls: [] as string[],
  };
  (globalThis as Record<string, unknown>).__STELLAR_HEALTH_MOCK__ = MOCK_STATE;

  return {
    StellarNetwork: { TESTNET: 'testnet', MAINNET: 'mainnet' },
    Networks: {
      TESTNET: 'Test SDF Network ; September 2015',
      PUBLIC: 'Public Global Stellar Network ; September 2015',
    },
    Horizon: {
      Server: jest.fn(() => ({
        fetchStatus: MOCK_STATE.fetchStatus,
        loadAccount: MOCK_STATE.loadAccount,
      })),
    },
    Asset: class MockAsset {
      code: string;
      issuer: string;
      constructor(code: string, issuer: string) {
        this.code = code;
        this.issuer = issuer;
      }
    },
    Keypair: {
      fromSecret: jest.fn((secret: string) => {
        MOCK_STATE.fromSecretCalls.push(secret);
        return { publicKey: () => 'G_SHOULD_NEVER_BE_USED_FROM_SECRET_KEY_1234567890123456' };
      }),
      fromPublicKey: jest.fn((pub: string) => {
        if (!/^G[A-Z2-7]{55}$/.test(pub)) {
          throw new Error('Invalid StrKey public key');
        }
        return { publicKey: () => pub };
      }),
    },
  };
});

function getMockState() {
  return (globalThis as Record<string, unknown>).__STELLAR_HEALTH_MOCK__ as {
    fetchStatus: jest.Mock;
    loadAccount: jest.Mock;
    fromSecretCalls: string[];
  };
}

describe('Gate G8: Read-Only Stellar Horizon Health Boundary', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS;
    delete process.env.STELLAR_SECRET_KEY;

    const mockState = getMockState();
    mockState.fetchStatus.mockReset().mockResolvedValue({ core_latest_ledger: 100 });
    mockState.loadAccount.mockReset().mockResolvedValue({
      accountId: () => VALID_TURNKEY_PUB,
      sequence: '42',
      thresholds: { low_threshold: 1, med_threshold: 2, high_threshold: 2 },
      balances: [
        {
          asset_code: 'USDC',
          asset_issuer: CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
          balance: '250.7500000',
          asset_type: 'credit_alphanum4',
          is_authorized: true,
        },
        {
          asset_code: 'XLM',
          asset_issuer: null,
          balance: '14.5000000',
          asset_type: 'native',
        },
      ],
    });
    mockState.fromSecretCalls.length = 0;

    // Mock admin D1 binding + KV binding for server actions
    (globalThis as Record<string, unknown>).DB = {
      prepare: jest.fn(() => ({
        bind: jest.fn(() => ({
          first: jest.fn(async () => ({ role: 'admin' })),
        })),
      })),
    };
    (globalThis as Record<string, unknown>).KV = {
      get: jest.fn(async () =>
        JSON.stringify({
          network: StellarNetwork.TESTNET,
          usdcIssuer: CANONICAL_STELLAR_TESTNET_USDC_ISSUER,
          horizonUrl: 'https://horizon-testnet.stellar.org',
        })
      ),
      put: jest.fn(async () => undefined),
      delete: jest.fn(async () => undefined),
    };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('reports Horizon reachability, sender existence, XLM and USDC balances via public account ID without touching STELLAR_SECRET_KEY', async () => {
    process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS = VALID_TURNKEY_PUB;
    process.env.STELLAR_SECRET_KEY = LEAK_CANARY_SECRET;

    const req = new NextRequest('https://apex-os.agencyos-openclaw.workers.dev/api/admin/settings/stellar/health');
    const res = await getStellarHealthRoute(req);
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({
      healthy: true,
      network: 'testnet',
      senderAccount: VALID_TURNKEY_PUB,
      senderBalanceUSDC: 250.75,
      senderBalanceXLM: 14.5,
      horizonConnected: true,
      errors: [],
    });

    // Zero raw secret key parsing occurred
    expect(getMockState().fromSecretCalls).toHaveLength(0);
    expect(JSON.stringify(body)).not.toContain(LEAK_CANARY_SECRET);
  });

  it('refuses to fall back to STELLAR_SECRET_KEY in health/settings/test actions when TURNKEY_STELLAR_HOT_WALLET_ADDRESS is unset', async () => {
    process.env.STELLAR_SECRET_KEY = LEAK_CANARY_SECRET;

    const req = new NextRequest('https://apex-os.agencyos-openclaw.workers.dev/api/admin/settings/stellar/health');
    const healthRes = await getStellarHealthRoute(req);
    const healthJson = await healthRes.json();

    expect(healthJson.healthy).toBe(false);
    expect(healthJson.senderAccount).toBeNull();
    expect(healthJson.errors[0]).toContain('TURNKEY_STELLAR_HOT_WALLET_ADDRESS');
    expect(JSON.stringify(healthJson)).not.toContain(LEAK_CANARY_SECRET);

    const settings = await getStellarSettings();
    expect(settings.config.secretKeyConfigured).toBe(false);
    expect(settings.config.senderAccountId).toBeNull();
    expect(settings.health).toBeNull();

    const connTest = await testStellarConnection();
    expect(connTest.success).toBe(false);
    expect(connTest.error).toContain('TURNKEY_STELLAR_HOT_WALLET_ADDRESS');
    expect(JSON.stringify(connTest)).not.toContain(LEAK_CANARY_SECRET);

    expect(getMockState().fromSecretCalls).toHaveLength(0);
  });

  it('rejects and redacts an accidentally pasted S... Stellar secret seed in TURNKEY_STELLAR_HOT_WALLET_ADDRESS without leaking it', async () => {
    process.env.TURNKEY_STELLAR_HOT_WALLET_ADDRESS = LEAK_CANARY_SECRET;
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Direct StellarService instantiation
    const svc = new StellarService({
      network: StellarNetwork.TESTNET,
      senderPublicKey: LEAK_CANARY_SECRET,
    });
    expect(svc.getSenderAccountId()).toBeNull();

    // Admin health endpoint
    const req = new NextRequest('https://apex-os.agencyos-openclaw.workers.dev/api/admin/settings/stellar/health');
    const res = await getStellarHealthRoute(req);
    const body = await res.json();

    expect(body.healthy).toBe(false);
    expect(body.senderAccount).toBeNull();
    expect(JSON.stringify(body)).not.toContain(LEAK_CANARY_SECRET);

    // Ensure console.error never received the raw secret seed
    for (const callArgs of errorSpy.mock.calls) {
      expect(JSON.stringify(callArgs)).not.toContain(LEAK_CANARY_SECRET);
    }
    errorSpy.mockRestore();
  });

  it('redacts accidental S... seeds or STELLAR_SECRET_KEY assignments from Horizon error messages', () => {
    const dirty = `Horizon failed with seed ${LEAK_CANARY_SECRET} and STELLAR_SECRET_KEY=${LEAK_CANARY_SECRET}`;
    const cleaned = sanitizeStellarDiagnosticError(dirty);
    expect(cleaned).not.toContain(LEAK_CANARY_SECRET);
    expect(cleaned).toContain('[REDACTED_STELLAR_SECRET]');
  });
});
