import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { ArrowLeft, FileText, Scale, ShieldCheck } from 'lucide-react';

interface LegalPageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

interface TermsSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
}

interface TermsCopy {
  readonly badge: string;
  readonly title: string;
  readonly effectiveDate: string;
  readonly intro: string;
  readonly backToLanding: string;
  readonly navTerms: string;
  readonly navNonCustodial: string;
  readonly navGeo: string;
  readonly sections: readonly TermsSection[];
}

const TERMS_COPY: Readonly<Record<'en' | 'vi', TermsCopy>> = {
  en: {
    badge: 'Legal & Regulatory Perimeter · Terms of Service',
    title: 'Terms of Service',
    effectiveDate: 'Effective Date: November 15, 2026 · Version 2.0 (Ascendancy Audit)',
    intro:
      'These Terms of Service govern access to ApexOS, a commercial affiliate marketing attribution and non-custodial trading-fee rebate analytics platform.',
    backToLanding: 'Back to Landing',
    navTerms: 'Terms of Service',
    navNonCustodial: 'Non-Custodial Disclosure',
    navGeo: 'Geo-Restriction Notice',
    sections: [
      {
        heading: '1. Commercial Nature & Regulatory Perimeter',
        paragraphs: [
          'ApexOS operates exclusively as a commercial affiliate marketing, partner UID attribution, and B2B Proof-of-Rebate analytics software platform.',
          'ApexOS is NOT a digital-asset exchange, broker-dealer, custodian, fiduciary, investment advisor, trading-signal provider, automated order-execution service, or money transmitter. Nothing on ApexOS constitutes financial, investment, legal, or tax advice.',
        ],
      },
      {
        heading: '2. UID-Only Attribution & Non-Custodial Scope',
        paragraphs: [
          'Participation requires linking only a public exchange User ID (UID) registered under an official ApexOS institutional partner code on supported partner exchanges (Bybit, OKX, Bitget, and onboarding partner venues KuCoin and Gate.io).',
          'Users never deposit funds with ApexOS and never submit exchange trading API keys, withdrawal keys, or wallet seed phrases.',
        ],
      },
      {
        heading: '3. CASH_COLLECTED Verification & T+7 Clawback Settlement Rules',
        paragraphs: [
          'Exchange fee rebates are contingent upon actual partner commission receipt from the originating exchange.',
        ],
        bullets: [
          'No ledger entry becomes payable until the underlying exchange partner statement is cryptographically reconciled to CASH_COLLECTED status in the 10^-8 USD double-entry ledger.',
          'All verified rebates are subject to a mandatory T+7 calendar-day settlement hold and a 5% clawback reserve to absorb post-trade exchange fee adjustments, institutional VIP tier recalculations, or wash-trade reversals.',
          'Under Safe-Spread Waterfall I4 (DEFAULT_WATERFALL_CONFIG), verified gross partner commissions allocate 5.00% (rounded up) to the Clawback Reserve, 50.00% of the 95.00% post-reserve Distributable Pool (47.50% effective gross) to Direct Trader Cashback, 30.00% of the remaining Platform Spread (14.25% effective gross) to L1 Direct Partner Commission, 0.00% by default (up to 10.00% of Spread / 4.75% effective gross under an active B2B Agency Contract) to L2 Sub-Partner Override, and the exact remainder (33.25% default / 28.50% with max L2) to Platform Operations.',
        ],
      },
      {
        heading: '4. Multi-Chain Self-Custody USDC Payouts & 48-Hour Wallet Timelock',
        paragraphs: [
          'Eligible unlocked balances are disbursed exclusively in USD Coin (USDC) directly to a user-designated self-custody wallet address.',
        ],
        bullets: [
          'Supported settlement networks: Stellar, Arbitrum, and Base.',
          'Minimum payout threshold: $10.00 USDC (1,000,000,000 ledger units at 10^-8 USD scale). Accrued balances below $10.00 USDC roll forward without expiration.',
          'Mandatory 48-Hour Wallet-Change Timelock: Any registration or modification of a payout destination address triggers an automatic 48-hour disbursement freeze and security notification to prevent unauthorized account-takeover drainage.',
        ],
      },
      {
        heading: '5. Strict 2-Level (L1 / L2) Partner Cap',
        paragraphs: [
          'Commercial partner revenue sharing is strictly capped at two levels: Direct Referring Partner (L1, 30% of Platform Spread / 14.25% effective gross) and Provisioned B2B Agency Sub-Partner Override (L2, 0% default; capped at 10% of Platform Spread / 4.75% effective gross, with combined L1 + L2 capped at 45% of Spread).',
          'Multi-level marketing (MLM) structures of three or more tiers (L3+) are permanently disabled in ledger code in compliance with commercial agency regulations, including Vietnam Decree 40/2018/ND-CP.',
        ],
      },
      {
        heading: '6. M2 Sybil, Wash-Trading & Self-Referral Prohibition',
        paragraphs: [
          'Self-referral, circular account rings, wash trading, synthetic volume generation, and M2 Sybil multi-accounting designed to extract both Direct Trader Cashback and L1/L2 Partner Commissions on controlled accounts are strictly prohibited.',
          'Accounts flagged by deterministic graph-cycle detection, shared payout-wallet clustering, or exchange partner compliance audits are subject to immediate rebate forfeiture, ledger quarantine, and permanent termination.',
        ],
      },
    ],
  },
  vi: {
    badge: 'Hành Lang Pháp Lý & Tuân Thủ · Điều Khoản Dịch Vụ',
    title: 'Điều Khoản Dịch Vụ (Terms of Service)',
    effectiveDate: 'Ngày hiệu lực: 15/11/2026 · Phiên bản 2.0 (Ascendancy Audit)',
    intro:
      'Điều khoản Dịch vụ này điều chỉnh việc truy cập và sử dụng ApexOS — nền tảng công nghệ phân tích dữ liệu hoàn phí giao dịch không lưu ký và tiếp thị liên kết thương mại.',
    backToLanding: 'Quay lại Trang chủ',
    navTerms: 'Điều Khoản Dịch Vụ',
    navNonCustodial: 'Công Bố Không Lưu Ký',
    navGeo: 'Thông Báo Giới Hạn Lãnh Thổ',
    sections: [
      {
        heading: '1. Bản Chất Thương Mại & Ranh Giới Pháp Lý',
        paragraphs: [
          'ApexOS hoạt động thuần túy như một nền tảng phần mềm tiếp thị liên kết thương mại (affiliate marketing), đối soát định danh UID đối tác và phân tích bằng chứng hoàn phí B2B (Proof-of-Rebate).',
          'ApexOS KHÔNG PHẢI là sàn giao dịch tài sản số, công ty môi giới chứng khoán, tổ chức lưu ký, đơn vị nhận ủy thác, tổ chức tư vấn đầu tư, nhà cung cấp tín hiệu giao dịch, công cụ đặt lệnh tự động hay tổ chức trung gian thanh toán/chuyển tiền. Mọi thông tin trên ApexOS không phải là lời khuyên tài chính, đầu tư, pháp lý hoặc thuế.',
        ],
      },
      {
        heading: '2. Đối Soát Chỉ Bằng UID & Phạm Vi Không Lưu Ký',
        paragraphs: [
          'Người dùng chỉ liên kết mã định danh công khai trên sàn (UID) đã đăng ký dưới mã đối tác tổ chức của ApexOS tại các sàn hỗ trợ (Bybit, OKX, Bitget và các sàn đang tích hợp đối tác KuCoin, Gate.io).',
          'Người dùng tuyệt đối không nạp tiền vào ApexOS và không bao giờ cung cấp API Key đặt lệnh, khóa rút tiền hay cụm từ khôi phục ví (seed phrase).',
        ],
      },
      {
        heading: '3. Quy Tắc Xác Thực CASH_COLLECTED & Quyết Toán Chống Clawback T+7',
        paragraphs: [
          'Khoản hoàn phí giao dịch chỉ phát sinh khi ApexOS thực tế nhận được hoa hồng đối tác từ sàn giao dịch gốc.',
        ],
        bullets: [
          'Không bút toán sổ cái nào được phép chi trả cho đến khi sao kê đối tác từ sàn được đối chiếu mật mã học sang trạng thái CASH_COLLECTED trên sổ cái kép chuẩn số nguyên 10^-8 USD.',
          'Mọi khoản hoàn phí hợp lệ đều áp dụng thời gian chờ quyết toán bắt buộc T+7 ngày lịch và trích lập 5% Quỹ Dự Phòng Clawback để bảo vệ hệ thống trước các khoản thu hồi phí sau giao dịch hoặc điều chỉnh bậc VIP từ sàn.',
          'Theo công thức Safe-Spread Waterfall I4 (DEFAULT_WATERFALL_CONFIG), 100% tổng hoa hồng đối tác được phân bổ: 5.00% (làm tròn lên) Quỹ dự phòng Clawback, 50.00% trên 95.00% Quỹ phân bổ sau dự phòng (tương đương 47.50% tổng hoa hồng) Hoàn phí trực tiếp cho Trader, 30.00% trên phần Platform Spread còn lại (tương đương 14.25% tổng hoa hồng) Hoa hồng đối tác trực tiếp L1, mặc định 0.00% (tối đa 10.00% Spread / 4.75% tổng hoa hồng theo Hợp đồng Đại lý B2B đang hiệu lực) Hoa hồng đối tác phụ L2, và phần dư chính xác (33.25% mặc định / 28.50% khi tối đa L2) cho Vận hành nền tảng.',
        ],
      },
      {
        heading: '4. Thanh Toán USDC Đa Chuỗi Tự Quản & Khóa An Toàn 48 Giờ',
        paragraphs: [
          'Số dư khả dụng sau kỳ T+7 được chi trả hoàn toàn bằng USD Coin (USDC) trực tiếp về địa chỉ ví tự quản (self-custody wallet) do người dùng chỉ định.',
        ],
        bullets: [
          'Mạng lưới thanh toán hỗ trợ: Stellar, Arbitrum và Base.',
          'Hạn mức thanh toán tối thiểu: $10.00 USDC (1,000,000,000 đơn vị sổ cái ở thang 10^-8 USD). Số dư dưới $10.00 USDC được bảo lưu cộng dồn sang kỳ tiếp theo.',
          'Khóa An Toàn 48 Giờ Khi Đổi Ví (48-Hour Wallet Timelock): Mọi thao tác thêm mới hoặc thay đổi địa chỉ ví nhận USDC đều kích hoạt chế độ tạm khóa giải ngân bắt buộc trong 48 giờ kèm cảnh báo bảo mật nhằm ngăn chặn chiếm đoạt tài khoản.',
        ],
      },
      {
        heading: '5. Giới Hạn Cứng Mạng Lưới Đối Tác 2 Tầng (L1 / L2)',
        paragraphs: [
          'Chương trình chia sẻ doanh thu đối tác thương mại bị giới hạn cứng tối đa hai cấp: Đối tác giới thiệu trực tiếp (L1, 30% Platform Spread / 14.25% tổng hoa hồng) và Đại lý đối tác B2B được cấp phép (L2, mặc định 0%; tối đa 10% Platform Spread / 4.75% tổng hoa hồng, tổng L1 + L2 tối đa 45% Spread).',
          'Mọi cấu trúc kinh doanh đa cấp từ 3 tầng trở lên (L3+) đều bị vô hiệu hóa vĩnh viễn trong mã nguồn sổ cái nhằm tuân thủ nghiêm ngặt pháp luật thương mại, bao gồm Nghị định 40/2018/NĐ-CP tại Việt Nam.',
        ],
      },
      {
        heading: '6. Nghiêm Cấm Gian Lận M2 Sybil, Tự Giới Thiệu & Giao Dịch Tạo Khối Lượng Ảo',
        paragraphs: [
          'Nghiêm cấm mọi hành vi tự giới thiệu bản thân (self-referral), lập cụm tài khoản vòng tròn, wash trading hoặc tấn công M2 Sybil đa tài khoản nhằm trục lợi đồng thời khoản hoàn phí Trader và hoa hồng đối tác L1/L2 trên cùng một chủ thể kiểm soát.',
          'Các tài khoản bị phát hiện bởi thuật toán phân tích đồ thị vòng lặp, trùng lặp cụm ví nhận tiền hoặc thông báo vi phạm từ sàn đối tác sẽ bị thu hồi toàn bộ hoàn phí chưa thanh toán, phong tỏa bút toán đối soát và chấm dứt quyền truy cập vĩnh viễn.',
        ],
      },
    ],
  },
};

export async function generateMetadata({
  params,
}: LegalPageProps): Promise<Metadata> {
  const { locale } = await params;
  const resolvedLocale = locale === 'vi' ? 'vi' : 'en';
  const copy = TERMS_COPY[resolvedLocale];

  return {
    title: copy.title,
    description: copy.intro,
  };
}

export default async function TermsOfServicePage({ params }: LegalPageProps) {
  const { locale } = await params;
  const resolvedLocale: 'en' | 'vi' = locale === 'vi' ? 'vi' : 'en';
  setRequestLocale(resolvedLocale);
  const copy = TERMS_COPY[resolvedLocale];

  return (
    <div className="min-h-screen bg-stitch-canvas text-stitch-primary">
      <header className="border-b border-stitch-divider bg-stitch-surface/80 backdrop-blur">
        <div className="max-w-4xl mx-auto px-6 py-4 flex flex-wrap items-center justify-between gap-4">
          <Link
            href={`/${resolvedLocale}/landing`}
            className="inline-flex items-center gap-2 text-sm text-stitch-muted hover:text-stitch-emerald transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>{copy.backToLanding}</span>
          </Link>
          <nav
            aria-label="Legal navigation"
            className="flex flex-wrap items-center gap-4 text-xs font-medium"
          >
            <Link
              href={`/${resolvedLocale}/legal/terms`}
              className="text-stitch-emerald"
            >
              {copy.navTerms}
            </Link>
            <Link
              href={`/${resolvedLocale}/legal/non-custodial-disclosure`}
              className="text-stitch-muted hover:text-stitch-primary transition-colors"
            >
              {copy.navNonCustodial}
            </Link>
            <Link
              href={`/${resolvedLocale}/legal/geo-restriction`}
              className="text-stitch-muted hover:text-stitch-primary transition-colors"
            >
              {copy.navGeo}
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 md:py-16">
        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-stitch-surface border border-stitch-divider text-stitch-emerald text-xs font-mono uppercase tracking-wider mb-4">
            <Scale className="w-3.5 h-3.5" />
            <span>{copy.badge}</span>
          </div>
          <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-stitch-primary mb-2">
            {copy.title}
          </h1>
          <p className="text-xs font-mono text-stitch-muted mb-4">
            {copy.effectiveDate}
          </p>
          <p className="text-base text-stitch-muted leading-relaxed">
            {copy.intro}
          </p>
        </div>

        <div className="space-y-6">
          {copy.sections.map((section) => (
            <section
              key={section.heading}
              className="stitch-obsidian-card p-6 md:p-8 space-y-3"
            >
              <h2 className="text-lg md:text-xl font-semibold text-stitch-primary flex items-center gap-2">
                <FileText className="w-4 h-4 text-stitch-emerald shrink-0" />
                <span>{section.heading}</span>
              </h2>
              {section.paragraphs.map((paragraph) => (
                <p
                  key={paragraph}
                  className="text-sm text-stitch-muted leading-relaxed"
                >
                  {paragraph}
                </p>
              ))}
              {section.bullets && (
                <ul className="space-y-2 pt-2">
                  {section.bullets.map((bullet) => (
                    <li
                      key={bullet}
                      className="flex items-start gap-2.5 text-sm text-stitch-muted leading-relaxed"
                    >
                      <ShieldCheck className="w-4 h-4 text-stitch-emerald shrink-0 mt-0.5" />
                      <span>{bullet}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
