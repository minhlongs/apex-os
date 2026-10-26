import { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';
import DashboardLayout from '@/components/dashboard/dashboard-layout';
import ExchangeKeysManager from '@/components/profile/ExchangeKeysManager';

interface PageProps {
  params: Promise<{ locale: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale } = await params;
  const isVi = locale === 'vi';
  return {
    title: isVi ? 'Hồ sơ & Khóa API Sàn | ApexOS' : 'Profile & Exchange API Keys | ApexOS',
    description: isVi
      ? 'Quản lý khóa API sàn giao dịch (OKX, KuCoin, Binance, Bybit) để tự động nhận hoàn phí và hoa hồng 3 tầng.'
      : 'Manage your exchange API keys (OKX, KuCoin, Binance, Bybit) for automatic trade cashback and 3-tier attribution.',
  };
}

export default async function ProfileDashboardPage({ params }: PageProps) {
  const { locale } = await params;
  const isVi = locale === 'vi';

  return (
    <DashboardLayout>
      <div className="space-y-6">
        <div className="rounded-xl border border-stitch-border bg-stitch-surface p-6">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <span className="inline-flex items-center gap-1.5 rounded-full border border-stitch-indigo/30 bg-stitch-indigo/10 px-3 py-1 font-mono text-xs font-semibold text-stitch-indigo">
                OBSIDIAN SELF-SERVICE ATTRIBUTION
              </span>
              <h1 className="mt-2 text-2xl font-bold text-stitch-primary">
                {isVi ? 'Hồ sơ & Liên kết Khóa Sàn' : 'Profile & Exchange Key Linking'}
              </h1>
              <p className="mt-1 text-sm text-stitch-muted">
                {isVi
                  ? 'Kết nối API Key ID công khai của bạn để hệ thống tự động đối khớp lệnh giao dịch và cộng hoàn phí (30% / 10% / 5%).'
                  : 'Bind your public exchange API Key ID so trade webhooks automatically credit your multi-tier cashback (30% / 10% / 5%).'}
              </p>
            </div>
          </div>
        </div>

        <ExchangeKeysManager locale={locale} />
      </div>
    </DashboardLayout>
  );
}
