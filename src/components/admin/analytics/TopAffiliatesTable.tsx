'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Table, { Column } from '@/components/Table/DataTable';
import { DollarSign, Users, TrendingUp } from 'lucide-react';

export interface AdminAffiliate extends Record<string, unknown> {
  id: string;
  email: string;
  full_name: string | null;
  referral_code: string;
  lifetime_earnings: number;
  lifetime_payouts: number;
  pending_earnings: number;
  total_conversions: number;
  total_clicks: number;
  conversion_rate: number;
  total_referrals: number;
  total_revenue: number;
  created_at: string;
}

interface AdminAffiliatesResponse {
  affiliates: AdminAffiliate[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}

interface TopAffiliatesTableProps {
  initialPage?: number;
}

export default function TopAffiliatesTable({ initialPage = 1 }: TopAffiliatesTableProps) {
  const t = useTranslations('admin.affiliates');
  const [affiliates, setAffiliates] = useState<AdminAffiliate[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(1);
  const [limit, setLimit] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const fetchAffiliates = useCallback(async (page: number, currentSort: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
    setIsLoading(true);
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      sortBy: currentSort.sortBy,
      sortOrder: currentSort.sortOrder,
    });

    try {
      const response = await fetch(`/api/admin/affiliates?${params.toString()}`, {
        next: { revalidate: 30 },
      });

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new Error('Admin access required');
        }
        throw new Error('Failed to fetch affiliates');
      }

      const data: AdminAffiliatesResponse = await response.json();
      setAffiliates(data.affiliates);
      setTotal(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.totalPages);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load affiliates');
    } finally {
      setIsLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    const page = parseInt(searchParams.get('affiliates_page') || searchParams.get('page') || initialPage.toString());
    const limitParam = parseInt(searchParams.get('limit') || '20');
    const sortBy = searchParams.get('affiliates_sortBy') || searchParams.get('sortBy') || 'lifetime_earnings';
    const sortOrder = (searchParams.get('affiliates_sortOrder') || searchParams.get('sortOrder') || 'desc') as 'asc' | 'desc';

    setLimit(limitParam);
    fetchAffiliates(page, { sortBy, sortOrder });
  }, [searchParams, fetchAffiliates, initialPage]);

  const handlePageChange = useCallback((page: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('affiliates_page', page.toString());
    router.push(`${pathname}?${params.toString()}`);
  }, [searchParams, router, pathname]);

  const handleLimitChange = useCallback((newLimit: number) => {
    const params = new URLSearchParams(searchParams);
    params.set('limit', newLimit.toString());
    params.set('affiliates_page', '1');
    router.push(`${pathname}?${params.toString()}`);
  }, [searchParams, router, pathname]);

  const handleSortChange = useCallback((sortBy: string, sortOrder: 'asc' | 'desc') => {
    const params = new URLSearchParams(searchParams);
    params.set('affiliates_sortBy', sortBy);
    params.set('affiliates_sortOrder', sortOrder);
    params.set('affiliates_page', '1');
    router.push(`${pathname}?${params.toString()}`);
  }, [searchParams, router, pathname]);

  const formatCurrency = (amount: number) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(amount);
  };

  const formatPercent = (value: number) => {
    return `${(value * 100).toFixed(1)}%`;
  };

  const formatNumber = (num: number) => {
    return num.toLocaleString();
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  };

  const getLevelBadgeClass = (referrals: number) => {
    if (referrals >= 50) return 'bg-purple-100 text-purple-800';
    if (referrals >= 20) return 'bg-blue-100 text-blue-800';
    if (referrals >= 10) return 'bg-green-100 text-green-800';
    return 'bg-gray-100 text-gray-800';
  };

  const getLevelLabel = (referrals: number) => {
    if (referrals >= 50) return 'Top Tier';
    if (referrals >= 20) return 'High';
    if (referrals >= 10) return 'Medium';
    return 'Growing';
  };

  const columns: Column<AdminAffiliate>[] = [
    {
      key: 'full_name',
      label: t('columns.affiliate'),
      sortable: true,
      width: '200px',
      render: (_, row) => (
        <div>
          <div className="font-medium text-gray-900">{row.full_name || 'N/A'}</div>
          <div className="text-xs text-gray-500 truncate max-w-[180px]" title={row.email}>
            {row.email}
          </div>
        </div>
      ),
    },
    {
      key: 'referral_code',
      label: t('columns.code'),
      sortable: true,
      width: '120px',
      render: (value) => (
        <code className="px-2 py-1 bg-gray-100 rounded text-xs font-mono text-gray-800">
          {value as string}
        </code>
      ),
    },
    {
      key: 'total_referrals',
      label: t('columns.referrals'),
      sortable: true,
      width: '100px',
      render: (value) => (
        <span className={`inline-flex items-center justify-center px-2 py-0.5 rounded-full text-xs font-medium ${getLevelBadgeClass(value as number)}`}>
          {getLevelLabel(value as number)}
        </span>
      ),
    },
    {
      key: 'total_conversions',
      label: t('columns.conversions'),
      sortable: true,
      width: '120px',
      render: (value) => formatNumber(value as number),
    },
    {
      key: 'total_clicks',
      label: t('columns.clicks'),
      sortable: true,
      width: '100px',
      render: (value) => formatNumber(value as number),
    },
    {
      key: 'conversion_rate',
      label: t('columns.conversionRate'),
      sortable: true,
      width: '120px',
      render: (value) => formatPercent(value as number),
    },
    {
      key: 'total_revenue',
      label: t('columns.revenue'),
      sortable: true,
      width: '140px',
      render: (value) => formatCurrency(value as number),
    },
    {
      key: 'lifetime_earnings',
      label: t('columns.earnings'),
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className="font-semibold text-green-600">{formatCurrency(value as number)}</span>
      ),
    },
    {
      key: 'pending_earnings',
      label: t('columns.pending'),
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className="font-medium text-yellow-600">{formatCurrency(value as number)}</span>
      ),
    },
    {
      key: 'created_at',
      label: t('columns.joined'),
      sortable: true,
      width: '120px',
      render: (value) => formatDate(value as string),
    },
  ];

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 rounded-lg">
            <Users className="w-5 h-5 text-indigo-600" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{t('title')}</h3>
            <p className="text-sm text-gray-500">{t('subtitle')}</p>
          </div>
        </div>
      </div>

      <Table
        data={affiliates}
        columns={columns}
        total={total}
        page={currentPage}
        totalPages={totalPages}
        limit={limit}
        defaultSortBy="lifetime_earnings"
        defaultSortOrder="desc"
        onPageChange={handlePageChange}
        onLimitChange={handleLimitChange}
        onSortChange={handleSortChange}
        exportFileName="affiliates"
        isLoading={isLoading}
        emptyMessage={error || t('empty.title')}
        searchable={false}
      />
    </div>
  );
}
