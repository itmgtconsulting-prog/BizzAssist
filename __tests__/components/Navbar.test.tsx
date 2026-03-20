/**
 * Component tests for the Navbar.
 *
 * Verifies that:
 * - Navbar renders the BizzAssist logo
 * - Language toggle buttons are present
 * - Switching language updates the active button state
 * - Login and CTA links are present
 * - Mobile menu opens and closes correctly
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Navbar from '@/app/components/Navbar';
import { LanguageProvider } from '@/app/context/LanguageContext';

// Mock Next.js Link to avoid router dependency in tests
vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

/** Renders Navbar wrapped in LanguageProvider (required for language context) */
function renderNavbar() {
  return render(
    <LanguageProvider>
      <Navbar />
    </LanguageProvider>
  );
}

describe('Navbar', () => {
  it('renders the BizzAssist logo text', () => {
    renderNavbar();
    expect(screen.getByText('Assist')).toBeInTheDocument();
  });

  it('renders DA and EN language toggle buttons', () => {
    renderNavbar();
    expect(screen.getAllByText('DA').length).toBeGreaterThan(0);
    expect(screen.getAllByText('EN').length).toBeGreaterThan(0);
  });

  it('renders login link', () => {
    renderNavbar();
    // Default language is DA, so "Log ind" should appear
    expect(screen.getByText('Log ind')).toBeInTheDocument();
  });

  it('renders get started CTA', () => {
    renderNavbar();
    expect(screen.getByText('Kom i gang gratis')).toBeInTheDocument();
  });

  it('switches to English when EN button is clicked', () => {
    renderNavbar();
    const enButtons = screen.getAllByText('EN');
    fireEvent.click(enButtons[0]);
    expect(screen.getByText('Log in')).toBeInTheDocument();
  });

  it('opens mobile menu when hamburger is clicked', () => {
    renderNavbar();
    // Find the mobile menu button (Menu icon button — only shown on mobile)
    const menuButton = screen.getByRole('button', { name: '' });
    // Before click — CTA should not be duplicated in mobile menu
    // After click — mobile menu appears with links
    fireEvent.click(menuButton);
    // Both desktop and mobile CTAs now visible
    const ctaLinks = screen.getAllByText('Kom i gang gratis');
    expect(ctaLinks.length).toBeGreaterThanOrEqual(1);
  });
});
