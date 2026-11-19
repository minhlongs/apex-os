'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Info,
  Loader2,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import type {
  AllowedUidExchange,
  BoundExchangeUidItem,
  UidVerificationStatus,
} from '@/app/api/affiliate/uids/route';
import type { AffiliateShortLinkItem } from '@/app/api/affiliate/short-links/route';

export interface NonCustodialUidPanelProps {
  locale?: string;
  shortLinks?: AffiliateShortLinkItem[];
  onUidMutated?: () => void;
}

const EXCHANGE_OPTIONS: ReadonlyArray<{
  value: AllowedUidExchange;
  label: string;
  defaultShadow: boolean;
}> = [
  { value: 'bybit', label: 'Bybit (V5 Affiliate API)', defaultShadow: false },
  { value: 'okx', label: 'OKX (Affiliate Rebate v5)', defaultShadow: false },
  { value: 'bitget', label: 'Bitget (Partner Rebate)', defaultShadow: false },
  { value: 'kucoin', label: 'KuCoin (30d Shadow Audit)', defaultShadow: true },
  { value: 'gateio', label: 'Gate.io (30d Shadow Audit)', defaultShadow: true },
];

const PARTNER_EXCHANGE_UID_STRUCTURE_REGEX =
  /^[A-Za-z0-9](?:[A-Za-z0-9]|[_-](?=[A-Za-z0-9])){3,30}[A-Za-z0-9]$/;

function isValidPartnerExchangeUid(rawUid: string): boolean {
  if (typeof rawUid !== 'string') {
    return false;
  }
  if (rawUid.length < 5 || rawUid.length > 32) {
    return false;
  }
  if (!PARTNER_EXCHANGE_UID_STRUCTURE_REGEX.test(rawUid)) {
    return false;
  }
  return (rawUid.match(/\d/g)?.length ?? 0) >= 4;
}

function renderVerificationBadge(status: UidVerificationStatus) {
  if (status === 'VERIFIED_BY_PARTNER') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-stitch-emerald/15 px-2.5 py-0.5 text-xs font-medium text-stitch-emerald">
        <CheckCircle2 className="h-3.5 w-3.5" />
        VERIFIED_BY_PARTNER
      </span>
    );
  }
  if (status === 'REJECTED') {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-red-500/15 px-2.5 py-0.5 text-xs font-medium text-red-400">
        <XCircle className="h-3.5 w-3.5" />
        REJECTED
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-stitch-amber/15 px-2.5 py-0.5 text-xs font-medium text-stitch-amber">
      <Clock className="h-3.5 w-3.5" />
      PENDING_FIRST_TRADE
    </span>
  );
}

export function NonCustodialUidPanel({
  shortLinks = [],
  onUidMutated,
}: NonCustodialUidPanelProps) {
  const [uids, setUids] = useState<BoundExchangeUidItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const [selectedExchange, setSelectedExchange] = useState<AllowedUidExchange>('bybit');
  const [exchangeUidInput, setExchangeUidInput] = useState<string>('');
  const [selectedShortCode, setSelectedShortCode] = useState<string>('');

  const loadUids = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/affiliate/uids', { credentials: 'include' });
      const data = (await res.json()) as {
        success?: boolean;
        uids?: BoundExchangeUidItem[];
        error?: string;
      };
      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? 'Unable to load bound exchange UIDs.');
        return;
      }
      setUids(data.uids ?? []);
      setErrorMsg(null);
    } catch {
      setErrorMsg('Network error while loading exchange UID bindings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadUids();
  }, [loadUids]);

  const matchingShortLinks = useMemo(
    () =>
      shortLinks.filter(
        (item) => item.exchange === selectedExchange && item.isActive
      ),
    [shortLinks, selectedExchange]
  );

  useEffect(() => {
    if (
      selectedShortCode &&
      !matchingShortLinks.some((item) => item.code === selectedShortCode)
    ) {
      setSelectedShortCode('');
    }
  }, [matchingShortLinks, selectedShortCode]);

  const handleBindUid = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    const trimmedUid = exchangeUidInput.trim();
    if (!isValidPartnerExchangeUid(trimmedUid)) {
      setErrorMsg(
        'Exchange UID must be 5-32 characters, start and end with a letter or digit, avoid consecutive dashes or underscores, and contain at least 4 numeric digits.'
      );
      return;
    }

    try {
      setSubmitting(true);
      const payload: {
        exchange: AllowedUidExchange;
        exchangeUid: string;
        linkedShortCode?: string;
      } = {
        exchange: selectedExchange,
        exchangeUid: trimmedUid,
      };
      if (selectedShortCode) {
        payload.linkedShortCode = selectedShortCode;
      }

      const res = await fetch('/api/affiliate/uids', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as {
        success?: boolean;
        uid?: BoundExchangeUidItem;
        error?: string;
      };

      if (!res.ok || !data.success || !data.uid) {
        setErrorMsg(data.error ?? 'Failed to bind partner exchange UID.');
        return;
      }

      setUids((prev) => [data.uid!, ...prev]);
      setExchangeUidInput('');
      setSelectedShortCode('');
      setSuccessMsg(
        `Bound ${data.uid.exchange.toUpperCase()} UID ${data.uid.exchangeUid} (awaiting first partner trade verification).`
      );
      onUidMutated?.();
    } catch {
      setErrorMsg('Network error while binding partner exchange UID.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRemoveUid = async (id: string) => {
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      setDeletingId(id);
      const res = await fetch(`/api/affiliate/uids?id=${encodeURIComponent(id)}`, {
        method: 'DELETE',
        credentials: 'include',
      });
      const data = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? 'Failed to remove UID binding.');
        return;
      }
      setUids((prev) => prev.filter((u) => u.id !== id));
      setSuccessMsg('Unverified exchange UID binding removed.');
      onUidMutated?.();
    } catch {
      setErrorMsg('Network error while removing UID binding.');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section
      aria-labelledby="non-custodial-uid-heading"
      className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2
            id="non-custodial-uid-heading"
            className="text-lg font-semibold text-stitch-primary flex items-center gap-2"
          >
            <ShieldCheck className="h-5 w-5 text-stitch-emerald" />
            Non-Custodial Exchange UID Binding
          </h2>
          <p className="text-xs text-stitch-muted mt-0.5">
            Deterministic partner rebate attribution across 5 audited exchanges without API keys.
          </p>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-stitch-emerald/30 bg-stitch-emerald/10 px-3 py-1 text-xs font-medium text-stitch-emerald">
          <Lock className="h-3.5 w-3.5" />
          Zero Custody
        </span>
      </div>

      {/* Mandatory Non-Custodial Security Banner */}
      <div
        role="note"
        data-testid="non-custodial-security-banner"
        className="rounded-xl border border-stitch-emerald/30 bg-stitch-emerald/10 p-3.5 text-xs text-stitch-primary flex items-start gap-2.5"
      >
        <ShieldCheck className="h-4 w-4 text-stitch-emerald shrink-0 mt-0.5" />
        <div>
          <p className="font-semibold text-stitch-emerald">
            Read-Only Partner UID Only — ApexOS Never Requests API Keys, Passphrases, or Custody.
          </p>
          <p className="text-stitch-muted mt-0.5">
            Rebates are verified directly from signed institutional partner commission ledgers into our
            immutable R2 Evidence Vault before any ledger credit is minted.
          </p>
        </div>
      </div>

      {/* Educational Exclusion Callout for Binance Standard Referral Pro */}
      <div
        data-testid="binance-exclusion-callout"
        className="rounded-xl border border-stitch-amber/30 bg-stitch-amber/10 p-3.5 text-xs flex items-start gap-2.5"
      >
        <Info className="h-4 w-4 text-stitch-amber shrink-0 mt-0.5" />
        <div>
          <span className="font-semibold text-stitch-amber">
            Why Binance Standard Referral Pro is Excluded:
          </span>{' '}
          <span className="text-stitch-muted">
            Binance Standard Referral Pro redacts/hides referee UIDs in partner APIs, making
            cryptographic per-trader Proof-of-Rebate impossible. Only deterministic UID-transparent
            partner rails (Bybit, OKX, Bitget, KuCoin, Gate.io) are accepted.
          </span>
        </div>
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

      {successMsg && (
        <div
          role="status"
          className="rounded-xl border border-stitch-emerald/40 bg-stitch-emerald/10 p-3 text-xs text-stitch-emerald flex items-center gap-2"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0" />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Bind Form */}
      <form onSubmit={handleBindUid} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <div className="md:col-span-4">
          <label
            htmlFor="uid-exchange-select"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Partner Exchange
          </label>
          <select
            id="uid-exchange-select"
            value={selectedExchange}
            onChange={(e) => setSelectedExchange(e.target.value as AllowedUidExchange)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          >
            {EXCHANGE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
            <option value="binance" disabled>
              Binance Standard Referral Pro — Unsupported (Hidden UIDs)
            </option>
          </select>
        </div>

        <div className="md:col-span-4">
          <label
            htmlFor="uid-value-input"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Account Exchange UID
          </label>
          <input
            id="uid-value-input"
            type="text"
            autoComplete="off"
            placeholder="e.g. 104928371"
            value={exchangeUidInput}
            onChange={(e) => setExchangeUidInput(e.target.value)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm font-mono text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          />
        </div>

        <div className="md:col-span-2">
          <label
            htmlFor="uid-shortlink-select"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Short Link (Opt.)
          </label>
          <select
            id="uid-shortlink-select"
            value={selectedShortCode}
            onChange={(e) => setSelectedShortCode(e.target.value)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-2.5 py-2 text-sm font-mono text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          >
            <option value="">None</option>
            {matchingShortLinks.map((sl) => (
              <option key={sl.code} value={sl.code}>
                /r/{sl.code}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={submitting}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-stitch-indigo hover:bg-stitch-violet disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Plus className="h-4 w-4" />
            )}
            Bind UID
          </button>
        </div>
      </form>

      {/* Bound UIDs Table */}
      <div className="overflow-x-auto border border-stitch-border rounded-xl">
        <table className="w-full text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase text-stitch-muted border-b border-stitch-border">
            <tr>
              <th className="px-4 py-2.5">Exchange</th>
              <th className="px-4 py-2.5">Partner UID</th>
              <th className="px-4 py-2.5">Attribution</th>
              <th className="px-4 py-2.5">Verification Status</th>
              <th className="px-4 py-2.5 text-right">Action</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stitch-border">
            {loading ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-stitch-muted text-xs">
                  Loading bound partner UIDs...
                </td>
              </tr>
            ) : uids.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-stitch-muted text-xs">
                  No exchange UIDs bound yet. Bind your Bybit, OKX, Bitget, KuCoin, or Gate.io UID above.
                </td>
              </tr>
            ) : (
              uids.map((item) => {
                const canDelete =
                  item.verificationStatus === 'PENDING_FIRST_TRADE' ||
                  item.verificationStatus === 'REJECTED';
                return (
                  <tr key={item.id} className="hover:bg-white/[0.02]">
                    <td className="px-4 py-3 font-medium text-stitch-primary uppercase">
                      <span>{item.exchange}</span>
                      {item.exchangeMode === 'SHADOW_30D' && (
                        <span className="ml-2 rounded bg-stitch-amber/15 px-1.5 py-0.5 text-[10px] font-mono text-stitch-amber">
                          30D SHADOW
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 font-mono text-stitch-primary">{item.exchangeUid}</td>
                    <td className="px-4 py-3 font-mono text-xs text-stitch-muted">
                      {item.linkedShortCode ? `/r/${item.linkedShortCode}` : 'Direct'}
                    </td>
                    <td className="px-4 py-3">{renderVerificationBadge(item.verificationStatus)}</td>
                    <td className="px-4 py-3 text-right">
                      {canDelete ? (
                        <button
                          type="button"
                          onClick={() => void handleRemoveUid(item.id)}
                          disabled={deletingId === item.id}
                          aria-label={`Remove UID ${item.exchangeUid}`}
                          className="inline-flex items-center gap-1 rounded-lg border border-red-500/30 px-2.5 py-1 text-xs text-red-400 hover:bg-red-500/10 disabled:opacity-50"
                        >
                          {deletingId === item.id ? (
                            <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          ) : (
                            <Trash2 className="h-3.5 w-3.5" />
                          )}
                          Remove
                        </button>
                      ) : (
                        <span className="inline-flex items-center gap-1 text-xs text-stitch-muted">
                          <Lock className="h-3.5 w-3.5" />
                          Audit Locked
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default NonCustodialUidPanel;
