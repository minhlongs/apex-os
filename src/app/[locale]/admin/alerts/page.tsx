/**
 * Admin Alerts Dashboard Page
 * Server component with admin authentication
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import AlertsClient from './AlertsClient';
import { fetchAlerts } from './actions';
import { requireAdmin } from '@/lib/admin-auth';
import type { AlertStatus, AlertSeverity } from './actions';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  return {
    title: messages?.admin?.alerts?.title || 'Alert Dashboard — ApexOS',
    description: 'Monitor and manage system alerts, notifications, and health indicators',
  };
}

export default async function AdminAlertsPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { locale } = await params;
  const paramsObj = await searchParams;

  // Verify admin role
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/alerts`);
  }

  // Parse query parameters
  const page = parseInt((paramsObj.page as string) || '1');
  const limit = Math.min(parseInt((paramsObj.limit as string) || '25'), 100);
  const status = paramsObj.status as string || 'active';
  const severity = paramsObj.severity as string || 'all';
  const type = paramsObj.type as string || 'all';
  const isRead = paramsObj.isRead === 'true' ? true : paramsObj.isRead === 'false' ? false : undefined;
  const isSilenced = paramsObj.isSilenced === 'true' ? true : paramsObj.isSilenced === 'false' ? false : undefined;
  const sortBy = paramsObj.sortBy as string || 'triggeredAt';
  const sortOrder = (paramsObj.sortOrder as 'asc' | 'desc') || 'desc';
  const search = paramsObj.search as string || '';

  // Fetch alerts data
  const { alerts, total, totalPages, summary } = await fetchAlerts({
    page,
    limit,
    status: status as AlertStatus | 'all',
    severity: severity as AlertSeverity | 'all',
    type,
    isRead,
    isSilenced,
    sortBy,
    sortOrder,
    search,
  });

  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {messages?.admin?.alerts?.title || 'Alert Dashboard'}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {messages?.admin?.alerts?.subtitle || 'Monitor and manage system alerts, notifications, and health indicators'}
            </p>
          </div>

          {/* Alerts Dashboard */}
          <AlertsClient
            initialAlerts={alerts}
            total={total}
            totalPages={totalPages}
            currentPage={page}
            limit={limit}
            initialFilters={{
              status: status as any,
              severity: severity as any,
              type: type === 'all' ? undefined : type,
              isRead,
              isSilenced,
            }}
            summary={summary}
          />
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
