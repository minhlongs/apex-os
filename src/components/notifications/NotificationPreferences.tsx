'use client';

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import { Check, Save, AlertCircle } from 'lucide-react';
import { useToast } from '@/components/toast/ToastProvider';
import type { NotificationSettings, UserNotificationChannel, AlertSeverityLevel } from '@/types/profile';

const SEVERITY_OPTIONS: { value: AlertSeverityLevel; labelKey: string; descriptionKey: string }[] = [
  { value: 'info', labelKey: 'all', descriptionKey: 'infoDesc' },
  { value: 'warning', labelKey: 'warningAndCritical', descriptionKey: 'warningAndCriticalDesc' },
  { value: 'critical', labelKey: 'criticalOnly', descriptionKey: 'criticalOnlyDesc' },
];

const CHANNEL_LABELS: Record<UserNotificationChannel, string> = {
  email: 'Email',
  slack: 'Slack',
  telegram: 'Telegram',
};

interface NotificationPreferencesProps {
  initialSettings: NotificationSettings;
  onSave?: (settings: NotificationSettings) => Promise<void>;
}

export function NotificationPreferences({ initialSettings, onSave }: NotificationPreferencesProps) {
  const t = useTranslations('notifications');
  const toast = useToast();
  const [settings, setSettings] = useState<NotificationSettings>(initialSettings);
  const [isSaving, setIsSaving] = useState(false);
  const [hasChanges, setHasChanges] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSettings(initialSettings);
  }, [initialSettings]);

  const updateSetting = <K extends keyof NotificationSettings>(
    key: K,
    value: NotificationSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setHasChanges(true);
    setError(null);
  };

  const updateChannelConfig = (channel: UserNotificationChannel, enabled: boolean, config?: Record<string, unknown>) => {
    setSettings(prev => ({
      ...prev,
      channel_config: {
        ...prev.channel_config,
        [channel]: { enabled, config: config ?? prev.channel_config[channel].config },
      },
      // Update enabled_channels if enabling/disabling
      enabled_channels: enabled
        ? [...prev.enabled_channels.filter(c => c !== channel), channel]
        : prev.enabled_channels.filter(c => c !== channel),
    }));
    setHasChanges(true);
    setError(null);
  };

  const updateQuietHours = (field: 'enabled' | 'start_hour' | 'end_hour' | 'timezone', value: boolean | number | string) => {
    setSettings(prev => ({
      ...prev,
      // The computed key spread of an optional block cannot prove the required
      // fields survive; the runtime object shape is unchanged.
      quiet_hours: {
        ...prev.quiet_hours,
        [field]: value,
      } as NonNullable<NotificationSettings['quiet_hours']>,
    }));
    setHasChanges(true);
    setError(null);
  };

  const handleSave = async () => {
    if (!onSave) return;

    setIsSaving(true);
    setError(null);
    try {
      await onSave(settings);
      setHasChanges(false);
      toast.addToast({
        type: 'success',
        title: t('settingsSaved'),
        message: '',
        duration: 3000,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : t('saveError');
      setError(message);
      toast.addToast({
        type: 'error',
        title: t('saveError'),
        message,
        duration: 5000,
      });
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Channel Preferences */}
      <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-stitch-primary">{t('channelPreferences')}</h3>
          <p className="text-sm text-stitch-muted mt-1">{t('channelPreferencesDesc')}</p>
        </div>
        <div className="space-y-4">
          {(Object.keys(CHANNEL_LABELS) as UserNotificationChannel[]).map((channel) => {
            const isEnabled = settings.enabled_channels.includes(channel);

            return (
              <div key={channel} className="flex items-center justify-between p-4 border border-stitch-border bg-stitch-canvas rounded-xl hover:bg-stitch-well/50 transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <label className="font-medium text-stitch-primary cursor-pointer">
                      {CHANNEL_LABELS[channel]}
                    </label>
                    {isEnabled ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-stitch-emerald/15 text-stitch-emerald border border-stitch-emerald/30">
                        <Check className="h-3 w-3 mr-1" />
                        {t('channelConfigured')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-stitch-well text-stitch-muted border border-stitch-border">
                        {t('channelNotConfigured')}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-stitch-muted mt-1">
                    {t(`channelDescriptions.${channel}`)}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  onClick={() => updateChannelConfig(channel, !isEnabled)}
                  disabled={isSaving}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-stitch-indigo ${
                    isEnabled ? 'bg-stitch-indigo' : 'bg-stitch-well'
                  }`}
                >
                  <span
                    aria-hidden="true"
                    className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                      isEnabled ? 'translate-x-5' : 'translate-x-0'
                    }`}
                  />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      {/* Severity Threshold */}
      <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-stitch-primary">{t('severityThreshold')}</h3>
          <p className="text-sm text-stitch-muted mt-1">{t('severityThresholdDesc')}</p>
        </div>
        <div className="max-w-md">
          <label htmlFor="severity-threshold" className="block text-sm font-medium text-stitch-muted mb-2">
            {t('selectSeverity')}
          </label>
          <select
            id="severity-threshold"
            value={settings.severity_threshold}
            onChange={(e) => updateSetting('severity_threshold', e.target.value as AlertSeverityLevel)}
            disabled={isSaving}
            className="block w-full rounded-lg border border-stitch-border bg-stitch-well px-3 py-2 text-sm text-stitch-primary outline-none focus:border-stitch-indigo disabled:opacity-60 disabled:cursor-not-allowed"
          >
            {SEVERITY_OPTIONS.map(({ value, labelKey }) => (
              <option key={value} value={value}>
                {t(`severityOptions.${labelKey}`)}
              </option>
            ))}
          </select>
          <p className="text-xs text-stitch-muted mt-2">
            {settings.severity_threshold === 'info'
              ? t('severityOptions.all')
              : settings.severity_threshold === 'warning'
              ? t('severityOptions.warningAndCritical')
              : t('severityOptions.criticalOnly')}
          </p>
        </div>
      </div>

      {/* Email Configuration */}
      {settings.enabled_channels.includes('email') && (
        <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
          <div className="mb-4">
            <h3 className="text-lg font-semibold text-stitch-primary">{t('emailSettings')}</h3>
            <p className="text-sm text-stitch-muted mt-1">{t('emailSettingsDesc')}</p>
          </div>
          <div className="max-w-md">
            <label htmlFor="email-override" className="block text-sm font-medium text-stitch-muted mb-2">
              {t('emailAddress')}
            </label>
            <input
              id="email-override"
              type="email"
              value={settings.email_override || ''}
              onChange={(e) => updateSetting('email_override', e.target.value || undefined)}
              placeholder={t('emailPlaceholder')}
              disabled={isSaving}
              className="block w-full rounded-lg border border-stitch-border bg-stitch-well px-3 py-2 text-sm text-stitch-primary outline-none focus:border-stitch-indigo disabled:opacity-60 disabled:cursor-not-allowed"
            />
            <p className="text-xs text-stitch-muted mt-2">{t('emailHelp')}</p>
          </div>
        </div>
      )}

      {/* Quiet Hours */}
      <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-stitch-primary">{t('quietHours')}</h3>
          <p className="text-sm text-stitch-muted mt-1">{t('quietHoursDesc')}</p>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label htmlFor="quiet-hours-enabled" className="text-sm font-medium text-stitch-primary cursor-pointer">
              {t('enableQuietHours')}
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={settings.quiet_hours?.enabled || false}
              onClick={() => updateQuietHours('enabled', !(settings.quiet_hours?.enabled || false))}
              disabled={isSaving}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-stitch-indigo ${
                settings.quiet_hours?.enabled ? 'bg-stitch-indigo' : 'bg-stitch-well'
              }`}
            >
              <span
                aria-hidden="true"
                className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                  settings.quiet_hours?.enabled ? 'translate-x-5' : 'translate-x-0'
                }`}
              />
            </button>
          </div>

          {settings.quiet_hours?.enabled && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-stitch-border">
              <div>
                <label htmlFor="quiet-start" className="block text-sm font-medium text-stitch-muted mb-2">
                  {t('startTime')}
                </label>
                <input
                  id="quiet-start"
                  type="time"
                  min="0"
                  max="23"
                  value={String(settings.quiet_hours?.start_hour || 22).padStart(2, '0')}
                  onChange={(e) => updateQuietHours('start_hour', parseInt(e.target.value, 10))}
                  disabled={isSaving}
                  className="block w-full rounded-lg border border-stitch-border bg-stitch-well px-3 py-2 text-sm text-stitch-primary outline-none focus:border-stitch-indigo disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label htmlFor="quiet-end" className="block text-sm font-medium text-stitch-muted mb-2">
                  {t('endTime')}
                </label>
                <input
                  id="quiet-end"
                  type="time"
                  min="0"
                  max="23"
                  value={String(settings.quiet_hours?.end_hour || 8).padStart(2, '0')}
                  onChange={(e) => updateQuietHours('end_hour', parseInt(e.target.value, 10))}
                  disabled={isSaving}
                  className="block w-full rounded-lg border border-stitch-border bg-stitch-well px-3 py-2 text-sm text-stitch-primary outline-none focus:border-stitch-indigo disabled:opacity-60 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Weekly Summary */}
      <div className="bg-stitch-surface rounded-2xl border border-stitch-border p-6">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-stitch-primary">{t('weeklySummary')}</h3>
            <p className="text-sm text-stitch-muted mt-1">{t('weeklySummaryDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.weekly_summary_enabled}
            onClick={() => updateSetting('weekly_summary_enabled', !settings.weekly_summary_enabled)}
            disabled={isSaving}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-stitch-indigo ${
              settings.weekly_summary_enabled ? 'bg-stitch-indigo' : 'bg-stitch-well'
            }`}
          >
            <span
              aria-hidden="true"
              className={`inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                settings.weekly_summary_enabled ? 'translate-x-5' : 'translate-x-0'
              }`}
            />
          </button>
        </div>
      </div>

      {/* Error Message */}
      {error && (
        <div className="rounded-xl bg-stitch-crimson/10 p-4 border border-stitch-crimson/30">
          <div className="flex">
            <AlertCircle className="h-5 w-5 text-stitch-crimson" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-stitch-crimson">{error}</h3>
            </div>
          </div>
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="inline-flex items-center justify-center rounded-lg bg-stitch-indigo px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-stitch-violet focus:outline-none focus:ring-2 focus:ring-stitch-indigo disabled:opacity-50 disabled:cursor-not-allowed transition-colors gap-2"
        >
          <Save className="h-4 w-4" />
          {isSaving ? t('saving') : t('saveChanges')}
        </button>
      </div>
    </div>
  );
}
