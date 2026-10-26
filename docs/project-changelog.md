# Project Changelog (Nhật Ký Phát Hành ApexOS)

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
- **Go-Live Gate (`npm run gate`)**: `21/21 PASS, 0 FAIL` (`G0`–`G5`)
- **Test Suite (`CI=true npm test`)**: `143/143` suites green (`3,326` passed, `1` skipped) trên Node `v26.7.0`
