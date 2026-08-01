'use client';

import { useState, useCallback, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import {
  Slack,
  Mail,
  Send,
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  Trash2,
  Eye,
  EyeOff,
  AlertCircle,
  Bell,
} from 'lucide-react';

interface ChannelConfig {
  enabled: boolean;
  [key: string]: unknown;
}

interface DbConfig {
  slack?: SlackConfig | null;
  email?: EmailConfig | null;
  telegram?: TelegramConfig | null;
}

interface SlackConfig extends ChannelConfig {
  webhookUrl: string;
  channel?: string;
  username?: string;
  iconEmoji?: string;
  iconUrl?: string;
}

interface EmailConfig extends ChannelConfig {
  apiKey: string;
  fromEmail: string;
  fromName: string;
  defaultRecipients: string[];
  replyTo?: string;
}

interface TelegramConfig extends ChannelConfig {
  botToken: string;
  chatIds: string[];
  parseMode?: 'HTML' | 'Markdown';
  disableWebPagePreview?: boolean;
}

const CHANNEL_LABELS = {
  slack: 'Slack',
  email: 'Email (Resend)',
  telegram: 'Telegram',
};

export default function NotificationsClient() {
  const t = useTranslations('admin.settings.notifications');
  const common = useTranslations('common');

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  const [testResults, setTestResults] = useState<
    Record<string, { success: boolean; error?: string; details?: unknown }>
  >({});

  const [dbConfig, setDbConfig] = useState<DbConfig>({});
  const [envConfig, setEnvConfig] = useState<Record<string, unknown>>({});

  // Form states for each channel
  const [formData, setFormData] = useState<{
    slack: SlackConfig;
    email: EmailConfig;
    telegram: TelegramConfig;
  }>({
    slack: {
      enabled: false,
      webhookUrl: '',
      channel: '',
      username: 'ApexOS Bot',
      iconEmoji: ':rocket:',
      iconUrl: '',
    },
    email: {
      enabled: false,
      apiKey: '',
      fromEmail: 'noreply@apexos.io',
      fromName: 'ApexOS',
      defaultRecipients: [],
      replyTo: '',
    },
    telegram: {
      enabled: false,
      botToken: '',
      chatIds: [],
      parseMode: 'HTML',
      disableWebPagePreview: false,
    },
  });

  // Password visibility toggles
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({
    slack: false,
    email: false,
    telegram: false,
  });

  // Fetch configuration on mount
  useEffect(() => {
    fetchConfig();
  }, []);

  const fetchConfig = async () => {
    try {
      const [configRes] = await Promise.all([
        fetch('/api/admin/notifications/config', {
          credentials: 'include',
        }),
      ]);

      if (configRes.ok) {
        const configData = await configRes.json();
        if (configData.success) {
          const { dbConfig: db, envConfig: env } = configData.data;
          setDbConfig(db || {});
          setEnvConfig(env || {});

          // Initialize form data with DB configs (falling back to env)
          if (db.slack) {
            setFormData(prev => ({
              ...prev,
              slack: {
                ...prev.slack,
                enabled: db.slack.enabled,
                webhookUrl: db.slack.webhookUrl || '',
                channel: db.slack.channel || '',
                username: db.slack.username || 'ApexOS Bot',
                iconEmoji: db.slack.iconEmoji || ':rocket:',
                iconUrl: db.slack.iconUrl || '',
              },
            }));
          }
          if (db.email) {
            setFormData(prev => ({
              ...prev,
              email: {
                ...prev.email,
                enabled: db.email.enabled,
                apiKey: db.email.apiKey || '',
                fromEmail: db.email.fromEmail || 'noreply@apexos.io',
                fromName: db.email.fromName || 'ApexOS',
                defaultRecipients: db.email.defaultRecipients || [],
                replyTo: db.email.replyTo || '',
              },
            }));
          }
          if (db.telegram) {
            setFormData(prev => ({
              ...prev,
              telegram: {
                ...prev.telegram,
                enabled: db.telegram.enabled,
                botToken: db.telegram.botToken || '',
                chatIds: db.telegram.chatIds || [],
                parseMode: db.telegram.parseMode || 'HTML',
                disableWebPagePreview: db.telegram.disableWebPagePreview || false,
              },
            }));
          }
        }
      }
    } catch (error) {
      console.error('Failed to fetch config:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = useCallback(
    (channel: 'slack' | 'email' | 'telegram', field: string, value: unknown) => {
      setFormData(prev => ({
        ...prev,
        [channel]: {
          ...prev[channel],
          [field]: value,
        },
      }));
      // Clear test result when config changes
      if (testResults[channel]) {
        setTestResults(prev => ({ ...prev, [channel]: undefined }));
      }
    },
    [testResults]
  );

  const handleRecipientsChange = useCallback(
    (channel: 'email', value: string) => {
      const recipients = value
        .split(',')
        .map(r => r.trim())
        .filter(r => r.length > 0);
      setFormData(prev => ({
        ...prev,
        [channel]: {
          ...prev[channel],
          defaultRecipients: recipients,
        },
      }));
    },
    []
  );

  const handleSave = useCallback(
    async (channel: 'slack' | 'email' | 'telegram') => {
      setSaving(prev => ({ ...prev, [channel]: true }));
      try {
        const response = await fetch('/api/admin/notifications/config', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            channelType: channel,
            config: formData[channel],
          }),
        });

        const result = await response.json();
        if (!result.success) {
          throw new Error(result.error || 'Failed to save');
        }

        // Refresh config from DB
        await fetchConfig();
        alert(t('saveSuccess'));
      } catch (error) {
        console.error('Save failed:', error);
        alert(t('saveError') + (error instanceof Error ? `: ${error.message}` : ''));
      } finally {
        setSaving(prev => ({ ...prev, [channel]: false }));
      }
    },
    [formData, t]
  );

  const handleTest = useCallback(
    async (channel: 'slack' | 'email' | 'telegram') => {
      setTesting(prev => ({ ...prev, [channel]: true }));
      setTestResults(prev => ({ ...prev, [channel]: undefined }));
      try {
        const response = await fetch('/api/admin/notifications/test', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            channelType: channel,
            config: formData[channel],
          }),
        });

        const result = await response.json();
        setTestResults(prev => ({ ...prev, [channel]: result }));
      } catch (error) {
        console.error('Test failed:', error);
        setTestResults(prev => ({
          ...prev,
          [channel]: {
            success: false,
            error: error instanceof Error ? error.message : 'Network error',
          },
        }));
      } finally {
        setTesting(prev => ({ ...prev, [channel]: false }));
      }
    },
    [formData]
  );

  const handleDelete = useCallback(
    async (channel: 'slack' | 'email' | 'telegram') => {
      if (!confirm(t('deleteConfirm'))) return;

      setSaving(prev => ({ ...prev, [channel]: true }));
      try {
        const response = await fetch(
          `/api/admin/notifications/${channel}`,
          {
            method: 'DELETE',
            credentials: 'include',
          }
        );

        const result = await response.json();
        if (!result.success) {
          throw new Error(result.error || 'Failed to delete');
        }

        // Reset form and DB config for this channel
        setDbConfig(prev => ({ ...prev, [channel]: null }));
        setFormData(prev => ({
          ...prev,
          [channel]: getDefaultChannelConfig(channel),
        }));
        alert(t('deleteSuccess'));
      } catch (error) {
        console.error('Delete failed:', error);
        alert(t('deleteError') + (error instanceof Error ? `: ${error.message}` : ''));
      } finally {
        setSaving(prev => ({ ...prev, [channel]: false }));
      }
    },
    [t]
  );

  const toggleSecretVisibility = (channel: string) => {
    setShowSecrets(prev => ({ ...prev, [channel]: !prev[channel] }));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
        <span className="ml-3 text-gray-600">{common('loading')}</span>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Global notification settings */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Bell className="w-5 h-5" />
          {t('globalSettings') || 'Global Settings'}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">
                {t('notificationsEnabled') || 'Notifications Enabled'}
              </p>
              <p className="text-sm text-gray-500">
                {t('notificationsEnabledDesc') || 'Master switch for all notification channels'}
              </p>
            </div>
            <div className="relative">
              <input
                type="checkbox"
                checked={Boolean(envConfig.enabled) || false}
                disabled
                className="h-6 w-6 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
              />
              <span className="ml-3 text-sm text-gray-400">(from env)</span>
            </div>
          </div>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-medium text-gray-900">
                {t('rateLimit') || 'Rate Limit'}
              </p>
              <p className="text-sm text-gray-500">
                {t('rateLimitDesc') || 'Max notifications per minute'}
              </p>
            </div>
            <span className="text-lg font-semibold text-gray-900">
              {(envConfig.rateLimitPerMinute as number) ?? 60}/min
            </span>
          </div>
        </div>
      </div>

      {/* Channel configuration cards */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Slack */}
        <ChannelCard
          channel="slack"
          config={formData.slack}
          dbConfigured={!!dbConfig.slack}
          Icon={Slack}
          onChange={handleInputChange}
          onRecipientsChange={handleRecipientsChange}
          onSave={() => handleSave('slack')}
          onTest={() => handleTest('slack')}
          onDelete={() => handleDelete('slack')}
          saving={saving.slack}
          testing={testing.slack}
          testResult={testResults.slack}
          showSecret={showSecrets.slack}
          toggleSecret={() => toggleSecretVisibility('slack')}
          t={t}
        />

        {/* Email */}
        <ChannelCard
          channel="email"
          config={formData.email}
          dbConfigured={!!dbConfig.email}
          Icon={Mail}
          onChange={handleInputChange}
          onRecipientsChange={handleRecipientsChange}
          onSave={() => handleSave('email')}
          onTest={() => handleTest('email')}
          onDelete={() => handleDelete('email')}
          saving={saving.email}
          testing={testing.email}
          testResult={testResults.email}
          showSecret={showSecrets.email}
          toggleSecret={() => toggleSecretVisibility('email')}
          t={t}
        />

        {/* Telegram */}
        <ChannelCard
          channel="telegram"
          config={formData.telegram}
          dbConfigured={!!dbConfig.telegram}
          Icon={Send}
          onChange={handleInputChange}
          onRecipientsChange={handleRecipientsChange}
          onSave={() => handleSave('telegram')}
          onTest={() => handleTest('telegram')}
          onDelete={() => handleDelete('telegram')}
          saving={saving.telegram}
          testing={testing.telegram}
          testResult={testResults.telegram}
          showSecret={showSecrets.telegram}
          toggleSecret={() => toggleSecretVisibility('telegram')}
          t={t}
        />
      </div>

      {/* Help section */}
      <div className="bg-blue-50 border border-blue-200 rounded-lg p-6">
        <h3 className="text-lg font-semibold text-blue-900 mb-3 flex items-center gap-2">
          <AlertCircle className="w-5 h-5" />
          {t('setupHelp') || 'Setup Instructions'}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6 text-sm text-blue-800">
          <div>
            <h4 className="font-semibold mb-2 flex items-center gap-2">
              <Slack className="w-4 h-4" />
              Slack
            </h4>
            <ol className="list-decimal list-inside space-y-1">
              <li>Go to slack.com/apps/A2Z</li>
              <li>Search for &quot;Incoming Webhooks&quot;</li>
              <li>Add to your workspace</li>
              <li>Create a new webhook</li>
              <li>Copy the webhook URL</li>
            </ol>
          </div>
          <div>
            <h4 className="font-semibold mb-2 flex items-center gap-2">
              <Mail className="w-4 h-4" />
              Email (Resend)
            </h4>
            <ol className="list-decimal list-inside space-y-1">
              <li>Sign up at resend.com</li>
              <li>Get your API key</li>
              <li>Verify your sending domain</li>
              <li>Add API key here</li>
              <li>Add recipient emails</li>
            </ol>
          </div>
          <div>
            <h4 className="font-semibold mb-2 flex items-center gap-2">
              <Send className="w-4 h-4" />
              Telegram
            </h4>
            <ol className="list-decimal list-inside space-y-1">
              <li>Message @BotFather on Telegram</li>
              <li>Create a new bot</li>
              <li>Copy the bot token</li>
              <li>Start chat with your bot</li>
              <li>Get chat ID via @getidsbot</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}

interface ChannelCardProps {
  channel: 'slack' | 'email' | 'telegram';
  config: ChannelConfig;
  dbConfigured: boolean;
  Icon: React.ComponentType<{ className?: string }>;
  onChange: (channel: 'slack' | 'email' | 'telegram', field: string, value: unknown) => void;
  onRecipientsChange: (channel: 'email', value: string) => void;
  onSave: () => void;
  onTest: () => void;
  onDelete: () => void;
  saving: boolean;
  testing: boolean;
  testResult: { success: boolean; error?: string; details?: unknown } | undefined;
  showSecret: boolean;
  toggleSecret: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

function ChannelCard({
  channel,
  config,
  dbConfigured,
  Icon,
  onChange,
  onRecipientsChange,
  onSave,
  onTest,
  onDelete,
  saving,
  testing,
  testResult,
  showSecret,
  toggleSecret,
  t,
}: ChannelCardProps) {
  const label = CHANNEL_LABELS[channel];

  return (
    <div className="bg-white rounded-lg shadow border border-gray-200 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 bg-gray-50 border-b border-gray-200 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Icon className={`w-6 h-6 ${config.enabled ? 'text-green-600' : 'text-gray-400'}`} />
          <div>
            <h3 className="font-semibold text-gray-900">{label}</h3>
            <p className="text-sm text-gray-500">
              {dbConfigured ? t('configured') : t('notConfigured')}
            </p>
          </div>
        </div>
        <label className="relative inline-flex items-center cursor-pointer">
          <input
            type="checkbox"
            checked={config.enabled}
            onChange={(e) => onChange(channel, 'enabled', e.target.checked)}
            className="sr-only peer"
          />
          <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4 peer-focus:ring-indigo-300 rounded-full peer peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-5 after:w-5 after:transition-all peer-checked:bg-indigo-600"></div>
        </label>
      </div>

      {/* Form */}
      <div className="p-6 space-y-4">
        {channel === 'slack' && (
          <>
            <InputField
              label={t('fields.webhookUrl') || 'Webhook URL'}
              value={config.webhookUrl as string}
              onChange={(v) => onChange('slack', 'webhookUrl', v)}
              type="url"
              placeholder="https://hooks.slack.com/services/..."
              required
            />
            <InputField
              label={t('fields.channel') || 'Channel (optional)'}
              value={config.channel as string}
              onChange={(v) => onChange('slack', 'channel', v)}
              placeholder="#alerts"
            />
            <InputField
              label={t('fields.username') || 'Bot Username'}
              value={config.username as string}
              onChange={(v) => onChange('slack', 'username', v)}
              placeholder="ApexOS Bot"
            />
            <InputField
              label={t('fields.iconEmoji') || 'Icon Emoji'}
              value={config.iconEmoji as string}
              onChange={(v) => onChange('slack', 'iconEmoji', v)}
              placeholder=":rocket:"
            />
          </>
        )}

        {channel === 'email' && (
          <>
            <InputField
              label={t('fields.apiKey') || 'Resend API Key'}
              value={config.apiKey as string}
              onChange={(v) => onChange('email', 'apiKey', v)}
              type={showSecret ? 'text' : 'password'}
              placeholder="re_..."
              required
              showToggle
              showSecret={showSecret}
              toggleSecret={toggleSecret}
            />
            <InputField
              label={t('fields.fromEmail') || 'From Email'}
              value={config.fromEmail as string}
              onChange={(v) => onChange('email', 'fromEmail', v)}
              type="email"
              placeholder="noreply@apexos.io"
              required
            />
            <InputField
              label={t('fields.fromName') || 'From Name'}
              value={config.fromName as string}
              onChange={(v) => onChange('email', 'fromName', v)}
              placeholder="ApexOS"
              required
            />
            <TextareaField
              label={t('fields.recipients') || 'Default Recipients'}
              value={(config.defaultRecipients as string[])?.join(', ')}
              onChange={(v) => onRecipientsChange('email', v)}
              placeholder="admin@apexos.io, alerts@apexos.io"
              required
              helper={t('fields.recipientsHelp') || 'Comma-separated email addresses'}
            />
            <InputField
              label={t('fields.replyTo') || 'Reply-To (optional)'}
              value={config.replyTo as string}
              onChange={(v) => onChange('email', 'replyTo', v)}
              type="email"
              placeholder="support@apexos.io"
            />
          </>
        )}

        {channel === 'telegram' && (
          <>
            <InputField
              label={t('fields.botToken') || 'Bot Token'}
              value={config.botToken as string}
              onChange={(v) => onChange('telegram', 'botToken', v)}
              type={showSecret ? 'text' : 'password'}
              placeholder="123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11"
              required
              showToggle
              showSecret={showSecret}
              toggleSecret={toggleSecret}
            />
            <TextareaField
              label={t('fields.chatIds') || 'Chat IDs'}
              value={(config.chatIds as string[])?.join(',')}
              onChange={(v) =>
                onChange('telegram', 'chatIds', v.split(',').map(s => s.trim()).filter(Boolean))
              }
              placeholder="-1001234567890, 123456789"
              required
              helper={t('fields.chatIdsHelp') || 'Comma-separated chat IDs (negative for groups)'}
            />
            <SelectField
              label={t('fields.parseMode') || 'Parse Mode'}
              value={config.parseMode as string}
              onChange={(v) => onChange('telegram', 'parseMode', v)}
              options={[
                { value: 'HTML', label: 'HTML' },
                { value: 'Markdown', label: 'Markdown' },
              ]}
            />
            <CheckboxField
              label={t('fields.disablePreview') || 'Disable Web Page Preview'}
              checked={config.disableWebPagePreview as boolean}
              onChange={(v) => onChange('telegram', 'disableWebPagePreview', v)}
            />
          </>
        )}
      </div>

      {/* Test result */}
      {testResult && (
        <div
          className={`mx-6 mb-4 p-4 rounded-lg flex items-start gap-3 ${
            testResult.success
              ? 'bg-green-50 border border-green-200'
              : 'bg-red-50 border border-red-200'
          }`}
        >
          {testResult.success ? (
            <CheckCircle className="w-5 h-5 text-green-600 mt-0.5" />
          ) : (
            <XCircle className="w-5 h-5 text-red-600 mt-0.5" />
          )}
          <div>
            <p
              className={`font-medium ${
                testResult.success ? 'text-green-800' : 'text-red-800'
              }`}
            >
              {testResult.success
                ? t('testSuccess') || 'Connection successful!'
                : t('testFailed') || 'Connection failed'}
            </p>
            {testResult.error && (
              <p className="text-sm text-red-600 mt-1">{testResult.error}</p>
            )}
            {testResult.success && testResult.details && (
              <p className="text-sm text-green-700 mt-1">
                {t('testDetails') || `Message ID: ${(testResult.details as any).messageId}`}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Actions */}
      <div className="px-6 py-4 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={onTest}
            disabled={testing || !config.enabled || !getRequiredFieldsFilled(channel, config)}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {testing ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <Bell className="w-4 h-4" />
            )}
            {t('actions.test') || 'Test Connection'}
          </button>
          {dbConfigured && (
            <button
              onClick={onDelete}
              disabled={saving}
              className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-red-700 bg-white border border-red-300 rounded-lg hover:bg-red-50 disabled:opacity-50"
            >
              <Trash2 className="w-4 h-4" />
              {t('actions.delete') || 'Delete'}
            </button>
          )}
        </div>
        <button
          onClick={onSave}
          disabled={saving || !getRequiredFieldsFilled(channel, config)}
          className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {t('actions.save') || 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}

function getRequiredFieldsFilled(
  channel: 'slack' | 'email' | 'telegram',
  config: ChannelConfig
): boolean {
  switch (channel) {
    case 'slack':
      return (config as SlackConfig).webhookUrl.length > 0;
    case 'email':
      return (config as EmailConfig).apiKey.length > 0 &&
        (config as EmailConfig).defaultRecipients.length > 0;
    case 'telegram':
      return (config as TelegramConfig).botToken.length > 0 &&
        (config as TelegramConfig).chatIds.length > 0;
    default:
      return false;
  }
}

function InputField({
  label,
  value,
  onChange,
  type = 'text',
  placeholder,
  required,
  showToggle,
  showSecret,
  toggleSecret,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  placeholder?: string;
  required?: boolean;
  showToggle?: boolean;
  showSecret?: boolean;
  toggleSecret?: () => void;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <div className="relative">
        <input
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          required={required}
          className="block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 text-sm"
        />
        {showToggle && toggleSecret && (
          <button
            type="button"
            onClick={toggleSecret}
            className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
          >
            {showSecret ? (
              <EyeOff className="w-4 h-4" />
            ) : (
              <Eye className="w-4 h-4" />
            )}
          </button>
        )}
      </div>
    </div>
  );
}

function TextareaField({
  label,
  value,
  onChange,
  placeholder,
  required,
  helper,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  helper?: string;
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">
        {label}
        {required && <span className="text-red-500 ml-1">*</span>}
      </label>
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        required={required}
        rows={3}
        className="block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 text-sm"
      />
      {helper && <p className="mt-1 text-sm text-gray-500">{helper}</p>}
    </div>
  );
}

function SelectField({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-gray-700 mb-1">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 text-sm"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function CheckboxField({
  label,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-center">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="h-4 w-4 text-indigo-600 border-gray-300 rounded focus:ring-indigo-500"
      />
      <label className="ml-2 block text-sm text-gray-700">{label}</label>
    </div>
  );
}

function getDefaultChannelConfig(
  channel: 'slack' | 'email' | 'telegram'
): ChannelConfig {
  switch (channel) {
    case 'slack':
      return {
        enabled: false,
        webhookUrl: '',
        channel: '',
        username: 'ApexOS Bot',
        iconEmoji: ':rocket:',
        iconUrl: '',
      };
    case 'email':
      return {
        enabled: false,
        apiKey: '',
        fromEmail: 'noreply@apexos.io',
        fromName: 'ApexOS',
        defaultRecipients: [],
        replyTo: '',
      };
    case 'telegram':
      return {
        enabled: false,
        botToken: '',
        chatIds: [],
        parseMode: 'HTML',
        disableWebPagePreview: false,
      };
    default:
      return { enabled: false };
  }
}
