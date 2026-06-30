'use client'

import { useState, useCallback, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { AffiliateDeal, CreateDealDto, UpdateDealDto } from '@/types/deal'

interface DealListClientProps {
  initialDeals: AffiliateDeal[]
  total: number
  totalPages: number
  currentPage: number
  limit: number
  initialFilters: { status?: string; exchange?: string; category?: string; search?: string }
}

interface FormState {
  name: string
  description: string
  url: string
  deal_type: string
  product_id: string
  default_commission_rate: string
  default_commission_type: 'percentage' | 'fixed'
  fixed_commission_amount: string
  cookie_duration_days: string
  is_active: boolean
  exchange: string
  category: string
  cashback_percent: string
  risk_level: string
  starts_at: string
  ends_at: string
}

const emptyForm: FormState = {
  name: '',
  description: '',
  url: '',
  deal_type: 'product',
  product_id: '',
  default_commission_rate: '10',
  default_commission_type: 'percentage',
  fixed_commission_amount: '0',
  cookie_duration_days: '30',
  is_active: true,
  exchange: '',
  category: '',
  cashback_percent: '',
  risk_level: '',
  starts_at: '',
  ends_at: '',
}

const exchanges = ['binance', 'bybit', 'okx', 'ftx', 'coinbase', 'kraken']
const categories = ['spot', 'futures', 'options', 'margin']
const riskLevels = ['low', 'medium', 'high']
const dealTypes = ['product', 'service', 'subscription', 'course']

export default function DealListClient(props: DealListClientProps) {
  const {
    initialDeals,
    total,
    totalPages,
    currentPage,
    limit,
    initialFilters
  } = props

  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const t = useTranslations()

  // State
  const [deals, setDeals] = useState<AffiliateDeal[]>(initialDeals)
  const [filters, setFilters] = useState({
    search: initialFilters.search || '',
    exchange: initialFilters.exchange || '',
    category: initialFilters.category || '',
    status: initialFilters.status || '',
  })

  const [isModalOpen, setIsModalOpen] = useState(false)
  const [editingDeal, setEditingDeal] = useState<AffiliateDeal | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)
  const [formError, setFormError] = useState<string | null>(null)
  const [formSuccess, setFormSuccess] = useState(false)

  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  // Sync deals when initialDeals changes
  useEffect(() => {
    setDeals(initialDeals)
  }, [initialDeals])

  // Apply filters
  const applyFilters = useCallback((newFilters: typeof filters) => {
    setFilters(newFilters)
    const params = new URLSearchParams()
    if (newFilters.search) params.set('search', newFilters.search)
    if (newFilters.exchange) params.set('exchange', newFilters.exchange)
    if (newFilters.category) params.set('category', newFilters.category)
    if (newFilters.status) params.set('is_active', newFilters.status)
    params.set('page', '1')
    startTransition(() => {
      router.push(`?${params.toString()}`)
    })
  }, [router])

  // Open create modal
  const openCreateModal = () => {
    setEditingDeal(null)
    setForm(emptyForm)
    setFormError(null)
    setFormSuccess(false)
    setIsModalOpen(true)
  }

  // Open edit modal
  const openEditModal = async (deal: AffiliateDeal) => {
    setEditingDeal(deal)
    setForm({
      name: deal.name,
      description: deal.description || '',
      url: deal.url,
      deal_type: deal.deal_type,
      product_id: deal.product_id || '',
      default_commission_rate: String(deal.default_commission_rate * 100),
      default_commission_type: deal.default_commission_type,
      fixed_commission_amount: String(deal.fixed_commission_amount),
      cookie_duration_days: String(deal.cookie_duration_days),
      is_active: deal.is_active === 1,
      exchange: deal.exchange || '',
      category: deal.category || '',
      cashback_percent: deal.cashback_percent ? String(deal.cashback_percent) : '',
      risk_level: deal.risk_level || '',
      starts_at: deal.starts_at || '',
      ends_at: deal.ends_at || '',
    })
    setFormError(null)
    setFormSuccess(false)
    setIsModalOpen(true)
  }

  // Handle form input change
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value, type } = e.target
    setForm(prev => ({
      ...prev,
      [name]: type === 'checkbox' ? (e.target as HTMLInputElement).checked : value
    }))
  }

  // Submit form
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setFormError(null)
    setFormSuccess(false)

    const payload: CreateDealDto | UpdateDealDto = {
      name: form.name,
      description: form.description || undefined,
      url: form.url,
      deal_type: form.deal_type,
      product_id: form.product_id || undefined,
      default_commission_rate: parseFloat(form.default_commission_rate) / 100,
      default_commission_type: form.default_commission_type,
      fixed_commission_amount: parseFloat(form.fixed_commission_amount),
      cookie_duration_days: parseInt(form.cookie_duration_days),
      is_active: form.is_active,
      exchange: form.exchange ? (form.exchange as 'binance' | 'bybit' | 'okx' | 'ftx' | 'coinbase' | 'kraken') : undefined,
      category: form.category ? (form.category as 'spot' | 'futures' | 'options' | 'margin') : undefined,
      cashback_percent: form.cashback_percent ? parseFloat(form.cashback_percent) : undefined,
      risk_level: form.risk_level ? (form.risk_level as 'low' | 'medium' | 'high') : undefined,
      starts_at: form.starts_at || undefined,
      ends_at: form.ends_at || undefined,
    }

    try {
      let response
      if (editingDeal) {
        const res = await fetch(`/api/deals/${editingDeal.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        response = await res.json()
        if (!res.ok) throw new Error(response.error || 'Failed to update deal')
      } else {
        const res = await fetch('/api/deals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        })
        response = await res.json()
        if (!res.ok) throw new Error(response.error || 'Failed to create deal')
      }

      setFormSuccess(true)
      setTimeout(() => {
        setIsModalOpen(false)
        router.refresh()
      }, 1000)
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An error occurred')
    }
  }

  // Handle delete
  const handleDelete = async () => {
    if (!deleteConfirmId) return
    setDeleteError(null)

    try {
      const res = await fetch(`/api/deals/${deleteConfirmId}`, {
        method: 'DELETE',
      })
      const response = await res.json()
      if (!res.ok) throw new Error(response.error || 'Failed to delete deal')

      setDeleteConfirmId(null)
      router.refresh()
    } catch (err) {
      setDeleteError(err instanceof Error ? err.message : 'Failed to delete')
    }
  }

  // Pagination
  const handlePageChange = (newPage: number) => {
    const params = new URLSearchParams()
    if (filters.search) params.set('search', filters.search)
    if (filters.exchange) params.set('exchange', filters.exchange)
    if (filters.category) params.set('category', filters.category)
    if (filters.status) params.set('is_active', filters.status)
    params.set('page', String(newPage))
    startTransition(() => {
      router.push(`?${params.toString()}`)
    })
  }

  // Render helpers
  const formatDate = (dateStr: string) => {
    return new Date(dateStr).toLocaleDateString('vi-VN')
  }

  const renderStatus = (isActive: number) => (
    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${isActive === 1 ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}`}>
      {isActive === 1 ? t('status.active') : t('status.inactive')}
    </span>
  )

  const renderExchange = (exchange?: string | null) => {
    if (!exchange) return '-'
    const exchangeNames: Record<string, string> = {
      binance: 'Binance',
      bybit: 'Bybit',
      okx: 'OKX',
      ftx: 'FTX',
      coinbase: 'Coinbase',
      kraken: 'Kraken'
    }
    return exchangeNames[exchange] || exchange
  }

  return (
    <div className="space-y-6">
      {/* Filters */}
      <div className="bg-white rounded-xl shadow p-6">
        <div className="flex flex-wrap gap-4 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              {t('stitch.common.search')}
            </label>
            <input
              type="text"
              name="search"
              value={filters.search}
              onChange={(e) => setFilters(prev => ({ ...prev, search: e.target.value }))}
              onKeyDown={(e) => e.key === 'Enter' && applyFilters(filters)}
              placeholder={t('forms.search_placeholder')}
              className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            />
          </div>

          <div className="min-w-[150px]">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Exchange
            </label>
            <select
              name="exchange"
              value={filters.exchange}
              onChange={(e) => setFilters(prev => ({ ...prev, exchange: e.target.value }))}
              className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">All Exchanges</option>
              {exchanges.map(ex => (
                <option key={ex} value={ex}>{ex.charAt(0).toUpperCase() + ex.slice(1)}</option>
              ))}
            </select>
          </div>

          <div className="min-w-[150px]">
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Category
            </label>
            <select
              name="category"
              value={filters.category}
              onChange={(e) => setFilters(prev => ({ ...prev, category: e.target.value }))}
              className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">All Categories</option>
              {categories.map(cat => (
                <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
              ))}
            </select>
          </div>

          <div className="min-w-[120px]">
            <label className="block text-sm font-medium text-gray-700 mb-1">Status</label>
            <select
              name="status"
              value={filters.status}
              onChange={(e) => setFilters(prev => ({ ...prev, status: e.target.value }))}
              className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
            >
              <option value="">All</option>
              <option value="1">Active</option>
              <option value="0">Inactive</option>
            </select>
          </div>

          <button
            onClick={() => applyFilters(filters)}
            disabled={isPending}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
          >
            {t('stitch.common.filter')}
          </button>

          <button
            onClick={() => {
              setFilters({ search: '', exchange: '', category: '', status: '' })
              router.push(`/?page=1`)
            }}
            className="px-4 py-2 bg-gray-200 text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-300"
          >
            {t('deals.filters.clearAll')}
          </button>

          <button
            onClick={openCreateModal}
            className="ml-auto px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700"
          >
            {t('stitch.common.create')}
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-xl shadow overflow-hidden">
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Exchange</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Category</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Commission</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Cashback</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {deals.length === 0 ? (
                <tr>
                  <td colSpan={8} className="px-6 py-12 text-center text-gray-500">
                    {t('tables.empty')}
                  </td>
                </tr>
              ) : (
                deals.map((deal) => (
                  <tr key={deal.id} className="hover:bg-gray-50">
                    <td className="px-6 py-4">
                      <div>
                        <div className="text-sm font-medium text-gray-900">{deal.name}</div>
                        {deal.description && (
                          <div className="text-xs text-gray-500 truncate max-w-xs">{deal.description}</div>
                        )}
                      </div>
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {renderExchange(deal.exchange)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {deal.category ? deal.category.toUpperCase() : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {(deal.default_commission_rate * 100).toFixed(1)}% {deal.default_commission_type === 'fixed' && '(fixed)'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {deal.cashback_percent ? `${deal.cashback_percent}%` : '-'}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap">{renderStatus(deal.is_active)}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {formatDate(deal.created_at)}
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                      <button
                        onClick={() => openEditModal(deal)}
                        className="text-indigo-600 hover:text-indigo-900 mr-4"
                      >
                        {t('tables.actions.edit')}
                      </button>
                      <button
                        onClick={() => setDeleteConfirmId(deal.id)}
                        className="text-red-600 hover:text-red-900"
                      >
                        {t('tables.actions.delete')}
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="bg-white px-6 py-4 border-t border-gray-200 flex items-center justify-between">
            <div className="text-sm text-gray-500">
              {t('tables.pagination.showing', {
                from: ((currentPage - 1) * limit) + 1,
                to: Math.min(currentPage * limit, total),
                total: total
              })}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage === 1 || isPending}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('tables.pagination.previous')}
              </button>
              {Array.from({ length: totalPages }, (_, i) => i + 1)
                .filter(p => p === 1 || p === totalPages || Math.abs(p - currentPage) <= 2)
                .map((p, idx, arr) => (
                  <span key={p}>
                    {idx > 0 && arr[idx - 1] !== p - 1 && <span className="px-2">...</span>}
                    <button
                      onClick={() => handlePageChange(p)}
                      disabled={isPending}
                      className={`px-3 py-1 border rounded text-sm ${currentPage === p ? 'bg-indigo-600 text-white border-indigo-600' : 'hover:bg-gray-100'}`}
                    >
                      {p}
                    </button>
                  </span>
                ))}
              <button
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage === totalPages || isPending}
                className="px-3 py-1 border rounded text-sm disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t('tables.pagination.next')}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Create/Edit Modal */}
      {isModalOpen && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/50" onClick={() => setIsModalOpen(false)} />
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto">
              <div className="sticky top-0 bg-white border-b border-gray-200 px-6 py-4 flex justify-between items-center">
                <h3 className="text-lg font-semibold text-gray-900">
                  {editingDeal ? t('tables.actions.edit') : t('stitch.common.create')}
                </h3>
                <button onClick={() => setIsModalOpen(false)} className="text-gray-400 hover:text-gray-500">
                  <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>

              <form onSubmit={handleSubmit} className="p-6 space-y-6">
                {formError && (
                  <div className="p-4 bg-red-50 border border-red-200 rounded-lg text-red-700 text-sm">
                    {formError}
                  </div>
                )}
                {formSuccess && (
                  <div className="p-4 bg-green-50 border border-green-200 rounded-lg text-green-700 text-sm">
                    {editingDeal ? 'Deal updated successfully!' : 'Deal created successfully!'}
                  </div>
                )}

                <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('forms.name')} *
                    </label>
                    <input
                      type="text"
                      name="name"
                      value={form.name}
                      onChange={handleInputChange}
                      required
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('forms.url')} *
                    </label>
                    <input
                      type="url"
                      name="url"
                      value={form.url}
                      onChange={handleInputChange}
                      required
                      placeholder="https://..."
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('forms.description_label')}
                    </label>
                    <textarea
                      name="description"
                      value={form.description}
                      onChange={handleInputChange}
                      rows={3}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('deals.types.product')}
                    </label>
                    <select
                      name="deal_type"
                      value={form.deal_type}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      {dealTypes.map(type => (
                        <option key={type} value={type}>{type.charAt(0).toUpperCase() + type.slice(1)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Exchange
                    </label>
                    <select
                      name="exchange"
                      value={form.exchange}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      <option value="">Select Exchange</option>
                      {exchanges.map(ex => (
                        <option key={ex} value={ex}>{ex.charAt(0).toUpperCase() + ex.slice(1)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('deals.categories.spot')}
                    </label>
                    <select
                      name="category"
                      value={form.category}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      <option value="">Select Category</option>
                      {categories.map(cat => (
                        <option key={cat} value={cat}>{cat.charAt(0).toUpperCase() + cat.slice(1)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      {t('deals.risk.low')}
                    </label>
                    <select
                      name="risk_level"
                      value={form.risk_level}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      <option value="">Select Risk</option>
                      {riskLevels.map(r => (
                        <option key={r} value={r}>{r.charAt(0).toUpperCase() + r.slice(1)}</option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Default Commission Rate (%)
                    </label>
                    <input
                      type="number"
                      name="default_commission_rate"
                      value={form.default_commission_rate}
                      onChange={handleInputChange}
                      min="0"
                      max="100"
                      step="0.1"
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Commission Type
                    </label>
                    <select
                      name="default_commission_type"
                      value={form.default_commission_type}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    >
                      <option value="percentage">Percentage</option>
                      <option value="fixed">Fixed Amount</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Fixed Commission Amount
                    </label>
                    <input
                      type="number"
                      name="fixed_commission_amount"
                      value={form.fixed_commission_amount}
                      onChange={handleInputChange}
                      min="0"
                      step="0.01"
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Cookie Duration (days)
                    </label>
                    <input
                      type="number"
                      name="cookie_duration_days"
                      value={form.cookie_duration_days}
                      onChange={handleInputChange}
                      min="1"
                      max="365"
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Cashback Percent (%)
                    </label>
                    <input
                      type="number"
                      name="cashback_percent"
                      value={form.cashback_percent}
                      onChange={handleInputChange}
                      min="0"
                      max="100"
                      step="0.1"
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Product ID
                    </label>
                    <input
                      type="text"
                      name="product_id"
                      value={form.product_id}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      Start Date
                    </label>
                    <input
                      type="date"
                      name="starts_at"
                      value={form.starts_at}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-1">
                      End Date
                    </label>
                    <input
                      type="date"
                      name="ends_at"
                      value={form.ends_at}
                      onChange={handleInputChange}
                      className="w-full rounded-lg border-gray-300 border px-3 py-2 text-sm focus:border-indigo-500 focus:ring-indigo-500"
                    />
                  </div>

                  <div className="flex items-center">
                    <input
                      type="checkbox"
                      name="is_active"
                      checked={form.is_active}
                      onChange={handleInputChange}
                      className="h-4 w-4 text-indigo-600 focus:ring-indigo-500 border-gray-300 rounded"
                    />
                    <label className="ml-2 block text-sm text-gray-900">
                      {t('status.active')}
                    </label>
                  </div>
                </div>

                <div className="flex justify-end gap-3 pt-4 border-t border-gray-200">
                  <button
                    type="button"
                    onClick={() => setIsModalOpen(false)}
                    className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    {t('stitch.common.cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isPending}
                    className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-700 disabled:opacity-50"
                  >
                    {isPending ? t('stitch.common.loading') : t('stitch.common.save')}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation */}
      {deleteConfirmId && (
        <div className="fixed inset-0 z-50 overflow-y-auto">
          <div className="flex min-h-screen items-center justify-center p-4">
            <div className="fixed inset-0 bg-black/50" onClick={() => setDeleteConfirmId(null)} />
            <div className="relative bg-white rounded-xl shadow-2xl w-full max-w-md p-6">
              <h3 className="text-lg font-semibold text-gray-900 mb-2">
                {t('dialogs.delete_confirm_title')}
              </h3>
              <p className="text-sm text-gray-500 mb-6">
                {t('dialogs.delete_confirm_message')}
              </p>
              {deleteError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded text-red-700 text-sm mb-4">
                  {deleteError}
                </div>
              )}
              <div className="flex justify-end gap-3">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="px-4 py-2 border border-gray-300 rounded-lg text-sm font-medium text-gray-700 hover:bg-gray-50"
                >
                  {t('dialogs.cancel')}
                </button>
                <button
                  onClick={handleDelete}
                  className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700"
                >
                  {t('dialogs.confirm')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
