---
title: "Phase 4: Exposure Cap, Dust, and Reserve Audits"
status: todo
---

# Phase 4: Exposure Cap, Dust, and Reserve Audits

## Overview

Close aging and historical exposure-count ambiguity while retaining the existing global cross-chain and cross-signer admission policy; audit precision dust and treasury reserve deductions without changing thresholds or chains.

## Verified Context and Data Flow

`getRolling24hHotVolumeUnits1e8` counts `SIGNING`, `BROADCAST_PENDING`, and `CONFIRMED` rows only while `created_at >= now - 24h` (`src/lib/payouts/turnkey-signer.ts:667-694`). Conditional UPDATE and INSERT signing claims repeat the same rolling predicate (`turnkey-signer.ts:803-889`). The baseline notes old pending rows age out and ambiguous cold/hot historical confirmed rows require conservative treatment (report 24, lines 27-29). The claim is global in D1, not chain/signer-specific. Settlement converts ledger units to chain precision and calculates residual dust (`src/lib/payouts/broadcast-recovery-machine.ts:915-930`). Existing treasury health checks have chain reserve and balance logic (`src/lib/payouts/treasury-health-service.ts:256-333`, `:448-514`).

## Requirements and Design

- Keep the existing global hot-wallet cap threshold and all currently counted states, but count all unresolved/in-flight hot exposure regardless of age. No pending transaction can vanish from exposure solely due to `created_at`.
- Additive durable admission accounting must cover outstanding hot exposure plus confirmed hot settlements for the established policy window; distinguish a verified confirmation timestamp from creation time if and only if schema and fixtures prove it. For pre-migration confirmed rows without provable signing lane/time, count conservatively; never reduce exposure by assuming they were cold or expired.
- Preserve D1-atomic admission claims. Ensure simultaneous writers cannot exceed global outstanding-plus-confirmed budget. Fail closed on invalid/missing timestamps, states or schema.
- Preserve $250 per transaction and $1,500/24h policy values, global scope, and existing use of `SIGNING` claim before nonce/sequence reservation and Turnkey (`broadcast-recovery-machine.ts:953-956`; `turnkey-signer.ts:755-762`).
- Audit chain dust accounting at Stellar 7dp and EVM 6dp, payout minimum and residual handling. No dust is silently spent, erased, or promoted into a later withdrawal without an explicit existing ledger invariant and test.
- Audit native gas and USDC balance reserve checks for each enabled chain; ensure reserve is subtracted exactly once and failures stop new transfers. Avoid changing the existing thresholds or adding unrelated reserve controls.

## Exposure design handoff / Bàn giao thiết kế hạn mức

- Dùng một điều kiện tính hạn mức chung cho phép đọc và cả hai lệnh giữ chỗ nguyên tử. Mọi `SIGNING` và `BROADCAST_PENDING` đều tính bất kể tuổi; giữ nguyên trần toàn hệ thống và trần mỗi giao dịch. / Use one accounting predicate for reads and both atomic claim writes; unresolved exposure never ages out.
- Ghi loại xác nhận và thời điểm hệ thống ghi nhận bằng chứng ngay trong lệnh chuyển sang `CONFIRMED`. Đây không phải thời gian block; dùng thời điểm ghi nhận để tránh cho giao dịch xác nhận muộn hết hạn mức sớm. Không đổi mốc khi replay; không điền lịch sử bằng `created_at`, `updated_at` hoặc hash đề xuất cold. Chỉ loại khỏi hạn mức các xác nhận cold đã có bằng chứng; giữ bản ghi mơ hồ, thiếu mốc, sai mốc hoặc mốc tương lai. / Store verification observation time and lane atomically with confirmation, never synthesize legacy metadata or refresh it on replay. Only proven cold confirmations are excluded; ambiguous rows remain included.
- Kiểm tra lượng tiền là số nguyên dương trong SQLite, chuyển tổng dưới dạng chuỗi nguyên tới `bigint`; chỉ tổng rỗng hợp lệ mới là 0. Thiếu schema hoặc kết quả, dữ liệu sai và phép cộng tràn phải từ chối. Chỉ cấp quyền khi lệnh claim xác nhận sửa đúng một hàng; không suy quyền từ bản ghi `SIGNING` đọc lại. / Validate exact integer accounting and claim ownership from the write result; fail closed on invalid or missing data.
- Phạm vi kiểm thử: đúng trần và quá một đơn vị, biên 24 giờ tính cả thời điểm đúng biên, replay không đổi mốc, pending và dữ liệu cũ vẫn được tính, một lệnh thắng khi hai chain tranh cùng phần hạn mức qua hai nhánh ghi. / Cover exact limits, inclusive 24-hour boundary, replay stability, legacy accounting, and competition across chains and both write branches.
- Không dùng riêng nhãn `FAILED_ABORTED` hoặc `EXPIRED_RECOVERED` làm bằng chứng giải phóng hạn mức: có nhánh `FAILED_ABORTED` xuất phát từ `SIGNING` cũ chứ không từ chứng cứ chain. Phân loại riêng khoản chưa từng có khả năng gửi, khoản đã thất bại/hết hạn có bằng chứng, và khoản chưa đủ chứng cứ. Không đánh dấu hàng lịch sử bằng suy đoán; kiểm tra quyền nhận lại slot cho đúng một payout và không cộng trùng khi thay thế một nghĩa vụ. / Terminal labels alone are not release evidence. Distinguish provable pre-submission aborts, verified terminal outcomes, and unresolved evidence; do not infer historical release or double-count a replacement.
- Chưa sửa signer/machine cho T‑03: T‑02 đang giữ hai tệp trong worktree riêng. / T‑03 implementation waits for the T‑02 shared-file handoff.

## Files and Ownership

- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/turnkey-signer.ts`: global sum, conditional claim and confirmation timestamp/lane semantics.
- One additive migration in `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/database/migrations/`: only new columns/indexes/tables required by verified design; no edits to migration 028.
- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/broadcast-recovery-machine.ts`: persist verified timestamps/dust only if current code lacks required canonical record; phase 2/3 edits already complete, no parallel edits.
- `/Users/macbook/apex-os-worktrees/phase2-ascendancy/src/lib/payouts/treasury-health-service.ts`: bounded audit/fix if demonstrated; do not widen scope.
- Focused existing payout tests after test agent handoff.

## Implementation Steps

1. Inventory every `settlement_broadcasts` transition and field writer; prove which states are hot, cold, unresolved, confirmed, expired or aborted, and whether `created_at` is reset.
2. Define the aggregate policy as global outstanding hot exposure plus confirmed hot volume in the existing 24-hour window; outstanding rows count until terminal verified resolution irrespective of age. Establish how confirmed state and time are durably proved, including original-row ambiguity.
3. Implement an additive schema and conditional SQLite/D1 write predicate that serializes budget admission across isolates. Preserve legacy rows and conservatively account for them without an unsafe backfill guess.
4. Make all read-only policy views use the same aggregate semantics as the atomic claim. Ensure existing terminal transition handles release only with evidence and correct state.
5. Trace decimal conversion, residual dust persistence/ledger reconciliation, min floor, EVM/Stellar reserve reads and adapter simulations. Change only demonstrated undercount/double-count or missing audit behavior within G16.
6. Add time-controlled tests at old pending/confirmed boundaries, unknown timestamps, resets, chain/signer aggregation, concurrent cap races, legacy rows, dust unit boundaries, and reserve exact/under/over limits.
7. Run isolated migration and fixture verification; never execute remote or production D1.

## Data Flow

Durable broadcast rows + safe timestamp/lane evidence → global outstanding plus confirmed-window exposure sum → one conditional D1 admission write before nonce/sequence/sign → verified terminal transitions/timestamps update accounting → settlement conversion yields chain units plus explicit residual dust → reserve/balance gates verify spendable chain funds → dispatch only if all predicates pass. Unknown legacy facts are counted conservatively, not guessed away.

## Test Matrix

Unit: caps at exact limit and one unit over; confirmed timestamp boundaries; stale unresolved row; states transitioned/retried; malformed and null timestamps; mixed chain/signer; dust conversion for EVM and Stellar; integer overflow/decimal safety. Integration: two concurrent D1 claim writers at remaining capacity; legacy rows after migration; safe confirmed-at updates; reopen after verified failure; native gas/USDC reserve thresholds; verify no change to constants. End-to-end: dispatch uses converted chain amount and account reserve guard, with ledger dust/remaining balance observable and repeat-safe.

## Success Criteria

- Old unresolved exposure remains included regardless of age; policy window applies only to confirmed exposure with verified settlement time.
- Aggregate cap remains global and concurrency-safe; thresholds unchanged; unclear old confirmed rows cannot increase headroom.
- Dust and reserves have exact integer/decimal assertions and auditable resulting states.
- New migration applies only in isolated SQLite fixtures and remains additive/backward-compatible.

## Risk, Rollback, and Dependencies

High likelihood/impact: historical confirmed lane/time is not reconstructable, and a backfill can falsely create budget. Mitigate by conservatively counting all ambiguous confirmed rows until manually reviewed; do not mint invented timestamps. High: migration assumptions differ from production D1. Mitigate with empty/current/schema fixture tests and existing migration conventions; never apply remotely in G16 execution. Rollback application code only; leave additive columns/indexes and conservative exposure data intact. Block on phases 2 and 3.

## Next Steps

Phase 5 starts only after cap and reserve tests pass locally and no policy threshold/scope has changed.
