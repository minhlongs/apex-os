/**
 * Server-Side Analytics Service
 * Gửi events đến Mixpanel và Amplitude từ server (Cloudflare Workers)
 *
 * Không dùng browser SDK — chỉ dùng HTTP API.
 * Thread-safe, không cần window/document.
 */

interface AnalyticsEvent {
  event: string;
  properties: Record<string, unknown>;
  timestamp?: string;
}

interface MixpanelPayload {
  token: string;
  distinct_id: string;
  event: string;
  properties: Record<string, unknown>;
  time?: number;
  ip?: string;
}

interface AmplitudePayload {
  api_key: string;
  events: Array<{
    user_id: string;
    event_type: string;
    event_properties?: Record<string, unknown>;
    timestamp?: number;
    ip?: string;
  }>;
}

export class AnalyticsHTTPService {
  private mixpanelToken: string | null = null;
  private amplitudeKey: string | null = null;
  private enabled = true;

  constructor() {
    this.mixpanelToken = process.env.NEXT_PUBLIC_MIXPANEL_TOKEN || process.env.MIXPANEL_TOKEN || null;
    this.amplitudeKey = process.env.NEXT_PUBLIC_AMPLITUDE_API_KEY || process.env.AMPLITUDE_API_KEY || null;
    this.enabled = process.env.NEXT_PUBLIC_ANALYTICS_ENABLED !== 'false';

    if (!this.mixpanelToken && !this.amplitudeKey) {
      console.warn('[AnalyticsHTTP] No analytics tokens configured');
      this.enabled = false;
    }
  }

  private enrichProperties(
    properties: Record<string, unknown>,
    userId: string,
    ip?: string
  ): Record<string, unknown> {
    return {
      ...properties,
      $insert_id: crypto.randomUUID(),
      time: Math.floor(Date.now() / 1000),
      token: this.mixpanelToken,
      distinct_id: userId,
      ip,
      env: process.env.NODE_ENV || 'production',
    };
  }

  async track(
    eventName: string,
    userId: string,
    properties: Record<string, unknown> = {},
    ip?: string
  ): Promise<void> {
    if (!this.enabled || (!this.mixpanelToken && !this.amplitudeKey)) {
      return;
    }

    const enriched = this.enrichProperties(properties, userId, ip);

    // Send to Mixpanel (HTTP API)
    if (this.mixpanelToken) {
      try {
        const payload: MixpanelPayload = {
          token: this.mixpanelToken,
          distinct_id: userId,
          event: eventName,
          properties: enriched,
          time: Math.floor(Date.now() / 1000),
          ip,
        };

        // Use Cloudflare Workers fetch with keepalive
        await fetch('https://api.mixpanel.com/track', {
          method: 'POST',
          body: Buffer.from(JSON.stringify([payload])).toString('base64'),
          headers: {
            'Content-Type': 'application/json',
          },
          // Cloudflare-specific: keepalive for background tracking
          keepalive: true,
        }).catch((err) => {
          console.error('[AnalyticsHTTP] Mixpanel track failed:', err);
        });
      } catch (error) {
        console.error('[AnalyticsHTTP] Mixpanel error:', error);
      }
    }

    // Send to Amplitude (HTTP API)
    if (this.amplitudeKey) {
      try {
        const amplitudePayload: AmplitudePayload = {
          api_key: this.amplitudeKey,
          events: [
            {
              user_id: userId,
              event_type: eventName,
              event_properties: enriched,
              timestamp: Math.floor(Date.now() / 1000),
              ip,
            },
          ],
        };

        await fetch('https://api2.amplitude.com/2/httpapi', {
          method: 'POST',
          body: JSON.stringify(amplitudePayload),
          headers: {
            'Content-Type': 'application/json',
          },
          keepalive: true,
        }).catch((err) => {
          console.error('[AnalyticsHTTP] Amplitude track failed:', err);
        });
      } catch (error) {
        console.error('[AnalyticsHTTP] Amplitude error:', error);
      }
    }

    if (process.env.NODE_ENV === 'development') {
      console.log(`[AnalyticsHTTP] Tracked: ${eventName}`, enriched);
    }
  }

  async identify(
    userId: string,
    traits: Record<string, unknown> = {},
    ip?: string
  ): Promise<void> {
    if (!this.enabled) return;

    const enriched = this.enrichProperties(traits, userId, ip);

    // Mixpanel people.set
    if (this.mixpanelToken) {
      try {
        const payload = {
          $token: this.mixpanelToken,
          $distinct_id: userId,
          ...enriched,
        };
        await fetch('https://api.mixpanel.com/engage', {
          method: 'POST',
          body: Buffer.from(JSON.stringify({ $distinct_id: userId, ...enriched })).toString('base64'),
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
        }).catch(console.error);
      } catch (error) {
        console.error('[AnalyticsHTTP] Mixpanel identify failed:', error);
      }
    }

    // Amplitude setUserProperties
    if (this.amplitudeKey) {
      try {
        await fetch('https://api.amplitude.com/2/httpapi', {
          method: 'POST',
          body: JSON.stringify({
            api_key: this.amplitudeKey,
            user_id: userId,
            user_properties: enriched,
          }),
          headers: { 'Content-Type': 'application/json' },
          keepalive: true,
        }).catch(console.error);
      } catch (error) {
        console.error('[AnalyticsHTTP] Amplitude identify failed:', error);
      }
    }
  }
}

// Singleton instance
const analyticsHTTP = new AnalyticsHTTPService();

export const track = (
  event: string,
  userId: string,
  properties: Record<string, unknown> = {},
  ip?: string
) => analyticsHTTP.track(event, userId, properties, ip);

export const identify = (
  userId: string,
  traits: Record<string, unknown> = {},
  ip?: string
) => analyticsHTTP.identify(userId, traits, ip);

export { analyticsHTTP, type AnalyticsEvent };
