'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Download, Loader2 } from 'lucide-react';

interface ExportUnpaidButtonProps {
  /** Optional chain filter (ethereum, solana, stellar, etc.) */
  chainFilter?: string;
  /** Minimum amount threshold */
  minAmount?: number;
}

export default function ExportUnpaidButton({
  chainFilter,
  minAmount = 0,
}: ExportUnpaidButtonProps) {
  const t = useTranslations('admin.affiliates');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleExport = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Build query params
      const params = new URLSearchParams();
      params.set('format', 'csv');
      if (chainFilter) params.set('chain', chainFilter);
      if (minAmount > 0) params.set('minAmount', minAmount.toString());

      const response = await fetch(`/api/admin/affiliates/unpaid-earnings?${params.toString()}`, {
        method: 'GET',
        credentials: 'include',
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}`);
      }

      const csvContent = await response.text();

      // Create download blob
      const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const timestamp = new Date().toISOString().split('T')[0];
      link.setAttribute('href', url);
      link.setAttribute('download', `unpaid-earnings-payouts-${timestamp}.csv`);
      link.style.visibility = 'hidden';
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
      console.error('Export failed:', err);
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      <button
        onClick={handleExport}
        disabled={isLoading}
        className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {isLoading ? (
          <Loader2 className="w-4 h-4 animate-spin" />
        ) : (
          <Download className="w-4 h-4" />
        )}
        {t('export.unpaidEarnings') || 'Xuất CSV cho Payouts'}
      </button>
      {error && (
        <span className="text-sm text-red-600">{error}</span>
      )}
    </div>
  );
}
