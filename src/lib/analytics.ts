/**
 * Analytics Tracking Service
 * Hỗ trợ Mixpanel và Amplitude qua environment variables
 *
 * Cấu hình env vars:
 * - NEXT_PUBLIC_MIXPANEL_TOKEN: Mixpanel project token
 * - NEXT_PUBLIC_AMPLITUDE_API_KEY: Amplitude API key
 * - NEXT_PUBLIC_ANALYTICS_ENABLED: "false" để tắt (mặc định: true)
 *
 * Events được theo dõi:
 * - signup: User đăng ký tài khoản
 * - deal_click: User click vào deal/affiliate link
 * - conversion: Trade được xác nhận (commission earned)
 * - payout: Payout được gửi (Stellar USDC)
 */

'use client';

interface AnalyticsProperties {
  userId?: string;
  email?: string;
  walletAddress?: string;
  affiliateCode?: string;
  dealId?: string;
  dealName?: string;
  exchange?: string;
  volume?: number;
  commission?: number;
  conversionId?: string;
  payoutId?: string;
  payoutAmount?: number;
  currency?: string;
  referrer?: string;
  page?: string;
  [key: string]: unknown;
}

const AnalyticsEvents = {
  SIGNUP: 'signup',
  DEAL_CLICK: 'deal_click',
  CONVERSION: 'conversion',
  PAYOUT: 'payout',
} as const;

type MixpanelInstance = any;
type AmplitudeInstance = any;

class AnalyticsService {
  private mixpanel: MixpanelInstance = null;
  private amplitude: AmplitudeInstance = null;
  private enabled = true;
  private initialized = false;

  constructor() {
    if (typeof window !== 'undefined') {
      this.initialize();
    }
  }

  private async initialize(): Promise<void> {
    if (this.initialized) return;

    // Check if analytics is disabled
    if (process.env.NEXT_PUBLIC_ANALYTICS_ENABLED === 'false') {
      this.enabled = false;
      this.initialized = true;
      return;
    }

    const mixpanelToken = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN;
    const amplitudeKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY;

    if (!mixpanelToken && !amplitudeKey) {
      console.warn('[Analytics] No tokens configured. Set NEXT_PUBLIC_MIXPANEL_TOKEN or NEXT_PUBLIC_AMPLITUDE_API_KEY');
      this.initialized = true;
      return;
    }

    try {
      // Initialize Mixpanel if token exists
      if (mixpanelToken) {
        const mixpanelModule = await import('mixpanel-browser');
        this.mixpanel = mixpanelModule.default
          ? mixpanelModule.default
          : mixpanelModule;
        this.mixpanel.init(mixpanelToken, {
          debug: process.env.NODE_ENV === 'development',
          track_pageview: false,
          persistence: 'localStorage',
        });
        console.log('[Analytics] Mixpanel initialized');
      }
    } catch (error) {
      console.error('[Analytics] Failed to initialize Mixpanel:', error);
    }

    try {
      // Initialize Amplitude if key exists
      if (amplitudeKey) {
        const amplitudeModule = await import('@amplitude/analytics-browser');
        this.amplitude = amplitudeModule.default
          ? amplitudeModule.default
          : amplitudeModule;
        if (this.amplitude.init) {
          this.amplitude.init(amplitudeKey, undefined, {
            defaultTracking: {
              pageViews: true,
              sessions: true,
              fileDownloads: false,
              formInteractions: false,
              elementInteractions: false,
            },
          });
        }
        console.log('[Analytics] Amplitude initialized');
      }
    } catch (error) {
      console.error('[Analytics] Failed to initialize Amplitude:', error);
    }

    this.initialized = true;
  }

  private async waitForInit(): Promise<boolean> {
    if (!this.initialized) {
      await this.initialize();
    }
    return this.enabled && (this.mixpanel !== null || this.amplitude !== null);
  }

  public async track(eventName: string, properties: AnalyticsProperties = {}): Promise<void> {
    if (!(await this.waitForInit())) {
      return;
    }

    const enrichedProps = this.enrichProperties(properties);

    // Track với Mixpanel
    if (this.mixpanel?.track) {
      try {
        this.mixpanel.track(eventName, enrichedProps);
        if (enrichedProps.userId && this.mixpanel?.people?.set) {
          this.mixpanel.people.set(enrichedProps.userId as string, {
            $email: enrichedProps.email,
            $wallet_address: enrichedProps.walletAddress,
            $affiliate_code: enrichedProps.affiliateCode,
          });
        }
      } catch (error) {
        console.error('[Analytics] Mixpanel track failed:', error);
      }
    }

    // Track với Amplitude
    if (this.amplitude?.track) {
      try {
        await this.amplitude.track(eventName, enrichedProps);
      } catch (error) {
        console.error('[Analytics] Amplitude track failed:', error);
      }
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[Analytics] Tracked: ${eventName}`, enrichedProps);
    }
  }

  public async identify(userId: string, traits?: Partial<AnalyticsProperties>): Promise<void> {
    if (!(await this.waitForInit())) {
      return;
    }

    const enrichedTraits = this.enrichProperties(traits);

    if (this.mixpanel?.identify) {
      try {
        this.mixpanel.identify(userId);
      } catch (error) {
        console.error('[Analytics] Mixpanel identify failed:', error);
      }
    }

    if (this.amplitude) {
      try {
        if (this.amplitude.setUserId) {
          await this.amplitude.setUserId(userId);
        }
        if (enrichedTraits && Object.keys(enrichedTraits).length > 0 && this.amplitude.setUserProperties) {
          await this.amplitude.setUserProperties(enrichedTraits);
        }
      } catch (error) {
        console.error('[Analytics] Amplitude identify failed:', error);
      }
    }
  }

  public async reset(): Promise<void> {
    if (!this.initialized) {
      return;
    }

    if (this.mixpanel?.reset) {
      try {
        this.mixpanel.reset();
      } catch (error) {
        console.error('[Analytics] Mixpanel reset failed:', error);
      }
    }

    if (this.amplitude?.removeUserId) {
      try {
        await this.amplitude.removeUserId();
      } catch (error) {
        console.error('[Analytics] Amplitude reset failed:', error);
      }
    }
  }

  public async isReady(): Promise<boolean> {
    return this.waitForInit();
  }

  private enrichProperties(properties: AnalyticsProperties = {}): Record<string, unknown> {
    const enriched: Record<string, unknown> = { ...properties };

    if (!enriched.timestamp) {
      enriched.timestamp = new Date().toISOString();
    }

    if (!enriched.env) {
      enriched.env = process.env.NODE_ENV || 'development';
    }

    return enriched;
  }

  // Helper methods for pre-defined events
  public async trackSignup(
    userId: string,
    email: string,
    walletAddress?: string,
    affiliateCode?: string
  ): Promise<void> {
    await this.track(AnalyticsEvents.SIGNUP, {
      userId,
      email,
      walletAddress,
      affiliateCode,
    });
  }

  public async trackDealClick(
    userId: string,
    dealId: string,
    dealName: string,
    exchange: string,
    referrer?: string
  ): Promise<void> {
    await this.track(AnalyticsEvents.DEAL_CLICK, {
      userId,
      dealId,
      dealName,
      exchange,
      referrer,
    });
  }

  public async trackConversion(
    userId: string,
    conversionId: string,
    dealId: string,
    exchange: string,
    volume: number,
    commission: number,
    currency = 'USDC'
  ): Promise<void> {
    await this.track(AnalyticsEvents.CONVERSION, {
      userId,
      conversionId,
      dealId,
      exchange,
      volume,
      commission,
      currency,
    });
  }

  public async trackPayout(
    userId: string,
    payoutId: string,
    amount: number,
    currency = 'USDC',
    walletAddress?: string
  ): Promise<void> {
    await this.track(AnalyticsEvents.PAYOUT, {
      userId,
      payoutId,
      payoutAmount: amount,
      currency,
      walletAddress,
    });
  }
}

// Singleton instance
const analytics = new AnalyticsService();

// Export functions
export const track = (event: string, properties?: AnalyticsProperties) => {
  analytics.track(event, properties).catch(console.error);
};

export const identify = (userId: string, traits?: Partial<AnalyticsProperties>) => {
  analytics.identify(userId, traits).catch(console.error);
};

export const resetAnalytics = () => {
  analytics.reset().catch(console.error);
};

export { analytics, AnalyticsEvents, type AnalyticsProperties };

export default analytics;
