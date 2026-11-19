'use client';

import React, { useMemo, useState } from 'react';
import Decimal from 'decimal.js';
import {
  AlertTriangle,
  Calculator,
  CheckCircle2,
  Clock,
  Layers,
  Lock,
  ShieldCheck,
  Wallet,
} from 'lucide-react';
import {
  computeSafeSpreadWaterfall,
  DEFAULT_WATERFALL_CONFIG,
  type WaterfallOptions,
} from '@/lib/ledger/waterfall';

const CalcDecimal = Decimal.clone({
  precision: 28,
  rounding: Decimal.ROUND_DOWN,
});

export type CalculatorExchangeId = 'bybit' | 'okx' | 'bitget' | 'kucoin' | 'gateio';
export type CalculatorMarketType = 'futures' | 'spot';
export type PartnerIntegrationStatus = 'live' | 'onboarding';

export interface MarketFeeSchedule {
  /** Blended effective exchange trading fee in basis points (1 bps = 0.01%). */
  readonly effectiveFeeBps: string;
  /** Institutional partner gross share percentage of exchange fee. */
  readonly partnerSharePct: string;
  /** Effective gross partner commission in basis points of notional volume. */
  readonly partnerGrossCommissionBps: string;
  /** Effective trader net cashback recovery in basis points (50% of gross partner bps). */
  readonly traderCashbackBps: string;
}

export interface PartnerExchangeSpec {
  readonly id: CalculatorExchangeId;
  readonly name: string;
  readonly status: PartnerIntegrationStatus;
  readonly markets: Readonly<Record<CalculatorMarketType, MarketFeeSchedule>>;
}

export const MIN_MONTHLY_VOLUME_USD = 10_000;
export const MAX_MONTHLY_VOLUME_USD = 50_000_000;
export const DEFAULT_MONTHLY_VOLUME_USD = 500_000;

export const LEDGER_SCALE_1E8 = BigInt('100000000');
const BPS_DIVISOR_DECIMAL = new CalcDecimal('10000');
const LEDGER_SCALE_DECIMAL = new CalcDecimal('100000000');

export const BINANCE_EXCLUSION_NOTE_EN =
  'Binance Standard Referral Pro excluded — referee UID telemetry unavailable without Enterprise Broker status';

export const BINANCE_EXCLUSION_NOTE_VI =
  'Loại trừ Binance Standard Referral Pro — không có dữ liệu đối soát UID người dùng nếu chưa có hợp đồng Enterprise Broker';

export const WATERFALL_SHARE_PCT = Object.freeze({
  gross: 100,
  clawbackReserve: 5,
  traderCashbackOfDistributable: 50,
  traderCashbackEffectiveGross: 47.5,
  l1PartnerOfSpread: 30,
  l1PartnerEffectiveGross: 14.25,
  l2SubPartnerDefault: 0,
  l2SubPartnerMaxOfSpread: 10,
  platformNetEffectiveGross: 33.25,
  config: DEFAULT_WATERFALL_CONFIG,
} as const);

export const PARTNER_EXCHANGE_SPECS: readonly PartnerExchangeSpec[] = Object.freeze([
  {
    id: 'bybit',
    name: 'Bybit',
    status: 'live',
    markets: {
      futures: {
        effectiveFeeBps: '4.00',
        partnerSharePct: '45',
        partnerGrossCommissionBps: '1.80',
        traderCashbackBps: '0.855',
      },
      spot: {
        effectiveFeeBps: '10.00',
        partnerSharePct: '45',
        partnerGrossCommissionBps: '4.50',
        traderCashbackBps: '2.1375',
      },
    },
  },
  {
    id: 'okx',
    name: 'OKX',
    status: 'live',
    markets: {
      futures: {
        effectiveFeeBps: '4.00',
        partnerSharePct: '40',
        partnerGrossCommissionBps: '1.60',
        traderCashbackBps: '0.76',
      },
      spot: {
        effectiveFeeBps: '9.00',
        partnerSharePct: '40',
        partnerGrossCommissionBps: '3.60',
        traderCashbackBps: '1.71',
      },
    },
  },
  {
    id: 'bitget',
    name: 'Bitget',
    status: 'live',
    markets: {
      futures: {
        effectiveFeeBps: '4.50',
        partnerSharePct: '50',
        partnerGrossCommissionBps: '2.25',
        traderCashbackBps: '1.06875',
      },
      spot: {
        effectiveFeeBps: '10.00',
        partnerSharePct: '50',
        partnerGrossCommissionBps: '5.00',
        traderCashbackBps: '2.375',
      },
    },
  },
  {
    id: 'kucoin',
    name: 'KuCoin',
    status: 'onboarding',
    markets: {
      futures: {
        effectiveFeeBps: '4.50',
        partnerSharePct: '40',
        partnerGrossCommissionBps: '1.80',
        traderCashbackBps: '0.855',
      },
      spot: {
        effectiveFeeBps: '10.00',
        partnerSharePct: '45',
        partnerGrossCommissionBps: '4.50',
        traderCashbackBps: '2.1375',
      },
    },
  },
  {
    id: 'gateio',
    name: 'Gate.io',
    status: 'onboarding',
    markets: {
      futures: {
        effectiveFeeBps: '4.00',
        partnerSharePct: '50',
        partnerGrossCommissionBps: '2.00',
        traderCashbackBps: '0.95',
      },
      spot: {
        effectiveFeeBps: '10.00',
        partnerSharePct: '50',
        partnerGrossCommissionBps: '5.00',
        traderCashbackBps: '2.375',
      },
    },
  },
]);

const VOLUME_PRESETS: readonly number[] = Object.freeze([
  50_000,
  500_000,
  2_500_000,
  10_000_000,
  50_000_000,
]);

export interface SafeSpreadWaterfallUnits {
  readonly grossCommissionUnits: bigint;
  readonly clawbackReserveUnits: bigint;
  readonly traderCashbackUnits: bigint;
  readonly l1PartnerUnits: bigint;
  readonly l2SubPartnerUnits: bigint;
  readonly l3PartnerUnits: bigint;
  readonly platformNetUnits: bigint;
  readonly annualizedTraderSavingsUnits: bigint;
}

export interface RebateCalculationInput {
  readonly exchange: CalculatorExchangeId;
  readonly marketType: CalculatorMarketType;
  readonly monthlyVolumeUsd: number | string;
}

export interface RebateCalculationResult {
  readonly exchangeSpec: PartnerExchangeSpec;
  readonly marketType: CalculatorMarketType;
  readonly feeSchedule: MarketFeeSchedule;
  readonly sanitizedVolumeUsd: number;
  readonly exchangeFeeUnits: bigint;
  readonly waterfall: SafeSpreadWaterfallUnits;
  readonly formatted: {
    readonly monthlyVolume: string;
    readonly exchangeFeePaid: string;
    readonly grossCommission: string;
    readonly clawbackReserve: string;
    readonly traderCashback: string;
    readonly l1PartnerCommission: string;
    readonly l2SubPartnerOverride: string;
    readonly platformNet: string;
    readonly annualizedTraderSavings: string;
  };
}

export function sanitizeMonthlyVolumeUsd(raw: number | string): number {
  const parsed =
    typeof raw === 'number'
      ? raw
      : Number(String(raw).replace(/[^0-9.-]/g, ''));

  if (!Number.isFinite(parsed) || Number.isNaN(parsed)) {
    return MIN_MONTHLY_VOLUME_USD;
  }

  const rounded = Math.trunc(parsed);
  if (rounded < MIN_MONTHLY_VOLUME_USD) {
    return MIN_MONTHLY_VOLUME_USD;
  }
  if (rounded > MAX_MONTHLY_VOLUME_USD) {
    return MAX_MONTHLY_VOLUME_USD;
  }
  return rounded;
}

export function getPartnerExchangeSpec(exchangeId: string): PartnerExchangeSpec {
  const found = PARTNER_EXCHANGE_SPECS.find((item) => item.id === exchangeId);
  return found ?? PARTNER_EXCHANGE_SPECS[0];
}

function addThousandsSeparators(integerDigits: string): string {
  return integerDigits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Formats 10^-8 USD integer units into a deterministic USD string without IEEE-754 float math.
 */
export function formatLedgerUnitsUsd(units1e8: bigint, fractionDigits = 2): string {
  const isNegative = units1e8 < BigInt(0);
  const absUnits = isNegative ? -units1e8 : units1e8;
  const dec = new CalcDecimal(absUnits.toString()).div(LEDGER_SCALE_DECIMAL);
  const fixed = dec.toFixed(fractionDigits, Decimal.ROUND_DOWN);
  const [wholePart, fracPart] = fixed.split('.');
  const formattedWhole = addThousandsSeparators(wholePart);
  const sign = isNegative ? '-' : '';
  return fracPart !== undefined
    ? `${sign}$${formattedWhole}.${fracPart}`
    : `${sign}$${formattedWhole}`;
}

/**
 * Returns exact 8-decimal USD string from 10^-8 integer units for deterministic assertions.
 */
export function unitsToExactDecimalString(units1e8: bigint): string {
  const isNegative = units1e8 < BigInt(0);
  const absUnits = isNegative ? -units1e8 : units1e8;
  const whole = absUnits / LEDGER_SCALE_1E8;
  const frac = (absUnits % LEDGER_SCALE_1E8).toString().padStart(8, '0');
  return `${isNegative ? '-' : ''}${whole.toString()}.${frac}`;
}

/**
 * Delegates directly to `computeSafeSpreadWaterfall` (`DEFAULT_WATERFALL_CONFIG`)
 * in `src/lib/ledger/waterfall.ts` so the landing calculator, B2B Proof-of-Rebate,
 * and double-entry ledger use the exact same `10^-8` USD integer formula:
 * - 5.00% Clawback Reserve (`R = ceil(0.05 * C)`)
 * - 50.00% of Distributable Pool `D = C - R` -> 47.50% effective gross Trader Cashback
 * - 30.00% of Spread `S = D - E_trader` -> 14.25% effective gross L1 Partner Commission
 * - 0.00% default L2 Sub-Partner Override (up to 10.00% of Spread / 4.75% gross for B2B Agencies; L3 hard-locked to 0)
 * - 33.25% default Platform Net Operations (`28.50%` with max B2B L2)
 */
export function computeWaterfallFromGrossUnits(
  grossCommissionUnits: bigint,
  options?: WaterfallOptions
): SafeSpreadWaterfallUnits {
  if (grossCommissionUnits < BigInt(0)) {
    throw new RangeError('grossCommissionUnits must be non-negative');
  }

  if (grossCommissionUnits === BigInt(0)) {
    return {
      grossCommissionUnits: BigInt(0),
      clawbackReserveUnits: BigInt(0),
      traderCashbackUnits: BigInt(0),
      l1PartnerUnits: BigInt(0),
      l2SubPartnerUnits: BigInt(0),
      l3PartnerUnits: BigInt(0),
      platformNetUnits: BigInt(0),
      annualizedTraderSavingsUnits: BigInt(0),
    };
  }

  const breakdown = computeSafeSpreadWaterfall(grossCommissionUnits, options);

  return {
    grossCommissionUnits: breakdown.cashCollectedUnits,
    clawbackReserveUnits: breakdown.reserveUnits,
    traderCashbackUnits: breakdown.traderCashbackUnits,
    l1PartnerUnits: breakdown.l1CommissionUnits,
    l2SubPartnerUnits: breakdown.l2CommissionUnits,
    l3PartnerUnits: breakdown.l3CommissionUnits,
    platformNetUnits: breakdown.platformNetUnits,
    annualizedTraderSavingsUnits: breakdown.traderCashbackUnits * BigInt(12),
  };
}

export function calculateSafeSpreadWaterfallRebate(
  input: RebateCalculationInput
): RebateCalculationResult {
  const exchangeSpec = getPartnerExchangeSpec(input.exchange);
  const marketType: CalculatorMarketType =
    input.marketType === 'spot' ? 'spot' : 'futures';
  const feeSchedule = exchangeSpec.markets[marketType];
  const sanitizedVolumeUsd = sanitizeMonthlyVolumeUsd(input.monthlyVolumeUsd);

  const volumeDec = new CalcDecimal(sanitizedVolumeUsd.toString());
  const feeBpsDec = new CalcDecimal(feeSchedule.effectiveFeeBps);
  const grossBpsDec = new CalcDecimal(feeSchedule.partnerGrossCommissionBps);

  const exchangeFeeUnitsDec = volumeDec
    .mul(feeBpsDec)
    .div(BPS_DIVISOR_DECIMAL)
    .mul(LEDGER_SCALE_DECIMAL)
    .toDecimalPlaces(0, Decimal.ROUND_DOWN);

  const grossCommissionUnitsDec = volumeDec
    .mul(grossBpsDec)
    .div(BPS_DIVISOR_DECIMAL)
    .mul(LEDGER_SCALE_DECIMAL)
    .toDecimalPlaces(0, Decimal.ROUND_DOWN);

  const exchangeFeeUnits = BigInt(exchangeFeeUnitsDec.toFixed(0));
  const grossCommissionUnits = BigInt(grossCommissionUnitsDec.toFixed(0));
  const waterfall = computeWaterfallFromGrossUnits(grossCommissionUnits);

  return {
    exchangeSpec,
    marketType,
    feeSchedule,
    sanitizedVolumeUsd,
    exchangeFeeUnits,
    waterfall,
    formatted: {
      monthlyVolume: `$${addThousandsSeparators(sanitizedVolumeUsd.toString())}`,
      exchangeFeePaid: formatLedgerUnitsUsd(exchangeFeeUnits, 2),
      grossCommission: formatLedgerUnitsUsd(waterfall.grossCommissionUnits, 2),
      clawbackReserve: formatLedgerUnitsUsd(waterfall.clawbackReserveUnits, 2),
      traderCashback: formatLedgerUnitsUsd(waterfall.traderCashbackUnits, 2),
      l1PartnerCommission: formatLedgerUnitsUsd(waterfall.l1PartnerUnits, 2),
      l2SubPartnerOverride: formatLedgerUnitsUsd(waterfall.l2SubPartnerUnits, 2),
      platformNet: formatLedgerUnitsUsd(waterfall.platformNetUnits, 2),
      annualizedTraderSavings: formatLedgerUnitsUsd(
        waterfall.annualizedTraderSavingsUnits,
        2
      ),
    },
  };
}

interface CopyBundle {
  readonly badge: string;
  readonly title: string;
  readonly subtitle: string;
  readonly exchangeLabel: string;
  readonly statusLive: string;
  readonly statusOnboarding: string;
  readonly binanceExcludedTitle: string;
  readonly binanceExcludedNote: string;
  readonly marketLabel: string;
  readonly futuresLabel: string;
  readonly spotLabel: string;
  readonly volumeLabel: string;
  readonly volumeRangeHint: string;
  readonly feeRateLabel: string;
  readonly grossCommissionRateLabel: string;
  readonly exchangeFeePaidLabel: string;
  readonly traderMonthlyTitle: string;
  readonly traderMonthlySub: string;
  readonly annualizedTitle: string;
  readonly annualizedSub: string;
  readonly waterfallTitle: string;
  readonly waterfallIntegrityBadge: string;
  readonly grossRowLabel: string;
  readonly grossRowDesc: string;
  readonly reserveRowLabel: string;
  readonly reserveRowDesc: string;
  readonly traderRowLabel: string;
  readonly traderRowDesc: string;
  readonly l1RowLabel: string;
  readonly l1RowDesc: string;
  readonly l2RowLabel: string;
  readonly l2RowDesc: string;
  readonly platformRowLabel: string;
  readonly platformRowDesc: string;
  readonly twoTierCapNotice: string;
  readonly settlementRailNotice: string;
}

const COPY: Readonly<Record<'en' | 'vi', CopyBundle>> = {
  en: {
    badge: 'Safe-Spread I4 Waterfall Engine · 10^-8 USD Integer Ledger',
    title: 'Non-Custodial Safe-Spread Rebate Calculator',
    subtitle:
      'Deterministic Decimal/BigInt calculation with zero floating-point drift. Estimate UID-only trader USDC cashback and 2-tier partner commissions before trading.',
    exchangeLabel: '1. Select Partner Exchange (UID-Only Attribution)',
    statusLive: 'Live',
    statusOnboarding: 'Partner Onboarding',
    binanceExcludedTitle: 'Transparency Notice',
    binanceExcludedNote: BINANCE_EXCLUSION_NOTE_EN,
    marketLabel: '2. Market Execution Venue',
    futuresLabel: 'Perpetual Futures',
    spotLabel: 'Spot Market',
    volumeLabel: '3. Monthly Trading Volume (USD)',
    volumeRangeHint: 'Range: $10,000 to $50,000,000 / month',
    feeRateLabel: 'Effective Exchange Fee',
    grossCommissionRateLabel: 'Gross Partner Commission',
    exchangeFeePaidLabel: 'Est. Monthly Exchange Fees',
    traderMonthlyTitle: 'Direct Trader Cashback (50% of Distributable · 47.50% Gross)',
    traderMonthlySub: 'Paid in self-custody USDC on Stellar, Arbitrum, or Base ($10 min)',
    annualizedTitle: 'Annualized Trader USDC Savings (12x)',
    annualizedSub: 'Projected 12-month execution fee recovery after T+7 verification',
    waterfallTitle: 'Safe-Spread I4 Waterfall Allocation (100% Conserved)',
    waterfallIntegrityBadge: '0 Float Drift · 10^-8 USD Verified',
    grossRowLabel: 'Gross Partner Commission (100%)',
    grossRowDesc: 'Verified CASH_COLLECTED receipt reconciled against R2 SHA-256 statement',
    reserveRowLabel: 'Clawback Reserve (5.00% Gross)',
    reserveRowDesc: 'T+7 settlement protection buffer against exchange fee reversals',
    traderRowLabel: 'Direct Trader Cashback (50% Distributable · 47.50% Gross)',
    traderRowDesc: 'Self-custody USDC payout on Stellar, Arbitrum, or Base',
    l1RowLabel: 'L1 Direct Partner Commission (30% Spread · 14.25% Gross)',
    l1RowDesc: 'Direct referring partner / quant desk attribution share',
    l2RowLabel: 'L2 B2B Agency Override (0% Default · Max 10% Spread)',
    l2RowDesc: 'Strictly 2-Tier Cap — provisioned B2B agencies only (L3 hard-locked to 0%)',
    platformRowLabel: 'Platform Treasury & HSM Ops (33.25% Gross Default)',
    platformRowDesc: 'Turnkey HSM signing, 5-year R2 evidence vaulting & ledger ops',
    twoTierCapNotice:
      '2-Tier Hard Cap Guarantee: L1 (30% of Spread) + B2B L2 (0% default, max 10% of Spread; L1+L2 <= 45% Spread). L3+ multi-level tiers are permanently disabled in ledger code.',
    settlementRailNotice:
      'Zero API Keys required: link exchange UID only. Settlements unlock T+7 after CASH_COLLECTED verification with a 48-hour wallet-change timelock.',
  },
  vi: {
    badge: 'Mô Hình Thác Nước Safe-Spread I4 · Sổ Cái Số Nguyên 10^-8 USD',
    title: 'Công Cụ Tính Hoàn Phí Không Lưu Ký Safe-Spread',
    subtitle:
      'Tính toán chính xác bằng Decimal/BigInt không sai số dấu phẩy động. Ước tính hoàn phí USDC trực tiếp về ví tự quản và hoa hồng đối tác tối đa 2 tầng.',
    exchangeLabel: '1. Chọn Sàn Đối Tác (Đối Soát Chỉ Bằng UID)',
    statusLive: 'Đang hoạt động',
    statusOnboarding: 'Đang tích hợp đối tác',
    binanceExcludedTitle: 'Minh Bạch Đối Soát',
    binanceExcludedNote: `${BINANCE_EXCLUSION_NOTE_VI} (${BINANCE_EXCLUSION_NOTE_EN})`,
    marketLabel: '2. Loại Thị Trường Giao Dịch',
    futuresLabel: 'Hợp Đồng Vĩnh Cửu (Perpetual Futures)',
    spotLabel: 'Giao Ngay (Spot)',
    volumeLabel: '3. Khối Lượng Giao Dịch Hàng Tháng (USD)',
    volumeRangeHint: 'Phạm vi: $10,000 đến $50,000,000 / tháng',
    feeRateLabel: 'Phí Sàn Thực Tế Ước Tính',
    grossCommissionRateLabel: 'Tổng Hoa Hồng Đối Tác',
    exchangeFeePaidLabel: 'Tổng Phí Sàn Ước Tính / Tháng',
    traderMonthlyTitle: 'Hoàn Phí Trực Tiếp Cho Trader (50% Quỹ Phân Bổ · 47.50% Tổng)',
    traderMonthlySub: 'Thanh toán USDC tự quản qua Stellar, Arbitrum hoặc Base (tối thiểu $10)',
    annualizedTitle: 'Tiết Kiệm USDC Quy Đổi Cả Năm (12x)',
    annualizedSub: 'Tổng phí giao dịch thu hồi dự kiến trong 12 tháng sau đối soát T+7',
    waterfallTitle: 'Phân Bổ Thác Nước Safe-Spread I4 (Bảo Toàn 100%)',
    waterfallIntegrityBadge: 'Không Trôi Số Thực · Chuẩn 10^-8 USD',
    grossRowLabel: 'Tổng Hoa Hồng Đối Tác Sàn (100%)',
    grossRowDesc: 'Biên nhận CASH_COLLECTED đối chiếu sao kê SHA-256 lưu trữ R2',
    reserveRowLabel: 'Quỹ Dự Phòng Clawback (5.00% Tổng)',
    reserveRowDesc: 'Bảo vệ quyết toán T+7 trước các khoản điều chỉnh phí từ sàn',
    traderRowLabel: 'Hoàn Phí Trực Tiếp Cho Trader (50% Quỹ Phân Bổ · 47.50% Tổng)',
    traderRowDesc: 'Nhận USDC về ví tự quản trên Stellar, Arbitrum hoặc Base',
    l1RowLabel: 'Hoa Hồng Đối Tác Trực Tiếp L1 (30% Spread · 14.25% Tổng)',
    l1RowDesc: 'Tỷ lệ chia sẻ doanh thu cho đối tác giới thiệu trực tiếp',
    l2RowLabel: 'Hoa Hồng Đại Lý B2B L2 (Mặc định 0% · Tối đa 10% Spread)',
    l2RowDesc: 'Giới hạn cứng 2 tầng — chỉ áp dụng cho đại lý B2B được cấp phép (L3 khóa ở 0%)',
    platformRowLabel: 'Vận Hành Hạ Tầng & Kho Bạc HSM (33.25% Mặc Định)',
    platformRowDesc: 'Ký số Turnkey HSM, lưu trữ bằng chứng R2 5 năm & sổ cái kép',
    twoTierCapNotice:
      'Cam Kết Giới Hạn Cứng 2 Tầng: L1 (30% Spread) + Đại lý B2B L2 (mặc định 0%, tối đa 10% Spread; L1+L2 <= 45% Spread). Mọi cấu trúc tầng thứ 3 (L3+) đều bị khóa cứng bằng 0 trong mã nguồn sổ cái.',
    settlementRailNotice:
      'Không cần API Key: chỉ định danh bằng UID sàn. Mở khóa thanh toán sau T+7 khi xác thực CASH_COLLECTED cùng khóa an toàn 48 giờ khi đổi ví.',
  },
};

export interface RebateCalculatorProps {
  readonly locale?: string;
}

export function RebateCalculator({ locale = 'en' }: RebateCalculatorProps) {
  const resolvedLocale: 'en' | 'vi' = locale === 'vi' ? 'vi' : 'en';
  const copy = COPY[resolvedLocale];

  const [exchange, setExchange] = useState<CalculatorExchangeId>('bybit');
  const [marketType, setMarketType] = useState<CalculatorMarketType>('futures');
  const [monthlyVolumeUsd, setMonthlyVolumeUsd] = useState<number>(
    DEFAULT_MONTHLY_VOLUME_USD
  );

  const calculation = useMemo(
    () =>
      calculateSafeSpreadWaterfallRebate({
        exchange,
        marketType,
        monthlyVolumeUsd,
      }),
    [exchange, marketType, monthlyVolumeUsd]
  );

  const handleVolumeInputChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const nextVolume = sanitizeMonthlyVolumeUsd(event.target.value);
    setMonthlyVolumeUsd(nextVolume);
  };

  return (
    <section
      aria-labelledby="rebate-calculator-heading"
      data-testid="rebate-calculator"
      className="stitch-obsidian-card p-6 md:p-10 border border-stitch-divider"
    >
      <div className="max-w-3xl mb-8">
        <div className="inline-flex items-center gap-2 px-3 py-1 rounded-full bg-stitch-well border border-stitch-divider text-stitch-emerald text-xs font-mono uppercase tracking-wider mb-3">
          <Calculator className="w-3.5 h-3.5" />
          <span>{copy.badge}</span>
        </div>
        <h2
          id="rebate-calculator-heading"
          className="text-2xl md:text-3xl font-bold text-stitch-primary tracking-tight mb-2"
        >
          {copy.title}
        </h2>
        <p className="text-sm md:text-base text-stitch-muted leading-relaxed">
          {copy.subtitle}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Controls */}
        <div className="lg:col-span-6 space-y-6">
          {/* 1. Exchange Selector */}
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-stitch-muted mb-3">
              {copy.exchangeLabel}
            </label>
            <div
              role="group"
              aria-label={copy.exchangeLabel}
              className="grid grid-cols-2 sm:grid-cols-3 gap-2.5"
            >
              {PARTNER_EXCHANGE_SPECS.map((item) => {
                const isSelected = item.id === exchange;
                const isLive = item.status === 'live';
                return (
                  <button
                    key={item.id}
                    type="button"
                    data-testid={`exchange-btn-${item.id}`}
                    aria-pressed={isSelected}
                    onClick={() => setExchange(item.id)}
                    className={`p-3 rounded-lg border text-left transition-colors ${
                      isSelected
                        ? 'bg-stitch-well border-stitch-emerald text-stitch-primary'
                        : 'bg-stitch-canvas/60 border-stitch-divider text-stitch-muted hover:border-stitch-muted'
                    }`}
                  >
                    <div className="font-semibold text-sm text-stitch-primary">
                      {item.name}
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-[11px] font-mono">
                      {isLive ? (
                        <>
                          <CheckCircle2 className="w-3 h-3 text-stitch-emerald shrink-0" />
                          <span className="text-stitch-emerald">{copy.statusLive}</span>
                        </>
                      ) : (
                        <>
                          <Clock className="w-3 h-3 text-stitch-amber shrink-0" />
                          <span className="text-stitch-amber">
                            {copy.statusOnboarding}
                          </span>
                        </>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Explicit Binance Exclusion Transparency Note */}
            <div
              data-testid="binance-exclusion-note"
              className="mt-3 p-3 rounded-lg bg-stitch-canvas/80 border border-stitch-amber/40 flex items-start gap-2.5 text-xs text-stitch-muted"
            >
              <AlertTriangle className="w-4 h-4 text-stitch-amber shrink-0 mt-0.5" />
              <div>
                <span className="font-semibold text-stitch-amber mr-1.5">
                  {copy.binanceExcludedTitle}:
                </span>
                <span>{copy.binanceExcludedNote}</span>
              </div>
            </div>
          </div>

          {/* 2. Market Type */}
          <div>
            <label className="block text-xs font-mono uppercase tracking-wider text-stitch-muted mb-3">
              {copy.marketLabel}
            </label>
            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                data-testid="market-btn-futures"
                aria-pressed={marketType === 'futures'}
                onClick={() => setMarketType('futures')}
                className={`px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
                  marketType === 'futures'
                    ? 'bg-stitch-well border-stitch-emerald text-stitch-primary'
                    : 'bg-stitch-canvas/60 border-stitch-divider text-stitch-muted hover:text-stitch-primary'
                }`}
              >
                {copy.futuresLabel}
              </button>
              <button
                type="button"
                data-testid="market-btn-spot"
                aria-pressed={marketType === 'spot'}
                onClick={() => setMarketType('spot')}
                className={`px-4 py-3 rounded-lg border text-sm font-medium transition-colors ${
                  marketType === 'spot'
                    ? 'bg-stitch-well border-stitch-emerald text-stitch-primary'
                    : 'bg-stitch-canvas/60 border-stitch-divider text-stitch-muted hover:text-stitch-primary'
                }`}
              >
                {copy.spotLabel}
              </button>
            </div>
          </div>

          {/* 3. Monthly Trading Volume */}
          <div>
            <div className="flex items-center justify-between gap-2 mb-2">
              <label
                htmlFor="monthly-volume-input"
                className="text-xs font-mono uppercase tracking-wider text-stitch-muted"
              >
                {copy.volumeLabel}
              </label>
              <span
                data-testid="volume-display"
                className="text-base font-bold font-mono text-stitch-emerald stitch-tabular-nums"
              >
                {calculation.formatted.monthlyVolume}
              </span>
            </div>

            <input
              id="monthly-volume-slider"
              data-testid="monthly-volume-slider"
              aria-label={copy.volumeLabel}
              type="range"
              min={MIN_MONTHLY_VOLUME_USD}
              max={MAX_MONTHLY_VOLUME_USD}
              step={10_000}
              value={calculation.sanitizedVolumeUsd}
              onChange={handleVolumeInputChange}
              className="w-full accent-emerald-500 cursor-pointer mb-3"
            />

            <div className="flex flex-col sm:flex-row sm:items-center gap-3">
              <input
                id="monthly-volume-input"
                data-testid="monthly-volume-input"
                type="number"
                min={MIN_MONTHLY_VOLUME_USD}
                max={MAX_MONTHLY_VOLUME_USD}
                step={10_000}
                value={calculation.sanitizedVolumeUsd}
                onChange={handleVolumeInputChange}
                className="w-full sm:w-48 px-3 py-2 rounded-lg bg-stitch-canvas border border-stitch-divider text-stitch-primary font-mono text-sm stitch-tabular-nums"
              />
              <span className="text-xs text-stitch-muted">{copy.volumeRangeHint}</span>
            </div>

            <div className="flex flex-wrap gap-2 mt-3">
              {VOLUME_PRESETS.map((preset) => (
                <button
                  key={preset}
                  type="button"
                  data-testid={`volume-preset-${preset}`}
                  onClick={() => setMonthlyVolumeUsd(preset)}
                  className={`px-2.5 py-1 rounded text-xs font-mono border transition-colors ${
                    calculation.sanitizedVolumeUsd === preset
                      ? 'bg-stitch-emerald/15 border-stitch-emerald text-stitch-emerald'
                      : 'bg-stitch-canvas/60 border-stitch-divider text-stitch-muted hover:text-stitch-primary'
                  }`}
                >
                  ${preset >= 1_000_000 ? `${preset / 1_000_000}M` : `${preset / 1_000}K`}
                </button>
              ))}
            </div>
          </div>

          {/* Effective bps summary */}
          <div className="grid grid-cols-3 gap-3 pt-2">
            <div className="p-3 rounded-lg bg-stitch-canvas/70 border border-stitch-divider">
              <div className="text-[11px] text-stitch-muted">{copy.feeRateLabel}</div>
              <div
                data-testid="effective-fee-bps"
                className="text-sm font-mono font-semibold text-stitch-primary mt-0.5 stitch-tabular-nums"
              >
                {calculation.feeSchedule.effectiveFeeBps} bps
              </div>
            </div>
            <div className="p-3 rounded-lg bg-stitch-canvas/70 border border-stitch-divider">
              <div className="text-[11px] text-stitch-muted">
                {copy.grossCommissionRateLabel}
              </div>
              <div
                data-testid="gross-commission-bps"
                className="text-sm font-mono font-semibold text-stitch-cyan mt-0.5 stitch-tabular-nums"
              >
                {calculation.feeSchedule.partnerGrossCommissionBps} bps (
                {calculation.feeSchedule.partnerSharePct}%)
              </div>
            </div>
            <div className="p-3 rounded-lg bg-stitch-canvas/70 border border-stitch-divider">
              <div className="text-[11px] text-stitch-muted">
                {copy.exchangeFeePaidLabel}
              </div>
              <div
                data-testid="exchange-fee-paid"
                className="text-sm font-mono font-semibold text-stitch-primary mt-0.5 stitch-tabular-nums"
              >
                {calculation.formatted.exchangeFeePaid}
              </div>
            </div>
          </div>
        </div>

        {/* Right Waterfall Output */}
        <div className="lg:col-span-6 space-y-5">
          {/* Highlight Cards: Monthly Trader Cashback + Annualized 12x Savings */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="p-5 rounded-xl bg-stitch-well border border-stitch-emerald/50">
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-stitch-emerald mb-1">
                <Wallet className="w-4 h-4" />
                <span>{copy.traderMonthlyTitle}</span>
              </div>
              <div
                data-testid="trader-monthly-cashback"
                className="text-3xl font-bold font-mono text-stitch-emerald stitch-tabular-nums my-1"
              >
                {calculation.formatted.traderCashback}
              </div>
              <p className="text-xs text-stitch-muted leading-snug">
                {copy.traderMonthlySub}
              </p>
            </div>

            <div className="p-5 rounded-xl bg-stitch-well border border-stitch-cyan/50">
              <div className="flex items-center gap-2 text-xs font-mono uppercase tracking-wider text-stitch-cyan mb-1">
                <ShieldCheck className="w-4 h-4" />
                <span>{copy.annualizedTitle}</span>
              </div>
              <div
                data-testid="trader-annualized-savings"
                className="text-3xl font-bold font-mono text-stitch-cyan stitch-tabular-nums my-1"
              >
                {calculation.formatted.annualizedTraderSavings}
              </div>
              <p className="text-xs text-stitch-muted leading-snug">
                {copy.annualizedSub}
              </p>
            </div>
          </div>

          {/* Safe-Spread I4 Waterfall Breakdown */}
          <div className="p-5 rounded-xl bg-stitch-canvas/80 border border-stitch-divider space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-stitch-divider">
              <div className="flex items-center gap-2 text-sm font-semibold text-stitch-primary">
                <Layers className="w-4 h-4 text-stitch-emerald" />
                <span>{copy.waterfallTitle}</span>
              </div>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-stitch-well text-stitch-emerald border border-stitch-divider">
                {copy.waterfallIntegrityBadge}
              </span>
            </div>

            {/* Gross 100% */}
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-stitch-divider/60">
              <div>
                <div className="text-sm font-medium text-stitch-primary">
                  {copy.grossRowLabel}
                </div>
                <div className="text-xs text-stitch-muted">{copy.grossRowDesc}</div>
              </div>
              <div
                data-testid="waterfall-gross"
                className="text-sm font-mono font-bold text-stitch-primary stitch-tabular-nums shrink-0"
              >
                {calculation.formatted.grossCommission}
              </div>
            </div>

            {/* 5% Clawback Reserve */}
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-stitch-divider/60">
              <div>
                <div className="text-sm font-medium text-stitch-amber">
                  {copy.reserveRowLabel}
                </div>
                <div className="text-xs text-stitch-muted">{copy.reserveRowDesc}</div>
              </div>
              <div
                data-testid="waterfall-reserve"
                className="text-sm font-mono font-semibold text-stitch-amber stitch-tabular-nums shrink-0"
              >
                {calculation.formatted.clawbackReserve}
              </div>
            </div>

            {/* 50% Direct Trader Cashback */}
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-stitch-divider/60">
              <div>
                <div className="text-sm font-medium text-stitch-emerald">
                  {copy.traderRowLabel}
                </div>
                <div className="text-xs text-stitch-muted">{copy.traderRowDesc}</div>
              </div>
              <div
                data-testid="waterfall-trader"
                className="text-sm font-mono font-semibold text-stitch-emerald stitch-tabular-nums shrink-0"
              >
                {calculation.formatted.traderCashback}
              </div>
            </div>

            {/* 20% L1 Partner */}
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-stitch-divider/60">
              <div>
                <div className="text-sm font-medium text-stitch-cyan">
                  {copy.l1RowLabel}
                </div>
                <div className="text-xs text-stitch-muted">{copy.l1RowDesc}</div>
              </div>
              <div
                data-testid="waterfall-l1"
                className="text-sm font-mono font-semibold text-stitch-cyan stitch-tabular-nums shrink-0"
              >
                {calculation.formatted.l1PartnerCommission}
              </div>
            </div>

            {/* 5% L2 Sub-Partner Override */}
            <div className="flex items-center justify-between gap-4 py-1.5 border-b border-stitch-divider/60">
              <div>
                <div className="text-sm font-medium text-stitch-cyan">
                  {copy.l2RowLabel}
                </div>
                <div className="text-xs text-stitch-muted">{copy.l2RowDesc}</div>
              </div>
              <div
                data-testid="waterfall-l2"
                className="text-sm font-mono font-semibold text-stitch-cyan stitch-tabular-nums shrink-0"
              >
                {calculation.formatted.l2SubPartnerOverride}
              </div>
            </div>

            {/* 20% Platform Net */}
            <div className="flex items-center justify-between gap-4 py-1.5">
              <div>
                <div className="text-sm font-medium text-stitch-muted">
                  {copy.platformRowLabel}
                </div>
                <div className="text-xs text-stitch-muted">{copy.platformRowDesc}</div>
              </div>
              <div
                data-testid="waterfall-platform"
                className="text-sm font-mono font-semibold text-stitch-muted stitch-tabular-nums shrink-0"
              >
                {calculation.formatted.platformNet}
              </div>
            </div>
          </div>

          <div className="p-3.5 rounded-lg bg-stitch-well/60 border border-stitch-divider text-xs text-stitch-muted space-y-1.5">
            <div className="flex items-start gap-2">
              <Lock className="w-3.5 h-3.5 text-stitch-emerald shrink-0 mt-0.5" />
              <span>{copy.twoTierCapNotice}</span>
            </div>
            <div className="flex items-start gap-2">
              <ShieldCheck className="w-3.5 h-3.5 text-stitch-cyan shrink-0 mt-0.5" />
              <span>{copy.settlementRailNotice}</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

export default RebateCalculator;
