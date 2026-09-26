'use client';

import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { BarChart3, Package, Activity, DollarSign, Bell, Settings, ShieldAlert } from 'lucide-react';
import NotificationBadge from '@/components/notifications/NotificationBadge';

interface AdminNavProps {
  locale: string;
}

const navItems = [
  { href: '/admin/deals', labelKey: 'deals', icon: Package },
  { href: '/admin/analytics', labelKey: 'analytics', icon: BarChart3 },
  { href: '/admin/metrics', labelKey: 'metrics', icon: DollarSign },
  { href: '/admin/health', labelKey: 'health', icon: Activity },
  { href: '/admin/alerts', labelKey: 'alerts', icon: Bell, showBadge: false },
  { href: '/admin/fraud', labelKey: 'fraud', icon: ShieldAlert, showBadge: true },
];

const settingsItems = [
  { href: '/admin/settings/notifications', labelKey: 'notifications', icon: Bell },
  { href: '/admin/settings/stellar', labelKey: 'stellar', icon: Settings },
];

export default function AdminNav({ locale }: AdminNavProps) {
  const t = useTranslations('admin');
  const pathname = usePathname();

  return (
    <nav className="mb-8 border-b border-gray-200 bg-white shadow-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center space-x-8 overflow-x-auto">
          {navItems.map(({ href, labelKey, icon: Icon, showBadge }) => {
            const isActive = pathname === href || pathname?.startsWith(href + '/');

            return (
              <Link
                key={href}
                href={`/${locale}${href}`}
                className={`flex items-center space-x-2 py-4 border-b-2 font-medium text-sm whitespace-nowrap ${
                  isActive
                    ? 'border-brand-600 text-brand-600'
                    : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                }`}
              >
                <div className="relative inline-flex items-center justify-center">
                  <Icon className="w-4 h-4" />
                  {showBadge && <NotificationBadge locale={locale} />}
                </div>
                <span>{t(`nav.${labelKey}`) || labelKey}</span>
              </Link>
            );
          })}

          {/* Settings dropdown */}
          <div className="relative group">
            <button className="flex items-center space-x-2 py-4 border-b-2 font-medium text-sm whitespace-nowrap border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300">
              <Settings className="w-4 h-4" />
              <span>{t('nav.settings') || 'Settings'}</span>
            </button>
            <div className="absolute top-full left-0 mt-0 w-48 bg-white rounded-md shadow-lg border border-gray-200 opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all z-50">
              <div className="py-1">
                {settingsItems.map(({ href, labelKey, icon: Icon }) => {
                  const isActive = pathname === href || pathname?.startsWith(href + '/');
                  return (
                    <Link
                      key={href}
                      href={`/${locale}${href}`}
                      className={`flex items-center space-x-2 px-4 py-2 text-sm ${
                        isActive
                          ? 'bg-indigo-50 text-indigo-700'
                          : 'text-gray-700 hover:bg-gray-50'
                      }`}
                    >
                      <Icon className="w-4 h-4" />
                      <span>{t(`nav.settings.${labelKey}`) || labelKey}</span>
                    </Link>
                  );
                })}
              </div>
            </div>
          </div>
        </div>
      </div>
    </nav>
  );
}
