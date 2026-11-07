'use client';

export const dynamic = 'force-dynamic';

import Link from 'next/link';
import { useLocale, useTranslations } from 'next-intl';
import {
  ArrowRight,
  TrendingUp,
  Shield,
  BarChart3,
  Users,
  Zap,
  BookOpen,
  Terminal,
  Percent,
} from 'lucide-react';

const FEATURE_KEYS = [
  { icon: Zap, key: 'aiSignals' as const },
  { icon: Percent, key: 'copyTrading' as const },
  { icon: Shield, key: 'riskManage' as const },
  { icon: BarChart3, key: 'paperTrade' as const },
  { icon: Users, key: 'referral' as const },
  { icon: TrendingUp, key: 'multiExchange' as const },
] as const;

export default function LandingPage() {
  const t = useTranslations('landing');
  const tNav = useTranslations('nav');
  const locale = useLocale();

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary">
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

      <main className="max-w-7xl mx-auto px-6 py-16 md:py-24">
        <section className="text-center mb-20">
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

          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 max-w-3xl mx-auto mt-14">
            <div className="stitch-obsidian-card p-5 text-center">
              <div className="text-2xl md:text-3xl font-bold font-mono text-stitch-emerald stitch-tabular-nums">
                2.7 – 12.0 bps
              </div>
              <div className="text-xs text-stitch-muted uppercase tracking-wider mt-1">
                {t('stats.volume')}
              </div>
            </div>
            <div className="stitch-obsidian-card p-5 text-center">
              <div className="text-2xl md:text-3xl font-bold font-mono text-stitch-primary stitch-tabular-nums">
                30% / 10% / 5%
              </div>
              <div className="text-xs text-stitch-muted uppercase tracking-wider mt-1">
                {t('stats.users')}
              </div>
            </div>
            <div className="stitch-obsidian-card p-5 text-center">
              <div className="text-2xl md:text-3xl font-bold font-mono text-stitch-cyan stitch-tabular-nums">
                Binance · Bybit · OKX · KuCoin
              </div>
              <div className="text-xs text-stitch-muted uppercase tracking-wider mt-1">
                {t('stats.masters')}
              </div>
            </div>
          </div>
        </section>

        <section>
          <h2 className="text-2xl md:text-3xl font-bold text-center text-stitch-primary mb-12">
            {t('features.title')}
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            {FEATURE_KEYS.map((f) => {
              const Icon = f.icon;
              return (
                <div
                  key={f.key}
                  className="stitch-obsidian-card p-6 hover:border-stitch-emerald/60 transition-colors"
                >
                  <div className="w-10 h-10 rounded-lg bg-stitch-well border border-stitch-divider flex items-center justify-center mb-4">
                    <Icon className="w-5 h-5 text-stitch-emerald" />
                  </div>
                  <h3 className="text-lg font-semibold text-stitch-primary mb-2">
                    {t(`features.${f.key}.title`)}
                  </h3>
                  <p className="text-sm text-stitch-muted leading-relaxed">
                    {t(`features.${f.key}.desc`)}
                  </p>
                </div>
              );
            })}
          </div>
        </section>
      </main>

      <footer className="border-t border-stitch-divider py-8 text-center text-stitch-muted text-sm">
        <p>{t('footer.rights')}</p>
      </footer>
    </div>
  );
}
