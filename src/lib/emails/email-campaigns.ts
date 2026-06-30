/**
 * Email Campaigns
 * Lifecycle triggers: welcome series, re-engagement, win-back
 */

import { getEmailQueueService } from './email-queue';
import { createEmailNotifier } from './notifier';
import { getDB } from '@/lib/db';

const queue = getEmailQueueService();

// ============================================================================
// Helpers
// ============================================================================

function buildHtml(
  locale: 'vi' | 'en',
  title: string,
  body: string,
  ctaLabel: string,
  ctaUrl: string
): string {
  const t: Record<string, Record<string, string>> = {
    vi: { greeting: 'Xin chào', footer: '© 2026 ApexOS. Mọi quyền được bảo lưu.' },
    en: { greeting: 'Hello', footer: '© 2026 ApexOS. All rights reserved.' },
  };
  const strings = t[locale] ?? t.en;
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;margin:0;padding:0}
.container{max-width:600px;margin:0 auto;background:#fff}
.header{background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;padding:24px 32px;text-align:center}
.content{padding:32px}
.button{display:inline-block;padding:12px 24px;background:#6366f1;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;margin:16px 0}
.footer{text-align:center;padding:24px;color:#6b7280;font-size:13px;border-top:1px solid #e5e7eb}
</style></head>
<body><div class="container">
<div class="header"><h1>ApexOS</h1></div>
<div class="content"><p>${strings.greeting},</p><p>${body}</p>
<a href="${ctaUrl}" class="button">${ctaLabel}</a></div>
<div class="footer"><p>${strings.footer}</p></div></div></body></html>`;
}

function enqueueCampaign(
  userId: string,
  email: string,
  type: string,
  subject: string,
  html: string,
  text: string,
  priority = 2
): void {
  queue.enqueue({ userId, email, type, subject, html, text, priority });
}

// ============================================================================
// 1. Welcome Series
// Trigger: user signs up
// ============================================================================

export interface WelcomeSeriesInput {
  userId: string;
  email: string;
  name: string;
  locale: 'vi' | 'en';
  role: 'shopper' | 'affiliate' | 'admin';
  referralCode?: string;
  baseUrl: string;
}

export function triggerWelcomeSeries(input: WelcomeSeriesInput): void {
  const { userId, email, name, locale, role, referralCode, baseUrl } = input;
  const isVi = locale === 'vi';

  const step1Subject = isVi ? '👋 Chào mừng đến ApexOS!' : '👋 Welcome to ApexOS!';
  const step1Body = isVi
    ? `Cảm ơn bạn đã đăng ký, ${name}! Hãy hoàn thiện hồ sơ để bắt đầu kiếm hoa hồng.`
    : `Thanks for signing up, ${name}! Complete your profile to start earning.`;
  const step1Html = buildHtml(locale, step1Subject, step1Body, isVi ? 'Bắt đầu ngay' : 'Get Started', `${baseUrl}/dashboard`);
  enqueueCampaign(userId, email, 'welcome-series-step-1', step1Subject, step1Html, step1Body, 2);

  const step2Subject = isVi ? '💡 Mẹo bắt đầu với ApexOS' : '💡 Getting Started Tips';
  const step2Body = isVi
    ? `Bạn đã biết? Chỉ cần chia sẻ link affiliate là có thể kiếm hoa hồng lên đến 30%!`
    : `Did you know? Simply sharing your affiliate link earns you up to 30% commission!`;
  const step2Html = buildHtml(locale, step2Subject, step2Body, isVi ? 'Xem hướng dẫn' : 'View Guide', `${baseUrl}/affiliate`);
  enqueueCampaign(userId, email, 'welcome-series-step-2', step2Subject, step2Html, step2Body, 3);

  const step3Subject = isVi ? '🔥 Deal hot đang chờ bạn' : '🔥 Hot Deals Awaiting You';
  const step3Body = isVi
    ? `Khám phá các deal hấp dẫn từ Binance, Bybit, OKX và KuCoin ngay!`
    : `Explore attractive deals from Binance, Bybit, OKX and KuCoin now!`;
  const step3Html = buildHtml(locale, step3Subject, step3Body, isVi ? 'Xem deals' : 'Browse Deals', `${baseUrl}/deals`);
  enqueueCampaign(userId, email, 'welcome-series-step-3', step3Subject, step3Html, step3Body, 3);

  if (role === 'affiliate' && referralCode) {
    const refSubject = isVi ? '🎯 Mã affiliate của bạn' : '🎯 Your Affiliate Code';
    const refBody = isVi
      ? `Mã giới thiệu của bạn là ${referralCode}. Chia sẻ ngay để kiếm hoa hồng!`
      : `Your referral code is ${referralCode}. Share it now to earn commissions!`;
    const refHtml = buildHtml(locale, refSubject, refBody, isVi ? 'Sao chép mã' : 'Copy Code', `${baseUrl}/affiliate`);
    enqueueCampaign(userId, email, 'welcome-affiliate-code', refSubject, refHtml, refBody, 2);
  }
}

// ============================================================================
// 2. Re-engagement
// Trigger: user logged in but no activity for 14 days
// ============================================================================

export interface ReEngagementInput {
  userId: string;
  email: string;
  name: string;
  locale: 'vi' | 'en';
  daysSinceLastActive: number;
  baseUrl: string;
}

export function triggerReEngagement(input: ReEngagementInput): void {
  const { userId, email, name, locale, daysSinceLastActive, baseUrl } = input;
  const isVi = locale === 'vi';

  const subject = isVi
    ? `Chúng tôi nhớ bạn, ${name}!`
    : `We miss you, ${name}!`;
  const body = isVi
    ? `Bạn đã không hoạt động ${daysSinceLastActive} ngày. Có deal mới đang chờ bạn khám phá!`
    : `You've been inactive for ${daysSinceLastActive} days. New deals are waiting for you!`;
  const html = buildHtml(locale, subject, body, isVi ? 'Xem deals mới' : 'See New Deals', `${baseUrl}/deals`);
  enqueueCampaign(userId, email, 're-engagement', subject, html, body, 3);
}

// ============================================================================
// 3. Win-back
// Trigger: user inactive for 30+ days
// ============================================================================

export interface WinBackInput {
  userId: string;
  email: string;
  name: string;
  locale: 'vi' | 'en';
  daysSinceLastActive: number;
  baseUrl: string;
}

export function triggerWinBack(input: WinBackInput): void {
  const { userId, email, name, locale, daysSinceLastActive, baseUrl } = input;
  const isVi = locale === 'vi';

  const subject = isVi
    ? `🎁 Quay lại ApexOS — Ưu đãi đặc biệt cho bạn!`
    : `🎁 Come Back to ApexOS — Special Offer for You!`;
  const body = isVi
    ? `Bạn đã vắng mặt ${daysSinceLastActive} ngày. Đừng bỏ lỡ cơ hội kiếm hoa hồng lên đến 30%!`
    : `You've been away for ${daysSinceLastActive} days. Don't miss out on earning up to 30% commission!`;
  const html = buildHtml(locale, subject, body, isVi ? 'Quay lại ngay' : 'Come Back Now', `${baseUrl}/deals`);
  enqueueCampaign(userId, email, 'win-back', subject, html, body, 3);
}

// ============================================================================
// 4. Campaign Scheduler (cron-triggered)
// ============================================================================

export interface CampaignScanResult {
  welcomeSeries: number;
  reEngagement: number;
  winBack: number;
  errors: string[];
}

/** Scan users and enqueue lifecycle campaigns based on activity */
export async function runLifecycleCampaigns(): Promise<CampaignScanResult> {
  const db = getDB();
  if (!db) {
    return { welcomeSeries: 0, reEngagement: 0, winBack: 0, errors: ['DB not configured'] };
  }

  const result: CampaignScanResult = { welcomeSeries: 0, reEngagement: 0, winBack: 0, errors: [] };
  const baseUrl = process.env.NEXT_PUBLIC_BASE_URL || 'http://localhost:3000';

  try {
    // 1. New users without welcome-series-step-1 in queue
    const newUsers = await db.prepare(
      `SELECT p.id, p.email, p.full_name, p.role, p.referral_code
       FROM profiles p
       WHERE p.created_at >= datetime('now', '-7 days')
         AND NOT EXISTS (
           SELECT 1 FROM email_queue WHERE user_id = p.id AND type = 'welcome-series-step-1'
         )`
    ).all();

    for (const u of newUsers.results as Array<{
      id: string;
      email: string;
      full_name: string;
      role: string;
      referral_code?: string;
    }>) {
      try {
        triggerWelcomeSeries({
          userId: u.id,
          email: u.email,
          name: u.full_name || 'User',
          locale: 'en',
          role: (u.role as 'shopper' | 'affiliate' | 'admin') || 'shopper',
          referralCode: u.referral_code,
          baseUrl,
        });
        result.welcomeSeries++;
      } catch (err) {
        result.errors.push(`welcome ${u.id}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 2. Re-engagement: last_active > 14d and <= 30d
    const reEngageUsers = await db.prepare(
      `SELECT p.id, p.email, p.full_name,
              julianday('now') - julianday(p.updated_at) as days_ago
       FROM profiles p
       WHERE p.updated_at <= datetime('now', '-14 days')
         AND p.updated_at > datetime('now', '-30 days')
         AND NOT EXISTS (
           SELECT 1 FROM email_queue WHERE user_id = p.id AND type = 're-engagement'
         )`
    ).all();

    for (const u of reEngageUsers.results as Array<{
      id: string;
      email: string;
      full_name: string;
      days_ago: number;
    }>) {
      try {
        triggerReEngagement({
          userId: u.id,
          email: u.email,
          name: u.full_name || 'User',
          locale: 'en',
          daysSinceLastActive: Math.floor(u.days_ago),
          baseUrl,
        });
        result.reEngagement++;
      } catch (err) {
        result.errors.push(`re-engagement ${u.id}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }

    // 3. Win-back: last_active > 30d
    const winBackUsers = await db.prepare(
      `SELECT p.id, p.email, p.full_name,
              julianday('now') - julianday(p.updated_at) as days_ago
       FROM profiles p
       WHERE p.updated_at <= datetime('now', '-30 days')
         AND NOT EXISTS (
           SELECT 1 FROM email_queue WHERE user_id = p.id AND type = 'win-back'
         )`
    ).all();

    for (const u of winBackUsers.results as Array<{
      id: string;
      email: string;
      full_name: string;
      days_ago: number;
    }>) {
      try {
        triggerWinBack({
          userId: u.id,
          email: u.email,
          name: u.full_name || 'User',
          locale: 'en',
          daysSinceLastActive: Math.floor(u.days_ago),
          baseUrl,
        });
        result.winBack++;
      } catch (err) {
        result.errors.push(`win-back ${u.id}: ${err instanceof Error ? err.message : 'unknown'}`);
      }
    }
  } catch (err) {
    result.errors.push(err instanceof Error ? err.message : 'Campaign scan failed');
  }

  return result;
}
