/**
 * Admin Payout Health Dashboard
 * Server component with admin authentication
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import HealthDashboardClient from './health-dashboard-client';
import { requireAdmin } from '@/lib/admin-auth';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  return {
    title: messages?.admin?.health?.title || 'Payout Health Dashboard — ApexOS',
    description: 'Monitor payout health, conversions, commissions, and failures',
  };
}

export default async function AdminHealthPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Verify admin role
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/health`);
  }

  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {messages?.admin?.health?.title || 'Payout Health Dashboard'}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {messages?.admin?.health?.subtitle || 'Monitor conversions, commissions, payouts, and system health in real-time'}
            </p>
          </div>

          {/* Dashboard Content */}
          <HealthDashboardClient locale={locale} />
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
