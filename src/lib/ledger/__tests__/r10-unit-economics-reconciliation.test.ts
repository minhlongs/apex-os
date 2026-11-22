import { computeSafeSpreadWaterfall, DEFAULT_WATERFALL_CONFIG } from '../waterfall';
import { parseUsdToLedgerUnits } from '../units';

interface PdfR10ScenarioInput {
  readonly name: 'BEAR' | 'BASE' | 'BULL';
  readonly activeTraders: number;
  readonly collectedCommissionUsd: string;
  readonly variableCostsUsd: string;
  readonly fixedInfraUsd: string;
  readonly replacementCacUsd: string;
  readonly originalPdfFcfUsd: string;
  readonly expectedRetailI4FcfUsd: string;
  readonly expectedMaxB2bI4FcfUsd: string;
}

const PDF_R10_SCENARIOS: readonly PdfR10ScenarioInput[] = [
  {
    name: 'BEAR',
    activeTraders: 50,
    collectedCommissionUsd: '394.80',
    variableCostsUsd: '76.35',
    fixedInfraUsd: '35.00',
    replacementCacUsd: '405.00',
    originalPdfFcfUsd: '-390.01',
    expectedRetailI4FcfUsd: '-385.08',
    expectedMaxB2bI4FcfUsd: '-403.83',
  },
  {
    name: 'BASE',
    activeTraders: 200,
    collectedCommissionUsd: '4656.00',
    variableCostsUsd: '181.25',
    fixedInfraUsd: '45.00',
    replacementCacUsd: '672.00',
    originalPdfFcfUsd: '684.79',
    expectedRetailI4FcfUsd: '649.87',
    expectedMaxB2bI4FcfUsd: '428.71',
  },
  {
    name: 'BULL',
    activeTraders: 800,
    collectedCommissionUsd: '41160.00',
    variableCostsUsd: '602.64',
    fixedInfraUsd: '95.00',
    replacementCacUsd: '1584.00',
    originalPdfFcfUsd: '10066.36',
    expectedRetailI4FcfUsd: '11404.06',
    expectedMaxB2bI4FcfUsd: '9448.96',
  },
];

/**
 * Pure half-away-from-zero USD cent formatter operating strictly on 10^-8 bigint units.
 */
function formatSignedLedgerUnitsToUsdCents(units1e8: bigint): string {
  const negative = units1e8 < 0n;
  const abs = negative ? -units1e8 : units1e8;
  // 1 cent = 1_000_000 units of 10^-8 USD; half-cent = 500_000n
  const roundedCents = (abs + 500_000n) / 1_000_000n;
  const dollars = roundedCents / 100n;
  const cents = roundedCents % 100n;
  return `${negative ? '-' : ''}${dollars.toString()}.${cents.toString().padStart(2, '0')}`;
}

function computeModeledFcfUnits1e8(
  platformNetUnits1e8: bigint,
  scenario: PdfR10ScenarioInput
): bigint {
  const variableUnits = parseUsdToLedgerUnits(scenario.variableCostsUsd);
  const fixedUnits = parseUsdToLedgerUnits(scenario.fixedInfraUsd);
  const replacementCacUnits = parseUsdToLedgerUnits(scenario.replacementCacUsd);
  return platformNetUnits1e8 - variableUnits - fixedUnits - replacementCacUnits;
}

describe('PDF R10 Unit Economics Reconciliation against Safe-Spread Waterfall I4', () => {
  it.each(PDF_R10_SCENARIOS)(
    'reconciles $name scenario FCF under Retail I4 and Max B2B L2 holding PDF Page 69-70 costs constant',
    (scenario) => {
      const grossUnits = parseUsdToLedgerUnits(scenario.collectedCommissionUsd);

      // 1. Retail I4 (L2 = 0%, L3 hard-locked = 0%)
      const retail = computeSafeSpreadWaterfall(grossUnits, {
        hasL1Referrer: true,
        hasB2bAgencyPartner: false,
        config: DEFAULT_WATERFALL_CONFIG,
      });
      expect(retail.l2CommissionUnits).toBe(0n);
      expect(retail.l3CommissionUnits).toBe(0n);
      expect(
        retail.reserveUnits +
          retail.traderCashbackUnits +
          retail.l1CommissionUnits +
          retail.l2CommissionUnits +
          retail.l3CommissionUnits +
          retail.platformNetUnits
      ).toBe(grossUnits);

      const retailFcfUnits = computeModeledFcfUnits1e8(retail.platformNetUnits, scenario);
      expect(formatSignedLedgerUnitsToUsdCents(retailFcfUnits)).toBe(
        scenario.expectedRetailI4FcfUsd
      );

      // 2. Max B2B L2 (L2 = 10% of Spread = 4.75% of Gross, L3 hard-locked = 0%)
      const maxB2b = computeSafeSpreadWaterfall(grossUnits, {
        hasL1Referrer: true,
        hasB2bAgencyPartner: true,
        config: { ...DEFAULT_WATERFALL_CONFIG, tier2ShareOfSpread: '0.10' },
      });
      expect(maxB2b.l3CommissionUnits).toBe(0n);
      expect(
        maxB2b.reserveUnits +
          maxB2b.traderCashbackUnits +
          maxB2b.l1CommissionUnits +
          maxB2b.l2CommissionUnits +
          maxB2b.l3CommissionUnits +
          maxB2b.platformNetUnits
      ).toBe(grossUnits);

      const maxB2bFcfUnits = computeModeledFcfUnits1e8(maxB2b.platformNetUnits, scenario);
      expect(formatSignedLedgerUnitsToUsdCents(maxB2bFcfUnits)).toBe(
        scenario.expectedMaxB2bI4FcfUsd
      );
    }
  );

  it('proves BEAR remains FCF-negative under both Retail and Max B2B even with 100% cash collection', () => {
    const bear = PDF_R10_SCENARIOS[0];
    const grossUnits = parseUsdToLedgerUnits(bear.collectedCommissionUsd);
    const retail = computeSafeSpreadWaterfall(grossUnits, {
      hasL1Referrer: true,
      hasB2bAgencyPartner: false,
    });
    const maxB2b = computeSafeSpreadWaterfall(grossUnits, {
      hasL1Referrer: true,
      hasB2bAgencyPartner: true,
      config: { tier2ShareOfSpread: '0.10' },
    });

    expect(computeModeledFcfUnits1e8(retail.platformNetUnits, bear)).toBeLessThan(0n);
    expect(computeModeledFcfUnits1e8(maxB2b.platformNetUnits, bear)).toBeLessThan(0n);
  });
});
