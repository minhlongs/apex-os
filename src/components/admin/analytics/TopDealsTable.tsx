'use client';

import { useState } from 'react';
import { ChevronUp, ChevronDown, Search } from 'lucide-react';
import type { DealMetrics } from '@/types/metrics';

interface TopDealsTableProps {
  deals: DealMetrics[];
}

type SortField = 'name' | 'total_revenue' | 'total_conversions' | 'conversion_rate' | 'total_clicks';
type SortDirection = 'asc' | 'desc';

export default function TopDealsTable({ deals }: TopDealsTableProps) {
  const [sortField, setSortField] = useState<SortField>('total_revenue');
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc');
  const [searchQuery, setSearchQuery] = useState('');

  function formatCurrency(value: number): string {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }).format(value);
  }

  function formatPercent(value: number): string {
    return `${value.toFixed(1)}%`;
  }

  function handleSort(field: SortField) {
    if (sortField === field) {
      setSortDirection(sortDirection === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDirection('desc');
    }
  }

  const filteredAndSortedDeals = deals
    .filter(deal =>
      deal.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deal.exchange?.toLowerCase().includes(searchQuery.toLowerCase()) ||
      deal.category?.toLowerCase().includes(searchQuery.toLowerCase())
    )
    .sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];

      if (typeof aVal === 'number' && typeof bVal === 'number') {
        return sortDirection === 'asc' ? aVal - bVal : bVal - aVal;
      }
      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return 0;
    });

  const SortIcon = ({ field }: { field: SortField }) => {
    if (sortField !== field) return null;
    return sortDirection === 'asc' ?
      <ChevronUp className="w-4 h-4 inline ml-1" /> :
      <ChevronDown className="w-4 h-4 inline ml-1" />;
  };

  const StatusBadge = ({ isActive }: { isActive: boolean }) => (
    <span className={`px-2 py-1 text-xs font-medium rounded-full ${
      isActive
        ? 'bg-green-100 text-green-800'
        : 'bg-gray-100 text-gray-800'
    }`}>
      {isActive ? 'Active' : 'Inactive'}
    </span>
  );

  return (
    <div className="bg-white rounded-lg border border-gray-200 shadow-sm">
      <div className="px-6 py-4 border-b border-gray-200">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">Top Deals</h3>
            <p className="text-sm text-gray-500 mt-1">
              Best performing deals by revenue
            </p>
          </div>
          <div className="relative">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search deals..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="pl-10 pr-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            />
          </div>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-gray-50">
            <tr>
              <th
                className="text-left py-3 px-4 font-medium text-gray-600 cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('name')}
              >
                Deal <SortIcon field="name" />
              </th>
              <th className="text-left py-3 px-4 font-medium text-gray-600">Exchange</th>
              <th
                className="text-right py-3 px-4 font-medium text-gray-600 cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('total_clicks')}
              >
                Clicks <SortIcon field="total_clicks" />
              </th>
              <th
                className="text-right py-3 px-4 font-medium text-gray-600 cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('conversion_rate')}
              >
                Conv. Rate <SortIcon field="conversion_rate" />
              </th>
              <th
                className="text-right py-3 px-4 font-medium text-gray-600 cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('total_conversions')}
              >
                Conversions <SortIcon field="total_conversions" />
              </th>
              <th
                className="text-right py-3 px-4 font-medium text-gray-600 cursor-pointer hover:bg-gray-100"
                onClick={() => handleSort('total_revenue')}
              >
                Revenue <SortIcon field="total_revenue" />
              </th>
              <th className="text-right py-3 px-4 font-medium text-gray-600">Status</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {filteredAndSortedDeals.length === 0 ? (
              <tr>
                <td colSpan={7} className="py-8 text-center text-gray-500">
                  No deals found matching your criteria
                </td>
              </tr>
            ) : (
              filteredAndSortedDeals.map((deal, index) => (
                <tr key={deal.id} className="hover:bg-gray-50">
                  <td className="py-4 px-4">
                    <div className="font-medium text-gray-900">{deal.name}</div>
                    {deal.category && (
                      <div className="text-xs text-gray-500">{deal.category}</div>
                    )}
                  </td>
                  <td className="py-4 px-4">
                    <span className="capitalize text-gray-600">{deal.exchange || 'Unknown'}</span>
                  </td>
                  <td className="py-4 px-4 text-right text-gray-900">
                    {deal.total_clicks.toLocaleString()}
                    <div className="text-xs text-gray-500">{deal.unique_clicks?.toLocaleString()} unique</div>
                  </td>
                  <td className="py-4 px-4 text-right text-gray-900">
                    {formatPercent(deal.conversion_rate)}
                  </td>
                  <td className="py-4 px-4 text-right text-gray-900">
                    {deal.total_conversions.toLocaleString()}
                  </td>
                  <td className="py-4 px-4 text-right">
                    <div className="font-medium text-gray-900">{formatCurrency(deal.total_revenue)}</div>
                    <div className="text-xs text-gray-500">
                      Comm: {formatCurrency(deal.total_commission)}
                    </div>
                  </td>
                  <td className="py-4 px-4 text-right">
                    <StatusBadge isActive={deal.is_active} />
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {filteredAndSortedDeals.length > 0 && (
        <div className="px-6 py-3 border-t border-gray-200 bg-gray-50">
          <div className="text-sm text-gray-500">
            Showing {filteredAndSortedDeals.length} of {deals.length} deals
          </div>
        </div>
      )}
    </div>
  );
}
