# G16.1 — Ràng buộc chứng cứ thanh toán cold / Cold payment proof binding

**Trạng thái / Status: Đã rà soát độc lập phần schema và bản sửa dispatch; kiểm thử Track A đã đạt sau cập nhật fixture / Independent source review complete for schema and dispatch repairs; aligned Track A tests passed.** Không phải phê duyệt phát hành hoặc chi tiền. / This is not release or spending approval.

## Thay đổi / Changes

- EVM đọc receipt thành công, đối chiếu đúng mạng và block đã finalized/canonical, rồi giải mã sự kiện `Transfer` của hợp đồng USDC cấu hình chuẩn. Nguồn tiền là trường nguồn trong sự kiện, không phải người gửi giao dịch cấp cao nhất. / EVM validates network, canonical finalized inclusion, and actual canonical USDC Transfer source, recipient, integer amount and log identity; the transaction relayer is not treated as the fund source.
- Stellar đối chiếu network passphrase, giao dịch thành công đã vào ledger và toàn bộ payment operations. Kiểm tra nguồn, đích, mã tài sản, issuer, số nguyên 7 chữ số thập phân và operation ID. Testnet yêu cầu issuer hợp lệ được cấu hình tin cậy; không suy ra issuer từ chứng cứ được nộp. / Stellar verifies the configured network and included successful payment operations, including source, destination, issuer, exact amount and operation identity. Testnet requires an explicitly trusted issuer.
- Migration cộng thêm `033_cold_settlement_claims.sql` đặt khóa duy nhất `(network, tx_hash, operation_id)` cùng ràng buộc một payout/một withdrawal lock. Claim được giữ trước khi ghi sổ; chỉ `CONFIRMED` sau khi xác minh hoàn tất ledger. / The additive migration uniquely claims each operation and withdrawal; claim persistence precedes idempotent ledger finalization and confirmed broadcast state.
- Retry giữ claim sau lỗi ghi sổ, đóng băng hoặc mất phản hồi. Không hủy claim để cho nghĩa vụ khác sử dụng. Hủy đề xuất cold không tự chứng minh tiền chưa chuyển và không tự mở khóa số dư. / Retries retain evidence ownership after partial failures. Cancelling a proposal does not prove non-execution or authorize a refund.
- Route hiện hữu và đối soát thụ động gọi quy trình này; không còn lựa chọn strictness cho phép bỏ qua chứng cứ tài chính. / Existing dispatch and passive reconciliation use the strict protocol; optional strictness cannot bypass proof.

## Kiểm chứng trên bản tích hợp / Integrated verification

Đường cơ sở và mã kiểm thử trước vá được giữ tại báo cáo 24, `g16-baseline-regressions.txt` và `g16-baseline-regression-source.txt`. Chỉ ba thất bại T-01 ban đầu là bằng chứng đỏ trực tiếp; không gán hồi tố 49 ca sau vá thành 49 ca đã thất bại trước vá. / Report 24 preserves the original baseline. The three original T-01 failures are direct red evidence; the expanded patched tests are not retroactively described as pre-fix failures.

Tất cả lệnh dưới chạy tại worktree chính với Node 26.7.0, `TZ=Asia/Saigon`, SQLite bộ nhớ và kết nối mô phỏng. / All commands ran in the integration worktree with in-memory SQLite and mock transports.

```sh
TZ=Asia/Saigon npm test -- --runInBand --no-coverage --runTestsByPath src/__tests__/sandbox/g16-treasury-regressions.test.ts -t 'G16 T01'
```

**Lượt ban đầu / Initial run: 1 suite đạt; 49 passed, 7 skipped, 56 total; exit 0.** Bảy ca ngoài bộ lọc thuộc T-02/T-03, chưa phải bằng chứng xanh cho hai lỗi đó. Log: [integrated T-01](./g16-integrated-t01.txt). / Seven filtered-out cases concern T-02/T-03 and do not establish their remediation.

**Lượt tích hợp sau sửa schema / Integrated post-schema run: 79 passed, 7 skipped, 86 total; exit 0.** Chạy cùng lệnh tại worktree chính, Node 26.7.0. Bản sửa không nuốt lỗi thiếu bảng cả khi không có candidates, và không đếm hot terminal thành công khi ledger lookup lỗi. / The same command passed in the primary worktree; missing schema now remains explicit even with zero candidates, and ledger lookup failure cannot increment hot terminal success counters.

```sh
TZ=Asia/Saigon npm test -- --runInBand --no-coverage --runTestsByPath src/__tests__/sandbox/settlement-and-legacy-boundary.test.ts src/__tests__/sandbox/g8-uncertain-broadcast-recovery.test.ts src/__tests__/sandbox/settlement-reconciler.test.ts src/__tests__/sandbox/g7-settlement-simulation.test.ts src/__tests__/sandbox/g3-ledger-invariants.test.ts src/__tests__/sandbox/ledger-reconciliation-clawback.test.ts
```

**6 suites đạt; 40 passed; exit 0.** Log: [integrated adjacent](./g16-integrated-adjacent.txt).

Agent triển khai báo typecheck, scoped lint và fixture migration 033 đạt trong worktree riêng; các kết quả đó chưa thay thế kiểm tra toàn bộ bản tích hợp. / Implementer-reported typecheck, scoped lint and migration results do not replace final integrated verification.

## Giữ khóa khi không xác định được trạng thái / Preserve the lock when settlement status is unknown

Dispatch không còn coi lỗi đọc trạng thái là bản ghi vắng mặt. Kiểm thử mới giữ nguyên ca timeout cũ và xác nhận khóa còn `INFLIGHT` khi trạng thái không đọc được; lần khôi phục sau tất toán đúng một lần, không gửi lại. Lượt tích hợp xác nhận **3 suites đạt, 92 ca đạt, 7 ca ngoài bộ lọc**. Xem [log tích hợp](./g16-dispatch-integrated.txt) và [rà soát độc lập](../../261119-1730-g16-treasury-remediation/reports/review-A-dispatch-disposition.md). / Dispatch no longer treats a status read failure as a missing record. The additive regression preserves the existing timeout case and verifies that later recovery settles once without resubmission. Independent source review found no blocker. The Track A fixture now supplies canonical payment evidence and a bound withdrawal lock; the integrated Track A and adjacent run passed all 26 cases.

## Ánh xạ kiểm thử sau sửa / Post-fix coverage map

Các tham chiếu dưới đây trỏ tới `src/__tests__/sandbox/g16-treasury-regressions.test.ts` trong bản tích hợp T‑01. Đây là bằng chứng sau sửa, không phải tất cả đều là ca đỏ trước sửa. / These are post-fix checks in the integrated T‑01 suite, not claims that each case failed on the baseline.

| Tiêu chí / Case | Bằng chứng / Evidence |
|---|---|
| COLD-01, COLD-02 | Ca receipt không có transfer, sai đích hoặc không khớp giao dịch yêu cầu (`:374–398`). / No transfer, wrong destination, or mismatched transaction. |
| COLD-03 | Hai payout không thể dùng lại cùng operation, kể cả qua hai service instances (`:477–491`, `:894–926`). / An operation is unique across payouts and service instances. |
| COLD-04–06 | Sai tài sản, số lượng hoặc nguồn bị từ chối; không tạo claim hoặc ghi sổ (`:374–398`, `:948–967`). / Wrong asset, amount or source does not create a claim or ledger entry. |
| COLD-07 | Nhiều log EVM hoặc operation Stellar cùng giao dịch được phân biệt bằng mã định danh riêng (`:466–475`, `:869–926`). / Distinct operations in one transaction are individually attributable. |
| COLD-08, COLD-09 | Sai mạng, thiếu metadata, log trùng và bằng chứng mơ hồ không xác nhận được payout (`:374–398`, `:413–425`, `:466–475`, `:948–967`). / Wrong network, incomplete or ambiguous proof is denied. |
| COLD-10 | Xác nhận lặp và khôi phục sau mất phản hồi không ghi sổ lần hai (`:493–505`, `:546–580`, `:894–926`). / Replays and lost-response retries do not double-post. |

## Còn chờ / Pending

Review A ban đầu phát hiện High nghẽn hàng đợi; follow-up độc lập đã xác minh lỗi đó đóng, cùng coverage $300, Base, Stellar distinct-operation/concurrency và fallback-proof restart. Bản sửa schema đã tích hợp; reviewer mới xác minh propagation lỗi ledger. Hai ca thiếu claims chạy chung đã được chẩn đoán là lỗi nhận diện SqliteError khác môi trường Jest, không phải reconciler nuốt lỗi. Sau sửa đúng hai matchers, 3 suites / 91 passed / 7 filtered đạt với `--no-cache`; SQLite thật và yêu cầu rejection vẫn giữ nguyên. Xem [review A ban đầu](../../261119-1730-g16-treasury-remediation/reports/review-A-cold-proof.md), [follow-up](../../261119-1730-g16-treasury-remediation/reports/review-A-cold-followup.md), [schema disposition](../../261119-1730-g16-treasury-remediation/reports/review-A-schema-disposition.md), và [combined log](./g16-combined-schema-matchers.txt). / Starvation and schema propagation are verified within focused scope; realm-safe assertions preserve real missing-schema rejection and combined checks pass. Final treasury gates remain open.

Lượt Jest toàn bộ giữa kỳ trên bản tích hợp hiện tại: 184 suite đạt, 1 suite thất bại; 3.773 ca đạt, 1 bỏ qua và 7 thất bại. Bốn ca thất bại thuộc T‑02 và ba ca thuộc T‑03 chưa được tích hợp. Đây không phải lượt kiểm chứng cuối. / The interim full Jest run passed 184 suites with one failed suite; 3,773 cases passed, one was skipped and seven failed. The seven failures are in pending T‑02 (four) and T‑03 (three). This is not final verification.

Kiểm tra migration trên bản tích hợp cuối, toàn bộ quality gates và CI đúng SHA cuối còn chờ. Chưa kiểm chứng D1/provider thật, production multisig hoặc dự trữ thật. Không có RPC thật, khóa ký thật, remote migration, triển khai hay chuyển USDC. / Final integrated migration checks, full gates and final-SHA CI remain pending. Production/provider attestations are not implied.
