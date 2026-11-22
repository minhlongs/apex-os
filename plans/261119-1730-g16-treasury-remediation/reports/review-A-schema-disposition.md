# Review A — Kết luận sửa schema / Schema repair disposition

**Kết quả / Result:** Không còn finding production từ missing-schema fallback trong phạm vi re-review; kiểm thử tích hợp sau sửa matcher đạt. Reviewer đã xác nhận trực tiếp hai assertions và log sau sửa, kết luận `Status: DONE` chỉ trong phạm vi schema/passive reconciliation, không phê duyệt toàn T‑01 hoặc dispatch. / No remaining production finding from missing-schema fallback within this review scope; the reviewer directly verified the final assertions and combined log and closed the schema/passive-review findings only.

## Review độc lập / Independent review

Reviewer `a6bceeadb52a66fd5` chỉ đọc mã và chạy kiểm tra cục bộ, không sửa file hoặc dùng dịch vụ thật. Đã xác minh selector không nuốt missing claims/ledger, ledger lookup failure không biến thành `null`, và hot terminal không tăng bộ đếm thành công khi lookup lỗi. Cold legacy vẫn không được resume/refund thiếu claim; passive hot recovery giữ các tùy chọn không ký/gửi mới. / The read-only reviewer verified schema-error propagation, no false hot terminal success and preserved passive recovery behavior.

Reviewer ban đầu thấy hai test thiếu claims thất bại khi chạy chung, sau đó tự chẩn đoán và rút lại suy diễn lỗi production. Native `better-sqlite3` có thể giữ `SqliteError` constructor từ môi trường Jest trước; `.rejects.toThrow` không nhận diện lỗi khác môi trường. Probe bằng public `Database.SqliteError` và foreign Error prototype tái hiện lỗi matcher, trong khi promise vẫn reject đúng. / The reviewer traced the combined-suite discrepancy to cross-realm SQLite error recognition, not swallowed production errors.

Điều phối viên đổi đúng hai assertions sang `.rejects.toMatchObject({ message: expect.stringMatching(...) })`; SQLite thật vẫn thiếu bảng và assertion vẫn yêu cầu rejection đúng thông báo. Không sửa production để làm xanh test. / Only two assertions changed; real missing-schema fixtures and required rejection remain intact.

## Kiểm chứng tích hợp / Integrated verification

```sh
TZ=Asia/Saigon npm test -- --no-cache --runInBand --no-coverage --runTestsByPath src/__tests__/sandbox/g16-treasury-regressions.test.ts src/__tests__/sandbox/settlement-reconciler.test.ts src/__tests__/sandbox/settlement-and-legacy-boundary.test.ts -t 'G16 T01|Passive Settlement|Settlement.*Legacy|legacy' --silent
```

**3 suites passed; 91 passed; 7 skipped by filter; 98 total; exit 0.** Node 26.7.0. `git diff --check`: exit 0. Log: [combined schema verification](../../reports/ascendancy-p2/g16-combined-schema-matchers.txt).

## Giới hạn / Limits

Đây là kết luận riêng cho schema của T‑01, không phải phê duyệt toàn treasury. Full suite, typecheck/lint/build trên bản tích hợp cuối, T‑02/T‑03, dust/reserve/multisig và các reviewer còn lại chưa hoàn tất. Lỗi dispatch được xử lý và rà soát trong [báo cáo riêng](./review-A-dispatch-disposition.md). / This focused disposition does not approve treasury release. Final integrated gates and the remaining mandate scope are open. The separate dispatch repair is reviewed in its own disposition.
