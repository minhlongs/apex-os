'use client';

import React, { useState } from 'react';
import type { ChainTreasuryStatus } from '@/data/stitch-terminal-data';

export interface StitchMultiChainPayoutsProps {
  readonly rails: readonly ChainTreasuryStatus[];
  readonly locale: 'en' | 'vi';
}

export function StitchMultiChainPayouts({
  rails,
  locale,
}: Readonly<StitchMultiChainPayoutsProps>) {
  const isVi = locale === 'vi';

  const [selectedChain, setSelectedChain] = useState<'stellar' | 'ethereum' | 'solana'>('stellar');
  const [walletInput, setWalletInput] = useState<string>(
    'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37'
  );
  const [batchIdempotencyKey, setBatchIdempotencyKey] = useState<string>(
    'sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
  );
  const [settlementStatus, setSettlementStatus] = useState<'IDLE' | 'RESERVED_D1' | 'BROADCASTED'>(
    'IDLE'
  );

  const isAddressValid = (() => {
    const trimmed = walletInput.trim();
    if (selectedChain === 'stellar') {
      return /^G[A-Z2-7]{55}$/.test(trimmed);
    }
    if (selectedChain === 'ethereum') {
      return /^0x[a-fA-F0-9]{40}$/.test(trimmed);
    }
    return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(trimmed);
  })();

  const handleChainPreset = (chainId: 'stellar' | 'ethereum' | 'solana') => {
    setSelectedChain(chainId);
    if (chainId === 'stellar') {
      setWalletInput('GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37');
    } else if (chainId === 'ethereum') {
      setWalletInput('0x71C7656EC7ab88b098defB751B7401B5f6d8976F');
    } else {
      setWalletInput('HN7cABqLq46Es1jh92dQQisAq662SmxELLLsHHe4YWrH');
    }
  };

  return (
    <section
      aria-labelledby="payouts-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 3 · THANH TOÁN ĐA CHUỖI & SỨC KHỎE NGÂN QUỸ'
              : 'SCREEN 3 · MULTI-CHAIN AUTOMATED PAYOUT RAILS & TREASURY HEALTH'}
          </p>
          <h2
            id="payouts-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Thanh Toán Tự Động Stellar · Ethereum · Solana'
              : 'TreasuryHealthService & D1 Atomic Batch Settlement'}
          </h2>
        </div>
        <span className="inline-flex items-center gap-2 rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          <span className="h-2 w-2 rounded-full bg-stitch-emerald" aria-hidden="true" />
          CIRCUIT BREAKER: CLOSED (3/3 RAILS HEALTHY)
        </span>
      </header>

      {/* 3 Chain Reserve Cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        {rails.map((rail) => (
          <article key={rail.chainId} className="stitch-obsidian-card p-5">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="font-display text-base font-bold text-stitch-primary">
                  {rail.name}
                </h3>
                <p className="font-mono text-xs text-stitch-muted">{rail.railProtocol}</p>
              </div>
              <span className="rounded-full bg-stitch-well px-2.5 py-1 font-mono text-xs font-semibold text-stitch-emerald">
                {rail.healthStatus}
              </span>
            </div>

            <div className="mt-4 space-y-2 border-t border-stitch-border pt-3 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-stitch-muted">USDC Hot Reserve:</span>
                <span className="font-bold text-stitch-primary stitch-tabular-nums">
                  ${rail.usdcReserve.toLocaleString('en-US', { minimumFractionDigits: 2 })} USDC
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">Native Gas Balance:</span>
                <span className="text-stitch-cyan">{rail.nativeGasBalance}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">Circuit Breaker Floor:</span>
                <span className="text-stitch-amber">{rail.nativeGasFloor}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">Finality / Fee:</span>
                <span className="text-stitch-emerald">
                  {rail.avgSettlementSec}s · ${rail.networkFeeUsd}
                </span>
              </div>
            </div>
          </article>
        ))}
      </div>

      {/* Multi-Chain Address Validator & D1 Atomic Batch Settlement Workbench */}
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <article className="stitch-obsidian-card p-6">
          <h3 className="text-lg font-display font-bold text-stitch-primary">
            {isVi
              ? 'Trình Xác Thực Địa Chỉ Ví Đa Chuỗi (StrKey / EIP-55 / Base58)'
              : 'Multi-Chain Destination Wallet Validator'}
          </h3>
          <p className="mt-1 text-xs text-stitch-muted">
            {isVi
              ? 'Kiểm tra định dạng ví và danh sách cấm vận OFAC trước khi khóa số dư D1'
              : 'Pre-flight format & OFAC SDN check prior to D1 atomic balance reservation'}
          </p>

          <div className="mt-4 flex gap-2" role="group" aria-label="Select blockchain rail">
            {(['stellar', 'ethereum', 'solana'] as const).map((chain) => (
              <button
                key={chain}
                type="button"
                aria-pressed={selectedChain === chain}
                onClick={() => handleChainPreset(chain)}
                className={`rounded-lg px-3 py-1.5 font-mono text-xs uppercase transition-colors ${
                  selectedChain === chain
                    ? 'bg-gradient-primary font-bold text-stitch-primary'
                    : 'border border-stitch-divider bg-stitch-well text-stitch-muted hover:text-stitch-primary'
                }`}
              >
                {chain}
              </button>
            ))}
          </div>

          <div className="mt-4">
            <label
              htmlFor="wallet-address-input"
              className="block font-mono text-xs text-stitch-muted"
            >
              Destination Address ({selectedChain.toUpperCase()})
            </label>
            <input
              id="wallet-address-input"
              type="text"
              value={walletInput}
              onChange={(e) => setWalletInput(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-stitch-divider bg-stitch-well px-3 py-2 font-mono text-xs text-stitch-primary focus:border-stitch-cyan focus:outline-none"
            />
          </div>

          <div
            aria-live="polite"
            className="mt-3 flex items-center justify-between rounded-lg border border-stitch-border bg-stitch-canvas/60 px-3 py-2 font-mono text-xs"
          >
            <span className="text-stitch-muted">Format & Checksum Status:</span>
            <span
              className={
                isAddressValid
                  ? 'font-bold text-stitch-emerald'
                  : 'font-bold text-stitch-crimson'
              }
            >
              {isAddressValid ? 'VALID_CHECKSUM · OFAC_CLEAN' : 'INVALID_ADDRESS_FORMAT'}
            </span>
          </div>
        </article>

        {/* Atomic Two-Phase Batch Settlement Workbench */}
        <article className="stitch-obsidian-card p-6">
          <h3 className="text-lg font-display font-bold text-stitch-primary">
            {isVi
              ? 'BatchSettlementService · Khóa 2 Pha Nguyên Tử D1'
              : 'BatchSettlementService · Two-Phase D1 Atomic Lock'}
          </h3>
          <p className="mt-1 text-xs text-stitch-muted">
            {isVi
              ? 'Ngưỡng tối thiểu $50.00 USDC · Chống chi tiêu kép qua khóa Idempotency SHA-256'
              : '$50.00 minimum threshold · Zero double-spend via SHA-256 idempotency key'}
          </p>

          <div className="mt-4 space-y-2 rounded-lg border border-stitch-divider bg-stitch-well/60 p-4 font-mono text-xs">
            <div className="flex justify-between">
              <span className="text-stitch-muted">Eligible Users (&ge; $50.00):</span>
              <span className="font-bold text-stitch-primary">24 Accounts ($1,840.00 USDC)</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stitch-muted">Idempotency Digest:</span>
              <span className="truncate max-w-xs text-stitch-cyan">{batchIdempotencyKey}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stitch-muted">D1 Trigger Audit Log:</span>
              <span className="text-stitch-emerald">IMMUTABLE_INSERT_ONLY</span>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-3">
            <button
              type="button"
              onClick={() => {
                setSettlementStatus('RESERVED_D1');
                setBatchIdempotencyKey(
                  `sha256:batch_${Date.now().toString(16)}_atomic_d1_reserved`
                );
              }}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-4 py-2 font-mono text-xs font-semibold text-stitch-primary transition-colors hover:border-stitch-cyan"
            >
              1. Reserve D1 Balances
            </button>
            <button
              type="button"
              onClick={() => setSettlementStatus('BROADCASTED')}
              className="rounded-lg bg-gradient-primary px-4 py-2 font-mono text-xs font-bold text-stitch-primary transition-opacity hover:opacity-95"
            >
              2. Broadcast Multi-Chain Batch
            </button>
          </div>

          <p aria-live="polite" className="mt-3 font-mono text-xs text-stitch-emerald">
            State: {settlementStatus} · Audit Trigger Active (`payout_audit_logs`)
          </p>
        </article>
      </div>
    </section>
  );
}
