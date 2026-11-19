import type { LinkedExchange, ProfileExternalIds } from '@/types/profile';

export const SUPPORTED_LINKED_EXCHANGES: readonly LinkedExchange[] = [
  'okx',
  'kucoin',
  'binance',
  'bybit',
] as const;

export function parseExternalIds(raw: string | null | undefined): ProfileExternalIds {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as ProfileExternalIds;
    }
    return {};
  } catch {
    return {};
  }
}

export function isSupportedLinkedExchange(value: string): value is LinkedExchange {
  return (SUPPORTED_LINKED_EXCHANGES as readonly string[]).includes(value);
}
