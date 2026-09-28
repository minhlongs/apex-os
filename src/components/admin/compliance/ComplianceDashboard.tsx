'use client';

import React, { useState, useEffect, useCallback } from 'react';
import {
  ShieldAlert,
  ShieldCheck,
  Ban,
  CheckCircle,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Search,
  Plus,
  Trash2,
  FileText,
  UserCheck,
  Eye,
  X,
} from 'lucide-react';

interface ComplianceDashboardProps {
  locale?: string;
}

interface PayoutHoldItem {
  id: string;
  affiliate_id: string;
  amount: number;
  currency: string;
  chain: string;
  status: string;
  compliance_status: string;
  compliance_reason: string;
  created_at: string;
  affiliate_email?: string;
  affiliate_kyc_tier?: string;
  affiliate_kyc_status?: string;
  affiliate_wallet_address?: string;
  payout_method_details?: string;
}

interface SanctionedAddressItem {
  address: string;
  chain: string;
  source: string;
  risk_score: number;
  added_at: string;
}

interface AuditLogItem {
  id: string;
  action: string;
  severity: string;
  actor_id: string | null;
  target_id: string | null;
  details: string;
  created_at: string;
}

interface SummaryKpis {
  totalHeldCents: number;
  totalHeldUsd: number;
  kycRequiredCount: number;
  complianceBlockedCount: number;
  totalCount: number;
}

export function ComplianceDashboard({ locale = 'en' }: ComplianceDashboardProps) {
  // Navigation tabs
  const [activeTab, setActiveTab] = useState<'holds' | 'sanctions' | 'audit'>('holds');

  // Holds data & filters
  const [holds, setHolds] = useState<PayoutHoldItem[]>([]);
  const [kpis, setKpis] = useState<SummaryKpis>({
    totalHeldCents: 0,
    totalHeldUsd: 0,
    kycRequiredCount: 0,
    complianceBlockedCount: 0,
    totalCount: 0,
  });
  const [holdsLoading, setHoldsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState('all');
  const [chainFilter, setChainFilter] = useState('all');
  const [searchAffiliate, setSearchAffiliate] = useState('');

  // Sanctions data & filters
  const [sanctions, setSanctions] = useState<SanctionedAddressItem[]>([]);
  const [sanctionsLoading, setSanctionsLoading] = useState(false);
  const [sanctionChainFilter, setSanctionChainFilter] = useState('all');
  const [sanctionSearch, setSanctionSearch] = useState('');

  // Audit data
  const [auditLogs, setAuditLogs] = useState<AuditLogItem[]>([]);
  const [auditLoading, setAuditLoading] = useState(false);

  // Review modal state
  const [reviewModal, setReviewModal] = useState<{
    isOpen: boolean;
    payout: PayoutHoldItem | null;
    action: 'approve' | 'reject' | 'reverify' | 'flag_address';
    reason: string;
    submitting: boolean;
  }>({
    isOpen: false,
    payout: null,
    action: 'approve',
    reason: '',
    submitting: false,
  });

  // Add sanction modal state
  const [addSanctionModal, setAddSanctionModal] = useState<{
    isOpen: boolean;
    address: string;
    chain: 'ethereum' | 'solana' | 'stellar';
    source: string;
    riskScore: number;
    submitting: boolean;
  }>({
    isOpen: false,
    address: '',
    chain: 'ethereum',
    source: '',
    riskScore: 1.0,
    submitting: false,
  });

  // Audit detail viewer modal
  const [selectedAuditLog, setSelectedAuditLog] = useState<AuditLogItem | null>(null);

  // Notifications toast
  const [notification, setNotification] = useState<{
    type: 'success' | 'error';
    message: string;
  } | null>(null);

  const showToast = (message: string, type: 'success' | 'error' = 'success') => {
    setNotification({ type, message });
    setTimeout(() => setNotification(null), 5000);
  };

  // Fetch payout holds
  const fetchHolds = useCallback(async () => {
    setHoldsLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== 'all') params.set('status', statusFilter);
      if (chainFilter !== 'all') params.set('chain', chainFilter);
      if (searchAffiliate) params.set('affiliateId', searchAffiliate);

      const res = await fetch(`/api/admin/compliance/payouts?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          setHolds(json.payouts || json.data || []);
          if (json.kpis) {
            setKpis(json.kpis);
          }
        }
      } else {
        const err = await res.json().catch(() => ({}));
        showToast(err.error || 'Failed to fetch compliance holds', 'error');
      }
    } catch {
      showToast('Network error fetching compliance holds', 'error');
    } finally {
      setHoldsLoading(false);
    }
  }, [statusFilter, chainFilter, searchAffiliate]);

  // Fetch sanctions
  const fetchSanctions = useCallback(async () => {
    setSanctionsLoading(true);
    try {
      const params = new URLSearchParams();
      if (sanctionChainFilter !== 'all') params.set('chain', sanctionChainFilter);
      if (sanctionSearch) params.set('search', sanctionSearch);

      const res = await fetch(`/api/admin/compliance/sanctions?${params.toString()}`);
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          setSanctions(json.addresses || json.data || []);
        }
      }
    } catch {
      showToast('Network error fetching sanctions watchlist', 'error');
    } finally {
      setSanctionsLoading(false);
    }
  }, [sanctionChainFilter, sanctionSearch]);

  // Fetch audit logs
  const fetchAuditLogs = useCallback(async () => {
    setAuditLoading(true);
    try {
      const res = await fetch('/api/admin/compliance/payouts?view=audit&limit=50');
      if (res.ok) {
        const json = await res.json();
        if (json.success) {
          setAuditLogs(json.data || []);
        }
      }
    } catch {
      showToast('Network error fetching compliance audit logs', 'error');
    } finally {
      setAuditLoading(false);
    }
  }, []);

  useEffect(() => {
    if (activeTab === 'holds') {
      fetchHolds();
    } else if (activeTab === 'sanctions') {
      fetchSanctions();
    } else if (activeTab === 'audit') {
      fetchAuditLogs();
    }
  }, [activeTab, fetchHolds, fetchSanctions, fetchAuditLogs]);

  // Submit Review Action
  const handleReviewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!reviewModal.payout) return;
    if (reviewModal.reason.trim().length < 5) {
      showToast('Reason must be at least 5 characters', 'error');
      return;
    }

    setReviewModal((prev) => ({ ...prev, submitting: true }));
    try {
      const payload: Record<string, any> = {
        payoutId: reviewModal.payout.id,
        action: reviewModal.action,
        reason: reviewModal.reason.trim(),
      };

      if (reviewModal.action === 'flag_address') {
        payload.chain = reviewModal.payout.chain;
        if (reviewModal.payout.affiliate_wallet_address) {
          payload.address = reviewModal.payout.affiliate_wallet_address;
        }
      }

      const res = await fetch('/api/admin/compliance/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        showToast(`Review action '${reviewModal.action}' applied successfully`);
        setReviewModal({
          isOpen: false,
          payout: null,
          action: 'approve',
          reason: '',
          submitting: false,
        });
        fetchHolds();
      } else {
        showToast(json.error || 'Failed to submit review action', 'error');
        setReviewModal((prev) => ({ ...prev, submitting: false }));
      }
    } catch {
      showToast('Network error submitting review action', 'error');
      setReviewModal((prev) => ({ ...prev, submitting: false }));
    }
  };

  // Submit Add Sanctioned Address
  const handleAddSanctionSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!addSanctionModal.address.trim()) {
      showToast('Address is required', 'error');
      return;
    }

    setAddSanctionModal((prev) => ({ ...prev, submitting: true }));
    try {
      const res = await fetch('/api/admin/compliance/sanctions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address: addSanctionModal.address.trim(),
          chain: addSanctionModal.chain,
          source: addSanctionModal.source.trim() || 'Manual Administrative Block',
          riskScore: addSanctionModal.riskScore,
        }),
      });

      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        showToast('Sanctioned address added successfully');
        setAddSanctionModal({
          isOpen: false,
          address: '',
          chain: 'ethereum',
          source: '',
          riskScore: 1.0,
          submitting: false,
        });
        fetchSanctions();
      } else {
        showToast(json.error || 'Failed to add address', 'error');
        setAddSanctionModal((prev) => ({ ...prev, submitting: false }));
      }
    } catch {
      showToast('Network error adding sanctioned address', 'error');
      setAddSanctionModal((prev) => ({ ...prev, submitting: false }));
    }
  };

  // Remove Sanctioned Address
  const handleRemoveSanction = async (address: string, chain: string) => {
    if (!confirm(`Are you sure you want to remove ${address} (${chain}) from the sanctions watchlist?`)) {
      return;
    }

    try {
      const res = await fetch('/api/admin/compliance/sanctions', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, chain, reason: 'Administrative removal' }),
      });

      const json = await res.json().catch(() => ({}));
      if (res.ok && json.success) {
        showToast('Address removed from watchlist');
        fetchSanctions();
      } else {
        showToast(json.error || 'Failed to remove address', 'error');
      }
    } catch {
      showToast('Network error removing address', 'error');
    }
  };

  return (
    <div className="space-y-6">
      {/* Toast Notification */}
      {notification && (
        <div
          className={`fixed top-4 right-4 z-50 flex items-center px-4 py-3 rounded-lg shadow-lg text-sm font-medium transition-all ${
            notification.type === 'success'
              ? 'bg-emerald-50 text-emerald-800 border border-emerald-200'
              : 'bg-rose-50 text-rose-800 border border-rose-200'
          }`}
        >
          {notification.type === 'success' ? (
            <CheckCircle className="w-5 h-5 mr-2 text-emerald-600" />
          ) : (
            <XCircle className="w-5 h-5 mr-2 text-rose-600" />
          )}
          <span>{notification.message}</span>
        </div>
      )}

      {/* Page Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 tracking-tight flex items-center gap-2">
            <ShieldCheck className="w-7 h-7 text-indigo-600" />
            Compliance & Regulatory Review
          </h1>
          <p className="mt-1 text-sm text-gray-500">
            Inspect tiered KYC payout holds, manage AML sanctions watchlists, and record immutable audit decisions.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              if (activeTab === 'holds') fetchHolds();
              if (activeTab === 'sanctions') fetchSanctions();
              if (activeTab === 'audit') fetchAuditLogs();
            }}
            className="inline-flex items-center px-3 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none"
          >
            <RefreshCw
              className={`w-4 h-4 mr-2 ${
                holdsLoading || sanctionsLoading || auditLoading ? 'animate-spin' : ''
              }`}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* KPI Metric Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Total Held Payouts
            </span>
            <span className="p-2 rounded-lg bg-indigo-50 text-indigo-600">
              <FileText className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            ${kpis.totalHeldUsd.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            {kpis.totalCount} payout(s) currently held
          </p>
        </div>

        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              KYC Required Holds
            </span>
            <span className="p-2 rounded-lg bg-amber-50 text-amber-600">
              <UserCheck className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {kpis.kycRequiredCount}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Exceeding $500 unverified limit
          </p>
        </div>

        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Compliance Blocked
            </span>
            <span className="p-2 rounded-lg bg-rose-50 text-rose-600">
              <Ban className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {kpis.complianceBlockedCount}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            OFAC / Sanctioned wallet matches
          </p>
        </div>

        <div className="bg-white p-5 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-gray-500">
              Sanctions Database
            </span>
            <span className="p-2 rounded-lg bg-slate-50 text-slate-600">
              <ShieldAlert className="w-5 h-5" />
            </span>
          </div>
          <div className="mt-2 text-2xl font-bold text-gray-900">
            {sanctions.length > 0 ? sanctions.length : '10+'}
          </div>
          <p className="mt-1 text-xs text-gray-500">
            Monitored OFAC / high-risk entities
          </p>
        </div>
      </div>

      {/* Tabs Navigation */}
      <div className="border-b border-gray-200 bg-white rounded-t-xl px-4 pt-2 shadow-sm">
        <nav className="flex space-x-8" aria-label="Tabs">
          <button
            onClick={() => setActiveTab('holds')}
            className={`py-3 px-1 border-b-2 font-medium text-sm inline-flex items-center gap-2 ${
              activeTab === 'holds'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <AlertTriangle className="w-4 h-4" />
            Payout Holds
            {kpis.totalCount > 0 && (
              <span className="ml-1 px-2 py-0.5 text-xs rounded-full bg-amber-100 text-amber-800">
                {kpis.totalCount}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('sanctions')}
            className={`py-3 px-1 border-b-2 font-medium text-sm inline-flex items-center gap-2 ${
              activeTab === 'sanctions'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <ShieldAlert className="w-4 h-4" />
            Sanctions Watchlist
          </button>

          <button
            onClick={() => setActiveTab('audit')}
            className={`py-3 px-1 border-b-2 font-medium text-sm inline-flex items-center gap-2 ${
              activeTab === 'audit'
                ? 'border-indigo-600 text-indigo-600'
                : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
            }`}
          >
            <FileText className="w-4 h-4" />
            Compliance Audit Trail
          </button>
        </nav>
      </div>

      {/* TAB 1: PAYOUT HOLDS */}
      {activeTab === 'holds' && (
        <div className="bg-white rounded-b-xl border border-t-0 border-gray-200 shadow-sm p-5 space-y-4">
          {/* Filters Bar */}
          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
              <input
                type="text"
                placeholder="Filter by Affiliate ID..."
                value={searchAffiliate}
                onChange={(e) => setSearchAffiliate(e.target.value)}
                className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
              />
            </div>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
            >
              <option value="all">All Compliance Statuses</option>
              <option value="kyc_required">KYC Required ($500+)</option>
              <option value="compliance_blocked">Compliance Blocked (Sanctions)</option>
            </select>
            <select
              value={chainFilter}
              onChange={(e) => setChainFilter(e.target.value)}
              className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
            >
              <option value="all">All Chains</option>
              <option value="ethereum">Ethereum (USDC)</option>
              <option value="solana">Solana (SPL)</option>
              <option value="stellar">Stellar (USDC)</option>
            </select>
          </div>

          {/* Table */}
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Payout ID</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Affiliate</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">Amount</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Chain & Recipient</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Compliance Reason</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">Status</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {holdsLoading ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      <RefreshCw className="w-5 h-5 mx-auto animate-spin mb-2 text-indigo-600" />
                      Loading compliance holds...
                    </td>
                  </tr>
                ) : holds.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-4 py-8 text-center text-gray-500">
                      No held payouts found matching the filter criteria.
                    </td>
                  </tr>
                ) : (
                  holds.map((payout) => {
                    const isKycReq =
                      payout.compliance_status === 'kyc_required' || payout.status === 'kyc_required';
                    const isBlocked =
                      payout.compliance_status === 'compliance_blocked' ||
                      payout.status === 'compliance_blocked';

                    return (
                      <tr key={payout.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 font-mono text-xs text-gray-700">
                          {payout.id.slice(0, 10)}...
                        </td>
                        <td className="px-4 py-3">
                          <div className="font-medium text-gray-900">
                            {payout.affiliate_email || payout.affiliate_id}
                          </div>
                          <div className="text-xs text-gray-500 flex items-center gap-1 mt-0.5">
                            <span className="font-mono text-[11px]">{payout.affiliate_id.slice(0, 8)}</span>
                            {payout.affiliate_kyc_tier && (
                              <span className="px-1.5 py-0.2 rounded bg-gray-100 text-[10px] uppercase font-semibold">
                                {payout.affiliate_kyc_tier.replace('tier', 'T')}
                              </span>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-right font-semibold text-gray-900">
                          ${payout.amount.toFixed(2)}
                        </td>
                        <td className="px-4 py-3">
                          <span className="capitalize font-medium text-gray-800">{payout.chain}</span>
                          {payout.affiliate_wallet_address && (
                            <div className="font-mono text-xs text-gray-500 truncate max-w-[140px]">
                              {payout.affiliate_wallet_address}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600 max-w-xs truncate">
                          {payout.compliance_reason || 'KYC limit exceeded'}
                        </td>
                        <td className="px-4 py-3 text-center">
                          {isKycReq && (
                            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">
                              KYC Required
                            </span>
                          )}
                          {isBlocked && (
                            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-100 text-rose-800">
                              Blocked (Sanctions)
                            </span>
                          )}
                          {!isKycReq && !isBlocked && (
                            <span className="px-2.5 py-1 rounded-full text-xs font-semibold bg-gray-100 text-gray-700 capitalize">
                              {payout.compliance_status || payout.status}
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() =>
                                setReviewModal({
                                  isOpen: true,
                                  payout,
                                  action: 'approve',
                                  reason: '',
                                  submitting: false,
                                })
                              }
                              className="px-2 py-1 text-xs font-medium rounded bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                              title="Approve manual override"
                            >
                              Approve
                            </button>
                            <button
                              onClick={() =>
                                setReviewModal({
                                  isOpen: true,
                                  payout,
                                  action: 'reject',
                                  reason: '',
                                  submitting: false,
                                })
                              }
                              className="px-2 py-1 text-xs font-medium rounded bg-rose-50 text-rose-700 hover:bg-rose-100"
                              title="Reject payout"
                            >
                              Reject
                            </button>
                            <button
                              onClick={() =>
                                setReviewModal({
                                  isOpen: true,
                                  payout,
                                  action: 'reverify',
                                  reason: '',
                                  submitting: false,
                                })
                              }
                              className="px-2 py-1 text-xs font-medium rounded bg-blue-50 text-blue-700 hover:bg-blue-100"
                              title="Request re-verification"
                            >
                              Re-verify
                            </button>
                            <button
                              onClick={() =>
                                setReviewModal({
                                  isOpen: true,
                                  payout,
                                  action: 'flag_address',
                                  reason: '',
                                  submitting: false,
                                })
                              }
                              className="px-2 py-1 text-xs font-medium rounded bg-amber-50 text-amber-700 hover:bg-amber-100"
                              title="Flag recipient address"
                            >
                              Flag
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 2: SANCTIONS WATCHLIST */}
      {activeTab === 'sanctions' && (
        <div className="bg-white rounded-b-xl border border-t-0 border-gray-200 shadow-sm p-5 space-y-4">
          <div className="flex flex-col sm:flex-row justify-between gap-3">
            <div className="flex flex-1 gap-2">
              <div className="relative flex-1">
                <Search className="w-4 h-4 absolute left-3 top-3 text-gray-400" />
                <input
                  type="text"
                  placeholder="Search by address or source..."
                  value={sanctionSearch}
                  onChange={(e) => setSanctionSearch(e.target.value)}
                  className="w-full pl-9 pr-3 py-2 border border-gray-300 rounded-md text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500"
                />
              </div>
              <select
                value={sanctionChainFilter}
                onChange={(e) => setSanctionChainFilter(e.target.value)}
                className="border border-gray-300 rounded-md px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-indigo-500 bg-white"
              >
                <option value="all">All Chains</option>
                <option value="ethereum">Ethereum</option>
                <option value="solana">Solana</option>
                <option value="stellar">Stellar</option>
              </select>
            </div>
            <button
              onClick={() =>
                setAddSanctionModal({
                  isOpen: true,
                  address: '',
                  chain: 'ethereum',
                  source: '',
                  riskScore: 1.0,
                  submitting: false,
                })
              }
              className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-indigo-600 hover:bg-indigo-700"
            >
              <Plus className="w-4 h-4 mr-2" />
              Add Sanctioned Address
            </button>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Chain</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Address</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Source / Reason</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">Risk Score</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Added At</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {sanctionsLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      <RefreshCw className="w-5 h-5 mx-auto animate-spin mb-2 text-indigo-600" />
                      Loading sanctions watchlist...
                    </td>
                  </tr>
                ) : sanctions.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      No sanctioned addresses found.
                    </td>
                  </tr>
                ) : (
                  sanctions.map((item, idx) => (
                    <tr key={`${item.chain}_${item.address}_${idx}`} className="hover:bg-gray-50">
                      <td className="px-4 py-3 font-semibold capitalize text-gray-800">
                        {item.chain}
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-gray-900 break-all max-w-sm">
                        {item.address}
                      </td>
                      <td className="px-4 py-3 text-gray-700">{item.source}</td>
                      <td className="px-4 py-3 text-center">
                        <span className="px-2 py-0.5 rounded text-xs font-semibold bg-rose-100 text-rose-800">
                          {(item.risk_score * 100).toFixed(0)}%
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-gray-500">{item.added_at}</td>
                      <td className="px-4 py-3 text-right">
                        <button
                          onClick={() => handleRemoveSanction(item.address, item.chain)}
                          className="text-rose-600 hover:text-rose-800 p-1 rounded hover:bg-rose-50"
                          title="Remove from sanctions list"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB 3: COMPLIANCE AUDIT TRAIL */}
      {activeTab === 'audit' && (
        <div className="bg-white rounded-b-xl border border-t-0 border-gray-200 shadow-sm p-5 space-y-4">
          <div className="flex justify-between items-center">
            <h2 className="text-sm font-semibold text-gray-700 uppercase tracking-wider">
              Immutable Compliance Audit Ledger
            </h2>
            <span className="text-xs text-gray-500">
              Protected by SQLite BEFORE UPDATE and BEFORE DELETE triggers
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-sm">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Timestamp</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Action</th>
                  <th className="px-4 py-3 text-center font-semibold text-gray-600">Severity</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Actor</th>
                  <th className="px-4 py-3 text-left font-semibold text-gray-600">Target</th>
                  <th className="px-4 py-3 text-right font-semibold text-gray-600">Details</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100 bg-white">
                {auditLoading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      <RefreshCw className="w-5 h-5 mx-auto animate-spin mb-2 text-indigo-600" />
                      Loading compliance audit logs...
                    </td>
                  </tr>
                ) : auditLogs.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-gray-500">
                      No audit records found.
                    </td>
                  </tr>
                ) : (
                  auditLogs.map((log) => {
                    const sevColor =
                      log.severity === 'critical'
                        ? 'bg-rose-100 text-rose-800'
                        : log.severity === 'high'
                        ? 'bg-orange-100 text-orange-800'
                        : log.severity === 'medium'
                        ? 'bg-amber-100 text-amber-800'
                        : 'bg-emerald-100 text-emerald-800';

                    return (
                      <tr key={log.id} className="hover:bg-gray-50">
                        <td className="px-4 py-3 text-xs text-gray-500 whitespace-nowrap">
                          {log.created_at}
                        </td>
                        <td className="px-4 py-3 font-medium text-gray-900 font-mono text-xs">
                          {log.action}
                        </td>
                        <td className="px-4 py-3 text-center">
                          <span className={`px-2 py-0.5 rounded text-xs font-semibold uppercase ${sevColor}`}>
                            {log.severity}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600 font-mono">
                          {log.actor_id || 'system'}
                        </td>
                        <td className="px-4 py-3 text-xs text-gray-600 font-mono truncate max-w-xs">
                          {log.target_id || 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-right">
                          <button
                            onClick={() => setSelectedAuditLog(log)}
                            className="inline-flex items-center text-xs text-indigo-600 hover:text-indigo-800 font-medium"
                          >
                            <Eye className="w-3.5 h-3.5 mr-1" />
                            Inspect
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Review Action Modal */}
      {reviewModal.isOpen && reviewModal.payout && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
              <h3 className="font-semibold text-gray-900 capitalize">
                {reviewModal.action === 'approve'
                  ? 'Manual Approval Override'
                  : reviewModal.action === 'reject'
                  ? 'Reject Compliance Hold'
                  : reviewModal.action === 'reverify'
                  ? 'Request Re-verification'
                  : 'Flag Recipient Address'}
              </h3>
              <button
                onClick={() => setReviewModal((prev) => ({ ...prev, isOpen: false }))}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleReviewSubmit} className="p-6 space-y-4">
              <div className="text-xs text-gray-500 bg-gray-50 p-3 rounded-lg space-y-1">
                <div>
                  <span className="font-semibold text-gray-700">Payout ID:</span>{' '}
                  <span className="font-mono">{reviewModal.payout.id}</span>
                </div>
                <div>
                  <span className="font-semibold text-gray-700">Amount:</span> $
                  {reviewModal.payout.amount.toFixed(2)} USD ({reviewModal.payout.chain})
                </div>
                <div>
                  <span className="font-semibold text-gray-700">Affiliate:</span>{' '}
                  {reviewModal.payout.affiliate_email || reviewModal.payout.affiliate_id}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Review Justification Reason <span className="text-rose-500">*</span>
                </label>
                <textarea
                  rows={3}
                  required
                  placeholder="Provide compliance justification (minimum 5 characters)..."
                  value={reviewModal.reason}
                  onChange={(e) => setReviewModal((prev) => ({ ...prev, reason: e.target.value }))}
                  className="w-full border border-gray-300 rounded-md p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
                <span className="text-[11px] text-gray-400">
                  Will be recorded in the immutable compliance audit trail.
                </span>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setReviewModal((prev) => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={reviewModal.submitting || reviewModal.reason.trim().length < 5}
                  className="px-4 py-2 rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {reviewModal.submitting ? 'Submitting...' : 'Confirm Action'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Sanctioned Address Modal */}
      {addSanctionModal.isOpen && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-md w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
              <h3 className="font-semibold text-gray-900">Add Sanctioned Address</h3>
              <button
                onClick={() => setAddSanctionModal((prev) => ({ ...prev, isOpen: false }))}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <form onSubmit={handleAddSanctionSubmit} className="p-6 space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Blockchain Chain
                </label>
                <select
                  value={addSanctionModal.chain}
                  onChange={(e) =>
                    setAddSanctionModal((prev) => ({
                      ...prev,
                      chain: e.target.value as any,
                    }))
                  }
                  className="w-full border border-gray-300 rounded-md p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 bg-white"
                >
                  <option value="ethereum">Ethereum (0x...)</option>
                  <option value="solana">Solana (Base58)</option>
                  <option value="stellar">Stellar (G...)</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Wallet / Contract Address <span className="text-rose-500">*</span>
                </label>
                <input
                  type="text"
                  required
                  placeholder="e.g. 0x123... or Base58 public key"
                  value={addSanctionModal.address}
                  onChange={(e) =>
                    setAddSanctionModal((prev) => ({ ...prev, address: e.target.value }))
                  }
                  className="w-full border border-gray-300 rounded-md p-2.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">
                  Source / Tag / Reason
                </label>
                <input
                  type="text"
                  placeholder="e.g. OFAC SDN List, Mixer Contract"
                  value={addSanctionModal.source}
                  onChange={(e) =>
                    setAddSanctionModal((prev) => ({ ...prev, source: e.target.value }))
                  }
                  className="w-full border border-gray-300 rounded-md p-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setAddSanctionModal((prev) => ({ ...prev, isOpen: false }))}
                  className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={addSanctionModal.submitting || !addSanctionModal.address.trim()}
                  className="px-4 py-2 rounded-md text-sm font-medium text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50"
                >
                  {addSanctionModal.submitting ? 'Adding...' : 'Add to Sanctions List'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Audit Detail Inspector Modal */}
      {selectedAuditLog && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl max-w-lg w-full shadow-2xl overflow-hidden animate-in fade-in zoom-in-95">
            <div className="px-6 py-4 border-b border-gray-200 flex justify-between items-center bg-gray-50">
              <h3 className="font-semibold text-gray-900">Audit Record Inspector</h3>
              <button
                onClick={() => setSelectedAuditLog(null)}
                className="text-gray-400 hover:text-gray-600"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-xs">
                <div>
                  <span className="text-gray-500">ID:</span>{' '}
                  <span className="font-mono text-gray-800">{selectedAuditLog.id}</span>
                </div>
                <div>
                  <span className="text-gray-500">Action:</span>{' '}
                  <span className="font-semibold text-gray-900">{selectedAuditLog.action}</span>
                </div>
                <div>
                  <span className="text-gray-500">Severity:</span>{' '}
                  <span className="uppercase font-semibold text-gray-800">{selectedAuditLog.severity}</span>
                </div>
                <div>
                  <span className="text-gray-500">Timestamp:</span>{' '}
                  <span className="text-gray-800">{selectedAuditLog.created_at}</span>
                </div>
                <div>
                  <span className="text-gray-500">Actor:</span>{' '}
                  <span className="font-mono text-gray-800">{selectedAuditLog.actor_id || 'system'}</span>
                </div>
                <div>
                  <span className="text-gray-500">Target:</span>{' '}
                  <span className="font-mono text-gray-800">{selectedAuditLog.target_id || 'N/A'}</span>
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-gray-600 mb-1">
                  Structured Payload Details:
                </label>
                <pre className="p-3 bg-gray-900 text-emerald-400 font-mono text-xs rounded-lg overflow-x-auto max-h-60">
                  {(() => {
                    try {
                      return JSON.stringify(JSON.parse(selectedAuditLog.details), null, 2);
                    } catch {
                      return selectedAuditLog.details;
                    }
                  })()}
                </pre>
              </div>
            </div>
            <div className="px-6 py-3 bg-gray-50 border-t border-gray-200 flex justify-end">
              <button
                onClick={() => setSelectedAuditLog(null)}
                className="px-4 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-100"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default ComplianceDashboard;
