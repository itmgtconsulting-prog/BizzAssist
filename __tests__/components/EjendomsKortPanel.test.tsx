/**
 * Component tests for app/components/ejendomme/EjendomsKortPanel.tsx (BIZZ-2089)
 *
 * Mapbox kan ikke køre i jsdom, så react-map-gl/mapbox mockes med simple
 * pass-through komponenter. Verificerer:
 *  - Loading-state vises mens geokodning kører
 *  - Markers renderes når geokodning lykkes (≤50 → individuelle markers)
 *  - Empty-state når intet kunne geokodes
 *  - Luk-knap med aria-label kalder onClose
 *  - Dialog a11y-attributter (role/aria-modal/aria-labelledby)
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import EjendomsKortPanel from '@/app/components/ejendomme/EjendomsKortPanel';
import { _clearGeokodCache } from '@/app/lib/ejendomsKortGeokod';

// Mock react-map-gl/mapbox — jsdom kan ikke køre WebGL/Mapbox
vi.mock('react-map-gl/mapbox', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-map">{children}</div>
  ),
  Marker: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-marker">{children}</div>
  ),
  Popup: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-popup">{children}</div>
  ),
  NavigationControl: () => null,
  Source: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="mock-source">{children}</div>
  ),
  Layer: () => null,
}));

vi.mock('next/link', () => ({
  default: ({ children, href }: { children: React.ReactNode; href: string }) => (
    <a href={href}>{children}</a>
  ),
}));

// Mapbox-token kræves for at kortet renderes — skal sættes FØR komponent-
// modulet evalueres (modul-level const), derfor vi.hoisted
vi.hoisted(() => {
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN = 'pk.test';
});

/** fetch-mock: uuid-1 geokoder OK, alt andet fejler */
const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
  const url = String(input);
  if (url.includes('/adresser/uuid-1?')) {
    return { ok: true, json: async () => ({ x: 12.5, y: 55.7, betegnelse: 'Testvej 1' }) };
  }
  return { ok: false, json: async () => ({}) };
});

beforeEach(() => {
  _clearGeokodCache();
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('EjendomsKortPanel', () => {
  it('viser loading-state og derefter marker når geokodning lykkes', async () => {
    render(
      <EjendomsKortPanel
        items={[{ bfe: 100, adresse: 'Testvej 1', dawaId: 'uuid-1' }]}
        lang="da"
        onClose={() => {}}
      />
    );
    expect(screen.getByText('Geokoder ejendomme…')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('mock-map')).toBeInTheDocument());
    expect(screen.getByTestId('mock-marker')).toBeInTheDocument();
    expect(screen.getByText(/1 placeret på kortet/)).toBeInTheDocument();
  });

  it('viser empty-state når intet kunne geokodes', async () => {
    render(
      <EjendomsKortPanel
        items={[{ bfe: null, adresse: null, dawaId: 'uuid-ukendt' }]}
        lang="da"
        onClose={() => {}}
      />
    );
    await waitFor(() =>
      expect(screen.getByText('Ingen ejendomme kunne placeres på kortet')).toBeInTheDocument()
    );
  });

  it('luk-knappen har aria-label og kalder onClose', async () => {
    const onClose = vi.fn();
    render(<EjendomsKortPanel items={[]} lang="da" onClose={onClose} />);
    const knap = await screen.findByLabelText('Luk kortpanel');
    fireEvent.click(knap);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('panelet er en dialog med aria-modal og labelledby', () => {
    render(<EjendomsKortPanel items={[]} lang="en" onClose={() => {}} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAttribute('aria-labelledby', 'ejendomskort-titel');
    expect(screen.getByText('Properties on map')).toBeInTheDocument();
  });

  it('Escape-tasten lukker panelet', () => {
    const onClose = vi.fn();
    render(<EjendomsKortPanel items={[]} lang="da" onClose={onClose} />);
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
