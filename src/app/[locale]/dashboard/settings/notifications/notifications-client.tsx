'use client';

import { useState, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { NotificationPreferences } from '@/components/notifications/NotificationPreferences';
import type { NotificationSettings } from '@/types/profile';

interface NotificationPreferencesClientProps {
  initialSettings: Record<string, unknown>;
  locale: string;
}

export function NotificationPreferencesClient({
  initialSettings,
  locale
}: NotificationPreferencesClientProps) {
  const t = useTranslations('notifications');

  const handleSave = useCallback(async (settings: NotificationSettings) => {
    const response = await fetch('/api/profile', {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ notification_settings: settings }),
    });

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || t('saveError'));
    }

    return response.json();
  }, [t]);

  return (
    <NotificationPreferences
      initialSettings={initialSettings as never}
      onSave={handleSave}
    />
  );
}
