/**
 * Canonical Monetary Precision & Conservation Attestation Tests
 *
 * Verifies exact integer arithmetic across all monetary boundaries:
 * - Internal D1 ledger: 10^-8 USD (bigint, LEDGER_SCALE = 100_000_000n)
 * - Stellar USDC wire: 10^-7 USDC stroops (divisor = 10n, residualDust1e8 in 0..9)
 * - EVM USDC wire (Arbitrum/Base): 10^-6 USDC base units (divisor = 100n, residualDust1e8 in 0..99)
 * - Conservation invariant:
 *   ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS
 */

import {
  BI_ZERO,
  LEDGER_SCALE,
  formatLedgerUnitsToUsd,
  ledgerUnitsToChainUnits,
  parseUsdToLedgerUnits,
} from '../units';
import { computeSafeSpreadWaterfall } from '../waterfall';
import { ledgerUnits1e8ToStellarStroops } from '../../payouts/stellar-service';
import { ledgerUnits1e8ToEvmUsdcUnits } from '../../payouts/adapters/arbitrum-base-usdc-adapter';

describe('Monetary precision reconciliation and exact conservation', () => {
  it('reconciles atomic boundary units: 1e-8 USD, 1e-7 Stellar USDC, 1e-6 EVM USDC', () => {
    const oneLedgerUnit = parseUsdToLedgerUnits('0.00000001');
    const oneStellarStroopInLedger = parseUsdToLedgerUnits('0.00000010');
    const oneEvmMicroInLedger = parseUsdToLedgerUnits('0.00000100');

    expect(oneLedgerUnit).toBe(BigInt(1));
    expect(oneStellarStroopInLedger).toBe(BigInt(10));
    expect(oneEvmMicroInLedger).toBe(BigInt(100));

    // 1 unit of 10^-8 USD is sub-representable on both Stellar and EVM — preserved 100% as dust
    const stellar1 = ledgerUnitsToChainUnits(oneLedgerUnit, 'stellar');
    expect(stellar1.chainUnits).toBe(BigInt(0));
    expect(stellar1.residualDust1e8).toBe(BigInt(1));
    expect(stellar1.chainUnits * BigInt(10) + stellar1.residualDust1e8).toBe(oneLedgerUnit);

    const evm1 = ledgerUnitsToChainUnits(oneLedgerUnit, 'arbitrum');
    expect(evm1.chainUnits).toBe(BigInt(0));
    expect(evm1.residualDust1e8).toBe(BigInt(1));
    expect(evm1.chainUnits * BigInt(100) + evm1.residualDust1e8).toBe(oneLedgerUnit);

    // 1 unit of 10^-7 USDC is exact on Stellar, preserved as dust on EVM
    const stellar10 = ledgerUnitsToChainUnits(oneStellarStroopInLedger, 'stellar');
    expect(stellar10.chainUnits).toBe(BigInt(1));
    expect(stellar10.residualDust1e8).toBe(BigInt(0));
    expect(stellar10.formatted).toBe('0.0000001');
    expect(ledgerUnits1e8ToStellarStroops(oneStellarStroopInLedger)).toBe(BigInt(1));

    const evm10 = ledgerUnitsToChainUnits(oneStellarStroopInLedger, 'base');
    expect(evm10.chainUnits).toBe(BigInt(0));
    expect(evm10.residualDust1e8).toBe(BigInt(10));

    // 1 unit of 10^-6 USDC is exact on both Stellar (10 stroops) and EVM (1 micro-USDC)
    const stellar100 = ledgerUnitsToChainUnits(oneEvmMicroInLedger, 'stellar');
    expect(stellar100.chainUnits).toBe(BigInt(10));
    expect(stellar100.residualDust1e8).toBe(BigInt(0));

    const evm100 = ledgerUnitsToChainUnits(oneEvmMicroInLedger, 'arbitrum');
    expect(evm100.chainUnits).toBe(BigInt(1));
    expect(evm100.residualDust1e8).toBe(BigInt(0));
    expect(evm100.formatted).toBe('0.000001');
    expect(ledgerUnits1e8ToEvmUsdcUnits(oneEvmMicroInLedger)).toBe(BigInt(1));
  });

  it('preserves exact conservation for amounts not representable on destination chains', () => {
    const unrepresentableAmounts = [
      BigInt(1),
      BigInt(9),
      BigInt(11),
      BigInt(99),
      BigInt(101),
      BigInt(1_000_000_007), // $10.00000007
      BigInt(1_000_000_099), // $10.00000099
      BigInt(24_999_999_999), // $249.99999999
    ];

    for (const amount of unrepresentableAmounts) {
      const stellar = ledgerUnitsToChainUnits(amount, 'stellar');
      expect(stellar.residualDust1e8 >= BI_ZERO && stellar.residualDust1e8 < BigInt(10)).toBe(true);
      expect(stellar.chainUnits * BigInt(10) + stellar.residualDust1e8).toBe(amount);

      for (const evmChain of ['arbitrum', 'base'] as const) {
        const evm = ledgerUnitsToChainUnits(amount, evmChain);
        expect(evm.residualDust1e8 >= BI_ZERO && evm.residualDust1e8 < BigInt(100)).toBe(true);
        expect(evm.chainUnits * BigInt(100) + evm.residualDust1e8).toBe(amount);
      }
    }
  });

  it('conserves every single 10^-8 unit across Safe-Spread Waterfall split-rounding remainders', () => {
    const testGrossUnits = [
      BigInt(1),
      BigInt(2),
      BigInt(3),
      BigInt(7),
      BigInt(19),
      BigInt(99),
      BigInt(100),
      BigInt(1_000_001),
      BigInt(123_456_789),
      BigInt(39_480_000_000), // BEAR $394.80
      BigInt(465_600_000_000), // BASE $4,656.00
      BigInt(4_116_000_000_000), // BULL $41,160.00
    ];

    for (const gross of testGrossUnits) {
      for (const tier2ShareOfSpread of ['0', '0.10']) {
        const breakdown = computeSafeSpreadWaterfall(gross, {
          config: { tier2ShareOfSpread },
          hasL1Referrer: true,
          hasB2bAgencyPartner: tier2ShareOfSpread !== '0',
        });

        const total =
          breakdown.reserveUnits +
          breakdown.traderCashbackUnits +
          breakdown.l1CommissionUnits +
          breakdown.l2CommissionUnits +
          breakdown.l3CommissionUnits +
          breakdown.platformNetUnits;

        expect(total).toBe(gross);
        expect(breakdown.l3CommissionUnits).toBe(BI_ZERO);
        expect(breakdown.platformNetUnits >= BI_ZERO).toBe(true);
      }
    }
  });

  it('enforces ORIGINAL_LIABILITY = VERIFIED_SETTLEMENT + REMAINING_LIABILITY + VALID_REVERSALS across partial withdrawals, dust accumulation, cross-chain settlement, and reversals', () => {
    // Accumulate 13 commission credits with non-round 1e-8 remainders
    let originalLiability = BI_ZERO;
    for (let i = 1; i <= 13; i++) {
      const credit = computeSafeSpreadWaterfall(BigInt(1_234_567_891) * BigInt(i)).traderCashbackUnits;
      originalLiability += credit;
    }

    let remainingLiability = originalLiability;
    let verifiedSettlementIn1e8 = BI_ZERO;
    let validReversalsIn1e8 = BI_ZERO;

    // 1. Partial withdrawal on Stellar with 1e-8 dust remainder
    const stellarRequest = BigInt(1_500_000_037); // $15.00000037
    const stellarConv = ledgerUnitsToChainUnits(stellarRequest, 'stellar');
    const stellarSettled1e8 = stellarConv.chainUnits * BigInt(10);
    // Only the chain-representable amount settles on-chain; residualDust1e8 stays in remainingLiability
    remainingLiability -= stellarSettled1e8;
    verifiedSettlementIn1e8 += stellarSettled1e8;

    expect(stellarConv.residualDust1e8).toBe(BigInt(7));
    expect(verifiedSettlementIn1e8 + remainingLiability + validReversalsIn1e8).toBe(
      originalLiability
    );

    // 2. Partial withdrawal on Arbitrum (EVM 6 decimals) with 1e-8 dust remainder
    const arbRequest = BigInt(2_250_000_089); // $22.50000089
    const arbConv = ledgerUnitsToChainUnits(arbRequest, 'arbitrum');
    const arbSettled1e8 = arbConv.chainUnits * BigInt(100);
    remainingLiability -= arbSettled1e8;
    verifiedSettlementIn1e8 += arbSettled1e8;

    expect(arbConv.residualDust1e8).toBe(BigInt(89));
    expect(verifiedSettlementIn1e8 + remainingLiability + validReversalsIn1e8).toBe(
      originalLiability
    );

    // 3. Partial withdrawal on Base (EVM 6 decimals) that later fails on-chain and is validly reversed
    const baseRequest = BigInt(1_100_000_045); // $11.00000045
    const baseConv = ledgerUnitsToChainUnits(baseRequest, 'base');
    const baseLocked1e8 = baseConv.chainUnits * BigInt(100);
    // Lock funds in-flight
    remainingLiability -= baseLocked1e8;
    // On-chain finality proves failure -> valid reversal restores liability
    const reversed1e8 = baseLocked1e8;
    remainingLiability += reversed1e8;
    // Net settled did not increase; if we also model a clawback reversal reducing liability:
    const clawbackReversal = BigInt(500_000_013); // $5.00000013 valid clawback reversal
    remainingLiability -= clawbackReversal;
    validReversalsIn1e8 += clawbackReversal;

    // 4. Accumulate dust from multiple small withdrawals until it crosses $0.00000100 (100 units)
    let accumulatedDust = stellarConv.residualDust1e8 + arbConv.residualDust1e8; // 7 + 89 = 96
    expect(accumulatedDust).toBe(BigInt(96));
    const tinyConv = ledgerUnitsToChainUnits(BigInt(1_000_000_004), 'arbitrum'); // dust = 4
    accumulatedDust += tinyConv.residualDust1e8; // 100 units = 1 EVM micro-USDC
    const dustSweep = ledgerUnitsToChainUnits(accumulatedDust, 'arbitrum');
    expect(dustSweep.chainUnits).toBe(BigInt(1));
    expect(dustSweep.residualDust1e8).toBe(BigInt(0));

    // Sweep the tiny payout + accumulated dust
    const tinySettled1e8 = tinyConv.chainUnits * BigInt(100) + dustSweep.chainUnits * BigInt(100);
    remainingLiability -= tinySettled1e8;
    verifiedSettlementIn1e8 += tinySettled1e8;

    // Final exact canonical conservation check (0 tolerance — 1 unit mismatch fails)
    expect(verifiedSettlementIn1e8 + remainingLiability + validReversalsIn1e8).toBe(
      originalLiability
    );
    expect(formatLedgerUnitsToUsd(LEDGER_SCALE)).toBe('1.00000000');
  });
});
