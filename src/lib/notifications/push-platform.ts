/**
 * Push notification platform identifiers.
 *
 * Kept outside the route module so Next.js route handlers expose only HTTP method
 * handlers to its route-type validator.
 */

export type PushPlatform = 'ios' | 'android' | 'web';

export const VALID_PLATFORMS: readonly PushPlatform[] = ['ios', 'android', 'web'] as const;
