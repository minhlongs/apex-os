'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Loader2,
  Lock,
  ShieldAlert,
  Unlock,
  Wallet,
  XCircle,
} from 'lucide-react';
import type {
  Phase1PayoutChain,
  WalletChangeRequestRow,
  WalletPayoutUnlockStatus,
} from '@/lib/wallet/timelock-wallet-service';

export interface PayoutWalletTimelockPanelProps {
  locale?: string;
  onWalletMutated?: () => void;
}

const PHASE1_CHAINS: ReadonlyArray<{
  value: Phase1PayoutChain;
  label: string;
  placeholder: string;
}> = [
  {
    value: 'stellar',
    label: 'Stellar (USDC Classic G-Address)',
    placeholder: 'G... (56-char Stellar StrKey)',
  },
  {
    value: 'arbitrum',
    label: 'Arbitrum One (Native USDC)',
    placeholder: '0x... (42-char EVM address)',
  },
  {
    value: 'base',
    label: 'Base (Native USDC)',
    placeholder: '0x... (42-char EVM address)',
  },
];

function formatCountdown48h(unlockAtIso: string, nowMs: number): {
  matured: boolean;
  label: string;
} {
  const unlockMs = Date.parse(unlockAtIso);
  if (Number.isNaN(unlockMs)) {
    return { matured: false, label: 'Calculating...' };
  }
  const diffMs = unlockMs - nowMs;
  if (diffMs <= 0) {
    return { matured: true, label: '48h Timelock Matured — Ready to Activate' };
  }
  const totalMinutes = Math.ceil(diffMs / 60000);
  const hours = Math.trunc(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return {
    matured: false,
    label: `${hours}h ${minutes}m remaining in 48h ATO safety window`,
  };
}

export function PayoutWalletTimelockPanel({
  onWalletMutated,
}: PayoutWalletTimelockPanelProps) {
  const [payoutStatus, setPayoutStatus] = useState<WalletPayoutUnlockStatus | null>(null);
  const [requests, setRequests] = useState<WalletChangeRequestRow[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [actingId, setActingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  const [proposedChain, setProposedChain] = useState<Phase1PayoutChain>('arbitrum');
  const [proposedAddress, setProposedAddress] = useState<string>('');

  const loadWalletState = useCallback(async () => {
    try {
      setLoading(true);
      const res = await fetch('/api/profile/wallet/timelock', { credentials: 'include' });
      const data = (await res.json()) as {
        success?: boolean;
        payoutStatus?: WalletPayoutUnlockStatus;
        requests?: WalletChangeRequestRow[];
        error?: string;
      };
      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? 'Failed to load payout wallet status.');
        return;
      }
      setPayoutStatus(data.payoutStatus ?? null);
      setRequests(data.requests ?? []);
      setErrorMsg(null);
    } catch {
      setErrorMsg('Network error while loading payout wallet settings.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadWalletState();
  }, [loadWalletState]);

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 30000);
    return () => clearInterval(timer);
  }, []);

  const pendingRequest = useMemo(
    () => requests.find((r) => r.status === 'PENDING_TIMELOCK') ?? null,
    [requests]
  );

  const selectedChainMeta =
    PHASE1_CHAINS.find((c) => c.value === proposedChain) ?? PHASE1_CHAINS[1];

  const handleProposeWallet = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setErrorMsg(null);
    setSuccessMsg(null);

    if (!proposedAddress.trim()) {
      setErrorMsg('Enter a valid non-custodial USDC destination address.');
      return;
    }

    try {
      setSubmitting(true);
      const res = await fetch('/api/profile/wallet/timelock', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proposedChain,
          proposedAddress: proposedAddress.trim(),
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
      };

      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? 'Failed to propose payout wallet change.');
        return;
      }

      setProposedAddress('');
      setSuccessMsg(
        '48-hour payout wallet timelock initiated. Withdrawals pause until timelock matures.'
      );
      await loadWalletState();
      onWalletMutated?.();
    } catch {
      setErrorMsg('Network error while proposing payout wallet.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRequestAction = async (requestId: string, action: 'activate' | 'cancel') => {
    setErrorMsg(null);
    setSuccessMsg(null);
    try {
      setActingId(requestId);
      const res = await fetch('/api/profile/wallet/timelock', {
        method: 'PATCH',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, action }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
      };
      if (!res.ok || !data.success) {
        setErrorMsg(data.error ?? `Failed to ${action} wallet change request.`);
        return;
      }
      setSuccessMsg(
        action === 'cancel'
          ? 'Pending wallet change cancelled immediately. Previous wallet security state restored.'
          : 'Matured payout wallet activated for USDC settlements.'
      );
      await loadWalletState();
      onWalletMutated?.();
    } catch {
      setErrorMsg(`Network error while attempting to ${action} wallet request.`);
    } finally {
      setActingId(null);
    }
  };

  const pendingCountdown = pendingRequest
    ? formatCountdown48h(pendingRequest.unlock_at, nowMs)
    : null;

  return (
    <section
      aria-labelledby="payout-wallet-timelock-heading"
      className="bg-stitch-surface border border-stitch-border rounded-2xl p-6 space-y-5"
    >
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
        <div>
          <h2
            id="payout-wallet-timelock-heading"
            className="text-lg font-semibold text-stitch-primary flex items-center gap-2"
          >
            <Wallet className="h-5 w-5 text-stitch-violet" />
            48-Hour Timelocked USDC Payout Wallet
          </h2>
          <p className="text-xs text-stitch-muted mt-0.5">
            Phase 1 settlement rails: Stellar, Arbitrum, and Base ($10.00 USDC minimum withdrawal).
          </p>
        </div>

        {payoutStatus?.unlocked ? (
          <span
            data-testid="wallet-unlock-pill"
            className="inline-flex items-center gap-1.5 rounded-full bg-stitch-emerald/15 px-3 py-1 text-xs font-medium text-stitch-emerald"
          >
            <Unlock className="h-3.5 w-3.5" />
            Payouts Unlocked
          </span>
        ) : (
          <span
            data-testid="wallet-unlock-pill"
            className="inline-flex items-center gap-1.5 rounded-full bg-stitch-amber/15 px-3 py-1 text-xs font-medium text-stitch-amber"
          >
            <Lock className="h-3.5 w-3.5" />
            {payoutStatus?.reason === 'WALLET_TIMELOCK_ACTIVE_48H'
              ? '48h Timelock Active'
              : 'No Active Wallet'}
          </span>
        )}
      </div>

      {/* Current Active Destination Summary */}
      <div className="rounded-xl border border-stitch-border bg-black/25 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="space-y-1">
          <p className="text-xs text-stitch-muted uppercase tracking-wider">
            Active USDC Destination
          </p>
          {loading ? (
            <p className="text-xs text-stitch-muted">Loading wallet state...</p>
          ) : payoutStatus?.walletAddress ? (
            <p className="font-mono text-sm text-stitch-primary break-all">
              <span className="uppercase text-stitch-indigo mr-2">
                [{payoutStatus.chain ?? 'usdc'}]
              </span>
              {payoutStatus.walletAddress}
            </p>
          ) : (
            <p className="text-sm text-stitch-muted">
              No active payout wallet bound yet. Propose a Stellar, Arbitrum, or Base address below.
            </p>
          )}
        </div>
      </div>

      {/* Active 48h Pending Timelock Banner + Emergency Cancel / Activate */}
      {pendingRequest && pendingCountdown && (
        <div
          data-testid="pending-timelock-card"
          className="rounded-xl border border-stitch-amber/40 bg-stitch-amber/10 p-4 space-y-3"
        >
          <div className="flex items-start gap-2.5">
            <ShieldAlert className="h-5 w-5 text-stitch-amber shrink-0 mt-0.5" />
            <div className="space-y-1 text-xs">
              <p className="font-semibold text-stitch-amber flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                {pendingCountdown.label}
              </p>
              <p className="text-stitch-primary font-mono break-all">
                Proposed [{pendingRequest.proposed_chain.toUpperCase()}]:{' '}
                {pendingRequest.proposed_address}
              </p>
              <p className="text-stitch-muted">
                Unlocks at {pendingRequest.unlock_at}. Did not authorize this change? Cancel
                immediately below to block account takeover (ATO) drainage.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {pendingCountdown.matured && (
              <button
                type="button"
                disabled={actingId === pendingRequest.id}
                onClick={() => void handleRequestAction(pendingRequest.id, 'activate')}
                className="inline-flex items-center gap-1.5 rounded-xl bg-stitch-emerald px-3.5 py-1.5 text-xs font-semibold text-black hover:opacity-90 disabled:opacity-50"
              >
                {actingId === pendingRequest.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                ) : (
                  <CheckCircle2 className="h-3.5 w-3.5" />
                )}
                Activate Matured Wallet
              </button>
            )}

            <button
              type="button"
              disabled={actingId === pendingRequest.id}
              onClick={() => void handleRequestAction(pendingRequest.id, 'cancel')}
              className="inline-flex items-center gap-1.5 rounded-xl border border-red-500/40 bg-red-500/15 px-3.5 py-1.5 text-xs font-semibold text-red-300 hover:bg-red-500/25 disabled:opacity-50"
            >
              {actingId === pendingRequest.id ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <XCircle className="h-3.5 w-3.5" />
              )}
              Emergency Cancel Request
            </button>
          </div>
        </div>
      )}

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

      {/* Propose New Timelocked Wallet Form */}
      <form onSubmit={handleProposeWallet} className="grid grid-cols-1 md:grid-cols-12 gap-3 items-end">
        <div className="md:col-span-4">
          <label
            htmlFor="wallet-chain-select"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Phase 1 USDC Network
          </label>
          <select
            id="wallet-chain-select"
            value={proposedChain}
            onChange={(e) => setProposedChain(e.target.value as Phase1PayoutChain)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          >
            {PHASE1_CHAINS.map((chain) => (
              <option key={chain.value} value={chain.value}>
                {chain.label}
              </option>
            ))}
          </select>
        </div>

        <div className="md:col-span-5">
          <label
            htmlFor="wallet-address-input"
            className="block text-xs font-medium text-stitch-muted mb-1"
          >
            Non-Custodial Destination Address
          </label>
          <input
            id="wallet-address-input"
            type="text"
            autoComplete="off"
            placeholder={selectedChainMeta.placeholder}
            value={proposedAddress}
            onChange={(e) => setProposedAddress(e.target.value)}
            className="w-full rounded-xl border border-stitch-border bg-black/30 px-3 py-2 text-sm font-mono text-stitch-primary focus:outline-none focus:border-stitch-indigo"
          />
        </div>

        <div className="md:col-span-3">
          <button
            type="submit"
            disabled={submitting || Boolean(pendingRequest)}
            className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl bg-stitch-indigo hover:bg-stitch-violet disabled:opacity-50 px-4 py-2 text-sm font-medium text-white transition-colors"
          >
            {submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Lock className="h-4 w-4" />
            )}
            Propose (48h Lock)
          </button>
        </div>
      </form>
    </section>
  );
}

export default PayoutWalletTimelockPanel;
