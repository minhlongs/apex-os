'use client';

import React from 'react';
import {
  ShieldAlert,
  RefreshCw,
  Ban,
  Download,
  Activity,
} from 'lucide-react';

interface FraudHeaderProps {
  isRefreshing: boolean;
  autoRefresh: boolean;
  lastRefreshed: Date;
  onRefresh: () => void;
  onToggleAutoRefresh: () => void;
  onOpenBlockIpModal: () => void;
  onExportReport: () => void;
}

export const FraudHeader: React.FC<FraudHeaderProps> = ({
  isRefreshing,
  autoRefresh,
  lastRefreshed,
  onRefresh,
  onToggleAutoRefresh,
  onOpenBlockIpModal,
  onExportReport,
}) => {
  const timeFormatted = lastRefreshed.toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-6 border-b border-gray-200">
      <div>
        <div className="flex items-center gap-3">
          <div className="p-2 bg-red-100 rounded-lg text-red-600">
            <ShieldAlert className="w-6 h-6" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold text-gray-900">
                Fraud Review Dashboard
              </h1>
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-800 border border-emerald-200">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
                Engine Active
              </span>
            </div>
            <p className="text-sm text-gray-500 mt-1">
              Inspect flagged suspicious clicks, evaluate anomaly velocity, and mitigate affiliate fraud.
            </p>
          </div>
        </div>
      </div>

      <div className="flex items-center flex-wrap gap-2.5">
        {/* Auto Refresh Toggle */}
        <button
          type="button"
          onClick={onToggleAutoRefresh}
          className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
            autoRefresh
              ? 'bg-blue-50 text-blue-700 border-blue-200'
              : 'bg-white text-gray-600 border-gray-300 hover:bg-gray-50'
          }`}
          title="Toggle 30-second automated polling"
        >
          <Activity className="w-3.5 h-3.5" />
          Auto-Refresh: {autoRefresh ? 'On (30s)' : 'Off'}
        </button>

        {/* Manual Refresh */}
        <button
          type="button"
          onClick={onRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 transition-colors"
          title={`Last updated at ${timeFormatted}`}
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          Refresh
        </button>

        {/* Export Report */}
        <button
          type="button"
          onClick={onExportReport}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          <Download className="w-3.5 h-3.5" />
          Export CSV
        </button>

        {/* Block New IP Action */}
        <button
          type="button"
          onClick={onOpenBlockIpModal}
          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-medium text-white bg-red-600 rounded-lg hover:bg-red-700 shadow-sm transition-colors"
        >
          <Ban className="w-3.5 h-3.5" />
          + Block New IP
        </button>
      </div>
    </div>
  );
};
