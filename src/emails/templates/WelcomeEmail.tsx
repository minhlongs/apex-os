import React from 'react';
import { EmailLayout, Heading, Text, Button } from '../components';

export interface WelcomeEmailProps {
  locale: 'vi' | 'en';
  name: string;
  email: string;
  referralCode?: string;
  baseUrl?: string;
}

export function WelcomeEmail({ locale, name, email, referralCode, baseUrl = 'https://apex-os.com' }: WelcomeEmailProps): JSX.Element {
  const isVi = locale === 'vi';
  const dashboardUrl = `${baseUrl}/dashboard`;
  const affiliateUrl = `${baseUrl}/affiliate`;

  return (
    <EmailLayout
      locale={locale}
      title={isVi ? 'Chào mừng đến ApexOS!' : 'Welcome to ApexOS!'}
      previewText={isVi ? 'Tài khoản của bạn đã sẵn sàng.' : 'Your account is ready.'}
    >
      <Heading level={2} align="left">
        {isVi ? `Xin chào, ${name}!` : `Hi, ${name}!`}
      </Heading>

      <Text size="md">
        {isVi
          ? 'Cảm ơn bạn đã tham gia ApexOS. Bây giờ bạn có thể kiếm hoa hồng từ mỗi giao dịch hợp lệ.'
          : 'Thanks for joining ApexOS. You can now earn commissions from every valid trade.'}
      </Text>

      <Button href={dashboardUrl}>{isVi ? 'Vào Dashboard' : 'Go to Dashboard'}</Button>

      <Text size="sm" color="#71717A">
        {isVi
          ? 'Hoàn thiện hồ sơ để bắt đầu nhận thông báo hoa hồng và thanh toán.'
          : 'Complete your profile to receive commission alerts and payouts.'}
      </Text>

      {referralCode && (
        <>
          <Heading level={3} align="left">
            {isVi ? 'Mã giới thiệu của bạn' : 'Your referral code'}
          </Heading>
          <Text size="md">
            {isVi ? `Chia sẻ mã này: ${referralCode}` : `Share this code: ${referralCode}`}
          </Text>
          <Button href={affiliateUrl} variant="secondary">
            {isVi ? 'Xem trang Affiliate' : 'Open Affiliate page'}
          </Button>
        </>
      )}
    </EmailLayout>
  );
}
