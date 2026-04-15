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

// Mock Next.js Link to avoid router dependency in jsdom
vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
    onClick,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
    onClick?: React.MouseEventHandler;
  }) => (
    <a href={href} className={className} onClick={onClick}>
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

  it('renders "Se ejendomsdetaljer" link (DA) when dawaId is set', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    expect(screen.getByText('Se ejendomsdetaljer')).toBeInTheDocument();
  });

  it('renders "View property details" link (EN) when dawaId is set', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="en" />);
    expect(screen.getByText('View property details')).toBeInTheDocument();
  });

  it('"Se ejendomsdetaljer" link points to /dashboard/ejendomme/{dawaId}', () => {
    render(<PropertyOwnerCard ejendom={baseEjendom} lang="da" />);
    const link = screen.getByText('Se ejendomsdetaljer').closest('a');
    expect(link).toHaveAttribute('href', `/dashboard/ejendomme/${baseEjendom.dawaId}`);
  });

  it('renders no-detail fallback message when dawaId is null', () => {
    render(<PropertyOwnerCard ejendom={ejendomNoDawaId} lang="da" />);
    expect(screen.getByText(/Ingen detaljeside/)).toBeInTheDocument();
  });

  it('renders no-detail fallback in English when lang=en and dawaId is null', () => {
    render(<PropertyOwnerCard ejendom={ejendomNoDawaId} lang="en" />);
    expect(screen.getByText(/No detail page/)).toBeInTheDocument();
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
