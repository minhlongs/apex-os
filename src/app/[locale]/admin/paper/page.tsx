import React from 'react';
import { PaperTradingConsole } from '@/components/admin/paper/PaperTradingConsole';

export const metadata = {
  title: 'Paper Trading Console (PAPER ONLY) | ApexOS Admin',
  description:
    'Real-data Paper Trading Simulator & Audit Console for Binance and Bybit L2 orderbooks.',
};

export default function AdminPaperTradingPage() {
  return <PaperTradingConsole />;
}
