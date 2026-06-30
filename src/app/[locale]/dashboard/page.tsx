import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import DashboardOverview from './dashboard-overview';

type Props = {
  params: Promise<{ locale: string }>;
  searchParams: Promise<Record<string, string>>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'dashboard' });

  return {
    title: `${t('title')} — ApexOS`,
    description: t('subtitle'),
  };
}

export default async function DashboardPage({ params }: Props) {
  const { locale } = await params;

  // Set locale for next-intl
  setRequestLocale(locale);

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {await getTranslations({ locale, namespace: 'dashboard' }).then(t => t('title'))}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {await getTranslations({ locale, namespace: 'dashboard' }).then(t => t('subtitle'))}
          </p>
        </div>

        {/* Dashboard Overview */}
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
          <DashboardOverview locale={locale} />
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
