'use client';

/**
 * Admin Ascendancy Console Operations Panel
 *
 * Unifies:
 * 1. Runtime Circuit Breakers & Shadow-to-Live Exchange Promotion Toggles
 *    (`GET` / `POST /api/admin/runtime-flags` gated by `x-passkey-stepup-token`)
 * 2. Partner Ingestion & Automated 5-Exchange Poller Console
 *    (`GET` / `POST /api/admin/reconciliation/poller` + `POST /api/admin/reconciliation/ingest`)
 *    with Live (`CASH_COLLECTED` + R2 `SHA-256`) & 30-Day Shadow (`KuCoin` / `Gate.io`) tables
 * 3. Turnkey HSM / Safe 2-of-3 Cold Multisig Settlement Broadcast Queue
 *    (`POST /api/admin/settlement/dispatch` actions `recover` & `resolve_cold_safe`)
 */

import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  AlertOctagon,
  AlertTriangle,
  CheckCircle,
  Database,
  FileText,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react';
import { obtainAdminStepUpToken } from '@/lib/auth/webauthn-browser';
import { B2bAgencyContractsPanel } from './b2b-agency-contracts-panel';
import type { ActivePasskeyStepUpSession } from './passkey-security-panel';

const PASSKEY_STEPUP_HEADER = 'x-passkey-stepup-token';

type SupportedPartnerExchange =
  | 'bybit'
  | 'okx'
  | 'bitget'
  | 'kucoin'
  | 'gateio';

type ManualDispatchOwnerType = 'affiliate' | 'trader' | 'agency';

type ManualDispatchChain = 'stellar' | 'arbitrum' | 'base';

const MINIMUM_MANUAL_DISPATCH_USD = 10;

interface SettlementDispatchApiResponse {
  success?: boolean;
  code?: string;
  error?: string;
  lockBatchId?: string | null;
  settlement?: {
    payoutId?: string;
    chain?: string;
    state?: string;
    txHash?: string;
    safeMultisigTxHash?: string;
    reason?: string;
  };
}

interface RuntimeFlagItem {
  flag_key: string;
  flag_value: string;
  reason: string | null;
  updated_by: string | null;
  updated_at: string;
}

interface LiveReconciliationItem {
  id: string;
  exchange: string;
  evidence_id: string;
  wallet_evidence_id: string | null;
  uid_allocated_units: number;
  wallet_cash_collected_units: number;
  clawback_offset_units: number;
  minted_gross_units: number;
  discrepancy_units: number;
  status: string;
  reconciled_at: string;
  payload_sha256: string | null;
}

interface ShadowReconciliationItem {
  id: string;
  exchange: string;
  evidence_id: string;
  row_count: number;
  mapped_uid_count: number;
  unmapped_uid_count: number;
  simulated_gross_units: number;
  wallet_cash_collected_units: number;
  discrepancy_units: number;
  status: string;
  notes: string | null;
  created_at: string;
  payload_sha256: string | null;
}

interface SettlementBroadcastItem {
  id: string;
  payout_id: string;
  affiliate_id: string;
  chain: string;
  recipient_address: string;
  amount_units_1e8: number;
  state: string;
  tx_hash: string | null;
  safe_multisig_tx_hash: string | null;
  error_reason: string | null;
  updated_at: string;
}

interface PollerRunTelemetryItem {
  id: string;
  trigger_source?: string;
  triggerSource?: string;
  exchange: string;
  mode: string;
  status: string;
  fetched_rows?: number;
  fetchedRows?: number;
  minted_batches?: number;
  mintedBatches?: number;
  started_at?: string;
  startedAt?: string;
}

interface RuntimeFlagsApiResponse {
  success: boolean;
  flags?: RuntimeFlagItem[];
  recentReconciliations?: LiveReconciliationItem[];
  recentShadowReconciliations?: ShadowReconciliationItem[];
  recentBroadcasts?: SettlementBroadcastItem[];
  code?: string;
  error?: string;
}

interface PollerStatusApiResponse {
  success?: boolean;
  runs?: PollerRunTelemetryItem[];
  recentRuns?: PollerRunTelemetryItem[];
  error?: string;
}

interface FlagMetadata {
  key: string;
  label: string;
  category: 'kill_switch' | 'promotion_gate';
  description: string;
}

const FLAG_DEFINITIONS: readonly FlagMetadata[] = [
  {
    key: 'EMERGENCY_LEDGER_FREEZE',
    label: 'Emergency Ledger Freeze',
    category: 'kill_switch',
    description:
      'Halts all Double-Entry Ledger minting, clawbacks, and withdrawal locks immediately.',
  },
  {
    key: 'EMERGENCY_PAUSE',
    label: 'Emergency Settlement Pause',
    category: 'kill_switch',
    description:
      'Pauses outbound Turnkey HSM signing and multichain USDC settlement dispatches.',
  },
  {
    key: 'BLOCK_VN_SIGNUPS',
    label: 'Vietnam Geo-Fence Signup Block',
    category: 'kill_switch',
    description:
      'Enforces hard geo-fence block on new account registrations originating from VN IPs.',
  },
  {
    key: 'PARTNER_KUCOIN_LIVE',
    label: 'KuCoin UTA v2 Live Minting',
    category: 'promotion_gate',
    description:
      'Promotes KuCoin ingestion from 30-day shadow audit log to live T+7 ledger minting.',
  },
  {
    key: 'PARTNER_GATEIO_LIVE',
    label: 'Gate.io v4 Live Minting',
    category: 'promotion_gate',
    description:
      'Promotes Gate.io ingestion from 30-day shadow audit log to live T+7 ledger minting.',
  },
];

const PARTNER_EXCHANGES: readonly SupportedPartnerExchange[] = [
  'bybit',
  'okx',
  'bitget',
  'kucoin',
  'gateio',
];

export interface AscendancyOpsPanelProps {
  activeStepUp: ActivePasskeyStepUpSession | null;
  onStepUpChange: (session: ActivePasskeyStepUpSession | null) => void;
}

function formatUsdUnits1e8(units: number): string {
  if (!Number.isFinite(units)) {
    return '$0.00';
  }
  const negative = units < 0;
  const absUnits = Math.abs(Math.trunc(units));
  const whole = Math.floor(absUnits / 100_000_000);
  const frac = Math.floor((absUnits % 100_000_000) / 1_000_000);
  return `${negative ? '-' : ''}$${whole.toLocaleString('en-US')}.${String(frac).padStart(2, '0')}`;
}

function shortHash(value: string | null | undefined, keep = 8): string {
  if (!value) {
    return '—';
  }
  if (value.length <= keep * 2 + 3) {
    return value;
  }
  return `${value.slice(0, keep)}...${value.slice(-6)}`;
}

function getBroadcastBadgeClass(state: string): string {
  switch (state) {
    case 'CONFIRMED':
      return 'bg-emerald-100 text-emerald-800';
    case 'QUEUED_COLD_SAFE':
      return 'bg-indigo-100 text-indigo-800';
    case 'BROADCAST_PENDING':
    case 'SIGNING':
      return 'bg-amber-100 text-amber-800';
    case 'EXPIRED_RECOVERED':
      return 'bg-blue-100 text-blue-800';
    default:
      return 'bg-red-100 text-red-800';
  }
}

export function AscendancyOpsPanel({
  activeStepUp,
  onStepUpChange,
}: AscendancyOpsPanelProps) {
  const [flags, setFlags] = useState<Record<string, RuntimeFlagItem>>({});
  const [reconciliations, setReconciliations] = useState<
    LiveReconciliationItem[]
  >([]);
  const [shadowReconciliations, setShadowReconciliations] = useState<
    ShadowReconciliationItem[]
  >([]);
  const [broadcasts, setBroadcasts] = useState<SettlementBroadcastItem[]>([]);
  const [pollerRuns, setPollerRuns] = useState<PollerRunTelemetryItem[]>([]);
  const [pollerRouteAvailable, setPollerRouteAvailable] =
    useState<boolean>(true);

  const [loadingTelemetry, setLoadingTelemetry] = useState<boolean>(true);
  const [panelError, setPanelError] = useState<string | null>(null);
  const [panelNotice, setPanelNotice] = useState<string | null>(null);

  // Runtime flag mutation state
  const [flagReason, setFlagReason] = useState<string>('');
  const [mutatingFlagKey, setMutatingFlagKey] = useState<string | null>(null);

  // Poller & manual ingestion state
  const [triggeringPoller, setTriggeringPoller] = useState<boolean>(false);
  const [ingestExchange, setIngestExchange] =
    useState<SupportedPartnerExchange>('bybit');
  const [periodStart, setPeriodStart] = useState<string>(
    '2026-11-01T00:00:00Z'
  );
  const [periodEnd, setPeriodEnd] = useState<string>('2026-11-15T00:00:00Z');
  const [walletCashUsd, setWalletCashUsd] = useState<string>('0.00');
  const [rawPartnerPayload, setRawPartnerPayload] = useState<string>('');
  const [rawWalletPayload, setRawWalletPayload] = useState<string>('');
  const [uidMapJson, setUidMapJson] = useState<string>('{}');
  const [ingesting, setIngesting] = useState<boolean>(false);

  // Broadcast queue action state
  const [busyPayoutId, setBusyPayoutId] = useState<string | null>(null);
  const [safeTxHashes, setSafeTxHashes] = useState<Record<string, string>>({});
  const [safeReasons, setSafeReasons] = useState<Record<string, string>>({});

  // Manual Phase 1 settlement dispatch state
  const [manualPayoutId, setManualPayoutId] = useState<string>('');
  const [manualIdempotencyKey, setManualIdempotencyKey] = useState<string>('');
  const [manualAffiliateId, setManualAffiliateId] = useState<string>('');
  const [manualOwnerType, setManualOwnerType] =
    useState<ManualDispatchOwnerType>('affiliate');
  const [manualChain, setManualChain] = useState<ManualDispatchChain>('arbitrum');
  const [manualRecipientAddress, setManualRecipientAddress] = useState<string>('');
  const [manualAmountUsd, setManualAmountUsd] = useState<string>('10.00');
  const [dispatchingManual, setDispatchingManual] = useState<boolean>(false);

  const ensureValidStepUpToken = useCallback(async (): Promise<string> => {
    if (activeStepUp) {
      const expMs = Date.parse(activeStepUp.expiresAt);
      if (!Number.isNaN(expMs) && expMs - Date.now() > 5_000) {
        return activeStepUp.stepUpToken;
      }
    }
    const freshSession = await obtainAdminStepUpToken();
    onStepUpChange(freshSession);
    return freshSession.stepUpToken;
  }, [activeStepUp, onStepUpChange]);

  const fetchOpsTelemetry = useCallback(async () => {
    setLoadingTelemetry(true);
    setPanelError(null);
    try {
      const flagsRes = await fetch('/api/admin/runtime-flags', {
        method: 'GET',
        credentials: 'same-origin',
      });
      const flagsJson = (await flagsRes.json()) as RuntimeFlagsApiResponse;
      if (!flagsRes.ok || !flagsJson.success) {
        throw new Error(
          flagsJson.error || 'Failed to load Ascendancy runtime telemetry.'
        );
      }

      const flagMap: Record<string, RuntimeFlagItem> = {};
      for (const row of flagsJson.flags ?? []) {
        flagMap[row.flag_key] = row;
      }
      setFlags(flagMap);
      setReconciliations(flagsJson.recentReconciliations ?? []);
      setShadowReconciliations(flagsJson.recentShadowReconciliations ?? []);
      setBroadcasts(flagsJson.recentBroadcasts ?? []);

      // Poll telemetry route (gracefully handle 404 when poller route is not yet merged)
      try {
        const pollerRes = await fetch('/api/admin/reconciliation/poller', {
          method: 'GET',
          credentials: 'same-origin',
        });
        if (pollerRes.status === 404) {
          setPollerRouteAvailable(false);
          setPollerRuns([]);
        } else if (pollerRes.ok) {
          setPollerRouteAvailable(true);
          const pollerJson =
            (await pollerRes.json()) as PollerStatusApiResponse;
          setPollerRuns(pollerJson.runs ?? pollerJson.recentRuns ?? []);
        }
      } catch {
        setPollerRouteAvailable(false);
      }
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error
          ? err.message
          : 'Unable to load Ascendancy operations data.'
      );
    } finally {
      setLoadingTelemetry(false);
    }
  }, []);

  useEffect(() => {
    void fetchOpsTelemetry();
  }, [fetchOpsTelemetry]);

  const handleToggleRuntimeFlag = async (
    flagKey: string,
    targetValue: 'true' | 'false'
  ) => {
    const trimmedReason = flagReason.trim();
    if (trimmedReason.length < 5) {
      setPanelError(
        'Enter an audit reason (minimum 5 characters) before toggling a runtime flag.'
      );
      return;
    }

    setMutatingFlagKey(flagKey);
    setPanelError(null);
    setPanelNotice(null);
    try {
      const token = await ensureValidStepUpToken();
      const isShadowPromotionFlag =
        flagKey === 'PARTNER_KUCOIN_LIVE' || flagKey === 'PARTNER_GATEIO_LIVE';
      const res =
        isShadowPromotionFlag && pollerRouteAvailable
          ? await fetch('/api/admin/reconciliation/poller', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                [PASSKEY_STEPUP_HEADER]: token,
              },
              body: JSON.stringify({
                action: 'promote_shadow',
                exchange:
                  flagKey === 'PARTNER_KUCOIN_LIVE' ? 'kucoin' : 'gateio',
                liveEnabled: targetValue === 'true',
                reason: trimmedReason,
              }),
            })
          : await fetch('/api/admin/runtime-flags', {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'Content-Type': 'application/json',
                [PASSKEY_STEPUP_HEADER]: token,
              },
              body: JSON.stringify({
                flagKey,
                flagValue: targetValue,
                reason: trimmedReason,
              }),
            });

      const json = (await res.json()) as {
        success: boolean;
        code?: string;
        error?: string;
      };
      if (!res.ok || !json.success) {
        if (
          json.code === 'PASSKEY_STEP_UP_REQUIRED' ||
          json.code === 'PASSKEY_STEP_UP_INVALID'
        ) {
          onStepUpChange(null);
        }
        throw new Error(json.error || `Failed to update ${flagKey}`);
      }

      setPanelNotice(`Updated ${flagKey} = ${targetValue}.`);
      await fetchOpsTelemetry();
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error ? err.message : 'Runtime flag update failed.'
      );
    } finally {
      setMutatingFlagKey(null);
    }
  };

  const handleTriggerPollCycle = async () => {
    setTriggeringPoller(true);
    setPanelError(null);
    setPanelNotice(null);
    try {
      const token = await ensureValidStepUpToken();
      const res = await fetch('/api/admin/reconciliation/poller', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: token,
        },
        body: JSON.stringify({ triggerSource: 'admin_manual' }),
      });

      if (res.status === 404) {
        setPollerRouteAvailable(false);
        throw new Error(
          'Automated poller endpoint (/api/admin/reconciliation/poller) is not yet mounted in this build.'
        );
      }

      const json = (await res.json()) as {
        success?: boolean;
        code?: string;
        error?: string;
      };
      if (!res.ok || json.success === false) {
        if (
          json.code === 'PASSKEY_STEP_UP_REQUIRED' ||
          json.code === 'PASSKEY_STEP_UP_INVALID'
        ) {
          onStepUpChange(null);
        }
        throw new Error(json.error || '5-exchange poll cycle failed.');
      }

      setPanelNotice('5-exchange partner poll cycle completed.');
      await fetchOpsTelemetry();
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error ? err.message : 'Failed to trigger partner poller.'
      );
    } finally {
      setTriggeringPoller(false);
    }
  };

  const handleManualIngest = async (e: React.FormEvent) => {
    e.preventDefault();
    setPanelError(null);
    setPanelNotice(null);

    if (!rawPartnerPayload.trim()) {
      setPanelError('Partner CSV/JSON statement payload is required.');
      return;
    }

    let parsedUidMap: Record<string, unknown>;
    try {
      const candidate = JSON.parse(uidMapJson.trim() || '{}') as unknown;
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
        throw new Error('uidToProfileMap must be a JSON object.');
      }
      parsedUidMap = candidate as Record<string, unknown>;
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error
          ? `Invalid UID map JSON: ${err.message}`
          : 'Invalid uidToProfileMap JSON.'
      );
      return;
    }

    setIngesting(true);
    try {
      const token = await ensureValidStepUpToken();
      const walletStatement =
        rawWalletPayload.trim() ||
        JSON.stringify({
          exchange: ingestExchange,
          walletCashCollectedUsd: walletCashUsd.trim(),
          periodStart: periodStart.trim(),
          periodEnd: periodEnd.trim(),
        });

      const res = await fetch('/api/admin/reconciliation/ingest', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: token,
        },
        body: JSON.stringify({
          exchange: ingestExchange,
          statementPeriodStart: periodStart.trim(),
          statementPeriodEnd: periodEnd.trim(),
          walletCashCollectedUsd: walletCashUsd.trim(),
          rawPartnerPayload,
          rawWalletStatementPayload: walletStatement,
          uidToProfileMap: parsedUidMap,
        }),
      });

      const json = (await res.json()) as {
        success?: boolean;
        status?: string;
        code?: string;
        error?: string;
      };
      if (!res.ok || !json.success) {
        if (
          json.code === 'PASSKEY_STEP_UP_REQUIRED' ||
          json.code === 'PASSKEY_STEP_UP_INVALID'
        ) {
          onStepUpChange(null);
        }
        throw new Error(json.error || 'Partner statement ingestion failed.');
      }

      setPanelNotice(
        `Ingested ${ingestExchange.toUpperCase()} batch (${json.status ?? 'RECONCILED'}).`
      );
      setRawPartnerPayload('');
      await fetchOpsTelemetry();
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error ? err.message : 'Manual statement ingestion failed.'
      );
    } finally {
      setIngesting(false);
    }
  };

  const handleRecoverBroadcast = async (
    payoutId: string,
    reexecuteExpired: boolean
  ) => {
    setBusyPayoutId(payoutId);
    setPanelError(null);
    setPanelNotice(null);
    try {
      const token = await ensureValidStepUpToken();
      const res = await fetch('/api/admin/settlement/dispatch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: token,
        },
        body: JSON.stringify({
          action: 'recover',
          payoutId,
          bumpGasRbf: true,
          reexecuteExpired,
        }),
      });

      const json = (await res.json()) as {
        success?: boolean;
        code?: string;
        error?: string;
        recovery?: { state?: string };
      };
      if (!res.ok || !json.success) {
        if (
          json.code === 'PASSKEY_STEP_UP_REQUIRED' ||
          json.code === 'PASSKEY_STEP_UP_INVALID'
        ) {
          onStepUpChange(null);
        }
        throw new Error(json.error || `Recovery failed for ${payoutId}`);
      }

      setPanelNotice(
        `Recovered broadcast ${payoutId} -> ${json.recovery?.state ?? 'UPDATED'}.`
      );
      await fetchOpsTelemetry();
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error ? err.message : 'Broadcast recovery failed.'
      );
    } finally {
      setBusyPayoutId(null);
    }
  };

  const handleResolveColdSafe = async (
    payoutId: string,
    coldResolution: 'CONFIRMED' | 'CANCELLED'
  ) => {
    const txHash = (safeTxHashes[payoutId] ?? '').trim();
    const reason = (safeReasons[payoutId] ?? '').trim();

    if (coldResolution === 'CONFIRMED' && !txHash) {
      setPanelError(
        `Enter executed Safe 2-of-3 on-chain txHash before confirming ${payoutId}.`
      );
      return;
    }

    setBusyPayoutId(payoutId);
    setPanelError(null);
    setPanelNotice(null);
    try {
      const token = await ensureValidStepUpToken();
      const res = await fetch('/api/admin/settlement/dispatch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: token,
        },
        body: JSON.stringify({
          action: 'resolve_cold_safe',
          payoutId,
          coldResolution,
          ...(txHash ? { txHash } : {}),
          reason:
            reason ||
            (coldResolution === 'CONFIRMED'
              ? 'Safe 2-of-3 multisig execution verified'
              : 'Safe 2-of-3 cold payout aborted by admin'),
        }),
      });

      const json = (await res.json()) as {
        success?: boolean;
        code?: string;
        error?: string;
      };
      if (!res.ok || !json.success) {
        if (
          json.code === 'PASSKEY_STEP_UP_REQUIRED' ||
          json.code === 'PASSKEY_STEP_UP_INVALID'
        ) {
          onStepUpChange(null);
        }
        throw new Error(
          json.error || `Safe 2-of-3 resolution failed for ${payoutId}`
        );
      }

      setPanelNotice(
        `Resolved Safe 2-of-3 payout ${payoutId} (${coldResolution}).`
      );
      await fetchOpsTelemetry();
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error ? err.message : 'Cold-Safe resolution failed.'
      );
    } finally {
      setBusyPayoutId(null);
    }
  };

  const handleGenerateManualDispatchIds = () => {
    const suffix = crypto.randomUUID();
    setManualPayoutId(`payout_phase1_${suffix}`);
    setManualIdempotencyKey(`idem_phase1_${suffix}`);
  };

  const handleManualDispatch = async (
    event: React.FormEvent<HTMLFormElement>
  ) => {
    event.preventDefault();
    setPanelError(null);
    setPanelNotice(null);

    const payoutId = manualPayoutId.trim();
    const idempotencyKey = manualIdempotencyKey.trim();
    const affiliateId = manualAffiliateId.trim();
    const recipientAddress = manualRecipientAddress.trim();
    const amountUsd = manualAmountUsd.trim();

    if (!payoutId || !idempotencyKey || !affiliateId || !recipientAddress) {
      setPanelError(
        'payoutId, idempotencyKey, affiliateId, and recipientAddress are required for a manual Phase 1 settlement dispatch.'
      );
      return;
    }

    const parsedAmount = Number.parseFloat(amountUsd);
    if (!Number.isFinite(parsedAmount) || parsedAmount < MINIMUM_MANUAL_DISPATCH_USD) {
      setPanelError(
        `amountUsd must be a numeric USD amount of at least $${MINIMUM_MANUAL_DISPATCH_USD.toFixed(2)}.`
      );
      return;
    }

    setDispatchingManual(true);
    try {
      const token = await ensureValidStepUpToken();
      const res = await fetch('/api/admin/settlement/dispatch', {
        method: 'POST',
        credentials: 'same-origin',
        headers: {
          'Content-Type': 'application/json',
          [PASSKEY_STEPUP_HEADER]: token,
        },
        body: JSON.stringify({
          action: 'dispatch',
          payoutId,
          idempotencyKey,
          affiliateId,
          ownerType: manualOwnerType,
          chain: manualChain,
          recipientAddress,
          amountUsd,
        }),
      });

      const json = (await res.json()) as SettlementDispatchApiResponse;
      if (!res.ok || !json.success) {
        if (
          json.code === 'PASSKEY_STEP_UP_REQUIRED' ||
          json.code === 'PASSKEY_STEP_UP_INVALID'
        ) {
          onStepUpChange(null);
        }
        throw new Error(json.error || `Settlement dispatch failed for ${payoutId}`);
      }

      const settledState = json.settlement?.state ?? 'DISPATCHED';
      const txReference = json.settlement?.txHash
        ? ` tx ${shortHash(json.settlement.txHash, 8)}`
        : json.settlement?.safeMultisigTxHash
          ? ` Safe tx ${shortHash(json.settlement.safeMultisigTxHash, 8)}`
          : '';
      setPanelNotice(
        `Dispatched ${payoutId} on ${json.settlement?.chain ?? manualChain} -> ${settledState}${txReference}.`
      );
      await fetchOpsTelemetry();
    } catch (err: unknown) {
      setPanelError(
        err instanceof Error ? err.message : 'Manual settlement dispatch failed.'
      );
    } finally {
      setDispatchingManual(false);
    }
  };

  return (
    <div className="space-y-6 mb-8">
      {panelError ? (
        <div className="rounded-lg bg-red-50 border border-red-200 p-4 text-sm text-red-700 flex items-center gap-2">
          <AlertOctagon className="w-5 h-5 shrink-0" />
          <span>{panelError}</span>
        </div>
      ) : null}

      {panelNotice ? (
        <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-4 text-sm text-emerald-800 flex items-center gap-2">
          <CheckCircle className="w-5 h-5 shrink-0 text-emerald-600" />
          <span>{panelNotice}</span>
        </div>
      ) : null}

      {/* 1. Runtime Circuit Breakers & Exchange Promotion Toggles */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <ShieldAlert className="w-5 h-5 text-red-600" />
              <span>Runtime Circuit Breakers & Exchange Promotion Gates</span>
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Every toggle requires a mandatory audit reason (min 5 chars) and WebAuthn Passkey step-up (`x-passkey-stepup-token`).
            </p>
          </div>

          <button
            type="button"
            onClick={() => void fetchOpsTelemetry()}
            disabled={loadingTelemetry}
            className="inline-flex items-center px-3 py-1.5 border border-gray-300 rounded-lg text-xs font-medium text-gray-700 bg-white hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw
              className={`w-3.5 h-3.5 mr-1.5 ${loadingTelemetry ? 'animate-spin' : ''}`}
            />
            Sync Console
          </button>
        </div>

        <div className="mb-4">
          <label
            htmlFor="runtime-flag-reason"
            className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
          >
            Mandatory Audit Reason (min 5 chars)
          </label>
          <input
            id="runtime-flag-reason"
            type="text"
            value={flagReason}
            onChange={(e) => setFlagReason(e.target.value)}
            placeholder="e.g. Incident #55 containment / 30-day KuCoin shadow audit reconciled 0 discrepancy"
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {FLAG_DEFINITIONS.map((meta) => {
            const row = flags[meta.key];
            const isTrue = row?.flag_value === 'true';
            const nextVal: 'true' | 'false' = isTrue ? 'false' : 'true';
            const isKillSwitch = meta.category === 'kill_switch';

            const activeBadgeClass = isKillSwitch
              ? isTrue
                ? 'bg-red-100 text-red-800 border-red-200'
                : 'bg-emerald-50 text-emerald-700 border-emerald-200'
              : isTrue
                ? 'bg-emerald-100 text-emerald-800 border-emerald-200'
                : 'bg-amber-50 text-amber-800 border-amber-200';

            return (
              <div
                key={meta.key}
                className="rounded-xl border border-gray-200 p-4 flex flex-col justify-between bg-gray-50/40"
              >
                <div>
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <span className="font-mono text-xs font-bold text-gray-800">
                      {meta.key}
                    </span>
                    <span
                      className={`px-2 py-0.5 text-xs font-bold rounded-full border ${activeBadgeClass}`}
                    >
                      {isKillSwitch
                        ? isTrue
                          ? 'TRIPPED (TRUE)'
                          : 'ARMED (FALSE)'
                        : isTrue
                          ? 'LIVE MINTING'
                          : 'SHADOW ONLY'}
                    </span>
                  </div>
                  <div className="text-sm font-semibold text-gray-900">
                    {meta.label}
                  </div>
                  <p className="text-xs text-gray-500 mt-1">
                    {meta.description}
                  </p>
                  {row?.reason ? (
                    <p className="text-xs text-gray-600 mt-2 truncate" title={row.reason}>
                      Last reason: <span className="italic">{row.reason}</span>
                    </p>
                  ) : null}
                </div>

                <div className="mt-4 pt-3 border-t border-gray-200 flex items-center justify-between gap-2">
                  <span className="text-[11px] text-gray-400">
                    {row?.updated_at || 'Default seed'}
                  </span>
                  <button
                    type="button"
                    disabled={mutatingFlagKey === meta.key}
                    onClick={() => void handleToggleRuntimeFlag(meta.key, nextVal)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-semibold text-white disabled:opacity-50 ${
                      isKillSwitch
                        ? isTrue
                          ? 'bg-emerald-600 hover:bg-emerald-700'
                          : 'bg-red-600 hover:bg-red-700'
                        : isTrue
                          ? 'bg-amber-600 hover:bg-amber-700'
                          : 'bg-indigo-600 hover:bg-indigo-700'
                    }`}
                  >
                    {mutatingFlagKey === meta.key
                      ? 'Updating...'
                      : `Set ${nextVal.toUpperCase()}`}
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 2. Partner Ingestion & Poller Console */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-5">
          <div>
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              <Database className="w-5 h-5 text-indigo-600" />
              <span>Partner Ingestion & 5-Exchange Poller Console</span>
            </h2>
            <p className="text-xs text-gray-500 mt-1">
              Execute Passkey-gated REST poll cycles or upload signed CSV/JSON partner statements anchored to R2 `SHA-256` evidence.
            </p>
          </div>

          <button
            type="button"
            onClick={() => void handleTriggerPollCycle()}
            disabled={triggeringPoller}
            className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Play className="w-3.5 h-3.5 mr-1.5" />
            {triggeringPoller
              ? 'Polling 5 Exchanges...'
              : 'Trigger 5-Exchange Poll Cycle'}
          </button>
        </div>

        {!pollerRouteAvailable ? (
          <div className="mb-4 rounded-lg bg-gray-50 border border-gray-200 px-3 py-2 text-xs text-gray-600 flex items-center gap-2">
            <AlertTriangle className="w-4 h-4 text-amber-500 shrink-0" />
            <span>
              Automated poller telemetry route (`/api/admin/reconciliation/poller`) is pending Workstream B merge; manual ingestion and D1 reconciliation logs remain live below.
            </span>
          </div>
        ) : pollerRuns.length > 0 ? (
          <div className="mb-6">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-gray-500 mb-2">
              Recent Partner Poller Telemetry
            </h3>
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-gray-200 text-xs">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Exchange</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Mode</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-600">Rows</th>
                    <th className="px-3 py-2 text-right font-semibold text-gray-600">Minted</th>
                    <th className="px-3 py-2 text-left font-semibold text-gray-600">Started At</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {pollerRuns.slice(0, 10).map((run) => (
                    <tr key={run.id}>
                      <td className="px-3 py-2 uppercase font-bold text-gray-800">{run.exchange}</td>
                      <td className="px-3 py-2 font-mono text-gray-600">{run.mode}</td>
                      <td className="px-3 py-2 font-semibold text-gray-800">{run.status}</td>
                      <td className="px-3 py-2 text-right font-mono">{run.fetchedRows ?? run.fetched_rows ?? 0}</td>
                      <td className="px-3 py-2 text-right font-mono">{run.mintedBatches ?? run.minted_batches ?? 0}</td>
                      <td className="px-3 py-2 text-gray-500">{run.startedAt ?? run.started_at ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : null}

        {/* Manual CSV/JSON Ingestion Form */}
        <form
          onSubmit={(e) => void handleManualIngest(e)}
          className="border border-gray-200 rounded-xl p-4 bg-gray-50/50 mb-6"
        >
          <div className="flex items-center gap-2 mb-3">
            <FileText className="w-4 h-4 text-gray-700" />
            <h3 className="text-sm font-bold text-gray-900">
              Manual Partner Statement Ingestion (`CSV` / `JSON`)
            </h3>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            <div>
              <label
                htmlFor="ingest-exchange"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Partner Exchange
              </label>
              <select
                id="ingest-exchange"
                value={ingestExchange}
                onChange={(e) =>
                  setIngestExchange(e.target.value as SupportedPartnerExchange)
                }
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs uppercase font-semibold"
              >
                {PARTNER_EXCHANGES.map((ex) => (
                  <option key={ex} value={ex}>
                    {ex.toUpperCase()}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label
                htmlFor="ingest-wallet-cash"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Wallet Cash Collected (USD)
              </label>
              <input
                id="ingest-wallet-cash"
                type="text"
                value={walletCashUsd}
                onChange={(e) => setWalletCashUsd(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="ingest-period-start"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Period Start (ISO)
              </label>
              <input
                id="ingest-period-start"
                type="text"
                value={periodStart}
                onChange={(e) => setPeriodStart(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="ingest-period-end"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Period End (ISO)
              </label>
              <input
                id="ingest-period-end"
                type="text"
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-3 mb-3">
            <div>
              <label
                htmlFor="ingest-partner-payload"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Raw Partner Statement (`CSV` / `JSON`)
              </label>
              <textarea
                id="ingest-partner-payload"
                rows={3}
                value={rawPartnerPayload}
                onChange={(e) => setRawPartnerPayload(e.target.value)}
                placeholder='{"rows":[...]} or CSV rows'
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="ingest-wallet-payload"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                Wallet Statement Evidence (optional)
              </label>
              <textarea
                id="ingest-wallet-payload"
                rows={3}
                value={rawWalletPayload}
                onChange={(e) => setRawWalletPayload(e.target.value)}
                placeholder="Exchange custody/deposit statement JSON or CSV"
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>

            <div>
              <label
                htmlFor="ingest-uid-map"
                className="block text-xs font-medium text-gray-700 mb-1"
              >
                UID-to-Profile Map (`JSON`)
              </label>
              <textarea
                id="ingest-uid-map"
                rows={3}
                value={uidMapJson}
                onChange={(e) => setUidMapJson(e.target.value)}
                placeholder='{"10001":{"traderProfileId":"usr_1"}}'
                className="w-full rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-mono"
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={ingesting}
            className="inline-flex items-center px-4 py-2 rounded-lg text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
          >
            <ShieldCheck className="w-4 h-4 mr-1.5" />
            {ingesting
              ? 'Verifying & Reconciling...'
              : 'Ingest & Reconcile Statement (Passkey Step-Up)'}
          </button>
        </form>

        {/* Live Reconciliations Table */}
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-700 mb-2">
              Live Reconciliations (`CASH_COLLECTED` + R2 `SHA-256`)
            </h3>
            {reconciliations.length === 0 ? (
              <p className="text-xs text-gray-500 py-3">
                No live `CASH_COLLECTED` reconciliation batches recorded yet.
              </p>
            ) : (
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Exchange</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-600">Cash USD</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-600">Minted</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">R2 SHA-256</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {reconciliations.map((rec) => (
                      <tr key={rec.id}>
                        <td className="px-3 py-2 uppercase font-bold text-gray-800">
                          {rec.exchange}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`px-2 py-0.5 rounded-full font-semibold ${
                              rec.status === 'MATCHED'
                                ? 'bg-emerald-100 text-emerald-800'
                                : rec.status === 'CLAWBACK_ADJUSTED'
                                  ? 'bg-amber-100 text-amber-800'
                                  : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {rec.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-800">
                          {formatUsdUnits1e8(rec.wallet_cash_collected_units)}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-800">
                          {formatUsdUnits1e8(rec.minted_gross_units)}
                        </td>
                        <td
                          className="px-3 py-2 font-mono text-gray-500"
                          title={rec.payload_sha256 ?? ''}
                        >
                          {shortHash(rec.payload_sha256, 8)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Shadow Reconciliations Table */}
          <div>
            <h3 className="text-xs font-bold uppercase tracking-wide text-gray-700 mb-2">
              Shadow Reconciliations (`KuCoin` / `Gate.io` 30-Day Audit)
            </h3>
            {shadowReconciliations.length === 0 ? (
              <p className="text-xs text-gray-500 py-3">
                No 30-day shadow audit batches logged yet.
              </p>
            ) : (
              <div className="overflow-x-auto border border-gray-200 rounded-lg">
                <table className="min-w-full divide-y divide-gray-200 text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Exchange</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">Status</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-600">UIDs</th>
                      <th className="px-3 py-2 text-right font-semibold text-gray-600">Sim Gross</th>
                      <th className="px-3 py-2 text-left font-semibold text-gray-600">R2 SHA-256</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {shadowReconciliations.map((sh) => (
                      <tr key={sh.id}>
                        <td className="px-3 py-2 uppercase font-bold text-gray-800">
                          {sh.exchange}
                        </td>
                        <td className="px-3 py-2">
                          <span
                            className={`px-2 py-0.5 rounded-full font-semibold ${
                              sh.status === 'PROMOTED_READY' ||
                              sh.status === 'SHADOW_LOGGED'
                                ? 'bg-indigo-100 text-indigo-800'
                                : 'bg-red-100 text-red-800'
                            }`}
                          >
                            {sh.status}
                          </span>
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-700">
                          {sh.mapped_uid_count}/{sh.row_count}
                        </td>
                        <td className="px-3 py-2 text-right font-mono text-gray-800">
                          {formatUsdUnits1e8(sh.simulated_gross_units)}
                        </td>
                        <td
                          className="px-3 py-2 font-mono text-gray-500"
                          title={sh.payload_sha256 ?? ''}
                        >
                          {shortHash(sh.payload_sha256, 8)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 3. Turnkey / Safe 2-of-3 Settlement Broadcast Queue */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-6">
        <div className="mb-4">
          <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
            <Activity className="w-5 h-5 text-emerald-600" />
            <span>Turnkey HSM & Safe 2-of-3 Cold Settlement Broadcast Queue</span>
          </h2>
          <p className="text-xs text-gray-500 mt-1">
            Recover uncertain `BROADCAST_PENDING` payouts (RBF / Horizon sequence check) or resolve `QUEUED_COLD_SAFE` ($250+/tx or $1,500+/24h) multisig executions.
          </p>
        </div>

        {/* Manual Phase 1 Settlement Dispatch Form */}
        <form
          onSubmit={(event) => void handleManualDispatch(event)}
          data-testid="manual-phase1-settlement-dispatch-form"
          className="mb-6 rounded-xl border border-gray-200 bg-gray-50/70 p-4 space-y-3"
        >
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
            <div>
              <h3 className="text-sm font-bold text-gray-900 flex items-center gap-1.5">
                <ShieldCheck className="w-4 h-4 text-emerald-600" />
                <span>Manual Phase 1 Settlement Dispatch</span>
              </h3>
              <p className="text-xs text-gray-500">
                Locks settled ledger units and dispatches Turnkey HSM / Safe 2-of-3 multichain USDC (`stellar`, `arbitrum`, `base`, min $10.00) with Passkey step-up.
              </p>
            </div>
            <button
              type="button"
              onClick={handleGenerateManualDispatchIds}
              className="inline-flex items-center px-3 py-1.5 rounded-lg border border-gray-300 bg-white text-xs font-semibold text-gray-700 hover:bg-gray-50"
            >
              Generate IDs
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label
                htmlFor="manual-dispatch-payout-id"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Payout ID
              </label>
              <input
                id="manual-dispatch-payout-id"
                type="text"
                value={manualPayoutId}
                onChange={(e) => setManualPayoutId(e.target.value)}
                placeholder="payout_phase1_..."
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="manual-dispatch-idempotency-key"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Idempotency Key
              </label>
              <input
                id="manual-dispatch-idempotency-key"
                type="text"
                value={manualIdempotencyKey}
                onChange={(e) => setManualIdempotencyKey(e.target.value)}
                placeholder="idem_phase1_..."
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div>
              <label
                htmlFor="manual-dispatch-affiliate-id"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Target Profile / Affiliate ID
              </label>
              <input
                id="manual-dispatch-affiliate-id"
                type="text"
                value={manualAffiliateId}
                onChange={(e) => setManualAffiliateId(e.target.value)}
                placeholder="user_alice"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
            <div className="md:col-span-2">
              <label
                htmlFor="manual-dispatch-owner-type"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Owner Type
              </label>
              <select
                id="manual-dispatch-owner-type"
                value={manualOwnerType}
                onChange={(e) =>
                  setManualOwnerType(e.target.value as ManualDispatchOwnerType)
                }
                className="w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-xs text-gray-900 focus:border-indigo-500 focus:outline-none"
              >
                <option value="affiliate">affiliate</option>
                <option value="trader">trader</option>
                <option value="agency">agency</option>
              </select>
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="manual-dispatch-chain"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Chain
              </label>
              <select
                id="manual-dispatch-chain"
                value={manualChain}
                onChange={(e) =>
                  setManualChain(e.target.value as ManualDispatchChain)
                }
                className="w-full rounded-lg border border-gray-300 bg-white px-2.5 py-2 text-xs text-gray-900 focus:border-indigo-500 focus:outline-none"
              >
                <option value="arbitrum">arbitrum</option>
                <option value="base">base</option>
                <option value="stellar">stellar</option>
              </select>
            </div>

            <div className="md:col-span-4">
              <label
                htmlFor="manual-dispatch-recipient"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Recipient Address
              </label>
              <input
                id="manual-dispatch-recipient"
                type="text"
                value={manualRecipientAddress}
                onChange={(e) => setManualRecipientAddress(e.target.value)}
                placeholder="0x... or G..."
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="md:col-span-2">
              <label
                htmlFor="manual-dispatch-amount-usd"
                className="block text-xs font-semibold uppercase tracking-wide text-gray-600 mb-1"
              >
                Amount USD (min $10)
              </label>
              <input
                id="manual-dispatch-amount-usd"
                type="text"
                inputMode="decimal"
                value={manualAmountUsd}
                onChange={(e) => setManualAmountUsd(e.target.value)}
                placeholder="10.00"
                className="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-xs font-mono text-gray-900 focus:border-indigo-500 focus:outline-none"
              />
            </div>

            <div className="md:col-span-2">
              <button
                type="submit"
                disabled={dispatchingManual}
                className="w-full inline-flex items-center justify-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5" />
                {dispatchingManual ? 'Dispatching...' : 'Dispatch Settlement'}
              </button>
            </div>
          </div>
        </form>

        {broadcasts.length === 0 ? (
          <p className="text-xs text-gray-500 py-3">
            No Turnkey or Safe 2-of-3 settlement broadcasts recorded yet.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200 text-xs">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">Payout ID</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">Chain</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">Recipient</th>
                  <th className="px-3 py-2 text-right font-semibold text-gray-600">Amount</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">State</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">Tx / Safe Hash</th>
                  <th className="px-3 py-2 text-left font-semibold text-gray-600">Passkey Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {broadcasts.map((item) => {
                  const isBusy = busyPayoutId === item.payout_id;
                  return (
                    <tr key={item.payout_id}>
                      <td className="px-3 py-2 font-mono font-semibold text-gray-900">
                        {item.payout_id}
                      </td>
                      <td className="px-3 py-2 uppercase font-bold text-gray-700">
                        {item.chain}
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-600">
                        {shortHash(item.recipient_address, 6)}
                      </td>
                      <td className="px-3 py-2 text-right font-mono font-semibold text-gray-900">
                        {formatUsdUnits1e8(item.amount_units_1e8)}
                      </td>
                      <td className="px-3 py-2">
                        <span
                          className={`px-2 py-0.5 rounded-full font-semibold ${getBroadcastBadgeClass(
                            item.state
                          )}`}
                        >
                          {item.state}
                        </span>
                      </td>
                      <td className="px-3 py-2 font-mono text-gray-500">
                        {shortHash(
                          item.tx_hash || item.safe_multisig_tx_hash,
                          8
                        )}
                      </td>
                      <td className="px-3 py-2">
                        {item.state === 'BROADCAST_PENDING' ||
                        item.state === 'EXPIRED_RECOVERED' ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                void handleRecoverBroadcast(
                                  item.payout_id,
                                  false
                                )
                              }
                              className="px-2.5 py-1 rounded bg-amber-600 text-white font-semibold hover:bg-amber-700 disabled:opacity-50"
                            >
                              {isBusy ? 'Recovering...' : 'Recover RPC'}
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                void handleRecoverBroadcast(
                                  item.payout_id,
                                  true
                                )
                              }
                              className="px-2.5 py-1 rounded bg-indigo-600 text-white font-semibold hover:bg-indigo-700 disabled:opacity-50"
                            >
                              Re-Execute Expired
                            </button>
                          </div>
                        ) : item.state === 'QUEUED_COLD_SAFE' ? (
                          <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-1.5">
                            <input
                              type="text"
                              value={safeTxHashes[item.payout_id] ?? ''}
                              onChange={(e) =>
                                setSafeTxHashes((prev) => ({
                                  ...prev,
                                  [item.payout_id]: e.target.value,
                                }))
                              }
                              placeholder="Safe on-chain txHash"
                              className="rounded border border-gray-300 px-2 py-1 text-xs font-mono w-36"
                            />
                            <input
                              type="text"
                              value={safeReasons[item.payout_id] ?? ''}
                              onChange={(e) =>
                                setSafeReasons((prev) => ({
                                  ...prev,
                                  [item.payout_id]: e.target.value,
                                }))
                              }
                              placeholder="Reason / note"
                              className="rounded border border-gray-300 px-2 py-1 text-xs w-28"
                            />
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                void handleResolveColdSafe(
                                  item.payout_id,
                                  'CONFIRMED'
                                )
                              }
                              className="px-2.5 py-1 rounded bg-emerald-600 text-white font-semibold hover:bg-emerald-700 disabled:opacity-50"
                            >
                              Confirm Safe
                            </button>
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() =>
                                void handleResolveColdSafe(
                                  item.payout_id,
                                  'CANCELLED'
                                )
                              }
                              className="px-2.5 py-1 rounded bg-red-600 text-white font-semibold hover:bg-red-700 disabled:opacity-50"
                            >
                              Abort
                            </button>
                          </div>
                        ) : (
                          <span className="text-gray-400">Terminal</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <B2bAgencyContractsPanel />
    </div>
  );
}
