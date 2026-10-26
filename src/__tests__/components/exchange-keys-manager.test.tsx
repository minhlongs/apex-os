/**
 * @jest-environment jsdom
 */

import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ExchangeKeysManager from '@/components/profile/ExchangeKeysManager';

describe('ExchangeKeysManager (Web 5-State Feedback & Zero-Secret Contract)', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('renders loading skeleton initially and transitions to unlinked state when empty', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { external_ids: {} },
      }),
    });

    render(<ExchangeKeysManager locale="vi" />);

    // Loading state
    expect(screen.getByText('Quản lý Khóa API Sàn')).toBeDefined();

    // After fetch resolves -> Zero-Secret Notice & input form
    await waitFor(() => {
      expect(screen.getByText(/An toàn tuyệt đối – Không lưu Secret Key/i)).toBeDefined();
    });
  });

  it('displays linked exchange keys and handles unlinking directly from DELETE response', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            external_ids: {
              okx: {
                api_key_id: 'okx_live_key_8899',
                label: 'Main Bot',
                linked_at: '2026-10-26T10:00:00.000Z',
              },
            },
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          unlinked: 'okx',
          data: { external_ids: {} },
        }),
      });

    render(<ExchangeKeysManager locale="en" />);

    await waitFor(() => {
      expect(screen.getByText('okx_live_key_8899')).toBeDefined();
    });
    expect(screen.getByText(/Main Bot/)).toBeDefined();

    const unlinkBtn = screen.getByRole('button', { name: /Unlink/i });
    fireEvent.click(unlinkBtn);

    await waitFor(() => {
      expect(screen.getByText(/Exchange key unlinked/i)).toBeDefined();
    });
    expect(screen.queryByText('okx_live_key_8899')).toBeNull();
  });

  it('blocks invalid api_key_id format client-side with 400 error feedback before network call', async () => {
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        data: { external_ids: {} },
      }),
    });

    render(<ExchangeKeysManager locale="vi" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/API Key ID/i)).toBeDefined();
    });

    const input = screen.getByLabelText(/API Key ID/i);
    fireEvent.change(input, { target: { value: 'abc' } });

    const submitBtn = screen.getByRole('button', { name: /Liên kết khóa sàn/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toBeDefined();
    });
    expect(screen.getByText(/Lỗi 400 – Định dạng không hợp lệ/i)).toBeDefined();
    // Only the initial GET was called, no POST network call wasted
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('handles 409 Conflict when an api_key_id is already linked to another account', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { external_ids: {} },
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 409,
        json: async () => ({
          success: false,
          error: 'This exchange API key identifier is already linked to another account',
        }),
      });

    render(<ExchangeKeysManager locale="vi" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/API Key ID/i)).toBeDefined();
    });

    const input = screen.getByLabelText(/API Key ID/i);
    fireEvent.change(input, { target: { value: 'conflict_key_12345' } });

    const submitBtn = screen.getByRole('button', { name: /Liên kết khóa sàn/i });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(screen.getByText(/Lỗi 409 – Trùng lặp khóa/i)).toBeDefined();
    });
    expect(screen.getByText(/API Key ID này đã được liên kết với một tài khoản khác/i)).toBeDefined();
  });

  it('links a valid key and updates state directly from POST response without extra GET', async () => {
    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { external_ids: {} },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            exchange: 'kucoin',
            api_key_id: 'kc_valid_key_2026',
            linked_at: '2026-10-26T12:00:00.000Z',
            external_ids: {
              kucoin: {
                api_key_id: 'kc_valid_key_2026',
                label: 'KuCoin Sub',
                linked_at: '2026-10-26T12:00:00.000Z',
              },
            },
          },
        }),
      });

    render(<ExchangeKeysManager locale="vi" />);

    await waitFor(() => {
      expect(screen.getByLabelText(/API Key ID/i)).toBeDefined();
    });

    fireEvent.change(screen.getByLabelText(/Sàn giao dịch/i), { target: { value: 'kucoin' } });
    fireEvent.change(screen.getByLabelText(/API Key ID/i), { target: { value: 'kc_valid_key_2026' } });
    fireEvent.change(screen.getByLabelText(/Nhãn/i), { target: { value: 'KuCoin Sub' } });

    fireEvent.click(screen.getByRole('button', { name: /Liên kết khóa sàn/i }));

    await waitFor(() => {
      expect(screen.getByText('kc_valid_key_2026')).toBeDefined();
    });
    expect(screen.getByText(/Đã liên kết khóa sàn thành công/i)).toBeDefined();
    expect(global.fetch).toHaveBeenCalledTimes(2); // 1 GET + 1 POST (no redundant GET)
  });
});
