/**
 * Admin Notifications Settings Page
 * Server component with admin authentication
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import NotificationsClient from './NotificationsClient';
import { requireAdmin } from '@/lib/admin-auth';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  return {
    title: messages?.admin?.settings?.notifications?.title || 'Notification Settings — ApexOS',
    description: 'Configure Slack, email, and Telegram notification channels',
  };
}

export default async function AdminNotificationsPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  // Verify admin role
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/settings/notifications`);
  }

  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {messages?.admin?.settings?.notifications?.title || 'Notification Settings'}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {messages?.admin?.settings?.notifications?.subtitle || 'Configure Slack, email, and Telegram channels for system notifications'}
            </p>
          </div>

          {/* Notifications Configuration */}
          <NotificationsClient />
        </div>
      </div>
    </NextIntlClientProvider>
  );
}
