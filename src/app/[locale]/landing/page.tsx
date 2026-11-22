'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowRight,
  BookOpen,
  Database,
  FileCheck2,
  Fingerprint,
  KeyRound,
  Shield,
  Terminal,
  Users,
  Wallet,
} from 'lucide-react';
import { RebateCalculator } from '@/components/landing/rebate-calculator';

const ASCENDANCY_PILLARS = [
  { icon: KeyRound, key: 'uidOnlyAttribution' as const },
  { icon: Database, key: 'atomicLedger' as const },
  { icon: FileCheck2, key: 'proofOfRebate' as const },
  { icon: Wallet, key: 'multiChainUsdc' as const },
  { icon: Users, key: 'twoTierPartner' as const },
  { icon: Fingerprint, key: 'hsmTreasury' as const },
] as const;

export default function LandingPage() {
  const t = useTranslations('landing');
  const tNav = useTranslations('nav');
  const locale = useLocale();

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary flex flex-col">
      <nav className="border-b border-stitch-divider bg-stitch-surface/80 backdrop-blur">
        <div className="flex items-center justify-between px-6 py-4 max-w-7xl mx-auto">
          <div className="flex items-center gap-6">
            <Link
              href={`/${locale}`}
              className="text-xl font-bold tracking-tight text-stitch-primary flex items-center gap-2"
            >
              <span className="inline-block w-2.5 h-2.5 rounded-full bg-stitch-emerald" />
              ApexOS
            </Link>
            <div className="hidden md:flex items-center gap-5 text-sm text-stitch-muted">
              <Link
                href={`/${locale}/deals`}
                className="hover:text-stitch-primary transition-colors"
              >
                {tNav('deals')}
              </Link>
              <Link
                href={`/${locale}/insights`}
                className="hover:text-stitch-primary transition-colors flex items-center gap-1.5"
              >
                <BookOpen className="w-3.5 h-3.5 text-stitch-emerald" />
                {tNav('insights')}
              </Link>
              <Link
                href={`/${locale}/terminal`}
                className="hover:text-stitch-primary transition-colors flex items-center gap-1.5"
              >
                <Terminal className="w-3.5 h-3.5 text-stitch-cyan" />
                {tNav('terminal')}
              </Link>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <Link
              href={`/${locale}/login`}
              className="text-stitch-muted hover:text-stitch-primary px-3 py-2 text-sm font-medium transition-colors"
            >
              {tNav('login')}
            </Link>
            <Link
              href={`/${locale}/signup`}
              className="bg-stitch-emerald text-slate-950 px-4 py-2 rounded-lg hover:opacity-90 text-sm font-semibold transition-opacity"
            >
              {tNav('signup')}
            </Link>
          </div>
        </div>
      </nav>

      <main className="flex-1 max-w-7xl mx-auto w-full px-6 py-16 md:py-24 space-y-20">
        {/* Hero Section */}
        <section className="text-center">
          <div className="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-stitch-surface border border-stitch-divider text-stitch-emerald text-xs font-mono uppercase tracking-wider mb-6">
            <Shield className="w-3.5 h-3.5" />
            <span>{t('heroBadge')}</span>
          </div>
          <h1 className="text-4xl md:text-6xl font-bold text-stitch-primary tracking-tight mb-6 max-w-4xl mx-auto">
            {t('heroTitle')}
          </h1>
          <p className="text-lg md:text-xl text-stitch-muted mb-10 max-w-3xl mx-auto leading-relaxed">
            {t('heroSubtitle')}
          </p>
          <div className="flex flex-wrap gap-4 justify-center">
            <Link
              href={`/${locale}/terminal`}
              className="bg-stitch-emerald text-slate-950 px-7 py-3.5 rounded-lg hover:opacity-90 font-semibold inline-flex items-center gap-2 transition-opacity"
            >
              {t('ctaPrimary')}
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href={`/${locale}/insights`}
              className="border border-stitch-divider bg-stitch-surface text-stitch-primary px-7 py-3.5 rounded-lg hover:border-stitch-emerald font-medium inline-flex items-center gap-2 transition-colors"
            >
              <BookOpen className="w-4 h-4 text-stitch-emerald" />
              {t('ctaSecondary')}
            </Link>
            <Link
              href={`/${locale}/deals`}
              className="border border-stitch-divider bg-stitch-well text-stitch-muted hover:text-stitch-primary px-6 py-3.5 rounded-lg font-medium transition-colors"
            >
              {t('ctaDeals')}
            </Link>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-4xl mx-auto mt-14">
            <div className="stitch-obsidian-card p-5 text-center">
              <div className="text-2xl md:text-3xl font-bold font-mono text-stitch-emerald stitch-tabular-nums">
                47.5% / 14.25% / ≤4.75%
              </div>
              <div className="text-xs text-stitch-muted uppercase tracking-wider mt-1">
                {t('stats.waterfall')}
              </div>
            </div>
            <div className="stitch-obsidian-card p-5 text-center">
              <div className="text-2xl md:text-3xl font-bold font-mono text-stitch-primary stitch-tabular-nums">
                10^-8 USD · T+7
              </div>
              <div className="text-xs text-stitch-muted uppercase tracking-wider mt-1">
                {t('stats.ledger')}
              </div>
            </div>
            <div className="stitch-obsidian-card p-5 text-center">
              <div className="text-xl md:text-2xl font-bold font-mono text-stitch-cyan stitch-tabular-nums">
                Stellar · Arbitrum · Base
              </div>
              <div className="text-xs text-stitch-muted uppercase tracking-wider mt-1">
                {t('stats.rails')}
              </div>
            </div>
          </div>
        </section>

        {/* Safe-Spread Waterfall Rebate Calculator */}
        <RebateCalculator locale={locale} />

        {/* 6 Ascendancy Non-Custodial Infrastructure Pillars */}
        <section aria-labelledby="ascendancy-pillars-heading">
          <h2
            id="ascendancy-pillars-heading"
            className="text-2xl md:text-3xl font-bold text-center text-stitch-primary mb-12"
          >
            {t('features.title')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {ASCENDANCY_PILLARS.map((pillar) => {
              const Icon = pillar.icon;
              return (
                <div
                  key={pillar.key}
                  data-testid={`pillar-${pillar.key}`}
                  className="stitch-obsidian-card p-6 hover:border-stitch-emerald/60 transition-colors"
                >
                  <div className="w-10 h-10 rounded-lg bg-stitch-well border border-stitch-divider flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-stitch-emerald" />
                  </div>
                  <h3 className="text-lg font-semibold text-stitch-primary mb-2">
                    {t(`features.${pillar.key}.title`)}
                  </h3>
                  <p className="text-sm text-stitch-muted leading-relaxed">
                    {t(`features.${pillar.key}.desc`)}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-stitch-divider bg-stitch-surface/40 py-10 px-6 text-stitch-muted text-sm">
        <div className="max-w-7xl mx-auto flex flex-col gap-6">
          <p className="text-xs text-stitch-muted max-w-4xl leading-relaxed">
            {t('footer.disclaimer')}
          </p>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pt-4 border-t border-stitch-divider/60">
            <p>{t('footer.rights')}</p>
            <nav
              aria-label="Legal and regulatory compliance"
              className="flex flex-wrap items-center gap-6 text-xs font-medium"
            >
              <Link
                href={`/${locale}/b2b/proof-of-rebate`}
                className="hover:text-stitch-emerald transition-colors"
              >
                {locale === 'vi' ? 'Xác minh Proof-of-Rebate (B2B)' : 'B2B Proof-of-Rebate'}
              </Link>
              <Link
                href={`/${locale}/legal/terms`}
                className="hover:text-stitch-emerald transition-colors"
              >
                {t('footer.terms')}
              </Link>
              <Link
                href={`/${locale}/legal/non-custodial-disclosure`}
                className="hover:text-stitch-emerald transition-colors"
              >
                {t('footer.nonCustodialDisclosure')}
              </Link>
              <Link
                href={`/${locale}/legal/geo-restriction`}
                className="hover:text-stitch-emerald transition-colors"
              >
                {t('footer.geoRestriction')}
              </Link>
            </nav>
          </div>
        </div>
      </footer>
    </div>
  );
}
