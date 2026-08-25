import React from 'react';
import { EmailLayout, Heading, Text, Button } from '../components';

interface DealExpiringEmailProps {
  locale: 'vi' | 'en';
  name: string;
  email: string;
  dealTitle: string;
  clicks: number;
  conversions: number;
  expiryDate: string;
  dealId: string;
  baseUrl?: string;
}

export function DealExpiringEmail({
  locale,
  name,
  email,
  dealTitle,
  clicks,
  conversions,
  expiryDate,
  dealId,
  baseUrl = 'https://apex-os.com',
}: DealExpiringEmailProps): JSX.Element {
  const isVi = locale === 'vi';
  const editDealUrl = `${baseUrl}/admin/deals/${dealId}/edit`;

  return (
    <EmailLayout
      locale={locale}
      title={
        isVi
          ? `Deal "${dealTitle}" của bạn sẽ hết hạn trong 3 ngày`
          : `Your deal "${dealTitle}" expires in 3 days`
      }
      previewText={
        isVi
          ? `Deal của bạn nhận được ${clicks} clicks và ${conversions} chuyển đổi. Hết hạn ${expiryDate}.`
          : `Your deal has received ${clicks} clicks and ${conversions} conversions. Expires ${expiryDate}.`
      }
    >
      <Heading level={2} align="left">
        {isVi ? 'Deal của bạn sắp hết hạn' : 'Your deal is expiring soon'}
      </Heading>

      <Text size="lg">
        {isVi ? `Deal:` : `Deal:`} <strong>{dealTitle}</strong>
      </Text>

      <Text size="md">
        {isVi ? `Clicks:` : `Clicks:`} {clicks.toLocaleString()}
      </Text>
      <Text size="md">
        {isVi ? `Chuyển đổi:` : `Conversions:`} {conversions.toLocaleString()}
      </Text>
      <Text size="md">
        {isVi ? `Hết hạn:` : `Expires:`} {expiryDate}
      </Text>

      <Button href={editDealUrl}>{isVi ? 'Gia hạn Deal' : 'Extend Deal'}</Button>
    </EmailLayout>
  );
}
