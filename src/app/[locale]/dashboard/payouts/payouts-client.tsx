'use client';

import { useState, useEffect, useCallback, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import Table, { Column } from '@/components/Table/DataTable';
import { DollarSign, TrendingUp, Wallet, FileText } from 'lucide-react';

type PayoutRecord = {
  id: string;
  affiliate_id: string;
  payout_method: string;
  payout_method_details: Record<string, unknown>;
  amount: number;
  currency: string;
  fee: number;
  net_amount: number;
  status: string;
  scheduled_at: string | null;
  paid_at: string | null;
  transaction_id: string | null;
  notes: string | null;
  created_at: string;
};

type PaginatedResponse<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

type Stats = {
  total_payouts: number;
  total_paid: number;
  pending_amount: number;
  total_fees: number;
};

const STATUS_OPTIONS = [
  { value: '', labelKey: 'filters.allStatus' },
  { value: 'pending', labelKey: 'status.pending' },
  { value: 'processing', labelKey: 'status.processing' },
  { value: 'completed', labelKey: 'status.completed' },
  { value: 'failed', labelKey: 'status.failed' },
  { value: 'cancelled', labelKey: 'status.cancelled' },
];

interface PayoutsClientProps {
  initialApiUrl: string;
}

export default function PayoutsClient({ initialApiUrl }: PayoutsClientProps) {
  const t = useTranslations('payouts');
  const [isPending, startTransition] = useTransition();
  const [payouts, setPayouts] = useState<PayoutRecord[]>([]);
  const [stats, setStats] = useState<Stats>({ total_payouts: 0, total_paid: 0, pending_amount: 0, total_fees: 0 });
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [limit, setLimit] = useState(20);
  const [error, setError] = useState<string | null>(null);
  const [filters, setFilters] = useState<{ status?: string }>({});

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const fetchPayouts = useCallback(async (page: number, currentFilters: Record<string, string>, currentSort: { sortBy: string; sortOrder: 'asc' | 'desc' }) => {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      sortBy: currentSort.sortBy,
      sortOrder: currentSort.sortOrder,
      ...currentFilters,
    });

    try {
      const response = await fetch(`/api/affiliate/payouts?${params.toString()}`, {
        next: { revalidate: 30 },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch payouts');
      }

      const data: PaginatedResponse<PayoutRecord> & { stats: Stats } = await response.json();
      setPayouts(data.data);
      setTotal(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.totalPages);
      setStats(data.stats);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load payouts');
    }
  }, [limit]);

  useEffect(() => {
    const status = searchParams.get('status') || '';
    const page = parseInt(searchParams.get('page') || '1');
    const limitParam = parseInt(searchParams.get('limit') || '20');
    const sortBy = searchParams.get('sortBy') || 'scheduled_at';
    const sortOrder = (searchParams.get('sortOrder') as 'asc' | 'desc') || 'desc';

    setFilters({ status: status || undefined });
    setLimit(limitParam);
    setCurrentPage(page);
    fetchPayouts(page, { status }, { sortBy, sortOrder });
  }, [searchParams, fetchPayouts]);

  const handleFilterChange = (newFilters: Record<string, string>) => {
    const params = new URLSearchParams();
    Object.entries(newFilters).forEach(([key, value]) => {
      if (value) params.set(key, value);
    });

    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
    });
  };

  const handleStatusChange = (status: string) => {
    handleFilterChange({ status });
  };

  const handleClearFilters = () => {
    router.push(pathname);
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

  const formatCurrency = (amount: number, currency: string) => {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: currency,
    }).format(amount);
  };

  const formatDate = (dateString: string | null) => {
    if (!dateString) return '-';
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
      case 'completed':
        return 'bg-stitch-emerald/15 text-stitch-emerald border border-stitch-emerald/30';
      case 'pending':
        return 'bg-stitch-amber/15 text-stitch-amber border border-stitch-amber/30';
      case 'processing':
        return 'bg-stitch-cyan/15 text-stitch-cyan border border-stitch-cyan/30';
      case 'failed':
        return 'bg-stitch-crimson/15 text-stitch-crimson border border-stitch-crimson/30';
      case 'cancelled':
        return 'bg-stitch-well text-stitch-muted border border-stitch-border';
      default:
        return 'bg-stitch-well text-stitch-muted border border-stitch-border';
    }
  };

  const getMethodLabel = (method: string) => {
    return t(`methods.${method}`) || method;
  };

  const truncateTxId = (txId: string | null) => {
    if (!txId) return '-';
    return `${txId.slice(0, 10)}...${txId.slice(-8)}`;
  };

  const formatDateRange = (payout: PayoutRecord) => {
    const scheduled = formatDate(payout.scheduled_at);
    const paid = payout.paid_at ? ` (Paid: ${formatDate(payout.paid_at)})` : '';
    return `${scheduled}${paid}`;
  };

  const activeFilterCount = (filters.status ? 1 : 0);

  const columns: Column<PayoutRecord>[] = [
    {
      key: 'scheduled_at',
      label: t('columns.date'),
      sortable: true,
      width: '180px',
      render: (_, row) => formatDateRange(row),
    },
    {
      key: 'amount',
      label: t('columns.amount'),
      sortable: true,
      width: '120px',
      render: (value, row) => (
        <span className="text-stitch-primary font-mono font-medium">{formatCurrency(value as number, row.currency)}</span>
      ),
    },
    {
      key: 'net_amount',
      label: t('columns.netAmount'),
      sortable: true,
      width: '120px',
      render: (value, row) => (
        <span className="text-stitch-emerald font-mono font-semibold">{formatCurrency(value as number, row.currency)}</span>
      ),
    },
    {
      key: 'payout_method',
      label: t('columns.method'),
      sortable: true,
      width: '140px',
      render: (value) => (
        <span className="text-stitch-primary">{getMethodLabel(value as string)}</span>
      ),
    },
    {
      key: 'status',
      label: t('columns.status'),
      sortable: true,
      width: '120px',
      render: (value) => {
        const status = value as string;
        return (
          <span className={`inline-flex items-center justify-center px-2.5 py-0.5 rounded-full text-xs font-medium ${getStatusBadgeClass(status)}`}>
            {t(`status.${status}`, { fallback: status })}
          </span>
        );
      },
    },
    {
      key: 'transaction_id',
      label: t('columns.transactionId'),
      sortable: true,
      width: '180px',
      render: (value) => (
        <span className="font-mono text-sm text-stitch-muted">
          {value ? truncateTxId(value as string) : '-'}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      {/* Stats Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-stitch-muted">{t('stats.totalPayouts')}</p>
              <p className="text-2xl font-bold font-mono text-stitch-primary">{stats.total_payouts}</p>
            </div>
            <div className="p-3 bg-stitch-indigo/15 rounded-xl">
              <Wallet className="w-6 h-6 text-stitch-indigo" />
            </div>
          </div>
        </div>

        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-stitch-muted">{t('stats.totalPaid')}</p>
              <p className="text-2xl font-bold font-mono text-stitch-emerald">
                {formatCurrency(stats.total_paid, 'USD')}
              </p>
            </div>
            <div className="p-3 bg-stitch-emerald/15 rounded-xl">
              <DollarSign className="w-6 h-6 text-stitch-emerald" />
            </div>
          </div>
        </div>

        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-stitch-muted">{t('stats.pendingAmount')}</p>
              <p className="text-2xl font-bold font-mono text-stitch-amber">
                {formatCurrency(stats.pending_amount, 'USD')}
              </p>
            </div>
            <div className="p-3 bg-stitch-amber/15 rounded-xl">
              <TrendingUp className="w-6 h-6 text-stitch-amber" />
            </div>
          </div>
        </div>

        <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-stitch-muted">{t('stats.totalFees')}</p>
              <p className="text-2xl font-bold font-mono text-stitch-primary">
                {formatCurrency(stats.total_fees, 'USD')}
              </p>
            </div>
            <div className="p-3 bg-stitch-violet/15 rounded-xl">
              <FileText className="w-6 h-6 text-stitch-violet" />
            </div>
          </div>
        </div>
      </div>

      {/* Filters */}
      <div className="bg-stitch-surface border border-stitch-border rounded-2xl p-6">
        <div className="flex flex-col lg:flex-row gap-4 items-center">
          {/* Status Filter */}
          <div className="lg:w-48">
            <select
              value={filters.status || ''}
              onChange={(e) => handleStatusChange(e.target.value)}
              className="w-full px-4 py-2 bg-stitch-well border border-stitch-border rounded-lg text-sm text-stitch-primary outline-none transition focus:border-stitch-indigo"
            >
              {STATUS_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {t(option.labelKey)}
                </option>
              ))}
            </select>
          </div>

          {/* Clear Filters */}
          {activeFilterCount > 0 && (
            <button
              onClick={handleClearFilters}
              className="px-4 py-2 text-stitch-muted hover:text-stitch-primary border border-stitch-border rounded-lg hover:bg-stitch-well transition-colors"
            >
              {t('filters.clear')}
            </button>
          )}
        </div>
      </div>

      {/* Payouts Table */}
      <Table
        data={payouts}
        columns={columns}
        total={total}
        page={currentPage}
        totalPages={totalPages}
        limit={limit}
        defaultSortBy="scheduled_at"
        defaultSortOrder="desc"
        onPageChange={handlePageChange}
        onLimitChange={handleLimitChange}
        onSortChange={handleSortChange}
        exportFileName="payouts"
        isLoading={isPending}
        emptyMessage={error ? error : t('empty.title')}
        searchable={false}
      />
    </div>
  );
}
