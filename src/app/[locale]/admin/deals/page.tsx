/**
 * Admin Deals Management Page
 * Server component with role-based access control
 */

import { redirect } from 'next/navigation'
import { NextIntlClientProvider } from 'next-intl'
import { getMessages } from 'next-intl/server'
import DealListClient from './DealListClient'
import { requireAdmin } from './actions'

export async function generateMetadata({
  params,
}: {
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  const messages = await getMessages({ locale })

  return {
    title: messages?.admin?.deals?.title || 'Admin - Deals Management',
  }
}

export default async function AdminDealsPage({
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
    redirect(`/${locale}/login?redirect=/${locale}/admin/deals`)
  }

  // Parse query parameters
  const page = parseInt((paramsObj.page as string) || '1')
  const limit = Math.min(parseInt((paramsObj.limit as string) || '20'), 100)
  const status = paramsObj.status as string | undefined
  const exchange = paramsObj.exchange as string | undefined
  const symbol = paramsObj.symbol as string | undefined

  // Fetch initial deals data using server action
  const { getAllDeals } = await import('./actions')
  const { data: deals, total, totalPages } = await getAllDeals(
    page,
    limit,
    status as 'active' | 'closed' | 'cancelled' | undefined,
    symbol,
    undefined // userId filter not for admin UI
  )

  const messages = await getMessages({ locale })

  return (
    <NextIntlClientProvider locale={locale} messages={messages}>
      <div className="min-h-screen bg-gray-50">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
          {/* Header */}
          <div className="mb-8">
            <h1 className="text-3xl font-bold text-gray-900">
              {messages?.admin?.deals?.title || 'Deals Management'}
            </h1>
            <p className="mt-2 text-sm text-gray-600">
              {messages?.admin?.deals?.subtitle || 'Create, edit, and manage trading deals'}
            </p>
          </div>

          {/* Filters and Actions */}
          <DealListClient
            initialDeals={deals || []}
            total={total}
            totalPages={totalPages}
            currentPage={page}
            limit={limit}
            initialFilters={{
              status,
              exchange,
            }}
          />
        </div>
      </div>
    </NextIntlClientProvider>
  )
}
