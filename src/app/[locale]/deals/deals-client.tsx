'use client';

import { useTranslations } from 'next-intl';
import { useSearchParams, useRouter } from 'next/navigation';

const EXCHANGES = [
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'okx', label: 'OKX' },
  { value: 'ftx', label: 'FTX' },
  { value: 'coinbase', label: 'Coinbase' },
  { value: 'kraken', label: 'Kraken' },
];

const CATEGORIES = [
  { value: 'spot', label: 'Spot Trading' },
  { value: 'futures', label: 'Futures' },
  { value: 'options', label: 'Options' },
  { value: 'margin', label: 'Margin Trading' },
];

const DEAL_TYPES = [
  { value: 'product', label: 'Product' },
  { value: 'service', label: 'Service' },
  { value: 'subscription', label: 'Subscription' },
  { value: 'course', label: 'Course' },
];

interface DealsFiltersProps {
  initialFilters: { exchange?: string; category?: string; deal_type?: string; search?: string };
}

export default function DealsFilters({ initialFilters }: DealsFiltersProps) {
  const t = useTranslations('deals');
  const searchParams = useSearchParams();
  const router = useRouter();

  const handleFilterChange = (key: string, value: string) => {
    const params = new URLSearchParams(searchParams.toString());
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    params.delete('page'); // Reset to page 1 on filter change

    router.push(`?${params.toString()}`);
  };

  const clearFilters = () => {
    router.push('');
  };

  const activeFiltersCount = [
    initialFilters.exchange,
    initialFilters.category,
    initialFilters.deal_type,
    initialFilters.search,
  ].filter(Boolean).length;

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <h2 className="font-semibold text-gray-900">{t('filters.title')}</h2>
        {activeFiltersCount > 0 && (
          <button
            onClick={clearFilters}
            className="text-sm text-brand-600 hover:text-brand-700"
          >
            {t('filters.clearAll')}
          </button>
        )}
      </div>

      {/* Search */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('filters.search')}
        </label>
        <div className="relative">
          <svg className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input
            type="text"
            placeholder={t('filters.searchPlaceholder')}
            defaultValue={initialFilters.search || ''}
            onChange={(e) => handleFilterChange('search', e.target.value)}
            className="w-full pl-10 pr-4 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent"
          />
        </div>
      </div>

      {/* Exchange Filter */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('filters.exchange')}
        </label>
        <select
          value={initialFilters.exchange || ''}
          onChange={(e) => handleFilterChange('exchange', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent"
        >
          <option value="">{t('filters.allExchanges')}</option>
          {EXCHANGES.map((ex) => (
            <option key={ex.value} value={ex.value}>
              {ex.label}
            </option>
          ))}
        </select>
      </div>

      {/* Category Filter */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('filters.category')}
        </label>
        <select
          value={initialFilters.category || ''}
          onChange={(e) => handleFilterChange('category', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent"
        >
          <option value="">{t('filters.allCategories')}</option>
          {CATEGORIES.map((cat) => (
            <option key={cat.value} value={cat.value}>
              {cat.label}
            </option>
          ))}
        </select>
      </div>

      {/* Deal Type Filter */}
      <div>
        <label className="block text-sm font-medium text-gray-700 mb-2">
          {t('filters.type')}
        </label>
        <select
          value={initialFilters.deal_type || ''}
          onChange={(e) => handleFilterChange('deal_type', e.target.value)}
          className="w-full px-3 py-2 border rounded-lg focus:ring-2 focus:ring-brand-500 focus:border-transparent"
        >
          <option value="">{t('filters.allTypes')}</option>
          {DEAL_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.label}
            </option>
          ))}
        </select>
      </div>
    </div>
  );
}
