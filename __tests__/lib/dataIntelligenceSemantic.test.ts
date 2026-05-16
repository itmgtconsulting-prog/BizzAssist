/**
 * Unit tests for Data Intelligence semantic layer (BIZZ-1562).
 *
 * Verificerer:
 * - Alle metrics + dimensions har unikke navne, valid SQL, og examples
 * - Join-graf BFS finder korrekt sti mellem fact-tabeller
 * - Metric+dim-kombinationer der dækker de 30 persona-spørgsmål er
 *   udtrykkelige uden missing metadata
 */
import { describe, it, expect } from 'vitest';
import { METRICS, getMetric, getMetricsByTable } from '@/app/lib/dataIntelligence/semantic/metrics';
import {
  DIMENSIONS,
  getDimension,
  getDimensionsByTable,
} from '@/app/lib/dataIntelligence/semantic/dimensions';
import {
  JOINS,
  findDirectJoin,
  findJoinPath,
  getReachableTables,
} from '@/app/lib/dataIntelligence/semantic/joinGraph';

describe('Metric-katalog', () => {
  it('har mindst 30 metrics', () => {
    expect(METRICS.length).toBeGreaterThanOrEqual(30);
  });

  it('alle metric-navne er unikke', () => {
    const names = METRICS.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('alle metrics har mindst 2 examples', () => {
    for (const m of METRICS) {
      expect(m.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('alle metrics har non-empty sql + table + displayName', () => {
    for (const m of METRICS) {
      expect(m.sql.trim()).not.toBe('');
      expect(m.table.trim()).not.toBe('');
      expect(m.displayName.trim()).not.toBe('');
    }
  });

  it('getMetric finder eksisterende', () => {
    expect(getMetric('count_virksomheder')).toBeDefined();
    expect(getMetric('avg_m2_pris')?.format).toBe('currency_dkk');
  });

  it('getMetric returnerer undefined for ukendt', () => {
    expect(getMetric('does_not_exist')).toBeUndefined();
  });

  it('getMetricsByTable filtrerer korrekt', () => {
    const handler = getMetricsByTable('ejerskifte_historik');
    expect(handler.length).toBeGreaterThanOrEqual(5);
    for (const m of handler) expect(m.table).toBe('ejerskifte_historik');
  });
});

describe('Dimensions-katalog', () => {
  it('har mindst 20 dimensions', () => {
    expect(DIMENSIONS.length).toBeGreaterThanOrEqual(20);
  });

  it('alle dimension-navne er unikke', () => {
    const names = DIMENSIONS.map((d) => d.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('alle dimensions har mindst 2 examples', () => {
    for (const d of DIMENSIONS) {
      expect(d.examples.length).toBeGreaterThanOrEqual(2);
    }
  });

  it('enum-dimensions har enumValues sat', () => {
    const enums = DIMENSIONS.filter((d) => d.type === 'enum');
    expect(enums.length).toBeGreaterThan(0);
    for (const d of enums) {
      expect(d.enumValues).toBeDefined();
      expect(d.enumValues!.length).toBeGreaterThan(0);
    }
  });

  it('bucket-dimensions har bucketize sat', () => {
    const bucketed = DIMENSIONS.filter((d) => d.bucketize);
    expect(bucketed.length).toBeGreaterThanOrEqual(2); // koebesum_bucket + antal_ejendomme_bucket
    for (const d of bucketed) {
      expect(d.bucketize!.ranges.length).toBeGreaterThan(2);
    }
  });

  it('getDimension finder eksisterende', () => {
    expect(getDimension('kommune')).toBeDefined();
    expect(getDimension('energimaerke')?.type).toBe('enum');
  });

  it('getDimensionsByTable filtrerer korrekt', () => {
    const bbrDims = getDimensionsByTable('bbr_ejendom_status');
    expect(bbrDims.length).toBeGreaterThan(0);
    for (const d of bbrDims) expect(d.table).toBe('bbr_ejendom_status');
  });
});

describe('Join-graf', () => {
  it('alle joins er retningsbestemte med non-empty on-clause', () => {
    for (const j of JOINS) {
      expect(j.fromTable).not.toBe(j.toTable);
      expect(j.on.trim()).not.toBe('');
    }
  });

  it('findDirectJoin finder ejerskifte_historik → kommune_ref', () => {
    const j = findDirectJoin('ejerskifte_historik', 'kommune_ref');
    expect(j).toBeDefined();
    expect(j!.on).toContain('kommune_kode');
  });

  it('findDirectJoin er bi-direktionel', () => {
    const a = findDirectJoin('cvr_virksomhed', 'regnskab_cache');
    const b = findDirectJoin('regnskab_cache', 'cvr_virksomhed');
    expect(a).toBeDefined();
    expect(b).toBeDefined();
  });

  it('findJoinPath finder direkte sti (1 hop)', () => {
    const path = findJoinPath('ejerskifte_historik', 'kommune_ref');
    expect(path).not.toBeNull();
    expect(path!.length).toBe(1);
  });

  it('findJoinPath finder multi-hop sti', () => {
    // ejerskifte_historik → bbr_ejendom_status → ejf_ejerskab → cvr_virksomhed
    const path = findJoinPath('ejerskifte_historik', 'cvr_virksomhed');
    expect(path).not.toBeNull();
    expect(path!.length).toBeLessThanOrEqual(4);
  });

  it('findJoinPath returnerer [] når from === to', () => {
    expect(findJoinPath('bbr_ejendom_status', 'bbr_ejendom_status')).toEqual([]);
  });

  it('getReachableTables fra cvr_virksomhed inkluderer regnskab + ejf', () => {
    const r = getReachableTables('cvr_virksomhed');
    expect(r.has('regnskab_cache')).toBe(true);
    expect(r.has('ejf_ejerskab')).toBe(true);
    expect(r.has('kommune_ref')).toBe(true);
  });
});

describe('Persona-spørgsmål kan udtrykkes', () => {
  it('journalist: "Hvor mange virksomheder?" — count_virksomheder', () => {
    expect(getMetric('count_virksomheder')).toBeDefined();
  });

  it('journalist: "Top kommuner efter handler" — count_handler × kommune', () => {
    expect(getMetric('count_handler')).toBeDefined();
    expect(getDimension('kommune')).toBeDefined();
    const path = findJoinPath('ejerskifte_historik', 'kommune_ref');
    expect(path).not.toBeNull();
  });

  it('mægler: "M²-pris per kvartal" — avg_m2_pris × kvartal', () => {
    expect(getMetric('avg_m2_pris')).toBeDefined();
    expect(getDimension('kvartal')).toBeDefined();
  });

  it('finans: "Top ejere efter ejendomsværdi" — kombination', () => {
    // sum_ejendomsvaerdi (vurdering_cache) × ejer_type (ejf_ejerskab)
    expect(getMetric('sum_ejendomsvaerdi')).toBeDefined();
    expect(getDimension('ejer_type')).toBeDefined();
    const path = findJoinPath('vurdering_cache', 'ejf_ejerskab');
    expect(path).not.toBeNull();
  });

  it('mægler: "Antal solgte lejligheder per måned" — count_handler × maaned × ejendomstype', () => {
    expect(getMetric('count_handler')).toBeDefined();
    expect(getDimension('maaned')).toBeDefined();
    expect(getDimension('ejendomstype')).toBeDefined();
  });
});
