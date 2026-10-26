import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { StitchObsidianBanner } from '@/components/stitch/StitchObsidianBanner';
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
        <StitchObsidianBanner
          locale={locale}
          targetTab="cockpit"
          screenLabel="Screen 1 · Cashback & 3-Tier Affiliate Cockpit"
        />

        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-stitch-primary">
            {await getTranslations({ locale, namespace: 'dashboard' }).then(t => t('title'))}
          </h1>
          <p className="mt-1 text-sm text-stitch-muted">
            {await getTranslations({ locale, namespace: 'dashboard' }).then(t => t('subtitle'))}
          </p>
        </div>

        {/* Dashboard Overview */}
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
          <DashboardOverview locale={locale} />
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
