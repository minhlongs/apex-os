---
title: "Staging Infrastructure Alignment & 48h Paper Trading Rehearsal Launch"
description: "Align staging KV/R2/D1 bindings, fix Worker Durable Object wrapper bundling, ship PR to target branch, and launch 48-hour staging rehearsal"
status: completed
priority: P1
effort: 2h
branch: feat/staging-rehearsal-48h
tags: [staging, paper-trading, durable-objects, cloudflare, rehearsal]
created: 2026-11-02
updated: 2026-11-02
---

# Plan: Staging Infrastructure Alignment & 48h Paper Trading Rehearsal Launch

## Overview
- **Objective:** Khắc phục 4 rào cản cấu hình/hạ tầng và 2 bẫy biến môi trường trên môi trường staging (`apex-os-staging`), áp dụng migrations D1 `028–030`, đóng gói đầy đủ `worker-wrapper.js` (`PaperTradingDurableObject`), mở PR, review & gộp vào `feature/sprint4-email-automation-complete`, deploy commit mới nhất lên `https://apex-os-staging.agencyos-openclaw.workers.dev` và kích hoạt `PaperTradingDurableObject` để bắt đầu phiên diễn tập 48 giờ.
- **Route:** `bugfix` / `infrastructure`
- **Ship mode:** `official` (`--ship` to `feature/sprint4-email-automation-complete`)

## Phases

| Phase | Name | Status | File |
| :---: | :--- | :---: | :--- |
| 1 | Align Staging KV, Worker Bundling & CI Config + Regression Tests | completed | [phase-01-staging-config-and-bundling.md](./phase-01-staging-config-and-bundling.md) |
| 2 | Provision Staging R2, Apply D1 Migrations 028–030 & Secret Setup | completed | [phase-02-staging-cloudflare-resources.md](./phase-02-staging-cloudflare-resources.md) |
| 3 | Ship PR, Merge, Deploy to Live Staging & Launch 48h Rehearsal | completed | [phase-03-ship-deploy-and-rehearsal.md](./phase-03-ship-deploy-and-rehearsal.md) |

## Acceptance Criteria
- [x] `wrangler.staging.jsonc` và `scripts/assert-staging-isolation.sh` đồng bộ `STAGING_KV_ID="f2cf595dec5543dc96f6370bebbc8754"`; `bash scripts/assert-staging-isolation.sh` và `npm run gate` đạt PASS (29/29).
- [x] R2 bucket `apex-os-uploads-staging` được tạo; remote D1 `apex-os-staging-db` có đủ 4 bảng Paper Trading (`paper_trade_journal`, `paper_strategy_snapshots`, `paper_trading_runs`, `paper_trading_outbox`) và 2 append-only triggers từ migrations `028–030`; secret `TERMINAL_HMAC_SECRET` được nạp vào `apex-os-staging`.
- [x] `package.json` và `.github/workflows/deploy.yml` sử dụng `wrangler deploy` sau `npm run build:worker` (tự động gắn `NEXT_PUBLIC_COMMIT_SHA` và `NEXT_PUBLIC_BUILD_TIME`), xuất đầy đủ `PaperTradingDurableObject`.
- [x] PR được tạo, review, gắn nhãn `ready to ship stable`, merge vào `feature/sprint4-email-automation-complete` với GitHub Actions CI xanh.
- [x] `bash scripts/verify-deployment.sh https://apex-os-staging.agencyos-openclaw.workers.dev "$(git rev-parse HEAD)"` đạt `VERIFY_DEPLOYMENT_PASSED` (`/api/version` khớp SHA và 13/13 routes trong `smoke-protected-routes.sh` đạt PASS).
- [x] `PaperTradingDurableObject` được kích hoạt (`start-collector`) với `executionMode: "PAPER"`, `collectorDesiredRunning: true`, và `node scripts/verify-paper-economic-gate.cjs` giữ nguyên `verdict: "NO_GO"` (exit code 1).
