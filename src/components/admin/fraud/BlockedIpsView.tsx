'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { Ban, Search, Check, Plus } from 'lucide-react';
import { BlockedIpDetailItem } from '@/types/fraud';

interface BlockedIpsViewProps {
  onOpenBlockModal: () => void;
  onUnblockIp: (ip: string, reason: string) => Promise<void>;
}

export const BlockedIpsView: React.FC<BlockedIpsViewProps> = ({
  onOpenBlockModal,
  onUnblockIp,
}) => {
  const [blockedIps, setBlockedIps] = useState<BlockedIpDetailItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [activeOnly, setActiveOnly] = useState(false);
  const [unblockingIp, setUnblockingIp] = useState<string | null>(null);

  const fetchBlockedIps = useCallback(async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams();
      if (search) params.set('search', search);
      if (activeOnly) params.set('activeOnly', 'true');
      const res = await fetch(`/api/admin/fraud/blocked-ips?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setBlockedIps(data.data || data.blockedIps || []);
      }
    } catch (err) {
      console.error('Failed to load blocked IPs:', err);
    } finally {
      setIsLoading(false);
    }
  }, [search, activeOnly]);

  useEffect(() => {
    fetchBlockedIps();
  }, [fetchBlockedIps]);

  const handleUnblock = async (ip: string) => {
    const reason = window.prompt(
      `Enter reason for unblocking IP address ${ip}:`,
      'Manual pardon by security administrator'
    );
    if (!reason || reason.trim().length < 3) return;

    setUnblockingIp(ip);
    try {
      await onUnblockIp(ip, reason.trim());
      await fetchBlockedIps();
    } finally {
      setUnblockingIp(null);
    }
  };

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="bg-white rounded-xl p-4 border border-gray-200 shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="flex items-center gap-3 flex-1 max-w-md">
          <div className="relative w-full">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search IP address or block rationale..."
              className="w-full pl-9 pr-4 py-2 text-xs bg-gray-50 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-purple-500 focus:bg-white"
            />
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-gray-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={activeOnly}
              onChange={(e) => setActiveOnly(e.target.checked)}
              className="rounded border-gray-300 text-purple-600 focus:ring-purple-500 w-4 h-4 cursor-pointer"
            />
            <span>Active Blocks Only</span>
          </label>

          <button
            type="button"
            onClick={onOpenBlockModal}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold text-white bg-purple-600 hover:bg-purple-700 rounded-lg shadow-sm transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            Add IP Block
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        {isLoading ? (
          <div className="p-8 space-y-3 animate-pulse">
            <div className="h-6 bg-gray-200 rounded w-1/4" />
            <div className="h-10 bg-gray-100 rounded" />
            <div className="h-10 bg-gray-100 rounded" />
          </div>
        ) : blockedIps.length === 0 ? (
          <div className="p-12 text-center">
            <Ban className="w-10 h-10 text-gray-300 mx-auto mb-3" />
            <h4 className="text-sm font-semibold text-gray-900">
              No blocked IP addresses
            </h4>
            <p className="text-xs text-gray-500 mt-1">
              There are currently no IP addresses recorded on the edge blacklist matching your search.
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs text-gray-600">
              <thead className="bg-gray-50 border-b border-gray-200 text-gray-700 font-semibold uppercase tracking-wider text-[11px]">
                <tr>
                  <th scope="col" className="py-3 px-4">IP Address</th>
                  <th scope="col" className="py-3 px-4">Reason / Threat Classification</th>
                  <th scope="col" className="py-3 px-4">Blocked By</th>
                  <th scope="col" className="py-3 px-4">Status</th>
                  <th scope="col" className="py-3 px-4">Blocked At</th>
                  <th scope="col" className="py-3 px-4">Expires</th>
                  <th scope="col" className="py-3 px-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {blockedIps.map((b) => (
                  <tr key={b.id} className="hover:bg-gray-50/80 transition-colors">
                    <td className="py-3 px-4 font-mono font-bold text-gray-900">
                      {b.ipAddress}
                    </td>
                    <td className="py-3 px-4 text-gray-700 max-w-xs truncate" title={b.reason}>
                      {b.reason}
                    </td>
                    <td className="py-3 px-4 font-mono text-gray-500 text-[11px]">
                      {b.blockedBy}
                    </td>
                    <td className="py-3 px-4">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                          b.isActive
                            ? 'bg-red-100 text-red-800 border border-red-200'
                            : 'bg-gray-100 text-gray-600'
                        }`}
                      >
                        {b.isActive ? 'Active Block' : 'Inactive / Expired'}
                      </span>
                    </td>
                    <td className="py-3 px-4 text-gray-500 text-[11px]">
                      {new Date(b.blockedAt).toLocaleString([], {
                        month: 'short',
                        day: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="py-3 px-4 text-gray-500 text-[11px]">
                      {b.expiresAt
                        ? new Date(b.expiresAt).toLocaleString([], {
                            month: 'short',
                            day: 'numeric',
                            hour: '2-digit',
                            minute: '2-digit',
                          })
                        : 'Never (Permanent)'}
                    </td>
                    <td className="py-3 px-4 text-right">
                      {b.isActive && (
                        <button
                          type="button"
                          disabled={unblockingIp === b.ipAddress}
                          onClick={() => handleUnblock(b.ipAddress)}
                          className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-emerald-700 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 rounded-lg transition-colors disabled:opacity-50"
                        >
                          <Check className="w-3.5 h-3.5" />
                          Unblock
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
