# Stellar Mainnet Setup Guide

Hướng dẫn chi tiết để cấu hình và triển khai Stellar USDC payout system cho mainnet.

## 📋 Mục lục

1. [Tổng quan](#tổng-quan)
2. [Chuẩn bị wallet chính](#chuẩn-bị-wallet-chính)
3. [Mua USDC và gửi vào wallet](#mua-usdc-và-gửi-vào-wallet)
4. [Cấu hình environment variables](#cấu-hình-environment-variables)
5. [Kiểm tra kết nối](#kiểm-tra-kết-nối)
6. [Admin Settings - Network Switch](#admin-settings---network-switch)
7. [Test mainnet transaction](#test-mainnet-transaction)
8. [Troubleshooting](#troubleshooting)

---

## Tổng quan

ApexOS sử dụng Stellar network để thực hiện USDC payouts cho affiliates. Trước khi chạy mainnet, bạn cần:

1. **Tạo Stellar wallet** (hoặc dùng ví hiện có)
2. **Mua và gửi USDC** vào wallet
3. **Cấu hình secret key** trong environment
4. **Set network về mainnet** thay vì testnet
5. **Kiểm tra kết nối và balance**

---

## Chuẩn bị wallet chính

### Lựa chọn 1: Sử dụng xPortal (khuyến nghị)

xPortal là ví Stellar đa chức năng, hỗ trợ tốt cho ApexOS:

1. Tải xPortal từ:
   - iOS: App Store (tìm "xPortal")
   - Android: Google Play
   - Chrome Extension: Chrome Web Store

2. Tạo wallet mới:
   - Mở xPortal → Create New Wallet
   - Chọn "Stellar" network
   - Lưu **Secret Key** (Phrase) an toàn (offline, không chia sẻ)
   - Xác nhận recovery phrase

3. Lấy **Public Key / Account ID**:
   - Trong xPortal, vào Settings → Account Details
   - Copy "Account ID" (bắt đầu bằng `G...`)
   - Ví dụ: `GBANPRT7K2I6Z3Q3R4Y5T6P7K2I6Z3Q3R4Y5`

### Lựa chọn 2: Sử dụng Stellar Laboratory

Stellar Laboratory (lab.stellar.org) là tool chính thức để quản lý Stellar account:

1. Truy cập https://laboratory.stellar.org
2. Click "Create Account" (chỉ works nếu chưa có account)
3. Generate new keypair:
   - **Secret Key**: `S...` (giữ bí mật tuyệt đối)
   - **Public Key**: `G...` (có thể chia sẻ)

**Lưu ý quan trọng:**
- **Secret Key** (bắt đầu bằng `S`) = PRIVATE KEY. KHÔNG BAO GIỜ chia sẻ.
- **Public Key/Account ID** (bắt đầu bằng `G`) = PUBLIC ADDRESS. Có thể chia sẻ để nhận tiền.
- Nếu đã có wallet (xPortal, Lobstr, StellarKey), bạn có thể dùng existing account.

---

## Mua USDC và gửi vào wallet

### Bước 1: Mua USDC

USDC (USD Coin) trên Stellar là token issued bởi Circle. Các cách mua:

**Option A: Sàn giao dịch crypto (khuyến nghị)**
1. Đăng ký tài khoản trên Binance, Bybit, OKX, hoặc Coinbase
2. Mua USDC bằng fiat (USD, VND, etc.) hoặcswap từ crypto khác
3. Rút USDC về Stellar wallet của bạn

**Option B: Peer-to-peer (P2P)**
1. Sử dụng P2P platform (Binance P2P, LocalBitcoins)
2. Mua USDC trực tiếp từ người bán
3. Yêu cầu họ gửi USDC đến Stellar address của bạn

**Option C: Swap từ XLM**
1. Nếu đã có XLM trên Stellar, dùng Stellar DEX để swap
2. Truy cập https://stellar.expert/ hoặc https://lobstr.co/
3. Swap XLM → USDC

### Bước 2: Gửi USDC vào wallet

1. Lấy **Stellar Public Key/Account ID** của wallet chính (bắt đầu bằng `G...`)
2. Trên sàn/exchange, chọn "Withdraw" USDC
3. Chọn network: **STELLAR (XLM)** - NOT ERC20, NOT TRC20
4.Nhập destination address: **Account ID** của bạn
5. **Memo (nếu có)**: Thường không cần, nhưng nếu sàn yêu cầu, nhập "0" hoặc để trống
6. Xác nhận withdrawal

**Kiểm tra balance:**
- Sau khi withdraw, mở xPortal hoặc Stellar Laboratory
- Check balance: https://horizon.stellar.org/accounts/`Gyour_account_id`
- Bạn nên thấy USDC balance > 0

---

## Cấu hình environment variables

### Trên Local Development

Tạo hoặc cập nhật `.env.local` tại project root:

```bash
# Stellar Mainnet Configuration
STELLAR_SECRET_KEY=SA...your_actual_secret_key_here...
STELLAR_NETWORK=mainnet
STELLAR_USDC_ISSUER=GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3
STELLAR_USDC_CODE=USDC

# Optional: Custom Horizon URL (dùng default nếu không set)
# STELLAR_HORIZON_URL=https://horizon.stellar.org
```

**Lưu ý:**
- `STELLAR_SECRET_KEY`: Secret key từ wallet (bắt đầu bằng `S`)
- `STELLAR_NETWORK`: Phải là `mainnet` (không phải `testnet`)
- `STELLAR_USDC_ISSUER`: USDC issuer address cho mainnet (đã có sẵn trong code)
- `.env.local` được gitignore - không commit secret key

### Trên Cloudflare Pages (Production)

1. Vào Cloudflare Dashboard → Pages → ApexOS project
2. Settings → Environment Variables
3. Thêm các biến:

| Name | Value |
|------|-------|
| `STELLAR_SECRET_KEY` | `S...` (secret key của bạn) |
| `STELLAR_NETWORK` | `mainnet` |
| `STELLAR_USDC_ISSUER` | `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3` |

4. Click "Save"
5. Deploy lại project

### Xác thực USDC Issuer

USDC trên Stellar mainnet được issue bởi Circle:

**Official USDC Issuer (Mainnet):**
```
GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3
```

**Verification:**
- Check trên StellarExpert: https://stellar.expert/explorer/mainnet/asset/USDC-GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3
- Homepage của USDC: https://www.circle.com/en/usdc

**Testnet Issuer (chỉ để test):**
```
GA6D2QCM3WQM3YQKV6W5HR5TMRIE5X5QJQZ6WESBG7N5VWBNX6QJX3BM
```

---

## Kiểm tra kết nối

### Health Check API

Chạy health check để xác nhận Stellar connection:

```bash
curl http://localhost:3000/api/health
```

Hoặc truy cập: http://localhost:3000/api/health

Output mong đợi khi đã cấu hình mainnet:

```json
{
  "stellar": {
    "healthy": true,
    "network": "mainnet",
    "senderAccount": "G...your_account...",
    "senderBalanceUSDC": 150.50,
    "senderBalanceXLM": 5.23,
    "horizonConnected": true,
    "errors": []
  }
}
```

### Stellar Service Health

Chạy payout service health check:

```bash
curl http://localhost:3000/api/payouts/health \
  -H "Authorization: Bearer ADMIN_TOKEN"
```

Hoặc dùng Node script:

```bash
npx tsx -e "
import { createStellarService } from './src/lib/payouts/stellar-service';
const service = createStellarService();
const health = await service.healthCheck();
console.log(JSON.stringify(health, null, 2));
"
```

---

## Admin Settings - Network Switch

ApexOS admin panel có Network Switch để dễ dàng chuyển đổi giữa testnet và mainnet.

### Truy cập Admin Settings

1. Đăng nhập với tài khoản admin
2. Vào `/admin/settings` menu
3. Chọn tab **"Stellar"** từ settings navigation

Hoặc truy cập trực tiếp: `https://your-app.pages.dev/[locale]/admin/settings/stellar`

### Network Switch UI

Trang Stellar Settings hiển thị:

1. **Network Selection** - Radio buttons để chọn testnet/mainnet
2. **Configuration** - Horizon URL (read-only default, có thể edit cho custom)
3. **USDC Issuer** - Hiển thị issuer address (copy button available)
4. **Wallet Configuration** - Hướng dẫn setup wallet
5. **Connection Status** - Real-time health check:
   - Horizon connection status
   - Sender account ID
   - USDC balance
   - XLM balance (for fees)
   - Errors (nếu có)
6. **Test Connection** button - Kiểm tra kết nối trước khi lưu
7. **Save Configuration** button - Lưu network setting

### Cập nhật network qua Admin UI

1. Toggle chọn **mainnet**
2. (Optional) Edit Horizon URL nếu dùng custom endpoint
3. Click **"Test Connection"** để verify
4. Click **"Save Configuration"**
5. System sẽ lưu cấu hình mới vào KV storage

**Lưu ý:** Thay đổi network chỉ có hiệu lực sau khi lưu. Env vars `STELLAR_NETWORK` vẫn là source of truth cho deployments.

### Health Status Indicators

- **🟢 Connected**: Horizon reachable, account có balance
- **🟡 Warning**: Horizon reachable nhưng balance thấp hoặc issue
- **🔴 Disconnected**: Không thể kết nối tới Horizon hoặc secret key missing

---

## Test mainnet transaction

**⚠️ QUAN TRỌNG:** Trước khi chạy production payout, hãy test với amount nhỏ.

### Dry Run (không gửi thật)

```bash
curl -X POST http://localhost:3000/api/payouts/run \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true, "limit": 1}'
```

Output:
```json
{
  "success": true,
  "dryRun": true,
  "jobId": "batch_xxx",
  "total": 1,
  "successful": 1,
  "results": [
    {
      "transactionId": "DRY_RUN_xxx",
      "toAccount": "G...",
      "amount": "10.00",
      "asset": "USDC"
    }
  ]
}
```

### Real Transaction (Small Amount)

1. Tạo affiliate test với wallet address là account của bạn
2. Tạo earning giả (ví dụ: $1.00 USDC)
3. Chạy payout với limit 1:

```bash
curl -X POST http://localhost:3000/api/payouts/run \
  -H "Authorization: Bearer ADMIN_TOKEN" \
  -d '{"limit": 1}'
```

4. Kiểm tra kết quả:
   - Transaction ID được trả về
   - Kiểm tra trên https://stellar.expert/explorer/mainnet/tx/`tx_hash`
   - Verify USDC đã đến wallet của bạn

5. Xác minh trên wallet:
   - Mở xPortal
   - Check USDC balance tăng

---

## Troubleshooting

### Lỗi: "Insufficient USDC balance"

**Nguyên nhân:** Wallet gửi không đủ USDC.

**Giải pháp:**
1. Check balance: https://horizon.stellar.org/accounts/`Gyour_account`
2. Nếu balance USDC = 0, cần gửi thêm USDC vào wallet
3. Ensure account có ít nhất XLM cho phí (≈ 0.003 XLM mỗi giao dịch)

### Lỗi: "Insufficient XLM for fee"

**Nguyên nhân:** Wallet không đủ XLM để pay transaction fee.

**Giải pháp:**
1. Gửi XLM vào wallet (từ exchange hoặc friendbot - chỉ testnet)
2. Minimum: ~0.01 XLM để cover fee và reserve

### Lỗi: "Transaction failed: tx_bad_seq"

**Nguyên nhân:** Sequence number không hợp lệ (account sequence mismatch).

**Giải pháp:**
- Stellar tự động quản lý sequence. Nếu có nhiều transaction đồng thời, có thể xảy ra race condition.
- Wait vài giây rồi thử lại.

### Lỗi: "Account does not exist on network"

**Nguyên nhân:** Wallet address không hợp lệ hoặc account chưa được tạo trên mainnet.

**Giải pháp:**
1. Verify account ID format (bắt đầu bằng `G`, 56 characters)
2. Check account exists: https://horizon.stellar.org/accounts/`Gyour_account`
3. Nếu "404 Not Found", account chưa tồn tại → cần gửi XLM/USDC trước để tạo account

### Lỗi: "No sender account configured"

**Nguyên nhân:** `STELLAR_SECRET_KEY` không được set hoặc rỗng.

**Giải pháp:**
- Check `.env.local` hoặc Cloudflare Pages environment variables
- Đảm bảo secret key hợp lệ (bắt đầu bằng `S`)

### Lỗi: "Horizon connection failed"

**Nguyên nhân:** Không thể kết nối tới Stellar Horizon server.

**Giải pháp:**
1. Check internet connection
2. Verify horizon URL: `https://horizon.stellar.org` (mainnet)
3. Test: `curl https://horizon.stellar.org`
4. Nếu timeout, có thể network issue hoặc Cloudflare block

### Lỗi: "USDC issuer mismatch"

**Nguyên nhân:** Custom `STELLAR_USDC_ISSUER` không khớp với USDC issuer chính thức.

**Giải phảm:**
- Xóa `STELLAR_USDC_ISSUER` env var để dùng default
- Hoặc set chính xác: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3`

### Lỗi: "Asset not authorized" (Trustline)

**Nguyên nhân:** Wallet của recipient chưa "trust" USDC asset.

**Giải pháp:**
- Trên Stellar, để nhận USDC, recipient phải tạo trustline tới USDC issuer.
- xPortal tự động tạo trustline khi nhận USDC lần đầu.
- Nếu dùng custom wallet, cần manually add trustline:
  ```bash
  # Using Stellar SDK
  builder.appendTrustLineAssetChange(
    new stellar.Asset('USDC', 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3')
  );
  ```

---

## Kiểm tra final checklist

- [ ] Stellar wallet đã tạo (có Secret Key)
- [ ] USDC đã gửi vào wallet (balance > 0)
- [ ] XLM đã có trong wallet (≥ 0.01 cho phí)
- [ ] `.env.local` có `STELLAR_SECRET_KEY` và `STELLAR_NETWORK=mainnet`
- [ ] Cloudflare Pages environment variables đã update (nếu deploy)
- [ ] Health check API trả về `healthy: true`
- [ ] Dry run payout thành công
- [ ] Small real transaction (≤ $1) thành công
- [ ] Admin settings Network Switch đang ở "mainnet"

---

## Thông tin tham khảo

### Stellar Resources

- Horizon API (mainnet): https://horizon.stellar.org
- Stellar Laboratory: https://laboratory.stellar.org
- StellarExpert Explorer: https://stellar.expert/explorer/mainnet
- xPortal Wallet: https://xportal.app
- Stellar Docs: https://developers.stellar.org

### USDC on Stellar

- Issuer: `GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGZX3UPOJ2FJ3FNB6DK6L3`
- Asset Code: `USDC`
- Network: Stellar Mainnet
- Official: https://www.circle.com/en/usdc

### ApexOS Code References

- Stellar Service: `src/lib/payouts/stellar-service.ts`
- Wallet Utils: `src/lib/wallet/wallet-utils.ts`
- Environment Example: `.env.production.example`
- Admin Settings: `src/app/[locale]/admin/settings/`

---

## Support

Nếu gặp vấn đề:

1. Check logs: `tail -f .hermes/logs/errors.log`
2. Run health check và đính kèm output
3. Verify transaction trên Stellar Expert
4. Liên hệ admin team hoặc tạo issue trong GitHub

---

**Last Updated:** 2026-06-24  
**Status:** Ready for Mainnet
