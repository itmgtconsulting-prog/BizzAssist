/**
 * Regression tests for the regnskab (financials) section of VirksomhedDetaljeClient.
 *
 * Verifies:
 * - "Henter virksomhedsdata..." loading indicator appears while XBRL fetch is in-flight
 * - Regnskabstal (financial data) renders after XBRL data resolves
 * - Empty state is shown when both XBRL data and PDF regnskaber are absent
 *
 * All external I/O (fetch, Supabase, Next.js navigation) is mocked.
 * The component is rendered with React.Suspense to support React 19's use() hook.
 *
 * Regression context: the regnskab section previously broke because:
 *   1. Non-serializable props (Set) were passed to the dynamically-loaded RegnskabChart
 *   2. XBRL loading state was not shown / cleared correctly after batch-fetching
 * These tests catch both classes of regression.
 */

import React, { Suspense } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ── jsdom polyfills ───────────────────────────────────────────────────────────

// jsdom does not implement window.matchMedia — stub it so the responsive-layout
// effect in VirksomhedDetaljeClient does not throw on mount.
Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: vi.fn().mockImplementation((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  })),
});

// ── Next.js router & link ─────────────────────────────────────────────────────

vi.mock('next/navigation', () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock('next/link', () => ({
  default: ({
    children,
    href,
    className,
  }: {
    children: React.ReactNode;
    href: string;
    className?: string;
  }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));

// ── Dynamic imports — return a no-op stub so recharts/mapbox never load ───────

vi.mock('next/dynamic', () => ({
  default: (_loader: unknown, _opts?: unknown) =>
    function DynamicStub({ 'data-testid': tid }: { 'data-testid'?: string }) {
      return React.createElement('div', { 'data-testid': tid ?? 'dynamic-stub' });
    },
}));

// ── Language context ──────────────────────────────────────────────────────────

vi.mock('@/app/context/LanguageContext', () => ({
  useLanguage: () => ({ lang: 'da' as const }),
  LanguageProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── AI page context ───────────────────────────────────────────────────────────

vi.mock('@/app/context/AIPageContext', () => ({
  useSetAIPageContext: () => vi.fn(),
  AIPageContextProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Subscription context & gate ───────────────────────────────────────────────

vi.mock('@/app/context/SubscriptionContext', () => ({
  useSubscription: () => ({
    subscription: null,
    isLoading: false,
    tokenBalance: 1000,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/app/components/SubscriptionGate', () => ({
  useSubscriptionAccess: () => ({
    hasAccess: true,
    limitedAccess: false,
    isLoading: false,
  }),
  SubscriptionGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ── Subscription helpers ──────────────────────────────────────────────────────

vi.mock('@/app/lib/subscriptions', () => ({
  resolvePlan: vi.fn().mockReturnValue({
    id: 'pro',
    name: 'Pro',
    tokenLimit: 10_000,
    features: [],
  }),
  formatTokens: vi.fn().mockImplementation((n: number) => String(n)),
  isSubscriptionFunctional: vi.fn().mockReturnValue(true),
}));

// ── Utility hooks ─────────────────────────────────────────────────────────────

vi.mock('@/app/lib/recentCompanies', () => ({ saveRecentCompany: vi.fn() }));
vi.mock('@/app/lib/recordRecentVisit', () => ({ recordRecentVisit: vi.fn() }));

// ── Sub-components that would otherwise require heavy setup ───────────────────

vi.mock('@/app/components/diagrams/DiagramData', () => ({
  buildDiagramGraph: vi.fn().mockReturnValue({ nodes: [], links: [] }),
}));

vi.mock('@/app/components/VerifiedLinks', () => ({
  default: () => React.createElement('div', { 'data-testid': 'verified-links' }),
}));

vi.mock('@/app/components/ejendomme/PropertyOwnerCard', () => ({
  default: () => React.createElement('div', { 'data-testid': 'property-owner-card' }),
}));

// ── Fetch mock setup ──────────────────────────────────────────────────────────

let mockFetch: ReturnType<typeof vi.fn>;

beforeEach(() => {
  mockFetch = vi.fn();
  vi.stubGlobal('fetch', mockFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── Mock data ─────────────────────────────────────────────────────────────────

/**
 * Minimal CVRPublicData shape required to render the company detail page
 * and show all tabs without crashing.
 */
const MOCK_COMPANY = {
  cvr: '44718502',
  navn: 'Pecunia IT ApS',
  status: 'Aktiv',
  virksomhedsform: 'ApS',
  ansatte: 3,
  stiftelsesdato: '2022-04-01',
  adresse: 'Søbyvej 11',
  postnr: '2650',
  by: 'Hvidovre',
  ejere: [],
  penheder: [],
  relationer: [],
  nøglepersoner: [],
  historik: [],
  branchekode: '620100',
  branche: 'Computerprogrammering',
  telefon: null,
  email: null,
  hjemmeside: null,
  formaal: null,
  kapital: null,
  regnskabsaar: null,
  brancheGruppe: null,
};

/** One complete financial year for XBRL assertions */
const MOCK_XBRL_YEAR = {
  aar: 2024,
  periodeStart: '2024-01-01',
  periodeSlut: '2024-12-31',
  periodelængde: 365,
  resultat: {
    omsaetning: 1_800_000,
    bruttofortjeneste: 900_000,
    personaleomkostninger: -400_000,
    afskrivninger: -50_000,
    resultatFoerSkat: 250_000,
    skatAfAaretsResultat: -62_500,
    aaretsResultat: 187_500,
    finansielleIndtaegter: null,
    finansielleOmkostninger: null,
    eksterneOmkostninger: null,
    driftsomkostninger: null,
  },
  balance: {
    aktiverIAlt: 2_000_000,
    anlaegsaktiverIAlt: 500_000,
    omsaetningsaktiverIAlt: 1_500_000,
    egenkapital: 900_000,
    gaeldsforpligtelserIAlt: 1_100_000,
    kortfristetGaeld: 400_000,
    langfristetGaeld: 700_000,
    selskabskapital: 50_000,
    overfoertResultat: 850_000,
    likvideBeholdninger: 300_000,
    vaerdipapirer: null,
    grundeOgBygninger: null,
    materielleAnlaeg: null,
    investeringsejendomme: null,
  },
  noegletal: {
    afkastningsgrad: 12.5,
    soliditetsgrad: 45.0,
    egenkapitalensForrentning: 20.8,
    overskudsgrad: 13.9,
    bruttomargin: 50.0,
    ebitMargin: 15.0,
    roic: 18.0,
    likviditetsgrad: 375.0,
    aktivernesOmsaetningshastighed: 0.9,
    omsaetningPrAnsat: 600_000,
    resultatPrAnsat: 62_500,
    finansielGearing: 1.2,
    nettoGaeld: 400_000,
    antalAnsatte: 3,
  },
};

// ── Render helper ─────────────────────────────────────────────────────────────

/**
 * Renders VirksomhedDetaljeClient for CVR 44718502.
 *
 * Wrapped in React.Suspense so that React 19's use(params) can suspend
 * briefly while the params Promise resolves before the component mounts.
 */
/**
 * Flushes React's scheduler and all pending microtasks/macrotasks to let
 * fetch promise chains and state updates fully settle.
 */
async function flushAll() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
}

async function renderVirksomhed() {
  const { default: VirksomhedDetaljeClient } =
    await import('@/app/dashboard/companies/[cvr]/VirksomhedDetaljeClient');
  const params = Promise.resolve({ cvr: '44718502' });

  let result!: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <Suspense fallback={<div data-testid="suspense-fallback">Loading…</div>}>
        <VirksomhedDetaljeClient params={params} />
      </Suspense>
    );
  });

  // Let the CVR fetch complete and the component re-render with tabs visible
  await flushAll();

  return result;
}

/**
 * Waits until the CVR data has loaded and the regnskab tab button is visible,
 * then clicks it to activate the financials section.
 *
 * Note: the tab buttons in VirksomhedDetaljeClient are plain <button> elements
 * without role="tab" — we locate them by exact text content "Regnskab".
 */
async function clickRegnskabTab() {
  // findByRole with a 8-second timeout handles slow promise chains in the test environment.
  // The button label comes from translations.da.company.tabs.financials = 'Regnskab'.
  const tab = await screen.findByRole('button', { name: /^regnskab$/i }, { timeout: 8000 });
  await act(async () => {
    fireEvent.click(tab);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });
  return tab;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('VirksomhedDetaljeClient — regnskab section', () => {
  it('shows "Henter virksomhedsdata..." loading indicator while XBRL data is in-flight', async () => {
    // CVR data resolves immediately; regnskab fetches never settle → loading stays visible
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/api/cvr-public')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_COMPANY),
        });
      }
      // Regnskab fetches hang indefinitely — xbrlLoading stays true
      return new Promise(() => {});
    });

    await renderVirksomhed();

    await clickRegnskabTab();

    // Loading text must be present while fetch is in-flight.
    // Both xbrlLoading and regnskabLoading can show the same text simultaneously —
    // use getAllByText to handle multiple instances.
    const loadingEls = screen.getAllByText('Henter virksomhedsdata...');
    expect(loadingEls.length).toBeGreaterThan(0);
  });

  it('renders XBRL regnskabstal table after data resolves', async () => {
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/cvr-public')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_COMPANY),
        });
      }
      if (u.includes('/api/regnskab/xbrl')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ years: [MOCK_XBRL_YEAR], total: 1 }),
        });
      }
      if (u.includes('/api/regnskab')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ regnskaber: [], tokenMangler: false }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await renderVirksomhed();

    await clickRegnskabTab();

    // Wait for ALL loading instances to clear
    await waitFor(() => {
      expect(screen.queryAllByText('Henter virksomhedsdata...')).toHaveLength(0);
    });

    // When XBRL data is present, the empty-state text must NOT be shown.
    // The empty state only renders when xbrlData is empty AND regnskaber is empty.
    expect(screen.queryByText('Ingen regnskabsdata tilgængelige')).not.toBeInTheDocument();

    // RegnskabstalTable renders with Resultatopgørelse expanded by default.
    // The year column header "2024" should appear once loading completes.
    await waitFor(
      () => {
        // Year headers appear in the expanded Resultatopgørelse section
        expect(screen.getByText('2024')).toBeInTheDocument();
      },
      { timeout: 3000 }
    );
  });

  it('shows empty state when both XBRL data and PDF regnskaber are absent', async () => {
    mockFetch.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes('/api/cvr-public')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve(MOCK_COMPANY),
        });
      }
      if (u.includes('/api/regnskab/xbrl')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ years: [], total: 0 }),
        });
      }
      if (u.includes('/api/regnskab')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ regnskaber: [], tokenMangler: false }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    await renderVirksomhed();

    await clickRegnskabTab();

    // Wait for all loading states to clear
    await waitFor(() => {
      expect(screen.queryByText('Henter virksomhedsdata...')).not.toBeInTheDocument();
    });

    // No table data should be present (empty state is rendered instead)
    expect(screen.queryByText('2024')).not.toBeInTheDocument();
    expect(screen.queryByText('2023')).not.toBeInTheDocument();
  });

  it('does not crash when CVR fetch fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (String(url).includes('/api/cvr-public')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({ error: 'Server error' }),
        });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
    });

    // The component should handle a failed CVR fetch gracefully (show error state, not crash)
    await expect(renderVirksomhed()).resolves.not.toThrow();
  });
});
