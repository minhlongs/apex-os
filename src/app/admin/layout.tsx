'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/contexts/auth-context';

interface Profile {
  id: string;
  email: string;
  role: 'shopper' | 'affiliate' | 'admin' | 'master_trader';
}

const navItems = [
  { href: '/admin/analytics', label: 'Analytics' },
  { href: '/admin/monitoring', label: 'Monitoring' },
  { href: '/admin/notifications', label: 'Notifications' },
  { href: '/admin/fraud', label: 'Fraud Detection' },
  { href: '/en/admin/treasury', label: 'Treasury & Ascendancy' },
];

export default function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { user, loading } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [profileLoading, setProfileLoading] = useState(true);
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    async function fetchProfile() {
      if (!user) {
        setProfileLoading(false);
        return;
      }

      try {
        const res = await fetch('/api/profile');
        if (res.ok) {
          const data = await res.json();
          if (data.success && data.profile) {
            setProfile(data.profile);
          }
        }
      } catch (error) {
        console.error('Failed to fetch profile:', error);
      } finally {
        setProfileLoading(false);
      }
    }

    fetchProfile();
  }, [user]);

  useEffect(() => {
    if (!loading && !profileLoading) {
      if (!user) {
        router.push('/login');
      } else if (profile?.role !== 'admin') {
        router.push('/');
      }
    }
  }, [user, profile, loading, profileLoading, router]);

  if (loading || profileLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="text-gray-500">Loading...</div>
      </div>
    );
  }

  if (!user || profile?.role !== 'admin') {
    return null;
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <nav className="bg-white border-b border-gray-200">
        <div className="container mx-auto px-4 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-8">
              <h1 className="text-xl font-bold text-gray-900">ApexOS Admin</h1>
              <div className="flex items-center gap-1">
                {navItems.map((item) => {
                  const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
                  return (
                    <a
                      key={item.href}
                      href={item.href}
                      className={`px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                        isActive
                          ? 'bg-blue-50 text-blue-700'
                          : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                      }`}
                    >
                      {item.label}
                    </a>
                  );
                })}
              </div>
            </div>
            <div className="flex items-center gap-4">
              <span className="text-sm text-gray-600">{user.email}</span>
              <a
                href="/"
                className="text-sm text-blue-600 hover:text-blue-800"
              >
                Back to App
              </a>
            </div>
          </div>
        </div>
      </nav>
      <main className="container mx-auto px-4 py-8">
        {children}
      </main>
    </div>
  );
}
