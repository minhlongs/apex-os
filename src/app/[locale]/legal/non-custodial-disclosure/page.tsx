import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { ArrowLeft, CheckCircle2, KeyRound, Lock, Shield } from 'lucide-react';

interface LegalPageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

interface DisclosureSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly bullets?: readonly string[];
}

interface DisclosureCopy {
  readonly badge: string;
  readonly title: string;
  readonly effectiveDate: string;
  readonly intro: string;
  readonly backToLanding: string;
  readonly navTerms: string;
  readonly navNonCustodial: string;
  readonly navGeo: string;
  readonly guaranteeHeadline: string;
  readonly guaranteeItems: readonly string[];
  readonly sections: readonly DisclosureSection[];
}

const DISCLOSURE_COPY: Readonly<Record<'en' | 'vi', DisclosureCopy>> = {
  en: {
    badge: 'Technical Security Guarantee · Non-Custodial Architecture',
    title: 'Non-Custodial & Technical Architecture Disclosure',
    effectiveDate: 'Effective Date: November 15, 2026 · Architecture Revision I4',
    intro:
      'This disclosure documents the cryptographic, key-management, and accounting boundaries that guarantee ApexOS cannot access, trade, or withdraw user exchange funds.',
    backToLanding: 'Back to Landing',
    navTerms: 'Terms of Service',
    navNonCustodial: 'Non-Custodial Disclosure',
    navGeo: 'Geo-Restriction Notice',
    guaranteeHeadline: 'Absolute Non-Custodial Guarantee',
    guaranteeItems: [
      'ApexOS NEVER requests, accepts, stores, or uses user exchange trade API keys or withdrawal API secrets.',
      'ApexOS NEVER requests or stores wallet private keys, mnemonic seed phrases, or recovery credentials.',
      'ApexOS NEVER holds custodial user deposits, margin balances, or pooled client trading capital.',
    ],
    sections: [
      {
        heading: '1. Read-Only Institutional Partner UID Attribution',
        paragraphs: [
          'User attribution relies strictly on the public numeric Exchange User ID (UID) associated with an official ApexOS institutional affiliate or broker sub-partner code on Bybit, OKX, Bitget, KuCoin, and Gate.io.',
          'Partner commission telemetry is ingested over ApexOS-owned partner credentials on the server side. Exchanges where standard affiliate endpoints omit deterministic referee UID telemetry (such as Binance Standard Referral Pro without Enterprise Broker status) are hard-blocked in the ingestion registry rather than scraping or requesting user keys.',
        ],
      },
      {
        heading: '2. SHA-256 Cloudflare R2 Evidence Vaulting & PII Redaction',
        paragraphs: [
          'Every ingested partner commission statement and broker wallet receipt is canonicalized, hashed with SHA-256, and archived in an immutable Cloudflare R2 evidence bucket under a 5-year audit retention policy.',
          'Public and B2B Proof-of-Rebate verification payloads expose only masked trader UIDs (for example ***1234), 10^-8 USD integer waterfall splits, payload SHA-256 anchors, and on-chain settlement transaction hashes — never raw UIDs, email addresses, or IP addresses.',
        ],
      },
      {
        heading: '3. Turnkey HSM Treasury Signing & Cold Multisig Segregation',
        paragraphs: [
          'Operational payout liquidity is segregated from user assets and governed by hardware-enforced signing policies:',
        ],
        bullets: [
          'Hot disbursement signing keys reside exclusively inside Turnkey Hardware Security Module (HSM) enclaves; raw private key material is never exported to Cloudflare Workers memory or environment variables.',
          'Administrative treasury configuration and high-value approvals require hardware-bound WebAuthn ES256 passkey step-up authentication.',
          'Excess treasury reserves are held in Safe 2-of-3 cold multisig vaults isolated from automated cron execution.',
        ],
      },
      {
        heading: '4. Direct Self-Custody Multi-Chain USDC Payouts',
        paragraphs: [
          'Once a rebate batch reaches CASH_COLLECTED status and clears the T+7 clawback window, payouts are broadcast directly on-chain in native USDC on Stellar, Arbitrum, or Base to the self-custody wallet address controlled solely by the user.',
          'Destination wallet updates enforce a mandatory 48-hour timelock before any on-chain transfer can target the updated address.',
        ],
      },
    ],
  },
  vi: {
    badge: 'Bảo Chứng Kỹ Thuật · Kiến Trúc Không Lưu Ký',
    title: 'Công Bố Kiến Trúc Kỹ Thuật & Không Lưu Ký',
    effectiveDate: 'Ngày hiệu lực: 15/11/2026 · Kiến trúc phiên bản I4',
    intro:
      'Bản công bố này mô tả chi tiết ranh giới mật mã học, quản trị khóa và sổ cái kế toán nhằm bảo đảm ApexOS tuyệt đối không thể truy cập, đặt lệnh hay rút tài sản của người dùng trên sàn.',
    backToLanding: 'Quay lại Trang chủ',
    navTerms: 'Điều Khoản Dịch Vụ',
    navNonCustodial: 'Công Bố Không Lưu Ký',
    navGeo: 'Thông Báo Giới Hạn Lãnh Thổ',
    guaranteeHeadline: 'Cam Kết Không Lưu Ký Tuyệt Đối',
    guaranteeItems: [
      'ApexOS TUYỆT ĐỐI KHÔNG yêu cầu, tiếp nhận, lưu trữ hay sử dụng API Key giao dịch hoặc khóa API rút tiền của người dùng trên bất kỳ sàn nào.',
      'ApexOS TUYỆT ĐỐI KHÔNG yêu cầu hay lưu trữ khóa riêng tư (private key), cụm từ khôi phục ví (seed phrase) hoặc thông tin truy cập tài khoản sàn.',
      'ApexOS TUYỆT ĐỐI KHÔNG nhận tiền gửi lưu ký, ký quỹ giao dịch hay gom vốn đầu tư của khách hàng dưới mọi hình thức.',
    ],
    sections: [
      {
        heading: '1. Đối Soát Chỉ Đọc Qua UID Đối Tác Tổ Chức',
        paragraphs: [
          'Việc ghi nhận hoàn phí chỉ dựa trên mã số định danh công khai trên sàn (UID) đã gắn với mã đối tác tổ chức chính thức của ApexOS tại Bybit, OKX, Bitget, KuCoin và Gate.io.',
          'Dữ liệu hoa hồng được đồng bộ từ phía máy chủ thông qua tài khoản đối tác của chính ApexOS. Đối với các chương trình thiếu dữ liệu định danh UID người dùng (như Binance Standard Referral Pro khi chưa có hợp đồng Enterprise Broker), hệ thống chủ động khóa cứng bộ kết nối thay vì thu thập khóa cá nhân hay cào dữ liệu trái phép.',
        ],
      },
      {
        heading: '2. Lưu Trữ Bằng Chứng R2 Băm SHA-256 & Ẩn Danh Hóa Dữ Liệu',
        paragraphs: [
          'Mọi bảng kê hoa hồng từ sàn và sao kê ví đối tác đều được chuẩn hóa, băm mật mã học SHA-256 và lưu trữ bất biến trong kho bằng chứng Cloudflare R2 với thời hạn lưu trữ kiểm toán 5 năm.',
          'Chứng từ Proof-of-Rebate dành cho đối tác B2B chỉ hiển thị UID đã che định danh (ví dụ ***1234), tỷ lệ phân bổ số nguyên 10^-8 USD, mã băm SHA-256 của sao kê gốc và mã giao dịch (tx hash) trên chuỗi — hoàn toàn không lộ UID gốc, email hay địa chỉ IP.',
        ],
      },
      {
        heading: '3. Ký Số Kho Bạc Bằng Turnkey HSM & Đa Chữ Ký Lạnh Safe 2-of-3',
        paragraphs: [
          'Nguồn vốn thanh toán hoàn phí vận hành tách biệt hoàn toàn và được kiểm soát bởi chính sách phần cứng nghiêm ngặt:',
        ],
        bullets: [
          'Khóa ký giải ngân tự động nằm hoàn toàn bên trong vùng an toàn phần cứng Turnkey HSM; khóa riêng tư không bao giờ xuất hiện trong bộ nhớ Cloudflare Workers hay biến môi trường.',
          'Mọi thao tác quản trị nhạy cảm đều bắt buộc xác thực bước hai bằng khóa phần cứng WebAuthn Passkey chuẩn ES256.',
          'Ngân quỹ dự trữ được bảo vệ trong kho lạnh đa chữ ký Safe 2-of-3 tách rời khỏi tiến trình giải ngân tự động.',
        ],
      },
      {
        heading: '4. Chi Trả USDC Đa Chuỗi Trực Tiếp Về Ví Tự Quản',
        paragraphs: [
          'Sau khi bút toán đạt trạng thái CASH_COLLECTED và hoàn tất thời gian chờ T+7 chống clawback, USDC được chuyển trực tiếp trên chuỗi qua mạng Stellar, Arbitrum hoặc Base đến địa chỉ ví tự quản do chính người dùng nắm giữ khóa riêng.',
          'Mọi yêu cầu thay đổi địa chỉ ví nhận tiền đều phải trải qua khóa an toàn 48 giờ trước khi hệ thống cho phép phát lệnh giải ngân mới.',
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
  const copy = DISCLOSURE_COPY[resolvedLocale];

  return {
    title: copy.title,
    description: copy.intro,
  };
}

export default async function NonCustodialDisclosurePage({
  params,
}: LegalPageProps) {
  const { locale } = await params;
  const resolvedLocale: 'en' | 'vi' = locale === 'vi' ? 'vi' : 'en';
  setRequestLocale(resolvedLocale);
  const copy = DISCLOSURE_COPY[resolvedLocale];

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
              className="text-stitch-muted hover:text-stitch-primary transition-colors"
            >
              {copy.navTerms}
            </Link>
            <Link
              href={`/${resolvedLocale}/legal/non-custodial-disclosure`}
              className="text-stitch-emerald"
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
            <KeyRound className="w-3.5 h-3.5" />
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

        {/* Highlighted Non-Custodial Guarantee Banner */}
        <section className="p-6 md:p-8 rounded-xl bg-stitch-well border border-stitch-emerald/60 mb-8 space-y-3">
          <div className="flex items-center gap-2 text-base font-semibold text-stitch-emerald">
            <Shield className="w-5 h-5" />
            <h2>{copy.guaranteeHeadline}</h2>
          </div>
          <ul className="space-y-2.5">
            {copy.guaranteeItems.map((item) => (
              <li
                key={item}
                className="flex items-start gap-2.5 text-sm text-stitch-primary leading-relaxed"
              >
                <CheckCircle2 className="w-4 h-4 text-stitch-emerald shrink-0 mt-0.5" />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>

        <div className="space-y-6">
          {copy.sections.map((section) => (
            <section
              key={section.heading}
              className="stitch-obsidian-card p-6 md:p-8 space-y-3"
            >
              <h2 className="text-lg md:text-xl font-semibold text-stitch-primary flex items-center gap-2">
                <Lock className="w-4 h-4 text-stitch-cyan shrink-0" />
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
                      <CheckCircle2 className="w-4 h-4 text-stitch-cyan shrink-0 mt-0.5" />
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
