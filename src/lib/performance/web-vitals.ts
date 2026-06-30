/**
 * Web Vitals Tracking for ApexOS
 *
 * Tracks Core Web Vitals and sends them to analytics endpoints.
 * Supports both client-side reporting and server-side aggregation.
 *
 * Metrics tracked (web-vitals v5):
 * - LCP (Largest Contentful Paint): Target < 2500ms
 * - INP (Interaction to Next Paint): Target < 200ms (replaced FID)
 * - CLS (Cumulative Layout Shift): Target < 0.1
 * - FCP (First Contentful Paint): Target < 1800ms
 * - TTFB (Time to First Byte): Target < 800ms
 *
 * Based on web-vitals library v5: https://github.com/GoogleChrome/web-vitals
 */

import { onCLS, onFCP, onINP, onLCP, onTTFB, type Metric } from 'web-vitals';

// Configuration
const CONFIG = {
  // Analytics endpoint (send to our own API for aggregation)
  analyticsEndpoint: '/api/analytics/web-vitals',
  // Sampling rate (1 = 100%, 0.1 = 10% of users)
  samplingRate: 1.0,
  // Debug mode (logs to console)
  debug: process.env.NODE_ENV === 'development',
  // Whether to send metrics to external service (e.g., Google Analytics)
  sendToGA: false,
  // GA Measurement ID (if sendToGA is true)
  gaMeasurementId: process.env.NEXT_PUBLIC_GA_MEASUREMENT_ID,
};

/**
 * Format a metric for logging/display
 */
export function formatMetric(metric: Metric): string {
  // web-vitals v5 doesn't have unit property; infer from name
  const unit = metric.name === 'CLS' ? '' : 'ms';
  return `${metric.name}: ${metric.value.toFixed(2)}${unit} (rating: ${metric.rating})`;
}

/**
 * Send a metric to our analytics API
 */
async function sendToAnalytics(metric: Metric): Promise<void> {
  try {
    const payload = {
      name: metric.name,
      value: metric.value,
      rating: metric.rating,
      delta: metric.delta,
      id: metric.id,
      navigationType: metric.navigationType,
      entries: metric.entries.map(entry => entry.toJSON()),
      timestamp: new Date().toISOString(),
      url: window.location.href,
      userAgent: navigator.userAgent,
    };

    // Use sendBeacon for reliability (works even on page unload)
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
    navigator.sendBeacon(CONFIG.analyticsEndpoint, blob);
  } catch (error) {
    if (CONFIG.debug) {
      console.error('[WebVitals] Failed to send to analytics:', error);
    }
  }
}

/**
 * Send a metric to Google Analytics (if configured)
 */
function sendToGoogleAnalytics(metric: Metric): void {
  if (!CONFIG.sendToGA || !CONFIG.gaMeasurementId) return;

  try {
    // GA4 event structure
    const event = {
      event: 'web_vital',
      event_category: 'Web Vitals',
      event_label: metric.name,
      value: Math.round(metric.value),
      non_interaction: true,
    };

    // @ts-ignore - gtag exists if GA is configured
    if (typeof window.gtag === 'function') {
      // @ts-ignore
      window.gtag('event', 'web_vital', event);
    }
  } catch (error) {
    if (CONFIG.debug) {
      console.error('[WebVitals] Failed to send to GA:', error);
    }
  }
}

/**
 * Process a metric: log, send to analytics, and optionally send to GA
 */
function handleMetric(metric: Metric): void {
  if (CONFIG.debug) {
    console.log(`[WebVitals] ${formatMetric(metric)}`);
  }

  // Send to our analytics API
  sendToAnalytics(metric);

  // Send to Google Analytics if configured
  sendToGoogleAnalytics(metric);
}

/**
 * Determine if a metric should be recorded based on sampling rate
 */
function shouldRecord(): boolean {
  return Math.random() < CONFIG.samplingRate;
}

/**
 * Initialize Web Vitals tracking
 *
 * Call this in your root layout or app component:
 * ```tsx
 * import { initWebVitals } from '@/lib/performance/web-vitals';
 *
 * export default function RootLayout({ children }) {
 *   useEffect(() => {
 *     initWebVitals();
 *   }, []);
 *   return <html>{children}</html>;
 * }
 * ```
 */
export function initWebVitals(): void {
  if (typeof window === 'undefined' || !shouldRecord()) {
    return;
  }

  // web-vitals v5 uses on* functions that accept a callback directly
  try {
    onLCP(handleMetric);
  } catch (error) {
    if (CONFIG.debug) console.error('[WebVitals] LCP error:', error);
  }

  try {
    onINP(handleMetric);
  } catch (error) {
    if (CONFIG.debug) console.error('[WebVitals] INP error:', error);
  }

  try {
    onCLS(handleMetric);
  } catch (error) {
    if (CONFIG.debug) console.error('[WebVitals] CLS error:', error);
  }

  try {
    onFCP(handleMetric);
  } catch (error) {
    if (CONFIG.debug) console.error('[WebVitals] FCP error:', error);
  }

  try {
    onTTFB(handleMetric);
  } catch (error) {
    if (CONFIG.debug) console.error('[WebVitals] TTFB error:', error);
  }
}

/**
 * Check if Web Vitals are supported in this environment
 */
export function isWebVitalsSupported(): boolean {
  return typeof window !== 'undefined' && 'sendBeacon' in navigator;
}

// Type declaration for gtag
declare global {
  interface Window {
    gtag?: (...args: any[]) => void;
  }
}
