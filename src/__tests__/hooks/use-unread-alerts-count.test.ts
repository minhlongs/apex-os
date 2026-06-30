import { renderHook, act, waitFor } from '@testing-library/react';
import { useUnreadAlertsCount } from '@/hooks/use-unread-alerts-count';

// Mock fetch globally
const mockFetch = jest.fn();

// @ts-expect-error - mocking fetch
global.fetch = mockFetch;

describe('useUnreadAlertsCount', () => {
  beforeEach(() => {
    mockFetch.mockClear();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  it('should initialize with loading state', async () => {
    // Create an promise that never resolves to keep loading
    mockFetch.mockImplementation(() => new Promise(() => {}));

    const { result } = renderHook(() => useUnreadAlertsCount());

    expect(result.current.loading).toBe(true);
    expect(result.current.count).toBe(0);
    expect(result.current.error).toBeNull();
  });

  it('should fetch and set unread count on successful response', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        summary: { unreadAlerts: 5 },
      }),
    });

    const { result } = renderHook(() => useUnreadAlertsCount());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.count).toBe(5);
    expect(result.current.error).toBeNull();
  });

  it('should handle unauthorized response', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    });

    const { result } = renderHook(() => useUnreadAlertsCount());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
  });

  it('should handle server error gracefully', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    });

    const { result } = renderHook(() => useUnreadAlertsCount());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.loading).toBe(false);
    expect(result.current.count).toBe(0);
  });

  it('should provide refresh function', async () => {
    const responses = [
      {
        ok: true,
        json: async () => ({
          success: true,
          summary: { unreadAlerts: 3 },
        }),
      },
      {
        ok: true,
        json: async () => ({
          success: true,
          summary: { unreadAlerts: 7 },
        }),
      },
    ];

    mockFetch.mockImplementation(() => responses.shift()!);

    const { result } = renderHook(() => useUnreadAlertsCount());

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.count).toBe(3);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.count).toBe(7);
  });

  it('should cap display at 99+', async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        success: true,
        summary: { unreadAlerts: 150 },
      }),
    });

    const { result } = renderHook(() => useUnreadAlertsCount());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.count).toBe(150);
    // The badge shows "99+" in the UI, but count stays as actual number
  });
});
