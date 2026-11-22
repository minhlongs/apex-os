'use client';

import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  Link2,
  Loader2,
  MousePointerClick,
  Power,
} from 'lucide-react';
import type {
  AffiliateShortLinkItem,
  ApprovedShortLinkExchange,
} from '@/app/api/affiliate/short-links/route';

export interface ShortLinksGeneratorPanelProps {
  locale?: string;
  onShortLinksChanged?: (links: AffiliateShortLinkItem[]) => void;
}

const PARTNER_EXCHANGES: ReadonlyArray<{
  value: ApprovedShortLinkExchange;
  label: string;
  placeholderUrl: string;
}> = [
  { value: 'bybit', label: 'Bybit', placeholderUrl: 'https://www.bybit.com/invite?ref=...' },
  { value: 'okx', label: 'OKX', placeholderUrl: 'https://www.okx.com/join/...' },
  { value: 'bitget', label: 'Bitget', placeholderUrl: 'https://www.bitget.com/referral/...' },
  { value: 'kucoin', label: 'KuCoin (30d Shadow)', placeholderUrl: 'https://www.kucoin.com/r/...' },
  { value: 'gateio', label: 'Gate.io (30d Shadow)', placeholderUrl: 'https://www.gate.io/signup/...' },
];

export function ShortLinksGeneratorPanel({
  onShortLinksChanged,
}: ShortLinksGeneratorPanelProps) {
  const [links, setLinks] = useState<AffiliateShortLinkItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [creating, setCreating] = useState<boolean>(false);
  const [togglingCode, setTogglingCode] = useState<string | null>(null);
  const [copiedCode, setCopiedCode] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [exchange, setExchange] = useState<ApprovedShortLinkExchange>('bybit');
  const [destinationUrl, setDestinationUrl] = useState<string>('');
  const [campaignTag, setCampaignTag] = useState<string>('');
  const [customCode, setCustomCode] = useState<string>('');

  const syncLinks = useCallback(
    (next: AffiliateShortLinkItem[]) => {
      setLinks(next);
      onShortLinksChanged?.(next);
    },
    [onShortLinksChanged]
  );

  const fetchLinks = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/affiliate/short-links', { credentials: 'include' });
      const data = (await res.json()) as {
        success?: boolean;
        shortLinks?: AffiliateShortLinkItem[];
        error?: string;
      };
      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? 'Failed to load partner short links.');
        return;
      }
      syncLinks(data.shortLinks ?? []);
      setErrorMsg(null);
    } catch {
      setErrorMsg('Network error while loading short links.');
    } finally {
      setLoading(false);
    }
  }, [syncLinks]);

  useEffect(() => {
    void fetchLinks();
  }, [fetchLinks]);

  const handleCreateShortLink = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);

    try {
      setCreating(true);
      const payload: {
        exchange: ApprovedShortLinkExchange;
        destinationUrl?: string;
        campaignTag?: string;
        customCode?: string;
      } = { exchange };

      if (destinationUrl.trim()) {
        payload.destinationUrl = destinationUrl.trim();
      }
      if (campaignTag.trim()) {
        payload.campaignTag = campaignTag.trim();
      }
      if (customCode.trim()) {
        payload.customCode = customCode.trim();
      }

      const res = await fetch('/api/affiliate/short-links', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = (await res.json()) as {
        success?: boolean;
        shortLink?: AffiliateShortLinkItem;
        error?: string;
      };

      if (!res.ok || !data.success || !data.shortLink) {
        setErrorMsg(data.error ?? 'Failed to create short link.');
        return;
      }

      const next = [data.shortLink, ...links];
      syncLinks(next);
      setDestinationUrl('');
      setCampaignTag('');
      setCustomCode('');
    } catch {
      setErrorMsg('Network error while creating short link.');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (item: AffiliateShortLinkItem) => {
    setErrorMsg(null);
    try {
      setTogglingCode(item.code);
      const res = await fetch('/api/affiliate/short-links', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: item.code, isActive: !item.isActive }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        shortLink?: { code: string; isActive: boolean };
        error?: string;
      };
      if (!res.ok || !data.success || !data.shortLink) {
        setErrorMsg(data.error ?? 'Failed to update short link status.');
        return;
      }
      const next = links.map((l) =>
        l.code === item.code ? { ...l, isActive: data.shortLink!.isActive } : l
      );
      syncLinks(next);
    } catch {
      setErrorMsg('Network error while toggling short link.');
    } finally {
      setTogglingCode(null);
    }
  };

  const handleCopy = async (item: AffiliateShortLinkItem) => {
    try {
      await navigator.clipboard.writeText(item.shortUrl);
      setCopiedCode(item.code);
      setTimeout(() => setCopiedCode((curr) => (curr === item.code ? null : curr)), 2000);
    } catch {
      setErrorMsg('Clipboard access denied — copy the /r/:code URL manually.');
    }
  };

  const activeExchangeMeta =
    PARTNER_EXCHANGES.find((p) => p.value === exchange) ?? PARTNER_EXCHANGES[0];

  return (
    <section
      aria-labelledby="short-links-generator-heading"
      className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 space-y-5"
    >
      <div>
        <h2
          id="short-links-generator-heading"
          className="text-lg font-semibold text-stitch-primary flex items-center gap-2"
        >
          <Link2 className="h-5 w-5 text-stitch-indigo" />
          Clean-Room Partner Short Links (/r/:code)
        </h2>
        <p className="text-xs text-stitch-muted mt-0.5">
          Edge KV-cached 302 attribution links restricted to allowlisted HTTPS exchange domains with
          SHA-256 anonymized click telemetry.
        </p>
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

      <form onSubmit={handleCreateShortLink} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <div className="md:col-span-3">
          <label
            htmlFor="shortlink-exchange"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Exchange
          </label>
          <select
            id="shortlink-exchange"
            value={exchange}
            onChange={(e) => setExchange(e.target.value as ApprovedShortLinkExchange)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          >
            {PARTNER_EXCHANGES.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-4">
          <label
            htmlFor="shortlink-destination"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Partner HTTPS URL (Optional)
          </label>
          <input
            id="shortlink-destination"
            type="url"
            placeholder={activeExchangeMeta.placeholderUrl}
            value={destinationUrl}
            onChange={(e) => setDestinationUrl(e.target.value)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          />
        </div>

        <div className="md:col-span-2">
          <label
            htmlFor="shortlink-campaign"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Campaign Tag
          </label>
          <input
            id="shortlink-campaign"
            type="text"
            placeholder="q4-desk"
            value={campaignTag}
            onChange={(e) => setCampaignTag(e.target.value)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          />
        </div>

        <div className="md:col-span-1">
          <label
            htmlFor="shortlink-custom-code"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Slug
          </label>
          <input
            id="shortlink-custom-code"
            type="text"
            placeholder="auto"
            value={customCode}
            onChange={(e) => setCustomCode(e.target.value)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-2.5 py-2 text-sm font-mono text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          />
        </div>

        <div className="md:col-span-2">
          <button
            type="submit"
            disabled={creating}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-stitch-indigo hover:bg-stitch-violet disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {creating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Create Link
          </button>
        </div>
      </form>

      <div className="overflow-x-auto border border-stitch-border rounded-xl">
        <table className="w-full text-left text-sm">
          <thead className="bg-black/20 text-xs uppercase text-stitch-muted border-b border-stitch-border">
            <tr>
              <th className="px-4 py-2.5">Short Link</th>
              <th className="px-4 py-2.5">Exchange</th>
              <th className="px-4 py-2.5">Campaign</th>
              <th className="px-4 py-2.5">Clicks</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Controls</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-stitch-border">
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-stitch-muted text-xs">
                  Loading /r/:code short links...
                </td>
              </tr>
            ) : links.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-6 text-center text-stitch-muted text-xs">
                  No partner short links created yet.
                </td>
              </tr>
            ) : (
              links.map((item) => (
                <tr key={item.code} className="hover:bg-white/[0.02]">
                  <td className="px-4 py-3 font-mono text-xs text-stitch-primary">
                    <div className="flex items-center gap-2">
                      <span>/r/{item.code}</span>
                      <a
                        href={item.destinationUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        title={item.destinationUrl}
                        className="text-stitch-muted hover:text-stitch-indigo"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  </td>
                  <td className="px-4 py-3 uppercase font-medium text-stitch-primary">
                    <span>{item.exchange}</span>
                    {item.exchangeMode === 'SHADOW_30D' && (
                      <span className="ml-1.5 rounded bg-stitch-amber/15 px-1.5 py-0.5 text-[10px] font-mono text-stitch-amber">
                        SHADOW
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-stitch-muted">
                    {item.campaignTag ?? '—'}
                  </td>
                  <td className="px-4 py-3 font-mono text-stitch-primary">
                    <span className="inline-flex items-center gap-1">
                      <MousePointerClick className="h-3.5 w-3.5 text-stitch-indigo" />
                      {item.clickCount}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    {item.isActive ? (
                      <span className="rounded-full bg-stitch-emerald/15 px-2.5 py-0.5 text-xs font-medium text-stitch-emerald">
                        Active
                      </span>
                    ) : (
                      <span className="rounded-full bg-white/10 px-2.5 py-0.5 text-xs font-medium text-stitch-muted">
                        Paused
                      </span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <div className="inline-flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => void handleCopy(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-stitch-border px-2.5 py-1 text-xs text-stitch-primary hover:border-stitch-indigo"
                      >
                        {copiedCode === item.code ? (
                          <>
                            <Check className="h-3.5 w-3.5 text-stitch-emerald" />
                            Copied
                          </>
                        ) : (
                          <>
                            <Copy className="h-3.5 w-3.5" />
                            Copy
                          </>
                        )}
                      </button>
                      <button
                        type="button"
                        disabled={togglingCode === item.code}
                        onClick={() => void handleToggleActive(item)}
                        className="inline-flex items-center gap-1 rounded-lg border border-stitch-border px-2.5 py-1 text-xs text-stitch-muted hover:text-stitch-primary disabled:opacity-50"
                      >
                        {togglingCode === item.code ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Power className="h-3.5 w-3.5" />
                        )}
                        {item.isActive ? 'Pause' : 'Enable'}
                      </button>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default ShortLinksGeneratorPanel;
