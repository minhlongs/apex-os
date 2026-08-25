import React from 'react';
import { EmailLayout, Heading, Text, Button } from '../components';

interface Props {
  locale: 'vi' | 'en';
  name: string;
  email: string;
  amount: number;
  exchange: string;
  tradeVolume: number;
  dealTitle: string;
  baseUrl?: string;
}

export function ConversionEarnedEmail({ locale, name, email, amount, exchange, tradeVolume, dealTitle, baseUrl = 'https://apex-os.com' }: Props): JSX.Element {
  const isVi = locale === 'vi';
  const dashboardUrl = `${baseUrl}/dashboard`;

  return (
    <EmailLayout
      locale={locale}
      title={isVi ? 'Bạn vừa nhận được hoa hồng!' : 'You earned a commission!'}
      previewText={isVi ? `Bạn nhận được ${amount.toFixed(2)} USDC` : `You earned ${amount.toFixed(2)} USDC`}
    >
      <Heading level={2} align="left">
        {isVi ? `Chúc mừng, ${name}!` : `Great job, ${name}!`}
      </Heading>

      <Text size="lg">
        {isVi ? 'Bạn vừa nhận được' : 'You just earned'} <strong>{amount.toFixed(2)} USDC</strong>
      </Text>

      <Text size="md">
        {isVi ? 'Sàn giao dịch:' : 'Exchange:'} {exchange}
      </Text>
      <Text size="md">
        {isVi ? 'Khối lượng giao dịch:' : 'Trade volume:'} {tradeVolume.toLocaleString()}
      </Text>
      <Text size="md">
        {isVi ? 'Deal:' : 'Deal:'} {dealTitle}
      </Text>

      <Button href={dashboardUrl}>{isVi ? 'Xem Dashboard' : 'View Dashboard'}</Button>
    </EmailLayout>
  );
}
