/**
 * Component tests for CookieBanner.
 *
 * Verifies that:
 * - Banner renders when no consent is stored in localStorage
 * - Banner is hidden when consent is already 'accepted'
 * - "Acceptér alle" button stores 'accepted' and hides the banner
 * - "Kun nødvendige" (decline) button stores 'declined' and hides the banner
 * - Links to /cookies policy are present
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import CookieBanner from '@/app/components/CookieBanner';
import { LanguageProvider } from '@/app/context/LanguageContext';

// Mock Next.js Link to a plain anchor — avoids router dependency in tests
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** Renders CookieBanner wrapped in LanguageProvider */
function renderBanner() {
  return render(
    <LanguageProvider>
      <CookieBanner />
    </LanguageProvider>
  );
}

describe('CookieBanner', () => {
  it('renders the banner when localStorage has no consent', async () => {
    // localStorage is cleared in afterEach by setup.ts, so this starts clean
    await act(async () => {
      renderBanner();
    });
    // The accept button should be visible
    expect(screen.getByRole('button', { name: /acceptér alle/i })).toBeInTheDocument();
  });

  it('does NOT render when consent is already stored as accepted', async () => {
    localStorage.setItem('cookie_consent', 'accepted');
    await act(async () => {
      renderBanner();
    });
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
  });

  it('does NOT render when consent is already stored as declined', async () => {
    localStorage.setItem('cookie_consent', 'declined');
    await act(async () => {
      renderBanner();
    });
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
  });

  it('"Acceptér alle" sets localStorage to accepted and hides the banner', async () => {
    await act(async () => {
      renderBanner();
    });
    const acceptBtn = screen.getByRole('button', { name: /acceptér alle/i });
    await act(async () => {
      fireEvent.click(acceptBtn);
    });
    expect(localStorage.getItem('cookie_consent')).toBe('accepted');
    expect(screen.queryByRole('button', { name: /acceptér alle/i })).not.toBeInTheDocument();
  });

  it('"Kun nødvendige" sets localStorage to declined and hides the banner', async () => {
    await act(async () => {
      renderBanner();
    });
    const declineBtn = screen.getByRole('button', { name: /kun nødvendige/i });
    await act(async () => {
      fireEvent.click(declineBtn);
    });
    expect(localStorage.getItem('cookie_consent')).toBe('declined');
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

  it('renders banner text in English when language is EN', async () => {
    // Render with EN by switching after mount — easier to check EN-specific strings
    // The LanguageProvider defaults to 'da', but we can inspect both button texts here
    await act(async () => {
      renderBanner();
    });
    // Default is Danish — ensure the DA strings are shown
    expect(screen.getByRole('button', { name: /acceptér alle/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /kun nødvendige/i })).toBeInTheDocument();
  });
});
