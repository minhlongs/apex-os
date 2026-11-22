import React from 'react';
import Link from 'next/link';
import type { Metadata } from 'next';
import { ShieldCheck, ArrowLeft } from 'lucide-react';
import { ProofOfRebateVerifier } from '@/components/b2b/proof-of-rebate-verifier';

export const metadata: Metadata = {
  title: 'Cryptographic Proof-of-Rebate Verifier | ApexOS Institutional',
  description:
    'Independently verify SHA-256 R2 partner statement digests, CASH_COLLECTED broker reconciliation, and 10^-8 USD integer Safe-Spread Waterfall conservation.',
};

export default async function B2bProofOfRebatePage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams?: Promise<{ batchId?: string }>;
}) {
  const { locale } = await params;
  const resolvedSearch = searchParams ? await searchParams : {};
  const initialBatchId =
    typeof resolvedSearch?.batchId === 'string' ? resolvedSearch.batchId : '';
  const isVi = locale === 'vi';

  return (
    <main className="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 sm:px-6 lg:px-8">
      <div className="max-w-5xl mx-auto space-y-8">
        <div className="flex items-center justify-between">
          <Link
            href={`/${locale}`}
            className="inline-flex items-center gap-2 text-xs font-medium text-slate-400 hover:text-emerald-400"
          >
            <ArrowLeft className="w-4 h-4" />
            {isVi ? 'Quay lại trang chủ ApexOS' : 'Back to ApexOS Home'}
          </Link>
          <span className="rounded-full border border-emerald-500/30 bg-emerald-500/10 px-3 py-1 text-xs font-mono text-emerald-300">
            GET /api/b2b/proof-of-rebate
          </span>
        </div>

        <header className="space-y-3">
          <div className="inline-flex items-center gap-2 text-emerald-400 text-xs font-semibold uppercase tracking-widest">
            <ShieldCheck className="w-4 h-4" />
            {isVi
              ? 'Xác Minh Mật Mã Dành Cho Đối Tác Tổ Chức & B2B'
              : 'Institutional & B2B Cryptographic Audit Portal'}
          </div>
          <h1 className="text-3xl sm:text-4xl font-bold tracking-tight text-white">
            {isVi
              ? 'Cổng Xác Minh Proof-of-Rebate (SHA-256 & Sổ Cái Kép)'
              : 'Cryptographic Proof-of-Rebate Verification'}
          </h1>
          <p className="text-sm sm:text-base text-slate-400 max-w-3xl">
            {isVi
              ? 'Kiểm chứng độc lập mã băm SHA-256 của sao kê đối tác lưu trữ bất biến 5 năm trên Cloudflare R2, trạng thái đối soát tiền thực nhận (CASH_COLLECTED), và định luật bảo toàn số nguyên 10^-8 USD (không tiết lộ thông tin định danh cá nhân PII).'
              : 'Independently verify 5-year immutable Cloudflare R2 partner statement SHA-256 digests, CASH_COLLECTED broker wallet reconciliation, and 10^-8 USD integer Safe-Spread Waterfall conservation with zero PII exposure.'}
          </p>
        </header>

        <ProofOfRebateVerifier locale={locale} initialBatchId={initialBatchId} />
      </div>
    </main>
  );
}
