import { describe, it, expect } from '@jest/globals';
import {
  DEFAULT_NOTIFICATION_SETTINGS,
  type NotificationSettings,
  type UpdateProfileInput,
} from '@/types/profile';

describe('NotificationPreferences Types', () => {
  describe('DEFAULT_NOTIFICATION_SETTINGS', () => {
    it('should have valid default values', () => {
      expect(DEFAULT_NOTIFICATION_SETTINGS).toBeDefined();
      expect(DEFAULT_NOTIFICATION_SETTINGS.enabled_channels).toContain('email');
      expect(DEFAULT_NOTIFICATION_SETTINGS.severity_threshold).toBe('info');
      expect(DEFAULT_NOTIFICATION_SETTINGS.channel_config).toBeDefined();
      expect(DEFAULT_NOTIFICATION_SETTINGS.channel_config.email.enabled).toBe(true);
      expect(DEFAULT_NOTIFICATION_SETTINGS.channel_config.slack.enabled).toBe(false);
      expect(DEFAULT_NOTIFICATION_SETTINGS.channel_config.telegram.enabled).toBe(false);
      expect(DEFAULT_NOTIFICATION_SETTINGS.weekly_summary_enabled).toBe(true);
    });

    it('should have quiet hours configured by default', () => {
      expect(DEFAULT_NOTIFICATION_SETTINGS.quiet_hours).toBeDefined();
      expect(DEFAULT_NOTIFICATION_SETTINGS.quiet_hours?.enabled).toBe(false);
      expect(DEFAULT_NOTIFICATION_SETTINGS.quiet_hours?.start_hour).toBe(22);
      expect(DEFAULT_NOTIFICATION_SETTINGS.quiet_hours?.end_hour).toBe(8);
    });
  });

  describe('NotificationSettings structure', () => {
    it('should accept a valid notification settings object', () => {
      const settings: NotificationSettings = {
        enabled_channels: ['email', 'slack'],
        severity_threshold: 'warning',
        channel_config: {
          email: { enabled: true },
          slack: { enabled: true, config: { webhookUrl: 'https://example.com/webhook' } },
          telegram: { enabled: false },
        },
        quiet_hours: {
          enabled: true,
          start_hour: 23,
          end_hour: 7,
          timezone: 'Asia/Ho_Chi_Minh',
        },
        email_override: 'user@example.com',
        weekly_summary_enabled: false,
      };

      expect(settings.enabled_channels).toHaveLength(2);
      expect(settings.severity_threshold).toBe('warning');
      expect(settings.channel_config.email.enabled).toBe(true);
      expect(settings.quiet_hours?.timezone).toBe('Asia/Ho_Chi_Minh');
    });

    it('should only allow valid severity thresholds', () => {
      const validSeverities: AlertSeverityLevel[] = ['info', 'warning', 'critical'];
      validSeverities.forEach((severity) => {
        const settings = { ...DEFAULT_NOTIFICATION_SETTINGS, severity_threshold: severity };
        expect(settings.severity_threshold).toBe(severity);
      });
    });

    it('should only allow valid channel types', () => {
      const validChannels: UserNotificationChannel[] = ['email', 'slack', 'telegram'];
      validChannels.forEach((channel) => {
        const settings: NotificationSettings = {
          ...DEFAULT_NOTIFICATION_SETTINGS,
          channel_config: {
            ...DEFAULT_NOTIFICATION_SETTINGS.channel_config,
            [channel]: { enabled: true },
          },
        };
        expect(settings.channel_config[channel]).toBeDefined();
      });
    });
  });

  describe('UpdateProfileInput', () => {
    it('should accept partial updates including notification_settings', () => {
      const update: UpdateProfileInput = {
        full_name: 'John Doe',
        notification_settings: {
          enabled_channels: ['email'],
          severity_threshold: 'critical',
          channel_config: DEFAULT_NOTIFICATION_SETTINGS.channel_config,
          weekly_summary_enabled: true,
        },
      };

      expect(update.full_name).toBe('John Doe');
      expect(update.notification_settings).toBeDefined();
      expect(update.notification_settings?.severity_threshold).toBe('critical');
    });

    it('should allow updating only notification_settings', () => {
      const update: UpdateProfileInput = {
        notification_settings: {
          ...DEFAULT_NOTIFICATION_SETTINGS,
          severity_threshold: 'critical',
        },
      };

      expect(update.full_name).toBeUndefined();
      expect(update.notification_settings?.severity_threshold).toBe('critical');
    });
  });
});
