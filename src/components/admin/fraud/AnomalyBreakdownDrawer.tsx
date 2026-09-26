'use client';

import React from 'react';
import {
  X,
  ShieldAlert,
  Clock,
  Activity,
  CheckCircle2,
  XCircle,
  Ban,
  Server,
} from 'lucide-react';
import { FlaggedClickDetail } from '@/types/fraud';
import { getAnomalyScoreStyle } from './FlaggedClicksTable';

interface AnomalyBreakdownDrawerProps {
  click: FlaggedClickDetail | null;
  isOpen: boolean;
  onClose: () => void;
  onApprove: (click: FlaggedClickDetail) => void;
  onReject: (click: FlaggedClickDetail) => void;
  onBlockIp: (ip: string, clickId?: string) => void;
}

export const AnomalyBreakdownDrawer: React.FC<AnomalyBreakdownDrawerProps> = ({
  click,
  isOpen,
  onClose,
  onApprove,
  onReject,
  onBlockIp,
}) => {
  if (!isOpen || !click) return null;

  const scoreStyle = getAnomalyScoreStyle(click.anomalyScore);
  const scorePercent = Math.min(100, Math.round(click.anomalyScore * 100));

  const isBurst = click.flagReasons.includes('BURST_CLICK' as any);
  const isRatio = click.flagReasons.includes('HIGH_CLICK_CONVERSION_RATIO' as any);
  const isRateLimit =
    click.flagReasons.includes('RATE_LIMIT_EXCEEDED' as any) ||
    click.flagReasons.includes('IP_RATE_LIMIT_EXCEEDED' as any);

  return (
    <div className="fixed inset-0 z-50 overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-gray-900/50 backdrop-blur-xs transition-opacity"
        onClick={onClose}
      />

      <div className="fixed inset-y-0 right-0 max-w-full flex pl-10">
        <div className="w-screen max-w-lg bg-white shadow-2xl flex flex-col">
          {/* Header */}
          <div className="px-6 py-5 border-b border-gray-200 flex items-center justify-between bg-gray-50">
            <div>
              <div className="flex items-center gap-2">
                <ShieldAlert className="w-5 h-5 text-red-600" />
                <h2 className="text-base font-bold text-gray-900">
                  Forensic Anomaly Breakdown
                </h2>
              </div>
              <p className="text-xs font-mono text-gray-500 mt-1">
                Click ID: {click.id}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              className="p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-200 rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>

          {/* Drawer Body */}
          <div className="flex-1 overflow-y-auto px-6 py-6 space-y-6 text-xs text-gray-700">
            {/* 1. Anomaly Score Progress Meter */}
            <div className="bg-gray-50 rounded-xl p-4 border border-gray-200">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-gray-700">
                  Composite Anomaly Score
                </span>
                <span
                  className={`px-2 py-0.5 rounded-full text-xs font-bold border ${scoreStyle.badgeBg}`}
                >
                  {click.anomalyScore.toFixed(4)} ({scoreStyle.label})
                </span>
              </div>
              <div className="w-full bg-gray-200 rounded-full h-2.5 overflow-hidden">
                <div
                  className={`h-2.5 rounded-full transition-all duration-500 ${
                    click.anomalyScore >= 0.7 ? 'bg-red-600' : click.anomalyScore >= 0.4 ? 'bg-amber-500' : 'bg-emerald-500'
                  }`}
                  style={{ width: `${scorePercent}%` }}
                />
              </div>
              <p className="text-[11px] text-gray-500 mt-2">
                Calculated via multi-anomaly probabilistic velocity check against platform thresholds.
              </p>
            </div>

            {/* 2. Detected Anomaly Vectors */}
            <div>
              <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wider mb-3">
                Detected Anomaly Vectors
              </h3>
              <div className="space-y-3">
                {/* Burst Vector */}
                {isBurst ? (
                  <div className="p-3.5 bg-red-50 border border-red-200 rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-red-900 flex items-center gap-1.5">
                        <Activity className="w-4 h-4 text-red-600" />
                        Rapid Multi-Click Burst (BURST_CLICK)
                      </span>
                      <span className="text-[10px] font-bold bg-red-200 text-red-800 px-1.5 py-0.5 rounded">
                        &lt; 2,000ms delta
                      </span>
                    </div>
                    <p className="mt-1 text-red-700 text-[11px]">
                      Sequential clicks were received from this IP or session tracking token within less than 2,000 milliseconds.
                    </p>
                  </div>
                ) : null}

                {/* Conversion Ratio Vector */}
                {isRatio ? (
                  <div className="p-3.5 bg-orange-50 border border-orange-200 rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-orange-900 flex items-center gap-1.5">
                        <Clock className="w-4 h-4 text-orange-600" />
                        Click Flooding (HIGH_CLICK_CONVERSION_RATIO)
                      </span>
                      <span className="text-[10px] font-bold bg-orange-200 text-orange-800 px-1.5 py-0.5 rounded">
                        &gt; 10:1 ratio
                      </span>
                    </div>
                    <p className="mt-1 text-orange-700 text-[11px]">
                      The click-to-conversion velocity for this affiliate and deal pair exceeds the platform threshold of 10:1 with at least 10 recorded clicks.
                    </p>
                  </div>
                ) : null}

                {/* Rate Limit Vector */}
                {isRateLimit ? (
                  <div className="p-3.5 bg-blue-50 border border-blue-200 rounded-lg">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-blue-900 flex items-center gap-1.5">
                        <Server className="w-4 h-4 text-blue-600" />
                        IP Rate Limit Exceeded
                      </span>
                      <span className="text-[10px] font-bold bg-blue-200 text-blue-800 px-1.5 py-0.5 rounded">
                        100/hr or 1,000/day
                      </span>
                    </div>
                    <p className="mt-1 text-blue-700 text-[11px]">
                      The originating IP address violated dual-window rate limits (100 clicks/hour or 1,000 clicks/day).
                    </p>
                  </div>
                ) : null}

                {!isBurst && !isRatio && !isRateLimit && (
                  <div className="p-3 bg-gray-50 border border-gray-200 rounded-lg text-gray-600 text-[11px]">
                    Flagged manually or via external bot signatures.
                  </div>
                )}
              </div>
            </div>

            {/* 3. Forensic Metadata Grid */}
            <div>
              <h3 className="text-xs font-bold text-gray-900 uppercase tracking-wider mb-3">
                Forensic Ingestion Telemetry
              </h3>
              <div className="bg-gray-50 rounded-xl p-4 border border-gray-200 space-y-2.5 font-mono text-[11px]">
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">IP Address:</span>
                  <span className="text-gray-900 font-semibold">{click.ipAddress || 'None'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">Location / Country:</span>
                  <span className="text-gray-900">{click.countryCode || 'Unknown'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">Deal ID:</span>
                  <span className="text-gray-900">{click.dealId}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">Affiliate Code:</span>
                  <span className="text-gray-900">{click.affiliateCode || click.affiliateId || 'Direct'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">Session Token:</span>
                  <span className="text-gray-900 truncate max-w-xs">{click.sessionId}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">Device Type:</span>
                  <span className="text-gray-900">{click.deviceType || 'unknown'}</span>
                </div>
                <div className="flex justify-between py-1 border-b border-gray-200">
                  <span className="text-gray-500 font-sans">Created At (UTC):</span>
                  <span className="text-gray-900">{click.createdAt}</span>
                </div>
                <div className="py-1">
                  <span className="text-gray-500 font-sans block mb-1">User Agent:</span>
                  <span className="text-gray-700 break-all text-[10px] bg-white p-2 rounded border border-gray-200 block">
                    {click.userAgent || 'None'}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Drawer Footer Actions */}
          <div className="p-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3 py-2 text-xs font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-100"
            >
              Close
            </button>

            <div className="flex items-center gap-2">
              {click.reviewStatus !== 'approved' && (
                <button
                  type="button"
                  onClick={() => onApprove(click)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-emerald-600 hover:bg-emerald-700 rounded-lg shadow-sm transition-colors"
                >
                  <CheckCircle2 className="w-3.5 h-3.5" />
                  Approve Click
                </button>
              )}

              {click.reviewStatus !== 'rejected' && (
                <button
                  type="button"
                  onClick={() => onReject(click)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg shadow-sm transition-colors"
                >
                  <XCircle className="w-3.5 h-3.5" />
                  Reject Click
                </button>
              )}

              {click.ipAddress && !click.isIpBlocked && (
                <button
                  type="button"
                  onClick={() => onBlockIp(click.ipAddress!, click.id)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-purple-700 bg-purple-50 border border-purple-200 hover:bg-purple-100 rounded-lg transition-colors"
                >
                  <Ban className="w-3.5 h-3.5" />
                  Block IP
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
