# G16.3 — Hạn mức ví nóng 24 giờ / Rolling 24-hour hot-wallet cap

**Trạng thái / Status: HOLD.** Candidate T‑03 và migration `036_durable_hot_exposure.sql` đã được kiểm tra cục bộ; chưa nghiệm thu. Review C xác nhận đã sửa lỗi chặn quota đối soát, nhưng vòng đời xác nhận hot cuối cùng và giải phóng theo chứng cứ chain chưa hoàn chỉnh. / The local candidate fixes reconciliation quota starvation, but finalized hot-confirmation and chain-proven terminal-release lifecycles remain incomplete. Xem [checkpoint Review C](../../261119-1730-g16-treasury-remediation/reports/review-C-exposure-adversarial-checkpoint.md).

## Checkpoint kiểm thử 2026-11-20 / Test checkpoint

- Hai suite đã sửa đạt **117/117**. Fixture khóa cũ vẫn tạo dữ liệu trên schema 028 + 032, sau đó áp dụng 033–036 trước khi chạy mã hiện tại và kiểm tra cả lane/timestamp lẫn khóa ngoại. / The historical lock still originates on 028 + 032; the fixture now migrates through 036 before invoking the current finalizer and checks both observation metadata and the claim foreign key.
- Trong lượt lỗi, cả hai số được lưu dưới dạng SQLite `INTEGER`; phép tính trực tiếp và phép đọc qua adapter đều ném `SQLITE_ERROR: integer overflow`. Matcher cũ báo nhầm đối với lỗi native; matcher mới kiểm tra mã và thông điệp trên cả phép đọc lẫn ghi giữ chỗ, đồng thời xác nhận lỗi thiếu schema. Không sửa SQL hay chính sách. / The failing run demonstrated a native SQLite rejection, not an accounting failure. Strict structural matchers now verify both overflow paths and the missing-schema error without changing production behavior.
- Lượt bảy suite mới nhất: **5 suite đạt, 2 lỗi; 204 ca đạt, 14 lỗi**. Còn 12 ca dust và hai ca reconciler liên quan đến hoàn tiền. Mock Stellar chỉ trả trạng thái và có thể có số ledger; mock EVM cung cấp receipt, kiểm tra được finality nhưng chưa có đường lưu bằng chứng để giải phóng. Không dùng các kết quả này để cho phép hoàn tiền theo nhãn trạng thái. / The remaining failures concern refunds. Do not treat a terminal status as release evidence. HOLD remains in force; local D1 runtime, finalized hot promotion and durable terminal release remain unverified or incomplete.

## Checkpoint tích hợp 2026-11-19 / Prior integrated checkpoint

- Controller chạy bảy suite trên Node 26.7.0: **4 suite lỗi, 3 đạt; 16 ca lỗi, 202 đạt; exit 1**. [Log](./g16-t03-controller-focused.txt). Một lỗi fixture thiếu migration 036, 12 lỗi vòng đời dust khi hoàn tiền, hai lỗi đối soát/hoàn tiền, một lỗi kỳ vọng tràn số. / The integrated focused run is red; no acceptance is inferred.
- Ca tràn số đạt khi chạy riêng (**1 đạt, 30 bỏ qua**) và khi chạy toàn bộ suite hạn mức (**31/31 đạt**). Nguyên nhân khác biệt lượt gộp chưa xác định; không ghi đè kết quả đỏ. / Overflow passed isolated and in the standalone exposure suite; combined-run discrepancy remains unresolved. [Isolated log](./g16-t03-overflow-isolated.txt), [suite log](./g16-t03-exposure-controller.txt).
- Agent báo cáo hai suite trọng tâm 76/76, typecheck và diff whitespace đạt trước lượt controller. Đây không phải bộ điều kiện nghiệm thu cuối. / Agent checkpoint results are not final gates.
- Migration chỉ được thử trên SQLite fixture, chưa trên D1 runtime. / Migration has SQLite fixture evidence only.
- Tất cả hot confirmation writers hiện ghi `UNVERIFIED_HOT`; chưa có promotion dựa trên finality nên khoản thành công có thể chiếm hạn mức vô thời hạn. Predicate giải phóng chỉ nhận `PRE_SUBMISSION_ABORT`. EVM receipt thất bại có gọi `readFinalizedReceipt(..., '0x0')`; phần thiếu là lưu bằng chứng giải phóng bền vững, không phải hoàn toàn thiếu kiểm tra finality. / Conservative containment is not full rolling-window or terminal-release acceptance.
- Giữ HOLD, không final gates/commit/push/live effects. / No final gates or outward effects are authorized by this checkpoint.

Các phần dưới ghi bằng chứng trước sửa, không phải trạng thái candidate cuối. / Sections below retain pre-fix evidence, not final candidate disposition.

## Bằng chứng hiện tại / Current evidence

Hạn mức hiện tại là **250 USD mỗi giao dịch** và **1.500 USD cho toàn hệ thống**. Phép đọc và hai nhánh ghi giữ chỗ lọc theo `created_at` cả với giao dịch chưa có kết quả. Do đó tuổi của bản ghi có thể làm giảm exposure dù nghĩa vụ vẫn còn. Ba ca T‑03 trong lượt Jest giữa kỳ xác nhận hành vi hiện tại không đạt yêu cầu trên phép đọc, quyết định chính sách và ghi giữ chỗ. / The current read and both reservation writes use `created_at` even for unresolved records. Three interim T‑03 checks fail across the read, policy decision, and reservation write. See [baseline report](./24-TREASURY-P0-BASELINE.md) and `src/lib/payouts/turnkey-signer.ts:672–694,803–889`.

## Bất biến phải giữ / Required invariants

1. Mọi khoản `SIGNING` hoặc `BROADCAST_PENDING` vẫn chiếm hạn mức cho đến khi có kết quả đáng tin cậy, không phụ thuộc tuổi bản ghi. / Outstanding exposure remains counted until a reliable outcome, regardless of age.
2. Với xác nhận đã kiểm chứng, tính cửa sổ từ lúc hệ thống ghi nhận bằng chứng, không dùng thời điểm tạo hoặc thời điểm sửa bản ghi. Lần đọc lại không đổi mốc. Không suy đoán đối với dữ liệu lịch sử thiếu bằng chứng. / Verified confirmations use durable observation time. Replays do not refresh it; ambiguous historical confirmations count conservatively.
3. Giữ chỗ bằng một lệnh ghi có điều kiện trên D1, tính chung mọi chain và signer. Chỉ kết quả ghi đúng một hàng mới xác nhận đã giữ chỗ. / Admission is an atomic global conditional write. Only a confirmed one-row write grants the reservation.
4. Dùng số nguyên chính xác. Thiếu schema, kết quả không rõ hoặc số không hợp lệ phải từ chối thay vì coi như hạn mức còn trống. / Invalid or missing accounting data must deny admission, not create headroom.

## Ma trận nghiệm thu / Acceptance matrix

| Ca / Case | Hành vi bắt buộc / Required behavior |
|---|---|
| CAP-01 | Chấp nhận đúng $250 khi còn hạn mức. / Exactly $250 per transaction is accepted when capacity exists. |
| CAP-02 | Từ chối ký ví nóng trên $250. / Greater than $250 is denied hot-wallet signing. |
| CAP-03 | Chỉ chấp nhận tổng đúng $1.500 nếu hạn mức còn đủ. / Exactly $1,500 aggregate is accepted only within available capacity. |
| CAP-04 | Từ chối khi vượt một đơn vị cơ sở. / One additional base unit above the limit is rejected. |
| CAP-05 | Giao dịch chờ 25 giờ vẫn chiếm hạn mức. / A 25-hour-old pending transaction still consumes capacity. |
| CAP-06 | Giao dịch 25 giờ tuổi vừa xác nhận vẫn chiếm hạn mức trong cửa sổ tương ứng. / A 25-hour-old transaction that confirms now continues consuming capacity for the appropriate rolling period. |
| CAP-07 | Chỉ giải phóng hạn mức của giao dịch thất bại cuối cùng khi an toàn. / A terminally failed transaction releases capacity only when safe. |
| CAP-08 | Các lần giữ chỗ đồng thời không thể vượt trần. / Concurrent admissions cannot exceed the cap. |
| CAP-09 | Nhiều service instances không thể vượt trần. / Multiple service instances cannot exceed the cap. |
| CAP-10 | Thiếu hoặc sai mốc xác nhận không tạo thêm hạn mức. / Missing or malformed confirmation timestamps fail closed. |
| CAP-11 | Giao dịch RBF thay thế không tính hai lần cùng nghĩa vụ. / RBF replacement does not consume duplicate capacity for the same economic operation. |
| CAP-12 | Thực hiện lại khoản thật sự hết hạn không bỏ qua trần. / Re-execution of a truly expired payout does not accidentally bypass the cap. |
| CAP-13 | Chênh lệch đồng hồ staging/production không giải phóng hạn mức sai. / Staging/production clock differences cannot result in unsafe capacity release. |
| CAP-14 | Chia theo ví hoặc mạng không vượt được chính sách đã duyệt. / Wallet/chain partitioning cannot bypass the approved treasury policy. |

Bảng này ghi yêu cầu, không ghi kết quả đạt. / This table records requirements, not passes.

## Kiểm tra nguồn trước bàn giao / Source checks before handoff

- `turnkey-signer.ts:806–855` dùng `FAILED_ABORTED` hoặc `EXPIRED_RECOVERED` để mở lại khoản giữ chỗ và có thể suy ra quyền từ lần đọc `SIGNING` sau khi kết quả ghi thiếu số hàng. Lần đọc đó không chứng minh lệnh hiện tại thắng quyền giữ chỗ. / The existing retry UPDATE accepts terminal labels alone, and a subsequent state read cannot establish ownership of the preceding write.
- `broadcast-recovery-machine.ts:1443` dùng cùng nhãn `FAILED_ABORTED` khi thu hồi phiên ký cũ, còn `:1603` và `:1779` dùng nhãn này sau khi đọc được giao dịch thất bại. Tách nguồn bằng chứng trước khi cho một hàng rời khỏi hạn mức. / Stale signing cleanup and observed chain failures share a status but do not convey equivalent terminal evidence.
- `broadcast-recovery-machine.ts:1646` dựa vào đồng hồ ứng dụng và kết quả Horizon không tìm thấy giao dịch để chuyển `EXPIRED_RECOVERED`. Không dùng riêng điều kiện đó để giải phóng hạn mức nếu chưa chứng minh ledger đã đi qua thời điểm hết hạn và không có giao dịch thành công. `arbitrum-base-usdc-adapter.ts:797–821` chỉ đọc trạng thái receipt, không tự chứng minh finality. / An application-clock expiry plus a missing Horizon result is not by itself definitive release evidence, and the ordinary EVM receipt helper does not attest finality.

Sau khi T‑02 bàn giao, cần đối chiếu lại toàn bộ nơi ghi trạng thái. Candidate có cả `FAILED_ABORTED` trước khi cấp quyền ký và `FAILED_ABORTED` sau chứng cứ thất bại; chỉ dựa vào tên trạng thái sẽ trộn hai nguồn này với dữ liệu cũ. Chỉ chứng cứ lưu bền và khớp nghĩa vụ mới cho phép giải phóng hạn mức. `SIGNING` chưa biết kết quả và giao dịch Stellar chỉ quá hạn theo đồng hồ ứng dụng vẫn phải tính. / Re-audit terminal writers after the T‑02 handoff. Count ambiguous signing and application-clock-only expiry; release only from durable evidence bound to the obligation. The isolated EVM refund branch currently lacks canonical finality, so no safe cap release is inferred from that branch yet.

## Còn thiếu / Open evidence

Chờ bàn giao signer và recovery machine sau T‑02; xem [thiết kế và ma trận kiểm thử](../../261119-1730-g16-treasury-remediation/phase-04-exposure-cap-and-reserve-audits.md). Chưa có migration T‑03, kết quả sau sửa, hoặc Review C. Không truy cập số dư hoặc hệ thống ký thật. / Await T‑02 shared-file handoff before implementation. No T‑03 migration, post-fix test results, or independent Review C yet. No live balances or signing systems were accessed.
