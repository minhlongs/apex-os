import type { Metadata } from 'next';
import Link from 'next/link';
import { setRequestLocale } from 'next-intl/server';
import { AlertOctagon, ArrowLeft, Globe, ShieldAlert } from 'lucide-react';
import {
  ADDITIONAL_RESTRICTED_JURISDICTIONS,
  EEA_MEMBER_STATES,
  SANCTIONED_JURISDICTIONS,
} from '@/lib/compliance/geo-fence';

interface LegalPageProps {
  readonly params: Promise<{ readonly locale: string }>;
}

interface GeoSection {
  readonly heading: string;
  readonly paragraphs: readonly string[];
  readonly codeBadgeList?: readonly string[];
}

interface GeoCopy {
  readonly badge: string;
  readonly title: string;
  readonly effectiveDate: string;
  readonly intro: string;
  readonly backToLanding: string;
  readonly navTerms: string;
  readonly navNonCustodial: string;
  readonly navGeo: string;
  readonly sections: readonly GeoSection[];
}

const GEO_COPY: Readonly<Record<'en' | 'vi', GeoCopy>> = {
  en: {
    badge: 'Edge Geo-Fencing · HTTP 451 Regulatory Gate',
    title: 'Jurisdictional & Geo-Restriction Notice',
    effectiveDate: 'Effective Date: November 15, 2026 · Edge Gate Policy v2.0',
    intro:
      'ApexOS enforces deterministic edge geo-fencing via Cloudflare cf-ipcountry telemetry and on-chain wallet sanctions screening prior to account onboarding, UID attribution, or USDC settlement.',
    backToLanding: 'Back to Landing',
    navTerms: 'Terms of Service',
    navNonCustodial: 'Non-Custodial Disclosure',
    navGeo: 'Geo-Restriction Notice',
    sections: [
      {
        heading: '1. OFAC & Comprehensive Sanctioned Jurisdictions (Hard-Blocked HTTP 451)',
        paragraphs: [
          'Access, registration, affiliate attribution, and USDC disbursements are strictly prohibited for individuals, entities, or IP addresses located in or organized under comprehensively sanctioned jurisdictions, as well as wallets listed on OFAC SDN, UN, EU, or UK sanctions lists:',
        ],
        codeBadgeList: SANCTIONED_JURISDICTIONS,
      },
      {
        heading: '2. Restricted Retail & Digital-Asset Promotion Jurisdictions',
        paragraphs: [
          'To respect national digital-asset promotion, payment-services, and derivatives marketing regimes (including US federal/state regulations, Singapore MAS PS-G02 guidelines, UK FCA financial-promotion rules, EU MiCA / EEA retail restrictions, and regional restrictions), requests originating from the following ISO-3166 country codes and anonymizing Tor exit nodes (T1) receive an automatic HTTP 451 Unavailable For Legal Reasons response at the edge:',
        ],
        codeBadgeList: [
          ...ADDITIONAL_RESTRICTED_JURISDICTIONS,
          ...EEA_MEMBER_STATES,
          'T1',
        ],
      },
      {
        heading: '3. Vietnam Resolution 05/2025/NQ-CP Compliance Posture & Emergency Circuit Breaker',
        paragraphs: [
          'In alignment with Vietnam Government Resolution 05/2025/NQ-CP on the piloted digital-asset regulatory framework and Vietnam Decree 40/2018/ND-CP on commercial agency boundaries, ApexOS operates purely as non-custodial affiliate analytics software (never a domestic exchange, order-matching venue, or 3-tier MLM network).',
          'Edge traffic from Vietnam is continuously evaluated via the Cloudflare cf-ipcountry header alongside the runtime administrative circuit breaker BLOCK_VN_SIGNUPS stored in D1 system configuration. When BLOCK_VN_SIGNUPS is activated in response to regulatory directives under Resolution 05/2025/NQ-CP, new Vietnam account signups, onboarding, UID attribution links, and referral clicks immediately return HTTP 451 (GEO_RESTRICTED_VN_KILLSWITCH), while allowing existing users to sign in and withdraw accrued unlocked self-custody balances.',
        ],
      },
      {
        heading: '4. Prohibition of VPN, Proxy, or Tor Circumvention',
        paragraphs: [
          'Users may not use virtual private networks (VPNs), proxy relays, Tor exit nodes (cf-ipcountry = T1), or falsified residency declarations to circumvent edge geo-fencing. Circumvention attempts constitute a material breach of the Terms of Service and trigger immediate compliance hold.',
        ],
      },
    ],
  },
  vi: {
    badge: 'Kiểm Soát Lãnh Thổ Tại Biên · Cổng Pháp Lý HTTP 451',
    title: 'Thông Báo Giới Hạn Lãnh Thổ & Tuân Thủ Pháp Lý',
    effectiveDate: 'Ngày hiệu lực: 15/11/2026 · Chính sách Edge Gate v2.0',
    intro:
      'ApexOS thực thi cơ chế chặn địa lý tự động tại biên mạng thông qua trường định danh cf-ipcountry của Cloudflare kết hợp sàng lọc danh sách trừng phạt ví trên chuỗi trước khi cho phép đăng ký, gắn UID hoặc giải ngân USDC.',
    backToLanding: 'Quay lại Trang chủ',
    navTerms: 'Điều Khoản Dịch Vụ',
    navNonCustodial: 'Công Bố Không Lưu Ký',
    navGeo: 'Thông Báo Giới Hạn Lãnh Thổ',
    sections: [
      {
        heading: '1. Các Quốc Gia & Vùng Lãnh Thổ Chịu Lệnh Trừng Phạt Toàn Diện (OFAC)',
        paragraphs: [
          'Nghiêm cấm tuyệt đối việc truy cập, đăng ký tài khoản, ghi nhận hoa hồng liên kết hoặc thanh toán USDC đối với cá nhân, tổ chức hoặc địa chỉ IP thuộc các vùng lãnh thổ chịu lệnh cấm vận toàn diện cũng như các địa chỉ ví nằm trong danh sách trừng phạt OFAC SDN, Liên Hợp Quốc, EU hoặc Vương quốc Anh:',
        ],
        codeBadgeList: SANCTIONED_JURISDICTIONS,
      },
      {
        heading: '2. Khu Vực Hạn Chế Quảng Bá Bán Lẻ Tài Sản Số',
        paragraphs: [
          'Nhằm tuân thủ quy định quản lý quảng bá dịch vụ tài sản số và phái sinh tại từng quốc gia (bao gồm quy định tại Hoa Kỳ, hướng dẫn MAS PS-G02 tại Singapore, quy tắc quảng bá tài chính FCA tại Anh, khung MiCA tại toàn bộ 30 quốc gia EEA và các khu vực hạn chế khác), mọi truy cập từ các mã quốc gia ISO-3166 dưới đây cũng như nút thoát ẩn danh Tor (T1) đều bị từ chối tự động tại biên mạng với mã trạng thái HTTP 451:',
        ],
        codeBadgeList: [
          ...ADDITIONAL_RESTRICTED_JURISDICTIONS,
          ...EEA_MEMBER_STATES,
          'T1',
        ],
      },
      {
        heading: '3. Tuân Thủ Nghị Quyết 05/2025/NQ-CP Tại Việt Nam & Cầu Dao Ngắt Khẩn Cấp',
        paragraphs: [
          'Phù hợp với định hướng quản lý thí điểm thị trường tài sản mã hóa theo Nghị quyết 05/2025/NQ-CP của Chính phủ Việt Nam và Nghị định 40/2018/NĐ-CP về quản lý hoạt động kinh doanh theo phương thức đa cấp, ApexOS chỉ vận hành phần mềm phân tích hoàn phí tiếp thị liên kết không lưu ký (không vận hành sàn khớp lệnh, không lưu ký tài sản và khóa cứng tối đa 2 tầng đối tác).',
          'Lưu lượng truy cập dựa trên header Cloudflare cf-ipcountry được kiểm soát trực tiếp bởi cầu dao khẩn cấp thời gian thực BLOCK_VN_SIGNUPS trong cơ sở dữ liệu cấu hình hệ thống. Khi BLOCK_VN_SIGNUPS được kích hoạt theo yêu cầu tuân thủ pháp lý, toàn bộ luồng đăng ký mới, gắn liên kết giới thiệu và ghi nhận click từ Việt Nam sẽ lập tức trả về HTTP 451 (GEO_RESTRICTED_VN_KILLSWITCH), đồng thời vẫn bảo đảm quyền tất toán về ví tự quản đối với các khoản số dư hợp lệ đã mở khóa trước đó.',
        ],
      },
      {
        heading: '4. Nghiêm Cấm Hành Vi Vượt Rào Địa Lý Qua VPN, Proxy Hoặc Tor',
        paragraphs: [
          'Người dùng không được sử dụng mạng riêng ảo (VPN), máy chủ proxy, mạng ẩn danh Tor (cf-ipcountry = T1) hoặc khai báo sai lệch nơi cư trú để né tránh hệ thống kiểm soát lãnh thổ. Mọi hành vi cố tình vượt rào đều bị xem là vi phạm nghiêm trọng Điều khoản Dịch vụ và bị tạm dừng đối soát ngay lập tức.',
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
  const copy = GEO_COPY[resolvedLocale];

  return {
    title: copy.title,
    description: copy.intro,
  };
}

export default async function GeoRestrictionPage({ params }: LegalPageProps) {
  const { locale } = await params;
  const resolvedLocale: 'en' | 'vi' = locale === 'vi' ? 'vi' : 'en';
  setRequestLocale(resolvedLocale);
  const copy = GEO_COPY[resolvedLocale];

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
              className="text-stitch-muted hover:text-stitch-primary transition-colors"
            >
              {copy.navNonCustodial}
            </Link>
            <Link
              href={`/${resolvedLocale}/legal/geo-restriction`}
              className="text-stitch-emerald"
            >
              {copy.navGeo}
            </Link>
          </nav>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-6 py-12 md:py-16">
        <div className="mb-10">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-stitch-surface border border-stitch-divider text-stitch-amber text-xs font-mono uppercase tracking-wider mb-4">
            <Globe className="w-3.5 h-3.5" />
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
          {copy.sections.map((section, idx) => (
            <section
              key={section.heading}
              className="stitch-obsidian-card p-6 md:p-8 space-y-3"
            >
              <h2 className="text-lg md:text-xl font-semibold text-stitch-primary flex items-center gap-2">
                {idx === 0 ? (
                  <AlertOctagon className="w-4 h-4 text-stitch-crimson shrink-0" />
                ) : (
                  <ShieldAlert className="w-4 h-4 text-stitch-amber shrink-0" />
                )}
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
              {section.codeBadgeList && (
                <div className="flex flex-wrap gap-1.5 pt-2">
                  {section.codeBadgeList.map((code) => (
                    <span
                      key={code}
                      className="px-2 py-0.5 rounded bg-stitch-well border border-stitch-divider text-xs font-mono text-stitch-primary"
                    >
                      {code}
                    </span>
                  ))}
                </div>
              )}
            </section>
          ))}
        </div>
      </main>
    </div>
  );
}
