/**
 * Component tests for the Hero marketing section (app/components/Hero.tsx).
 *
 * Verifies that:
 * - Hero renders without crashing
 * - The primary headline text is present
 * - A CTA link pointing to /login/signup is present
 * - The hero renders the correct copy in English when the language is EN
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Hero from '@/app/components/Hero';
import { LanguageProvider } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

// Stable router.push spy so search-navigation can be asserted across tests
const pushMock = vi.fn();

// Mock Next.js navigation — avoids router dependency in tests
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: pushMock, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => '/',
  useSearchParams: () => new URLSearchParams(),
}));

// Mock Next.js Link — avoids router dependency in tests
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

/** Renders Hero wrapped in LanguageProvider */
function renderHero() {
  return render(
    <LanguageProvider>
      <Hero />
    </LanguageProvider>
  );
}

describe('Hero', () => {
  it('renders without crashing (smoke test)', () => {
    // Expect no thrown error during render
    expect(() => renderHero()).not.toThrow();
  });

  it('renders part of the Danish headline by default', () => {
    renderHero();
    // translations.da.hero.title = 'Data og Information om'
    expect(screen.getByText(translations.da.hero.title)).toBeInTheDocument();
  });

  it('renders the highlighted part of the headline', () => {
    renderHero();
    // translations.da.hero.titleHighlight = 'ejendomme, virksomheder og deres ejere'
    expect(screen.getByText(translations.da.hero.titleHighlight)).toBeInTheDocument();
  });

  it('renders the subtitle text', () => {
    renderHero();
    expect(screen.getByText(translations.da.hero.subtitle)).toBeInTheDocument();
  });

  it('renders a CTA link pointing to /login/signup', () => {
    renderHero();
    // The CTA uses translations[lang].nav.getStarted as its label
    const ctaLink = screen.getByRole('link', { name: /kom i gang gratis/i });
    expect(ctaLink).toBeInTheDocument();
    expect(ctaLink).toHaveAttribute('href', '/login/signup');
  });

  it('renders the dashboard preview image', () => {
    renderHero();
    const img = screen.getByRole('img', { name: /bizzassist dashboard/i });
    expect(img).toBeInTheDocument();
    expect(img).toHaveAttribute('src', '/images/dashboard-preview.png');
  });

  it('renders the English headline when lang is set to EN', () => {
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <Hero />
      </LanguageProvider>
    );
    expect(screen.getByText(translations.en.hero.title)).toBeInTheDocument();
    expect(screen.getByText(translations.en.hero.titleHighlight)).toBeInTheDocument();
  });

  it('renders the English CTA label in EN mode', () => {
    localStorage.setItem('ba-lang', 'en');
    render(
      <LanguageProvider>
        <Hero />
      </LanguageProvider>
    );
    // translations.en.nav.getStarted = 'Get started free'
    expect(screen.getByRole('link', { name: /get started free/i })).toBeInTheDocument();
  });

  /**
   * BIZZ-2187: autocomplete consumes the DAR shape ({ tekst, adresse.id, bfe }).
   * Regression guard: an address WITH a resolved bfe must produce a BFE-based
   * SEO link, and an address WITHOUT a bfe must be skipped (would otherwise link
   * to /ejendom/<slug>/0 → "Ejendom ikke fundet").
   */
  it('shows BFE-resolved address suggestions and navigates to the SEO page on click', async () => {
    pushMock.mockClear();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/adresse/autocomplete')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                type: 'adgangsadresse',
                tekst: 'Søbyvej 11, 2740 Skovlunde',
                adresse: { id: '0a3f507b-883d-32b8-e044-0003ba298018' },
                bfe: 2155712,
              },
              // No bfe → must be filtered out of the dropdown
              {
                type: 'adgangsadresse',
                tekst: 'Søbyvej 11, 2650 Hvidovre',
                adresse: { id: '0a3f507c-e46f-32b8-e044-0003ba298018' },
              },
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHero();
    const input = screen.getByPlaceholderText(/søg adresse/i);
    fireEvent.change(input, { target: { value: 'søbyvej 11' } });

    const option = await screen.findByText('Søbyvej 11, 2740 Skovlunde');
    // Address without a bfe must not be rendered (would be a dead /0 link)
    expect(screen.queryByText('Søbyvej 11, 2650 Hvidovre')).not.toBeInTheDocument();

    fireEvent.mouseDown(option);
    expect(pushMock).toHaveBeenCalledWith('/ejendom/søbyvej-11-2740-skovlunde/2155712');

    vi.unstubAllGlobals();
  });

  /** BIZZ-2187: Enter navigates to the top search result. */
  it('navigates to the first result when Enter is pressed', async () => {
    pushMock.mockClear();
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('/api/adresse/autocomplete')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve([
              {
                type: 'adgangsadresse',
                tekst: 'Søbyvej 11, 2740 Skovlunde',
                adresse: { id: '0a3f507b-883d-32b8-e044-0003ba298018' },
                bfe: 2155712,
              },
            ]),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
    });
    vi.stubGlobal('fetch', fetchMock);

    renderHero();
    const input = screen.getByPlaceholderText(/søg adresse/i);
    fireEvent.change(input, { target: { value: 'søbyvej 11' } });
    await screen.findByText('Søbyvej 11, 2740 Skovlunde');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(pushMock).toHaveBeenCalledWith('/ejendom/søbyvej-11-2740-skovlunde/2155712');

    vi.unstubAllGlobals();
  });
});
