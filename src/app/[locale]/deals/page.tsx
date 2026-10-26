import { Suspense } from 'react';
import Link from 'next/link';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import DealsFilters from './deals-client';
import DealsResults from './DealsResults';
import ArbitrageFinder from '@/components/deals/ArbitrageFinder';
import { StitchObsidianBanner } from '@/components/stitch/StitchObsidianBanner';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string>>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'deals' });

  return {
    title: `${t('title')} — ApexOS`,
    description: t('subtitle'),
  };
}

export default async function DealsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { exchange, category, deal_type, search, page = '1', limit = '20', tab = 'deals' } = await searchParams;

  // Set locale for next-intl
  setRequestLocale(locale);

  const queryParams = new URLSearchParams();
  if (exchange) queryParams.set('exchange', exchange);
  if (category) queryParams.set('category', category);
  if (deal_type) queryParams.set('deal_type', deal_type);
  if (search) queryParams.set('search', search);
  if (page) queryParams.set('page', page);
  if (limit) queryParams.set('limit', limit);

  const dealsUrl = `/api/public/deals?${queryParams.toString()}`;

  // Get translations for server-rendered text
  const t = await getTranslations({ locale, namespace: 'deals' });
  const pageNum = parseInt(page) || 1;

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <StitchObsidianBanner
          locale={locale}
          targetTab="arbitrage"
          screenLabel="Screen 2 · Basis-Point (bps) Arbitrage & Deal Crawler Matrix"
        />

        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
          <p className="mt-2 text-gray-600">{t('subtitle')}</p>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b border-gray-200 mb-8 space-x-8">
          <Link
            href={`/${locale}/deals?tab=deals`}
            className={`pb-4 px-1 border-b-2 font-medium text-sm transition-colors ${
              tab !== 'arbitrage'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            All Deals
          </Link>
          <Link
            href={`/${locale}/deals?tab=arbitrage`}
            className={`pb-4 px-1 border-b-2 font-medium text-sm flex items-center gap-2 transition-colors ${
              tab === 'arbitrage'
                ? 'border-brand-600 text-brand-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <span>Arbitrage & Yield Finder</span>
            <span className="bg-amber-100 text-amber-800 text-xs px-2 py-0.5 rounded-full font-semibold">
              Live Matrix
            </span>
          </Link>
        </div>

        {/* Tab Content */}
        {tab === 'arbitrage' ? (
          <Suspense fallback={<div className="animate-pulse h-96 bg-gray-100 rounded-xl" />}>
            <ArbitrageFinder />
          </Suspense>
        ) : (
          /* Filters and Results */
          <div className="flex flex-col lg:flex-row gap-8">
            {/* Filters Sidebar */}
            <aside className="lg:w-64 flex-shrink-0">
              <div className="bg-white rounded-lg shadow p-6 sticky top-6">
                <Suspense fallback={<div className="animate-pulse h-64 bg-gray-100 rounded"></div>}>
                  <DealsFilters
                    initialFilters={{ exchange, category, deal_type, search }}
                  />
                </Suspense>
              </div>
            </aside>

            {/* Deals Grid */}
            <main className="flex-1">
              <Suspense fallback={<div className="animate-pulse h-96 bg-gray-100 rounded"></div>}>
                <DealsResults
                  apiUrl={dealsUrl}
                  initialPage={pageNum}
                  initialFilters={{ exchange, category, deal_type, search }}
                />
              </Suspense>
            </main>
          </div>
        )}
      </div>
    </div>
  );
}
