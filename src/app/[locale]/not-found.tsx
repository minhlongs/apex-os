'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';

const translations = {
  vi: {
    title: 'Trang không tồn tại',
    description: 'Trang bạn tìm kiếm không tồn tại hoặc đã bị xóa.',
    goHome: 'Về trang chủ',
  },
  en: {
    title: 'Page not found',
    description: 'The page you are looking for does not exist or has been removed.',
    goHome: 'Go home',
  },
};

function NotFoundIcon() {
  return (
    <svg
      className="w-16 h-16 mx-auto text-text-tertiary dark:text-text-tertiary mb-6"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeWidth={1}
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        d="M9.879 7.519c1.171-1.025 3.071-1.025 4.242 0 1.172 1.025 1.172 2.687 0 3.712-.203.179-.43.326-.67.442-.745.361-1.45.999-1.45 1.827v.75M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9 5.25h.008v.008H12v-.008z"
      />
    </svg>
  );
}

export default function NotFound() {
  const [locale, setLocale] = useState<'vi' | 'en'>('vi');

  useEffect(() => {
    const pathLocale = window.location.pathname.split('/')[1];
    if (pathLocale === 'en') setLocale('en');
  }, []);

  const t = translations[locale];

  return (
    <div className="min-h-screen flex items-center justify-center bg-background dark:bg-background-darker antialiased">
      <div className="max-w-md w-full mx-4 p-8 bg-white dark:bg-surface-dark rounded-xl shadow-lg text-center">
        <NotFoundIcon />
        <h1 className="heading-3 text-text-primary dark:text-text-inverse mb-3">
          {t.title}
        </h1>
        <p className="text-text-secondary dark:text-text-tertiary mb-6 text-sm">
          {t.description}
        </p>
        <Link href={`/${locale}`} className="btn btn-primary">
          {t.goHome}
        </Link>
      </div>
    </div>
  );
}
