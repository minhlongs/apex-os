import { captureException, captureMessage, addBreadcrumb, setUserContext, clearUserContext, startSpan } from '@/lib/error-tracking';
import * as Sentry from '@sentry/nextjs';

// Mock the Sentry module
jest.mock('@sentry/nextjs', () => ({
  init: jest.fn(),
  captureException: jest.fn(),
  captureMessage: jest.fn(),
  addBreadcrumb: jest.fn(),
  setUser: jest.fn(),
  startSpan: jest.fn((options, callback) => callback({})),
  getCurrentScope: jest.fn(() => ({
    getSpan: jest.fn(() => ({ spanId: 'test-span-id' })),
  })),
  withScope: jest.fn((callback) => callback({})),
  browserTracingIntegration: jest.fn(() => ({})),
  replayIntegration: jest.fn(() => ({})),
}));

describe('Error Tracking Module', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('captureException', () => {
    it('should capture errors when Sentry is enabled', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';
      const error = new Error('Test error');

      captureException(error, { userId: '123' });

      expect(Sentry.captureException).toHaveBeenCalledWith(error, {
        extra: { userId: '123' },
      });
    });

    it('should not capture when Sentry is disabled', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'false';
      const error = new Error('Test error');

      captureException(error);

      expect(Sentry.captureException).not.toHaveBeenCalled();
    });
  });

  describe('captureMessage', () => {
    it('should capture message with default info level', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';
      captureMessage('Test message');

      expect(Sentry.captureMessage).toHaveBeenCalledWith('Test message', { level: 'info' });
    });

    it('should capture message with custom level', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';
      captureMessage('Warning message', 'warning');

      expect(Sentry.captureMessage).toHaveBeenCalledWith('Warning message', { level: 'warning' });
    });
  });

  describe('addBreadcrumb', () => {
    it('should add breadcrumb with category and message', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';
      addBreadcrumb('navigation', 'User clicked button', { buttonId: 'submit' });

      expect(Sentry.addBreadcrumb).toHaveBeenCalledWith({
        category: 'navigation',
        message: 'User clicked button',
        data: { buttonId: 'submit' },
        level: 'info',
      });
    });
  });

  describe('setUserContext', () => {
    it('should set user with all fields', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';
      setUserContext({
        id: 'user-123',
        email: 'test@example.com',
        walletAddress: '0x123...',
      });

      expect(Sentry.setUser).toHaveBeenCalledWith({
        id: 'user-123',
        email: 'test@example.com',
        walletAddress: '0x123...',
      });
    });
  });

  describe('clearUserContext', () => {
    it('should clear user context', () => {
      clearUserContext();
      expect(Sentry.setUser).toHaveBeenCalledWith(null);
    });
  });

  describe('startSpan', () => {
    it('should start a span and execute callback', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'true';
      const mockSpan = { setData: jest.fn(), setHttpStatus: jest.fn() };

      Sentry.startSpan.mockImplementation((options, callback) => callback(mockSpan));

      const result = startSpan('test-operation', 'test.type', () => {
        return 'result-value';
      });

      expect(result).toBe('result-value');
    });

    it('should return callback result directly when Sentry disabled', () => {
      process.env.NEXT_PUBLIC_SENTRY_ENABLED = 'false';
      const result = startSpan('test', 'test', () => 'value');
      expect(result).toBe('value');
    });
  });
});
