'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const translations = {
  vi: {
    title: 'Lỗi bảng điều khiển quản trị',
    description: 'Đã xảy ra lỗi khi tải bảng điều khiển quản trị.',
    errorDetails: 'Chi tiết lỗi',
    tryAgain: 'Thử lại',
    goDashboard: 'Về Dashboard',
  },
  en: {
    title: 'Admin dashboard error',
    description: 'An error occurred while loading the admin dashboard.',
    errorDetails: 'Error details',
    tryAgain: 'Try again',
    goDashboard: 'Go to Dashboard',
  },
};

function ErrorIcon() {
  return (
    <svg
      className="w-16 h-16 mx-auto text-error-500 mb-6"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1.5}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z"
      />
    </svg>
  );
}

export default function AdminError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [locale, setLocale] = useState<'vi' | 'en'>('vi');

  useEffect(() => {
    const pathLocale = window.location.pathname.split('/')[1];
    if (pathLocale === 'en') setLocale('en');
  }, []);

  const t = translations[locale];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background dark:bg-background-darker antialiased">
      <div className="max-w-md w-full mx-4 p-8 bg-white dark:bg-surface-dark rounded-xl shadow-lg text-center">
        <ErrorIcon />
        <h2 className="heading-3 text-text-primary dark:text-text-inverse mb-3">
          {t.title}
        </h2>
        <p className="text-text-secondary dark:text-text-tertiary mb-2 text-sm">
          {t.description}
        </p>
        {error?.message && (
          <p className="text-xs text-text-tertiary mb-6 font-mono bg-surface dark:bg-surface-darker p-3 rounded-lg break-all">
            {error.message}
          </p>
        )}
        <div className="flex flex-col sm:flex-row gap-3 justify-center">
          <button onClick={reset} className="btn btn-primary">
            {t.tryAgain}
          </button>
          <Link href={`/${locale}/dashboard`} className="btn btn-outline">
            {t.goDashboard}
          </Link>
        </div>
      </div>
    </div>
  );
}
