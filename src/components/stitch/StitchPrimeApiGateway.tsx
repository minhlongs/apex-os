'use client';

import React, { useState } from 'react';
import {
  Cpu,
  ShieldCheck,
  Zap,
  KeyRound,
  Activity,
  CheckCircle2,
  AlertTriangle,
  Terminal,
} from 'lucide-react';
import {
  PRIME_API_GATEWAY_ROUTES,
  type TerminalLocale,
} from '@/data/stitch-terminal-data';

export interface StitchPrimeApiGatewayProps {
  readonly locale?: TerminalLocale;
}

export function StitchPrimeApiGateway({
  locale = 'en',
}: Readonly<StitchPrimeApiGatewayProps>) {
  const isVi = locale === 'vi';
  const [selectedRouteId, setSelectedRouteId] = useState<string>(
    PRIME_API_GATEWAY_ROUTES[0].routeId
  );
  const [clientTier, setClientTier] = useState<
    'STANDARD' | 'VIP_QUANT' | 'PRIME_INSTITUTIONAL'
  >('PRIME_INSTITUTIONAL');
  const [requestedRpm, setRequestedRpm] = useState<string>('1800');
  const [simResult, setSimResult] = useState<{
    status: 'ALLOWED_200' | 'RATE_LIMITED_429';
    remainingTokens: number;
    bucketCapacity: number;
    retryAfterSec: number;
    edgeRayId: string;
  }>({
    status: 'ALLOWED_200',
    remainingTokens: 600,
    bucketCapacity: 2400,
    retryAfterSec: 0,
    edgeRayId: 'cf-ray-8d9f1024a7b6-SGN',
  });

  const tierCapacities: Record<
    'STANDARD' | 'VIP_QUANT' | 'PRIME_INSTITUTIONAL',
    number
  > = {
    STANDARD: 300,
    VIP_QUANT: 1200,
    PRIME_INSTITUTIONAL: 2400,
  };

  const handleEvaluateRateLimit = () => {
    const rpm = Math.max(1, Number(requestedRpm) || 1);
    const capacity = tierCapacities[clientTier];
    if (rpm <= capacity) {
      setSimResult({
        status: 'ALLOWED_200',
        remainingTokens: capacity - rpm,
        bucketCapacity: capacity,
        retryAfterSec: 0,
        edgeRayId: `cf-ray-${rpm.toString(16)}a9f0-SGN`,
      });
    } else {
      const overflow = rpm - capacity;
      const refillPerSec = Math.max(1, Math.round(capacity / 60));
      setSimResult({
        status: 'RATE_LIMITED_429',
        remainingTokens: 0,
        bucketCapacity: capacity,
        retryAfterSec: Math.max(1, Math.ceil(overflow / refillPerSec)),
        edgeRayId: `cf-ray-429-${rpm.toString(16)}-SGN`,
      });
    }
  };

  return (
    <section
      aria-labelledby="prime-gateway-heading"
      className="space-y-6 animate-fade-in"
    >
      {/* Header Banner */}
      <header className="stitch-obsidian-card p-5 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-xs font-mono text-stitch-cyan uppercase tracking-wider">
            <Cpu className="w-4 h-4" aria-hidden="true" />
            <span>
              {isVi
                ? 'MÀN HÌNH 16 • CỔNG API ĐỊNH CHẾ & BỘ GIỚI HẠN TỐC ĐỘ CLOUDFLARE KV'
                : 'SCREEN 16 • INSTITUTIONAL PRIME API GATEWAY & KV TOKEN-BUCKET RATE LIMITER'}
            </span>
          </div>
          <h2
            id="prime-gateway-heading"
            className="text-xl font-display font-bold tracking-tight text-stitch-primary mt-1"
          >
            {isVi
              ? 'Quản Trị Lưu Lượng Edge, Cổng FIX 4.4 / REST & Chống Bùng Nổ Tốc Độ KV'
              : 'Edge Traffic Governance, FIX 4.4 / REST Gateway & KV Token-Bucket Burst Control'}
          </h2>
          <p className="text-xs text-stitch-muted mt-1">
            {isVi
              ? 'Thực thi giới hạn tốc độ phân tán tại hơn 310 trung tâm dữ liệu Cloudflare Edge với độ trễ kiểm tra token-bucket < 1.2ms.'
              : 'Distributed rate limiting enforced across 310+ Cloudflare Edge PoPs with sub-1.2ms KV token-bucket verification.'}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2.5 text-xs font-mono">
          <span className="px-3 py-1.5 rounded-lg bg-stitch-emerald/10 text-stitch-emerald border border-stitch-emerald/30 flex items-center gap-1.5">
            <ShieldCheck className="w-3.5 h-3.5" aria-hidden="true" />
            KV_RATE_LIMITER: ACTIVE
          </span>
          <span className="px-3 py-1.5 rounded-lg bg-stitch-cyan/10 text-stitch-cyan border border-stitch-cyan/30">
            P99 GATEWAY: 1.1ms
          </span>
        </div>
      </header>

      {/* KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <article className="stitch-obsidian-card p-4">
          <div className="text-[11px] font-mono text-stitch-muted uppercase">
            {isVi ? 'THÔNG LƯỢNG ĐỈNH EDGE' : 'EDGE PEAK THROUGHPUT'}
          </div>
          <div className="text-2xl font-display font-bold stitch-tabular-nums text-stitch-primary mt-1">
            48,920 req/m
          </div>
          <div className="text-[11px] font-mono text-stitch-emerald mt-1">
            99.998% {isVi ? 'Thời gian hoạt động SLA' : 'Institutional SLA Uptime'}
          </div>
        </article>

        <article className="stitch-obsidian-card p-4">
          <div className="text-[11px] font-mono text-stitch-muted uppercase">
            {isVi ? 'ĐỘ TRỄ KIỂM TRA KV P99' : 'KV TOKEN CHECK P99'}
          </div>
          <div className="text-2xl font-display font-bold stitch-tabular-nums text-stitch-cyan mt-1">
            1.14 ms
          </div>
          <div className="text-[11px] font-mono text-stitch-muted mt-1">
            Cloudflare Workers KV + Durable Counter
          </div>
        </article>

        <article className="stitch-obsidian-card p-4">
          <div className="text-[11px] font-mono text-stitch-muted uppercase">
            {isVi ? 'YÊU CẦU BỊ CHẶN (HTTP 429)' : 'BURST THROTTLED (HTTP 429)'}
          </div>
          <div className="text-2xl font-display font-bold stitch-tabular-nums text-stitch-amber mt-1">
            0.04%
          </div>
          <div className="text-[11px] font-mono text-stitch-muted mt-1">
            {isVi ? 'Bảo vệ chống DDoS & Replay' : 'Zero D1 database saturation'}
          </div>
        </article>

        <article className="stitch-obsidian-card p-4">
          <div className="text-[11px] font-mono text-stitch-muted uppercase">
            {isVi ? 'PHIÊN FIX 4.4 / WS ĐANG MỞ' : 'ACTIVE FIX 4.4 / WS SESSIONS'}
          </div>
          <div className="text-2xl font-display font-bold stitch-tabular-nums text-stitch-emerald mt-1">
            128 Nodes
          </div>
          <div className="text-[11px] font-mono text-stitch-muted mt-1">
            mTLS 1.3 + Ed25519 Signed Headers
          </div>
        </article>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* Route Matrix */}
        <article className="lg:col-span-7 stitch-obsidian-card p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-stitch-border pb-3">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-stitch-cyan" aria-hidden="true" />
              <h3 className="text-xs font-mono uppercase tracking-wider text-stitch-primary font-semibold">
                {isVi
                  ? 'MA TRẬN ĐỊNH TUYẾN API ĐỊNH CHẾ & HẠN MỨC TOKEN-BUCKET'
                  : 'INSTITUTIONAL API ROUTE MATRIX & TOKEN-BUCKET QUOTAS'}
              </h3>
            </div>
            <span className="text-[11px] font-mono text-stitch-muted">
              {PRIME_API_GATEWAY_ROUTES.length} {isVi ? 'Tuyến Edge' : 'Edge Routes'}
            </span>
          </div>

          <div className="space-y-2.5">
            {PRIME_API_GATEWAY_ROUTES.map((route) => {
              const isSelected = route.routeId === selectedRouteId;
              return (
                <div
                  key={route.routeId}
                  role="button"
                  tabIndex={0}
                  aria-pressed={isSelected}
                  data-testid={`gateway-route-${route.routeId}`}
                  onClick={() => setSelectedRouteId(route.routeId)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      setSelectedRouteId(route.routeId);
                    }
                  }}
                  className={`p-3.5 rounded-lg border transition-colors duration-150 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stitch-cyan ${
                    isSelected
                      ? 'bg-stitch-cyan/10 border-stitch-cyan/50'
                      : 'bg-stitch-canvas border-stitch-border hover:border-stitch-divider'
                  }`}
                >
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span
                        className={`px-2 py-0.5 rounded text-[10px] font-mono font-bold ${
                          route.method === 'POST'
                            ? 'bg-stitch-emerald/15 text-stitch-emerald border border-stitch-emerald/30'
                            : 'bg-stitch-cyan/15 text-stitch-cyan border border-stitch-cyan/30'
                        }`}
                      >
                        {route.method}
                      </span>
                      <span className="text-xs font-mono font-semibold text-stitch-primary">
                        {route.path}
                      </span>
                      <span className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-stitch-well text-stitch-muted">
                        {route.protocol}
                      </span>
                    </div>
                    <span className="text-[11px] font-mono text-stitch-emerald">
                      {route.status}
                    </span>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-2.5 pt-2.5 border-t border-stitch-border text-[11px] font-mono stitch-tabular-nums">
                    <div>
                      <span className="text-stitch-muted">{isVi ? 'Hạng:' : 'Tier:'} </span>
                      <span className="text-stitch-primary">{route.tierName}</span>
                    </div>
                    <div>
                      <span className="text-stitch-muted">{isVi ? 'Trần Burst:' : 'Burst Cap:'} </span>
                      <span className="text-stitch-cyan">{route.burstCapacityRpm} RPM</span>
                    </div>
                    <div>
                      <span className="text-stitch-muted">{isVi ? 'Nạp lại:' : 'Refill:'} </span>
                      <span className="text-stitch-emerald">
                        +{route.refillRatePerSec}/s ({route.p99LatencyMs}ms)
                      </span>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </article>

        {/* Interactive KV Token-Bucket Simulator */}
        <article className="lg:col-span-5 stitch-obsidian-card p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-stitch-border pb-3">
            <div className="flex items-center gap-2">
              <KeyRound className="w-4 h-4 text-stitch-emerald" aria-hidden="true" />
              <h3 className="text-xs font-mono uppercase tracking-wider text-stitch-primary font-semibold">
                {isVi
                  ? 'BỘ MÔ PHỎNG KIỂM TRA KV TOKEN-BUCKET TRỰC TIẾP'
                  : 'LIVE KV TOKEN-BUCKET RATE LIMIT EVALUATOR'}
              </h3>
            </div>
            <Activity className="w-4 h-4 text-stitch-cyan" aria-hidden="true" />
          </div>

          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-mono uppercase text-stitch-muted mb-1">
                {isVi ? 'HẠNG KHÓA API KHÁCH HÀNG' : 'INSTITUTIONAL CLIENT TIER'}
              </label>
              <div className="grid grid-cols-3 gap-2" role="group" aria-label="Select client tier">
                {(['STANDARD', 'VIP_QUANT', 'PRIME_INSTITUTIONAL'] as const).map((tier) => (
                  <button
                    key={tier}
                    type="button"
                    aria-pressed={clientTier === tier}
                    onClick={() => setClientTier(tier)}
                    data-testid={`gateway-tier-${tier}`}
                    className={`px-2 py-1.5 rounded-lg text-[11px] font-mono font-semibold border cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stitch-cyan ${
                      clientTier === tier
                        ? 'bg-stitch-cyan/15 text-stitch-cyan border-stitch-cyan/50'
                        : 'bg-stitch-canvas text-stitch-muted border-stitch-border hover:text-stitch-primary'
                    }`}
                  >
                    {tier.replace('_', ' ')}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label
                htmlFor="gateway-rpm-input"
                className="block text-[11px] font-mono uppercase text-stitch-muted mb-1"
              >
                {isVi
                  ? 'TỐC ĐỘ GỬI YÊU CẦU MÔ PHỎNG (REQUESTS / MINUTE)'
                  : 'SIMULATED INBOUND BURST RATE (REQUESTS / MINUTE)'}
              </label>
              <input
                id="gateway-rpm-input"
                data-testid="gateway-rpm-input"
                type="number"
                value={requestedRpm}
                onChange={(e) => setRequestedRpm(e.target.value)}
                className="w-full bg-stitch-canvas border border-stitch-divider rounded-lg px-3 py-2 text-sm font-mono stitch-tabular-nums text-stitch-primary focus:outline-none focus:border-stitch-cyan focus-visible:ring-1 focus-visible:ring-stitch-cyan"
              />
            </div>

            <button
              type="button"
              onClick={handleEvaluateRateLimit}
              data-testid="evaluate-kv-rate-limit-btn"
              className="w-full py-2.5 px-4 rounded-lg bg-stitch-cyan/15 hover:bg-stitch-cyan/25 text-stitch-cyan border border-stitch-cyan/40 font-mono text-xs font-semibold uppercase tracking-wider cursor-pointer transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-stitch-cyan flex items-center justify-center gap-2"
            >
              <Zap className="w-3.5 h-3.5" aria-hidden="true" />
              {isVi
                ? 'KIỂM TRA HẠN MỨC TOKEN-BUCKET TẠI EDGE'
                : 'EVALUATE EDGE KV TOKEN-BUCKET QUOTA'}
            </button>
          </div>

          {/* Evaluation Result Box */}
          <div
            role="status"
            aria-live="polite"
            data-testid="gateway-rate-limit-result"
            className={`p-4 rounded-lg border font-mono text-xs space-y-2 ${
              simResult.status === 'ALLOWED_200'
                ? 'bg-stitch-emerald/5 border-stitch-emerald/40 text-stitch-primary'
                : 'bg-stitch-crimson/10 border-stitch-crimson/40 text-stitch-primary'
            }`}
          >
            <div className="flex items-center justify-between">
              <span className="text-[11px] uppercase text-stitch-muted">
                {isVi ? 'PHẢN HỒI CỔNG EDGE:' : 'EDGE GATEWAY VERDICT:'}
              </span>
              <span
                className={`font-bold flex items-center gap-1 ${
                  simResult.status === 'ALLOWED_200'
                    ? 'text-stitch-emerald'
                    : 'text-stitch-crimson'
                }`}
              >
                {simResult.status === 'ALLOWED_200' ? (
                  <CheckCircle2 className="w-3.5 h-3.5" aria-hidden="true" />
                ) : (
                  <AlertTriangle className="w-3.5 h-3.5" aria-hidden="true" />
                )}
                {simResult.status}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-2 pt-2 border-t border-stitch-border stitch-tabular-nums">
              <div>
                <div className="text-[10px] text-stitch-muted">BUCKET CAPACITY</div>
                <div className="text-sm font-bold text-stitch-primary">
                  {simResult.bucketCapacity} RPM
                </div>
              </div>
              <div>
                <div className="text-[10px] text-stitch-muted">REMAINING TOKENS</div>
                <div className="text-sm font-bold text-stitch-cyan">
                  {simResult.remainingTokens}
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between text-[11px] pt-1 text-stitch-muted stitch-tabular-nums">
              <span>Retry-After: {simResult.retryAfterSec}s</span>
              <span>{simResult.edgeRayId}</span>
            </div>
          </div>
        </article>
      </div>
    </section>
  );
}
