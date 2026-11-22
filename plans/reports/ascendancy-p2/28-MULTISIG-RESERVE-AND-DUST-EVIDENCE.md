# G16.4 — Bằng chứng multisig, dự trữ và số dư lẻ / Multisig, reserve and dust evidence

**Trạng thái / Status:** Chưa đủ bằng chứng để đạt / Not yet verified. Báo cáo phân biệt rà soát SHA nền `262b070a0f07eeb3367415bb192ed2bf717f5867` với kiểm thử bản tích hợp cục bộ. Không dùng kết nối chain thật. / This report separates the baseline audit from integrated local tests. No live chain connections were used.

## Số dư lẻ và vòng đời tại SHA nền / Baseline dust and lifecycle

- Sổ cái giữ 8 chữ số thập phân. Quy đổi bỏ phần dư theo quantum 10 ledger units trên Stellar 7dp và 100 ledger units trên Base/Arbitrum 6dp. Dispatch khóa/chuyển phần quy đổi được; phần dư vẫn khả dụng, không được chuyển thành khoản rút mới nếu chưa qua lock mới. / The ledger uses 8dp; conversion floors to a 10-unit Stellar or 100-unit EVM quantum. Only the payable amount is locked; dust remains available and must require a new withdrawal lock before later use.
- Bằng chứng hiện có tại `__tests__/payouts/phase2-track-a-hardening.test.ts:383–601`: Arbitrum kiểm thử qua route, khóa/chi `$12.34567800` từ yêu cầu `$12.34567891`, còn `$0.00000091` và sổ cân bằng. Stellar chỉ kiểm tra quy đổi máy settlement, không phải toàn ledger; Base chưa có cùng vòng đời. `$9.99999999` bị từ chối, nhưng chưa có cặp đối chứng chính xác `$10` và `$10.00000001` trên đủ ba chain. / Existing coverage includes one Arbitrum route-to-ledger dust case, a Stellar machine-only conversion case, and a below-minimum rejection; Base and complete three-chain boundaries are not covered.
- G3 kiểm tra conversion, safety integer, reversal và ledger fuzz (`src/__tests__/sandbox/g3-ledger-invariants.test.ts:56–190,265`); G7 kiểm tra adapter scaling/minimum (`src/__tests__/sandbox/g7-settlement-simulation.test.ts:482–565`). Chưa có bằng chứng nhiều lần rút và credit trên cùng balance bảo toàn đúng từng đơn vị qua pending, retry, recovery, evidenced revert và passive reconciliation. / Existing G3/G7 coverage does not establish exact dust conservation across repeated withdrawals, additional credits, pending/retry/recovery and evidenced reversal.
- Reconciler hiện giữ `passiveOnly: true`; khi migration schema thiếu, vừa sửa để phát lỗi rõ thay vì báo lượt rỗng thành công. Điều này không thay thế kiểm thử vòng đời dust hoặc no-double-send. / Passive reconciliation remains read-only for new effects; explicit schema failure is not lifecycle proof.

### Khoảng trống và test tối thiểu / Gaps and minimal tests

Cần một bộ kiểm thử in-memory SQLite, mock chain/signing transports, dùng route/machine/ledger thật theo mẫu Track A để kiểm chứng:

1. Trên Stellar/Base/Arbitrum, biên `$9.99999999`, `$10.00000000`, `$10.00000001`; phần dư chính xác `0/1/9` đơn vị ledger trên Stellar và `0/1/99` trên EVM, kể cả điểm tăng đúng một chain unit. Dưới minimum phải bị từ chối trước lock/sign/send. / Test minimum and exact chain-quantum boundaries.
2. Nhiều lần rút cùng tài khoản, rồi thêm credit đủ để dust vượt đúng một chain quantum; chỉ một lock mới được phép chi phần đó. Tổng ledger available + locked + settled phải bảo toàn chính xác. / Prove accumulation becomes spendable only through a new lock.
3. Pending/timeout rồi cùng payout retry/recovery; không ký/gửi/ghi sổ hai lần. Với revert chỉ dùng receipt thất bại được chain xác minh hoặc Stellar failure evidence; missing receipt/timeout không phải bằng chứng hoàn. Kiểm tra `INFLIGHT → VOIDED`, hoàn đúng lock một lần, retry không double-refund. / Preserve liabilities through uncertainty and refund only on verified failure.
4. Sau freeze, passive reconciliation ghi nhận chain truth mà không phát sinh signing/submission; exact dust invariants giữ nguyên. / Observe chain truth without authorizing new effects.

## Kiểm thử vòng đời vừa tích hợp / Newly integrated lifecycle checks

`__tests__/payouts/g16-dust-lifecycle.test.ts` đã tích hợp dưới dạng thay đổi chỉ thêm kiểm thử. Chạy tại worktree chính, Node 26.7.0: `TZ=Asia/Saigon npm test -- --runInBand --no-cache --no-coverage --runTestsByPath __tests__/payouts/g16-dust-lifecycle.test.ts` → **1 suite, 12 ca đạt, exit 0**. [Log thực thi](./g16-dust-lifecycle-integrated.txt). / The test-only patch passed all 12 cases on the integrated source using in-memory SQLite, real dispatch/ledger code and mocked signing/chain transports; network fetch is disabled and asserted unused.

Mỗi chain kiểm tra minimum và quantum, nhiều lần rút cùng tài khoản, thêm credit để phần dư đạt quantum mới, pending/replay, passive confirmation và hoàn một lần khi có chứng cứ giao dịch thất bại. Khi ledger freeze đang bật, chain truth vẫn được ghi nhận nhưng lock giữ nguyên cho đến khi fixture gỡ freeze; không phát sinh lần ký/gửi thêm. / Each chain covers boundaries, repeated withdrawals and credit, pending replay, passive confirmation, and one-time verified-failure reversal. Freeze preserves the lock while recording chain status, then allows accounting recovery after fixture thaw; no additional signing or submission is permitted by these assertions.

Đây là bằng chứng sau tích hợp, không phải 12 ca đỏ trước sửa hoặc chứng thực chain thật. Review D độc lập chạy đạt 51 ca trong sáu suites, gồm 12 ca vòng đời mới. Reviewer chưa đóng G16.4: mock Stellar không giải mã XDR từ builder thật, và concurrency/partial-failure còn thiếu. Kiểm thử wire offline đã bổ sung sau lượt Review D; bản cuối sau T‑02/T‑03 phải chạy lại. / Independent Review D reproduced 51 tests across six suites, including the 12 lifecycle cases. It retained Stellar wire-encoding and adversarial concurrency/failure coverage limits; no production attestation is implied. Final integration reruns remain required.

### Kiểm thử đồng thời, khởi động lại và gián đoạn / Overlap, restart and partial-failure checks

Bản mở rộng trên `__tests__/payouts/g16-dust-lifecycle.test.ts` chạy đạt **24/24 ca / passed** tại worktree chính, Node 26.7.0 ([log](./g16-dust-adversarial-integrated.txt)), gồm 12 ca bổ sung trên cả Stellar, Base và Arbitrum: reconciler xử lý cùng khóa trong lúc dispatch chờ phản hồi gửi; máy settlement mới đọc lại khóa đang chờ; thất bại đã xác minh trong lúc đóng băng chỉ hoàn đúng một lần sau mở khóa; và mất phản hồi sau khi bút toán khóa đã commit vào SQLite. Các ca này chứng minh hành vi mô phỏng trên ổ SQLite bộ nhớ, không bao phủ mất phản hồi sau bút toán tất toán cuối cùng hoặc mạng thật. / The expanded lifecycle file passed 24/24 locally in the primary worktree, adding 12 overlap, machine-restart, verified-failure-under-freeze, and post-lock-commit response-loss cases across all three chains. These remain simulated-transport tests and do not prove live networks or finalization-commit response loss.

### Mã hóa giao dịch Stellar ngoại tuyến / Offline Stellar wire encoding

`__tests__/payouts/g16-stellar-wire-precision.test.ts` — **4/4 đạt / passed**, Node 26.7.0, [log](./g16-stellar-wire-integrated.txt). Bộ dựng production tạo XDR chưa ký; SDK giải mã và kiểm tra nguồn, đích, mã USDC, issuer và lượng stroop chính xác tại bốn biên từ `$10` đến `$10.00000010`. Không có `fetch`. / The real production builder generated unsigned XDR. The decoder verified source, destination, USDC code and issuer, and exact wire stroops at four boundaries, with no fetch calls.

Kiểm thử truyền hai biểu diễn số tiền nhất quán; không chứng minh builder từ chối đầu vào mâu thuẫn, hoặc giao dịch thật có thể được gửi. Chạy chung với vòng đời dust: **2 suites, 16/16 đạt / passed** ([log](./g16-dust-wire-combined.txt)); typecheck và lint đạt. Đây là lượt lịch sử do điều phối viên chạy trước lượt kiểm chứng bổ sung. / The test supplies consistent amount representations; it does not establish mismatch rejection or successful submission. This was a controller run, not an independent Review D rerun.

### Kiểm chứng độc lập bổ sung / Independent follow-up

[Review D](../../261119-1730-g16-treasury-remediation/reports/review-D-ledger-dust-reserves.md) chạy độc lập cả hai bộ trên Node 26.7.0: **28/28 ca đạt**, gồm 24 ca vòng đời và 4 ca XDR. Không phát hiện lỗi chặn mới trong phần bổ sung. / Review D independently ran both suites: **28/28 passed**, with no new blocker in the incremental tests.

Hai luồng có chạy chồng nhau, nhưng ca kiểm thử không cho hai bút toán tất toán tranh ghi cùng lúc. Ca mất phản hồi chỉ xảy ra sau khi ghi khóa rút tiền; ca khởi động lại chỉ dựng máy xử lý mới, dùng chung DB và kết nối mô phỏng. / The overlap is real but does not exercise competing terminal commits. Response loss covers the withdrawal-lock commit only; restart covers a fresh machine with the same DB and simulated chain, not a process restart.

## Dự trữ 80% và điểm quyết định chi / 80% reserve and payout decision point

- `verifyTreasuryReserveDistribution` tại `src/lib/payouts/turnkey-signer.ts:455–503` dùng integer math, từ chối tổng bằng 0 và đầu vào âm. Tìm kiếm production caller không thấy; caller quan sát được chỉ là tests tại `src/__tests__/sandbox/g7-settlement-simulation.test.ts:727,736`. / The 80% helper uses integer math but has no observed production caller; only test callers were found.
- `TreasuryHealthService.canSettle` (`src/lib/payouts/treasury-health-service.ts:265–345`) kiểm tra gas/số dư cho batch, không thực thi tỷ lệ hot/cold hay pending-liability accounting; service balance tổng hợp dùng `number` (`:448–514`). Route treasury legacy trả 410 khi Ascendancy hoạt động (`src/app/api/admin/payouts/treasury/route.ts:35–52`). Chưa chứng minh gate dự trữ 80% tại quyết định chi, số dư authoritative hot/cold, hoặc mỗi pending obligation được trừ đúng một lần. / Existing health checks are not an authoritative reserve-distribution gate.
- Không tự nối helper vào production caller trong audit này: chưa có snapshot đồng nhất về số dư hot/cold và liabilities pending cho cả chain. Cần quyết định kiến trúc/nguồn sự thật trước; cho đến khi có, tiêu chí 80% vẫn chưa đạt. / No production gate was invented without a verified cross-chain balance/liability snapshot.

## Multisig production chưa xác minh / Production multisig not verified

- Cold transfer proof và unique claim trong code xác minh giao dịch đã xảy ra; chúng không xác minh ai kiểm soát Safe hoặc ngưỡng phê duyệt. / Payment proof does not attest signer control or threshold.
- **EVM Safe**: cần chain/block-pinned owners, threshold, enabled modules/guards và đường thực thi tương đương của Safe trên Arbitrum và Base; nhãn `2-of-3` hoặc địa chỉ cấu hình không đủ. / Require chain-specific Safe owners, threshold, modules/guards and execution-path attestation.
- **Stellar**: cần network/ledger-pinned signer addresses/weights, master weight, payment medium threshold; chứng minh signer đơn độc không đạt threshold. `stellar-service.ts:529–543` đọc được thresholds nhưng chưa thấy xác minh cold account trên ledger. / Require ledger-pinned signer weights and applicable payment threshold.
- **Verdict:** `COLD_MULTISIG_PRODUCTION_UNVERIFIED`. Không truy cập khóa hoặc hệ thống ký thật; không có mainnet query hay giao dịch. / No live keys, signing systems, RPC queries or transfers were used.

## Lỗi hoàn khóa khi trạng thái chưa rõ / Refund under uncertain state

Dispatch từng có thể xem lỗi đọc trạng thái là bản ghi vắng mặt và hoàn lock khi giao dịch chưa rõ kết quả. Bản sửa tích hợp giữ lock khi không đọc được trạng thái; kiểm thử xác nhận đối soát sau đó chỉ tất toán một lần. Xem [log tích hợp](./g16-dispatch-integrated.txt) và [rà soát độc lập](../../261119-1730-g16-treasury-remediation/reports/review-A-dispatch-disposition.md); ca này không thay thế bằng chứng toàn vòng đời số dư lẻ hoặc multisig. / The integrated dispatch repair retains the lock on an uncertain read; the regression verifies later recovery settles only once. Independent source review found no blocker. This is not full dust or multisig evidence.

## Kết luận / Conclusion

G16.4 chưa đạt. Review D đã kiểm chứng độc lập 28 ca vòng đời dust và XDR chưa ký. Chưa chứng minh hai bút toán tất toán tranh ghi cùng lúc hoặc mất phản hồi sau khi tất toán. Chưa chứng minh gate dự trữ production hoặc multisig chain-specific. Không có dữ liệu balance live nên không kết luận tỷ lệ thực tế. / Review D independently verified 28 mocked lifecycle and unsigned XDR cases. Competing terminal writes, terminal-commit response loss, production reserve enforcement and chain-specific multisig attestation remain open. No live balance data was used.
