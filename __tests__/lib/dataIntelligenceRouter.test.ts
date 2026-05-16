/**
 * Unit tests for Data Intelligence router + queryPlan (BIZZ-1563).
 *
 * Dækker:
 * - validateQueryPlan: metric/dimension lookup, filter-shapes, time-range,
 *   sort, limit-grænser
 * - resolvePreset: alle 9 presets → korrekte from/to ISO-datoer
 * - detectPersona: keyword-matching for journalist/finans/maegler/general
 *
 * Router.routeQuery() har Claude API som dependency og testes via integration
 * tests (separat — kræver BIZZASSIST_CLAUDE_KEY).
 */
import { describe, it, expect } from 'vitest';
import {
  validateQueryPlan,
  resolvePreset,
  type QueryPlan,
} from '@/app/lib/dataIntelligence/semantic/queryPlan';
import { detectPersona } from '@/app/lib/dataIntelligence/semantic/router';

describe('validateQueryPlan', () => {
  it('accepterer minimal valid plan', () => {
    const plan: QueryPlan = {
      metrics: ['count_virksomheder'],
      dimensions: [],
      filters: [],
    };
    expect(validateQueryPlan(plan).ok).toBe(true);
  });

  it('afviser plan uden metrics', () => {
    const plan: QueryPlan = { metrics: [], dimensions: [], filters: [] };
    const r = validateQueryPlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/mindst én metric/);
  });

  it('afviser ukendt metric', () => {
    const plan: QueryPlan = {
      metrics: ['hallucineret_metric'],
      dimensions: [],
      filters: [],
    };
    const r = validateQueryPlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.field).toBe('metrics');
      expect(r.reason).toMatch(/Ukendt metric/);
    }
  });

  it('afviser ukendt dimension', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: ['hallucineret_dim'],
      filters: [],
    };
    const r = validateQueryPlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('dimensions');
  });

  it('afviser filter med ukendt dimension', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'ukendt', op: 'eq', value: 1 }],
    };
    const r = validateQueryPlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('filters');
  });

  it('afviser "in" operator uden array-value', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune', op: 'in', value: 101 }],
    };
    const r = validateQueryPlan(plan);
    expect(r.ok).toBe(false);
  });

  it('accepterer "in" med array', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune', op: 'in', value: ['København', 'Aarhus'] }],
    };
    expect(validateQueryPlan(plan).ok).toBe(true);
  });

  it('afviser "between" uden tuple', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune_kode', op: 'between', value: 101 }],
    };
    expect(validateQueryPlan(plan).ok).toBe(false);
  });

  it('accepterer "between" med [min, max]', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune_kode', op: 'between', value: [100, 200] }],
    };
    expect(validateQueryPlan(plan).ok).toBe(true);
  });

  it('accepterer is_null uden value', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune', op: 'is_null' }],
    };
    expect(validateQueryPlan(plan).ok).toBe(true);
  });

  it('afviser timeRange med ukendt dimension', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      timeRange: { dimension: 'ukendt_dim', preset: 'last_12_months' },
    };
    const r = validateQueryPlan(plan);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.field).toBe('timeRange');
  });

  it('accepterer timeRange med preset', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: ['maaned'],
      filters: [],
      timeRange: { dimension: 'maaned', preset: 'last_12_months', grain: 'month' },
    };
    expect(validateQueryPlan(plan).ok).toBe(true);
  });

  it('afviser timeRange uden preset eller from/to', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      timeRange: { dimension: 'maaned' },
    };
    expect(validateQueryPlan(plan).ok).toBe(false);
  });

  it('afviser sort.by der ikke findes', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      sort: { by: 'fake_metric', direction: 'desc' },
    };
    expect(validateQueryPlan(plan).ok).toBe(false);
  });

  it('accepterer sort.by der refererer til metric', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      sort: { by: 'count_handler', direction: 'desc' },
    };
    expect(validateQueryPlan(plan).ok).toBe(true);
  });

  it('afviser limit > 10000', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      limit: 99999,
    };
    expect(validateQueryPlan(plan).ok).toBe(false);
  });

  it('afviser > 5 metrics', () => {
    const plan: QueryPlan = {
      metrics: Array(6).fill('count_handler'),
      dimensions: [],
      filters: [],
    };
    expect(validateQueryPlan(plan).ok).toBe(false);
  });
});

describe('resolvePreset', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('last_7_days returnerer 7 dages range', () => {
    const r = resolvePreset('last_7_days', now);
    expect(r.from).toBe('2026-05-09');
    expect(r.to).toBe('2026-05-16');
  });

  it('last_30_days returnerer 30 dages range', () => {
    const r = resolvePreset('last_30_days', now);
    expect(r.to).toBe('2026-05-16');
    // from = 30 dage før
    expect(r.from).toBe('2026-04-16');
  });

  it('last_12_months returnerer 1 år tilbage', () => {
    const r = resolvePreset('last_12_months', now);
    expect(r.from).toBe('2025-05-16');
    expect(r.to).toBe('2026-05-16');
  });

  it('ytd starter 1. januar', () => {
    const r = resolvePreset('ytd', now);
    expect(r.from).toBe('2026-01-01');
    expect(r.to).toBe('2026-05-16');
  });

  it('qtd starter på kvartalsstart', () => {
    // Maj 2026 → Q2 starter 1. april
    const r = resolvePreset('qtd', now);
    expect(r.from).toBe('2026-04-01');
  });

  it('mtd starter 1. i måneden', () => {
    const r = resolvePreset('mtd', now);
    expect(r.from).toBe('2026-05-01');
  });

  it('last_year returnerer hele forrige kalenderår', () => {
    const r = resolvePreset('last_year', now);
    expect(r.from).toBe('2025-01-01');
    expect(r.to).toBe('2026-01-01');
  });

  it('all_time returnerer 1900-now', () => {
    const r = resolvePreset('all_time', now);
    expect(r.from).toBe('1900-01-01');
    expect(r.to).toBe('2026-05-16');
  });
});

describe('detectPersona', () => {
  it('genkender journalist via "hvor mange"', () => {
    expect(detectPersona('Hvor mange virksomheder er der?')).toBe('journalist');
  });

  it('genkender journalist via "top 10"', () => {
    expect(detectPersona('Top 10 brancher efter aktivitet')).toBe('journalist');
  });

  it('genkender finans via "samlet værdi"', () => {
    expect(detectPersona('Hvad er den samlede værdi af koncernen?')).toBe('finans');
  });

  it('genkender finans via "porteføl"', () => {
    expect(detectPersona('Vis min porteføljes egenkapital')).toBe('finans');
  });

  it('genkender maegler via "m²-pris"', () => {
    expect(detectPersona('Gennemsnitlig m²-pris i Aarhus')).toBe('maegler');
  });

  it('genkender maegler via "parcelhus"', () => {
    expect(detectPersona('Sammenlignelige parcelhuse i 2900')).toBe('maegler');
  });

  it('fallback til general ved ingen keywords', () => {
    expect(detectPersona('Test query xyz')).toBe('general');
  });
});
