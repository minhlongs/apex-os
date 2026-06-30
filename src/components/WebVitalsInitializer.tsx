'use client';

import { useEffect } from 'react';
import { initWebVitals, isWebVitalsSupported } from '@/lib/performance/web-vitals';

/**
 * WebVitalsInitializer
 *
 * Client component that initializes Web Vitals tracking on mount.
 * Place this in your root layout to enable performance monitoring.
 */
export default function WebVitalsInitializer() {
  useEffect(() => {
    // Check if Web Vitals is supported (should be in modern browsers)
    if (!isWebVitalsSupported()) {
      console.warn('[WebVitals] Not supported in this environment');
      return;
    }

    // Initialize tracking
    initWebVitals();
  }, []);

  // This component doesn't render anything
  return null;
}
