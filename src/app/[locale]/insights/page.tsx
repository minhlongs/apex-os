import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { QUANT_INSIGHT_ARTICLES } from '@/data/quant-insights';
import { ArrowRight, BookOpen, Clock, Zap, Shield, TrendingUp } from 'lucide-react';

type Props = {
  params: Promise<{ locale: string }>;
};

const CATEGORY_ICONS = {
  microstructure: Zap,
  security: Shield,
  liquidity: TrendingUp,
} as const;

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const { CANONICAL_PRODUCTION_ORIGIN, resolveCanonicalAppOrigin } = await import(
    '@/config/canonical-origin'
  );
  const baseUrl =
    resolveCanonicalAppOrigin({ appEnv: 'production' }) || CANONICAL_PRODUCTION_ORIGIN;
  const t = await getTranslations({ locale, namespace: 'insights' });

  return {
    title: `${t('title')} — ApexOS`,
    description: t('subtitle'),
    alternates: {
      canonical: `${baseUrl}/${locale}/insights`,
      languages: {
        'vi-VN': '/vi/insights',
        'en-US': '/en/insights',
      },
    },
  };
}

export default async function InsightsListPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations({ locale, namespace: 'insights' });
  const isVi = locale === 'vi';

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-12 md:py-16">
        {/* Header */}
        <div className="text-center max-w-3xl mx-auto mb-16">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-stitch-surface border border-stitch-divider text-stitch-emerald text-xs font-mono uppercase tracking-wider mb-4">
            <BookOpen className="w-3.5 h-3.5" />
            <span>{t('badge')}</span>
          </div>
          <h1 className="text-3xl md:text-5xl font-bold tracking-tight text-stitch-primary mb-4">
            {t('title')}
          </h1>
          <p className="text-stitch-muted text-base md:text-lg leading-relaxed">
            {t('subtitle')}
          </p>
        </div>

        {/* Articles Grid */}
        <Suspense fallback={<div className="animate-pulse h-96 bg-stitch-surface rounded-xl" />}>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 mb-16">
            {QUANT_INSIGHT_ARTICLES.map((article) => {
              const Icon = CATEGORY_ICONS[article.category];
              const title = isVi ? article.title.vi : article.title.en;
              const summary = isVi ? article.summary.vi : article.summary.en;

              return (
                <article
                  key={article.slug}
                  className="stitch-obsidian-card flex flex-col justify-between p-6 hover:border-stitch-emerald/60 transition-colors"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-4">
                      <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md bg-stitch-well text-xs font-mono text-stitch-emerald uppercase tracking-wider border border-stitch-divider">
                        <Icon className="w-3.5 h-3.5" />
                        {article.category}
                      </span>
                      <span className="inline-flex items-center gap-1 text-xs font-mono text-stitch-muted">
                        <Clock className="w-3.5 h-3.5" />
                        {t('readingTime', { minutes: article.readingTimeMinutes })}
                      </span>
                    </div>

                    <h2 className="text-xl font-bold text-stitch-primary mb-3 line-clamp-2 leading-snug">
                      <Link
                        href={`/${locale}/insights/${article.slug}`}
                        className="hover:text-stitch-emerald transition-colors"
                      >
                        {title}
                      </Link>
                    </h2>

                    <p className="text-sm text-stitch-muted mb-6 line-clamp-3 leading-relaxed">
                      {summary}
                    </p>

                    <div className="p-3 bg-stitch-well/60 rounded-lg border border-stitch-divider mb-6 text-xs font-mono">
                      <div className="flex justify-between items-center mb-1">
                        <span className="text-stitch-muted">Metric:</span>
                        <span className="text-stitch-emerald font-semibold stitch-tabular-nums">
                          {article.metricsHighlight.bps}
                        </span>
                      </div>
                      <div className="flex justify-between items-center text-stitch-muted">
                        <span>Settlement:</span>
                        <span className="text-stitch-primary">{article.metricsHighlight.settlement}</span>
                      </div>
                    </div>
                  </div>

                  <Link
                    href={`/${locale}/insights/${article.slug}`}
                    className="inline-flex items-center justify-between w-full pt-4 border-t border-stitch-divider text-stitch-emerald hover:text-stitch-emerald/80 text-sm font-semibold group"
                  >
                    <span>{t('readArticle')}</span>
                    <ArrowRight className="w-4 h-4 transform group-hover:translate-x-1 transition-transform" />
                  </Link>
                </article>
              );
            })}
          </div>
        </Suspense>

        {/* CTA Section */}
        <section className="stitch-obsidian-card p-8 md:p-12 text-center bg-gradient-to-b from-stitch-surface to-stitch-well/70">
          <h2 className="text-2xl md:text-3xl font-bold text-stitch-primary mb-3">
            {t('ctaTitle')}
          </h2>
          <p className="text-stitch-muted text-sm md:text-base max-w-2xl mx-auto mb-6">
            {t('ctaDesc')}
          </p>
          <Link
            href={`/${locale}/terminal`}
            className="inline-flex items-center gap-2 bg-stitch-emerald text-slate-950 px-6 py-3 rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity"
          >
            {t('ctaButton')}
            <ArrowRight className="w-4 h-4" />
          </Link>
        </section>
      </div>
    </div>
  );
}
