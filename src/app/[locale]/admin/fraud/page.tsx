/**
 * Admin Fraud Review Dashboard Page
 * Location: src/app/[locale]/admin/fraud/page.tsx
 * Server component guarded by requireAdmin() with NextIntl support.
 */

import { redirect } from 'next/navigation';
import { NextIntlClientProvider } from 'next-intl';
import { getMessages } from 'next-intl/server';
import { requireAdmin } from '@/lib/admin-auth';
import { FraudDashboard } from '@/components/admin/fraud';

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const messages = await getMessages({ locale });

  return {
    title: (messages as any)?.admin?.fraud?.title || 'Fraud Review Dashboard — ApexOS',
    description:
      (messages as any)?.admin?.fraud?.subtitle ||
      'Inspect flagged suspicious clicks, evaluate anomaly velocity, and mitigate affiliate fraud.',
  };
}

export default async function AdminFraudPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const { locale } = await params;
  await searchParams; // Await searchParams per Next.js 15 App Router requirements

  // Guard: require admin authentication
  const admin = await requireAdmin();
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/fraud`);
  }

  // Fetch localization messages
  const messages = await getMessages({ locale });

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <FraudDashboard locale={locale} />
    </NextIntlClientProvider>
  );
}
