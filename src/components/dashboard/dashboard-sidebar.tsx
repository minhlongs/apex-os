'use client'

import { usePathname } from 'next/navigation'
import Link from 'next/link'

interface DashboardSidebarProps {
  isOpen?: boolean
  onClose?: () => void
}

export function DashboardSidebar({ isOpen = true, onClose }: DashboardSidebarProps) {
  const pathname = usePathname()

  const localeMatch = pathname?.match(/^\/(vi|en)(?=\/|$)/)
  const localePrefix = localeMatch ? `/${localeMatch[1]}` : '/vi'
  const isVi = localePrefix === '/vi'

  const navLinks = [
    {
      to: `${localePrefix}/dashboard`,
      exact: true,
      label: isVi ? 'Tổng quan' : 'Dashboard',
      icon: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
    },
    {
      to: `${localePrefix}/dashboard/profile`,
      exact: false,
      label: isVi ? 'Hồ sơ & Khóa Sàn' : 'Profile & Keys',
      icon: 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z',
    },
    {
      to: `${localePrefix}/dashboard/affiliates`,
      exact: false,
      label: isVi ? 'Đối tác Affiliate' : 'Affiliates',
      icon: 'M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z',
    },
    {
      to: `${localePrefix}/dashboard/conversions`,
      exact: false,
      label: isVi ? 'Lịch sử Giao dịch' : 'Conversions',
      icon: 'M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z',
    },
    {
      to: `${localePrefix}/dashboard/payouts`,
      exact: false,
      label: isVi ? 'Chi trả USDC' : 'Payouts',
      icon: 'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    },
    {
      to: `${localePrefix}/dashboard/settings/notifications`,
      exact: false,
      label: isVi ? 'Thông báo' : 'Notifications',
      icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    },
  ]

  const sidebarClasses = `
    fixed lg:static inset-y-0 left-0 z-40
    w-64 bg-stitch-surface border-r border-stitch-border
    transform transition-transform duration-300 ease-in-out
    lg:transform-none
    ${isOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'}
  `

  const isActive = (href: string, exact: boolean) => {
    if (!pathname) return false
    if (exact) return pathname === href || pathname === '/dashboard'
    return pathname === href || pathname.startsWith(`${href}/`)
  }

  return (
    <>
      {/* Mobile overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 lg:hidden"
          onClick={onClose}
        />
      )}

      <aside className={sidebarClasses}>
        <nav className="p-4 space-y-1">
          {navLinks.map((link) => {
            const active = isActive(link.to, link.exact)
            return (
              <Link
                key={link.to}
                href={link.to}
                onClick={() => onClose?.()}
                className={`flex items-center space-x-3 px-4 py-3 rounded-lg transition-colors ${
                  active
                    ? 'bg-stitch-indigo/15 text-stitch-indigo border border-stitch-indigo/30 font-semibold'
                    : 'text-stitch-muted hover:bg-stitch-well hover:text-stitch-primary'
                }`}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={link.icon} />
                </svg>
                <span>{link.label}</span>
              </Link>
            )
          })}
        </nav>
      </aside>
    </>
  )
}
