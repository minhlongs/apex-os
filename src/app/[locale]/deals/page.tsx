import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import DealsFilters from './deals-client';
import DealsResults from './DealsResults';

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
  const { exchange, category, deal_type, search, page = '1', limit = '20' } = await searchParams;

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
        {/* Header */}
        <div className="mb-8">
          <h1 className="text-3xl font-bold text-gray-900">{t('title')}</h1>
          <p className="mt-2 text-gray-600">{t('subtitle')}</p>
        </div>

        {/* Filters and Results */}
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
      </div>
    </div>
  );
}
