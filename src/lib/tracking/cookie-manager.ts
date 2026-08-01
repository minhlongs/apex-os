import { warn as logWarn } from '@/lib/logger';
/**
 * Cookie Manager for tracking referral codes and other tracking data
 */

export interface CookieOptions {
  days?: number;
  path?: string;
  domain?: string;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

const DEFAULT_COOKIE_OPTIONS: Required<CookieOptions> = {
  days: 365,
  path: '/',
  domain: '',
  secure: true,
  sameSite: 'Lax',
};

const REFERRAL_COOKIE_NAME = 'referral_code';

/**
 * Sets a cookie with the given name and value
 */
function setCookie(
  name: string,
  value: string,
  options: CookieOptions = {}
): void {
  const opts = { ...DEFAULT_COOKIE_OPTIONS, ...options };
  let expires = '';

  if (opts.days) {
    const date = new Date();
    date.setTime(date.getTime() + opts.days * 24 * 60 * 60 * 1000);
    expires = `; expires=${date.toUTCString()}`;
  }

  const domain = opts.domain ? `; domain=${opts.domain}` : '';
  const path = `; path=${opts.path}`;
  const secure = opts.secure ? '; secure' : '';
  const sameSite = `; samesite=${opts.sameSite}`;

  document.cookie = `${name}=${encodeURIComponent(value)}${expires}${domain}${path}${secure}${sameSite}`;
}

/**
 * Gets a cookie value by name
 */
function getCookie(name: string): string | null {
  const nameEQ = `${name}=`;
  const ca = document.cookie.split(';');

  for (let c of ca) {
    c = c.trim();
    if (c.indexOf(nameEQ) === 0) {
      return decodeURIComponent(c.substring(nameEQ.length));
    }
  }

  return null;
}

/**
 * Deletes a cookie by name
 */
function deleteCookie(name: string, options: Pick<CookieOptions, 'path' | 'domain'> = {}): void {
  setCookie(name, '', { ...options, days: -1 });
}

/**
 * Sets the referral code cookie
 * @param referralCode - The referral code to store
 * @param options - Optional cookie configuration (expiry, path, domain, etc.)
 */
export function setReferralCookie(referralCode: string, options: CookieOptions = {}): void {
  if (!referralCode || typeof referralCode !== 'string') {
    logWarn('Invalid referral code provided');
    return;
  }

  setCookie(REFERRAL_COOKIE_NAME, referralCode.trim(), options);
}

/**
 * Gets the stored referral code from cookies
 * @returns The referral code if found, otherwise null
 */
export function getReferralCode(): string | null {
  return getCookie(REFERRAL_COOKIE_NAME);
}

/**
 * Clears the referral code cookie
 * @param options - Optional cookie configuration (path, domain must match when setting)
 */
export function clearReferralCookie(options: Pick<CookieOptions, 'path' | 'domain'> = {}): void {
  deleteCookie(REFERRAL_COOKIE_NAME, options);
}
