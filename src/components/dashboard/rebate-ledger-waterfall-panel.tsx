'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clock,
  FileCheck2,
  GitBranch,
  Lock,
  RefreshCw,
  Shield,
  Wallet,
} from 'lucide-react';
import type {
  PortalBalanceBucketSummary,
  PortalBatchFeedItem,
  PortalLedgerStateBucket,
  TwoLevelPartnerTreeSummary,
} from '@/app/api/affiliate/ledger-summary/route';
import type { ProofOfRebateRecord } from '@/lib/ledger/proof-of-rebate';
import { formatLedgerUnitsToUsd } from '@/lib/ledger/units';

export interface RebateLedgerWaterfallPanelProps {
  locale?: string;
  refreshTrigger?: number;
}

interface LedgerSummaryApiPayload {
  success?: boolean;
  balances?: PortalBalanceBucketSummary;
  recentBatches?: PortalBatchFeedItem[];
  proofsOfRebate?: ProofOfRebateRecord[];
  partnerTree?: TwoLevelPartnerTreeSummary;
  error?: string;
}

function formatHoldRemaining(holdUntilIso: string | null, nowMs: number): string {
  if (!holdUntilIso) {
    return '—';
  }
  const targetMs = Date.parse(holdUntilIso);
  if (Number.isNaN(targetMs)) {
    return '—';
  }
  const diffMs = targetMs - nowMs;
  if (diffMs <= 0) {
    return 'Matured (Ready)';
  }
  const totalMinutes = Math.trunc(diffMs / 60000);
  const days = Math.trunc(totalMinutes / 1440);
  const hours = Math.trunc((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${days}d ${hours}h left`;
  }
  return `${hours}h ${minutes}m left`;
}

function formatUnitsStringAsUsd(rawUnits: string): string {
  try {
    return formatLedgerUnitsToUsd(BigInt(rawUnits), 4);
  } catch {
    return '0.0000';
  }
}

function renderStatePill(bucket: PortalLedgerStateBucket) {
  switch (bucket) {
    case 'INFLIGHT':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-stitch-amber/15 px-2.5 py-0.5 text-xs font-medium text-stitch-amber">
          <Clock className="h-3 w-3" />
          INFLIGHT (T+7)
        </span>
      );
    case 'AVAILABLE':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-stitch-emerald/15 px-2.5 py-0.5 text-xs font-medium text-stitch-emerald">
          <CheckCircle2 className="h-3 w-3" />
          AVAILABLE
        </span>
      );
    case 'LOCKED_WITHDRAWAL':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-stitch-indigo/20 px-2.5 py-0.5 text-xs font-medium text-stitch-indigo">
          <Lock className="h-3 w-3" />
          LOCKED_WITHDRAWAL
        </span>
      );
    case 'SETTLED':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-stitch-violet/20 px-2.5 py-0.5 text-xs font-medium text-stitch-violet">
          <Wallet className="h-3 w-3" />
          SETTLED
        </span>
      );
    case 'CLAWBACK':
      return (
        <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-400">
          <AlertTriangle className="h-3 w-3" />
          CLAWBACK
        </span>
      );
  }
}

export function RebateLedgerWaterfallPanel({
  refreshTrigger = 0,
}: RebateLedgerWaterfallPanelProps) {
  const [balances, setBalances] = useState<PortalBalanceBucketSummary | null>(null);
  const [recentBatches, setRecentBatches] = useState<PortalBatchFeedItem[]>([]);
  const [proofs, setProofs] = useState<ProofOfRebateRecord[]>([]);
  const [partnerTree, setPartnerTree] = useState<TwoLevelPartnerTreeSummary | null>(null);
  const [expandedProofBatchId, setExpandedProofBatchId] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const fetchSummary = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/affiliate/ledger-summary', { credentials: 'include' });
      const data = (await res.json()) as LedgerSummaryApiPayload;
      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? 'Failed to load atomic ledger summary.');
        return;
      }
      setBalances(data.balances ?? null);
      setRecentBatches(data.recentBatches ?? []);
      setProofs(data.proofsOfRebate ?? []);
      setPartnerTree(data.partnerTree ?? null);
      setErrorMsg(null);
    } catch {
      setErrorMsg('Network error while loading atomic ledger summary.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchSummary();
  }, [fetchSummary, refreshTrigger]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 60000);
    return () => clearInterval(timer);
  }, []);

  const stateCards = [
    {
      testId: 'ledger-card-inflight',
      title: 'T+7 In-Flight',
      usd: balances?.inflightUsd ?? '0.00',
      exactUsd: balances?.inflightUsdExact ?? '0.00000000',
      subtitle: 'Partner clawback hold window (7 days)',
      accent: 'text-stitch-amber',
    },
    {
      testId: 'ledger-card-available',
      title: 'Available USDC',
      usd: balances?.availableUsd ?? '0.00',
      exactUsd: balances?.availableUsdExact ?? '0.00000000',
      subtitle: `Min payout $${balances?.minimumWithdrawalUsd ?? '10.00'} USDC`,
      accent: 'text-stitch-emerald',
    },
    {
      testId: 'ledger-card-locked',
      title: 'Locked Withdrawal',
      usd: balances?.lockedWithdrawalUsd ?? '0.00',
      exactUsd: balances?.lockedWithdrawalUsdExact ?? '0.00000000',
      subtitle: 'Escrowed for Turnkey MPC broadcast',
      accent: 'text-stitch-indigo',
    },
    {
      testId: 'ledger-card-settled',
      title: 'Lifetime Settled',
      usd: balances?.settledUsd ?? '0.00',
      exactUsd: balances?.settledUsdExact ?? '0.00000000',
      subtitle: 'Disbursed on Stellar / Arbitrum / Base',
      accent: 'text-stitch-violet',
    },
  ];

  return (
    <div className="space-y-6">
      {/* 1. 4 Exact Integer Ledger State Cards */}
      <section aria-label="Atomic Double-Entry Balance Buckets" className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-lg font-semibold text-stitch-primary">
              Atomic Rebate Ledger (10^-8 USD Integer Precision)
            </h2>
            <p className="text-xs text-stitch-muted">
              Cash-basis double-entry balances reconciled against verified partner wallet deposits.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void fetchSummary()}
            disabled={loading}
            className="inline-flex items-center gap-1.5 rounded-xl border border-stitch-border bg-stitch-surface px-3 py-1.5 text-xs text-stitch-primary hover:border-stitch-indigo disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        </div>

        {errorMsg && (
          <div
            role="alert"
            className="rounded-xl border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300 flex items-center gap-2"
          >
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{errorMsg}</span>
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {stateCards.map((card) => (
            <div
              key={card.testId}
              data-testid={card.testId}
              className="bg-stitch-surface border border-stitch-border rounded-2xl p-5"
            >
              <p className="text-xs font-medium uppercase tracking-wider text-stitch-muted">
                {card.title}
              </p>
              <p className={`mt-2 text-2xl font-bold font-mono ${card.accent}`}>
                ${card.usd}
              </p>
              <p className="mt-1 text-[11px] font-mono text-stitch-muted" title="Exact 10^-8 USD">
                Exact: ${card.exactUsd}
              </p>
              <p className="mt-2 text-xs text-stitch-muted">{card.subtitle}</p>
            </div>
          ))}
        </div>
      </section>

      {/* 2. T+7 Countdown & Settlement Feed */}
      <section
        aria-labelledby="settlement-feed-heading"
        className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 space-y-4"
      >
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
          <div>
            <h3 id="settlement-feed-heading" className="text-base font-semibold text-stitch-primary">
              T+7 Maturation Countdown & On-Chain Settlement Feed
            </h3>
            <p className="text-xs text-stitch-muted">
              Partner commissions mature 7 days after verified cash collection to absorb exchange clawbacks.
            </p>
          </div>
          {balances && balances.clawedBackUnits !== '0' && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-3 py-1 text-xs font-mono text-red-300">
              Clawbacks Adjusted: -${balances.clawedBackUsd}
            </span>
          )}
        </div>

        <div className="overflow-x-auto border border-stitch-border rounded-xl">
          <table className="w-full text-left text-sm">
            <thead className="bg-black/20 text-xs uppercase text-stitch-muted border-b border-stitch-border">
              <tr>
                <th className="px-4 py-2.5">State</th>
                <th className="px-4 py-2.5">Exchange / Masked UID</th>
                <th className="px-4 py-2.5">Amount (USDC)</th>
                <th className="px-4 py-2.5">T+7 Hold / Tx Hash</th>
                <th className="px-4 py-2.5">Created</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border">
              {loading ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-stitch-muted">
                    Loading journal batches...
                  </td>
                </tr>
              ) : recentBatches.length === 0 ? (
                <tr>
                  <td colSpan={5} className="px-4 py-6 text-center text-xs text-stitch-muted">
                    No commission or settlement batches recorded yet.
                  </td>
                </tr>
              ) : (
                recentBatches.map((batch) => (
                  <tr key={batch.batchId} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3">{renderStatePill(batch.stateBucket)}</td>
                    <td className="px-4 py-3 text-xs">
                      <span className="font-semibold uppercase text-stitch-primary">
                        {batch.exchange ?? 'TREASURY'}
                      </span>
                      {batch.maskedTraderUid && (
                        <span className="ml-2 font-mono text-stitch-muted">
                          ({batch.maskedTraderUid})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-stitch-primary">
                      {batch.direction === 'DEBIT' ? '-' : '+'}${batch.userAmountUsd}
                      {batch.clawedBackUnits !== '0' && (
                        <span className="ml-1.5 text-[11px] text-red-400">
                          (clawback -${batch.clawedBackUsd})
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-stitch-muted">
                      {batch.settledTxHash ? (
                        <span className="text-stitch-emerald" title={batch.settledTxHash}>
                          Tx: {batch.settledTxHash.slice(0, 10)}...{batch.settledTxHash.slice(-6)}
                        </span>
                      ) : batch.stateBucket === 'INFLIGHT' ? (
                        <span className="text-stitch-amber">
                          {formatHoldRemaining(batch.holdUntil, nowMs)}
                        </span>
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs text-stitch-muted">
                      {batch.createdAt.slice(0, 10)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      {/* 3. Cryptographic B2B Proof-of-Rebate Inspector + 4. Strictly 2-Level Partner Tree */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Proof-of-Rebate Drawer/Inspector */}
        <section
          aria-labelledby="proof-of-rebate-heading"
          className="lg:col-span-7 bg-stitch-surface border border-stitch-border rounded-2xl p-6 space-y-4"
        >
          <div className="flex items-center gap-2">
            <FileCheck2 className="h-5 w-5 text-stitch-emerald" />
            <div>
              <h3 id="proof-of-rebate-heading" className="text-base font-semibold text-stitch-primary">
                B2B Cryptographic Proof-of-Rebate Inspector
              </h3>
              <p className="text-xs text-stitch-muted">
                SHA-256 anchored R2 trade evidence & wallet reconciliation digests (zero raw PII).
              </p>
            </div>
          </div>

          {proofs.length === 0 ? (
            <p className="text-xs text-stitch-muted py-4">
              Verified Proof-of-Rebate anchors will appear here as partner trades reconcile.
            </p>
          ) : (
            <div className="space-y-2.5">
              {proofs.map((proof) => {
                const isOpen = expandedProofBatchId === proof.batchId;
                return (
                  <div
                    key={proof.batchId}
                    className="rounded-xl border border-stitch-border bg-black/20 overflow-hidden"
                  >
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedProofBatchId(isOpen ? null : proof.batchId)
                      }
                      className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-white/[0.02]"
                    >
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-xs">
                          <span className="font-semibold uppercase text-stitch-primary">
                            {proof.exchange}
                          </span>
                          <span className="font-mono text-stitch-muted">
                            UID {proof.maskedTraderUid}
                          </span>
                          <span className="rounded bg-stitch-emerald/15 px-1.5 py-0.5 text-[10px] font-mono text-stitch-emerald">
                            {proof.reconciliation.status}
                          </span>
                        </div>
                        <p className="text-[11px] font-mono text-stitch-muted">
                          Proof SHA-256: {proof.proofDigestSha256.slice(0, 18)}...
                        </p>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="font-mono text-sm font-semibold text-stitch-emerald">
                          Gross ${proof.grossCommissionUsd}
                        </span>
                        {isOpen ? (
                          <ChevronUp className="h-4 w-4 text-stitch-muted" />
                        ) : (
                          <ChevronDown className="h-4 w-4 text-stitch-muted" />
                        )}
                      </div>
                    </button>

                    {isOpen && (
                      <div
                        data-testid={`proof-drawer-${proof.batchId}`}
                        className="px-4 pb-4 pt-2 border-t border-stitch-border text-xs space-y-2.5 font-mono"
                      >
                        <div className="grid grid-cols-2 gap-2 text-[11px]">
                          <div>
                            <span className="text-stitch-muted">Trader Cashback:</span>{' '}
                            <span className="text-stitch-primary">
                              ${formatUnitsStringAsUsd(proof.waterfallUnits.traderCashbackUnits)}
                            </span>
                          </div>
                          <div>
                            <span className="text-stitch-muted">L1 Affiliate:</span>{' '}
                            <span className="text-stitch-primary">
                              ${formatUnitsStringAsUsd(proof.waterfallUnits.l1AffiliateCommissionUnits)}
                            </span>
                          </div>
                          <div>
                            <span className="text-stitch-muted">L2 B2B Override:</span>{' '}
                            <span className="text-stitch-primary">
                              ${formatUnitsStringAsUsd(proof.waterfallUnits.b2bAgencyOverrideUnits)}
                            </span>
                          </div>
                          <div>
                            <span className="text-stitch-muted">Clawback Reserve:</span>{' '}
                            <span className="text-stitch-amber">
                              ${formatUnitsStringAsUsd(proof.waterfallUnits.clawbackReserveUnits)}
                            </span>
                          </div>
                        </div>

                        <div className="space-y-1 text-[11px] text-stitch-muted break-all border-t border-stitch-border pt-2">
                          <p>
                            <span className="text-stitch-primary">R2 Evidence SHA-256:</span>{' '}
                            {proof.evidence.payloadSha256}
                          </p>
                          <p>
                            <span className="text-stitch-primary">Wallet Recon SHA-256:</span>{' '}
                            {proof.reconciliation.walletPayloadSha256}
                          </p>
                          <p>
                            <span className="text-stitch-primary">Proof Digest SHA-256:</span>{' '}
                            {proof.proofDigestSha256}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </section>

        {/* Strictly 2-Level Partner Tree Summary */}
        <section
          aria-labelledby="two-level-partner-tree-heading"
          className="lg:col-span-5 bg-stitch-surface border border-stitch-border rounded-2xl p-6 space-y-4"
        >
          <div className="flex items-start justify-between gap-2">
            <div className="flex items-center gap-2">
              <GitBranch className="h-5 w-5 text-stitch-indigo" />
              <div>
                <h3
                  id="two-level-partner-tree-heading"
                  className="text-base font-semibold text-stitch-primary"
                >
                  2-Level B2B Partner Hierarchy
                </h3>
                <p className="text-xs text-stitch-muted">
                  Strictly capped at L1 Direct + L2 Sub-Affiliate (No L3+ MLM).
                </p>
              </div>
            </div>
            <span className="inline-flex items-center gap-1 rounded-full border border-stitch-indigo/30 bg-stitch-indigo/10 px-2.5 py-0.5 text-[11px] font-mono text-stitch-indigo">
              <Shield className="h-3 w-3" />
              MAX L2
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div
              data-testid="partner-tier-l1"
              className="rounded-xl border border-stitch-border bg-black/20 p-3.5"
            >
              <p className="text-xs text-stitch-muted">L1 Direct Referrals</p>
              <p className="text-xl font-bold font-mono text-stitch-primary mt-1">
                {partnerTree?.l1DirectCount ?? 0}
              </p>
              <p className="text-xs font-mono text-stitch-emerald mt-1">
                +${partnerTree?.l1OverrideEarnedUsd ?? '0.00'}
              </p>
            </div>

            <div
              data-testid="partner-tier-l2"
              className="rounded-xl border border-stitch-border bg-black/20 p-3.5"
            >
              <p className="text-xs text-stitch-muted">L2 B2B Sub-Affiliates</p>
              <p className="text-xl font-bold font-mono text-stitch-primary mt-1">
                {partnerTree?.l2SubAffiliateCount ?? 0}
              </p>
              <p className="text-xs font-mono text-stitch-indigo mt-1">
                +${partnerTree?.l2B2bOverrideEarnedUsd ?? '0.00'}
              </p>
            </div>
          </div>

          <div className="border border-stitch-border rounded-xl overflow-hidden">
            <table className="w-full text-left text-xs">
              <thead className="bg-black/20 uppercase text-stitch-muted border-b border-stitch-border">
                <tr>
                  <th className="px-3 py-2">Partner Ref</th>
                  <th className="px-3 py-2">Tier</th>
                  <th className="px-3 py-2">Joined</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-stitch-border">
                {!partnerTree || partnerTree.nodes.length === 0 ? (
                  <tr>
                    <td colSpan={3} className="px-3 py-4 text-center text-stitch-muted">
                      No L1 or L2 partner accounts attributed yet.
                    </td>
                  </tr>
                ) : (
                  partnerTree.nodes.slice(0, 8).map((node) => (
                    <tr key={node.partnerId}>
                      <td className="px-3 py-2 font-mono text-stitch-primary">
                        {node.maskedPartnerRef}
                      </td>
                      <td className="px-3 py-2">
                        <span className="rounded bg-stitch-indigo/15 px-2 py-0.5 font-mono text-stitch-indigo">
                          L{node.level}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-stitch-muted">
                        {node.joinedAt ? node.joinedAt.slice(0, 10) : '—'}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    </div>
  );
}

export default RebateLedgerWaterfallPanel;
