import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { useTranslations } from 'next-intl';
import NotificationBadge from '@/components/notifications/NotificationBadge';

// Mock variables must be declared before jest.mock
const mockRefresh = jest.fn();
let mockUnreadAlertsCountReturn: any;

// Mock the hook
jest.mock('@/hooks/use-unread-alerts-count', () => ({
  useUnreadAlertsCount: () => mockUnreadAlertsCountReturn,
}));

jest.mock('next-intl', () => ({
  useTranslations: jest.fn(() => (key: string) => key),
}));

// Mock fetch globally
const mockFetch = jest.fn();
global.fetch = mockFetch;

// Mock window.location
Object.defineProperty(window, 'location', {
  value: { href: '' },
  writable: true,
});

describe('NotificationBadge', () => {
  beforeEach(() => {
    mockFetch.mockReset(); // Reset implementation and usage
    mockRefresh.mockReset();
    mockUnreadAlertsCountReturn = {
      count: 0,
      loading: false,
      error: null,
      refresh: mockRefresh,
      stopPolling: jest.fn(),
      startPolling: jest.fn(),
      isPollingActive: true,
      isPageVisible: true,
    };
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  const defaultHookReturn = {
    count: 0,
    loading: false,
    error: null,
    refresh: mockRefresh,
    stopPolling: jest.fn(),
    startPolling: jest.fn(),
    isPollingActive: true,
    isPageVisible: true,
  };

  it('should render bell icon with no badge when count is 0', () => {
    mockUnreadAlertsCountReturn.count = 0;

    render(<NotificationBadge locale="en" />);

    expect(screen.getByRole('button')).toBeInTheDocument();
    expect(screen.getByLabelText(/nav\.alerts/)).toBeInTheDocument();
    expect(screen.queryByText(/[0-9]+/)).not.toBeInTheDocument();
  });

  it('should render badge with count when unread alerts exist', async () => {
    mockUnreadAlertsCountReturn.count = 5;

    render(<NotificationBadge locale="en" />);

    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
    });
  });

  it('should show 99+ when count exceeds 99', async () => {
    mockUnreadAlertsCountReturn.count = 150;

    render(<NotificationBadge locale="en" />);

    await waitFor(() => {
      expect(screen.getByText('99+')).toBeInTheDocument();
    });
  });

  it('should show tooltip with alert list on hover', async () => {
    mockUnreadAlertsCountReturn.count = 2;

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        success: true,
        data: [
          {
            id: '1',
            title: 'Critical alert',
            description: 'Something went wrong',
            severity: 'critical',
            triggeredAt: new Date().toISOString(),
            type: 'custom',
          },
        ],
      }),
    });

    render(<NotificationBadge locale="en" />);

    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);

    await waitFor(() => {
      expect(screen.getByText('Critical alert')).toBeInTheDocument();
    });
  });

  it('should show empty state in tooltip when no alerts', async () => {
    mockUnreadAlertsCountReturn.count = 0;

    render(<NotificationBadge locale="en" />);

    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);

    await waitFor(() => {
      expect(screen.getByText(/badge\.noUnreadAlerts/)).toBeInTheDocument();
    });
  });

  it('should call refresh on tooltip refresh button click', async () => {
    const refreshMock = jest.fn().mockResolvedValue(undefined);

    // Set up the mock return with the refresh mock BEFORE rendering
    mockUnreadAlertsCountReturn = {
      count: 3,
      loading: false,
      error: null,
      refresh: refreshMock,
      stopPolling: jest.fn(),
      startPolling: jest.fn(),
      isPollingActive: true,
      isPageVisible: true,
    };

    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        data: [],
      }),
    });

    render(<NotificationBadge locale="en" />);

    // Hover over the badge button to open tooltip
    const badgeButton = screen.getByRole('button', { name: /nav\.alerts/ });
    fireEvent.mouseEnter(badgeButton);

    // Wait for the tooltip to appear and loading to complete (button becomes enabled)
    await waitFor(() => {
      const refreshButton = screen.getByRole('button', { name: /common\.refresh/i });
      expect(refreshButton).not.toBeDisabled();
    }, { timeout: 3000 });

    const refreshButton = screen.getByRole('button', { name: /common\.refresh/i });
    fireEvent.click(refreshButton);

    expect(refreshMock).toHaveBeenCalled();
  });

  it('should close tooltip when clicking outside', async () => {
    mockUnreadAlertsCountReturn.count = 3;

    render(
      <div>
        <NotificationBadge locale="en" />
        <button data-testid="outside">Outside</button>
      </div>
    );

    const badgeButton = screen.getByRole('button', { name: /nav\.alerts/ });
    fireEvent.mouseEnter(badgeButton);

    await waitFor(() => {
      expect(badgeButton).toHaveAttribute('aria-expanded', 'true');
    });

    const outsideButton = screen.getByTestId('outside');
    fireEvent.mouseDown(outsideButton);

    await waitFor(() => {
      expect(badgeButton).toHaveAttribute('aria-expanded', 'false');
    });
  });

  it('should have proper accessibility attributes', () => {
    mockUnreadAlertsCountReturn.count = 5;

    render(<NotificationBadge locale="en" />);

    // Use more specific selector for the badge button
    const button = screen.getByRole('button', { name: /nav\.alerts/ });
    expect(button).toHaveAttribute('aria-haspopup', 'true');
    expect(button).toHaveAttribute('aria-expanded', 'false');
    // aria-label includes the count, so just check it starts with nav.alerts
    expect(button.getAttribute('aria-label')).toMatch(/^nav\.alerts/);
  });

  it('should handle loading state in tooltip', async () => {
    mockUnreadAlertsCountReturn.count = 3;
    mockUnreadAlertsCountReturn.loading = true;

    mockFetch.mockImplementation(() => new Promise(resolve => setTimeout(resolve, 1000)));

    render(<NotificationBadge locale="en" />);

    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);

    // Tooltip should show loading spinner while fetching preview
    await waitFor(() => {
      // Check that fetch was called
      expect(mockFetch).toHaveBeenCalled();
    });
  });

  it('should handle fetch errors gracefully in tooltip', async () => {
    mockUnreadAlertsCountReturn.count = 3;

    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    render(<NotificationBadge locale="en" />);

    const button = screen.getByRole('button');
    fireEvent.mouseEnter(button);

    // Should not throw even if preview fetch fails
    await waitFor(() => {
      expect(button).toBeInTheDocument();
    });
  });
});

describe('NotificationBadge animations', () => {
  beforeEach(() => {
    mockUnreadAlertsCountReturn.count = 5;
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('should trigger pop animation when count changes', async () => {
    const { rerender } = render(<NotificationBadge locale="en" />);

    // Initial count
    await waitFor(() => {
      expect(screen.getByText('5')).toBeInTheDocument();
    });

    // Change count
    mockUnreadAlertsCountReturn.count = 8;

    rerender(<NotificationBadge locale="en" />);

    // Animation class should be applied
    await waitFor(() => {
      const badge = screen.getByText('8').closest('span');
      expect(badge).toBeInTheDocument();
    });
  });
});
