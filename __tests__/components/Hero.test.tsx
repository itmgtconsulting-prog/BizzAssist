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
import { render, screen } from '@testing-library/react';
import Hero from '@/app/components/Hero';
import { LanguageProvider } from '@/app/context/LanguageContext';
import { translations } from '@/app/lib/translations';

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
});
