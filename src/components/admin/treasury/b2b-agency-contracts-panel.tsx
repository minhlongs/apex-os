'use client';

/**
 * White-Label B2B Agency Split Contracts Admin Panel
 *
 * Consumes `GET` / `POST /api/admin/b2b-contracts` (WebAuthn Passkey step-up required)
 * and enforces `G1` Safe-Spread Waterfall I4 invariants:
 * - `clawbackReserveBps` in `[500, 2500]` (`5.00%` – `25.00%` of gross `C`)
 * - `traderCashbackBps` in `[0, 8000]` (`0.00%` – `80.00%` of distributable `D = C - R`)
 * - `tier1SpreadBps + tier2SpreadBps <= 4500` (`<= 45.00%` of spread `S = D - T`)
 * - `tier2SpreadBps <= 1000` (`<= 10.00%` of spread `S`)
 * - `tier3SpreadBps === 0` hard-locked (Vietnam Decree 40/2018/ND-CP)
 */

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, CheckCircle, RefreshCw, ShieldCheck, AlertTriangle } from 'lucide-react';
import { obtainAdminStepUpToken } from '@/lib/auth/webauthn-browser';

interface EffectiveGrossPct {
  clawbackReservePct: string;
  traderCashbackPct: string;
  l1AffiliatePct: string;
  b2bAgencyL2Pct: string;
  l3CapPct: '0.00';
  platformNetPct: string;
}

interface B2bContractItem {
  id: string;
  agencyProfileId: string;
  agencyName: string;
  clawbackReserveBps: number;
  traderCashbackBps: number;
  tier1SpreadBps: number;
  tier2SpreadBps: number;
  tier3SpreadBps: 0;
  status: 'ACTIVE' | 'PAUSED' | 'TERMINATED';
  notes: string | null;
  updatedAt: string;
  effectiveGrossSharesPct: EffectiveGrossPct;
}

export function B2bAgencyContractsPanel(): React.ReactElement {
  const [contracts, setContracts] = useState<B2bContractItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const [agencyProfileId, setAgencyProfileId] = useState<string>('');
  const [agencyName, setAgencyName] = useState<string>('');
  const [clawbackReserveBps, setClawbackReserveBps] = useState<number>(500);
  const [traderCashbackBps, setTraderCashbackBps] = useState<number>(5000);
  const [tier1SpreadBps, setTier1SpreadBps] = useState<number>(3000);
  const [tier2SpreadBps, setTier2SpreadBps] = useState<number>(1000);
  const [status, setStatus] = useState<'ACTIVE' | 'PAUSED' | 'TERMINATED'>('ACTIVE');
  const [notes, setNotes] = useState<string>('');

  const loadContracts = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/admin/b2b-contracts', {
        method: 'GET',
        credentials: 'include',
      });
      const data = (await res.json()) as {
        success?: boolean;
        contracts?: B2bContractItem[];
        error?: string;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Failed to load B2B contracts (${res.status})`);
      }
      setContracts(data.contracts ?? []);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Unable to load B2B contracts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadContracts();
  }, [loadContracts]);

  // Real-time preview of gross shares from basis points
  const reserveRatio = Math.max(0, Math.min(10000, clawbackReserveBps)) / 10000;
  const distributableRatio = 1 - reserveRatio;
  const traderGrossPct = distributableRatio * (traderCashbackBps / 10000) * 100;
  const spreadRatio = distributableRatio * (1 - traderCashbackBps / 10000);
  const l1GrossPct = spreadRatio * (tier1SpreadBps / 10000) * 100;
  const l2GrossPct = spreadRatio * (tier2SpreadBps / 10000) * 100;
  const platformGrossPct = spreadRatio * (1 - (tier1SpreadBps + tier2SpreadBps) / 10000) * 100;
  const combinedSpreadBps = tier1SpreadBps + tier2SpreadBps;
  const solvencyExceeded = combinedSpreadBps > 4500 || tier2SpreadBps > 1000 || clawbackReserveBps < 500;

  const handleUpsert = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    setSubmitting(true);
    try {
      const stepUp = await obtainAdminStepUpToken();
      const res = await fetch('/api/admin/b2b-contracts', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json',
          'x-passkey-stepup-token': stepUp.stepUpToken,
        },
        body: JSON.stringify({
          agencyProfileId: agencyProfileId.trim(),
          agencyName: agencyName.trim(),
          clawbackReserveBps,
          traderCashbackBps,
          tier1SpreadBps,
          tier2SpreadBps,
          tier3SpreadBps: 0,
          status,
          notes: notes.trim() || undefined,
        }),
      });
      const data = (await res.json()) as {
        success?: boolean;
        error?: string;
        contract?: B2bContractItem;
      };
      if (!res.ok || !data.success) {
        throw new Error(data.error || `Contract save failed (${res.status})`);
      }
      setMessage(
        `Saved B2B split schedule for ${data.contract?.agencyName ?? agencyName} (${data.contract?.status ?? status}).`
      );
      await loadContracts();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to save B2B agency contract');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6 shadow-sm space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <Building2 className="w-5 h-5 text-indigo-600" />
          <div>
            <h3 className="text-base font-bold text-gray-900">
              White-Label B2B Agency Split Contracts (Safe-Spread Waterfall I4)
            </h3>
            <p className="text-xs text-gray-500">
              Solvency cap: L1 + L2 &le; 45.00% of Spread S (4,500 bps) &bull; B2B L2 &le; 10.00% (1,000 bps) &bull; L3 = 0% hard-locked (Decree 40/2018/ND-CP)
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void loadContracts()}
          disabled={loading}
          className="inline-flex items-center gap-1.5 rounded-lg border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {error && (
        <div className="flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {message && (
        <div className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-800">
          <CheckCircle className="w-4 h-4 shrink-0" />
          <span>{message}</span>
        </div>
      )}

      <form onSubmit={(e) => void handleUpsert(e)} className="grid grid-cols-1 md:grid-cols-6 gap-3 bg-gray-50 rounded-lg p-4 border border-gray-200">
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Agency Profile ID
          </label>
          <input
            type="text"
            required
            value={agencyProfileId}
            onChange={(e) => setAgencyProfileId(e.target.value)}
            placeholder="usr_agency_quantdesk"
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Quant Desk / Community Name
          </label>
          <input
            type="text"
            required
            value={agencyName}
            onChange={(e) => setAgencyName(e.target.value)}
            placeholder="Apex Quant Syndicate"
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Status
          </label>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as 'ACTIVE' | 'PAUSED' | 'TERMINATED')}
            className="w-full rounded border border-gray-300 px-2 py-1.5 text-xs bg-white"
          >
            <option value="ACTIVE">ACTIVE</option>
            <option value="PAUSED">PAUSED</option>
            <option value="TERMINATED">TERMINATED</option>
          </select>
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            L3 Cap (bps)
          </label>
          <input
            type="text"
            disabled
            value="0 (Hard-Locked)"
            className="w-full rounded border border-gray-200 bg-gray-100 px-2.5 py-1.5 text-xs font-mono text-gray-500"
          />
        </div>

        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Reserve (500–2500 bps)
          </label>
          <input
            type="number"
            min={500}
            max={2500}
            value={clawbackReserveBps}
            onChange={(e) => setClawbackReserveBps(Number(e.target.value))}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Trader Share D (0–8000)
          </label>
          <input
            type="number"
            min={0}
            max={8000}
            value={traderCashbackBps}
            onChange={(e) => setTraderCashbackBps(Number(e.target.value))}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            L1 Spread S (0–4500)
          </label>
          <input
            type="number"
            min={0}
            max={4500}
            value={tier1SpreadBps}
            onChange={(e) => setTier1SpreadBps(Number(e.target.value))}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs font-mono"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            B2B L2 Spread S (0–1000)
          </label>
          <input
            type="number"
            min={0}
            max={1000}
            value={tier2SpreadBps}
            onChange={(e) => setTier2SpreadBps(Number(e.target.value))}
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs font-mono"
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-xs font-semibold text-gray-700 mb-1">
            Contract Audit Note
          </label>
          <input
            type="text"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Signed institutional addendum ref"
            className="w-full rounded border border-gray-300 px-2.5 py-1.5 text-xs"
          />
        </div>

        <div className="md:col-span-6 flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-gray-200">
          <div className="text-xs text-gray-600 font-mono">
            Effective Gross Split: Reserve {(reserveRatio * 100).toFixed(2)}% &bull; Trader{' '}
            {traderGrossPct.toFixed(2)}% &bull; L1 {l1GrossPct.toFixed(2)}% &bull; B2B L2{' '}
            {l2GrossPct.toFixed(2)}% &bull; L3 0.00% &bull; Platform {platformGrossPct.toFixed(2)}%
          </div>
          <button
            type="submit"
            disabled={submitting || solvencyExceeded}
            className="inline-flex items-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            {submitting ? 'Authorizing via Passkey...' : 'Save Contract (Passkey Step-Up)'}
          </button>
        </div>
      </form>

      {contracts.length === 0 ? (
        <p className="text-xs text-gray-500">
          No custom B2B agency contracts provisioned yet. Retail defaults apply (5.00% Reserve / 47.50% Trader / 14.25% L1 / 0.00% L2 / 0.00% L3 / 33.25% Platform).
        </p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead>
              <tr className="border-b border-gray-200 text-left text-gray-500">
                <th className="py-2 pr-3">Agency</th>
                <th className="py-2 pr-3">Status</th>
                <th className="py-2 pr-3">Schedule (bps)</th>
                <th className="py-2 pr-3">Effective Gross % (R / T / L1 / L2 / L3 / Net)</th>
                <th className="py-2">Updated</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {contracts.map((c) => (
                <tr key={c.id}>
                  <td className="py-2 pr-3">
                    <div className="font-semibold text-gray-900">{c.agencyName}</div>
                    <div className="font-mono text-[11px] text-gray-500">{c.agencyProfileId}</div>
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={`inline-block rounded px-2 py-0.5 font-semibold ${
                        c.status === 'ACTIVE'
                          ? 'bg-emerald-100 text-emerald-800'
                          : 'bg-gray-100 text-gray-700'
                      }`}
                    >
                      {c.status}
                    </span>
                  </td>
                  <td className="py-2 pr-3 font-mono">
                    R:{c.clawbackReserveBps} / T:{c.traderCashbackBps} / L1:{c.tier1SpreadBps} / L2:{c.tier2SpreadBps} / L3:0
                  </td>
                  <td className="py-2 pr-3 font-mono text-gray-700">
                    {c.effectiveGrossSharesPct.clawbackReservePct}% /{' '}
                    {c.effectiveGrossSharesPct.traderCashbackPct}% /{' '}
                    {c.effectiveGrossSharesPct.l1AffiliatePct}% /{' '}
                    {c.effectiveGrossSharesPct.b2bAgencyL2Pct}% / 0.00% /{' '}
                    {c.effectiveGrossSharesPct.platformNetPct}%
                  </td>
                  <td className="py-2 text-gray-500">{c.updatedAt}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
