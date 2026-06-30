'use client';

import { useState, useCallback, useTransition, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Table, { Column } from '@/components/Table/DataTable';

type Conversion = {
  id: string;
  deal_id: string;
  deal_name: string;
  affiliate_code: string | null;
  customer_id: string | null;
  order_id: string | null;
  revenue: number;
  currency: string;
  commission_amount: number;
  commission_type: string;
  conversion_type: string;
  status: string;
  converted_at: string;
  approved_at: string | null;
  rejected_at: string | null;
  refunded_at: string | null;
  notes: string | null;
  level: number;
};

interface ConversionsClientProps {
  initialApiUrl: string;
}

const STATUS_OPTIONS = [
  { value: '', labelKey: 'filters.allStatus' },
  { value: 'pending', labelKey: 'status.pending' },
  { value: 'approved', labelKey: 'status.approved' },
  { value: 'rejected', labelKey: 'status.rejected' },
  { value: 'refunded', labelKey: 'status.refunded' },
];

const TYPE_OPTIONS = [
  { value: '', labelKey: 'filters.allTypes' },
  { value: 'sale', labelKey: 'types.sale' },
  { value: 'lead', labelKey: 'types.lead' },
  { value: 'signup', labelKey: 'types.signup' },
  { value: 'install', labelKey: 'types.install' },
];

export default function ConversionsClient({ initialApiUrl }: ConversionsClientProps) {
  const t = useTranslations('conversions');
  const [isPending, startTransition] = useTransition();
  const [conversions, setConversions] = useState<Conversion[]>([]);
  const [stats, setStats] = useState<{ total_conversions: number; total_earnings: number; total_revenue: number; avg_order_value: number }>(
    { total_conversions: 0, total_earnings: 0, total_revenue: 0, avg_order_value: 0 }
  );
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [limit, setLimit] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<{ status?: string; conversion_type?: string; search?: string }>({});
  const [sort, setSort] = useState<{ sortBy: string; sortOrder: 'asc' | 'desc' }>({
    sortBy: 'converted_at',
    sortOrder: 'desc',
  });

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const fetchConversions = useCallback(async (page: number, currentFilters: Record<string, string>, currentSort: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      ...currentFilters,
      sortBy: currentSort.sortBy,
      sortOrder: currentSort.sortOrder,
    });

    try {
      const response = await fetch(`/api/affiliate/conversions?${params.toString()}`, {
        next: { revalidate: 30 },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch conversions');
      }

      const data: { data: Conversion[]; total: number; page: number; limit: number; totalPages: number; stats: typeof stats } = await response.json();
      setConversions(data.data);
      setTotal(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.totalPages);
      setStats(data.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load conversions');
    }
  }, [limit]);

  useEffect(() => {
    const status = searchParams.get('status');
    const type = searchParams.get('conversion_type');
    const search = searchParams.get('search');
    const sortBy = searchParams.get('sortBy') || 'converted_at';
    const sortOrder = (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc';
    const page = parseInt(searchParams.get('page') || '1');

    const newFilters: Record<string, string> = {};
    if (status) newFilters.status = status;
    if (type) newFilters.conversion_type = type;
    if (search) newFilters.search = search;

    setFilters({
      status: status ?? undefined,
      conversion_type: type ?? undefined,
      search: search ?? undefined,
    });
    setSort({ sortBy, sortOrder });
    setLimit(parseInt(searchParams.get('limit') || '20'));
    fetchConversions(page, newFilters, { sortBy, sortOrder });
  }, [searchParams, fetchConversions]);

  const handleFilterChange = (newFilters: Record<string, string>) => {
    const params = new URLSearchParams();
    Object.entries(newFilters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });
    params.set('sortBy', sort.sortBy);
    params.set('sortOrder', sort.sortOrder);

    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  };

  const handleSearch = (search: string) => {
    const currentStatus = filters.status || '';
    const currentType = filters.conversion_type || '';
    handleFilterChange({ status: currentStatus, conversion_type: currentType, search });
  };

  const handleStatusChange = (status: string) => {
    const currentType = filters.conversion_type || '';
    const currentSearch = filters.search || '';
    handleFilterChange({ status, conversion_type: currentType, search: currentSearch });
  };

  const handleTypeChange = (type: string) => {
    const currentStatus = filters.status || '';
    const currentSearch = filters.search || '';
    handleFilterChange({ status: currentStatus, conversion_type: type, search: currentSearch });
  };

  const handlePageChange = useCallback((page: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('page', page.toString());
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const handleLimitChange = useCallback((newLimit: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('limit', newLimit.toString());
    params.set('page', '1');
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const handleSortChange = useCallback((sortBy: string, sortOrder: 'asc' | 'desc') => {
    const params = new URLSearchParams(searchParams);
    params.set('sortBy', sortBy);
    params.set('sortOrder', sortOrder);
    params.set('page', '1');
    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  }, [searchParams, router, pathname]);

  const clearFilters = () => {
    router.push(pathname);
  };

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getStatusBadgeClass = (status: string) => {
    switch (status) {
      case 'approved':
        return 'bg-green-100 text-green-800';
      case 'pending':
        return 'bg-yellow-100 text-yellow-800';
      case 'rejected':
        return 'bg-red-100 text-red-800';
      case 'refunded':
        return 'bg-gray-100 text-gray-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getTypeBadgeClass = (type: string) => {
    switch (type) {
      case 'sale':
        return 'bg-blue-100 text-blue-800';
      case 'lead':
        return 'bg-purple-100 text-purple-800';
      case 'signup':
        return 'bg-indigo-100 text-indigo-800';
      case 'install':
        return 'bg-orange-100 text-orange-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const getLevelBadgeClass = (level: number) => {
    switch (level) {
      case 1:
        return 'bg-green-100 text-green-800';
      case 2:
        return 'bg-blue-100 text-blue-800';
      case 3:
        return 'bg-purple-100 text-purple-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  const activeFilterCount = (filters.status ? 1 : 0) + (filters.conversion_type ? 1 : 0) + (filters.search ? 1 : 0);

  const columns: Column<Conversion>[] = [
    {
      key: 'converted_at',
      label: t('columns.date'),
      sortable: true,
      width: '160px',
      render: (_, row) => formatDate(row.converted_at),
    },
    {
      key: 'deal_name',
      label: t('columns.deal'),
      sortable: true,
      render: (_, row) => (
        <div className="font-medium text-gray-900">{row.deal_name}</div>
      ),
    },
    {
      key: 'order_id',
      label: t('columns.orderId'),
      sortable: true,
      width: '140px',
      render: (value) => <span className="font-mono text-sm">{value as string || '-'}</span>,
    },
    {
      key: 'revenue',
      label: t('columns.revenue'),
      sortable: true,
      width: '120px',
      render: (value, row) => (
        <span className="text-gray-900">{formatCurrency(value as number, row.currency)}</span>
      ),
    },
    {
      key: 'commission_amount',
      label: t('columns.commission'),
      sortable: true,
      width: '120px',
      render: (value, row) => (
        <span className="font-semibold text-green-600">{formatCurrency(value as number, row.currency)}</span>
      ),
    },
    {
      key: 'level',
      label: t('columns.level'),
      sortable: true,
      width: '80px',
      render: (value) => (
        <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getLevelBadgeClass(value as number)}`}>
          {value as number}
        </span>
      ),
    },
    {
      key: 'conversion_type',
      label: t('columns.type'),
      sortable: true,
      width: '100px',
      render: (value) => (
        <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getTypeBadgeClass(value as string)}`}>
          {t(`types.${value}`)}
        </span>
      ),
    },
    {
      key: 'status',
      label: t('columns.status'),
      sortable: true,
      width: '120px',
      render: (value) => (
        <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeClass(value as string)}`}>
          {t(`status.${value}`)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">{t('stats.totalConversions')}</p>
              <p className="text-2xl font-bold text-gray-900">{stats.total_conversions}</p>
            </div>
            <div className="p-3 bg-blue-100 rounded-full">
              <svg className="w-6 h-6 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7h8m0 0v8m0-8l-8 8-4-4-6 6" />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">{t('stats.totalEarnings')}</p>
              <p className="text-2xl font-bold text-green-600">
                {formatCurrency(stats.total_earnings, 'USD')}
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
              <p className="text-sm text-gray-600">{t('stats.totalRevenue')}</p>
              <p className="text-2xl font-bold text-gray-900">
                {formatCurrency(stats.total_revenue, 'USD')}
              </p>
            </div>
            <div className="p-3 bg-purple-100 rounded-full">
              <svg className="w-6 h-6 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 11V7a4 4 0 00-8 0v4M5 9h14l1 12H4L5 9z" />
              </svg>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-lg shadow p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-600">{t('stats.avgOrderValue')}</p>
              <p className="text-2xl font-bold text-gray-900">
                {formatCurrency(stats.avg_order_value, 'USD')}
              </p>
            </div>
            <div className="p-3 bg-orange-100 rounded-full">
              <svg className="w-6 h-6 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
              </svg>
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-white rounded-lg shadow p-6">
        <div className="flex flex-col lg:flex-row gap-4">
          {/* Search */}
          <div className="flex-1 relative">
            <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="text"
              placeholder={t('filters.searchPlaceholder')}
              defaultValue={filters.search || ''}
              onChange={(e) => handleSearch(e.target.value)}
              className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            />
          </div>

          {/* Status Filter */}
          <div className="lg:w-48">
            <select
              value={filters.status || ''}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>

          {/* Type Filter */}
          <div className="lg:w-48">
            <select
              value={filters.conversion_type || ''}
              onChange={(e) => handleTypeChange(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
            >
              {TYPE_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>

          {/* Clear Filters */}
          {activeFilterCount > 0 && (
            <button
              onClick={clearFilters}
              className="px-4 py-2 text-gray-600 hover:text-gray-900 border border-gray-300 rounded-lg hover:bg-gray-50"
            >
              {t('filters.clear')}
            </button>
          )}
        </div>
      </div>

      {/* Conversions Table */}
      <Table
        data={conversions}
        columns={columns}
        total={total}
        page={currentPage}
        totalPages={totalPages}
        limit={limit}
        defaultSortBy={sort.sortBy}
        defaultSortOrder={sort.sortOrder}
        onPageChange={handlePageChange}
        onLimitChange={handleLimitChange}
        onSortChange={handleSortChange}
        exportFileName="conversions"
        isLoading={isPending}
        emptyMessage={error ? error : t('empty.title')}
      />
    </div>
  );
}
