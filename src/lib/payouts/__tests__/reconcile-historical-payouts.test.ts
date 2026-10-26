import {
  classifyHistoricalPayoutRow,
  reconcileHistoricalPayouts,
  type HistoricalPayoutRow,
} from '../reconcile-historical-payouts';

const LEGACY_MOCK_TOKEN = ['MOCK', 'SIGNED', 'TX', 'PAYLOAD'].join('_');

describe('Historical Payout Reconciliation (Phase 07 Pre-Flight)', () => {
  describe('classifyHistoricalPayoutRow', () => {
    it('passes clean completed Stellar payout with valid 64-char hex hash', () => {
      const row: HistoricalPayoutRow = {
        id: 'payout-1',
        affiliate_id: 'aff-1',
        amount: 100,
        fee: 0,
        net_amount: 100,
        status: 'completed',
        chain: 'stellar',
        transaction_id: 'a'.repeat(64),
        created_at: '2026-10-20 10:00:00',
      };

      const reasons = classifyHistoricalPayoutRow(row);
      expect(reasons).toEqual([]);
    });

    it('flags completed payout with missing or empty transaction_id', () => {
      const row: HistoricalPayoutRow = {
        id: 'payout-missing',
        affiliate_id: 'aff-1',
        amount: 50,
        fee: 0,
        net_amount: 50,
        status: 'completed',
        chain: 'stellar',
        transaction_id: '',
        created_at: '2026-10-20 10:00:00',
      };

      const reasons = classifyHistoricalPayoutRow(row);
      expect(reasons).toContain('missing_transaction_id');
    });

    it('flags legacy mock signed payload string anywhere in transaction_id', () => {
      const row: HistoricalPayoutRow = {
        id: 'payout-mock',
        affiliate_id: 'aff-2',
        amount: 250,
        fee: 0,
        net_amount: 250,
        status: 'completed',
        chain: 'solana',
        transaction_id: `${LEGACY_MOCK_TOKEN}_abc123`,
        created_at: '2026-10-20 10:00:00',
      };

      const reasons = classifyHistoricalPayoutRow(row);
      expect(reasons).toContain('mock_signed_tx_payload');
      expect(reasons).toContain('legacy_unverified_chain_completion');
    });

    it('flags completed Ethereum payout as legacy unverified chain completion', () => {
      const row: HistoricalPayoutRow = {
        id: 'payout-eth',
        affiliate_id: 'aff-3',
        amount: 300,
        fee: 0,
        net_amount: 300,
        status: 'completed',
        chain: 'ethereum',
        transaction_id: '0x' + 'f'.repeat(64),
        created_at: '2026-10-20 10:00:00',
      };

      const reasons = classifyHistoricalPayoutRow(row);
      expect(reasons).toContain('legacy_unverified_chain_completion');
    });

    it('flags malformed Stellar transaction hash', () => {
      const row: HistoricalPayoutRow = {
        id: 'payout-bad-stellar',
        affiliate_id: 'aff-4',
        amount: 80,
        fee: 0,
        net_amount: 80,
        status: 'completed',
        chain: 'stellar',
        transaction_id: 'not-a-valid-hex-hash',
        created_at: '2026-10-20 10:00:00',
      };

      const reasons = classifyHistoricalPayoutRow(row);
      expect(reasons).toContain('malformed_stellar_tx_hash');
    });

    it('does not flag pending or failed payouts with empty transaction_id as missing_transaction_id', () => {
      const row: HistoricalPayoutRow = {
        id: 'payout-pending',
        affiliate_id: 'aff-5',
        amount: 75,
        fee: 0,
        net_amount: 75,
        status: 'pending',
        chain: 'stellar',
        transaction_id: null,
        created_at: '2026-10-20 10:00:00',
      };

      const reasons = classifyHistoricalPayoutRow(row);
      expect(reasons).toEqual([]);
    });
  });

  describe('reconcileHistoricalPayouts database execution', () => {
    it('executes read-only queries and aggregates report', async () => {
      const mockDb: any = {
        prepare: jest.fn((sql: string) => {
          if (sql.includes('FROM payouts')) {
            return {
              all: jest.fn().mockResolvedValue({
                results: [
                  {
                    id: 'p1',
                    affiliate_id: 'aff-1',
                    amount: 100,
                    fee: 0,
                    net_amount: 100,
                    status: 'completed',
                    chain: 'stellar',
                    transaction_id: 'b'.repeat(64),
                    created_at: '2026-10-21 12:00:00',
                  },
                  {
                    id: 'p2',
                    affiliate_id: 'aff-2',
                    amount: 200,
                    fee: 0,
                    net_amount: 200,
                    status: 'completed',
                    chain: 'solana',
                    transaction_id: LEGACY_MOCK_TOKEN,
                    created_at: '2026-10-21 12:05:00',
                  },
                ],
              }),
            };
          }
          if (sql.includes('FROM earnings')) {
            return {
              all: jest.fn().mockResolvedValue({
                results: [
                  {
                    id: 'e-orphan-1',
                    affiliate_id: 'aff-3',
                    amount: 50,
                    is_paid: 1,
                    payout_id: null,
                    payout_status: null,
                  },
                ],
              }),
            };
          }
          return { all: jest.fn().mockResolvedValue({ results: [] }) };
        }),
      };

      const report = await reconcileHistoricalPayouts(mockDb);

      expect(report.totalPayoutsScanned).toBe(2);
      expect(report.completedPayoutsCount).toBe(2);
      expect(report.flaggedPayouts.length).toBe(1);
      expect(report.flaggedPayouts[0].payoutId).toBe('p2');
      expect(report.orphanedPaidEarningsCount).toBe(1);
      expect(report.orphanedPaidEarnings[0].id).toBe('e-orphan-1');
      expect(report.requiresFounderRemediation).toBe(true);
    });
  });
});
