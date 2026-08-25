import React from 'react';
import { EmailLayout, Heading, Text, Button } from '../components';

interface Props {
  locale: 'vi' | 'en';
  name: string;
  email: string;
  amountUsdc: number;
  txHash: string;
  explorerUrl: string;
  payoutDate: string;
  baseUrl?: string;
}

export function PayoutSentEmail({ locale, name, email, amountUsdc, txHash, explorerUrl, payoutDate, baseUrl = 'https://apex-os.com' }: Props): JSX.Element {
  const isVi = locale === 'vi';
  const payoutsUrl = `${baseUrl}/dashboard/payouts`;

  return (
    <EmailLayout
      locale={locale}
      title={isVi ? 'Payout đã được gửi' : 'Payout sent'}
      previewText={isVi ? `${amountUsdc.toFixed(2)} USDC đã được gửi` : `${amountUsdc.toFixed(2)} USDC sent`}
    >
      <Heading level={2} align="left">
        {isVi ? `Payout đã gửi, ${name}!` : `Payout sent, ${name}!`}
      </Heading>

      <Text size="lg">
        {isVi ? 'Số tiền:' : 'Amount:'} <strong>{amountUsdc.toFixed(2)} USDC</strong>
      </Text>

      <Text size="md">
        {isVi ? 'Mã giao dịch:' : 'Transaction:'}{' '}
        <a href={explorerUrl} style={{ color: '#F97316' }} target="_blank" rel="noreferrer">
          {txHash.slice(0, 12)}...
        </a>
      </Text>

      <Text size="md">
        {isVi ? 'Ngày thanh toán:' : 'Payout date:'} {payoutDate}
      </Text>

      <Button href={payoutsUrl}>{isVi ? 'Xem lịch sử payout' : 'View payout history'}</Button>
    </EmailLayout>
  );
}
