import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import AffiliatesClient from './affiliates-client';

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
    console.error('Error fetching affiliate dashboard:', error);
    initialData = null;
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t('title')}</h1>
          <p className="mt-1 text-sm text-gray-600">{t('subtitle')}</p>
        </div>

        {/* Affiliate Dashboard */}
        <Suspense fallback={
          <div className="bg-white rounded-lg shadow p-8 text-center">
            <div className="animate-pulse space-y-4">
              <div className="h-8 bg-gray-200 rounded w-1/4 mx-auto"></div>
              <div className="h-4 bg-gray-200 rounded w-1/2 mx-auto"></div>
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
                {[1, 2, 3, 4].map(i => (
                  <div key={i} className="h-32 bg-gray-200 rounded"></div>
                ))}
              </div>
            </div>
          </div>
        }>
          {initialData ? (
            <AffiliatesClient initialData={initialData} />
          ) : (
            <div className="bg-white rounded-lg shadow p-12 text-center">
              <h2 className="text-2xl font-bold text-gray-900 mb-2">Access Denied</h2>
              <p className="text-gray-500">Please log in to view your affiliate dashboard.</p>
            </div>
          )}
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
