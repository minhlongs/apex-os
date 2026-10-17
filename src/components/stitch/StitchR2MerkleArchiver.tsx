'use client';

import React, { useState } from 'react';
import type { R2MerkleSnapshotEntry } from '@/data/stitch-terminal-data';

export interface StitchR2MerkleArchiverProps {
  readonly snapshots: readonly R2MerkleSnapshotEntry[];
  readonly locale: 'en' | 'vi';
}

export function StitchR2MerkleArchiver({
  snapshots,
  locale,
}: Readonly<StitchR2MerkleArchiverProps>) {
  const isVi = locale === 'vi';

  const [selectedSnapshotId, setSelectedSnapshotId] = useState<string>(
    snapshots[0]?.snapshotId ?? 'snap-2026-10-17'
  );
  const [tamperSimulated, setTamperSimulated] = useState<boolean>(false);

  const activeSnapshot =
    snapshots.find((s) => s.snapshotId === selectedSnapshotId) ?? snapshots[0];

  return (
    <section
      aria-labelledby="r2-merkle-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 14 · KHO LƯU TRỮ CLOUDFLARE R2 WORM & CHỨNG THỰC MERKLE PROOF'
              : 'SCREEN 14 · CLOUDFLARE R2 COLD-STORAGE AUDIT ARCHIVER & MERKLE PROOF CONSOLE'}
          </p>
          <h2
            id="r2-merkle-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Lưu Trữ Lạnh R2 Zero-Egress & Kiểm Chứng Cây Merkle SHA-256'
              : 'Cloudflare R2 Cold-Storage Snapshot Archiver & Zero-Egress Proof Verifier'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          R2 BUCKET: apex-os-audit-worm · $0.00 EGRESS · 7-YEAR WORM LOCK
        </span>
      </header>

      {/* 4 Hero R2 Cold-Storage KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Archived Daily Bundles
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-primary stitch-tabular-nums">
            1,095 Bundles
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-emerald">
            7-Year SEC/SOC2 WORM Retention
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Cloudflare R2 Egress Cost
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums">
            $0.00 / GB
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-cyan">
            48.6 GB Parquet + JSONL Proofs
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Active Snapshot Rows
          </p>
          <p
            aria-live="polite"
            className="mt-2 text-2xl font-display font-bold text-stitch-cyan stitch-tabular-nums"
          >
            {activeSnapshot.rowCount.toLocaleString('en-US')} Rows
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-muted">
            {activeSnapshot.compressedSizeMb} MB Parquet Bundle
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Merkle Proof Integrity
          </p>
          <p
            aria-live="polite"
            className={`mt-2 text-lg font-mono font-bold ${
              tamperSimulated ? 'text-stitch-crimson' : 'text-stitch-emerald'
            }`}
          >
            {tamperSimulated
              ? '409 CONFLICT · MERKLE_ROOT_MISMATCH'
              : '200 VERIFIED · R2_WORM_MATCH'}
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-violet">
            SHA-256 Binary Merkle Tree
          </p>
        </article>
      </div>

      {/* Cloudflare R2 Snapshot Catalog & Interactive Proof Verifier */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              Cloudflare R2 WORM Snapshot Catalog (`r2://apex-os-audit-worm/`)
            </h3>
            <p className="text-xs text-stitch-muted">
              Select a daily Parquet snapshot bundle or test cryptographic Merkle leaf tamper rejection
            </p>
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setTamperSimulated((prev) => !prev)}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs font-semibold text-stitch-amber hover:border-stitch-amber"
            >
              {tamperSimulated
                ? 'Restore Authentic Merkle Proof'
                : 'Simulate Corrupted R2 Leaf Proof'}
            </button>
          </div>
        </div>

        <div className="mt-4 rounded-lg border border-stitch-divider bg-stitch-well/70 p-4 font-mono text-xs">
          <div className="text-stitch-muted">Selected R2 Object Key &amp; SHA-256 Merkle Root:</div>
          <div className="mt-1 font-bold text-stitch-cyan">{activeSnapshot.r2ObjectKey}</div>
          <div className="mt-1 break-all text-stitch-emerald">{activeSnapshot.merkleRootHash}</div>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Snapshot ID</th>
                <th className="px-3 py-3">R2 Object Path</th>
                <th className="px-3 py-3">Ledger Rows</th>
                <th className="px-3 py-3">Retention Lock</th>
                <th className="px-3 py-3">Audit Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border font-mono text-xs">
              {snapshots.map((snap) => (
                <tr key={snap.snapshotId} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4 font-bold text-stitch-primary">
                    {snap.snapshotId}
                  </td>
                  <td className="px-3 py-3.5 text-stitch-cyan">{snap.r2ObjectKey}</td>
                  <td className="px-3 py-3.5 text-stitch-emerald">
                    {snap.rowCount.toLocaleString('en-US')}
                  </td>
                  <td className="px-3 py-3.5 text-stitch-violet">{snap.retentionUntil}</td>
                  <td className="px-3 py-3.5">
                    <button
                      type="button"
                      onClick={() => setSelectedSnapshotId(snap.snapshotId)}
                      className="rounded border border-stitch-divider bg-stitch-well px-2.5 py-1 text-[11px] font-bold text-stitch-primary hover:border-stitch-cyan hover:text-stitch-cyan"
                    >
                      Inspect {snap.snapshotId}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>
    </section>
  );
}
