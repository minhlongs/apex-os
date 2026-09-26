'use client';

import React from 'react';
import {
  Eye,
  CheckCircle2,
  XCircle,
  Ban,
  Copy,
  ShieldCheck,
} from 'lucide-react';
import { FlaggedClickDetail } from '@/types/fraud';

interface FlaggedClicksTableProps {
  clicks: FlaggedClickDetail[];
  selectedIds: Set<string>;
  isLoading: boolean;
  onToggleSelect: (id: string) => void;
  onToggleSelectAll: () => void;
  onInspect: (click: FlaggedClickDetail) => void;
  onApprove: (click: FlaggedClickDetail) => void;
  onReject: (click: FlaggedClickDetail) => void;
  onBlockIp: (ip: string, clickId?: string) => void;
  onFilterByReason?: (reason: string) => void;
}

export function getAnomalyScoreStyle(score: number): {
  badgeBg: string;
  textColor: string;
  label: string;
} {
  if (score >= 0.90) {
    return { badgeBg: 'bg-red-100 text-red-800 border-red-200', textColor: 'text-red-700', label: 'CRITICAL' };
  }
  if (score >= 0.70) {
    return { badgeBg: 'bg-orange-100 text-orange-800 border-orange-200', textColor: 'text-orange-700', label: 'HIGH' };
  }
  if (score >= 0.40) {
    return { badgeBg: 'bg-amber-100 text-amber-800 border-amber-200', textColor: 'text-amber-700', label: 'MEDIUM' };
  }
  return { badgeBg: 'bg-emerald-100 text-emerald-800 border-emerald-200', textColor: 'text-emerald-700', label: 'LOW' };
}

export const FlaggedClicksTable: React.FC<FlaggedClicksTableProps> = ({
  clicks,
  selectedIds,
  isLoading,
  onToggleSelect,
  onToggleSelectAll,
  onInspect,
  onApprove,
  onReject,
  onBlockIp,
  onFilterByReason,
}) => {
  const allSelected = clicks.length > 0 && clicks.every((c) => selectedIds.has(c.id));
  const someSelected = clicks.some((c) => selectedIds.has(c.id)) && !allSelected;

  const copyToClipboard = (text: string) => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(text);
    }
  };

  if (isLoading) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden p-8">
        <div className="space-y-4 animate-pulse">
          <div className="h-6 bg-gray-200 rounded w-1/4" />
          <div className="h-10 bg-gray-100 rounded" />
          <div className="h-10 bg-gray-100 rounded" />
          <div className="h-10 bg-gray-100 rounded" />
        </div>
      </div>
    );
  }

  // Graceful Empty State (F10-B1, F10-B4)
  if (clicks.length === 0) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-12 text-center">
        <div className="mx-auto w-12 h-12 rounded-full bg-emerald-50 text-emerald-600 flex items-center justify-center mb-4">
          <ShieldCheck className="w-6 h-6" />
        </div>
        <h3 className="text-base font-semibold text-gray-900">
          No suspicious clicks found
        </h3>
        <p className="text-sm text-gray-500 mt-1 max-w-sm mx-auto">
          No suspicious clicks matching your active filter criteria. All click traffic is clean or already resolved.
        </p>
      </div>
    );
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs text-gray-600">
          <thead className="bg-gray-50 border-b border-gray-200 text-gray-700 font-semibold uppercase tracking-wider text-[11px]">
            <tr>
              <th scope="col" className="p-4 w-4">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => {
                    if (el) el.indeterminate = someSelected;
                  }}
                  onChange={onToggleSelectAll}
                  className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                />
              </th>
              <th scope="col" className="py-3 px-3">Click ID</th>
              <th scope="col" className="py-3 px-3">Deal</th>
              <th scope="col" className="py-3 px-3">Affiliate</th>
              <th scope="col" className="py-3 px-3">IP & Location</th>
              <th scope="col" className="py-3 px-3 text-center">Anomaly Score</th>
              <th scope="col" className="py-3 px-3">Flag Reasons</th>
              <th scope="col" className="py-3 px-3 text-center">Status</th>
              <th scope="col" className="py-3 px-3">Timestamp</th>
              <th scope="col" className="py-3 px-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {clicks.map((click) => {
              const isSelected = selectedIds.has(click.id);
              const scoreStyle = getAnomalyScoreStyle(click.anomalyScore);

              return (
                <tr
                  key={click.id}
                  className={`hover:bg-gray-50/80 transition-colors ${
                    isSelected ? 'bg-blue-50/50' : ''
                  }`}
                >
                  {/* Select Checkbox */}
                  <td className="p-4">
                    <input
                      type="checkbox"
                      checked={isSelected}
                      onChange={() => onToggleSelect(click.id)}
                      className="rounded border-gray-300 text-blue-600 focus:ring-blue-500 w-4 h-4 cursor-pointer"
                    />
                  </td>

                  {/* Click ID */}
                  <td className="py-3 px-3 font-mono font-medium text-gray-900">
                    <div className="flex items-center gap-1.5">
                      <span>{click.id.slice(0, 10)}...</span>
                      <button
                        type="button"
                        onClick={() => copyToClipboard(click.id)}
                        className="text-gray-400 hover:text-gray-600 transition-colors"
                        title="Copy Click ID"
                      >
                        <Copy className="w-3 h-3" />
                      </button>
                    </div>
                  </td>

                  {/* Deal */}
                  <td className="py-3 px-3">
                    <span className="font-mono text-gray-800 bg-gray-100 px-1.5 py-0.5 rounded text-[11px]">
                      {click.dealId}
                    </span>
                  </td>

                  {/* Affiliate */}
                  <td className="py-3 px-3">
                    {click.affiliateCode || click.affiliateId ? (
                      <span className="font-mono text-blue-700 bg-blue-50 px-1.5 py-0.5 rounded border border-blue-100 text-[11px]">
                        {click.affiliateCode || click.affiliateId}
                      </span>
                    ) : (
                      <span className="text-gray-400 italic">Direct</span>
                    )}
                  </td>

                  {/* IP Address & Country */}
                  <td className="py-3 px-3">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="font-mono text-gray-700 font-medium">
                        {click.ipAddress || 'Unknown IP'}
                      </span>
                      {click.countryCode && (
                        <span className="bg-gray-100 text-gray-700 px-1 py-0.2 rounded text-[10px] font-semibold uppercase">
                          {click.countryCode}
                        </span>
                      )}
                      {click.isIpBlocked && (
                        <span className="bg-red-100 text-red-800 px-1.5 py-0.2 rounded text-[10px] font-semibold border border-red-200">
                          Blocked
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Anomaly Score Badge */}
                  <td className="py-3 px-3 text-center">
                    <span
                      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-bold border ${scoreStyle.badgeBg}`}
                    >
                      <span>{click.anomalyScore.toFixed(2)}</span>
                      <span className="text-[9px] opacity-80">({scoreStyle.label})</span>
                    </span>
                  </td>

                  {/* Flag Reasons */}
                  <td className="py-3 px-3">
                    <div className="flex flex-wrap gap-1 max-w-xs">
                      {click.flagReasons && click.flagReasons.length > 0 ? (
                        click.flagReasons.map((reason) => (
                          <button
                            key={reason}
                            type="button"
                            onClick={() => onFilterByReason && onFilterByReason(reason)}
                            className="bg-red-50 text-red-700 hover:bg-red-100 border border-red-200 px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors cursor-pointer"
                            title={`Filter by reason: ${reason}`}
                          >
                            {reason}
                          </button>
                        ))
                      ) : (
                        <span className="text-gray-400 text-[11px] italic">None</span>
                      )}
                    </div>
                  </td>

                  {/* Status */}
                  <td className="py-3 px-3 text-center">
                    <span
                      className={`inline-block px-2 py-0.5 rounded-full text-[11px] font-medium capitalize ${
                        click.reviewStatus === 'approved'
                          ? 'bg-emerald-100 text-emerald-800'
                          : click.reviewStatus === 'rejected'
                          ? 'bg-red-100 text-red-800'
                          : 'bg-amber-100 text-amber-800'
                      }`}
                    >
                      {click.reviewStatus || 'pending'}
                    </span>
                  </td>

                  {/* Timestamp */}
                  <td className="py-3 px-3 whitespace-nowrap text-gray-500 text-[11px]">
                    {new Date(click.createdAt).toLocaleString([], {
                      month: 'short',
                      day: 'numeric',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                  </td>

                  {/* Row Actions */}
                  <td className="py-3 px-3 text-right">
                    <div className="inline-flex items-center gap-1">
                      {/* Inspect */}
                      <button
                        type="button"
                        onClick={() => onInspect(click)}
                        className="p-1 text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded transition-colors"
                        title="Inspect Forensics"
                      >
                        <Eye className="w-4 h-4" />
                      </button>

                      {/* Approve */}
                      {click.reviewStatus !== 'approved' && (
                        <button
                          type="button"
                          onClick={() => onApprove(click)}
                          className="p-1 text-gray-500 hover:text-emerald-600 hover:bg-emerald-50 rounded transition-colors"
                          title="Approve Click"
                        >
                          <CheckCircle2 className="w-4 h-4" />
                        </button>
                      )}

                      {/* Reject */}
                      {click.reviewStatus !== 'rejected' && (
                        <button
                          type="button"
                          onClick={() => onReject(click)}
                          className="p-1 text-gray-500 hover:text-red-600 hover:bg-red-50 rounded transition-colors"
                          title="Reject Click"
                        >
                          <XCircle className="w-4 h-4" />
                        </button>
                      )}

                      {/* Block IP */}
                      {click.ipAddress && !click.isIpBlocked && (
                        <button
                          type="button"
                          onClick={() => onBlockIp(click.ipAddress!, click.id)}
                          className="p-1 text-gray-500 hover:text-purple-600 hover:bg-purple-50 rounded transition-colors"
                          title="Block IP Address"
                        >
                          <Ban className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
