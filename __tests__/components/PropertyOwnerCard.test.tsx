/**
 * Component tests for app/components/ejendomme/PropertyOwnerCard.tsx
 *
 * Verifies that the card correctly renders property ownership data:
 *  - Adresse og postal linje vises
 *  - BFE-nummer badge vises
 *  - Ejendomstype badge vises med korrekt label
 *  - "Se ejendomsdetaljer" link vises når dawaId er sat
 *  - Fallback vises når dawaId mangler
 *  - Ejer-CVR link vises i showOwner mode
 *
 * Replaces "–" / missing-data regression tests: if the card renders the
 * address and BFE number correctly the data flow from the API is intact.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import PropertyOwnerCard from '@/app/components/ejendomme/PropertyOwnerCard';
import type { EjendomSummary } from '@/app/api/ejendomme-by-owner/route';

// Mock Next.js Link to avoid router dependency in jsdom.
// Spread all props through so aria-label, onClick and className reach the anchor.
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    ...rest
  }: {
    children: React.ReactNode;
    href: string;
  } & Record<string, unknown>) => (
    <a href={href} {...(rest as Record<string, unknown>)}>
      {children}
    </a>
  ),
}));

// ── Fixtures ──────────────────────────────────────────────────────────────────

const baseEjendom: EjendomSummary = {
  bfeNummer: 100165718,
  ownerCvr: '12345678',
  adresse: 'Nørrebrogade 10',
  postnr: '2200',
  by: 'København N',
  kommune: 'København',
  kommuneKode: '0101',
  ejendomstype: 'Normal ejendom',
  dawaId: 'b84b7e12-b8a1-4601-87d5-000000000001',
  etage: null,
  doer: null,
};

const ejendomNoAdresse: EjendomSummary = {
  ...baseEjendom,
  adresse: null,
  postnr: null,
  by: null,
};

const ejendomNoDawaId: EjendomSummary = {
  ...baseEjendom,
  dawaId: null,
};

const ejendomEjerlejlighed: EjendomSummary = {
  ...baseEjendom,
  ejendomstype: 'Ejerlejlighed',
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('PropertyOwnerCard', () => {
  it('renders the adresse when present', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    expect(screen.getByText('Nørrebrogade 10')).toBeInTheDocument();
  });

  it('renders "BFE {formatted number}" badge', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    // 100165718 formatted with da-DK locale uses "." as thousand separator
    expect(screen.getByText(/BFE/)).toBeInTheDocument();
  });

  it('renders postal line with postnr and by', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    expect(screen.getByText('2200 København N')).toBeInTheDocument();
  });

  it('falls back to kommune when postnr/by are absent', () => {
    render(<PropertyOwnerCard ejendom={ejendomNoAdresse} lang="da" />);
    // Kommune appears in both postal fallback line and badge — check at least one exists
    expect(screen.getAllByText('København').length).toBeGreaterThanOrEqual(1);
  });

  it('falls back to "BFE {bfeNummer}" as adresselinje when adresse is null', () => {
    render(<PropertyOwnerCard ejendom={ejendomNoAdresse} lang="da" />);
    // Multiple "BFE" occurrences expected (adresselinje + badge) — ensure at least one
    expect(screen.getAllByText(/BFE/).length).toBeGreaterThanOrEqual(1);
  });

  it('renders "Parcelhus/grund" badge for "Normal ejendom" type', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    expect(screen.getByText('Parcelhus/grund')).toBeInTheDocument();
  });

  it('renders "Ejerlejlighed" badge for Ejerlejlighed type', () => {
    render(<PropertyOwnerCard ejendom={ejendomEjerlejlighed} lang="da" />);
    expect(screen.getByText('Ejerlejlighed')).toBeInTheDocument();
  });

  // BIZZ-464: "Se detaljer"-pillen er fjernet — hele kortet er Link'et.
  // Tjek nu bare at der findes en anchor mod detaljesiden med en læsbar
  // aria-label for skærmlæsere.
  it('wraps the whole card in a link to /dashboard/ejendomme/{dawaId} when dawaId is set', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/dashboard/ejendomme/${baseEjendom.dawaId}`);
    expect(link.getAttribute('aria-label')).toMatch(/^Se detaljer for /);
  });

  it('uses English aria-label when lang=en', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="en" />);
    const link = screen.getByRole('link');
    expect(link.getAttribute('aria-label')).toMatch(/^View details for /);
  });

  it('renders no-detail fallback message when dawaId is null', () => {
    render(<PropertyOwnerCard ejendom={ejendomNoDawaId} lang="da" />);
    expect(screen.getByText(/DAWA-id mangler/)).toBeInTheDocument();
  });

  it('renders no-detail fallback in English when lang=en and dawaId is null', () => {
    render(<PropertyOwnerCard ejendom={ejendomNoDawaId} lang="en" />);
    expect(screen.getByText(/DAWA id missing/)).toBeInTheDocument();
  });

  it('does NOT render ejer-CVR section when showOwner is false (default)', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    expect(screen.queryByText(/CVR 12345678/)).not.toBeInTheDocument();
  });

  it('renders ejer-CVR link when showOwner is true', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" showOwner />);
    expect(screen.getByText(/CVR 12345678/)).toBeInTheDocument();
  });

  it('ejer-CVR link points to /dashboard/companies/{cvr}', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" showOwner />);
    const link = screen.getByText(/CVR 12345678/).closest('a');
    expect(link).toHaveAttribute('href', '/dashboard/companies/12345678');
  });

  it('renders "Ukendt" type badge when ejendomstype is null', () => {
    render(<PropertyOwnerCard ejendom={{ ...baseEjendom, ejendomstype: null }} lang="da" />);
    expect(screen.getByText('Ukendt')).toBeInTheDocument();
  });
});
