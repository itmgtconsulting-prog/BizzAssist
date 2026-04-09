/**
 * Cookie consent utilities for GDPR-compliant tracking.
 *
 * Consent is stored in both a cookie (`bizzassist_consent`) and localStorage
 * (`cookie_consent`) for backward compatibility. The cookie enables server-side
 * reading during SSR so tracking scripts can be conditionally included.
 *
 * @module cookieConsent
 */

/** Allowed consent values */
export type ConsentValue = 'accepted' | 'declined';

/** Name of the consent cookie readable by the server */
export const CONSENT_COOKIE_NAME = 'bizzassist_consent';

/** Name of the legacy localStorage key (kept for migration) */
export const CONSENT_LOCALSTORAGE_KEY = 'cookie_consent';

/** Cookie max-age in seconds (1 year) */
const ONE_YEAR_SECONDS = 365 * 24 * 60 * 60;

/**
 * Set the consent value in both a cookie and localStorage.
 *
 * The cookie is set with `SameSite=Lax`, `Secure`, `Path=/`, and a 1-year expiry
 * so the server can read it during SSR. localStorage is written in parallel for
 * backward compatibility with existing client-side consumers.
 *
 * @param value - The consent choice: 'accepted' or 'declined'
 */
export function setConsent(value: ConsentValue): void {
  // Set the cookie for server-side access
  const expires = new Date(Date.now() + ONE_YEAR_SECONDS * 1000).toUTCString();
  document.cookie = `${CONSENT_COOKIE_NAME}=${value}; Path=/; SameSite=Lax; Secure; Expires=${expires}`;

  // Write to localStorage for backward compatibility / migration
  if (typeof localStorage !== 'undefined') {
    localStorage.setItem(CONSENT_LOCALSTORAGE_KEY, value);
  }
}

/**
 * Read the current consent value from the cookie or localStorage (fallback).
 *
 * Checks the `bizzassist_consent` cookie first. If absent, falls back to the
 * legacy `cookie_consent` localStorage key. When a localStorage value is found
 * without a matching cookie, the cookie is automatically written (migration).
 *
 * @returns The stored consent value, or `null` if no consent has been recorded
 */
export function getConsentClient(): ConsentValue | null {
  // 1. Try reading from cookie
  const cookieValue = parseCookieValue(document.cookie, CONSENT_COOKIE_NAME);
  if (cookieValue === 'accepted' || cookieValue === 'declined') {
    return cookieValue;
  }

  // 2. Fallback: read from localStorage (legacy users)
  if (typeof localStorage !== 'undefined') {
    const stored = localStorage.getItem(CONSENT_LOCALSTORAGE_KEY);
    if (stored === 'accepted' || stored === 'declined') {
      // Migrate: write the cookie so the server can read it next time
      setConsent(stored);
      return stored;
    }
  }

  return null;
}

/**
 * Parse a specific cookie value from a raw `document.cookie` string.
 *
 * @param cookieString - The full cookie string (e.g. `document.cookie`)
 * @param name - The cookie name to look up
 * @returns The decoded cookie value, or `null` if not found
 */
export function parseCookieValue(cookieString: string, name: string): string | null {
  const match = cookieString.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/**
 * Read the consent value from a server-side cookie header string.
 *
 * Intended for use in Server Components and `layout.tsx` where `document` is
 * unavailable. Pass the raw `Cookie` header value (from `headers()` or
 * `cookies()`).
 *
 * @param cookieHeader - The raw Cookie header string, or `null`/`undefined`
 * @returns The consent value, or `null` if the cookie is absent or invalid
 */
export function getConsentFromCookieHeader(
  cookieHeader: string | null | undefined
): ConsentValue | null {
  if (!cookieHeader) return null;
  const value = parseCookieValue(cookieHeader, CONSENT_COOKIE_NAME);
  if (value === 'accepted' || value === 'declined') {
    return value;
  }
  return null;
}
