import React from 'react';
import type { Metadata } from 'next';
import TelegramAppClient from './telegram-app-client';

/**
 * src/app/[locale]/telegram/app/page.tsx
 *
 * Page entry point for the Telegram Mini App (TMA).
 * Passes locale context to the interactive client component.
 */

export const metadata: Metadata = {
  title: 'ApexOS Mini App | Deals, Arbitrage & Referrals',
  description: 'Access top crypto cashback deals, arbitrage spreads, and viral referral rewards inside Telegram.',
};

export default async function TelegramAppPage({
  params,
}: {
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;

  return <TelegramAppClient locale={locale} />;
}
