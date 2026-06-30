/**
 * Email templates for ApexOS notifications
 * Uses inline styles for maximum email client compatibility
 */

import type {
  CommissionEarnedData,
  PayoutCompletedData,
  WeeklySummaryData,
  WelcomeData,
  PasswordResetData,
} from './types';

interface TemplateContext {
  locale: 'vi' | 'en';
  baseUrl: string;
}

const baseStyles = `
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
    line-height: 1.6;
    color: #1a1a1a;
    background-color: #f5f5f5;
    margin: 0;
    padding: 0;
  }
  .container {
    max-width: 600px;
    margin: 0 auto;
    background-color: #ffffff;
  }
  .header {
    background: linear-gradient(135deg, #6366f1 0%, #8b5cf6 100%);
    color: white;
    padding: 24px 32px;
    text-align: center;
  }
  .logo {
    font-size: 24px;
    font-weight: bold;
    margin: 0;
  }
  .content {
    padding: 32px;
  }
  .section {
    margin-bottom: 24px;
    padding: 16px;
    background-color: #f9fafb;
    border-radius: 8px;
  }
  .section-title {
    font-size: 14px;
    font-weight: 600;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 12px;
  }
  .amount {
    font-size: 28px;
    font-weight: bold;
    color: #6366f1;
  }
  .button {
    display: inline-block;
    padding: 12px 24px;
    background-color: #6366f1;
    color: white;
    text-decoration: none;
    border-radius: 8px;
    font-weight: 600;
    margin: 8px 4px;
  }
  .footer {
    text-align: center;
    padding: 24px;
    color: #6b7280;
    font-size: 14px;
    border-top: 1px solid #e5e7eb;
  }
  .footer a {
    color: #6366f1;
    text-decoration: none;
  }
  .stats-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 16px;
    margin-bottom: 24px;
  }
  .stat-card {
    text-align: center;
    padding: 16px;
    background-color: #f9fafb;
    border-radius: 8px;
  }
  .stat-value {
    font-size: 24px;
    font-weight: bold;
    color: #6366f1;
  }
  .stat-label {
    font-size: 12px;
    color: #6b7280;
    text-transform: uppercase;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    margin: 16px 0;
  }
  th, td {
    padding: 12px;
    text-align: left;
    border-bottom: 1px solid #e5e7eb;
  }
  th {
    font-weight: 600;
    color: #6b7280;
    font-size: 12px;
    text-transform: uppercase;
  }
`;

const translations: Record<'vi' | 'en', Record<string, string>> = {
  vi: {
    companyName: 'ApexOS',
    tagline: 'Cashback crypto toàn cầu',
    viewDashboard: 'Xem Bảng điều khiển',
    viewTransaction: 'Xem giao dịch',
    contactSupport: 'Liên hệ hỗ trợ',
    unsubscribe: 'Hủy đăng ký',
    privacyPolicy: 'Chính sách quyền riêng tư',
    termsOfService: 'Điều khoản dịch vụ',
    copyright: '© 2026 ApexOS. Mọi quyền được bảo lưu.',
    greeting: 'Xin chào',
    thanks: 'Cảm ơn bạn đã sử dụng ApexOS!',
  },
  en: {
    companyName: 'ApexOS',
    tagline: 'Global Crypto Cashback',
    viewDashboard: 'View Dashboard',
    viewTransaction: 'View Transaction',
    contactSupport: 'Contact Support',
    unsubscribe: 'Unsubscribe',
    privacyPolicy: 'Privacy Policy',
    termsOfService: 'Terms of Service',
    copyright: '© 2026 ApexOS. All rights reserved.',
    greeting: 'Hello',
    thanks: 'Thanks for using ApexOS!',
  },
};

function getTranslations(locale: 'vi' | 'en') {
  return translations[locale];
}

function buildFooter(ctx: TemplateContext): string {
  const t = getTranslations(ctx.locale);
  return `
    <div class="footer">
      <p>${t.thanks}</p>
      <p style="margin-top: 16px;">
        <a href="${ctx.baseUrl}/contact">${t.contactSupport}</a> |
        <a href="${ctx.baseUrl}/dashboard">${t.viewDashboard}</a>
      </p>
      <p style="margin-top: 16px; font-size: 12px;">
        ${t.unsubscribe} | <a href="${ctx.baseUrl}/privacy">${t.privacyPolicy}</a> | <a href="${ctx.baseUrl}/terms">${t.termsOfService}</a>
      </p>
      <p style="margin-top: 16px;">${t.copyright}</p>
    </div>
  `;
}

function buildHeader(ctx: TemplateContext): string {
  const t = getTranslations(ctx.locale);
  return `
    <div class="header">
      <h1 class="logo">${t.companyName}</h1>
      <p>${t.tagline}</p>
    </div>
  `;
}

/**
 * Commission earned email - sent when user earns commission from a referral's trade
 */
export function commissionEarnedTemplate(data: CommissionEarnedData & TemplateContext): string {
  const t = getTranslations(data.locale);

  const tierText = data.locale === 'vi'
    ? `Cấp ${data.tier} (${data.tier === 1 ? '30%' : data.tier === 2 ? '10%' : '5%'})`
    : `Tier ${data.tier} (${data.tier === 1 ? '30%' : data.tier === 2 ? '10%' : '5%'})`;

  const statusText = data.locale === 'vi'
    ? { pending: 'Chờ thanh toán', scheduled: `Sẽ thanh toán ${data.payoutDate}`, paid: 'Đã thanh toán' }
    : { pending: 'Pending payout', scheduled: `Scheduled for ${data.payoutDate}`, paid: 'Paid' };

  const amountFormatted = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(data.amount);

  const tradeVolumeFormatted = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(data.tradeVolume);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${t.companyName} - ${data.locale === 'vi' ? 'Bạn vừa nhận được hoa hồng!' : 'You earned a commission!'}</title>
      <style>${baseStyles}</style>
    </head>
    <body>
      <div class="container">
        ${buildHeader(data)}
        <div class="content">
          <p>${t.greeting} ${data.userName}!</p>
          <p>${data.locale === 'vi'
            ? 'Chúc mừng! Bạn vừa nhận được hoa hồng từ một giao dịch được giới thiệu.'
            : 'Congratulations! You just earned a commission from a referred trade.'}</p>

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Chi tiết hoa hồng' : 'Commission Details'}</div>
            <table>
              <tr>
                <th>${data.locale === 'vi' ? 'Giao dịch' : 'Deal'}</th>
                <td>${data.dealName}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Sàn giao dịch' : 'Exchange'}</th>
                <td>${data.exchange}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Khối lượng giao dịch' : 'Trade Volume'}</th>
                <td>${tradeVolumeFormatted}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Cấp hoa hồng' : 'Commission Tier'}</th>
                <td>${tierText}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Số tiền nhận được' : 'Amount Earned'}</th>
                <td class="amount">${amountFormatted}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Trạng thái' : 'Status'}</th>
                <td>${statusText[data.payoutStatus]}</td>
              </tr>
              ${data.payoutDate && data.payoutStatus === 'scheduled' ? `
              <tr>
                <th>${data.locale === 'vi' ? 'Ngày thanh toán dự kiến' : 'Expected Payout Date'}</th>
                <td>${data.payoutDate}</td>
              </tr>
              ` : ''}
            </table>
          </div>

          ${data.payoutStatus !== 'paid' ? `
          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Hoàn thành thanh toán' : 'Payout Info'}</div>
            <p>${data.locale === 'vi'
              ? 'Các khoản hoa hồng được thanh toán hàng tuần qua Stellar USDC. Kiểm tra trang thanh toán để xem lịch sử giao dịch của bạn.'
              : 'Commissions are paid out weekly via Stellar USDC. Check your payouts page for transaction history.'}</p>
          </div>
          ` : ''}

          <p style="text-align: center; margin-top: 32px;">
            <a href="${data.baseUrl}/dashboard/earnings" class="button">${t.viewDashboard}</a>
          </p>
        </div>
        ${buildFooter(data)}
      </div>
    </body>
    </html>
  `;
}

/**
 * Payout completed email - sent when a payout is processed
 */
export function payoutCompletedTemplate(data: PayoutCompletedData & TemplateContext): string {
  const t = getTranslations(data.locale);

  const amountFormatted = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(data.amount);

  const shortHash = `${data.transactionHash.slice(0, 8)}...${data.transactionHash.slice(-8)}`;

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${t.companyName} - ${data.locale === 'vi' ? 'Thanh toán đã hoàn tất' : 'Payout Completed'}</title>
      <style>${baseStyles}</style>
    </head>
    <body>
      <div class="container">
        ${buildHeader(data)}
        <div class="content">
          <p>${t.greeting} ${data.userName}!</p>
          <p>${data.locale === 'vi'
            ? 'Thanh toán của bạn đã được xử lý thành công! USDC đã được gửi đến ví của bạn.'
            : 'Your payout has been successfully processed! USDC has been sent to your wallet.'}</p>

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Chi tiết thanh toán' : 'Payout Details'}</div>
            <table>
              <tr>
                <th>${data.locale === 'vi' ? 'Số tiền' : 'Amount'}</th>
                <td class="amount">${amountFormatted} USDC</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Mạng lưới' : 'Network'}</th>
                <td>${data.network === 'testnet' ? 'Stellar Testnet' : 'Stellar Mainnet'}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Địa chỉ ví' : 'Wallet Address'}</th>
                <td style="font-family: monospace; font-size: 12px;">${data.walletAddress}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Mã giao dịch' : 'Transaction Hash'}</th>
                <td style="font-family: monospace; font-size: 12px;">
                  <a href="${data.explorerUrl}" style="color: #6366f1;">${shortHash}</a>
                </td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Ngày thanh toán' : 'Payout Date'}</th>
                <td>${data.payoutDate}</td>
              </tr>
            </table>
          </div>

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Xác nhận giao dịch' : 'Verify Transaction'}</div>
            <p>${data.locale === 'vi'
              ? 'Bạn có thể xác nhận giao dịch này trên trình khám phá Stellar:'
              : 'You can verify this transaction on the Stellar explorer:'}</p>
            <p style="text-align: center;">
              <a href="${data.explorerUrl}" class="button">${getTranslations(data.locale).viewTransaction}</a>
            </p>
          </div>

          <p style="text-align: center; margin-top: 32px;">
            <a href="${data.baseUrl}/dashboard/payouts" class="button">${getTranslations(data.locale).viewDashboard}</a>
          </p>
        </div>
        ${buildFooter(data)}
      </div>
    </body>
    </html>
  `;
}

/**
 * Weekly summary email for affiliates
 */
export function weeklySummaryTemplate(data: WeeklySummaryData & TemplateContext): string {
  const t = getTranslations(data.locale);

  const totalEarningsFormatted = new Intl.NumberFormat(data.locale === 'vi' ? 'vi-VN' : 'en-US', {
    style: 'currency',
    currency: 'USD',
  }).format(data.totalEarnings);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${t.companyName} - ${data.locale === 'vi' ? 'Tóm tắt hàng tuần' : 'Weekly Summary'}</title>
      <style>${baseStyles}</style>
    </head>
    <body>
      <div class="container">
        ${buildHeader(data)}
        <div class="content">
          <p>${t.greeting} ${data.userName}!</p>
          <p>${data.locale === 'vi'
            ? 'Đây là tóm tắt hoạt động và hoa hồng của bạn trong tuần qua.'
            : 'Here is your activity summary and earnings for the past week.'}</p>

          <div class="stats-grid">
            <div class="stat-card">
              <div class="stat-value">${data.conversionsCount}</div>
              <div class="stat-label">${data.locale === 'vi' ? 'Giao dịch' : 'Conversions'}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value">${data.activeReferrals}</div>
              <div class="stat-label">${data.locale === 'vi' ? 'Giới thiệu đang hoạt động' : 'Active Referrals'}</div>
            </div>
            <div class="stat-card">
              <div class="stat-value" style="color: #10b981;">${totalEarningsFormatted}</div>
              <div class="stat-label">${data.locale === 'vi' ? 'Thu nhập tuần này' : 'Weekly Earnings'}</div>
            </div>
          </div>

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Thông tin kỳ thanh toán' : 'Period Details'}</div>
            <table>
              <tr>
                <th>${data.locale === 'vi' ? 'Ngày bắt đầu' : 'Period Start'}</th>
                <td>${data.periodStart}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Ngày kết thúc' : 'Period End'}</th>
                <td>${data.periodEnd}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Xếp hạng affiliate' : 'Affiliate Rank'}</th>
                <td>${data.affiliateRank}</td>
              </tr>
              <tr>
                <th>${data.locale === 'vi' ? 'Thanh toán tiếp theo' : 'Next Payout'}</th>
                <td>${data.nextPayoutDate}</td>
              </tr>
            </table>
          </div>

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Cơ hội tăng thu nhập' : 'Growth Tips'}</div>
            <p>${data.locale === 'vi'
              ? '• Chia sẻ liên kết giới thiệu của bạn với nhiều người hơn\n• Theo dõi hiệu suất của bạn trên bảng điều khiển affiliate\n• Nâng cấp lên cấp độ cao hơn để nhận tỷ lệ hoa hồng cao hơn'
              : '• Share your referral link with more people\n• Track your performance on the affiliate dashboard\n• Level up to higher tiers for better commission rates'}</p>
          </div>

          <p style="text-align: center; margin-top: 32px;">
            <a href="${data.baseUrl}/dashboard/affiliate" class="button">${t.viewDashboard}</a>
          </p>
        </div>
        ${buildFooter(data)}
      </div>
    </body>
    </html>
  `;
}

/**
 * Welcome email for new users
 */
export function welcomeTemplate(data: WelcomeData & TemplateContext): string {
  const t = getTranslations(data.locale);

  const roleText = data.locale === 'vi'
    ? { shopper: 'Người mua hàng', affiliate: 'Đối tác affiliate', admin: 'Quản trị viên' }
    : { shopper: 'Shopper', affiliate: 'Affiliate Partner', admin: 'Administrator' };

  const welcomeMessage = data.locale === 'vi'
    ? {
        shopper: 'Chào mừng bạn đến với ApexOS! Bây giờ bạn có thể kiếm tiền mặt từ giao dịch crypto của mình.',
        affiliate: 'Chào mừng bạn đến với ApexOS! Với tư cách là đối tác affiliate, bạn có thể kiếm hoa hồng lên đến 30% từ giới thiệu.',
        admin: 'Chào mừng bạn đến với ApexOS! Tài khoản quản trị của bạn đã được thiết lập.',
      }
    : {
        shopper: 'Welcome to ApexOS! You can now earn cashback on your crypto trades.',
        affiliate: 'Welcome to ApexOS! As an affiliate partner, you can earn up to 30% in referral commissions.',
        admin: 'Welcome to ApexOS! Your administrator account has been set up.',
      };

  const verificationSection = data.verificationToken ? `
    <div class="section">
      <div class="section-title">${data.locale === 'vi' ? 'Xác minh email' : 'Verify Your Email'}</div>
      <p>${data.locale === 'vi'
        ? 'Vui lòng xác minh địa chỉ email của bạn bằng cách nhấp vào nút bên dưới:'
        : 'Please verify your email address by clicking the button below:'}</p>
      <p style="text-align: center;">
        <a href="${data.baseUrl}/verify-email?token=${data.verificationToken}" class="button">${data.locale === 'vi' ? 'Xác minh Email' : 'Verify Email'}</a>
      </p>
    </div>
  ` : '';

  const referralSection = data.referralCode ? `
    <div class="section">
      <div class="section-title">${data.locale === 'vi' ? 'Mã giới thiệu của bạn' : 'Your Referral Code'}</div>
      <p style="font-size: 18px; font-weight: bold; text-align: center; padding: 16px; background: #f3f4f6; border-radius: 8px;">
        ${data.referralCode}
      </p>
      <p style="text-align: center; margin-top: 8px;">
        <a href="${data.baseUrl}/referral?code=${data.referralCode}" class="button">${data.locale === 'vi' ? 'Chia sẻ liên kết' : 'Share Your Link'}</a>
      </p>
    </div>
  ` : '';

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${t.companyName} - ${data.locale === 'vi' ? 'Chào mừng!' : 'Welcome!'}</title>
      <style>${baseStyles}</style>
    </head>
    <body>
      <div class="container">
        ${buildHeader(data)}
        <div class="content">
          <p>${t.greeting} ${data.userName}!</p>
          <p>${welcomeMessage[data.role]}</p>

          ${verificationSection}

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Vai trò tài khoản' : 'Your Account Role'}</div>
            <p style="font-size: 18px; font-weight: bold; text-align: center;">${roleText[data.role]}</p>
          </div>

          ${referralSection}

          <div class="section">
            <div class="section-title">${data.locale === 'vi' ? 'Bắt đầu ngay' : 'Getting Started'}</div>
            <p>${data.locale === 'vi'
              ? '• Hoàn thiện hồ sơ của bạn và thêm địa chỉ ví\n• Khám phá các giao dịch trên trang Deals\n• Theo dõi hoa hồng của bạn từ Bảng điều khiển'
              : '• Complete your profile and add wallet addresses\n• Explore deals on the Deals page\n• Track your commissions from the Dashboard'}</p>
          </div>

          <p style="text-align: center; margin-top: 32px;">
            <a href="${data.baseUrl}/dashboard" class="button">${t.viewDashboard}</a>
          </p>
        </div>
        ${buildFooter(data)}
      </div>
    </body>
    </html>
  `;
}

/**
 * Password reset email
 */
export function passwordResetTemplate(data: PasswordResetData & TemplateContext): string {
  const t = getTranslations(data.locale);

  return `
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${t.companyName} - ${data.locale === 'vi' ? 'Đặt lại mật khẩu' : 'Reset Password'}</title>
      <style>${baseStyles}</style>
    </head>
    <body>
      <div class="container">
        ${buildHeader(data)}
        <div class="content">
          <p>${t.greeting} ${data.userName}!</p>
          <p>${data.locale === 'vi'
            ? 'Chúng tôi nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.'
            : 'We received a request to reset your password.'}</p>

          <div class="section" style="text-align: center;">
            <div class="section-title">${data.locale === 'vi' ? 'Đặt lại mật khẩu' : 'Reset Your Password'}</div>
            <p style="margin-bottom: 16px;">${data.locale === 'vi'
              ? 'Nhấp vào nút bên dưới để chọn mật khẩu mới:'
              : 'Click the button below to choose a new password:'}</p>
            <a href="${data.resetUrl}" class="button" style="font-size: 16px; padding: 16px 32px;">
              ${data.locale === 'vi' ? 'Đặt lại mật khẩu' : 'Reset Password'}
            </a>
            <p style="margin-top: 16px; font-size: 12px; color: #6b7280;">
              ${data.locale === 'vi'
                ? `Liên kết này sẽ hết hạn sau ${data.expiresIn}.`
                : `This link will expire in ${data.expiresIn}.`}
            </p>
          </div>

          <div class="section">
            <p style="color: #6b7280; font-size: 14px;">
              ${data.locale === 'vi'
                ? 'Nếu bạn không yêu cầu đặt lại mật khẩu, vui lòng bỏ qua email này. Mật khẩu của bạn vẫn được bảo mật.'
                : 'If you did not request a password reset, please ignore this email. Your password remains secure.'}
            </p>
          </div>

          <p style="text-align: center; margin-top: 32px;">
            <a href="${data.baseUrl}/login" class="button">${getTranslations(data.locale).viewDashboard}</a>
          </p>
        </div>
        ${buildFooter(data)}
      </div>
    </body>
    </html>
  `;
}

/**
 * Default plain text template for emails without HTML
 */
export function plainTextTemplate(
  locale: 'vi' | 'en',
  baseUrl: string,
  userName: string,
  subject: string,
  message: string,
  actions?: Array<{ label: string; url: string }>
): string {
  const t = getTranslations(locale);

  let text = `
${t.companyName} - ${subject}

${t.greeting} ${userName},

${message}
`;

  if (actions && actions.length > 0) {
    text += '\n' + (locale === 'vi' ? 'Hành động:' : 'Actions:') + '\n';
    actions.forEach(action => {
      text += `• ${action.label}: ${baseUrl}${action.url}\n`;
    });
  }

  text += `
---
${t.thanks}
${t.companyName} - ${baseUrl}
`;

  return text.trim();
}
