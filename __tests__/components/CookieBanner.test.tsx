/**
 * Component tests for CookieBanner.
 *
 * Verifies that:
 * - Banner renders when no consent is stored
 * - Banner is hidden when consent cookie is already 'accepted'
 * - Banner is hidden when consent cookie is already 'declined'
 * - "Acceptér alle" sets both cookie and localStorage to 'accepted' and hides banner
 * - "Kun nødvendige" sets both cookie and localStorage to 'declined' and hides banner
 * - Legacy localStorage-only consent is migrated to cookie
 * - Links to /cookies policy are present
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CookieBanner from '@/app/components/CookieBanner';
import { LanguageProvider } from '@/app/context/LanguageContext';
import { CONSENT_COOKIE_NAME, CONSENT_LOCALSTORAGE_KEY } from '@/app/lib/cookieConsent';

// Mock Next.js Link to a plain anchor — avoids router dependency in tests
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** Helper to read a specific cookie value from document.cookie */
function getCookieValue(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

/** Clear document.cookie by setting all cookies to expired */
function clearCookies(): void {
  document.cookie.split(';').forEach((c) => {
    const name = c.trim().split('=')[0];
    if (name) {
      document.cookie = `${name}=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT`;
    }
  });
}

/** Renders CookieBanner wrapped in LanguageProvider */
function renderBanner() {
  return render(
    <LanguageProvider>
      <CookieBanner />
    </LanguageProvider>
  );
}

describe('CookieBanner', () => {
  beforeEach(() => {
    clearCookies();
    localStorage.clear();
  });

  it('renders the banner when no consent is stored', async () => {
    await act(async () => {
      renderBanner();
    });
    expect(screen.getByRole('button', { name: /acceptér alle/i })).toBeInTheDocument();
  });

  it('does NOT render when consent cookie is already accepted', async () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=accepted; Path=/`;
    await act(async () => {
      renderBanner();
    });
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
  });

  it('does NOT render when consent cookie is already declined', async () => {
    document.cookie = `${CONSENT_COOKIE_NAME}=declined; Path=/`;
    await act(async () => {
      renderBanner();
    });
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
  });

  it('does NOT render when legacy localStorage consent exists (and migrates to cookie)', async () => {
    localStorage.setItem(CONSENT_LOCALSTORAGE_KEY, 'accepted');
    await act(async () => {
      renderBanner();
    });
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
    // Verify migration: cookie should now be set
    expect(getCookieValue(CONSENT_COOKIE_NAME)).toBe('accepted');
  });

  it('"Acceptér alle" sets cookie and localStorage to accepted and hides the banner', async () => {
    await act(async () => {
      renderBanner();
    });
    const acceptBtn = screen.getByRole('button', { name: /acceptér alle/i });
    await act(async () => {
      fireEvent.click(acceptBtn);
    });
    expect(getCookieValue(CONSENT_COOKIE_NAME)).toBe('accepted');
    expect(localStorage.getItem(CONSENT_LOCALSTORAGE_KEY)).toBe('accepted');
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
  });

  it('"Kun nødvendige" sets cookie and localStorage to declined and hides the banner', async () => {
    await act(async () => {
      renderBanner();
    });
    const declineBtn = screen.getByRole('button', { name: /kun nødvendige/i });
    await act(async () => {
      fireEvent.click(declineBtn);
    });
    expect(getCookieValue(CONSENT_COOKIE_NAME)).toBe('declined');
    expect(localStorage.getItem(CONSENT_LOCALSTORAGE_KEY)).toBe('declined');
    expect(screen.queryByRole('button', { name: /kun nødvendige/i })).not.toBeInTheDocument();
  });

  it('renders a link to /cookies', async () => {
    await act(async () => {
      renderBanner();
    });
    const cookieLink = screen.getByRole('link', { name: /cookiepolitik/i });
    expect(cookieLink).toBeInTheDocument();
    expect(cookieLink).toHaveAttribute('href', '/cookies');
  });

  it('renders banner text in Danish by default', async () => {
    await act(async () => {
      renderBanner();
    });
    expect(screen.getByRole('button', { name: /acceptér alle/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /kun nødvendige/i })).toBeInTheDocument();
  });
});
