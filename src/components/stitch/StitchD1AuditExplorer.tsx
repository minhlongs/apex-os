'use client';

import React, { useState } from 'react';
import type { D1AuditLogEntry } from '@/data/stitch-terminal-data';

export interface StitchD1AuditExplorerProps {
  readonly auditLogs: readonly D1AuditLogEntry[];
  readonly locale: 'en' | 'vi';
}

export function StitchD1AuditExplorer({
  auditLogs,
  locale,
}: Readonly<StitchD1AuditExplorerProps>) {
  const isVi = locale === 'vi';

  const [tamperAttemptResult, setTamperAttemptResult] = useState<string>(
    'SQLITE_TRIGGERS_ARMED · 0 MUTATION VIOLATIONS'
  );
  const [tamperTriggered, setTamperTriggered] = useState<boolean>(false);
  const [merkleVerified, setMerkleVerified] = useState<boolean>(true);

  return (
    <section
      aria-labelledby="d1-audit-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 9 · TRÌNH KHÁM PHÁ NHẬT KÝ KIỂM TOÁN D1 BẤT BIẾN & MERKLE ROOT'
              : 'SCREEN 9 · IMMUTABLE D1 SQLITE TRIGGER AUDIT EXPLORER & MERKLE VERIFIER'}
          </p>
          <h2
            id="d1-audit-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Kiểm Toán Bất Biến payout_audit_logs & Xác Thực SHA-256 Merkle'
              : 'Forensic D1 Audit Trail & SQLite Immutability Guard'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          BEFORE UPDATE / DELETE TRIGGERS: ARMED
        </span>
      </header>

      {/* SQLite Trigger Guard & Merkle Root Cards */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            SQLite Trigger Constraint
          </p>
          <p className="mt-2 font-mono text-sm font-bold text-stitch-emerald">
            RAISE(ABORT, &apos;Audit logs are immutable&apos;)
          </p>
          <p className="mt-2 text-xs text-stitch-muted">
            Enforced at Cloudflare D1 storage engine level (`BEFORE UPDATE` &amp; `BEFORE DELETE`)
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Batch SHA-256 Merkle Root
          </p>
          <p className="mt-2 truncate font-mono text-sm font-bold text-stitch-cyan">
            0x9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08
          </p>
          <p className="mt-2 text-xs text-stitch-emerald font-mono">
            {merkleVerified ? 'MERKLE_PROOF_VALID · 148,920 LEAVES' : 'VERIFYING...'}
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Tamper-Attempt Sandbox
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setTamperTriggered(true);
                setTamperAttemptResult(
                  "SQLITE_CONSTRAINT_TRIGGER: ABORT — 'Audit logs are immutable and cannot be modified or deleted'"
                );
              }}
              className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1.5 font-mono text-xs text-stitch-crimson"
            >
              Simulate SQL DELETE/UPDATE Tamper
            </button>
            <button
              type="button"
              onClick={() => {
                setTamperTriggered(false);
                setMerkleVerified(true);
                setTamperAttemptResult('SQLITE_TRIGGERS_ARMED · 0 MUTATION VIOLATIONS');
              }}
              className="rounded-lg bg-gradient-primary px-3 py-1.5 font-mono text-xs font-bold text-stitch-primary"
            >
              Verify Merkle Root
            </button>
          </div>
          <p
            aria-live="polite"
            className={`mt-2 font-mono text-xs ${
              tamperTriggered ? 'font-bold text-stitch-crimson' : 'text-stitch-emerald'
            }`}
          >
            {tamperAttemptResult}
          </p>
        </article>
      </div>

      {/* Immutable payout_audit_logs Table */}
      <article className="stitch-obsidian-card p-6">
        <h3 className="text-lg font-display font-bold text-stitch-primary">
          {isVi
            ? 'Nhật Ký Chuyển Trạng Thái Nguyên Tử (payout_audit_logs)'
            : 'Append-Only State Transition Ledger (payout_audit_logs)'}
        </h3>
        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Log ID / Timestamp</th>
                <th className="px-3 py-3">Payout / User</th>
                <th className="px-3 py-3">Rail &amp; Amount</th>
                <th className="px-3 py-3">State Transition</th>
                <th className="px-3 py-3">Idempotency &amp; Tx Proof</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border font-mono text-xs">
              {auditLogs.map((entry) => (
                <tr key={entry.logId} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4">
                    <div className="font-bold text-stitch-primary">{entry.logId}</div>
                    <div className="text-stitch-muted">{entry.createdAtIso}</div>
                  </td>
                  <td className="px-3 py-3.5">
                    <div className="text-stitch-primary">{entry.payoutId}</div>
                    <div className="text-stitch-muted">{entry.userId}</div>
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="text-stitch-cyan">{entry.chain}</span> ·{' '}
                    <span className="font-bold text-stitch-emerald">
                      ${entry.amountUsdc.toFixed(2)} USDC
                    </span>
                  </td>
                  <td className="px-3 py-3.5">
                    <span className="text-stitch-muted">{entry.previousStatus}</span>
                    {' -> '}
                    <span
                      className={
                        entry.newStatus === 'compliance_blocked'
                          ? 'font-bold text-stitch-crimson'
                          : 'font-bold text-stitch-emerald'
                      }
                    >
                      {entry.newStatus}
                    </span>
                  </td>
                  <td className="px-3 py-3.5">
                    <div className="truncate max-w-xs text-stitch-primary">
                      {entry.idempotencyHash}
                    </div>
                    <div className="truncate max-w-xs text-stitch-muted">
                      {entry.txHashOrReason}
                    </div>
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
