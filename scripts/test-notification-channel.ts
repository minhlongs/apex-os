#!/usr/bin/env tsx
/**
 * Quick Notification Channel Test
 *
 * Sends a test notification to a specific channel.
 * Useful for quick verification of individual channel configuration.
 *
 * Usage:
 *   tsx scripts/test-notification-channel.ts slack
 *   tsx scripts/test-notification-channel.ts email
 *   tsx scripts/test-notification-channel.ts telegram
 */

const channel = process.argv[2];

if (!channel || !['slack', 'email', 'telegram'].includes(channel)) {
  console.log(`
Usage: tsx scripts/test-notification-channel.ts <channel>

Channels:
  slack    - Test Slack webhook notification
  email    - Test Resend email notification
  telegram - Test Telegram bot notification

Example:
  tsx scripts/test-notification-channel.ts slack
  `);
  process.exit(1);
}

async function testSlack() {
  const { loadConfig, createNotificationService } = await import('@/lib/notifications/config');

  const config = loadConfig();

  if (!config.channels.slack?.enabled) {
    console.error('❌ Slack is not enabled or not configured');
    console.error('   Set SLACK_WEBHOOK_URL and SLACK_ENABLED=true in .env.local');
    process.exit(1);
  }

  const service = createNotificationService();

  console.log('🧪 Sending test Slack notification...');

  const result = await service.sendCustom(
    '🧪 ApexOS Test Notification',
    'This is a test message from the ApexOS alerting system. If you see this message in Slack, the integration is working correctly.',
    {
      test: true,
      channel: 'slack',
      timestamp: new Date().toISOString(),
      actions: [
        { label: 'View Dashboard', url: 'http://localhost:3000/admin/monitoring' },
        { label: 'Alert Config', url: 'http://localhost:3000/admin/alerts/config' },
      ],
    },
    { channels: ['slack'], priority: 'normal' }
  );

  const r = result[0];

  if (r.success) {
    console.log('✅ Slack notification sent successfully!');
    console.log(`   Message ID: ${r.messageId}`);
    console.log(`   Timestamp: ${r.timestamp.toISOString()}`);
  } else {
    console.log('❌ Slack notification failed');
    console.log(`   Error: ${r.error}`);
    process.exit(1);
  }
}

async function testEmail() {
  const { loadConfig, createNotificationService } = await import('@/lib/notifications/config');

  const config = loadConfig();

  if (!config.channels.email?.enabled) {
    console.error('❌ Email is not enabled or not configured');
    console.error('   Set RESEND_API_KEY in .env.local');
    process.exit(1);
  }

  const service = createNotificationService();

  console.log('🧪 Sending test email notification...');

  const result = await service.sendCustom(
    '🧪 ApexOS Test Notification',
    'This is a test email from the ApexOS alerting system. If you receive this email, the Resend integration is working correctly.',
    {
      test: true,
      channel: 'email',
      timestamp: new Date().toISOString(),
      environment: config.environment,
    },
    { channels: ['email'], priority: 'normal' }
  );

  const r = result[0];

  if (r.success) {
    console.log('✅ Email notification sent successfully!');
    console.log(`   Message ID: ${r.messageId}`);
    console.log(`   Timestamp: ${r.timestamp.toISOString()}`);
    console.log(`   Recipients: ${config.channels.email?.defaultRecipients.join(', ')}`);
  } else {
    console.log('❌ Email notification failed');
    console.log(`   Error: ${r.error}`);
    process.exit(1);
  }
}

async function testTelegram() {
  const { loadConfig, createNotificationService } = await import('@/lib/notifications/config');

  const config = loadConfig();

  if (!config.channels.telegram?.enabled) {
    console.error('❌ Telegram is not enabled or not configured');
    console.error('   Set TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS, and TELEGRAM_ENABLED=true');
    process.exit(1);
  }

  const service = createNotificationService();

  console.log('🧪 Sending test Telegram notification...');

  const result = await service.sendCustom(
    '🧪 ApexOS Test Notification',
    'This is a test message from the ApexOS alerting system. If you see this message in Telegram, the bot integration is working correctly.',
    {
      test: true,
      channel: 'telegram',
      timestamp: new Date().toISOString(),
    },
    { channels: ['telegram'], priority: 'normal' }
  );

  const r = result[0];

  if (r.success) {
    console.log('✅ Telegram notification sent successfully!');
    console.log(`   Message ID: ${r.messageId}`);
    console.log(`   Timestamp: ${r.timestamp.toISOString()}`);
    console.log(`   Chat IDs: ${config.channels.telegram?.chatIds.join(', ')}`);
  } else {
    console.log('❌ Telegram notification failed');
    console.log(`   Error: ${r.error}`);
    process.exit(1);
  }
}

// Run the selected test
switch (channel) {
  case 'slack':
    testSlack().catch(console.error);
    break;
  case 'email':
    testEmail().catch(console.error);
    break;
  case 'telegram':
    testTelegram().catch(console.error);
    break;
}
