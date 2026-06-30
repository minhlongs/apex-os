'use client';

import { useState, useEffect, useCallback, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Search, Filter, ExternalLink } from 'lucide-react';

type PublicDeal = {
  id: string;
  name: string;
  description: string | null;
  deal_type: 'product' | 'service' | 'subscription' | 'course';
  exchange: string | null;
  category: string | null;
  url: string;
  default_commission_rate: number;
  cashback_percent: number | null;
  risk_level: string | null;
  created_at: string;
};

type PaginatedResponse<T> = {
  data: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
};

interface DealsResultsProps {
  apiUrl: string;
  initialPage: number;
  initialFilters: { exchange?: string; category?: string; deal_type?: string; search?: string };
}

const RISK_LEVELS: Record<string, { label: string; color: string }> = {
  low: { label: 'Low Risk', color: 'bg-green-100 text-green-800' },
  medium: { label: 'Medium Risk', color: 'bg-yellow-100 text-yellow-800' },
  high: { label: 'High Risk', color: 'bg-red-100 text-red-800' },
};

const EXCHANGE_COLORS: Record<string, string> = {
  binance: 'bg-yellow-100 text-yellow-800',
  bybit: 'bg-red-100 text-red-800',
  okx: 'bg-blue-100 text-blue-800',
  ftx: 'bg-purple-100 text-purple-800',
  coinbase: 'bg-blue-100 text-blue-800',
  kraken: 'bg-indigo-100 text-indigo-800',
};

export default function DealsResults({ apiUrl, initialPage, initialFilters }: DealsResultsProps) {
  const t = useTranslations('deals');
  const [isPending, startTransition] = useTransition();
  const [deals, setDeals] = useState<PublicDeal[]>([]);
  const [total, setTotal] = useState(0);
  const [currentPage, setCurrentPage] = useState(initialPage);
  const [totalPages, setTotalPages] = useState(1);
  const [limit] = useState(20);
  const [error, setError] = useState<string | null>(null);

  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const fetchDeals = useCallback(async (page: number, filters: Record<string, string>) => {
    const params = new URLSearchParams({
      page: page.toString(),
      limit: limit.toString(),
      is_active: '1',
      ...filters,
    });

    try {
      const response = await fetch(`${apiUrl}&${params.toString()}`, {
        next: { revalidate: 60 },
      });

      if (!response.ok) {
        throw new Error('Failed to fetch deals');
      }

      const data: PaginatedResponse<PublicDeal> = await response.json();
      setDeals(data.data);
      setTotal(data.total);
      setCurrentPage(data.page);
      setTotalPages(data.totalPages);
      setError(null);
    } catch (err) {
      setError(t('error'));
      console.error('Error fetching deals:', err);
    }
  }, [apiUrl, limit, t]);

  useEffect(() => {
    const filters: Record<string, string> = {};
    if (initialFilters.exchange) filters.exchange = initialFilters.exchange;
    if (initialFilters.category) filters.category = initialFilters.category;
    if (initialFilters.deal_type) filters.deal_type = initialFilters.deal_type;
    if (initialFilters.search) filters.search = initialFilters.search;

    fetchDeals(initialPage, filters);
  }, [initialFilters, initialPage, fetchDeals]);

  const handlePageChange = (page: number) => {
    const params = new URLSearchParams(searchParams.toString());
    params.set('page', page.toString());

    startTransition(() => {
      router.push(`${pathname}?${params.toString()}`);
      fetchDeals(page, {
        exchange: initialFilters.exchange || '',
        category: initialFilters.category || '',
        deal_type: initialFilters.deal_type || '',
        search: initialFilters.search || '',
      });
    });

    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const getCashbackDisplay = (deal: PublicDeal) => {
    if (deal.cashback_percent) {
      return `${deal.cashback_percent.toFixed(2)}%`;
    }
    if (deal.default_commission_rate > 0) {
      return `${(deal.default_commission_rate * 100).toFixed(2)}%`;
    }
    return '—';
  };

  return (
    <div className="space-y-6">
      {/* Results summary */}
      <div className="text-sm text-gray-600">
        {t('pagination.showing', { from: 1, to: deals.length, total })}
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}

      {!error && deals.length === 0 && (
        <div className="text-center py-12">
          <div className="text-gray-400 mb-4">
            <Filter className="w-12 h-12 mx-auto" />
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">{t('empty.title')}</h3>
          <p className="text-gray-600 mb-4">{t('empty.description')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {deals.map((deal) => (
          <div key={deal.id} className="bg-white rounded-lg shadow-md overflow-hidden hover:shadow-lg transition-shadow">
            {/* Header with exchange badge */}
            <div className="p-4 border-b bg-gray-50">
              <div className="flex justify-between items-start">
                <span className={`px-2 py-1 text-xs font-medium rounded ${EXCHANGE_COLORS[deal.exchange || ''] || 'bg-gray-100 text-gray-800'}`}>
                  {deal.exchange ? t(`exchanges.${deal.exchange}`) : 'Unknown'}
                </span>
                <span className={`px-2 py-1 text-xs font-medium rounded ${RISK_LEVELS[deal.risk_level || 'medium'].color}`}>
                  {deal.risk_level ? t(`risk.${deal.risk_level}`) : t('risk.medium')}
                </span>
              </div>
              <h3 className="mt-2 font-semibold text-gray-900 line-clamp-2">{deal.name}</h3>
            </div>

            {/* Content */}
            <div className="p-4">
              {deal.description && (
                <p className="text-sm text-gray-600 mb-4 line-clamp-2">{deal.description}</p>
              )}

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-500">{t('card.type')}:</span>
                  <span className="font-medium capitalize">{t(`types.${deal.deal_type}`)}</span>
                </div>
                {deal.category && (
                  <div className="flex justify-between">
                    <span className="text-gray-500">{t('card.category')}:</span>
                    <span className="font-medium capitalize">{t(`categories.${deal.category}`)}</span>
                  </div>
                )}
                <div className="flex justify-between">
                  <span className="text-gray-500">{t('card.cashback')}:</span>
                  <span className="font-medium text-brand-600">{getCashbackDisplay(deal)}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-500">{t('card.posted')}:</span>
                  <span className="font-medium">{formatDate(deal.created_at)}</span>
                </div>
              </div>
            </div>

            {/* Footer with CTA */}
            <div className="p-4 border-t bg-gray-50">
              <a
                href={deal.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-brand-600 text-white py-2 px-4 rounded-lg hover:bg-brand-700 transition-colors font-medium"
              >
                <ExternalLink className="w-4 h-4" />
                {t('card.viewDeal')}
              </a>
            </div>
          </div>
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-2 mt-8">
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1 || isPending}
            className="flex items-center gap-1 px-4 py-2 border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            <ChevronLeft className="w-4 h-4" />
            {t('pagination.previous')}
          </button>

          <div className="flex items-center gap-1">
            {Array.from({ length: Math.min(5, totalPages) }, (_, i) => {
              let pageNum: number;
              if (totalPages <= 5) {
                pageNum = i + 1;
              } else if (currentPage <= 3) {
                pageNum = i + 1;
              } else if (currentPage >= totalPages - 2) {
                pageNum = totalPages - 4 + i;
              } else {
                pageNum = currentPage - 2 + i;
              }

              return (
                <button
                  key={pageNum}
                  onClick={() => handlePageChange(pageNum)}
                  className={`w-10 h-10 rounded-lg ${
                    currentPage === pageNum
                      ? 'bg-brand-600 text-white'
                      : 'border hover:bg-gray-50'
                  }`}
                >
                  {pageNum}
                </button>
              );
            })}
          </div>

          <button
            onClick={() => handlePageChange(currentPage + 1)}
            disabled={currentPage === totalPages || isPending}
            className="flex items-center gap-1 px-4 py-2 border rounded-lg disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
          >
            {t('pagination.next')}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
