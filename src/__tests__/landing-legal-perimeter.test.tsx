/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  RebateCalculator,
  PARTNER_EXCHANGE_SPECS,
  MIN_MONTHLY_VOLUME_USD,
  MAX_MONTHLY_VOLUME_USD,
  LEDGER_SCALE_1E8,
  BINANCE_EXCLUSION_NOTE_EN,
  BINANCE_EXCLUSION_NOTE_VI,
  sanitizeMonthlyVolumeUsd,
  computeWaterfallFromGrossUnits,
  calculateSafeSpreadWaterfallRebate,
  unitsToExactDecimalString,
} from '@/components/landing/rebate-calculator';
import { computeSafeSpreadWaterfall } from '@/lib/ledger/waterfall';
import LandingPage from '@/app/[locale]/landing/page';
import TermsPage from '@/app/[locale]/legal/terms/page';
import NonCustodialDisclosurePage from '@/app/[locale]/legal/non-custodial-disclosure/page';
import GeoRestrictionPage from '@/app/[locale]/legal/geo-restriction/page';
import sitemap from '@/app/sitemap';
import robots from '@/app/robots';
import enMessages from '@/i18n/messages/en.json';
import viMessages from '@/i18n/messages/vi.json';

let mockActiveLocale: 'en' | 'vi' = 'en';

jest.mock('next-intl', () => ({
  useLocale: () => mockActiveLocale,
  useTranslations: (namespace?: string) => {
    const dict = (mockActiveLocale === 'vi' ? viMessages : enMessages) as Record<string, unknown>;
    return (key: string) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const resolved = fullPath.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, dict);
      return typeof resolved === 'string' ? resolved : fullPath;
    };
  },
}));

jest.mock('next-intl/server', () => ({
  setRequestLocale: jest.fn(),
  getTranslations: async ({ locale, namespace }: { locale: string; namespace?: string }) => {
    const dict = (locale === 'vi' ? viMessages : enMessages) as Record<string, unknown>;
    return (key: string) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const resolved = fullPath.split('.').reduce<unknown>((acc, part) => {
        if (acc && typeof acc === 'object' && part in (acc as Record<string, unknown>)) {
          return (acc as Record<string, unknown>)[part];
        }
        return undefined;
      }, dict);
      return typeof resolved === 'string' ? resolved : fullPath;
    };
  },
}));

describe('Workstream D — Non-Custodial Rebate Calculator, Landing & Legal Perimeter', () => {
  beforeEach(() => {
    mockActiveLocale = 'en';
  });

  describe('Safe-Spread Waterfall Exact Integer Math (10^-8 USD)', () => {
    it('supports all 5 partner exchanges and excludes Binance', () => {
      const ids = PARTNER_EXCHANGE_SPECS.map((s) => s.id);
      expect(ids).toEqual(['bybit', 'okx', 'bitget', 'kucoin', 'gateio']);
      expect(ids).not.toContain('binance');

      const liveIds = PARTNER_EXCHANGE_SPECS.filter((s) => s.status === 'live').map((s) => s.id);
      const onboardingIds = PARTNER_EXCHANGE_SPECS.filter((s) => s.status === 'onboarding').map(
        (s) => s.id
      );
      expect(liveIds).toEqual(['bybit', 'okx', 'bitget']);
      expect(onboardingIds).toEqual(['kucoin', 'gateio']);
    });

    it('clamps out-of-range, negative, and NaN volume inputs at boundary', () => {
      expect(sanitizeMonthlyVolumeUsd(-500)).toBe(MIN_MONTHLY_VOLUME_USD);
      expect(sanitizeMonthlyVolumeUsd(0)).toBe(MIN_MONTHLY_VOLUME_USD);
      expect(sanitizeMonthlyVolumeUsd(1_000_000_000)).toBe(MAX_MONTHLY_VOLUME_USD);
      expect(sanitizeMonthlyVolumeUsd('not-a-number')).toBe(MIN_MONTHLY_VOLUME_USD);
      expect(sanitizeMonthlyVolumeUsd('$2,500,000')).toBe(2_500_000);
    });

    it('conserves 100% of gross units across reserve, trader, L1, L2 (L3=0), and platform net', () => {
      const oddGrossSamples = [
        BigInt(0),
        BigInt(1),
        BigInt(7),
        BigInt(99),
        BigInt(101),
        BigInt('9000000000'), // $90.00 in 10^-8 units
        BigInt('12345678901'),
      ];

      for (const gross of oddGrossSamples) {
        const wf = computeWaterfallFromGrossUnits(gross);
        expect(wf.l3PartnerUnits).toBe(BigInt(0));

        const total =
          wf.clawbackReserveUnits +
          wf.traderCashbackUnits +
          wf.l1PartnerUnits +
          wf.l2SubPartnerUnits +
          wf.l3PartnerUnits +
          wf.platformNetUnits;

        expect(total).toBe(gross);
        expect(wf.annualizedTraderSavingsUnits).toBe(wf.traderCashbackUnits * BigInt(12));

        if (gross > BigInt(0)) {
          const ledgerWf = computeSafeSpreadWaterfall(gross);
          expect(wf.clawbackReserveUnits).toBe(ledgerWf.reserveUnits);
          expect(wf.traderCashbackUnits).toBe(ledgerWf.traderCashbackUnits);
          expect(wf.l1PartnerUnits).toBe(ledgerWf.l1CommissionUnits);
          expect(wf.l2SubPartnerUnits).toBe(ledgerWf.l2CommissionUnits);
          expect(wf.l3PartnerUnits).toBe(ledgerWf.l3CommissionUnits);
          expect(wf.platformNetUnits).toBe(ledgerWf.platformNetUnits);
        }
      }

      expect(() => computeWaterfallFromGrossUnits(BigInt(-1))).toThrow(RangeError);
    });

    it('computes deterministic Bybit Futures $1,000,000 Safe-Spread Waterfall in 10^-8 units matching src/lib/ledger/waterfall.ts', () => {
      const result = calculateSafeSpreadWaterfallRebate({
        exchange: 'bybit',
        marketType: 'futures',
        monthlyVolumeUsd: 1_000_000,
      });

      // $1,000,000 * 4.00 bps = $400 exchange fee; 45% partner gross = $180.00 (1.80 bps)
      // Reserve R = 5% of $180 = $9.00; Distributable D = $171.00
      // Trader = 50% of D = $85.50 (47.50% gross); Spread S = $85.50
      // L1 = 30% of S = $25.65 (14.25% gross); L2 default = $0.00; Platform Net = $59.85 (33.25% gross)
      expect(result.exchangeFeeUnits).toBe(BigInt(400) * LEDGER_SCALE_1E8);
      expect(result.waterfall.grossCommissionUnits).toBe(BigInt(180) * LEDGER_SCALE_1E8);
      expect(result.waterfall.clawbackReserveUnits).toBe(BigInt(9) * LEDGER_SCALE_1E8);
      expect(result.waterfall.traderCashbackUnits).toBe(BigInt('8550000000')); // $85.50
      expect(result.waterfall.l1PartnerUnits).toBe(BigInt('2565000000')); // $25.65
      expect(result.waterfall.l2SubPartnerUnits).toBe(BigInt(0)); // $0.00 default
      expect(result.waterfall.l3PartnerUnits).toBe(BigInt(0)); // L3 = 0%
      expect(result.waterfall.platformNetUnits).toBe(BigInt('5985000000')); // $59.85
      expect(result.waterfall.annualizedTraderSavingsUnits).toBe(BigInt(1026) * LEDGER_SCALE_1E8);
      expect(unitsToExactDecimalString(result.waterfall.traderCashbackUnits)).toBe('85.50000000');
    });
  });

  describe('RebateCalculator Interactive UI (EN & VI)', () => {
    it('renders 5 exchanges, Binance exclusion disclosure, and updates calculations interactively', () => {
      render(<RebateCalculator locale="en" />);

      expect(screen.getByTestId('binance-exclusion-note').textContent).toContain(
        BINANCE_EXCLUSION_NOTE_EN
      );

      // Default is Bybit Futures @ $500,000 -> Gross $90, Reserve $4.50, Distributable $85.50, Trader $42.75/mo, Annual $513/yr
      expect(screen.getByTestId('trader-monthly-cashback').textContent).toBe('$42.75');
      expect(screen.getByTestId('trader-annualized-savings').textContent).toBe('$513.00');

      // Switch to KuCoin + Spot + $10,000,000 preset
      fireEvent.click(screen.getByTestId('exchange-btn-kucoin'));
      fireEvent.click(screen.getByTestId('market-btn-spot'));
      fireEvent.click(screen.getByTestId('volume-preset-10000000'));

      // KuCoin Spot: 10 bps fee ($10,000), 45% partner gross = 4.50 bps ($4,500), 5% reserve ($225), 50% of $4,275 distributable = $2,137.50
      expect(screen.getByTestId('effective-fee-bps').textContent).toContain('10.00 bps');
      expect(screen.getByTestId('waterfall-gross').textContent).toBe('$4,500.00');
      expect(screen.getByTestId('waterfall-reserve').textContent).toBe('$225.00');
      expect(screen.getByTestId('trader-monthly-cashback').textContent).toBe('$2,137.50');
    });

    it('renders Vietnamese localization cleanly', () => {
      render(<RebateCalculator locale="vi" />);
      expect(screen.getByTestId('binance-exclusion-note').textContent).toContain(
        BINANCE_EXCLUSION_NOTE_VI
      );
    });
  });

  describe('Landing Page Clean-Room Positioning & Legal Links', () => {
    it('renders non-custodial positioning with zero Copy Trading, AI Signals, or 3-Tier claims (EN & VI)', () => {
      for (const locale of ['en', 'vi'] as const) {
        mockActiveLocale = locale;
        const { unmount, container } = render(<LandingPage />);
        const text = container.textContent ?? '';

        expect(text.toLowerCase()).not.toContain('copy trading');
        expect(text.toLowerCase()).not.toContain('copy-trading');
        expect(text.toLowerCase()).not.toContain('ai signal');
        expect(text.toLowerCase()).not.toContain('3-tier');
        expect(text.toLowerCase()).not.toContain('30% / 10% / 5%');

        // Verify all 3 legal perimeter links are present in footer
        const hrefs = Array.from(container.querySelectorAll('a')).map((a) =>
          a.getAttribute('href')
        );
        expect(hrefs).toContain(`/${locale}/legal/terms`);
        expect(hrefs).toContain(`/${locale}/legal/non-custodial-disclosure`);
        expect(hrefs).toContain(`/${locale}/legal/geo-restriction`);
        unmount();
      }
    });
  });

  describe('Legal Perimeter Server Pages & Sitemap/Robots Registration', () => {
    it('renders Terms, Non-Custodial Disclosure, and Geo-Restriction pages in EN and VI', async () => {
      for (const locale of ['en', 'vi'] as const) {
        const termsEl = await TermsPage({ params: Promise.resolve({ locale }) });
        const { unmount: u1, container: c1 } = render(termsEl);
        expect(c1.textContent).toContain('UID');
        expect(c1.textContent).toContain('T+7');
        u1();

        const disclosureEl = await NonCustodialDisclosurePage({
          params: Promise.resolve({ locale }),
        });
        const { unmount: u2, container: c2 } = render(disclosureEl);
        expect(c2.textContent).toContain('Turnkey');
        expect(c2.textContent).toContain('Stellar');
        expect(c2.textContent).toContain('Arbitrum');
        expect(c2.textContent).toContain('Base');
        u2();

        const geoEl = await GeoRestrictionPage({ params: Promise.resolve({ locale }) });
        const { unmount: u3, container: c3 } = render(geoEl);
        expect(c3.textContent).toContain('451');
        expect((c3.textContent ?? '').toLowerCase()).toContain('cf-ipcountry');
        expect(c3.textContent).toContain('BLOCK_VN_SIGNUPS');
        u3();
      }
    });

    it('registers localized legal and B2B Proof-of-Rebate routes in sitemap.xml and robots.txt allowlist on the verified canonical Worker origin', () => {
      const urls = sitemap().map((entry) => entry.url);
      const expectedOrigin = 'https://apex-os.agencyos-openclaw.workers.dev';
      for (const locale of ['en', 'vi']) {
        expect(urls).toContain(`${expectedOrigin}/${locale}/legal/terms`);
        expect(urls).toContain(`${expectedOrigin}/${locale}/legal/non-custodial-disclosure`);
        expect(urls).toContain(`${expectedOrigin}/${locale}/legal/geo-restriction`);
        expect(urls).toContain(`${expectedOrigin}/${locale}/b2b/proof-of-rebate`);
      }

      const robotConfig = robots();
      const rule = Array.isArray(robotConfig.rules) ? robotConfig.rules[0] : robotConfig.rules;
      expect(rule.allow).toEqual(
        expect.arrayContaining([
          '/vi/legal/*',
          '/en/legal/*',
          '/vi/b2b/proof-of-rebate',
          '/en/b2b/proof-of-rebate',
        ])
      );
    });
  });
});
