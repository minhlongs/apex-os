'use client';

import { renderToString } from 'react-dom/server';
import { commissionEarnedTemplate } from '@/lib/emails/templates';
import { error as logError } from '@/lib/logger';
import { WelcomeEmail } from '@/emails/templates/WelcomeEmail';
import { ConversionEarnedEmail } from '@/emails/templates/ConversionEarnedEmail';
import { PayoutSentEmail } from '@/emails/templates/PayoutSentEmail';
import { WeeklySummaryEmail } from '@/emails/templates/WeeklySummaryEmail';
import { DealExpiringEmail } from '@/emails/templates/DealExpiringEmail';

const TEMPLATES = [
  { id: 'commission-earned', label: 'Commission Earned' },
  { id: 'payout-completed', label: 'Payout Completed' },
  { id: 'weekly-summary', label: 'Weekly Summary' },
  { id: 'welcome', label: 'Welcome' },
  { id: 'deal-expiring', label: 'Deal Expiring' },
];

function renderHtml(templateId: string): string {
  try {
    switch (templateId) {
      case 'welcome':
        return renderToString(
          <WelcomeEmail
            locale="en"
            name="Test User"
            email="test@example.com"
            referralCode="ABC123"
          />
        );
      case 'commission-earned':
        return commissionEarnedTemplate({
          locale: 'en',
          baseUrl: 'https://apex-os.com',
          tier: 1,
          payoutStatus: 'pending',
          dealName: 'Binance Spot',
          userName: 'Test User',
          userEmail: 'test@example.com',
          amount: 12.5,
          exchange: 'Binance',
          tradeVolume: 1250,
        });
      case 'payout-completed':
        return renderToString(
          <PayoutSentEmail
            locale="en"
            name="Test User"
            email="test@example.com"
            amountUsdc={25}
            txHash="stellar-tx-abc123"
            explorerUrl="https://stellar.expert/testnet/tx/stellar-tx-abc123"
            payoutDate="2026-08-02"
          />
        );
      case 'weekly-summary':
        return renderToString(
          <WeeklySummaryEmail
            locale="en"
            name="Test User"
            email="test@example.com"
            earnings={50.25}
            clicks={120}
            activeReferrals={8}
            topDeal="BTC/USDT Spot"
          />
        );
      case 'deal-expiring':
        return renderToString(
          <DealExpiringEmail
            locale="en"
            name="Admin User"
            email="admin@apex-os.com"
            dealTitle="ETH/USDT Futures"
            clicks={340}
            conversions={12}
            expiryDate="2026-08-05"
            dealId="deal-42"
          />
        );
      default:
        return '<p>Template preview not implemented yet.</p>';
    }
  } catch (error) {
    logError(`Failed to render template "${templateId}":`, error);
    return `<p style="color: red;">Error rendering template: ${templateId}</p>`;
  }
}

export default function EmailPreviewPage() {
  return (
    <div className="p-8">
      <h1 className="text-2xl font-bold mb-6">Email Template Preview</h1>
      <div className="grid grid-cols-2 gap-6">
        {TEMPLATES.map((template) => (
          <div key={template.id} className="border rounded-lg overflow-hidden">
            <div className="bg-gray-100 px-4 py-2 border-b font-semibold">
              {template.label}
            </div>
            <div className="bg-white p-4">
              <div
                className="border rounded"
                dangerouslySetInnerHTML={{ __html: renderHtml(template.id) }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
