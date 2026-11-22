# Review B — Hàng rào an toàn / Safety fencing

**Trạng thái / Disposition: HOLD.** Bản ghi của điều phối viên từ rà soát độc lập chỉ đọc trên candidate `g16-fencing`; chưa phải phê duyệt tích hợp. / Controller record of independent read-only candidate review, not integration approval.

## High đã xác minh / Verified High

Sau khi nhà cung cấp trả lỗi chưa rõ kết quả, `payout-effect-fence.ts:170,218–224` giữ `worker_id`; nhánh kết thúc workflow (`:113–117`) không giải phóng quyền chưa rõ kết quả. Đối soát thụ động có thể chứng minh EVM revert và chuyển broadcast thành `FAILED_ABORTED` (`broadcast-recovery-machine.ts:1683–1705` trong candidate), nhưng không ghi nhận kết thúc attempt. Trigger `035_payout_effect_grants.sql:90–100` chặn hoàn khóa bất cứ khi nào `worker_id` còn tồn tại. Không có đường giải quyết attempt bằng bằng chứng cuối cùng, nên khoản khóa có thể không được hoàn dù giao dịch đã thất bại. / Ambiguous provider errors retain workflow ownership. Passive observation can establish transaction failure, but no production terminal-attempt resolution clears the refund fence; funds can remain locked indefinitely.

Reviewer tái hiện trigger bằng SQLite bộ nhớ: `FAILED_ABORTED` với worker còn giữ quyền bị từ chối hoàn; bỏ worker thủ công mới cho phép. Đây là thí nghiệm cục bộ, không phải cách khắc phục được chấp nhận. / The reviewer reproduced the trigger behavior in isolated SQLite. Manual clearing demonstrates the condition, not an approved recovery protocol.

**Sửa bắt buộc / Required correction:** Ghi nhận kết thúc attempt nguyên tử dựa trên bằng chứng cuối cùng, gắn đúng payout, attempt, nonce/sequence và giao dịch ứng viên; vô hiệu tác vụ mới nhưng giữ khả năng lưu kết quả tới muộn. Kiểm thử lỗi gửi → bằng chứng giao dịch thất bại → hoàn đúng một lần. Không dùng riêng nhãn `FAILED_ABORTED`, tuổi bản ghi hoặc timeout để mở khóa. / Require proof-bound atomic terminal resolution and an integrated uncertain-send → verified-failure → exactly-once refund regression; state labels or timeouts alone must not authorize release.

## Nhận định đã rút lại / Retracted finding

Reviewer rút lại nhận định Critical về bypass Stellar cũ trong cấu hình Ascendancy. `guardLegacyAdminPayoutMutation` chặn trước settlement (403 khi thiếu step-up, 409 `LEGACY_PAYOUT_ROUTE_DISABLED` sau step-up). Factory Stellar không dùng khóa cục bộ khi cấu hình hot wallet Turnkey; đường cũ từ chối trước gửi khi không có keypair. Điều phối viên chạy bộ legacy boundary đạt 8/8. / Source gates and signing capability do not support the initially alleged configured-production bypass. No code was changed for the retracted claim.

## Rà soát bản sửa có mục tiêu / Targeted correction review

Reviewer xác nhận lỗi High đã được xử lý ở mức mã cho giao dịch thất bại khớp quyền gửi: `recordFailedReceipt` đối chiếu payout, lock, owner, chain, signer, nonce/sequence và grant hash/effect/epoch. Một lệnh ghi kết thúc attempt; trigger cập nhật trạng thái thất bại nguyên tử. Chốt trạng thái terminal ngăn workflow mới và attempt cũ không được cấp quyền thêm. Chưa phát hiện lỗi an toàn mới trong phạm vi sửa này. / The original High is addressed in source for exact admitted failed submissions; targeted review found no new verified defect in that correction.

**Chưa đóng nghiệm thu:** Hai ca mới gọi helper có lỗi mô phỏng, chạy passive recovery thật rồi chèn journal bằng SQL trực tiếp. Chúng không gọi `ledger.revertWithdrawal`, không xác nhận lock gốc thành `VOIDED`, không kiểm postings/balance invariants; lần chèn thứ hai lỗi UNIQUE không chứng minh toàn vòng đời hoàn tiền đúng một lần. Chưa có interleave callback tới muộn hay ca bằng chứng không khớp. Reviewer đọc log đỏ hai ca và log xanh 41 ca, không tự chạy lại. / These are core grant/recovery/trigger tests, not integrated exactly-once ledger-refund proof. Actual dispatch/reconciler ledger reversal, balances, lock state, replay, mismatched evidence and late-result behavior still need focused evidence. Artifact inspection is distinct from an independent rerun.

## Kiểm tra lại bằng chứng hoàn tiền / Ledger-refund follow-up

Reviewer đọc bản vá và [log 181/187](../../reports/ascendancy-p2/g16-t02-adjacent-aligned.txt), không tự chạy lại. Sáu ca mất phản hồi gửi mới (ba chain, có và không đóng băng) đi qua route dispatch, bộ đối soát và ledger thật trong fixture; kiểm tra khóa `VOIDED`, cân bằng sổ cái, một bút toán hoàn, chạy lại không ký/gửi thêm. Điều này bổ sung bằng chứng vòng đời cho lỗi giữ quyền worker, không chứng minh kết quả từ nhà cung cấp thật là chung cuộc. / The six new simulated-rail cases supply the missing integrated ledger reversal, exact accounting, and replay evidence for the original retained-worker defect. The reviewer inspected the artifact rather than independently rerunning it.

Ba ca ngoài T‑03 còn đỏ: lỗi kết nối HSM xảy ra sau admission (không chứng minh chưa ký), và hai fixture kỳ vọng hoàn chỉ từ hết hạn cộng với Horizon không tìm thấy. Một ca trong số đó chưa đi tới phần kiểm chống ký lại sau khi khóa đã giải quyết. `SIGNING` có kết quả chưa rõ không được bộ đối soát tự động giải quyết. Điều phối viên còn xác nhận receipt EVM khớp hash và số block chưa đủ chứng minh finality; đang sửa trước khi tích hợp. / Three non-cap tests remain red. Ambiguous `SIGNING` is not automatically resolved. Controller source inspection also found that the EVM failed-receipt adapter path does not prove canonical finality. HOLD remains in force.

## Giới hạn còn mở / Remaining limits

- D1 cấp quyền và yêu cầu tới nhà cung cấp không nguyên tử; yêu cầu đã được cấp quyền vẫn có thể bắt đầu sau khi dừng. Tiêu chí tuyệt đối của mandate chưa đạt. / Admission closure is not an absolute no-new-provider-call guarantee.
- Kiểm thử lân cận đang được chỉnh fixture migration; chưa chứng minh bản tích hợp đạt. / Adjacent migration fixtures and integrated verification remain incomplete.
- `COLD_SUBMIT` chưa có caller production quan sát được; tạo đề xuất cold trong D1 không chứng minh thao tác multisig bên ngoài. / A declared effect kind is not evidence that external multisig submission is controlled here.

Implementer đã nhận yêu cầu sửa; chưa có kết quả sau sửa. / Correction requested; post-fix verification is pending.
