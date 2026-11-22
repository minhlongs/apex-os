# Review A — Giữ khóa khi không đọc được trạng thái / Retain lock on unknown settlement state

**Kết luận / Result:** Rà soát độc lập không tìm thấy lỗi chặn trong bản sửa dispatch. Lỗi đọc không chứng minh bản ghi vắng mặt: hệ thống giữ lock để lần khôi phục sau đối soát. / Independent source review found no blocker in the dispatch repair. A failed read cannot establish absence; the lock remains available for reconciliation.

Reviewer kiểm tra bản vá và truy vết cả trường hợp replay đã tất toán, trạng thái pending/confirmed và hoàn khóa hợp lệ trước khi phát giao dịch. Kiểm thử mới không thay thế ca timeout cũ. Nó xác nhận khóa giữ `INFLIGHT`, không tạo bút toán hoàn, sau đó tất toán đúng một lần qua hai lần recovery, không gửi lại. / The reviewer traced settled replays, pending and confirmed outcomes, and eligible pre-broadcast reverts. The additive test checks lock retention, no refund, and one finalization across two recovery calls without resubmission.

**Kiểm chứng / Verification:** Điều phối viên chạy trên worktree tích hợp: 3 suites đạt, 92 ca đạt, 7 ca ngoài bộ lọc, exit 0; xem [log](../../reports/ascendancy-p2/g16-dispatch-integrated.txt). Reviewer không chạy lại được Jest vì hook chặn; kết luận độc lập dựa trên mã và assertions, không phải lần chạy thứ hai. / The integration run passed. The reviewer's Jest attempt was blocked; the independent result is source review, not a second test execution.

**Còn mở / Open:** Fixture Track A đã cập nhật và cả 26 ca trong lượt chạy Track A cùng hai suite liền kề đều đạt. Kết luận này vẫn không phê duyệt toàn T‑01 hoặc toàn treasury. / Track A fixture alignment is complete, and all 26 cases across Track A and two adjacent suites passed. Neither full T‑01 nor treasury release is approved by this review.
