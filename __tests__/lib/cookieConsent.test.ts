/**
 * Unit tests for app/lib/cookieConsent.ts
 *
 * Verifies:
 * - parseCookieValue extracts values from cookie strings
 * - getConsentFromCookieHeader reads consent from raw Cookie headers
 * - setConsent writes to both document.cookie and localStorage
 * - getConsentClient reads cookie first, then falls back to localStorage
 * - getConsentClient migrates localStorage-only values to cookies
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  parseCookieValue,
  getConsentFromCookieHeader,
  setConsent,
  getConsentClient,
  CONSENT_COOKIE_NAME,
  CONSENT_LOCALSTORAGE_KEY,
} from '@/app/lib/cookieConsent';

/** Clear document.cookie by expiring all cookies */
function clearCookies(): void {
  document.cookie.split(';').forEach((c) => {
    const name = c.trim().split('=')[0];
    if (name) {
      document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  });
}

describe('parseCookieValue', () => {
  it('extracts a value from a single cookie', () => {
    expect(parseCookieValue('foo=bar', 'foo')).toBe('bar');
  });

  it('extracts a value from multiple cookies', () => {
    expect(parseCookieValue('a=1; bizzassist_consent=accepted; c=3', 'bizzassist_consent')).toBe(
      'accepted'
    );
  });

  it('returns null when cookie is not present', () => {
    expect(parseCookieValue('a=1; b=2', 'missing')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseCookieValue('', 'foo')).toBeNull();
  });

  it('handles URL-encoded values', () => {
    expect(parseCookieValue('name=hello%20world', 'name')).toBe('hello world');
  });
});

describe('getConsentFromCookieHeader', () => {
  it('returns accepted when cookie is present', () => {
    expect(getConsentFromCookieHeader('bizzassist_consent=accepted; other=val')).toBe('accepted');
  });

  it('returns declined when cookie is present', () => {
    expect(getConsentFromCookieHeader('bizzassist_consent=declined')).toBe('declined');
  });

  it('returns null for invalid consent value', () => {
    expect(getConsentFromCookieHeader('bizzassist_consent=maybe')).toBeNull();
  });

  it('returns null for null input', () => {
    expect(getConsentFromCookieHeader(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(getConsentFromCookieHeader(undefined)).toBeNull();
  });

  it('returns null when consent cookie is absent', () => {
    expect(getConsentFromCookieHeader('session=abc123')).toBeNull();
  });
});

describe('setConsent', () => {
  beforeEach(() => {
    clearCookies();
    localStorage.clear();
  });

  it('writes accepted to both cookie and localStorage', () => {
    setConsent('accepted');
    expect(document.cookie).toContain(`${CONSENT_COOKIE_NAME}=accepted`);
    expect(localStorage.getItem(CONSENT_LOCALSTORAGE_KEY)).toBe('accepted');
  });

  it('writes declined to both cookie and localStorage', () => {
    setConsent('declined');
    expect(document.cookie).toContain(`${CONSENT_COOKIE_NAME}=declined`);
    expect(localStorage.getItem(CONSENT_LOCALSTORAGE_KEY)).toBe('declined');
  });
});

describe('getConsentClient', () => {
  beforeEach(() => {
    clearCookies();
    localStorage.clear();
  });

  it('returns null when nothing is stored', () => {
    expect(getConsentClient()).toBeNull();
  });

  it('reads from cookie when present', () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=accepted; Path=/`;
    expect(getConsentClient()).toBe('accepted');
  });

  it('falls back to localStorage when cookie is absent', () => {
    localStorage.setItem(CONSENT_LOCALSTORAGE_KEY, 'declined');
    expect(getConsentClient()).toBe('declined');
  });

  it('migrates localStorage value to cookie on fallback read', () => {
    localStorage.setItem(CONSENT_LOCALSTORAGE_KEY, 'accepted');
    getConsentClient();
    expect(document.cookie).toContain(`${CONSENT_COOKIE_NAME}=accepted`);
  });

  it('prefers cookie over localStorage', () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=declined; Path=/`;
    localStorage.setItem(CONSENT_LOCALSTORAGE_KEY, 'accepted');
    expect(getConsentClient()).toBe('declined');
  });
});
