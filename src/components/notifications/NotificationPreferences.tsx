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
      quiet_hours: {
        ...prev.quiet_hours,
        [field]: value,
      },
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
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('channelPreferences')}</h3>
          <p className="text-sm text-gray-500 mt-1">{t('channelPreferencesDesc')}</p>
        </div>
        <div className="space-y-4">
          {(Object.keys(CHANNEL_LABELS) as UserNotificationChannel[]).map((channel) => {
            const isEnabled = settings.enabled_channels.includes(channel);

            return (
              <div key={channel} className="flex items-center justify-between p-4 border border-gray-200 rounded-lg hover:bg-gray-50 transition-colors">
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <label className="font-medium text-gray-900 cursor-pointer">
                      {CHANNEL_LABELS[channel]}
                    </label>
                    {isEnabled ? (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-green-100 text-green-800">
                        <Check className="h-3 w-3 mr-1" />
                        {t('channelConfigured')}
                      </span>
                    ) : (
                      <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-600">
                        {t('channelNotConfigured')}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">
                    {t(`channelDescriptions.${channel}`)}
                  </p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={isEnabled}
                  onClick={() => updateChannelConfig(channel, !isEnabled)}
                  disabled={isSaving}
                  className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                    isEnabled ? 'bg-indigo-600' : 'bg-gray-200'
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
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('severityThreshold')}</h3>
          <p className="text-sm text-gray-500 mt-1">{t('severityThresholdDesc')}</p>
        </div>
        <div className="max-w-md">
          <label htmlFor="severity-threshold" className="block text-sm font-medium text-gray-700 mb-2">
            {t('selectSeverity')}
          </label>
          <select
            id="severity-threshold"
            value={settings.severity_threshold}
            onChange={(e) => updateSetting('severity_threshold', e.target.value as AlertSeverityLevel)}
            disabled={isSaving}
            className="block w-full rounded-md border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
          >
            {SEVERITY_OPTIONS.map(({ value, labelKey, descriptionKey }) => (
              <option key={value} value={value}>
                {t(`severityOptions.${labelKey}`)}
              </option>
            ))}
          </select>
          <p className="text-xs text-gray-500 mt-2">
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
        <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
          <div className="mb-4">
            <h3 className="text-lg font-semibold text-gray-900">{t('emailSettings')}</h3>
            <p className="text-sm text-gray-500 mt-1">{t('emailSettingsDesc')}</p>
          </div>
          <div className="max-w-md">
            <label htmlFor="email-override" className="block text-sm font-medium text-gray-700 mb-2">
              {t('emailAddress')}
            </label>
            <input
              id="email-override"
              type="email"
              value={settings.email_override || ''}
              onChange={(e) => updateSetting('email_override', e.target.value || undefined)}
              placeholder={t('emailPlaceholder')}
              disabled={isSaving}
              className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
            />
            <p className="text-xs text-gray-500 mt-2">{t('emailHelp')}</p>
          </div>
        </div>
      )}

      {/* Quiet Hours */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="mb-4">
          <h3 className="text-lg font-semibold text-gray-900">{t('quietHours')}</h3>
          <p className="text-sm text-gray-500 mt-1">{t('quietHoursDesc')}</p>
        </div>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <label htmlFor="quiet-hours-enabled" className="text-sm font-medium text-gray-900 cursor-pointer">
              {t('enableQuietHours')}
            </label>
            <button
              type="button"
              role="switch"
              aria-checked={settings.quiet_hours?.enabled || false}
              onClick={() => updateQuietHours('enabled', !(settings.quiet_hours?.enabled || false))}
              disabled={isSaving}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
                settings.quiet_hours?.enabled ? 'bg-indigo-600' : 'bg-gray-200'
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-4 border-t border-gray-200">
              <div>
                <label htmlFor="quiet-start" className="block text-sm font-medium text-gray-700 mb-2">
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
                  className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
              <div>
                <label htmlFor="quiet-end" className="block text-sm font-medium text-gray-700 mb-2">
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
                  className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 disabled:bg-gray-100 disabled:cursor-not-allowed"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Weekly Summary */}
      <div className="bg-white rounded-lg border border-gray-200 p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{t('weeklySummary')}</h3>
            <p className="text-sm text-gray-500 mt-1">{t('weeklySummaryDesc')}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={settings.weekly_summary_enabled}
            onClick={() => updateSetting('weekly_summary_enabled', !settings.weekly_summary_enabled)}
            disabled={isSaving}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 ${
              settings.weekly_summary_enabled ? 'bg-indigo-600' : 'bg-gray-200'
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
        <div className="rounded-md bg-red-50 p-4 border border-red-200">
          <div className="flex">
            <AlertCircle className="h-5 w-5 text-red-400" />
            <div className="ml-3">
              <h3 className="text-sm font-medium text-red-800">{error}</h3>
            </div>
          </div>
        </div>
      )}

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={!hasChanges || isSaving}
          className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:bg-indigo-300 disabled:cursor-not-allowed transition-colors gap-2"
        >
          <Save className="h-4 w-4" />
          {isSaving ? t('saving') : t('saveChanges')}
        </button>
      </div>
    </div>
  );
}
