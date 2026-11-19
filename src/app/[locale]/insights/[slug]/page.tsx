import { notFound } from 'next/navigation';
import Link from 'next/link';
import type { Metadata } from 'next';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { QUANT_INSIGHT_ARTICLES, getQuantInsightBySlug } from '@/data/quant-insights';
import { generateTechArticleJsonLd } from '@/lib/seo/json-ld';
import { ArrowLeft, ArrowRight, Clock, Shield, CheckCircle2 } from 'lucide-react';

type Props = {
  params: Promise<{ locale: string; slug: string }>;
};

const locales = ['vi', 'en'] as const;

export function generateStaticParams() {
  const params: Array<{ locale: string; slug: string }> = [];
  for (const locale of locales) {
    for (const article of QUANT_INSIGHT_ARTICLES) {
      params.push({ locale, slug: article.slug });
    }
  }
  return params;
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { locale, slug } = await params;
  const article = getQuantInsightBySlug(slug);
  if (!article) {
    return { title: 'Insight Not Found — ApexOS' };
  }

  const isVi = locale === 'vi';
  const { CANONICAL_PRODUCTION_ORIGIN, resolveCanonicalAppOrigin } = await import(
    '@/config/canonical-origin'
  );
  const baseUrl =
    resolveCanonicalAppOrigin({ appEnv: 'production' }) || CANONICAL_PRODUCTION_ORIGIN;
  const title = isVi ? article.title.vi : article.title.en;
  const description = isVi ? article.summary.vi : article.summary.en;

  return {
    title: `${title} — ApexOS`,
    description,
    keywords: article.tags.join(', '),
    alternates: {
      canonical: `${baseUrl}/${locale}/insights/${slug}`,
      languages: {
        'vi-VN': `/vi/insights/${slug}`,
        'en-US': `/en/insights/${slug}`,
      },
    },
    openGraph: {
      title,
      description,
      type: 'article',
      publishedTime: article.publishedAt,
    },
  };
}

export default async function InsightArticlePage({ params }: Props) {
  const { locale, slug } = await params;
  if (!locales.includes(locale as (typeof locales)[number])) {
    notFound();
  }

  setRequestLocale(locale);
  const article = getQuantInsightBySlug(slug);
  if (!article) {
    notFound();
  }

  const t = await getTranslations({ locale, namespace: 'insights' });
  const isVi = locale === 'vi';
  const title = isVi ? article.title.vi : article.title.en;
  const summary = isVi ? article.summary.vi : article.summary.en;

  const techArticleJsonLd = generateTechArticleJsonLd({
    slug: article.slug,
    title,
    description: summary,
    publishedAt: article.publishedAt,
    locale,
  });

  const formattedDate = new Date(article.publishedAt).toLocaleDateString(
    isVi ? 'vi-VN' : 'en-US',
    { year: 'numeric', month: 'short', day: 'numeric' }
  );

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary">
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(techArticleJsonLd) }}
      />

      <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-12">
        <div className="mb-8">
          <Link
            href={`/${locale}/insights`}
            className="inline-flex items-center text-stitch-emerald hover:underline text-sm font-medium"
          >
            <ArrowLeft className="w-4 h-4 mr-2" />
            {t('backToList')}
          </Link>
        </div>

        {/* Article Header */}
        <header className="stitch-obsidian-card p-6 md:p-10 mb-8">
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono text-stitch-muted mb-4">
            <span className="px-2.5 py-1 rounded bg-stitch-well border border-stitch-divider text-stitch-emerald uppercase">
              {article.category}
            </span>
            <span className="inline-flex items-center gap-1">
              <Clock className="w-3.5 h-3.5" />
              {t('readingTime', { minutes: article.readingTimeMinutes })}
            </span>
            <span>•</span>
            <span>{t('publishedOn', { date: formattedDate })}</span>
          </div>

          <h1 className="text-2xl md:text-4xl font-bold text-stitch-primary mb-4 leading-tight">
            {title}
          </h1>

          <p className="text-stitch-muted text-base md:text-lg leading-relaxed mb-6">
            {summary}
          </p>

          {/* Quantitative Metrics Highlight Bar */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 p-4 rounded-xl bg-stitch-well/70 border border-stitch-divider font-mono text-xs">
            <div>
              <div className="text-stitch-muted uppercase mb-1">Target Impact</div>
              <div className="text-stitch-emerald text-base font-bold stitch-tabular-nums">
                {article.metricsHighlight.bps}
              </div>
            </div>
            <div>
              <div className="text-stitch-muted uppercase mb-1">Supported Venues</div>
              <div className="text-stitch-primary font-semibold">
                {article.metricsHighlight.exchanges.join(' · ')}
              </div>
            </div>
            <div>
              <div className="text-stitch-muted uppercase mb-1">Settlement Rail</div>
              <div className="text-stitch-cyan font-semibold">
                {article.metricsHighlight.settlement}
              </div>
            </div>
          </div>
        </header>

        {/* Article Sections */}
        <div className="space-y-8 mb-12">
          {article.sections.map((section, idx) => {
            const heading = isVi ? section.heading.vi : section.heading.en;
            const content = isVi ? section.content.vi : section.content.en;
            const callout = section.callout
              ? isVi
                ? section.callout.vi
                : section.callout.en
              : null;

            return (
              <section key={idx} className="stitch-obsidian-card p-6 md:p-8">
                <h2 className="text-xl md:text-2xl font-bold text-stitch-primary mb-4">
                  {heading}
                </h2>
                <p className="text-stitch-muted text-base leading-relaxed mb-4">
                  {content}
                </p>
                {callout && (
                  <div className="mt-4 p-4 rounded-lg bg-stitch-well border-l-4 border-stitch-emerald text-sm font-mono text-stitch-primary flex items-start gap-3">
                    <CheckCircle2 className="w-5 h-5 text-stitch-emerald flex-shrink-0 mt-0.5" />
                    <div>{callout}</div>
                  </div>
                )}
              </section>
            );
          })}
        </div>

        {/* Footer CTA */}
        <div className="stitch-obsidian-card p-8 text-center">
          <div className="inline-flex items-center gap-2 text-xs font-mono text-stitch-emerald uppercase mb-2">
            <Shield className="w-4 h-4" />
            <span>Zero-Secret API Key ID Verification</span>
          </div>
          <h3 className="text-xl md:text-2xl font-bold text-stitch-primary mb-2">
            {t('ctaTitle')}
          </h3>
          <p className="text-stitch-muted text-sm max-w-xl mx-auto mb-6">
            {t('ctaDesc')}
          </p>
          <div className="flex flex-wrap justify-center gap-4">
            <Link
              href={`/${locale}/terminal`}
              className="inline-flex items-center gap-2 bg-stitch-emerald text-slate-950 px-6 py-3 rounded-lg font-semibold text-sm hover:opacity-90 transition-opacity"
            >
              {t('ctaButton')}
              <ArrowRight className="w-4 h-4" />
            </Link>
            <Link
              href={`/${locale}/deals`}
              className="inline-flex items-center gap-2 border border-stitch-divider bg-stitch-well text-stitch-primary px-6 py-3 rounded-lg font-medium text-sm hover:border-stitch-emerald transition-colors"
            >
              View Live Rebate Matrix
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
