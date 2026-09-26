'use client';

import React from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

interface BulkActionBarProps {
  selectedCount: number;
  onBulkApprove: () => void;
  onBulkReject: () => void;
  onClearSelection: () => void;
}

export const BulkActionBar: React.FC<BulkActionBarProps> = ({
  selectedCount,
  onBulkApprove,
  onBulkReject,
  onClearSelection,
}) => {
  if (selectedCount === 0) return null;

  return (
    <div className="fixed bottom-6 inset-x-0 z-40 flex justify-center px-4 pointer-events-none">
      <div className="bg-gray-900 text-white rounded-xl shadow-2xl px-6 py-3.5 flex items-center justify-between gap-6 pointer-events-auto border border-gray-700 max-w-2xl w-full transition-all duration-300 animate-in fade-in slide-in-from-bottom-4">
        {/* Selection count */}
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
          <span>
            <strong className="text-white">{selectedCount}</strong> click{selectedCount > 1 ? 's' : ''} selected
          </span>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2.5">
          <button
            type="button"
            onClick={onBulkApprove}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white shadow-xs transition-colors"
          >
            <CheckCircle2 className="w-3.5 h-3.5" />
            Bulk Approve
          </button>

          <button
            type="button"
            onClick={onBulkReject}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-red-600 hover:bg-red-500 text-white shadow-xs transition-colors"
          >
            <XCircle className="w-3.5 h-3.5" />
            Bulk Reject
          </button>

          <button
            type="button"
            onClick={onClearSelection}
            className="p-1.5 text-gray-400 hover:text-white rounded-md hover:bg-gray-800 transition-colors"
            title="Clear Selection"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>
    </div>
  );
};
