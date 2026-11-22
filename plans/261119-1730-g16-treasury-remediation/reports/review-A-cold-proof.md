# Review A — Independent Cold Settlement Proof Review (T-01)

*Preserved verbatim from independent read-only reviewer agent `ac2332b474f90f9ca` (which operates under a no-write restriction).*

## T-01 — Kết quả review độc lập / Independent review

**Kết luận:** Có **1 lỗi High về khả năng phục hồi tự động** cần xử lý trước khi kết luận T-01 hoàn tất. Chưa phát hiện đường xác nhận sai hoặc tái sử dụng cùng operation trong phần nguồn đã kiểm tra. Đây không phải xác nhận sẵn sàng production cho toàn bộ treasury; T-02/T-03 ngoài phạm vi.

### Phạm vi và phương pháp

- Nguồn frozen tại `/Users/macbook/apex-os-worktrees/g16-implementation`, HEAD xác minh là `262b070a0f07eeb3367415bb192ed2bf717f5867`.
- Đọc toàn bộ diff tracked, ba file untracked, README, CLAUDE.md, API docs diff, các caller production và kiểm tra ledger liên quan.
- Scout tập trung vào xác nhận đồng thời giữa service instances, claim đã lưu nhưng ledger lỗi, mất phản hồi sau commit, freeze, dữ liệu cold lịch sử và hàng đợi recovery.
- Không sửa nguồn, không tạo report file, không gọi RPC thật, ký giao dịch, truy cập DB remote hoặc chạy lại suite parent đã chạy. Parent có thể lưu nội dung này tại `/Users/macbook/apex-os-worktrees/phase2-ascendancy/plans/261119-1730-g16-treasury-remediation/reports/review-A-cold-proof.md`.

## High — Legacy cold records có thể chặn vĩnh viễn recovery của claim mới

**Vị trí**
- `/Users/macbook/apex-os-worktrees/g16-implementation/src/lib/payouts/settlement-reconciler.ts:236–250`
- `/Users/macbook/apex-os-worktrees/g16-implementation/src/lib/payouts/settlement-reconciler.ts:378–390`
- `/Users/macbook/apex-os-worktrees/g16-implementation/src/lib/payouts/broadcast-recovery-machine.ts:2328–2342`

**Trạng thái gây lỗi cụ thể**

1. Có ít nhất 25 cold records lịch sử, trạng thái terminal, lock vẫn `INFLIGHT`, nhưng chưa có verified claim.
2. Chúng cũ hơn một cold payout mới đã lưu claim, đang `QUEUED_COLD_SAFE` sau freeze hoặc lỗi ledger.
3. Truy vấn chọn các terminal records trên, sắp theo `updated_at ASC`, lấy mặc định 25.
4. Nhánh cold gọi `resumeColdPaymentClaim`. Record `CONFIRMED` không claim bị từ chối; record `FAILED_ABORTED` không đủ điều kiện ngay từ `requireColdPayout`.
5. Catch chỉ ghi lỗi vào kết quả; không thay đổi thứ tự, cursor hoặc lịch thử lại. Tick tiếp theo lại chọn đúng 25 records đó.

**Tác động:** Claim mới không bao giờ được tác vụ tự động xử lý, kể cả sau khi gỡ freeze hoặc DB đã bình thường. Các broadcast mới khác phía sau cũng có thể bị chặn. Tiền không bị hoàn hay ghi sổ sai, nhưng yêu cầu recovery tự hội tụ không được bảo đảm.

**English:** Permanently ineligible legacy cold rows can monopolize the bounded reconciliation queue, indefinitely starving recoverable claims.

**Khuyến nghị:** Tách hàng đợi tự phục hồi khỏi các cold records cần xử lý thủ công; chỉ đưa cold rows có claim và trạng thái được hỗ trợ vào hàng đợi tự động. Vẫn phải báo cáo riêng legacy rows, không tự hoàn tiền hoặc bỏ qua yêu cầu chứng cứ. Bổ sung defensive test có hơn một trang legacy rows và một recoverable claim ở phía sau.

**Mức xác minh:** Đường đi được xác minh trực tiếp bằng truy vấn và các nhánh code; không chạy reproduction.

## Kiểm chứng các bất biến chính

- **Canonical proof:** EVM kiểm tra chain ID, receipt thành công, transaction hash, canonical block, finalized height và Transfer log từ đúng USDC contract. Source lấy từ event, không nhầm với relayer.
- **Stellar:** Kiểm tra network passphrase, transaction/operation thành công, operation identity dạng chuỗi, pagination, payment source, recipient, issuer và stroops chính xác.
- **Không tái sử dụng:** Claim có khóa chính `(network, tx_hash, operation_id)` và unique riêng cho payout/lock; không phụ thuộc mutex trong một isolate.
- **Lock linkage:** Claim insert có điều kiện đối chiếu payout, owner, lock, chain, amount và trạng thái `INFLIGHT`.
- **Crash/retry:** Claim được lưu trước ghi sổ; lỗi/freeze không giải phóng claim. Retry kiểm tra ledger batch và lock đã commit trước khi trả thành công.
- **Cancellation:** Từ chối hoàn tiền khi chưa chứng minh proposal không thực thi — đây là giới hạn an toàn có chủ đích, không phải lỗi.
- **Production callers:** Route admin gọi resolver sau admin + Passkey step-up. Cron gọi passive reconciler; nhánh resume claim không ký hoặc broadcast giao dịch mới.

## COLD-01–10 — Coverage và khoảng trống

Nguồn test chính: `/Users/macbook/apex-os-worktrees/g16-implementation/src/__tests__/sandbox/g16-treasury-regressions.test.ts`.

| Tiêu chí | Bằng chứng test đã đọc | Khoảng trống |
|---|---|---|
| COLD-01: Không có USDC transfer đúng recipient | Matrix từ dòng 319: no logs, recipient-only, wrong recipient | Có assertions claim/lock/finalization |
| COLD-02: Hash thành công không liên quan | Unrelated transaction, wrong source/recipient trong matrix | Không có dedicated case nghĩa vụ **$300**; fixture chính là $15 |
| COLD-03: Hai payouts không dùng cùng operation | Đồng thời hai instances, dòng 354 | Dùng $15 thay vì $300 |
| COLD-04: Sai token | EVM wrong asset; Stellar wrong issuer/code/native | Chưa có Base-specific fixture |
| COLD-05: Sai amount | EVM lệch một token unit; Stellar lệch một stroop | Có assertions không claim/không finalization |
| COLD-06: Sai treasury source | Matrix EVM và Stellar | Có kiểm tra source từ operation thực |
| COLD-07: Hai operations riêng có thể settle riêng | Dòng 343: ambiguous reject, sau đó chọn operation 1/2 | Dùng $15; chưa có Stellar equivalent |
| COLD-08: Sai network | EVM chain ID; Stellar network passphrase | Chưa kiểm tra chuyển toàn bộ proof sang fallback |
| COLD-09: Thiếu/không rõ chứng cứ | Missing metadata, malformed ABI, duplicate IDs, ambiguity | Chưa có đầy đủ Stellar malformed/pagination-failure matrix |
| COLD-10: Retry không ghi sổ lần hai | Dòng 423, 440; authenticated route regression | Có assertions một finalize batch/hai postings |

**Additional required cases:** Đã thấy tests cho concurrent instances, claim persistence khi ledger batch lỗi, retry không đọc provider lại, claim-storage failure, mất phản hồi sau ledger commit và freeze rồi reconcile.

**Khoảng trống đáng bổ sung:** backlog starvation nêu trên; Base cold-proof; Stellar distinct-operation/concurrent replay; fallback restart không trộn chứng cứ giữa hai RPC. Việc dùng $15 không chứng minh sai thuật toán, nhưng chưa đáp ứng nguyên văn các acceptance cases $300.

Route integration $300 nằm tại `/Users/macbook/apex-os-worktrees/g16-implementation/src/__tests__/sandbox/settlement-and-legacy-boundary.test.ts:485–543`.

## Lệnh và kết quả / Verification evidence

Reviewer trực tiếp chạy:

```text
node -v
→ v26.7.0

git -C /Users/macbook/apex-os-worktrees/g16-implementation rev-parse HEAD
→ 262b070a0f07eeb3367415bb192ed2bf717f5867

git -C /Users/macbook/apex-os-worktrees/g16-implementation diff --check
→ exit 0, không có output

git -C /Users/macbook/apex-os-worktrees/g16-implementation check-ignore src/database/migrations/033_cold_settlement_claims.sql
→ không có output; migration không bị ignore
```

Parent báo **T01: 49 passed / 7 skipped**, và **6 adjacent suites: 40 passed**. Đây là kết quả parent cung cấp, không phải lượt chạy độc lập của reviewer; không có exact test command trong thông tin được chuyển giao.

Không chạy build/lint/typecheck/full suite trong lượt review này. Không đo phần trăm type/test coverage.

## Đề xuất trạng thái plan

Phần implementation về strict proof, durable claims, lock linkage và idempotent ledger recovery đã hiện diện. **Chưa nên đóng yêu cầu recovery convergence** cho đến khi xử lý queue starvation và thêm defensive regression tương ứng. Không thay đổi trạng thái plan.

### Câu hỏi còn mở / Unresolved questions

- Chủ sở hữu sẽ xử lý và theo dõi legacy cold terminal records không claim bằng quy trình thủ công nào?
- Có yêu cầu các acceptance cases COLD-02/03/07 phải chạy đúng $300, hay chấp nhận fixture tương đương về integer-unit invariants?

**Status: DONE_WITH_CONCERNS**
**Summary:** Hoàn tất review độc lập T-01; phát hiện một lỗi High có thể làm recovery tự động bị kẹt. Không phát hiện false settlement hoặc operation reuse trong phạm vi đã kiểm tra.
**Concerns/Blockers:** Cần sửa recovery starvation trước khi xác nhận T-01 hoàn tất; các khoảng trống test và giới hạn xác minh được liệt kê ở trên.
