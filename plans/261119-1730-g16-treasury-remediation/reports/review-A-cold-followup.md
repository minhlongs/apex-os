# Review A — Kiểm tra lại bản sửa cold / Cold follow-up review

**Status: DONE_WITH_CONCERNS.** Reviewer độc lập `a3b57d5c7483c66f2` kiểm tra bản đóng băng tại worktree `g16-implementation`; không sửa file hoặc tác động hệ thống thật. / Independent reviewer inspected the frozen implementation without modifying files or accessing live systems.

## Đã xác minh / Verified

- Lỗi High nghẽn hàng đợi do cold legacy đã đóng. Hai nhóm actionable và diagnostic có hạn mức riêng. Qua nhiều lượt, 26 claim trị giá $300 và một khoản hot hoàn tất; 26 dòng legacy và các khoản khóa không đổi, không hoàn tiền. / Legacy diagnostics no longer starve actionable recovery.
- Claim được giữ khi thiếu máy đối soát. Sau khi ledger commit nhưng cập nhật trạng thái gián đoạn, retry hoàn tất mà không ghi trùng. / Claims survive unavailable recovery machinery and post-ledger state-update failure.
- Reviewer chạy Jest `--no-cache` với SQLite bộ nhớ và kết nối mô phỏng: **74 passed; 7 T‑02/T‑03 skipped by filter**. Xác minh Base mainnet/testnet $300, sai mạng/tài sản, fallback đọc lại toàn bộ proof, và các Stellar operations riêng biệt trong cùng giao dịch không bị dùng lại. / Offline checks cover exact-$300 Base cases, complete fallback proof restart and Stellar operation uniqueness.

## Chưa đạt / Remaining findings

### High — Thiếu bảng ledger có thể báo thành công giả / Missing ledger can yield false success

Nguồn tại thời điểm review: `src/lib/payouts/settlement-reconciler.ts:267–279`, `:321–325`, `:415–454`. Selector bỏ qua lỗi thiếu bảng; lookup coi bảng `ledger_journal_batches` không tồn tại như không có lock. Hot recovery sau đó có thể tăng `confirmed` hoặc `reverted` dù chưa ghi sổ. Terminal rows có lock đang chờ cũng có thể biến khỏi lượt quét. / Missing-schema fallback can hide pending ledger work and report terminal success without posting.

Regression bắt buộc: thiếu `ledger_journal_batches`, hot `BROADCAST_PENDING` quan sát thành `CONFIRMED` hoặc `FAILED_ABORTED`; báo rõ lỗi bảng, không tăng bộ đếm thành công, không ghi sổ hoặc hoàn tiền. Có thể reject cả lượt trước mutation hoặc trả lỗi cấp lượt; không được đổi lỗi lookup thành `null`. / Required tests must preserve the schema failure rather than treating it as an absent lock.

### Medium — Thiếu claims có thể báo lượt rỗng thành công / Missing claims can yield a green empty run

Nguồn: `src/lib/payouts/settlement-reconciler.ts:267–279`, `:350`. SQLite có migrations 028 và 032 nhưng thiếu 033 phải báo rõ `cold_settlement_claims` hoặc migration 033, kể cả không có candidates. Nếu giữ fallback, không resume/refund cold. / A missing required claim table must remain visible even with zero rows.

### Giới hạn quan sát không chặn actionable recovery / Nonblocking diagnostic limitation

Hạn mức cảnh báo lặp lại 25 legacy rows cũ nhất, nên dòng thứ 26 chưa được phát cảnh báo. Điều này không còn chặn các claim có thể phục hồi. / Oldest-first diagnostic pagination remains bounded and incomplete, but no longer starves actionable work.

## Xử lý / Disposition

Điều phối viên giao bản sửa schema có kiểm thử đỏ trước sửa; chưa có kết quả tích hợp hoặc signoff tiếp theo. Review A ban đầu được giữ riêng tại [review-A-cold-proof.md](./review-A-cold-proof.md). / Schema repair and another independent pass remain pending; the original review is preserved separately.
