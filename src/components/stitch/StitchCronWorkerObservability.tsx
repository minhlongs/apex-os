'use client';

import React, { useState } from 'react';
import type { CronJobScheduleEntry } from '@/data/stitch-terminal-data';

export interface StitchCronWorkerObservabilityProps {
  readonly cronJobs: readonly CronJobScheduleEntry[];
  readonly locale: 'en' | 'vi';
}

export function StitchCronWorkerObservability({
  cronJobs,
  locale,
}: Readonly<StitchCronWorkerObservabilityProps>) {
  const isVi = locale === 'vi';

  const [lastTriggeredJob, setLastTriggeredJob] = useState<string>('d1-metrics');
  const [simulatedQueryMs, setSimulatedQueryMs] = useState<number>(14);
  const [simulatedStoragePct, setSimulatedStoragePct] = useState<number>(14);

  const isSlowQueryTriggered = simulatedQueryMs > 1000;
  const isStorageCritical = simulatedStoragePct >= 80;

  return (
    <section
      aria-labelledby="cron-observability-heading"
      className="space-y-6 animate-fade-in"
    >
      <header className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-mono uppercase tracking-wider text-stitch-cyan">
            {isVi
              ? 'MÀN HÌNH 12 · GIÁM SÁT CLOUDFLARE CRON WORKER, HÀNG ĐỢI EMAIL & ĐỘ TRỄ D1'
              : 'SCREEN 12 · CLOUDFLARE EDGE CRON WORKER, EMAIL QUEUE & D1 OBSERVABILITY'}
          </p>
          <h2
            id="cron-observability-heading"
            className="text-2xl font-display font-bold tracking-tight text-stitch-primary"
          >
            {isVi
              ? 'Trung Tâm Giám Sát Edge Worker, Hàng Đợi Resend & Độ Trễ D1'
              : 'Cloudflare Edge Cron Schedule & D1 Query Telemetry Command'}
          </h2>
        </div>
        <span className="rounded-full border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-emerald">
          WRANGLER CRON: 7/7 SCHEDULES ACTIVE · D1 MONITOR READY
        </span>
      </header>

      {/* 4 Hero Edge Observability KPI Cards */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Cloudflare Cron Health
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-emerald stitch-tabular-nums">
            7 / 7 Healthy
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-cyan">
            99.98% Edge Worker Uptime
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            D1 Query Latency (Avg)
          </p>
          <p
            aria-live="polite"
            className={`mt-2 text-2xl font-display font-bold stitch-tabular-nums ${
              isSlowQueryTriggered ? 'text-stitch-crimson' : 'text-stitch-emerald'
            }`}
          >
            {simulatedQueryMs} ms
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-muted">
            Threshold: &gt;1000ms (`SLOW_QUERY_THRESHOLD_MS`)
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            Resend Email Queue
          </p>
          <p className="mt-2 text-2xl font-display font-bold text-stitch-primary stitch-tabular-nums">
            1,482 Sent
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-emerald">
            0 Dead-Letter · 15m Cadence
          </p>
        </article>

        <article className="stitch-obsidian-card p-5">
          <p className="text-xs font-mono uppercase text-stitch-muted">
            D1 Storage Quota (10 GB)
          </p>
          <p
            aria-live="polite"
            className={`mt-2 text-2xl font-display font-bold stitch-tabular-nums ${
              isStorageCritical ? 'text-stitch-crimson' : 'text-stitch-cyan'
            }`}
          >
            {simulatedStoragePct}.2% Used
          </p>
          <p className="mt-1 font-mono text-xs text-stitch-muted">
            Critical Alert Gate: &gt;=80% Quota
          </p>
        </article>
      </div>

      {/* Cloudflare Workers Cron Schedule Matrix */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              Cloudflare Workers Cron Schedule Matrix (`/api/cron`)
            </h3>
            <p className="text-xs text-stitch-muted">
              All 7 scheduled jobs configured in `wrangler.toml` with bearer secret guard and manual trigger simulation
            </p>
          </div>
          <span
            aria-live="polite"
            className="rounded-lg border border-stitch-divider bg-stitch-well px-3 py-1 font-mono text-xs text-stitch-cyan"
          >
            LAST MANUAL DISPATCH: ?job={lastTriggeredJob} (200 OK)
          </span>
        </div>

        <div className="mt-4 overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-stitch-border font-mono text-xs uppercase text-stitch-muted">
                <th className="py-3 pr-4">Job ID</th>
                <th className="px-3 py-3">Cron Expression</th>
                <th className="px-3 py-3">Handler Function</th>
                <th className="px-3 py-3">Duration</th>
                <th className="px-3 py-3">Last Execution Telemetry</th>
                <th className="px-3 py-3">Manual Dispatch</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-stitch-border font-mono text-xs">
              {cronJobs.map((job) => (
                <tr key={job.jobId} className="hover:bg-stitch-well/50">
                  <td className="py-3.5 pr-4 font-bold text-stitch-primary">
                    {job.jobId}
                  </td>
                  <td className="px-3 py-3.5 text-stitch-cyan">
                    {job.cronExpression} ({job.cadenceLabel})
                  </td>
                  <td className="px-3 py-3.5 text-stitch-violet">
                    {job.handlerName}
                  </td>
                  <td className="px-3 py-3.5 text-stitch-emerald">
                    {job.lastDurationMs} ms
                  </td>
                  <td className="px-3 py-3.5 text-stitch-muted">
                    {job.lastOutputSummary}
                  </td>
                  <td className="px-3 py-3.5">
                    <button
                      type="button"
                      onClick={() => setLastTriggeredJob(job.jobId)}
                      className="rounded border border-stitch-divider bg-stitch-well px-2.5 py-1 text-[11px] font-bold text-stitch-primary hover:border-stitch-cyan hover:text-stitch-cyan"
                    >
                      Trigger {job.jobId}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </article>

      {/* D1 Query Latency & Alert Threshold Simulator (/api/monitoring/d1) */}
      <article className="stitch-obsidian-card p-6">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-stitch-border pb-4">
          <div>
            <h3 className="text-lg font-display font-bold text-stitch-primary">
              D1 Query Latency &amp; Alert Rule Simulator (`/api/monitoring/d1`)
            </h3>
            <p className="text-xs text-stitch-muted">
              Simulate query execution duration (`alert-slow-query &gt; 1000ms`) and storage quota (`alert-storage &gt;= 80%`)
            </p>
          </div>
          <span
            aria-live="polite"
            className={`rounded-full px-3 py-1 font-mono text-xs font-bold ${
              isSlowQueryTriggered || isStorageCritical
                ? 'bg-stitch-crimson/15 text-stitch-crimson'
                : 'bg-stitch-emerald/15 text-stitch-emerald'
            }`}
          >
            {isSlowQueryTriggered || isStorageCritical
              ? 'ALERT TRIGGERED: DISPATCHING TO /api/monitoring/alert-engine'
              : 'ALL 4 D1 ALERT RULES WITHIN NOMINAL THRESHOLDS'}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-6 md:grid-cols-2">
          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="d1-query-latency-slider" className="text-stitch-muted">
                Simulated D1 Query Duration (ms):
              </label>
              <span className="font-bold text-stitch-cyan">{simulatedQueryMs} ms</span>
            </div>
            <input
              id="d1-query-latency-slider"
              type="range"
              min={5}
              max={1800}
              step={25}
              value={simulatedQueryMs}
              onChange={(e) => setSimulatedQueryMs(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
            />
          </div>

          <div>
            <div className="flex justify-between font-mono text-xs">
              <label htmlFor="d1-storage-quota-slider" className="text-stitch-muted">
                Simulated D1 Storage Quota Utilization (%):
              </label>
              <span className="font-bold text-stitch-violet">{simulatedStoragePct}%</span>
            </div>
            <input
              id="d1-storage-quota-slider"
              type="range"
              min={5}
              max={95}
              step={5}
              value={simulatedStoragePct}
              onChange={(e) => setSimulatedStoragePct(Number(e.target.value))}
              className="mt-2 h-2 w-full cursor-pointer appearance-none rounded-lg bg-stitch-well accent-primary-500"
            />
          </div>
        </div>
      </article>
    </section>
  );
}
