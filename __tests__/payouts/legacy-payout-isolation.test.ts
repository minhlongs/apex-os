/**
 * Regression suite verifying legacy money-moving payout paths are permanently
 * disabled fail-closed with zero signing, zero broadcast, and zero ledger mutation.
 */

import {
  StellarService,
  StellarNetwork,
  CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
  LegacyPayoutPathDisabledError,
  type PayoutDatabase,
} from '@/lib/payouts/stellar-service';

describe('Legacy payout path isolation (LEGACY_PAYOUT_EXECUTION = 0)', () => {
  it('blocks StellarService.processBatchPayouts fail-closed with zero signing, broadcast, or DB mutation', async () => {
    const dbCalls = {
      getPendingEarnings: 0,
      createPayout: 0,
      markEarningsPaid: 0,
    };
    const db: PayoutDatabase = {
      async getPendingEarnings() {
        dbCalls.getPendingEarnings += 1;
        return [
          {
            id: 'earn-legacy-1',
            affiliate_id: 'aff-legacy-1',
            amount: 50,
            wallet_address: 'GBVALIDWALLET2345672345672345672345672345672345672345672',
            affiliate_name: 'Legacy User',
            affiliate_email: 'legacy@example.com',
          },
        ];
      },
      async createPayout() {
        dbCalls.createPayout += 1;
        return 'legacy-payout-id';
      },
      async markEarningsPaid() {
        dbCalls.markEarningsPaid += 1;
        return 1;
      },
    };

    const service = new StellarService({
      network: StellarNetwork.TESTNET,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
    });

    const sendPayoutSpy = jest.spyOn(service, 'sendPayout');
    const submitTxSpy = jest.spyOn(service, 'submitTransaction');

    let thrown: unknown;
    try {
      await service.processBatchPayouts(db, { limit: 10, dryRun: false });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(LegacyPayoutPathDisabledError);
    expect((thrown as LegacyPayoutPathDisabledError).code).toBe('LEGACY_PAYOUT_PATH_DISABLED');
    expect((thrown as LegacyPayoutPathDisabledError).legacyMethod).toBe(
      'StellarService.processBatchPayouts'
    );
    expect(sendPayoutSpy).not.toHaveBeenCalled();
    expect(submitTxSpy).not.toHaveBeenCalled();
    expect(dbCalls.getPendingEarnings).toBe(0);
    expect(dbCalls.createPayout).toBe(0);
    expect(dbCalls.markEarningsPaid).toBe(0);
  });

  it('preserves read-only reconciliation methods on StellarService', () => {
    const service = new StellarService({
      network: StellarNetwork.TESTNET,
      horizonUrl: 'https://horizon-testnet.stellar.org',
      usdcIssuer: CANONICAL_CIRCLE_STELLAR_MAINNET_USDC_ISSUER,
    });

    expect(typeof service.getAccount).toBe('function');
    expect(typeof service.getUSDCBalance).toBe('function');
    expect(typeof service.getXLMBalance).toBe('function');
    expect(typeof service.hasUsdcTrustline).toBe('function');
    expect(typeof service.getTransaction).toBe('function');
    expect(typeof service.verifyPayout).toBe('function');
    expect(typeof service.healthCheck).toBe('function');
  });
});
