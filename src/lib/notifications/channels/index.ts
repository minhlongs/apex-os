/**
 * Notification Channels Index
 * Re-exports all channel implementations
 */

export { SlackNotifier, createSlackNotifier } from './slack';
// SlackConfig is exported from config.ts, not slack.ts

export { EmailNotifierChannel, createEmailNotifierChannel } from './email';
// EmailConfig is exported from config.ts

export { TelegramNotifier, createTelegramNotifier } from './telegram';
// TelegramConfig is exported from config.ts

// Re-export config types from the parent config module
export type { SlackConfig, EmailConfig, TelegramConfig, NotificationConfig, NotificationChannel, NotificationPriority, NotificationMessage, SendResult, NotificationContext, ChannelNotifier } from '../config';
