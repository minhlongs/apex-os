import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import ConversionsClient from './conversions-client';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string>>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'conversions' });

  return {
    title: `${t('title')} — ApexOS`,
    description: t('subtitle'),
  };
}

export default async function ConversionsPage({ params, searchParams }: Props) {
  const { locale } = await params;
  const { status, conversion_type, search, page = '1' } = await searchParams;

  // Set locale for next-intl
  setRequestLocale(locale);

  // Get translations for title and description
  const t = await getTranslations({ locale, namespace: 'conversions' });

  // Build API URL with initial filters
  const queryParams = new URLSearchParams();
  if (status) queryParams.set('status', status);
  if (conversion_type) queryParams.set('conversion_type', conversion_type);
  if (search) queryParams.set('search', search);
  if (page) queryParams.set('page', page);

  const initialApiUrl = `/api/affiliate/conversions?${queryParams.toString()}`;

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-stitch-primary">{t('title')}</h1>
          <p className="mt-1 text-sm text-stitch-muted">{t('subtitle')}</p>
        </div>

        {/* Conversions Table with Filters */}
        <Suspense fallback={
          <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-8 text-center">
            <div className="animate-pulse space-y-4">
              <div className="h-4 bg-stitch-well rounded w-1/4 mx-auto"></div>
              <div className="h-32 bg-stitch-well rounded-xl"></div>
              <div className="h-32 bg-stitch-well rounded-xl"></div>
            </div>
          </div>
        }>
          <ConversionsClient initialApiUrl={initialApiUrl} />
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
