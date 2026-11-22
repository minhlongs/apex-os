# G16 — Hồ sơ bàn giao treasury / Treasury owner packet

**Trạng thái / Status: HOLD — chưa đủ điều kiện cập nhật Draft PR #56 / not cleared to update Draft PR #56.** Đây là bản ghi tiến độ, không phải xác nhận phát hành. / This is a checkpoint, not release approval.

## Git và phạm vi / Git and scope

- SHA nền và HEAD hiện tại / Baseline and current HEAD: `262b070a0f07eeb3367415bb192ed2bf717f5867`, branch `feat/ascendancy-phase2-verified`. Chưa có SHA bản vá hoặc URL CI tương ứng. / There is no patched SHA or corresponding CI URL.
- [Draft PR #56](https://github.com/minhlongs/apex-os/pull/56) được xác nhận ở mốc nền; chưa cập nhật PR. / Draft status was checked at baseline; no PR update was made.
- Thay đổi cục bộ thuộc nhóm settlement dispatch, xác minh chứng cứ chain, đối soát, sổ cái, đọc cờ an toàn, hai migration cộng thêm `033_cold_settlement_claims.sql` và `034_withdrawal_freeze_at_write.sql`, kiểm thử liên quan và tài liệu. Danh sách cuối chỉ có sau tích hợp. / The local delta is limited to settlement dispatch, chain evidence, reconciliation, ledger, safety reads, the two additive migrations, related tests, and documentation. The final file manifest awaits integration.

## Ba lỗi và bằng chứng / Three defects and evidence

| Lỗi / Finding | Nguyên nhân, sửa và kiểm chứng / Cause, correction and verification |
|---|---|
| T‑01 | Thiếu kiểm tra operation chuẩn và quyền sở hữu duy nhất. Bản tích hợp ràng buộc operation với payout và lock, giữ claim qua retry và không hoàn tiền khi đọc trạng thái lỗi. Có ba ca đỏ ban đầu; lượt tích hợp gần nhất cho cold proof và dispatch đạt 92 ca, bảy ca T‑02/T‑03 nằm ngoài bộ lọc. Track A cùng hai suite kế cận đạt 26 ca. Review A đã kiểm tra độc lập các phần proof, schema và dispatch; chưa phải duyệt toàn bộ bản cuối. / Missing canonical operation verification and unique ownership were addressed with durable claim and recovery. Three original red cases, 92 focused passes with seven out of filter, and 26 Track A and adjacent passes are recorded. Review A findings and scoped dispositions are in [report 25](./25-COLD-SETTLEMENT-PROOF-BINDING.md). |
| T‑02 | Bản chặn đã tích hợp cục bộ. Lượt chạy tập trung đạt 188/191; cả ba ca đỏ thuộc T‑03. Kiểm thử mô phỏng đã đi qua hoàn tiền thật trong sổ cái; bản tích hợp đòi block EVM chuẩn đã chung cuộc trước khi chấp nhận giao dịch thất bại. Bản ghi lịch sử và tiêu chí dừng tuyệt đối vẫn mở. / The fence is locally integrated; 188/191 focused cases passed, with all three failures in T‑03. Ledger reversal is exercised with simulated external rails; historical terminal rows and the absolute stop guarantee remain open. See [report 26](./26-RECOVERY-EMERGENCY-FENCE.md). |
| T‑03 | Hạn mức dùng thời điểm tạo cho cả giao dịch chưa giải quyết. Ba ca đỏ trên phép đọc, chính sách và giữ chỗ vẫn thất bại giữa kỳ. Chưa tích hợp bản sửa hoặc Review C. / Creation-time filtering ages out unresolved reservations. Three read, policy, and admission cases remained red. No integrated repair or Review C yet. See [report 27](./27-ROLLING-CAP-ACCOUNTING-FIX.md). |

Nguồn trước sửa / Pre-fix evidence: [report 24](./24-TREASURY-P0-BASELINE.md), [baseline Jest log](./g16-baseline-regressions.txt). Lượt Jest toàn bộ giữa kỳ: **184 suite đạt, 1 thất bại; 3.773 ca đạt, 1 bỏ qua, 7 thất bại; exit 1**. Chưa có kết quả build hoặc CI cuối. / The interim full Jest run passed 184 suites with one failed; 3,773 passed, one skipped and seven failed. Final builds and CI are not recorded. The local staging-isolation check returned `STAGING_ISOLATED` on Node 26.7.0.

Lượt Jest toàn bộ mới nhất trên bản tích hợp, trước khi mở rộng kiểm thử vòng đời dust: **186 suites đạt, 1 thất bại; 3.789 ca đạt, 1 bỏ qua, 7 thất bại; exit 1**. Chỉ bốn ca T‑02 và ba ca T‑03 thất bại. Typecheck, lint và kiểm tra cách ly staging đạt; chưa chạy CI SHA cuối. / The latest integrated full-Jest run, before the lifecycle expansion, passed 186 suites, with one failed suite: 3,789 passing, one skipped and seven failing (four T‑02, three T‑03). Typecheck, lint and staging isolation passed. [Log](./g16-current-integrated-jest.txt).

## Bất biến tài chính và cấu hình / Financial invariants and configuration

- Các ca cold đã kiểm tra giữ quyền sở hữu operation và không ghi sổ lần hai trong những tình huống được mô phỏng. Không suy rộng thành số liệu production. / Cold claim ownership and no duplicate posting were checked for the tested scenarios, not measured in production.
- Chưa xác nhận số lần ký/gửi khi đóng băng bằng không, mức exposure lớn nhất, confirmed spend trong cửa sổ, tổng nghĩa vụ thiếu vốn. Review D chạy độc lập đạt 28/28 ca trên ba chain (24 vòng đời với kết nối mô phỏng và 4 XDR chưa ký). Chưa kiểm chứng hai lần ghi tất toán đồng thời hoặc mất phản hồi sau khi tất toán. / Zero frozen effects, maximum exposure, confirmed-window expenditure and unfunded liabilities are not established. Independent Review D passed 28/28 (24 simulated lifecycle and 4 unsigned Stellar XDR cases). Competing terminal writes and terminal-commit response loss remain unverified. Kiểm tra kiểu và lint đạt sau khi mở rộng kiểm thử. / Typecheck and lint passed after the test expansion.
- `COLD_MULTISIG_PRODUCTION_UNVERIFIED`. Chưa xác minh 80% dự trữ; helper không có caller production quan sát được. Không truy cập hệ thống ký hoặc khóa thật. Cấu hình cục bộ giữ `AUTO_SETTLE_PAYOUTS=false` và `V1_STELLAR_ONLY_PAYOUTS=true`. / The multisig and reserve attestations remain open. No live signing access; the payout flags are unchanged. See [report 28](./28-MULTISIG-RESERVE-AND-DUST-EVIDENCE.md).

## Rà soát bảo mật và việc còn mở từ G15 / Security review and open G15 items

Chưa có audit thay thế hoàn tất. Không tìm thấy log lỗi G15.3 trong bộ báo cáo cục bộ; không chuyển trạng thái người dùng cung cấp thành PASS. Shadow promotion coverage/freshness, tính nguyên tử của audit log khi đổi cờ, độ đúng của economic gate và điều kiện pháp lý vẫn mở cho G16; báo cáo G1–G11 trước đó không giải quyết thay G15. / No completed replacement security audit or local G15.3 failure log was found. Shadow promotion coverage/freshness, runtime-flag audit atomicity, economic deployment gating, and legal release conditions remain open; earlier G1–G11 review is not G15 closure.

## Xác nhận tác động bên ngoài / Remote mutation attestation

Không thay đổi remote D1, Cloudflare Workers, production secrets, staging configuration, DNS, tài sản mainnet, ví treasury hoặc cờ payout. Không commit, push, merge, đánh dấu Ready, đóng Issue #55, hay chạy triển khai. / No changes were made to remote D1, Cloudflare Workers, production secrets, staging configuration, DNS, mainnet assets, treasury wallets, or payout flags. No commit, push, merge, ready transition, issue closure, or deployment was performed.

## Trạng thái từng điều kiện / Individual gate status

| Gate | Trạng thái / Status |
|---|---|
| `G15.3_SECURITY_REVIEW` | BLOCKED — audit thay thế chưa đủ / replacement audit incomplete |
| `G15.4_TREASURY_AUDIT` | FAIL — chưa tái nghiệm thu / prior disposition not overridden |
| `G16.1_COLD_PROOF` | Kiểm chứng tập trung đạt; xác minh bản cuối còn chờ / focused verification passed; final verification pending |
| `G16.2_EMERGENCY_FENCE` | HOLD — Review B xác nhận bản sửa hoàn tiền ở mức mã trong worktree riêng; chưa chứng minh vòng đời hoàn tiền qua sổ cái và chưa đạt tiêu chí ký/gửi tuyệt đối / isolated source correction reviewed; integrated ledger reversal and absolute provider-call criterion remain open |
| `G16.3_ROLLING_CAP` | HOLD — bản tích hợp chưa sửa / not fixed in integration |
| `G16.4_RESERVE_AND_DUST` | HOLD — thiếu bằng chứng vòng đời và production / lifecycle and production evidence incomplete |
| `G16.5_INDEPENDENT_REVIEW` | PENDING — Review A theo phạm vi; Review D đạt 51 ca ở lượt đầu và 28 ca ở lượt bổ sung, nhưng giữ HOLD; B/C/E chưa đủ / scoped A and D (51 initial, 28 follow-up; HOLD); B/C/E incomplete |
| `G16.6_GITHUB_CI` | NOT RUN — chưa có SHA bản vá / no patched SHA |
