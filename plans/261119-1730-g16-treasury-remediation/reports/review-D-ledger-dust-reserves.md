# Review D — Sổ cái, số dư lẻ và dự trữ / Ledger, dust and reserves

**Kết luận / Disposition: HOLD G16.4.** Đây là bản ghi của điều phối viên từ kết quả kiểm tra độc lập chỉ đọc, không phải văn bản do reviewer ký hay phê duyệt phát hành. / Controller record of the independent read-only review, not a reviewer-authored sign-off or release approval.

## Đã xác minh / Verified

Review D chạy trên Node 26.7.0, `TZ=Asia/Saigon`: dust và Track A đạt **25 ca trong 2 suites**; G3 ledger, G7 simulation, reconciler và G8 recovery đạt **26 ca trong 4 suites**. Không phát hiện lỗi chặn mới trong vòng đời dust tuần tự đã kiểm thử bằng kết nối mô phỏng. / Review D independently passed 51 tests across six suites and found no new blocker in the tested sequential mocked lifecycle.

## Điều kiện chặn / Blockers

1. **High — Dự trữ 80% chưa được thực thi tại điểm quyết định chi.** Reviewer không tìm thấy production caller của `verifyTreasuryReserveDistribution`. Kiểm tra gas, số dư và mô phỏng hiện có không chứng minh ảnh chụp nhất quán của tài sản và nghĩa vụ đang chờ. / No production caller of the 80% reserve helper was observed; existing checks do not attest balances and pending liabilities consistently.
2. **High — `COLD_MULTISIG_PRODUCTION_UNVERIFIED`.** Chứng cứ chuyển tiền không chứng minh cơ cấu phê duyệt trên ví Safe hoặc Stellar. / Transfer evidence does not attest EVM Safe owners, thresholds, modules or guards, or Stellar signer weights and payment thresholds.
3. **Coverage — Còn thiếu kiểm thử đồng thời và gián đoạn từng bước.** Reviewer đề nghị kiểm tra dispatch/reconciler cùng khóa, lỗi đã xác minh trong freeze, mất phản hồi sau gửi, khởi động lại và lỗi giữa các bước ghi sổ. Các ca này không được tính vào 51 ca đã chạy. / Requested concurrent dispatch/reconciliation, failure under freeze, response loss, restart and partial ledger cases are not part of the 51-test result.

## Sau lượt rà soát / After the review

Review D chạy độc lập `__tests__/payouts/g16-dust-lifecycle.test.ts` và `__tests__/payouts/g16-stellar-wire-precision.test.ts` trên Node 26.7.0, `TZ=Asia/Saigon`: **2 suites, 28/28 ca đạt, exit 0** (24 vòng đời, 4 XDR). Không phát hiện lỗi chặn mới trong phần bổ sung. / Independent follow-up passed **28/28 tests** on both suites; no new incremental blocker was found.

Hai luồng xử lý cùng khóa có chạy chồng nhau, nhưng không tranh ghi bút toán tất toán. Ca mất phản hồi chỉ kiểm tra lần ghi khóa, không phải lần ghi tất toán hay hoàn tiền. Máy xử lý mới có cache riêng nhưng dùng cùng SQLite và mạng mô phỏng. Kiểm thử XDR xác nhận số tiền và tài sản thật trong dữ liệu giao dịch chưa ký với đầu vào nhất quán, không xác nhận gửi giao dịch đã ký hay từ chối đầu vào mâu thuẫn. / The tests exercise genuine overlap, but not competing terminal writes; post-lock-commit response loss, but not post-finalization or post-reversal response loss; and fresh-machine recovery, but not a process restart. Real unsigned Stellar XDR is verified for consistent inputs, without establishing signed submission or mismatch rejection.

**HOLD không đổi:** chưa chứng minh kiểm soát dự trữ 80% tại điểm chi và chưa xác minh đa chữ ký trên ví production. T‑02/T‑03 không thuộc lượt rà soát này. / The two High findings still apply; T‑02/T‑03 were not reviewed here. See [report 28](../../reports/ascendancy-p2/28-MULTISIG-RESERVE-AND-DUST-EVIDENCE.md).
