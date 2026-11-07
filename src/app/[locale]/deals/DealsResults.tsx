'use client';

import { useState, useEffect, useCallback, useTransition } from 'react';
import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { ChevronLeft, ChevronRight, Filter, ExternalLink } from 'lucide-react';

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
  low: { label: 'Low Risk', color: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30' },
  medium: { label: 'Medium Risk', color: 'bg-amber-500/10 text-amber-300 border border-amber-500/30' },
  high: { label: 'High Risk', color: 'bg-rose-500/10 text-rose-400 border border-rose-500/30' },
};

const EXCHANGE_COLORS: Record<string, string> = {
  binance: 'bg-amber-500/10 text-amber-300 border border-amber-500/30',
  bybit: 'bg-rose-500/10 text-rose-400 border border-rose-500/30',
  okx: 'bg-sky-500/10 text-sky-400 border border-sky-500/30',
  kucoin: 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30',
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
    } catch {
      setError(t('error'));
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
      <div className="text-sm text-stitch-muted">
        {t('pagination.showing', { from: 1, to: deals.length, total })}
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 text-rose-400 px-4 py-3 rounded-lg text-sm">
          {error}
        </div>
      )}

      {!error && deals.length === 0 && (
        <div className="stitch-obsidian-card text-center py-12">
          <div className="text-stitch-muted mb-4">
            <Filter className="w-12 h-12 mx-auto opacity-50" />
          </div>
          <h3 className="text-lg font-medium text-stitch-primary mb-2">{t('empty.title')}</h3>
          <p className="text-stitch-muted mb-4 text-sm">{t('empty.description')}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-6">
        {deals.map((deal) => (
          <div
            key={deal.id}
            className="stitch-obsidian-card flex flex-col justify-between overflow-hidden hover:border-stitch-emerald/60 transition-colors"
          >
            <div>
              <div className="p-4 border-b border-stitch-divider bg-stitch-well/40">
                <div className="flex justify-between items-start gap-2">
                  <span className={`px-2 py-0.5 text-xs font-mono font-medium rounded ${EXCHANGE_COLORS[deal.exchange || ''] || 'bg-stitch-well text-stitch-muted border border-stitch-divider'}`}>
                    {deal.exchange ? t(`exchanges.${deal.exchange}`) : 'Unknown'}
                  </span>
                  <span className={`px-2 py-0.5 text-xs font-mono font-medium rounded ${RISK_LEVELS[deal.risk_level || 'medium'].color}`}>
                    {deal.risk_level ? t(`risk.${deal.risk_level}`) : t('risk.medium')}
                  </span>
                </div>
                <h3 className="mt-2 font-semibold text-stitch-primary line-clamp-2">{deal.name}</h3>
              </div>

              <div className="p-4">
                {deal.description && (
                  <p className="text-sm text-stitch-muted mb-4 line-clamp-2 leading-relaxed">{deal.description}</p>
                )}

                <div className="space-y-2 text-xs font-mono">
                  <div className="flex justify-between">
                    <span className="text-stitch-muted">{t('card.type')}:</span>
                    <span className="font-medium text-stitch-primary capitalize">{t(`types.${deal.deal_type}`)}</span>
                  </div>
                  {deal.category && (
                    <div className="flex justify-between">
                      <span className="text-stitch-muted">{t('card.category')}:</span>
                      <span className="font-medium text-stitch-primary capitalize">{t(`categories.${deal.category}`)}</span>
                    </div>
                  )}
                  <div className="flex justify-between">
                    <span className="text-stitch-muted">{t('card.cashback')}:</span>
                    <span className="font-bold text-stitch-emerald stitch-tabular-nums">{getCashbackDisplay(deal)}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-stitch-muted">{t('card.posted')}:</span>
                    <span className="font-medium text-stitch-muted">{formatDate(deal.created_at)}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="p-4 border-t border-stitch-divider bg-stitch-well/30">
              <a
                href={deal.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-center gap-2 w-full bg-stitch-emerald text-slate-950 py-2 px-4 rounded-lg hover:opacity-90 transition-opacity font-semibold text-sm"
              >
                <ExternalLink className="w-4 h-4" />
                {t('card.viewDeal')}
              </a>
            </div>
          </div>
        ))}
      </div>

      {totalPages > 1 && (
        <div className="flex justify-center items-center gap-2 mt-8">
          <button
            onClick={() => handlePageChange(currentPage - 1)}
            disabled={currentPage === 1 || isPending}
            className="flex items-center gap-1 px-4 py-2 border border-stitch-divider rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-stitch-well text-sm text-stitch-primary"
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
                  className={`w-10 h-10 rounded-lg text-sm font-mono ${
                    currentPage === pageNum
                      ? 'bg-stitch-emerald text-slate-950 font-bold'
                      : 'border border-stitch-divider text-stitch-muted hover:bg-stitch-well'
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
            className="flex items-center gap-1 px-4 py-2 border border-stitch-divider rounded-lg disabled:opacity-30 disabled:cursor-not-allowed hover:bg-stitch-well text-sm text-stitch-primary"
          >
            {t('pagination.next')}
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}
    </div>
  );
}
