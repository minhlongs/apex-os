'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import {
  Network,
  Globe,
  Shield,
  Wallet,
  Coins,
  CheckCircle,
  XCircle,
  Loader2,
  Save,
  AlertTriangle,
  ExternalLink,
  Copy,
  RefreshCw,
} from 'lucide-react';

interface StellarClientProps {
  initialConfig: {
    network: string;
    secretKeyConfigured: boolean;
    usdcIssuer: string;
    horizonUrl: string;
    senderAccountId: string | null;
    updatedAt: string;
  };
  initialHealth: {
    horizonConnected: boolean;
    senderBalanceUSDC: number;
    senderBalanceXLM: number;
    errors: string[];
  } | null;
  usdcInfo: {
    issuer: string;
    code: string;
    horizonUrl: string;
    explorerUrl: string;
    network: string;
  };
}

export default function StellarClient({
  initialConfig,
  initialHealth,
  usdcInfo,
}: StellarClientProps) {
  const t = useTranslations('admin.settings.stellar');

  const [config, setConfig] = useState(initialConfig);
  const [health, setHealth] = useState(initialHealth);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    error?: string;
    network?: string;
    senderBalanceUSDC?: number;
    senderBalanceXLM?: number;
  } | null>(null);
  const [copiedField, setCopiedField] = useState<string | null>(null);

  // Network options
  const networks = [
    { value: 'testnet', label: 'Testnet', description: 'For development and testing' },
    { value: 'mainnet', label: 'Mainnet', description: 'Production - real USDC transactions' },
  ];

  // Refresh health status
  const refreshHealth = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/settings/stellar/health', {
        credentials: 'include',
      });
      if (res.ok) {
        const data = await res.json();
        setHealth(data.health);
      }
    } catch (error) {
      console.error('Failed to refresh health:', error);
    }
  }, []);

  // Test connection
  const handleTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const res = await fetch('/api/admin/settings/stellar/test', {
        credentials: 'include',
      });
      const data = await res.json();
      setTestResult(data);
      if (data.success) {
        await refreshHealth();
      }
    } catch (error) {
      setTestResult({
        success: false,
        error: error instanceof Error ? error.message : 'Network error',
      });
    } finally {
      setTesting(false);
    }
  }, [refreshHealth]);

  // Save configuration
  const handleSave = useCallback(async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/admin/settings/stellar', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          network: config.network,
          horizonUrl: config.horizonUrl,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || 'Failed to save');
      }
      alert(t('saveSuccess'));
      // Refresh health after save
      await refreshHealth();
    } catch (error) {
      alert(t('saveError') + (error instanceof Error ? `: ${error.message}` : ''));
    } finally {
      setSaving(false);
    }
  }, [config, t, refreshHealth]);

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (error) {
      console.error('Failed to copy:', error);
    }
  };

  const isMainnet = config.network === 'mainnet';

  return (
    <div className="space-y-8">
      {/* Network Selection Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Network className="w-5 h-5" />
          {t('networkSelection') || 'Network Selection'}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {networks.map((net) => (
            <div
              key={net.value}
              className={`relative border-2 rounded-lg p-4 cursor-pointer transition-all ${
                config.network === net.value
                  ? 'border-indigo-600 bg-indigo-50'
                  : 'border-gray-200 hover:border-gray-300'
              }`}
            >
              <div className="flex items-start gap-3">
                <input
                  type="radio"
                  name="network"
                  value={net.value}
                  checked={config.network === net.value}
                  onChange={() =>
                    setConfig((prev) => ({ ...prev, network: net.value as 'testnet' | 'mainnet' }))
                  }
                  className="mt-1"
                />
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-gray-900">{net.label}</span>
                    {config.network === net.value && (
                      <span className="px-2 py-0.5 text-xs bg-indigo-100 text-indigo-700 rounded-full">
                        {t('active') || 'Active'}
                      </span>
                    )}
                    {net.value === 'mainnet' && (
                      <span className="px-2 py-0.5 text-xs bg-red-100 text-red-700 rounded-full">
                        {t('production') || 'PRODUCTION'}
                      </span>
                    )}
                  </div>
                  <p className="text-sm text-gray-500 mt-1">{net.description}</p>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Configuration Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Globe className="w-5 h-5" />
          {t('configuration') || 'Configuration'}
        </h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('fields.horizonUrl') || 'Horizon URL'}
            </label>
            <input
              type="url"
              value={config.horizonUrl}
              onChange={(e) =>
                setConfig((prev) => ({ ...prev, horizonUrl: e.target.value }))
              }
              className="block w-full px-3 py-2 border border-gray-300 rounded-lg shadow-sm focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              placeholder="https://horizon.stellar.org"
            />
            <p className="mt-1 text-xs text-gray-500">
              {t('fields.horizonUrlHelp') || 'Stellar Horizon server endpoint'}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('fields.usdcIssuer') || 'USDC Issuer'}
            </label>
            <div className="relative">
              <input
                type="text"
                value={usdcInfo.issuer}
                readOnly
                className="block w-full px-3 py-2 border border-gray-200 bg-gray-50 rounded-lg text-sm text-gray-600"
              />
              <button
                type="button"
                onClick={() => copyToClipboard(usdcInfo.issuer, 'issuer')}
                className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-600"
              >
                {copiedField === 'issuer' ? (
                  <CheckCircle className="w-4 h-4 text-green-600" />
                ) : (
                  <Copy className="w-4 h-4" />
                )}
              </button>
            </div>
            <p className="mt-1 text-xs text-gray-500">
              <a
                href={usdcInfo.explorerUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center gap-1 text-indigo-600 hover:text-indigo-800"
              >
                <ExternalLink className="w-3 h-3" />
                {t('fields.viewOnExplorer') || 'View on StellarExpert'}
              </a>
            </p>
          </div>
        </div>
      </div>

      {/* Wallet Configuration Card */}
      <div className="bg-white rounded-lg shadow p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
          <Wallet className="w-5 h-5" />
          {t('walletConfiguration') || 'Wallet Configuration'}
        </h2>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left: Instructions */}
          <div className="space-y-4">
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4">
              <h3 className="font-semibold text-blue-900 mb-2 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" />
                {t('setupRequired') || 'Setup Required'}
              </h3>
              <p className="text-sm text-blue-800 mb-3">
                {t('setupDescription') ||
                  'Before running payouts, you must create a Stellar wallet and fund it with USDC.'}
              </p>
              <ol className="list-decimal list-inside space-y-2 text-sm text-blue-800">
                {(t.raw('setupSteps') as string[]) || [
                  'Tải xPortal wallet từ app store',
                  'Tạo wallet mới với network phù hợp',
                  'Lưu Secret Key an toàn (offline)',
                  'Copy Account ID (public key)',
                  'Mua và gửi USDC vào Account ID',
                ].map((step, i) => <li key={i}>{step}</li>)}
              </ol>
            </div>

            <div className="bg-yellow-50 border border-yellow-200 rounded-lg p-4">
              <h3 className="font-semibold text-yellow-900 mb-2 flex items-center gap-2">
                <Shield className="w-4 h-4" />
                {t('secretKeyWarning') || 'Secret Key Security'}
              </h3>
              <p className="text-sm text-yellow-800">
                {t('secretKeyWarningDesc') ||
                  'STELLAR_SECRET_KEY phải được set trong environment variables. Không bao giờ chia sẻ secret key. Nó cho phép system rút USDC từ wallet.'}
              </p>
            </div>
          </div>

          {/* Right: Health Status */}
          <div className="space-y-4">
            <h3 className="font-medium text-gray-900">
              {t('connectionStatus') || 'Connection Status'}
            </h3>

            <div className="space-y-3">
              <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                <span className="text-sm text-gray-600">
                  {t('status.horizon') || 'Horizon Connection'}
                </span>
                {health ? (
                  health.horizonConnected ? (
                    <span className="flex items-center gap-1 text-sm text-green-600">
                      <CheckCircle className="w-4 h-4" />
                      {t('status.connected') || 'Connected'}
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-sm text-red-600">
                      <XCircle className="w-4 h-4" />
                      {t('status.disconnected') || 'Disconnected'}
                    </span>
                  )
                ) : (
                  <span className="text-sm text-gray-400">{t('status.unknown') || 'Unknown'}</span>
                )}
              </div>

              {config.senderAccountId && (
                <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                  <span className="text-sm text-gray-600">
                    {t('status.senderAccount') || 'Sender Account'}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-mono text-gray-900">
                      {config.senderAccountId.slice(0, 8)}...{config.senderAccountId.slice(-8)}
                    </span>
                    <button
                      onClick={() => copyToClipboard(config.senderAccountId!, 'senderAccount')}
                      className="text-gray-400 hover:text-gray-600"
                    >
                      {copiedField === 'senderAccount' ? (
                        <CheckCircle className="w-4 h-4 text-green-600" />
                      ) : (
                        <Copy className="w-4 h-4" />
                      )}
                    </button>
                  </div>
                </div>
              )}

              {health && (
                <>
                  <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <span className="text-sm text-gray-600 flex items-center gap-2">
                      <Coins className="w-4 h-4" />
                      USDC Balance
                    </span>
                    <span className={`text-sm font-semibold ${
                      health.senderBalanceUSDC > 0 ? 'text-green-600' : 'text-yellow-600'
                    }`}>
                      {health.senderBalanceUSDC.toFixed(2)} USDC
                    </span>
                  </div>

                  <div className="flex items-center justify-between p-3 bg-gray-50 rounded-lg">
                    <span className="text-sm text-gray-600 flex items-center gap-2">
                      <Wallet className="w-4 h-4" />
                      XLM Balance (Fee)
                    </span>
                    <span className={`text-sm font-semibold ${
                      health.senderBalanceXLM >= 0.01 ? 'text-green-600' : 'text-red-600'
                    }`}>
                      {health.senderBalanceXLM.toFixed(4)} XLM
                    </span>
                  </div>
                </>
              )}

              {health?.errors && health.errors.length > 0 && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-lg">
                  <h4 className="text-sm font-medium text-red-800 mb-2">
                    {t('errors.title') || 'Errors'}
                  </h4>
                  <ul className="space-y-1">
                    {health.errors.map((error, i) => (
                      <li key={i} className="text-sm text-red-700 flex items-start gap-2">
                        <XCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                        {error}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>

            {/* Test Connection Button */}
            <div className="pt-2">
              <button
                onClick={handleTest}
                disabled={testing}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {testing ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                {t('actions.testConnection') || 'Test Connection'}
              </button>
            </div>

            {/* Test Result */}
            {testResult && (
              <div
                className={`p-4 rounded-lg flex items-start gap-3 ${
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
                      ? t('test.success') || 'Connection successful!'
                      : t('test.failed') || 'Connection failed'}
                  </p>
                  {testResult.success ? (
                    <div className="mt-2 space-y-1 text-sm text-green-700">
                      <p>Network: {testResult.network}</p>
                      <p>USDC Balance: {testResult.senderBalanceUSDC?.toFixed(2)}</p>
                      <p>XLM Balance: {testResult.senderBalanceXLM?.toFixed(4)}</p>
                    </div>
                  ) : (
                    <p className="text-sm text-red-700 mt-1">{testResult.error}</p>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Info Card */}
      <div className="bg-gray-100 rounded-lg p-6">
        <h3 className="font-semibold text-gray-900 mb-3">
          {t('info.title') || 'USDC on Stellar'}
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm">
          <div>
            <span className="text-gray-600">{t('info.network') || 'Network'}:</span>
            <span className="ml-2 font-medium">{isMainnet ? 'Stellar Mainnet' : 'Stellar Testnet'}</span>
          </div>
          <div>
            <span className="text-gray-600">{t('info.asset') || 'Asset'}:</span>
            <span className="ml-2 font-medium">{usdcInfo.code}</span>
          </div>
          <div>
            <span className="text-gray-600">{t('info.issuer') || 'Issuer'}:</span>
            <span className="ml-2 font-mono text-xs">
              {usdcInfo.issuer.slice(0, 10)}...{usdcInfo.issuer.slice(-8)}
            </span>
          </div>
        </div>
        <p className="mt-4 text-sm text-gray-600">
          {isMainnet
            ? t('info.mainnetWarning') ||
              'Mainnet uses real USDC. Ensure wallet is funded before running payouts.'
            : t('info.testnetDescription') ||
              'Testnet uses free test USDC via Friendbot. Safe for development.'}
        </p>
      </div>

      {/* Save Button */}
      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={saving || config.network === initialConfig.network}
          className="inline-flex items-center gap-2 px-6 py-3 text-sm font-medium text-white bg-indigo-600 rounded-lg hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Save className="w-4 h-4" />
          )}
          {t('actions.saveConfiguration') || 'Save Configuration'}
        </button>
      </div>
    </div>
  );
}
