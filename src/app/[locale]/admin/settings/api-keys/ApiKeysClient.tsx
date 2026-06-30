'use client'

import { useState, useCallback } from 'react'
import { useTranslations } from 'next-intl'

interface ApiKeysClientProps {
  initialKeys: Array<{
    provider: string
    created_at: string
    updated_at: string
  }>
}

const PROVIDERS = [
  { value: 'binance', label: 'Binance' },
  { value: 'bybit', label: 'Bybit' },
  { value: 'resend', label: 'Resend (Email)' },
]

export default function ApiKeysClient({ initialKeys }: ApiKeysClientProps) {
  const t = useTranslations('admin.apiKeys')

  // State
  const [keys, setKeys] = useState(initialKeys)
  const [provider, setProvider] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [success, setSuccess] = useState<string | null>(null)
  const [deleteConfirmProvider, setDeleteConfirmProvider] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Refresh keys từ server
  const refreshKeys = useCallback(async () => {
    try {
      const res = await fetch('/api/admin/settings/api-keys/keys')
      if (!res.ok) throw new Error('Failed to fetch keys')
      const data = await res.json()
      setKeys(data.keys || [])
    } catch (err) {
      console.error('Error refreshing keys:', err)
    }
  }, [])

  // Handle add key
  const handleAddKey = async (e: React.FormEvent) => {
    e.preventDefault()
    setError(null)
    setSuccess(null)
    setLoading(true)

    try {
      const formData = new FormData()
      formData.append('provider', provider)
      formData.append('apiKey', apiKey)

      const res = await fetch('/api/admin/settings/api-keys', {
        method: 'POST',
        body: formData,
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Không thể thêm API key')
      }

      setSuccess('Đã thêm API key thành công')
      setProvider('')
      setApiKey('')
      await refreshKeys()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Đã xảy ra lỗi')
    } finally {
      setLoading(false)
    }
  }

  // Handle delete
  const handleDelete = async () => {
    if (!deleteConfirmProvider) return
    setDeleteError(null)

    try {
      const res = await fetch(`/api/admin/settings/api-keys?provider=${deleteConfirmProvider}`, {
        method: 'DELETE',
      })

      const data = await res.json()

      if (!res.ok) {
        throw new Error(data.error || 'Không thể xóa API key')
      }

      setDeleteConfirmProvider(null)
      await refreshKeys()
      setSuccess('Đã xóa API key thành công')
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Đã xảy ra lỗi')
    }
  }

  // Format date
  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString('vi-VN', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
    } catch {
      return dateStr
    }
  }

  // Get provider label
  const getProviderLabel = (value: string) => {
    return PROVIDERS.find(p => p.value === value)?.label || value
  }

  return (
    <div className="space-y-8">
      {/* Add Key Form */}
      <div className="bg-white rounded-xl shadow p-6">
        <h2 className="text-xl font-semibold text-gray-900 mb-4">
          {t('addTitle')}
        </h2>
        <p className="text-sm text-gray-600 mb-4">
          {t('addDescription')}
        </p>

        <form onSubmit={handleAddKey} className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="provider" className="block text-sm font-medium text-gray-700 mb-1">
                Provider *
              </label>
              <select
                id="provider"
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                required
                disabled={loading}
                className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500 disabled:bg-gray-100"
              >
                <option value="">Chọn provider...</option>
                {PROVIDERS.map(p => (
                  <option key={p.value} value={p.value}>{p.label}</option>
                ))}
              </select>
            </div>

            <div>
              <label htmlFor="apiKey" className="block text-sm font-medium text-gray-700 mb-1">
                API Key *
              </label>
              <input
                id="apiKey"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                required
                minLength={5}
                placeholder="Nhập API key..."
                disabled={loading}
                className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500 disabled:bg-gray-100"
              />
            </div>
          </div>

          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
              {error}
            </div>
          )}

          {success && (
            <div className="p-3 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
              {success}
            </div>
          )}

          <button
            type="submit"
            disabled={loading || !provider || !apiKey}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {loading ? 'Đang lưu...' : 'Thêm API Key'}
          </button>
        </form>
      </div>

      {/* Keys List */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-xl font-semibold text-gray-900">
            {t('listTitle')}
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            {t('listDescription')}
          </p>
        </div>

        {keys.length === 0 ? (
          <div className="px-6 py-12 text-center text-gray-500">
            <p>{t('empty')}</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Provider
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Ngày tạo
                  </th>
                  <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Cập nhật
                  </th>
                  <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">
                    Thao tác
                  </th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {keys.map((key) => (
                  <tr key={key.provider} className="hover:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap">
                      <div className="flex items-center">
                        <div>
                          <div className="text-sm font-medium text-gray-900">
                            {getProviderLabel(key.provider)}
                          </div>
                          <div className="text-xs text-gray-500">
                            {key.provider}
                          </div>
                        </div>
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(key.created_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(key.updated_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => setDeleteConfirmProvider(key.provider)}
                        className="text-red-600 hover:text-red-900 disabled:opacity-50"
                        disabled={loading}
                      >
                        Xóa
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Delete Confirmation Modal */}
      {deleteConfirmProvider && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/50" onClick={() => setDeleteConfirmProvider(null)} />
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                Xác nhận xóa
              </h3>
              <p className="text-sm text-gray-500 mb-6">
                Bạn có chắc chắn muốn xóa API key của <strong>{getProviderLabel(deleteConfirmProvider)}</strong>? Hành động này không thể hoàn tác.
              </p>
              {deleteError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm mb-4">
                  {deleteError}
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setDeleteConfirmProvider(null)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  Hủy
                </button>
                <button
                  onClick={handleDelete}
                  disabled={loading}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
                >
                  Xóa
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
