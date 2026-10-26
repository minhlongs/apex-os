"use client";

/**
 * src/components/profile/ExchangeKeysManager.tsx
 *
 * Self-Service Exchange API Key Identifier Linking Manager.
 * Connects to /api/profile/exchange-keys (GET, POST, DELETE) to let users bind
 * their public exchange `api_key_id` so OKX / KuCoin trade webhooks
 * (`ok-access-key`, `kc-api-key`) can attribute cashback correctly.
 *
 * Contract:
 * - Collects ONLY the public `api_key_id` (never secret key / passphrase).
 * - 5 UI states: Loading, Unlinked, Linked, 400 Format Error, 409 Conflict Error.
 * - Updates local state directly from the POST/DELETE response `data.external_ids`.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Key,
  Link2,
  Loader2,
  Shield,
  Trash2,
} from 'lucide-react';
import {
  SUPPORTED_LINKED_EXCHANGES,
  isValidApiKeyId,
  type SupportedLinkedExchange,
} from '@/lib/theme/obsidian-tokens';
import type { LinkedExchangeBinding, ProfileExternalIds } from '@/types/profile';

type ManagerState = 'loading' | 'unlinked' | 'linked' | 'error';

interface Props {
  locale: string;
}

const EXCHANGE_LABELS: Record<SupportedLinkedExchange, { vi: string; en: string }> = {
  okx: { vi: 'OKX', en: 'OKX' },
  kucoin: { vi: 'KuCoin', en: 'KuCoin' },
  binance: { vi: 'Binance', en: 'Binance' },
  bybit: { vi: 'Bybit', en: 'Bybit' },
};

function getBinding(externalIds: ProfileExternalIds, exchange: SupportedLinkedExchange): LinkedExchangeBinding | undefined {
  const raw = externalIds[exchange];
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && typeof raw.api_key_id === 'string') {
    return raw as LinkedExchangeBinding;
  }
  return undefined;
}

export default function ExchangeKeysManager({ locale }: Props) {
  const isVietnamese = locale === 'vi';

  const [state, setState] = useState<ManagerState>('loading');
  const [externalIds, setExternalIds] = useState<ProfileExternalIds>({});
  const [selectedExchange, setSelectedExchange] = useState<SupportedLinkedExchange>('okx');
  const [apiKeyId, setApiKeyId] = useState('');
  const [label, setLabel] = useState('');
  const [busy, setBusy] = useState<SupportedLinkedExchange | null>(null);
  const [error, setError] = useState<{ status: number; message: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const t = useCallback(
    (vi: string, en: string) => (isVietnamese ? vi : en),
    [isVietnamese]
  );

  const applyExternalIds = useCallback((next: ProfileExternalIds) => {
    setExternalIds(next);
    setState(Object.keys(next).length > 0 ? 'linked' : 'unlinked');
  }, []);

  const loadKeys = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const res = await fetch('/api/profile/exchange-keys', { method: 'GET' });
      if (res.status === 401) {
        setState('unlinked');
        return;
      }
      const json = (await res.json()) as { success: boolean; data?: { external_ids: ProfileExternalIds } };
      if (!res.ok || !json.success) {
        setState('unlinked');
        return;
      }
      applyExternalIds(json.data?.external_ids ?? {});
    } catch {
      setState('unlinked');
    }
  }, [applyExternalIds]);

  useEffect(() => {
    void loadKeys();
  }, [loadKeys]);

  const inputInvalid = apiKeyId.trim().length > 0 && !isValidApiKeyId(apiKeyId);

  const linkedCount = useMemo(() => Object.keys(externalIds).length, [externalIds]);

  async function handleLink() {
    setError(null);
    setNotice(null);

    if (!isValidApiKeyId(apiKeyId)) {
      setError({
        status: 400,
        message: t(
          'Định dạng API Key ID không hợp lệ (6-128 ký tự chữ, số, gạch ngang hoặc gạch dưới).',
          'Invalid API Key ID format (6-128 alphanumeric, dash, or underscore characters).'
        ),
      });
      return;
    }

    setBusy(selectedExchange);
    try {
      const res = await fetch('/api/profile/exchange-keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          exchange: selectedExchange,
          api_key_id: apiKeyId.trim(),
          ...(label.trim() ? { label: label.trim() } : {}),
        }),
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: { external_ids: ProfileExternalIds };
      };

      if (res.status === 409) {
        setError({
          status: 409,
          message: t(
            'API Key ID này đã được liên kết với một tài khoản khác.',
            'This exchange API key identifier is already linked to another account.'
          ),
        });
        return;
      }
      if (res.status === 400) {
        setError({
          status: 400,
          message: json.error ?? t('Dữ liệu không hợp lệ.', 'Invalid request payload.'),
        });
        return;
      }
      if (!res.ok || !json.success) {
        setError({
          status: res.status,
          message: json.error ?? t('Không thể liên kết khóa.', 'Unable to link the key.'),
        });
        return;
      }

      // Optimistic direct state update — no second GET round-trip needed.
      applyExternalIds(json.data?.external_ids ?? {});
      setApiKeyId('');
      setLabel('');
      setNotice(t('Đã liên kết khóa sàn thành công.', 'Exchange key linked successfully.'));
    } catch {
      setError({
        status: 0,
        message: t('Lỗi mạng. Vui lòng thử lại.', 'Network error. Please try again.'),
      });
    } finally {
      setBusy(null);
    }
  }

  async function handleUnlink(exchange: SupportedLinkedExchange) {
    setError(null);
    setNotice(null);
    setBusy(exchange);
    try {
      const res = await fetch(`/api/profile/exchange-keys?exchange=${encodeURIComponent(exchange)}`, {
        method: 'DELETE',
      });
      const json = (await res.json()) as {
        success: boolean;
        error?: string;
        data?: { external_ids: ProfileExternalIds };
      };

      if (!res.ok || !json.success) {
        setError({
          status: res.status,
          message: json.error ?? t('Không thể hủy liên kết khóa.', 'Unable to unlink the key.'),
        });
        return;
      }

      applyExternalIds(json.data?.external_ids ?? {});
      setNotice(t('Đã hủy liên kết khóa sàn.', 'Exchange key unlinked.'));
    } catch {
      setError({
        status: 0,
        message: t('Lỗi mạng. Vui lòng thử lại.', 'Network error. Please try again.'),
      });
    } finally {
      setBusy(null);
    }
  }

  // ---- Render: Loading skeleton ----
  if (state === 'loading') {
    return (
      <section className="rounded-2xl border border-stitch-border bg-stitch-surface p-6">
        <div className="flex items-center gap-3">
          <span className="text-stitch-indigo" aria-hidden="true">
            <Loader2 className="h-5 w-5 animate-spin" />
          </span>
          <h2 className="text-lg font-semibold text-stitch-primary">
            {t('Quản lý Khóa API Sàn', 'Exchange API Key Management')}
          </h2>
        </div>
        <div className="mt-5 space-y-3" aria-busy="true" aria-live="polite">
          <div className="h-11 w-full animate-pulse rounded-xl bg-stitch-well" />
          <div className="h-11 w-full animate-pulse rounded-xl bg-stitch-well" />
          <div className="h-20 w-full animate-pulse rounded-xl bg-stitch-well" />
        </div>
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-stitch-border bg-stitch-surface p-6">
      <header className="flex items-start gap-3">
        <span className="rounded-xl bg-stitch-well p-2 text-stitch-indigo" aria-hidden="true">
          <Key className="h-5 w-5" />
        </span>
        <div>
          <h2 className="text-lg font-semibold text-stitch-primary">
            {t('Quản lý Khóa API Sàn', 'Exchange API Key Management')}
          </h2>
          <p className="mt-1 text-sm text-stitch-muted">
            {t(
              'Liên kết mã định danh API Key công khai để hệ thống tự động ghi nhận cashback từ giao dịch của bạn.',
              'Link your public API Key identifier so trades are automatically attributed to your cashback account.'
            )}
          </p>
        </div>
      </header>

      <div className="mt-4 flex gap-3 rounded-xl border border-stitch-amber/40 bg-stitch-well p-3">
        <span className="shrink-0 text-stitch-amber" aria-hidden="true">
          <Shield className="h-5 w-5" />
        </span>
        <p className="text-xs text-stitch-muted">
          <strong className="font-semibold text-stitch-amber">
            {t('An toàn tuyệt đối – Không lưu Secret Key.', 'Zero-secret — no Secret Key stored.')}
          </strong>{' '}
          {t(
            'Chúng tôi chỉ thu thập API Key ID (mã định danh công khai). Bạn không bao giờ cần nhập Secret Key, Passphrase hay cấp quyền rút tiền.',
            'We collect only the public API Key ID. You never enter a Secret Key, Passphrase, or grant withdrawal permission.'
          )}
        </p>
      </div>

      {error && (
        <div
          className="mt-4 flex gap-3 rounded-xl border border-stitch-crimson/40 bg-stitch-crimson/10 p-3"
          role="alert"
        >
          <span className="shrink-0 text-stitch-crimson" aria-hidden="true">
            <AlertTriangle className="h-5 w-5" />
          </span>
          <div>
            <p className="text-sm font-semibold text-stitch-crimson">
              {error.status === 409
                ? t(`Lỗi 409 – Trùng lặp khóa`, 'Error 409 – Duplicate key')
                : t(`Lỗi 400 – Định dạng không hợp lệ`, 'Error 400 – Invalid format')}
            </p>
            <p className="mt-0.5 text-xs text-stitch-muted">{error.message}</p>
          </div>
        </div>
      )}

      {notice && (
        <div className="mt-4 flex gap-3 rounded-xl border border-stitch-emerald/40 bg-stitch-emerald/10 p-3" role="status">
          <span className="shrink-0 text-stitch-emerald" aria-hidden="true">
            <Check className="h-5 w-5" />
          </span>
          <p className="text-sm text-stitch-primary">{notice}</p>
        </div>
      )}

      {state === 'linked' && (
        <ul className="mt-5 space-y-2">
          {SUPPORTED_LINKED_EXCHANGES.map((exchange) => {
            const binding = getBinding(externalIds, exchange);
            if (!binding) return null;
            return (
              <li
                key={exchange}
                className="flex items-center justify-between gap-3 rounded-xl border border-stitch-border bg-stitch-canvas px-4 py-3"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-stitch-primary">
                    {EXCHANGE_LABELS[exchange][isVietnamese ? 'vi' : 'en']}
                    {binding.label ? (
                      <span className="ml-2 text-xs font-normal text-stitch-muted">— {binding.label}</span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 truncate font-mono text-xs text-stitch-muted">{binding.api_key_id}</p>
                  {binding.linked_at ? (
                    <p className="mt-0.5 text-[11px] text-stitch-muted">
                      {t('Liên kết lúc', 'Linked at')}{' '}
                      {new Date(binding.linked_at).toLocaleString(isVietnamese ? 'vi-VN' : 'en-US')}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => handleUnlink(exchange)}
                  disabled={busy === exchange}
                  className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-stitch-crimson/40 px-3 py-1.5 text-xs font-semibold text-stitch-crimson transition hover:bg-stitch-crimson/10 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {busy === exchange ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
                  ) : (
                    <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                  )}
                  {t('Hủy liên kết', 'Unlink')}
                </button>
              </li>
            );
          })}
          {linkedCount === 0 && (
            <li className="rounded-xl border border-dashed border-stitch-divider px-4 py-6 text-center text-sm text-stitch-muted">
              {t('Chưa có khóa nào được liên kết.', 'No exchange keys linked yet.')}
            </li>
          )}
        </ul>
      )}

      <div className="mt-5 space-y-3 rounded-xl border border-stitch-border bg-stitch-canvas p-4">
        <div>
          <label htmlFor="eks-exchange" className="text-xs font-semibold uppercase tracking-wide text-stitch-muted">
            {t('Sàn giao dịch', 'Exchange')}
          </label>
          <select
            id="eks-exchange"
            value={selectedExchange}
            onChange={(event) => setSelectedExchange(event.target.value as SupportedLinkedExchange)}
            disabled={busy !== null}
            className="mt-1.5 w-full rounded-lg border border-stitch-border bg-stitch-well px-3 py-2 text-sm text-stitch-primary outline-none transition focus:border-stitch-indigo disabled:opacity-60"
          >
            {SUPPORTED_LINKED_EXCHANGES.map((exchange) => (
              <option key={exchange} value={exchange}>
                {EXCHANGE_LABELS[exchange][isVietnamese ? 'vi' : 'en']}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="eks-api-key" className="text-xs font-semibold uppercase tracking-wide text-stitch-muted">
            API Key ID <span className="normal-case text-stitch-crimson">*</span>
          </label>
          <input
            id="eks-api-key"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={apiKeyId}
            onChange={(event) => setApiKeyId(event.target.value)}
            placeholder={t('Ví dụ: okx_prod_key_2026', 'e.g. okx_prod_key_2026')}
            disabled={busy !== null}
            aria-invalid={inputInvalid}
            aria-describedby="eks-api-key-hint"
            className={`mt-1.5 w-full rounded-lg border bg-stitch-well px-3 py-2 font-mono text-sm text-stitch-primary outline-none transition disabled:opacity-60 ${
              inputInvalid ? 'border-stitch-crimson focus:border-stitch-crimson' : 'border-stitch-border focus:border-stitch-indigo'
            }`}
          />
          {inputInvalid ? (
            <p id="eks-api-key-hint" className="mt-1 text-[11px] text-stitch-crimson">
              {t(
                '6-128 ký tự: chữ, số, gạch ngang (-) hoặc gạch dưới (_).',
                '6-128 characters: letters, digits, dash (-) or underscore (_).'
              )}
            </p>
          ) : (
            <p id="eks-api-key-hint" className="mt-1 text-[11px] text-stitch-muted">
              {t('Chỉ nhập API Key ID — tuyệt đối không nhập Secret Key.', 'Public API Key ID only — never the Secret Key.')}
            </p>
          )}
        </div>

        <div>
          <label htmlFor="eks-label" className="text-xs font-semibold uppercase tracking-wide text-stitch-muted">
            {t('Nhãn (không bắt buộc)', 'Label (optional)')}
          </label>
          <input
            id="eks-label"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={t('Ví dụ: Tài khoản chính', 'e.g. Main account')}
            maxLength={64}
            disabled={busy !== null}
            className="mt-1.5 w-full rounded-lg border border-stitch-border bg-stitch-well px-3 py-2 text-sm text-stitch-primary outline-none transition focus:border-stitch-indigo disabled:opacity-60"
          />
        </div>

        <button
          type="button"
          onClick={handleLink}
          disabled={busy !== null || apiKeyId.trim().length === 0}
          className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-stitch-indigo px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-stitch-violet disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy !== null ? (
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          ) : (
            <Link2 className="h-4 w-4" aria-hidden="true" />
          )}
          {t('Liên kết khóa sàn', 'Link exchange key')}
        </button>
      </div>
    </section>
  );
}
