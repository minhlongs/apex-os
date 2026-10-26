'use client';

import React, { useState, useEffect } from 'react';
import { Search, Filter, RotateCcw } from 'lucide-react';
import { FRAUD_REASON_CODES } from '@/types/fraud';

export interface FraudFiltersState {
  search: string;
  status: string; // 'all' | 'pending' | 'approved' | 'rejected'
  reason: string;
  affiliateCode: string;
  dateRange: string; // '24h' | '7d' | '30d' | 'all'
}

interface FraudFilterToolbarProps {
  filters: FraudFiltersState;
  onFilterChange: (newFilters: Partial<FraudFiltersState>) => void;
  onResetFilters: () => void;
  isLoading?: boolean;
}

export const FraudFilterToolbar: React.FC<FraudFilterToolbarProps> = ({
  filters,
  onFilterChange,
  onResetFilters,
}) => {
  const [searchInput, setSearchInput] = useState(filters.search);

  // Debounce search input by 300ms
  useEffect(() => {
    const timer = setTimeout(() => {
      if (searchInput !== filters.search) {
        onFilterChange({ search: searchInput });
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput, filters.search, onFilterChange]);

  // Keep internal state aligned if reset
  useEffect(() => {
    setSearchInput(filters.search);
  }, [filters.search]);

  const hasActiveFilters =
    filters.search !== '' ||
    filters.status !== 'all' ||
    filters.reason !== 'ALL' ||
    filters.affiliateCode !== '' ||
    filters.dateRange !== '24h';

  return (
    <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm mb-6 space-y-4">
      {/* Top Row: Search and Status Pills */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        {/* Search Input */}
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search by Click ID, IP, or Affiliate..."
            className="w-full pl-9 pr-4 py-2 text-sm bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 focus:bg-white transition-colors"
          />
        </div>

        {/* Status Segmented Control */}
        <div className="inline-flex rounded-lg border border-gray-200 bg-gray-50 p-1 self-start md:self-auto">
          {[
            { id: 'all', label: 'All Clicks' },
            { id: 'pending', label: 'Pending' },
            { id: 'approved', label: 'Approved' },
            { id: 'rejected', label: 'Rejected' },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => onFilterChange({ status: tab.id })}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors ${
                filters.status === tab.id
                  ? 'bg-white text-gray-900 shadow-xs'
                  : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Bottom Row: Reason, Affiliate, Date, Reset */}
      <div className="flex flex-wrap items-center gap-3 pt-3 border-t border-gray-100 text-xs">
        <div className="flex items-center gap-1.5 text-gray-500 font-medium">
          <Filter className="w-3.5 h-3.5" />
          <span>Filters:</span>
        </div>

        {/* Reason Code Dropdown */}
        <div className="relative">
          <select
            value={filters.reason}
            onChange={(e) => onFilterChange({ reason: e.target.value })}
            className="px-3 py-1.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="ALL">All Reason Codes</option>
            {FRAUD_REASON_CODES.map((code) => (
              <option key={code} value={code}>
                {code}
              </option>
            ))}
          </select>
        </div>

        {/* Affiliate Code Input */}
        <div>
          <input
            type="text"
            value={filters.affiliateCode}
            onChange={(e) => onFilterChange({ affiliateCode: e.target.value })}
            placeholder="Affiliate ID / Code..."
            className="px-3 py-1.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 w-36"
          />
        </div>

        {/* Date Range Dropdown */}
        <div className="relative flex items-center">
          <select
            value={filters.dateRange}
            onChange={(e) => onFilterChange({ dateRange: e.target.value })}
            className="px-3 py-1.5 bg-gray-50 border border-gray-300 rounded-lg text-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="24h">Last 24 Hours</option>
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="all">All Time</option>
          </select>
        </div>

        {/* Reset Button */}
        {hasActiveFilters && (
          <button
            type="button"
            onClick={onResetFilters}
            className="inline-flex items-center gap-1 px-2.5 py-1.5 text-gray-600 hover:text-red-600 hover:bg-red-50 rounded-lg transition-colors ml-auto font-medium"
          >
            <RotateCcw className="w-3 h-3" />
            Reset Filters
          </button>
        )}
      </div>
    </div>
  );
};
