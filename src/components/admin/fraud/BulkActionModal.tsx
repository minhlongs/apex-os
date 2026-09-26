'use client';

import React, { useState } from 'react';
import { CheckCircle2, XCircle, X } from 'lucide-react';

interface BulkActionModalProps {
  isOpen: boolean;
  action: 'approve' | 'reject';
  selectedCount: number;
  onClose: () => void;
  onSubmit: (action: 'approve' | 'reject', reason: string, blockIpAlso?: boolean) => Promise<void>;
}

export const BulkActionModal: React.FC<BulkActionModalProps> = ({
  isOpen,
  action,
  selectedCount,
  onClose,
  onSubmit,
}) => {
  const [reason, setReason] = useState('');
  const [blockIpAlso, setBlockIpAlso] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  React.useEffect(() => {
    setReason('');
    setBlockIpAlso(false);
    setErrorMessage('');
  }, [isOpen, action]);

  if (!isOpen) return null;

  const isApprove = action === 'approve';

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reason.trim() || reason.trim().length < 3) {
      setErrorMessage('Reason is required and must contain at least 3 characters');
      return;
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      await onSubmit(action, reason.trim(), blockIpAlso);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || `Failed to bulk ${action} clicks`);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="fixed inset-0 bg-gray-900/60 backdrop-blur-xs" onClick={onClose} />

      <div className="bg-white rounded-2xl shadow-xl max-w-md w-full relative z-10 overflow-hidden border border-gray-200 animate-in fade-in zoom-in-95 duration-200">
        <div className="p-6">
          <div className="flex items-center justify-between pb-4 border-b border-gray-100">
            <div className="flex items-center gap-2.5">
              <div
                className={`p-2 rounded-lg ${
                  isApprove ? 'bg-emerald-100 text-emerald-600' : 'bg-red-100 text-red-600'
                }`}
              >
                {isApprove ? <CheckCircle2 className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900 capitalize">
                  Bulk {action} Clicks
                </h3>
                <p className="text-xs text-gray-500">
                  Execute resolution across {selectedCount} selected click{selectedCount > 1 ? 's' : ''}
                </p>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-600 rounded-lg"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="mt-4 space-y-4 text-xs">
            {errorMessage && (
              <div className="p-3 bg-red-50 text-red-700 rounded-lg border border-red-200 font-medium">
                {errorMessage}
              </div>
            )}

            <div className="p-3.5 bg-gray-50 border border-gray-200 rounded-lg text-gray-700 leading-relaxed">
              {isApprove ? (
                <span>
                  You are about to mark <strong>{selectedCount}</strong> click{selectedCount > 1 ? 's' : ''} as legitimate. Suspicion flags will be cleared, and conversion attribution will be immediately restored.
                </span>
              ) : (
                <span>
                  You are about to reject <strong>{selectedCount}</strong> click{selectedCount > 1 ? 's' : ''}. Suspicion will be permanently confirmed, and any matched commissions will be voided.
                </span>
              )}
            </div>

            {/* Reason */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1">
                Audit Justification <span className="text-red-500">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder={`Provide non-repudiation audit justification for this bulk ${action}...`}
                rows={3}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-500 focus:outline-none resize-none"
              />
            </div>

            {/* Optional IP Block cascade when rejecting */}
            {!isApprove && (
              <div className="flex items-start gap-2 pt-1">
                <input
                  type="checkbox"
                  id="blockIpAlso"
                  checked={blockIpAlso}
                  onChange={(e) => setBlockIpAlso(e.target.checked)}
                  className="rounded border-gray-300 text-red-600 focus:ring-red-500 w-4 h-4 cursor-pointer mt-0.5"
                />
                <label htmlFor="blockIpAlso" className="text-gray-700 text-xs cursor-pointer select-none">
                  Also blacklist originating IP addresses on active edge firewall
                </label>
              </div>
            )}

            {/* Actions */}
            <div className="pt-2 flex items-center justify-end gap-2.5">
              <button
                type="button"
                onClick={onClose}
                disabled={isSubmitting}
                className="px-4 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting}
                className={`inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white rounded-lg shadow-sm disabled:opacity-50 transition-colors ${
                  isApprove
                    ? 'bg-emerald-600 hover:bg-emerald-700'
                    : 'bg-red-600 hover:bg-red-700'
                }`}
              >
                {isApprove ? <CheckCircle2 className="w-3.5 h-3.5" /> : <XCircle className="w-3.5 h-3.5" />}
                {isSubmitting ? 'Processing...' : `Confirm Bulk ${action}`}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
