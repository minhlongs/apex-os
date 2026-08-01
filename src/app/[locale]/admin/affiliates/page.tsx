/**
 * Admin Top Affiliates Page
 * Server component with role-based access control
 */

import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import AffiliatesClient from './AffiliatesClient'
import ExportUnpaidButton from '@/components/admin/ExportUnpaidButton'
import { getTopAffiliates } from './actions'
import { requireAdmin } from '@/lib/admin-auth'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  const messages = await getMessages({ locale })

  return {
    title: messages?.admin?.affiliates?.title || 'Admin - Top Affiliates',
  }
}

export default async function AdminAffiliatesPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>
}) {
  const { locale } = await params
  const paramsObj = await searchParams

  // Verify admin role
  const admin = await requireAdmin()
  if (!admin) {
    redirect(`/${locale}/login?redirect=/${locale}/admin/affiliates`)
  }

  // Parse query parameters
  const page = parseInt((paramsObj.page as string) || '1')
  const limit = Math.min(parseInt((paramsObj.limit as string) || '20'), 100)
  const sortBy = paramsObj.sortBy as string || 'lifetime_earnings'
  const sortOrder = (paramsObj.sortOrder as 'asc' | 'desc') || 'desc'
  const timeRange = paramsObj.timeRange as string || 'all'

  // Fetch top affiliates data
  const { affiliates, total, totalPages } = await getTopAffiliates(
    page,
    limit,
    sortBy,
    sortOrder,
    timeRange
  )

  const messages = await getMessages({ locale })

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
              <div>
                <h1 className="text-3xl font-bold text-gray-900">
                  {messages?.admin?.affiliates?.title || 'Top Affiliates'}
                </h1>
                <p className="mt-2 text-sm text-gray-600">
                  {messages?.admin?.affiliates?.subtitle || 'View and manage top performing affiliates'}
                </p>
              </div>
              <ExportUnpaidButton />
            </div>
          </div>

          {/* Affiliates Table */}
          <AffiliatesClient
            initialAffiliates={affiliates}
            total={total}
            totalPages={totalPages}
            currentPage={page}
            limit={limit}
            initialSort={{ sortBy, sortOrder }}
            timeRange={timeRange}
          />
        </div>
      </div>
    </NextIntlClientProvider>
  )
}
