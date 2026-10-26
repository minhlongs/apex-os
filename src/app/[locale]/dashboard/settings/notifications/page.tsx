import { Suspense } from 'react';
import { getTranslations, setRequestLocale } from 'next-intl/server';
import { DashboardLayout } from '@/components/dashboard/dashboard-layout';
import { NotificationPreferencesClient } from './notifications-client';
import { error as logError } from '@/lib/logger';

type Props = {
  params: Promise<{ locale: string }>;
};

export async function generateMetadata({ params }: Props) {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: 'notifications' });

  return {
    title: `${t('pageTitle')} — ApexOS`,
    description: t('pageDescription'),
  };
}

export default async function NotificationsSettingsPage({ params }: Props) {
  const { locale } = await params;
  setRequestLocale(locale);

  const t = await getTranslations({ locale, namespace: 'notifications' });

  // Fetch initial notification settings
  let initialSettings: Record<string, unknown> | null = null;

  try {
    const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';
    const response = await fetch(`${baseUrl}/api/profile`, {
      headers: {
        'Content-Type': 'application/json',
      },
      next: { revalidate: 0 },
    });

    if (response.ok) {
      const data = await response.json();
      initialSettings = data.success ? data.profile.notificationSettings : null;
    }
  } catch (error) {
    logError('Error fetching notification settings', { error: error instanceof Error ? error.message : String(error) });
  }

  return (
    <DashboardLayout>
      <div className="space-y-6">
        {/* Page Header */}
        <div>
          <h1 className="text-2xl font-bold text-stitch-primary">{t('pageTitle')}</h1>
          <p className="mt-1 text-sm text-stitch-muted">{t('pageDescription')}</p>
        </div>

        {/* Notification Preferences */}
        <Suspense fallback={
          <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-8 text-center">
            <div className="animate-pulse space-y-4">
              <div className="h-8 bg-stitch-well rounded w-1/4 mx-auto"></div>
              <div className="h-4 bg-stitch-well rounded w-1/2 mx-auto"></div>
              <div className="space-y-4">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-20 bg-stitch-well rounded-xl"></div>
                ))}
              </div>
            </div>
          </div>
        }>
          {initialSettings ? (
            <NotificationPreferencesClient initialSettings={initialSettings} locale={locale} />
          ) : (
            <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-12 text-center">
              <h2 className="text-2xl font-bold text-stitch-primary mb-2">{t('notAuthenticated')}</h2>
              <p className="text-stitch-muted">{t('loginRequired')}</p>
            </div>
          )}
        </Suspense>
      </div>
    </DashboardLayout>
  );
}
