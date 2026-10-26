import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import AffiliatesClient from './affiliates-client';
import { error as logError } from '@/lib/logger';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string>>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'affiliates' });

  return {
    title: `${t('title')} — ApexOS`,
    description: t('subtitle'),
  };
}

export default async function AffiliatesPage({ params }: Props) {
  const { locale } = await params;

  // Set locale for next-intl
  setRequestLocale(locale);

  // Get translations for loading state
  const t = await getTranslations({ locale, namespace: 'affiliates' });

  // Fetch initial dashboard data on the server
  let initialData;
  try {
    // Use internal fetch to get dashboard data
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const response = await fetch(`${baseUrl}/api/affiliate/dashboard`, {
      headers: {
        'Content-Type': 'application/json',
      },
      // Cache for 30 seconds
      next: { revalidate: 30 },
    });

    if (!response.ok) {
      if (response.status === 401) {
        initialData = null;
      } else {
        throw new Error('Failed to fetch affiliate data');
      }
    } else {
      initialData = await response.json();
    }
  } catch (error) {
    logError('Error fetching affiliate dashboard', { error: error instanceof Error ? error.message : String(error) });
    initialData = null;
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-stitch-primary">{t('title')}</h1>
          <p className="mt-1 text-sm text-stitch-muted">{t('subtitle')}</p>
        </div>

        {/* Affiliate Dashboard */}
        <Suspense fallback={
          <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-8 text-center">
            <div className="animate-pulse space-y-4">
              <div className="h-8 bg-stitch-well rounded w-1/4 mx-auto"></div>
              <div className="h-4 bg-stitch-well rounded w-1/2 mx-auto"></div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="h-32 bg-stitch-well rounded-xl"></div>
                ))}
              </div>
            </div>
          </div>
        }>
          {initialData ? (
            <AffiliatesClient initialData={initialData} />
          ) : (
            <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-12 text-center">
              <h2 className="text-2xl font-bold text-stitch-primary mb-2">Access Denied</h2>
              <p className="text-stitch-muted">Please log in to view your affiliate dashboard.</p>
            </div>
          )}
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
