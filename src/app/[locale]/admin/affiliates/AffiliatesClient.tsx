'use client';

import { useState, useCallback, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Table, { Column } from '@/components/Table/DataTable';
import type { TopAffiliate } from '@/app/api/admin/affiliates/route';

interface AffiliatesClientProps {
  initialAffiliates: TopAffiliate[];
  total: number;
  totalPages: number;
  currentPage: number;
  limit: number;
  initialSort: { sortBy: string; sortOrder: 'asc' | 'desc' };
  timeRange: string;
}

const TIME_RANGE_OPTIONS = [
  { value: 'all', labelKey: 'timeRange.all' },
  { value: '7d', labelKey: 'timeRange.7d' },
  { value: '30d', labelKey: 'timeRange.30d' },
  { value: '90d', labelKey: 'timeRange.90d' },
];

export default function AffiliatesClient({
  initialAffiliates,
  total,
  totalPages,
  currentPage,
  limit,
  initialSort,
  timeRange,
}: AffiliatesClientProps) {
  const t = useTranslations('admin.affiliates');
  const [isPending, startTransition] = useTransition();
  const [affiliates] = useState<TopAffiliate[]>(initialAffiliates);
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const handlePageChange = useCallback((newPage: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', newPage.toString());
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const handleLimitChange = useCallback((newLimit: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('limit', newLimit.toString());
    params.set('page', '1'); // Reset to first page
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const handleSortChange = useCallback((sortBy: string, sortOrder: 'asc' | 'desc') => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('sortBy', sortBy);
    params.set('sortOrder', sortOrder);
    params.set('page', '1'); // Reset to first page on sort
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const handleTimeRangeChange = useCallback((newTimeRange: string) => {
    const params = new URLSearchParams(searchParams);
    if (newTimeRange === 'all') {
      params.delete('timeRange');
    } else {
      params.set('timeRange', newTimeRange);
    }
    params.set('page', '1'); // Reset to first page
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(amount);
  };

  const formatPercent = (value: number) => {
    return `${(value * 100).toFixed(2)}%`;
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const columns: Column<TopAffiliate>[] = [
    {
      key: 'email',
      label: t('columns.email'),
      sortable: true,
      render: (value, row) => (
        <div>
          <div className="font-medium text-gray-900">{row.full_name || '-'}</div>
          <div className="text-sm text-gray-500">{value as string}</div>
        </div>
      ),
    },
    {
      key: 'referral_code',
      label: t('columns.referralCode'),
      sortable: true,
      width: '120px',
      render: (value) => (
        <span className="font-mono text-sm bg-gray-100 px-2 py-1 rounded">
          {value as string}
        </span>
      ),
    },
    {
      key: 'lifetime_earnings',
      label: t('columns.lifetimeEarnings'),
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className="font-semibold text-green-600">
          {formatCurrency(value as number)}
        </span>
      ),
    },
    {
      key: 'pending_earnings',
      label: t('columns.pendingEarnings'),
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className="font-medium text-yellow-600">
          {formatCurrency(value as number)}
        </span>
      ),
    },
    {
      key: 'total_conversions',
      label: t('columns.totalConversions'),
      sortable: true,
      width: '100px',
      render: (value) => <span className="text-gray-900">{value as number}</span>,
    },
    {
      key: 'conversion_rate',
      label: t('columns.conversionRate'),
      sortable: true,
      width: '120px',
      render: (value) => (
        <span className={`font-medium ${(value as number) >= 0.1 ? 'text-green-600' : (value as number) >= 0.05 ? 'text-yellow-600' : 'text-red-600'}`}>
          {formatPercent(value as number)}
        </span>
      ),
    },
    {
      key: 'total_referrals',
      label: t('columns.totalReferrals'),
      sortable: true,
      width: '120px',
      render: (value) => <span className="text-gray-900">{value as number}</span>,
    },
    {
      key: 'total_revenue',
      label: t('columns.totalRevenue'),
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className="text-gray-900">{formatCurrency(value as number)}</span>
      ),
    },
    {
      key: 'created_at',
      label: t('columns.joined'),
      sortable: true,
      width: '120px',
      render: (value) => <span className="text-gray-500">{formatDate(value as string)}</span>,
    },
  ];

  // Calculate stats for summary cards
  const totalLifetimeEarnings = affiliates.reduce((sum, a) => sum + a.lifetime_earnings, 0);
  const totalPendingEarnings = affiliates.reduce((sum, a) => sum + a.pending_earnings, 0);
  const avgConversionRate = affiliates.length > 0
    ? affiliates.reduce((sum, a) => sum + a.conversion_rate, 0) / affiliates.length
    : 0;

  return (
    <div className="space-y-6">
      {/* Time Range Filter */}
      <div className="bg-white rounded-lg shadow p-4">
        <div className="flex flex-col sm:flex-row gap-4 items-start sm:items-center justify-between">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('filters.timeRange')}
            </label>
            <div className="flex gap-2">
              {TIME_RANGE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  onClick={() => handleTimeRangeChange(option.value)}
                  className={`px-3 py-2 rounded-lg text-sm font-medium transition-colors ${
                    timeRange === option.value
                      ? 'bg-indigo-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {t(option.labelKey)}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">{t('stats.totalEarnings')}</p>
              <p className="text-2xl font-bold text-green-600">
                {formatCurrency(totalLifetimeEarnings)}
              </p>
            </div>
            <div className="p-3 bg-green-100 rounded-full">
              <svg className="w-6 h-6 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">{t('stats.pendingEarnings')}</p>
              <p className="text-2xl font-bold text-yellow-600">
                {formatCurrency(totalPendingEarnings)}
              </p>
            </div>
            <div className="p-3 bg-yellow-100 rounded-full">
              <svg className="w-6 h-6 text-yellow-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">{t('stats.avgConversionRate')}</p>
              <p className="text-2xl font-bold text-blue-600">
                {formatPercent(avgConversionRate)}
              </p>
            </div>
            <div className="p-3 bg-blue-100 rounded-full">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Data Table */}
      <Table
        data={affiliates}
        columns={columns}
        total={total}
        page={currentPage}
        totalPages={totalPages}
        limit={limit}
        defaultSortBy={initialSort.sortBy}
        defaultSortOrder={initialSort.sortOrder}
        searchable={false}
        onPageChange={handlePageChange}
        onLimitChange={handleLimitChange}
        onSortChange={handleSortChange}
        exportFileName="top-affiliates"
        isLoading={isPending}
        emptyMessage={t('empty.title')}
      />
    </div>
  );
}
