export interface QuantInsightArticle {
  slug: string;
  publishedAt: string;
  readingTimeMinutes: number;
  category: 'microstructure' | 'security' | 'liquidity';
  tags: string[];
  metricsHighlight: {
    bps: string;
    exchanges: string[];
    settlement: string;
  };
  title: {
    vi: string;
    en: string;
  };
  summary: {
    vi: string;
    en: string;
  };
  sections: Array<{
    heading: { vi: string; en: string };
    content: { vi: string; en: string };
    callout?: { vi: string; en: string };
  }>;
}

export const QUANT_INSIGHT_ARTICLES: readonly QuantInsightArticle[] = [
  {
    slug: 'basis-point-fee-drag-quant-execution',
    publishedAt: '2026-10-26T08:00:00.000Z',
    readingTimeMinutes: 7,
    category: 'microstructure',
    tags: ['Fee Drag', 'Basis Points', 'Sharpe Ratio', 'Futures Taker'],
    metricsHighlight: {
      bps: '2.7 – 12.0 bps',
      exchanges: ['Binance', 'Bybit', 'OKX', 'KuCoin'],
      settlement: 'Stellar USDC',
    },
    title: {
      vi: 'Giải Phẫu Lực Cản Phí (Fee Drag) Theo Điểm Cơ Bản (bps) Trong Giao Dịch Định Lượng',
      en: 'Anatomy of Basis-Point (bps) Fee Drag in Quantitative Execution',
    },
    summary: {
      vi: 'Cách thu hồi 2.7 đến 12.0 bps chi phí Taker/Maker làm thay đổi kỳ vọng toán học (Expected Value) và nâng đường cong vốn (Equity Curve) mà không cần tăng đòn bẩy.',
      en: 'How recovering 2.7 to 12.0 bps of Taker/Maker friction shifts mathematical expectancy and lifts portfolio Sharpe without adding directional risk.',
    },
    sections: [
      {
        heading: {
          vi: '1. Toán Học Của Lực Cản Phí: Kẻ Thù Thầm Lặng Của Hệ Thống Scalping & High-Frequency',
          en: '1. The Compounding Math of Execution Drag',
        },
        content: {
          vi: 'Trong giao dịch phái sinh tiền mã hóa, phần lớn các thuật toán trung bình tạo ra alpha biên từ 8 đến 25 điểm cơ bản (bps) trên mỗi vòng quay vốn. Tuy nhiên, mức phí Taker tiêu chuẩn tại Binance (4–5 bps), Bybit (5.5 bps), OKX (5 bps) và KuCoin (6 bps) có thể ngốn tới 40%–60% tổng lợi nhuận gộp. Khi khối lượng giao dịch đạt 10M USD/tháng, 5 bps phí tương đương 5,000 USD thất thoát mỗi tháng — tức 60,000 USD/năm.',
          en: 'In crypto derivatives, most high-turnover algorithms capture a raw edge of 8 to 25 basis points (bps) per round-trip. However, standard taker fees across Binance, Bybit, OKX, and KuCoin consume 40%–60% of gross edge. On a modest $10M monthly turnover, a 5 bps drag represents $5,000 in monthly leakage — over $60,000 annualized.',
        },
        callout: {
          vi: 'Công thức: EV_net = WinRate * AvgWin - LossRate * AvgLoss - RoundTripFees_bps. Thu hồi 4 bps hoàn phí làm tăng trực tiếp EV ròng thêm +16% tới +32%.',
          en: 'Formula: EV_net = WinRate * AvgWin - LossRate * AvgLoss - RoundTripFees_bps. A 4 bps rebate increases net algorithmic expectancy by +16% to +32%.',
        },
      },
      {
        heading: {
          vi: '2. Ma Trận Chênh Lệch Phí Giữa 4 Sàn Lớn (Arbitrage & Rebate Matrix)',
          en: '2. Four-Exchange Liquidity & Fee Arbitrage Matrix',
        },
        content: {
          vi: 'Bằng cách kết hợp dữ liệu realtime từ Binance, Bybit, OKX và KuCoin, ApexOS định tuyến và đối khớp khối lượng thực tế của bạn với mức hoàn phí tối ưu: Bybit hoàn tới 50% phí, Binance 45%, OKX 42% và KuCoin 40%. Đối với một bàn giao dịch quy mô vừa ($250k volume/tháng), mức tiết kiệm ròng đạt tối thiểu $810/năm.',
          en: 'By streaming live fee telemetry across Binance, Bybit, OKX, and KuCoin, ApexOS matches trade flow to optimal tier rebates: up to 50% on Bybit, 45% on Binance, 42% on OKX, and 40% on KuCoin. A desk turning over just $250k monthly saves a guaranteed $810/year.',
        },
      },
      {
        heading: {
          vi: '3. Tái Đầu Tư Hoàn Phí: Biến Chi Phí Chìm Thành Alpha Tích Lũy',
          en: '3. Capitalizing Rebates into Compounding Growth',
        },
        content: {
          vi: 'Thay vì coi phí giao dịch là chi phí mất đi vĩnh viễn, khoản hoàn phí được tất toán trực tiếp bằng Stellar USDC về ví của bạn hàng tuần. Khoản vốn này có thể tái phân bổ vào margin giao dịch hoặc hưởng lợi tức staking, tạo ra hiệu ứng lãi kép cho toàn bộ danh mục.',
          en: 'Rather than treating trading fees as dead friction, weekly automated Stellar USDC rebates return liquid settlement directly to your designated treasury, compounding margin resilience across market cycles.',
        },
      },
    ],
  },
  {
    slug: 'zero-secret-api-key-id-verification-architecture',
    publishedAt: '2026-10-26T08:30:00.000Z',
    readingTimeMinutes: 6,
    category: 'security',
    tags: ['Zero-Secret', 'API Key ID', 'HMAC Webhook', 'Sub-Second Attribution'],
    metricsHighlight: {
      bps: '< 1s Attribution',
      exchanges: ['Binance', 'Bybit', 'OKX', 'KuCoin'],
      settlement: 'Non-Custodial',
    },
    title: {
      vi: 'Kiến Trúc Xác Thực Zero-Secret API Key ID: Đối Soát Khối Lượng Dưới 1 Giây Không Rủi Ro Lưu Ký',
      en: 'Zero-Secret API Key ID Verification: Sub-Second Attribution Without Custodial Risk',
    },
    summary: {
      vi: 'Tại sao các quỹ định lượng và nhà giao dịch tổ chức tuyệt đối không giao Secret Key hay quyền rút tiền — và cơ chế đối soát public Key ID của ApexOS bảo vệ tài sản ra sao.',
      en: 'Why quantitative desks strictly reject platforms demanding API Secrets or withdrawal rights — and how ApexOS uses public read-only Key IDs for trade attribution.',
    },
    sections: [
      {
        heading: {
          vi: '1. Nghịch Lý Bảo Mật Trong Mô Hình Copy-Trading Truyền Thống',
          en: '1. The Custodial Dilemma of Legacy Copy-Trading Platforms',
        },
        content: {
          vi: 'Các nền tảng copy-trading cũ thường yêu cầu người dùng cung cấp API Secret với quyền Trade (đặt lệnh), thậm chí một số dịch vụ mờ ám còn yêu cầu quyền Transfer hoặc nạp tiền vào ví sàn nội bộ. Đây là lỗ hổng chí mạng: nếu máy chủ bên thứ ba bị xâm nhập, kẻ tấn công có thể thao túng thanh khoản cặp coin rác (wash-trading) để rút cạn tài khoản của người dùng.',
          en: 'Legacy copy platforms demand full Trade permissions and API Secrets, exposing accounts to catastrophic counterparty risk through key leaks or synthetic wash-trading. Institutional capital strictly prohibits sharing private keys with third-party servers.',
        },
        callout: {
          vi: 'Nguyên tắc bất biến của ApexOS: Không bao giờ yêu cầu API Secret. Không bao giờ yêu cầu quyền Trade hoặc Withdraw. Chỉ liên kết định danh công khai API Key ID.',
          en: 'ApexOS Invariant: Zero API Secrets collected. Zero Trade permissions. Zero Withdrawal access. Only public, read-only API Key IDs.',
        },
      },
      {
        heading: {
          vi: '2. Cơ Chế Đối Soát Lệnh Dưới 1 Giây Qua Webhook HMAC-SHA256',
          en: '2. Sub-Second HMAC Webhook Matching Engine',
        },
        content: {
          vi: 'Khi lệnh của bạn khớp trên Binance, Bybit, OKX hoặc KuCoin, sàn giao dịch sẽ bắn một webhook có chữ ký HMAC-SHA256 đến endpoint của ApexOS. Hệ thống bóc tách public API Key ID và mã liên kết (Affiliate UID), đối chiếu với cây đối tác 3 tầng trong vòng chưa tới 1 giây và ghi nhận hoàn phí vào sổ cái kép D1.',
          en: 'When your order fills on exchange matching engines, signed HMAC-SHA256 trade webhooks hit ApexOS edge routes. The matcher extracts the public Key ID and affiliate UID, resolving 3-tier attribution in under one second on Cloudflare Workers D1.',
        },
      },
      {
        heading: {
          vi: '3. Xác Thực Chuẩn Biểu Thức Chính Quy Regex Chặt Chẽ',
          en: '3. Regex Sanitization & Isolation Bounds',
        },
        content: {
          vi: 'Mọi chuỗi Key ID nhập vào đều được lọc qua biểu thức chính quy /^[A-Za-z0-9_-]{6,128}$/. Hệ thống mã hóa định danh và chỉ sử dụng cho mục đích tra cứu sự kiện khớp lệnh (read-only execution logs), đảm bảo an toàn tuyệt đối 100% trước mọi nguy cơ chiếm đoạt tài khoản.',
          en: 'All bound Key IDs pass strict validation /^[A-Za-z0-9_-]{6,128}$/. Values remain purely metadata pointers for webhook event deduplication, preserving total non-custodial integrity.',
        },
      },
    ],
  },
  {
    slug: 'multi-tier-liquidity-attribution-30-10-5-usdc-settlement',
    publishedAt: '2026-10-26T09:00:00.000Z',
    readingTimeMinutes: 8,
    category: 'liquidity',
    tags: ['3-Tier Desk', 'KOL Economics', 'Stellar USDC', 'Double-Entry Ledger'],
    metricsHighlight: {
      bps: '30% / 10% / 5%',
      exchanges: ['Binance', 'Bybit', 'OKX', 'KuCoin'],
      settlement: 'Weekly Auto-Batch',
    },
    title: {
      vi: 'Kinh Tế Học Bàn Thanh Khoản Đa Tầng (30% / 10% / 5%) & Quyết Toán Stellar USDC',
      en: 'Multi-Tier Liquidity Desk Economics (30%/10%/5%) & Automated Stellar USDC Settlement',
    },
    summary: {
      vi: 'Mô hình hóa dòng tiền hoàn phí bền vững cho các Chủ cộng đồng, Quỹ giao dịch Prop và KOL Định chế trên nền sổ cái kế toán kép D1.',
      en: 'Sustainable multi-tier liquidity revenue architecture for Trading Communities, Prop Desks, and Institutional KOLs powered by double-entry D1 accounting.',
    },
    sections: [
      {
        heading: {
          vi: '1. Vượt Qua Mô Hình Chia Sẻ Doanh Thu Đơn Tầng Truyền Thống',
          en: '1. Beyond Single-Tier Retail Affiliate Links',
        },
        content: {
          vi: 'Hầu hết các chương trình affiliate sàn crypto truyền thống chỉ trả hoa hồng một lần hoặc chia sẻ một tầng cố định và thường bị sàn cắt giảm tỷ lệ sau khi thu hút đủ người dùng. Kiến trúc Bàn Thanh khoản 3 Tầng của ApexOS bảo đảm quyền lợi lâu dài: Cấp 1 hưởng 30% doanh thu hoàn phí, Cấp 2 hưởng 10%, và Cấp 3 hưởng 5% từ toàn bộ mạng lưới giao dịch phát sinh.',
          en: 'Conventional exchange affiliate programs lock creators into fragile single-tier links vulnerable to retroactive margin slashing. ApexOS institutes an immutable 3-tier structure: 30% direct Tier 1, 10% Tier 2 sub-affiliates, and 5% Tier 3 network volume.',
        },
        callout: {
          vi: 'Minh họa dòng tiền: Một cộng đồng giao dịch 20M USD/tháng tạo ra khoảng 10,000 USD phí sàn. Mức hoa hồng Tier 1 (30%) mang lại 3,000 USD/tháng (36,000 USD/năm) thu nhập định lượng bền vững.',
          en: 'Cashflow Simulation: A trading desk network generating $20M monthly volume produces ~$10,000 in gross exchange fees. A 30% Tier-1 allocation delivers $3,000 monthly ($36,000/year) in deterministic revenue.',
        },
      },
      {
        heading: {
          vi: '2. Sổ Cái Kế Toán Kép D1 & Kiểm Toán Minh Bạch',
          en: '2. Double-Entry Ledger & D1 Audit Traceability',
        },
        content: {
          vi: 'Mỗi khoản hoa hồng và hoàn phí đều được hạch toán theo nguyên tắc kế toán kép trong bảng `earnings` và `conversions` của SQLite D1. Mọi biến động số dư đều gắn liền với mã giao dịch (Trade ID), thời gian khớp lệnh và tỷ lệ chia sẻ, loại bỏ hoàn toàn tình trạng sai lệch hay gian lận số liệu.',
          en: 'Every rebate and commission credit is logged with double-entry rigor across Cloudflare D1 tables (`earnings`, `conversions`). All entries link immutably to exchange Trade IDs, timestamps, and attribution nodes.',
        },
      },
      {
        heading: {
          vi: '3. Thanh Toán Tức Thì Bằng Stellar USDC & VietQR SePay',
          en: '3. Weekly Automated Stellar USDC & Fiat Rails',
        },
        content: {
          vi: 'Định kỳ hàng tuần, hệ thống gom các khoản hoa hồng đủ điều kiện (ngưỡng tối thiểu 50 USDC) và thực hiện chi trả tự động thông qua blockchain Stellar với phí giao dịch chỉ $0.00001, hoặc tùy chọn nhận tiền mặt qua cổng VietQR SePay nội địa.',
          en: 'Weekly batch payouts settle eligible balances (minimum $50 USDC) directly via the high-speed Stellar blockchain with sub-cent network fees, or via localized automated banking rails.',
        },
      },
    ],
  },
] as const;

export function getQuantInsightBySlug(slug: string): QuantInsightArticle | undefined {
  return QUANT_INSIGHT_ARTICLES.find((article) => article.slug === slug);
}
