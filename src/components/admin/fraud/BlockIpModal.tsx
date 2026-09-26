'use client';

import React, { useState } from 'react';
import { Ban, X, AlertTriangle } from 'lucide-react';

interface BlockIpModalProps {
  isOpen: boolean;
  targetIp: string;
  clickId?: string;
  onClose: () => void;
  onSubmit: (ip: string, reason: string, expiresAt?: string | null) => Promise<void>;
}

export const BlockIpModal: React.FC<BlockIpModalProps> = ({
  isOpen,
  targetIp,
  clickId,
  onClose,
  onSubmit,
}) => {
  const [ipInput, setIpInput] = useState(targetIp || '');
  const [reason, setReason] = useState('');
  const [duration, setDuration] = useState<'permanent' | '24h' | '7d' | '30d'>('permanent');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  // Keep state in sync with prop
  React.useEffect(() => {
    setIpInput(targetIp || '');
    setReason('');
    setDuration('permanent');
    setErrorMessage('');
  }, [targetIp, isOpen]);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!ipInput.trim()) {
      setErrorMessage('IP address is required');
      return;
    }
    if (!reason.trim() || reason.trim().length < 3) {
      setErrorMessage('Reason is required and must contain at least 3 characters');
      return;
    }

    let expiresAt: string | null = null;
    const now = Date.now();
    if (duration === '24h') {
      expiresAt = new Date(now + 24 * 3600 * 1000).toISOString();
    } else if (duration === '7d') {
      expiresAt = new Date(now + 7 * 24 * 3600 * 1000).toISOString();
    } else if (duration === '30d') {
      expiresAt = new Date(now + 30 * 24 * 3600 * 1000).toISOString();
    }

    setIsSubmitting(true);
    setErrorMessage('');

    try {
      await onSubmit(ipInput.trim(), reason.trim(), expiresAt);
      onClose();
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to block IP address');
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
              <div className="p-2 bg-red-100 text-red-600 rounded-lg">
                <Ban className="w-5 h-5" />
              </div>
              <div>
                <h3 className="text-base font-bold text-gray-900">
                  Block IP Address
                </h3>
                <p className="text-xs text-gray-500">
                  Add IP to active edge blacklist {clickId ? `(Click: ${clickId})` : ''}
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

            {/* Warning Callout */}
            <div className="p-3 bg-amber-50 border border-amber-200 rounded-lg flex items-start gap-2.5">
              <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
              <p className="text-[11px] text-amber-800 leading-relaxed">
                Traffic originating from this IP will receive immediate <strong>HTTP 403 Forbidden</strong> responses without recording affiliate clicks or commissions.
              </p>
            </div>

            {/* Target IP */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1">
                Target IP Address
              </label>
              <input
                type="text"
                value={ipInput}
                onChange={(e) => setIpInput(e.target.value)}
                placeholder="e.g. 198.51.100.25"
                disabled={Boolean(targetIp)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg font-mono text-xs focus:ring-2 focus:ring-red-500 focus:outline-none disabled:bg-gray-100 disabled:text-gray-500"
              />
            </div>

            {/* Duration */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1">
                Block Duration
              </label>
              <select
                value={duration}
                onChange={(e) => setDuration(e.target.value as any)}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-red-500 focus:outline-none bg-white"
              >
                <option value="permanent">Permanent (No expiration)</option>
                <option value="24h">24 Hours</option>
                <option value="7d">7 Days</option>
                <option value="30d">30 Days</option>
              </select>
            </div>

            {/* Reason */}
            <div>
              <label className="block text-gray-700 font-semibold mb-1">
                Audit Reason <span className="text-red-500">*</span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Enter justification for blocking this IP address (min 3 chars)..."
                rows={3}
                required
                className="w-full px-3 py-2 border border-gray-300 rounded-lg text-xs focus:ring-2 focus:ring-red-500 focus:outline-none resize-none"
              />
            </div>

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
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm disabled:opacity-50 transition-colors"
              >
                <Ban className="w-3.5 h-3.5" />
                {isSubmitting ? 'Blocking...' : 'Confirm Block'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
};
