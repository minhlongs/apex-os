/**
 * Admin API Key Management Page
 * Server component with admin authentication
 */

import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import ApiKeysClient from './ApiKeysClient'
import { getUserKeys } from './actions'
import { requireAdmin } from '@/lib/admin-auth'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params
  const messages = await getMessages({ locale })

  return {
    title: messages?.admin?.apiKeys?.title || 'API Key Management — ApexOS',
    description: 'Manage BYOK API keys for external services',
  }
}

export default async function AdminApiKeysPage({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  // Verify admin role
  const admin = await requireAdmin()
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/settings/api-keys`)
  }

  // Fetch initial API keys data
  const keys = await getUserKeys()

  const messages = await getMessages({ locale })

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {messages?.admin?.apiKeys?.title || 'API Key Management'}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {messages?.admin?.apiKeys?.subtitle || 'Quản lý API keys cho các dịch vụ bên ngoài (Binance, Bybit, Resend)'}
            </p>
          </div>

          {/* API Keys Management */}
          <ApiKeysClient initialKeys={keys} />
        </div>
      </div>
    </NextIntlClientProvider>
  )
}
