# Advisory: Khắc phục 3 Live Telemetry Blocker & Reset Rehearsal 48h

> Chế độ: `/ak-advise --ultra` (Best-of-5 Verifier Mode)
> Ngày: 2026-11-02 | Timezone: Asia/Saigon | Ngôn ngữ: Tiếng Việt
> Trạng thái Production: **NO_GO** (bất biến)
> Môi trường vá lỗi duy nhất: `apex-os-staging` (commit `5fff74e84391b5d87f6e9f537896e0dee1f0fb4b`)

---

## 0. Bảng xếp hạng `--ultra` (5 ứng viên, thang 80)

| Tiêu chí (thang 20) | C1 | **C2** | C3 | C4 | C5 |
|---|---|---|---|---|---|
| Faithfulness (bám sát yêu cầu đã khóa, non-goals, Production NO-GO, bảo mật) | 17 | **18** | 17 | 15 | 16 |
| Evidence Grounding (`file:line` chính xác, công thức, `ingestOrBufferWsBook`, V1/V7) | 14 | **18** | 10 | 12 | 16 |
| Honesty of Trade-offs (edge subrequests, WS resync latency, cập nhật test, Unverified) | 14 | **19** | 17 | 14 | 15 |
| Actionability (Work Checklist, Success Metrics, Handoff Brief) | 16 | **18** | 16 | 15 | 16 |
| **TỔNG (thang 80)** | 61 | **73** | 60 | 56 | 63 |

**Thứ tự cuối cùng:** C2 (73) > C5 (63) > C1 (61) > C3 (60) > C4 (56)

**Ứng viên thắng cuộc: Candidate #2.**

Verifier (`kongming`) đã áp 2 sửa chứng cứ lên bản gốc C2 trước khi trình bày:
(a) dải `fetch()` đổi `690-750` → `1138-1156`;
(b) endpoint WS Coin-M `nbstream.binance.com/eoptions` → `fstream.binance.me`.

---

## 1. Tóm tắt điều hành (Executive Summary)

Khắc phục dứt điểm 3 điểm nghẽn kỹ thuật đang chặn buổi diễn tập thị trường thực 48 giờ trên `apex-os-staging`, đồng thời bổ sung cơ chế `reset-rehearsal` để khởi tạo lại cửa sổ diễn tập một cách sạch sẽ — trong khi giữ nguyên cổng chặn Production (`apex-os`) ở trạng thái `NO_GO`.

Ba nguyên nhân gốc rễ đã được xác minh trực tiếp từ mã nguồn và bằng chứng telemetry thực:

1. **Bybit Spot L2 rơi vào vòng lặp `FEED_DESYNC` vô tận.** Bybit v5 Spot REST `/v5/market/orderbook?category=spot` trả về `u ≈ 68.309.332` (sequence toàn cục của bộ khớp lệnh), trong khi luồng WebSocket `wss://stream.bybit.com/v5/public/spot` (`orderbook.50.{symbol}`) đánh số `u ≈ 7.652.445` (per-stream). Bybit WS **luôn** gửi một bản tin `"type": "snapshot"` đầu tiên ngay sau `op: 'subscribe'`, chứa `u` gốc của luồng WS đó. Hiện tại `startWebSocketStreams()` thêm cả 8 khóa vào `bootstrappingKeys` rồi gọi `pollAllPairs()` → `fetchBybitDepth(pair, 'spot')` nạp `u ≈ 68.3M`, `applySnapshotAndDrainBuffer` đặt `minSeq = 68.3M` và vứt bỏ toàn bộ delta WS; sau đó `worker-do.ts` gọi lại `fetchBybitDepth` mỗi lần `FEED_DESYNC`, tạo vòng lặp vĩnh viễn (`gapCount: 65` / `51` trên BTC / ETH).
2. **Binance Linear Perp (`binance:linear_perp:BTC/USDT`, `ETH/USDT`) kẹt ở `DISCONNECTED` (`lastSequenceId: 0`, `reconnectCount: 14`).** `live-collector.ts` khóa cứng một hostname duy nhất cho cả WS (`wss://fstream.binance.com/stream`) và REST (`https://fapi.binance.com/fapi/v1/*`). Khi Cloudflare Edge colo bị chặn kết nối tới dải IP `fstream*` / `fapi*`, collector chỉ reconnect vào đúng endpoint bị chặn. Ngoài ra `fetchBinancePerpDepth` dùng `Promise.all([depth, premiumIndex])` — lỗi tạm thời ở funding làm hủy toàn bộ snapshot orderbook.
3. **Seed Inventory Passive Beta gây `haltedByDrawdown = true` ngay ở 0 chu kỳ.** `strategy-engine.ts` pre-seed `$4.000` BTC/ETH cho **cả hai** chiến lược theo giá cứng năm 2024 (`SEED_INVENTORY_REFERENCE = { BTC: 68.000, ETH: 2.600 }`), rồi `standingInventoryMarkToMarketUsdt()` nhân toàn bộ `baseInventory` với giá thực 2026. Tại tích tắc đầu tiên chưa mở chu kỳ nào: `equityUsdt` vọt lên `10.296,6746` → `peakEquityUsdt` chốt ở đó; khi giá lùi nhẹ về `10.032,5720` thì `(10296,6746 - 10032,5720) / 10296,6746 = 2,5649% > 2,0%` → `haltedByDrawdown = true` vĩnh viễn cho cả hai chiến lược ở **0 chu kỳ**.

---

## 2. Bản xem trước kết quả kỳ vọng (Visual Outcome Preview)

```
+--------------------------------------------------------------------------------------------------+
| TRƯỚC KHI SỬA (HIỆN TRẠNG STAGING)                                                               |
+--------------------------------------------------------------------------------------------------+
| Stream Status (4/8 SYNCED):                                                                      |
|   binance:spot:BTC/USDT          -> SYNCED                                                        |
|   binance:spot:ETH/USDT          -> SYNCED                                                        |
|   bybit:linear_perp:BTC/USDT     -> SYNCED                                                        |
|   bybit:linear_perp:ETH/USDT     -> SYNCED                                                        |
|   bybit:spot:BTC/USDT            -> FEED_DESYNC  (gapCount: 65)                                   |
|   bybit:spot:ETH/USDT            -> FEED_DESYNC  (gapCount: 51)                                   |
|   binance:linear_perp:BTC/USDT   -> DISCONNECTED (lastSequenceId: 0)                              |
|   binance:linear_perp:ETH/USDT   -> DISCONNECTED (lastSequenceId: 0)                              |
|                                                                                                  |
| Strategy Ledgers (0 cycles opened, 0 cycles closed):                                             |
|   spot-2exch: equity = 10041,132 | peak = 10296,6746 | maxDD = 2,5649% | halted = true            |
|   spot-perp : equity = 10041,688 | peak = 10296,6746 | maxDD = 2,5649% | halted = true             |
|   windowMetrics[*].baselineProvenance = "PENDING_LIVE_VALUATION"                                  |
+--------------------------------------------------------------------------------------------------+
                                                |
                                                v
+--------------------------------------------------------------------------------------------------+
| SAU KHI SỬA + POST /api/admin/paper/overview {"action": "reset-rehearsal"}                        |
+--------------------------------------------------------------------------------------------------+
| Stream Status (8/8 SYNCED, feedAgeMs <= 1000ms):                                                  |
|   bybit:spot:*               -> SYNCED (native WS "snapshot" + "delta" u-chain)                    |
|   binance:linear_perp:*      -> SYNCED (multi-endpoint rotation / REST pump < 500ms)              |
|   (4 luồng còn lại giữ nguyên SYNCED)                                                             |
|                                                                                                  |
| Strategy Ledgers (t = 0, 0 chu kỳ đã mở):                                                         |
|   spot-perp : cash = 10000,00 (5000/venue), baseInventory = 0, equity = 10000,00, maxDD = 0%     |
|   spot-2exch: cash = 6000,00 (3000/venue), seed inventory = 4000,00 (neo theo giá thực),         |
|               Δinventory = 0, equity = 10000,00, maxDD = 0%, haltedByDrawdown = false             |
|   windowMetrics[*].baselineProvenance = "LIVE_VERIFIED"                                           |
|   continuousCoverageMs > 0 (tăng liên tục theo thời gian thực)                                    |
|   overallVerdict = "NO_GO" (cho tới khi đủ >= 30 ngày thực & >= 100 chu kỳ & PnL > 0 & DD <= 2%)  |
+--------------------------------------------------------------------------------------------------+
```

---

## 3. Verdict (Phán quyết)

**Đối với Production (`apex-os`): `NO_GO`** — không triển khai, không chạm `apex-os-db`.

**Đối với Staging remediation & rehearsal reset: `GO`** — sửa dứt điểm 3 lỗi Giai đoạn 2 + bổ sung `reset-rehearsal`.

Cả 3 điểm nghẽn đều là lỗi cơ học trong tầng thu thập dữ liệu CEX (`live-collector.ts` / `worker-do.ts`) và tầng hạch toán tồn kho khởi tạo (`strategy-engine.ts`), **không phải** do logic khớp lệnh VWAP hay cổng kiểm định kinh tế bị sai.

Quan trọng: `PAPER_FROZEN_CONFIG_HASH` (`scripts/verify-paper-economic-gate.cjs:33-47` và `src/lib/paper/strategy-engine.ts:52-63`) chỉ băm 8 tham số cấu hình chuẩn (`modelVersion: 'paper-v1.1.0'`, `initialCapitalUsdt: 10000`, `maxCycleNotionalUsdt: 500`, `maxOpenCycles: 4`, `singleLegTakerFeeRate: 0.0005`, `minEntryNetSpreadBps: 2.0`, `exitConvergenceSpreadBps: 3.0`, `maxDrawdownLimitPct: 2.0`). Do đó sửa công thức hạch toán tồn kho trong `PaperStrategyEngine` **không làm thay đổi hash** và giữ đồng bộ 100% với cổng kiểm định. (Verifier đã tự tính lại hash từ 8 trường này và thu được đúng `03aa4c7a0928d368f026962f7fcf40f643ee8e14b8db87144e527f0222ca76ad`.)

---

## 4. Needs from you (Cần xác nhận từ bạn)

Không còn câu hỏi mở nào. Toàn bộ phạm vi, mục tiêu, ràng buộc và tiêu chí nghiệm thu đã được khóa trước khi chạy `--ultra`.

---

## 5. What you should do (Những việc cần làm)

### 5.1. Khắc phục Điểm nghẽn 1 — Bybit Spot L2 qua khung `"type": "snapshot"` gốc của WebSocket

**Giải pháp:**

1. Trong `ingestOrBufferWsBook(book)` (`live-collector.ts:330-342`): nếu `book.isDelta === false` (khung `"type": "snapshot"` gốc do chính Bybit WS phát), **không đẩy vào `deltaBuffer`** mà gọi trực tiếp `this.applySnapshotAndDrainBuffer(key, book)` để lấy đúng `u` của WS snapshot làm mốc (`lastSequenceId = book.sequenceId`), xả các delta WS có `sequenceId > book.sequenceId`, và xóa `key` khỏi `this.bootstrappingKeys`. (Đây là điểm chặn thực sự — phải xử lý **trước** khi kiểm tra `bootstrappingKeys`.)
2. Trong `startWebSocketStreams()` (`269-295`) và `bootstrapSnapshots()`: khi WebSocket đang bật, chỉ gọi REST snapshot bootstrap cho các luồng **Binance** (vốn cần cầu nối REST `lastUpdateId` với WS `[U, u]`) hoặc các luồng Bybit chưa có WS mở. Không gọi `fetchBybitDepth(pair, 'spot')` đè lên luồng Bybit Spot WS đang hoạt động.
3. Thêm `resyncBybitWsStream(pair, marketType): Promise<void>`: gửi `{"op":"unsubscribe","args":["orderbook.50." + symbol]}` rồi `{"op":"subscribe","args":["orderbook.50." + symbol]}` trên socket đang mở (hoặc đóng/mở lại nếu socket không ở `READY_STATE_OPEN`) để Bybit WS gửi lại khung `"type": "snapshot"` mới cùng không gian `u`.
4. Trong `scheduleReconnect` (`live-collector.ts:633-671`): với `exchange === 'bybit'`, khi kết nối lại chỉ cần chờ khung `"type": "snapshot"` đầu tiên của chính WS đó, không gọi `fetchBybitDepth`.
5. Trong `worker-do.ts:294-309` (`startLiveCollector` / `onBook`): khi `res.streamState.status === 'FEED_DESYNC'` và `book.exchange === 'bybit' && book.marketType === 'spot'`, gọi `await this.collector.resyncBybitWsStream(book.pair, 'spot')` thay vì `fetchBybitDepth` — kèm **cooldown 2000ms mỗi stream key** để tránh bão unsubscribe/subscribe khi nhiều delta cũ đang nằm trên đường truyền.

### 5.2. Khắc phục Điểm nghẽn 2 — Khôi phục `binance:linear_perp` từ Cloudflare Edge

1. **Xoay vòng đa điểm cuối (cho phép ghi đè qua `CollectorConfig`):**
   - WS: `wss://fstream.binance.com/stream`, `wss://fstream.binance.me/stream`, `wss://fstream1.binance.com/stream`, `wss://fstream2.binance.com/stream`, `wss://fstream-auth.binance.com/stream`
   - REST base: `https://fapi.binance.com`, `https://fapi.binance.me`, `https://fapi1.binance.com`, `https://fapi2.binance.com`, `https://www.binance.com` (qua `/fapi/v1/depth` và `/fapi/v1/premiumIndex` — đi qua CDN toàn cầu nên vượt qua được nhiều rào chặn IP nơi `fapi.binance.com` trực tiếp bị chặn)
2. **Tách biệt `depth` và `premiumIndex` + cache funding** (TTL 5–10 giây theo từng cặp) để lỗi funding không bao giờ làm hỏng luồng orderbook — vẫn trả sổ lệnh hợp lệ kèm thông tin funding gần nhất.
3. **High-Frequency REST Snapshot Fallback Pump:** nếu toàn bộ WS endpoint `fstream.*` thất bại bắt tay tại PoP hiện tại, tự động kích hoạt vòng lặp snapshot L2 (`isDelta: false`) mỗi **400–500ms** từ endpoint REST hoạt động tốt nhất, đồng thời vẫn thử kết nối lại WS ở nền. Nhờ `worker-do.ts:291-293` (`if (book.isDelta === false) await this.resyncStream(book, book.receivedTs)`) và `orderbook-sequencer.ts:293-296` (`isRepeatedValidSnapshot` chấp nhận `sequenceId === existing.lastSequenceId` với `isDelta === false`, làm mới `lastReceivedTs` / `feedAgeMs`), cả hai luồng duy trì **`SYNCED` liên tục với `feedAgeMs <= 500ms`**.

### 5.3. Khắc phục Điểm nghẽn 3 — Hạch toán vốn khởi tạo & Drawdown trung hòa tồn kho

1. **`spot-perp` — 100% USDT tại `t = 0`:** mỗi sàn `freeCollateralUsdt = 5000`, `baseInventory = {BTC: 0, ETH: 0}`, `baseInventoryCostBasisUsdt = 0`, `initialInventoryCostBasisUsdt = 0`. Lý do: chiến lược luôn mua Spot (Leg A) đồng thời bán khống Perp (Leg B) khi mở chu kỳ (`evaluateSpotPerpPair`, `strategy-engine.ts:568-660`) và bán lại đúng lượng Spot đó khi đóng (`closeOpenCycle`, `878-921`) — **không bao giờ bán Spot trước khi mua**, nên không cần giữ BTC/ETH tại `t = 0`.
2. **`spot-2exch` — giữ tồn kho vận hành, định giá theo độ lệch ròng:** cần sẵn BTC/ETH trên cả 2 sàn để chân bán thực thi được (ràng buộc no-borrow). Lưu `seedBaseInventory: Record<PaperExchange, Record<PaperPair, number>>` và `seedAllocatedPerPairUsdt` (`1.000 USDT` mỗi cặp mỗi sàn, tổng `initialInventoryCostBasisUsdt = 4.000`). **Neo lại theo giá thực đầu tiên** (`reanchorSeedInventoryToLivePrice(pair, liveMidPrice)`) khi `currentBaseInventory === seedBaseInventory` và chưa có chu kỳ nào từng mở, để `seedBaseInventory[ex][pair] = 1000 / liveMidPrice` khớp mệnh giá `$1.000` ở giá năm 2026.
3. **Công thức định giá tồn kho trung hòa** cho `standingInventoryMarkToMarketUsdt()` (`strategy-engine.ts:265-286`):
   - Lượng tồn kho ròng quy về trước khi mở các chu kỳ đang mở:
     `effectiveStandingQty(ex, pair) = venue.baseInventory[pair] − Σ[c ∈ openCycles(pair, legA=ex)] c.quantityBase + Σ[c ∈ openCycles(pair, legB=ex, spot)] c.quantityBase`
   - Độ lệch so với tồn kho gốc: `ΔstandingQty(ex, pair) = effectiveStandingQty(ex, pair) − seedQty(ex, pair)`
   - Giá trị định giá: `standingInventoryMarkUsdt = Σ(ex, pair) [ seedCostBasisUsdt[ex][pair] + ΔstandingQty(ex, pair) × markPrice(pair) ]`
   - **Kiểm nghiệm 4 trạng thái:**
     - **①** 0 chu kỳ mở và 0 đóng → `Δ = 0` → value `= 4.000` → `equityUsdt = 6.000 + 4.000 + 0 = 10.000,00`, `peakEquityUsdt = 10.000`, `maxDrawdownPct = 0`, `haltedByDrawdown = false` **bất kể BTC là $34.000, $68.000 hay $100.000**.
     - **②** Đang mở 1 chu kỳ (mua `q` ở A, bán `q` ở B) → `effectiveStandingQty` vẫn bằng `seedQty` ở cả hai sàn; toàn bộ MTM vào qua `+ lastUnrealizedPnlUsdt`.
     - **③** Đóng chu kỳ → tồn kho quay về đúng `seedQty`, tiền mặt tăng đúng `netPnlUsdt`, `equityUsdt = 10.000 + realizedNetPnlUsdt`.
     - **④** Nếu có `ΔstandingQty ≠ 0` thực sự → nhân `markPrice` phản ánh đúng rủi ro tồn kho ròng.
4. **Bảo toàn tương thích ngược cho `restoreState` / `PaperReplayEngine`:** thêm trường **tùy chọn** `seedBaseInventory?` vào `PaperSerializedStrategyState` (`src/lib/paper/types.ts:224`). Nếu artifact cũ không có, khôi phục mặc định từ `venueBalances` hoặc hằng số khởi tạo → mọi test `N2 Rigorous` / `replayCycleFromArtifact` đạt `matched: true` 100%.

### 5.4. Bổ sung hành động `reset-rehearsal`

Trạng thái `haltedByDrawdown: true`, `maxDrawdownPct: 2,5649%`, `peakEquityUsdt: 10296,6746` cùng rạn `paper_trading_runs` lỗi (`verdict = 'NO_GO'`) đã bền vững trong DO storage (`strategy_state_*`, `window_baseline_*`, `sequencer_state`) và bảng D1. Nếu chỉ deploy rồi gọi `start-collector`, `ensureRestored()` sẽ nạp lại `haltedByDrawdown: true`.

1. Trong `src/lib/paper/worker-do.ts`: thêm `async resetRehearsal(nowTs = Date.now())` và nhánh `if (url.pathname === '/reset-rehearsal' && request.method === 'POST')` trong `fetch(request)` (`worker-do.ts:1138-1156`):
   - Re-instantiate hai `PaperStrategyEngine` mới cho `'spot-2exch'` và `'spot-perp'` với vốn sạch `10.000 USDT`, `haltedByDrawdown = false`, `maxDrawdownPct = 0`, `peakEquityUsdt = 10.000`.
   - Đặt lại `this.sequencer = new OrderbookSequencer()`, xóa khóa tạm (`active_cycle_ticks_ledger`, `session_ticks`), `continuous_coverage_ms = 0`, `gap_started_at_ms = null`, `last_live_confirmed_ts_ms = null`, `run_started_at_ms = nowTs`.
   - Thiết lập `window_baseline_spot-2exch` / `window_baseline_spot-perp` sạch tại `nowTs` với `baselineProvenance: 'PENDING_LIVE_VALUATION'` (tự động chuyển sang `'LIVE_VERIFIED'` khi 8/8 luồng `SYNCED` theo cơ chế sẵn có tại `worker-do.ts:465-516` / `resetContinuousWindow`).
   - Lưu trạng thái vào DO storage; gọi `deactivatePriorRuns` + `syncPaperRun` + `saveStrategySnapshot` trên `this.env?.DB` để vô hiệu hóa run cũ và ghi nhận run mới sạch.
   - Khởi động lại `startLiveCollector()` để thu thập lại cả 8 luồng.
2. Trong `src/app/api/admin/paper/overview/route.ts` (`198-215`): mở rộng kiểu `action` thành `'start-collector' | 'stop-collector' | 'reset-rehearsal'`; khi `'reset-rehearsal'` thì `doStub.fetch('http://internal/reset-rehearsal', { method: 'POST' })`.

### 5.5. Cập nhật và bổ sung bộ kiểm thử hồi quy

**2 điểm kiểm tra hiện hữu khóa hành vi cũ (chính là nguyên nhân Điểm nghẽn 3), bắt buộc phải cập nhật:**

1. `src/lib/paper/__tests__/paper-engine-and-replay.test.ts:1171` — `V1` ("values standing base inventory at live orderbook prices and halts strategy when 50% market drop triggers >=2% drawdown even with 0 open cycles"). Cập nhật thành: **(a)** khi 0 chu kỳ mở (`Δinventory = 0`), biến động giá dù lên `$75.000` hay giảm 50% xuống `$34.000` **không** làm thay đổi `equityUsdt` (`10.000`) và **không** gây `haltedByDrawdown`; **(b)** khi có chu kỳ mở hoặc `Δinventory ≠ 0` làm giảm `equityUsdt >= 2,0%` so với `peakEquityUsdt`, `updateMarkToMarketDrawdown` **phải** tính đúng drawdown và kích hoạt `haltedByDrawdown = true` — đây là bài test chốt an toàn, cập nhật không được làm mất điều kiện này.
2. `paper-engine-and-replay.test.ts:1614` — `V7` hiện có `expect(binanceInitBtc).toBeGreaterThan(0);` (dòng `1613`: `const binanceInitBtc = initVenue?.binance.baseInventory['BTC/USDT'] ?? 0;`). Với `spot-perp` 100% USDT thì đổi thành `expect(binanceInitBtc).toBe(0);` và `expect(initVenue?.binance.freeCollateralUsdt).toBe(5000);`. **Phần còn lại của `V7` (dòng 1645: `const expectedBtc = binanceInitBtc + (500 / 68005)`) vẫn hoạt động hoàn hảo.**
3. Kiểm tra thêm 2 điểm để chắc chắn không vỡ: dòng `175` (`venueCash + inventoryCost === 10000` vẫn **đúng tuyệt đối** cho cả hai chiến lược: `spot-2exch` = `6000 + 4000`, `spot-perp` = `10000 + 0`) và dòng `829` (`P23-01 & P23-02`: tại tick 0 `cashBalanceUsdt === 6000`, `inventoryValueUsdt === 4000`, `equityUsdt === 10000`, `unrealizedPnlUsdt === 0`).

**4 bài kiểm thử hồi quy mới (đỏ trước khi sửa, xanh sau khi sửa):**

- **R1** (Điểm nghẽn 1): mô phỏng WS `"type": "snapshot"` Bybit Spot (`u = 7.652.445`) + `"type": "delta"` (`7.652.446`, `7.652.447`) trong khi REST trả `u = 68.309.332`. Chứng minh `bybit:spot:BTC/USDT` và `ETH/USDT` giữ `SYNCED` với `lastSequenceId = 7.652.447`, `gapCount = 0`, và khi có gap thật thì resync qua WS mà không nạp `u` từ REST.
- **R2** (Điểm nghẽn 2): mô phỏng `fstream.binance.com` / `fapi.binance.com` ném lỗi kết nối/HTTP 451 như trên Edge PoP; chứng minh `LiveMarketCollector` tự chuyển sang endpoint dự phòng / pump `< 500ms` và đưa cả `binance:linear_perp:BTC/USDT` lẫn `ETH/USDT` về `SYNCED` với `feedAgeMs <= 1000`.
- **R3** (Điểm nghẽn 3): bơm giá thực 2026 (`BTC = $74.800`, `ETH = $2.320`, sau đó dao động `±5%`) vào cả hai chiến lược khi 0 chu kỳ mở; chứng minh `equityUsdt === 10000`, `peakEquityUsdt === 10000`, `maxDrawdownPct === 0`, `haltedByDrawdown === false`, và `spot-perp` có `freeCollateralUsdt = 5000`/sàn & `baseInventory = 0`.
- **R4** (`reset-rehearsal`): kiểm thử `POST http://internal/reset-rehearsal` (và route `{"action":"reset-rehearsal"}`) xóa sạch `haltedByDrawdown: true` trong DO storage, vô hiệu hóa run cũ trong D1, và chuyển `baselineProvenance` sang `LIVE_VERIFIED` khi 8/8 `SYNCED`.

---

## 6. What you shouldn't do (Những việc tuyệt đối tránh)

1. **Không trộn lẫn hoặc ghi đè `sequenceId` từ REST `/v5/market/orderbook?category=spot` vào bộ sequencer của Bybit Spot khi WebSocket đang chạy.** Hai không gian số thứ tự (`68,3M` vs `7,6M`) là hai bộ đếm độc lập trên hạ tầng của Bybit.
2. **Không xóa bỏ kiểm tra tính liên tục** (`prevSequenceId !== existing.lastSequenceId`) đối với `"type": "delta"` của Bybit Spot. Bybit Spot WS đảm bảo delta tăng đúng 1 đơn vị kể từ snapshot của chính kết nối WS đó; nếu hụt delta thật thì phải `FEED_DESYNC` và yêu cầu lại snapshot qua unsubscribe + subscribe.
3. **Không xóa tồn kho cơ sở của `spot-2exch`.** Khác với `spot-perp`, `spot-2exch` phải bán tài sản cơ sở trên sàn giá Bid cao hơn (`sellerVenue.baseInventory[pair] >= requiredBaseQty`, `strategy-engine.ts:701`). Nếu xóa, mọi chu kỳ sẽ bị từ chối với `NO_TRADE: Insufficient spot base inventory` và chiến lược tê liệt vĩnh viễn.
4. **Không tắt hoặc nới lỏng `maxDrawdownLimitPct = 2,0%`** hay bất kỳ điều kiện nào trong `scripts/verify-paper-economic-gate.cjs` (`MAX_DRAWDOWN_PCT = 2.0`, `EXPECTED_CONFIG_HASH`).
5. **Không sửa `PAPER_CANONICAL_CONFIG`** trừ khi thực sự cần thiết, để bảo toàn `PAPER_FROZEN_CONFIG_HASH` đồng nhất tuyệt đối giữa runtime và script cổng kinh tế.
6. **Không triển khai lên `apex-os` hoặc chạm vào `apex-os-db`.** Mọi thao tác chỉ trên `apex-os-staging` / `apex-os-staging-db`.

---

## 7. What could be better / more efficient (Tối ưu hóa kiến trúc)

1. **Nhận diện khung `"type": "snapshot"` ngay trong `ingestOrBufferWsBook` cho mọi luồng Bybit (`spot` và `linear_perp`):** cả hai gửi snapshot (`isDelta: false`) ngay khi đăng ký kênh. Khi mọi bản tin `book.isDelta === false` được xử lý bằng `applySnapshotAndDrainBuffer(key, book)`, cả hai đồng bộ tức thì ngay từ khung đầu tiên của WS mà không tốn RTT REST.
2. **Sticky Best Endpoint cho Binance Perp trên Cloudflare DO:** một `PaperTradingDurableObject` gắn cố định với một colo. Khi tìm được endpoint REST/WS phản hồi thành công (ví dụ `https://www.binance.com/fapi/v1` hoặc `wss://fstream.binance.me/stream`), ghi nhớ chỉ số đó (`preferredBinancePerpRestIdx`, `preferredBinancePerpWsIdx`) giúp các lần sau đi thẳng vào endpoint sống thay vì thử lại endpoint bị chặn ở đầu danh sách và chịu phạt timeout.
3. **Bổ sung trường chẩn đoán kết nối vào `/api/admin/paper/overview`:** hiển thị rõ mỗi luồng đang nhận dữ liệu qua `WS_NATIVE` hay `REST_FALLBACK_PUMP` và endpoint nào đang hoạt động — giúp giám sát 48 giờ diễn tập và 30 ngày chạy thật minh bạch tuyệt đối.

---

## 8. My take and how to get there (Lộ trình thực thi từng tệp)

### Bước 1 — `src/lib/paper/live-collector.ts` (Điểm nghẽn 1 & 2)

```ts
const BINANCE_PERP_WS_ENDPOINTS = [
  'wss://fstream.binance.com/stream',
  'wss://fstream.binance.me/stream',
  'wss://fstream1.binance.com/stream',
  'wss://fstream2.binance.com/stream',
  'wss://fstream-auth.binance.com/stream',
];
const BINANCE_PERP_REST_BASES = [
  'https://fapi.binance.com',
  'https://fapi.binance.me',
  'https://fapi1.binance.com',
  'https://fapi2.binance.com',
  'https://www.binance.com',
];
```

- Trong `ingestOrBufferWsBook` (`330-342`), **trước** khi kiểm tra `if (this.bootstrappingKeys.has(key))`, thêm:

```ts
if (book.isDelta === false) {
  const drained = this.applySnapshotAndDrainBuffer(key, book);
  if (this.onBook) {
    this.onBook(book);
    for (const d of drained) this.onBook(d);
  }
  return true;
}
```

- Trong `startWebSocketStreams()` (`269-295`): chỉ gọi REST bootstrap cho các luồng **Binance** (`fetchBinanceSpotDepth`, `fetchBinancePerpDepth`). Nếu sau 3 giây mà một luồng `bybit:linear_perp` chưa có WS snapshot thì mới fallback sang REST; riêng `bybit:spot` khi WS đang chạy **chỉ dùng WS snapshot**.
- Lưu tham chiếu socket Bybit theo `marketType` (`this.bybitSockets = new Map<PaperMarketType, WebSocket>()`). `resyncBybitWsStream(pair, 'spot')` đặt `lastResyncAttemptMs` cách nhau tối thiểu `2000ms` mỗi `streamKey`, đánh dấu `this.beginBootstrapping(key)` rồi gửi `unsubscribe` + `subscribe` trên `orderbook.50.${symbol}`; nếu `ws` không mở thì `this.scheduleReconnect('bybit', 'spot')`.
- Trong `fetchBinancePerpDepth(pair, nowTs)`: thử lần lượt `BINANCE_PERP_REST_BASES` (ưu tiên base vừa thành công lần trước); tách `/fapi/v1/premiumIndex` vào hàm phụ có cache 5 giây và `try/catch` riêng để lỗi funding không bao giờ làm hỏng `/fapi/v1/depth`.
- Trong `connectBinanceWs('linear_perp')`: xoay vòng `BINANCE_PERP_WS_ENDPOINTS` mỗi lần thử kết nối lại. Trong `startWebSocketStreams()`, duy trì một bộ định thời nhẹ (mỗi `450ms`): nếu `binance:linear_perp:{BTC/USDT, ETH/USDT}` chưa nhận được frame WS nào trong `600ms` hoặc `status !== 'SYNCED'`, tự động gọi `fetchBinancePerpDepth(pair)` và đẩy kết quả (`isDelta: false`) qua `applySnapshotAndDrainBuffer` + `this.onBook(res.book)`.

### Bước 2 — `src/lib/paper/worker-do.ts` (Điểm nghẽn 1 & `reset-rehearsal`)

- `startLiveCollector` (`onBook`, `294-309`): khi `res.streamState.status === 'FEED_DESYNC' && this.collector`, nếu `book.exchange === 'bybit' && book.marketType === 'spot'` → `await this.collector.resyncBybitWsStream(book.pair, 'spot')` thay vì `fetchBybitDepth`.
- `alarm()` (`359-363`): khi `!this.collector.isHealthy(10000)`, gọi phương thức `await this.collector.recoverUnhealthyStreams()` chỉ nạp lại REST cho các luồng không phải `bybit:spot` và gọi `resyncBybitWsStream` cho `bybit:spot` không khỏe — tránh việc `alarm()` ghi đè REST `u` lên `bybit:spot`.
- `fetch()` (`1138-1156`): thêm nhánh `POST /reset-rehearsal` → đặt lại sequencer + 2 engine, toàn bộ bộ đếm phiên, `windowBaselines` về trạng thái gốc tại `nowTs` với `baselineProvenance: 'PENDING_LIVE_VALUATION'`; ghi đè khóa trong `this.state.storage`; gọi `deactivatePriorRuns` + `syncPaperRun` + `saveStrategySnapshot` trên `this.env?.DB`; dừng và khởi động lại `this.startLiveCollector()`.

### Bước 3 — `src/lib/paper/strategy-engine.ts` & `types.ts` (Điểm nghẽn 3)

- Thêm `private seedBaseInventory: Record<PaperExchange, Record<PaperPair, number>>` và `private seedInventoryCostBasisUsdt: Record<PaperExchange, Record<PaperPair, number>>`.
- Trong constructor (`174-243`): nếu `'spot-perp'` → `perPairInventoryUsdt = 0`, `freeCashPerVenue = halfCapital` (`5.000 USDT`), `baseInventory = {BTC: 0, ETH: 0}`, `baseInventoryCostBasisUsdt = 0`, `initialInventoryCostBasisUsdt = 0`. Nếu `'spot-2exch'` → giữ nguyên phân bổ `$1.000` mỗi cặp mỗi sàn (`freeCashPerVenue = 3.000`, `initialInventoryCostBasisUsdt = 4.000`), lưu bản sao số lượng khởi tạo vào `this.seedBaseInventory` và giá vốn `$1.000` vào `this.seedInventoryCostBasisUsdt`.
- Trong `standingInventoryMarkToMarketUsdt()` (`265-286`): với `'spot-perp'` trả về tổng `qty × markPrice` của tồn kho dư ngoài các chu kỳ đang mở (`= 0` khi 0 chu kỳ). Với `'spot-2exch'`: với mỗi sàn `ex` và cặp `pair`, tính `effectiveStandingQty` theo công thức ở §5.3, `ΔstandingQty = effectiveStandingQty − seedQty`, rồi `seedCostBasisUsdt[ex][pair] + ΔstandingQty × markPrice`.
- Bổ sung `reanchorSeedInventoryToLivePrice(pair, liveMidPrice)` gọi **một lần duy nhất** mỗi cặp trên `spot-2exch` khi nhận giá thực đầu tiên và `openCycles.size === 0 && closedCycles.length === 0`.
- Trong `src/lib/paper/types.ts:224`: thêm `seedBaseInventory?` (tùy chọn) vào `PaperSerializedStrategyState` + xử lý fallback trong `serializeState` / `restoreState`.

### Bước 4 — `src/app/api/admin/paper/overview/route.ts`

Hỗ trợ `action === 'reset-rehearsal'` trong `POST` (`198-215`), chuyển tiếp tới `http://internal/reset-rehearsal`.

### Bước 5 — Kiểm thử cục bộ, Deploy & Xác minh trực tiếp

1. `npx vitest run src/lib/paper/__tests__/paper-engine-and-replay.test.ts` + `npm run build` trên Node 26.7.0 (chạy từ app root — chạy từ cwd lệch sẽ exit 0 giả).
2. `npx wrangler deploy --env staging`.
3. `POST .../api/admin/paper/overview` `{"action":"reset-rehearsal"}` rồi `{"action":"start-collector"}`.
4. `GET .../api/admin/paper/overview` xác nhận 8/8 `SYNCED`, `haltedByDrawdown: false`, `equityUsdt: 10000`, `maxDrawdownPct: 0`, `baselineProvenance: "LIVE_VERIFIED"`.

---

## 9. Benefits (Lợi ích đạt được)

- **Triệt tiêu vòng lặp `FEED_DESYNC` trên Bybit Spot:** dùng đúng nguồn sự thật (`"type": "snapshot"` từ chính kênh WS của Bybit) thay vì trộn lẫn hai hệ quy chiếu sequence khác nhau.
- **8/8 luồng `SYNCED` từ Cloudflare Edge:** vượt qua giới hạn chặn IP/WS của `fstream` / `fapi` nhờ xoay vòng đa điểm cuối kết hợp pump REST dự phòng `< 500ms`.
- **Hạch toán đúng bản chất Quỹ Arbitrage Trung hòa Thị trường:** loại bỏ hoàn toàn hiện tượng "cháy tài khoản ảo ở 0 giao dịch" do chênh lệch giá giữa hằng số năm 2024 và giá năm 2026, đồng thời giải phóng toàn bộ `$10.000 USDT` vốn ký quỹ cho `spot-perp`.
- **Giữ nguyên 100% tính toàn vẹn của Cổng Kinh tế Production:** không phải thay đổi `PAPER_FROZEN_CONFIG_HASH` hay nới lỏng bất kỳ tiêu chí 30 ngày / 100 chu kỳ nào.

---

## 10. Trade-offs (Đánh đổi kỹ thuật)

- **Khi một PoP Cloudflare chặn toàn bộ WS tới Binance Futures:** `binance:linear_perp` sẽ chạy qua pump REST dự phòng (`~400–500ms`/lần, tương đương ~4 req/s cho 2 cặp — rất thấp so với hạn mức 2.400 weight/phút của Binance). Độ tươi dữ liệu vẫn giữ `200ms–600ms` (`<= 1000ms`), đủ điều kiện mở/đóng chu kỳ an toàn trong khi WS vẫn tiếp tục thử lại ở nền.
- **Cập nhật `V1` và `V7` trong `paper-engine-and-replay.test.ts`:** hai bài test cũ kiểm tra giả định cũ (mọi chiến lược giữ `$4.000` tồn kho không phòng vệ và chịu lỗ MTM ngay cả ở 0 chu kỳ). Việc cập nhật là **bắt buộc** để phản ánh đúng mô hình hạch toán trung hòa — nhưng phải giữ nguyên nhánh (b) của `V1` kiểm chứng halt vẫn hoạt động khi có vị thế mở thực sự.
- **Đổi lấy này:** NAV trung hòa tồn kho đo lường hiệu suất thuần của bộ máy arbitrage (giả định phần tồn kho gốc được phòng hộ hoặc cấp vốn cố định ở tầng treasury). Nếu quỹ thực sự giữ `$4.000` BTC/ETH vật lý không phòng hộ, giá trị ví thật vẫn biến động theo thị trường — đây là chi phí của mô hình, không phải lỗi.

---

## 11. Unverified (Những điểm chỉ xác minh được sau khi deploy)

- **Endpoint Binance Futures nào phản hồi nhanh nhất tại PoP Cloudflare nơi `PAPER_TRADING_DO` của Staging cư trú:** trên máy local cả `fstream.binance.com` và `fapi.binance.com` đều kết nối được, nhưng trên Edge PoP của `apex-os-staging` cần quan sát trực tiếp sau deploy để xác nhận endpoint dự phòng nào được chọn (`fstream.binance.me`, `www.binance.com/fapi/v1/depth`, ...).
- **Toàn bộ dẫn chứng `file:line`** trong báo cáo này phản ánh trạng thái hiện tại của worktree tại commit `5fff74e8`; nếu tệp thay đổi sau đó cần đối chiếu lại.

---

## 12. Work checklist, success metrics & handoff brief

### Danh mục công việc (Work Checklist)

- [ ] `live-collector.ts`: xử lý ngay bản tin WS `book.isDelta === false` qua `applySnapshotAndDrainBuffer(key, book)` thay vì đẩy vào `deltaBuffer`; không gọi `fetchBybitDepth(pair, 'spot')` đè lên luồng Bybit Spot khi WS đang chạy trong `startWebSocketStreams()` / `bootstrapSnapshots()` / `scheduleReconnect()`; bổ sung `resyncBybitWsStream(pair, marketType)` (cooldown 2000ms); bổ sung danh sách đa điểm cuối WS/REST + cache `premiumIndex` + pump REST `450ms` cho `binance:linear_perp`.
- [ ] `worker-do.ts`: trong `onBook`, `bybit:spot` `FEED_DESYNC` → `resyncBybitWsStream`; trong `alarm()` không gọi `bootstrapSnapshots()` ghi đè lên `bybit:spot`; bổ sung `resetRehearsal(nowTs)` + nhánh `POST /reset-rehearsal`.
- [ ] `strategy-engine.ts` & `types.ts`: `spot-perp` 100% USDT (`5.000`/sàn, `0` tồn kho); `spot-2exch` giữ tồn kho vận hành + `reanchorSeedInventoryToLivePrice`; sửa `standingInventoryMarkToMarketUsdt()` chỉ mark-to-market phần `Δinventory = effectiveStandingQty − seedQty`; thêm `seedBaseInventory?` tùy chọn vào serialized state.
- [ ] `overview/route.ts`: hỗ trợ `{"action": "reset-rehearsal"}` trong `POST`.
- [ ] `paper-engine-and-replay.test.ts`: cập nhật `V1` (1171) và `V7` (1614); bổ sung `R1`–`R4`.
- [ ] Kiểm thử & Deploy: `npm test`, `npm run build` (0 lỗi); deploy `apex-os-staging`; gọi `reset-rehearsal` + `start-collector`; xác minh qua `GET /api/admin/paper/overview`.

### Thước đo thành công (Success Metrics)

1. `GET https://apex-os-staging.agencyos-openclaw.workers.dev/api/admin/paper/overview` trả về **8/8** luồng `status === "SYNCED"` và `feedAgeMs <= 1000` trong nhiều lần lấy mẫu liên tiếp cách nhau ≥ 60 giây.
2. Cả hai chiến lược báo cáo `haltedByDrawdown === false`; tại 0 chu kỳ thì `equityUsdt === 10000`, `peakEquityUsdt === 10000`, `maxDrawdownPct === 0`.
3. `windowMetrics["spot-2exch"].baselineProvenance === "LIVE_VERIFIED"` và `windowMetrics["spot-perp"].baselineProvenance === "LIVE_VERIFIED"`, `continuousCoverageMs` tăng đều theo thời gian thực.
4. Toàn bộ test xanh trên Node 26.7.0, `0` lỗi TypeScript/build, **không sinh `:any` mới** trong mã sản phẩm.
5. `node scripts/verify-paper-economic-gate.cjs` vẫn `passed: false`, `verdict: "NO_GO"` và đối chiếu **khớp 100%** `EXPECTED_CONFIG_HASH` với `PAPER_FROZEN_CONFIG_HASH`.
6. Không có log/telemetry/public endpoint nào lộ secret, token hoặc session trị danh.

### Bản bàn giao thực thi (Handoff Brief)

```text
Handoff brief
Objective: Khắc phục 3 điểm nghẽn buổi diễn tập thị trường thực trên apex-os-staging (Bybit Spot REST/WS
sequence mismatch, Binance Linear Perp Cloudflare Edge disconnection, và unhedged seed inventory
drawdown ở 0 chu kỳ) và bổ sung hành động reset-rehearsal, trong khi giữ Production nghiêm ngặt NO_GO.

Done means:
1. Staging live (/api/admin/paper/overview) hiển thị cả 8/8 luồng (binance:spot, binance:linear_perp,
   bybit:spot, bybit:linear_perp x BTC/USDT, ETH/USDT) với status: "SYNCED" và feedAgeMs <= 1000
   qua nhiều lần lấy mẫu liên tiếp trong >= 60 giây.
2. Cả hai chiến lược báo cáo haltedByDrawdown: false, equityUsdt: 10000, maxDrawdownPct: 0 tại 0
   chu kỳ, baselineProvenance: "LIVE_VERIFIED", và continuousCoverageMs tăng liên tục.
3. Bybit Spot phục hồi gap thật qua WS unsubscribe+subscribe, không bao giờ qua REST u.
4. Toàn bộ unit + regression test xanh trên Node 26.7.0; npm run build 0 lỗi.
5. scripts/verify-paper-economic-gate.cjs vẫn NO_GO với EXPECTED_CONFIG_HASH khớp 100%
   PAPER_FROZEN_CONFIG_HASH.

Out of scope: Không deploy production (apex-os), không thay đổi D1 production (apex-os-db),
không nới lỏng cổng kinh tế 30 ngày / 100 chu kỳ / PnL > 0 / DD <= 2%, không đặt lệnh tiền thật.

Constraints: Bảo toàn PAPER_MODEL_VERSION / PAPER_FROZEN_CONFIG_HASH giữa strategy-engine.ts và
verify-paper-economic-gate.cjs; không bao giờ lộ secret/token.

Key files:
- src/lib/paper/live-collector.ts
- src/lib/paper/orderbook-sequencer.ts
- src/lib/paper/worker-do.ts
- src/lib/paper/strategy-engine.ts
- src/lib/paper/types.ts
- src/app/api/admin/paper/overview/route.ts
- src/lib/paper/__tests__/paper-engine-and-replay.test.ts (V1:1171, V7:1614)
- scripts/verify-paper-economic-gate.cjs

Stop and ask only if: đề xuất thay đổi Done-means đã xác nhận; cần deploy production hoặc chạm
apex-os-db; cần nới lỏng cổng kinh tế; phát hiện lỗi retry 3 lần không giải thích được.
Suggested command: /ak-plan
```

---

## 13. Ghi chú Verifier (Audit trail)

1. Ứng viên #2 được chọn vì **không có một dẫn chứng bịa đặt nào**, là ứng viên duy nhất chỉ ra điểm chặn thực sự của Điểm nghẽn 1 ở mức mã nguồn (`ingestOrBufferWsBook` phải xử lý `isDelta === false` **trước** khi kiểm tra `bootstrappingKeys`), duy nhất phát hiện rủi ro tương thích ngược của `seedBaseInventory` đối với `PaperSerializedStrategyState`, và duy nhất phát hiện đúng 2 bài test cũ bị ảnh hưởng (`V1` dòng 1171, `V7` dòng 1614).
2. Hai sửa chứng cứ đã được áp lên bản gốc C2: dải `fetch()` `690-750` → `1138-1156`; endpoint WS Coin-M `nbstream.binance.com/eoptions` → `fstream.binance.me`.
3. Ứng viên #3 đã chế ra chuỗi lỗi `"Sequence not increasing: 7635989 <= 68310903"`; chuỗi thực tại `orderbook-sequencer.ts` là `Sequence gap detected on ${key}: last=..., incoming=... (expectedPrev=...)`. Dù phần Visual Outcome Preview của C3 được đánh giá tốt, chuỗi bịa đặt đã được loại và không xuất hiện trong báo cáo này.
4. Ứng viên #1 dẫn `getCurrentEquityUsdt` tại `1383-1410` (thực tế `1392`); Ứng viên #4 liệt kê `dstream.binance.com` (stream Coin-M phái sinh, không phải USD-M Perp) và thiếu endpoint đã khóa. Các lỗi này đã bị loại khỏi bản thắng cuộc.

---

## 14. Chuyên đề 1 (Mục 2): Chiến lược Cloudflare Edge Egress & Smart Placement cho Binance USD-M Perp

### 14.1. Chẩn đoán tầng mạng từ Telemetry thực trên `apex-os-staging`

Quan sát trực tiếp `/tmp/paper-overview-staging.json`:
- `binance:spot:BTC/USDT` (`receiveCount: 570`, `status: "SYNCED"`) và `binance:spot:ETH/USDT` (`receiveCount: 554`, `status: "SYNCED"`) kết nối hoàn toàn bình thường.
- Ngược lại, `binance:linear_perp:BTC/USDT` và `ETH/USDT` có `connected: false`, `receiveCount: 0`, `lastSequenceId: 0`, `reconnectCount: 14`, `lastErrorReason: "Failed to establish websocket connection"`.

**Nguyên nhân kiến trúc trên Cloudflare Workers / Durable Objects:**
1. **Geo-blocking phân tầng giữa Spot và USD-M Futures:** Binance vận hành cụm biên (WAF/CloudFront) cho USD-M Futures (`fstream.binance.com`, `fapi.binance.com`) với chính sách chặn IP nghiêm ngặt hơn hẳn Spot (`stream.binance.com:9443`) đối với các dải IP egress của Cloudflare tại Bắc Mỹ (`wnam`/`enam`) và một số colo châu Âu. Khi `PaperTradingDurableObject` được khởi tạo mà không có `locationHint` (`src/app/api/admin/paper/overview/route.ts:62,222` gọi `env.PAPER_TRADING_DO.idFromName('global-paper-engine')` rồi `.get(doId)`), DO sẽ ghim vĩnh viễn tại colo gần request đầu tiên (thường là US/VN tùy đường định tuyến).
2. **Đơn điểm lỗi (Single-Host Lock-in) trong `live-collector.ts`:**
   - WebSocket (`src/lib/paper/live-collector.ts:435-441`): khóa cứng duy nhất `wss://fstream.binance.com/stream?streams=...`. Khi bắt tay WS bị từ chối (HTTP 451 / 403), `scheduleReconnect` chỉ thử lại đúng URL đó.
   - REST (`src/lib/paper/live-collector.ts:154-165`): khóa cứng `https://fapi.binance.com/fapi/v1/depth` và `/fapi/v1/premiumIndex` trong `Promise.all`. Chỉ cần 1 trong 2 request bị 451/timeout là toàn bộ `fetchBinancePerpDepth` ném lỗi, khiến `lastSequenceId` giữ nguyên bằng `0`.

### 14.2. So sánh các phương án vượt rào cản Edge Egress cho `binance:linear_perp`

| Phương án | Cơ chế hoạt động | Ưu điểm | Nhược điểm / Giới hạn | Quyết định |
|---|---|---|---|---|
| **A. Xoay vòng đa điểm cuối WS + REST (`fstream*` / `fapi*` / `www.binance.com/fapi`) + Sticky Memoization** | Thử tuần tự danh sách WS (`fstream.binance.com`, `fstream.binance.me`, `fstream1.binance.com`, `fstream2.binance.com`, `fstream-auth.binance.com`) và REST (`fapi.binance.com`, `fapi.binance.me`, `fapi1.binance.com`, `fapi2.binance.com`, `www.binance.com`). Ghi nhớ chỉ số endpoint thành công (`preferredPerpRestIdx`, `preferredPerpWsIdx`). | `www.binance.com/fapi/v1/depth` đi qua cổng CDN web chính của Binance nên thường xuyên mở ở các colo nơi `fapi.binance.com` bị chặn trực tiếp. Độ trễ bằng 0 sau lần chọn đầu tiên. | Nếu colo hiện tại thuộc vùng bị chặn toàn diện ở tầng WAF WebSocket, cả 5 WS endpoint có thể vẫn từ chối upgrade. | **Bắt buộc triển khai (Tầng 1)** |
| **B. Tách rời `depth` khỏi `premiumIndex` + Cache Funding 5–10s** | Trong `fetchBinancePerpDepth` (`live-collector.ts:152-211`), gọi `/fapi/v1/depth` độc lập; `/fapi/v1/premiumIndex` được bọc trong `try/catch` riêng với bộ nhớ đệm TTL 5–10 giây theo từng `pair`. | Triệt tiêu hoàn toàn lỗi liên đới: sự cố tạm thời ở endpoint funding không bao giờ làm rớt sổ lệnh L2 hay gây `FEED_DESYNC`. | Không có nhược điểm (funding rate chỉ chốt mỗi 8 giờ, cache 5–10s hoàn toàn chính xác). | **Bắt buộc triển khai (Tầng 2)** |
| **C. High-Frequency REST Snapshot Fallback Pump (`400ms–450ms`)** | Khi WS `binance:linear_perp` chưa `connected` hoặc chưa nhận frame mới sau `600ms`, vòng lặp bất đồng bộ trong `LiveMarketCollector` tự động gọi `fetchBinancePerpDepth(pair)` (`isDelta: false`) mỗi `400ms–450ms` và đẩy qua `applySnapshotAndDrainBuffer` + `onBook`. | Tương thích 100% với `orderbook-sequencer.ts:293-296` (`isRepeatedValidSnapshot` làm mới `lastReceivedTs` ngay cả khi `lastUpdateId` giữa 2 lần gọi cách nhau 400ms chưa đổi). Giữ `feedAgeMs <= 500ms < 1000ms` và `status === 'SYNCED'` liên tục 24/7 ngay cả khi WS bị chặn hoàn toàn. Chỉ tốn ~4.4 req/s cho 2 cặp (~266 weight/phút << giới hạn 2.400 weight/phút). | Tốn subrequest HTTP từ Durable Object khi WS chết, nhưng hoàn toàn nằm trong hạn mức của DO trả phí. | **Bắt buộc triển khai (Tầng 3 — Bảo hiểm 100% uptime)** |
| **D. Cloudflare Smart Placement (`wrangler.staging.jsonc`) + DO `locationHint: 'apac'` / `'enam'`** | Bật `"placement": { "mode": "smart" }` trong `wrangler.staging.jsonc` và truyền `{ locationHint: 'apac' }` (Singapore/Tokyo — nơi đặt máy chủ khớp lệnh của Binance & Bybit) khi gọi `PAPER_TRADING_DO.get(doId, { locationHint: 'apac' })` kèm khóa tên DO mới (hoặc giữ nguyên tên cho trạng thái đã reset). | Đặt Worker/DO tại khu vực châu Á - Thái Bình Dương (`SIN` / `NRT`), vừa tránh toàn bộ dải IP Mỹ bị Binance Futures chặn (HTTP 451), vừa giảm RTT tới Binance/Bybit từ ~180ms xuống ~5–15ms. | Lưu ý của Cloudflare: một `idFromName('global-paper-engine')` đã được khởi tạo trước đó sẽ giữ nguyên colo cũ; `locationHint` chỉ có hiệu lực trọn vẹn nếu kết hợp `placement: smart` hoặc khởi tạo instance DO tại vùng APAC. Do đó **không được phụ thuộc duy nhất vào `locationHint`** mà phải kết hợp với Tầng 1 + 2 + 3. | **Khuyến nghị bổ sung cùng Tầng 1–3** |
| **E. `data-api.binance.vision`** | Dùng cổng dữ liệu lịch sử/công cộng `https://data-api.binance.vision/api/v3/depth`. | Không bao giờ bị chặn HTTP 451 tại Mỹ. | **Chỉ hỗ trợ Spot (`/api/v3/*`), KHÔNG hỗ trợ USD-M Futures (`/fapi/v1/*` trả HTTP 404/400).** | **Loại bỏ cho `linear_perp`** |

### 14.3. Thiết kế chi tiết Tầng Mạng cho `src/lib/paper/live-collector.ts` & `wrangler.staging.jsonc`

1. **Cấu hình `wrangler.staging.jsonc`:**
   Thêm `"placement": { "mode": "smart" }` ở cấp cấu hình gốc của `wrangler.staging.jsonc` để Cloudflare định tuyến Worker gần nguồn dữ liệu CEX.
2. **Ma trận Endpoint & Sticky Failover trong `LiveMarketCollector`:**
   - Khi `fetchBinancePerpDepth(pair, nowTs)` chạy:
     - Bắt đầu từ `this.preferredBinancePerpRestIdx` (mặc định `0`), duyệt vòng qua `BINANCE_PERP_REST_BASES`:
       1. `https://fapi.binance.com`
       2. `https://www.binance.com` (gọi `/fapi/v1/depth?symbol=...&limit=20`)
       3. `https://fapi.binance.me`
       4. `https://fapi1.binance.com`
       5. `https://fapi2.binance.com`
     - Mỗi lần thử dùng `AbortSignal.timeout(1500)` để nếu endpoint đầu bị treo/chặn thì chuyển ngay sang endpoint kế tiếp trong `< 1.5s`, và ngay khi một base trả về HTTP 200 hợp lệ (`Array.isArray(data.bids)`), lưu lại `this.preferredBinancePerpRestIdx = idx` để mọi tick kế tiếp đi thẳng vào endpoint sống.
3. **Cơ chế Pump REST dự phòng 400ms không gây xung đột với WS:**
   - Bộ định thời `this.perpFallbackTimer` chạy mỗi `400ms` khi `this.running === true`.
   - Với mỗi `pair` trong `this.config.pairs`: kiểm tra `const st = this.streamStates.get('binance:linear_perp:' + pair)`.
   - Nếu `!st?.connected || (Date.now() - st.lastReceiveTs > 450)`: gọi `fetchBinancePerpDepth(pair, Date.now())`.
   - Khi nhận được `book` (`isDelta: false`), gọi `this.ingestOrBufferWsBook(book)` (đã được nâng cấp để xử lý `book.isDelta === false` qua `applySnapshotAndDrainBuffer` + `this.onBook(book)`).
   - Nhờ vậy, dù WS đang sống hay bị chặn ở Edge PoP, `sequencer` luôn nhận được snapshot hợp lệ mỗi `400ms`, giữ `feedAgeMs <= 450ms` (`< 1000ms` ngưỡng `maxFeedAgeMs` tại `orderbook-sequencer.ts:138`).

---

## 15. Chuyên đề 2 (Mục 3): Kiểm toán Định lượng (Quant Audit) Công thức Trung hòa Tồn kho ($\Delta\text{inventory}$) qua Toàn bộ Vòng đời 48 Giờ

### 15.1. Phân tích Bất biến Kế toán Hiện tại trong `src/lib/paper/strategy-engine.ts`

Kiểm tra trực tiếp mã nguồn tại `src/lib/paper/strategy-engine.ts`:
- Công thức NAV hiện tại (`getCurrentEquityUsdt`, dòng `1392-1410`):
  $$\text{Equity} = \underbrace{\sum_{v \in \{\text{bin}, \text{byb}\}} (\text{free}_v + \text{allocated}_v) - \sum_{c \in \text{openCycles}} c.\text{openCycleCashDeltaUsdt}}_{\text{Cash \& Reserved Margin Thực (đã khử tiền bán Spot tạm ứng)}} + \text{standingInventoryMarkUsdt} + \text{lastUnrealizedPnlUsdt}$$

Hãy kiểm tra dòng chảy của từng biến qua **5 trạng thái vòng đời** của cả hai chiến lược:

#### Trạng thái 1: Khởi tạo tại $t = 0$ (0 chu kỳ mở, 0 chu kỳ đóng)
- **Với `spot-perp`:**
  - `freeCollateralUsdt`: Binance `= 5.000`, Bybit `= 5.000` $\Rightarrow \sum(\text{free} + \text{allocated}) = 10.000\text{ USDT}$.
  - `baseInventory = { 'BTC/USDT': 0, 'ETH/USDT': 0 }`, `seedBaseInventory = 0`, `initialInventoryCostBasisUsdt = 0`.
  - $\text{standingInventoryMarkUsdt} = 0$, $\text{lastUnrealizedPnlUsdt} = 0$.
  - $\Rightarrow \text{Equity}(t_0) = 10.000,0000\text{ USDT}$, $\text{peakEquityUsdt} = 10.000,0000$, $\text{maxDrawdownPct} = 0\%$.
- **Với `spot-2exch`:**
  - `freeCollateralUsdt`: Binance `= 3.000`, Bybit `= 3.000` $\Rightarrow \sum(\text{free} + \text{allocated}) = 6.000\text{ USDT}$.
  - Mỗi sàn giữ $1.000\text{ USDT}$ giá vốn gốc (`seedCostBasisUsdt[ex][pair] = 1000`) cho mỗi cặp (`BTC/USDT`, `ETH/USDT`), tổng `initialInventoryCostBasisUsdt = 4.000 USDT`.
  - Khi nhận giá mark thực đầu tiên $P_{\text{live}}(\text{pair})$ (lúc `openCycles.size === 0 && closedCycles.length === 0`), `reanchorSeedInventoryToLivePrice` đặt:
    $$\text{seedQty}(ex, \text{pair}) = \text{venue.baseInventory}[\text{pair}] = \text{round8}\!\left(\frac{1000}{P_{\text{live}}(\text{pair})}\right)$$
  - Tại mọi mức giá thị trường tiếp theo $P(t)$ khi chưa mở chu kỳ:
    $$\text{effectiveStandingQty}(ex, \text{pair}) = \text{venue.baseInventory}[\text{pair}] = \text{seedQty}(ex, \text{pair})$$
    $$\Rightarrow \Delta\text{standingQty}(ex, \text{pair}) = 0 \implies \text{standingInventoryMarkUsdt} = \sum_{ex, \text{pair}} 1000 = 4.000,0000\text{ USDT}$$
  - $\Rightarrow \text{Equity}(t) = 6.000 + 4.000 + 0 = 10.000,0000\text{ USDT}$ **bất biến tuyệt đối với biến động giá thị trường khi 0 chu kỳ mở**.

#### Trạng thái 2: Đang mở chu kỳ (`openNewCycle`, dòng `1000-1095`)
Giả sử mở 1 chu kỳ cho cặp $p$ với khối lượng cơ sở $q = \text{quantityBase}$, mua ở sàn $A$ giá $P_A^{\text{in}}$ (`legAQuote = q \cdot P_A^{\text{in}}`), bán ở sàn $B$ giá $P_B^{\text{in}}$ (`legBQuote = q \cdot P_B^{\text{in}}`):

- **Trường hợp 2a — Chiến lược `spot-2exch` (`legAMarket = 'spot'`, `legBMarket = 'spot'`):**
  - Tại `openNewCycle` (`1028-1070`):
    - Sàn $A$ (mua Spot): `free_A` giảm `legAQuote`, `allocated_A` tăng `legAQuote` $\Rightarrow \text{free}_A + \text{allocated}_A$ **không đổi** (`= 3.000`). Tồn kho vật lý: $\text{base}_A[p] = \text{seedQty}_A[p] + q$.
    - Sàn $B$ (bán Spot): `free_B` tăng `+legBQuote`, đồng thời `openCycleCashDeltaUsdt = legBQuote` $\Rightarrow (\text{free}_B + \text{allocated}_B) - \text{openCycleCashDeltaUsdt}$ **không đổi** (`= 3.000`). Tồn kho vật lý: $\text{base}_B[p] = \text{seedQty}_B[p] - q$.
    - Như vậy thành phần tiền mặt ròng $\text{totalVenueQuoteUsdt} - \text{openCashDeltaUsdt}$ giữ nguyên bằng đúng $6.000,0000\text{ USDT}$!
  - Bây giờ xét thành phần tồn kho `standingInventoryMarkToMarketUsdt()`:
    - Trên sàn $A$:
      $$\text{effectiveStandingQty}(A, p) = \text{base}_A[p] - q = (\text{seedQty}_A[p] + q) - q = \text{seedQty}_A[p] \implies \Delta\text{standingQty}(A, p) = 0$$
    - Trên sàn $B$:
      $$\text{effectiveStandingQty}(B, p) = \text{base}_B[p] + q = (\text{seedQty}_B[p] - q) + q = \text{seedQty}_B[p] \implies \Delta\text{standingQty}(B, p) = 0$$
    - Do đó $\text{standingInventoryMarkUsdt} = 4.000,0000\text{ USDT}$!
  - Còn lãi/lỗ chưa thực hiện của hai chân $+q$ (ở $A$) và $-q$ (ở $B$) được tính ở đâu? Chính xác tại `updateMarkToMarketDrawdown` (`1301-1317`):
    $$\text{cycleMark} = (P_A^{\text{exit,bid}} - P_A^{\text{in}}) \cdot q + (P_B^{\text{in}} - P_B^{\text{exit,ask}}) \cdot q - \text{entryFees} - \text{estExitFees}$$
    $$\Rightarrow \text{Equity}(t) = 6.000 + 4.000 + \text{lastUnrealizedPnlUsdt} = 10.000 + \text{cycleMark}$$
  - **Kết luận Kiểm toán 2a:** Không hề có tính trùng (zero double-counting) và không hề bỏ sót phí hay chênh lệch giá mở/đóng. Nếu cộng trực tiếp $\text{base}_A[p] \cdot P_{\text{mid}}$ mà không trừ $q$ của chu kỳ đang mở, chân mua $+q$ và chân bán $-q$ ở hai sàn sẽ triệt tiêu trên giá mid chung, nhưng nếu chỉ 1 chân là spot (như `spot-perp`) sẽ gây **tính trùng gấp đôi** biến động giá của $+q$! Công thức quy về `effectiveStandingQty` bảo vệ tuyệt đối cả hai chiến lược khỏi lỗi tính trùng này.

- **Trường hợp 2b — Chiến lược `spot-perp` (`legAMarket = 'spot'`, `legBMarket = 'linear_perp'`):**
  - Tại `openNewCycle` (`1028-1070`):
    - Chân $A$ (mua Spot trên sàn $V$): `free_V` giảm `legAQuote`, `allocated_V` tăng `legAQuote`; $\text{base}_V[p]$ tăng từ $0$ lên $+q$.
    - Chân $B$ (bán Perp trên sàn $V$): `free_V` giảm `legBQuote`, `allocated_V` tăng `legBQuote`; `openCycleCashDeltaUsdt = 0`.
    - Tổng $\text{free}_V + \text{allocated}_V$ giữ nguyên bằng $10.000,0000\text{ USDT}$!
  - Trong `standingInventoryMarkToMarketUsdt()`:
    - Vì chân $A$ đang nằm trong `openCycles` (`legAMarket === 'spot'`), lượng $+q$ thuộc về vị thế delta-neutral đang mở:
      $$\text{effectiveStandingQty}(V, p) = \text{base}_V[p] - q = q - q = 0 \implies \Delta\text{standingQty}(V, p) = 0 \implies \text{standingInventoryMarkUsdt} = 0$$
    - Toàn bộ lãi/lỗ MTM của chân mua Spot $+q$ cộng chân bán Perp $-q$ cộng `accruedFundingUsdt` trừ phí vào/ra đã nằm trọn vẹn trong `lastUnrealizedPnlUsdt` (`1302-1317`)!
    - **Phát hiện quan trọng của Kiểm toán Định lượng:** Nếu ở `spot-perp` ta không trừ $q$ của `openCycles` khi tính `standingInventoryMarkToMarketUsdt()`, thì khi chu kỳ đang mở, $\text{base}_V[p] = q > 0$ sẽ được cộng thêm $q \cdot P_{\text{mid}}$ vào `standingInventoryMarkUsdt`, nâng `Equity` giả tạo lên $10.000 + 500 = 10.500\text{ USDT}$ ngay lập tức và khi đóng chu kỳ sẽ tụt về $10.000$ gây **drawdown ảo $4,76\% > 2\%$ làm halt chiến lược ngay ở chu kỳ đầu tiên**!
    - Nhờ công thức thống nhất:
      $$\text{effectiveStandingQty}(ex, p) = \text{round8}\!\left(\text{venue.baseInventory}[p] - \sum_{\substack{c \in \text{open}(p) \\ c.\text{legA}=ex,\, \text{spot}}} c.\text{quantityBase} + \sum_{\substack{c \in \text{open}(p) \\ c.\text{legB}=ex,\, \text{spot}}} c.\text{quantityBase}\right)$$
      áp dụng giống hệt nhau cho **cả `spot-2exch` và `spot-perp`** (với `spot-perp` có `seedQty = 0` và `seedCostBasisUsdt = 0`), $\text{effectiveStandingQty}$ luôn bằng $0$ cho `spot-perp` trong suốt thời gian mở lẫn đóng chu kỳ!

#### Trạng thái 3: Khi đóng chu kỳ (`closeOpenCycle`, dòng `1097-1257`)
- Trong `closeOpenCycle` (`1183-1228`):
  - Với `spot-2exch`:
    - Sàn $A$ bán lại đúng `open.quantityBase`: $\text{base}_A[p] = \text{round8}((\text{seedQty}_A[p] + q) - q) = \text{seedQty}_A[p]$. Tiền mặt `free_A` nhận về `legAEntryQuoteUsdt + legAPnl - legAFeesUsdt` (và giải phóng `allocated_A`).
    - Sàn $B$ mua lại đúng `open.quantityBase`: $\text{base}_B[p] = \text{round8}((\text{seedQty}_B[p] - q) + q) = \text{seedQty}_B[p]$. Tiền mặt `free_B` trừ đi `legBEntryQuoteUsdt - legBPnl + legBFeesUsdt`.
    - Cộng hai sàn lại:
      $$\Delta(\text{free}_A + \text{free}_B + \text{allocated}_A + \text{allocated}_B - \text{openCashDelta}) = \text{legAPnl} + \text{legBPnl} - \text{totalFeesUsdt} = \text{netPnlUsdt}$$
    - Và tồn kho vật lý trên cả hai sàn quay về **chính xác từng satoshi** (`round8`) bằng `seedQty` ban đầu: $\Delta\text{standingQty} = 0$, $\text{standingInventoryMarkUsdt} = 4.000,0000\text{ USDT}$.
  - Với `spot-perp`:
    - Sàn $V$ bán lại `open.quantityBase` ở Spot ($\text{base}_V[p]$ về $0$) và tất toán Perp: tổng tiền mặt tăng đúng `netPnlUsdt = legAPnl + legBPnl + fundingDeltaUsdt - totalFeesUsdt`.
- **Hệ quả toán học sau $N$ chu kỳ đã đóng:**
  $$\text{Equity}_{\text{sau } N \text{ chu kỳ}} = 10.000,0000 + \sum_{i=1}^{N} \text{netPnlUsdt}_i$$
  Không có bất kỳ độ trượt tồn kho (inventory drift) nào sau khi đóng chu kỳ vì `closeOpenCycle` luôn mua/bán lại đúng `open.quantityBase` (`computeVwapFillByBaseQty(book, side, existingOpen.quantityBase)` tại dòng `551-560` và `789-798`).

#### Trạng thái 4: Tái cân bằng liên sàn (`rebalance` / `totalRebalanceFeesUsdt`)
- Kiểm tra toàn bộ codebase (`grep -rn "rebalance" src/lib/paper/`): trong phiên bản `paper-v1.1.0`, `totalRebalanceFeesUsdt` là bộ đếm kế toán được khởi tạo bằng `0` (`strategy-engine.ts:108`), không có hàm tự động chuyểnbase/USDT khác lượng giữa hai sàn ngoài chu kỳ mở/đóng đối ứng 1:1.
- Hơn nữa, ngay cả khi một hàm rebalance chuyển $\delta q$ từ sàn này sang sàn kia hoặc phát sinh phần dư $\Delta\text{standingQty}(ex, p) \neq 0$, công thức:
  $$\text{standingInventoryMarkUsdt} = \sum_{ex, p} \Big( \text{seedCostBasisUsdt}[ex][p] + \Delta\text{standingQty}(ex, p) \times \text{markPrice}(p) \Big)$$
  vẫn định giá chính xác phần lệch $\Delta\text{standingQty}$ theo `markPrice(p)` thời gian thực, trong khi phí rebalance đã trừ trực tiếp vào `freeCollateralUsdt`.

#### Trạng thái 5: Khi xảy ra đứt kết nối $> 15\text{s}$ và Reset Cửa sổ Liên tục (`markOpenCyclesAsCarryOver`, dòng `1489-1523`)
- Khi `resetContinuousWindow(nowMs)` chạy (`worker-do.ts:465-516`), `engine.markOpenCyclesAsCarryOver(this.sequencer, nowMs)` gán `open.isCarryOver = true` và chụp `open.baselineUnrealizedPnlUsdt = currentNetPnl`.
- Đồng thời `baseline.baselineEquityUsdt = snap.equityUsdt`.
- Nhờ $\text{standingInventoryMarkUsdt}$ không còn bị nhiễu bởi beta thụ động của tồn kho gốc, `baselineEquityUsdt` tại thời điểm reset và `snap.equityUsdt` sau khi đóng chu kỳ carry-over chỉ chênh nhau đúng phần `windowAttributableNetPnlUsdt = netPnlUsdt - baselineUnrealizedPnlUsdt` (`strategy-engine.ts:1165-1167`). Hai chỉ số `windowRealizedNetPnl` (`windowNavPnl`) và `windowAttributablePnl` tại `worker-do.ts:548-558` sẽ **hội tụ tuyệt đối với nhau**, không bao giờ bị lệch dấu như trong `/tmp/paper-overview-staging.json` cũ (`windowRealizedNetPnlUsdt: -0.1879` ở 0 chu kỳ)!

---

## 16. Chuyên đề 3 (Mục 1): Lệnh Thực thi Một Dòng (`/ak-vibe` & `/ak-cook`) + Bản Bàn giao Đã Khóa

Bạn có thể sao chép và chạy trực tiếp **1 trong 2 lệnh một dòng** dưới đây tùy theo quy trình bạn muốn dùng:

### Lựa chọn 1 — Chạy toàn trình tự động qua `/ak-vibe` (Tạo/cập nhật Plan $\to$ TDD Fix $\to$ Code Review $\to$ Ship PR $\to$ Merge $\to$ Deploy Staging & Reset Rehearsal 48h):

```text
/ak-vibe Triển khai trọn vẹn báo cáo cố vấn đã khóa tại plans/reports/advise-261102-0807-staging-rehearsal-live-telemetry.md (Candidate #2 - 73/80 + Chuyên đề Edge Egress & Quant Audit §14-§15): (1) Khắc phục Bybit Spot L2 FEED_DESYNC trong src/lib/paper/live-collector.ts và src/lib/paper/worker-do.ts bằng cách xử lý ngay bản tin WS book.isDelta === false qua applySnapshotAndDrainBuffer trước khi kiểm tra bootstrappingKeys, không gọi REST fetchBybitDepth(pair, 'spot') đè lên WS đang chạy, và thêm resyncBybitWsStream(pair, 'spot') có cooldown 2000ms; (2) Khắc phục Binance Linear Perp DISCONNECTED trên Cloudflare Edge bằng xoay vòng đa điểm cuối WS (fstream.binance.com, fstream.binance.me, fstream1.binance.com, fstream2.binance.com, fstream-auth.binance.com) + REST (fapi.binance.com, www.binance.com, fapi.binance.me, fapi1.binance.com, fapi2.binance.com) kèm sticky memoization, tách riêng cache premiumIndex (TTL 5-10s) khỏi depth, bật REST snapshot fallback pump 400-450ms khi WS chưa SYNCED, và bật placement smart trong wrangler.staging.jsonc; (3) Sửa hạch toán tồn kho trong src/lib/paper/strategy-engine.ts và src/lib/paper/types.ts: khởi tạo spot-perp 100% USDT (5000 USDT/sàn, baseInventory = 0, initialInventoryCostBasisUsdt = 0), giữ tồn kho vận hành $4000 cho spot-2exch kèm reanchorSeedInventoryToLivePrice và định giá standingInventoryMarkToMarketUsdt theo đúng công thức effectiveStandingQty (trừ legA spot đang mở, cộng legB spot đang mở) để cả hai chiến lược có equityUsdt = 10000, maxDrawdownPct = 0, haltedByDrawdown = false tại 0 chu kỳ và không tính trùng khi mở chu kỳ, thêm seedBaseInventory? tùy chọn vào PaperSerializedStrategyState; (4) Thêm action reset-rehearsal vào POST /api/admin/paper/overview và PaperTradingDurableObject (/reset-rehearsal); (5) Cập nhật test V1 (dòng 1171), V7 (dòng 1614) và thêm 4 regression tests R1-R4 trong src/lib/paper/__tests__/paper-engine-and-replay.test.ts; (6) Chạy pass toàn bộ test trên Node 26.7.0 + npm run build, deploy duy nhất lên apex-os-staging, gọi reset-rehearsal + start-collector và xác minh trực tiếp 8/8 luồng SYNCED (feedAgeMs <= 1000), haltedByDrawdown = false, baselineProvenance = LIVE_VERIFIED, đồng thời giữ nghiêm ngặt Production NO_GO (scripts/verify-paper-economic-gate.cjs EXIT_CODE=1, không chạm apex-os hoặc apex-os-db). --ship
```

### Lựa chọn 2 — Triển khai trực tiếp ngay trong worktree hiện tại qua `/ak-cook` (Nhanh nhất nếu bạn muốn sửa code, chạy test, deploy `apex-os-staging` và `reset-rehearsal` ngay lập tức):

```text
/ak-cook --tdd --auto Triển khai trọn vẹn báo cáo cố vấn plans/reports/advise-261102-0807-staging-rehearsal-live-telemetry.md (Candidate #2 + §14-§15): sửa dứt điểm 3 Live Telemetry Blocker (Bybit Spot WS snapshot/resync, Binance Perp multi-endpoint + 400ms REST fallback pump + placement smart trong wrangler.staging.jsonc, và hạch toán trung hòa tồn kho effectiveStandingQty cho spot-2exch + 100% USDT cho spot-perp), bổ sung POST reset-rehearsal, cập nhật V1/V7 + thêm R1-R4 trong src/lib/paper/__tests__/paper-engine-and-replay.test.ts, build & deploy lên apex-os-staging, kích hoạt reset-rehearsal + start-collector và xác minh 8/8 SYNCED + LIVE_VERIFIED trên staging, giữ nghiêm ngặt Production NO_GO.
```

