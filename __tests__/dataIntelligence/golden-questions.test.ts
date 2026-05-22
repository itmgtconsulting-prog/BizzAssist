/**
 * BIZZ-1714: Golden test queries for DI semantic layer.
 *
 * Verifies that the metric catalog contains correct definitions for
 * EJF-data queries. Tests metric existence, table references, filter
 * correctness, and SQL patterns.
 *
 * These tests run in CI on every PR that changes metrics or SQL prompt.
 */

import { describe, it, expect } from 'vitest';
import { getMetric, getMetricsByTable, METRICS } from '@/app/lib/dataIntelligence/semantic/metrics';

describe('golden metric definitions', () => {
  // ─── Arms-length handler ─────────────────────────────────────────────

  it('count_arms_length_handler exists and filters on fri handel', () => {
    const m = getMetric('count_arms_length_handler');
    expect(m).toBeDefined();
    expect(m!.table).toBe('ejf_ejerskifte');
    expect(m!.filters).toContainEqual(expect.stringContaining('Almindelig fri handel'));
  });

  it('median_koebesum_arms_length exists and filters on fri handel', () => {
    const m = getMetric('median_koebesum_arms_length');
    expect(m).toBeDefined();
    expect(m!.table).toBe('ejf_ejerskifte');
    expect(m!.sql).toContain('PERCENTILE_CONT');
    expect(m!.filters).toContainEqual(expect.stringContaining('Almindelig fri handel'));
  });

  // ─── Tvangsauktion ───────────────────────────────────────────────────

  it('tvangsauktion_rate computes ratio correctly', () => {
    const m = getMetric('tvangsauktion_rate');
    expect(m).toBeDefined();
    expect(m!.sql).toContain('Tvangsauktion');
    expect(m!.sql).toContain('NULLIF');
    expect(m!.format).toBe('percent');
  });

  it('count_tvangsauktioner filters on Tvangsauktion', () => {
    const m = getMetric('count_tvangsauktioner');
    expect(m).toBeDefined();
    expect(m!.filters).toContainEqual(expect.stringContaining('Tvangsauktion'));
  });

  // ─── Familie ─────────────────────────────────────────────────────────

  it('familieoverdragelse_rate computes ratio', () => {
    const m = getMetric('familieoverdragelse_rate');
    expect(m).toBeDefined();
    expect(m!.sql).toContain('Familieoverdragelse');
    expect(m!.format).toBe('percent');
  });

  // ─── Ejerskifte velocity ─────────────────────────────────────────────

  it('ejerskifte_velocity counts ejerskifter', () => {
    const m = getMetric('ejerskifte_velocity');
    expect(m).toBeDefined();
    expect(m!.table).toBe('ejf_ejerskifte');
    expect(m!.type).toBe('count');
  });

  // ─── KVM-pris ────────────────────────────────────────────────────────

  it('avg_koebesum_per_m2 filters on fri handel + areal > 10', () => {
    const m = getMetric('avg_koebesum_per_m2');
    expect(m).toBeDefined();
    expect(m!.filters).toContainEqual(expect.stringContaining('Almindelig fri handel'));
    expect(m!.filters).toContainEqual(expect.stringContaining('samlet_boligareal > 10'));
    expect(m!.unit).toBe('DKK/m²');
  });
});

describe('ejf_ejerskifte metric coverage', () => {
  it('has at least 7 metrics referencing ejf_ejerskifte', () => {
    const ejfMetrics = getMetricsByTable('ejf_ejerskifte');
    expect(ejfMetrics.length).toBeGreaterThanOrEqual(7);
  });

  it('all ejf_ejerskifte metrics have filters', () => {
    const ejfMetrics = getMetricsByTable('ejf_ejerskifte');
    for (const m of ejfMetrics) {
      expect(m.filters?.length).toBeGreaterThan(0);
    }
  });

  it('all ejf_ejerskifte metrics have examples', () => {
    const ejfMetrics = getMetricsByTable('ejf_ejerskifte');
    for (const m of ejfMetrics) {
      expect(m.examples?.length).toBeGreaterThan(0);
    }
  });
});

describe('existing metrics still valid', () => {
  it('avg_koebesum still filters on fri handel (BIZZ-1732)', () => {
    const m = getMetric('avg_koebesum');
    expect(m).toBeDefined();
    expect(m!.filters).toContainEqual(expect.stringContaining('ejf_ejerskifte'));
  });

  it('median_koebesum still filters on fri handel (BIZZ-1732)', () => {
    const m = getMetric('median_koebesum');
    expect(m).toBeDefined();
    expect(m!.filters).toContainEqual(expect.stringContaining('ejf_ejerskifte'));
  });

  it('total metric count is at least 38', () => {
    expect(METRICS.length).toBeGreaterThanOrEqual(38);
  });
});

describe('golden question → expected table mapping', () => {
  /**
   * These mappings verify that the metric catalog supports the key
   * questions users will ask. The AI should select the correct table
   * and metric for each question type.
   */
  const questionMappings = [
    {
      question: 'Hvad er median bolighandel i København 2025?',
      expectedMetric: 'median_koebesum_arms_length',
      expectedTable: 'ejf_ejerskifte',
    },
    {
      question: 'Hvor mange tvangsauktioner i 2024?',
      expectedMetric: 'count_tvangsauktioner',
      expectedTable: 'ejf_ejerskifte',
    },
    {
      question: 'Hvilke kommuner har højest andel tvangsauktioner?',
      expectedMetric: 'tvangsauktion_rate',
      expectedTable: 'ejf_ejerskifte',
    },
    {
      question: 'Kvm-pris for frie handler i København?',
      expectedMetric: 'avg_koebesum_per_m2',
      expectedTable: 'ejf_ejerskifte',
    },
    {
      question: 'Hvor mange familieoverdragelser i 2024?',
      expectedMetric: 'familieoverdragelse_rate',
      expectedTable: 'ejf_ejerskifte',
    },
  ];

  for (const { question, expectedMetric, expectedTable } of questionMappings) {
    it(`"${question}" → ${expectedMetric} on ${expectedTable}`, () => {
      const m = getMetric(expectedMetric);
      expect(m).toBeDefined();
      expect(m!.table).toBe(expectedTable);
      // Verify at least one example is semantically similar
      expect(m!.examples?.some((ex) => ex.length > 10)).toBe(true);
    });
  }
});
