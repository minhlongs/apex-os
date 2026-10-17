import React from 'react';
import Link from 'next/link';
import type { TerminalScreenId } from '@/data/stitch-terminal-data';

export interface StitchObsidianBannerProps {
  readonly locale: string;
  readonly targetTab: TerminalScreenId;
  readonly screenLabel: string;
}

export function StitchObsidianBanner({
  locale,
  targetTab,
  screenLabel,
}: Readonly<StitchObsidianBannerProps>) {
  const safeLocale = locale === 'vi' ? 'vi' : 'en';
  const isVi = safeLocale === 'vi';

  return (
    <aside
      aria-label="ApexOS Stitch Obsidian Quant Terminal Bridge"
      className="mb-6 rounded-xl border border-stitch-divider bg-stitch-surface px-4 py-3 text-stitch-primary shadow-md flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-flex items-center gap-1.5 rounded-full border border-stitch-divider bg-stitch-well px-2.5 py-1 font-mono text-xs font-semibold text-stitch-emerald">
          <span className="h-2 w-2 rounded-full bg-stitch-emerald" aria-hidden="true" />
          Obsidian Quant Terminal
        </span>
        <span className="font-mono text-xs text-stitch-cyan">{screenLabel}</span>
        <span className="hidden md:inline font-mono text-xs text-stitch-muted">
          3/3 Chains HEALTHY · D1 Immutable Trigger Active
        </span>
      </div>

      <div className="flex items-center gap-2">
        <Link
          href={`/${safeLocale}/terminal?tab=${targetTab}`}
          className="inline-flex items-center gap-1.5 rounded-lg bg-gradient-primary px-3 py-1.5 font-mono text-xs font-bold text-stitch-primary transition-opacity hover:opacity-95"
        >
          {isVi ? 'Mở Buồng Lái Stitch Quant ->' : 'Launch Stitch Quant Terminal ->'}
        </Link>
      </div>
    </aside>
  );
}
