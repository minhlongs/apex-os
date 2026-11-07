# Báo Cáo Kiểm Toán Độc Lập & Khắc Phục Toàn Diện ApexOS (Post-Commit `bbc4b7f3fdf486022d778310a3e581a9306e9fc0`)

- **Ngày thực hiện:** 2026-10-31
- **Worktree:** `/Users/macbook/apex-os-worktrees/go-live-pipeline`
- **Commit cơ sở được kiểm toán:** `bbc4b7f3fdf486022d778310a3e581a9306e9fc0`
- **Runtime xác minh:** Node.js `v26.7.0` (ABI 147)
- **Quyết định phát hành tổng thể (Overall Go-Live Verdict):** **NO-GO (Chặn phát hành sản xuất cho tới khi hoàn tất cửa sổ Paper Trading thực tế >= 30 ngày liên tục & Staging rehearsal trên Cloudflare)**

---

## 1. Xác Minh Findings F01–F16 & Trạng Thái Khắc Phục

| Mã | Mức độ | Nội dung Finding trên `bbc4b7f3` | Trạng thái ban đầu | Biện pháp khắc phục đã thực thi & Bằng chứng |
|---|---|---|---|---|
| **F01** | CRITICAL | `/api/admin/paper/overview` và `/api/admin/paper/export` fail-open khi thiếu `DB` hoặc `getAuth(db)` ném lỗi (`allowWithoutDb = true`). | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Xóa hoàn toàn nhánh `allowWithoutDb`, áp dụng `verifyAdminSession()` fail-closed (`401`/`403`/`503`). Kiểm chứng bởi `src/app/api/admin/paper/__tests__/paper-routes.test.ts` (7/7 tests pass). |
| **F02** | CRITICAL | `PaperTradingDurableObject` chưa được export trong `worker-wrapper.js` và thiếu `durable_objects` + `migrations` trong `wrangler.jsonc` / `wrangler.staging.jsonc`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Export `PaperTradingDurableObject` trong `worker-wrapper.js`, khai báo binding `PAPER_TRADING_DO` và migration `v1-paper-trading-do` trong cả `wrangler.jsonc` và `wrangler.staging.jsonc`. |
| **F03** | CRITICAL | API/Console/Export chạy lại `buildCanonical50TickSequence()` thay vì tách bạch rõ nguồn dữ liệu; thiếu cơ chế nối DO/D1 thực tế. | Tồn tại một phần | **ĐÃ SỬA:** Bổ sung `dataSource: 'FIXTURE_REPLAY_50_TICK'` rõ ràng trên API overview, đóng dấu watermark `PAPER` và tách biệt trạng thái DO/D1 khỏi fixture 50-tick. |
| **F04** | CRITICAL | Điều kiện kinh tế 30 ngày / 100 chu kỳ / P&L > 0 / DD <= 2% bị hạ xuống `DESCRIPTIVE_RESEARCH_ONLY` (`isReleaseBlocker: false`) và tính `Math.floor(tickCount / 24)`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Chuyển `PaperReplayEngine.buildEconomicResearchSummary()` sang `STRICT_ECONOMIC_AUDIT`, `isReleaseBlocker: true`, `overallVerdict: 'NO_GO'` khi `verifiedRealMarketDays < 30` hoặc `closedCyclesCount < 100` hoặc `realizedNetPnlUsdt <= 0` hoặc `maxDrawdownPct > 2.0`. Tuyệt đối không quy đổi `tickCount` thành ngày. |
| **F05** | HIGH | `OrderbookSequencer.ingest()` ghi đè toàn bộ `this.books.set(key, book)` thay vì merge L2 delta và xóa mức giá `quantity === 0`; chưa xử lý repeated snapshot `sequenceId` hợp lệ và trạng thái `DISCONNECTED`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Cài đặt `applyL2Delta()` xóa mức giá `quantity <= 0`, sắp xếp bids giảm dần / asks tăng dần, cho phép repeated snapshot hợp lệ (`isRepeatedValidSnapshot`), và thêm `markDisconnected()` chặn `validatePairSync()`. |
| **F06** | HIGH | Funding cộng mỗi tick trong `evaluateSpotPerp()` và fallback `+1.5 bps` tạo lợi nhuận giả. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Chỉ cộng funding khi bước qua mốc thanh toán 8 giờ thực tế (`Math.floor(nowTs / (8 * 3600 * 1000))`), hoàn toàn bất biến với tần suất tick; khi thiếu `fundingRateBps` mặc định bằng `0.0` bps. |
| **F07** | HIGH | Vốn gộp chung `cashBalanceUsdt`, thiếu theo dõi tồn kho (inventory) và ký quỹ (collateral) tách biệt theo từng sàn Binance và Bybit. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Thêm `venueBalances` (`binance` và `bybit`, mỗi bên khởi tạo `5,000 USDT` free collateral + pre-funded `baseInventory` cho `BTC/USDT` và `ETH/USDT`) vào `PaperStrategyEngine`. Đã khắc phục triệt để Bug 1 (R2 - âm spot balance) bằng kiểm tra pre-trade `sellerVenue.baseInventory >= requiredBaseQty` và bổ sung regression test. |
| **F08** | HIGH | `getCurrentEquityUsdt()` chỉ cộng `cashBalanceUsdt + allocated` (bỏ qua unrealized P&L của vị thế mở) và điều kiện dừng dùng `>` thay vì `>= 2.0%`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** `updateMarkToMarketDrawdown(sequencer, nowTs)` định giá lại toàn bộ vị thế mở theo VWAP orderbook hiện tại trừ phí thoát ước tính, tích hợp trực tiếp vào vòng lặp `evaluatePair()`, `getCurrentEquityUsdt()`, `getSnapshot().equityUsdt`, và kích hoạt `haltedByDrawdown = true` ngay khi `maxDrawdownPct >= maxDrawdownLimitPct` (`2.0%`). Khắc phục Bug 2 (R3) và bổ sung regression test. |
| **F09** | HIGH | `PaperTradingDurableObject` chỉ lưu `closed_cycles`, mất số dư tiền mặt, vị thế mở và drawdown khi DO khởi động lại; chưa lưu R2 replay archive. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Thêm `serializeState()` / `restoreState()` cho `PaperStrategyEngine`, lưu `strategy_state_${sid}` trong DO storage, thêm `loadFromD1()` và ghi archive chu kỳ đóng vào R2 (`paper-replay/...`). Khắc phục Bug 3 (R5 - commit-after-write idempotency trong `PaperJournal.recordClosedCycle()`) và bổ sung migration `029_paper_trading_outbox_and_runs.sql`. |
| **F10** | HIGH | Migration `028_paper_trading_journal.sql` chưa có trigger chặn `UPDATE`/`DELETE` trên bảng `paper_trading_cycles`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Bổ sung `trg_paper_trading_cycles_immutable_update` và `trg_paper_trading_cycles_immutable_delete` (`SELECT RAISE(ABORT, ...)`). |
| **F11** | HIGH | `.github/workflows/deploy.yml` cho phép `workflow_dispatch` chạy `deploy-production` ngay cả khi `deploy-staging` bị skipped. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Thêm điều kiện bắt buộc `needs.deploy-staging.result == 'success'` cho `deploy-production` và bước xác minh `GITHUB_SHA` khớp tuyệt đối. |
| **F12** | MEDIUM | `src/app/api/terminal/snapshot/route.ts` trả về `latencyMs: 12` cố định và giá tĩnh không gắn cờ `SYNTHETIC_DEMO_SNAPSHOT`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Thêm `isSyntheticDemo: true`, `dataSource: 'SYNTHETIC_DEMO_SNAPSHOT'`, và bỏ số đo độ trễ giả (`latencyMs: null`). |
| **F13** | MEDIUM | `BinanceCrawlerAdapter` và `BybitCrawlerAdapter` trộn biểu phí tĩnh với danh sách symbol live mà không gắn cờ provenance rõ ràng. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Gắn `metadata.data_source = 'live_symbols_with_curated_rates'` và `symbols_crawled_live = true` khi kết hợp symbol live với biểu phí chuẩn. |
| **F14** | MEDIUM | `PayoutRouter.isStellarOnlyEnforced()` có thể bị tắt qua biến môi trường trong production/staging. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Khóa cứng `isStellarOnlyEnforced() === true` khi `NODE_ENV === 'production'` hoặc `APP_ENV === 'production'` / `'staging'` bất kể cờ môi trường. |
| **F15** | MEDIUM | `src/app/api/admin/paper/__tests__/paper-routes.test.ts` khóa hành vi fail-open (`200 OK` khi không có session). | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Viết lại bộ test kiểm chứng đầy đủ 4 kịch bản fail-closed (`401` anonymous, `403` shopper, `503` khi `getAuth` lỗi, `200` khi admin hợp lệ). |
| **F16** | HIGH | Báo cáo trước kết luận `GO` khi `verifiedRealMarketDays = 0`. | Tồn tại trên `bbc4b7f3` | **ĐÃ SỬA:** Báo cáo này và toàn bộ cổng kiểm toán kinh tế trả về **NO-GO** trung thực cho tới khi hoàn tất 30 ngày chạy thực tế. |

---

## 2. Kiểm Toán Chuỗi Cashback End-to-End

Đã kiểm tra và chạy toàn bộ bộ test cho chuỗi **Auth → Tracking Click → Exchange Webhook → Commission Matching (30%/10%/5%) → Double-Entry Ledger → Payout Batch & Stellar USDC Rail → Reconciliation**:
- **Tracking & Attribution (`src/lib/tracking/__tests__/`):** Xác thực chữ ký HMAC-SHA256 trên payload gốc (`req.text()`), chống replay qua `webhook_dedup`, khớp người dùng qua ví/email trong cửa sổ 30 ngày, phân bổ hoa hồng 3 tầng (30% / 10% / 5%).
- **Earnings & Ledger (`src/lib/earnings/__tests__/`):** Tổng hợp thu nhập chưa thanh toán, ngăn chặn chi trả trùng lặp.
- **Payouts & V1 Stellar Gate (`src/lib/payouts/__tests__/`):**
  - `AUTO_SETTLE_PAYOUTS = "false"` trong cả `wrangler.jsonc` và `wrangler.staging.jsonc`.
  - `V1_STELLAR_ONLY_PAYOUTS = "true"` và khóa cứng trong `PayoutRouter.isStellarOnlyEnforced()` cho môi trường staging/production.
  - Sàng lọc lệnh trừng phạt (sanctions screening) đồng bộ trước khi ký giao dịch.
- **Kết quả chạy test chuỗi Cashback/Payout:** `11 test suites passed, 113 tests passed`.

---

## 3. Kết Quả Kiểm Chứng Kỹ Thuật (Node v26.7.0)

1. **Runtime:** `node --version` → `v26.7.0`
2. **Typecheck (`npx tsc --noEmit`):** `0 errors`
3. **Linter (`npm run lint`):** `0 errors, 0 warnings`
4. **Go-Live Gate (`ALLOW_DIRTY_TREE=1 bash scripts/go-live-gate.sh`):** `28 passed, 0 failed`
5. **Full Test Suite (`npm test`):** `152 passed, 152 total` (`3,386 passed, 1 skipped, 0 failed`)

---

## 4. Phán Quyết Nghiệm Thu Cuối Cùng (Final Verdict)

- **Trạng thái kỹ thuật tại kho mã (Local Codebase & Automated Gates):** **ĐẠT (PASS)** — Toàn bộ 16 findings F01–F16 từ báo cáo kiểm toán độc lập đã được khắc phục triệt để và có test bảo vệ.
- **Trạng thái cổng kinh tế (Economic Go-Live Gate):** **CHƯA ĐẠT (NO-GO)** — `verifiedRealMarketDays = 0 / 30` ngày bắt buộc và `closedCyclesCount = 2 / 100` chu kỳ thực tế.
- **Quyết định phát hành Production:** **NO-GO**. Không triển khai lên Production cho tới khi:
  1. Triển khai bản sửa lỗi này lên môi trường **Staging** (`apex-os-staging`) và hoàn tất diễn tập phục hồi (crash/restart DO, D1 migration `028_paper_trading_journal.sql`).
  2. Chạy Paper Trading liên tục tối thiểu **30 ngày trên dữ liệu thị trường thật** với cấu hình đóng băng (`model_version: paper-v1.0.0`), đạt **>= 100 chu kỳ đóng hợp lệ** trên mỗi chiến lược (`spot-2exch` và `spot-perp`), **Net P&L > 0** sau toàn bộ chi phí, và **Max Drawdown <= 2.0%**.
