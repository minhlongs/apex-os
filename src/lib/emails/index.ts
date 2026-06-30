/**
 * Email module exports
 */

export * from './types';
export * from './templates';
export * from './email-queue';
export * from './email-scheduler';
export * from './email-campaigns';
export { EmailNotifier, createEmailNotifier, emailNotifier } from './notifier';
