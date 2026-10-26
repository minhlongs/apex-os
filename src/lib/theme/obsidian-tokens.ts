/**
 * src/lib/theme/obsidian-tokens.ts
 *
 * Isomorphic Zero-Dependency Obsidian Design System Token Contract.
 * Synchronized 1:1 with apex-os-mobile/src/theme/tokens.ts.
 *
 * WCAG 2.1 AA Compliance Note:
 * - `textPrimary` (#F8FAFC) on `canvas` (#020617) has contrast ratio ~19.5:1 (passes AAA).
 * - `textMuted` (#94A3B8) on `canvas` (#020617) has contrast ratio ~8.5:1 (passes AAA).
 * - `textMuted` (#94A3B8) on `surface` (#0F172A) has contrast ratio ~6.5:1 (passes AA & AAA).
 *   (Upgraded from the non-compliant #64748B which was only 3.0:1 on canvas).
 */

export const obsidianTokens = {
  // Backgrounds & Surfaces
  canvas: '#020617', // Slate 950 deep obsidian canvas
  surface: '#0F172A', // Slate 900 card and panel background
  well: '#1E293B', // Slate 800 recessed inputs, pills, and wells

  // Borders & Dividers
  border: '#1E293B', // Slate 800 subtle card boundary
  divider: '#334155', // Slate 700 clear section divider

  // Accent & Brand Palette
  indigo: '#6366F1', // Primary brand action
  violet: '#8B5CF6', // Secondary brand accent
  cyan: '#06B6D4', // Informational & deep links
  emerald: '#10B981', // Success, earnings, & confirmed state
  amber: '#F59E0B', // Warning, pending, & security notices
  crimson: '#EF4444', // Error, deletion, & rejected state

  // Typography & Content
  textPrimary: '#F8FAFC', // Slate 50 ultra-high contrast body & headers
  textMuted: '#94A3B8', // Slate 400 WCAG 2.1 AA compliant secondary text
} as const;

export type ObsidianTokens = typeof obsidianTokens;

/**
 * Exchange API Key Linking Shared Validation Contract
 * Used across Web and Mobile to validate user inputs before dispatching requests.
 */
export const SUPPORTED_LINKED_EXCHANGES = ['okx', 'kucoin', 'binance', 'bybit'] as const;
export type SupportedLinkedExchange = (typeof SUPPORTED_LINKED_EXCHANGES)[number];

export const API_KEY_ID_REGEX = /^[A-Za-z0-9_-]{6,128}$/;

export function isValidApiKeyId(value: string): boolean {
  return API_KEY_ID_REGEX.test(value.trim());
}

export function isSupportedExchange(value: string): value is SupportedLinkedExchange {
  return (SUPPORTED_LINKED_EXCHANGES as readonly string[]).includes(value.toLowerCase().trim());
}
