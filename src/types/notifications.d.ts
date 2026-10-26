/**
 * Global TypeScript Declarations
 * Extends built-in types with project-specific declarations
 */

// ============================================================================
// Environment Variables
// ============================================================================

declare namespace NodeJS {
  interface ProcessEnv {
    // Auth
    BETTER_AUTH_SECRET?: string;
    BETTER_AUTH_ENCRYPTION_KEY?: string;

    // Application
    NEXT_PUBLIC_APP_URL?: string;
    NEXT_PUBLIC_SITE_URL?: string;
    NEXT_PUBLIC_BASE_URL?: string;
    DEFAULT_LOCALE?: 'vi' | 'en';

    // Sentry
    NEXT_PUBLIC_SENTRY_DSN?: string;
    SENTRY_ORG?: string;
    SENTRY_PROJECT?: string;
    SENTRY_ENVIRONMENT?: string;
    NEXT_PUBLIC_SENTRY_ENABLED?: string;

    // Cloudflare
    CLOUDFLARE_API_TOKEN?: string;
    CLOUDFLARE_ACCOUNT_ID?: string;
    D1_DATABASE?: string;

    // Email (Resend)
    RESEND_API_KEY?: string;
    RESEND_FROM_EMAIL?: string;
    RESEND_FROM_NAME?: string;
    RESEND_REPLY_TO?: string;
    NEXT_PUBLIC_SENDER_EMAIL?: string;
    NEXT_PUBLIC_SUPPORT_EMAIL?: string;

    // Notifications
    NOTIFICATIONS_ENABLED?: string;
    NOTIFICATION_DEFAULT_PRIORITY?: 'low' | 'normal' | 'high' | 'critical';
    NOTIFICATION_RATE_LIMIT?: string;
    NOTIFICATION_MAX_RETRIES?: string;
    NOTIFICATION_RETRY_BACKOFF?: string;
    NOTIFICATION_EMAIL_RECIPIENTS?: string;
    SUPPORT_EMAIL?: string;
    DOCS_URL?: string;

    // Slack
    SLACK_WEBHOOK_URL?: string;
    SLACK_ENABLED?: string;
    SLACK_CHANNEL?: string;
    SLACK_USERNAME?: string;
    SLACK_ICON_EMOJI?: string;
    SLACK_ICON_URL?: string;

    // Telegram
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_IDS?: string;
    TELEGRAM_ENABLED?: string;
    TELEGRAM_PARSE_MODE?: 'HTML' | 'Markdown';
    TELEGRAM_DISABLE_WEB_PAGE_PREVIEW?: string;

    // Stellar
    STELLAR_SECRET_KEY?: string;
    STELLAR_NETWORK?: 'testnet' | 'mainnet';
    STELLAR_USDC_ISSUER?: string;
    STELLAR_USDC_CODE?: string;

    // Webhooks
    BINANCE_WEBHOOK_SECRET?: string;
    BYBIT_WEBHOOK_SECRET?: string;

    // Payments
    POLAR_ACCESS_TOKEN?: string;
    POLAR_WEBHOOK_SECRET?: string;
    POLAR_ORGANIZATION_ID?: string;
    SEPAY_MERCHANT_ID?: string;
    SEPAY_SECRET_KEY?: string;
    SEPAY_API_URL?: string;

    // Admin
    ADMIN_API_TOKEN?: string;

    // AI Services
    ANTHROPIC_API_KEY?: string;
    OPENAI_API_KEY?: string;
  }
}

// ============================================================================
// Global Window Augmentation (for SSR compatibility)
// ============================================================================

interface Window {
  // Add any global window properties here
  [key: string]: unknown;
}

// ============================================================================
// Next.js Image Augmentation
// ============================================================================

declare module 'next/image' {
  import * as Image from 'next/image';

  // Re-export everything
  export default Image;
  export { Image };
}

// ============================================================================
// Global Document for Email Templates
// ============================================================================

/**
 * Minimal document interface for email template rendering
 * Used in email channel for escapeHtml utility
 */
declare const document: {
  createElement(tagName: string): {
    textContent: string;
    innerHTML: string;
  };
};

// ============================================================================
// Database Types
// ============================================================================

declare module '@sqlite.org/sqlite-wasm' {
  // D1 database types
  export interface Database {
    prepare(sql: string): Statement;
  }

  export interface Statement {
    bind(...params: unknown[]): Statement;
    all<T = unknown>(): { results: T[] };
    run(): { changes: number };
    get<T = unknown>(): T | undefined;
  }
}

// ============================================================================
// Cloudflare Workers Types
// ============================================================================

// KV Namespace type (Cloudflare Workers)
interface KVNamespace {
  get(key: string, type?: 'text' | 'json'): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string, limit?: number): Promise<{ keys: Array<{ name: string }> }>;
}

declare global {
  // D1 binding available in Cloudflare Workers environment
  const DB: {
    prepare(sql: string): {
      bind(...params: unknown[]): {
        all<T = unknown>(): { results: T[] };
        run(): { changes: number };
        get<T = unknown>(): T | undefined;
      };
    };
  } | undefined;

  // KV binding - using the namespace directly
  const KV: KVNamespace | undefined;

  // R2 binding
  const R2_BUCKET: {
    get(key: string): { body: ReadableStream<Uint8Array> } | null;
    put(key: string, body: ReadableStream<Uint8Array> | Blob | string): Promise<void>;
    delete(key: string): Promise<void>;
    list(prefix?: string): { objects: Array<{ key: string }> };
  } | undefined;
}

// ============================================================================
// Fetch Event (for Service Worker / Worker contexts)
// ============================================================================

interface FetchEvent extends Event {
  readonly request: Request;
  respondWith(response: Response | Promise<Response>): void;
  waitUntil(promise: Promise<unknown>): void;
}

// ============================================================================
// Custom Element Registrations
// ============================================================================

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface HTMLElementTagNameMap {
    // Add custom elements if needed
  }
}
