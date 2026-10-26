/**
 * src/__tests__/theme/obsidian-tokens-parity.test.ts
 *
 * Automated Token Parity & WCAG 2.1 AA Contrast Ratio Test Suite.
 * Validates:
 * 1. 1:1 Color parity between Web and Mobile Obsidian Token Contracts.
 * 2. WCAG 2.1 AA contrast ratio (>= 4.5:1 for normal text) of text tokens against backgrounds.
 * 3. Validation regex and supported exchange list consistency.
 */

import {
  obsidianTokens as webObsidianTokens,
  SUPPORTED_LINKED_EXCHANGES as WEB_SUPPORTED_EXCHANGES,
  API_KEY_ID_REGEX as WEB_API_KEY_REGEX,
  isValidApiKeyId as webIsValidApiKeyId,
  isSupportedExchange as webIsSupportedExchange,
} from '@/lib/theme/obsidian-tokens';

import {
  obsidianTokens as mobileObsidianTokens,
  SUPPORTED_LINKED_EXCHANGES as MOBILE_SUPPORTED_EXCHANGES,
  API_KEY_ID_REGEX as MOBILE_API_KEY_REGEX,
  isValidApiKeyId as mobileIsValidApiKeyId,
} from '../../../apex-os-mobile/src/theme/obsidian-tokens';

function hexToRgb(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  const r = parseInt(clean.substring(0, 2), 16);
  const g = parseInt(clean.substring(2, 4), 16);
  const b = parseInt(clean.substring(4, 6), 16);
  return [r, g, b];
}

function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hex1: string, hex2: string): number {
  const lum1 = relativeLuminance(hexToRgb(hex1));
  const lum2 = relativeLuminance(hexToRgb(hex2));
  const brightest = Math.max(lum1, lum2);
  const darkest = Math.min(lum1, lum2);
  return (brightest + 0.05) / (darkest + 0.05);
}

describe('Obsidian Tokens Web & Mobile Parity', () => {
  it('has identical keys and values between Web and Mobile', () => {
    const webKeys = Object.keys(webObsidianTokens).sort();
    const mobileKeys = Object.keys(mobileObsidianTokens).sort();

    expect(webKeys).toEqual(mobileKeys);

    for (const key of webKeys as Array<keyof typeof webObsidianTokens>) {
      expect(webObsidianTokens[key]).toBe(mobileObsidianTokens[key]);
    }
  });

  it('maintains parity for supported exchanges and API key regex', () => {
    expect([...WEB_SUPPORTED_EXCHANGES]).toEqual([...MOBILE_SUPPORTED_EXCHANGES]);
    expect(WEB_API_KEY_REGEX.source).toBe(MOBILE_API_KEY_REGEX.source);

    const validKeys = ['okx_api_key_01', 'Binance-Sub-99', 'kc_prod_api_key', 'Abc123_-xyz'];
    const invalidKeys = ['short', 'has spaces in key', 'bad$character', ''];

    for (const key of validKeys) {
      expect(webIsValidApiKeyId(key)).toBe(true);
      expect(mobileIsValidApiKeyId(key)).toBe(true);
    }

    for (const key of invalidKeys) {
      expect(webIsValidApiKeyId(key)).toBe(false);
      expect(mobileIsValidApiKeyId(key)).toBe(false);
    }
  });

  it('validates supported exchange helper correctly', () => {
    expect(webIsSupportedExchange('okx')).toBe(true);
    expect(webIsSupportedExchange('KUCOIN')).toBe(true);
    expect(webIsSupportedExchange('binance')).toBe(true);
    expect(webIsSupportedExchange('Bybit')).toBe(true);
    expect(webIsSupportedExchange('unknown_exchange')).toBe(false);
  });
});

describe('WCAG 2.1 AA Contrast Ratio Enforcement', () => {
  const WCAG_AA_NORMAL_TEXT_THRESHOLD = 4.5;

  it('enforces textPrimary contrast ratio >= 4.5:1 on canvas and surface', () => {
    const canvasContrast = contrastRatio(webObsidianTokens.textPrimary, webObsidianTokens.canvas);
    const surfaceContrast = contrastRatio(webObsidianTokens.textPrimary, webObsidianTokens.surface);

    expect(canvasContrast).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_THRESHOLD);
    expect(surfaceContrast).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_THRESHOLD);
    // In fact textPrimary (#F8FAFC) is > 15:1
    expect(canvasContrast).toBeGreaterThan(15.0);
  });

  it('enforces textMuted (#94A3B8) contrast ratio >= 4.5:1 on canvas and surface (fixing #64748B)', () => {
    const canvasContrast = contrastRatio(webObsidianTokens.textMuted, webObsidianTokens.canvas);
    const surfaceContrast = contrastRatio(webObsidianTokens.textMuted, webObsidianTokens.surface);

    expect(canvasContrast).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_THRESHOLD);
    expect(surfaceContrast).toBeGreaterThanOrEqual(WCAG_AA_NORMAL_TEXT_THRESHOLD);

    // Verify mathematical upgrade over the broken #64748B
    const brokenOldContrast = contrastRatio('#64748B', webObsidianTokens.canvas);
    expect(brokenOldContrast).toBeLessThan(4.5); // was ~3.0:1
    expect(canvasContrast).toBeGreaterThan(brokenOldContrast * 1.8); // Now ~8.5:1
  });
});
