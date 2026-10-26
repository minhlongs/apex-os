'use client';

import { useState, useCallback, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { ChevronLeft, ChevronRight, ChevronUp, ChevronDown, Download, Search } from 'lucide-react';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  render?: (value: unknown, row: T) => React.ReactNode;
  width?: string;
}

export interface TableProps<T> {
  data: T[];
  columns: Column<T>[];
  total: number;
  page: number;
  totalPages: number;
  limit: number;
  defaultSortBy?: string;
  defaultSortOrder?: 'asc' | 'desc';
  searchable?: boolean;
  onPageChange: (page: number) => void;
  onLimitChange: (limit: number) => void;
  onSortChange: (sortBy: string, sortOrder: 'asc' | 'desc') => void;
  onSearch?: (search: string) => void;
  exportFileName?: string;
  isLoading?: boolean;
  emptyMessage?: string;
}

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100];

export default function Table<T extends Record<string, unknown>>({
  data,
  columns,
  total,
  page,
  totalPages,
  limit,
  defaultSortBy = '',
  defaultSortOrder = 'desc',
  searchable = true,
  onPageChange,
  onLimitChange,
  onSortChange,
  onSearch,
  exportFileName = 'export',
  isLoading = false,
  emptyMessage = 'No data available',
}: TableProps<T>) {
  const t = useTranslations('common');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const [localSortBy, setLocalSortBy] = useState<string>(searchParams.get('sortBy') || defaultSortBy);
  const [localSortOrder, setLocalSortOrder] = useState<'asc' | 'desc'>(
    (searchParams.get('sortOrder') as 'asc' | 'desc') || defaultSortOrder
  );
  const [searchQuery, setSearchQuery] = useState(searchParams.get('search') || '');

  const handleSort = useCallback((columnKey: string) => {
    const newSortBy = columnKey;
    let newSortOrder: 'asc' | 'desc' = 'asc';

    if (localSortBy === columnKey) {
      newSortOrder = localSortOrder === 'asc' ? 'desc' : 'asc';
    }

    setLocalSortBy(newSortBy);
    setLocalSortOrder(newSortOrder);
    onSortChange(newSortBy, newSortOrder);
  }, [localSortBy, localSortOrder, onSortChange]);

  const handleSearch = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    onSearch?.(searchQuery);
  }, [searchQuery, onSearch]);

  const handleExportCSV = useCallback(() => {
    if (data.length === 0) return;

    // Get headers
    const headers = columns.map(col => col.label).join(',');

    // Convert data rows to CSV
    const rows = data.map(row => {
      return columns.map(col => {
        const value = col.render ? col.render(row[col.key], row) : (row[col.key] ?? '');
        // Convert React node to string
        const stringValue = typeof value === 'string' ? value : value?.toString() || '';
        // Escape quotes and wrap in quotes if contains comma or quotes
        if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
          return `"${stringValue.replace(/"/g, '""')}"`;
        }
        return stringValue;
      }).join(',');
    }).join('\n');

    const csvContent = `${headers}\n${rows}`;
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    const url = URL.createObjectURL(blob);
    link.setAttribute('href', url);
    link.setAttribute('download', `${exportFileName}_${new Date().toISOString().split('T')[0]}.csv`);
    link.style.visibility = 'hidden';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }, [data, columns, exportFileName]);

  const getSortIcon = (columnKey: string) => {
    if (localSortBy !== columnKey) {
      return <ChevronUp className="w-4 h-4 text-stitch-muted" />;
    }
    return localSortOrder === 'asc'
      ? <ChevronUp className="w-4 h-4 text-stitch-indigo" />
      : <ChevronDown className="w-4 h-4 text-stitch-indigo" />;
  };

  const renderPaginationInfo = () => {
    const start = total === 0 ? 0 : (page - 1) * limit + 1;
    const end = Math.min(page * limit, total);
    return t('pagination.showing', { start, end, total });
  };

  return (
    <div className="space-y-4">
      {/* Search and Export Bar */}
      <div className="flex flex-col sm:flex-row gap-4 justify-between">
        {searchable && onSearch && (
          <form onSubmit={handleSearch} className="flex gap-2 flex-1 max-w-md">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-5 h-5 text-stitch-muted" />
              <input
                type="text"
                placeholder={t('search.placeholder')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full pl-10 pr-4 py-2 bg-stitch-well border border-stitch-border rounded-lg text-sm text-stitch-primary outline-none transition focus:border-stitch-indigo"
              />
            </div>
            <button
              type="submit"
              className="px-4 py-2 bg-stitch-indigo text-white rounded-lg hover:bg-stitch-violet transition-colors"
            >
              {t('search.search')}
            </button>
            {searchQuery && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  onSearch('');
                }}
                className="px-4 py-2 text-stitch-muted hover:text-stitch-primary border border-stitch-border rounded-lg hover:bg-stitch-well transition-colors"
              >
                {t('search.clear')}
              </button>
            )}
          </form>
        )}

        <div className="flex gap-2">
          <button
            onClick={handleExportCSV}
            disabled={data.length === 0 || isLoading}
            className="flex items-center gap-2 px-4 py-2 bg-stitch-emerald text-white rounded-lg hover:bg-stitch-emerald/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            {t('export.csv')}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-stitch-surface border border-stitch-border rounded-2xl overflow-hidden">
        {isLoading ? (
          <div className="p-8 text-center text-stitch-muted">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-stitch-indigo mx-auto"></div>
            <p className="mt-2">{t('loading')}</p>
          </div>
        ) : data.length === 0 ? (
          <div className="p-8 text-center text-stitch-muted">
            <p className="text-lg font-medium">{emptyMessage}</p>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-stitch-border">
                <thead className="bg-stitch-well">
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        className={`px-6 py-3 text-left text-xs font-medium text-stitch-muted uppercase tracking-wider ${
                          column.sortable ? 'cursor-pointer hover:bg-stitch-canvas/50 select-none' : ''
                        }`}
                        style={{ width: column.width }}
                        onClick={() => column.sortable && handleSort(column.key)}
                      >
                        <div className="flex items-center gap-2">
                          <span>{column.label}</span>
                          {column.sortable && getSortIcon(column.key)}
                        </div>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="bg-stitch-surface divide-y divide-stitch-border">
                  {data.map((row, idx) => (
                    <tr key={row.id as string} className="hover:bg-stitch-well/50 transition-colors">
                      {columns.map((column) => (
                        <td key={`${idx}-${column.key}`} className="px-6 py-4 whitespace-nowrap text-sm text-stitch-primary">
                          {column.render
                            ? column.render(row[column.key], row)
                            : String(row[column.key] ?? '-')}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="bg-stitch-surface px-4 py-3 border-t border-stitch-border flex flex-col sm:flex-row items-center justify-between gap-4">
                {/* Page Size Selector */}
                <div className="flex items-center gap-2">
                  <span className="text-sm text-stitch-muted">{t('pagination.show')}</span>
                  <select
                    value={limit}
                    onChange={(e) => onLimitChange(parseInt(e.target.value))}
                    className="px-2 py-1 bg-stitch-well border border-stitch-border rounded text-sm text-stitch-primary outline-none focus:border-stitch-indigo"
                  >
                    {PAGE_SIZE_OPTIONS.map((size) => (
                      <option key={size} value={size}>
                        {size}
                      </option>
                    ))}
                  </select>
                  <span className="text-sm text-stitch-muted">{t('pagination.entries')}</span>
                </div>

                {/* Pagination Info */}
                <div className="text-sm text-stitch-muted">
                  {renderPaginationInfo()}
                </div>

                {/* Page Navigation */}
                <div className="flex items-center gap-2">
                  <button
                    onClick={() => onPageChange(page - 1)}
                    disabled={page === 1}
                    className="flex items-center gap-1 px-3 py-1 border border-stitch-border rounded-md text-sm text-stitch-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-stitch-well"
                  >
                    <ChevronLeft className="w-4 h-4" />
                    {t('pagination.previous')}
                  </button>

                  {/* Page Numbers */}
                  <div className="flex items-center gap-1">
                    {Array.from({ length: totalPages }, (_, i) => i + 1)
                      .filter(p => p === 1 || p === totalPages || (p >= page - 1 && p <= page + 1))
                      .map((p, idx, arr) => (
                        <span key={p}>
                          {idx > 0 && arr[idx - 1] !== p - 1 && (
                            <span className="px-2 text-stitch-muted">...</span>
                          )}
                          <button
                            onClick={() => onPageChange(p)}
                            className={`px-3 py-1 rounded-md text-sm ${
                              page === p
                                ? 'bg-stitch-indigo text-white'
                                : 'border border-stitch-border text-stitch-primary hover:bg-stitch-well'
                            }`}
                          >
                            {p}
                          </button>
                        </span>
                      ))}
                  </div>

                  <button
                    onClick={() => onPageChange(page + 1)}
                    disabled={page === totalPages}
                    className="flex items-center gap-1 px-3 py-1 border border-stitch-border rounded-md text-sm text-stitch-primary disabled:opacity-50 disabled:cursor-not-allowed hover:bg-stitch-well"
                  >
                    {t('pagination.next')}
                    <ChevronRight className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
