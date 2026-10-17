'use client';

import React, { useState } from 'react';
import type { ByokVaultKeyEntry } from '@/data/stitch-terminal-data';

export interface StitchByokVaultProps {
  readonly vaultKeys: readonly ByokVaultKeyEntry[];
  readonly locale: 'en' | 'vi';
}

export function StitchByokVault({
  vaultKeys,
  locale,
}: Readonly<StitchByokVaultProps>) {
  const isVi = locale === 'vi';

  const [samplePlainKey, setSamplePlainKey] = useState<string>(
    'bapi_live_99481024_readonly_spot_futures'
  );
  const [hasWithdrawPermission, setHasWithdrawPermission] = useState<boolean>(false);
  const [rotatedFingerprint, setRotatedFingerprint] = useState<string>(
    'sha256:4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c'
  );

  return (
    <section
      aria-labelledby="byok-vault-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 10 · KÉT MÃ HÓA BYOK AES-GCM-256 & XOAY VÒNG KHÓA ZERO-KNOWLEDGE'
              : 'SCREEN 10 · BYOK AES-GCM-256 EXCHANGE API KEY VAULT & ROTATION CONSOLE'}
          </p>
          <h2
            id="byok-vault-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Quản Lý Khóa API Đa Sàn (AES-GCM-256) & Chặn Quyền Rút Tiền'
              : 'Zero-Knowledge BYOK Envelope Vault & Read-Only Policy Guard'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          CIPHER: AES-GCM-256 (96-BIT IV + 128-BIT TAG)
        </span>
      </header>

      {/* 4 Exchange BYOK Key Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {vaultKeys.map((entry) => (
          <article key={entry.exchangeId} className="stitch-obsidian-card p-5">
            <div className="flex items-center justify-between">
              <span className="font-display text-sm font-bold text-stitch-primary">
                {entry.exchangeName}
              </span>
              <span className="rounded-md bg-stitch-well px-2 py-0.5 font-mono text-xs text-stitch-emerald">
                {entry.status}
              </span>
            </div>
            <p className="mt-2 truncate font-mono text-xs text-stitch-cyan">
              {entry.keyFingerprint}
            </p>
            <div className="mt-3 space-y-1 border-t border-stitch-border pt-2 font-mono text-xs">
              <div className="flex justify-between">
                <span className="text-stitch-muted">Permissions:</span>
                <span className="text-stitch-emerald">{entry.scopes}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">Withdraw Bit:</span>
                <span className="font-bold text-stitch-crimson">REJECTED_BY_POLICY</span>
              </div>
              <div className="flex justify-between">
                <span className="text-stitch-muted">Rotation Age:</span>
                <span className="text-stitch-primary">{entry.rotatedAgo}</span>
              </div>
            </div>
          </article>
        ))}
      </div>

      {/* Interactive AES-GCM-256 Envelope Sealer & Scope Policy Verifier */}
      <article className="stitch-obsidian-card p-6">
        <h3 className="text-lg font-display font-bold text-stitch-primary">
          {isVi
            ? 'Trình Kiểm Tra Phong Bì Mã Hóa WebCrypto AES-GCM-256'
            : 'Interactive WebCrypto AES-GCM-256 Envelope Sealer & Scope Guard'}
        </h3>
        <div className="mt-4 grid grid-cols-1 gap-6 lg:grid-cols-2">
          <div className="space-y-3">
            <label
              htmlFor="byok-key-input"
              className="block font-mono text-xs text-stitch-muted"
            >
              Plaintext Exchange API Key (Client-Side Memory Only)
            </label>
            <input
              id="byok-key-input"
              type="text"
              value={samplePlainKey}
              onChange={(e) => setSamplePlainKey(e.target.value)}
              className="w-full rounded-lg border border-stitch-divider bg-stitch-well px-3 py-2 font-mono text-xs text-stitch-primary"
            />
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => {
                  setHasWithdrawPermission(false);
                  setRotatedFingerprint(
                    `sha256:rotated_${Date.now().toString(16)}_aes_gcm_256`
                  );
                }}
                className="rounded-lg bg-gradient-primary px-3 py-1.5 font-mono text-xs font-bold text-stitch-primary"
              >
                Seal &amp; Rotate Read-Only Key
              </button>
              <button
                type="button"
                onClick={() => setHasWithdrawPermission(true)}
                className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs text-stitch-crimson"
              >
                Simulate Key With Withdraw Scope
              </button>
            </div>
          </div>

          <div
            aria-live="polite"
            className="rounded-lg border border-stitch-divider bg-stitch-canvas/80 p-4 font-mono text-xs space-y-2"
          >
            <div className="flex justify-between">
              <span className="text-stitch-muted">Envelope Fingerprint:</span>
              <span className="truncate max-w-xs text-stitch-cyan">{rotatedFingerprint}</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stitch-muted">D1 Storage Payload:</span>
              <span className="text-stitch-violet">iv_b64:9f2a... · tag_b64:c81e...</span>
            </div>
            <div className="flex justify-between">
              <span className="text-stitch-muted">Policy Gate Verdict:</span>
              <span
                className={
                  hasWithdrawPermission
                    ? 'font-bold text-stitch-crimson'
                    : 'font-bold text-stitch-emerald'
                }
              >
                {hasWithdrawPermission
                  ? '403 FORBIDDEN · WITHDRAW_SCOPE_REJECTED'
                  : '200 SEALED · READ_ONLY_VERIFIED'}
              </span>
            </div>
          </div>
        </div>
      </article>
    </section>
  );
}
