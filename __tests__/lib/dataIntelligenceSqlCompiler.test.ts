/**
 * Unit tests for Data Intelligence SQL-compiler (BIZZ-1564).
 *
 * Dækker:
 * - escapeSqlLiteral: string/number/boolean/null + injection-attempts
 * - compileQueryPlan: minimal plan, metric+dim, joins, filters, timeRange,
 *   sort, limit clamping, default-filtre fra metrics
 * - executeQueryPlan: integration med mock runner
 */
import { describe, it, expect, vi } from 'vitest';
import {
  compileQueryPlan,
  escapeSqlLiteral,
  executeQueryPlan,
} from '@/app/lib/dataIntelligence/semantic/sqlCompiler';
import type { QueryPlan } from '@/app/lib/dataIntelligence/semantic/queryPlan';

describe('escapeSqlLiteral', () => {
  it('escaper strings med single quotes', () => {
    expect(escapeSqlLiteral("O'Brien")).toBe("'O''Brien'");
  });
  it('returnerer NULL for null/undefined', () => {
    expect(escapeSqlLiteral(null)).toBe('NULL');
    expect(escapeSqlLiteral(undefined)).toBe('NULL');
  });
  it('formaterer numbers raw', () => {
    expect(escapeSqlLiteral(42)).toBe('42');
    expect(escapeSqlLiteral(3.14)).toBe('3.14');
  });
  it('formaterer booleans som TRUE/FALSE', () => {
    expect(escapeSqlLiteral(true)).toBe('TRUE');
    expect(escapeSqlLiteral(false)).toBe('FALSE');
  });
  it('afviser non-finite numbers', () => {
    expect(() => escapeSqlLiteral(NaN)).toThrow();
    expect(() => escapeSqlLiteral(Infinity)).toThrow();
  });
  it('strip NUL-bytes', () => {
    expect(escapeSqlLiteral('a\0b')).toBe("'ab'");
  });
  it('escaper injection-forsøg', () => {
    const evil = "'; DROP TABLE users; --";
    const escaped = escapeSqlLiteral(evil);
    expect(escaped).toBe("'''; DROP TABLE users; --'");
    // Stadig en enkelt sluttet streng — ingen unescaped quote
    expect((escaped.match(/'/g) ?? []).length % 2).toBe(0);
  });
});

describe('compileQueryPlan — minimal', () => {
  it('genererer SELECT/FROM/LIMIT for simpel count', () => {
    const plan: QueryPlan = {
      metrics: ['count_virksomheder'],
      dimensions: [],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/SELECT COUNT\(\*\) AS count_virksomheder/);
    expect(r.query.sql).toMatch(/FROM public\.cvr_virksomhed/);
    expect(r.query.sql).toMatch(/LIMIT 100/);
    expect(r.query.baseTable).toBe('cvr_virksomhed');
    expect(r.query.columns).toHaveLength(1);
    expect(r.query.columns[0].source).toBe('metric');
  });

  it('inkluderer default-filtre fra metric', () => {
    const plan: QueryPlan = {
      metrics: ['count_virksomheder_aktive'],
      dimensions: [],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/WHERE ophoert IS NULL/);
  });

  it('dedupliker default-filtre når flere metrics deler dem', () => {
    const plan: QueryPlan = {
      metrics: ['sum_koebesum', 'avg_koebesum'],
      dimensions: [],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 'kontant_koebesum IS NOT NULL' bør kun forekomme én gang
    const matches = r.query.sql.match(/kontant_koebesum IS NOT NULL/g) ?? [];
    expect(matches.length).toBe(1);
  });
});

describe('compileQueryPlan — dimensions + GROUP BY', () => {
  it('genererer GROUP BY for dimensions', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: ['aar'],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/GROUP BY 1/);
    expect(r.query.sql).toMatch(/EXTRACT\(YEAR FROM overtagelsesdato\)/);
  });

  it('default-sorterer på første metric DESC ved dimensions', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: ['aar'],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/ORDER BY count_handler DESC NULLS LAST/);
  });
});

describe('compileQueryPlan — joins', () => {
  it('joiner til kommune_ref for kommune-dimension', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: ['kommune'],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/LEFT JOIN public\.kommune_ref/);
    expect(r.query.joinedTables).toContain('kommune_ref');
  });

  it('finder multi-hop sti via cvr_virksomhed', () => {
    // regnskab_cache → cvr_virksomhed → ejf_ejerskab → bbr_ejendom_status
    const plan: QueryPlan = {
      metrics: ['sum_omsaetning'],
      dimensions: ['ejer_type'],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.joinedTables).toContain('cvr_virksomhed');
    expect(r.query.joinedTables).toContain('ejf_ejerskab');
  });
});

describe('compileQueryPlan — filters', () => {
  it('renderer eq-filter med escaping', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune_kode', op: 'eq', value: 101 }],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/kommune_kode = 101/);
  });

  it('renderer in-filter med array', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune_kode', op: 'in', value: [101, 147, 173] }],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/kommune_kode IN \(101, 147, 173\)/);
  });

  it('renderer between-filter', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune_kode', op: 'between', value: [100, 200] }],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/kommune_kode BETWEEN 100 AND 200/);
  });

  it('renderer is_null uden value', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'kommune_kode', op: 'is_null' }],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/kommune_kode IS NULL/);
  });

  it('escaper string-værdier i filter', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [{ dimension: 'by', op: 'eq', value: "Aarhus's" }],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/postnummer_by = 'Aarhus''s'/);
  });
});

describe('compileQueryPlan — timeRange', () => {
  const now = new Date('2026-05-16T12:00:00Z');

  it('renderer preset som from/to', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      timeRange: { dimension: 'dato', preset: 'last_30_days' },
    };
    const r = compileQueryPlan(plan, { now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/overtagelsesdato >= '2026-04-16'/);
    expect(r.query.sql).toMatch(/overtagelsesdato <= '2026-05-16'/);
  });

  it('overskriver preset med eksplicit from/to', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      timeRange: {
        dimension: 'dato',
        preset: 'last_30_days',
        from: '2025-01-01',
        to: '2025-12-31',
      },
    };
    const r = compileQueryPlan(plan, { now });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/'2025-01-01'/);
    expect(r.query.sql).toMatch(/'2025-12-31'/);
  });
});

describe('compileQueryPlan — sort + limit', () => {
  it('eksplicit sort overrider default', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: ['aar'],
      filters: [],
      sort: { by: 'aar', direction: 'asc' },
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.sql).toMatch(/ORDER BY aar ASC NULLS LAST/);
  });

  it('clamper limit til MAX_LIMIT', () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
      // valideringen tillader op til 10000; vi setter præcis dér
      limit: 10000,
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.query.limit).toBe(10000);
    expect(r.query.sql).toMatch(/LIMIT 10000/);
  });
});

describe('compileQueryPlan — validation pass-through', () => {
  it('returnerer fejl ved ukendt metric', () => {
    const plan: QueryPlan = {
      metrics: ['ukendt'],
      dimensions: [],
      filters: [],
    };
    const r = compileQueryPlan(plan);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/Ukendt metric/);
  });
});

describe('executeQueryPlan', () => {
  it('kører compile + runner i én operation', async () => {
    const plan: QueryPlan = {
      metrics: ['count_handler'],
      dimensions: [],
      filters: [],
    };
    const runner = vi.fn().mockResolvedValue([{ count_handler: 42 }]);
    const result = await executeQueryPlan(plan, runner);
    expect(runner).toHaveBeenCalledOnce();
    expect(result.rows).toEqual([{ count_handler: 42 }]);
    expect(result.columns).toHaveLength(1);
    expect(result.columns[0].catalogName).toBe('count_handler');
    expect(typeof result.durationMs).toBe('number');
  });

  it('kaster på compile-fejl', async () => {
    const plan: QueryPlan = {
      metrics: [],
      dimensions: [],
      filters: [],
    };
    const runner = vi.fn();
    await expect(executeQueryPlan(plan, runner)).rejects.toThrow(/SQL compile fejl/);
    expect(runner).not.toHaveBeenCalled();
  });
});
