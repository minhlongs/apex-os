# Review C — Kiểm tra đối kháng T‑03 / T‑03 adversarial checkpoint

**Trạng thái / Status: BLOCKED — HOLD.** Rà soát độc lập checkpoint ổn định đã hoàn tất với các điều kiện còn mở; không nghiệm thu bản tích hợp. / Independent stable-checkpoint rereview is complete with concerns; the integrated candidate is not accepted.

## Bổ sung sau rà soát checkpoint ổn định / Stable-checkpoint addendum

- Lỗi starvation bên dưới đã được sửa: terminal chưa đủ proof dùng quota chẩn đoán riêng; kiểm thử backlog qua nhiều lượt đạt trong standalone suite 31/31. / The previously reproduced starvation is fixed with a separate diagnostic quota and passing multi-tick regression.
- Vẫn chặn: tất cả hot writers ghi `UNVERIFIED_HOT`, chưa có vòng đời promotion theo finality; nghĩa vụ thành công có thể giữ hạn mức vô thời hạn. / Finalized hot-confirmation lifecycle remains incomplete.
- Vẫn chặn: migration 036 chỉ giải phóng `PRE_SUBMISSION_ABORT`, chưa đủ vòng đời release/refund hoặc re-execution dựa trên chứng cứ chain. EVM reverted receipt **có** kiểm tra `readFinalizedReceipt(..., '0x0')`; không nhầm thiếu persistence với thiếu kiểm tra finality. / Chain-proven terminal release is incomplete despite EVM reverted-receipt finality verification.
- Controller chạy bảy suite: **4 failed, 3 passed; 16 failed, 202 passed**, gồm một fixture thiếu 036, 12 dust failure/refund expectations, hai reconciler expectations, một overflow rejection. [Log](../../reports/ascendancy-p2/g16-t03-controller-focused.txt). / Integrated verification remains red.
- Ca overflow đạt riêng (1 passed, 30 skipped) và toàn bộ exposure suite đạt 31/31; reviewer đã đọc trực tiếp cả hai log. Đây là khác biệt lượt gộp chưa rõ nguyên nhân, **không phải lỗi SQL overflow đã chứng minh**. / The overflow discrepancy is not a proven SQL defect; standalone green does not erase integrated red. [Isolated](../../reports/ascendancy-p2/g16-t03-overflow-isolated.txt), [standalone suite](../../reports/ascendancy-p2/g16-t03-exposure-controller.txt).
- Effect-fence suite đạt trong lượt controller. Nghi vấn test kỳ vọng refund đã được rút vì bản ổn định hiện kỳ vọng giữ lock. / The earlier effect-fence test mismatch is withdrawn; the stable suite passes with retained-lock expectations.
- Reviewer không thấy thêm đường undercount/refund bypass có thể tới được trong phạm vi đã xem. Không có xác minh D1 runtime hoặc đầy đủ concurrent first-confirmation lifecycle. / No additional reachable bypass was established; D1 and full concurrent first-confirmation evidence remain open.

Các mục sau giữ lịch sử rà soát ban đầu; kết luận hiện tại ở bổ sung trên. / Following sections preserve the initial review history; the addendum above is current.

## Lỗi đã xác minh / Verified blocker

**High — Hàng kết thúc chưa đủ bằng chứng chặn hàng đợi đối soát.** Trong `src/lib/payouts/settlement-reconciler.ts`, terminal hot `FAILED_ABORTED`/`EXPIRED_RECOVERED` có lock `INFLIGHT` cùng chiếm quota với pending, xếp theo `updated_at` cũ nhất. Khi bị từ chối hoàn tiền do thiếu proof, hàng không thay đổi và tiếp tục được chọn. / Unproven hot terminal rows share the actionable quota and remain oldest after refund denial, starving newer pending rows.

Reviewer độc lập tái hiện trên SQLite với migration đến 036: `limit=3`, ba terminal cũ `a,b,c`, pending mới `z`; hai lượt đều chọn `a,b,c`, proof view rỗng, không chọn `z`. Cần phân loại retained/manual riêng và kiểm thử backlog vượt quota qua nhiều lượt. / The independent reviewer reproduced the starvation over two ticks. Retained/manual rows must not consume actionable capacity; a multi-tick regression is required.

## Bằng chứng hiện có / Current evidence

- Reviewer áp dụng chuỗi migration fixture `028 → 033 → 034 → 035 → 036` trên SQLite 3.53.2 thành công; còn đúng một failed-receipt publisher, `foreign_key_check` không có lỗi. Chưa xác minh D1 runtime. / SQLite fixture migration checks passed; D1 runtime verification remains pending.
- Lượt T‑03 giữa kỳ: **3 failed, 83 skipped**, do fixture chỉ đến 035 và thiếu `signing_lane`. Không phải kết quả bản cuối. / The interim focused run failed on stale fixtures, not a final candidate.
- Timestamp lịch sử null/sai/tương lai vẫn được tính. Hot confirmation writers có điều kiện `BROADCAST_PENDING`; cold writer có điều kiện `QUEUED_COLD_SAFE`; replay thông thường không đổi mốc quan sát. / Ambiguous timestamps remain counted; guarded confirmation writers preserve ordinary replay timestamps.
- Cold finalizer kiểm tra durable claim và ledger finalization trước khi ghi lane/time. / The cold finalizer checks the durable claim and ledger finalization before recording exclusion metadata.

## Phân biệt nghi vấn / Hypothesis disposition

Direct SQL có thể retire một attempt khi trigger không cập nhật broadcast tương ứng. Chưa chứng minh đường production tới lỗi này: `recordFailedReceipt` lặp cùng điều kiện identity/grant trong một statement. Đây là đề xuất contract test, không phải blocker đã xác minh. / A direct-SQL mismatch is reproducible, but the production writer duplicates the relevant predicates in the same statement; treat it as contract-test evidence, not a confirmed reachable blocker.

## Cần kiểm chứng tiếp / Pending verification

- Sửa starvation và fixture 036; chạy CAP boundaries, global concurrency qua INSERT/retry UPDATE, và giữ nghĩa vụ lịch sử chưa có proof. / Verify starvation repair, current fixtures, exact caps and both concurrent admission branches.
- Kiểm chứng release/refund chỉ từ bằng chứng đủ mạnh, không từ hash/boolean hoặc nhãn terminal. Bản sửa đang chọn giữ exposure khi chưa chứng minh finality/inclusion. Chưa nghiệm thu lựa chọn này hoặc CAP-07. / Verify terminal evidence and conservatively retained ambiguous receipts; no acceptance is implied yet.
- Kiểm thử restart, nhiều attempt, prior grants, replay timestamps và cold proposal không có claim. / Cover restart, prior grants, replay stability and proposal-only cold records.
- Reviewer phải rà soát lại checkpoint ổn định trước khi ký kết luận cuối. / Re-review a stable checkpoint before final disposition.

Không commit/push, không chạy final gates, không gọi signing/RPC thật hoặc sửa remote database. / No commit, push, final gates, live signing/RPC or remote database changes.
