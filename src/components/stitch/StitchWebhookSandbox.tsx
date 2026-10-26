'use client';

import React, { useState, useMemo } from 'react';
import type { WebhookSandboxPreset } from '@/data/stitch-terminal-data';

export interface StitchWebhookSandboxProps {
  readonly presets: readonly WebhookSandboxPreset[];
  readonly locale: 'en' | 'vi';
}

export function StitchWebhookSandbox({
  presets,
  locale,
}: Readonly<StitchWebhookSandboxProps>) {
  const isVi = locale === 'vi';

  const [selectedProviderId, setSelectedProviderId] =
    useState<WebhookSandboxPreset['providerId']>('binance');
  const [tamperMode, setTamperMode] = useState<'VALID' | 'INVALID_SIG' | 'DUPLICATE_NONCE'>(
    'VALID'
  );

  // Screen 8: Live EIP-1559 & Solana Priority Fee Surge Simulator state
  const [ethBaseFeeGwei, setEthBaseFeeGwei] = useState<number>(28);
  const [ethHotReserve, setEthHotReserve] = useState<number>(1.84);
  const [solPriorityMicroLamports, setSolPriorityMicroLamports] = useState<number>(5000);

  const activePreset = useMemo(
    () => presets.find((p) => p.providerId === selectedProviderId) ?? presets[0],
    [presets, selectedProviderId]
  );

  const tierSplits = useMemo(() => {
    const fee = activePreset.exchangeFeeUsd;
    return {
      l1: (fee * 0.3).toFixed(2),
      l2: (fee * 0.1).toFixed(2),
      l3: (fee * 0.05).toFixed(2),
    };
  }, [activePreset]);

  const ethCircuitState = useMemo(() => {
    if (ethHotReserve < 0.05 || ethBaseFeeGwei > 180) {
      return {
        status: 'CRITICAL · CIRCUIT_OPEN (PAUSED)',
        badgeClass: 'text-stitch-crimson',
        action: 'Auto-Pause ERC-20 Rail -> Failover to Stellar XLM/USDC & Solana SPL',
      };
    }
    if (ethHotReserve < 0.2 || ethBaseFeeGwei > 90) {
      return {
        status: 'LOW_RESERVE · ELEVATED_GAS',
        badgeClass: 'text-stitch-amber',
        action: 'Batching Non-Urgent ERC-20 Payouts · Stellar & Solana Normal',
      };
    }
    return {
      status: 'HEALTHY · ALL RAILS OPEN',
      badgeClass: 'text-stitch-emerald',
      action: 'Atomic D1 Two-Phase Settlement Running Across All 3 Chains',
    };
  }, [ethBaseFeeGwei, ethHotReserve]);

  return (
    <section
      aria-labelledby="sandbox-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 7 & 8 · PHÒNG THÍ NGHIỆM WEBHOOK HMAC & MÔ PHỎNG PHÍ GAS'
              : 'SCREENS 7 & 8 · WEBHOOK HMAC SANDBOX & EIP-1559 FEE SURGE SIMULATOR'}
          </p>
          <h2
            id="sandbox-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Kiểm Thử Chữ Ký Webhook Đa Sàn & Cầu Dao Ngân Quỹ'
              : 'Multi-Exchange Webhook Replay & Treasury Circuit Breaker Lab'}
          </h2>
        </div>
      </header>

      {/* Screen 7: Multi-Exchange Webhook Replay & HMAC Sandbox */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              Screen 7 · Multi-Exchange Webhook HMAC-SHA256 / SHA512 Verifier
            </h3>
            <p className="text-xs text-stitch-muted">
              Binance · Bybit · OKX · KuCoin · NOWPayments IPN (Cloudflare KV 24h Nonce Guard)
            </p>
          </div>

          <div className="flex flex-wrap gap-2" role="group" aria-label="Webhook provider selector">
            {presets.map((preset) => {
              const active = preset.providerId === selectedProviderId;
              return (
                <button
                  key={preset.providerId}
                  type="button"
                  aria-pressed={active}
                  onClick={() => setSelectedProviderId(preset.providerId)}
                  className={`rounded-lg px-3 py-1.5 font-mono text-xs uppercase transition-colors ${
                    active
                      ? 'bg-gradient-primary font-bold text-stitch-primary'
                      : 'border border-stitch-divider bg-stitch-well text-stitch-muted hover:text-stitch-primary'
                  }`}
                >
                  {preset.providerId}
                </button>
              );
            })}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div>
            <div className="flex items-center justify-between font-mono text-xs text-stitch-muted">
              <span>Header: {activePreset.signatureHeader}</span>
              <span>{activePreset.algorithm}</span>
            </div>
            <pre className="mt-2 overflow-x-auto rounded-lg border border-stitch-divider bg-stitch-canvas p-4 font-mono text-xs text-stitch-cyan">
              {activePreset.samplePayload}
            </pre>
          </div>

          <div className="flex flex-col justify-between space-y-4">
            <div className="rounded-lg border border-stitch-divider bg-stitch-well/70 p-4 font-mono text-xs space-y-2">
              <div className="flex justify-between">
                <span className="text-stitch-muted">Replay Protection:</span>
                <span className="text-stitch-primary">{activePreset.replayWindow}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">3-Tier Commission Cascade:</span>
                <span className="text-stitch-emerald">
                  L1 ${tierSplits.l1} · L2 ${tierSplits.l2} · L3 ${tierSplits.l3} USDC
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">Verification Outcome:</span>
                <span
                  className={
                    tamperMode === 'VALID'
                      ? 'font-bold text-stitch-emerald'
                      : 'font-bold text-stitch-crimson'
                  }
                >
                  {tamperMode === 'VALID'
                    ? '200 OK · HMAC_SIGNATURE_VERIFIED'
                    : tamperMode === 'INVALID_SIG'
                      ? '401 UNAUTHORIZED · SIGNATURE_MISMATCH'
                      : '409 CONFLICT · KV_NONCE_REPLAY_BLOCKED'}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setTamperMode('VALID')}
                className="rounded-lg bg-gradient-primary px-3 py-2 font-mono text-xs font-bold text-stitch-primary"
              >
                Replay Valid Signed Payload
              </button>
              <button
                type="button"
                onClick={() => setTamperMode('INVALID_SIG')}
                className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-2 font-mono text-xs text-stitch-crimson"
              >
                Simulate Tampered HMAC
              </button>
              <button
                type="button"
                onClick={() => setTamperMode('DUPLICATE_NONCE')}
                className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-2 font-mono text-xs text-stitch-amber"
              >
                Simulate Duplicate Nonce
              </button>
            </div>
          </div>
        </div>
      </article>

      {/* Screen 8: Live EIP-1559 & Solana Priority Fee Surge Simulator */}
      <article className="stitch-obsidian-card p-6">
        <div className="border-b border-stitch-border pb-4">
          <h3 className="text-lg font-display font-bold text-stitch-primary">
            Screen 8 · Live EIP-1559 &amp; Solana Priority Fee Surge Simulator
          </h3>
          <p className="text-xs text-stitch-muted">
            Interactive chaos test for `TreasuryHealthService` Auto-Pause Circuit Breaker
          </p>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-3">
          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="eth-gas-slider" className="text-stitch-muted">
                Ethereum EIP-1559 Base Fee:
              </label>
              <span className="font-bold text-stitch-cyan">{ethBaseFeeGwei} gwei</span>
            </div>
            <input
              id="eth-gas-slider"
              type="range"
              min={10}
              max={300}
              step={5}
              value={ethBaseFeeGwei}
              onChange={(e) => setEthBaseFeeGwei(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
            />
          </div>

          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="eth-reserve-slider" className="text-stitch-muted">
                ETH Hot Wallet Gas Reserve:
              </label>
              <span className="font-bold text-stitch-violet">{ethHotReserve.toFixed(2)} ETH</span>
            </div>
            <input
              id="eth-reserve-slider"
              type="range"
              min={0.01}
              max={2.5}
              step={0.01}
              value={ethHotReserve}
              onChange={(e) => setEthHotReserve(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-secondary-500"
            />
          </div>

          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="sol-priority-slider" className="text-stitch-muted">
                Solana Priority Fee (micro-lamports):
              </label>
              <span className="font-bold text-stitch-emerald">
                {solPriorityMicroLamports.toLocaleString('en-US')} µL
              </span>
            </div>
            <input
              id="sol-priority-slider"
              type="range"
              min={1000}
              max={200000}
              step={1000}
              value={solPriorityMicroLamports}
              onChange={(e) => setSolPriorityMicroLamports(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
            />
          </div>
        </div>

        <div
          aria-live="polite"
          className="mt-4 flex flex-col justify-between gap-2 rounded-lg border border-stitch-divider bg-stitch-canvas/80 p-4 font-mono text-xs sm:flex-row sm:items-center"
        >
          <div>
            <span className="text-stitch-muted">Circuit Breaker State: </span>
            <span className={`font-bold ${ethCircuitState.badgeClass}`}>
              {ethCircuitState.status}
            </span>
          </div>
          <div className="text-stitch-primary">{ethCircuitState.action}</div>
        </div>
      </article>
    </section>
  );
}
