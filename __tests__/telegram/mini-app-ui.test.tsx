/**
 * __tests__/telegram/mini-app-ui.test.tsx
 *
 * Comprehensive Automated UI Test Suite for Telegram Mini App (TMA):
 * - useTelegramWebApp hook (SDK integration & SSR/browser fallback)
 * - TelegramLeaderboard component (Podium 1st/2nd/3rd, ranks 4-100, period selector, sticky user bar)
 * - TelegramAppClient component (Tabs navigation, deals feed, referral copy with haptics, earnings, wallet binding)
 * - TelegramLayout & CSS theme variables
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act, renderHook } from '@testing-library/react';
import { useTelegramWebApp } from '@/hooks/useTelegramWebApp';
import {
  TelegramLeaderboard,
  computeTier,
  getNextTierTarget,
} from '@/components/telegram/TelegramLeaderboard';
import TelegramAppClient from '@/app/[locale]/telegram/app/telegram-app-client';
import TelegramLayout, { viewport, metadata } from '@/app/[locale]/telegram/layout';
import type { TelegramWebApp, LeaderboardResponse } from '@/types/telegram';

// Mock navigator.clipboard
const mockWriteText = jest.fn().mockResolvedValue(undefined);
Object.assign(navigator, {
  clipboard: {
    writeText: mockWriteText,
  },
});

// Mock fetch
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Helper to create Telegram WebApp mock
function createMockTelegramWebApp(overrides: Partial<TelegramWebApp> = {}): TelegramWebApp {
  const eventListeners: Record<string, Array<(...args: any[]) => void>> = {};

  return {
    initData: 'query_id=AAHd&user=%7B%22id%22%3A123456%2C%22first_name%22%3A%22Alice%22%2C%22username%22%3A%22alice_crypto%22%7D&auth_date=1727500000&hash=mockhash123',
    initDataUnsafe: {
      query_id: 'AAHd',
      user: {
        id: 123456,
        first_name: 'Alice',
        last_name: 'Crypto',
        username: 'alice_crypto',
        language_code: 'en',
      },
      auth_date: 1727500000,
      hash: 'mockhash123',
      start_param: 'ref_TOPLEADER',
    },
    version: '7.0',
    platform: 'tdesktop',
    colorScheme: 'dark',
    themeParams: {
      bg_color: '#17212b',
      text_color: '#f5f5f5',
      hint_color: '#708499',
      button_color: '#5288c1',
      button_text_color: '#ffffff',
      secondary_bg_color: '#232e3c',
    },
    isExpanded: true,
    viewportHeight: 720,
    viewportStableHeight: 720,
    headerColor: '#17212b',
    backgroundColor: '#17212b',
    ready: jest.fn(),
    expand: jest.fn(),
    close: jest.fn(),
    openLink: jest.fn(),
    openTelegramLink: jest.fn(),
    HapticFeedback: {
      impactOccurred: jest.fn(),
      notificationOccurred: jest.fn(),
      selectionChanged: jest.fn(),
    },
    MainButton: {
      text: 'CONFIRM',
      color: '#4f46e5',
      textColor: '#ffffff',
      isVisible: false,
      isActive: true,
      isProgressVisible: false,
      setText: jest.fn(),
      onClick: jest.fn(),
      offClick: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
      enable: jest.fn(),
      disable: jest.fn(),
      showProgress: jest.fn(),
      hideProgress: jest.fn(),
    },
    BackButton: {
      isVisible: false,
      onClick: jest.fn(),
      offClick: jest.fn(),
      show: jest.fn(),
      hide: jest.fn(),
    },
    onEvent: jest.fn((event: string, callback: (...args: any[]) => void) => {
      if (!eventListeners[event]) eventListeners[event] = [];
      eventListeners[event].push(callback);
    }),
    offEvent: jest.fn((event: string, callback: (...args: any[]) => void) => {
      if (!eventListeners[event]) return;
      eventListeners[event] = eventListeners[event].filter((cb) => cb !== callback);
    }),
    ...overrides,
  };
}

describe('Telegram Mini App (TMA) UI Suite', () => {
  let originalTelegram: any;

  beforeEach(() => {
    jest.clearAllMocks();
    originalTelegram = window.Telegram;
    mockFetch.mockReset();
    mockWriteText.mockClear();
  });

  afterEach(() => {
    window.Telegram = originalTelegram;
  });

  // ==========================================================================
  // 1. useTelegramWebApp Hook Tests
  // ==========================================================================
  describe('useTelegramWebApp Hook', () => {
    it('initializes cleanly with Telegram WebApp SDK when present', () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      const { result } = renderHook(() => useTelegramWebApp());

      expect(mockTg.ready).toHaveBeenCalled();
      expect(result.current.isReady).toBe(true);
      expect(result.current.user).toEqual(mockTg.initDataUnsafe.user);
      expect(result.current.colorScheme).toBe('dark');
      expect(result.current.viewportHeight).toBe(720);
      expect(result.current.isExpanded).toBe(true);
      expect(result.current.initData).toContain('hash=mockhash123');
    });

    it('gracefully falls back when outside Telegram (SSR / standard browser)', () => {
      delete (window as any).Telegram;

      const { result } = renderHook(() => useTelegramWebApp());

      expect(result.current.isReady).toBe(true);
      expect(result.current.user).toBeNull();
      expect(result.current.initData).toBe('');
      expect(result.current.webApp).toBeNull();
      expect(typeof result.current.expand).toBe('function');
      expect(typeof result.current.hapticFeedback.selectionChanged).toBe('function');

      // Safe no-op calls
      expect(() => {
        result.current.expand();
        result.current.ready();
        result.current.hapticFeedback.selectionChanged();
        result.current.hapticFeedback.impactOccurred('medium');
        result.current.hapticFeedback.notificationOccurred('success');
      }).not.toThrow();
    });

    it('triggers haptic feedback methods through SDK', () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      const { result } = renderHook(() => useTelegramWebApp());

      result.current.hapticFeedback.impactOccurred('heavy');
      expect(mockTg.HapticFeedback.impactOccurred).toHaveBeenCalledWith('heavy');

      result.current.hapticFeedback.notificationOccurred('success');
      expect(mockTg.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('success');

      result.current.hapticFeedback.selectionChanged();
      expect(mockTg.HapticFeedback.selectionChanged).toHaveBeenCalled();
    });

    it('handles navigation via openTelegramLink and openLink', () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      const { result } = renderHook(() => useTelegramWebApp());

      result.current.openTelegramLink('https://t.me/ApexOSBot');
      expect(mockTg.openTelegramLink).toHaveBeenCalledWith('https://t.me/ApexOSBot');

      result.current.openLink('https://apex-os.com', { try_instant_view: true });
      expect(mockTg.openLink).toHaveBeenCalledWith('https://apex-os.com', {
        try_instant_view: true,
      });
    });

    it('controls MainButton and BackButton through helper controllers', () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      const { result } = renderHook(() => useTelegramWebApp());

      act(() => {
        result.current.mainButton.setText('PAY NOW');
        result.current.mainButton.show();
      });
      expect(mockTg.MainButton.setText).toHaveBeenCalledWith('PAY NOW');
      expect(mockTg.MainButton.show).toHaveBeenCalled();

      act(() => {
        result.current.backButton.show();
      });
      expect(mockTg.BackButton.show).toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // 2. TelegramLeaderboard Component Tests
  // ==========================================================================
  describe('TelegramLeaderboard Component', () => {
    const mockLeaderboardData: LeaderboardResponse = {
      success: true,
      period: 'all_time',
      data: [
        {
          rank: 1,
          telegram_id: 101,
          username: 'gold_master',
          first_name: 'Goldie',
          display_name: '@gold_master',
          referral_code: 'APEX_GOLD',
          verified_referees: 85,
          total_volume_usd: 85000,
          total_earnings_usd: 425,
          badge: 'gold',
        },
        {
          rank: 2,
          telegram_id: 102,
          username: 'silver_fox',
          first_name: 'Silvia',
          display_name: '@silver_fox',
          referral_code: 'APEX_SILVER',
          verified_referees: 48,
          total_volume_usd: 48000,
          total_earnings_usd: 240,
          badge: 'silver',
        },
        {
          rank: 3,
          telegram_id: 103,
          username: 'bronze_bull',
          first_name: 'Bron',
          display_name: '@bronze_bull',
          referral_code: 'APEX_BRONZE',
          verified_referees: 28,
          total_volume_usd: 28000,
          total_earnings_usd: 140,
          badge: 'bronze',
        },
        {
          rank: 4,
          telegram_id: 104,
          username: 'diamond_dave',
          first_name: 'Dave',
          display_name: '@diamond_dave',
          referral_code: 'APEX_DAVE',
          verified_referees: 18,
          total_volume_usd: 18000,
          total_earnings_usd: 90,
          badge: 'top_10',
        },
      ],
      user_rank: {
        rank: 14,
        verified_referees: 6,
        total_volume_usd: 6000,
        total_earnings_usd: 30,
      },
      total_participants: 120,
      updated_at: new Date().toISOString(),
    };

    it('renders loading state initially and then displays podium and list', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLeaderboardData,
      });

      render(<TelegramLeaderboard currentTelegramId={123456} />);

      expect(screen.getByTestId('leaderboard-loading')).toBeInTheDocument();

      await waitFor(() => {
        expect(screen.getByTestId('podium-section')).toBeInTheDocument();
      });

      // 1st place podium gold
      expect(screen.getByTestId('podium-rank-1')).toHaveTextContent('@gold_master');
      expect(screen.getByTestId('podium-rank-1')).toHaveTextContent('85 refs');

      // 2nd place podium silver
      expect(screen.getByTestId('podium-rank-2')).toHaveTextContent('@silver_fox');

      // 3rd place podium bronze
      expect(screen.getByTestId('podium-rank-3')).toHaveTextContent('@bronze_bull');

      // Ranks 4-100 list
      expect(screen.getByTestId('rank-row-4')).toHaveTextContent('@diamond_dave');
      expect(screen.getByTestId('rank-row-4')).toHaveTextContent('DIAMOND');

      // Sticky user rank bar
      const userBar = screen.getByTestId('sticky-user-rank-bar');
      expect(userBar).toHaveTextContent('Rank #14');
      expect(userBar).toHaveTextContent('6 referrals');
    });

    it('switches period tabs with subtle haptic tap and refetches data', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => mockLeaderboardData,
      });

      render(<TelegramLeaderboard />);

      await waitFor(() => {
        expect(screen.getByTestId('podium-section')).toBeInTheDocument();
      });

      // Click "This Month" tab
      const monthTab = screen.getByTestId('tab-monthly');
      fireEvent.click(monthTab);

      expect(mockTg.HapticFeedback.selectionChanged).toHaveBeenCalled();
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('period=monthly')
      );
    });

    it('handles error state and provides retry action', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      render(<TelegramLeaderboard />);

      await waitFor(() => {
        expect(screen.getByTestId('leaderboard-error')).toBeInTheDocument();
      });

      // Retry
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => mockLeaderboardData,
      });

      const retryBtn = screen.getByText('Retry');
      fireEvent.click(retryBtn);

      await waitFor(() => {
        expect(screen.getByTestId('podium-section')).toBeInTheDocument();
      });
    });

    it('computes tier and next tier requirements accurately', () => {
      expect(computeTier(0, 0)).toBe('BRONZE');
      expect(computeTier(3, 100)).toBe('SILVER');
      expect(computeTier(10, 500)).toBe('GOLD');
      expect(computeTier(25, 2000)).toBe('PLATINUM');
      expect(computeTier(50, 5000)).toBe('DIAMOND');

      expect(getNextTierTarget(1)).toEqual({ nextTier: 'SILVER', needed: 2 });
      expect(getNextTierTarget(5)).toEqual({ nextTier: 'GOLD', needed: 5 });
      expect(getNextTierTarget(15)).toEqual({ nextTier: 'PLATINUM', needed: 10 });
      expect(getNextTierTarget(30)).toEqual({ nextTier: 'DIAMOND', needed: 20 });
      expect(getNextTierTarget(60)).toEqual({ nextTier: 'MAX', needed: 0 });
    });
  });

  // ==========================================================================
  // 3. TelegramAppClient Component Tests
  // ==========================================================================
  describe('TelegramAppClient Component', () => {
    it('authenticates with initData on mount and renders header greeting', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockImplementation(async (url: string) => {
        if (url.includes('/api/auth/telegram')) {
          return {
            ok: true,
            json: async () => ({
              success: true,
              user: {
                id: 'usr_alice123',
                email: 'tg_123456@telegram.apexos.io',
                telegram_id: 123456,
                username: 'alice_crypto',
                first_name: 'Alice',
                referral_code: 'APEX_ALICE',
                wallet_address: '0x1234567890123456789012345678901234567890',
                preferred_chain: 'ethereum',
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ data: [] }),
        };
      });

      render(<TelegramAppClient locale="en" />);

      await waitFor(() => {
        expect(screen.getByText('Hey, Alice! 👋')).toBeInTheDocument();
      });

      // Wallet badge in header
      expect(screen.getByTestId('header-wallet-btn')).toHaveTextContent('0x1234...7890');
    });

    it('navigates between all 4 tabs with haptic feedback', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          deals: [],
          data: [],
        }),
      });

      render(<TelegramAppClient locale="en" />);
      await waitFor(() => {
        expect(screen.getByText(/hey,/i)).toBeInTheDocument();
      });

      // Default: Deals tab
      expect(screen.getByTestId('tab-content-deals')).toBeInTheDocument();

      // Switch to Referral Tab
      fireEvent.click(screen.getByTestId('nav-tab-referral'));
      expect(mockTg.HapticFeedback.selectionChanged).toHaveBeenCalled();
      expect(screen.getByTestId('tab-content-referral')).toBeInTheDocument();

      // Switch to Leaderboard Tab
      fireEvent.click(screen.getByTestId('nav-tab-leaderboard'));
      await waitFor(() => {
        expect(screen.getByTestId('tab-content-leaderboard')).toBeInTheDocument();
        expect(screen.queryByTestId('leaderboard-loading')).not.toBeInTheDocument();
      });

      // Switch to Earnings Tab
      fireEvent.click(screen.getByTestId('nav-tab-earnings'));
      await waitFor(() => {
        expect(screen.getByTestId('tab-content-earnings')).toBeInTheDocument();
      });
    });

    it('copies personal referral link with success haptic notification', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          user: {
            id: 'usr_alice123',
            referral_code: 'APEX_ALICE',
            first_name: 'Alice',
          },
        }),
      });

      render(<TelegramAppClient locale="en" />);

      // Switch to referral tab
      fireEvent.click(screen.getByTestId('nav-tab-referral'));

      await waitFor(() => {
        expect(screen.getByTestId('referral-link-display')).toHaveTextContent('APEX_ALICE');
      });

      // Click copy button
      const copyBtn = screen.getByTestId('copy-referral-btn');
      await act(async () => {
        fireEvent.click(copyBtn);
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        expect.stringContaining('start=ref_APEX_ALICE')
      );
      expect(mockTg.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('success');
      expect(screen.getByText('Copied')).toBeInTheDocument();
    });

    it('triggers share with Telegram friends opening deep share link', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({
          success: true,
          user: {
            id: 'usr_alice123',
            referral_code: 'APEX_ALICE',
            first_name: 'Alice',
          },
        }),
      });

      render(<TelegramAppClient locale="en" />);
      await waitFor(() => {
        expect(screen.getByText(/hey,/i)).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId('nav-tab-referral'));

      const shareBtn = screen.getByTestId('share-telegram-btn');
      fireEvent.click(shareBtn);

      expect(mockTg.HapticFeedback.impactOccurred).toHaveBeenCalledWith('medium');
      expect(mockTg.openTelegramLink).toHaveBeenCalledWith(
        expect.stringContaining('https://t.me/share/url?url=')
      );
    });

    it('allows binding wallet address and updates profile', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockImplementation(async (url: string, opts: any) => {
        if (opts?.method === 'POST') {
          return {
            ok: true,
            json: async () => ({
              success: true,
              user: {
                id: 'usr_alice123',
                first_name: 'Alice',
                wallet_address: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
                preferred_chain: 'ethereum',
              },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({ success: true }),
        };
      });

      render(<TelegramAppClient locale="en" />);
      await waitFor(() => {
        expect(screen.getByText(/hey,/i)).toBeInTheDocument();
      });

      // Switch to earnings tab
      fireEvent.click(screen.getByTestId('nav-tab-earnings'));

      const input = screen.getByTestId('wallet-address-input');
      fireEvent.change(input, {
        target: { value: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd' },
      });

      const saveBtn = screen.getByTestId('save-wallet-btn');
      await act(async () => {
        fireEvent.click(saveBtn);
      });

      await waitFor(() => {
        expect(screen.getByTestId('wallet-status-message')).toHaveTextContent(
          'Wallet successfully bound!'
        );
      });
      expect(mockTg.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('success');
    });

    it('claims deal and copies deal referral link with haptic confirmation', async () => {
      const mockTg = createMockTelegramWebApp();
      window.Telegram = { WebApp: mockTg };

      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ success: true }),
      });

      render(<TelegramAppClient locale="en" />);
      await waitFor(() => {
        expect(screen.getByText(/hey,/i)).toBeInTheDocument();
      });

      // Find claim deal button on first deal
      const claimBtn = screen.getByTestId('claim-deal-deal-bybit-vip');
      await act(async () => {
        fireEvent.click(claimBtn);
      });

      expect(mockWriteText).toHaveBeenCalledWith(
        expect.stringContaining('https://bybit.com/register')
      );
      expect(mockTg.HapticFeedback.notificationOccurred).toHaveBeenCalledWith('success');
      expect(screen.getByText('Copied!')).toBeInTheDocument();
    });
  });

  // ==========================================================================
  // 4. Layout & Viewport Export Tests
  // ==========================================================================
  describe('Telegram Layout & Viewport Configuration', () => {
    it('exports proper mobile touch viewport parameters', () => {
      expect(viewport.width).toBe('device-width');
      expect(viewport.initialScale).toBe(1);
      expect(viewport.maximumScale).toBe(1);
      expect(viewport.userScalable).toBe(false);
      expect(viewport.viewportFit).toBe('cover');
    });

    it('exports metadata for Telegram Mini App', () => {
      expect(metadata.title).toBe('ApexOS Telegram Mini App');
      expect(metadata.robots).toEqual({ index: false, follow: false });
    });

    it('renders layout wrapper with Telegram WebApp SDK script', () => {
      const { container } = render(
        <TelegramLayout>
          <div data-testid="tma-child">Test Content</div>
        </TelegramLayout>
      );

      expect(screen.getByTestId('tma-child')).toBeInTheDocument();
      expect(container.querySelector('.tma-container')).toBeInTheDocument();
    });
  });
});
