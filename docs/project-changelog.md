# Project Changelog (Nhật Ký Phát Hành ApexOS)

---

## [1.6.0] — 2026-10-30 (Cashback Hardening & Greenfield Paper Trading Console: G0–G7)

### Tổng quan / Summary
- **Tiếng Việt:** Bản phát hành `v1.6.0` hoàn tất kiểm toán nền tảng Cashback/Affiliate (cô lập hai chiều D1/KV/R2 giữa Staging và Production, xóa bỏ khóa HMAC cố định và thông số marketing `12ms` giả lập, khóa cứng cổng thanh toán V1 chỉ cho phép Stellar USDC kèm duyệt thủ công `AUTO_SETTLE_PAYOUTS=false`, gắn nhãn nguồn dữ liệu `fallback_fixture` cho crawler) và triển khai Greenfield Paper Trading Engine trên Cloudflare Durable Objects (bộ tuần tự sổ lệnh L2 Binance & Bybit cho `BTC/USDT` và `ETH/USDT`, hai sổ cái chiến lược độc lập 10.000 USDT `spot-2exch` và `spot-perp`, nhật ký bất biến D1/R2 có khóa chống trùng SHA-256, kiểm định phát lại 50-tick trùng khớp 100% bit-identical, và Admin Console 3 bề mặt có đóng dấu `PAPER SIMULATION ONLY`).
- **English:** Release `v1.6.0` completes the Cashback/Affiliate platform security hardening (bidirectional D1/KV/R2 staging-production isolation, removal of hardcoded HMAC secret literals and fabricated `12ms` latency claims, V1 Stellar-only payout rail guard with `AUTO_SETTLE_PAYOUTS=false`, explicit `fallback_fixture` crawler provenance) and ships the Greenfield Paper Trading Simulator on Cloudflare Durable Objects (Binance & Bybit L2 orderbook sequencer for `BTC/USDT` & `ETH/USDT`, two isolated 10,000 USDT strategy ledgers `spot-2exch` and `spot-perp`, immutable SHA-256 idempotent journal, 100% bit-identical 50-tick deterministic replay verification, and 3-surface Admin Console with CSV/PDF export and descriptive non-blocking economic research telemetry).

### Bằng chứng Kiểm định (Verification Evidence)
- **Go-Live Gate (`bash scripts/go-live-gate.sh`)**: `27/27 PASS, 0 FAIL` (`G0`–`G7`)
- **Test Suite (`npm test`)**: `152/152` suites green (`3,375` passed, `1` skipped) trên Node `v26.7.0`

---

## [1.5.0] — 2026-10-26 (Zero-Bug Go-Live Release: Phases 01–07)

### Tổng quan / Summary
- **Tiếng Việt:** Bản phát hành sản xuất (Go-Live `v1.5.0`) hợp nhất toàn bộ các giai đoạn chuẩn hóa môi trường Node 26 (`Phase 01`), kiểm tra kiểu nghiêm ngặt `strict: true` (`Phase 02`), hợp nhất cấu hình Cloudflare Worker (`Phase 03`), chuẩn hóa luồng tiền tệ đơn vị nguyên & khóa xác nhận on-chain (`Phase 04`), cô lập D1 Staging & tự động hóa CI/CD (`Phase 05`), cổng kiểm định Go-Live G0–G5 (`Phase 06`), và quy trình đối chiếu/cutover sản xuất (`Phase 07`).
- **English:** Production Go-Live release (`v1.5.0`) unifying Node 26 runtime determinism (`Phase 01`), strict TypeScript compilation (`Phase 02`), single JSONC Worker config (`Phase 03`), exact minor-unit money math & on-chain settlement gating (`Phase 04`), isolated Staging D1 & OpenNext deploy pipeline (`Phase 05`), automated G0–G5 Go-Live verification gate (`Phase 06`), and historical payout reconciliation + cutover runbook (`Phase 07`).

### Thay đổi trọng tâm (Key Changes)
1. **Single Payout Settlement Authority (`D2=batch-settlement-service-single-authority`)**:
   - Hợp nhất `POST /api/payouts`, `/api/cron?job=payouts`, và `worker-wrapper.js` về một cổng thanh toán duy nhất `BatchSettlementService.executeBatch()`.
   - `worker-wrapper.js` ủy quyền hoàn toàn cho `/api/cron?job=payouts` kèm xác thực `Bearer ${env.CRON_SECRET}`.
2. **Chống Double-Spend & Bảo toàn Sổ cái (`G4c`, `G4d`, `G4e`)**:
   - Lưu `transaction_id` ngay cả khi giao dịch chưa được xác nhận tức thì (`!isSettled(verdict)`) trong `executeBatch`, giúp `retryPayout` kiểm tra lại trạng thái trên chuỗi trước khi phát lệnh mới.
   - Gom toàn bộ thao tác `UPDATE earnings SET is_paid = 1` vào helper duy nhất `prepareRetireEarningsStatement()` chỉ chạy khi `isSettled(verdict) === true`.
   - Tính toán hoa hồng và phí hoàn toàn bằng đơn vị nguyên (`minor units` / micro-USDC `BigInt`), loại bỏ sai số số thực IEEE-754.
3. **Fail-Closed Multi-Chain & Manual-First Rollout (`D1=stellar-mainnet-fail-closed`, `G4b`, `G4h`, `G4i`)**:
   - `resolveStellarNetwork()` bắt buộc cấu hình tường minh `STELLAR_NETWORK=mainnet` trên production; tự động fail-closed nếu thiếu.
   - `SolanaAdapter` và `EthereumAdapter` giữ chế độ fail-closed (`success: false`), loại bỏ hoàn toàn `MOCK_SIGNED_TX_PAYLOAD` và hash giả lập.
   - Cờ `AUTO_SETTLE_PAYOUTS=false` mặc định trên production giữ cron ở chế độ an toàn cho đến khi Admin duyệt thủ công đợt đầu tiên.
   - Biên lai email (`src/lib/payouts/receipts.ts`) tự động chọn URL Stellar Expert (`public` cho `mainnet`, `testnet` cho `testnet`).
4. **Deploy Pipeline, Cô lập Staging D1 & Cổng Kiểm Định G0–G5 (`Phase 05–07`)**:
   - Thêm `/api/version`, `wrangler.staging.jsonc` (cô lập `apex-os-staging-db`), `scripts/assert-staging-isolation.sh`, `scripts/smoke-protected-routes.sh`, `scripts/verify-deployment.sh`, `scripts/go-live-gate.sh`, và `scripts/reconcile-historical-payouts.sh`.
   - Thêm tài liệu vận hành `docs/rollback-runbook.md`, `docs/go-live-checklist.md`, và `docs/cutover-runbook.md`.

### Bằng chứng Kiểm định (Verification Evidence)
- **Merge Commit (Phase 04+05+06)**: `754984bd` ([PR #4](https://github.com/minhlongs/apex-os/pull/4), [Issue #3](https://github.com/minhlongs/apex-os/issues/3))
- **Merge Commit (Phase 07 Cutover & Reconciliation)**: `bb04eb60` ([PR #6](https://github.com/minhlongs/apex-os/pull/6), [Issue #5](https://github.com/minhlongs/apex-os/issues/5))
- **Go-Live Gate (`npm run gate`)**: `22/22 PASS, 0 FAIL` (`G0`–`G5`, bao gồm kiểm định SQLite `GLOB` 64-char hex parity trên `scripts/reconcile-historical-payouts.sh`)
- **Test Suite (`CI=true npm test`)**: `143/143` suites green (`3,327` passed, `1` skipped) trên Node `v26.7.0`
