'use client';

/**
 * src/hooks/useTelegramWebApp.ts
 *
 * React hook providing safe client-side access to window.Telegram.WebApp
 * with graceful SSR and standard browser fallback mocks.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import type {
  TelegramWebApp,
  TelegramUser,
  TelegramThemeParams,
  TelegramHapticFeedback,
} from '@/types/telegram';

export interface TelegramHapticWrapper {
  impactOccurred(style: 'light' | 'medium' | 'heavy' | 'rigid' | 'soft'): void;
  notificationOccurred(type: 'error' | 'success' | 'warning'): void;
  selectionChanged(): void;
}

export interface TelegramMainButtonController {
  show(): void;
  hide(): void;
  setText(text: string): void;
  onClick(fn: () => void): void;
  offClick(fn: () => void): void;
  enable(): void;
  disable(): void;
  showProgress(leaveActive?: boolean): void;
  hideProgress(): void;
  isVisible: boolean;
  isActive: boolean;
  isProgressVisible: boolean;
  text: string;
  color: string;
  textColor: string;
}

export interface TelegramBackButtonController {
  show(): void;
  hide(): void;
  onClick(fn: () => void): void;
  offClick(fn: () => void): void;
  isVisible: boolean;
}

export interface UseTelegramWebAppResult {
  webApp: TelegramWebApp | null;
  isReady: boolean;
  initData: string;
  initDataUnsafe: TelegramWebApp['initDataUnsafe'];
  user: TelegramUser | null;
  themeParams: TelegramThemeParams;
  colorScheme: 'light' | 'dark';
  viewportHeight: number;
  viewportStableHeight: number;
  isExpanded: boolean;
  expand(): void;
  ready(): void;
  close(): void;
  openTelegramLink(url: string): void;
  openLink(url: string, options?: { try_instant_view?: boolean }): void;
  hapticFeedback: TelegramHapticWrapper;
  mainButton: TelegramMainButtonController;
  backButton: TelegramBackButtonController;
}

export function useTelegramWebApp(): UseTelegramWebAppResult {
  const [isReady, setIsReady] = useState<boolean>(false);
  const [webAppInstance, setWebAppInstance] = useState<TelegramWebApp | null>(null);
  const [initData, setInitData] = useState<string>('');
  const [initDataUnsafe, setInitDataUnsafe] = useState<TelegramWebApp['initDataUnsafe']>({});
  const [user, setUser] = useState<TelegramUser | null>(null);
  const [themeParams, setThemeParams] = useState<TelegramThemeParams>({});
  const [colorScheme, setColorScheme] = useState<'light' | 'dark'>('dark');
  const [viewportHeight, setViewportHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800
  );
  const [viewportStableHeight, setViewportStableHeight] = useState<number>(() =>
    typeof window !== 'undefined' ? window.innerHeight : 800
  );
  const [isExpanded, setIsExpanded] = useState<boolean>(true);

  // Button state caches
  const [mainButtonState, setMainButtonState] = useState({
    isVisible: false,
    isActive: true,
    isProgressVisible: false,
    text: '',
    color: '#4f46e5',
    textColor: '#ffffff',
  });
  const [backButtonVisible, setBackButtonVisible] = useState(false);

  const mainClickListenersRef = useRef<Set<() => void>>(new Set());
  const backClickListenersRef = useRef<Set<() => void>>(new Set());

  // Initialization & Event Binding
  useEffect(() => {
    if (typeof window === 'undefined') return;

    const tg = window.Telegram?.WebApp;
    if (tg) {
      setWebAppInstance(tg);
      setInitData(tg.initData || '');
      setInitDataUnsafe(tg.initDataUnsafe || {});
      setUser(tg.initDataUnsafe?.user || null);
      setThemeParams(tg.themeParams || {});
      setColorScheme(tg.colorScheme || 'dark');
      setViewportHeight(tg.viewportHeight ?? window.innerHeight);
      setViewportStableHeight(tg.viewportStableHeight ?? window.innerHeight);
      setIsExpanded(tg.isExpanded ?? true);

      if (tg.MainButton) {
        setMainButtonState({
          isVisible: Boolean(tg.MainButton.isVisible),
          isActive: tg.MainButton.isActive !== false,
          isProgressVisible: Boolean(tg.MainButton.isProgressVisible),
          text: tg.MainButton.text || '',
          color: tg.MainButton.color || '#4f46e5',
          textColor: tg.MainButton.textColor || '#ffffff',
        });
      }

      if (tg.BackButton) {
        setBackButtonVisible(Boolean(tg.BackButton.isVisible));
      }

      // Signal ready to Telegram
      try {
        tg.ready();
        setIsReady(true);
      } catch {
        setIsReady(true);
      }

      // Listen for viewport updates
      const handleViewportChange = () => {
        setViewportHeight(tg.viewportHeight ?? window.innerHeight);
        setViewportStableHeight(tg.viewportStableHeight ?? window.innerHeight);
        setIsExpanded(tg.isExpanded ?? true);
      };

      // Listen for theme updates
      const handleThemeChange = () => {
        setThemeParams(tg.themeParams || {});
        setColorScheme(tg.colorScheme || 'dark');
      };

      if (typeof tg.onEvent === 'function') {
        tg.onEvent('viewportChanged', handleViewportChange);
        tg.onEvent('themeChanged', handleThemeChange);
      }

      return () => {
        if (typeof tg.offEvent === 'function') {
          try {
            tg.offEvent('viewportChanged', handleViewportChange);
            tg.offEvent('themeChanged', handleThemeChange);
          } catch {
            // Ignore teardown errors
          }
        }
      };
    } else {
      // Browser fallback (outside Telegram)
      setIsReady(true);
      const isDark =
        typeof window !== 'undefined' &&
        window.matchMedia?.('(prefers-color-scheme: dark)').matches;
      setColorScheme(isDark ? 'dark' : 'light');
    }
  }, []);

  // Viewport Actions
  const expand = useCallback(() => {
    if (webAppInstance && typeof webAppInstance.expand === 'function') {
      webAppInstance.expand();
      setIsExpanded(true);
    } else {
      setIsExpanded(true);
    }
  }, [webAppInstance]);

  const ready = useCallback(() => {
    if (webAppInstance && typeof webAppInstance.ready === 'function') {
      webAppInstance.ready();
    }
    setIsReady(true);
  }, [webAppInstance]);

  const close = useCallback(() => {
    if (webAppInstance && typeof webAppInstance.close === 'function') {
      webAppInstance.close();
    } else if (typeof window !== 'undefined') {
      window.history.back();
    }
  }, [webAppInstance]);

  // Navigation Actions
  const openTelegramLink = useCallback(
    (url: string) => {
      if (webAppInstance && typeof webAppInstance.openTelegramLink === 'function') {
        webAppInstance.openTelegramLink(url);
      } else if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    [webAppInstance]
  );

  const openLink = useCallback(
    (url: string, options?: { try_instant_view?: boolean }) => {
      if (webAppInstance && typeof webAppInstance.openLink === 'function') {
        webAppInstance.openLink(url, options);
      } else if (typeof window !== 'undefined') {
        window.open(url, '_blank', 'noopener,noreferrer');
      }
    },
    [webAppInstance]
  );

  // Haptic Feedback
  const hapticFeedback = useMemo<TelegramHapticWrapper>(() => {
    return {
      impactOccurred: (style) => {
        if (
          webAppInstance?.HapticFeedback &&
          typeof webAppInstance.HapticFeedback.impactOccurred === 'function'
        ) {
          webAppInstance.HapticFeedback.impactOccurred(style);
        } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(style === 'heavy' ? 25 : 10);
        }
      },
      notificationOccurred: (type) => {
        if (
          webAppInstance?.HapticFeedback &&
          typeof webAppInstance.HapticFeedback.notificationOccurred === 'function'
        ) {
          webAppInstance.HapticFeedback.notificationOccurred(type);
        } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(type === 'error' ? [30, 50, 30] : 15);
        }
      },
      selectionChanged: () => {
        if (
          webAppInstance?.HapticFeedback &&
          typeof webAppInstance.HapticFeedback.selectionChanged === 'function'
        ) {
          webAppInstance.HapticFeedback.selectionChanged();
        } else if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
          navigator.vibrate(5);
        }
      },
    };
  }, [webAppInstance]);

  // MainButton Controller
  const mainButton = useMemo<TelegramMainButtonController>(() => {
    return {
      show: () => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.show();
        }
        setMainButtonState((prev) => ({ ...prev, isVisible: true }));
      },
      hide: () => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.hide();
        }
        setMainButtonState((prev) => ({ ...prev, isVisible: false }));
      },
      setText: (text: string) => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.setText(text);
        }
        setMainButtonState((prev) => ({ ...prev, text }));
      },
      onClick: (fn: () => void) => {
        mainClickListenersRef.current.add(fn);
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.onClick(fn);
        }
      },
      offClick: (fn: () => void) => {
        mainClickListenersRef.current.delete(fn);
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.offClick(fn);
        }
      },
      enable: () => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.enable();
        }
        setMainButtonState((prev) => ({ ...prev, isActive: true }));
      },
      disable: () => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.disable();
        }
        setMainButtonState((prev) => ({ ...prev, isActive: false }));
      },
      showProgress: (leaveActive?: boolean) => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.showProgress(leaveActive);
        }
        setMainButtonState((prev) => ({
          ...prev,
          isProgressVisible: true,
          isActive: leaveActive ?? prev.isActive,
        }));
      },
      hideProgress: () => {
        if (webAppInstance?.MainButton) {
          webAppInstance.MainButton.hideProgress();
        }
        setMainButtonState((prev) => ({ ...prev, isProgressVisible: false }));
      },
      isVisible: webAppInstance?.MainButton?.isVisible ?? mainButtonState.isVisible,
      isActive: webAppInstance?.MainButton?.isActive ?? mainButtonState.isActive,
      isProgressVisible:
        webAppInstance?.MainButton?.isProgressVisible ?? mainButtonState.isProgressVisible,
      text: webAppInstance?.MainButton?.text ?? mainButtonState.text,
      color: webAppInstance?.MainButton?.color ?? mainButtonState.color,
      textColor: webAppInstance?.MainButton?.textColor ?? mainButtonState.textColor,
    };
  }, [webAppInstance, mainButtonState]);

  // BackButton Controller
  const backButton = useMemo<TelegramBackButtonController>(() => {
    return {
      show: () => {
        if (webAppInstance?.BackButton) {
          webAppInstance.BackButton.show();
        }
        setBackButtonVisible(true);
      },
      hide: () => {
        if (webAppInstance?.BackButton) {
          webAppInstance.BackButton.hide();
        }
        setBackButtonVisible(false);
      },
      onClick: (fn: () => void) => {
        backClickListenersRef.current.add(fn);
        if (webAppInstance?.BackButton) {
          webAppInstance.BackButton.onClick(fn);
        }
      },
      offClick: (fn: () => void) => {
        backClickListenersRef.current.delete(fn);
        if (webAppInstance?.BackButton) {
          webAppInstance.BackButton.offClick(fn);
        }
      },
      isVisible: webAppInstance?.BackButton?.isVisible ?? backButtonVisible,
    };
  }, [webAppInstance, backButtonVisible]);

  return {
    webApp: webAppInstance,
    isReady,
    initData,
    initDataUnsafe,
    user,
    themeParams,
    colorScheme,
    viewportHeight,
    viewportStableHeight,
    isExpanded,
    expand,
    ready,
    close,
    openTelegramLink,
    openLink,
    hapticFeedback,
    mainButton,
    backButton,
  };
}
