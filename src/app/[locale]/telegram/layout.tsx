import React from 'react';
import type { Metadata, Viewport } from 'next';
import Script from 'next/script';

/**
 * src/app/[locale]/telegram/layout.tsx
 *
 * Dedicated layout for the Telegram Mini App (TMA).
 * - Injects the official Telegram WebApp SDK script (https://telegram.org/js/telegram-web-app.js)
 * - Configures touch viewport parameters (user-scalable=no, viewport-fit=cover)
 * - Applies Telegram WebApp theme CSS variables and safe-area insets
 */

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  viewportFit: 'cover',
  themeColor: [
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
    { media: '(prefers-color-scheme: dark)', color: '#0f172a' },
  ],
};

export const metadata: Metadata = {
  title: 'ApexOS Telegram Mini App',
  description: 'ApexOS Crypto Cashback & Viral Social Referral Bot for Telegram',
  robots: {
    index: false,
    follow: false,
  },
};

export default function TelegramLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <>
      <Script
        src="https://telegram.org/js/telegram-web-app.js"
        strategy="beforeInteractive"
      />
      <div className="tma-container min-h-screen min-h-[100dvh] w-full max-w-lg mx-auto bg-slate-900 text-slate-100 flex flex-col selection:bg-indigo-500/30">
        {children}
      </div>
    </>
  );
}
