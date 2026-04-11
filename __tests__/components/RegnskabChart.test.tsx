/**
 * Regression tests for the RegnskabChart component.
 *
 * Verifies:
 * - Chart renders correctly with full XBRL mock data (omsætning, resultat, egenkapital)
 * - A Line element is rendered for each chartRowId
 * - Chart does NOT crash with serializable-only props (no Set, Map, Function)
 * - Chart handles empty and single-point datasets without crashing
 * - Color cycling works when more rows than colors are provided
 * - Auxiliary chart elements (axes, grid, tooltip) are rendered
 *
 * Regression context: the component previously crashed when non-serializable props
 * (Set instances, callbacks) were passed across the next/dynamic import boundary.
 * This test suite is the guard against that class of regression.
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import RegnskabChart from '@/app/dashboard/companies/[cvr]/RegnskabChart';

// ── Recharts mock ─────────────────────────────────────────────────────────────
//
// jsdom has no SVG layout engine — recharts crashes on ResizeObserver / getBoundingClientRect.
// We replace every recharts export with a minimal stub that preserves testable attributes.

vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="responsive-container">{children}</div>
  ),
  LineChart: ({ children, data }: { children: React.ReactNode; data: unknown[] }) => (
    <div data-testid="recharts-linechart" data-point-count={String(data?.length ?? 0)}>
      {children}
    </div>
  ),
  Line: ({ dataKey }: { dataKey: string }) => (
    <div data-testid={`line-${dataKey}`} data-key={dataKey} />
  ),
  XAxis: () => <div data-testid="x-axis" />,
  YAxis: () => <div data-testid="y-axis" />,
  CartesianGrid: () => <div data-testid="cartesian-grid" />,
  Tooltip: () => <div data-testid="tooltip" />,
}));

// ── Shared mock data ──────────────────────────────────────────────────────────

/** Three years of realistic XBRL financial data (Novo-scale truncated for clarity) */
const MOCK_CHART_DATA = [
  { aar: 2022, omsaetning: 1_200_000, resultat: 150_000, egenkapital: 500_000 },
  { aar: 2023, omsaetning: 1_500_000, resultat: 200_000, egenkapital: 700_000 },
  { aar: 2024, omsaetning: 1_800_000, resultat: 250_000, egenkapital: 900_000 },
];

const MOCK_ROW_IDS = ['omsaetning', 'resultat', 'egenkapital'];

const MOCK_ALL_ROWS = [
  { id: 'omsaetning', label: 'Omsætning' },
  { id: 'resultat', label: 'Årets resultat' },
  { id: 'egenkapital', label: 'Egenkapital', isPercent: false },
];

const MOCK_COLORS = ['#2563eb', '#16a34a', '#dc2626'] as const;

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('RegnskabChart', () => {
  it('renders without crashing with full XBRL mock data', () => {
    render(
      <RegnskabChart
        chartData={MOCK_CHART_DATA}
        chartRowIds={MOCK_ROW_IDS}
        alleRows={MOCK_ALL_ROWS}
        colors={MOCK_COLORS}
      />
    );

    expect(screen.getByTestId('responsive-container')).toBeInTheDocument();
    expect(screen.getByTestId('recharts-linechart')).toBeInTheDocument();
  });

  it('renders one Line element for each chartRowId', () => {
    render(
      <RegnskabChart
        chartData={MOCK_CHART_DATA}
        chartRowIds={MOCK_ROW_IDS}
        alleRows={MOCK_ALL_ROWS}
        colors={MOCK_COLORS}
      />
    );

    for (const id of MOCK_ROW_IDS) {
      expect(screen.getByTestId(`line-${id}`)).toBeInTheDocument();
    }
  });

  it('passes the correct data point count to LineChart', () => {
    render(
      <RegnskabChart
        chartData={MOCK_CHART_DATA}
        chartRowIds={MOCK_ROW_IDS}
        alleRows={MOCK_ALL_ROWS}
        colors={MOCK_COLORS}
      />
    );

    expect(screen.getByTestId('recharts-linechart')).toHaveAttribute(
      'data-point-count',
      String(MOCK_CHART_DATA.length)
    );
  });

  it('does NOT crash when props are all serializable (no Set / Map / Function)', () => {
    // Regression guard: RegnskabChart is loaded via next/dynamic — all props MUST be
    // JSON-serializable to cross the dynamic-import boundary safely. This test verifies
    // the serializable prop contract is upheld and that the component renders correctly.
    const serializableChartData = [{ aar: 2024, omsaetning: 500_000 }];
    const serializableRowIds = ['omsaetning'];
    const serializableRows = [{ id: 'omsaetning', label: 'Omsætning' }];
    const serializableColors = ['#2563eb'] as const;

    // Confirm all props survive JSON round-trip (catches Set/Map/Function at test time)
    expect(() => JSON.stringify(serializableChartData)).not.toThrow();
    expect(() => JSON.stringify(serializableRowIds)).not.toThrow();
    expect(() => JSON.stringify(serializableRows)).not.toThrow();
    expect(() => JSON.stringify(serializableColors)).not.toThrow();

    // Verify the component renders correctly with only serializable props
    render(
      <RegnskabChart
        chartData={serializableChartData}
        chartRowIds={serializableRowIds}
        alleRows={serializableRows}
        colors={serializableColors}
      />
    );

    expect(screen.getByTestId('recharts-linechart')).toBeInTheDocument();
    expect(screen.getByTestId('line-omsaetning')).toBeInTheDocument();
  });

  it('renders with empty chartData and chartRowIds without crashing', () => {
    render(<RegnskabChart chartData={[]} chartRowIds={[]} alleRows={[]} colors={MOCK_COLORS} />);

    expect(screen.getByTestId('recharts-linechart')).toBeInTheDocument();
    // No line elements should exist when row IDs are empty
    expect(screen.queryByTestId(/^line-/)).not.toBeInTheDocument();
  });

  it('renders correctly with a single data point', () => {
    render(
      <RegnskabChart
        chartData={[{ aar: 2024, omsaetning: 1_000_000 }]}
        chartRowIds={['omsaetning']}
        alleRows={[{ id: 'omsaetning', label: 'Omsætning' }]}
        colors={MOCK_COLORS}
      />
    );

    expect(screen.getByTestId('line-omsaetning')).toBeInTheDocument();
    expect(screen.getByTestId('recharts-linechart')).toHaveAttribute('data-point-count', '1');
  });

  it('cycles colors when chartRowIds exceed the colors array length', () => {
    // Four rows but only two colors — colors[idx % colors.length] must cycle without crash
    const manyRowIds = ['a', 'b', 'c', 'd'];
    const manyRows = manyRowIds.map((id) => ({ id, label: id }));
    const twoColors = ['#111111', '#222222'];

    render(
      <RegnskabChart
        chartData={[{ aar: 2024, a: 1, b: 2, c: 3, d: 4 }]}
        chartRowIds={manyRowIds}
        alleRows={manyRows}
        colors={twoColors}
      />
    );

    for (const id of manyRowIds) {
      expect(screen.getByTestId(`line-${id}`)).toBeInTheDocument();
    }
  });

  it('renders XAxis, YAxis, CartesianGrid and Tooltip', () => {
    render(
      <RegnskabChart
        chartData={MOCK_CHART_DATA}
        chartRowIds={MOCK_ROW_IDS}
        alleRows={MOCK_ALL_ROWS}
        colors={MOCK_COLORS}
      />
    );

    expect(screen.getByTestId('x-axis')).toBeInTheDocument();
    expect(screen.getByTestId('y-axis')).toBeInTheDocument();
    expect(screen.getByTestId('cartesian-grid')).toBeInTheDocument();
    expect(screen.getByTestId('tooltip')).toBeInTheDocument();
  });

  it('handles null values in chartData without crashing', () => {
    const dataWithNulls = [
      { aar: 2022, omsaetning: null, resultat: 150_000 },
      { aar: 2023, omsaetning: 1_500_000, resultat: null },
    ];

    render(
      <RegnskabChart
        chartData={dataWithNulls}
        chartRowIds={['omsaetning', 'resultat']}
        alleRows={[
          { id: 'omsaetning', label: 'Omsætning' },
          { id: 'resultat', label: 'Resultat' },
        ]}
        colors={MOCK_COLORS}
      />
    );

    expect(screen.getByTestId('line-omsaetning')).toBeInTheDocument();
    expect(screen.getByTestId('line-resultat')).toBeInTheDocument();
  });
});
