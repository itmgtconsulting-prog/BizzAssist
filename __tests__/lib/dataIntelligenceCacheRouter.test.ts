/**
 * Unit tests for Data Intelligence cache-router (BIZZ-1565, L3).
 *
 * Dækker:
 * - isScalarLookup: detection af plans der kan caches som scorecard
 * - buildScorecardKey: mapping fra metric til scorecard-key
 * - hashPlanForCache: stabilt fingerprint (sort-uafhængigt)
 * - tryScorecardLookup: hit/miss + error-handling
 * - tryMvMatch: tom registry returnerer null
 * - findMatchingMv: subset-matching (når MV'er tilføjes)
 */
import { describe, it, expect, vi } from 'vitest';
import {
  buildScorecardKey,
  hashPlanForCache,
  isScalarLookup,
  tryCacheLayers,
  tryMvMatch,
  tryScorecardLookup,
  type ScorecardReader,
} from '@/app/lib/dataIntelligence/semantic/cacheRouter';
import { findMatchingMv, MV_REGISTRY } from '@/app/lib/dataIntelligence/semantic/mvCatalog';
import type { QueryPlan } from '@/app/lib/dataIntelligence/semantic/queryPlan';

describe('isScalarLookup', () => {
  it('genkender 1-metric-0-dim-0-filter plan', () => {
    expect(isScalarLookup({ metrics: ['count_handler'], dimensions: [], filters: [] })).toBe(true);
  });
  it('afviser plan med dimensions', () => {
    expect(isScalarLookup({ metrics: ['count_handler'], dimensions: ['aar'], filters: [] })).toBe(
      false
    );
  });
  it('afviser plan med filtre', () => {
    expect(
      isScalarLookup({
        metrics: ['count_handler'],
        dimensions: [],
        filters: [{ dimension: 'kommune_kode', op: 'eq', value: 101 }],
      })
    ).toBe(false);
  });
  it('afviser plan med timeRange', () => {
    expect(
      isScalarLookup({
        metrics: ['count_handler'],
        dimensions: [],
        filters: [],
        timeRange: { dimension: 'dato', preset: 'last_30_days' },
      })
    ).toBe(false);
  });
  it('afviser plan med 2+ metrics', () => {
    expect(
      isScalarLookup({
        metrics: ['count_handler', 'avg_koebesum'],
        dimensions: [],
        filters: [],
      })
    ).toBe(false);
  });
});

describe('buildScorecardKey', () => {
  it('returnerer metric-navn for simpel count', () => {
    expect(buildScorecardKey({ metrics: ['count_handler'], dimensions: [], filters: [] })).toBe(
      'count_handler'
    );
  });
  it('mapper sum_koebesum til _alle-variant', () => {
    expect(buildScorecardKey({ metrics: ['sum_koebesum'], dimensions: [], filters: [] })).toBe(
      'sum_koebesum_alle'
    );
  });
  it('returnerer null for non-scalar plan', () => {
    expect(
      buildScorecardKey({
        metrics: ['count_handler'],
        dimensions: ['aar'],
        filters: [],
      })
    ).toBe(null);
  });
  it('returnerer null for ukendt metric', () => {
    expect(buildScorecardKey({ metrics: ['hallucineret'], dimensions: [], filters: [] })).toBe(
      null
    );
  });
});

describe('hashPlanForCache', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('producerer 32-tegn hex', () => {
    const h = hashPlanForCache({ metrics: ['count_handler'], dimensions: [], filters: [] }, now);
    expect(h).toMatch(/^[a-f0-9]{32}$/);
  });

  it('returnerer samme hash for equivalente plans', () => {
    const a: QueryPlan = {
      metrics: ['count_handler', 'avg_koebesum'],
      dimensions: ['kommune', 'aar'],
      filters: [
        { dimension: 'kommune_kode', op: 'in', value: [101, 147] },
        { dimension: 'ejer_type', op: 'eq', value: 'virksomhed' },
      ],
    };
    const b: QueryPlan = {
      metrics: ['avg_koebesum', 'count_handler'],
      dimensions: ['aar', 'kommune'],
      filters: [
        { dimension: 'ejer_type', op: 'eq', value: 'virksomhed' },
        { dimension: 'kommune_kode', op: 'in', value: [147, 101] },
      ],
    };
    expect(hashPlanForCache(a, now)).toBe(hashPlanForCache(b, now));
  });

  it('returnerer forskellig hash for forskellige metrics', () => {
    const a: QueryPlan = { metrics: ['count_handler'], dimensions: [], filters: [] };
    const b: QueryPlan = { metrics: ['count_virksomheder'], dimensions: [], filters: [] };
    expect(hashPlanForCache(a, now)).not.toBe(hashPlanForCache(b, now));
  });

  it('inkluderer preset-resolution i hash', () => {
    const a: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      timeRange: { dimension: 'dato', preset: 'last_30_days' },
    };
    const h1 = hashPlanForCache(a, new Date('2026-05-16T12:00:00Z'));
    const h2 = hashPlanForCache(a, new Date('2026-06-16T12:00:00Z'));
    // Preset resolveres til forskellige datoer → hash skal være forskellig
    expect(h1).not.toBe(h2);
  });
});

describe('tryScorecardLookup', () => {
  function mockReader(
    rows: Record<string, Awaited<ReturnType<ScorecardReader['fetchOne']>>>
  ): ScorecardReader {
    return {
      fetchOne: vi.fn(async (key: string) => rows[key] ?? null),
    };
  }

  it('returnerer ScorecardResult ved hit', async () => {
    const reader = mockReader({
      count_handler: {
        value_numeric: '12345',
        display_name: 'Antal handler',
        unit: 'antal',
        format: 'integer',
        refreshed_at: '2026-05-16T04:00:00Z',
      },
    });
    const r = await tryScorecardLookup(
      { metrics: ['count_handler'], dimensions: [], filters: [] },
      reader
    );
    expect(r).not.toBeNull();
    expect(r?.layer).toBe('scorecard');
    expect(r?.key).toBe('count_handler');
    expect(r?.value).toBe(12345);
    expect(r?.format).toBe('integer');
  });

  it('returnerer null ved miss', async () => {
    const reader = mockReader({});
    const r = await tryScorecardLookup(
      { metrics: ['count_handler'], dimensions: [], filters: [] },
      reader
    );
    expect(r).toBeNull();
  });

  it('returnerer null for non-scalar plan (ingen reader-kald)', async () => {
    const reader = mockReader({});
    const r = await tryScorecardLookup(
      { metrics: ['count_handler'], dimensions: ['aar'], filters: [] },
      reader
    );
    expect(r).toBeNull();
    expect(reader.fetchOne).not.toHaveBeenCalled();
  });

  it('fail-soft: returnerer null hvis reader kaster', async () => {
    const reader: ScorecardReader = {
      fetchOne: vi.fn(async () => {
        throw new Error('db unreachable');
      }),
    };
    const r = await tryScorecardLookup(
      { metrics: ['count_handler'], dimensions: [], filters: [] },
      reader
    );
    expect(r).toBeNull();
  });
});

describe('mvCatalog', () => {
  it('MV_REGISTRY er tom indtil follow-up', () => {
    expect(MV_REGISTRY).toHaveLength(0);
  });

  it('tryMvMatch returnerer null på tom registry', () => {
    expect(
      tryMvMatch({ metrics: ['count_handler'], dimensions: ['kommune'], filters: [] })
    ).toBeNull();
  });

  it('findMatchingMv kræver præcis dimensions-match', () => {
    // Test logik direkte ved at injicere en MV
    MV_REGISTRY.push({
      name: 'test_mv',
      schema: 'public',
      metrics: ['count_handler', 'avg_koebesum'],
      dimensions: ['kommune_kode', 'maaned'],
      metricColumns: {
        count_handler: 'count_handler',
        avg_koebesum: 'avg_koebesum',
      },
      dimensionColumns: { kommune_kode: 'kommune_kode', maaned: 'maaned' },
      description: 'test',
    });
    try {
      // Match
      expect(
        findMatchingMv({
          metrics: ['count_handler'],
          dimensions: ['kommune_kode', 'maaned'],
          filters: [],
        })
      ).not.toBeNull();
      // Miss: andre dimensions
      expect(
        findMatchingMv({
          metrics: ['count_handler'],
          dimensions: ['aar'],
          filters: [],
        })
      ).toBeNull();
      // Miss: ukendt metric
      expect(
        findMatchingMv({
          metrics: ['count_handler', 'sum_omsaetning'],
          dimensions: ['kommune_kode', 'maaned'],
          filters: [],
        })
      ).toBeNull();
    } finally {
      MV_REGISTRY.pop();
    }
  });
});

describe('tryCacheLayers — orchestration', () => {
  it('returnerer scorecard ved hit (springer mv/redis over)', async () => {
    const reader: ScorecardReader = {
      fetchOne: vi.fn(async () => ({
        value_numeric: 42,
        display_name: 'Antal handler',
        unit: 'antal',
        format: 'integer' as const,
        refreshed_at: '2026-05-16T04:00:00Z',
      })),
    };
    const r = await tryCacheLayers(
      { metrics: ['count_handler'], dimensions: [], filters: [] },
      { scorecardReader: reader, skipRedis: true }
    );
    expect(r?.layer).toBe('scorecard');
  });

  it('returnerer null hvis alle lag misser', async () => {
    const reader: ScorecardReader = {
      fetchOne: vi.fn(async () => null),
    };
    const r = await tryCacheLayers(
      { metrics: ['count_handler'], dimensions: ['aar'], filters: [] },
      { scorecardReader: reader, skipRedis: true }
    );
    expect(r).toBeNull();
  });
});
