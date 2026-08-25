import React from 'react';
import { EmailLayout, Heading, Text, Button } from '../components';

interface Props {
  locale: 'vi' | 'en';
  name: string;
  email: string;
  earnings: number;
  clicks: number;
  activeReferrals: number;
  topDeal?: string;
  baseUrl?: string;
}

export function WeeklySummaryEmail({ locale, name, email, earnings, clicks, activeReferrals, topDeal, baseUrl = 'https://apex-os.com' }: Props): JSX.Element {
  const isVi = locale === 'vi';
  const dashboardUrl = `${baseUrl}/dashboard`;

  return (
    <EmailLayout
      locale={locale}
      title={isVi ? 'Tóm tắt tuần của bạn' : 'Your weekly summary'}
      previewText={isVi ? `Thu nhập tuần này: ${earnings.toFixed(2)} USDC` : `This week: ${earnings.toFixed(2)} USDC`}
    >
      <Heading level={2} align="left">
        {isVi ? `Tuần của bạn, ${name}` : `Your week, ${name}`}
      </Heading>

      <Text size="lg">
        {isVi ? 'Thu nhập tuần này:' : 'Weekly earnings:'} <strong>{earnings.toFixed(2)}</strong>
      </Text>

      <Text size="md">
        {isVi ? 'Clicks:' : 'Clicks:'} {clicks}
      </Text>
      <Text size="md">
        {isVi ? 'Giới thiệu hoạt động:' : 'Active referrals:'} {activeReferrals}
      </Text>

      {topDeal && (
        <Text size="md">
          {isVi ? 'Deal nổi bật:' : 'Top deal:'} {topDeal}
        </Text>
      )}

      <Button href={dashboardUrl}>{isVi ? 'Xem Dashboard' : 'Open Dashboard'}</Button>
    </EmailLayout>
  );
}
