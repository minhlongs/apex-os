/**
 * Email Notifier Usage Examples
 *
 * This file demonstrates how to use the EmailNotifier service
 * for various notification types in ApexOS.
 */

import { emailNotifier } from './index';
import type { EmailNotification } from './types';

// ============================================================================
// Basic Usage: Send a simple email
// ============================================================================

async function exampleSimpleEmail() {
  const result = await emailNotifier.send({
    to: 'user@example.com',
    subject: 'Test Email from ApexOS',
    html: '<h1>Hello!</h1><p>This is a test email.</p>',
    text: 'Hello! This is a test email.',
  });

  console.log('Send result:', result);
}

// ============================================================================
// Commission Earned Notification
// ============================================================================

async function exampleCommissionEarned() {
  const notification: EmailNotification<'commission-earned'> = {
    type: 'commission-earned',
    data: {
      locale: 'vi',
      baseUrl: 'https://apexos.io',
      userName: 'Nguyễn Văn A',
      userEmail: 'nguyenvana@example.com',
      amount: 15.50,
      dealName: 'Binance Spot Trading - 50% Cashback',
      exchange: 'Binance',
      tradeVolume: 1000,
      tier: 1,
      payoutStatus: 'pending',
    },
  };

  const result = await emailNotifier.sendNotification(notification);
  console.log('Commission email sent:', result);
}

// ============================================================================
// Payout Completed Notification
// ============================================================================

async function examplePayoutCompleted() {
  const notification: EmailNotification<'payout-completed'> = {
    type: 'payout-completed',
    data: {
      locale: 'en',
      baseUrl: 'https://apexos.io',
      userName: 'John Doe',
      userEmail: 'john@example.com',
      amount: 150.75,
      transactionHash: 'SCL2I5O7QPMXUY3B4WTVG5N6J9K8L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6A7B8C9D0E1F2',
      walletAddress: 'GBBM6BKZPEHyo4c7bZ4yT3K2C5X7b9V6w8z1q2r3s4t5u6v',
      network: 'testnet',
      payoutDate: '2026-06-21',
      explorerUrl: 'https://stellar.expert/explorer/testnet/tx/SCL2I5O7QPMXUY3B4WTVG5N6J9K8L2M3N4O5P6Q7R8S9T0U1V2W3X4Y5Z6A7B8C9D0E1F2',
    },
  };

  const result = await emailNotifier.sendNotification(notification);
  console.log('Payout email sent:', result);
}

// ============================================================================
// Weekly Summary Notification
// ============================================================================

async function exampleWeeklySummary() {
  const notification: EmailNotification<'weekly-summary'> = {
    type: 'weekly-summary',
    data: {
      locale: 'vi',
      baseUrl: 'https://apexos.io',
      userName: 'Trần Thị B',
      userEmail: 'tranthib@example.com',
      periodStart: '2026-06-15',
      periodEnd: '2026-06-21',
      totalEarnings: 245.50,
      conversionsCount: 12,
      activeReferrals: 8,
      affiliateRank: 'Gold Affiliate',
      nextPayoutDate: '2026-06-28',
    },
  };

  const result = await emailNotifier.sendNotification(notification);
  console.log('Weekly summary sent:', result);
}

// ============================================================================
// Welcome Email
// ============================================================================

async function exampleWelcome() {
  const notification: EmailNotification<'welcome'> = {
    type: 'welcome',
    data: {
      locale: 'en',
      baseUrl: 'https://apexos.io',
      userName: 'Alice Smith',
      userEmail: 'alice@example.com',
      role: 'affiliate',
      verificationToken: 'abc123def456',
      referralCode: 'ALICE20',
    },
  };

  const result = await emailNotifier.sendNotification(notification);
  console.log('Welcome email sent:', result);
}

// ============================================================================
// Password Reset Email
// ============================================================================

async function examplePasswordReset() {
  const notification: EmailNotification<'password-reset'> = {
    type: 'password-reset',
    data: {
      locale: 'vi',
      baseUrl: 'https://apexos.io',
      userName: 'Minh Nguyễn',
      userEmail: 'minh@example.com',
      resetUrl: 'https://apexos.io/reset-password?token=xyz789',
      expiresIn: '24 hours',
    },
  };

  const result = await emailNotifier.sendNotification(notification);
  console.log('Password reset email sent:', result);
}

// ============================================================================
// Email Verification
// ============================================================================

async function exampleEmailVerification() {
  const notification: EmailNotification<'email-verification'> = {
    type: 'email-verification',
    data: {
      locale: 'en',
      baseUrl: 'https://apexos.io',
      userName: 'Bob Wilson',
      userEmail: 'bob@example.com',
      verificationUrl: 'https://apexos.io/verify?token=verify123',
      expiresIn: '7 days',
    },
  };

  const result = await emailNotifier.sendNotification(notification);
  console.log('Verification email sent:', result);
}

// ============================================================================
// Dry Run Mode (for development/testing)
// ============================================================================

async function exampleDryRun() {
  const notifier = emailNotifier; // singleton uses env config

  // Or create a custom instance with dryRun enabled:
  // import { createEmailNotifier } from './index';
  // const notifier = createEmailNotifier({ dryRun: true });

  // Emails will be logged to console instead of sent
  await notifier.sendNotification({
    type: 'welcome',
    data: {
      locale: 'en',
      baseUrl: 'https://apexos.io',
      userName: 'Test User',
      userEmail: 'test@example.com',
      role: 'shopper',
    },
  });
}

// ============================================================================
// Environment Variables Required
// ============================================================================
/*
Create a `.env.local` file with:

RESEND_API_KEY=re_your_api_key_here
RESEND_FROM_EMAIL=noreply@apexos.io
RESEND_FROM_NAME=ApexOS
NEXT_PUBLIC_BASE_URL=https://apexos.io

For development without sending real emails:
RESEND_SEND_REAL=true  # Set to false or omit for dryRun in dev
*/

export {
  exampleSimpleEmail,
  exampleCommissionEarned,
  examplePayoutCompleted,
  exampleWeeklySummary,
  exampleWelcome,
  examplePasswordReset,
  exampleEmailVerification,
  exampleDryRun,
};
